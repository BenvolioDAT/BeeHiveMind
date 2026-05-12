'use strict';

// Couriers reserve energy deliveries for the current tick and for in-flight ETA.
// This prevents multiple haulers from targeting the same sink and overbooking it.

function getQueenReservationMap() {
  if (!Memory._queenRes || Memory._queenRes.tick !== Game.time) {
    Memory._queenRes = { tick: Game.time, map: {} };
  }
  return Memory._queenRes.map;
}

function getReservedEnergyForStructure(structureId) {
  var map = getQueenReservationMap();
  return map[structureId] || 0;
}

function sumPibReservedEnergy(roomName, targetId, resourceType) {
  resourceType = resourceType || RESOURCE_ENERGY;
  var root = Memory._PIB;
  if (!root || root.tick !== Game.time || !root.rooms) return 0;
  var roomCache = root.rooms[roomName];
  if (!roomCache || !roomCache.fills) return 0;
  var map = roomCache.fills[targetId];
  if (!map) return 0;

  var sum = 0;
  var keys = Object.keys(map);
  for (var i = 0; i < keys.length; i++) {
    var entry = map[keys[i]];
    if (!entry || entry.res !== resourceType) continue;
    sum += (entry.amount || 0);
  }
  return sum;
}

function getEffectiveFreeCapacity(target, resourceType) {
  resourceType = resourceType || RESOURCE_ENERGY;
  var freeNow = (target.store && target.store.getFreeCapacity(resourceType)) || 0;
  var sameTickReserved = getReservedEnergyForStructure(target.id) || 0;
  var roomName = (target.pos && target.pos.roomName) || (target.room && target.room.name);
  var inFlightReserved = roomName ? sumPibReservedEnergy(roomName, target.id, resourceType) : 0;
  return Math.max(0, freeNow - sameTickReserved - inFlightReserved);
}

function reservePibFill(creep, target, amount, resourceType) {
  resourceType = resourceType || RESOURCE_ENERGY;
  if (!Memory._PIB || Memory._PIB.tick !== Game.time) {
    Memory._PIB = { tick: Game.time, rooms: {} };
  }
  var roomName = (target.pos && target.pos.roomName) || (creep.room && creep.room.name);
  if (!roomName) return 0;

  if (!Memory._PIB.rooms[roomName]) Memory._PIB.rooms[roomName] = { fills: {}, withdrawals: {} };
  var roomCache = Memory._PIB.rooms[roomName];
  if (!roomCache.fills[target.id]) roomCache.fills[target.id] = {};

  var eta = creep.pos.getRangeTo(target);
  var bookedAmount = Math.max(0, Math.min(Math.floor(amount || 0), getEffectiveFreeCapacity(target, resourceType)));
  roomCache.fills[target.id][creep.name] = {
    res: resourceType,
    amount: bookedAmount,
    untilTick: Game.time + eta
  };
  return bookedAmount;
}

function releasePibFill(creep, target, resourceType) {
  if (!creep || !target) return;
  resourceType = resourceType || RESOURCE_ENERGY;
  var roomName = (target.pos && target.pos.roomName) || (creep.room && creep.room.name);
  if (!roomName) return;

  var root = Memory._PIB;
  if (!root || !root.rooms) return;
  var roomCache = root.rooms[roomName];
  if (!roomCache || !roomCache.fills) return;

  var map = roomCache.fills[target.id];
  if (map && map[creep.name]) delete map[creep.name];
  if (map && Object.keys(map).length === 0) delete roomCache.fills[target.id];
}

function reserveFill(creep, target, amount, resourceType) {
  resourceType = resourceType || RESOURCE_ENERGY;
  var map = getQueenReservationMap();
  var freeCapacity = getEffectiveFreeCapacity(target, resourceType);
  var requested = Math.max(0, Math.floor(Number(amount) || 0));
  var reserved = Math.max(0, Math.min(requested, freeCapacity));

  if (reserved > 0) {
    map[target.id] = (map[target.id] || 0) + reserved;
    creep.memory.dropoffId = target.id;
    reservePibFill(creep, target, reserved, resourceType);
  }
  return reserved;
}

module.exports = {
  getQueenReservationMap: getQueenReservationMap,
  getReservedEnergyForStructure: getReservedEnergyForStructure,
  sumPibReservedEnergy: sumPibReservedEnergy,
  reservePibFill: reservePibFill,
  releasePibFill: releasePibFill,
  getEffectiveFreeCapacity: getEffectiveFreeCapacity,
  reserveFill: reserveFill
};
