'use strict';

// Remote Veinseeker behavior is deliberately source-bound. The creep does not
// search rooms for work; SourceEnergy.Manager must give it sourceId+targetRoom.

var CFG = require('role.Veinseeker.Config');
var BeeToolbox = require('BeeToolbox');
var SourceEnergyManager = require('SourceEnergy.Manager');
var SourceWorkerManager = require('SourceWorker.Manager');

var REPAIR_START = (typeof CFG.remoteContainerRepairStartPct === 'number') ? CFG.remoteContainerRepairStartPct : 0.50;
var REPAIR_STOP = (typeof CFG.remoteContainerRepairStopPct === 'number') ? CFG.remoteContainerRepairStopPct : 0.85;
var UNASSIGNED_SUICIDE_TICKS = Math.min(50, Math.max(5, CFG.VEINSEEKER_UNASSIGNED_SUICIDE_TICKS || 25));

function debugSay(creep, text) {
  BeeToolbox.sayIfDebugEnabled(creep, text, CFG.DEBUG_SAY);
}

function debugOptions() {
  return {
    enabled: CFG.DEBUG_DRAW,
    width: CFG.DRAW.WIDTH,
    opacity: CFG.DRAW.OPACITY,
    font: CFG.DRAW.FONT
  };
}

function debugLine(creep, target, color, label) {
  BeeToolbox.drawDebugLine(creep, target, color, label, debugOptions());
}

function debugRing(room, pos, color, label) {
  BeeToolbox.drawDebugRing(room, pos, color, label, debugOptions());
}

function getHomeName(creep) {
  if (!creep || !creep.memory) return null;
  return creep.memory.home || creep.memory._home || (creep.room && creep.room.name) || null;
}

function getAssignedSourceId(creep) {
  return SourceWorkerManager.getSourceIdFromMemory(creep && creep.memory);
}

function setBadAssignment(creep, reason) {
  if (!creep || !creep.memory) return;
  if (!creep.memory.remoteBadAssignSince) creep.memory.remoteBadAssignSince = Game.time;
  creep.memory.remoteBadAssignReason = reason || 'bad-assignment';
  debugSay(creep, 'BAD');
}

function clearBadAssignment(creep) {
  if (!creep || !creep.memory) return;
  delete creep.memory.remoteBadAssignSince;
  delete creep.memory.remoteBadAssignReason;
}

function clearAssignmentMemory(creep) {
  delete creep.memory.sourceId;
  delete creep.memory.assignedSource;
  delete creep.memory.targetRoom;
  delete creep.memory.roomName;
  delete creep.memory.containerId;
  delete creep.memory.assignedContainer;
  delete creep.memory.seatX;
  delete creep.memory.seatY;
  delete creep.memory.seatRoom;
  delete creep.memory.planX;
  delete creep.memory.planY;
}

function releaseAssignment(creep, reason) {
  SourceEnergyManager.releaseSource(creep, reason);
  clearAssignmentMemory(creep);
  setBadAssignment(creep, reason);
}

function recycleBadRemote(creep, reason) {
  setBadAssignment(creep, reason);
  var since = creep.memory.remoteBadAssignSince || Game.time;
  if ((Game.time - since) >= UNASSIGNED_SUICIDE_TICKS) {
    creep.suicide();
    return true;
  }
  if (creep.room && getHomeName(creep) && creep.room.name !== getHomeName(creep)) {
    debugSay(creep, 'TRAVEL');
    creep.travelTo(new RoomPosition(25, 25, getHomeName(creep)), { range: 20, reusePath: CFG.TRAVEL_REUSE });
    return true;
  }
  debugSay(creep, 'IDLE');
  return true;
}

function ensureIdentity(creep) {
  if (!creep || !creep.memory) return;
  creep.memory.role = 'Veinseeker';
  creep.memory.task = 'veinseeker';
  creep.memory.mode = 'remote';
}

function getPlanRecord(creep) {
  var home = getHomeName(creep);
  var sourceId = getAssignedSourceId(creep);
  if (!home || !sourceId) return null;
  return SourceEnergyManager.getSourceRecord(home, sourceId);
}

function tryPlanAssignment(creep) {
  if (getAssignedSourceId(creep) && creep.memory.targetRoom) return true;
  var assigned = SourceEnergyManager.assignIdleRemoteVeinseeker(creep);
  return !!assigned;
}

function validateAssignment(creep) {
  ensureIdentity(creep);

  if (!tryPlanAssignment(creep)) {
    return recycleBadRemote(creep, 'no-active-source-plan');
  }

  var sourceId = getAssignedSourceId(creep);
  var targetRoom = creep.memory.targetRoom || creep.memory.roomName;
  if (!sourceId || !targetRoom) {
    releaseAssignment(creep, 'missing-source-or-target');
    return recycleBadRemote(creep, 'missing-source-or-target');
  }

  var rec = getPlanRecord(creep);
  if (!rec || !rec.active || rec.mode !== 'remote') {
    releaseAssignment(creep, rec ? (rec.reason || 'source-inactive') : 'source-not-in-plan');
    return recycleBadRemote(creep, rec ? (rec.reason || 'source-inactive') : 'source-not-in-plan');
  }

  if (rec.targetRoom && targetRoom !== rec.targetRoom) {
    releaseAssignment(creep, 'source-target-mismatch');
    return recycleBadRemote(creep, 'source-target-mismatch');
  }

  if (SourceEnergyManager.isRemoteUnsafe(targetRoom)) {
    releaseAssignment(creep, 'unsafe-room');
    debugSay(creep, 'SAFE');
    return true;
  }

  creep.memory.home = rec.homeRoom;
  creep.memory.targetRoom = rec.targetRoom;
  creep.memory.roomName = rec.targetRoom;
  creep.memory.sourceId = rec.sourceId;
  creep.memory.assignedSource = rec.sourceId;
  SourceEnergyManager.claimSource(creep, rec.sourceId, rec.targetRoom);
  clearBadAssignment(creep);
  return false;
}

function makeKnownSourcePosition(creep, rec) {
  if (!rec || typeof rec.x !== 'number' || typeof rec.y !== 'number') return null;
  return new RoomPosition(rec.x, rec.y, rec.targetRoom || rec.roomName || creep.memory.targetRoom);
}

function travelToAssignedRoom(creep, rec) {
  var targetRoom = creep.memory.targetRoom || (rec && rec.targetRoom);
  if (!targetRoom) return false;
  if (creep.room.name === targetRoom) return false;
  var targetPos = makeKnownSourcePosition(creep, rec) || new RoomPosition(25, 25, targetRoom);
  debugSay(creep, 'TRAVEL');
  debugLine(creep, { pos: targetPos }, CFG.DRAW.TRAVEL_COLOR, 'SRC');
  creep.travelTo(targetPos, { range: 1, reusePath: CFG.TRAVEL_REUSE });
  return true;
}

function rememberSeat(creep, pos) {
  if (!creep || !creep.memory || !pos) return;
  creep.memory.seatX = pos.x;
  creep.memory.seatY = pos.y;
  creep.memory.seatRoom = pos.roomName;
}

function getRememberedSeat(creep) {
  if (!creep || !creep.memory) return null;
  if (typeof creep.memory.seatX !== 'number' || typeof creep.memory.seatY !== 'number' || !creep.memory.seatRoom) return null;
  return new RoomPosition(creep.memory.seatX, creep.memory.seatY, creep.memory.seatRoom);
}

function seatBelongsToSource(pos, source) {
  if (!pos || !source) return false;
  if (pos.roomName !== source.pos.roomName) return false;
  return pos.getRangeTo(source.pos) <= 1 && SourceWorkerManager.isWalkable(pos);
}

function chooseMiningSeat(creep, source, anchorPos) {
  var remembered = getRememberedSeat(creep);
  if (seatBelongsToSource(remembered, source)) return remembered;

  if (anchorPos && seatBelongsToSource(anchorPos, source)) {
    rememberSeat(creep, anchorPos);
    return anchorPos;
  }

  var preferred = SourceWorkerManager.getPreferredSeatPos(source);
  if (seatBelongsToSource(preferred, source)) {
    rememberSeat(creep, preferred);
    return preferred;
  }

  var seats = SourceWorkerManager.buildHarvestSeatList(source);
  if (seats.length) {
    rememberSeat(creep, seats[0]);
    return seats[0];
  }
  return null;
}

function updateVisibleSourceMemory(source) {
  if (!source || !source.pos) return;
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[source.pos.roomName]) Memory.rooms[source.pos.roomName] = {};
  var roomMem = Memory.rooms[source.pos.roomName];
  if (!roomMem.sources) roomMem.sources = {};
  if (!roomMem.sources[source.id]) roomMem.sources[source.id] = {};
  roomMem.sources[source.id].x = source.pos.x;
  roomMem.sources[source.id].y = source.pos.y;
  roomMem.sources[source.id].roomName = source.pos.roomName;
  roomMem.sources[source.id].lastSeen = Game.time;
  roomMem.sources[source.id].openTiles = SourceWorkerManager.countOpenHarvestTiles(source);
  roomMem.sources[source.id].accessible = roomMem.sources[source.id].openTiles > 0;
}

function publishRemoteState(creep, source, container, site, plannedPos) {
  SourceWorkerManager.upsertRemoteContainerBuildStatus(creep, source, container, site, plannedPos, {
    isRoomUnsafe: SourceEnergyManager.isRemoteUnsafe
  });
  if (container) {
    SourceWorkerManager.upsertRemoteContainerStatus(creep, source, container, {
      isRoomUnsafe: SourceEnergyManager.isRemoteUnsafe
    });
    SourceWorkerManager.upsertRemoteHaulRequest(creep, source, container, {
      isRoomUnsafe: SourceEnergyManager.isRemoteUnsafe
    });
  }
  SourceWorkerManager.publishRemoteLooseEnergyRequests(creep, source, container, {
    isRoomUnsafe: SourceEnergyManager.isRemoteUnsafe
  });
}

function moveToSeatOrSource(creep, source, seatPos, container, site) {
  if (seatPos && !creep.pos.isEqualTo(seatPos)) {
    debugSay(creep, 'TRAVEL');
    debugRing(creep.room, seatPos, CFG.DRAW.SEAT, 'SEAT');
    creep.travelTo(seatPos, { range: 0, reusePath: CFG.TRAVEL_REUSE });
    return true;
  }
  if (!seatPos && creep.pos.getRangeTo(source) > 1) {
    debugSay(creep, 'TRAVEL');
    debugLine(creep, source, CFG.DRAW.TRAVEL_COLOR, 'SRC');
    creep.travelTo(source, { range: 1, reusePath: CFG.TRAVEL_REUSE });
    return true;
  }
  return false;
}

function shouldRepairContainer(creep, container) {
  if (!container || !container.hitsMax) return false;
  var pct = container.hits / container.hitsMax;
  if (creep.memory.repairingRemoteContainer) return pct < REPAIR_STOP;
  return pct < REPAIR_START;
}

function runContainerRepair(creep, source, container, seatPos) {
  if (!container) {
    creep.memory.repairingRemoteContainer = false;
    return false;
  }

  if (!shouldRepairContainer(creep, container)) {
    creep.memory.repairingRemoteContainer = false;
    return false;
  }

  creep.memory.repairingRemoteContainer = true;
  SourceWorkerManager.markContainerRepairMaintenanceHold(creep, container, source);

  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) <= 0) {
    var surplus = (container.store && (container.store[RESOURCE_ENERGY] || 0)) || 0;
    var minKeep = CFG.remoteContainerRepairMinContainerEnergy || 100;
    if (surplus > minKeep && creep.pos.getRangeTo(container) <= 1) {
      creep.withdraw(container, RESOURCE_ENERGY, Math.min(creep.store.getFreeCapacity(RESOURCE_ENERGY), surplus - minKeep));
      return true;
    }
    debugSay(creep, 'MINE');
    creep.harvest(source);
    return true;
  }

  if (creep.pos.getRangeTo(container) > 3) {
    debugSay(creep, 'TRAVEL');
    creep.travelTo(seatPos || container, { range: seatPos ? 0 : 3, reusePath: CFG.TRAVEL_REUSE });
    return true;
  }

  debugSay(creep, 'REPAIR');
  creep.repair(container);
  return true;
}

function depositOrBuild(creep, source, container, site, plannedPos) {
  var carried = creep.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
  if (carried <= 0) return false;

  if (container && creep.pos.getRangeTo(container) <= 1) {
    var tr = creep.transfer(container, RESOURCE_ENERGY);
    if (tr === ERR_FULL) {
      debugSay(creep, 'HAUL');
      creep.drop(RESOURCE_ENERGY);
    }
    return true;
  }

  if (site && creep.pos.getRangeTo(site) <= 3) {
    debugSay(creep, 'BUILD');
    creep.build(site);
    return true;
  }

  if (!container && !site && carried >= creep.store.getCapacity(RESOURCE_ENERGY)) {
    debugSay(creep, 'HAUL');
    creep.drop(RESOURCE_ENERGY);
    return true;
  }

  return false;
}

function harvestAssignedSource(creep) {
  var rec = getPlanRecord(creep);
  if (!rec) {
    releaseAssignment(creep, 'source-not-in-plan');
    return;
  }

  if (travelToAssignedRoom(creep, rec)) return;

  if (SourceEnergyManager.isRemoteUnsafe(creep.room.name)) {
    debugSay(creep, 'SAFE');
    releaseAssignment(creep, 'unsafe-room');
    return;
  }

  var source = Game.getObjectById(rec.sourceId);
  if (!source) {
    releaseAssignment(creep, 'source-not-visible');
    return;
  }

  updateVisibleSourceMemory(source);
  debugRing(creep.room, source.pos, CFG.DRAW.SRC_COLOR, 'SRC');

  var infra = SourceWorkerManager.ensureSourceContainerOrSite(source);
  var container = SourceWorkerManager.findAssignedSourceContainer(creep, source) || infra.container;
  var site = infra.site || null;
  var plannedPos = infra.plannedPos || null;
  var anchorPos = (container && container.pos) || (site && site.pos) || plannedPos || null;
  var seatPos = chooseMiningSeat(creep, source, anchorPos);

  if (container) {
    creep.memory.containerId = container.id;
    creep.memory.assignedContainer = container.id;
  } else {
    delete creep.memory.containerId;
    delete creep.memory.assignedContainer;
  }

  publishRemoteState(creep, source, container, site, plannedPos);

  if (moveToSeatOrSource(creep, source, seatPos, container, site)) return;

  if (container && runContainerRepair(creep, source, container, seatPos)) {
    publishRemoteState(creep, source, container, site, plannedPos);
    return;
  }

  if (!container && site && creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
    debugSay(creep, 'BUILD');
    creep.build(site);
    publishRemoteState(creep, source, container, site, plannedPos);
    return;
  }

  debugSay(creep, 'MINE');
  var result = creep.harvest(source);
  if (result === ERR_NOT_IN_RANGE) {
    creep.travelTo(source, { range: 1, reusePath: CFG.TRAVEL_REUSE });
    return;
  }

  depositOrBuild(creep, source, container, site, plannedPos);
  publishRemoteState(creep, source, container, site, plannedPos);
}

function run(creep) {
  if (!creep || creep.spawning) return;
  if (validateAssignment(creep)) return;
  harvestAssignedSource(creep);
}

module.exports = {
  run: run,
  MAX_VEINSEEKER_PER_SOURCE: 1
};
