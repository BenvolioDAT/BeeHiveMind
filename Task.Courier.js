'use strict';

/**
 * What changed & why:
 * - Rebuilt courier role around persistent _task envelopes so targets stick until exhausted or invalid.
 * - Uses BeeSelectors for cached lookups and BeeActions for action safety plus movement intents.
 * - Integrates Logistics haul hints and emits visual breadcrumbs guarded by CFG.DEBUG flags.
 */

var BeeSelectors = require('BeeSelectors');
var BeeActions = require('BeeActions');

var CFG = Object.freeze({
  DEBUG_SAY: false,
  DEBUG_DRAW: true,
  DRAW: {
    WITHDRAW: '#6ec1ff',
    DELIVER: '#6effa1',
    PICKUP: '#ffe66e',
    IDLE: '#bfbfbf',
    WIDTH: 0.12,
    OPACITY: 0.45,
    FONT: 0.6
  },
  STUCK_TICKS: 6,
  MOVE_PRIORITIES: {
    withdraw: 50,
    pickup: 60,
    deliver: 40
  }
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
      opacity: CFG.DRAW.OPACITY,
      lineStyle: 'solid'
    });
    if (label) {
      room.visual.text(label, pos.x, pos.y - 0.3, {
        color: color,
        opacity: CFG.DRAW.OPACITY,
        font: CFG.DRAW.FONT,
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
  creep.memory._task = null;
}

function claimHaulRequest(creep) {
  if (!Memory.__BHM || Memory.__BHM.haulTick !== Game.time) return null;
  var reqs = Memory.__BHM.haulRequests || [];
  for (var i = 0; i < reqs.length; i++) {
    var r = reqs[i];
    if (!r) continue;
    if (r.room !== creep.room.name) continue;
    if (r.resource !== RESOURCE_ENERGY) continue;
    return r;
  }
  return null;
}

function pickWithdrawTask(creep) {
  var room = creep.room;
  var summary = BeeSelectors.getRoomEnergyData(room);
  if (!summary) return null;
  var tomb = BeeSelectors.findTombstoneWithEnergy(room);
  if (tomb) {
    return { type: 'withdraw', targetId: tomb.id, since: Game.time, data: { source: 'tomb' } };
  }
  var ruin = BeeSelectors.findRuinWithEnergy(room);
  if (ruin) {
    return { type: 'withdraw', targetId: ruin.id, since: Game.time, data: { source: 'ruin' } };
  }
  var drop = BeeSelectors.findBestEnergyDrop(room);
  if (drop) {
    return { type: 'pickup', targetId: drop.id, since: Game.time, data: { source: 'drop' } };
  }
  var container = BeeSelectors.findBestEnergyContainer(room);
  if (container) {
    return { type: 'withdraw', targetId: container.id, since: Game.time, data: { source: 'container' } };
  }
  if (summary.terminal && (summary.terminal.store[RESOURCE_ENERGY] | 0) > 0) {
    return { type: 'withdraw', targetId: summary.terminal.id, since: Game.time, data: { source: 'terminal' } };
  }
  if (summary.storage && (summary.storage.store[RESOURCE_ENERGY] | 0) > 0) {
    return { type: 'withdraw', targetId: summary.storage.id, since: Game.time, data: { source: 'storage' } };
  }
  return null;
}

function pickDeliverTask(creep) {
  var room = creep.room;
  var targets = BeeSelectors.findSpawnLikeNeedingEnergy(room);
  var chosen = BeeSelectors.selectClosestByRange(creep.pos, targets);
  if (chosen) {
    return { type: 'deliver', targetId: chosen.id, since: Game.time, data: { sink: 'spawnLike' } };
  }
  var towers = BeeSelectors.findTowersNeedingEnergy(room);
  chosen = BeeSelectors.selectClosestByRange(creep.pos, towers);
  if (chosen) {
    return { type: 'deliver', targetId: chosen.id, since: Game.time, data: { sink: 'tower' } };
  }
  var haul = claimHaulRequest(creep);
  if (haul && room.storage) {
    return { type: 'deliver', targetId: room.storage.id, since: Game.time, data: { sink: 'haul', request: haul } };
  }
  var storage = BeeSelectors.findStorageNeedingEnergy(room);
  if (storage) {
    return { type: 'deliver', targetId: storage.id, since: Game.time, data: { sink: 'storage' } };
  }
  if (room.terminal) {
    return { type: 'deliver', targetId: room.terminal.id, since: Game.time, data: { sink: 'terminal' } };
  }
  return null;
}

function needNewTask(creep, task) {
  if (!task) return true;
  var target = Game.getObjectById(task.targetId);
  if (!target) return true;
  if (task.type === 'withdraw' || task.type === 'pickup') {
    if (creep.store.getFreeCapacity() === 0) return true;
    if (task.type === 'withdraw' && target.store && (target.store[RESOURCE_ENERGY] | 0) === 0) return true;
    if (task.type === 'pickup' && target.amount <= 0) return true;
  }
  if (task.type === 'deliver') {
    if (creep.store[RESOURCE_ENERGY] === 0) return true;
    if (target.store && target.store.getFreeCapacity(RESOURCE_ENERGY) === 0) return true;
    if (target.energyCapacity != null && (target.energy | 0) >= (target.energyCapacity | 0)) return true;
  }
  if (!task.data) task.data = {};
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

function executeTask(creep, task) {
  if (!task) return;
  var target = Game.getObjectById(task.targetId);
  if (!target) {
    clearTask(creep);
    return;
  }
  var priority = CFG.MOVE_PRIORITIES[task.type] || 0;
  if (task.type === 'withdraw') {
    drawLine(creep, target, CFG.DRAW.WITHDRAW, 'WD');
    debugSay(creep, '📦');
    var withdrawOpts = { priority: priority, reusePath: 20 };
    var rc = BeeActions.safeWithdraw(creep, target, RESOURCE_ENERGY, withdrawOpts);
    if (rc === OK && creep.store.getFreeCapacity() === 0) clearTask(creep);
    return;
  }
  if (task.type === 'pickup') {
    drawLine(creep, target, CFG.DRAW.PICKUP, 'DROP');
    debugSay(creep, '🍪');
    var pickupOpts = { priority: priority, reusePath: 10 };
    var pc = BeeActions.safePickup(creep, target, pickupOpts);
    if (pc === OK && creep.store.getFreeCapacity() === 0) clearTask(creep);
    return;
  }
  if (task.type === 'deliver') {
    drawLine(creep, target, CFG.DRAW.DELIVER, 'DEL');
    debugSay(creep, '🚚');
    var transferOpts = { priority: priority, reusePath: 20 };
    var tr = BeeActions.safeTransfer(creep, target, RESOURCE_ENERGY, null, transferOpts);
    if (tr === OK && creep.store[RESOURCE_ENERGY] === 0) clearTask(creep);
    return;
  }
}

var TaskCourier = {
  run: function (creep) {
    if (!creep || creep.spawning) return;
    ensureTask(creep);
    var task = creep.memory._task;
    if (needNewTask(creep, task)) {
      var newTask = null;
      if (creep.store[RESOURCE_ENERGY] > 0) {
        newTask = pickDeliverTask(creep);
      }
      if (!newTask) {
        newTask = pickWithdrawTask(creep);
      }
      if (!newTask && creep.store[RESOURCE_ENERGY] > 0) {
        var storage = creep.room.storage || creep.room.terminal;
        if (storage) newTask = { type: 'deliver', targetId: storage.id, since: Game.time, data: { sink: 'fallback' } };
      }
      if (!newTask) {
        debugSay(creep, '🧘');
        if (CFG.DEBUG_DRAW) drawLine(creep, creep.pos, CFG.DRAW.IDLE, 'IDLE');
        clearTask(creep);
        return;
      }
      creep.memory._task = newTask;
      task = newTask;
    }
    executeTask(creep, task);
  }
};

module.exports = TaskCourier;
