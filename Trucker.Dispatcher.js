'use strict';

// -----------------------------------------------------------------------------
// Trucker.Dispatcher.js - job selection and reservation for Trucker creeps
// Owns:
// * Memory.__BHM.truckerDispatch.claims and assignedByCreep, the short-lived
//   claim tables that prevent two Truckers from selecting the same job.
// * Per-home audit summaries in Memory.rooms[homeRoom].lastRemoteHaulRequestAudit
//   when chooseJobForTrucker evaluates remote haul requests.
// Reads:
// * Memory.__BHM.remoteHaulRequests produced by role.Veinseeker.Logic.js when remote
//   source containers have enough energy to haul.
// * Memory.rooms[remoteRoom].intel/hostile/sourceWorkerBlocked fields for safety gates.
// Usually called by:
// * role.Trucker.Logic.js whenever a Trucker needs a dispatchJob.
// Systems that depend on it:
// * BeeSpawnManager reads Trucker job counts and remote haul pressure to size
//   future Trucker quotas.
// Do not casually change:
// * Job id format, reservation TTL semantics, or remote request skip reasons;
//   they are used in diagnostics and quota calculations.
// -----------------------------------------------------------------------------

var CFG = require('role.Trucker.Config');

function ensureDispatchMemory() {
  // Dispatcher-owned claim tables. They are separate from individual Trucker
  // creep.memory.dispatchJob so dead creeps and expired claims can be cleaned.
  if (!Memory.__BHM) Memory.__BHM = {};
  if (!Memory.__BHM.truckerDispatch) Memory.__BHM.truckerDispatch = {};
  var d = Memory.__BHM.truckerDispatch;
  if (!d.claims) d.claims = {};
  if (!d.assignedByCreep) d.assignedByCreep = {};
  return d;
}

function normalizeSourceContainerRecord(raw, sourceId, roomName, homeRoom) {
  var rec = raw || {};
  return {
    sourceId: rec.sourceId || sourceId || null,
    roomName: rec.roomName || roomName || null,
    homeRoom: rec.homeRoom || homeRoom || null,
    containerId: rec.containerId || rec.id || null,
    siteId: rec.siteId || null,
    x: (typeof rec.x === 'number') ? rec.x : null,
    y: (typeof rec.y === 'number') ? rec.y : null,
    status: rec.status || 'unknown',
    amount: (typeof rec.amount === 'number') ? rec.amount : 0,
    capacity: (typeof rec.capacity === 'number') ? rec.capacity : 2000,
    hits: (typeof rec.hits === 'number') ? rec.hits : null,
    hitsMax: (typeof rec.hitsMax === 'number') ? rec.hitsMax : null,
    updated: rec.updated || 0,
    lastSeen: rec.lastSeen || rec.updated || 0
  };
}

function refreshContainerRecordFromVision(record, roomObj) {
  if (!record || !roomObj) return record;
  var out = normalizeSourceContainerRecord(record, record.sourceId, record.roomName, record.homeRoom);
  var src = out.sourceId ? Game.getObjectById(out.sourceId) : null;
  if (src && src.pos) { out.x = src.pos.x; out.y = src.pos.y; out.roomName = src.pos.roomName; }
  var cont = out.containerId ? Game.getObjectById(out.containerId) : null;
  if (cont && cont.store) {
    out.status = 'built'; out.amount = cont.store[RESOURCE_ENERGY] || 0; out.capacity = cont.store.getCapacity(RESOURCE_ENERGY) || 2000;
    out.hits = cont.hits; out.hitsMax = cont.hitsMax; out.x = cont.pos.x; out.y = cont.pos.y; out.lastSeen = Game.time; out.updated = Game.time;
  } else if (out.siteId) {
    var site = Game.getObjectById(out.siteId);
    if (site) { out.status = 'site'; out.x = site.pos.x; out.y = site.pos.y; out.lastSeen = Game.time; out.updated = Game.time; }
    else out.status = 'missing';
  }
  return out;
}

function estimateRemoteRoundTripTicks(homeRoom, remoteRoom) {
  if (!homeRoom || !remoteRoom) return 9999;
  var rooms = 0;
  try {
    var route = Game.map.findRoute(homeRoom, remoteRoom);
    if (route && route !== ERR_NO_PATH && typeof route.length === 'number') rooms = route.length;
  } catch (e) {}
  if (!rooms || rooms < 1) rooms = Game.map.getRoomLinearDistance(homeRoom, remoteRoom) || 1;
  var estimatedTravelTicks = rooms * 50 + 100;
  return estimatedTravelTicks * 2 + 100;
}

function estimateRemoteRequestDistance(homeRoom, req) {
  if (!homeRoom || !req) return 9999;
  var remoteRoom = req.roomName || req.remoteRoom;
  if (!remoteRoom) return 9999;
  var roomDistance = 0;
  try {
    var route = Game.map.findRoute(homeRoom, remoteRoom);
    if (route && route !== ERR_NO_PATH && typeof route.length === 'number') roomDistance = route.length;
  } catch (err) {}
  if (!roomDistance || roomDistance < 1) roomDistance = Game.map.getRoomLinearDistance(homeRoom, remoteRoom) || 1;
  var inRoomDistance = (typeof req.x === 'number' && typeof req.y === 'number') ? 25 : 50;
  return Math.max(1, roomDistance * 50 + inRoomDistance);
}

function scoreRemoteRequestForCreep(creep, req) {
  if (!creep || !req) return 0;
  var capacity = creep.store ? (creep.store.getFreeCapacity(RESOURCE_ENERGY) || 0) : 0;
  if (capacity <= 0) return 0;
  var distance = estimateRemoteRequestDistance(creep.memory.home || (creep.room && creep.room.name), req);
  return Math.min(capacity, req.amount || 0) / Math.max(1, distance);
}

function canCreepSafelyTakeRemoteJob(creep, remoteRoom) {
  if (!creep || !remoteRoom) return false;
  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) return true;
  if (typeof creep.ticksToLive !== 'number') return true;
  var required = estimateRemoteRoundTripTicks(creep.memory.home, remoteRoom);
  return creep.ticksToLive >= required;
}

function isRemoteRequestReservedByOther(req, creepName) {
  if (!req) return false;
  return !!(req.assignedTo && req.assignedTo !== creepName && (req.assignedUntil || 0) > Game.time);
}

function claimJob(creep, job, ttl) {
  var d = ensureDispatchMemory();
  if (!job || !job.id || !creep) return false;
  var c = d.claims[job.id];
  if (c && c.creepName !== creep.name && c.until > Game.time) return false;
  d.claims[job.id] = { creepName: creep.name, until: Game.time + (ttl || CFG.RESERVATION_TTL), type: job.type };
  d.assignedByCreep[creep.name] = { id: job.id, type: job.type, tick: Game.time };
  return true;
}

function releaseJob(creep, jobId) {
  var d = ensureDispatchMemory();
  if (jobId && d.claims[jobId] && d.claims[jobId].creepName === creep.name) delete d.claims[jobId];
  if (d.assignedByCreep[creep.name]) delete d.assignedByCreep[creep.name];
}

function cleanupDispatchMemory() {
  // Remove expired job claims and claims owned by dead creeps before choosing
  // new work. This prevents remote haul requests from staying locked forever.
  var d = ensureDispatchMemory();
  var id;
  for (id in d.claims) {
    if (!d.claims.hasOwnProperty(id)) continue;
    if (!d.claims[id] || d.claims[id].until <= Game.time) delete d.claims[id];
  }
  for (id in d.assignedByCreep) {
    if (!d.assignedByCreep.hasOwnProperty(id)) continue;
    if (!Game.creeps[id]) delete d.assignedByCreep[id];
  }
  return d;
}

function getLocalContainerPressure(homeRoom) {
  // Local pressure protects the home economy. If source containers are near
  // full, the dispatcher reserves some Truckers for local pickup before remote
  // haul work can claim everyone.
  var out = {
    containersSeen: 0,
    containersOverPickup: 0,
    containersOverUrgent: 0,
    containersOverCritical: 0,
    localPressure: 'none',
    reason: 'no_vision'
  };
  if (!homeRoom) return out;
  var room = Game.rooms[homeRoom];
  if (!room) return out;
  out.reason = 'no_containers';
  var pickupAt = Math.max(0, CFG.LOCAL_CONTAINER_PICKUP_AT || 1000);
  var urgentAt = Math.max(pickupAt, CFG.LOCAL_CONTAINER_URGENT_AT || 1600);
  var criticalAt = Math.max(urgentAt, CFG.LOCAL_CONTAINER_CRITICAL_AT || 1900);
  var containers = room.find(FIND_STRUCTURES, {
    filter: function(s) { return s.structureType === STRUCTURE_CONTAINER && s.store; }
  });
  out.containersSeen = containers.length;
  for (var i = 0; i < containers.length; i++) {
    var energy = containers[i].store[RESOURCE_ENERGY] || 0;
    if (energy >= pickupAt) out.containersOverPickup++;
    if (energy >= urgentAt) out.containersOverUrgent++;
    if (energy >= criticalAt) out.containersOverCritical++;
  }
  if (out.containersOverCritical > 0) {
    out.localPressure = 'critical';
    out.reason = 'containers_over_critical';
  } else if (out.containersOverUrgent > 0) {
    out.localPressure = 'urgent';
    out.reason = 'containers_over_urgent';
  } else if (out.containersOverPickup > 0) {
    out.localPressure = 'pickup';
    out.reason = 'containers_over_pickup';
  }
  return out;
}

function countHomeTruckers(homeRoom) {
  var count = 0;
  for (var name in Game.creeps) {
    if (!Game.creeps.hasOwnProperty(name)) continue;
    var c = Game.creeps[name];
    if (!c || !c.memory) continue;
    if (c.memory.role !== 'Trucker') continue;
    if ((c.memory.home || c.room.name) !== homeRoom) continue;
    count++;
  }
  return count;
}

function countHomeTruckersOnLocalJobs(homeRoom) {
  var count = 0;
  for (var name in Game.creeps) {
    if (!Game.creeps.hasOwnProperty(name)) continue;
    var c = Game.creeps[name];
    if (!c || !c.memory) continue;
    if (c.memory.role !== 'Trucker') continue;
    if ((c.memory.home || c.room.name) !== homeRoom) continue;
    var job = c.memory.dispatchJob;
    if (!job || !job.type) continue;
    if (job.type === 'LOCAL_COLLECT' || job.type === 'LOCAL_DELIVER') count++;
  }
  return count;
}

function getMyUsernameForTruckerDispatch() {
  for (var name in Game.spawns) {
    if (!Game.spawns.hasOwnProperty(name)) continue;
    var spawn = Game.spawns[name];
    if (!spawn || !spawn.owner || !spawn.owner.username) continue;
    return spawn.owner.username;
  }
  return null;
}

function isRemoteRoomUnsafeForTrucker(remoteRoom) {
  // Trucker remote safety gate mirrors Veinseeker enough to avoid hostile/blocked
  // rooms, but remains local to dispatch so hauling can make its own decisions.
  if (!remoteRoom) return false;
  var mem = (Memory.rooms && Memory.rooms[remoteRoom]) || {};
  if (mem.hostile) return true;
  if (mem.sourceWorkerBlockedUntil && mem.sourceWorkerBlockedUntil > Game.time) return true;
  if (mem._invaderLock && mem._invaderLock.locked) {
    var lockTick = (typeof mem._invaderLock.t === 'number') ? mem._invaderLock.t : null;
    if (lockTick == null || (Game.time - lockTick) <= 1500) return true;
  }
  var myName = getMyUsernameForTruckerDispatch();
  var intel = mem.intel || {};
  if (intel.owner && (!myName || intel.owner !== myName)) return true;
  if (intel.reservation && (!myName || intel.reservation !== myName)) return true;
  return false;
}

function getLocalDesiredTruckers(localContainerPressure) {
  var base = Math.max(0, CFG.LOCAL_TRUCKER_BASE_QUOTA || 0);
  var desired = base;
  if (localContainerPressure && (localContainerPressure.localPressure === 'urgent' || localContainerPressure.localPressure === 'critical')) desired += 1;
  var maxTotal = Math.max(0, CFG.MAX_TOTAL_TRUCKERS_PER_HOME || 0);
  if (maxTotal > 0) desired = Math.min(desired, maxTotal);
  return desired;
}

function chooseJobForTrucker(creep) {
  // Main dispatcher entry. It prioritizes returning carried energy, preserves
  // a minimum local-hauling presence, then chooses the best fresh/safe remote
  // haul request by urgency and amount.
  var d = cleanupDispatchMemory();
  var home = creep.memory.home || creep.room.name;
  var diag = { tick: Game.time, jobsSeen: 0, jobsClaimed: 0, localJobs: 0, remoteJobs: 0, skippedRemoteTTL: 0, skippedReserved: 0, skippedNoVision: 0, skippedUnsafe: 0, skippedLowAmount: 0, skippedStale: 0, skippedMaintenance: 0, assignedByCreep: d.assignedByCreep || {} };
  var remoteAudit = { tick: Game.time, truckerName: creep.name, activeRequests: 0, skippedLowAmount: 0, skippedStale: 0, skippedUnsafe: 0, skippedMaintenance: 0, skippedReserved: 0, skippedTTL: 0, selectedRequestId: null, selectedTargetType: null, selectedRemoteRoom: null, selectedAmount: 0 };
  var localContainerPressure = getLocalContainerPressure(home);
  var homeTruckers = countHomeTruckers(home);
  var localAssignedTruckers = countHomeTruckersOnLocalJobs(home);
  var localDesiredTruckers = getLocalDesiredTruckers(localContainerPressure);
  var forceLocalCollect = localAssignedTruckers < localDesiredTruckers;
  if (forceLocalCollect) localContainerPressure.reason = 'protect_local_desired_quota';
  localContainerPressure.homeTruckers = homeTruckers;
  localContainerPressure.localAssignedTruckers = localAssignedTruckers;
  localContainerPressure.localDesiredTruckers = localDesiredTruckers;
  localContainerPressure.forceLocalCollect = forceLocalCollect;
  diag.localContainerPressure = localContainerPressure;

  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
    if (!Memory.rooms) Memory.rooms = {};
    if (!Memory.rooms[home]) Memory.rooms[home] = {};
    Memory.rooms[home].lastRemoteHaulRequestAudit = remoteAudit;
    return { id: 'return:' + creep.name, type: 'REMOTE_RETURN', homeRoom: home };
  }

  diag.jobsSeen++; diag.localJobs++;
  // Keep this claim id per-creep so urgent/critical local pressure can fan out
  // across multiple Truckers in the same tick without a shared claim collision.
  var localCollect = { id: 'localCollect:' + home + ':' + creep.name, type: 'LOCAL_COLLECT', homeRoom: home };
  if (forceLocalCollect && claimJob(creep, localCollect, 10)) { diag.jobsClaimed++; d.lastRun = diag; if (!Memory.rooms) Memory.rooms = {}; if (!Memory.rooms[home]) Memory.rooms[home] = {}; Memory.rooms[home].lastRemoteHaulRequestAudit = remoteAudit; return localCollect; }

  var reqs = (Memory.__BHM && Memory.__BHM.remoteHaulRequests) || {};
  var best = null;
  var bestScore = -1;
  for (var id in reqs) {
    if (!reqs.hasOwnProperty(id)) continue;
    var r = reqs[id];
    if (!r || r.homeRoom !== home) continue;
    remoteAudit.activeRequests++;
    if (CFG.shouldBlockRemoteHaulForMaintenance(r)) { diag.skippedMaintenance++; remoteAudit.skippedMaintenance++; continue; }
    if (isRemoteRequestReservedByOther(r, creep.name)) { diag.skippedReserved++; remoteAudit.skippedReserved++; continue; }
    if ((r.amount || 0) < CFG.MIN_HAUL_REQUEST_ENERGY) { diag.skippedLowAmount++; remoteAudit.skippedLowAmount++; continue; }
    if ((Game.time - (r.updated || 0)) > CFG.REQUEST_STALE_TICKS) { diag.skippedStale++; remoteAudit.skippedStale++; continue; }
    var remoteRoom = r.roomName || r.remoteRoom;
    if (isRemoteRoomUnsafeForTrucker(remoteRoom)) { diag.skippedUnsafe++; remoteAudit.skippedUnsafe++; continue; }
    if (!canCreepSafelyTakeRemoteJob(creep, remoteRoom)) { diag.skippedRemoteTTL++; remoteAudit.skippedTTL++; continue; }
    var distance = estimateRemoteRequestDistance(home, r);
    var score = scoreRemoteRequestForCreep(creep, r);
    var targetType = r.targetType || 'container';
    var j = { id: 'remote:' + id, type: 'REMOTE_PICKUP', requestId: id, roomName: remoteRoom, targetType: targetType, targetId: r.targetId || r.resourceId || r.containerId || null, resourceId: r.resourceId || null, containerId: targetType === 'container' ? r.containerId : null, sourceId: r.sourceId, x: r.x, y: r.y, urgent: !!r.urgent, amount: r.amount || 0, distance: distance, score: score };
    diag.jobsSeen++; diag.remoteJobs++;
    if (!best || (j.urgent && !best.urgent) || (j.urgent === best.urgent && score > bestScore)) {
      best = j;
      bestScore = score;
    }
  }
  if (best && claimJob(creep, best, CFG.RESERVATION_TTL)) { diag.jobsClaimed++; remoteAudit.selectedRequestId = best.requestId || null; remoteAudit.selectedTargetType = best.targetType || null; remoteAudit.selectedRemoteRoom = best.roomName || null; remoteAudit.selectedAmount = best.amount || 0; remoteAudit.selectedScore = best.score || 0; remoteAudit.selectedDistance = best.distance || null; d.lastRun = diag; if (!Memory.rooms) Memory.rooms = {}; if (!Memory.rooms[home]) Memory.rooms[home] = {}; Memory.rooms[home].lastRemoteHaulRequestAudit = remoteAudit; return best; }

  if (claimJob(creep, localCollect, 10)) { diag.jobsClaimed++; d.lastRun = diag; if (!Memory.rooms) Memory.rooms = {}; if (!Memory.rooms[home]) Memory.rooms[home] = {}; Memory.rooms[home].lastRemoteHaulRequestAudit = remoteAudit; return localCollect; }

  diag.jobsSeen++; diag.localJobs++;
  var localDeliver = { id: 'localDeliver:' + home, type: 'LOCAL_DELIVER', homeRoom: home };
  claimJob(creep, localDeliver, 10);
  d.lastRun = diag;
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[home]) Memory.rooms[home] = {};
  Memory.rooms[home].lastRemoteHaulRequestAudit = remoteAudit;
  return localDeliver;
}

module.exports = {
  ensureDispatchMemory: ensureDispatchMemory,
  normalizeSourceContainerRecord: normalizeSourceContainerRecord,
  refreshContainerRecordFromVision: refreshContainerRecordFromVision,
  estimateRemoteRoundTripTicks: estimateRemoteRoundTripTicks,
  canCreepSafelyTakeRemoteJob: canCreepSafelyTakeRemoteJob,
  isRemoteRequestReservedByOther: isRemoteRequestReservedByOther,
  claimJob: claimJob,
  releaseJob: releaseJob,
  cleanupDispatchMemory: cleanupDispatchMemory,
  getLocalContainerPressure: getLocalContainerPressure,
  chooseJobForTrucker: chooseJobForTrucker
};
