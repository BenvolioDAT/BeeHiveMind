'use strict';

// role.Courier.js
// Owns: Courier tick orchestration only.
// Does not own: cache internals, reservation bookkeeping, targeting details, or action primitives.
// Called by: main role runner via require('role.Courier').

var CourierConfig = require('Courier.Config');
var CourierMemory = require('Courier.Memory');
var CourierCache = require('Courier.Cache');
var CourierTargets = require('Courier.Targets');
var CourierReservations = require('Courier.Reservations');
var CourierActions = require('Courier.Actions');

var COURIER_STATE = CourierConfig.COURIER_STATE;

function collectEnergy(creep) {
  var now = Game.time;
  var roomCache = CourierCache.getCourierRoomCache(creep.room);
  var sourceContainer = CourierTargets.pickBestSourceContainer(creep, roomCache, now);

  // Collection order is intentionally strict to preserve behavior:
  // 1) en-route drops, 2) source-container workflow, 3) graves/ruins,
  // 4) generic drops, 5) storage/terminal withdraw, 6) idle.
  var enRouteDrop = CourierTargets.pickEnRouteDrop(creep);
  if (enRouteDrop) {
    CourierActions.debugSay(creep, '↘️Drop');
    CourierActions.debugDrawLine(creep, enRouteDrop, CourierConfig.CFG.DRAW.DROP_COLOR, 'DROP*');
    if (creep.pickup(enRouteDrop) === ERR_NOT_IN_RANGE) {
      CourierActions.requestCourierMove(creep, enRouteDrop, 1, { reusePath: 20, intentType: 'courier_collect' }, 'courier.collect.pickupEnRoute');
    }
    return;
  }

  if (sourceContainer && CourierActions.tryContainerWorkflow(creep, sourceContainer)) return;

  CourierActions.rescanGraves(roomCache, creep.room);
  if (CourierActions.tryGraves(creep, roomCache)) return;
  if (CourierActions.tryGenericDrops(creep)) return;
  if (CourierActions.tryStorageWithdraw(creep)) return;
  CourierActions.idleNearAnchor(creep);
}

function deliverEnergy(creep) {
  var carryAmount = creep.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
  if (carryAmount <= 0) {
    creep.memory.transferring = false;
    creep.memory.dropoffId = null;
    return;
  }

  var target = CourierTargets.ensureDropoffTarget(creep);
  if (!target) {
    CourierActions.idleNearAnchor(creep);
    return;
  }

  // Reservations prevent multiple Couriers/Queens from overbooking the same sink.
  var reservedAmount = CourierReservations.reserveFill(creep, target, carryAmount, RESOURCE_ENERGY);
  if (reservedAmount <= 0) {
    creep.memory.dropoffId = null;
    return;
  }

  CourierActions.drawDeliveryIntent(creep, target);
  var transferResult = CourierActions.transferTo(creep, target, RESOURCE_ENERGY);
  if (transferResult === OK && (creep.store[RESOURCE_ENERGY] || 0) === 0) {
    creep.memory.transferring = false;
    creep.memory.dropoffId = null;
  }
}

var roleCourier = {
  role: 'Courier',

  run: function (creep) {
    if (!creep) return;

    // Beginner flow: prepare memory, choose state, then execute one phase.
    var state = CourierMemory.determineCourierState(creep);
    if (state === COURIER_STATE.DELIVER) {
      deliverEnergy(creep);
      return;
    }
    collectEnergy(creep);
  },

  collectEnergy: collectEnergy,
  deliverEnergy: deliverEnergy
};

module.exports = roleCourier;
