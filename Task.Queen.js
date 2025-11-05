'use strict';

/**
 * What changed & why:
 * - Rebuilt the queen role around the shared _task envelope so targets persist across ticks until satisfied.
 * - Wired withdrawals/deliveries through BeeSelectors + BeeActions which queue movement intents for the MOVE phase.
 * - Added lightweight per-tick fill reservations plus debug breadcrumbs that respect CFG.DEBUG toggles.
 */

var BeeSelectors = require('BeeSelectors');
var BeeActions = require('BeeActions');
var MovementManager = require('Movement.Manager');

var CFG = Object.freeze({
  DEBUG_SAY: false,
  DEBUG_DRAW: true,
  DRAW: {
    WITHDRAW: '#69c3ff',
    DELIVER: '#7dff85',
    PICKUP: '#ffe66e',
    IDLE: '#bfbfbf',
    WIDTH: 0.12,
    OPACITY: 0.45,
    FONT: 0.6
  },
  STUCK_TICKS: 6,
  MOVE_PRIORITIES: {
    withdraw: 60,
    pickup: 70,
    deliver: 55,
    idle: 5
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

function ensureTaskSlot(creep) {
  if (!creep || !creep.memory) return;
  if (!creep.memory._task) creep.memory._task = null;
}

function setTask(creep, task) {
  if (!creep || !creep.memory) return;
  creep.memory._task = task;
}

function clearTask(creep) {
  if (!creep || !creep.memory) return;
  creep.memory._task = null;
}

function getReservationBucket() {
  if (!global.__BHM) global.__BHM = {};
  if (!global.__BHM.queenReservations || global.__BHM.queenReservations.tick !== Game.time) {
    global.__BHM.queenReservations = { tick: Game.time, map: {} };
  }
  return global.__BHM.queenReservations.map;
}

function reserveFill(targetId, amount) {
  if (!targetId || amount <= 0) return;
  var map = getReservationBucket();
  var cur = map[targetId] || 0;
  map[targetId] = cur + amount;
}

function getReserved(targetId) {
  if (!targetId) return 0;
  var map = getReservationBucket();
  return map[targetId] || 0;
}

function getEnergyStored(target) {
  if (!target) return 0;
  if (target.store) return target.store[RESOURCE_ENERGY] || 0;
  if (target.energy != null) return target.energy | 0;
  return 0;
}

function getFreeEnergyCapacity(target) {
  if (!target) return 0;
  if (target.store && target.store.getFreeCapacity) {
    return target.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
  }
  if (target.energyCapacity != null) {
    return (target.energyCapacity | 0) - (target.energy | 0);
  }
  return 0;
}

function createTask(type, targetId, data) {
  return {
    type: type,
    targetId: targetId || null,
    since: Game.time,
    data: data || {}
  };
}

function getIdleAnchor(creep) {
  if (!creep || !creep.room) return null;
  if (creep.room.storage) return creep.room.storage;
  var spawns = creep.room.find(FIND_MY_SPAWNS);
  if (spawns && spawns.length) return spawns[0];
  if (creep.room.controller) return creep.room.controller;
  return null;
}

function createIdleTask(creep) {
  var anchor = getIdleAnchor(creep);
  if (!anchor) return createTask('idle', null, null);
  var pos = anchor.pos || anchor;
  var data = {
    pos: { x: pos.x, y: pos.y, roomName: pos.roomName },
    range: 2
  };
  return createTask('idle', anchor.id || null, data);
}

function needsNewTask(creep, task) {
  if (!task) return true;
  var target = task.targetId ? Game.getObjectById(task.targetId) : null;
  if (!task.data) task.data = {};

  if (task.type === 'withdraw') {
    if (!target) return true;
    if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) return true;
    if (getEnergyStored(target) <= 0) return true;
  } else if (task.type === 'pickup') {
    if (!target) return true;
    if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) return true;
    if (target.amount != null && target.amount <= 0) return true;
  } else if (task.type === 'deliver') {
    if (!target) return true;
    if ((creep.store[RESOURCE_ENERGY] || 0) === 0) return true;
    if (getFreeEnergyCapacity(target) === 0) return true;
  } else if (task.type === 'idle') {
    // Always allow idle task to continue unless we have energy to move.
  }

  var data = task.data;
  if (data.lastPosX === creep.pos.x && data.lastPosY === creep.pos.y) {
    data.stuck = (data.stuck || 0) + 1;
    if (data.stuck >= CFG.STUCK_TICKS) return true;
  } else {
    data.stuck = 0;
    data.lastPosX = creep.pos.x;
    data.lastPosY = creep.pos.y;
  }

  return false;
}

function pickWithdrawTask(creep) {
  var room = creep.room;
  if (!room) return null;

  var tomb = BeeSelectors.findTombstoneWithEnergy(room);
  if (tomb) {
    return createTask('withdraw', tomb.id, { source: 'tomb' });
  }

  var ruin = BeeSelectors.findRuinWithEnergy(room);
  if (ruin) {
    return createTask('withdraw', ruin.id, { source: 'ruin' });
  }

  var drop = BeeSelectors.findBestEnergyDrop(room);
  if (drop) {
    return createTask('pickup', drop.id, { source: 'drop' });
  }

  var container = BeeSelectors.findBestEnergyContainer(room);
  if (container) {
    return createTask('withdraw', container.id, { source: 'container' });
  }

  if (room.storage && (room.storage.store[RESOURCE_ENERGY] || 0) > 0) {
    return createTask('withdraw', room.storage.id, { source: 'storage' });
  }

  if (room.terminal && (room.terminal.store[RESOURCE_ENERGY] || 0) > 0) {
    return createTask('withdraw', room.terminal.id, { source: 'terminal' });
  }

  return null;
}

function pickDeliverTask(creep) {
  var room = creep.room;
  if (!room) return null;

  var amount = creep.store[RESOURCE_ENERGY] || 0;
  if (amount <= 0) return null;

  var spawnLike = BeeSelectors.findSpawnLikeNeedingEnergy(room);
  var bestSpawn = BeeSelectors.selectClosestByRange(creep.pos, spawnLike);
  if (bestSpawn) {
    var freeSpawn = getFreeEnergyCapacity(bestSpawn);
    if (freeSpawn > getReserved(bestSpawn.id)) {
      var planAmount = Math.min(freeSpawn, amount);
      reserveFill(bestSpawn.id, planAmount);
      return createTask('deliver', bestSpawn.id, { sink: 'spawn' });
    }
  }

  var towers = BeeSelectors.findTowersNeedingEnergy(room);
  var bestTower = BeeSelectors.selectClosestByRange(creep.pos, towers);
  if (bestTower) {
    var freeTower = getFreeEnergyCapacity(bestTower);
    if (freeTower > getReserved(bestTower.id)) {
      var planTower = Math.min(freeTower, amount);
      reserveFill(bestTower.id, planTower);
      return createTask('deliver', bestTower.id, { sink: 'tower' });
    }
  }

  if (room.storage) {
    var storeFree = room.storage.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
    if (storeFree > 0) {
      return createTask('deliver', room.storage.id, { sink: 'storage' });
    }
  }

  if (room.terminal) {
    var termFree = room.terminal.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
    if (termFree > 0) {
      return createTask('deliver', room.terminal.id, { sink: 'terminal' });
    }
  }

  return null;
}

function chooseNextTask(creep) {
  if ((creep.store[RESOURCE_ENERGY] || 0) === 0) {
    var withdrawTask = pickWithdrawTask(creep);
    if (withdrawTask) return withdrawTask;
  } else {
    var deliverTask = pickDeliverTask(creep);
    if (deliverTask) return deliverTask;
  }
  return createIdleTask(creep);
}

function executeTask(creep, task) {
  if (!task) return;
  var target = task.targetId ? Game.getObjectById(task.targetId) : null;
  var priority = CFG.MOVE_PRIORITIES[task.type] || 0;

  if (task.type === 'withdraw') {
    if (!target) { clearTask(creep); return; }
    drawLine(creep, target, CFG.DRAW.WITHDRAW, 'WD');
    debugSay(creep, '📥');
    var rc = BeeActions.safeWithdraw(creep, target, RESOURCE_ENERGY, { priority: priority, reusePath: 20 });
    if (rc === OK) {
      if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) clearTask(creep);
    } else if (rc === ERR_NOT_ENOUGH_RESOURCES || rc === ERR_INVALID_TARGET) {
      clearTask(creep);
    }
    return;
  }

  if (task.type === 'pickup') {
    if (!target) { clearTask(creep); return; }
    drawLine(creep, target, CFG.DRAW.PICKUP, 'P');
    debugSay(creep, '🍪');
    var pc = BeeActions.safePickup(creep, target, { priority: priority, reusePath: 10 });
    if (pc === OK) {
      if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) clearTask(creep);
    } else if (pc === ERR_INVALID_TARGET) {
      clearTask(creep);
    }
    return;
  }

  if (task.type === 'deliver') {
    if (!target) { clearTask(creep); return; }
    drawLine(creep, target, CFG.DRAW.DELIVER, 'DL');
    debugSay(creep, '🚚');
    var tr = BeeActions.safeTransfer(creep, target, RESOURCE_ENERGY, null, { priority: priority, reusePath: 20 });
    if (tr === OK) {
      if ((creep.store[RESOURCE_ENERGY] || 0) === 0) clearTask(creep);
    } else if (tr === ERR_FULL || tr === ERR_INVALID_TARGET) {
      clearTask(creep);
    }
    return;
  }

  if (task.type === 'idle') {
    var pos = task.data && task.data.pos;
    if (!pos) return;
    var anchor = new RoomPosition(pos.x, pos.y, pos.roomName);
    drawLine(creep, anchor, CFG.DRAW.IDLE, 'ID');
    MovementManager.request(creep, anchor, priority, { range: task.data.range || 1, reusePath: 30 });
    return;
  }
}

var TaskQueen = {
  run: function (creep) {
    if (!creep || creep.spawning) return;
    ensureTaskSlot(creep);

    var task = creep.memory._task;
    if (needsNewTask(creep, task)) {
      task = chooseNextTask(creep);
      setTask(creep, task);
    }

    task = creep.memory._task;
    if (!task) {
      setTask(creep, createIdleTask(creep));
      task = creep.memory._task;
    }

    executeTask(creep, task);
  }
};

module.exports = TaskQueen;
