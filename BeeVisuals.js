'use strict';

/**
 * BeeVisuals – readable visual overlays for your rooms and the world map.
 *
 * Draws:
 *  - Debug creep list (left column)
 *  - Optional structure placement markers (role.Builder structurePlacements)
 *  - CPU & bucket stats
 *  - In-room planned roads (debug)
 *  - World/overview overlays (flags + planned road dots)
 *  - Energy bar + worker role table (bottom-right, stacked upward)
 */

// ----------------------------- Dependencies ------------------------------
var Builder = require('role.Builder'); // exposes structurePlacements metadata
var RepairConfig = require('role.Repair.Config');
var LunaConfig = require('role.Luna.Config');
var Logger      = require('core.logger');
var LOG_LEVEL   = Logger.LOG_LEVEL;
var CoreConfig = require('core.config');
var BeeVisuals = {};

// ------------------------------- Settings --------------------------------
var CFG = {
  // General debug output
  maxCreepsRenderedDebug: 30,    // cap lines so the left column doesn't explode
  drawDebugEachTick: true,       // true = always, else use debugTickModulo
  debugTickModulo: 1,            // e.g. 2 = every other tick

  // CPU + counters
  showCpuStats: true,
  showRepairCounter: true,
  showRemoteContainerHaulVisuals: true,
  showRemoteContainerHaulMapVisuals: true,
  showRemoteContainerBuildVisuals: true,
  remoteContainerHaulMapModulo: 1,

  // Task table cadence
  tableTickModulo: 1,            // e.g. 2 = every other tick

  // World/overview map overlays
  worldDrawModulo: 0,            // 0 disables; 1 = every tick; raise to 2/3 to throttle
  worldMaxFlagMarkers: 600,      // hard cap for flag rings
  worldMaxPlannedTiles: 800,     // hard cap for planned road dots

  // Visual look
  colors: {
    text: '#ffffff',
    panelFill: '#000000',
    panelStroke: '#000000',
    plannedRoad: '#ffe066',
    builtRoad: '#99ff99',
    cursor: '#66ccff',
    debugMarker: 'cyan',
    barGood: '#00ff00'
  },
  alpha: {
    panel: 0.4,
    faint: 0.3
  },

  // Bottom-right UI anchoring (panels grow upward)
  ui: {
    rightX: 48.8,   // near right edge of the room
    bottomY: 48.6,  // near bottom edge of the room
    panelGap: 0.35  // vertical spacing between stacked panels
  }
};

function visualsConfig() {
  return (CoreConfig && CoreConfig.settings && CoreConfig.settings.visuals) || {};
}

BeeVisuals.visualBudgetLevel = function () {
  var vc = visualsConfig();
  if (vc.enabled === false) return 'off';
  if (vc.lowCpuMode === false) return 'full';

  var bucket = (Game && Game.cpu && typeof Game.cpu.bucket === 'number') ? Game.cpu.bucket : null;
  var used = (Game && Game.cpu && typeof Game.cpu.getUsed === 'function') ? Game.cpu.getUsed() : 0;

  if (bucket !== null && bucket < (vc.minBucketForAnyVisuals || 1000)) return 'minimal';
  if (used > (vc.maxCpuUsedBeforeVisuals || 14)) return 'minimal';
  if (bucket !== null && bucket < (vc.minBucketForFullVisuals || 5000)) return 'medium';
  return 'full';
};

// ------------------------------- Utilities -------------------------------

/** Get a "main" room: prefer Memory.firstSpawnRoom, else the first spawn's room. */
function getMainRoom() {
  var rn = Memory.firstSpawnRoom;
  if (rn && Game.rooms[rn]) return Game.rooms[rn];

  for (var name in Game.spawns) {
    if (!Game.spawns.hasOwnProperty(name)) continue;
    var sp = Game.spawns[name];
    if (sp && sp.room) return sp.room;
  }
  return null;
}

/** Hashy room-stagger: draw every tick if mod<=1, else spread load by room name. */
function shouldDrawForRoom(mod, roomName) {
  if (mod <= 1) return true;
  var h = 0;
  for (var i = 0; i < roomName.length; i++) {
    h = h * 31 + roomName.charCodeAt(i);
  }
  // Spread the draw load using a small hash offset instead of bitwise masking.
  var offset = Math.abs(h % 4);
  return ((Game.time + offset) % mod) === 0;
}

/** Cheap check: is there already a road or road site at (x,y)? */
function hasRoadOrSiteFast(roomObj, x, y) {
  var arr = roomObj.lookForAt(LOOK_STRUCTURES, x, y);
  for (var i = 0; i < arr.length; i++) if (arr[i].structureType === STRUCTURE_ROAD) return true;

  var siteArr = roomObj.lookForAt(LOOK_CONSTRUCTION_SITES, x, y);
  for (var j = 0; j < siteArr.length; j++) if (siteArr[j].structureType === STRUCTURE_ROAD) return true;

  return false;
}

/** Draw a simple horizontal bar with background. */
function drawBar(visual, x, y, width, height, pct, fillColor, bgColor) {
  var clamped = Math.max(0, Math.min(1, pct || 0));
  var w = clamped * width;
  visual.rect(x, y, width, height, { fill: bgColor || '#000000', opacity: 0.3, stroke: '#000000' });
  visual.rect(x, y, w, height, { fill: fillColor || CFG.colors.barGood, opacity: 0.5, stroke: '#000000' });
}

/** Shorthand for text styling. */
function text(visual, str, x, y, size, align, opacity, color) {
  visual.text(String(str), x, y, {
    color: color || CFG.colors.text,
    font: size || 0.5,
    align: align || 'left',
    opacity: (typeof opacity === 'number') ? opacity : 1,
    stroke: '#000000'
  });
}

// ------------------------------- Module ----------------------------------

// bottom-right stack state (per room, resets each drawVisuals call)
BeeVisuals._stack = {}; // roomName -> current bottom cursor (y)

/** Reset the bottom-right stack for a room (set cursor to bottom baseline). */
function _resetBottomRightStack(roomName) {
  BeeVisuals._stack[roomName] = CFG.ui.bottomY;
}

/**
 * Reserve a bottom-right panel rectangle and return its top-left coordinates.
 * Panels are right-aligned and grow upward.
 * Returns: { leftX, topY }
 */
function _reserveBottomRight(roomName, panelWidth, panelHeight) {
  var bottom = BeeVisuals._stack.hasOwnProperty(roomName)
    ? BeeVisuals._stack[roomName]
    : CFG.ui.bottomY;

  var topY  = bottom - panelHeight;      // grow upward
  var leftX = CFG.ui.rightX - panelWidth; // right-aligned

  BeeVisuals._stack[roomName] = topY - CFG.ui.panelGap; // move cursor up for next panel
  return { leftX: leftX, topY: topY };
}

/**
 * Main entrypoint – call this once per tick.
 * Draws:
 *  - Debug creep list (left column)
 *  - Optional structure placement markers (cyan circles)
 *  - CPU + bucket stats
 *  - In-room planned roads (debug)
 *  - World overlays (if enabled)
 *  - Repair counter
 *  - Energy bar (bottom-right) + worker table stacked above it
 */
BeeVisuals.drawVisuals = function () {
  var room = getMainRoom();
  if (!room) return;
  var budget = BeeVisuals.visualBudgetLevel();
  if (budget === 'off') return;

  // reset the bottom-right stack for this room
  _resetBottomRightStack(room.name);

  var visual = new RoomVisual(room.name);

  // 1) Creep debug list + optional structure placement dots
  if (budget === 'full' &&
      Logger.shouldLog(LOG_LEVEL.DEBUG) &&
      (CFG.drawDebugEachTick || shouldDrawForRoom(CFG.debugTickModulo, room.name))) {
    drawCreepDebugList(visual, room);
    drawStructurePlacementDots(visual, room);
  }

  // 2) CPU / bucket info
  var vc = visualsConfig();
  if (CFG.showCpuStats && ((vc.cpuStatsModulo || 1) <= 1 || (Game.time % (vc.cpuStatsModulo || 1)) === 0)) {
    drawCpuStats(visual);
  }

  if ((budget === 'medium' || budget === 'full' || (vc.persistentHud === true)) && CFG.showRepairCounter) {
    drawRepairCounter(visual);
  }

  if ((vc.persistentHud === true || budget === 'medium' || budget === 'full')) {
    BeeVisuals.drawRemoteHaulStatusTable();
    if (vc.remoteContainerBuildTableEnabled !== false) {
      BeeVisuals.drawRemoteContainerBuildStatusTable();
    }
  }

  if (budget === 'full') {
    BeeVisuals.drawPlannedRoadsDebug();
    BeeVisuals.drawWorldOverview();

    if (vc.remoteHaulMapEnabled === true) {
      BeeVisuals.drawRemoteContainerHaulMapVisuals();
    }
    if (vc.remoteHaulRoomOverlayEnabled === true) {
      BeeVisuals.drawRemoteContainerHaulVisuals();
    }
    if (vc.remoteContainerBuildOverlayEnabled !== false) {
      BeeVisuals.drawRemoteContainerBuildVisuals();
    }
  }
};

/**
 * Energy bar (bottom-right). Compact, right-aligned, grows upward via stack.
 */
BeeVisuals.drawEnergyBar = function () {
  var room = getMainRoom();
  if (!room) return;
  var vc = visualsConfig();
  var mod = vc.energyBarModulo || 1;
  if (mod > 1 && (Game.time % mod) !== 0) return;
  if (BeeVisuals.visualBudgetLevel() === 'off') return;

  var v = new RoomVisual(room.name);

  var energy   = room.energyAvailable || 0;
  var capacity = room.energyCapacityAvailable || 0;
  var pct      = capacity > 0 ? (energy / capacity) : 0;

  // panel geometry
  var innerW = 6.0;
  var innerH = 1.0;

  // reserve outer box (with a bit of padding)
  var outerW = innerW + 0.8;
  var outerH = innerH + 0.6;

  var pos = _reserveBottomRight(room.name, outerW, outerH);
  var xLeft = pos.leftX + 0.4; // inner padding
  var yTop  = pos.topY  + 0.3;

  // backdrop
  v.rect(pos.leftX + 0.15, pos.topY + 0.15, outerW - 0.3, outerH - 0.3, {
    fill: '#000000', opacity: 0.18, stroke: '#333333'
  });

  // bar + label
  drawBar(v, xLeft, yTop, innerW, innerH, pct, CFG.colors.barGood, CFG.colors.panelFill);
  text(v, energy + '/' + capacity, xLeft + (innerW / 2), yTop + innerH - 0.15, 0.5, 'center', 1);
};

// Teach-by-example constants live at module scope so they are easy to tweak.
var WORKER_MAX_TASKS = {
  BaseHarvest: 2, Builder: 1, Upgrader: 1, Repair: 0,
  Courier: 1, Luna: null, Trucker: null, Scout: 1, Queen: 2,
  CombatArcher: 0, CombatMelee: 0, CombatMedic: 0,
  Dismantler: 0, Claimer: 2
};

var WORKER_ROLE_ALIAS = {
  baseharvest: 'BaseHarvest',
  builder: 'Builder',
  upgrader: 'Upgrader',
  repair: 'Repair',
  courier: 'Courier',
  luna: 'Luna',
  remoteharvest: 'Luna',
  trucker: 'Trucker',
  haulremote: 'Trucker',
  scout: 'Scout',
  queen: 'Queen',
  combatarcher: 'CombatArcher',
  combatmelee: 'CombatMelee',
  combatmedic: 'CombatMedic',
  dismantler: 'Dismantler',
  claimer: 'Claimer'
};

/** Normalize a role tag by checking the official map first, then known aliases. */
function canonicalWorkerRole(tag) {
  if (!tag) return null;
  if (Object.prototype.hasOwnProperty.call(WORKER_MAX_TASKS, tag)) return tag;
  var lower = tag.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(WORKER_ROLE_ALIAS, lower)) {
    return WORKER_ROLE_ALIAS[lower];
  }
  return null;
}

/** Count current workers against the target quotas so we can render the table. */
function collectWorkerStats(room) {
  var tasks = {};
  var totalCount = 0;
  var maxTotal = 0;
  var hasUnknownMax = false;
  var key;

  var quotaSnapshot = room && Memory.rooms && Memory.rooms[room.name] && Memory.rooms[room.name].lastRoleQuotas;
  var quotaMap = quotaSnapshot && quotaSnapshot.quotas ? quotaSnapshot.quotas : null;

  for (key in WORKER_MAX_TASKS) {
    if (!WORKER_MAX_TASKS.hasOwnProperty(key)) continue;
    tasks[key] = 0;

    var quotaValue = null;
    if (quotaMap && Object.prototype.hasOwnProperty.call(quotaMap, key)) {
      quotaValue = quotaMap[key];
    } else if (quotaMap && key === 'BaseHarvest' && Object.prototype.hasOwnProperty.call(quotaMap, 'Baseharvest')) {
      quotaValue = quotaMap.Baseharvest;
    } else {
      quotaValue = WORKER_MAX_TASKS[key];
    }

    if (quotaValue == null) {
      hasUnknownMax = true;
    } else {
      maxTotal += Number(quotaValue) || 0;
    }
  }

  for (var name in Game.creeps) {
    if (!Game.creeps.hasOwnProperty(name)) continue;
    var creep = Game.creeps[name];
    if (!creep || !creep.memory) continue;
    var canonical = canonicalWorkerRole((creep.memory.role || creep.memory.task || '').toString());
    if (canonical && tasks.hasOwnProperty(canonical)) {
      tasks[canonical] = (tasks[canonical] || 0) + 1;
      totalCount++;
    }
  }

  return { totalCount: totalCount, maxTotal: maxTotal, tasks: tasks, hasUnknownMax: hasUnknownMax, quotas: quotaMap };
}

/** Pre-compute table geometry once so the draw loop reads like instructions. */
function workerTableGeometry() {
  var nameW = 4.2;
  var valueW = 1.4;
  var cellH = 0.7;
  var rows  = 1 + Object.keys(WORKER_MAX_TASKS).length;
  var innerW = nameW + valueW;
  var innerH = rows * cellH + 0.6;
  return {
    nameW: nameW,
    valueW: valueW,
    cellH: cellH,
    innerW: innerW,
    innerH: innerH,
    outerW: innerW + 0.8,
    outerH: innerH + 0.6
  };
}

/**
 * Worker role table (bottom-right). Stacks above energy bar.
 * Uses the helpers above so novice readers can follow the data gathering story.
 */
BeeVisuals.drawWorkerBeeTaskTable = function () {
  var room = getMainRoom();
  if (!room) return;
  var budget = BeeVisuals.visualBudgetLevel();
  var vc = visualsConfig();
  if (budget !== 'full' && budget !== 'medium' && vc.persistentHud !== true) return;
  if (!shouldDrawForRoom(vc.workerTableModulo || CFG.tableTickModulo, room.name)) return;

  var v = new RoomVisual(room.name);
  var stats = collectWorkerStats(room);
  var geom = workerTableGeometry();

  var pos = _reserveBottomRight(room.name, geom.outerW, geom.outerH);
  var xLeft = pos.leftX + 0.4;
  var yTop  = pos.topY  + 0.3;

  // Soft shaded backing so the white text remains readable against any terrain.
  v.rect(pos.leftX + 0.15, pos.topY + 0.15, geom.outerW - 0.3, geom.outerH - 0.3, {
    fill: '#000000', opacity: 0.18, stroke: '#333333'
  });

  // Header: just the overall worker count vs. target.
  v.rect(xLeft, yTop, geom.nameW, geom.cellH, {
    fill: CFG.colors.panelFill,
    stroke: CFG.colors.panelStroke,
    opacity: CFG.alpha.panel,
    radius: 0.05
  });
  v.rect(xLeft + geom.nameW, yTop, geom.valueW, geom.cellH, {
    fill: CFG.colors.panelFill,
    stroke: CFG.colors.panelStroke,
    opacity: CFG.alpha.panel,
    radius: 0.05
  });
  text(v, 'Workers', xLeft + 0.3, yTop + geom.cellH / 2 + 0.15, 0.5, 'left', 1);
  var headerTotal = stats.hasUnknownMax ? (stats.totalCount + '/?') : (stats.totalCount + '/' + stats.maxTotal);
  text(v, headerTotal, xLeft + geom.nameW + geom.valueW - 0.3,
       yTop + geom.cellH / 2 + 0.15, 0.5, 'right', 1);

  // Each row repeats the same structure: label on the left, current/max on the right.
  var row = 1;
  var maxRows = vc.maxWorkerRowsDrawn || 15;
  for (var k in WORKER_MAX_TASKS) {
    if (!WORKER_MAX_TASKS.hasOwnProperty(k)) continue;
    if (row > maxRows) break;
    var y = yTop + row * geom.cellH;
    var roleQuota = null;
    if (stats.quotas && Object.prototype.hasOwnProperty.call(stats.quotas, k)) {
      roleQuota = stats.quotas[k];
    } else if (stats.quotas && k === 'BaseHarvest' && Object.prototype.hasOwnProperty.call(stats.quotas, 'Baseharvest')) {
      roleQuota = stats.quotas.Baseharvest;
    } else {
      roleQuota = WORKER_MAX_TASKS[k];
    }
    var val = (roleQuota == null) ? ((stats.tasks[k] || 0) + '/?') : ((stats.tasks[k] || 0) + '/' + (Number(roleQuota) || 0));

    v.rect(xLeft, y, geom.nameW, geom.cellH, {
      fill: CFG.colors.panelFill,
      stroke: CFG.colors.panelStroke,
      opacity: CFG.alpha.panel,
      radius: 0.05
    });
    v.rect(xLeft + geom.nameW, y, geom.valueW, geom.cellH, {
      fill: CFG.colors.panelFill,
      stroke: CFG.colors.panelStroke,
      opacity: CFG.alpha.panel,
      radius: 0.05
    });
    text(v, k,   xLeft + 0.3, y + geom.cellH / 2 + 0.15, 0.5, 'left', 1);
    text(v, val, xLeft + geom.nameW + geom.valueW - 0.3, y + geom.cellH / 2 + 0.15, 0.5, 'right', 1);

    row++;
  }
};

// ------------------------- In-room roads (DEBUG) -------------------------

/**
 * Overlay for planned roads using Memory.rooms[room].roadPlanner.paths
 * Draws a handful per tick to avoid going ham on CPU.
 */
BeeVisuals.drawPlannedRoadsDebug = function () {
  if (BeeVisuals.visualBudgetLevel() !== 'full') return;
  if (!Logger.shouldLog(LOG_LEVEL.DEBUG)) return;

  var room = getMainRoom();
  if (!room) return;

  // Light tick-gate (set MOD>1 if you want to throttle)
  var vc = visualsConfig();
  var MOD = vc.plannedRoadDebugModulo || 1;
  if (((Game.time + 3) % MOD) !== 0) return;

  var v = new RoomVisual(room.name);

  if (!Memory.rooms || !Memory.rooms[room.name] || !Memory.rooms[room.name].roadPlanner) return;

  var rp    = Memory.rooms[room.name].roadPlanner;
  var paths = rp.paths || {};

  var MAX_PATHS = 6;
  var MAX_TILES = vc.maxPlannedRoadTilesDrawn || 75;

  var COLOR_PLANNED = CFG.colors.plannedRoad;
  var COLOR_BUILT   = CFG.colors.builtRoad;
  var COLOR_CURSOR  = CFG.colors.cursor;

  var drawnPaths = 0;
  var drawnTiles = 0;

  var labelY = 5;

  for (var key in paths) {
    if (!paths.hasOwnProperty(key)) continue;
    if (drawnPaths >= MAX_PATHS) break;

    var rec = paths[key];
    if (!rec || !rec.path || !rec.path.length) continue;

    text(v, key, 1, labelY + (drawnPaths * 0.6), 0.5, 'left', 0.6);

    var lastX = -1, lastY = -1, lastRoom = null;

    for (var idx = 0; idx < rec.path.length; idx++) {
      if (drawnTiles >= MAX_TILES) break;

      var step   = rec.path[idx];
      var rname  = step.roomName;
      var rx     = step.x != null ? step.x : 0;
      var ry     = step.y != null ? step.y : 0;
      var rObj   = Game.rooms[rname];
      if (!rObj) continue;

      if (typeof rec.i === 'number' && idx === rec.i) {
        new RoomVisual(rname).circle(rx, ry, {
          radius: 0.4, stroke: COLOR_CURSOR, fill: 'transparent', opacity: 0.7
        });
      }

      if (rObj.getTerrain().get(rx, ry) === TERRAIN_MASK_WALL) continue;

      var already = hasRoadOrSiteFast(rObj, rx, ry);
      var color   = already ? COLOR_BUILT : COLOR_PLANNED;
      var opac    = already ? 0.55 : 0.35;

      new RoomVisual(rname).circle(rx, ry, { radius: 0.25, fill: color, opacity: opac });

      if (lastRoom === rname && lastX !== -1) {
        new RoomVisual(rname).line(lastX, lastY, rx, ry, { width: 0.09, color: color, opacity: opac });
      }

      lastX = rx; lastY = ry; lastRoom = rname;
      drawnTiles++;
      if (drawnTiles >= MAX_TILES) break;
    }

    if (rec.done && lastRoom === room.name && lastX !== -1) {
      text(v, '✓', lastX, lastY, 0.6, 'center', 0.7, CFG.colors.builtRoad);
    }

    drawnPaths++;
  }
};

// ------------------------ World / Overview overlays ----------------------

function shouldDrawWorldOverlay(mod) {
  var m = Number(mod) || 0;
  if (m <= 0) return false;
  return (Game.time % m) === 0;
}

/** Draw concentric flag rings for any flag that matches the remote prefix. */
function drawWorldFlagMarkers(mapVisual, maxMarkers) {
  var drawn = 0;
  for (var fname in Game.flags) {
    if (!Game.flags.hasOwnProperty(fname)) continue;
    if (fname.indexOf('SRC-') !== 0) continue;
    var flag = Game.flags[fname];

    mapVisual.circle(flag.pos, { radius: 5.0, fill: 'transparent', stroke: '#ffd54f', opacity: 0.9, strokeWidth: 0.8 });
    mapVisual.circle(flag.pos, { radius: 0.9, fill: '#ffd54f', opacity: 0.9 });

    drawn++;
    if (drawn >= maxMarkers) break;
  }
  return drawn;
}

/** Walk every planner path in Memory and sprinkle dots; bail early when capped. */
function drawWorldRoadDots(mapVisual, maxTiles) {
  var tiles = 0;
  if (!Memory.rooms) return tiles;

  for (var rn in Memory.rooms) {
    if (!Memory.rooms.hasOwnProperty(rn)) continue;
    var rm = Memory.rooms[rn];
    if (!rm || !rm.roadPlanner || !rm.roadPlanner.paths) continue;

    var paths = rm.roadPlanner.paths;
    for (var key in paths) {
      if (!paths.hasOwnProperty(key)) continue;
      var rec = paths[key];
      if (!rec || !rec.path || !rec.path.length) continue;

      for (var i = 0; i < rec.path.length; i++) {
        var step = rec.path[i];
        var pos  = new RoomPosition(step.x != null ? step.x : 0,
                                   step.y != null ? step.y : 0,
                                   step.roomName || rn);
        mapVisual.circle(pos, { radius: 0.8, fill: CFG.colors.plannedRoad, opacity: 0.6 });
        tiles++;
        if (tiles >= maxTiles) return tiles;
      }
    }
  }

  return tiles;
}

/**
 * Draws:
 *  - Flag rings for flags named like "SRC-*" (tweak prefix if needed)
 *  - Planned road dots across all rooms (from memory planner paths)
 * The helpers above keep the flow linear so novices see the cadence gate first,
 * then the flag overlays, then the planner data walk.
 */
BeeVisuals.drawWorldOverview = function () {
  if (!shouldDrawWorldOverlay(CFG.worldDrawModulo)) return;

  var mv = Game.map.visual;
  drawWorldFlagMarkers(mv, CFG.worldMaxFlagMarkers);
  drawWorldRoadDots(mv, CFG.worldMaxPlannedTiles);
};



BeeVisuals.drawRemoteHaulStatusTable = function () {
  var vc = visualsConfig();
  if (vc.enabled === false) return;
  if (vc.remoteHaulTableEnabled === false) return;

  var mod = vc.remoteHaulTableModulo || 1;
  if (mod > 1 && (Game.time % mod) !== 0) return;

  var root = Memory && Memory.__BHM;
  var requests = root && root.remoteHaulRequests ? root.remoteHaulRequests : {};
  var statusRoot = root && root.remoteContainerStatus ? root.remoteContainerStatus : {};
  if (!requests && !statusRoot) return;

  var staleTicks = vc.remoteHaulTableStaleTicks || 150;
  var showStale = vc.remoteHaulTableShowStale === true;
  var maxRows = vc.maxRemoteHaulTableRows || 8;

  var ownedRooms = [];
  for (var roomName in Game.rooms) {
    if (!Game.rooms.hasOwnProperty(roomName)) continue;
    var room = Game.rooms[roomName];
    if (!room || !room.controller || !room.controller.my) continue;
    if (!room.find || room.find(FIND_MY_SPAWNS).length <= 0) continue;
    ownedRooms.push(room);
  }

  for (var i = 0; i < ownedRooms.length; i++) {
    var roomObj = ownedRooms[i];
    var rows = [];

    var mergedById = {};
    for (var statusId in statusRoot) {
      if (!statusRoot.hasOwnProperty(statusId)) continue;
      var statusReq = statusRoot[statusId];
      if (!statusReq) continue;
      if (statusReq.homeRoom !== roomObj.name) continue;
      mergedById[statusId] = {
        status: statusReq,
        haul: null
      };
    }
    for (var reqId in requests) {
      if (!requests.hasOwnProperty(reqId)) continue;
      var haulReq = requests[reqId];
      if (!haulReq) continue;
      if (haulReq.homeRoom !== roomObj.name) continue;
      var keyId = haulReq.containerId || haulReq.id || reqId;
      if (!mergedById[keyId]) {
        mergedById[keyId] = { status: null, haul: haulReq };
      } else {
        mergedById[keyId].haul = haulReq;
      }
    }

    for (var mergedId in mergedById) {
      if (!mergedById.hasOwnProperty(mergedId)) continue;
      var merged = mergedById[mergedId];
      var statusReq = merged.status;
      var haulReq = merged.haul;
      var req = statusReq || haulReq;
      if (!req) continue;

      var amount = Number(req.amount) || 0;

      var stale = false;
      if (typeof req.updated === 'number' && staleTicks > 0) {
        stale = (Game.time - req.updated) > staleTicks;
      }
      if (stale && !showStale) continue;

      var remoteRoomName = req.remoteRoom || req.roomName || '?';
      var energyAmount = amount;
      var capacity = Number(req.capacity) || 0;
      var fillPct = Number(req.fillPct) || 0;

      if (req.containerId) {
        var container = Game.getObjectById(req.containerId);
        if (container && container.store) {
          energyAmount = container.store[RESOURCE_ENERGY] || 0;
          capacity = container.store.getCapacity(RESOURCE_ENERGY) || container.store.getCapacity() || capacity;
          if (capacity > 0) {
            fillPct = Math.floor((energyAmount / capacity) * 100);
          }
        } else if (capacity > 0) {
          fillPct = Math.floor((energyAmount / capacity) * 100);
        }
      } else if (capacity > 0) {
        fillPct = Math.floor((energyAmount / capacity) * 100);
      }

      if (fillPct < 0) fillPct = 0;
      if (fillPct > 100) fillPct = 100;

      var assigned = !!(req.assignedTo && req.assignedUntil > Game.time);
      var emergencyRepairStartPct = RepairConfig.remoteContainerEmergencyRepairStartPct || 0.40;
      var lunaRepairStartPct = LunaConfig.remoteContainerRepairStartPct || 0.50;
      var maintenanceUntil = Number(req.maintenanceUntil) || 0;
      var maintenanceReason = req.maintenanceReason || null;
      var hitsPct = Number(req.containerHitsPct);
      if (!(hitsPct >= 0)) hitsPct = null;
      var status = 'READY';
      if (stale && showStale) {
        status = 'STALE';
      } else if (maintenanceReason === 'emergencyRemoteRepair' && maintenanceUntil > Game.time) {
        status = 'EMERGENCY';
      } else if (maintenanceReason === 'containerRepair' && maintenanceUntil > Game.time) {
        status = 'LUNA FIX';
      } else if (hitsPct != null && hitsPct <= emergencyRepairStartPct) {
        status = 'CRITICAL';
      } else if (hitsPct != null && hitsPct <= lunaRepairStartPct) {
        status = 'LOW HP';
      } else if (assigned) {
        status = req.assignedTo;
      } else if (req.urgent) {
        status = 'URGENT';
      }

      if (statusReq && haulReq) {
        var haulAssigned = !!(haulReq.assignedTo && haulReq.assignedUntil > Game.time);
        if (haulAssigned) {
          assigned = true;
          if (status === 'READY' || status === 'URGENT') {
            status = haulReq.assignedTo;
          }
        } else if (haulReq.urgent && status === 'READY') {
          status = 'URGENT';
        }
      }

      var containerHealth = '-';
      if (typeof req.containerHits === 'number' && typeof req.containerHitsMax === 'number' && req.containerHitsMax > 0) {
        containerHealth = Math.floor((req.containerHits / req.containerHitsMax) * 100) + '%';
      } else if (hitsPct != null) {
        containerHealth = Math.floor(hitsPct * 100) + '%';
      }

      rows.push({
        roomName: remoteRoomName,
        energy: energyAmount,
        fillPct: fillPct,
        health: containerHealth,
        status: status,
        urgent: !!req.urgent,
        assigned: assigned,
        amount: energyAmount
      });
    }

    if (rows.length <= 0) continue;

    rows.sort(function (a, b) {
      if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
      if (a.assigned !== b.assigned) return a.assigned ? -1 : 1;
      return (b.amount || 0) - (a.amount || 0);
    });

    var shownRows = rows.slice(0, maxRows);
    var hiddenCount = rows.length - shownRows.length;

    var panelX = 1.0;
    var panelY = 1.2;
    var rowHeight = 0.55;
    var panelWidth = 17.2;
    var totalRows = 1 + shownRows.length + (hiddenCount > 0 ? 1 : 0);
    var panelHeight = 0.55 + (totalRows * rowHeight);

    var v = new RoomVisual(roomObj.name);
    v.rect(panelX - 0.2, panelY - 0.45, panelWidth, panelHeight, {
      fill: '#000000',
      opacity: 0.35,
      stroke: '#333333',
      strokeWidth: 0.05
    });

    text(v, 'Remote Haul', panelX, panelY, 0.5, 'left', 1, '#ffffff');
    text(v, 'Room', panelX, panelY + rowHeight, 0.45, 'left', 0.9, '#cccccc');
    text(v, 'Energy', panelX + 3.9, panelY + rowHeight, 0.45, 'left', 0.9, '#cccccc');
    text(v, 'Full', panelX + 7.5, panelY + rowHeight, 0.45, 'left', 0.9, '#cccccc');
    text(v, 'HP', panelX + 9.8, panelY + rowHeight, 0.45, 'left', 0.9, '#cccccc');
    text(v, 'Status', panelX + 11.6, panelY + rowHeight, 0.45, 'left', 0.9, '#cccccc');

    for (var r = 0; r < shownRows.length; r++) {
      var line = shownRows[r];
      var y = panelY + rowHeight * (2 + r);
      var statusColor = '#00ff66';
      if (line.status === 'URGENT') statusColor = '#ff8c42';
      if (line.status === 'STALE' || line.status === 'CRITICAL' || line.status === 'EMERGENCY') statusColor = '#ff5555';
      if (line.status === 'LOW HP' || line.status === 'LUNA FIX') statusColor = '#ffd166';
      if (line.assigned && line.status !== 'EMERGENCY' && line.status !== 'CRITICAL' && line.status !== 'STALE' && line.status !== 'LUNA FIX' && line.status !== 'LOW HP' && line.status !== 'URGENT' && line.status !== 'READY') statusColor = '#66ccff';

      text(v, line.roomName, panelX, y, 0.42, 'left', 1, '#ffffff');
      text(v, String(line.energy), panelX + 3.9, y, 0.42, 'left', 1, '#ffffff');
      text(v, line.fillPct + '%', panelX + 7.5, y, 0.42, 'left', 1, '#ffffff');
      text(v, line.health, panelX + 9.8, y, 0.42, 'left', 1, '#ffffff');
      text(v, line.status, panelX + 11.6, y, 0.42, 'left', 1, statusColor);
    }

    if (hiddenCount > 0) {
      var moreY = panelY + rowHeight * (2 + shownRows.length);
      text(v, '+' + hiddenCount + ' more', panelX, moreY, 0.42, 'left', 1, '#aaaaaa');
    }
  }
};

/**
 * Draw remote container haul request overlays directly from memory requests.
 * Uses RoomVisual(roomName) so remote rooms can be drawn from remembered positions.
 */



BeeVisuals.drawRemoteContainerBuildStatusTable = function () {
  var vc = visualsConfig();
  if (vc.remoteContainerBuildTableEnabled === false) return;
  var showBuilt = vc.remoteContainerBuildTableShowBuilt === true;

  var mod = vc.remoteContainerBuildTableModulo || 1;
  if (mod > 1 && (Game.time % mod) !== 0) return;

  var builds = Memory && Memory.__BHM && Memory.__BHM.remoteContainerBuilds;
  if (!builds) return;

  var staleTicks = vc.remoteContainerBuildTableStaleTicks || 150;
  var maxRows = vc.maxRemoteContainerBuildTableRows || 8;
  var grouped = {};

  for (var sourceId in builds) {
    if (!Object.prototype.hasOwnProperty.call(builds, sourceId)) continue;
    var rec = builds[sourceId];
    if (!rec || !rec.homeRoom) continue;

    var status = rec.status || 'missing';
    if (status === 'built' && !showBuilt) continue;
    var updated = typeof rec.updated === 'number' ? rec.updated : -1;
    var stale = updated < 0 ? true : ((Game.time - updated) > staleTicks);

    var statusText = '?';
    if (status === 'planned') statusText = 'PLAN';
    else if (status === 'building') statusText = String(Math.floor(Number(rec.progressPct) || 0)) + '%';
    else if (status === 'built') statusText = 'DONE';
    else if (status === 'blocked') statusText = 'BLOCK';

    var luna = '-';
    if (rec.assignedLuna && Game.creeps[rec.assignedLuna]) luna = rec.assignedLuna;

    var shortSource = sourceId ? String(sourceId).slice(-6) : '------';
    var remoteRoom = rec.remoteRoom || rec.roomName || '?';

    var pri = 3;
    if (status === 'building') pri = 0;
    else if (status === 'planned' || status === 'missing') pri = 1;
    else if (status === 'blocked' || stale) pri = 2;
    else if (status === 'built') pri = 4;

    if (!grouped[rec.homeRoom]) grouped[rec.homeRoom] = [];
    grouped[rec.homeRoom].push({
      remoteRoom: remoteRoom,
      sourceShort: shortSource,
      statusText: statusText,
      luna: luna,
      stale: stale,
      pri: pri,
      updated: updated
    });
  }

  for (var homeRoom in grouped) {
    if (!Object.prototype.hasOwnProperty.call(grouped, homeRoom)) continue;

    var rows = grouped[homeRoom];
    rows.sort(function (a, b) {
      if (a.pri !== b.pri) return a.pri - b.pri;
      if (a.updated !== b.updated) return a.updated - b.updated;
      if (a.remoteRoom !== b.remoteRoom) return a.remoteRoom < b.remoteRoom ? -1 : 1;
      if (a.sourceShort !== b.sourceShort) return a.sourceShort < b.sourceShort ? -1 : 1;
      return 0;
    });

    var shownRows = rows.slice(0, maxRows);
    var hidden = rows.length - shownRows.length;

    var v = new RoomVisual(homeRoom);
    var x = 48.6;
    var y = 1.2;
    var rowH = 0.78;
    var panelWidth = 16.6;
    var panelHeight = rowH * (2.25 + shownRows.length + (hidden > 0 ? 1 : 0));
    var leftX = x - panelWidth;

    v.rect(leftX, y - 0.45, panelWidth, panelHeight, {
      fill: '#000000',
      opacity: 0.35,
      stroke: '#333333',
      strokeWidth: 0.05
    });

    text(v, 'Remote Builds', leftX + 0.25, y, 0.52, 'left', 1, '#ffffff');

    for (var i = 0; i < shownRows.length; i++) {
      var line = shownRows[i];
      var lineY = y + rowH * (1 + i);
      var rowTxt = line.remoteRoom + '  ' + line.sourceShort + '  ' + line.statusText + '  ' + line.luna + (line.stale ? ' !' : '');
      text(v, rowTxt, leftX + 0.25, lineY, 0.43, 'left', 1, line.stale ? '#ffd166' : '#ffffff');
    }

    if (hidden > 0) {
      text(v, '+' + hidden + ' more', leftX + 0.25, y + rowH * (1 + shownRows.length), 0.4, 'left', 1, '#aaaaaa');
    }
  }
};

BeeVisuals.drawRemoteContainerBuildVisuals = function () {
  if (!CFG.showRemoteContainerBuildVisuals) return;
  var vc = visualsConfig();
  if (vc.remoteContainerBuildOverlayEnabled === false) return;
  var showBuilt = vc.remoteContainerBuildOverlayShowBuilt === true;
  var mod = vc.remoteContainerBuildVisualModulo || 1;
  if (mod > 1 && (Game.time % mod) !== 0) return;

  var builds = Memory && Memory.__BHM && Memory.__BHM.remoteContainerBuilds;
  if (!builds) return;

  var staleTicks = vc.remoteContainerBuildStaleTicks || 150;
  var maxDraw = vc.maxRemoteContainerBuildsDrawn || 12;
  var drawn = 0;

  for (var sourceId in builds) {
    if (!Object.prototype.hasOwnProperty.call(builds, sourceId)) continue;
    if (drawn >= maxDraw) break;
    var rec = builds[sourceId];
    if (!rec || !rec.roomName || typeof rec.x !== 'number' || typeof rec.y !== 'number') continue;

    var status = rec.status || 'missing';
    if (status === 'built' && !showBuilt) continue;
    var stale = (typeof rec.updated === 'number') ? ((Game.time - rec.updated) > staleTicks) : true;
    var ringColor = '#cccccc';
    var label = 'BOX ?';
    if (status === 'planned') { ringColor = '#ffe066'; label = 'BOX PLAN'; }
    else if (status === 'building') { ringColor = '#2ad1c9'; label = 'BOX ' + (Math.floor(rec.progressPct || 0)) + '%'; }
    else if (status === 'built') { ringColor = '#6effa1'; label = 'BOX DONE'; }
    else if (status === 'missing') { ringColor = '#ff8c42'; label = 'BOX ?'; }
    else if (status === 'blocked') { ringColor = '#ff5555'; label = 'BOX BLOCK'; }
    if (stale) label += ' STALE';

    var v = new RoomVisual(rec.roomName);
    v.circle(rec.x, rec.y, { radius: 0.55, fill: 'transparent', stroke: ringColor, opacity: stale ? 0.4 : 0.85, strokeWidth: 0.12 });
    v.rect(rec.x + 0.55, rec.y - 1.0, 5.9, 2.0, { fill: '#000000', opacity: 0.4, stroke: '#333333', strokeWidth: 0.05 });
    text(v, label, rec.x + 0.75, rec.y - 0.45, 0.42, 'left', 1, '#ffffff');

    if (status === 'building') {
      var pct = Math.max(0, Math.min(1, (Number(rec.progressPct) || 0) / 100));
      drawBar(v, rec.x + 0.75, rec.y - 0.2, 4.2, 0.25, pct, '#2ad1c9', '#222222');
    }

    var assigned = rec.assignedLuna;
    if (assigned && Game.creeps[assigned]) {
      text(v, assigned, rec.x + 0.75, rec.y + 0.45, 0.38, 'left', 1, '#66ccff');
    }
    drawn++;
  }
};
BeeVisuals.drawRemoteContainerHaulVisuals = function () {
  if (BeeVisuals.visualBudgetLevel() !== 'full') return;
  if (!CFG.showRemoteContainerHaulVisuals) return;
  if (visualsConfig().remoteHaulRoomOverlayEnabled !== true) return;

  try {
    if (!Memory.__BHM || !Memory.__BHM.remoteHaulRequests) return;

    var requests = Memory.__BHM.remoteHaulRequests;

    var vc = visualsConfig();
    var limit = vc.maxRemoteHaulRequestsDrawn || 10;
    if (vc.remoteHaulVisualModulo > 1 && (Game.time % vc.remoteHaulVisualModulo) !== 0) return;
    var drawn = 0;
    for (var reqId in requests) {
      if (!requests.hasOwnProperty(reqId)) continue;
      if (drawn >= limit) break;
      var req = requests[reqId];
      if (!req) continue;

      var roomName = req.roomName || req.remoteRoom;
      if (!roomName) continue;
      if (typeof req.x !== 'number' || typeof req.y !== 'number') continue;

      var amount = Number(req.amount) || 0;
      var capacity = Number(req.capacity) || 0;

      if (req.containerId) {
        var container = Game.getObjectById(req.containerId);
        if (container && container.store) {
          amount = container.store[RESOURCE_ENERGY] || 0;
          capacity = container.store.getCapacity(RESOURCE_ENERGY) || container.store.getCapacity() || capacity;
        }
      }

      var fillPct = capacity > 0 ? Math.floor((amount / capacity) * 100) : (Number(req.fillPct) || 0);
      if (fillPct < 0) fillPct = 0;
      if (fillPct > 100) fillPct = 100;

      var assigned = !!(req.assignedTo && req.assignedUntil > Game.time);
      var statusText = assigned ? (req.assignedTo + ' On route') : 'READY';
      var statusColor = assigned ? '#00e5ff' : '#00ff66';

      var v = new RoomVisual(roomName);
      var px = req.x + 0.7;
      var py = req.y - 0.2;

      var ringColor = '#66ccff';
      if (!assigned && req.urgent) ringColor = '#ff8c42';

      v.circle(req.x, req.y, { radius: 0.45, fill: 'transparent', stroke: ringColor, opacity: 0.8, strokeWidth: 0.12 });
      v.rect(px - 0.25, py - 0.55, 5.6, 2.1, { fill: '#000000', opacity: 0.45, stroke: '#333333', strokeWidth: 0.05 });

      text(v, 'Energy: ' + amount, px, py, 0.45, 'left', 1, '#ffffff');
      text(v, 'Full: ' + fillPct + '%', px, py + 0.6, 0.45, 'left', 1, '#ffffff');
      text(v, statusText, px, py + 1.2, 0.45, 'left', 1, statusColor);

      if (assigned && Game.creeps[req.assignedTo]) {
        var trucker = Game.creeps[req.assignedTo];
        if (trucker && trucker.pos && trucker.pos.roomName === roomName) {
          v.line(trucker.pos.x, trucker.pos.y, req.x, req.y, { color: '#00e5ff', width: 0.07, opacity: 0.7, lineStyle: 'dashed' });
        }
      }
      drawn++;
    }
  } catch (err) {
    if (Logger && Logger.log) {
      Logger.log(LOG_LEVEL.BASIC, '[BeeVisuals] drawRemoteContainerHaulVisuals error: ' + err);
    }
  }
};

/**
 * Draw compact remote container haul request markers on the world map.
 * Uses Game.map.visual + RoomPosition for overworld visibility.
 */
BeeVisuals.drawRemoteContainerHaulMapVisuals = function () {
  if (BeeVisuals.visualBudgetLevel() !== 'full') return;
  if (!CFG.showRemoteContainerHaulMapVisuals) return;
  if (visualsConfig().remoteHaulMapEnabled !== true) return;
  var vc = visualsConfig();
  var mapMod = vc.remoteHaulMapModulo || CFG.remoteContainerHaulMapModulo || 1;
  if (mapMod > 0 && (Game.time % mapMod) !== 0) return;

  try {
    if (!Memory.__BHM || !Memory.__BHM.remoteHaulRequests) return;

    var requests = Memory.__BHM.remoteHaulRequests;
    var mv = Game.map.visual;

    var limit = vc.maxRemoteHaulRequestsDrawn || 10;
    var drawn = 0;
    for (var reqId in requests) {
      if (!requests.hasOwnProperty(reqId)) continue;
      if (drawn >= limit) break;
      var req = requests[reqId];
      if (!req) continue;

      var roomName = req.roomName || req.remoteRoom;
      if (!roomName) continue;
      if (typeof req.x !== 'number' || typeof req.y !== 'number') continue;

      var pos = new RoomPosition(req.x, req.y, roomName);

      var amount = Number(req.amount) || 0;
      var capacity = Number(req.capacity) || 0;

      if (req.containerId) {
        var container = Game.getObjectById(req.containerId);
        if (container && container.store) {
          amount = container.store[RESOURCE_ENERGY] || 0;
          capacity = container.store.getCapacity(RESOURCE_ENERGY) || container.store.getCapacity() || capacity;
        }
      }

      var fillPct = capacity > 0 ? Math.floor((amount / capacity) * 100) : (Number(req.fillPct) || 0);
      if (fillPct < 0) fillPct = 0;
      if (fillPct > 100) fillPct = 100;

      var assigned = !!(req.assignedTo && req.assignedUntil > Game.time);
      var statusText = assigned ? (req.assignedTo + ' On route') : ('READY ' + fillPct + '%');
      var ringColor = assigned ? '#00e5ff' : '#00ff66';
      if (!assigned && req.urgent) ringColor = '#ff8c42';

      mv.circle(pos, { radius: 4, fill: 'transparent', stroke: ringColor, opacity: 0.85, strokeWidth: 1.5 });
      mv.text(statusText, pos, {
        color: assigned ? '#00e5ff' : '#ffffff',
        fontSize: 7,
        align: 'left',
        backgroundColor: '#000000',
        backgroundPadding: 0.2,
        opacity: 0.9
      });
      drawn++;
    }
  } catch (err) {
    if (Logger && Logger.log) {
      Logger.log(LOG_LEVEL.BASIC, '[BeeVisuals] drawRemoteContainerHaulMapVisuals error: ' + err);
    }
  }
};

// ------------------------------ Draw helpers -----------------------------

/** Left-column debug list of creeps and some key memory fields. */
function drawCreepDebugList(visual, room) {
  var y = 1;
  var count = 0;

  for (var cname in Game.creeps) {
    if (!Game.creeps.hasOwnProperty(cname)) continue;
    var creep = Game.creeps[cname];

    var parts = [];
    parts.push((creep.name || 'bee') + ': ' + (creep.ticksToLive || 0));

    if (creep.memory && creep.memory.assignedSource)    parts.push('A.S.ID:' + creep.memory.assignedSource);
    if (creep.memory && creep.memory.assignedContainer) parts.push('C.ID:'   + creep.memory.assignedContainer);
    if (creep.memory && creep.memory.targetRoom)        parts.push('T.R:'    + creep.memory.targetRoom);
    if (creep.memory && creep.memory.sourceId)          parts.push('S.ID:'   + creep.memory.sourceId);

    text(visual, parts.join(', '), 0, y, 0.5, 'left', 1);
    y += 1;

    count++;
    if (count >= CFG.maxCreepsRenderedDebug) break;
  }
}

/** Cyan dots near the first spawn showing Builder.structurePlacements, if present. */
function drawStructurePlacementDots(visual, room) {
  var firstSpawn = null;
  for (var sn in Game.spawns) {
    if (!Game.spawns.hasOwnProperty(sn)) continue;
    firstSpawn = Game.spawns[sn];
    break;
  }
  if (!firstSpawn) return;

  if (Builder && Builder.structurePlacements) {
    var baseX = firstSpawn.pos.x;
    var baseY = firstSpawn.pos.y;
    var placements = Builder.structurePlacements;

    for (var p = 0; p < placements.length; p++) {
      var pl = placements[p];
      visual.circle(baseX + pl.x, baseY + pl.y, { radius: 0.4, opacity: 0.1, stroke: CFG.colors.debugMarker });
    }
  }
}

/** CPU bucket + usage (with delta from last tick). */
function drawCpuStats(visual) {
  var used = Game.cpu.getUsed();
  var last = Memory.lastCpuUsage || 0;
  var delta = used - last;
  Memory.lastCpuUsage = used;

  text(visual, 'CPU Bucket: ' + Game.cpu.bucket, 20, 1, 0.6, 'left', 1);
  text(visual, 'CPU Used: ' + used.toFixed(2) + ' / Δ ' + delta.toFixed(2), 20, 2, 0.6, 'left', 1);
}

/** Simple repair counter line (uses Memory.GameTickRepairCounter). */
function drawRepairCounter(visual) {
  var counter = Memory.GameTickRepairCounter || 0;
  text(visual, 'Repair Tick Count: ' + counter + '/5', 20, 3, 0.6, 'left', 1);
}

module.exports = BeeVisuals;
