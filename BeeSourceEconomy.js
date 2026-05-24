'use strict';

var ENERGY_PICKUP_MIN = 50;
var SOURCE_REGEN_TICKS = 300;
var DEFAULT_SOURCE_ENERGY_PER_TICK = 10;

function ensureRoomMemory(roomName) {
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
  return Memory.rooms[roomName];
}

function ensureRoomSourceEconomy(room) {
  if (!room || !room.name) return null;
  var mem = ensureRoomMemory(room.name);
  if (!mem.sourceEconomy) mem.sourceEconomy = {};
  var econ = mem.sourceEconomy;
  econ.tick = Game.time;
  econ.roomName = room.name;
  if (!econ.activeSourceIds) econ.activeSourceIds = [];
  if (!econ.sources) econ.sources = {};
  if (!econ.pickupReservations) econ.pickupReservations = {};
  if (!econ.pickupCarryBySource) econ.pickupCarryBySource = {};
  if (typeof econ.sourceCount !== 'number') econ.sourceCount = 0;
  if (typeof econ.income !== 'number') econ.income = 0;
  if (typeof econ.maxIncome !== 'number') econ.maxIncome = 0;
  if (typeof econ.truckerCarry !== 'number') econ.truckerCarry = 0;
  if (typeof econ.truckerCarryTotal !== 'number') econ.truckerCarryTotal = 0;
  if (typeof econ.truckerStoredEnergy !== 'number') econ.truckerStoredEnergy = 0;
  if (typeof econ.pendingEnergy !== 'number') econ.pendingEnergy = 0;
  if (!econ.lastPickupScores) econ.lastPickupScores = {};
  return econ;
}

function getRoomAnchor(room) {
  if (!room) return null;
  if (room.storage) return room.storage.pos;
  var spawns = room.find(FIND_MY_SPAWNS);
  if (spawns && spawns.length) return spawns[0].pos;
  if (room.controller) return room.controller.pos;
  return new RoomPosition(25, 25, room.name);
}

function estimateInterRoomDistance(fromPos, toPos) {
  if (!fromPos || !toPos) return 25;
  if (fromPos.roomName === toPos.roomName) return Math.max(1, fromPos.getRangeTo(toPos));
  var routeLength = Infinity;
  try {
    var route = Game.map.findRoute(fromPos.roomName, toPos.roomName);
    if (route && route !== ERR_NO_PATH && typeof route.length === 'number') routeLength = route.length;
  } catch (err) {}
  if (!isFinite(routeLength)) {
    routeLength = Game.map.getRoomLinearDistance(fromPos.roomName, toPos.roomName) || 1;
  }
  return Math.max(1, routeLength * 50 + 25);
}

function getSourceDistance(room, creep, rec, sourceObj) {
  if (rec && typeof rec.distance === 'number' && rec.distance > 0) return rec.distance;
  var sourcePos = sourceObj && sourceObj.pos ? sourceObj.pos : (rec && rec.pos ? new RoomPosition(rec.pos.x, rec.pos.y, rec.pos.roomName) : null);
  if (!sourcePos) return 25;
  var fromPos = creep && creep.pos ? creep.pos : getRoomAnchor(room);
  return estimateInterRoomDistance(fromPos, sourcePos);
}

function getSourceExpectedEnergyDelta(rec, distance) {
  if (!rec) return 0;
  var harvestPower = rec.harvestPower || rec.energyPerTick || 0;
  var energy = rec.energy || 0;
  var regen = typeof rec.regeneration === 'number' ? rec.regeneration : SOURCE_REGEN_TICKS;
  var travel = Math.max(1, Math.floor(distance || rec.distance || 1));
  if (harvestPower <= 0) return 0;
  if (travel < regen) {
    return Math.min(energy, harvestPower * travel);
  }
  return Math.min(energy, harvestPower * regen) + harvestPower * (travel - regen);
}

function refreshOwnedRoomSources(room) {
  var econ = ensureRoomSourceEconomy(room);
  if (!econ) return null;
  releaseStalePickupReservations(room.name);
  econ.activeSourceIds = [];
  econ.sources = {};
  econ.income = 0;
  econ.pendingEnergy = 0;
  econ.lastPickupScores = {};
  var sources = room.find(FIND_SOURCES);
  var anchor = getRoomAnchor(room);
  for (var i = 0; i < sources.length; i++) {
    var source = sources[i];
    var containers = source.pos.findInRange(FIND_STRUCTURES, 1, { filter: function (s) { return s.structureType === STRUCTURE_CONTAINER; } });
    var drops = source.pos.findInRange(FIND_DROPPED_RESOURCES, 1, { filter: function (r) { return r.resourceType === RESOURCE_ENERGY; } });
    var dropped = 0;
    for (var d = 0; d < drops.length; d++) dropped += (drops[d].amount || 0);
    var container = containers.length ? containers[0] : null;
    var containerEnergy = container && container.store ? (container.store[RESOURCE_ENERGY] || 0) : 0;
    var regen = typeof source.ticksToRegeneration === 'number' ? source.ticksToRegeneration : 300;
    var assignedCarry = (econ.pickupCarryBySource && econ.pickupCarryBySource[source.id]) || 0;
    var pendingEnergy = Math.max(0, dropped + containerEnergy - assignedCarry);
    var distance = anchor ? estimateInterRoomDistance(anchor, source.pos) : 25;
    var energyPerTick = source.energyCapacity ? source.energyCapacity / SOURCE_REGEN_TICKS : DEFAULT_SOURCE_ENERGY_PER_TICK;
    econ.activeSourceIds.push(source.id);
    econ.sources[source.id] = {
      sourceId: source.id,
      roomName: room.name,
      homeRoom: room.name,
      isRemote: false,
      pos: { x: source.pos.x, y: source.pos.y, roomName: source.pos.roomName },
      containerId: container ? container.id : null,
      droppedEnergy: dropped,
      containerEnergy: containerEnergy,
      pendingEnergy: pendingEnergy,
      energy: source.energy || 0,
      regeneration: regen,
      distance: distance,
      energyPerTick: energyPerTick,
      harvestPower: 0,
      minerCount: 0,
      assignedTruckers: 0,
      assignedCarry: assignedCarry,
      expectedPickupEnergy: pendingEnergy,
      needsPickup: pendingEnergy >= ENERGY_PICKUP_MIN,
      danger: false,
      reason: ''
    };
  }
  econ.sourceCount = econ.activeSourceIds.length;
  econ.maxIncome = econ.sourceCount * DEFAULT_SOURCE_ENERGY_PER_TICK;
  return econ;
}

function refreshBaseHarvestStats(room) {
  var econ = ensureRoomSourceEconomy(room);
  if (!econ || !econ.sources) return;
  var names = Object.keys(Game.creeps);
  for (var i = 0; i < names.length; i++) {
    var c = Game.creeps[names[i]];
    if (!c || !c.memory || c.memory.role !== 'BaseHarvest') continue;
    var sid = c.memory.assignedSource || c.memory.sourceId;
    if (!sid || !econ.sources[sid]) continue;
    econ.sources[sid].minerCount += 1;
    econ.sources[sid].harvestPower += c.getActiveBodyparts(WORK) * 2;
  }
}

function refreshTruckerCarryStats(room) {
  var econ = ensureRoomSourceEconomy(room);
  if (!econ) return;
  econ.truckerCarry = 0;
  econ.truckerCarryTotal = 0;
  econ.truckerStoredEnergy = 0;
  var names = Object.keys(Game.creeps);
  for (var i = 0; i < names.length; i++) {
    var c = Game.creeps[names[i]];
    if (!c || !c.memory || c.memory.role !== 'Trucker') continue;
    if ((c.memory.home || c.room.name) !== room.name) continue;
    econ.truckerStoredEnergy += c.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    if (!c.spawning) {
      econ.truckerCarry += c.getActiveBodyparts(CARRY) * CARRY_CAPACITY;
    }
  }
}

function calculatePendingEnergy(room) {
  var econ = ensureRoomSourceEconomy(room);
  if (!econ || !econ.sources) return 0;
  var total = 0;
  var income = 0;
  var carryNeeded = 0;
  var ids = Object.keys(econ.sources);
  for (var i = 0; i < ids.length; i++) {
    var rec = econ.sources[ids[i]];
    if (!rec) continue;
    rec.pendingEnergy = Math.max(0, (rec.containerEnergy || 0) + (rec.droppedEnergy || 0) - (rec.assignedCarry || 0));
    rec.expectedPickupEnergy = rec.pendingEnergy + getSourceExpectedEnergyDelta(rec, rec.distance);
    rec.needsPickup = rec.pendingEnergy >= 50;
    total += rec.pendingEnergy;
    income += Math.min(rec.harvestPower || 0, rec.energyPerTick || DEFAULT_SOURCE_ENERGY_PER_TICK);
    carryNeeded += 2 * Math.max(1, rec.distance || 1) * Math.max(0, rec.energyPerTick || DEFAULT_SOURCE_ENERGY_PER_TICK);
  }
  econ.pendingEnergy = total;
  econ.income = income;
  econ.truckerCarryTotal = Math.ceil(carryNeeded);
  return total;
}

function releaseStalePickupReservations(roomName) {
  var mem = ensureRoomMemory(roomName);
  var econ = mem.sourceEconomy;
  if (!econ || !econ.pickupReservations) return;
  econ.pickupCarryBySource = {};
  var names = Object.keys(econ.pickupReservations);
  for (var i = 0; i < names.length; i++) {
    var name = names[i];
    var rec = econ.pickupReservations[name];
    if (!rec || rec.until < Game.time || !Game.creeps[name]) {
      delete econ.pickupReservations[name];
      continue;
    }
    econ.pickupCarryBySource[rec.sourceId] = (econ.pickupCarryBySource[rec.sourceId] || 0) + (rec.carryAmount || 0);
  }
}

function reservePickupCarry(roomName, sourceId, creepName, carryAmount) {
  var mem = ensureRoomMemory(roomName);
  if (!mem.sourceEconomy) return 0;
  if (!mem.sourceEconomy.pickupReservations) mem.sourceEconomy.pickupReservations = {};
  mem.sourceEconomy.pickupReservations[creepName] = { sourceId: sourceId, carryAmount: carryAmount || 0, until: Game.time + 20 };
  return carryAmount || 0;
}

function getBestPickupSource(room, creep) {
  var econ = ensureRoomSourceEconomy(room);
  if (!econ || !econ.sources) return null;
  releaseStalePickupReservations(room.name);
  var ids = Object.keys(econ.sources);
  var best = null;
  var bestScore = -1;
  var scores = {};
  var capacity = creep && creep.store ? (creep.store.getFreeCapacity(RESOURCE_ENERGY) || 0) : 0;
  if (capacity <= 0) return null;
  for (var i = 0; i < ids.length; i++) {
    var rec = econ.sources[ids[i]];
    if (!rec || rec.danger) continue;
    rec.assignedCarry = (econ.pickupCarryBySource && econ.pickupCarryBySource[rec.sourceId]) || 0;
    rec.pendingEnergy = Math.max(0, (rec.containerEnergy || 0) + (rec.droppedEnergy || 0) - rec.assignedCarry);
    var sourceObj = Game.getObjectById(rec.sourceId);
    var distance = getSourceDistance(room, creep, rec, sourceObj);
    if (typeof creep.ticksToLive === 'number' && creep.ticksToLive < (2 * distance + 30)) {
      scores[rec.sourceId] = { skipped: 'ttl', distance: distance };
      continue;
    }
    var expectedEnergy = Math.max(0, (rec.pendingEnergy || 0) + getSourceExpectedEnergyDelta(rec, distance));
    if (expectedEnergy < 0.5 * capacity && (rec.pendingEnergy || 0) < ENERGY_PICKUP_MIN) {
      scores[rec.sourceId] = { skipped: 'low-energy', distance: distance, expectedEnergy: Math.floor(expectedEnergy) };
      continue;
    }
    var score = Math.min(capacity, expectedEnergy) / Math.max(1, distance);
    scores[rec.sourceId] = {
      score: score,
      distance: distance,
      expectedEnergy: Math.floor(expectedEnergy),
      pendingEnergy: Math.floor(rec.pendingEnergy || 0)
    };
    if (score > bestScore) {
      bestScore = score;
      best = rec;
      best.distance = distance;
      best.expectedPickupEnergy = expectedEnergy;
      best.pickupScore = score;
    }
  }
  econ.lastPickupScores = scores;
  return best;
}

module.exports = {
  ensureRoomSourceEconomy: ensureRoomSourceEconomy,
  refreshOwnedRoomSources: refreshOwnedRoomSources,
  refreshBaseHarvestStats: refreshBaseHarvestStats,
  refreshTruckerCarryStats: refreshTruckerCarryStats,
  calculatePendingEnergy: calculatePendingEnergy,
  getBestPickupSource: getBestPickupSource,
  reservePickupCarry: reservePickupCarry,
  releaseStalePickupReservations: releaseStalePickupReservations,
  getSourceExpectedEnergyDelta: getSourceExpectedEnergyDelta,
  getSourceDistance: getSourceDistance
};
