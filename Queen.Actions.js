'use strict';

var BeeActions = require('BeeActions');
var MovementManager = require('Movement.Manager');
var BeeRoleVisuals = require('BeeRoleVisuals');
var CoreLogger = require('core.logger');
var QueenConfig = require('Queen.Config');
var QueenTasks = require('Queen.Tasks');

var CFG = QueenConfig.CFG;
var queenLog = CoreLogger.createLogger('Queen', CoreLogger.LOG_LEVEL.BASIC);

function describeError(error) { return error && (error.stack || error.message || String(error)); }
function debugSay(creep, message) { if (CFG.DEBUG_SAY && creep && message) creep.say(message, true); }
function drawLine(creep, target, color, label) {
  try { BeeRoleVisuals.drawLine(CFG.DEBUG_DRAW, creep, target, color, label, CFG.DRAW); }
  catch (error) { queenLog.warnEvery('queen.drawLine.visual', 250, 'drawLine failed for', creep && creep.name, describeError(error)); }
}

function getQueenTaskPriority(task) { if (!task) return 0; return CFG.MOVE_PRIORITIES[task.type] || 0; }
function getQueenTaskTarget(task) { if (!task || !task.targetId) return null; return Game.getObjectById(task.targetId); }

function runQueenWithdrawState(creep, clearTask) {
  var task = creep.memory._task;
  var target = getQueenTaskTarget(task);
  if (!task || !target) { clearTask(creep); return; }
  drawLine(creep, target, CFG.DRAW.WITHDRAW, 'WD');
  debugSay(creep, '📥');
  var withdrawResult = BeeActions.safeWithdraw(creep, target, RESOURCE_ENERGY, { priority: getQueenTaskPriority(task), reusePath: 20 });
  if (withdrawResult === OK) {
    if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) clearTask(creep);
  } else if (withdrawResult === ERR_NOT_ENOUGH_RESOURCES || withdrawResult === ERR_INVALID_TARGET) {
    clearTask(creep);
  }
}

function runQueenPickupState(creep, clearTask) {
  var task = creep.memory._task;
  var target = getQueenTaskTarget(task);
  if (!task || !target) { clearTask(creep); return; }
  drawLine(creep, target, CFG.DRAW.PICKUP, 'P');
  debugSay(creep, '🍪');
  var pickupResult = BeeActions.safePickup(creep, target, { priority: getQueenTaskPriority(task), reusePath: 10 });
  if (pickupResult === OK) {
    if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) clearTask(creep);
  } else if (pickupResult === ERR_INVALID_TARGET) {
    clearTask(creep);
  }
}

function runQueenDeliverState(creep, clearTask, releaseTerminalJobClaimIfHeld) {
  var task = creep.memory._task;
  var target = getQueenTaskTarget(task);
  if (!task || !target) { clearTask(creep); return; }
  drawLine(creep, target, CFG.DRAW.DELIVER, 'DL');
  debugSay(creep, '🚚');

  var transferAmount = null;
  if (task.data && task.data.sink === 'terminal_job' && typeof task.data.amount === 'number') {
    var targetFree = QueenTasks.getFreeEnergyCapacity(target);
    var carryNow = creep.store[RESOURCE_ENERGY] || 0;
    transferAmount = Math.min(task.data.amount, targetFree, carryNow);
    if (transferAmount <= 0) { clearTask(creep); return; }
  }

  var transferResult = BeeActions.safeTransfer(creep, target, RESOURCE_ENERGY, transferAmount, { priority: getQueenTaskPriority(task), reusePath: 20 });
  if (transferResult === OK) {
    if (transferAmount != null && task.data && task.data.sink === 'terminal_job') {
      task.data.amount = Math.max(0, (task.data.amount || 0) - transferAmount);
    }
    if (task.data && task.data.sink === 'terminal_job' && (task.data.amount || 0) <= 0) { clearTask(creep); return; }
    if ((creep.store[RESOURCE_ENERGY] || 0) === 0) clearTask(creep);
  } else if (transferResult === ERR_FULL || transferResult === ERR_INVALID_TARGET) {
    if (typeof releaseTerminalJobClaimIfHeld === 'function') releaseTerminalJobClaimIfHeld(creep);
    clearTask(creep);
  }
}

function runQueenIdleState(creep) {
  var task = creep.memory._task;
  if (!task || task.type !== 'idle') return;
  var pos = task.data && task.data.pos;
  if (!pos) return;
  var anchor = new RoomPosition(pos.x, pos.y, pos.roomName);
  drawLine(creep, anchor, CFG.DRAW.IDLE, 'ID');
  MovementManager.request(creep, anchor, getQueenTaskPriority(task), { range: task.data.range || 1, reusePath: 30 });
}

module.exports = { runQueenWithdrawState: runQueenWithdrawState, runQueenPickupState: runQueenPickupState, runQueenDeliverState: runQueenDeliverState, runQueenIdleState: runQueenIdleState };
