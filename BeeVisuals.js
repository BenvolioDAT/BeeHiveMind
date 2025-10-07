// BeeVisuals.cpu.always.es5.js
// ES5-safe visuals that draw EVERY TICK (no blinking), with light CPU hygiene.

'use strict';

var TaskBuilder = require('Task.Builder'); // guarded below
var TaskManager = require('TaskManager');
var BeeToolbox = require('BeeToolbox');
var Logger = require('core.logger');
var LOG_LEVEL = Logger.LOG_LEVEL;

// Config: draw every tick, but keep caps to avoid runaway CPU
var CFG = {
  maxCreepsRenderedDebug: 30,
  showCpuStats: true,
  showRepairCounter: true,
  drawDebugEachTick: true,
  debugTickModulo: 1,
  tableTickModulo: 1,

  // World/overview map overlay throttles
  worldDrawModulo: 0,          // 1 = every tick (raise to 2/3 if you want less)
  worldMaxFlagMarkers: 600,    // hard cap marker count for safety
  worldMaxPlannedTiles: 800    // hard cap for planned-road dots
};

// ---------- helpers ----------
/**
 * Resolve the primary owned room for drawing HUD elements.
 * @returns {Room|null} First owned room detected or null when none.
 * @sideeffects None.
 * @cpu Low because it scans spawns at most once.
 * @memory None beyond local variables.
 */
function _getMainRoom() {
  var rn = Memory.firstSpawnRoom;
  if (rn && Game.rooms[rn]) return Game.rooms[rn];
  for (var name in Game.spawns) {
    if (!Game.spawns.hasOwnProperty(name)) continue;
    var sp = Game.spawns[name];
    if (sp && sp.room) return sp.room;
  }
  return null;
}
/**
 * Determine whether visuals for a room should render on this tick.
 * @param {number} mod Tick modulo throttling value.
 * @param {string} roomName Room identifier.
 * @returns {boolean} True when drawing should occur.
 * @sideeffects None.
 * @cpu O(len(roomName)).
 * @memory None.
 */
function _shouldDraw(mod, roomName) {
  if (mod <= 1) return true;
  var h = 0;
  for (var i = 0; i < roomName.length; i++) h = (h * 31 + roomName.charCodeAt(i)) | 0;
  return ((Game.time + (h & 3)) % mod) === 0;
}

// ---------- module ----------
var BeeVisuals = {
  /**
   * Render the main per-tick in-room HUD visuals.
   * @returns {void}
   * @sideeffects Draws visuals and mutates Memory.lastCpuUsage, Memory.GameTickRepairCounter.
   * @cpu Moderate due to iteration over creeps and optional overlays.
   * @memory Uses transient arrays only.
   */
  drawVisuals: function () {
    var room = _getMainRoom();
    if (!room) return;

    var visual = new RoomVisual(room.name);

    // DEBUG creep lines
    if (Logger.shouldLog(LOG_LEVEL.DEBUG) && (CFG.drawDebugEachTick || _shouldDraw(CFG.debugTickModulo, room.name))) {
      var yOffset = 1;
      var count = 0;
      for (var cname in Game.creeps) {
        if (!Game.creeps.hasOwnProperty(cname)) continue;
        var creep = Game.creeps[cname];

        var parts = [];
        parts.push((creep.name || 'bee') + ': ' + (creep.ticksToLive || 0));
        if (creep.memory && creep.memory.assignedSource) parts.push('A.S.ID:' + creep.memory.assignedSource);
        if (creep.memory && creep.memory.assignedContainer) parts.push('C.ID:' + creep.memory.assignedContainer);
        if (creep.memory && creep.memory.targetRoom) parts.push('T.R:' + creep.memory.targetRoom);
        if (creep.memory && creep.memory.sourceId) parts.push('S.ID:' + creep.memory.sourceId);

        visual.text(parts.join(', '), 0, yOffset, { color: 'white', font: 0.5, opacity: 1, align: 'left' });
        yOffset += 1;
        count++;
        if (count >= CFG.maxCreepsRenderedDebug) break;
      }

      var plannerState = null;
      if (BeeToolbox && typeof BeeToolbox.getPlannerState === 'function') {
        plannerState = BeeToolbox.getPlannerState(room.name);
      }
      if (plannerState && plannerState.placements && plannerState.placements.length) {
        var MAX_PLACEMENTS = 75;
        var colors = {
          structure_extension: '#66ccff',
          structure_road: '#cccccc',
          structure_tower: '#ff6666',
          structure_storage: '#ffcc66',
          structure_container: '#a1887f',
          structure_link: '#b388ff',
          structure_lab: '#ff99ff'
        };
        var drawn = 0;
        for (var pi = 0; pi < plannerState.placements.length && drawn < MAX_PLACEMENTS; pi++) {
          var placement = plannerState.placements[pi];
          if (!placement) continue;
          var typeKey = String(placement.type || '').toLowerCase();
          var color = colors[typeKey] || '#66ccff';
          visual.circle(placement.x, placement.y, { radius: 0.35, opacity: 0.35, stroke: color, fill: 'transparent' });
          drawn++;
        }
        if (plannerState.anchor) {
          visual.circle(plannerState.anchor.x, plannerState.anchor.y, { radius: 0.45, opacity: 0.3, stroke: '#ffffff' });
        }
      } else {
        var firstSpawn = null;
        for (var sn in Game.spawns) { if (Game.spawns.hasOwnProperty(sn)) { firstSpawn = Game.spawns[sn]; break; } }
        if (firstSpawn && TaskBuilder && TaskBuilder.structurePlacements) {
          var baseX = firstSpawn.pos.x;
          var baseY = firstSpawn.pos.y;
          var placements = TaskBuilder.structurePlacements;
          for (var p = 0; p < placements.length; p++) {
            var pl = placements[p];
            visual.circle(baseX + pl.x, baseY + pl.y, { radius: 0.4, opacity: 0.1, stroke: 'cyan' });
          }
        }
      }
    }

    // CPU + bucket readouts
    if (CFG.showCpuStats) {
      var used = Game.cpu.getUsed();
      var last = Memory.lastCpuUsage || 0;
      var delta = used - last;
      Memory.lastCpuUsage = used;

      visual.text('CPU Bucket: ' + Game.cpu.bucket, 20, 1, { color: 'white', font: 0.6, opacity: 1 });
      visual.text('CPU Used: ' + used.toFixed(2) + ' / Δ ' + delta.toFixed(2), 20, 2, { color: 'white', font: 0.6, opacity: 1 });
    }

    // In-room planned roads (DEBUG)
    BeeVisuals.drawPlannedRoadsDebug();

    // NEW: world/overview map overlays (flags + planned roads)
    BeeVisuals.drawWorldOverview();

    // Repair counter
    if (CFG.showRepairCounter) {
      var counter = Memory.GameTickRepairCounter || 0;
      visual.text('Repair Tick Count: ' + counter + '/5', 20, 3, { color: 'white', font: 0.6, opacity: 1 });
    }
  },

  /**
   * Draw an energy availability bar in the main room.
   * @returns {void}
   * @sideeffects Renders visuals only.
   * @cpu Low.
   * @memory None.
   */
  drawEnergyBar: function () {
    var room = _getMainRoom();
    if (!room) return;

    var visuals = new RoomVisual(room.name);
    var energy = room.energyAvailable | 0;
    var capacity = room.energyCapacityAvailable | 0;
    var pct = (capacity > 0) ? (energy / capacity) : 0;

    var x = 0, y = 19, width = 5.2, height = 1;

    visuals.rect(x, y, width, height, { fill: '#000000', opacity: 0.3, stroke: '#000000' });
    visuals.rect(x, y, width * pct, height, { fill: '#00ff00', opacity: 0.5, stroke: '#000000' });
    visuals.text(String(energy) + '/' + String(capacity), x + width / 2, y + height - 0.15, {
      color: 'white', font: 0.5, align: 'center', opacity: 1, stroke: '#000000'
    });
  },

  /**
   * Display a table of worker bee task assignments.
   * @returns {void}
   * @sideeffects Draws visuals.
   * @cpu Moderate when enumerating creeps.
   * @memory Temporary counters only.
   */
  drawWorkerBeeTaskTable: function () {
    var room = _getMainRoom();
    if (!room) return;
    if (!_shouldDraw(CFG.tableTickModulo, room.name)) return;

    var visual = new RoomVisual(room.name);

    var workerBees = [];
    for (var cn in Game.creeps) {
      if (!Game.creeps.hasOwnProperty(cn)) continue;
      var c = Game.creeps[cn];
      if (c && c.memory && c.memory.role === 'Worker_Bee') workerBees.push(c);
    }
    var totalCount = workerBees.length | 0;

    var displayOrder = [
      'baseharvest', 'courier', 'builder', 'upgrader', 'repair',
      'luna', 'queen', 'Trucker', 'scout',
      'CombatMelee', 'CombatArcher', 'CombatMedic',
      'Dismantler', 'Claimer'
    ];

    var fallbackMax = {
      baseharvest: 2,
      courier: 1,
      builder: 1,
      upgrader: 1,
      repair: 0,
      luna: 4,
      queen: 1,
      Trucker: 0,
      scout: 1,
      CombatMelee: 0,
      CombatArcher: 0,
      CombatMedic: 0,
      Dismantler: 0,
      Claimer: 1
    };

    var dynamicDesired = {};
    if (TaskManager && typeof TaskManager.getDesiredTaskCounts === 'function') {
      dynamicDesired = TaskManager.getDesiredTaskCounts();
    }

    var maxTasks = Object.create(null);
    for (var di = 0; di < displayOrder.length; di++) {
      var key = displayOrder[di];
      var desired = (dynamicDesired && dynamicDesired[key] != null) ? (dynamicDesired[key] | 0) : (fallbackMax[key] | 0);
      maxTasks[key] = desired;
    }

    var tasks = {};
    var k;
    for (k = 0; k < displayOrder.length; k++) {
      tasks[displayOrder[k]] = 0;
    }
    for (var i = 0; i < workerBees.length; i++) {
      var t = (workerBees[i].memory && workerBees[i].memory.task) ? workerBees[i].memory.task : 'idle';
      if (tasks.hasOwnProperty(t)) tasks[t] = (tasks[t] | 0) + 1;
    }

    var maxTotal = 0;
    for (k = 0; k < displayOrder.length; k++) {
      maxTotal += (maxTasks[displayOrder[k]] | 0);
    }

    var x0 = 0, y0 = 20;
    var nameW = 4, valueW = 1.2, cellH = 0.7;
    var font = 0.5, fillColor = '#000000', strokeColor = '#000000', opacityLvl = 0.4;

    visual.rect(x0, y0, nameW, cellH, { fill: fillColor, stroke: strokeColor, opacity: opacityLvl, radius: 0.05 });
    visual.rect(x0 + nameW, y0, valueW, cellH, { fill: fillColor, stroke: strokeColor, opacity: opacityLvl, radius: 0.05 });
    visual.text('Worker_Bee', x0 + 0.3, y0 + cellH / 2 + 0.15, { font: font, color: '#ffffff', align: 'left', opacity: 1 });
    visual.text(String(totalCount) + '/' + String(maxTotal), x0 + nameW + valueW - 0.3, y0 + cellH / 2 + 0.15, { font: font, color: '#ffffff', align: 'right', opacity: 1 });

    var row = 1;
    for (var orderIdx = 0; orderIdx < displayOrder.length; orderIdx++) {
      var taskName = displayOrder[orderIdx];
      var y = y0 + row * cellH;
      var val = String(tasks[taskName] | 0) + '/' + String(maxTasks[taskName] | 0);

      visual.rect(x0, y, nameW, cellH, { fill: fillColor, stroke: strokeColor, opacity: opacityLvl, radius: 0.05 });
      visual.rect(x0 + nameW, y, valueW, cellH, { fill: fillColor, stroke: strokeColor, opacity: opacityLvl, radius: 0.05 });
      visual.text(taskName, x0 + 0.3, y + cellH / 2 + 0.15, { font: font, color: '#ffffff', align: 'left', opacity: 1 });
      visual.text(val, x0 + nameW + valueW - 0.3, y + cellH / 2 + 0.15, { font: font, color: '#ffffff', align: 'right', opacity: 1 });

      row++;
    }
  }
};

// --- Planned road overlay (in-room, DEBUG only) ---
/**
 * Render debug markers for planned roads stored by the planner.
 * @returns {void}
 * @sideeffects Draws visuals for debugging.
 * @cpu Moderate due to iterating planned segments.
 * @memory Temporary arrays only.
 */
BeeVisuals.drawPlannedRoadsDebug = function () {
  if (!Logger.shouldLog(LOG_LEVEL.DEBUG)) return;
  var room = _getMainRoom(); if (!room) return;
  var MOD = 1; if (((Game.time + 3) % MOD) !== 0) return;

  var v = new RoomVisual(room.name);

  if (!Memory.rooms || !Memory.rooms[room.name] || !Memory.rooms[room.name].roadPlanner) return;
  var rp = Memory.rooms[room.name].roadPlanner;
  var paths = rp.paths || {};
  var key;

  var MAX_PATHS = 6;
  var MAX_TILES = 250;

  var drawnPaths = 0;
  var drawnTiles = 0;

  var COLOR_PLANNED = '#ffe066';
  var COLOR_BUILT   = '#99ff99';
  var COLOR_CURSOR  = '#66ccff';

/**
 * Quickly check if a tile already hosts a road or road construction site.
 * @param {Room} roomObj Room context.
 * @param {number} x Tile X coordinate.
 * @param {number} y Tile Y coordinate.
 * @returns {boolean} True when a road exists or is planned on the tile.
 * @sideeffects None.
 * @cpu Low per call.
 * @memory None.
 */
function _hasRoadOrSiteFast(roomObj, x, y) {
    var arr = roomObj.lookForAt(LOOK_STRUCTURES, x, y);
    for (var i = 0; i < arr.length; i++) if (arr[i].structureType === STRUCTURE_ROAD) return true;
    var siteArr = roomObj.lookForAt(LOOK_CONSTRUCTION_SITES, x, y);
    for (var j = 0; j < siteArr.length; j++) if (siteArr[j].structureType === STRUCTURE_ROAD) return true;
    return false;
  }

  for (key in paths) {
    if (!paths.hasOwnProperty(key)) continue;
    if (drawnPaths >= MAX_PATHS) break;

    var rec = paths[key];
    if (!rec || !rec.path || !rec.path.length) continue;

    v.text(key, 1, 5 + (drawnPaths * 0.6), { color: '#ffffff', font: 0.5, opacity: 0.6, align: 'left' });

    var lastX = -1, lastY = -1, lastRoom = null;

    for (var idx = 0; idx < rec.path.length; idx++) {
      if (drawnTiles >= MAX_TILES) break;

      var step = rec.path[idx];
      var rname = step.roomName;
      var rx = step.x | 0, ry = step.y | 0;
      var theRoom = Game.rooms[rname];
      if (!theRoom) continue;

      if (typeof rec.i === 'number' && idx === rec.i) {
        new RoomVisual(rname).circle(rx, ry, { radius: 0.4, stroke: COLOR_CURSOR, fill: 'transparent', opacity: 0.7 });
      }

      if (theRoom.getTerrain().get(rx, ry) === TERRAIN_MASK_WALL) continue;

      var already = _hasRoadOrSiteFast(theRoom, rx, ry);
      var color = already ? COLOR_BUILT : COLOR_PLANNED;
      var opacity = already ? 0.55 : 0.35;

      new RoomVisual(rname).circle(rx, ry, { radius: 0.25, fill: color, opacity: opacity, stroke: undefined });

      if (lastRoom === rname && lastX !== -1) {
        new RoomVisual(rname).line(lastX, lastY, rx, ry, { width: 0.09, color: color, opacity: opacity });
      }

      lastX = rx; lastY = ry; lastRoom = rname;
      drawnTiles++;
      if (drawnTiles >= MAX_TILES) break;
    }

    if (rec.done && lastRoom === room.name && lastX !== -1) {
      v.text('✓', lastX, lastY, { color: COLOR_BUILT, font: 0.6, opacity: 0.7, align: 'center' });
    }

    drawnPaths++;
  }
};

// --- NEW: World/overview map overlays (flags + planned sites) ---
/**
 * Draw high-level world map overlays including flags and planned roads.
 * @returns {void}
 * @sideeffects Draws visuals on the world map.
 * @cpu Moderate when data volume high.
 * @memory Temporary arrays only.
 */
BeeVisuals.drawWorldOverview = function () {
  // Throttle — treat 0/false as "disabled"
  var mod = CFG.worldDrawModulo | 0;
  if (mod <= 0) return;
  if ((Game.time % mod) !== 0) return;

  var mv = Game.map.visual; // MapVisual

  // 1) Source flags on the world map (any room, no vision required)
  var drawn = 0;
  for (var fname in Game.flags) {
    if (!Game.flags.hasOwnProperty(fname)) continue;
    if (fname.indexOf('SRC-') !== 0) continue; // your source-flag prefix
    var f = Game.flags[fname];

    // A visible yellow ring + small center dot
    mv.circle(f.pos, { radius: 5.0, fill: 'transparent', stroke: '#ffd54f', opacity: 0.9, strokeWidth: 0.8 });
    mv.circle(f.pos, { radius: 0.9, fill: '#ffd54f', opacity: 0.9 });

    drawn++;
    if (drawn >= CFG.worldMaxFlagMarkers) break;
  }

  // 2) Planned construction (roads) on the world map.
  //    Uses the same Memory.rooms[*].roadPlanner.paths you already render in-room.
  var tiles = 0;
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
          var pos = new RoomPosition(step.x | 0, step.y | 0, step.roomName || rn);

          // amber dot per planned tile
          mv.circle(pos, { radius: 0.8, fill: '#ffe066', opacity: 0.6, stroke: undefined });

          tiles++;
          if (tiles >= CFG.worldMaxPlannedTiles) return; // stop early if we hit our cap
        }
      }
    }
  }

  // (Optional) If you ever want to draw lines between rooms:
  // Game.map.visual.connectRooms('W38S47', 'W39S47', { color: '#66ccff', width: 1, opacity: 0.4 });
};

module.exports = BeeVisuals;
