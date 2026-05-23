'use strict';

// -----------------------------------------------------------------------------
// RemoteHarvest.Manager.js - remote mining planning and diagnostics authority
// Owns:
// * Memory.__BHM.remoteHarvest.homes[homeRoom], including source records,
//   desiredLuna, liveLuna, queuedLuna, missing/stale/unsafe source lists, and
//   queue reservations.
// * Memory.rooms[homeRoom].lastRemoteHarvestPlan and
//   Memory.rooms[homeRoom].lastRemoteSourceEconomics for human-readable audits.
// Reads:
// * Memory.rooms[remoteRoom].sources/intel/scout data written by Scouts, Luna,
//   BeeToolbox, and maintenance.
// * Memory.__BHM.scoutIntel.homes from role.Scout.Logic.js.
// * Memory.rooms[homeRoom].spawnQueue to count queued Luna reservations.
// Usually called by:
// * BeeSpawnManager.prepareRoomQueues(), before it computes Luna quota and
//   enqueues role jobs.
// Used by:
// * role.Luna.Logic.js to claim/release live source ownership.
// * BeeSpawnManager.js to reserve/unreserve a source for a queued Luna.
// Do not casually change:
// * Reservation TTLs, source status names, or the distinction between
//   diagnostic reports and behavior-changing queue/assignment state.
// -----------------------------------------------------------------------------

var LunaConfig = require('role.Luna.Config');
var RoadPlanner = require('Planner.Road');
var BeeToolbox = require('BeeToolbox');
var BodyConfig = require('Spawn.BodyConfig');

var RESERVE_TTL = 100;
// Economics diagnostics are intentionally estimates. They explain "why this
// source looks good/bad" without changing source selection, spawn queues, or
// remote hauling behavior.
var REMOTE_SOURCE_ENERGY_REGEN_TICKS = 300;
var DEFAULT_NEUTRAL_SOURCE_ENERGY_CAPACITY = 1500;
var DEFAULT_RESERVED_SOURCE_ENERGY_CAPACITY = 3000;
var DEFAULT_KEEPER_SOURCE_ENERGY_CAPACITY = 4000;
var DEFAULT_CONTAINER_REPAIR_ENERGY_PER_TICK = 0.10;
var ROLE_CONFIGS = BodyConfig && BodyConfig.ROLE_CONFIGS ? BodyConfig.ROLE_CONFIGS : {};

function ensureMemory() {
  // Root Memory bucket for remote-harvest planning. This is not creep memory;
  // it is the home-room plan BeeSpawnManager reads before queuing Luna creeps.
  if (!Memory.__BHM) Memory.__BHM = {};
  if (!Memory.__BHM.remoteHarvest) {
    Memory.__BHM.remoteHarvest = { tick: Game.time, homes: {} };
  }
  if (!Memory.__BHM.remoteHarvest.homes) Memory.__BHM.remoteHarvest.homes = {};
  Memory.__BHM.remoteHarvest.tick = Game.time;
  return Memory.__BHM.remoteHarvest;
}

function ensureHomeMemory(homeRoom) {
  // One home owns one remote-harvest plan. Source records here are the source
  // of truth for desiredLuna, live/queued counts, and queue reservations.
  var root = ensureMemory();
  if (!root.homes[homeRoom]) {
    root.homes[homeRoom] = {
      sources: {}, desiredLuna: 0, liveLuna: 0, queuedLuna: 0,
      missingSources: [], unsafeSources: [], staleSources: [], duplicateSources: [], lastAudit: Game.time
    };
  }
  var rec = root.homes[homeRoom];
  if (!rec.sources) rec.sources = {};
  if (!rec.missingSources) rec.missingSources = [];
  if (!rec.unsafeSources) rec.unsafeSources = [];
  if (!rec.staleSources) rec.staleSources = [];
  if (!rec.duplicateSources) rec.duplicateSources = [];
  return rec;
}

function getRoomMemoryBucket(roomName) {
  return BeeToolbox.getRoomMemoryBucket(roomName);
}

function refreshVisibleRemoteSafety(room) {
  return BeeToolbox.refreshVisibleRemoteSafety(room);
}

function isRemoteUnsafe(remoteName) {
  // Candidate filtering handles intel owner/reservation gates explicitly.
  // Keep this wrapper aligned with prior behavior by ignoring intel ownership
  // inside the shared helper used for generic room-level danger checks.
  return BeeToolbox.isRemoteRoomUnsafe(remoteName, {
    invaderLockTtl: (LunaConfig && LunaConfig.INVADER_LOCK_MEMO_TTL) || 1500,
    ignoreIntelOwnership: true
  });
}

function getMyUsername() {
  for (var name in Game.spawns) {
    if (!Object.prototype.hasOwnProperty.call(Game.spawns, name)) continue;
    var spawn = Game.spawns[name];
    if (!spawn || !spawn.owner || !spawn.owner.username) continue;
    return spawn.owner.username;
  }
  return null;
}

function getRemoteIntelTick(remoteName) {
  return BeeToolbox.getBestRemoteIntelTick(remoteName);
}





function isLocalOwnedRoomForLuna(homeRoom, roomName) {
  // Prevent Luna from treating the home room or another owned spawn room as a
  // remote. This guard is shared by discovery, queue pruning, and live Luna
  // assignment release.
  if (!roomName) return false;
  var homeName = null;
  if (typeof homeRoom === 'string') homeName = homeRoom;
  else if (homeRoom && homeRoom.name) homeName = homeRoom.name;

  if (homeName && roomName === homeName) return { blocked: true, reason: 'home-room' };

  var room = Game.rooms[roomName];
  if (room && room.controller && room.controller.my) return { blocked: true, reason: 'local-owned-room' };

  if (room) {
    var mySpawnsVisible = room.find(FIND_MY_SPAWNS) || [];
    if (mySpawnsVisible.length > 0) return { blocked: true, reason: 'owned-spawn-room' };
  }

  for (var spawnName in Game.spawns) {
    if (!Object.prototype.hasOwnProperty.call(Game.spawns, spawnName)) continue;
    var spawn = Game.spawns[spawnName];
    if (!spawn || !spawn.pos) continue;
    if (spawn.pos.roomName === roomName) return { blocked: true, reason: 'owned-spawn-room' };
  }

  var myName = getMyUsername();
  var roomMem = (Memory.rooms && Memory.rooms[roomName]) || {};
  var intel = roomMem.intel || {};
  if (intel.owner && myName && intel.owner === myName) return { blocked: true, reason: 'local-owned-room' };

  return { blocked: false, reason: null };
}

function getRouteDistanceBetweenRooms(homeName, remoteName) {
  if (!homeName || !remoteName) return Infinity;
  if (homeName === remoteName) return 0;
  var route = null;
  try { route = Game.map.findRoute(homeName, remoteName); } catch (e) { route = ERR_NO_PATH; }
  if (route === ERR_NO_PATH || !route || !Array.isArray(route)) return Infinity;
  return route.length;
}

// --- Diagnostics formatting helpers ----------------------------------------
// Memory reports are easier to read when numbers are rounded and Infinity is
// written as null. Screeps Memory serializes to JSON, so null is clearer for
// "unknown/unavailable" than a special JavaScript value.
function roundNumber(value, places) {
  if (typeof value !== 'number' || !isFinite(value)) return null;
  var factor = Math.pow(10, places || 2);
  return Math.round(value * factor) / factor;
}

function finiteOrNull(value) {
  return (typeof value === 'number' && isFinite(value)) ? value : null;
}

// --- Diagnostics body helpers ------------------------------------------------
// These helpers read the existing body config and summarize what the room could
// spawn. They do not ask BeeSpawnManager to enqueue anything.
function calculateBodyCost(body) {
  if (!body || !body.length) return 0;
  var total = 0;
  for (var i = 0; i < body.length; i++) total += BODYPART_COST[body[i]] || 0;
  return total;
}

function countBodyParts(body, part) {
  if (!body || !body.length) return 0;
  var count = 0;
  for (var i = 0; i < body.length; i++) if (body[i] === part) count++;
  return count;
}

function cloneBody(body) {
  var out = [];
  if (!body) return out;
  for (var i = 0; i < body.length; i++) out.push(body[i]);
  return out;
}

function chooseDiagnosticBody(roleName, energyCapacity) {
  var list = ROLE_CONFIGS[roleName];
  if (!list || !list.length) return [];
  var energy = typeof energyCapacity === 'number' && energyCapacity > 0 ? energyCapacity : 300;
  // Body lists are ordered largest-to-smallest elsewhere in the codebase, so
  // the first affordable body matches the spawn system's normal body choice.
  for (var i = 0; i < list.length; i++) {
    if (calculateBodyCost(list[i]) <= energy) return cloneBody(list[i]);
  }
  // If the room cannot afford even the smallest body, still report the smallest
  // configured body so the diagnostic shows the intended role shape.
  return cloneBody(list[list.length - 1]);
}

function bodyPartSummary(body) {
  return {
    work: countBodyParts(body, WORK),
    carry: countBodyParts(body, CARRY),
    move: countBodyParts(body, MOVE),
    claim: countBodyParts(body, CLAIM),
    total: body ? body.length : 0,
    cost: calculateBodyCost(body)
  };
}

function getHomeEnergyCapacity(homeRoom) {
  var room = Game.rooms && Game.rooms[homeRoom];
  if (!room) return 300;
  if (typeof room.energyCapacityAvailable === 'number' && room.energyCapacityAvailable > 0) return room.energyCapacityAvailable;
  if (typeof room.energyAvailable === 'number' && room.energyAvailable > 0) return room.energyAvailable;
  return 300;
}

// Pick the same practical "home anchor" used by Luna travel: storage first,
// then spawn, then controller, then room center as a last-resort estimate.
function getHomeAnchorPos(homeRoom) {
  var room = Game.rooms && Game.rooms[homeRoom];
  if (room) {
    if (room.storage) return room.storage.pos;
    var spawns = room.find(FIND_MY_SPAWNS) || [];
    if (spawns.length) return spawns[0].pos;
    if (room.controller && room.controller.my) return room.controller.pos;
  }
  return new RoomPosition(25, 25, homeRoom);
}

// Cost matrix used only for the visible-path estimate in this report. It keeps
// the same broad idea as Luna movement: roads are cheap, blocking structures are
// impassable, containers are allowed because Luna wants to sit on/near them.
function buildDiagnosticCostMatrix(roomName) {
  var room = Game.rooms && Game.rooms[roomName];
  if (!room) return;
  var matrix = new PathFinder.CostMatrix();
  var structures = room.find(FIND_STRUCTURES) || [];
  for (var i = 0; i < structures.length; i++) {
    var structure = structures[i];
    if (structure.structureType === STRUCTURE_ROAD) matrix.set(structure.pos.x, structure.pos.y, 1);
    else if (structure.structureType !== STRUCTURE_CONTAINER && (structure.structureType !== STRUCTURE_RAMPART || !structure.my)) {
      matrix.set(structure.pos.x, structure.pos.y, 0xff);
    }
  }
  var sites = room.find(FIND_CONSTRUCTION_SITES) || [];
  for (var j = 0; j < sites.length; j++) {
    var site = sites[j];
    if (site.structureType !== STRUCTURE_ROAD && site.structureType !== STRUCTURE_CONTAINER) matrix.set(site.pos.x, site.pos.y, 0xff);
  }
  return matrix;
}

// Path distance has three quality levels:
// 1) best: a fresh PathFinder result when the source room is visible;
// 2) good: cached distance fields from Memory if prior code recorded them;
// 3) unknown: null, with the economics calculation falling back to route range.
function estimatePathDistance(homeRoom, remoteRoom, sourceObj, sourceMem, routeDistance) {
  if (sourceObj && sourceObj.pos && Game.rooms && Game.rooms[homeRoom] && Game.rooms[remoteRoom]) {
    try {
      var ret = PathFinder.search(getHomeAnchorPos(homeRoom), { pos: sourceObj.pos, range: 1 }, {
        maxOps: (LunaConfig && LunaConfig.MAX_PF_OPS) || 3000,
        plainCost: (LunaConfig && LunaConfig.PLAIN_COST) || 2,
        swampCost: (LunaConfig && LunaConfig.SWAMP_COST) || 10,
        roomCallback: buildDiagnosticCostMatrix
      });
      if (!ret.incomplete && ret.path && typeof ret.path.length === 'number') {
        return { distance: ret.path.length, source: 'visible-pathfinder' };
      }
    } catch (e) {}
  }

  // These fields are optional because other parts of the bot may or may not
  // have seen this remote source recently enough to cache path details.
  if (sourceMem) {
    if (typeof sourceMem.pathDistance === 'number') return { distance: sourceMem.pathDistance, source: 'cached-pathDistance' };
    if (typeof sourceMem.remotePathDistance === 'number') return { distance: sourceMem.remotePathDistance, source: 'cached-remotePathDistance' };
    if (typeof sourceMem.entrySteps === 'number' && isFinite(routeDistance)) {
      return { distance: (routeDistance * 50) + sourceMem.entrySteps, source: 'route-plus-entrySteps' };
    }
  }

  return { distance: null, source: null };
}

// Scout intel is separate from room Memory. These accessors keep the report
// readable and avoid duplicating the long Memory.__BHM path everywhere.
function getScoutRoomRecord(homeRoom, remoteRoom) {
  var scout = Memory.__BHM && Memory.__BHM.scoutIntel && Memory.__BHM.scoutIntel.homes &&
    Memory.__BHM.scoutIntel.homes[homeRoom] && Memory.__BHM.scoutIntel.homes[homeRoom].rooms;
  return scout && scout[remoteRoom] ? scout[remoteRoom] : null;
}

function getScoutSourceRecord(homeRoom, remoteRoom, sourceId) {
  if (!sourceId) return null;
  var rec = getScoutRoomRecord(homeRoom, remoteRoom);
  if (!rec || !rec.sources) return null;
  for (var i = 0; i < rec.sources.length; i++) {
    if (rec.sources[i] && rec.sources[i].id === sourceId) return rec.sources[i];
  }
  return null;
}

// Controller state matters because a reserved/owned room has larger source
// capacity than an unreserved neutral room. This helper records both the status
// and which intel source produced that status.
function getControllerEstimate(homeRoom, remoteRoom) {
  var myName = getMyUsername();
  var room = Game.rooms && Game.rooms[remoteRoom];
  var mem = (Memory.rooms && Memory.rooms[remoteRoom]) || {};
  var intel = mem.intel || {};
  var scout = getScoutRoomRecord(homeRoom, remoteRoom);
  var scoutController = scout && scout.controller ? scout.controller : null;

  var owner = null;
  var reservation = null;
  var reservationTicks = null;
  var hasController = false;
  var source = 'unknown';

  if (room && room.controller) {
    hasController = true;
    owner = room.controller.owner && room.controller.owner.username || null;
    reservation = room.controller.reservation && room.controller.reservation.username || null;
    reservationTicks = room.controller.reservation && room.controller.reservation.ticksToEnd || null;
    source = 'visible';
  } else if (scoutController) {
    hasController = true;
    owner = scoutController.owner || null;
    reservation = scoutController.reservation || null;
    source = 'scout';
  } else if (intel.owner || intel.reservation || typeof intel.rcl === 'number') {
    hasController = true;
    owner = intel.owner || null;
    reservation = intel.reservation || null;
    source = 'room-intel';
  }

  var ownedByMe = !!(owner && myName && owner === myName);
  var reservedByMe = !!(reservation && myName && reservation === myName);
  var ownedByOther = !!(owner && (!myName || owner !== myName));
  var reservedByOther = !!(reservation && (!myName || reservation !== myName));
  var status = 'unknown';
  if (!hasController) status = 'no-controller';
  else if (ownedByMe) status = 'owned-by-me';
  else if (ownedByOther) status = 'owned-by-other';
  else if (reservedByMe) status = 'reserved-by-me';
  else if (reservedByOther) status = 'reserved-by-other';
  else status = 'unreserved';

  return {
    status: status,
    hasController: hasController,
    owner: owner,
    reservation: reservation,
    reservationTicks: reservationTicks,
    ownedByMe: ownedByMe,
    reservedByMe: reservedByMe,
    ownedByOther: ownedByOther,
    reservedByOther: reservedByOther,
    source: source
  };
}

// Source energy is energy regenerated per tick. Visible sources give the most
// accurate number. If the room is not visible, fall back to Screeps defaults:
// neutral 1500, reserved/owned 3000, keeper 4000 energy per 300 ticks.
function estimateSourceEnergyPerTick(remoteRoom, sourceObj, sourceMem, controllerEstimate) {
  if (sourceObj && typeof sourceObj.energyCapacity === 'number' && sourceObj.energyCapacity > 0) {
    return sourceObj.energyCapacity / REMOTE_SOURCE_ENERGY_REGEN_TICKS;
  }
  if (sourceMem && typeof sourceMem.energyCapacity === 'number' && sourceMem.energyCapacity > 0) {
    return sourceMem.energyCapacity / REMOTE_SOURCE_ENERGY_REGEN_TICKS;
  }

  var mem = (Memory.rooms && Memory.rooms[remoteRoom]) || {};
  var intel = mem.intel || {};
  if (intel.keeperLairs && intel.keeperLairs > 0) {
    return DEFAULT_KEEPER_SOURCE_ENERGY_CAPACITY / REMOTE_SOURCE_ENERGY_REGEN_TICKS;
  }
  if (controllerEstimate && (controllerEstimate.ownedByMe || controllerEstimate.reservedByMe ||
      controllerEstimate.ownedByOther || controllerEstimate.reservedByOther)) {
    return DEFAULT_RESERVED_SOURCE_ENERGY_CAPACITY / REMOTE_SOURCE_ENERGY_REGEN_TICKS;
  }
  return DEFAULT_NEUTRAL_SOURCE_ENERGY_CAPACITY / REMOTE_SOURCE_ENERGY_REGEN_TICKS;
}

// Used to split one reserver's spawn/energy cost across the sources in the room.
// A two-source room should not charge the full reserver cost to both sources.
function getRemoteSourceCountEstimate(homeRoom, remoteRoom) {
  var count = 0;
  var room = Game.rooms && Game.rooms[remoteRoom];
  if (room) {
    var liveSources = room.find(FIND_SOURCES) || [];
    if (liveSources.length) return liveSources.length;
  }
  var mem = (Memory.rooms && Memory.rooms[remoteRoom]) || {};
  if (mem.sources) {
    for (var sid in mem.sources) {
      if (Object.prototype.hasOwnProperty.call(mem.sources, sid)) count++;
    }
    if (count > 0) return count;
  }
  var scout = getScoutRoomRecord(homeRoom, remoteRoom);
  if (scout && scout.sources && scout.sources.length) return scout.sources.length;
  if (mem.intel && typeof mem.intel.sources === 'number') return Math.max(1, mem.intel.sources);
  return 1;
}

// Reserver cost is included only as diagnostics. The bot currently does not
// spawn remote reservers from this report; this just answers "what would that
// controller reservation cost per source?"
function estimateReserverEconomics(homeRoom, remoteRoom, controllerEstimate, sourcesInRoom, energyCapacity) {
  if (!controllerEstimate || !controllerEstimate.hasController) return { spawnUsage: 0, energyCost: 0 };
  if (controllerEstimate.ownedByMe || controllerEstimate.ownedByOther || controllerEstimate.reservedByOther) {
    return { spawnUsage: 0, energyCost: 0 };
  }
  var body = chooseDiagnosticBody('Claimer', energyCapacity);
  if (!body.length) return { spawnUsage: 0, energyCost: 0 };
  var sourceDivisor = Math.max(1, sourcesInRoom || getRemoteSourceCountEstimate(homeRoom, remoteRoom));
  var claimLifeTime = (typeof CREEP_CLAIM_LIFE_TIME === 'number') ? CREEP_CLAIM_LIFE_TIME : 600;
  return {
    spawnUsage: ((body.length * CREEP_SPAWN_TIME) / claimLifeTime) / sourceDivisor,
    energyCost: (calculateBodyCost(body) / claimLifeTime) / sourceDivisor
  };
}

// Source records can come from live objects, Memory.rooms[remote].sources, or
// scout intel. Normalize all of those shapes into one {x, y, roomName} style.
function sourceRecordPosition(rec) {
  if (!rec) return null;
  if (rec.pos && typeof rec.pos.x === 'number') return rec.pos;
  if (typeof rec.x === 'number' && typeof rec.y === 'number') return { x: rec.x, y: rec.y, roomName: rec.roomName || null };
  return null;
}

// Build the per-source list for a remote room. The order of preference is live
// vision, room memory, then scout memory. The seen map prevents duplicate source
// IDs when the same source appears in more than one intel source.
function collectDiagnosticSourcesForRemote(homeRoom, remoteRoom) {
  var out = [];
  var seen = Object.create(null);
  var room = Game.rooms && Game.rooms[remoteRoom];
  var mem = (Memory.rooms && Memory.rooms[remoteRoom]) || {};

  function add(sourceId, sourceObj, sourceMem, scoutRec, sourceTag) {
    var key = sourceId || ('unknown:' + out.length);
    if (sourceId && seen[key]) return;
    if (sourceId) seen[key] = true;
    var pos = sourceObj && sourceObj.pos ? sourceObj.pos : sourceRecordPosition(sourceMem) || sourceRecordPosition(scoutRec);
    out.push({
      sourceId: sourceId || null,
      sourceObj: sourceObj || null,
      sourceMem: sourceMem || null,
      scoutRec: scoutRec || null,
      sourceTag: sourceTag || 'unknown',
      x: pos && typeof pos.x === 'number' ? pos.x : null,
      y: pos && typeof pos.y === 'number' ? pos.y : null
    });
  }

  if (room) {
    var liveSources = room.find(FIND_SOURCES) || [];
    for (var i = 0; i < liveSources.length; i++) {
      var liveSource = liveSources[i];
      add(liveSource.id, liveSource, mem.sources && mem.sources[liveSource.id], getScoutSourceRecord(homeRoom, remoteRoom, liveSource.id), 'visible');
    }
  }

  if (mem.sources) {
    for (var sid in mem.sources) {
      if (!Object.prototype.hasOwnProperty.call(mem.sources, sid)) continue;
      add(sid, null, mem.sources[sid], getScoutSourceRecord(homeRoom, remoteRoom, sid), 'memory');
    }
  }

  var scout = getScoutRoomRecord(homeRoom, remoteRoom);
  if (scout && scout.sources) {
    for (var s = 0; s < scout.sources.length; s++) {
      var scoutSource = scout.sources[s];
      if (!scoutSource) continue;
      add(scoutSource.id || null, null, mem.sources && scoutSource.id ? mem.sources[scoutSource.id] : null, scoutSource, 'scout');
    }
  }

  if (!out.length && mem.intel && typeof mem.intel.sources === 'number' && mem.intel.sources > 0) {
    for (var n = 0; n < mem.intel.sources; n++) add(null, null, null, null, 'room-intel-count');
  }

  return out;
}

// Remote discovery already rejects whole rooms for reasons like unsafe/no-route.
// Keep those reasons so every source inside that room inherits the same reject.
function indexRemoteRejectReasons(remoteDiscovery) {
  var out = Object.create(null);
  var rejected = remoteDiscovery && remoteDiscovery.rejectedRemoteRooms ? remoteDiscovery.rejectedRemoteRooms : [];
  for (var i = 0; i < rejected.length; i++) {
    var rec = rejected[i];
    if (rec && rec.room) out[rec.room] = rec.reason || 'rejected';
  }
  return out;
}

// This is a diagnostics mirror of the existing safety gates. It labels a source
// as rejected but never blocks assignment or queueing itself.
function sourceRejectReason(homeRoom, remoteRoom, sourceRec, roomRejectReason, routeDistance) {
  if (roomRejectReason) return roomRejectReason;
  var localOwnedCheck = isLocalOwnedRoomForLuna(homeRoom, remoteRoom);
  if (localOwnedCheck && localOwnedCheck.blocked) return localOwnedCheck.reason || 'local-owned-room';
  if (!isFinite(routeDistance)) return 'no-route';
  if (isRemoteUnsafe(remoteRoom)) return 'unsafe';

  var ttl = (LunaConfig && LunaConfig.LUNA_REMOTE_INTEL_TTL) || 3000;
  var intelTick = getRemoteIntelTick(remoteRoom);
  if (!Game.rooms[remoteRoom] && (intelTick == null || (Game.time - intelTick) > ttl)) return 'stale-intel';

  var sourceMem = sourceRec && sourceRec.sourceMem;
  if (sourceMem && sourceMem.lunaBlockedUntil && sourceMem.lunaBlockedUntil > Game.time) {
    return sourceMem.lunaBlockedReason || 'source-blocked';
  }
  var scoutRec = sourceRec && sourceRec.scoutRec;
  if (scoutRec && scoutRec.accessible === false) return scoutRec.blockedReason || 'source-inaccessible';
  if (!sourceRec || !sourceRec.sourceId) return 'missing-source-id';
  return null;
}

// Recount live and queued Luna directly at report time. This makes the report
// match the final queue after BeeSpawnManager has finished preparing the room.
function countLiveLunaForHome(homeRoom) {
  var count = 0;
  for (var name in Game.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Game.creeps, name)) continue;
    var creep = Game.creeps[name];
    if (!creep || !creep.memory) continue;
    if (creep.memory.role !== 'Luna' && creep.memory.task !== 'luna' && creep.memory.task !== 'remoteharvest') continue;
    var creepHome = creep.memory.home || creep.memory._home || (creep.room && creep.room.name);
    if (creepHome === homeRoom) count++;
  }
  return count;
}

function countQueuedLunaForHome(homeRoom) {
  var queue = (Memory.rooms && Memory.rooms[homeRoom] && Memory.rooms[homeRoom].spawnQueue) || [];
  var count = 0;
  for (var i = 0; i < queue.length; i++) {
    if (queue[i] && queue[i].role === 'Luna') count++;
  }
  return count;
}

// Main entry point for the economics report. It intentionally writes only to
// Memory.rooms[homeRoom].lastRemoteSourceEconomics and returns the report.
// Nothing here reserves a source, queues a creep, clears Memory, or changes
// remote haul/repair behavior.
function buildRemoteSourceEconomicsReport(homeRoom, remoteDiscovery) {
  // Human-facing diagnostics only. This report explains profitability and
  // rejection reasons, but must not enqueue, reserve, release, or block sources.
  if (!homeRoom) return null;
  // Reuse the discovery result from queue prep when available, so the report
  // explains the same candidate set BeeSpawnManager just evaluated.
  if (!remoteDiscovery) remoteDiscovery = gatherCandidateRemoteRoomsForHome(homeRoom);
  var home = ensureHomeMemory(homeRoom);
  var roomMem = getRoomMemoryBucket(homeRoom);
  var energyCapacity = getHomeEnergyCapacity(homeRoom);
  // Miner body is estimated once per home because all candidate sources use the
  // same room energy capacity and Luna body table.
  var minerBody = chooseDiagnosticBody('Luna', energyCapacity);
  var minerSummary = bodyPartSummary(minerBody);
  var rejectedByRoom = indexRemoteRejectReasons(remoteDiscovery);
  var remoteRooms = [];
  var seenRooms = Object.create(null);
  var candidates = remoteDiscovery && remoteDiscovery.candidateRemoteRooms ? remoteDiscovery.candidateRemoteRooms : [];
  var accepted = remoteDiscovery && remoteDiscovery.acceptedRemoteRooms ? remoteDiscovery.acceptedRemoteRooms : [];
  var rejected = remoteDiscovery && remoteDiscovery.rejectedRemoteRooms ? remoteDiscovery.rejectedRemoteRooms : [];

  function addRoom(roomName) {
    if (!roomName || seenRooms[roomName]) return;
    seenRooms[roomName] = true;
    remoteRooms.push(roomName);
  }

  for (var c = 0; c < candidates.length; c++) addRoom(candidates[c]);
  for (var a = 0; a < accepted.length; a++) addRoom(accepted[a]);
  for (var r = 0; r < rejected.length; r++) if (rejected[r]) addRoom(rejected[r].room);

  var sourceReports = [];
  var profitableSources = 0;
  var totalEstimatedSpawnUsage = 0;
  var totalEstimatedNetEnergy = 0;

  for (var i = 0; i < remoteRooms.length; i++) {
    var remoteRoom = remoteRooms[i];
    var routeDistance = getRouteDistanceBetweenRooms(homeRoom, remoteRoom);
    var controllerEstimate = getControllerEstimate(homeRoom, remoteRoom);
    var sources = collectDiagnosticSourcesForRemote(homeRoom, remoteRoom);
    var sourcesInRoom = Math.max(1, sources.length || getRemoteSourceCountEstimate(homeRoom, remoteRoom));
    var reserverEconomics = estimateReserverEconomics(homeRoom, remoteRoom, controllerEstimate, sourcesInRoom, energyCapacity);

    for (var j = 0; j < sources.length; j++) {
      var sourceRec = sources[j];
      var pathEstimate = estimatePathDistance(homeRoom, remoteRoom, sourceRec.sourceObj, sourceRec.sourceMem, routeDistance);
      var pathDistance = pathEstimate.distance;
      // Haulers need to make a round trip. If exact pathing is unavailable, use
      // route rooms * 50 tiles as a conservative rough distance.
      var fallbackOneWayDistance = pathDistance != null ? pathDistance : (isFinite(routeDistance) ? Math.max(50, routeDistance * 50) : null);
      var roundTripDistance = fallbackOneWayDistance != null ? Math.max(1, fallbackOneWayDistance * 2) : null;
      var sourceEnergyPerTick = estimateSourceEnergyPerTick(remoteRoom, sourceRec.sourceObj, sourceRec.sourceMem, controllerEstimate);
      // A source may produce more than this Luna body can harvest. Cap income by
      // WORK parts so the estimate reflects the chosen miner body.
      var harvestEnergyPerTick = Math.min(sourceEnergyPerTick, Math.max(0, minerSummary.work * HARVEST_POWER));
      var haulerCarryPartsNeeded = roundTripDistance != null
        ? Math.max(0, Math.ceil((harvestEnergyPerTick * roundTripDistance) / CARRY_CAPACITY))
        : 0;
      // Spawn usage is "fraction of one spawn kept busy forever". Example:
      // 0.10 means this source consumes about 10% of a spawn over time.
      var minerSpawnUsage = minerBody.length ? (minerBody.length * CREEP_SPAWN_TIME) / CREEP_LIFE_TIME : 0;
      var minerEnergyCost = minerBody.length ? calculateBodyCost(minerBody) / CREEP_LIFE_TIME : 0;
      var haulerSpawnUsage = (haulerCarryPartsNeeded * 2 * CREEP_SPAWN_TIME) / CREEP_LIFE_TIME;
      var haulerEnergyCost = (haulerCarryPartsNeeded * (BODYPART_COST[CARRY] + BODYPART_COST[MOVE])) / CREEP_LIFE_TIME;
      var containerRepairCost = DEFAULT_CONTAINER_REPAIR_ENERGY_PER_TICK;
      var rejectReason = sourceRejectReason(homeRoom, remoteRoom, sourceRec, rejectedByRoom[remoteRoom] || null, routeDistance);
      var estimatedTotalSpawnUsage = minerSpawnUsage + haulerSpawnUsage + reserverEconomics.spawnUsage;
      // Net energy subtracts ongoing creep replacement energy and estimated
      // container repair energy from harvested energy.
      var estimatedNetEnergyPerTick = harvestEnergyPerTick - minerEnergyCost - haulerEnergyCost - reserverEconomics.energyCost - containerRepairCost;
      var profitable = !rejectReason && estimatedNetEnergyPerTick > 0;

      if (profitable) {
        profitableSources++;
        totalEstimatedSpawnUsage += estimatedTotalSpawnUsage;
        totalEstimatedNetEnergy += estimatedNetEnergyPerTick;
      }

      sourceReports.push({
        homeRoom: homeRoom,
        remoteRoom: remoteRoom,
        sourceId: sourceRec.sourceId,
        routeDistance: finiteOrNull(routeDistance),
        pathDistance: pathDistance,
        pathDistanceSource: pathEstimate.source,
        sourceEnergyPerTick: roundNumber(sourceEnergyPerTick, 2),
        reservedOwnedEstimate: controllerEstimate,
        minerBodyParts: minerSummary,
        minerSpawnUsage: roundNumber(minerSpawnUsage, 4),
        haulerCarryPartsNeeded: haulerCarryPartsNeeded,
        haulerSpawnUsage: roundNumber(haulerSpawnUsage, 4),
        reserverSpawnUsage: roundNumber(reserverEconomics.spawnUsage, 4),
        containerRepairCost: roundNumber(containerRepairCost, 3),
        estimatedNetEnergyPerTick: roundNumber(estimatedNetEnergyPerTick, 2),
        estimatedTotalSpawnUsage: roundNumber(estimatedTotalSpawnUsage, 4),
        selectedCandidate: false,
        rejectReason: rejectReason
      });
    }
  }

  sourceReports.sort(function (a, b) {
    var ar = a.routeDistance == null ? 999999 : a.routeDistance;
    var br = b.routeDistance == null ? 999999 : b.routeDistance;
    if (ar !== br) return ar - br;
    if (a.remoteRoom !== b.remoteRoom) return a.remoteRoom < b.remoteRoom ? -1 : 1;
    var asid = a.sourceId || '';
    var bsid = b.sourceId || '';
    return asid < bsid ? -1 : (asid > bsid ? 1 : 0);
  });

  var warning = null;
  if ((home.desiredLuna || 0) > profitableSources) {
    warning = 'currentDesiredLuna exceeds profitable source count';
  }
  var currentLiveLuna = countLiveLunaForHome(homeRoom);
  var currentQueuedLuna = countQueuedLunaForHome(homeRoom);

  roomMem.lastRemoteSourceEconomics = {
    tick: Game.time,
    homeRoom: homeRoom,
    candidateSources: sourceReports.length,
    profitableSources: profitableSources,
    totalEstimatedSpawnUsage: roundNumber(totalEstimatedSpawnUsage, 4),
    totalEstimatedNetEnergy: roundNumber(totalEstimatedNetEnergy, 2),
    currentDesiredLuna: home.desiredLuna || 0,
    currentLiveLuna: currentLiveLuna,
    currentQueuedLuna: currentQueuedLuna,
    warning: warning,
    sources: sourceReports,
    // Assumptions are included in Memory so a novice can trace where the math
    // came from without hunting through constants at the top of the file.
    assumptions: {
      creepLifeTime: CREEP_LIFE_TIME,
      claimCreepLifeTime: (typeof CREEP_CLAIM_LIFE_TIME === 'number') ? CREEP_CLAIM_LIFE_TIME : 600,
      creepSpawnTime: CREEP_SPAWN_TIME,
      neutralSourceEnergyCapacity: DEFAULT_NEUTRAL_SOURCE_ENERGY_CAPACITY,
      reservedSourceEnergyCapacity: DEFAULT_RESERVED_SOURCE_ENERGY_CAPACITY,
      keeperSourceEnergyCapacity: DEFAULT_KEEPER_SOURCE_ENERGY_CAPACITY,
      containerRepairCostEnergyPerTick: DEFAULT_CONTAINER_REPAIR_ENERGY_PER_TICK
    }
  };

  return roomMem.lastRemoteSourceEconomics;
}

function addUniqueRoomName(list, seen, roomName) {
  if (!roomName || seen[roomName]) return;
  seen[roomName] = true;
  list.push(roomName);
}

function gatherCandidateRemoteRoomsForHome(homeRoom) {
  // Remote discovery merges three signals: RoadPlanner active remotes, existing
  // Memory.rooms source/intel records, and currently visible rooms. The accepted
  // list is the only set buildSourcePlanForHome should turn into source records.
  var out = { candidateRemoteRooms: [], acceptedRemoteRooms: [], rejectedRemoteRooms: [] };
  if (!homeRoom) return out;
  var homeName = typeof homeRoom === 'string' ? homeRoom : homeRoom.name;
  var homeObj = typeof homeRoom === 'string' ? Game.rooms[homeRoom] : homeRoom;
  if (!homeName) return out;

  var ttl = (LunaConfig && LunaConfig.LUNA_REMOTE_INTEL_TTL) || 3000;
  var radius = (LunaConfig && LunaConfig.REMOTE_RADIUS) || 3;
  var myName = getMyUsername();
  var discovered = [];
  var seen = Object.create(null);
  var sourceTags = Object.create(null);

  if (RoadPlanner && typeof RoadPlanner.getActiveRemoteRooms === 'function' && homeObj) {
    var active = RoadPlanner.getActiveRemoteRooms(homeObj) || [];
    for (var i = 0; i < active.length; i++) {
      addUniqueRoomName(discovered, seen, active[i]);
      sourceTags[active[i]] = 'roadPlanner';
    }
  }

  var memRooms = Memory.rooms || {};
  for (var rn in memRooms) {
    if (!Object.prototype.hasOwnProperty.call(memRooms, rn)) continue;
    var mem = memRooms[rn] || {};
    var hasMemSources = false;
    if (mem.sources) for (var sid in mem.sources) { if (Object.prototype.hasOwnProperty.call(mem.sources, sid)) { hasMemSources = true; break; } }
    if (!hasMemSources && !(mem.intel && typeof mem.intel.sources === 'number' && mem.intel.sources > 0)) continue;
    if (Game.map.getRoomLinearDistance(homeName, rn) > radius) continue;
    addUniqueRoomName(discovered, seen, rn);
    if (!sourceTags[rn]) sourceTags[rn] = 'memory';
  }

  for (var visibleName in Game.rooms) {
    if (!Object.prototype.hasOwnProperty.call(Game.rooms, visibleName)) continue;
    var visible = Game.rooms[visibleName];
    if (!visible || !visible.find) continue;
    if (Game.map.getRoomLinearDistance(homeName, visibleName) > radius) continue;
    var foundSources = visible.find(FIND_SOURCES) || [];
    if (!foundSources.length) continue;
    addUniqueRoomName(discovered, seen, visibleName);
    if (!sourceTags[visibleName]) sourceTags[visibleName] = 'visible';
  }

  out.candidateRemoteRooms = discovered.slice(0);
  for (var j = 0; j < discovered.length; j++) {
    var remoteName = discovered[j];
    var reason = null;
    var remoteMem = (Memory.rooms && Memory.rooms[remoteName]) || {};
    var remoteVisible = Game.rooms[remoteName];
    var intel = remoteMem.intel || {};

    var localOwnedCheck = isLocalOwnedRoomForLuna(homeName, remoteName);
    if (localOwnedCheck.blocked) reason = localOwnedCheck.reason;
    else if (Game.map.getRoomLinearDistance(homeName, remoteName) > radius) reason = 'beyond-radius';
    else if (getRouteDistanceBetweenRooms(homeName, remoteName) === Infinity) reason = 'no-route';
    else if (isRemoteUnsafe(remoteName)) {
      if (remoteMem.lunaBlockedReason === 'all-sources-inaccessible') reason = 'all-sources-inaccessible';
      else reason = 'unsafe';
    }
    else if (remoteMem.lunaBlocked) reason = 'luna-blocked';
    else if (remoteVisible && remoteVisible.controller && remoteVisible.controller.owner && (!myName || remoteVisible.controller.owner.username !== myName)) reason = 'owned-by-other';
    else if (remoteVisible && remoteVisible.controller && remoteVisible.controller.reservation && (!myName || remoteVisible.controller.reservation.username !== myName)) reason = 'reserved-by-other';
    else if (intel.owner && (!myName || intel.owner !== myName)) reason = 'intel-owned-by-other';
    else if (intel.reservation && (!myName || intel.reservation !== myName)) reason = 'intel-reserved-by-other';
    else {
      var intelTick = getRemoteIntelTick(remoteName);
      if (!remoteVisible && (intelTick == null || (Game.time - intelTick) > ttl)) reason = 'stale-intel';
    }

    if (reason) out.rejectedRemoteRooms.push({ room: remoteName, reason: reason, source: sourceTags[remoteName] || 'unknown' });
    else out.acceptedRemoteRooms.push(remoteName);
  }

  out.acceptedRemoteRooms.sort(function (a, b) {
    var routeA = getRouteDistanceBetweenRooms(homeName, a);
    var routeB = getRouteDistanceBetweenRooms(homeName, b);
    if (routeA !== routeB) return routeA - routeB;
    var linA = Game.map.getRoomLinearDistance(homeName, a);
    var linB = Game.map.getRoomLinearDistance(homeName, b);
    if (linA !== linB) return linA - linB;
    return a < b ? -1 : (a > b ? 1 : 0);
  });

  return out;
}


function getApprovedRemotesFromScout(homeRoom) {
  // Scout-focused approval path used by Luna fallback selection. It reads
  // Memory.__BHM.scoutIntel and returns source-level candidates with route
  // ordering plus explicit rejection reasons for diagnostics.
  var out = { approvedRooms: [], approvedSources: [], rejected: [] };
  var ttl = (LunaConfig && LunaConfig.LUNA_REMOTE_INTEL_TTL) || 3000;
  var intel = Memory.__BHM && Memory.__BHM.scoutIntel && Memory.__BHM.scoutIntel.homes && Memory.__BHM.scoutIntel.homes[homeRoom];
  var rooms = intel && intel.rooms ? intel.rooms : null;
  if (!rooms) return out;
  for (var rn in rooms) {
    if (!Object.prototype.hasOwnProperty.call(rooms, rn)) continue;
    var rec = rooms[rn]; if (!rec) continue;
    var reason = null;
    if (rn === homeRoom) reason = 'home-room';
    else if (rec.routeDistance === Infinity || rec.routeDistance == null) reason = 'no-route';
    else if (!rec.lastSeen || (Game.time - rec.lastSeen) > ttl) reason = 'stale-scout-intel';
    else if (!rec.sources || rec.sources.length <= 0) reason = 'no-sources';
    else if (!rec.remoteEligible) reason = rec.remoteBlockedReason || 'blocked';
    else if (isRemoteUnsafe(rn)) reason = 'unsafe';
    if (reason) { out.rejected.push({ room: rn, reason: reason }); continue; }

    out.approvedRooms.push(rn);
    for (var i = 0; i < rec.sources.length; i++) {
      var src = rec.sources[i];
      if (!src || !src.id || src.accessible === false) continue;
      out.approvedSources.push({ sourceId: src.id, targetRoom: rn, routeDistance: rec.routeDistance, linearDistance: rec.linearDistance, roomName: rn });
    }
  }
  out.approvedRooms.sort(function(a,b){
    var ra = getRouteDistanceBetweenRooms(homeRoom,a), rb = getRouteDistanceBetweenRooms(homeRoom,b);
    if (ra !== rb) return ra-rb;
    var la = Game.map.getRoomLinearDistance(homeRoom,a), lb = Game.map.getRoomLinearDistance(homeRoom,b);
    if (la !== lb) return la-lb;
    return a < b ? -1 : (a > b ? 1 : 0);
  });
  out.approvedSources.sort(function(a,b){
    if (a.routeDistance!==b.routeDistance) return a.routeDistance-b.routeDistance;
    if (a.linearDistance!==b.linearDistance) return a.linearDistance-b.linearDistance;
    if (a.roomName!==b.roomName) return a.roomName < b.roomName ? -1 : 1;
    return a.sourceId < b.sourceId ? -1 : (a.sourceId > b.sourceId ? 1 : 0);
  });
  return out;
}


function ensureRemoteContainerBuildsMemory() {
  // Shared with role.Luna.Logic.js. Build records tell the planner/spawner that
  // a source may still need a Luna to create or finish its remote container.
  if (!Memory.__BHM) Memory.__BHM = {};
  if (!Memory.__BHM.remoteContainerBuilds) Memory.__BHM.remoteContainerBuilds = {};
  return Memory.__BHM.remoteContainerBuilds;
}

function isUnfinishedContainerBuild(sourceRec) {
  // Used to prefer queueing Luna for sources whose container is not built yet.
  // Unsafe rooms are ignored so the queue does not chase blocked infrastructure.
  if (!sourceRec || !sourceRec.sourceId) return false;
  if (sourceRec.remoteRoom && isRemoteUnsafe(sourceRec.remoteRoom)) return false;

  var containerRec = sourceRec.container;
  if (containerRec && (containerRec.status === 'planned' || containerRec.status === 'building' || containerRec.status === 'missing')) {
    return true;
  }

  var builds = ensureRemoteContainerBuildsMemory();
  var buildRec = builds[sourceRec.sourceId];
  if (!buildRec) return false;
  if (buildRec.remoteRoom && isRemoteUnsafe(buildRec.remoteRoom)) return false;
  return buildRec.status !== 'built';
}
function buildSourcePlanForHome(homeRoom, remoteRooms) {
  // Rebuild the per-home source plan from approved remote rooms. The function
  // preserves selected per-source fields from the previous plan, then refreshes
  // safety/stale/source status for this tick.
  var home = ensureHomeMemory(homeRoom);
  var oldSources = home.sources || {};
  home.sources = {};
  home.unsafeSources = [];
  home.staleSources = [];

  var ttl = (LunaConfig && LunaConfig.LUNA_REMOTE_INTEL_TTL) || 3000;
  for (var i = 0; i < (remoteRooms || []).length; i++) {
    var remoteRoom = remoteRooms[i];
    if (!remoteRoom) continue;
    if (isLocalOwnedRoomForLuna(homeRoom, remoteRoom).blocked) continue;
    if (isRemoteUnsafe(remoteRoom)) { home.unsafeSources.push(remoteRoom); continue; }

    var intelTick = getRemoteIntelTick(remoteRoom);
    if (!Game.rooms[remoteRoom] && (intelTick == null || (Game.time - intelTick) > ttl)) {
      home.staleSources.push(remoteRoom);
      continue;
    }

    var list = [];
    var live = Game.rooms[remoteRoom];
    if (live) {
      var found = live.find(FIND_SOURCES) || [];
      for (var f = 0; f < found.length; f++) list.push(found[f]);
    } else {
      var mem = (Memory.rooms && Memory.rooms[remoteRoom]) || {};
      if (mem.sources) {
        for (var sid in mem.sources) {
          if (!Object.prototype.hasOwnProperty.call(mem.sources, sid)) continue;
          list.push({ id: sid, pos: mem.sources[sid].pos || mem.sources[sid] });
        }
      }
    }

    var blockedInRoom = 0;
    var totalInRoom = 0;
    for (var j = 0; j < list.length; j++) {
      var src = list[j];
      if (!src || !src.id) continue;
      totalInRoom++;
      var srcMem = (Memory.rooms && Memory.rooms[remoteRoom] && Memory.rooms[remoteRoom].sources && Memory.rooms[remoteRoom].sources[src.id]) || {};
      if (srcMem.lunaBlockedUntil && srcMem.lunaBlockedUntil > Game.time) {
        blockedInRoom++;
        continue;
      }
      var prev = oldSources[src.id] || {};
      var x = src.pos && typeof src.pos.x === 'number' ? src.pos.x : (typeof prev.x === 'number' ? prev.x : null);
      var y = src.pos && typeof src.pos.y === 'number' ? src.pos.y : (typeof prev.y === 'number' ? prev.y : null);
      home.sources[src.id] = {
        sourceId: src.id, homeRoom: homeRoom, remoteRoom: remoteRoom,
        x: x, y: y,
        containerId: prev.containerId || null,
        container: prev.container || null,
        assignedLuna: prev.assignedLuna || null,
        reservedBy: prev.reservedBy || null,
        reservedUntil: prev.reservedUntil || 0,
        lastSeen: Game.time,
        lastActive: prev.lastActive || 0,
        status: 'open',
        reason: 'planned'
      };
    }
    if (totalInRoom > 0 && blockedInRoom >= totalInRoom) home.unsafeSources.push(remoteRoom + ':all-sources-blocked');
  }

  return home;
}

function auditAssignmentsForHome(homeRoom) {
  // Reconcile the plan with reality: live Luna creeps, queued Luna spawn items,
  // expired queue reservations, blocked source Memory, duplicate assignments,
  // and unfinished container work all converge into lastRemoteHarvestPlan.
  var home = ensureHomeMemory(homeRoom);
  var bySource = {};
  var liveCount = 0;

  for (var name in Game.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Game.creeps, name)) continue;
    var c = Game.creeps[name];
    if (!c || !c.memory) continue;
    if (c.memory.role !== 'Luna' && c.memory.task !== 'luna' && c.memory.task !== 'remoteharvest') continue;
    var chome = c.memory.home || c.memory._home || (c.room && c.room.name);
    if (chome !== homeRoom) continue;
    liveCount++;
    if (!c.memory.sourceId) continue;
    if (!bySource[c.memory.sourceId]) bySource[c.memory.sourceId] = [];
    bySource[c.memory.sourceId].push(c);
  }

  home.liveLuna = liveCount;
  home.duplicateSources = [];
  home.missingSources = [];
  var queuedSources = [];
  var queuedBySource = {};
  var duplicateQueuedSources = [];
  var assignedSources = [];
  var unfinishedContainerSources = [];
  var sourceQueueDecisions = {};
  var queued = 0;
  var spawnQueue = (Memory.rooms && Memory.rooms[homeRoom] && Memory.rooms[homeRoom].spawnQueue) || [];
  for (var q = 0; q < spawnQueue.length; q++) {
    var item = spawnQueue[q];
    if (!item || item.role !== 'Luna' || !item.sourceId) continue;
    queuedBySource[item.sourceId] = (queuedBySource[item.sourceId] || 0) + 1;
  }

  for (var sid in home.sources) {
    if (!Object.prototype.hasOwnProperty.call(home.sources, sid)) continue;
    var rec = home.sources[sid];
    if (!rec) continue;
    var rmem = (Memory.rooms && Memory.rooms[rec.remoteRoom] && Memory.rooms[rec.remoteRoom].sources && Memory.rooms[rec.remoteRoom].sources[sid]) || {};
    if (rmem.lunaBlockedUntil && rmem.lunaBlockedUntil > Game.time) {
      rec.status = 'blocked';
      rec.reason = rmem.lunaBlockedReason || 'source-blocked';
      continue;
    }

    if (rec.reservedUntil && rec.reservedUntil <= Game.time) {
      rec.reservedBy = null;
      rec.reservedUntil = 0;
    }
    var hasQueueItemsForSource = queuedBySource[sid] > 0;
    if (rec.reservedBy && rec.reservedUntil > Game.time && !hasQueueItemsForSource && String(rec.reservedBy).indexOf('queue:') === 0) {
      rec.reservedBy = null;
      rec.reservedUntil = 0;
      sourceQueueDecisions[sid] = 'cleared-stale-reservation-no-queue-item';
    }
    if (rec.reservedBy && rec.reservedUntil > Game.time && !hasQueueItemsForSource) queued++;
    if (hasQueueItemsForSource) {
      rec.reservedBy = rec.reservedBy || ('queue:spawnQueue:' + sid);
      rec.reservedUntil = Math.max(rec.reservedUntil || 0, Game.time + RESERVE_TTL);
      queued += queuedBySource[sid];
      queuedSources.push(sid);
      if (hasQueueItemsForSource && queuedBySource[sid] > 1) duplicateQueuedSources.push(sid);
    }

    if (rec.assignedLuna && !Game.creeps[rec.assignedLuna]) rec.assignedLuna = null;

    var contenders = bySource[sid] || [];
    if (contenders.length > 1) {
      contenders.sort(function (a, b) {
        var at = a.memory && typeof a.memory._assignTick === 'number' ? a.memory._assignTick : 99999999;
        var bt = b.memory && typeof b.memory._assignTick === 'number' ? b.memory._assignTick : 99999999;
        if (at !== bt) return at - bt;
        return a.name < b.name ? -1 : 1;
      });
      for (var d = 1; d < contenders.length; d++) contenders[d].memory._forceYield = true;
      home.duplicateSources.push(sid);
    }

    if (contenders.length > 0) {
      rec.assignedLuna = contenders[0].name;
      rec.status = 'assigned';
      rec.reason = 'live-luna';
      rec.lastActive = Game.time;
      assignedSources.push(sid);
      rec.reservedBy = null;
      rec.reservedUntil = 0;
      sourceQueueDecisions[sid] = 'assigned-live-luna';
    } else if ((rec.reservedBy && rec.reservedUntil > Game.time) || hasQueueItemsForSource) {
      rec.status = 'queued';
      rec.reason = rec.reservedBy;
      sourceQueueDecisions[sid] = hasQueueItemsForSource ? 'queued-spawnQueue' : 'queued-reserved';
    } else {
      rec.status = 'open';
      rec.reason = 'missing-luna';
      if (isUnfinishedContainerBuild(rec)) {
        rec.reason = 'unfinished-container';
        if (rec.container) rec.container.status = rec.container.status || 'missing';
        unfinishedContainerSources.push(sid);
        sourceQueueDecisions[sid] = 'missing-luna-unfinished-container';
      } else {
        sourceQueueDecisions[sid] = 'missing-luna';
      }
      home.missingSources.push(sid);
    }
  }

  home.desiredLuna = Object.keys(home.sources).length;
  home.queuedLuna = queued;
  home.lastAudit = Game.time;

  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[homeRoom]) Memory.rooms[homeRoom] = {};
  Memory.rooms[homeRoom].lastRemoteHarvestPlan = {
    tick: Game.time,
    desiredLuna: home.desiredLuna,
    liveLuna: home.liveLuna,
    queuedLuna: home.queuedLuna,
    queuedSources: queuedSources,
    duplicateQueuedSources: duplicateQueuedSources,
    missingSources: home.missingSources.slice(0),
    unfinishedContainerSources: unfinishedContainerSources,
    assignedSources: assignedSources,
    unsafeSources: home.unsafeSources.slice(0),
    staleSources: home.staleSources.slice(0),
    duplicateSources: home.duplicateSources.slice(0),
    blockedSources: Object.keys(home.sources).filter(function (sid) {
      var src = home.sources[sid];
      var rs = src && Memory.rooms && Memory.rooms[src.remoteRoom] && Memory.rooms[src.remoteRoom].sources && Memory.rooms[src.remoteRoom].sources[sid];
      return !!(rs && rs.lunaBlockedUntil && rs.lunaBlockedUntil > Game.time);
    }),
    sourceQueueDecisions: sourceQueueDecisions,
    notes: 'one Luna per approved source'
  };

  return home;
}

function unreserveSourceForQueue(homeRoom, sourceId) {
  // Called when BeeSpawnManager failed to enqueue a Luna after reserving the
  // source. It deliberately refuses to clear a source already claimed by a live
  // Luna.
  var home = ensureHomeMemory(homeRoom);
  var rec = home.sources[sourceId];
  if (!rec) return false;
  if (rec.assignedLuna) return false;
  rec.reservedBy = null;
  rec.reservedUntil = 0;
  if (rec.status === 'queued') {
    rec.status = 'open';
    rec.reason = 'enqueue-failed';
  }
  return true;
}

function reserveSourceForQueue(homeRoom) {
  // Spawn-queue reservation point. It chooses one missing/open source, marks it
  // queued for RESERVE_TTL ticks, and returns only the memory needed for the
  // queued Luna item.
  var home = ensureHomeMemory(homeRoom);
  var pick = null;
  var unfinishedFirst = [];
  var normalMissing = [];
  for (var i = 0; i < home.missingSources.length; i++) {
    var sidList = home.missingSources[i];
    var recList = home.sources[sidList];
    if (!recList) continue;
    if (isUnfinishedContainerBuild(recList)) unfinishedFirst.push(sidList);
    else normalMissing.push(sidList);
  }
  var orderedMissing = unfinishedFirst.concat(normalMissing);
  for (var i = 0; i < orderedMissing.length; i++) {
    var sid = orderedMissing[i];
    var rec = home.sources[sid];
    if (!rec || rec.assignedLuna) continue;
    if (isLocalOwnedRoomForLuna(homeRoom, rec.remoteRoom).blocked) continue;
    if (isRemoteUnsafe(rec.remoteRoom)) continue;
    var roomSourceMem = (Memory.rooms && Memory.rooms[rec.remoteRoom] && Memory.rooms[rec.remoteRoom].sources && Memory.rooms[rec.remoteRoom].sources[sid]) || {};
    if (roomSourceMem.lunaBlockedUntil && roomSourceMem.lunaBlockedUntil > Game.time) continue;
    if (rec.reservedBy && rec.reservedUntil > Game.time) continue;
    pick = rec; break;
  }
  if (!pick) return null;
  pick.reservedBy = 'queue:' + Game.time + ':' + pick.sourceId;
  pick.reservedUntil = Game.time + RESERVE_TTL;
  pick.status = 'queued';
  pick.reason = pick.reservedBy;
  return { sourceId: pick.sourceId, targetRoom: pick.remoteRoom };
}

function claimSource(creep, sourceId, targetRoom) {
  // Live Luna claim point. Once a creep has a sourceId/targetRoom, this clears
  // any queue reservation and marks the source assigned to that creep.
  if (!creep || !creep.memory) return false;
  var homeRoom = creep.memory.home || creep.memory._home || (creep.room && creep.room.name);
  if (!homeRoom || !sourceId) return false;
  var home = ensureHomeMemory(homeRoom);
  var rec = home.sources[sourceId];
  if (!rec) return false;
  if (isLocalOwnedRoomForLuna(homeRoom, targetRoom || rec.remoteRoom).blocked) return false;
  rec.assignedLuna = creep.name;
  rec.remoteRoom = targetRoom || rec.remoteRoom;
  rec.reservedBy = null;
  rec.reservedUntil = 0;
  rec.status = 'assigned';
  rec.reason = 'claimed';
  rec.lastActive = Game.time;
  return true;
}

function releaseSource(creep) {
  // Live Luna release point. Luna calls this on unsafe rooms, stuck paths, end
  // of life, or duplicate ownership so the source can be queued again later.
  if (!creep || !creep.memory || !creep.memory.sourceId) return false;
  var homeRoom = creep.memory.home || creep.memory._home || (creep.room && creep.room.name);
  if (!homeRoom) return false;
  var home = ensureHomeMemory(homeRoom);
  var rec = home.sources[creep.memory.sourceId];
  if (!rec) return false;
  if (rec.assignedLuna === creep.name) rec.assignedLuna = null;
  rec.status = 'open';
  rec.reason = 'released';
  rec.reservedBy = null;
  rec.reservedUntil = 0;
  return true;
}

module.exports = {
  getApprovedRemotesFromScout: getApprovedRemotesFromScout,
  ensureMemory: ensureMemory,
  ensureHomeMemory: ensureHomeMemory,
  gatherCandidateRemoteRoomsForHome: gatherCandidateRemoteRoomsForHome,
  buildRemoteSourceEconomicsReport: buildRemoteSourceEconomicsReport,
  buildSourcePlanForHome: buildSourcePlanForHome,
  auditAssignmentsForHome: auditAssignmentsForHome,
  reserveSourceForQueue: reserveSourceForQueue,
  unreserveSourceForQueue: unreserveSourceForQueue,
  claimSource: claimSource,
  releaseSource: releaseSource,
  isRemoteUnsafe: isRemoteUnsafe,
  refreshVisibleRemoteSafety: refreshVisibleRemoteSafety,
  isLocalOwnedRoomForLuna: isLocalOwnedRoomForLuna
};
