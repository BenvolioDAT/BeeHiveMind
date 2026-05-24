'use strict';

// -----------------------------------------------------------------------------
// role.Trucker.Logic.js - local hauling plus remote container hauling execution
// Owns:
// * Trucker creep memory: role/task/home/state, dispatchJob,
//   requestId/containerId/sourceId/requestRoom/requestX/requestY/targetRoom,
//   deliveryTargetId/deliveryReservedAmount, and energyHandoffTarget.
// * Same-tick delivery reservations in Memory._queenRes and Memory._PIB so
//   Queens and Truckers do not overfill the same structure.
// * Memory.__BHM.truckerDispatch.lastRun diagnostic fields for the latest
//   execution pass.
// Reads/writes:
// * Memory.__BHM.remoteHaulRequests records produced by Luna remote containers.
// * role.EnergyHandoff request memory when handing energy to worker creeps.
// Usually called by:
// * BeeHiveMind.runCreeps() through role.Trucker.js.
// Systems that depend on it:
// * Trucker.Dispatcher assigns remote pickup/local work; BeeSpawnManager reads
//   dispatch state to decide remote-capable Trucker quotas.
// Do not casually change:
// * request claim/release fields or delivery reservation math; duplicate
//   haulers and over-reserved sinks are easy to create.
// -----------------------------------------------------------------------------

var CFG = require('role.Trucker.Config');
var Dispatcher = require('Trucker.Dispatcher');
var Handoff = require('role.EnergyHandoff');
var BeeSelectors = require('BeeSelectors');
var BeeSourceEconomy = require('BeeSourceEconomy');

function ensureIdentity(creep) {
  // Normalize old or manually spawned haulers into the Trucker contract before
  // any dispatcher logic reads creep.memory.role/task/home/state.
  creep.memory.role = 'Trucker';
  if (!creep.memory.task) creep.memory.task = 'haulUnified';
  if (!creep.memory.home) creep.memory.home = Memory.firstSpawnRoom || creep.room.name;
  if (!creep.memory.state) creep.memory.state = 'IDLE';
}

function ensureTruckerDiagnostics() {
  // Last-run diagnostics are shared per tick/home for console debugging. They
  // are intentionally not used to drive behavior.
  if (!Memory.__BHM) Memory.__BHM = {};
  if (!Memory.__BHM.truckerDispatch) Memory.__BHM.truckerDispatch = {};
  if (!Memory.__BHM.truckerDispatch.lastRun) Memory.__BHM.truckerDispatch.lastRun = {};
  return Memory.__BHM.truckerDispatch.lastRun;
}

function getQueenReservationMap() {
  // Compatibility reservation map shared with Queen-era logistics. This is
  // tick-local Memory so multiple haulers do not all choose the same free space.
  if (!Memory._queenRes || Memory._queenRes.tick !== Game.time) {
    Memory._queenRes = { tick: Game.time, map: {} };
  }
  return Memory._queenRes.map;
}

function getReservedEnergyForStructure(structId) {
  var map = getQueenReservationMap();
  return map[structId] || 0;
}

function sumPibReservedEnergy(roomName, targetId, resourceType) {
  resourceType = resourceType || RESOURCE_ENERGY;
  var root = Memory._PIB;
  if (!root || root.tick !== Game.time || !root.rooms) return 0;
  var room = root.rooms[roomName];
  if (!room || !room.fills) return 0;
  var fills = room.fills[targetId];
  if (!fills) return 0;
  var sum = 0;
  var names = Object.keys(fills);
  for (var i = 0; i < names.length; i++) {
    var rec = fills[names[i]];
    if (!rec || rec.res !== resourceType) continue;
    sum += (rec.amount || 0);
  }
  return sum;
}

function getEffectiveFreeCapacity(target, resourceType) {
  resourceType = resourceType || RESOURCE_ENERGY;
  if (!target || !target.store) return 0;
  var freeNow = target.store.getFreeCapacity(resourceType) || 0;
  var sameTick = getReservedEnergyForStructure(target.id) || 0;
  var roomName = (target.pos && target.pos.roomName) || (target.room && target.room.name);
  var pib = roomName ? sumPibReservedEnergy(roomName, target.id, resourceType) : 0;
  return Math.max(0, freeNow - sameTick - pib);
}

function reservePibFill(creep, target, amount, resourceType) {
  // PIB fill reservations mirror Queen/Trucker delivery intent in Memory._PIB
  // so other same-tick logistics code can see capacity that is already claimed.
  resourceType = resourceType || RESOURCE_ENERGY;
  if (!creep || !target || !target.id) return 0;
  if (!Memory._PIB || Memory._PIB.tick !== Game.time) Memory._PIB = { tick: Game.time, rooms: {} };
  var roomName = (target.pos && target.pos.roomName) || (creep.room && creep.room.name);
  if (!roomName) return 0;
  if (!Memory._PIB.rooms[roomName]) Memory._PIB.rooms[roomName] = { fills: {}, withdrawals: {} };
  var room = Memory._PIB.rooms[roomName];
  if (!room.fills[target.id]) room.fills[target.id] = {};

  var booked = Math.max(0, Math.min(Math.floor(amount || 0), getEffectiveFreeCapacity(target, resourceType)));
  room.fills[target.id][creep.name] = { res: resourceType, amount: booked, untilTick: Game.time + creep.pos.getRangeTo(target) };
  return booked;
}

function releasePibFill(creep, target, resourceType) {
  resourceType = resourceType || RESOURCE_ENERGY;
  var targetId = target && target.id ? target.id : (creep && creep.memory ? creep.memory.deliveryTargetId : null);
  var roomName = (target && target.pos && target.pos.roomName) || (creep && creep.memory ? creep.memory.deliveryTargetRoom : null) || (creep && creep.room && creep.room.name);
  if (!targetId || !roomName) return;
  var root = Memory._PIB;
  if (!root || !root.rooms || !root.rooms[roomName] || !root.rooms[roomName].fills) return;
  var map = root.rooms[roomName].fills[targetId];
  if (map && map[creep.name] && (!map[creep.name].res || map[creep.name].res === resourceType)) delete map[creep.name];
  if (map && Object.keys(map).length === 0) delete root.rooms[roomName].fills[targetId];
}

function reserveFill(creep, target, amount, resourceType) {
  // Public local-delivery reservation helper for this role. It reserves only
  // effective free capacity after same-tick Queen and PIB reservations.
  resourceType = resourceType || RESOURCE_ENERGY;
  if (!creep || !target || !target.id) return 0;
  var map = getQueenReservationMap();
  var free = getEffectiveFreeCapacity(target, resourceType);
  var request = Math.max(0, Math.floor(Number(amount) || 0));
  var reserve = Math.min(request, free);
  if (reserve <= 0) return 0;
  map[target.id] = (map[target.id] || 0) + reserve;
  reservePibFill(creep, target, reserve, resourceType);
  creep.memory.deliveryTargetId = target.id;
  creep.memory.deliveryTargetRoom = target.pos ? target.pos.roomName : creep.room.name;
  creep.memory.deliveryReservedAmount = reserve;
  return reserve;
}

function clearDeliveryReservation(creep, target, resourceType) {
  releasePibFill(creep, target, resourceType || RESOURCE_ENERGY);
  delete creep.memory.deliveryTargetId;
  delete creep.memory.deliveryTargetRoom;
  delete creep.memory.deliveryReservedAmount;
}

function describeSinkType(target) {
  if (!target) return null;
  if (target.structureType) return target.structureType;
  if (target.name) return 'creep';
  return 'unknown';
}

function recordDeliverySelection(creep, diag, target, mode, fallbackReason) {
  if (!diag) return;
  diag.deliveryMode = mode || 'legacy_fallback';
  diag.deliverySinkId = target && target.id ? target.id : null;
  diag.deliverySinkType = describeSinkType(target);
  diag.deliveryFallbackReason = fallbackReason || null;

  var home = creep && creep.memory ? (creep.memory.home || (creep.room && creep.room.name)) : null;
  if (!home) return;
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[home]) Memory.rooms[home] = {};
  Memory.rooms[home].lastTruckerDelivery = {
    tick: Game.time,
    creepName: creep.name,
    deliveryMode: diag.deliveryMode,
    selectedSinkId: diag.deliverySinkId,
    selectedSinkType: diag.deliverySinkType,
    fallbackReason: diag.deliveryFallbackReason
  };
}

function chooseClosestEffectiveFree(creep, candidates, diag) {
  var best = null;
  var bestFallback = null;
  for (var i = 0; i < candidates.length; i++) {
    var target = candidates[i];
    if (!target || !target.store) continue;
    if (diag) diag.deliveryTargetsSeen++;
    if (getEffectiveFreeCapacity(target, RESOURCE_ENERGY) > 0) {
      best = best || target;
    } else {
      bestFallback = 'full_or_reserved';
      if (diag) diag.skippedReservedCapacity++;
    }
  }
  if (!best) return { target: null, reason: bestFallback || 'none_available' };
  var closest = creep.pos.findClosestByPath(candidates, {
    filter: function (target) {
      return target && target.store && getEffectiveFreeCapacity(target, RESOURCE_ENERGY) > 0;
    }
  });
  return { target: closest || best, reason: null };
}

function findPreferredFeederSink(creep, diag) {
  // Storage/hub feeder mode is the new normal path. Source containers remain
  // mining output; the hub container is the temporary spawn-area buffer used
  // only before storage exists.
  var room = creep && creep.room;
  if (!room) return { target: null, mode: null, reason: 'missing_room' };

  if (CFG.TRUCKER_STORAGE_FEEDER_ENABLED !== false && room.storage) {
    if (diag) diag.deliveryTargetsSeen++;
    if (getEffectiveFreeCapacity(room.storage, RESOURCE_ENERGY) > 0) {
      return { target: room.storage, mode: 'storage_feeder', reason: null };
    }
    if (diag) diag.skippedReservedCapacity++;
    return { target: null, mode: null, reason: 'storage_full_or_reserved' };
  }
  if (room.storage) return { target: null, mode: null, reason: 'storage_feeder_disabled' };

  if (CFG.TRUCKER_HUB_CONTAINER_FEEDER_ENABLED !== false) {
    var hubs = BeeSelectors.findSpawnHubContainers(room, {
      rangeFromSpawn: CFG.HUB_CONTAINER_RANGE_FROM_SPAWN
    });
    if (hubs && hubs.length) {
      var picked = chooseClosestEffectiveFree(creep, hubs, diag);
      if (picked.target) return { target: picked.target, mode: 'hub_container_feeder', reason: null };
      return { target: null, mode: null, reason: 'hub_container_' + picked.reason };
    }
    return { target: null, mode: null, reason: 'no_hub_container' };
  }

  return { target: null, mode: null, reason: 'hub_container_feeder_disabled' };
}

function hasActivePreferredFeederSink(creep) {
  var selection = findPreferredFeederSink(creep, null);
  return !!(selection && selection.target);
}

function recordExistingDeliveryTarget(creep, diag, target) {
  if (!target || !diag || diag.deliveryMode) return;
  var mode = 'legacy_fallback';
  if (creep.room && creep.room.storage && target.id === creep.room.storage.id && CFG.TRUCKER_STORAGE_FEEDER_ENABLED !== false) {
    mode = 'storage_feeder';
  } else if (creep.room && !creep.room.storage && BeeSelectors.isSpawnHubContainer(creep.room, target, {
    rangeFromSpawn: CFG.HUB_CONTAINER_RANGE_FROM_SPAWN
  })) {
    mode = 'hub_container_feeder';
  }
  recordDeliverySelection(creep, diag, target, mode, null);
}


function clearTruckerHandoff(creep, room, reason, diag) {
  // Handoff cleanup must clear both sides of the request: the Trucker's target
  // and the receiver creep's assigned hauler/courier memory.
  var mem = Handoff.ensureHandoffMemory(room || creep.room);
  var name = creep.memory.energyHandoffTarget;
  if (name && mem && mem.requests && mem.requests[name]) {
    var req = mem.requests[name];
    Handoff.clearAssignedHauler(req);
    var rc = Game.creeps[name]; if (rc && rc.memory) { rc.memory.energyHandoffHauler = null; delete rc.memory.energyHandoffCourier; }
  }
  creep.memory.energyHandoffTarget = null;
  creep.memory.energyHandoffFailCount = 0;
  if (diag && reason) diag.handoffClearedReason = reason;
}

function isCreepEnergyReceiver(target) {
  if (!target || !target.pos || !target.store) return false;
  if (!target.my || target.spawning) return false;
  if (!target.name) return false;
  return typeof target.store.getFreeCapacity === 'function';
}

function findClaimableEnergyHandoffRequest(trucker, diag) {
  // Local worker handoff search. This runs before storage dumping when there is
  // no urgent structure fill, letting Truckers feed active workers directly.
  if (!CFG.HANDOFF_ENABLED) return null;
  Handoff.cleanupEnergyHandoffRequests(trucker.room);
  var mem = Handoff.ensureHandoffMemory(trucker.room); if (!mem) return null;
  var reqs = mem.requests || {}; var best = null; var bestScore = -99999;
  var keys = Object.keys(reqs);
  if (diag) diag.handoffRequestsSeen = keys.length;
  for (var i = 0; i < keys.length; i++) {
    var req = reqs[keys[i]]; if (!req) continue;
    if (req.roomName !== trucker.room.name) continue;
    Handoff.migrateHandoffRequestSchema(req, trucker.room.name);
    if (Handoff.getAssignedHaulerName(req) && Handoff.getAssignedHaulerName(req) !== trucker.name) continue;
    var receiver = Game.creeps[req.receiverName];
    if (!isCreepEnergyReceiver(receiver)) continue;
    if (receiver.pos.roomName !== trucker.room.name) continue;
    var free = receiver.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
    if (free < CFG.HANDOFF_MIN_RECEIVER_FREE) continue;
    var d = trucker.pos.getRangeTo(receiver);
    if (d > CFG.HANDOFF_MAX_RANGE) continue;
    var score = (req.jobTargetId ? 200 : 0) + free - d;
    if (score > bestScore) { bestScore = score; best = req; }
  }
  return best;
}

function getCurrentAssignedHandoffRequest(trucker) {
  var targetName = trucker.memory.energyHandoffTarget;
  if (!targetName) return null;
  var mem = Handoff.ensureHandoffMemory(trucker.room);
  if (!mem || !mem.requests) return null;
  var req = mem.requests[targetName];
  if (!req) return null;
  Handoff.migrateHandoffRequestSchema(req, trucker.room.name);
  if (Handoff.getAssignedHaulerName(req) !== trucker.name) return null;
  var receiver = Game.creeps[req.receiverName];
  if (!isCreepEnergyReceiver(receiver)) return null;
  if (receiver.pos.roomName !== trucker.room.name) return null;
  var free = receiver.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
  if (free < CFG.HANDOFF_MIN_RECEIVER_FREE) return null;
  if (trucker.pos.getRangeTo(receiver) > CFG.HANDOFF_MAX_RANGE) return null;
  return req;
}

function claimEnergyHandoffRequest(trucker, req, diag) {
  if (!req) return false;
  var mem = Handoff.ensureHandoffMemory(trucker.room); if (!mem || !mem.requests[req.receiverName]) return false;
  if (trucker.memory.energyHandoffTarget && trucker.memory.energyHandoffTarget !== req.receiverName) {
    clearTruckerHandoff(trucker, trucker.room, 'switch_target', diag);
  }
  var live = mem.requests[req.receiverName];
  Handoff.migrateHandoffRequestSchema(live, trucker.room.name);
  if (Handoff.getAssignedHaulerName(live) && Handoff.getAssignedHaulerName(live) !== trucker.name) return false;
  if (!Handoff.getAssignedHaulerName(live)) {
    Handoff.setAssignedHaulerName(live, trucker.name);
    live.assignedAt = Game.time;
    live.expiresAt = Game.time + CFG.HANDOFF_ASSIGN_TTL;
    live.waitUntil = Game.time + CFG.HANDOFF_WAIT_TTL;
    if (diag) diag.handoffClaimed = true;
  }
  trucker.memory.energyHandoffTarget = live.receiverName;
  var receiver = Game.creeps[live.receiverName]; if (receiver && receiver.memory) { receiver.memory.energyHandoffHauler = trucker.name; delete receiver.memory.energyHandoffCourier; }
  return true;
}

function tryTruckerEnergyHandoff(creep, diag) {
  // Attempt one receiver-to-hauler transfer workflow. Returning true means the
  // Trucker spent this tick servicing or resolving the handoff request.
  if (!CFG.HANDOFF_ENABLED) return false;
  var carryAmt = creep.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
  if (carryAmt < CFG.HANDOFF_MIN_TRUCKER_ENERGY) { clearTruckerHandoff(creep, creep.room, 'low_energy', diag); if (diag) diag.handoffResult = 'below_min'; return false; }

  Handoff.cleanupEnergyHandoffRequests(creep.room);
  var req = getCurrentAssignedHandoffRequest(creep);
  if (!req) req = findClaimableEnergyHandoffRequest(creep, diag);
  if (!req) { clearTruckerHandoff(creep, creep.room, 'no_request', diag); if (diag) diag.handoffResult = 'none'; return false; }
  if (!claimEnergyHandoffRequest(creep, req, diag)) { if (diag) diag.handoffResult = 'claim_failed'; return false; }

  var receiver = Game.creeps[req.receiverName];
  if (!isCreepEnergyReceiver(receiver)) { clearTruckerHandoff(creep, creep.room, 'invalid_receiver', diag); if (diag) diag.handoffResult = 'invalid_receiver'; return false; }
  var free = receiver.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
  if (free < CFG.HANDOFF_MIN_RECEIVER_FREE) { clearTruckerHandoff(creep, creep.room, 'receiver_free_low', diag); if (diag) diag.handoffResult = 'receiver_low'; return false; }

  clearDeliveryReservation(creep);
  var amount = Math.min(carryAmt, free, req.amountWanted || free);
  var tr = creep.transfer(receiver, RESOURCE_ENERGY, amount);
  if (diag) diag.handoffTarget = req.receiverName;
  if (tr === ERR_NOT_IN_RANGE) { creep.travelTo(receiver, { range: 1, reusePath: CFG.PATH_REUSE }); if (diag) diag.handoffResult = 'moving'; return true; }
  if (tr === OK) {
    if (diag) diag.handoffResult = 'ok';
    if ((creep.store[RESOURCE_ENERGY] || 0) === 0 || (receiver.store.getFreeCapacity(RESOURCE_ENERGY) || 0) === 0) clearTruckerHandoff(creep, creep.room, 'handoff_complete', diag);
    return true;
  }
  if (tr === ERR_FULL || tr === ERR_INVALID_TARGET || tr === ERR_NOT_ENOUGH_RESOURCES) {
    clearTruckerHandoff(creep, creep.room, 'transfer_' + tr, diag); if (diag) diag.handoffResult = 'clear_' + tr; return true;
  }
  creep.memory.energyHandoffFailCount = (creep.memory.energyHandoffFailCount || 0) + 1;
  if (creep.memory.energyHandoffFailCount >= CFG.HANDOFF_MAX_FAILS) clearTruckerHandoff(creep, creep.room, 'max_fails', diag);
  if (diag) diag.handoffResult = 'code_' + tr;
  return true;
}

function clearRemoteRequestAssignment(creep) {
  // Release a remoteHaulRequest claim held by this creep and clear all request
  // location fields from creep memory so the dispatcher can select fresh work.
  var requests = (Memory.__BHM && Memory.__BHM.remoteHaulRequests) || {};
  var id = creep.memory.requestId;
  if (id && requests[id] && requests[id].assignedTo === creep.name) {
    requests[id].assignedTo = null;
    requests[id].assignedUntil = 0;
  }
  delete creep.memory.requestId; delete creep.memory.containerId; delete creep.memory.sourceId;
  delete creep.memory.requestRoom; delete creep.memory.requestX; delete creep.memory.requestY; delete creep.memory.targetRoom;
}

function isActiveRemoteRequest(req, homeName) { /* unchanged */
  // Remote requests are valid only while fresh, large enough, same-home, and
  // not under maintenance. The dispatcher and runner intentionally share this
  // predicate so claimed jobs can be dropped when Memory changes.
  if (!req || !req.id || !homeName) return false;
  if (req.homeRoom !== homeName) return false;
  if (CFG.shouldBlockRemoteHaulForMaintenance(req)) return false;
  if ((req.amount || 0) < CFG.MIN_HAUL_REQUEST_ENERGY) return false;
  if ((Game.time - (req.updated || 0)) > CFG.REQUEST_STALE_TICKS) return false;
  return true;
}
function isRemoteRequestReservedByOther(req, creepName) { if (!req) return false; return !!(req.assignedTo && req.assignedTo !== creepName && (req.assignedUntil || 0) > Game.time); }

function hasUrgentLocalDeliveryTarget(creep) {
  var room = creep.room;
  var spExt = room.find(FIND_STRUCTURES, { filter: function(s){ return (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) && getEffectiveFreeCapacity(s, RESOURCE_ENERGY) > 0; } });
  if (spExt.length > 0) return true;
  var towers = room.find(FIND_STRUCTURES, { filter: function(s){ if (s.structureType !== STRUCTURE_TOWER || !s.store) return false; var cap = s.store.getCapacity(RESOURCE_ENERGY) || 0; if (cap <= 0) return false; var cur = s.store[RESOURCE_ENERGY] || 0; if (cur >= Math.floor(cap * CFG.TOWER_REFILL_AT_OR_BELOW)) return false; return getEffectiveFreeCapacity(s, RESOURCE_ENERGY) > 0; } });
  return towers.length > 0;
}
function isUrgentDeliveryTarget(target) {
  if (!target || !target.store) return false;
  if (target.structureType === STRUCTURE_SPAWN || target.structureType === STRUCTURE_EXTENSION) {
    return getEffectiveFreeCapacity(target, RESOURCE_ENERGY) > 0;
  }
  if (target.structureType === STRUCTURE_TOWER) {
    var cap = target.store.getCapacity(RESOURCE_ENERGY) || 0;
    if (cap <= 0) return false;
    var cur = target.store[RESOURCE_ENERGY] || 0;
    if (cur >= Math.floor(cap * CFG.TOWER_REFILL_AT_OR_BELOW)) return false;
    return getEffectiveFreeCapacity(target, RESOURCE_ENERGY) > 0;
  }
  return false;
}
function isNonUrgentStorageLikeTarget(target) {
  if (!target) return false;
  return target.structureType === STRUCTURE_STORAGE ||
    target.structureType === STRUCTURE_TERMINAL ||
    target.structureType === STRUCTURE_CONTAINER ||
    target.structureType === STRUCTURE_LINK;
}

function claimRemoteRequestForJob(creep, job) { /* unchanged */
  // Convert a dispatcher job into a live Memory.__BHM.remoteHaulRequests claim
  // plus creep memory route fields used by runRemote().
  var reqs = (Memory.__BHM && Memory.__BHM.remoteHaulRequests) || {};
  var req = reqs[job.requestId];
  if (!req) return null;
  if (isRemoteRequestReservedByOther(req, creep.name)) return null;
  req.assignedTo = creep.name; req.assignedUntil = Game.time + CFG.RESERVATION_TTL;
  creep.memory.requestId = job.requestId; creep.memory.containerId = req.containerId || job.containerId; creep.memory.sourceId = req.sourceId || job.sourceId;
  creep.memory.requestRoom = req.roomName || req.remoteRoom || job.roomName || null;
  creep.memory.requestX = (typeof req.x === 'number') ? req.x : job.x; creep.memory.requestY = (typeof req.y === 'number') ? req.y : job.y;
  creep.memory.targetRoom = creep.memory.requestRoom;
  return req;
}

function drawHaulIntent(creep, target, color) {
  if (!creep || !target || !target.pos || !Game.map || !Game.map.visual) return;
  try {
    Game.map.visual.line(creep.pos, target.pos, {
      color: color || '#4deeea',
      opacity: 0.55,
      width: 1.2,
      lineStyle: 'dashed'
    });
  } catch (err) {}
}

function getLargestEnergyDropNear(pos, range, minAmount) {
  if (!pos || !Game.rooms[pos.roomName]) return null;
  var drops = pos.findInRange(FIND_DROPPED_RESOURCES, range || 1, {
    filter: function (r) { return r.resourceType === RESOURCE_ENERGY && (r.amount || 0) >= (minAmount || 1); }
  });
  var best = null;
  for (var i = 0; i < drops.length; i++) {
    if (!best || (drops[i].amount || 0) > (best.amount || 0)) best = drops[i];
  }
  return best;
}

function getLargestEnergyTombstoneNear(pos, range) {
  if (!pos || !Game.rooms[pos.roomName]) return null;
  var tombstones = pos.findInRange(FIND_TOMBSTONES, range || 1, {
    filter: function (t) { return t.store && (t.store[RESOURCE_ENERGY] || 0) > 0; }
  });
  var best = null;
  for (var i = 0; i < tombstones.length; i++) {
    if (!best || (tombstones[i].store[RESOURCE_ENERGY] || 0) > (best.store[RESOURCE_ENERGY] || 0)) best = tombstones[i];
  }
  return best;
}

function findRemoteLooseEnergy(creep, req, source, container) {
  var anchors = [];
  if (source && source.pos) anchors.push({ pos: source.pos, range: 3 });
  if (container && container.pos) anchors.push({ pos: container.pos, range: 2 });
  var requestRoom = req ? (req.roomName || req.remoteRoom) : null;
  if (requestRoom && typeof req.x === 'number' && typeof req.y === 'number' && Game.rooms[requestRoom]) {
    anchors.push({ pos: new RoomPosition(req.x, req.y, requestRoom), range: 2 });
  }

  var bestDrop = null;
  var bestTombstone = null;
  for (var i = 0; i < anchors.length; i++) {
    var anchor = anchors[i];
    var drop = getLargestEnergyDropNear(anchor.pos, anchor.range, 50);
    if (drop && (!bestDrop || drop.amount > bestDrop.amount)) bestDrop = drop;
    var tombstone = getLargestEnergyTombstoneNear(anchor.pos, anchor.range);
    if (tombstone && (!bestTombstone || (tombstone.store[RESOURCE_ENERGY] || 0) > (bestTombstone.store[RESOURCE_ENERGY] || 0))) {
      bestTombstone = tombstone;
    }
  }
  return bestDrop || bestTombstone;
}

function collectEnergyTarget(creep, target) {
  if (!creep || !target) return ERR_INVALID_TARGET;
  var result;
  if (target.resourceType) {
    result = creep.pickup(target);
  } else {
    result = creep.withdraw(target, RESOURCE_ENERGY);
  }
  if (result === ERR_NOT_IN_RANGE && target.pos) {
    creep.travelTo(target, { range: 1, reusePath: CFG.PATH_REUSE });
  }
  if (result === OK && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
    creep.memory.dispatchJob = { id: 'return:' + creep.name, type: 'REMOTE_RETURN', homeRoom: creep.memory.home };
  }
  return result;
}

function findLocalCollectTarget(creep) {
  var room = creep.room;
  BeeSourceEconomy.refreshOwnedRoomSources(room);
  BeeSourceEconomy.refreshBaseHarvestStats(room);
  BeeSourceEconomy.refreshTruckerCarryStats(room);
  BeeSourceEconomy.calculatePendingEnergy(room);
  var pick = BeeSourceEconomy.getBestPickupSource(room, creep);
  if (pick) {
    var amount = creep.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
    BeeSourceEconomy.reservePickupCarry(room.name, pick.sourceId, creep.name, amount);
    var sourceObj = Game.getObjectById(pick.sourceId);
    var container = pick.containerId ? Game.getObjectById(pick.containerId) : null;
    if (container && (container.store[RESOURCE_ENERGY] || 0) > 0) {
      Memory.rooms[room.name].lastTruckerSourcePick = { tick: Game.time, trucker: creep.name, selectedSourceId: pick.sourceId, selectedTargetId: container.id, pendingEnergy: pick.pendingEnergy || 0, assignedCarry: amount, reason: 'source_container' };
      drawHaulIntent(creep, sourceObj || container, '#4deeea');
      return container;
    }
    if (sourceObj) {
      var nearDrop = getLargestEnergyDropNear(sourceObj.pos, 1, 1);
      if (nearDrop) {
        Memory.rooms[room.name].lastTruckerSourcePick = { tick: Game.time, trucker: creep.name, selectedSourceId: pick.sourceId, selectedTargetId: nearDrop.id, pendingEnergy: pick.pendingEnergy || 0, assignedCarry: amount, reason: 'source_drop' };
        drawHaulIntent(creep, sourceObj, '#4deeea');
        return nearDrop;
      }
      Memory.rooms[room.name].lastTruckerSourcePick = { tick: Game.time, trucker: creep.name, selectedSourceId: pick.sourceId, selectedTargetId: null, pendingEnergy: pick.pendingEnergy || 0, expectedPickupEnergy: Math.floor(pick.expectedPickupEnergy || 0), assignedCarry: amount, reason: 'source_wait' };
      drawHaulIntent(creep, sourceObj, '#4deeea');
      return { waitForSourceEnergy: true, sourceId: pick.sourceId, pos: sourceObj.pos };
    }
  }
  var drops = room.find(FIND_DROPPED_RESOURCES, { filter: function(r){ return r.resourceType === RESOURCE_ENERGY && r.amount >= 50; } }); if (drops.length) return creep.pos.findClosestByPath(drops);
  var graves = room.find(FIND_TOMBSTONES, { filter: function(t){ return t.store && (t.store[RESOURCE_ENERGY] || 0) > 0; } }); if (graves.length) return creep.pos.findClosestByPath(graves);
  var ruins = room.find(FIND_RUINS, { filter: function(t){ return t.store && (t.store[RESOURCE_ENERGY] || 0) > 0; } }); if (ruins.length) return creep.pos.findClosestByPath(ruins);
  var hubIds = {};
  var hubs = BeeSelectors.findSpawnHubContainers(room, { rangeFromSpawn: CFG.HUB_CONTAINER_RANGE_FROM_SPAWN });
  for (var h = 0; h < hubs.length; h++) {
    if (hubs[h] && hubs[h].id) hubIds[hubs[h].id] = true;
  }
  var containers = room.find(FIND_STRUCTURES, {
    filter: function(s){
      if (!s || s.structureType !== STRUCTURE_CONTAINER || !s.store) return false;
      if (hubIds[s.id]) return false;
      return (s.store[RESOURCE_ENERGY] || 0) >= 50;
    }
  }); if (containers.length) return creep.pos.findClosestByPath(containers);
  if (room.storage && (room.storage.store[RESOURCE_ENERGY] || 0) > 0 && !hasActivePreferredFeederSink(creep)) return room.storage;
  if (room.terminal && (room.terminal.store[RESOURCE_ENERGY] || 0) > 0) return room.terminal;
  return null;
}

function pickClosestWithEffectiveFree(creep, candidates, diag) {
  var best = null;
  var i;
  for (i = 0; i < candidates.length; i++) {
    var s = candidates[i];
    var eff = getEffectiveFreeCapacity(s, RESOURCE_ENERGY);
    diag.deliveryTargetsSeen++;
    if (eff > 0) best = best || s;
    else diag.skippedReservedCapacity++;
  }
  if (!best) return null;
  return creep.pos.findClosestByPath(candidates, { filter: function(s){ return getEffectiveFreeCapacity(s, RESOURCE_ENERGY) > 0; } }) || best;
}

function findLocalDeliverTarget(creep, diag) {
  var room = creep.room;
  var feeder = findPreferredFeederSink(creep, diag);
  if (feeder.target) {
    recordDeliverySelection(creep, diag, feeder.target, feeder.mode, null);
    return feeder.target;
  }
  var feederFallbackReason = feeder.reason || 'no_preferred_feeder';

  var spExt = room.find(FIND_STRUCTURES, { filter: function(s){ return (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) && s.store; } });
  var target = pickClosestWithEffectiveFree(creep, spExt, diag);
  if (target) {
    recordDeliverySelection(creep, diag, target, 'legacy_fallback', feederFallbackReason);
    return target;
  }

  var towers = room.find(FIND_STRUCTURES, { filter: function(s){ if (s.structureType !== STRUCTURE_TOWER || !s.store) return false; var cap = s.store.getCapacity(RESOURCE_ENERGY) || 0; if (cap <= 0) return false; return (s.store[RESOURCE_ENERGY] || 0) < Math.floor(cap * CFG.TOWER_REFILL_AT_OR_BELOW); } });
  target = pickClosestWithEffectiveFree(creep, towers, diag);
  if (target) {
    recordDeliverySelection(creep, diag, target, 'legacy_fallback', feederFallbackReason);
    return target;
  }

  if (room.storage && getEffectiveFreeCapacity(room.storage, RESOURCE_ENERGY) > 0) { diag.deliveryTargetsSeen++; recordDeliverySelection(creep, diag, room.storage, 'legacy_fallback', feederFallbackReason); return room.storage; }
  if (room.storage) { diag.deliveryTargetsSeen++; diag.skippedReservedCapacity++; }
  if (room.terminal && getEffectiveFreeCapacity(room.terminal, RESOURCE_ENERGY) > 0) { diag.deliveryTargetsSeen++; recordDeliverySelection(creep, diag, room.terminal, 'legacy_fallback', feederFallbackReason); return room.terminal; }
  if (room.terminal) { diag.deliveryTargetsSeen++; diag.skippedReservedCapacity++; }
  recordDeliverySelection(creep, diag, null, 'legacy_fallback', feederFallbackReason);
  return null;
}

function runLocal(creep, job, diag) {
  // Local mode alternates between collection and delivery, but urgent spawn/
  // extension/tower needs can interrupt non-urgent delivery reservations.
  if (creep.room.name !== creep.memory.home) { creep.travelTo(new RoomPosition(25, 25, creep.memory.home), { range: 20, reusePath: CFG.PATH_REUSE }); return; }
  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) clearDeliveryReservation(creep);

  var preferredFeederActive = hasActivePreferredFeederSink(creep);
  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0 && hasUrgentLocalDeliveryTarget(creep)) { creep.memory.dispatchJob = { id: 'localDeliver:' + creep.memory.home, type: 'LOCAL_DELIVER', homeRoom: creep.memory.home }; }

  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0 || job.type === 'LOCAL_COLLECT') {
    var src = findLocalCollectTarget(creep);
    if (!src) { if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) creep.memory.dispatchJob = { id: 'localDeliver:' + creep.memory.home, type: 'LOCAL_DELIVER', homeRoom: creep.memory.home }; return; }
    if (src.waitForSourceEnergy && src.pos) {
      if (creep.pos.getRangeTo(src.pos) > 3) creep.travelTo(src.pos, { range: 3, reusePath: CFG.PATH_REUSE });
      return;
    }
    var pr = src.amount ? creep.pickup(src) : creep.withdraw(src, RESOURCE_ENERGY);
    if (pr === ERR_NOT_IN_RANGE) creep.travelTo(src, { range: 1, reusePath: CFG.PATH_REUSE });
    return;
  }

  var urgentTargetExists = hasUrgentLocalDeliveryTarget(creep);
  var dst = creep.memory.deliveryTargetId ? Game.getObjectById(creep.memory.deliveryTargetId) : null;
  if (urgentTargetExists && dst && isNonUrgentStorageLikeTarget(dst) && !isUrgentDeliveryTarget(dst) && !preferredFeederActive) {
    clearDeliveryReservation(creep, dst);
    dst = null;
    delete creep.memory.deliveryTargetId;
    diag.urgentRetarget = true;
  }
  if (!urgentTargetExists && !preferredFeederActive) {
    diag.handoffBeforeStorage = true;
    if (tryTruckerEnergyHandoff(creep, diag)) return;
  } else {
    diag.handoffBeforeStorage = false;
  }
  if (!dst) dst = findLocalDeliverTarget(creep, diag);
  if (!dst) { clearDeliveryReservation(creep); return; }
  recordExistingDeliveryTarget(creep, diag, dst);

  var carried = creep.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
  var reservedAmount = reserveFill(creep, dst, carried, RESOURCE_ENERGY);
  if (reservedAmount <= 0) { clearDeliveryReservation(creep, dst); diag.lastDeliveryResult = 'no_effective_capacity'; return; }
  diag.deliveryTargetsReserved++; diag.lastDeliveryTargetId = dst.id; diag.lastReservedAmount = reservedAmount;

  var tr = creep.transfer(dst, RESOURCE_ENERGY);
  if (tr === ERR_NOT_IN_RANGE) { creep.travelTo(dst, { range: 1, reusePath: CFG.PATH_REUSE }); diag.lastDeliveryResult = 'moving'; return; }
  if (tr === OK || tr === ERR_FULL) { clearDeliveryReservation(creep, dst); diag.lastDeliveryResult = tr === OK ? 'ok' : 'full'; if (tr === ERR_FULL) delete creep.memory.deliveryTargetId; return; }
  if (tr === ERR_INVALID_TARGET || tr === ERR_NOT_OWNER || tr === ERR_NO_BODYPART) { clearDeliveryReservation(creep, dst); delete creep.memory.deliveryTargetId; diag.lastDeliveryResult = 'invalid'; return; }
  diag.lastDeliveryResult = 'code_' + tr;
}

function runRemote(creep, job) { /* same with release on completion handled in run */
  // Remote pickup mode claims a Luna-produced haul request, travels to the
  // container, withdraws energy, and leaves return/delivery to REMOTE_RETURN.
  var req = claimRemoteRequestForJob(creep, job);
  if (!req) { clearRemoteRequestAssignment(creep); Dispatcher.releaseJob(creep, job.id); delete creep.memory.dispatchJob; return; }
  if (!isActiveRemoteRequest(req, creep.memory.home)) {
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) { creep.memory.dispatchJob = { id: 'return:' + creep.name, type: 'REMOTE_RETURN', homeRoom: creep.memory.home }; return; }
    clearRemoteRequestAssignment(creep); Dispatcher.releaseJob(creep, job.id); delete creep.memory.dispatchJob; return;
  }
  var container = creep.memory.containerId ? Game.getObjectById(creep.memory.containerId) : null;
  var source = creep.memory.sourceId ? Game.getObjectById(creep.memory.sourceId) : null;
  if (source) drawHaulIntent(creep, source, '#4deeea');
  if (!container) {
    var loose = findRemoteLooseEnergy(creep, req, source, null);
    if (loose) {
      collectEnergyTarget(creep, loose);
      return;
    }
    var reqRoom = creep.memory.requestRoom, reqX = creep.memory.requestX, reqY = creep.memory.requestY;
    if (reqRoom && typeof reqX === 'number' && typeof reqY === 'number') {
      if (creep.room.name !== reqRoom) creep.travelTo(new RoomPosition(reqX, reqY, reqRoom), { range: 1, reusePath: CFG.PATH_REUSE });
      else { clearRemoteRequestAssignment(creep); Dispatcher.releaseJob(creep, job.id); delete creep.memory.dispatchJob; }
    }
    return;
  }
  if (creep.pos.roomName !== container.pos.roomName) { creep.travelTo(container, { range: 1, reusePath: CFG.PATH_REUSE }); return; }
  var looseEnergy = findRemoteLooseEnergy(creep, req, source, container);
  if (looseEnergy) {
    collectEnergyTarget(creep, looseEnergy);
    return;
  }
  var wr = creep.withdraw(container, RESOURCE_ENERGY);
  if (wr === ERR_NOT_IN_RANGE) creep.travelTo(container, { range: 1, reusePath: CFG.PATH_REUSE });
  if (wr === OK && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
    creep.memory.dispatchJob = { id: 'return:' + creep.name, type: 'REMOTE_RETURN', homeRoom: creep.memory.home };
  }
  if (wr === ERR_NOT_ENOUGH_RESOURCES) {
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
      creep.memory.dispatchJob = { id: 'return:' + creep.name, type: 'REMOTE_RETURN', homeRoom: creep.memory.home };
    } else {
      clearRemoteRequestAssignment(creep); Dispatcher.releaseJob(creep, job.id); delete creep.memory.dispatchJob;
    }
  }
}

function run(creep) {
  // Main Trucker state machine: normalize identity, pick/refresh dispatchJob,
  // prioritize returning carried remote energy, optionally hand off locally,
  // then execute remote pickup, remote return, or local hauling.
  if (creep.spawning) return;
  ensureIdentity(creep);
  var diag = ensureTruckerDiagnostics();
  diag.tick = Game.time; diag.deliveryTargetsSeen = 0; diag.deliveryTargetsReserved = 0; diag.skippedReservedCapacity = 0;
  diag.handoffRequestsSeen = 0; diag.handoffClaimed = false; diag.handoffTarget = null; diag.handoffResult = null; diag.handoffClearedReason = null;
  diag.handoffBeforeStorage = false; diag.lastDeliveryResult = null;
  diag.urgentRetarget = false;
  diag.deliveryMode = null; diag.deliverySinkId = null; diag.deliverySinkType = null; diag.deliveryFallbackReason = null;

  var active = creep.memory.dispatchJob || null;
  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0 && creep.room.name !== creep.memory.home) active = { type: 'REMOTE_RETURN', id: active ? active.id : ('return:' + creep.name) };
  if (!active) active = Dispatcher.chooseJobForTrucker(creep);
  creep.memory.dispatchJob = active;

  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) clearTruckerHandoff(creep, creep.room, 'empty_store', diag);
  else if (creep.memory.energyHandoffTarget && !hasUrgentLocalDeliveryTarget(creep)) {
    if (tryTruckerEnergyHandoff(creep, diag)) return;
  }

  if (!active) { if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) clearDeliveryReservation(creep); return; }
  if (active.type === 'REMOTE_PICKUP') return runRemote(creep, active);

  if (active.type === 'REMOTE_RETURN') {
    if (creep.room.name !== creep.memory.home) { creep.travelTo(new RoomPosition(25, 25, creep.memory.home), { range: 20, reusePath: CFG.PATH_REUSE }); return; }
    var sink = findLocalDeliverTarget(creep, diag) || creep.room.storage || creep.room.terminal;
    if (!sink) {
      if (tryTruckerEnergyHandoff(creep, diag)) return;
      return;
    }
    recordExistingDeliveryTarget(creep, diag, sink);
    var reserveAmt = reserveFill(creep, sink, creep.store.getUsedCapacity(RESOURCE_ENERGY), RESOURCE_ENERGY);
    if (reserveAmt <= 0) { clearDeliveryReservation(creep, sink); return; }
    var rc = creep.transfer(sink, RESOURCE_ENERGY);
    if (rc === ERR_NOT_IN_RANGE) creep.travelTo(sink, { range: 1, reusePath: CFG.PATH_REUSE });
    if (rc === OK || rc === ERR_FULL) clearDeliveryReservation(creep, sink);
    if (rc === OK && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) { clearRemoteRequestAssignment(creep); Dispatcher.releaseJob(creep, active.id); delete creep.memory.dispatchJob; }
    return;
  }

  runLocal(creep, active, diag);
  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0 && active.type === 'LOCAL_DELIVER') { clearDeliveryReservation(creep); delete creep.memory.dispatchJob; }
  if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0 && active.type === 'LOCAL_COLLECT') creep.memory.dispatchJob = { id: 'localDeliver:' + creep.memory.home, type: 'LOCAL_DELIVER', homeRoom: creep.memory.home };
}

module.exports = { run: run };
