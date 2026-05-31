'use strict';

// -----------------------------------------------------------------------------
// role.Trucker.Dispatcher.js - job selection and reservation for Trucker creeps
// Owns:
// * Memory.__BHM.truckerDispatch.claims and assignedByCreep, the short-lived
//   claim tables that prevent two Truckers from selecting the same job.
// * Per-home audit summaries in Memory.rooms[homeRoom].lastRemoteHaulRequestAudit
//   when chooseJobForTrucker evaluates remote haul requests.
// Reads:
// * Memory.__BHM.remoteHaulRequests produced by SourceWorker.Manager via
//   role.Veinseeker.Remote.js when remote
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
var BeeToolbox = require('BeeToolbox');
var SourceEnergyManager = require('SourceEnergy.Manager');

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

function getTickCache() {
  return global.__BHM && global.__BHM.tick === Game.time ? global.__BHM : null;
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
  return BeeToolbox.estimateRemoteRoundTripTicks(homeRoom, remoteRoom);
}

function estimateRemoteRequestDistance(homeRoom, req) {
  return BeeToolbox.estimateRemoteRequestDistance(homeRoom, req);
}

function cleanupRequestAssignmentMap(req) {
  if (!req) return 0;
  if (!req.assignedTruckers) req.assignedTruckers = {};
  var count = 0;
  for (var name in req.assignedTruckers) {
    if (!Object.prototype.hasOwnProperty.call(req.assignedTruckers, name)) continue;
    if (!req.assignedTruckers[name] || req.assignedTruckers[name] <= Game.time || !Game.creeps[name]) {
      delete req.assignedTruckers[name];
      continue;
    }
    count++;
  }
  if (req.assignedTo && req.assignedUntil && req.assignedUntil > Game.time && Game.creeps[req.assignedTo]) {
    if (!req.assignedTruckers[req.assignedTo]) {
      req.assignedTruckers[req.assignedTo] = req.assignedUntil;
      count++;
    }
  } else if (req.assignedTo) {
    req.assignedTo = null;
    req.assignedUntil = 0;
  }
  return count;
}

function getRemoteRequestMaxAssignments(req) {
  if (!req) return 1;
  if ((req.targetType || 'container') !== 'container') return 1;
  return Math.max(1, CFG.REMOTE_HAUL_MAX_ASSIGNMENTS_PER_REQUEST || 1);
}

function getActiveSourceDecision(homeRoom, req) {
  if (!req || !req.sourceId) return { active: true, reason: 'no-source-id' };
  var rec = SourceEnergyManager.getSourceRecord(homeRoom, req.sourceId);
  if (!rec) return { active: true, reason: 'source-not-in-plan' };
  if (rec.mode !== 'remote') return { active: true, reason: 'non-remote-source' };
  return {
    active: !!rec.active,
    reason: rec.active ? (rec.activationReason || rec.reason || 'active') : (rec.rejectionReason || rec.reason || 'inactive'),
    record: rec
  };
}

function scoreRemoteRequestForCreep(creep, req) {
  if (!creep || !req) return { score: 0, skipReason: 'invalid-request' };
  var capacity = creep.store ? (creep.store.getFreeCapacity(RESOURCE_ENERGY) || 0) : 0;
  if (capacity <= 0) return { score: 0, skipReason: 'no-capacity' };
  var home = creep.memory.home || (creep.room && creep.room.name);
  var distance = estimateRemoteRequestDistance(home, req);
  var sourceDecision = getActiveSourceDecision(home, req);
  var ept = sourceDecision.record && sourceDecision.record.economics && typeof sourceDecision.record.economics.energyPerTick === 'number'
    ? sourceDecision.record.economics.energyPerTick
    : 0;
  var arrivalTicks = Math.max(1, distance * Math.max(0.1, CFG.REMOTE_HAUL_EXPECTED_ARRIVAL_MULTIPLIER || 1.15));
  var targetType = req.targetType || 'container';
  var current = Math.max(0, req.amount || 0);
  var expected = targetType === 'container' ? current + (ept * arrivalTicks) : current;
  var requestCapacity = req.capacity || (targetType === 'container' ? 2000 : current);
  if (requestCapacity > 0) expected = Math.min(requestCapacity, expected);
  var minExpected = Math.max(0, CFG.REMOTE_HAUL_MIN_EXPECTED_ENERGY || CFG.MIN_HAUL_REQUEST_ENERGY || 300);
  if (expected < minExpected) return { score: 0, skipReason: 'expected-low', distance: distance, expectedEnergy: expected, arrivalTicks: arrivalTicks };
  var haulAmount = Math.min(capacity, expected);
  var fillPct = requestCapacity > 0 ? expected / requestCapacity : 1;
  var base = haulAmount / Math.max(1, distance);
  var urgencyBonus = req.urgent ? base * (CFG.REMOTE_SCORE_URGENCY_BONUS || 0.25) : 0;
  var fillBonus = fillPct * (CFG.REMOTE_SCORE_FILL_BONUS || 0.20);
  var ttlMargin = typeof creep.ticksToLive === 'number' ? creep.ticksToLive - ((distance * 2) + 50) : null;
  var ttlScore = ttlMargin !== null ? Math.max(-0.5, Math.min(0.5, ttlMargin / 1000)) : 0;
  return {
    score: base + urgencyBonus + fillBonus + ttlScore,
    skipReason: null,
    distance: distance,
    arrivalTicks: Math.round(arrivalTicks),
    expectedEnergy: Math.round(expected),
    haulAmount: Math.round(haulAmount),
    fillPct: Math.round(fillPct * 1000) / 1000,
    ttlMargin: ttlMargin,
    sourceDecision: sourceDecision.reason
  };
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
  var count = cleanupRequestAssignmentMap(req);
  if (req.assignedTruckers && req.assignedTruckers[creepName] && req.assignedTruckers[creepName] > Game.time) return false;
  if (req.assignedTo && req.assignedTo === creepName && (req.assignedUntil || 0) > Game.time) return false;
  return count >= getRemoteRequestMaxAssignments(req);
}

function claimJob(creep, job, ttl) {
  var d = ensureDispatchMemory();
  if (!job || !job.id || !creep) return false;
  var until = Game.time + (ttl || CFG.RESERVATION_TTL);
  var maxAssignments = job.type === 'REMOTE_PICKUP' ? Math.max(1, job.maxAssignments || CFG.REMOTE_HAUL_MAX_ASSIGNMENTS_PER_REQUEST || 1) : 1;
  var c = d.claims[job.id];
  if (maxAssignments <= 1) {
    if (c && c.creepName !== creep.name && c.until > Game.time) return false;
    d.claims[job.id] = { creepName: creep.name, until: until, type: job.type };
    d.assignedByCreep[creep.name] = { id: job.id, type: job.type, tick: Game.time };
    return true;
  }
  if (!c || !c.creeps) {
    var converted = {};
    if (c && c.creepName && c.until > Game.time && Game.creeps[c.creepName]) converted[c.creepName] = c.until;
    c = d.claims[job.id] = { creeps: converted, type: job.type, maxAssignments: maxAssignments };
  }
  var live = 0;
  for (var name in c.creeps) {
    if (!Object.prototype.hasOwnProperty.call(c.creeps, name)) continue;
    if (!c.creeps[name] || c.creeps[name] <= Game.time || !Game.creeps[name]) {
      delete c.creeps[name];
      continue;
    }
    live++;
  }
  if (!c.creeps[creep.name] && live >= maxAssignments) return false;
  c.creeps[creep.name] = until;
  c.creepName = creep.name;
  c.until = until;
  d.assignedByCreep[creep.name] = { id: job.id, type: job.type, tick: Game.time };
  return true;
}

function releaseJob(creep, jobId) {
  var d = ensureDispatchMemory();
  if (jobId && d.claims[jobId]) {
    if (d.claims[jobId].creeps && d.claims[jobId].creeps[creep.name]) {
      delete d.claims[jobId].creeps[creep.name];
      if (Object.keys(d.claims[jobId].creeps).length === 0) delete d.claims[jobId];
    } else if (d.claims[jobId].creepName === creep.name) {
      delete d.claims[jobId];
    }
  }
  if (d.assignedByCreep[creep.name]) delete d.assignedByCreep[creep.name];
}

function cleanupDispatchMemory() {
  // Remove expired job claims and claims owned by dead creeps before choosing
  // new work. This prevents remote haul requests from staying locked forever.
  var d = ensureDispatchMemory();
  if (d.cleanupTick === Game.time) return d;
  d.cleanupTick = Game.time;
  var id;
  for (id in d.claims) {
    if (!d.claims.hasOwnProperty(id)) continue;
    var claim = d.claims[id];
    if (!claim) {
      delete d.claims[id];
      continue;
    }
    if (claim.creeps) {
      var liveClaims = 0;
      for (var cname in claim.creeps) {
        if (!Object.prototype.hasOwnProperty.call(claim.creeps, cname)) continue;
        if (!claim.creeps[cname] || claim.creeps[cname] <= Game.time || !Game.creeps[cname]) {
          delete claim.creeps[cname];
          continue;
        }
        liveClaims++;
      }
      if (liveClaims <= 0) delete d.claims[id];
      continue;
    }
    if (claim.until <= Game.time || (claim.creepName && !Game.creeps[claim.creepName])) delete d.claims[id];
  }
  for (id in d.assignedByCreep) {
    if (!d.assignedByCreep.hasOwnProperty(id)) continue;
    if (!Game.creeps[id]) delete d.assignedByCreep[id];
  }
  return d;
}

function cleanupRemoteHaulRequestsForHome(homeRoom) {
  var reqs = (Memory.__BHM && Memory.__BHM.remoteHaulRequests) || {};
  var report = {
    clearedExpiredAssignments: 0,
    clearedDeadAssignments: 0,
    cleanedAssignmentMaps: 0,
    deletedStaleRequests: 0
  };
  var hardStale = Math.max(CFG.REQUEST_STALE_TICKS * 3, CFG.REQUEST_STALE_TICKS + 50);
  for (var id in reqs) {
    if (!Object.prototype.hasOwnProperty.call(reqs, id)) continue;
    var req = reqs[id];
    if (!req || (homeRoom && req.homeRoom !== homeRoom)) continue;
    var beforeMap = req.assignedTruckers ? Object.keys(req.assignedTruckers).length : 0;
    cleanupRequestAssignmentMap(req);
    var afterMap = req.assignedTruckers ? Object.keys(req.assignedTruckers).length : 0;
    if (afterMap < beforeMap) report.cleanedAssignmentMaps += beforeMap - afterMap;
    if (req.assignedTo && (!req.assignedUntil || req.assignedUntil <= Game.time)) {
      req.assignedTo = null;
      req.assignedUntil = 0;
      report.clearedExpiredAssignments++;
    } else if (req.assignedTo && !Game.creeps[req.assignedTo]) {
      req.assignedTo = null;
      req.assignedUntil = 0;
      report.clearedDeadAssignments++;
    }
    if ((Game.time - (req.updated || 0)) > hardStale) {
      delete reqs[id];
      report.deletedStaleRequests++;
    }
  }
  return report;
}

function writeRemoteHaulAudit(homeRoom, remoteAudit) {
  if (!homeRoom) return;
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[homeRoom]) Memory.rooms[homeRoom] = {};
  Memory.rooms[homeRoom].lastRemoteHaulRequestAudit = remoteAudit;
  if (Memory.rooms[homeRoom].lastSourceEnergyPlan) {
    Memory.rooms[homeRoom].lastSourceEnergyPlan.truckerRemoteHaulDecisions = remoteAudit;
  }
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
  var C = getTickCache();
  var snap = C && C.roomSnapshots && C.roomSnapshots[homeRoom] ? C.roomSnapshots[homeRoom] : null;
  var containers = snap && snap.allContainers ? snap.allContainers : room.find(FIND_STRUCTURES, {
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
  var C = getTickCache();
  if (C && C.creepsByHomeRole && C.creepsByHomeRole[homeRoom] && C.creepsByHomeRole[homeRoom].Trucker) {
    return C.creepsByHomeRole[homeRoom].Trucker.length;
  }
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
  var C = getTickCache();
  if (C && C.truckerAssignmentCountsByHome && C.truckerAssignmentCountsByHome[homeRoom]) {
    return C.truckerAssignmentCountsByHome[homeRoom].truckersOnLocalJobs || 0;
  }
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

function isRemoteRoomUnsafeForTrucker(remoteRoom) {
  // Trucker remote safety gate mirrors Veinseeker enough to avoid hostile/blocked
  // rooms, but remains local to dispatch so hauling can make its own decisions.
  return BeeToolbox.isRemoteRoomUnsafe(remoteRoom);
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
  var requestCleanup = cleanupRemoteHaulRequestsForHome(home);
  var diag = { tick: Game.time, jobsSeen: 0, jobsClaimed: 0, localJobs: 0, remoteJobs: 0, skippedRemoteTTL: 0, skippedReserved: 0, skippedNoVision: 0, skippedUnsafe: 0, skippedLowAmount: 0, skippedExpectedLow: 0, skippedInactiveSource: 0, skippedStale: 0, skippedMaintenance: 0, skippedClaimedJob: 0, assignedByCreep: d.assignedByCreep || {} };
  var remoteAudit = { tick: Game.time, truckerName: creep.name, activeRequests: 0, skippedLowAmount: 0, skippedExpectedLow: 0, skippedInactiveSource: 0, skippedStale: 0, skippedUnsafe: 0, skippedMaintenance: 0, skippedReserved: 0, skippedTTL: 0, skippedClaimedJob: 0, selectedRequestId: null, selectedTargetType: null, selectedRemoteRoom: null, selectedAmount: 0, selectedExpectedEnergy: 0, selectedArrivalTicks: 0, cleanup: requestCleanup };
  if (CFG.TRUCKER_REMOTE_SCORE_DEBUG) remoteAudit.evaluated = [];
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
    writeRemoteHaulAudit(home, remoteAudit);
    return { id: 'return:' + creep.name, type: 'REMOTE_RETURN', homeRoom: home };
  }

  diag.jobsSeen++; diag.localJobs++;
  // Keep this claim id per-creep so urgent/critical local pressure can fan out
  // across multiple Truckers in the same tick without a shared claim collision.
  var localCollect = { id: 'localCollect:' + home + ':' + creep.name, type: 'LOCAL_COLLECT', homeRoom: home };
  if (forceLocalCollect && claimJob(creep, localCollect, 10)) { diag.jobsClaimed++; d.lastRun = diag; writeRemoteHaulAudit(home, remoteAudit); return localCollect; }

  var reqs = (Memory.__BHM && Memory.__BHM.remoteHaulRequests) || {};
  var remoteJobs = [];
  for (var id in reqs) {
    if (!reqs.hasOwnProperty(id)) continue;
    var r = reqs[id];
    if (!r || r.homeRoom !== home) continue;
    remoteAudit.activeRequests++;
    if (CFG.shouldBlockRemoteHaulForMaintenance(r)) { diag.skippedMaintenance++; remoteAudit.skippedMaintenance++; continue; }
    if (isRemoteRequestReservedByOther(r, creep.name)) { diag.skippedReserved++; remoteAudit.skippedReserved++; continue; }
    if ((r.amount || 0) < CFG.MIN_HAUL_REQUEST_ENERGY) { diag.skippedLowAmount++; remoteAudit.skippedLowAmount++; continue; }
    if ((Game.time - (r.updated || 0)) > CFG.REQUEST_STALE_TICKS) { diag.skippedStale++; remoteAudit.skippedStale++; continue; }
    var sourceDecision = getActiveSourceDecision(home, r);
    if (!sourceDecision.active) { diag.skippedInactiveSource++; remoteAudit.skippedInactiveSource++; continue; }
    var remoteRoom = r.roomName || r.remoteRoom;
    if (isRemoteRoomUnsafeForTrucker(remoteRoom)) { diag.skippedUnsafe++; remoteAudit.skippedUnsafe++; continue; }
    if (!canCreepSafelyTakeRemoteJob(creep, remoteRoom)) { diag.skippedRemoteTTL++; remoteAudit.skippedTTL++; continue; }
    var distance = estimateRemoteRequestDistance(home, r);
    var score = scoreRemoteRequestForCreep(creep, r);
    if (score.skipReason === 'expected-low') {
      diag.skippedExpectedLow++;
      remoteAudit.skippedExpectedLow++;
      if (remoteAudit.evaluated) remoteAudit.evaluated.push({ requestId: id, skipped: score.skipReason, expectedEnergy: score.expectedEnergy, distance: score.distance });
      continue;
    }
    var targetType = r.targetType || 'container';
    var j = { id: 'remote:' + id, type: 'REMOTE_PICKUP', requestId: id, roomName: remoteRoom, targetType: targetType, targetId: r.targetId || r.resourceId || r.containerId || null, resourceId: r.resourceId || null, containerId: targetType === 'container' ? r.containerId : null, sourceId: r.sourceId, x: r.x, y: r.y, urgent: !!r.urgent, amount: r.amount || 0, distance: distance, score: score.score || 0, expectedEnergy: score.expectedEnergy || (r.amount || 0), haulAmount: score.haulAmount || 0, arrivalTicks: score.arrivalTicks || 0, ttlMargin: score.ttlMargin, sourceDecision: score.sourceDecision || sourceDecision.reason, maxAssignments: getRemoteRequestMaxAssignments(r) };
    if (remoteAudit.evaluated) remoteAudit.evaluated.push({ requestId: id, roomName: remoteRoom, amount: j.amount, expectedEnergy: j.expectedEnergy, score: j.score, distance: j.distance, sourceDecision: j.sourceDecision });
    diag.jobsSeen++; diag.remoteJobs++;
    remoteJobs.push(j);
  }
  remoteJobs.sort(function (a, b) {
    if (a.urgent !== b.urgent) return a.urgent ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    if ((b.expectedEnergy || 0) !== (a.expectedEnergy || 0)) return (b.expectedEnergy || 0) - (a.expectedEnergy || 0);
    if ((a.distance || 0) !== (b.distance || 0)) return (a.distance || 0) - (b.distance || 0);
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
  });
  for (var ri = 0; ri < remoteJobs.length; ri++) {
    var remoteJob = remoteJobs[ri];
    // Dispatch claims can race after scoring; keep trying lower-scored valid
    // requests before falling back to local hauling.
    if (!claimJob(creep, remoteJob, CFG.RESERVATION_TTL)) {
      diag.skippedClaimedJob++;
      remoteAudit.skippedClaimedJob++;
      continue;
    }
    diag.jobsClaimed++;
    remoteAudit.selectedRequestId = remoteJob.requestId || null;
    remoteAudit.selectedTargetType = remoteJob.targetType || null;
    remoteAudit.selectedRemoteRoom = remoteJob.roomName || null;
    remoteAudit.selectedAmount = remoteJob.amount || 0;
    remoteAudit.selectedExpectedEnergy = remoteJob.expectedEnergy || 0;
    remoteAudit.selectedArrivalTicks = remoteJob.arrivalTicks || 0;
    remoteAudit.selectedHaulAmount = remoteJob.haulAmount || 0;
    remoteAudit.selectedTtlMargin = remoteJob.ttlMargin;
    remoteAudit.selectedSourceDecision = remoteJob.sourceDecision || null;
    remoteAudit.selectedScore = remoteJob.score || 0;
    remoteAudit.selectedDistance = remoteJob.distance || null;
    d.lastRun = diag;
    writeRemoteHaulAudit(home, remoteAudit);
    return remoteJob;
  }

  if (claimJob(creep, localCollect, 10)) { diag.jobsClaimed++; d.lastRun = diag; writeRemoteHaulAudit(home, remoteAudit); return localCollect; }

  diag.jobsSeen++; diag.localJobs++;
  var localDeliver = { id: 'localDeliver:' + home, type: 'LOCAL_DELIVER', homeRoom: home };
  claimJob(creep, localDeliver, 10);
  d.lastRun = diag;
  writeRemoteHaulAudit(home, remoteAudit);
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
  cleanupRemoteHaulRequestsForHome: cleanupRemoteHaulRequestsForHome,
  getLocalContainerPressure: getLocalContainerPressure,
  chooseJobForTrucker: chooseJobForTrucker
};
