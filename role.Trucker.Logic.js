'use strict';

var CFG = require('role.Trucker.Config');

function ensureHaulRoot() {
  if (!Memory.__BHM) Memory.__BHM = {};
  if (!Memory.__BHM.remoteHaulRequests) Memory.__BHM.remoteHaulRequests = {};
  return Memory.__BHM.remoteHaulRequests;
}

function ensureIdentity(creep) {
  creep.memory.role = 'Trucker';
  if (!creep.memory.task) creep.memory.task = 'haulRemote';
  if (!creep.memory.home) creep.memory.home = Memory.firstSpawnRoom || creep.room.name;
  if (!creep.memory.state) creep.memory.state = 'IDLE';
}

function isActiveRequest(r, homeName) {
  if (!r || !r.id || r.homeRoom !== homeName) return false;
  if (r.maintenanceUntil && r.maintenanceUntil > Game.time) return false;
  if ((r.amount || 0) < CFG.MIN_HAUL_REQUEST_ENERGY) return false;
  if ((Game.time - (r.updated || 0)) > CFG.REQUEST_STALE_TICKS) return false;
  return true;
}

function reserveRequest(creep, req) {
  req.assignedTo = creep.name;
  req.assignedUntil = Game.time + CFG.RESERVATION_TTL;
  creep.memory.requestId = req.id;
  creep.memory.containerId = req.containerId;
  creep.memory.sourceId = req.sourceId;
  creep.memory.requestRoom = req.roomName || req.remoteRoom || null;
  creep.memory.requestX = req.x;
  creep.memory.requestY = req.y;
  creep.memory.targetRoom = req.remoteRoom || req.roomName;
}

function pickRequest(creep) {
  var requests = ensureHaulRoot();
  var home = creep.memory.home;
  var best = null;
  for (var id in requests) {
    if (!requests.hasOwnProperty(id)) continue;
    var r = requests[id];
    if (!isActiveRequest(r, home)) continue;
    var reserved = r.assignedTo && r.assignedTo !== creep.name && (r.assignedUntil || 0) > Game.time;
    if (reserved) continue;
    if (!best || (r.urgent && !best.urgent) || (r.amount > best.amount)) best = r;
  }
  if (best) reserveRequest(creep, best);
  return best;
}

function clearAssignment(creep) {
  var requests = ensureHaulRoot();
  var id = creep.memory.requestId;
  if (id && requests[id] && requests[id].assignedTo === creep.name) {
    requests[id].assignedTo = null;
    requests[id].assignedUntil = 0;
  }
  delete creep.memory.requestId;
  delete creep.memory.containerId;
  delete creep.memory.sourceId;
  delete creep.memory.targetRoom;
  delete creep.memory.requestRoom;
  delete creep.memory.requestX;
  delete creep.memory.requestY;
}

function getAssignedRequest(creep) {
  if (!creep.memory.requestId) return null;
  var requests = ensureHaulRoot();
  return requests[creep.memory.requestId] || null;
}

function deliverTarget(creep) {
  var room = creep.room;
  if (CFG.DELIVERY_STORAGE_FIRST && room.storage && room.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) return room.storage;
  if (room.terminal && room.terminal.store.getFreeCapacity(RESOURCE_ENERGY) > 0) return room.terminal;
  var needy = room.find(FIND_STRUCTURES, { filter: function(s){
    if (!s.store) return false;
    if (s.structureType !== STRUCTURE_SPAWN && s.structureType !== STRUCTURE_EXTENSION && s.structureType !== STRUCTURE_TOWER) return false;
    return s.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
  }});
  if (needy.length) return creep.pos.findClosestByPath(needy);
  var conts = room.find(FIND_STRUCTURES, { filter: function(s){
    return s.structureType === STRUCTURE_CONTAINER && s.store && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
  }});
  return conts.length ? creep.pos.findClosestByPath(conts) : null;
}

function run(creep) {
  if (creep.spawning) return;
  ensureIdentity(creep);

  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0 && creep.memory.state === 'DELIVER') creep.memory.state = 'IDLE';
  if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) creep.memory.state = 'RETURN';

  var request = getAssignedRequest(creep);
  if (creep.memory.requestId && !request) {
    clearAssignment(creep);
    request = null;
  }

  if (!request && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
    request = pickRequest(creep);
  }

  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0 && (creep.memory.state === 'RETURN' || creep.memory.state === 'DELIVER' || creep.room.name === creep.memory.home)) {
    creep.memory.state = 'DELIVER';
    if (creep.room.name !== creep.memory.home) {
      creep.travelTo(new RoomPosition(25, 25, creep.memory.home), { range: 20, reusePath: CFG.PATH_REUSE });
      return;
    }
    var target = deliverTarget(creep);
    if (!target) return;
    var tr = creep.transfer(target, RESOURCE_ENERGY);
    if (tr === ERR_NOT_IN_RANGE) creep.travelTo(target, { reusePath: CFG.PATH_REUSE });
    if (tr === OK && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) clearAssignment(creep);
    return;
  }

  if (!request) {
    creep.memory.state = 'IDLE';
    var idlePos = (creep.room.storage && creep.room.storage.pos) || (creep.room.find(FIND_MY_SPAWNS)[0] && creep.room.find(FIND_MY_SPAWNS)[0].pos);
    if (idlePos) creep.travelTo(idlePos, { range: CFG.IDLE_RANGE, reusePath: CFG.PATH_REUSE });
    return;
  }

  if (!isActiveRequest(request, creep.memory.home)) {
    clearAssignment(creep);
    return;
  }

  var container = creep.memory.containerId ? Game.getObjectById(creep.memory.containerId) : null;

  if (!container) {
    var reqRoom = creep.memory.requestRoom || request.roomName || request.remoteRoom;
    var reqX = (typeof creep.memory.requestX === 'number') ? creep.memory.requestX : request.x;
    var reqY = (typeof creep.memory.requestY === 'number') ? creep.memory.requestY : request.y;
    if (reqRoom && typeof reqX === 'number' && typeof reqY === 'number' && creep.room.name !== reqRoom) {
      creep.memory.state = 'TO_REMOTE';
      creep.travelTo(new RoomPosition(reqX, reqY, reqRoom), { range: 1, reusePath: CFG.PATH_REUSE });
      return;
    }
    if (reqRoom && typeof reqX === 'number' && typeof reqY === 'number' && creep.room.name === reqRoom) {
      clearAssignment(creep);
      return;
    }
    clearAssignment(creep);
    return;
  }

  if (creep.pos.roomName !== container.pos.roomName) {
    creep.memory.state = 'TO_REMOTE';
    creep.travelTo(container, { range: 1, reusePath: CFG.PATH_REUSE });
    return;
  }

  creep.memory.state = 'WITHDRAW';
  var wr = creep.withdraw(container, RESOURCE_ENERGY);
  if (wr === ERR_NOT_IN_RANGE) {
    creep.travelTo(container, { range: 1, reusePath: CFG.PATH_REUSE });
    return;
  }

  if (wr === ERR_NOT_ENOUGH_RESOURCES) {
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
      creep.memory.state = 'RETURN';
    } else {
      clearAssignment(creep);
    }
    return;
  }

  if (wr === OK) {
    if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0 || (container.store[RESOURCE_ENERGY] || 0) < CFG.MIN_HAUL_REQUEST_ENERGY) {
      creep.memory.state = 'RETURN';
    }
  }
}

module.exports = { run: run };
