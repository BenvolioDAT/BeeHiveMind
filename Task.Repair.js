'use strict';

/**
 * What changed & why:
 * - Replaced ad-hoc queue popping with BeeSelectors.reserveRepairTarget so creeps and towers share one repair list.
 * - Adopted persistent _task envelopes with BeeActions wrappers for movement intents and safe execution.
 * - Uses snapshot-based energy sourcing (drops/containers/storage) instead of per-tick room.find spam.
 */

var BeeSelectors = require('BeeSelectors');
var BeeActions = require('BeeActions');
var MovementManager = require('Movement.Manager');

var CFG = Object.freeze({
  DEBUG_SAY: false,
  DEBUG_DRAW: true,
  DRAW: {
    GATHER: '#ffd480',
    REPAIR: '#2ad1c9',
    IDLE: '#bfbfbf',
    WIDTH: 0.12,
    OPACITY: 0.45,
    FONT: 0.6
  },
  STUCK_TICKS: 4,
  GATHER_REUSE: 15,
  REPAIR_REUSE: 10
});

function debugSay(creep, msg) {
  if (CFG.DEBUG_SAY && creep && msg) creep.say(msg, true);
}

function drawLine(creep, target, color, label) {
  if (!CFG.DEBUG_DRAW || !creep || !target) return;
  var room = creep.room;
  if (!room || !room.visual) return;
  var pos = target.pos || target;
  if (!pos || pos.roomName !== room.name) return;
  try {
    room.visual.line(creep.pos, pos, {
      color: color,
      width: CFG.DRAW.WIDTH,
      opacity: CFG.DRAW.OPACITY
    });
    if (label) {
      room.visual.text(label, pos.x, pos.y - 0.3, {
        color: color,
        font: CFG.DRAW.FONT,
        opacity: CFG.DRAW.OPACITY,
        align: 'center'
      });
    }
  } catch (e) {}
}

function ensureTask(creep) {
  if (!creep.memory) return;
  if (!creep.memory._task) creep.memory._task = null;
}

function clearTask(creep) {
  if (!creep.memory) return;
  var existing = creep.memory._task;
  if (existing && existing.type === 'repair') {
    BeeSelectors.releaseRepairTarget(creep.room.name, existing.targetId);
  }
  creep.memory._task = null;
}

function chooseGatherTask(creep) {
  var room = creep.room;
  var tomb = BeeSelectors.findTombstoneWithEnergy(room);
  if (tomb) {
    return { type: 'gather', targetId: tomb.id, since: Game.time, data: { mode: 'withdraw', source: 'tomb' } };
  }
  var ruin = BeeSelectors.findRuinWithEnergy(room);
  if (ruin) {
    return { type: 'gather', targetId: ruin.id, since: Game.time, data: { mode: 'withdraw', source: 'ruin' } };
  }
  var drop = BeeSelectors.findBestEnergyDrop(room);
  if (drop) {
    return { type: 'gather', targetId: drop.id, since: Game.time, data: { mode: 'pickup', source: 'drop' } };
  }
  var container = BeeSelectors.findBestEnergyContainer(room);
  if (container) {
    return { type: 'gather', targetId: container.id, since: Game.time, data: { mode: 'withdraw', source: 'container' } };
  }
  var summary = BeeSelectors.getRoomEnergyData(room);
  if (summary && summary.storage && (summary.storage.store[RESOURCE_ENERGY] | 0) > 0) {
    return { type: 'gather', targetId: summary.storage.id, since: Game.time, data: { mode: 'withdraw', source: 'storage' } };
  }
  if (summary && summary.terminal && (summary.terminal.store[RESOURCE_ENERGY] | 0) > 0) {
    return { type: 'gather', targetId: summary.terminal.id, since: Game.time, data: { mode: 'withdraw', source: 'terminal' } };
  }
  return null;
}

function chooseRepairTask(creep) {
  var entry = BeeSelectors.reserveRepairTarget(creep.room, creep.name);
  if (!entry || !entry.target) return null;
  return {
    type: 'repair',
    targetId: entry.target.id,
    since: Game.time,
    data: { goalHits: entry.goalHits }
  };
}

function needNewTask(creep, task) {
  if (!task) return true;
  if (!task.data) task.data = {};
  var target = Game.getObjectById(task.targetId);
  if (task.type === 'gather') {
    if (!target) return true;
    if (creep.store.getFreeCapacity() === 0) return true;
    if (task.data.mode === 'pickup') {
      if (!target.amount || target.amount <= 0) return true;
    } else if (target.store && (target.store[RESOURCE_ENERGY] | 0) === 0) {
      return true;
    }
  } else if (task.type === 'repair') {
    if (creep.store[RESOURCE_ENERGY] === 0) return true;
    if (!target) return true;
    var goal = task.data.goalHits || target.hitsMax;
    if (target.hits >= goal) return true;
  }
  if (task.data.lastPosX === creep.pos.x && task.data.lastPosY === creep.pos.y) {
    task.data.stuck = (task.data.stuck | 0) + 1;
    if (task.data.stuck >= CFG.STUCK_TICKS) return true;
  } else {
    task.data.stuck = 0;
    task.data.lastPosX = creep.pos.x;
    task.data.lastPosY = creep.pos.y;
  }
  return false;
}

function executeGather(creep, task) {
  var target = Game.getObjectById(task.targetId);
  if (!target) {
    clearTask(creep);
    return;
  }
  drawLine(creep, target, CFG.DRAW.GATHER, 'ENERGY');
  debugSay(creep, '🔄');
  var rc;
  if (task.data.mode === 'pickup') {
    rc = BeeActions.safePickup(creep, target, { reusePath: CFG.GATHER_REUSE });
  } else {
    rc = BeeActions.safeWithdraw(creep, target, RESOURCE_ENERGY, { reusePath: CFG.GATHER_REUSE });
  }
  if (rc === OK && creep.store.getFreeCapacity() === 0) clearTask(creep);
}

function executeRepair(creep, task) {
  var target = Game.getObjectById(task.targetId);
  if (!target) {
    clearTask(creep);
    return;
  }
  drawLine(creep, target, CFG.DRAW.REPAIR, 'FIX');
  debugSay(creep, '🔧');
  var rc = BeeActions.safeRepair(creep, target, { reusePath: CFG.REPAIR_REUSE });
  if (rc === OK) {
    if (task.data.goalHits && target.hits >= task.data.goalHits) {
      BeeSelectors.releaseRepairTarget(creep.room.name, target.id);
      clearTask(creep);
    }
  }
  if (creep.store[RESOURCE_ENERGY] === 0) clearTask(creep);
}

var TaskRepair = {
  run: function (creep) {
    if (!creep || creep.spawning) return;
    ensureTask(creep);
    var task = creep.memory._task;
    if (needNewTask(creep, task)) {
      if (task && task.type === 'repair') BeeSelectors.releaseRepairTarget(creep.room.name, task.targetId);
      var newTask = null;
      if (creep.store[RESOURCE_ENERGY] === 0) {
        newTask = chooseGatherTask(creep);
      } else {
        newTask = chooseRepairTask(creep);
      }
      if (!newTask && creep.store[RESOURCE_ENERGY] > 0) newTask = chooseRepairTask(creep);
      if (!newTask) {
        debugSay(creep, '🧘');
        var anchor = BeeSelectors.findRoomAnchor(creep.room);
        if (anchor) {
          MovementManager.request(creep, anchor, MovementManager.PRIORITIES.idle, { range: 2, reusePath: CFG.REPAIR_REUSE, intentType: 'idle' });
        }
        clearTask(creep);
        return;
      }
      creep.memory._task = newTask;
      task = newTask;
    }
    if (!task) return;
    if (task.type === 'gather') {
      executeGather(creep, task);
      return;
    }
    if (task.type === 'repair') {
      executeRepair(creep, task);
      return;
    }
    clearTask(creep);
  }
};

module.exports = TaskRepair;
