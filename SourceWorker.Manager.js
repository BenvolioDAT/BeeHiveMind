'use strict';

// Shared source-worker helpers for Veinseeker home and remote mining.
// Keep role routing/behavior in role.Veinseeker.* files; this module owns the
// source-adjacent mechanics and Memory schemas shared by spawn, trucker, scout,
// and repair systems.
var CFG = require('role.Veinseeker.Config');
var BeeToolbox = require('BeeToolbox');

function getSourceIdFromMemory(mem) {
  if (!mem) return null;
  return mem.assignedSource || mem.sourceId || mem.replaceSourceId || mem.replacementTargetSourceId || null;
}

function getQueueSourceId(item) {
  if (!item) return null;
  return item.sourceId || item.assignedSource || item.replaceSourceId || item.replacementTargetSourceId || null;
}

function getCreepHomeRoomName(creep) {
  if (!creep) return null;
  if (creep.memory && creep.memory.home) return creep.memory.home;
  if (creep.memory && creep.memory._home) return creep.memory._home;
  if (creep.room && creep.room.name) return creep.room.name;
  return null;
}

function isVeinseekerMemory(mem) {
  if (!mem) return false;
  var role = mem.role ? String(mem.role).toLowerCase() : '';
  var task = mem.task ? String(mem.task).toLowerCase() : '';
  return role === 'veinseeker' || task === 'veinseeker';
}

function isVeinseekerRoleMemory(mem) {
  return !!(mem && mem.role && String(mem.role).toLowerCase() === 'veinseeker');
}

function isVeinseekerQueueItem(item) {
  return item && String(item.role || '').toLowerCase() === 'veinseeker' && item.mode !== 'remote';
}

function getCreepBodyParts(creep) {
  var parts = [];
  if (!creep || !creep.body) return parts;
  for (var i = 0; i < creep.body.length; i++) {
    if (creep.body[i] && creep.body[i].type) parts.push(creep.body[i].type);
  }
  return parts;
}

function getCreepBodyCost(creep) {
  if (!creep) return 0;
  var memCost = creep.memory && typeof creep.memory.bornBodyCost === 'number'
    ? creep.memory.bornBodyCost
    : 0;
  var parts = getCreepBodyParts(creep);
  if (parts.length) return BeeToolbox.calculateBodyCost(parts);
  return memCost;
}

function getCreepBodySignature(creep) {
  if (!creep) return '';
  var parts = getCreepBodyParts(creep);
  if (parts.length) return BeeToolbox.getBodySignature(parts);
  return creep.memory && creep.memory.bornBodySignature ? creep.memory.bornBodySignature : '';
}

function getDesiredBodyPlan(room, spawnLogic) {
  if (!room || !spawnLogic || typeof spawnLogic.getBestBodyPlanForRoomCapacity !== 'function') return null;
  return spawnLogic.getBestBodyPlanForRoomCapacity('Veinseeker', room, { mode: 'home' });
}

function makeBodyPlanDiag(plan) {
  if (!plan) {
    return { cost: 0, signature: '', summary: null, tierIndex: -1 };
  }
  return {
    cost: plan.cost || 0,
    signature: plan.signature || '',
    summary: plan.summary || null,
    tierIndex: typeof plan.tierIndex === 'number' ? plan.tierIndex : -1
  };
}

function isHomeVeinseekerSafelyHarvesting(creep, source, opts) {
  var safeTtl = opts && typeof opts.safeTtl === 'number'
    ? opts.safeTtl
    : (CFG.VEINSEEKER_REPLACEMENT_SAFE_TTL || 120);
  if (!creep || !source || !creep.memory) return false;
  if (creep.spawning) return false;
  if (!isVeinseekerRoleMemory(creep.memory)) return false;
  if (creep.memory.mode === 'remote') return false;
  if (getSourceIdFromMemory(creep.memory) !== source.id) return false;
  if (typeof creep.ticksToLive === 'number' && creep.ticksToLive < safeTtl) return false;
  if (!creep.pos || creep.pos.roomName !== source.pos.roomName) return false;
  return creep.pos.getRangeTo(source) <= 1;
}

function createHomeCoverageRecord() {
  return {
    live: 0,
    queued: 0,
    hasCoverage: false,
    emergencyNeeded: false,
    upgradeNeeded: false,
    bestLiveCost: 0,
    bestLiveName: null,
    replacementQueued: false,
    reason: 'not-evaluated',
    activeLive: 0,
    bestLiveSignature: '',
    bestSafeLiveName: null,
    bestSafeLiveCost: 0,
    lowestTtlName: null,
    lowestTtl: null,
    replacementInProgress: false
  };
}

function getRoomQueue(roomName, opts) {
  if (opts && typeof opts.ensureRoomQueue === 'function') return opts.ensureRoomQueue(roomName);
  return (Memory.rooms && Memory.rooms[roomName] && Memory.rooms[roomName].spawnQueue) || [];
}

function writeHomeCoverageDiag(roomName, diag, opts) {
  if (opts && opts.writeDiag === false) return;
  if (!roomName) return;
  if (opts && typeof opts.ensureRoomMemory === 'function') {
    opts.ensureRoomMemory(roomName).lastVeinseekerBodyPlan = diag;
    return;
  }
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
  Memory.rooms[roomName].lastVeinseekerBodyPlan = diag;
}

function buildHomeCoverageReport(room, opts) {
  opts = opts || {};
  var roomName = room && room.name;
  var desiredPlan = getDesiredBodyPlan(room, opts.spawnLogic);
  var diag = {
    tick: Game.time,
    roomName: roomName || null,
    energyAvailable: room ? room.energyAvailable : 0,
    energyCapacityAvailable: room ? room.energyCapacityAvailable : 0,
    desiredPlan: makeBodyPlanDiag(desiredPlan),
    sources: {},
    decisions: []
  };
  if (!roomName || !room) return { desiredPlan: desiredPlan, diag: diag, sources: [] };

  var sources = room.find(FIND_SOURCES) || [];
  for (var s = 0; s < sources.length; s++) diag.sources[sources[s].id] = createHomeCoverageRecord();

  var q = getRoomQueue(roomName, opts);
  for (var qi = 0; qi < q.length; qi++) {
    var item = q[qi];
    if (!isVeinseekerQueueItem(item)) continue;
    var qSourceId = getQueueSourceId(item);
    if (!qSourceId || !diag.sources[qSourceId]) {
      diag.decisions.push({ action: 'ignoreQueuedVeinseeker', reason: 'missing-or-unknown-source', queueIndex: qi });
      continue;
    }
    var qRec = diag.sources[qSourceId];
    qRec.queued++;
    if (item.sourceWorkerSpawnMode === 'upgradeReplacement' || item.replaceCreepName || item.replacementFor) {
      qRec.replacementQueued = true;
    }
  }

  for (var name in Game.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Game.creeps, name)) continue;
    var creep = Game.creeps[name];
    if (!creep || !creep.my || !creep.memory) continue;
    if (!isVeinseekerRoleMemory(creep.memory) || creep.memory.mode === 'remote') continue;
    if (getCreepHomeRoomName(creep) !== roomName) continue;
    var sourceId = getSourceIdFromMemory(creep.memory);
    if (!sourceId || !diag.sources[sourceId]) continue;

    var rec = diag.sources[sourceId];
    rec.live++;
    if (!creep.spawning) {
      rec.activeLive++;
      rec.hasCoverage = true;
    }

    var bodyCost = getCreepBodyCost(creep);
    if (bodyCost > rec.bestLiveCost) {
      rec.bestLiveCost = bodyCost;
      rec.bestLiveName = creep.name;
      rec.bestLiveSignature = getCreepBodySignature(creep);
    }

    var ttl = typeof creep.ticksToLive === 'number' ? creep.ticksToLive : null;
    if (ttl !== null && (rec.lowestTtl === null || ttl < rec.lowestTtl)) {
      rec.lowestTtl = ttl;
      rec.lowestTtlName = creep.name;
    }

    if (creep.memory.sourceWorkerSpawnMode === 'upgradeReplacement' && creep.memory.replacementFor) {
      rec.replacementInProgress = true;
      rec.replacementQueued = true;
    }

    var source = Game.getObjectById(sourceId);
    if (source && isHomeVeinseekerSafelyHarvesting(creep, source, opts) && bodyCost > rec.bestSafeLiveCost) {
      rec.bestSafeLiveCost = bodyCost;
      rec.bestSafeLiveName = creep.name;
    }
  }

  for (var si = 0; si < sources.length; si++) {
    var sid = sources[si].id;
    var srcRec = diag.sources[sid];
    srcRec.emergencyNeeded = srcRec.live <= 0 && srcRec.queued <= 0;
    if (desiredPlan && srcRec.bestSafeLiveName && desiredPlan.cost > srcRec.bestLiveCost &&
        !srcRec.replacementQueued && !srcRec.replacementInProgress) {
      srcRec.upgradeNeeded = true;
    }
    if (srcRec.emergencyNeeded) srcRec.reason = 'no-active-veinseeker-coverage';
    else if (srcRec.upgradeNeeded) srcRec.reason = 'safe-live-body-below-room-capacity-plan';
    else if (srcRec.replacementQueued) srcRec.reason = 'replacement-already-queued-or-active';
    else if (srcRec.queued > 0 && srcRec.activeLive <= 0) srcRec.reason = 'waiting-for-queued-veinseeker';
    else if (srcRec.live > 0 && srcRec.activeLive <= 0) srcRec.reason = 'veinseeker-spawning';
    else srcRec.reason = 'covered';
  }

  writeHomeCoverageDiag(roomName, diag, opts);
  return { desiredPlan: desiredPlan, diag: diag, sources: sources };
}

function sourceHasLiveHomeCoverage(roomName, sourceId) {
  if (!roomName || !sourceId) return false;
  for (var name in Game.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Game.creeps, name)) continue;
    var creep = Game.creeps[name];
    if (!creep || !creep.my || !creep.memory) continue;
    if (!isVeinseekerRoleMemory(creep.memory) || creep.memory.mode === 'remote') continue;
    if (getCreepHomeRoomName(creep) !== roomName) continue;
    if (getSourceIdFromMemory(creep.memory) !== sourceId) continue;
    if (creep.spawning) continue;
    return true;
  }
  return false;
}

function roomHasHomeEmergency(room) {
  if (!room) return false;
  var sources = room.find(FIND_SOURCES) || [];
  for (var i = 0; i < sources.length; i++) {
    if (!sourceHasLiveHomeCoverage(room.name, sources[i].id)) return true;
  }
  return false;
}

function isWalkable(pos) {
  if (!pos || !pos.roomName) return false;
  if (pos.x <= 0 || pos.x >= 49 || pos.y <= 0 || pos.y >= 49) return false;
  var terrain = new Room.Terrain(pos.roomName);
  return terrain.get(pos.x, pos.y) !== TERRAIN_MASK_WALL;
}

function isTileOccupiedByAlly(pos, myName) {
  if (!pos || typeof pos.lookFor !== 'function') return false;
  var creeps = pos.lookFor(LOOK_CREEPS);
  for (var i = 0; i < creeps.length; i++) {
    var c = creeps[i];
    if (c.my && c.name !== myName) return true;
  }
  return false;
}

function isTileOccupiedByAnyCreep(pos, myName) {
  if (!pos || typeof pos.lookFor !== 'function') return false;
  var creeps = pos.lookFor(LOOK_CREEPS);
  for (var i = 0; i < creeps.length; i++) {
    var c = creeps[i];
    if (!c) continue;
    if (!myName || c.name !== myName) return true;
  }
  return false;
}

function countWalkableSeatsAround(pos) {
  if (!pos || !pos.roomName) return 0;
  var seats = 0;
  var terrain = new Room.Terrain(pos.roomName);
  for (var dx = -1; dx <= 1; dx++) {
    for (var dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      var x = pos.x + dx;
      var y = pos.y + dy;
      if (x <= 0 || x >= 49 || y <= 0 || y >= 49) continue;
      if (terrain.get(x, y) !== TERRAIN_MASK_WALL) seats++;
    }
  }
  return seats;
}

function findSourceContainer(source) {
  if (!source || !source.pos) return null;
  var containers = source.pos.findInRange(FIND_STRUCTURES, 1, {
    filter: function (s) { return s.structureType === STRUCTURE_CONTAINER; }
  });
  return containers.length ? containers[0] : null;
}

function findSourceContainerSite(source) {
  if (!source || !source.pos) return null;
  var sites = source.pos.findInRange(FIND_CONSTRUCTION_SITES, 1, {
    filter: function (cs) { return cs.structureType === STRUCTURE_CONTAINER; }
  });
  return sites.length ? sites[0] : null;
}

function chooseSourceContainerBuildPosition(source) {
  if (!source || !source.pos || !source.room) return null;
  var terrain = source.room.getTerrain();
  var best = null;
  for (var dx = -1; dx <= 1; dx++) {
    for (var dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      var x = source.pos.x + dx;
      var y = source.pos.y + dy;
      if (x < 1 || x > 48 || y < 1 || y > 48) continue;
      if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
      var blocked = false;
      var look = source.room.lookAt(x, y);
      for (var i = 0; i < look.length; i++) {
        var item = look[i];
        if (item.type === 'structure' && item.structure &&
            item.structure.structureType !== STRUCTURE_CONTAINER &&
            item.structure.structureType !== STRUCTURE_ROAD &&
            item.structure.structureType !== STRUCTURE_RAMPART) {
          blocked = true;
          break;
        }
        if (item.type === 'constructionSite' && item.constructionSite &&
            item.constructionSite.structureType !== STRUCTURE_CONTAINER &&
            item.constructionSite.structureType !== STRUCTURE_ROAD) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      var range = source.pos.getRangeTo(x, y);
      if (!best || range < best.range) best = { x: x, y: y, roomName: source.pos.roomName, range: range };
    }
  }
  return best;
}

function ensureSourceContainerOrSite(source) {
  var container = findSourceContainer(source);
  if (container) return { container: container, site: null, plannedPos: container.pos };
  var site = findSourceContainerSite(source);
  if (site) return { container: null, site: site, plannedPos: site.pos };
  var pos = chooseSourceContainerBuildPosition(source);
  if (pos) {
    var rc = source.room.createConstructionSite(pos.x, pos.y, STRUCTURE_CONTAINER);
    if (rc === OK || rc === ERR_INVALID_TARGET) site = findSourceContainerSite(source);
  }
  return { container: null, site: site || null, plannedPos: pos || null };
}

function getPreferredSeatPos(source) {
  var container = findSourceContainer(source);
  if (container) return container.pos;
  if (!source || !source.pos) return null;
  var candidates = [];
  for (var dx = -1; dx <= 1; dx++) {
    for (var dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      var p = new RoomPosition(source.pos.x + dx, source.pos.y + dy, source.pos.roomName);
      if (isWalkable(p)) candidates.push(p);
    }
  }
  if (!candidates.length) return null;
  candidates.sort(function (a, b) { return (a.y - b.y) || (a.x - b.x); });
  return candidates[0];
}

function getSourceSeatCount(source, maxHarvestersPerSource) {
  if (!source || !source.pos) return 0;
  var seats = findSourceContainer(source) ? 1 : countWalkableSeatsAround(source.pos);
  var max = typeof maxHarvestersPerSource === 'number'
    ? maxHarvestersPerSource
    : (CFG.MAX_HARVESTERS_PER_SOURCE || 0);
  if (max > 0) seats = Math.min(seats, max);
  return seats;
}

function countOpenHarvestTiles(source) {
  if (!source || !source.pos || !source.room) return 1;
  var terrain = source.room.getTerrain();
  var count = 0;
  for (var dx = -1; dx <= 1; dx++) {
    for (var dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      var x = source.pos.x + dx;
      var y = source.pos.y + dy;
      if (x < 1 || x > 48 || y < 1 || y > 48) continue;
      if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;

      var look = source.room.lookAt(x, y);
      var blocked = false;
      for (var i = 0; i < look.length; i++) {
        var item = look[i];
        if (item.type === LOOK_STRUCTURES || item.type === 'structure') {
          var s = item.structure;
          if (s.structureType === STRUCTURE_RAMPART && !s.my) { blocked = true; break; }
          if (s.structureType !== STRUCTURE_ROAD && s.structureType !== STRUCTURE_CONTAINER && s.structureType !== STRUCTURE_RAMPART) {
            blocked = true; break;
          }
        }
        if (item.type === LOOK_CONSTRUCTION_SITES || item.type === 'constructionSite') {
          var cs = item.constructionSite;
          if (cs.structureType !== STRUCTURE_ROAD && cs.structureType !== STRUCTURE_CONTAINER) {
            blocked = true; break;
          }
        }
      }
      if (!blocked) count++;
    }
  }
  return count;
}

function getSourceMaxSlots(sourceId, targetRoom, opts) {
  opts = opts || {};
  if (!sourceId) return 0;
  if (targetRoom && opts.isRemoteUnsafe && opts.isRemoteUnsafe(targetRoom)) return 0;

  if (targetRoom && opts.requireFreshIntel) {
    var intelTick = opts.getRemoteIntelTick ? opts.getRemoteIntelTick(targetRoom) : null;
    var intelTtl = opts.intelTtl || (CFG.VEINSEEKER_REMOTE_INTEL_TTL || 3000);
    if (!Game.rooms[targetRoom] && (intelTick == null || (Game.time - intelTick) > intelTtl)) return 0;
  }

  var allowMulti = opts.allowMulti != null ? opts.allowMulti : !(CFG.ALLOW_MULTI_VEINSEEKER_PER_SOURCE === false);
  if (!allowMulti) return 1;
  var maxSlots = Math.max(1, opts.maxPerSource || CFG.MAX_VEINSEEKER_PER_SOURCE || 1);
  var source = Game.getObjectById(sourceId);
  if (!source || !source.pos || !source.room) return 1;
  var minOpenForExtra = opts.minOpenForExtra || CFG.MIN_OPEN_HARVEST_TILES_PER_EXTRA_VEINSEEKER || 2;
  var openTiles = countOpenHarvestTiles(source);
  if (openTiles < minOpenForExtra) return 1;
  return Math.min(maxSlots, openTiles);
}

function isContainerForSource(container, source) {
  if (!container || !source || !container.pos || !source.pos) return false;
  if (container.structureType !== STRUCTURE_CONTAINER) return false;
  if (container.pos.roomName !== source.pos.roomName) return false;
  return container.pos.inRangeTo(source.pos, 1);
}

function findAssignedSourceContainer(creep, source, opts) {
  if (!creep || !source) return null;
  opts = opts || {};
  var memContainerId = creep.memory.containerId || creep.memory.assignedContainer;
  if (memContainerId) {
    var direct = Game.getObjectById(memContainerId);
    if (isContainerForSource(direct, source)) return direct;
    delete creep.memory.containerId;
    delete creep.memory.assignedContainer;
  }
  var sid = creep.memory.sourceId || source.id;
  if (sid && typeof opts.getSourceMemory === 'function') {
    var roomName = creep.memory.targetRoom || creep.pos.roomName;
    var srec = opts.getSourceMemory(roomName, sid);
    if (srec && srec.containerId) {
      var fromSourceMem = Game.getObjectById(srec.containerId);
      if (isContainerForSource(fromSourceMem, source)) return fromSourceMem;
      delete srec.containerId;
    }
  }
  return findSourceContainer(source);
}

function ensureRemoteHaulRequestsMemory() {
  if (!Memory.__BHM) Memory.__BHM = {};
  if (!Memory.__BHM.remoteHaulRequests) Memory.__BHM.remoteHaulRequests = {};
  return Memory.__BHM.remoteHaulRequests;
}

function ensureRemoteContainerStatusMemory() {
  if (!Memory.__BHM) Memory.__BHM = {};
  if (!Memory.__BHM.remoteContainerStatus) Memory.__BHM.remoteContainerStatus = {};
  return Memory.__BHM.remoteContainerStatus;
}

function ensureRemoteContainerBuildMemory() {
  if (!Memory.__BHM) Memory.__BHM = {};
  if (!Memory.__BHM.remoteContainerBuilds) Memory.__BHM.remoteContainerBuilds = {};
  return Memory.__BHM.remoteContainerBuilds;
}

function computeConstructionProgressPct(site) {
  if (!site || !(site.progressTotal > 0)) return 0;
  var pct = Math.floor((site.progress / site.progressTotal) * 100);
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  return pct;
}

function resolveHomeName(creep, opts) {
  if (opts && typeof opts.getHomeName === 'function') return opts.getHomeName(creep);
  return getCreepHomeRoomName(creep);
}

function isRoomUnsafe(roomName, opts) {
  if (opts && typeof opts.isRoomUnsafe === 'function') return opts.isRoomUnsafe(roomName);
  return false;
}

function clearStaleRemoteContainerRepairMemory(sourceId, remoteRoom) {
  if (!sourceId || !remoteRoom) return;
  var status = ensureRemoteContainerStatusMemory();
  var requests = ensureRemoteHaulRequestsMemory();
  var targetIdentity = BeeToolbox.getRemoteContainerIdentity({ sourceId: sourceId, remoteRoom: remoteRoom });
  for (var key in status) {
    if (!Object.prototype.hasOwnProperty.call(status, key)) continue;
    var entry = status[key];
    if (!entry) continue;
    var entryIdentity = BeeToolbox.getRemoteContainerIdentity(entry);
    var sameSourceRoom = targetIdentity.sourceId === entryIdentity.sourceId && targetIdentity.remoteRoom === entryIdentity.remoteRoom;
    if (!sameSourceRoom) continue;
    if (BeeToolbox.isLiveContainerId(entryIdentity.containerId)) continue;
    delete status[key];
    if (entryIdentity.containerId && requests[entryIdentity.containerId]) delete requests[entryIdentity.containerId];
    if (requests[key]) delete requests[key];
  }
}

function upsertRemoteContainerBuildStatus(creep, source, container, site, plannedPos, opts) {
  if (!creep || !source) return;
  var homeName = resolveHomeName(creep, opts);
  var remoteRoom = creep.memory && creep.memory.targetRoom ? creep.memory.targetRoom : (source.pos && source.pos.roomName);
  if (!homeName || !remoteRoom || remoteRoom === homeName) return;

  var pos = (container && container.pos) || (site && site.pos) || plannedPos || (source && source.pos) || null;
  var status = 'missing';
  var progress = 0;
  var progressTotal = 0;
  var progressPct = 0;

  if (container) {
    status = 'built';
    progress = 1;
    progressTotal = 1;
    progressPct = 100;
  } else if (site) {
    status = 'building';
    progress = site.progress || 0;
    progressTotal = site.progressTotal || 0;
    progressPct = computeConstructionProgressPct(site);
  } else if (plannedPos) {
    status = 'planned';
  }

  if (status === 'building' || status === 'planned' || status === 'missing') {
    clearStaleRemoteContainerRepairMemory(source.id, remoteRoom);
  }

  var builds = ensureRemoteContainerBuildMemory();
  var prev = builds[source.id] || {};
  builds[source.id] = {
    sourceId: source.id,
    homeRoom: homeName,
    remoteRoom: remoteRoom,
    roomName: pos ? pos.roomName : (prev.roomName || remoteRoom),
    x: pos && typeof pos.x === 'number' ? pos.x : (typeof prev.x === 'number' ? prev.x : null),
    y: pos && typeof pos.y === 'number' ? pos.y : (typeof prev.y === 'number' ? prev.y : null),
    siteId: site ? site.id : null,
    containerId: container ? container.id : null,
    status: status,
    progress: progress,
    progressTotal: progressTotal,
    progressPct: progressPct,
    assignedVeinseeker: creep.name || null,
    updated: Game.time,
    lastSeen: Game.time
  };

  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[remoteRoom]) Memory.rooms[remoteRoom] = {};
  if (!Memory.rooms[remoteRoom].sources) Memory.rooms[remoteRoom].sources = {};
  if (!Memory.rooms[remoteRoom].sources[source.id]) Memory.rooms[remoteRoom].sources[source.id] = {};
  Memory.rooms[remoteRoom].sources[source.id].container = {
    status: status,
    x: builds[source.id].x,
    y: builds[source.id].y,
    siteId: site ? site.id : null,
    containerId: container ? container.id : null,
    progress: progress,
    progressTotal: progressTotal,
    progressPct: progressPct,
    updated: Game.time
  };
}

function upsertRemoteContainerStatus(creep, source, container, opts) {
  if (!creep || !source || !container) return;
  var homeName = resolveHomeName(creep, opts);
  if (!homeName || container.pos.roomName === homeName) return;
  var status = ensureRemoteContainerStatusMemory();
  var key = container.id || source.id;
  var prev = status[key] || {};
  var amount = container.store ? (container.store[RESOURCE_ENERGY] || 0) : 0;
  var capacity = container.store ? (container.store.getCapacity(RESOURCE_ENERGY) || 2000) : 2000;
  status[key] = {
    id: container.id,
    homeRoom: homeName,
    remoteRoom: container.pos.roomName,
    roomName: container.pos.roomName,
    sourceId: source.id,
    containerId: container.id,
    x: container.pos.x,
    y: container.pos.y,
    amount: amount,
    capacity: capacity,
    containerHits: container.hits || 0,
    containerHitsMax: container.hitsMax || 0,
    containerHitsPct: container.hitsMax > 0 ? container.hits / container.hitsMax : 1,
    status: 'built',
    updated: Game.time,
    maintenanceUntil: prev.maintenanceUntil || 0,
    maintenanceBy: prev.maintenanceBy || null,
    maintenanceReason: prev.maintenanceReason || null
  };
}

function upsertRemoteHaulRequest(creep, source, container, opts) {
  if (!creep || !source || !container) return;
  var homeName = resolveHomeName(creep, opts);
  if (!homeName || container.pos.roomName === homeName) return;
  var minAmount = CFG.REMOTE_CONTAINER_REQUEST_MIN || 300;
  var urgentThreshold = CFG.REMOTE_CONTAINER_REQUEST_URGENT || 1600;
  var amount = container.store ? (container.store[RESOURCE_ENERGY] || 0) : 0;
  var requests = ensureRemoteHaulRequestsMemory();
  var id = container.id || source.id;
  if (amount < minAmount || isRoomUnsafe(container.pos.roomName, opts)) {
    delete requests[id];
    return;
  }
  var capacity = container.store.getCapacity(RESOURCE_ENERGY) || 2000;
  var prev = requests[id] || {};
  requests[id] = {
    id: id,
    homeRoom: homeName,
    remoteRoom: container.pos.roomName,
    sourceId: source.id,
    targetType: 'container',
    targetId: container.id,
    containerId: container.id,
    amount: amount,
    capacity: capacity,
    fillPct: capacity > 0 ? amount / capacity : 0,
    x: container.pos.x,
    y: container.pos.y,
    roomName: container.pos.roomName,
    urgent: amount >= urgentThreshold || (amount / Math.max(1, capacity)) >= 0.8,
    updated: Game.time,
    containerHits: container.hits || 0,
    containerHitsMax: container.hitsMax || 0,
    containerHitsPct: container.hitsMax > 0 ? (container.hits / container.hitsMax) : 1,
    assignedTo: prev.assignedTo || null,
    assignedUntil: prev.assignedUntil || 0,
    maintenanceUntil: prev.maintenanceUntil || 0,
    maintenanceBy: prev.maintenanceBy || null,
    maintenanceReason: prev.maintenanceReason || null
  };
}

function upsertRemoteLooseHaulRequest(creep, source, target, targetType, opts) {
  if (!creep || !source || !target || !target.pos || !targetType) return;
  var homeName = resolveHomeName(creep, opts);
  var roomName = target.pos.roomName;
  if (!homeName || roomName === homeName || isRoomUnsafe(roomName, opts)) return;
  var amount = 0;
  if (targetType === 'dropped') amount = target.amount || 0;
  else if (target.store) amount = target.store[RESOURCE_ENERGY] || 0;
  var minAmount = CFG.REMOTE_CONTAINER_REQUEST_MIN || 300;
  var urgentThreshold = CFG.REMOTE_CONTAINER_REQUEST_URGENT || 1600;
  var requests = ensureRemoteHaulRequestsMemory();
  var id = targetType + ':' + target.id;
  if (amount < minAmount) {
    delete requests[id];
    return;
  }
  var prev = requests[id] || {};
  requests[id] = {
    id: id,
    homeRoom: homeName,
    remoteRoom: roomName,
    roomName: roomName,
    sourceId: source.id,
    targetType: targetType,
    targetId: target.id,
    resourceId: targetType === 'dropped' ? target.id : null,
    containerId: null,
    amount: amount,
    capacity: targetType === 'dropped' ? amount : null,
    fillPct: targetType === 'dropped' ? 1 : null,
    x: target.pos.x,
    y: target.pos.y,
    urgent: amount >= urgentThreshold,
    updated: Game.time,
    assignedTo: prev.assignedTo || null,
    assignedUntil: prev.assignedUntil || 0,
    maintenanceUntil: prev.maintenanceUntil || 0,
    maintenanceBy: prev.maintenanceBy || null,
    maintenanceReason: prev.maintenanceReason || null
  };
}

function publishRemoteLooseEnergyRequests(creep, source, container, opts) {
  if (!source || !source.pos || !source.room) return;
  var anchors = [{ pos: source.pos, range: 3 }];
  if (container && container.pos) anchors.push({ pos: container.pos, range: 2 });
  for (var i = 0; i < anchors.length; i++) {
    var anchor = anchors[i];
    var drops = anchor.pos.findInRange(FIND_DROPPED_RESOURCES, anchor.range, {
      filter: function (r) { return r.resourceType === RESOURCE_ENERGY; }
    }) || [];
    for (var d = 0; d < drops.length; d++) upsertRemoteLooseHaulRequest(creep, source, drops[d], 'dropped', opts);
    var tombstones = anchor.pos.findInRange(FIND_TOMBSTONES, anchor.range, {
      filter: function (t) { return t.store && (t.store[RESOURCE_ENERGY] || 0) > 0; }
    }) || [];
    for (var t = 0; t < tombstones.length; t++) upsertRemoteLooseHaulRequest(creep, source, tombstones[t], 'tombstone', opts);
    if (typeof FIND_RUINS !== 'undefined') {
      var ruins = anchor.pos.findInRange(FIND_RUINS, anchor.range, {
        filter: function (r) { return r.store && (r.store[RESOURCE_ENERGY] || 0) > 0; }
      }) || [];
      for (var r = 0; r < ruins.length; r++) upsertRemoteLooseHaulRequest(creep, source, ruins[r], 'ruin', opts);
    }
  }
}

function markContainerRepairMaintenanceHold(creep, container, source) {
  if (!creep || !container) return;
  var requests = ensureRemoteHaulRequestsMemory();
  var key = container.id || (source && source.id);
  if (!key || !requests[key]) return;
  requests[key].maintenanceUntil = Game.time + (CFG.remoteContainerRepairHoldTicks || 25);
  requests[key].maintenanceBy = creep.name;
  requests[key].maintenanceReason = 'containerRepair';
}

module.exports = {
  getSourceIdFromMemory: getSourceIdFromMemory,
  getQueueSourceId: getQueueSourceId,
  getCreepHomeRoomName: getCreepHomeRoomName,
  isVeinseekerMemory: isVeinseekerMemory,
  buildHomeCoverageReport: buildHomeCoverageReport,
  isHomeVeinseekerSafelyHarvesting: isHomeVeinseekerSafelyHarvesting,
  sourceHasLiveHomeCoverage: sourceHasLiveHomeCoverage,
  roomHasHomeEmergency: roomHasHomeEmergency,
  isWalkable: isWalkable,
  isTileOccupiedByAlly: isTileOccupiedByAlly,
  isTileOccupiedByAnyCreep: isTileOccupiedByAnyCreep,
  countWalkableSeatsAround: countWalkableSeatsAround,
  findSourceContainer: findSourceContainer,
  findSourceContainerSite: findSourceContainerSite,
  chooseSourceContainerBuildPosition: chooseSourceContainerBuildPosition,
  ensureSourceContainerOrSite: ensureSourceContainerOrSite,
  getPreferredSeatPos: getPreferredSeatPos,
  getSourceSeatCount: getSourceSeatCount,
  countOpenHarvestTiles: countOpenHarvestTiles,
  getSourceMaxSlots: getSourceMaxSlots,
  isContainerForSource: isContainerForSource,
  findAssignedSourceContainer: findAssignedSourceContainer,
  ensureRemoteHaulRequestsMemory: ensureRemoteHaulRequestsMemory,
  ensureRemoteContainerStatusMemory: ensureRemoteContainerStatusMemory,
  ensureRemoteContainerBuildMemory: ensureRemoteContainerBuildMemory,
  clearStaleRemoteContainerRepairMemory: clearStaleRemoteContainerRepairMemory,
  upsertRemoteContainerBuildStatus: upsertRemoteContainerBuildStatus,
  upsertRemoteContainerStatus: upsertRemoteContainerStatus,
  upsertRemoteHaulRequest: upsertRemoteHaulRequest,
  upsertRemoteLooseHaulRequest: upsertRemoteLooseHaulRequest,
  publishRemoteLooseEnergyRequests: publishRemoteLooseEnergyRequests,
  markContainerRepairMaintenanceHold: markContainerRepairMaintenanceHold
};
