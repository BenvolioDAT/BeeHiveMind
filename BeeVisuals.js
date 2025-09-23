// BeeVisuals.cpu.always.es5.js
// ES5-safe visuals that draw EVERY TICK (no blinking), with light CPU hygiene.

'use strict';

var TaskBuilder = require('Task.Builder'); // guarded below

// Logging fallback (uses your global currentLogLevel if present)
var LOG_LEVEL = { NONE: 0, BASIC: 1, DEBUG: 2 };
var _logLevel = (typeof currentLogLevel === 'number') ? currentLogLevel : LOG_LEVEL.NONE;

// Config: draw every tick, but keep caps to avoid runaway CPU
var CFG = {
  maxCreepsRenderedDebug: 30, // cap per-creep debug lines
  showCpuStats: true,
  showRepairCounter: true,
  drawDebugEachTick: true,    // set false to throttle debug lines later if needed
  debugTickModulo: 1,         // 1 = every tick; raise if you want throttling later
  tableTickModulo: 1          // 1 = every tick; raise if you want throttling later
};

// ---------- helpers ----------
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
function _shouldDraw(mod, roomName) {
  if (mod <= 1) return true;
  // staggered hash (unused when mod=1)
  var h = 0;
  for (var i = 0; i < roomName.length; i++) h = (h * 31 + roomName.charCodeAt(i)) | 0;
  return ((Game.time + (h & 3)) % mod) === 0;
}

// ---------- module ----------
var BeeVisuals = {
  // Always called each tick
  drawVisuals: function () {
    var room = _getMainRoom();
    if (!room) return;

    var visual = new RoomVisual(room.name);

    // DEBUG creep lines (draw every tick by default)
    if (_logLevel >= LOG_LEVEL.DEBUG && (CFG.drawDebugEachTick || _shouldDraw(CFG.debugTickModulo, room.name))) {
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

      // structure placement markers near first spawn (cheap)
      var firstSpawn = null;
      for (var sn in Game.spawns) { if (Game.spawns.hasOwnProperty(sn)) { firstSpawn = Game.spawns[sn]; break; } }
      if (firstSpawn && TaskBuilder && TaskBuilder.structurePlacements) {
        var baseX = firstSpawn.pos.x;
        var baseY = firstSpawn.pos.y;
        var placements = TaskBuilder.structurePlacements;
        for (var p = 0; p < placements.length; p++) {
          var pl = placements[p];
          visual.circle(baseX + pl.x, baseY + pl.y, { radius: 0.4, opacity: 0.1, stroke: 'cyan' });
          // Labels cost more CPU; keep off unless you really need them
          // visual.text(String(pl.type).replace('STRUCTURE_', ''), baseX + pl.x, baseY + pl.y, { font: 0.3, color: 'cyan' });
        }
      }
    }

    // CPU + bucket readouts (every tick so they stay visible)
    if (CFG.showCpuStats) {
      var used = Game.cpu.getUsed();
      var last = Memory.lastCpuUsage || 0;
      var delta = used - last;
      Memory.lastCpuUsage = used;

      visual.text('CPU Bucket: ' + Game.cpu.bucket, 20, 1, { color: 'white', font: 0.6, opacity: 1 });
      visual.text('CPU Used: ' + used.toFixed(2) + ' / Δ ' + delta.toFixed(2), 20, 2, { color: 'white', font: 0.6, opacity: 1 });
    }

    // Repair counter (every tick)
    if (CFG.showRepairCounter) {
      var counter = Memory.GameTickRepairCounter || 0;
      visual.text('Repair Tick Count: ' + counter + '/5', 20, 3, { color: 'white', font: 0.6, opacity: 1 });
    }
  },

  // Always draw each tick
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

  // By default: every tick too; you can throttle with tableTickModulo later
  drawWorkerBeeTaskTable: function () {
    var room = _getMainRoom();
    if (!room) return;
    if (!_shouldDraw(CFG.tableTickModulo, room.name)) return; // 1 => always

    var visual = new RoomVisual(room.name);

    // collect counts
    var workerBees = [];
    for (var cn in Game.creeps) {
      if (!Game.creeps.hasOwnProperty(cn)) continue;
      var c = Game.creeps[cn];
      if (c && c.memory && c.memory.role === 'Worker_Bee') workerBees.push(c);
    }
    var totalCount = workerBees.length | 0;

    var maxTasks = {
      baseharvest: 2,
      builder: 1,
      upgrader: 1,
      repair: 0,
      courier: 1,
      remoteharvest: 2,
      scout: 0,
      queen: 1,
      CombatArcher: 0,
      CombatMelee: 0,
      CombatMedic: 0,
      Dismantler: 0,
      Claimer: 0
    };

    var tasks = {};
    var k;
    for (k in maxTasks) if (maxTasks.hasOwnProperty(k)) tasks[k] = 0;
    for (var i = 0; i < workerBees.length; i++) {
      var t = (workerBees[i].memory && workerBees[i].memory.task) ? workerBees[i].memory.task : 'idle';
      if (tasks.hasOwnProperty(t)) tasks[t] = (tasks[t] | 0) + 1;
    }

    var maxTotal = 0;
    for (k in maxTasks) if (maxTasks.hasOwnProperty(k)) maxTotal += (maxTasks[k] | 0);

    // table drawing
    var x0 = 0, y0 = 20;
    var nameW = 4, valueW = 1.2, cellH = 0.7;
    var font = 0.5, fillColor = '#000000', strokeColor = '#000000', opacityLvl = 0.4;

    // header
    visual.rect(x0, y0, nameW, cellH, { fill: fillColor, stroke: strokeColor, opacity: opacityLvl, radius: 0.05 });
    visual.rect(x0 + nameW, y0, valueW, cellH, { fill: fillColor, stroke: strokeColor, opacity: opacityLvl, radius: 0.05 });
    visual.text('Worker_Bee', x0 + 0.3, y0 + cellH / 2 + 0.15, { font: font, color: '#ffffff', align: 'left', opacity: 1 });
    visual.text(String(totalCount) + '/' + String(maxTotal), x0 + nameW + valueW - 0.3, y0 + cellH / 2 + 0.15, { font: font, color: '#ffffff', align: 'right', opacity: 1 });

    var row = 1;
    for (k in maxTasks) {
      if (!maxTasks.hasOwnProperty(k)) continue;
      var y = y0 + row * cellH;
      var val = String(tasks[k] | 0) + '/' + String(maxTasks[k] | 0);

      visual.rect(x0, y, nameW, cellH, { fill: fillColor, stroke: strokeColor, opacity: opacityLvl, radius: 0.05 });
      visual.rect(x0 + nameW, y, valueW, cellH, { fill: fillColor, stroke: strokeColor, opacity: opacityLvl, radius: 0.05 });
      visual.text(k, x0 + 0.3, y + cellH / 2 + 0.15, { font: font, color: '#ffffff', align: 'left', opacity: 1 });
      visual.text(val, x0 + nameW + valueW - 0.3, y + cellH / 2 + 0.15, { font: font, color: '#ffffff', align: 'right', opacity: 1 });

      row++;
    }
  }
};

module.exports = BeeVisuals;
