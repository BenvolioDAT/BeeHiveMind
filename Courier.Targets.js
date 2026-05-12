'use strict';

var CourierConfig = require('Courier.Config');
var CFG = CourierConfig.CFG;
var CourierCache = require('Courier.Cache');
var CourierReservations = require('Courier.Reservations');

function findClosestByRange(position, objects) {
  var best = null;
  var bestDistance = 1e9;
  for (var i = 0; i < objects.length; i++) {
    var object = objects[i];
    var distance = position.getRangeTo(object);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = object;
    }
  }
  return best;
}

function isGoodContainer(container) {
  if (!container || container.structureType !== STRUCTURE_CONTAINER || !container.store) return false;
  return (container.store[RESOURCE_ENERGY] || 0) >= CFG.CONTAINER_MIN;
}

function getStructureEnergy(target) {
  if (!target || !target.store) return 0;
  return target.store[RESOURCE_ENERGY] || 0;
}

function isContainerClearlyBetter(candidate, current) {
  return getStructureEnergy(candidate) > (getStructureEnergy(current) + CFG.BETTER_CONTAINER_DELTA);
}

function pickBestSourceContainer(creep, roomCache, now) {
  var current = Game.getObjectById(creep.memory.pickupContainerId);
  var retargetAt = creep.memory.retargetAt || 0;
  if (current && isGoodContainer(current) && now < retargetAt) return current;

  var best = Game.getObjectById(roomCache.bestSrcId);
  if (!best) {
    var sourceContainers = CourierCache.getCourierObjectsFromIds(roomCache.srcIds);
    var candidates = sourceContainers.filter(isGoodContainer);
    best = candidates.length ? findClosestByRange(creep.pos, candidates) : null;
  }

  // Keep sticky targeting unless a clearly better container appears.
  if (!current || (best && current.id !== best.id && isContainerClearlyBetter(best, current))) {
    creep.memory.pickupContainerId = best ? best.id : null;
    creep.memory.retargetAt = now + CFG.RETARGET_COOLDOWN;
    return best;
  }
  return current;
}

function pickEnRouteDrop(creep) {
  var nearby = creep.pos.findInRange(FIND_DROPPED_RESOURCES, CFG.DROPPED_ALONG_ROUTE_R, {
    filter: function (resource) {
      var amount = Number(resource.amount) || 0;
      return resource.resourceType === RESOURCE_ENERGY && amount >= CFG.DROPPED_BIG_MIN;
    }
  });
  if (!nearby || !nearby.length) return null;
  return findClosestByRange(creep.pos, nearby);
}

function pickSpawnOrExtension(creep) {
  var list = creep.room.find(FIND_STRUCTURES, {
    filter: function (structure) {
      if (!structure.store) return false;
      var structureType = structure.structureType;
      if (structureType !== STRUCTURE_SPAWN && structureType !== STRUCTURE_EXTENSION) return false;
      return CourierReservations.getEffectiveFreeCapacity(structure, RESOURCE_ENERGY) > 0;
    }
  });
  return list.length ? findClosestByRange(creep.pos, list) : null;
}

function pickLowTower(creep) {
  var list = creep.room.find(FIND_STRUCTURES, {
    filter: function (structure) {
      if (structure.structureType !== STRUCTURE_TOWER || !structure.store) return false;
      var used = structure.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
      var capacity = structure.store.getCapacity(RESOURCE_ENERGY) || 0;
      if (capacity <= 0) return false;
      if ((used / capacity) > CFG.TOWER_REFILL_AT_OR_BELOW) return false;
      return CourierReservations.getEffectiveFreeCapacity(structure, RESOURCE_ENERGY) > 0;
    }
  });
  return list.length ? findClosestByRange(creep.pos, list) : null;
}

function pickStorageSink(creep) {
  var storage = creep.room.storage;
  if (!storage || !storage.store) return null;
  if (CourierReservations.getEffectiveFreeCapacity(storage, RESOURCE_ENERGY) <= 0) return null;
  return storage;
}

function ensureDropoffTarget(creep) {
  var target = Game.getObjectById(creep.memory.dropoffId);
  if (target && CourierReservations.getEffectiveFreeCapacity(target, RESOURCE_ENERGY) > 0) return target;
  target = pickSpawnOrExtension(creep);
  if (!target) target = pickLowTower(creep);
  if (!target) target = pickStorageSink(creep);
  if (!target) return null;
  creep.memory.dropoffId = target.id;
  return target;
}

module.exports = {
  findClosestByRange: findClosestByRange,
  isGoodContainer: isGoodContainer,
  pickBestSourceContainer: pickBestSourceContainer,
  pickEnRouteDrop: pickEnRouteDrop,
  pickSpawnOrExtension: pickSpawnOrExtension,
  pickLowTower: pickLowTower,
  pickStorageSink: pickStorageSink,
  ensureDropoffTarget: ensureDropoffTarget
};
