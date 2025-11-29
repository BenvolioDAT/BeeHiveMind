'use strict';

/**
 * BeeVisuals – readable visual overlays for your rooms and the world map.
 *
 * Draws:
 *  - Debug creep list (left column)
 *  - Optional structure placement markers (roleBeeWorker.structurePlacements)
 *  - CPU & bucket stats
 *  - In-room planned roads (debug)
 *  - World/overview overlays (flags + planned road dots)
 *  - Energy bar + worker role table (bottom-right, stacked upward)
 */

// ----------------------------- Dependencies ------------------------------
var roleBeeWorker = require('role.BeeWorker'); // exposes Builder.structurePlacements metadata
var Logger      = require('core.logger');
var LOG_LEVEL   = Logger.LOG_LEVEL;

// ------------------------------- Settings --------------------------------
var CFG = {
  // General debug output
  maxCreepsRenderedDebug: 30,    // cap lines so the left column doesn't explode
  drawDebugEachTick: true,       // true = always, else use debugTickModulo
  debugTickModulo: 1,            // e.g. 2 = every other tick

  // CPU + counters
  showCpuStats: true,
  showRepairCounter: true,

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
var BeeVisuals = {};

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

  // reset the bottom-right stack for this room
  _resetBottomRightStack(room.name);

  var visual = new RoomVisual(room.name);

  // 1) Creep debug list + optional structure placement dots
  if (Logger.shouldLog(LOG_LEVEL.DEBUG) &&
      (CFG.drawDebugEachTick || shouldDrawForRoom(CFG.debugTickModulo, room.name))) {
    drawCreepDebugList(visual, room);
    drawStructurePlacementDots(visual, room);
  }

  // 2) CPU / bucket info
  if (CFG.showCpuStats) {
    drawCpuStats(visual);
  }

  // 3) In-room planned roads (debug)
  BeeVisuals.drawPlannedRoadsDebug();

  // 4) World overlays (flags + planned roads)
  BeeVisuals.drawWorldOverview();

  // 5) Repair counter line
  if (CFG.showRepairCounter) {
    drawRepairCounter(visual);
  }
};

/**
 * Energy bar (bottom-right). Compact, right-aligned, grows upward via stack.
 */
BeeVisuals.drawEnergyBar = function () {
  var room = getMainRoom();
  if (!room) return;

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
  Courier: 1, Luna: 8, Scout: 1, Queen: 2,
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
function collectWorkerStats() {
  var tasks = {};
  var totalCount = 0;
  var maxTotal = 0;
  var key;

  for (key in WORKER_MAX_TASKS) {
    if (!WORKER_MAX_TASKS.hasOwnProperty(key)) continue;
    tasks[key] = 0;
    maxTotal += Number(WORKER_MAX_TASKS[key]) || 0;
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

  return { totalCount: totalCount, maxTotal: maxTotal, tasks: tasks };
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
  if (!shouldDrawForRoom(CFG.tableTickModulo, room.name)) return;

  var v = new RoomVisual(room.name);
  var stats = collectWorkerStats();
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
  text(v, stats.totalCount + '/' + stats.maxTotal, xLeft + geom.nameW + geom.valueW - 0.3,
       yTop + geom.cellH / 2 + 0.15, 0.5, 'right', 1);

  // Each row repeats the same structure: label on the left, current/max on the right.
  var row = 1;
  for (var k in WORKER_MAX_TASKS) {
    if (!WORKER_MAX_TASKS.hasOwnProperty(k)) continue;
    var y = yTop + row * geom.cellH;
    var val = (stats.tasks[k] || 0) + '/' + (WORKER_MAX_TASKS[k] || 0);

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
  if (!Logger.shouldLog(LOG_LEVEL.DEBUG)) return;

  var room = getMainRoom();
  if (!room) return;

  // Light tick-gate (set MOD>1 if you want to throttle)
  var MOD = 1;
  if (((Game.time + 3) % MOD) !== 0) return;

  var v = new RoomVisual(room.name);

  if (!Memory.rooms || !Memory.rooms[room.name] || !Memory.rooms[room.name].roadPlanner) return;

  var rp    = Memory.rooms[room.name].roadPlanner;
  var paths = rp.paths || {};

  var MAX_PATHS = 6;
  var MAX_TILES = 250;

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

/** Cyan dots near the first spawn showing roleBeeWorker.structurePlacements, if present. */
function drawStructurePlacementDots(visual, room) {
  var firstSpawn = null;
  for (var sn in Game.spawns) {
    if (!Game.spawns.hasOwnProperty(sn)) continue;
    firstSpawn = Game.spawns[sn];
    break;
  }
  if (!firstSpawn) return;

  if (roleBeeWorker && roleBeeWorker.structurePlacements) {
    var baseX = firstSpawn.pos.x;
    var baseY = firstSpawn.pos.y;
    var placements = roleBeeWorker.structurePlacements;

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
