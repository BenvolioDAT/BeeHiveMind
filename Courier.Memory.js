'use strict';

var BeeRoles = require('BeeRoles');
var CourierConfig = require('Courier.Config');
var COURIER_STATE = CourierConfig.COURIER_STATE;

function ensureCourierIdentity(creep) {
  if (!creep || !creep.memory) return;
  creep.memory.role = BeeRoles.ROLE_NAMES.COURIER;
  if (!creep.memory.task) creep.memory.task = 'courier';
}

function initializeCourierMemoryKeys(creep) {
  if (creep.memory.pickupContainerId === undefined) creep.memory.pickupContainerId = null;
  if (creep.memory.retargetAt === undefined) creep.memory.retargetAt = 0;
  if (creep.memory.dropoffId === undefined) creep.memory.dropoffId = null;
}

function determineCourierState(creep) {
  ensureCourierIdentity(creep);
  initializeCourierMemoryKeys(creep);

  if (creep.memory.transferring && creep.store[RESOURCE_ENERGY] === 0) {
    creep.memory.transferring = false;
  }
  if (!creep.memory.transferring && creep.store.getFreeCapacity() === 0) {
    creep.memory.transferring = true;
  }

  creep.memory.state = creep.memory.transferring ? COURIER_STATE.DELIVER : COURIER_STATE.COLLECT;
  return creep.memory.state;
}

module.exports = {
  ensureCourierIdentity: ensureCourierIdentity,
  initializeCourierMemoryKeys: initializeCourierMemoryKeys,
  determineCourierState: determineCourierState
};
