'use strict';

// Shared source-worker helpers for Veinseeker home and remote mining.
// Keep role routing/behavior in role.Veinseeker.* files; this module owns the
// source-adjacent mechanics and Memory schemas shared by spawn, trucker, scout,
// and repair systems.
var CFG = require('role.Veinseeker.Config');
var BeeToolbox = require('BeeToolbox');
var BodyUtils = require('core.body');
var Roles = require('core.roles');

var HOME_SOURCE_MAX_VEINSEEKERS_PER_SOURCE = 3;

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
  return Roles.canonicalRoleName(mem.role) === 'Veinseeker' ||
    Roles.canonicalRoleName(mem.task) === 'Veinseeker';
}

function isVeinseekerQueueItem(item) {
  return item && Roles.canonicalRoleName(item.role) === 'Veinseeker' && item.mode !== 'remote';
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
  if (parts.length) return BodyUtils.calculateBodyCost(parts);
  return memCost;
}

function getCreepBodySignature(creep) {
  if (!creep) return '';
  var parts = getCreepBodyParts(creep);
  if (parts.length) return BodyUtils.getBodySignature(parts);
  return creep.memory && creep.memory.bornBodySignature ? creep.memory.bornBodySignature : '';
}

function getWorkPartConstant() {
  return typeof WORK === 'undefined' ? 'work' : WORK;
}

function countWorkPartsInBody(body) {
  if (!body || !body.length) return 0;
  return BodyUtils.countBodyParts(body, getWorkPartConstant());
}

function countWorkPartsInSignature(signature) {
  if (!signature) return 0;
  var workPart = String(getWorkPartConstant());
  var parts = String(signature).split('|');
  var count = 0;
  for (var i = 0; i < parts.length; i++) {
    if (parts[i] === workPart) count++;
  }
  return count;
}

function getCreepAssignedWorkParts(creep) {
  if (!creep) return 0;
  var parts = getCreepBodyParts(creep);
  if (parts.length) return countWorkPartsInBody(parts);
  if (creep.memory && creep.memory.bornBodySummary &&
      typeof creep.memory.bornBodySummary.work === 'number') {
    return creep.memory.bornBodySummary.work;
  }
  if (creep.memory && creep.memory.bornBodySignature) {
    return countWorkPartsInSignature(creep.memory.bornBodySignature);
  }
  if (typeof creep.getActiveBodyparts === 'function') {
    return creep.getActiveBodyparts(getWorkPartConstant());
  }
  return 0;
}

function getCreepActiveWorkParts(creep) {
  if (!creep) return 0;
  if (typeof creep.getActiveBodyparts === 'function') {
    return creep.getActiveBodyparts(getWorkPartConstant());
  }
  return getCreepAssignedWorkParts(creep);
}

function getQueuedItemWorkParts(item, desiredPlan) {
  if (item && item.desiredBodySummary && typeof item.desiredBodySummary.work === 'number') {
    return item.desiredBodySummary.work;
  }
  if (item && item.body && item.body.length) return countWorkPartsInBody(item.body);
  if (item && item.desiredBodySignature) {
    var fromSignature = countWorkPartsInSignature(item.desiredBodySignature);
    if (fromSignature > 0) return fromSignature;
  }
  if (desiredPlan && desiredPlan.summary && typeof desiredPlan.summary.work === 'number') {
    return desiredPlan.summary.work;
  }
  if (desiredPlan && desiredPlan.body && desiredPlan.body.length) {
    return countWorkPartsInBody(desiredPlan.body);
  }
  return 1;
}

function getHomeSourceSlotLimit(rawSeatCount) {
  rawSeatCount = Math.max(0, rawSeatCount || 0);
  if (rawSeatCount <= 0) return 0;
  return Math.min(rawSeatCount, HOME_SOURCE_MAX_VEINSEEKERS_PER_SOURCE);
}

function getPlannedWorkPerHomeMiner(desiredPlan) {
  var work = getQueuedItemWorkParts(null, desiredPlan);
  return Math.max(1, work || 1);
}

function getHomeSourceSeatPolicy(source) {
  var rawSeats = source ? buildHarvestSeatList(source) : [];
  var rawSeatCount = rawSeats.length;
  return {
    rawSeats: rawSeatCount,
    seats: getHomeSourceSlotLimit(rawSeatCount)
  };
}

function getDesiredWorkForSource(source) {
  var energyCapacity = null;
  if (source && typeof source.energyCapacity === 'number' && source.energyCapacity > 0) {
    energyCapacity = source.energyCapacity;
  } else if (typeof SOURCE_ENERGY_CAPACITY === 'number' && SOURCE_ENERGY_CAPACITY > 0) {
    energyCapacity = SOURCE_ENERGY_CAPACITY;
  } else {
    energyCapacity = 3000;
  }
  var regenTime = typeof ENERGY_REGEN_TIME === 'number' ? ENERGY_REGEN_TIME : 300;
  var harvestPower = typeof HARVEST_POWER === 'number' ? HARVEST_POWER : 2;
  if (regenTime <= 0 || harvestPower <= 0) return 0;
  return Math.ceil(energyCapacity / regenTime / harvestPower);
}

function countLiveAssignedWork(roomName, sourceId) {
  if (!roomName || !sourceId) return 0;
  var total = 0;
  for (var name in Game.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Game.creeps, name)) continue;
    var creep = Game.creeps[name];
    if (!creep || !creep.my || !creep.memory) continue;
    if (!isVeinseekerMemory(creep.memory) || creep.memory.mode === 'remote') continue;
    if (creep.spawning) continue;
    if (getCreepHomeRoomName(creep) !== roomName) continue;
    if (getSourceIdFromMemory(creep.memory) !== sourceId) continue;
    total += getCreepActiveWorkParts(creep);
  }
  return total;
}

function countQueuedAssignedWork(roomName, sourceId, desiredPlan) {
  if (!roomName || !sourceId) return 0;
  var total = 0;
  var q = getRoomQueue(roomName, null);
  for (var i = 0; i < q.length; i++) {
    var item = q[i];
    if (!isVeinseekerQueueItem(item)) continue;
    if (getQueueSourceId(item) !== sourceId) continue;
    total += getQueuedItemWorkParts(item, desiredPlan);
  }
  return total;
}

function getLiveAssignedWorkForSource(roomName, sourceId) {
  return countLiveAssignedWork(roomName, sourceId);
}

function getQueuedAssignedWorkForSource(roomName, sourceId, desiredPlan) {
  return countQueuedAssignedWork(roomName, sourceId, desiredPlan);
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
  if (!isVeinseekerMemory(creep.memory)) return false;
  if (creep.memory.mode === 'remote') return false;
  if (getSourceIdFromMemory(creep.memory) !== source.id) return false;
  if (typeof creep.ticksToLive === 'number' && creep.ticksToLive < safeTtl) return false;
  if (!creep.pos || creep.pos.roomName !== source.pos.roomName) return false;
  return creep.pos.getRangeTo(source) <= 1;
}

function createHomeCoverageRecord() {
  return {
    sourceId: null,
    rawSeats: 0,
    seats: 0,
    live: 0,
    queued: 0,
    liveWork: 0,
    queuedWork: 0,
    spawnPending: 0,
    spawnPendingWork: 0,
    desiredSourceWork: 0,
    desiredWork: 0,
    freeWork: 0,
    plannedWorkPerMiner: 0,
    saturatedByWork: false,
    saturatedBySeats: false,
    hasOpenSeat: false,
    selectedSeat: null,
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

function getSeatPosFromMemory(mem) {
  if (!mem) return null;
  if (typeof mem.seatX !== 'number' ||
      typeof mem.seatY !== 'number' ||
      !mem.seatRoom) {
    return null;
  }
  return new RoomPosition(mem.seatX, mem.seatY, mem.seatRoom);
}

function serializeSeat(pos) {
  if (!pos) return null;
  return { x: pos.x, y: pos.y, roomName: pos.roomName };
}

function collectReservedHarvestSeats(roomName, sourceId, excludeName) {
  var reserved = {};
  if (!roomName || !sourceId) return reserved;
  for (var name in Game.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Game.creeps, name)) continue;
    if (excludeName && name === excludeName) continue;
    var creep = Game.creeps[name];
    if (!creep || !creep.my || !creep.memory) continue;
    if (!isVeinseekerMemory(creep.memory) || creep.memory.mode === 'remote') continue;
    if (getCreepHomeRoomName(creep) !== roomName) continue;
    if (getSourceIdFromMemory(creep.memory) !== sourceId) continue;
    var seat = getSeatPosFromMemory(creep.memory);
    if (!seat) continue;
    reserved[getHarvestSeatKey(seat)] = creep.name;
  }
  return reserved;
}

function applySourceMiningRecordTotals(rec) {
  rec.freeWork = Math.max(0, rec.desiredWork - rec.liveWork - rec.queuedWork);
  rec.saturatedByWork = rec.desiredWork > 0 && (rec.liveWork + rec.queuedWork) >= rec.desiredWork;
  rec.saturatedBySeats = rec.seats <= 0 || (rec.live + rec.queued) >= rec.seats;
  rec.hasOpenSeat = !!rec.selectedSeat && !rec.saturatedBySeats;
  rec.hasCoverage = rec.liveWork > 0;
  rec.emergencyNeeded = rec.liveWork <= 0 && rec.queuedWork <= 0 &&
    rec.desiredWork > 0 && rec.seats > 0 && rec.hasOpenSeat;

  if (rec.seats <= 0) rec.reason = 'no-harvest-seats';
  else if (rec.replacementQueued || rec.replacementInProgress) rec.reason = 'replacement-already-queued-or-active';
  else if (rec.queued > 0 && rec.liveWork <= 0) rec.reason = 'waiting-for-queued-veinseeker';
  else if (rec.emergencyNeeded) rec.reason = 'emergency-needed';
  else if (rec.saturatedByWork) rec.reason = 'source-work-saturated';
  else if (rec.saturatedBySeats) rec.reason = 'source-seat-saturated';
  else if (rec.freeWork > 0) rec.reason = 'source-work-deficit';
  else rec.reason = 'covered';
}

function getSourceMiningStatus(roomName, source, desiredPlan, opts) {
  opts = opts || {};
  var sourceId = source && source.id ? source.id : (opts.sourceId || null);
  var rec = createHomeCoverageRecord();
  rec.sourceId = sourceId;
  var seatPolicy = getHomeSourceSeatPolicy(source);
  rec.rawSeats = seatPolicy.rawSeats;
  rec.seats = seatPolicy.seats;
  rec.plannedWorkPerMiner = getPlannedWorkPerHomeMiner(desiredPlan);
  rec.desiredSourceWork = getDesiredWorkForSource(source);
  rec.desiredWork = Math.min(
    rec.desiredSourceWork,
    rec.seats * rec.plannedWorkPerMiner
  );

  if (roomName && sourceId) {
    var q = getRoomQueue(roomName, opts);
    for (var qi = 0; qi < q.length; qi++) {
      if (opts.excludeQueueIndex === qi) continue;
      var item = q[qi];
      if (!isVeinseekerQueueItem(item)) continue;
      if (getQueueSourceId(item) !== sourceId) continue;
      rec.queued++;
      rec.queuedWork += getQueuedItemWorkParts(item, desiredPlan);
      if (item.sourceWorkerSpawnMode === 'upgradeReplacement' || item.replaceCreepName || item.replacementFor) {
        rec.replacementQueued = true;
      }
    }

    for (var name in Game.creeps) {
      if (!Object.prototype.hasOwnProperty.call(Game.creeps, name)) continue;
      var creep = Game.creeps[name];
      if (!creep || !creep.my || !creep.memory) continue;
      if (!isVeinseekerMemory(creep.memory) || creep.memory.mode === 'remote') continue;
      if (getCreepHomeRoomName(creep) !== roomName) continue;
      if (getSourceIdFromMemory(creep.memory) !== sourceId) continue;

      if (creep.spawning) {
        var pendingWork = getCreepAssignedWorkParts(creep) || getCreepActiveWorkParts(creep);
        rec.queued++;
        rec.spawnPending++;
        rec.spawnPendingWork += pendingWork;
        rec.queuedWork += pendingWork;
        if (creep.memory.sourceWorkerSpawnMode === 'upgradeReplacement' ||
            creep.memory.replaceCreepName || creep.memory.replacementFor) {
          rec.replacementInProgress = true;
          rec.replacementQueued = true;
        }
        continue;
      }

      rec.live++;
      rec.activeLive++;
      rec.liveWork += getCreepActiveWorkParts(creep);

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

      if (source && isHomeVeinseekerSafelyHarvesting(creep, source, opts) && bodyCost > rec.bestSafeLiveCost) {
        rec.bestSafeLiveCost = bodyCost;
        rec.bestSafeLiveName = creep.name;
      }
    }
  }

  var reserved = collectReservedHarvestSeats(roomName, sourceId, opts.excludeCreepName || opts.creepName || null);
  var selectedSeat = source ? chooseOpenHarvestSeat(source, opts.creepName || null, reserved) : null;
  rec.selectedSeat = serializeSeat(selectedSeat);
  applySourceMiningRecordTotals(rec);

  if (desiredPlan && rec.bestSafeLiveName && desiredPlan.cost > rec.bestLiveCost &&
      rec.freeWork > 0 && !rec.saturatedBySeats &&
      !rec.replacementQueued && !rec.replacementInProgress) {
    rec.upgradeNeeded = true;
    rec.reason = 'safe-live-body-below-room-capacity-plan';
  }

  return rec;
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
  var knownSources = {};
  for (var s = 0; s < sources.length; s++) {
    var sourceForRecord = sources[s];
    var record = getSourceMiningStatus(roomName, sourceForRecord, desiredPlan, opts);
    diag.sources[sourceForRecord.id] = record;
    knownSources[sourceForRecord.id] = true;
  }

  var q = getRoomQueue(roomName, opts);
  for (var qi = 0; qi < q.length; qi++) {
    var item = q[qi];
    if (!isVeinseekerQueueItem(item)) continue;
    var qSourceId = getQueueSourceId(item);
    if (!qSourceId || !knownSources[qSourceId]) {
      diag.decisions.push({ action: 'ignoreQueuedVeinseeker', reason: 'missing-or-unknown-source', queueIndex: qi });
    }
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
    if (!isVeinseekerMemory(creep.memory) || creep.memory.mode === 'remote') continue;
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

function getHarvestSeatKey(pos) {
  if (!pos) return '';
  return pos.roomName + ':' + pos.x + ':' + pos.y;
}

function isHarvestSeatWalkable(pos) {
  if (!isWalkable(pos)) return false;
  var room = Game.rooms[pos.roomName];
  if (!room) return true;
  var look = room.lookAt(pos.x, pos.y);
  for (var i = 0; i < look.length; i++) {
    var item = look[i];
    if (item.type === LOOK_STRUCTURES || item.type === 'structure') {
      var structure = item.structure;
      if (structure.structureType === STRUCTURE_RAMPART && !structure.my) return false;
      if (structure.structureType !== STRUCTURE_ROAD &&
          structure.structureType !== STRUCTURE_CONTAINER &&
          structure.structureType !== STRUCTURE_RAMPART) {
        return false;
      }
    }
    if (item.type === LOOK_CONSTRUCTION_SITES || item.type === 'constructionSite') {
      var site = item.constructionSite;
      if (site.structureType !== STRUCTURE_ROAD && site.structureType !== STRUCTURE_CONTAINER) return false;
    }
  }
  return true;
}

function buildRawHarvestSeatList(source) {
  var seats = [];
  if (!source || !source.pos) return seats;
  for (var dx = -1; dx <= 1; dx++) {
    for (var dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      var pos = new RoomPosition(source.pos.x + dx, source.pos.y + dy, source.pos.roomName);
      if (isHarvestSeatWalkable(pos)) seats.push(pos);
    }
  }
  seats.sort(function (a, b) { return (a.y - b.y) || (a.x - b.x); });
  return seats;
}

function ensureSourceMemoryForSource(source) {
  if (!source || !source.pos || !source.id) return null;
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[source.pos.roomName]) Memory.rooms[source.pos.roomName] = {};
  if (!Memory.rooms[source.pos.roomName].sources) Memory.rooms[source.pos.roomName].sources = {};
  if (!Memory.rooms[source.pos.roomName].sources[source.id]) Memory.rooms[source.pos.roomName].sources[source.id] = {};
  return Memory.rooms[source.pos.roomName].sources[source.id];
}

function writeContainerPlacementDiag(source, selectedPos, coveredSeats, totalSeats, candidateCount, reason, extra) {
  var srec = ensureSourceMemoryForSource(source);
  if (!srec) return;
  var diag = {
    tick: Game.time,
    selected: serializeSeat(selectedPos),
    coveredSeats: coveredSeats || 0,
    totalSeats: totalSeats || 0,
    candidateCount: candidateCount || 0,
    reason: reason || 'unknown'
  };
  if (extra) {
    for (var key in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, key)) diag[key] = extra[key];
    }
  }
  srec.containerPlacement = diag;
}

function writeContainerSeatProblem(source, anchor, totalSeats, reason) {
  var srec = ensureSourceMemoryForSource(source);
  if (!srec) return;
  srec.containerSeatProblem = {
    tick: Game.time,
    reason: reason || 'no-container-compatible-harvest-seats',
    anchor: anchor && anchor.pos ? serializeSeat(anchor.pos) : null,
    anchorType: anchor && anchor.type ? anchor.type : null,
    totalSeats: totalSeats || 0
  };
}

function clearContainerSeatProblem(source) {
  var srec = ensureSourceMemoryForSource(source);
  if (srec && srec.containerSeatProblem) delete srec.containerSeatProblem;
}

function isValidSourceContainerTile(source, pos) {
  if (!source || !source.pos || !pos || !pos.roomName) return false;
  if (pos.roomName !== source.pos.roomName) return false;
  if (pos.x <= 0 || pos.x >= 49 || pos.y <= 0 || pos.y >= 49) return false;
  if (pos.isEqualTo(source.pos) || pos.getRangeTo(source.pos) > 1) return false;

  var terrain = source.room && typeof source.room.getTerrain === 'function'
    ? source.room.getTerrain()
    : new Room.Terrain(pos.roomName);
  if (terrain.get(pos.x, pos.y) === TERRAIN_MASK_WALL) return false;

  var room = source.room || Game.rooms[pos.roomName];
  if (!room || typeof room.lookAt !== 'function') return true;
  var look = room.lookAt(pos.x, pos.y);
  for (var i = 0; i < look.length; i++) {
    var item = look[i];
    if (item.type === LOOK_STRUCTURES || item.type === 'structure') {
      var structure = item.structure;
      if (!structure) continue;
      if (structure.structureType === STRUCTURE_RAMPART && !structure.my) return false;
      if (structure.structureType !== STRUCTURE_ROAD &&
          structure.structureType !== STRUCTURE_CONTAINER &&
          structure.structureType !== STRUCTURE_RAMPART) {
        return false;
      }
    }
    if (item.type === LOOK_CONSTRUCTION_SITES || item.type === 'constructionSite') {
      var site = item.constructionSite;
      if (site && site.structureType !== STRUCTURE_CONTAINER) return false;
    }
  }
  return true;
}

function countContainerCompatibleSeats(containerPos, seats) {
  if (!containerPos || !seats || !seats.length) return 0;
  var count = 0;
  for (var i = 0; i < seats.length; i++) {
    var seat = seats[i];
    if (!seat || seat.roomName !== containerPos.roomName) continue;
    if (seat.getRangeTo(containerPos) <= 1) count++;
  }
  return count;
}

function buildSourceContainerCandidateList(source, seats) {
  var candidates = [];
  if (!source || !source.pos) return candidates;
  seats = seats || buildRawHarvestSeatList(source);
  var seatKeys = {};
  for (var si = 0; si < seats.length; si++) {
    seatKeys[getHarvestSeatKey(seats[si])] = true;
  }
  var terrain = source.room && typeof source.room.getTerrain === 'function'
    ? source.room.getTerrain()
    : new Room.Terrain(source.pos.roomName);

  for (var dx = -1; dx <= 1; dx++) {
    for (var dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      var pos = new RoomPosition(source.pos.x + dx, source.pos.y + dy, source.pos.roomName);
      if (!isValidSourceContainerTile(source, pos)) continue;
      var terrainMask = terrain ? terrain.get(pos.x, pos.y) : null;
      candidates.push({
        pos: pos,
        coveredSeats: countContainerCompatibleSeats(pos, seats),
        isHarvestSeat: !!seatKeys[getHarvestSeatKey(pos)],
        isPlain: terrainMask === 0,
        terrain: terrainMask
      });
    }
  }

  candidates.sort(function (a, b) {
    if (b.coveredSeats !== a.coveredSeats) return b.coveredSeats - a.coveredSeats;
    if (b.isHarvestSeat !== a.isHarvestSeat) return b.isHarvestSeat ? 1 : -1;
    if (b.isPlain !== a.isPlain) return b.isPlain ? 1 : -1;
    return (a.pos.y - b.pos.y) || (a.pos.x - b.pos.x);
  });
  return candidates;
}

function selectBestSourceContainerCandidate(source, seats) {
  var candidates = buildSourceContainerCandidateList(source, seats);
  if (!candidates.length) return null;
  var best = candidates[0];
  best.candidateCount = candidates.length;
  best.totalSeats = seats ? seats.length : 0;
  return best;
}

function getBadSiteRelocationDecision(site, best, currentCovered) {
  if (!site || !best) return { relocate: false, gain: 0, reason: 'missing-site-or-candidate' };
  var gain = best.coveredSeats - currentCovered;
  var minGain = typeof CFG.VEINSEEKER_MIN_CONTAINER_SEAT_COVERAGE_GAIN_TO_RELOCATE === 'number'
    ? CFG.VEINSEEKER_MIN_CONTAINER_SEAT_COVERAGE_GAIN_TO_RELOCATE
    : 2;
  if (gain < minGain) return { relocate: false, gain: gain, reason: 'site-coverage-acceptable' };
  if (CFG.VEINSEEKER_RELOCATE_BAD_CONTAINER_SITES === false) {
    return { relocate: false, gain: gain, reason: 'relocation-disabled' };
  }
  var maxProgress = typeof CFG.VEINSEEKER_BAD_CONTAINER_SITE_MAX_PROGRESS === 'number'
    ? CFG.VEINSEEKER_BAD_CONTAINER_SITE_MAX_PROGRESS
    : 250;
  var progress = site.progress || 0;
  if (progress > maxProgress) {
    return { relocate: false, gain: gain, reason: 'site-not-optimal-progress-too-high' };
  }
  if (site.my === false) {
    return { relocate: false, gain: gain, reason: 'site-not-owned' };
  }
  return { relocate: true, gain: gain, reason: 'relocate-low-progress-site' };
}

function getExistingContainerCoverageDiag(best, currentCovered) {
  if (!best || !best.pos || best.coveredSeats <= currentCovered) return null;
  return {
    warning: 'existing-container-covers-fewer-seats-than-best-candidate',
    bestCandidate: serializeSeat(best.pos),
    bestCoveredSeats: best.coveredSeats || 0,
    coverageGap: (best.coveredSeats || 0) - (currentCovered || 0)
  };
}

function getBestSourceContainerAnchor(source) {
  if (!source || !source.pos) return null;
  var seats = buildRawHarvestSeatList(source);
  var best = selectBestSourceContainerCandidate(source, seats);
  var candidateCount = best ? best.candidateCount : 0;
  var container = findSourceContainer(source);
  if (container && container.pos) {
    var containerCovered = countContainerCompatibleSeats(container.pos, seats);
    writeContainerPlacementDiag(source, container.pos, containerCovered, seats.length, candidateCount, 'existing-container',
      getExistingContainerCoverageDiag(best, containerCovered));
    return {
      type: 'container',
      container: container,
      site: null,
      pos: container.pos,
      plannedPos: container.pos,
      coveredSeats: containerCovered,
      totalSeats: seats.length,
      candidateCount: candidateCount,
      best: best
    };
  }

  var site = findSourceContainerSite(source);
  if (site && site.pos) {
    var siteCovered = countContainerCompatibleSeats(site.pos, seats);
    var decision = getBadSiteRelocationDecision(site, best, siteCovered);
    var extra = {};
    if (decision.reason === 'site-not-optimal-progress-too-high') {
      extra.warning = 'site-not-optimal-progress-too-high';
    }
    writeContainerPlacementDiag(source, site.pos, siteCovered, seats.length, candidateCount, 'existing-container-site', extra);
    return {
      type: 'site',
      container: null,
      site: site,
      pos: site.pos,
      plannedPos: site.pos,
      coveredSeats: siteCovered,
      totalSeats: seats.length,
      candidateCount: candidateCount,
      best: best,
      relocationDecision: decision
    };
  }

  if (!best) {
    writeContainerPlacementDiag(source, null, 0, seats.length, 0, 'no-valid-container-candidate');
    return null;
  }
  writeContainerPlacementDiag(source, best.pos, best.coveredSeats, seats.length, best.candidateCount, 'planned-best-seat-coverage');
  return {
    type: 'planned',
    container: null,
    site: null,
    pos: best.pos,
    plannedPos: best.pos,
    coveredSeats: best.coveredSeats,
    totalSeats: seats.length,
    candidateCount: best.candidateCount,
    best: best
  };
}

function buildContainerCompatibleHarvestSeatList(source) {
  var seats = buildRawHarvestSeatList(source);
  var anchor = getBestSourceContainerAnchor(source);
  if (!anchor || !anchor.pos) return seats;
  var compatible = [];
  for (var i = 0; i < seats.length; i++) {
    if (seats[i].getRangeTo(anchor.pos) <= 1) compatible.push(seats[i]);
  }
  compatible.sort(function (a, b) { return (a.y - b.y) || (a.x - b.x); });
  return compatible;
}

function buildHarvestSeatList(source) {
  var rawSeats = buildRawHarvestSeatList(source);
  if (!source || !source.pos) return rawSeats;
  var anchor = getBestSourceContainerAnchor(source);
  if (anchor && anchor.pos) {
    var compatible = [];
    for (var i = 0; i < rawSeats.length; i++) {
      if (rawSeats[i].getRangeTo(anchor.pos) <= 1) compatible.push(rawSeats[i]);
    }
    compatible.sort(function (a, b) { return (a.y - b.y) || (a.x - b.x); });
    if (compatible.length) {
      clearContainerSeatProblem(source);
      return compatible;
    }
    writeContainerSeatProblem(source, anchor, rawSeats.length, 'no-compatible-seats-for-container-anchor');
  }
  return rawSeats;
}

function chooseOpenHarvestSeat(source, creepName, reservedSeats) {
  var seats = buildHarvestSeatList(source);
  for (var i = 0; i < seats.length; i++) {
    var seat = seats[i];
    var reservedBy = reservedSeats ? reservedSeats[getHarvestSeatKey(seat)] : null;
    if (reservedBy && reservedBy !== creepName) continue;
    if (isTileOccupiedByAnyCreep(seat, creepName)) continue;
    return seat;
  }
  return null;
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
  containers.sort(function (a, b) { return (a.pos.y - b.pos.y) || (a.pos.x - b.pos.x); });
  return containers.length ? containers[0] : null;
}

function findSourceContainerSite(source) {
  if (!source || !source.pos) return null;
  var sites = source.pos.findInRange(FIND_CONSTRUCTION_SITES, 1, {
    filter: function (cs) { return cs.structureType === STRUCTURE_CONTAINER; }
  });
  sites.sort(function (a, b) { return (a.pos.y - b.pos.y) || (a.pos.x - b.pos.x); });
  return sites.length ? sites[0] : null;
}

function chooseSourceContainerBuildPosition(source) {
  if (!source || !source.pos || !source.room) return null;
  var seats = buildRawHarvestSeatList(source);
  var best = selectBestSourceContainerCandidate(source, seats);
  if (!best) {
    writeContainerPlacementDiag(source, null, 0, seats.length, 0, 'no-valid-container-candidate');
    return null;
  }
  writeContainerPlacementDiag(source, best.pos, best.coveredSeats, seats.length, best.candidateCount, 'planned-best-seat-coverage');
  return best.pos;
}

function ensureSourceContainerOrSite(source) {
  var container = findSourceContainer(source);
  if (container) {
    var containerSeats = buildRawHarvestSeatList(source);
    var containerBest = selectBestSourceContainerCandidate(source, containerSeats);
    var containerCovered = countContainerCompatibleSeats(container.pos, containerSeats);
    writeContainerPlacementDiag(source, container.pos, containerCovered, containerSeats.length,
      containerBest ? containerBest.candidateCount : 0, 'existing-container',
      getExistingContainerCoverageDiag(containerBest, containerCovered));
    return { container: container, site: null, plannedPos: container.pos };
  }
  var site = findSourceContainerSite(source);
  if (site) {
    var seats = buildRawHarvestSeatList(source);
    var best = selectBestSourceContainerCandidate(source, seats);
    var siteCovered = countContainerCompatibleSeats(site.pos, seats);
    var decision = getBadSiteRelocationDecision(site, best, siteCovered);
    if (decision.relocate && best && best.pos) {
      var removeResult = site.remove();
      if (removeResult === OK) {
        var createResult = source.room.createConstructionSite(best.pos.x, best.pos.y, STRUCTURE_CONTAINER);
        var relocatedSite = findSourceContainerSite(source);
        writeContainerPlacementDiag(source, best.pos, best.coveredSeats, seats.length, best.candidateCount, 'planned-best-seat-coverage', {
          action: 'relocated-low-progress-site',
          previous: serializeSeat(site.pos)
        });
        return { container: null, site: relocatedSite || null, plannedPos: best.pos, createResult: createResult };
      }
    }
    var extra = {};
    if (decision.reason === 'site-not-optimal-progress-too-high') {
      extra.warning = 'site-not-optimal-progress-too-high';
    }
    writeContainerPlacementDiag(source, site.pos, siteCovered, seats.length, best ? best.candidateCount : 0, 'existing-container-site', extra);
    return { container: null, site: site, plannedPos: site.pos };
  }
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
  var policy = getHomeSourceSeatPolicy(source);
  var seats = policy.seats || 0;
  if (seats <= 0 && countWalkableSeatsAround(source.pos) > 0) {
    seats = getHomeSourceSlotLimit(countWalkableSeatsAround(source.pos));
  }
  var max = typeof maxHarvestersPerSource === 'number'
    ? maxHarvestersPerSource
    : 0;
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
  var assignedTo = null;
  var assignedUntil = 0;
  if (prev.assignedTo && prev.assignedUntil && prev.assignedUntil > Game.time && Game.creeps[prev.assignedTo]) {
    assignedTo = prev.assignedTo;
    assignedUntil = prev.assignedUntil;
  }
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
    assignedTo: assignedTo,
    assignedUntil: assignedUntil,
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
  var assignedTo = null;
  var assignedUntil = 0;
  if (prev.assignedTo && prev.assignedUntil && prev.assignedUntil > Game.time && Game.creeps[prev.assignedTo]) {
    assignedTo = prev.assignedTo;
    assignedUntil = prev.assignedUntil;
  }
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
    assignedTo: assignedTo,
    assignedUntil: assignedUntil,
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
  getDesiredWorkForSource: getDesiredWorkForSource,
  countLiveAssignedWork: countLiveAssignedWork,
  countQueuedAssignedWork: countQueuedAssignedWork,
  getLiveAssignedWorkForSource: getLiveAssignedWorkForSource,
  getQueuedAssignedWorkForSource: getQueuedAssignedWorkForSource,
  getSourceMiningStatus: getSourceMiningStatus,
  buildHomeCoverageReport: buildHomeCoverageReport,
  isHomeVeinseekerSafelyHarvesting: isHomeVeinseekerSafelyHarvesting,
  sourceHasLiveHomeCoverage: sourceHasLiveHomeCoverage,
  roomHasHomeEmergency: roomHasHomeEmergency,
  isWalkable: isWalkable,
  getHarvestSeatKey: getHarvestSeatKey,
  buildRawHarvestSeatList: buildRawHarvestSeatList,
  isValidSourceContainerTile: isValidSourceContainerTile,
  countContainerCompatibleSeats: countContainerCompatibleSeats,
  getBestSourceContainerAnchor: getBestSourceContainerAnchor,
  buildContainerCompatibleHarvestSeatList: buildContainerCompatibleHarvestSeatList,
  buildHarvestSeatList: buildHarvestSeatList,
  chooseOpenHarvestSeat: chooseOpenHarvestSeat,
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
