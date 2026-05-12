'use strict';

var CoreLogger = require('core.logger');
var BeeRoleVisuals = require('BeeRoleVisuals');
var MovementManager = require('Movement.Manager');
var CourierConfig = require('Courier.Config');
var CourierReservations = require('Courier.Reservations');
var CourierTargets = require('Courier.Targets');
var CFG = CourierConfig.CFG;

var courierLog = CoreLogger.createLogger('Courier', CoreLogger.LOG_LEVEL.BASIC);

function describeError(error) {
  return error && (error.stack || error.message || String(error));
}

function debugSay(creep, message) { BeeRoleVisuals.debugSay(CFG.DEBUG_SAY, creep, message); }
function debugDrawLine(creep, target, color, label) {
  try { BeeRoleVisuals.drawLine(CFG.DEBUG_DRAW, creep, target, color, label, CFG.DRAW); }
  catch (error) { courierLog.warnEvery('courier.debugDrawLine.visual', 250, 'debugDrawLine failed for', creep && creep.name, describeError(error)); }
}

function hasUsableTravelTarget(target) {
  var position = target && (target.pos || target);
  return !!(position && typeof position.x === 'number' && typeof position.y === 'number' && position.roomName);
}

function requestCourierMove(creep, target, range, options, reason) {
  if (!creep || !target) return ERR_INVALID_ARGS;
  if (!hasUsableTravelTarget(target)) return ERR_INVALID_ARGS;
  if (!MovementManager || typeof MovementManager.request !== 'function') return ERR_INVALID_ARGS;
  var requestOptions = options ? Object.assign({}, options) : {};
  requestOptions.range = range;
  requestOptions.intentType = requestOptions.intentType || 'courier_deliver';
  var requestResult = MovementManager.request(creep, target, null, requestOptions);
  if (requestResult === OK || (typeof requestResult === 'number' && requestResult > OK)) return requestResult;
  if (requestResult === ERR_INVALID_ARGS) return ERR_INVALID_ARGS;
  return requestResult;
}

function transferTo(creep, target, resourceType) {
  resourceType = resourceType || RESOURCE_ENERGY;
  var transferResult = creep.transfer(target, resourceType);
  if (transferResult === ERR_NOT_IN_RANGE) {
    requestCourierMove(creep, target, 1, { reusePath: CFG.PATH_REUSE }, 'courier.deliver.transfer');
    return transferResult;
  }
  if (transferResult === OK || transferResult === ERR_FULL || (transferResult !== ERR_TIRED && transferResult !== ERR_BUSY)) {
    CourierReservations.releasePibFill(creep, target, resourceType);
    if (transferResult !== OK) creep.memory.dropoffId = null;
  }
  return transferResult;
}

function tryContainerWorkflow(creep, container) {
  if (!CourierTargets.isGoodContainer(container)) return false;
  var drops = container.pos.findInRange(FIND_DROPPED_RESOURCES, CFG.DROPPED_NEAR_CONTAINER_R, {
    filter: function (resource) {
      var amount = Number(resource.amount) || 0;
      return resource.resourceType === RESOURCE_ENERGY && amount > 0;
    }
  });
  if (drops.length) {
    var bestDrop = CourierTargets.findClosestByRange(creep.pos, drops);
    debugSay(creep, '↘️Drop');
    debugDrawLine(creep, bestDrop, CFG.DRAW.DROP_COLOR, 'DROP');
    var pickupResult = creep.pickup(bestDrop);
    if (pickupResult === ERR_NOT_IN_RANGE) {
      requestCourierMove(creep, bestDrop, 1, { reusePath: 20, intentType: 'courier_collect' }, 'courier.collect.containerDropPickup');
      return true;
    }
    if (pickupResult === OK && creep.store.getFreeCapacity() === 0) { creep.memory.transferring = true; return true; }
  }

  var energyInContainer = (container.store && container.store[RESOURCE_ENERGY]) || 0;
  if (energyInContainer <= 0) { creep.memory.retargetAt = Game.time; return false; }

  debugSay(creep, '↘️Con');
  debugDrawLine(creep, container, CFG.DRAW.WD_COLOR, 'CON');
  var withdrawResult = creep.withdraw(container, RESOURCE_ENERGY);
  if (withdrawResult === ERR_NOT_IN_RANGE) {
    requestCourierMove(creep, container, 1, { reusePath: CFG.PATH_REUSE, intentType: 'courier_collect' }, 'courier.collect.containerWithdraw');
    return true;
  }
  if (withdrawResult === OK && creep.store.getFreeCapacity() === 0) creep.memory.transferring = true;
  if (withdrawResult === ERR_NOT_ENOUGH_RESOURCES) creep.memory.retargetAt = Game.time;
  return true;
}

function rescanGraves(roomCache, room) {
  var nextScanAt = roomCache.nextGraveScanAt || 0;
  if (nextScanAt > Game.time) return;
  roomCache.nextGraveScanAt = Game.time + CFG.GRAVE_SCAN_COOLDOWN;
  var graves = room.find(FIND_TOMBSTONES, { filter: function (tombstone) { return (tombstone.store[RESOURCE_ENERGY] || 0) > 0; } });
  var ruins = room.find(FIND_RUINS, { filter: function (ruin) { return (ruin.store[RESOURCE_ENERGY] || 0) > 0; } });
  roomCache.graves = graves.concat(ruins);
}

function tryGraves(creep, roomCache) {
  if (!roomCache.graves || !roomCache.graves.length) return false;
  var grave = CourierTargets.findClosestByRange(creep.pos, roomCache.graves);
  if (!grave) return false;
  debugSay(creep, '↘️Grv');
  debugDrawLine(creep, grave, CFG.DRAW.GRAVE_COLOR, 'GRAVE');
  var graveWithdrawResult = creep.withdraw(grave, RESOURCE_ENERGY);
  if (graveWithdrawResult === ERR_NOT_IN_RANGE) {
    requestCourierMove(creep, grave, 1, { reusePath: 20, intentType: 'courier_collect' }, 'courier.collect.graveWithdraw');
  }
  return true;
}

function tryGenericDrops(creep) {
  var dropped = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
    filter: function (resource) { return resource.resourceType === RESOURCE_ENERGY && (resource.amount || 0) >= 50; }
  });
  if (!dropped) return false;
  debugSay(creep, '↘️Drop');
  debugDrawLine(creep, dropped, CFG.DRAW.DROP_COLOR, 'DROP');
  if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) {
    requestCourierMove(creep, dropped, 1, { reusePath: 20, intentType: 'courier_collect' }, 'courier.collect.genericDrop');
  }
  return true;
}

function tryStorageWithdraw(creep) {
  var room = creep.room;
  var storeLike = null;
  if (room.storage && (room.storage.store[RESOURCE_ENERGY] || 0) > 0) storeLike = room.storage;
  else if (room.terminal && (room.terminal.store[RESOURCE_ENERGY] || 0) > 0) storeLike = room.terminal;
  if (!storeLike) return false;

  debugSay(creep, storeLike.structureType === STRUCTURE_STORAGE ? '↘️Sto' : '↘️Term');
  debugDrawLine(creep, storeLike, CFG.DRAW.WD_COLOR, storeLike.structureType === STRUCTURE_STORAGE ? 'STO' : 'TERM');
  var storageWithdrawResult = creep.withdraw(storeLike, RESOURCE_ENERGY);
  if (storageWithdrawResult === ERR_NOT_IN_RANGE) {
    requestCourierMove(creep, storeLike, 1, { reusePath: CFG.PATH_REUSE, intentType: 'courier_collect' }, 'courier.collect.storageWithdraw');
  }
  return true;
}

function idleNearAnchor(creep) {
  var anchor = creep.room.storage || creep.pos.findClosestByRange(FIND_MY_SPAWNS) || creep.pos;
  debugSay(creep, 'IDLE');
  debugDrawLine(creep, (anchor.pos || anchor), CFG.DRAW.IDLE_COLOR, 'IDLE');
  if (!creep.pos.inRangeTo(anchor, 3)) {
    creep.travelTo(anchor, { range: 3, reusePath: CFG.PATH_REUSE });
  }
}

function drawDeliveryIntent(creep, target) {
  var structureType = target.structureType;
  if (structureType === STRUCTURE_EXTENSION) { debugSay(creep, '→ EXT'); debugDrawLine(creep, target, CFG.DRAW.FILL_COLOR, 'EXT'); }
  else if (structureType === STRUCTURE_SPAWN) { debugSay(creep, '→ SPN'); debugDrawLine(creep, target, CFG.DRAW.FILL_COLOR, 'SPN'); }
  else if (structureType === STRUCTURE_TOWER) { debugSay(creep, '→ TWR'); debugDrawLine(creep, target, CFG.DRAW.FILL_COLOR, 'TWR'); }
  else if (structureType === STRUCTURE_STORAGE) { debugSay(creep, '→ STO'); debugDrawLine(creep, target, CFG.DRAW.FILL_COLOR, 'STO'); }
  else { debugSay(creep, '→ FILL'); debugDrawLine(creep, target, CFG.DRAW.FILL_COLOR, 'FILL'); }
}

module.exports = {
  requestCourierMove: requestCourierMove,
  transferTo: transferTo,
  tryContainerWorkflow: tryContainerWorkflow,
  rescanGraves: rescanGraves,
  tryGraves: tryGraves,
  tryGenericDrops: tryGenericDrops,
  tryStorageWithdraw: tryStorageWithdraw,
  idleNearAnchor: idleNearAnchor,
  drawDeliveryIntent: drawDeliveryIntent,
  debugSay: debugSay,
  debugDrawLine: debugDrawLine
};
