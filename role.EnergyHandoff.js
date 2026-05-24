'use strict';

var MemoryUtils = require('core.memory');

var HANDOFF = Object.freeze({
  HANDOFF_ENABLED: true,
  HANDOFF_REQUEST_TTL: 25,
  HANDOFF_ASSIGN_TTL: 40,
  HANDOFF_WAIT_TTL: 10,
  HANDOFF_MIN_HAULER_ENERGY: 25,
  HANDOFF_MIN_RECEIVER_FREE: 25,
  HANDOFF_MAX_RANGE: 30,
  HANDOFF_MAX_FAILS: 3,
  HANDOFF_DEBUG_SAY: false
});

function ensureRoomMemory(room) {
  if (!room || !room.name) return null;
  var roomMem = MemoryUtils.ensureRoom(room.name);
  if (!roomMem.energyHandoffs) roomMem.energyHandoffs = { requests: {} };
  if (!roomMem.energyHandoffs.requests) roomMem.energyHandoffs.requests = {};
  return roomMem.energyHandoffs;
}

function trackMigration(roomName, reqMoved, creepMoved) {
  if (!reqMoved && !creepMoved) return;
  if (!Memory.__BHM) Memory.__BHM = {};
  var diag = Memory.__BHM.handoffSchemaMigration || { tick: Game.time, migratedRequests: 0, migratedCreepMemory: 0, lastRoom: roomName || null };
  diag.tick = Game.time;
  diag.migratedRequests = (diag.migratedRequests || 0) + (reqMoved || 0);
  diag.migratedCreepMemory = (diag.migratedCreepMemory || 0) + (creepMoved || 0);
  diag.lastRoom = roomName || diag.lastRoom || null;
  Memory.__BHM.handoffSchemaMigration = diag;
}

function migrateHandoffRequestSchema(req, roomName) {
  if (!req) return 0;
  if (!req.assignedHaulerName && req.assignedCourierName) {
    req.assignedHaulerName = req.assignedCourierName;
    delete req.assignedCourierName;
    trackMigration(roomName, 1, 0);
    return 1;
  }
  if (req.assignedCourierName) delete req.assignedCourierName;
  return 0;
}

function migrateCreepHandoffMemory(creep) {
  if (!creep || !creep.memory) return 0;
  if (!creep.memory.energyHandoffHauler && creep.memory.energyHandoffCourier) {
    creep.memory.energyHandoffHauler = creep.memory.energyHandoffCourier;
    delete creep.memory.energyHandoffCourier;
    trackMigration(creep.room && creep.room.name, 0, 1);
    return 1;
  }
  if (creep.memory.energyHandoffCourier) delete creep.memory.energyHandoffCourier;
  return 0;
}

function getAssignedHaulerName(req) {
  if (!req) return null;
  if (req.assignedHaulerName) return req.assignedHaulerName;
  if (req.assignedCourierName) return req.assignedCourierName;
  return null;
}

function setAssignedHaulerName(req, haulerName) {
  if (!req) return;
  req.assignedHaulerName = haulerName || null;
  if (req.assignedCourierName) delete req.assignedCourierName;
}

function clearAssignedHauler(req) {
  if (!req) return;
  req.assignedHaulerName = null;
  req.assignedAt = null;
  req.waitUntil = null;
  if (req.assignedCourierName) delete req.assignedCourierName;
}

function clearAssignmentOnHauler(name) {
  var c = Game.creeps[name];
  if (!c || !c.memory) return;
  c.memory.energyHandoffTarget = null;
  c.memory.energyHandoffFailCount = 0;
}

function cleanupEnergyHandoffRequests(room) {
  var mem = ensureRoomMemory(room); if (!mem) return;
  var reqs = mem.requests || {};
  var names = Object.keys(reqs);
  for (var i = 0; i < names.length; i++) {
    var name = names[i]; var req = reqs[name];
    migrateHandoffRequestSchema(req, room.name);
    var receiver = Game.creeps[name];
    var expired = !req || req.expiresAt <= Game.time;
    var badReceiver = !receiver || receiver.spawning || !receiver.my || receiver.pos.roomName !== room.name;
    if (expired || badReceiver) {
      var assigned = getAssignedHaulerName(req);
      if (assigned) clearAssignmentOnHauler(assigned);
      delete reqs[name];
      if (receiver && receiver.memory) { receiver.memory.energyHandoffRequest = null; receiver.memory.energyHandoffHauler = null; delete receiver.memory.energyHandoffCourier; }
      continue;
    }
    migrateCreepHandoffMemory(receiver);
    var assignedHauler = getAssignedHaulerName(req);
    if (assignedHauler) {
      var hauler = Game.creeps[assignedHauler];
      if (!hauler || !hauler.my || req.assignedAt + HANDOFF.HANDOFF_ASSIGN_TTL <= Game.time) {
        if (hauler && hauler.memory) clearAssignmentOnHauler(hauler.name);
        clearAssignedHauler(req);
        if (receiver && receiver.memory) { receiver.memory.energyHandoffHauler = null; delete receiver.memory.energyHandoffCourier; }
      }
    }
  }
}

function clearEnergyHandoffRequest(creep) {
  if (!creep || !creep.room) return;
  var mem = ensureRoomMemory(creep.room); if (!mem) return;
  var req = mem.requests[creep.name];
  migrateHandoffRequestSchema(req, creep.room.name);
  var assigned = getAssignedHaulerName(req);
  if (assigned) clearAssignmentOnHauler(assigned);
  delete mem.requests[creep.name];
  creep.memory.energyHandoffRequest = null;
  creep.memory.energyHandoffHauler = null;
  delete creep.memory.energyHandoffCourier;
}

function publishEnergyHandoffRequest(creep, roleName, jobTarget, amountWanted) {
  if (!HANDOFF.HANDOFF_ENABLED || !creep || !creep.room) return null;
  var mem = ensureRoomMemory(creep.room); if (!mem) return null;
  cleanupEnergyHandoffRequests(creep.room);
  var free = creep.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
  var wanted = Math.max(0, Math.min(amountWanted || free, free));
  if (wanted < HANDOFF.HANDOFF_MIN_RECEIVER_FREE) return null;
  var existing = mem.requests[creep.name] || {};
  migrateHandoffRequestSchema(existing, creep.room.name);
  migrateCreepHandoffMemory(creep);
  var req = {
    receiverName: creep.name,
    receiverRole: roleName,
    roomName: creep.room.name,
    amountWanted: wanted,
    freeCapacity: free,
    requestedAt: existing.requestedAt || Game.time,
    expiresAt: Game.time + HANDOFF.HANDOFF_REQUEST_TTL,
    assignedHaulerName: getAssignedHaulerName(existing) || null,
    assignedAt: existing.assignedAt || null,
    jobTargetId: jobTarget ? jobTarget.id : null,
    jobTargetType: jobTarget ? (jobTarget.structureType || 'work') : null,
    waitUntil: existing.waitUntil || null
  };
  mem.requests[creep.name] = req;
  creep.memory.energyHandoffRequest = true;
  creep.memory.energyHandoffHauler = req.assignedHaulerName;
  delete creep.memory.energyHandoffCourier;
  return req;
}

module.exports = {
  HANDOFF: HANDOFF,
  ensureHandoffMemory: ensureRoomMemory,
  cleanupEnergyHandoffRequests: cleanupEnergyHandoffRequests,
  clearEnergyHandoffRequest: clearEnergyHandoffRequest,
  publishEnergyHandoffRequest: publishEnergyHandoffRequest,
  migrateHandoffRequestSchema: migrateHandoffRequestSchema,
  migrateCreepHandoffMemory: migrateCreepHandoffMemory,
  getAssignedHaulerName: getAssignedHaulerName,
  setAssignedHaulerName: setAssignedHaulerName,
  clearAssignedHauler: clearAssignedHauler
};
