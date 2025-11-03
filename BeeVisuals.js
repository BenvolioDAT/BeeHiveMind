'use strict';

/**
 * BeeVisuals – readable visual overlays for your rooms and the world map.
 *
 * Draws:
 *  - Debug creep list (left column)
 *  - Optional structure placement markers (Task.Builder.structurePlacements)
 *  - CPU & bucket stats
 *  - In-room planned roads (debug)
 *  - World/overview overlays (flags + planned road dots)
 *  - Energy bar + Worker_Bee task table (bottom-right, stacked upward)
 */

// ----------------------------- Dependencies ------------------------------
var TaskBuilder = require('Task.Builder'); // optional: structurePlacements
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
  for (var i = 0; i < roomName.length; i++) h = (h * 31 + roomName.charCodeAt(i)) | 0;
  return ((Game.time + (h & 3)) % mod) === 0;
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
 *  - Energy bar (bottom-right) + Worker_Bee table stacked above it
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

  var energy   = room.energyAvailable | 0;
  var capacity = room.energyCapacityAvailable | 0;
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

/**
 * Worker_Bee task table (bottom-right). Stacks above energy bar.
 * Uses a fixed target map for quick at-a-glance guidance.
 */
BeeVisuals.drawWorkerBeeTaskTable = function () {
  var room = getMainRoom();
  if (!room) return;
  if (!shouldDrawForRoom(CFG.tableTickModulo, room.name)) return;

  var v = new RoomVisual(room.name);

  // Collect Worker_Bee creeps
  var workerBees = [];
  for (var name in Game.creeps) {
    if (!Game.creeps.hasOwnProperty(name)) continue;
    var c = Game.creeps[name];
    if (c && c.memory && c.memory.role === 'Worker_Bee') workerBees.push(c);
  }
  var totalCount = workerBees.length | 0;

  // Tweak to match your spawn quotas
  var maxTasks = {
    baseharvest: 2, builder: 1, upgrader: 1, repair: 0,
    courier: 1, luna: 8, scout: 1, queen: 2,
    CombatArcher: 0, CombatMelee: 0, CombatMedic: 0,
    Dismantler: 0, Claimer: 2
  };

  // Current counts by task
  var tasks = {};
  var k;
  for (k in maxTasks) if (maxTasks.hasOwnProperty(k)) tasks[k] = 0;
  for (var i = 0; i < workerBees.length; i++) {
    var t = (workerBees[i].memory && workerBees[i].memory.task) ? workerBees[i].memory.task : 'idle';
    if (tasks.hasOwnProperty(t)) tasks[t] = (tasks[t] | 0) + 1;
  }

  // Sum of maxes for header total
  var maxTotal = 0;
  for (k in maxTasks) if (maxTasks.hasOwnProperty(k)) maxTotal += (maxTasks[k] | 0);

  // table geometry
  var nameW = 4.2, valueW = 1.4, cellH = 0.7;
  var rows  = 1 /*header*/ + Object.keys(maxTasks).length;
  var innerW = nameW + valueW;
  var innerH = rows * cellH + 0.6; // padding

  // reserve outer box (with a bit of padding)
  var outerW = innerW + 0.8;
  var outerH = innerH + 0.6;

  var pos = _reserveBottomRight(room.name, outerW, outerH);
  var xLeft = pos.leftX + 0.4; // inner padding
  var yTop  = pos.topY  + 0.3;

  // panel backdrop
  v.rect(pos.leftX + 0.15, pos.topY + 0.15, outerW - 0.3, outerH - 0.3, {
    fill: '#000000', opacity: 0.18, stroke: '#333333'
  });

  // header row
  v.rect(xLeft, yTop, nameW, cellH, { fill: CFG.colors.panelFill, stroke: CFG.colors.panelStroke, opacity: CFG.alpha.panel, radius: 0.05 });
  v.rect(xLeft + nameW, yTop, valueW, cellH, { fill: CFG.colors.panelFill, stroke: CFG.colors.panelStroke, opacity: CFG.alpha.panel, radius: 0.05 });
  text(v, 'Worker_Bee', xLeft + 0.3, yTop + cellH / 2 + 0.15, 0.5, 'left', 1);
  text(v, totalCount + '/' + maxTotal, xLeft + nameW + valueW - 0.3, yTop + cellH / 2 + 0.15, 0.5, 'right', 1);

  // body rows
  var row = 1;
  for (k in maxTasks) {
    if (!maxTasks.hasOwnProperty(k)) continue;
    var y = yTop + row * cellH;
    var val = (tasks[k] | 0) + '/' + (maxTasks[k] | 0);

    v.rect(xLeft, y, nameW, cellH, { fill: CFG.colors.panelFill, stroke: CFG.colors.panelStroke, opacity: CFG.alpha.panel, radius: 0.05 });
    v.rect(xLeft + nameW, y, valueW, cellH, { fill: CFG.colors.panelFill, stroke: CFG.colors.panelStroke, opacity: CFG.alpha.panel, radius: 0.05 });
    text(v, k,   xLeft + 0.3, y + cellH / 2 + 0.15, 0.5, 'left', 1);
    text(v, val, xLeft + nameW + valueW - 0.3, y + cellH / 2 + 0.15, 0.5, 'right', 1);

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
      var rx     = step.x | 0;
      var ry     = step.y | 0;
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

/**
 * Draws:
 *  - Flag rings for flags named like "SRC-*" (tweak prefix if needed)
 *  - Planned road dots across all rooms (from memory planner paths)
 * Throttled by CFG.worldDrawModulo (0 disables).
 */
BeeVisuals.drawWorldOverview = function () {
  var mod = CFG.worldDrawModulo | 0;
  if (mod <= 0) return;
  if ((Game.time % mod) !== 0) return;

  var mv = Game.map.visual; // MapVisual (global)
  var drawnFlags = 0;
  var tiles      = 0;

  // 1) World flag rings (prefix filter)
  for (var fname in Game.flags) {
    if (!Game.flags.hasOwnProperty(fname)) continue;
    if (fname.indexOf('SRC-') !== 0) continue; // adjust prefix if you like
    var f = Game.flags[fname];

    mv.circle(f.pos, { radius: 5.0, fill: 'transparent', stroke: '#ffd54f', opacity: 0.9, strokeWidth: 0.8 });
    mv.circle(f.pos, { radius: 0.9, fill: '#ffd54f', opacity: 0.9 });

    drawnFlags++;
    if (drawnFlags >= CFG.worldMaxFlagMarkers) break;
  }

  // 2) Planned road tiles on the world map (from all rooms' planner memory)
  if (Memory.rooms) {
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
          var pos  = new RoomPosition(step.x | 0, step.y | 0, step.roomName || rn);

          mv.circle(pos, { radius: 0.8, fill: CFG.colors.plannedRoad, opacity: 0.6 });

          tiles++;
          if (tiles >= CFG.worldMaxPlannedTiles) return; // stop if we hit our cap
        }
      }
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

/** Cyan dots near the first spawn showing TaskBuilder.structurePlacements, if present. */
function drawStructurePlacementDots(visual, room) {
  var firstSpawn = null;
  for (var sn in Game.spawns) {
    if (!Game.spawns.hasOwnProperty(sn)) continue;
    firstSpawn = Game.spawns[sn];
    break;
  }
  if (!firstSpawn) return;

  if (TaskBuilder && TaskBuilder.structurePlacements) {
    var baseX = firstSpawn.pos.x;
    var baseY = firstSpawn.pos.y;
    var placements = TaskBuilder.structurePlacements;

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
