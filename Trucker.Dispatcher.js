'use strict';

var CFG = require('role.Trucker.Config');

function ensureDispatchMemory() {
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

function canCreepSafelyTakeRemoteJob(creep, remoteRoom) {
  if (!creep || !remoteRoom) return false;
  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) return true;
  if (typeof creep.ticksToLive !== 'number') return true;
  var required = estimateRemoteRoundTripTicks(creep.memory.home, remoteRoom);
  return creep.ticksToLive >= required;
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

function chooseJobForTrucker(creep) {
  var d = cleanupDispatchMemory();
  var home = creep.memory.home || creep.room.name;
  var diag = { tick: Game.time, jobsSeen: 0, jobsClaimed: 0, localJobs: 0, remoteJobs: 0, skippedRemoteTTL: 0, skippedNoVision: 0, skippedUnsafe: 0, assignedByCreep: d.assignedByCreep || {} };

  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
    return { id: 'return:' + creep.name, type: 'REMOTE_RETURN', homeRoom: home };
  }

  var reqs = (Memory.__BHM && Memory.__BHM.remoteHaulRequests) || {};
  var best = null;
  for (var id in reqs) {
    if (!reqs.hasOwnProperty(id)) continue;
    var r = reqs[id];
    if (!r || r.homeRoom !== home) continue;
    if ((r.amount || 0) < CFG.MIN_HAUL_REQUEST_ENERGY) continue;
    if ((Game.time - (r.updated || 0)) > CFG.REQUEST_STALE_TICKS) continue;
    var remoteRoom = r.roomName || r.remoteRoom;
    if (!canCreepSafelyTakeRemoteJob(creep, remoteRoom)) { diag.skippedRemoteTTL++; continue; }
    var j = { id: 'remote:' + id, type: 'REMOTE_PICKUP', requestId: id, roomName: remoteRoom, containerId: r.containerId, sourceId: r.sourceId, x: r.x, y: r.y, urgent: !!r.urgent, amount: r.amount || 0 };
    diag.jobsSeen++; diag.remoteJobs++;
    if (!best || (j.urgent && !best.urgent) || (j.amount > best.amount)) best = j;
  }
  if (best && claimJob(creep, best, CFG.RESERVATION_TTL)) { diag.jobsClaimed++; d.lastRun = diag; return best; }

  diag.jobsSeen++; diag.localJobs++;
  var localCollect = { id: 'localCollect:' + home, type: 'LOCAL_COLLECT', homeRoom: home };
  if (claimJob(creep, localCollect, 10)) { diag.jobsClaimed++; d.lastRun = diag; return localCollect; }

  diag.jobsSeen++; diag.localJobs++;
  var localDeliver = { id: 'localDeliver:' + home, type: 'LOCAL_DELIVER', homeRoom: home };
  claimJob(creep, localDeliver, 10);
  d.lastRun = diag;
  return localDeliver;
}

module.exports = {
  ensureDispatchMemory: ensureDispatchMemory,
  normalizeSourceContainerRecord: normalizeSourceContainerRecord,
  refreshContainerRecordFromVision: refreshContainerRecordFromVision,
  estimateRemoteRoundTripTicks: estimateRemoteRoundTripTicks,
  canCreepSafelyTakeRemoteJob: canCreepSafelyTakeRemoteJob,
  claimJob: claimJob,
  releaseJob: releaseJob,
  cleanupDispatchMemory: cleanupDispatchMemory,
  chooseJobForTrucker: chooseJobForTrucker
};
