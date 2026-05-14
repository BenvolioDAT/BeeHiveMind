'use strict';

var HANDOFF = Object.freeze({
  HANDOFF_ENABLED: true,
  HANDOFF_REQUEST_TTL: 25,
  HANDOFF_ASSIGN_TTL: 40,
  HANDOFF_WAIT_TTL: 10,
  HANDOFF_MIN_COURIER_ENERGY: 25,
  HANDOFF_MIN_RECEIVER_FREE: 25,
  HANDOFF_MAX_RANGE: 30,
  HANDOFF_MAX_FAILS: 3,
  HANDOFF_DEBUG_SAY: false
});

function ensureRoomMemory(room) {
  if (!room || !room.name) return null;
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};
  if (!Memory.rooms[room.name].energyHandoffs) Memory.rooms[room.name].energyHandoffs = { requests: {} };
  if (!Memory.rooms[room.name].energyHandoffs.requests) Memory.rooms[room.name].energyHandoffs.requests = {};
  return Memory.rooms[room.name].energyHandoffs;
}

function clearAssignmentOnCourier(name) {
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
    var receiver = Game.creeps[name];
    var expired = !req || req.expiresAt <= Game.time;
    var badReceiver = !receiver || receiver.spawning || !receiver.my || receiver.pos.roomName !== room.name;
    if (expired || badReceiver) {
      if (req && req.assignedCourierName) clearAssignmentOnCourier(req.assignedCourierName);
      delete reqs[name];
      if (receiver && receiver.memory) { receiver.memory.energyHandoffRequest = null; receiver.memory.energyHandoffCourier = null; }
      continue;
    }
    if (req.assignedCourierName) {
      var courier = Game.creeps[req.assignedCourierName];
      if (!courier || !courier.my || req.assignedAt + HANDOFF.HANDOFF_ASSIGN_TTL <= Game.time) {
        if (courier && courier.memory) clearAssignmentOnCourier(courier.name);
        req.assignedCourierName = null; req.assignedAt = null; req.waitUntil = null;
        if (receiver && receiver.memory) receiver.memory.energyHandoffCourier = null;
      }
    }
  }
}

function clearEnergyHandoffRequest(creep) {
  if (!creep || !creep.room) return;
  var mem = ensureRoomMemory(creep.room); if (!mem) return;
  var req = mem.requests[creep.name];
  if (req && req.assignedCourierName) clearAssignmentOnCourier(req.assignedCourierName);
  delete mem.requests[creep.name];
  creep.memory.energyHandoffRequest = null;
  creep.memory.energyHandoffCourier = null;
}

function publishEnergyHandoffRequest(creep, roleName, jobTarget, amountWanted) {
  if (!HANDOFF.HANDOFF_ENABLED || !creep || !creep.room) return null;
  var mem = ensureRoomMemory(creep.room); if (!mem) return null;
  cleanupEnergyHandoffRequests(creep.room);
  var free = creep.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
  var wanted = Math.max(0, Math.min(amountWanted || free, free));
  if (wanted < HANDOFF.HANDOFF_MIN_RECEIVER_FREE) return null;
  var existing = mem.requests[creep.name] || {};
  var req = {
    receiverName: creep.name,
    receiverRole: roleName,
    roomName: creep.room.name,
    amountWanted: wanted,
    freeCapacity: free,
    requestedAt: existing.requestedAt || Game.time,
    expiresAt: Game.time + HANDOFF.HANDOFF_REQUEST_TTL,
    assignedCourierName: existing.assignedCourierName || null,
    assignedAt: existing.assignedAt || null,
    jobTargetId: jobTarget ? jobTarget.id : null,
    jobTargetType: jobTarget ? (jobTarget.structureType || 'work') : null,
    waitUntil: existing.waitUntil || null
  };
  mem.requests[creep.name] = req;
  creep.memory.energyHandoffRequest = true;
  creep.memory.energyHandoffCourier = req.assignedCourierName;
  return req;
}

module.exports = {
  HANDOFF: HANDOFF,
  ensureHandoffMemory: ensureRoomMemory,
  cleanupEnergyHandoffRequests: cleanupEnergyHandoffRequests,
  clearEnergyHandoffRequest: clearEnergyHandoffRequest,
  publishEnergyHandoffRequest: publishEnergyHandoffRequest
};
