'use strict';

var CFG = require('role.Trucker.Config');
var Dispatcher = require('Trucker.Dispatcher');

function ensureIdentity(creep) {
  creep.memory.role = 'Trucker';
  if (!creep.memory.task) creep.memory.task = 'haulUnified';
  if (!creep.memory.home) creep.memory.home = Memory.firstSpawnRoom || creep.room.name;
  if (!creep.memory.state) creep.memory.state = 'IDLE';
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


function isActiveRemoteRequest(req, homeName) {
  if (!req || !req.id || !homeName) return false;
  if (req.homeRoom !== homeName) return false;
  if (req.maintenanceUntil && req.maintenanceUntil > Game.time) return false;
  if ((req.amount || 0) < CFG.MIN_HAUL_REQUEST_ENERGY) return false;
  if ((Game.time - (req.updated || 0)) > CFG.REQUEST_STALE_TICKS) return false;
  return true;
}

function hasUrgentLocalDeliveryTarget(creep) {
  if (!creep || !creep.room) return false;
  var room = creep.room;
  var spExt = room.find(FIND_STRUCTURES, { filter: function(s){ return (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) && s.store && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0; } });
  if (spExt.length > 0) return true;
  var towers = room.find(FIND_STRUCTURES, { filter: function(s){ if (s.structureType !== STRUCTURE_TOWER || !s.store) return false; var cap = s.store.getCapacity(RESOURCE_ENERGY) || 0; if (cap <= 0) return false; var cur = s.store[RESOURCE_ENERGY] || 0; return cur < Math.floor(cap * 0.7); } });
  return towers.length > 0;
}

function claimRemoteRequestForJob(creep, job) {
  var reqs = (Memory.__BHM && Memory.__BHM.remoteHaulRequests) || {};
  var req = reqs[job.requestId];
  if (!req) return null;
  req.assignedTo = creep.name;
  req.assignedUntil = Game.time + CFG.RESERVATION_TTL;
  creep.memory.requestId = job.requestId;
  creep.memory.containerId = req.containerId || job.containerId;
  creep.memory.sourceId = req.sourceId || job.sourceId;
  creep.memory.requestRoom = req.roomName || req.remoteRoom || job.roomName || null;
  creep.memory.requestX = (typeof req.x === 'number') ? req.x : job.x;
  creep.memory.requestY = (typeof req.y === 'number') ? req.y : job.y;
  creep.memory.targetRoom = creep.memory.requestRoom;
  return req;
}

function findLocalCollectTarget(creep) {
  var room = creep.room;
  var drops = room.find(FIND_DROPPED_RESOURCES, { filter: function(r){ return r.resourceType === RESOURCE_ENERGY && r.amount >= 50; } });
  if (drops.length) return creep.pos.findClosestByPath(drops);
  var graves = room.find(FIND_TOMBSTONES, { filter: function(t){ return t.store && (t.store[RESOURCE_ENERGY] || 0) > 0; } });
  if (graves.length) return creep.pos.findClosestByPath(graves);
  var ruins = room.find(FIND_RUINS, { filter: function(t){ return t.store && (t.store[RESOURCE_ENERGY] || 0) > 0; } });
  if (ruins.length) return creep.pos.findClosestByPath(ruins);
  var containers = room.find(FIND_STRUCTURES, { filter: function(s){ return s.structureType === STRUCTURE_CONTAINER && s.store && (s.store[RESOURCE_ENERGY] || 0) >= 50; } });
  if (containers.length) return creep.pos.findClosestByPath(containers);
  if (room.storage && (room.storage.store[RESOURCE_ENERGY] || 0) > 0) return room.storage;
  if (room.terminal && (room.terminal.store[RESOURCE_ENERGY] || 0) > 0) return room.terminal;
  return null;
}

function findLocalDeliverTarget(creep) {
  var room = creep.room;
  var spExt = room.find(FIND_STRUCTURES, { filter: function(s){ return (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) && s.store && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0; } });
  if (spExt.length) return creep.pos.findClosestByPath(spExt);
  var towers = room.find(FIND_STRUCTURES, { filter: function(s){ return s.structureType === STRUCTURE_TOWER && s.store && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0; } });
  if (towers.length) return creep.pos.findClosestByPath(towers);
  if (room.storage && room.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) return room.storage;
  if (room.terminal && room.terminal.store.getFreeCapacity(RESOURCE_ENERGY) > 0) return room.terminal;
  return null;
}

function runLocal(creep, job) {
  if (creep.room.name !== creep.memory.home) {
    creep.travelTo(new RoomPosition(25, 25, creep.memory.home), { range: 20, reusePath: CFG.PATH_REUSE });
    return;
  }
  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0 && hasUrgentLocalDeliveryTarget(creep)) {
    creep.memory.dispatchJob = { id: 'localDeliver:' + creep.memory.home, type: 'LOCAL_DELIVER', homeRoom: creep.memory.home };
    return;
  }
  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0 || job.type === 'LOCAL_COLLECT') {
    var src = findLocalCollectTarget(creep);
    if (!src) {
      if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) creep.memory.dispatchJob = { id: 'localDeliver:' + creep.memory.home, type: 'LOCAL_DELIVER', homeRoom: creep.memory.home };
      return;
    }
    var pr = src.amount ? creep.pickup(src) : creep.withdraw(src, RESOURCE_ENERGY);
    if (pr === ERR_NOT_IN_RANGE) creep.travelTo(src, { range: 1, reusePath: CFG.PATH_REUSE });
    return;
  }
  var dst = findLocalDeliverTarget(creep);
  if (!dst) return;
  var tr = creep.transfer(dst, RESOURCE_ENERGY);
  if (tr === ERR_NOT_IN_RANGE) creep.travelTo(dst, { range: 1, reusePath: CFG.PATH_REUSE });
}

function runRemote(creep, job) {
  var req = claimRemoteRequestForJob(creep, job);
  if (!req) {
    clearRemoteRequestAssignment(creep);
    Dispatcher.releaseJob(creep, job.id);
    delete creep.memory.dispatchJob;
    return;
  }

  if (!isActiveRemoteRequest(req, creep.memory.home)) {
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
      creep.memory.dispatchJob = { id: 'return:' + creep.name, type: 'REMOTE_RETURN', homeRoom: creep.memory.home };
      return;
    }
    clearRemoteRequestAssignment(creep);
    Dispatcher.releaseJob(creep, job.id);
    delete creep.memory.dispatchJob;
    return;
  }

  var container = creep.memory.containerId ? Game.getObjectById(creep.memory.containerId) : null;
  if (!container) {
    var reqRoom = creep.memory.requestRoom;
    var reqX = creep.memory.requestX;
    var reqY = creep.memory.requestY;
    if (reqRoom && typeof reqX === 'number' && typeof reqY === 'number') {
      if (creep.room.name !== reqRoom) creep.travelTo(new RoomPosition(reqX, reqY, reqRoom), { range: 1, reusePath: CFG.PATH_REUSE });
      else { clearRemoteRequestAssignment(creep); Dispatcher.releaseJob(creep, job.id); }
    }
    return;
  }

  if (creep.pos.roomName !== container.pos.roomName) {
    creep.travelTo(container, { range: 1, reusePath: CFG.PATH_REUSE });
    return;
  }

  var wr = creep.withdraw(container, RESOURCE_ENERGY);
  if (wr === ERR_NOT_IN_RANGE) creep.travelTo(container, { range: 1, reusePath: CFG.PATH_REUSE });
  if (wr === ERR_NOT_ENOUGH_RESOURCES && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
    clearRemoteRequestAssignment(creep); Dispatcher.releaseJob(creep, job.id);
  }
}

function run(creep) {
  if (creep.spawning) return;
  ensureIdentity(creep);

  var active = creep.memory.dispatchJob || null;
  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0 && creep.room.name !== creep.memory.home) {
    active = { type: 'REMOTE_RETURN', id: active ? active.id : ('return:' + creep.name) };
  }
  if (!active) active = Dispatcher.chooseJobForTrucker(creep);
  creep.memory.dispatchJob = active;

  if (!active) return;

  if (active.type === 'REMOTE_PICKUP') return runRemote(creep, active);

  if (active.type === 'REMOTE_RETURN') {
    if (creep.room.name !== creep.memory.home) {
      creep.travelTo(new RoomPosition(25, 25, creep.memory.home), { range: 20, reusePath: CFG.PATH_REUSE });
      return;
    }
    var sink = findLocalDeliverTarget(creep) || creep.room.storage || creep.room.terminal;
    if (!sink) return;
    var rc = creep.transfer(sink, RESOURCE_ENERGY);
    if (rc === ERR_NOT_IN_RANGE) creep.travelTo(sink, { range: 1, reusePath: CFG.PATH_REUSE });
    if (rc === OK && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
      clearRemoteRequestAssignment(creep);
      Dispatcher.releaseJob(creep, active.id);
      delete creep.memory.dispatchJob;
    }
    return;
  }

  runLocal(creep, active);
  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0 && active.type === 'LOCAL_DELIVER') delete creep.memory.dispatchJob;
  if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0 && active.type === 'LOCAL_COLLECT') creep.memory.dispatchJob = { id: 'localDeliver:' + creep.memory.home, type: 'LOCAL_DELIVER', homeRoom: creep.memory.home };
}

module.exports = { run: run };
