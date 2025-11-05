'use strict';

/**
 * What changed & why:
 * - Migrated the upgrader role to the shared _task envelope with persistent gather/upgrade assignments.
 * - Uses BeeSelectors snapshots plus BeeActions wrappers to avoid repeated room.find and to queue movement intents.
 * - Keeps controller signing/RCL8 pause logic while honoring centralized Movement.Manager priorities.
 */

var BeeSelectors = require('BeeSelectors');
var BeeActions = require('BeeActions');
var MovementManager = require('Movement.Manager');

var CFG = Object.freeze({
  DEBUG_SAY: false,
  DEBUG_DRAW: true,
  DRAW: {
    GATHER: '#8ef',
    UPGRADE: '#ffd16e',
    SIGN: '#9cff9c',
    IDLE: '#bfbfbf',
    WIDTH: 0.12,
    OPACITY: 0.45,
    FONT: 0.6
  },
  STUCK_TICKS: 4,
  SIGN_TEXT: 'BeeNice Please.',
  SKIP_RCL8_IF_SAFE: true,
  RCL8_SAFE_TTL: 180000,
  GATHER_REUSE: 20,
  UPGRADE_REUSE: 10
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
  creep.memory._task = null;
}

function shouldPause(controller) {
  if (!controller) return false;
  if (!CFG.SKIP_RCL8_IF_SAFE) return false;
  if (controller.level !== 8) return false;
  if ((controller.ticksToDowngrade | 0) <= CFG.RCL8_SAFE_TTL) return false;
  return true;
}

function maintainSign(creep, controller) {
  if (!controller) return;
  var desired = CFG.SIGN_TEXT;
  if (controller.sign && controller.sign.text === desired) return;
  if (creep.pos.inRangeTo(controller.pos, 1)) {
    creep.signController(controller, desired);
  } else {
    MovementManager.request(creep, controller, MovementManager.PRIORITIES.upgrade, { range: 1, reusePath: CFG.UPGRADE_REUSE, intentType: 'upgrade' });
  }
}

function chooseGatherTask(creep) {
  var room = creep.room;
  var controllerLink = BeeSelectors.findControllerLink(room);
  if (controllerLink && controllerLink.store && (controllerLink.store[RESOURCE_ENERGY] | 0) > 0) {
    return {
      type: 'gather',
      targetId: controllerLink.id,
      since: Game.time,
      data: { mode: 'withdraw', source: 'controllerLink' }
    };
  }
  var list = BeeSelectors.getEnergySourcePriority(room);
  for (var i = 0; i < list.length; i++) {
    var entry = list[i];
    if (!entry || !entry.target) continue;
    if (entry.kind === 'drop') {
      return { type: 'gather', targetId: entry.target.id, since: Game.time, data: { mode: 'pickup', source: 'drop' } };
    }
    if (entry.kind === 'tomb') {
      return { type: 'gather', targetId: entry.target.id, since: Game.time, data: { mode: 'withdraw', source: 'tomb' } };
    }
    if (entry.kind === 'ruin') {
      return { type: 'gather', targetId: entry.target.id, since: Game.time, data: { mode: 'withdraw', source: 'ruin' } };
    }
    if (entry.kind === 'source') {
      return { type: 'gather', targetId: entry.target.id, since: Game.time, data: { mode: 'harvest', source: 'source' } };
    }
    return { type: 'gather', targetId: entry.target.id, since: Game.time, data: { mode: 'withdraw', source: entry.kind || 'energy' } };
  }
  return null;
}

function chooseUpgradeTask(creep) {
  var controller = creep.room.controller;
  if (!controller) return null;
  return { type: 'upgrade', targetId: controller.id, since: Game.time, data: {} };
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
    } else if (task.data.mode === 'harvest') {
      if (target.energy != null && target.energy === 0 && target.ticksToRegeneration > 1) return true;
    } else if (target.store && (target.store[RESOURCE_ENERGY] | 0) === 0) {
      return true;
    }
  } else if (task.type === 'upgrade') {
    if (creep.store[RESOURCE_ENERGY] === 0) return true;
    var controller = target;
    if (!controller || !controller.my) return true;
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
  drawLine(creep, target, CFG.DRAW.GATHER, 'GET');
  debugSay(creep, '🔄');
  var rc;
  if (task.data.mode === 'pickup') {
    rc = BeeActions.safePickup(creep, target, { reusePath: CFG.GATHER_REUSE });
  } else if (task.data.mode === 'harvest') {
    rc = BeeActions.safeHarvest(creep, target, { reusePath: CFG.GATHER_REUSE });
  } else {
    rc = BeeActions.safeWithdraw(creep, target, RESOURCE_ENERGY, { reusePath: CFG.GATHER_REUSE });
  }
  if (rc === OK && creep.store.getFreeCapacity() === 0) clearTask(creep);
}

function executeUpgrade(creep, task) {
  var controller = creep.room.controller;
  if (!controller) {
    clearTask(creep);
    return;
  }
  if (shouldPause(controller)) {
    maintainSign(creep, controller);
    var anchor = BeeSelectors.findRoomAnchor(creep.room);
    if (anchor && creep.pos.getRangeTo(anchor) > 2) {
      drawLine(creep, anchor, CFG.DRAW.IDLE, 'IDLE');
      MovementManager.request(creep, anchor, MovementManager.PRIORITIES.idle, { range: 2, reusePath: CFG.UPGRADE_REUSE, intentType: 'idle' });
    }
    return;
  }
  drawLine(creep, controller, CFG.DRAW.UPGRADE, 'UP');
  debugSay(creep, '⚡');
  var rc = BeeActions.safeUpgrade(creep, controller, { reusePath: CFG.UPGRADE_REUSE });
  if (rc === OK) maintainSign(creep, controller);
  if (creep.store[RESOURCE_ENERGY] === 0) clearTask(creep);
}

function runTask(creep, task) {
  if (!task) return;
  if (task.type === 'gather') {
    executeGather(creep, task);
    return;
  }
  if (task.type === 'upgrade') {
    executeUpgrade(creep, task);
    return;
  }
  clearTask(creep);
}

var TaskUpgrader = {
  run: function (creep) {
    if (!creep || creep.spawning) return;
    ensureTask(creep);
    var task = creep.memory._task;
    if (needNewTask(creep, task)) {
      var newTask = null;
      if (creep.store[RESOURCE_ENERGY] === 0) {
        newTask = chooseGatherTask(creep);
      } else {
        newTask = chooseUpgradeTask(creep);
      }
      if (!newTask && creep.store[RESOURCE_ENERGY] > 0) newTask = chooseUpgradeTask(creep);
      if (!newTask) {
        var anchor = BeeSelectors.findRoomAnchor(creep.room);
        if (anchor && creep.pos.getRangeTo(anchor) > 2) {
          drawLine(creep, anchor, CFG.DRAW.IDLE, 'IDLE');
          MovementManager.request(creep, anchor, MovementManager.PRIORITIES.idle, { range: 2, reusePath: CFG.UPGRADE_REUSE, intentType: 'idle' });
        }
        debugSay(creep, '🧘');
        clearTask(creep);
        return;
      }
      creep.memory._task = newTask;
      task = newTask;
    }
    runTask(creep, task);
  }
};

module.exports = TaskUpgrader;
