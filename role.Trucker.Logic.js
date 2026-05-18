'use strict';

var CFG = require('role.Trucker.Config');
var Dispatcher = require('Trucker.Dispatcher');
var Handoff = require('role.EnergyHandoff');

function ensureIdentity(creep) {
  creep.memory.role = 'Trucker';
  if (!creep.memory.task) creep.memory.task = 'haulUnified';
  if (!creep.memory.home) creep.memory.home = Memory.firstSpawnRoom || creep.room.name;
  if (!creep.memory.state) creep.memory.state = 'IDLE';
}

function ensureTruckerDiagnostics() {
  if (!Memory.__BHM) Memory.__BHM = {};
  if (!Memory.__BHM.truckerDispatch) Memory.__BHM.truckerDispatch = {};
  if (!Memory.__BHM.truckerDispatch.lastRun) Memory.__BHM.truckerDispatch.lastRun = {};
  return Memory.__BHM.truckerDispatch.lastRun;
}

function getQueenReservationMap() {
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


function clearTruckerHandoff(creep, room, reason, diag) {
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
  if (!req || !req.id || !homeName) return false;
  if (req.homeRoom !== homeName) return false;
  if (req.maintenanceUntil && req.maintenanceUntil > Game.time) return false;
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

function claimRemoteRequestForJob(creep, job) { /* unchanged */
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

function findLocalCollectTarget(creep) { /* unchanged */
  var room = creep.room;
  var drops = room.find(FIND_DROPPED_RESOURCES, { filter: function(r){ return r.resourceType === RESOURCE_ENERGY && r.amount >= 50; } }); if (drops.length) return creep.pos.findClosestByPath(drops);
  var graves = room.find(FIND_TOMBSTONES, { filter: function(t){ return t.store && (t.store[RESOURCE_ENERGY] || 0) > 0; } }); if (graves.length) return creep.pos.findClosestByPath(graves);
  var ruins = room.find(FIND_RUINS, { filter: function(t){ return t.store && (t.store[RESOURCE_ENERGY] || 0) > 0; } }); if (ruins.length) return creep.pos.findClosestByPath(ruins);
  var containers = room.find(FIND_STRUCTURES, { filter: function(s){ return s.structureType === STRUCTURE_CONTAINER && s.store && (s.store[RESOURCE_ENERGY] || 0) >= 50; } }); if (containers.length) return creep.pos.findClosestByPath(containers);
  if (room.storage && (room.storage.store[RESOURCE_ENERGY] || 0) > 0) return room.storage;
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
  var spExt = room.find(FIND_STRUCTURES, { filter: function(s){ return (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) && s.store; } });
  var target = pickClosestWithEffectiveFree(creep, spExt, diag);
  if (target) return target;

  var towers = room.find(FIND_STRUCTURES, { filter: function(s){ if (s.structureType !== STRUCTURE_TOWER || !s.store) return false; var cap = s.store.getCapacity(RESOURCE_ENERGY) || 0; if (cap <= 0) return false; return (s.store[RESOURCE_ENERGY] || 0) < Math.floor(cap * CFG.TOWER_REFILL_AT_OR_BELOW); } });
  target = pickClosestWithEffectiveFree(creep, towers, diag);
  if (target) return target;

  if (room.storage && getEffectiveFreeCapacity(room.storage, RESOURCE_ENERGY) > 0) { diag.deliveryTargetsSeen++; return room.storage; }
  if (room.storage) { diag.deliveryTargetsSeen++; diag.skippedReservedCapacity++; }
  if (room.terminal && getEffectiveFreeCapacity(room.terminal, RESOURCE_ENERGY) > 0) { diag.deliveryTargetsSeen++; return room.terminal; }
  if (room.terminal) { diag.deliveryTargetsSeen++; diag.skippedReservedCapacity++; }
  return null;
}

function runLocal(creep, job, diag) {
  if (creep.room.name !== creep.memory.home) { creep.travelTo(new RoomPosition(25, 25, creep.memory.home), { range: 20, reusePath: CFG.PATH_REUSE }); return; }
  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) clearDeliveryReservation(creep);

  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0 && hasUrgentLocalDeliveryTarget(creep)) { creep.memory.dispatchJob = { id: 'localDeliver:' + creep.memory.home, type: 'LOCAL_DELIVER', homeRoom: creep.memory.home }; }

  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0 || job.type === 'LOCAL_COLLECT') {
    var src = findLocalCollectTarget(creep);
    if (!src) { if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) creep.memory.dispatchJob = { id: 'localDeliver:' + creep.memory.home, type: 'LOCAL_DELIVER', homeRoom: creep.memory.home }; return; }
    var pr = src.amount ? creep.pickup(src) : creep.withdraw(src, RESOURCE_ENERGY);
    if (pr === ERR_NOT_IN_RANGE) creep.travelTo(src, { range: 1, reusePath: CFG.PATH_REUSE });
    return;
  }

  var urgentTargetExists = hasUrgentLocalDeliveryTarget(creep);
  var dst = creep.memory.deliveryTargetId ? Game.getObjectById(creep.memory.deliveryTargetId) : null;
  if (!urgentTargetExists) {
    diag.handoffBeforeStorage = true;
    if (tryTruckerEnergyHandoff(creep, diag)) return;
  } else {
    diag.handoffBeforeStorage = false;
  }
  if (!dst) dst = findLocalDeliverTarget(creep, diag);
  if (!dst) { clearDeliveryReservation(creep); return; }

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
  var req = claimRemoteRequestForJob(creep, job);
  if (!req) { clearRemoteRequestAssignment(creep); Dispatcher.releaseJob(creep, job.id); delete creep.memory.dispatchJob; return; }
  if (!isActiveRemoteRequest(req, creep.memory.home)) {
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) { creep.memory.dispatchJob = { id: 'return:' + creep.name, type: 'REMOTE_RETURN', homeRoom: creep.memory.home }; return; }
    clearRemoteRequestAssignment(creep); Dispatcher.releaseJob(creep, job.id); delete creep.memory.dispatchJob; return;
  }
  var container = creep.memory.containerId ? Game.getObjectById(creep.memory.containerId) : null;
  if (!container) {
    var reqRoom = creep.memory.requestRoom, reqX = creep.memory.requestX, reqY = creep.memory.requestY;
    if (reqRoom && typeof reqX === 'number' && typeof reqY === 'number') {
      if (creep.room.name !== reqRoom) creep.travelTo(new RoomPosition(reqX, reqY, reqRoom), { range: 1, reusePath: CFG.PATH_REUSE });
      else { clearRemoteRequestAssignment(creep); Dispatcher.releaseJob(creep, job.id); delete creep.memory.dispatchJob; }
    }
    return;
  }
  if (creep.pos.roomName !== container.pos.roomName) { creep.travelTo(container, { range: 1, reusePath: CFG.PATH_REUSE }); return; }
  var wr = creep.withdraw(container, RESOURCE_ENERGY);
  if (wr === ERR_NOT_IN_RANGE) creep.travelTo(container, { range: 1, reusePath: CFG.PATH_REUSE });
  if (wr === ERR_NOT_ENOUGH_RESOURCES && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) { clearRemoteRequestAssignment(creep); Dispatcher.releaseJob(creep, job.id); delete creep.memory.dispatchJob; }
}

function run(creep) {
  if (creep.spawning) return;
  ensureIdentity(creep);
  var diag = ensureTruckerDiagnostics();
  diag.tick = Game.time; diag.deliveryTargetsSeen = 0; diag.deliveryTargetsReserved = 0; diag.skippedReservedCapacity = 0;
  diag.handoffRequestsSeen = 0; diag.handoffClaimed = false; diag.handoffTarget = null; diag.handoffResult = null; diag.handoffClearedReason = null;
  diag.handoffBeforeStorage = false; diag.lastDeliveryResult = null;

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
