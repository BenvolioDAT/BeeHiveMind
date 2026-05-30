'use strict';

// -----------------------------------------------------------------------------
// role.Veinseeker.Remote.js - remote miner/forager behavior
// Owns:
// * Live Veinseeker creep memory: role/task/home/sourceId/targetRoom/assigned,
//   assignedContainer/containerId, seat coordinates, repair state, and movement
//   breadcrumbs such as _stuck/_retargetAt/_forceYield.
// * Legacy Memory.remoteAssignments same-tick/live ownership records.
// * Remote container producer records:
//   Memory.__BHM.remoteContainerStatus,
//   Memory.__BHM.remoteContainerBuilds,
//   Memory.__BHM.remoteHaulRequests.
// Reads:
// * SourceEnergy.Manager's Memory.__BHM.sourceEnergy plan for queue/live
//   source ownership, plus Memory.rooms[remote].sources/intel safety fields.
// Usually called by:
// * BeeHiveMind.runCreeps() through role.Veinseeker.js.
// Systems that depend on it:
// * BeeSpawnManager uses the source/build state to decide replacement Veinseeker
//   quotas; role.Trucker.Dispatcher consumes remoteHaulRequests; Repair consumes
//   remoteContainerStatus for emergency repair work.
// Do not casually change:
// * Assignment/release order, container status keys, haul request keys, or
//   unsafe-room Memory fields. Those are shared cross-module contracts.
// -----------------------------------------------------------------------------
const BeeToolbox = require('BeeToolbox');
const CombatSquads = require('Combat.Squads');
const MovementManager = require('Movement.Manager');
var CFG = require('role.Veinseeker.Config');
var SourceEnergyManager = require('SourceEnergy.Manager');
var SourceWorkerManager = require('SourceWorker.Manager');

var REMOTE_DEFENSE_MAX_DISTANCE = CFG.REMOTE_DEFENSE_MAX_DISTANCE;
var THREAT_DECAY_TICKS_COPY = CFG.THREAT_DECAY_TICKS_COPY;
var REMOTE_RADIUS = CFG.REMOTE_RADIUS;
var MAX_PF_OPS = CFG.MAX_PF_OPS;
var PLAIN_COST = CFG.PLAIN_COST;
var SWAMP_COST = CFG.SWAMP_COST;
var MAX_VEINSEEKER_PER_SOURCE = CFG.MAX_VEINSEEKER_PER_SOURCE;
var ALLOW_MULTI_VEINSEEKER_PER_SOURCE = CFG.ALLOW_MULTI_VEINSEEKER_PER_SOURCE !== false;
var MIN_OPEN_HARVEST_TILES_PER_EXTRA_VEINSEEKER = CFG.MIN_OPEN_HARVEST_TILES_PER_EXTRA_VEINSEEKER || 2;
var PREFER_EMPTY_SOURCES_BEFORE_STACKING = CFG.PREFER_EMPTY_SOURCES_BEFORE_STACKING !== false;
var VEINSEEKER_SECONDARY_SOURCE_SCORE_PENALTY = CFG.VEINSEEKER_SECONDARY_SOURCE_SCORE_PENALTY || 150;
var VEINSEEKER_FIRST_OPEN_BONUS = (typeof CFG.VEINSEEKER_FIRST_OPEN_BONUS === 'number') ? CFG.VEINSEEKER_FIRST_OPEN_BONUS : -120;
var VEINSEEKER_UNDERHARVEST_ENERGY_THRESHOLD = CFG.VEINSEEKER_UNDERHARVEST_ENERGY_THRESHOLD || 800;
var VEINSEEKER_RESERVED_SOURCE_SECOND_MIN_WORK = CFG.VEINSEEKER_RESERVED_SOURCE_SECOND_MIN_WORK || 4;
var PF_CACHE_TTL = CFG.PF_CACHE_TTL;
var INVADER_LOCK_MEMO_TTL = CFG.INVADER_LOCK_MEMO_TTL;
var UNSAFE_ROOM_TTL = CFG.UNSAFE_ROOM_TTL;
var AVOID_TTL = CFG.AVOID_TTL;
var RETARGET_COOLDOWN = CFG.RETARGET_COOLDOWN;
var ASSIGN_STICKY_TTL = CFG.ASSIGN_STICKY_TTL;
var STUCK_WINDOW = CFG.STUCK_WINDOW;
var FLAG_PRUNE_PERIOD = CFG.FLAG_PRUNE_PERIOD;
var FLAG_RETENTION_TTL = CFG.FLAG_RETENTION_TTL;
var VEINSEEKER_BLOCKED_SOURCE_TTL = CFG.VEINSEEKER_BLOCKED_SOURCE_TTL || 10000;
var VEINSEEKER_BLOCKED_ROOM_TTL = CFG.VEINSEEKER_BLOCKED_ROOM_TTL || 10000;
var VEINSEEKER_REJECT_INACCESSIBLE_SOURCES = CFG.VEINSEEKER_REJECT_INACCESSIBLE_SOURCES !== false;
var VEINSEEKER_INACCESSIBLE_BLOCK_TTL = CFG.VEINSEEKER_INACCESSIBLE_BLOCK_TTL || VEINSEEKER_BLOCKED_SOURCE_TTL;
var VEINSEEKER_PATH_FAIL_LIMIT = CFG.VEINSEEKER_PATH_FAIL_LIMIT || 3;
var VEINSEEKER_STUCK_SOURCE_BLOCK_TICKS = CFG.VEINSEEKER_STUCK_SOURCE_BLOCK_TICKS || 8;
var VEINSEEKER_STUCK_SOURCE_BLOCK_TTL = CFG.VEINSEEKER_STUCK_SOURCE_BLOCK_TTL || 250;
var VEINSEEKER_REMOTE_INTEL_TTL = CFG.VEINSEEKER_REMOTE_INTEL_TTL || 3000;
var VEINSEEKER_UNASSIGNED_SUICIDE_TICKS = (typeof CFG.VEINSEEKER_UNASSIGNED_SUICIDE_TICKS === 'number') ? CFG.VEINSEEKER_UNASSIGNED_SUICIDE_TICKS : 750;

// =========================
// Debug helpers
// =========================
// BeeToolbox owns the repeated debug say/line plumbing. Veinseeker keeps debugRing
// role-local because its ring radius/default stroke/RoomVisual width differ
// from the generic helper and those visuals are useful while tracing remotes.
function debugOptions() {
  return {
    enabled: CFG.DEBUG_DRAW,
    width: CFG.DRAW.WIDTH,
    opacity: CFG.DRAW.OPACITY,
    font: CFG.DRAW.FONT
  };
}

function debugSay(creep, msg) {
  BeeToolbox.sayIfDebugEnabled(creep, msg, CFG.DEBUG_SAY);
}

function debugDrawLine(creep, target, color, label) {
  BeeToolbox.drawDebugLine(creep, target, color, label, debugOptions());
}

function debugRing(room, pos, color, text) {
  if (!CFG.DEBUG_DRAW || !room || !room.visual || !pos) return;
  try {
    room.visual.circle(pos, { radius: 0.45, fill: 'transparent', stroke: color || '#fff', opacity: CFG.DRAW.OPACITY });
    if (text) room.visual.text(text, pos.x, pos.y - 0.6, { color: color || '#fff', opacity: CFG.DRAW.OPACITY, font: CFG.DRAW.FONT });
  } catch (e) {}
}

// =========================
// Threat helpers shared with Scout-style remote intel.
// =========================
function ensureCombatIntelMemory() {
  if (CombatSquads && CombatSquads.SquadFlagIntel && typeof CombatSquads.SquadFlagIntel.ensureMemory === 'function') {
    return CombatSquads.SquadFlagIntel.ensureMemory();
  }
  if (!Memory.squadFlags) Memory.squadFlags = { rooms: {}, bindings: {} };
  if (!Memory.squadFlags.rooms) Memory.squadFlags.rooms = {};
  if (!Memory.squadFlags.bindings) Memory.squadFlags.bindings = {};
  return Memory.squadFlags;
}

function ensureRemoteSquadMemory(flagName) {
  if (!flagName) return null;
  if (!Memory.squads) Memory.squads = {};
  var bucket = Memory.squads[flagName];
  if (!bucket) {
    bucket = {
      state: 'INIT',
      targetId: null,
      members: { leader: null, buddy: null, medic: null },
      rally: null,
      lastSeenTick: 0
    };
    Memory.squads[flagName] = bucket;
  } else {
    if (!bucket.members) bucket.members = { leader: null, buddy: null, medic: null };
    if (!bucket.state) bucket.state = 'INIT';
  }
  return bucket;
}

function ensureThreatCache() {
  if (!global.__beeThreatIntelCache || global.__beeThreatIntelCache.tick !== Game.time) {
    global.__beeThreatIntelCache = { tick: Game.time, spawnRooms: null, distance: {} };
  }
  if (!global.__beeThreatIntelCache.distance) global.__beeThreatIntelCache.distance = {};
  return global.__beeThreatIntelCache;
}

function listOwnedSpawnRooms() {
  var cache = ensureThreatCache();
  if (cache.spawnRooms) return cache.spawnRooms;
  var seen = {};
  var list = [];
  for (var name in Game.spawns) {
    if (!Game.spawns.hasOwnProperty(name)) continue;
    var spawn = Game.spawns[name];
    if (!spawn || !spawn.my) continue;
    var roomName = (spawn.room && spawn.room.name) || (spawn.pos && spawn.pos.roomName);
    if (!roomName || seen[roomName]) continue;
    seen[roomName] = true;
    list.push(roomName);
  }
  cache.spawnRooms = list;
  return list;
}

function roomDistanceFromOwnedSpawn(roomName) {
  if (!roomName) return Infinity;
  var cache = ensureThreatCache();
  if (cache.distance[roomName] != null) return cache.distance[roomName];
  var spawnRooms = listOwnedSpawnRooms();
  var best = Infinity;
  for (var i = 0; i < spawnRooms.length; i++) {
    var owned = spawnRooms[i];
    if (owned === roomName) { best = 0; break; }
    var route = null;
    try {
      route = Game.map.findRoute(roomName, owned);
    } catch (e) {
      route = ERR_NO_PATH;
    }
    if (route === ERR_NO_PATH || route == null) continue;
    var dist = Array.isArray(route) ? route.length : (typeof route.length === 'number' ? route.length : Infinity);
    if (dist < best) best = dist;
  }
  cache.distance[roomName] = best;
  return best;
}

function computeThreatBundle(room) {
  if (!room) return { score: 0, hasThreat: false, bestId: null };
  if (CombatSquads && typeof CombatSquads.getLiveThreatForRoom === 'function') {
    try {
      var data = CombatSquads.getLiveThreatForRoom(room);
      if (data) return data;
    } catch (e) {}
  }
  var hostiles = [];
  try {
    hostiles = room.find(FIND_HOSTILE_CREEPS) || [];
  } catch (err) {}
  var bestId = hostiles.length ? hostiles[0].id : null;
  return { score: hostiles.length * 5, hasThreat: hostiles.length > 0, bestId: bestId };
}

function recordThreatIntel(room, threatBundle, shouldEscalate, sourceTag, distance) {
  if (!room) return;
  var roomName = room.name || (room.pos ? room.pos.roomName : null);
  if (!roomName) return;
  var intel = ensureCombatIntelMemory();
  if (!intel) return;
  if (!intel.rooms) intel.rooms = {};
  var rec = intel.rooms[roomName];
  if (!rec) {
    rec = { lastSeen: 0, lastThreatAt: 0, lastPos: null, lastScore: 0 };
  }
  rec.lastSeen = Game.time;
  var anchor = null;
  if (room.controller && room.controller.pos) anchor = room.controller.pos;
  else if (room.storage && room.storage.pos) anchor = room.storage.pos;
  else if (room.pos) anchor = room.pos;
  else anchor = new RoomPosition(25, 25, roomName);
  rec.lastPos = { x: anchor.x, y: anchor.y, roomName: roomName };
  if (distance != null) rec.lastDistanceFromSpawn = distance;
  if (sourceTag) rec.lastIntelSource = sourceTag;
  var score = (threatBundle && typeof threatBundle.score === 'number') ? threatBundle.score : 0;
  var sawThreat = Boolean(threatBundle && threatBundle.hasThreat);
  if (shouldEscalate) {
    rec.lastScore = score;
    if (sawThreat) {
      rec.lastThreatAt = Game.time;
    } else if (rec.lastScore > 0) {
      var since = Game.time - (rec.lastThreatAt || rec.lastSeen || 0);
      if (since > THREAT_DECAY_TICKS_COPY) rec.lastScore = 0;
    }
    if (rec.deferredThreat) delete rec.deferredThreat;
  } else {
    rec.lastScore = 0;
    if (sawThreat && score > 0) {
      rec.deferredThreat = { score: score, lastSeen: Game.time, distance: distance, source: sourceTag || 'Scout' };
      rec.lastThreatAt = Game.time;
    } else if (rec.deferredThreat) {
      delete rec.deferredThreat;
    }
  }
  intel.rooms[roomName] = rec;
}

function evaluateRoomThreat(room, sourceTag) {
  if (!room) return null;
  var threatBundle = computeThreatBundle(room);
  var distance = roomDistanceFromOwnedSpawn(room.name);
  var canEscalate = (distance <= REMOTE_DEFENSE_MAX_DISTANCE);
  var allowScore = (!threatBundle || !threatBundle.hasThreat) ? true : canEscalate;
  recordThreatIntel(room, threatBundle, allowScore, sourceTag, distance);
  return { threat: threatBundle, distance: distance, canEscalate: canEscalate };
}

function ensureRemoteDefensePlan(room, threatBundle, distance) {
  if (!room || !threatBundle || !threatBundle.hasThreat || !(threatBundle.score > 0)) return;
  var flagName = 'Squad' + room.name;
  var bucket = Memory.squads && Memory.squads[flagName] ? Memory.squads[flagName] : null;
  if (bucket && !bucket.remoteDefense && !bucket.autoDefense) {
    // Respect manual squads that already claimed this flag name.
    return;
  }
  bucket = ensureRemoteSquadMemory(flagName);
  if (!bucket) return;
  bucket.remoteDefense = true;
  if (!bucket.planType) bucket.planType = 'REMOTE_DEFENSE';
  bucket.targetRoom = room.name;
  bucket.lastKnownScore = threatBundle.score;
  bucket.lastDefenseTick = Game.time;
  bucket.lastSeenTick = Game.time;
  bucket.lastDistance = distance;
  var rallyPos = (room.controller && room.controller.pos) || (room.storage && room.storage.pos) || new RoomPosition(25, 25, room.name);
  bucket.rally = { x: rallyPos.x, y: rallyPos.y, roomName: rallyPos.roomName };
  var attackPos = null;
  if (threatBundle.bestId) {
    var obj = Game.getObjectById(threatBundle.bestId);
    if (obj && obj.pos) attackPos = obj.pos;
  }
  if (!attackPos) attackPos = rallyPos;
  var serialized = { x: attackPos.x, y: attackPos.y, roomName: attackPos.roomName };
  bucket.targetPos = serialized;
  bucket.focusTargetPos = serialized;
  bucket.target = serialized;
  bucket.targetId = threatBundle.bestId || null;
  bucket.focusTarget = threatBundle.bestId || null;
  bucket.requestedAt = Game.time;
  var intel = ensureCombatIntelMemory();
  if (intel && intel.bindings) {
    intel.bindings[flagName] = { flagName: flagName, target: serialized, targetId: bucket.targetId, source: 'Veinseeker' };
  }
  Memory.squads[flagName] = bucket;
}

function softenRemoteDefensePlan(roomName) {
  if (!roomName || !Memory.squads) return;
  var flagName = 'Squad' + roomName;
  var bucket = Memory.squads[flagName];
  if (!bucket || !bucket.remoteDefense) return;
  bucket.lastKnownScore = 0;
}

  // ============================
  // Tunables (existing behaviour)
  // ============================
  // NOTE: REMOTE_RADIUS is measured in "room hops" from the home room.
  // Values are sourced from config-backed declarations near the file top.

  // ============================
  // Helpers: short id, flags
  // ============================
  function shortSid(id) {
    if (!id || typeof id !== 'string') return '??????';
    var n = id.length; return id.substr(n - 6);
  }

  // Returns the Memory.rooms[roomName] bucket, creating it if missing.
  function getRoomMemoryBucket(roomName){
    Memory.rooms = Memory.rooms || {};
    return (Memory.rooms[roomName] = (Memory.rooms[roomName] || {}));
  }
  // Returns the per-source memory bucket for a given room and source id.
  function getSourceMemory(roomName, sid) {
    var rm = getRoomMemoryBucket(roomName);
    rm.sources = rm.sources || {};
    return (rm.sources[sid] = (rm.sources[sid] || {}));
  }
  function shouldLogVeinseekerBlock(key, interval) {
    var step = interval || 250;
    if (!Memory.__BHM) Memory.__BHM = {};
    if (!Memory.__BHM.sourceWorkerBlockLog) Memory.__BHM.sourceWorkerBlockLog = {};
    var last = Memory.__BHM.sourceWorkerBlockLog[key] || 0;
    if ((Game.time - last) < step) return false;
    Memory.__BHM.sourceWorkerBlockLog[key] = Game.time;
    return true;
  }
  function clearExpiredVeinseekerSourceBlock(roomName, sourceId) {
    if (!roomName || !sourceId) return;
    var srec = getSourceMemory(roomName, sourceId);
    if (srec && srec.sourceWorkerBlockedUntil && srec.sourceWorkerBlockedUntil <= Game.time) {
      delete srec.sourceWorkerBlockedUntil; delete srec.sourceWorkerBlockedReason;
    }
  }
  function isVeinseekerSourceBlocked(roomName, sourceId) {
    if (!roomName || !sourceId) return false;
    clearExpiredVeinseekerSourceBlock(roomName, sourceId);
    var srec = getSourceMemory(roomName, sourceId);
    return !!(srec && srec.sourceWorkerBlockedUntil && srec.sourceWorkerBlockedUntil > Game.time);
  }
  function markVeinseekerSourceBlocked(roomName, sourceId, reason, ttl) {
    if (!roomName || !sourceId) return;
    var until = Game.time + Math.max(1, ttl || VEINSEEKER_BLOCKED_SOURCE_TTL);
    var srec = getSourceMemory(roomName, sourceId);
    srec.sourceWorkerBlockedUntil = until;
    srec.sourceWorkerBlockedReason = reason || 'blocked-source';
    var rm = getRoomMemoryBucket(roomName);
    rm.lastSourceWorkerBlock = { tick: Game.time, type: 'source', sourceId: sourceId, reason: srec.sourceWorkerBlockedReason, until: until };
    if (shouldLogVeinseekerBlock('src:' + roomName + ':' + sourceId, 250)) {
      console.log('🚫 Veinseeker source blocked ' + roomName + ' ' + sourceId.slice(-6) + ' reason=' + srec.sourceWorkerBlockedReason + ' until=' + until);
    }
  }
  function markVeinseekerRoomBlocked(roomName, reason, ttl) {
    if (!roomName) return;
    var rm = getRoomMemoryBucket(roomName);
    rm.sourceWorkerBlockedUntil = Game.time + Math.max(1, ttl || VEINSEEKER_BLOCKED_ROOM_TTL);
    rm.sourceWorkerBlockedReason = reason || 'blocked-room';
    rm.lastSourceWorkerBlock = { tick: Game.time, type: 'room', reason: rm.sourceWorkerBlockedReason, until: rm.sourceWorkerBlockedUntil };
    if (shouldLogVeinseekerBlock('room:' + roomName, 250)) {
      console.log('🚫 Veinseeker room blocked ' + roomName + ' reason=' + rm.sourceWorkerBlockedReason + ' until=' + rm.sourceWorkerBlockedUntil);
    }
  }
  
  function recordVeinseekerPathFailure(creep, sourceId, reason) {
    if (!creep || !creep.memory) return 0;

    var sid = sourceId || creep.memory.sourceId;
    var roomName = creep.memory.targetRoom || creep.pos.roomName;
    var failReason = reason || 'path-fail';

    if (creep.memory._pathFailSid !== sid) creep.memory._pathFailCount = 0;
    creep.memory._pathFailSid = sid;
    creep.memory._pathFailCount = (creep.memory._pathFailCount || 0) + 1;

    if (shouldLogVeinseekerBlock('fail:' + creep.name + ':' + sid, 250)) {
      console.log(
        '⚠️ Veinseeker path fail ' +
        creep.name +
        ' sid=' + (sid ? sid.slice(-6) : 'none') +
        ' count=' + creep.memory._pathFailCount +
        ' reason=' + failReason
      );
    }

    // Room-travel failures are noisy and can happen from temporary routing,
    // border travel, traffic, incomplete Traveler paths, or route cache weirdness.
    //
    // Do NOT mark the whole remote source/room blocked from this alone.
    // A valid remote room can look "blocked" forever if one travel attempt poisons
    // Memory. Instead, put only this creep on a short retarget cooldown.
if (failReason === 'path-to-room' ||
    failReason === 'room-travel' ||
    failReason === 'path-to-room-incomplete' ||
    failReason === 'room-travel-incomplete') {

  // Room travel can fail from temporary Traveler/router weirdness, traffic,
  // stale route cache, or bad edge positioning. Do not poison the whole remote
  // room/source from this alone.
  //
  // But also do not let one creep retry the same failed assignment forever.
  // Once the same assigned source has failed several times, release only this
  // creep's assignment. releaseAssignment() already puts the source into this
  // creep's short avoid list, so it can try a different source after cooldown.
  if (creep.memory._pathFailCount >= VEINSEEKER_PATH_FAIL_LIMIT) {
    if (!creep.memory._lastRoomTravelReleaseLog ||
          (Game.time - creep.memory._lastRoomTravelReleaseLog) >= 25) {
        console.log(
          '🚦 Veinseeker ' + creep.name +
          ' releasing room-travel assignment without blocking room/source' +
          ' room=' + roomName +
          ' sid=' + (sid ? sid.slice(-6) : 'none') +
          ' reason=' + failReason +
          ' count=' + creep.memory._pathFailCount
        );
        creep.memory._lastRoomTravelReleaseLog = Game.time;
      }

        creep.memory._pathFailCount = 0;
        markAvoidRoom(creep, roomName, AVOID_TTL);
        releaseAssignment(creep);
        return 0;
    }

    creep.memory._retargetAt = Game.time + RETARGET_COOLDOWN;
    return creep.memory._pathFailCount;
  }

    if (creep.memory._pathFailCount >= VEINSEEKER_PATH_FAIL_LIMIT && sid && roomName) {
      markVeinseekerSourceBlocked(
        roomName,
        sid,
        failReason,
        VEINSEEKER_BLOCKED_SOURCE_TTL
      );

      // Only non-room-travel failures may block the room. This keeps one bad
      // source-seat/source-path from turning a whole visible usable remote into
      // "no safe assignment."
      if (creep.pos.roomName !== roomName) {
        markVeinseekerRoomBlocked(
          roomName,
          failReason,
          VEINSEEKER_BLOCKED_ROOM_TTL
        );
      }

      releaseAssignment(creep);
    }

    return creep.memory._pathFailCount;
  }
function clearVeinseekerPathFailure(creep, sourceId) {
  if (!creep || !creep.memory) return;
  var sid = sourceId || creep.memory.sourceId;
  if (!sid) return;
  if (creep.memory._pathFailSid === sid) {
    creep.memory._pathFailCount = 0;
  }
}
function veinseekerTravelToAssigned(creep, target, opts, sourceId, failReason) {
  if (!creep || !target) return ERR_INVALID_TARGET;
  var travelOpts = {};
  var k;
  if (opts) {
    for (k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) travelOpts[k] = opts[k];
  }
  var returnData = {};
  travelOpts.maxOps = CFG.TRAVEL_MAX_OPS || 4000;
  travelOpts.returnData = returnData;
  var rc = creep.travelTo(target, travelOpts);
  if (rc === ERR_NO_PATH) {
    recordVeinseekerPathFailure(creep, sourceId, failReason || 'no-path');
    return rc;
  }
  if (returnData.pathfinderReturn && returnData.pathfinderReturn.incomplete && creep.memory && creep.memory._stuck >= STUCK_WINDOW) {
    recordVeinseekerPathFailure(creep, sourceId, (failReason || 'path') + '-incomplete');
    return rc;
  }

  // If travelTo did not report ERR_NO_PATH and the pathfinder did not report an
  // incomplete stuck path, treat this as a usable travel attempt and clear the
  // old path-failure counter for this source.
  if (rc === OK || rc === ERR_TIRED || rc === ERR_BUSY) {
    clearVeinseekerPathFailure(creep, sourceId);
  }

  return rc;
}

  // mark activity each time we touch/own/harvest a source
  function touchSourceActive(roomName, sid) {
    if (!roomName || !sid) return;
    var srec = getSourceMemory(roomName, sid);
    srec.lastActive = Game.time;
  }

  /** Ensure exactly one flag exists on this source tile (idempotent) and touch lastActive. */
  function ensureSourceFlag(source) {
    if (!source || !source.pos || !source.room) return;

    var roomName = source.pos.roomName;
    var srec = getSourceMemory(roomName, source.id);

    // reuse previous flag if it still matches this tile
    if (srec.flagName) {
      var f = Game.flags[srec.flagName];
      if (f &&
          f.pos.x === source.pos.x &&
          f.pos.y === source.pos.y &&
          f.pos.roomName === roomName) {
        touchSourceActive(roomName, source.id);
        return;
      }
    }

    // does a properly-named flag already sit here? adopt it
    var flagsHere = source.pos.lookFor(LOOK_FLAGS) || [];
    var expectedPrefix = 'SRC-' + roomName + '-';
    var sidTail = shortSid(source.id);
    for (var i = 0; i < flagsHere.length; i++) {
      var fh = flagsHere[i];
      if (typeof fh.name === 'string' &&
          fh.name.indexOf(expectedPrefix) === 0 &&
          fh.name.indexOf(sidTail) !== -1) {
        srec.flagName = fh.name;
        touchSourceActive(roomName, source.id);
        return;
      }
    }

    // create a new one
    var base = expectedPrefix + sidTail;
    var name = base, tries = 1;
    while (Game.flags[name]) { tries++; name = base + '-' + tries; if (tries > 10) break; }
    var rc = source.room.createFlag(source.pos, name, COLOR_YELLOW, COLOR_YELLOW);
    if (typeof rc === 'string') {
      srec.flagName = rc;
      touchSourceActive(roomName, source.id);
    }
  }

  // ============================
  // NEW: Controller flag helpers (Reserve:roomName style)
  // ============================
  function ensureControllerFlag(ctrl){
    if (!ctrl) return;
    var roomName = ctrl.pos.roomName;
    var rm = getRoomMemoryBucket(roomName);

    var expect = 'Reserve:' + roomName;

    if (rm.controllerFlagName) {
      var f0 = Game.flags[rm.controllerFlagName];
      if (f0 &&
          f0.pos.x === ctrl.pos.x &&
          f0.pos.y === ctrl.pos.y &&
          f0.pos.roomName === roomName) {
        return;
      }
    }

    var flagsHere = ctrl.pos.lookFor(LOOK_FLAGS) || [];
    for (var i = 0; i < flagsHere.length; i++) {
      if (flagsHere[i].name === expect) {
        rm.controllerFlagName = expect;
        return;
      }
    }

    var rc = ctrl.room.createFlag(ctrl.pos, expect, COLOR_WHITE, COLOR_PURPLE);
    if (typeof rc === 'string') rm.controllerFlagName = rc;
  }

  function pruneControllerFlagIfNoForagers(roomName, roomCountMap){
    var rm = getRoomMemoryBucket(roomName);
    var fname = rm.controllerFlagName;
    if (!fname) return;

    var count = roomCountMap && roomCountMap[roomName] ? roomCountMap[roomName] : 0;
    if (count > 0) return;

    var f = Game.flags[fname];
    if (f) {
      try { f.remove(); } catch (e) {}
    }
    delete rm.controllerFlagName;
  }

  // ============================
  // Avoid-list (per creep)
  // ============================
  // Ensures we have a creep.memory._avoid bucket to track stuck tiles.
  function ensureAvoidanceMemory(creep){
    if (!creep.memory._avoid) creep.memory._avoid = {};
    return creep.memory._avoid;
  }
  function shouldAvoid(creep, sid){ var a=ensureAvoidanceMemory(creep); var t=a[sid]; return (typeof t==='number' && Game.time<t); }
  function markAvoid(creep, sid, ttl){ var a=ensureAvoidanceMemory(creep); a[sid] = Game.time + (ttl!=null?ttl:AVOID_TTL); }
  function avoidRemaining(creep, sid){ var a=ensureAvoidanceMemory(creep); var t=a[sid]; if (typeof t!=='number') return 0; var left=t-Game.time; return left>0?left:0; }

  function ensureRoomAvoidanceMemory(creep) {
  if (!creep.memory._avoidRooms) creep.memory._avoidRooms = {};
  return creep.memory._avoidRooms;
  }

  function shouldAvoidRoom(creep, roomName) {
    if (!creep || !creep.memory || !roomName) return false;

    var avoidRooms = ensureRoomAvoidanceMemory(creep);
    var until = avoidRooms[roomName];

    return typeof until === 'number' && Game.time < until;
  }

  function markAvoidRoom(creep, roomName, ttl) {
    if (!creep || !creep.memory || !roomName) return;

    var avoidRooms = ensureRoomAvoidanceMemory(creep);
    avoidRooms[roomName] = Game.time + (ttl != null ? ttl : AVOID_TTL);
  }

  // ============================
  // Per-tick *claim* (same-tick contention guard)
  // ============================
  // Shared reservation table for remote mining seat claims (cleared each tick).
  function getClaimTable(){
    // Same-tick contention guard. This table resets every tick and prevents two
    // Veinseeker creeps from selecting the same source in the same decision pass.
    var sc=Memory._sourceClaim;
    if(!sc||sc.t!==Game.time){ Memory._sourceClaim={t:Game.time,m:{}}; }
    return Memory._sourceClaim.m;
  }
  function tryClaimSourceForTick(creep, sid){
    var m=getClaimTable(), cur=m[sid];
    if (!cur){ m[sid]=creep.name; return true; }
    if (creep.name < cur){ m[sid]=creep.name; return true; }
    return cur===creep.name;
  }

  // ============================
  // remoteAssignments model
  // ============================
  function ensureAssignmentsMem(){ if(!Memory.remoteAssignments) Memory.remoteAssignments={}; return Memory.remoteAssignments; }
  // Normalises a mining assignment entry so later logic can rely on keys existing.
  function ensureMiningAssignment(entry, roomName){
    // Legacy saves used a plain number here. Newer code uses a richer record
    // with owner/owners/maxSlots so multi-Veinseeker source ownership can be audited.
    if (!entry || typeof entry !== 'object') entry = { count: 0, owner: null, roomName: roomName||null, since: null };
    if (typeof entry.count !== 'number') entry.count = 0;
    if (!('owner' in entry)) entry.owner = null;
    if (!('roomName' in entry)) entry.roomName = roomName||null;
    if (!('since' in entry)) entry.since = null;
    if (!Array.isArray(entry.owners)) {
      if (entry.owner) entry.owners = [entry.owner];
      else entry.owners = [];
    }
    if (typeof entry.maxSlots !== 'number') entry.maxSlots = MAX_VEINSEEKER_PER_SOURCE;
    if (typeof entry.lastAudit !== 'number') entry.lastAudit = 0;
    return entry;
  }
  function maCount(memAssign, sid){
    var e = memAssign[sid];
    if (!e) return 0;
    if (typeof e === 'number') return e; // backward compat
    return typeof e.count === 'number' ? e.count : 0;
  }
  function maOwner(memAssign, sid){
    var e = memAssign[sid];
    if (!e || typeof e === 'number') return null;
    return e.owner || null;
  }
  function maOwners(memAssign, sid){
    var e = ensureMiningAssignment(memAssign[sid], null);
    return e.owners || [];
  }
  function getLiveVeinseekerContendersForSource(sid){
    var contenders = [];
    for (var name in Game.creeps){
      var c = Game.creeps[name];
      if (!c || !c.memory) continue;
      if (c.memory.task === 'veinseeker' && c.memory.sourceId === sid) contenders.push(c);
    }
    return contenders;
  }
  function ownersMatchLiveContenders(entry, contenders, sid){
    var e = ensureMiningAssignment(entry, null);
    var owners = e.owners || [];
    if (owners.length !== contenders.length) return false;
    if ((e.owner || null) !== (owners[0] || null)) return false;

    var liveMap = {};
    for (var i = 0; i < contenders.length; i++) liveMap[contenders[i].name] = true;
    for (var j = 0; j < owners.length; j++) {
      var ownerName = owners[j];
      var oc = Game.creeps[ownerName];
      if (!liveMap[ownerName]) return false;
      if (!oc || !oc.memory || oc.memory.task !== 'veinseeker' || oc.memory.sourceId !== sid) return false;
    }
    return true;
  }
  function getSourceMaxSlots(sid) {
    return SourceWorkerManager.getSourceMaxSlots(sid, null, {
      allowMulti: ALLOW_MULTI_VEINSEEKER_PER_SOURCE,
      maxPerSource: MAX_VEINSEEKER_PER_SOURCE,
      minOpenForExtra: MIN_OPEN_HARVEST_TILES_PER_EXTRA_VEINSEEKER
    });
  }
  function rankContenderForSource(a, sourcePos){
    var assignTick = (a && a.memory && typeof a.memory._assignTick === 'number') ? a.memory._assignTick : 0;
    var dist = sourcePos && a && a.pos ? a.pos.getRangeTo(sourcePos) : 999;
    return { creep: a, assignTick: assignTick, dist: dist };
  }
  function maSetOwner(memAssign, sid, owner, roomName){
    var e = ensureMiningAssignment(memAssign[sid], roomName);
    if (owner && e.owners.indexOf(owner) === -1) e.owners.push(owner);
    e.owner = owner; e.roomName = roomName || e.roomName; e.since = Game.time;
    e.maxSlots = getSourceMaxSlots(sid);
    e.lastAudit = Game.time;
    memAssign[sid] = e;
    if (e.roomName) touchSourceActive(e.roomName, sid);
  }
  function maClearOwner(memAssign, sid){
    var e = ensureMiningAssignment(memAssign[sid], null);
    e.owner = null; e.since = null;
    e.owners = [];
    e.count = 0;
    e.lastAudit = Game.time;
    memAssign[sid] = e;
  }
  function maInc(memAssign, sid, roomName){
    var e = ensureMiningAssignment(memAssign[sid], roomName);
    var current = typeof e.count === 'number' ? e.count : 0;
    e.count = current + 1;
    memAssign[sid]=e;
  }
  function maDec(memAssign, sid){
    var e = ensureMiningAssignment(memAssign[sid], null);
    var current = typeof e.count === 'number' ? e.count : 0;
    e.count = Math.max(0, current - 1);
    memAssign[sid]=e;
  }

  // ============================
  // Ownership / duplicate resolver
  // ============================
  function resolveOwnershipForSid(sid){
    // Authoritative duplicate resolver for live Veinseeker creeps on one source. It
    // ranks contenders and marks losing creeps with _forceYield instead of
    // moving them immediately; the main run loop handles the release safely.
    var memAssign = ensureAssignmentsMem();
    var e = ensureMiningAssignment(memAssign[sid], null);

    var contenders = getLiveVeinseekerContendersForSource(sid);

    if (!contenders.length){
      maClearOwner(memAssign, sid);
      return null;
    }

    var src = Game.getObjectById(sid);
    var srcPos = src && src.pos ? src.pos : null;
    var maxSlots = getSourceMaxSlots(sid);
    var ranked = contenders.map(function(c){ return rankContenderForSource(c, srcPos); });
    ranked.sort(function(a,b){
      if (a.assignTick !== b.assignTick) return a.assignTick - b.assignTick;
      if (a.dist !== b.dist) return a.dist - b.dist;
      return a.creep.name < b.creep.name ? -1 : 1;
    });
    var winners = ranked.slice(0, maxSlots).map(function(r){ return r.creep; });
    var winner = winners[0];
    var entry = ensureMiningAssignment(memAssign[sid], winner.memory.targetRoom||null);
    entry.owners = winners.map(function(w){ return w.name; });
    entry.owner = entry.owners[0] || null;
    entry.count = contenders.length;
    entry.maxSlots = maxSlots;
    entry.lastAudit = Game.time;
    memAssign[sid] = entry;

    for (var i=maxSlots; i<ranked.length; i++){
      var loser = ranked[i].creep;
      if (loser && loser.memory && loser.memory.sourceId === sid){
        loser.memory._forceYield = true;
      }
    }

    return winner.name;
  }

  // Audits all sids once per tick: recompute counts, scrub dead owners, and prune flags
  function auditRemoteAssignments(){
    // Once-per-tick cleanup for Memory.remoteAssignments. It recomputes counts
    // from live creeps, clears dead owners, and prunes old source/controller
    // flags so stale assignment memory does not block new Veinseeker creeps forever.
    var memAssign = ensureAssignmentsMem();

    for (var sid in memAssign){
      memAssign[sid] = ensureMiningAssignment(memAssign[sid], memAssign[sid].roomName||null);
      memAssign[sid].count = 0;
    }

    var roomCounts = {};
    for (var name in Game.creeps){
      var c = Game.creeps[name];
      if (!c || !c.memory) continue;
      if (c.memory.task === 'veinseeker') {
        if (c.memory.sourceId){
          var sid2 = c.memory.sourceId;
          var e2 = ensureMiningAssignment(memAssign[sid2], c.memory.targetRoom||null);
          var currentCount = typeof e2.count === 'number' ? e2.count : 0;
          e2.count = currentCount + 1;
          memAssign[sid2] = e2;
        }
        if (c.memory.targetRoom){
          var rn = c.memory.targetRoom;
          var roomCurrent = roomCounts[rn] || 0;
          roomCounts[rn] = roomCurrent + 1;
        }
      }
    }

    for (var sid3 in memAssign){
      var entry = ensureMiningAssignment(memAssign[sid3], null);
      var cap = getSourceMaxSlots(sid3);
      var contenders = getLiveVeinseekerContendersForSource(sid3);
      if (!contenders.length) {
        maClearOwner(memAssign, sid3);
        continue;
      }
      if (entry.count > cap || !ownersMatchLiveContenders(entry, contenders, sid3)) {
        resolveOwnershipForSid(sid3);
      }
    }

    if ((Game.time % FLAG_PRUNE_PERIOD) === 0) pruneUnusedSourceFlags();

    var rooms = Memory.rooms || {};
    for (var roomName in rooms) {
      if (!rooms.hasOwnProperty(roomName)) continue;
      pruneControllerFlagIfNoForagers(roomName, roomCounts);
    }
  }

  function auditOncePerTick(){
    if (Memory._auditRemoteAssignmentsTick !== Game.time){
      auditRemoteAssignments();
      Memory._auditRemoteAssignmentsTick = Game.time;
    }
  }

  // ============================
  // Flag pruning (sources)
  // ============================
  function pruneUnusedSourceFlags(){
    var memAssign = ensureAssignmentsMem();
    var now = Game.time;

    var rooms = Memory.rooms || {};
    for (var roomName in rooms){
      if (!rooms.hasOwnProperty(roomName)) continue;
      var rm = rooms[roomName]; if (!rm || !rm.sources) continue;

      var roomLocked = isRoomLockedByInvaderCore(roomName);

      for (var sid in rm.sources){
        if (!rm.sources.hasOwnProperty(sid)) continue;
        var srec = rm.sources[sid] || {};
        var flagName = srec.flagName;
        if (!flagName) continue;

        var e = ensureMiningAssignment(memAssign[sid], rm.sources[sid].roomName || roomName);
        var count  = typeof e.count === 'number' ? e.count : 0;
        var owner  = e.owner || null;
        var last   = typeof srec.lastActive === 'number' ? srec.lastActive : 0;

        var inactiveLong = (now - last) > FLAG_RETENTION_TTL;
        var nobodyOwns   = (count === 0 && owner == null);

        if (roomLocked || (nobodyOwns && inactiveLong)) {
          var f = Game.flags[flagName];
          if (f) {
            var prefix = 'SRC-' + roomName + '-';
            var looksLikeOurs = (typeof flagName === 'string' && flagName.indexOf(prefix) === 0);
            var posMatches = (!srec.x || !srec.y) ? true : (f.pos.x === srec.x && f.pos.y === srec.y);
            var srcObj = Game.getObjectById(sid);
            var tileOk = srcObj ? (f.pos.x === srcObj.pos.x && f.pos.y === srcObj.pos.y && f.pos.roomName === srcObj.pos.roomName) : true;

            if (looksLikeOurs && (posMatches && tileOk)) {
              try { f.remove(); } catch (e1) {}
            }
          }
          delete srec.flagName;
          rm.sources[sid] = srec;
        }
      }
    }
  }

  // ============================
  // Pathing helpers (Traveler-first)
  // ============================
  if (!Memory._pfCost) Memory._pfCost = {};

  function isUsablePathCost(cost) {
  return typeof cost === 'number' &&
    cost >= 0 &&
    cost !== Infinity &&
    !isNaN(cost);
  }

  function pfCostCached(anchorPos, targetPos, sourceId) {
    if (!anchorPos || !targetPos || !sourceId) return Infinity;

    var key = anchorPos.roomName + ':' + sourceId;
    var rec = Memory._pfCost[key];

    // Old or bad Memory can contain null/undefined/NaN path costs.
    // Never trust cached path cost unless it is a real finite number.
    if (rec && (Game.time - rec.t) < PF_CACHE_TTL && isUsablePathCost(rec.c)) {
      return rec.c;
    }

    var c = pfCost(anchorPos, targetPos);

    if (!isUsablePathCost(c)) {
      c = Infinity;
    }

    Memory._pfCost[key] = { c: c, t: Game.time };
    return c;
  }

  function pfCost(anchorPos, targetPos) {
    var ret = PathFinder.search(
      anchorPos,
      { pos: targetPos, range: 1 },
      {
        maxOps: MAX_PF_OPS,
        plainCost: PLAIN_COST,
        swampCost: SWAMP_COST,
        roomCallback: function(roomName) {
          var room = Game.rooms[roomName]; if (!room) return;
          var m = new PathFinder.CostMatrix();
          room.find(FIND_STRUCTURES).forEach(function(s){
            if (s.structureType===STRUCTURE_ROAD) m.set(s.pos.x,s.pos.y,1);
            else if (s.structureType!==STRUCTURE_CONTAINER && (s.structureType!==STRUCTURE_RAMPART || !s.my)) m.set(s.pos.x,s.pos.y,0xff);
          });
          room.find(FIND_CONSTRUCTION_SITES).forEach(function(cs){ if (cs.structureType!==STRUCTURE_ROAD) m.set(cs.pos.x,cs.pos.y,0xff); });
          return m;
        }
      }
    );
    return ret.incomplete ? Infinity : ret.cost;
  }
  // ============================
  // Room discovery & anchor
  // ============================
  function getHomeName(creep){
    if (creep.memory.home) return creep.memory.home;
    var spawns = Object.keys(Game.spawns).map(function(k){return Game.spawns[k];});
    if (spawns.length){
      var best = spawns[0], bestD = Game.map.getRoomLinearDistance(creep.pos.roomName, best.pos.roomName);
      for (var i=1;i<spawns.length;i++){
        var s=spawns[i], d=Game.map.getRoomLinearDistance(creep.pos.roomName, s.pos.roomName);
        if (d<bestD){ best=s; bestD=d; }
      }
      creep.memory.home = best.pos.roomName; return creep.memory.home;
    }
    creep.memory.home = creep.pos.roomName; return creep.memory.home;
  }
  function getAnchorPos(homeName){
    var r = Game.rooms[homeName];
    if (r){
      if (r.storage) return r.storage.pos;
      var spawns = r.find(FIND_MY_SPAWNS); if (spawns.length) return spawns[0].pos;
      if (r.controller && r.controller.my) return r.controller.pos;
    }
    return new RoomPosition(25,25,homeName);
  }
  function bfsNeighborRooms(startName, radius){
    radius = radius==null?1:radius;
    var seen={}; seen[startName]=true;
    var frontier=[startName];
    for (var depth=0; depth<radius; depth++){
      var next=[];
      for (var f=0; f<frontier.length; f++){
        var rn=frontier[f], exits=Game.map.describeExits(rn)||{};
        for (var dir in exits){ var n=exits[dir]; if(!seen[n]){ seen[n]=true; next.push(n);} }
      }
      frontier=next;
    }
    var out=[]; for (var k in seen) if (k!==startName) out.push(k);
    return out;
  }

  // ============================
  // Flagging helper (sources)
  // ============================
  function markValidRemoteSourcesForHome(homeName){
    var anchor=getAnchorPos(homeName);
    var memAssign=ensureAssignmentsMem();
    var rooms=bfsNeighborRooms(homeName, REMOTE_RADIUS);

    for (var i=0;i<rooms.length;i++){
      var rn=rooms[i], room=Game.rooms[rn]; if(!room) continue;
      var rm = getRoomMemoryBucket(rn);
      var localOwnedReason = getVeinseekerLocalOwnedRoomBlockReason(homeName, rn);
      if (localOwnedReason) continue;
      if (rm.hostile) continue;
      if (isRoomLockedByInvaderCore(rn)) continue;

      if (rm._lastValidFlagScan && (Game.time - rm._lastValidFlagScan) < 300) continue;
      rm._lastValidFlagScan = Game.time;

      var sources = room.find(FIND_SOURCES);
      for (var j=0;j<sources.length;j++){
        var s=sources[j];
        if (isVeinseekerSourceBlocked(rn, s.id)) continue;
        var e=ensureMiningAssignment(memAssign[s.id], rn);
        // Teaching note: remember which home owns this remote assignment so
        // replacements can be spawned even after a wipe.
        if (!e.homeRoom) e.homeRoom = homeName;
        e.remoteRoom = rn;
        if (maCount(memAssign, s.id) >= getSourceMaxSlots(s.id)) continue;
        var cost = pfCostCached(anchor, s.pos, s.id); if (cost===Infinity) continue;
        ensureSourceFlag(s);
        var srec = getSourceMemory(rn, s.id); srec.x = s.pos.x; srec.y = s.pos.y;
        memAssign[s.id] = e;
      }
    }
  }

  
function getMyUsername() {
  return BeeToolbox.myUsername();
}


function getVeinseekerLocalOwnedRoomBlockReason(homeRoom, roomName) {
  if (!SourceEnergyManager || typeof SourceEnergyManager.isLocalOwnedRoomForVeinseeker !== 'function') return null;
  var check = SourceEnergyManager.isLocalOwnedRoomForVeinseeker(homeRoom, roomName);
  return check && check.blocked ? (check.reason || 'local-owned-room') : null;
}

function isVeinseekerLocalOwnedRoom(homeRoom, roomName) {
  return !!getVeinseekerLocalOwnedRoomBlockReason(homeRoom, roomName);
}

function markVeinseekerRoomUnsafe(roomName, reason, ttl) {
  // Veinseeker-specific room block. SourceEnergy/BeeSpawnManager read these fields
  // through BeeToolbox safety helpers before planning or queueing new Veinseeker work.
  if (!roomName) return;
  Memory.rooms = Memory.rooms || {};
  Memory.rooms[roomName] = Memory.rooms[roomName] || {};
  var blockTtl = (typeof ttl === 'number' && ttl > 0) ? ttl : (UNSAFE_ROOM_TTL || 1500);
  Memory.rooms[roomName].sourceWorkerBlockedUntil = Game.time + blockTtl;
  Memory.rooms[roomName].sourceWorkerBlockedReason = reason || 'unsafe';
  Memory.rooms[roomName].sourceWorkerBlockedAt = Game.time;
}

function isVeinseekerRoomBlockedByMemory(roomName) {
  if (!roomName) return false;
  var mem = (Memory.rooms && Memory.rooms[roomName]) || {};
  if (mem.hostile) return true;
  if (mem.sourceWorkerBlockedUntil && mem.sourceWorkerBlockedUntil > Game.time) return true;
  if (BeeToolbox.isRoomInvaderLocked(roomName, { ttl: INVADER_LOCK_MEMO_TTL })) return true;
  var myName = getMyUsername();
  var intel = mem.intel || {};
  if (intel.owner && (!myName || intel.owner !== myName)) return true;
  if (intel.reservation && (!myName || intel.reservation !== myName)) return true;
  return false;
}

function isVisibleRoomUnsafeForVeinseeker(room) {
  // Veinseeker keeps this visible unsafe check local because it stamps a Veinseeker-specific
  // blocked reason into room memory. BeeToolbox handles generic safety checks,
  // but this function preserves Veinseeker diagnostics.
  if (!room) return false;
  var myName = getMyUsername();
  var controller = room.controller;
  var owner = controller && controller.owner && controller.owner.username;
  if (owner && (!myName || owner !== myName)) {
    markVeinseekerRoomUnsafe(room.name, 'ownedBy:' + owner);
    return true;
  }
  var reservation = controller && controller.reservation && controller.reservation.username;
  if (reservation && (!myName || reservation !== myName)) {
    markVeinseekerRoomUnsafe(room.name, 'reservedBy:' + reservation);
    return true;
  }
  var hostiles = room.find(FIND_HOSTILE_CREEPS) || [];
  if (hostiles.length > 0) {
    var dangerous = [];
    var scoutOnly = [];
    for (var i = 0; i < hostiles.length; i++) {
      if (isDangerousHostileForVeinseeker(hostiles[i])) dangerous.push(hostiles[i]);
      else scoutOnly.push(hostiles[i]);
    }
    if (dangerous.length > 0) {
      markVeinseekerRoomUnsafe(room.name, 'dangerousHostiles');
      return true;
    }
    if (scoutOnly.length > 0) {
      Memory.rooms = Memory.rooms || {};
      Memory.rooms[room.name] = Memory.rooms[room.name] || {};
      var roomMem = Memory.rooms[room.name];
      roomMem.lastVeinseekerScoutSeen = Game.time;
      roomMem.lastVeinseekerScoutCount = scoutOnly.length;
      roomMem.lastVeinseekerScoutOwner = scoutOnly[0] && scoutOnly[0].owner ? scoutOnly[0].owner.username : null;
      var scoutLogInterval = CFG.VEINSEEKER_SCOUT_LOG_INTERVAL || 100;
      if (!roomMem.lastVeinseekerScoutLogAt || (Game.time - roomMem.lastVeinseekerScoutLogAt) >= scoutLogInterval) {
        roomMem.lastVeinseekerScoutLogAt = Game.time;
        console.log('👀 Veinseeker scout-only hostile in ' + room.name + ' x' + scoutOnly.length + ' owner=' + (roomMem.lastVeinseekerScoutOwner || 'unknown'));
      }
    }
  }
  if (isRoomLockedByInvaderCore(room.name)) {
    markVeinseekerRoomUnsafe(room.name, 'invaderLock');
    return true;
  }
  return false;
}

function isDangerousHostileForVeinseeker(hostile) {
  if (!hostile || typeof hostile.getActiveBodyparts !== 'function') return true;
  if (hostile.getActiveBodyparts(ATTACK) > 0) return true;
  if (hostile.getActiveBodyparts(RANGED_ATTACK) > 0) return true;
  if (hostile.getActiveBodyparts(HEAL) > 0) return true;
  if (hostile.getActiveBodyparts(CLAIM) > 0) return true;
  if (hostile.getActiveBodyparts(WORK) > 0) return true;
  return false;
}

function refreshVisibleVeinseekerSafety(room) {
  return BeeToolbox.refreshVisibleRemoteSafety(room);
}

function isVeinseekerRoomUnsafe(roomName) {
  // Combined safety check used before assignment, travel, harvesting, and queue
  // pruning. Visible rooms can clear generic stale danger via BeeToolbox, but
  // dangerous live conditions are stamped back into Memory for later ticks.
  // Do not collapse this into the generic remote helper without behavior tests:
  // Veinseeker also owns source-level blocks and treats scout-only hostiles specially.
  if (!roomName) return false;
  var room = Game.rooms[roomName];
  if (room) refreshVisibleVeinseekerSafety(room);
  if (isVeinseekerRoomBlockedByMemory(roomName)) return true;
  if (room && isVisibleRoomUnsafeForVeinseeker(room)) return true;
  return false;
}

function logVeinseekerNoSafeSource(creep, details) {
  if (!creep || !details) return;
  var interval = CFG.NO_SAFE_ASSIGN_LOG_INTERVAL || 25;
  if (creep.memory) creep.memory._lastNoSafeAssignDetails = String(details).slice(0, 250);
  if (creep.memory && creep.memory._lastNoSafeAssignLog && (Game.time - creep.memory._lastNoSafeAssignLog) < interval) return;
  if (creep.memory) creep.memory._lastNoSafeAssignLog = Game.time;
  console.log('🛑 Veinseeker ' + creep.name + ' no safe assignment: ' + details);
}

function getRoomEntryAnchor(homeName, remoteName) {
  var anchor = getAnchorPos(homeName);
  var route = null;
  try { route = Game.map.findRoute(homeName, remoteName); } catch (e) { route = ERR_NO_PATH; }
  if (route === ERR_NO_PATH || !route || !route.length || !route[0] || !route[0].exit) return anchor;
  var exitDir = route[0].exit;
  var exits = anchor.findClosestByPath(exitDir);
  return exits || anchor;
}

function getRouteDistanceBetweenRooms(homeName, remoteName) {
  return BeeToolbox.getRouteDistanceBetweenRooms(homeName, remoteName);
}

function roomCostMatrixForVeinseeker(roomName) {
  var room = Game.rooms[roomName]; if (!room) return;
  var m = new PathFinder.CostMatrix();
  room.find(FIND_STRUCTURES).forEach(function (s) {
    if (s.structureType === STRUCTURE_ROAD) m.set(s.pos.x, s.pos.y, 1);
    else if (s.structureType !== STRUCTURE_CONTAINER && (s.structureType !== STRUCTURE_RAMPART || !s.my)) m.set(s.pos.x, s.pos.y, 0xff);
  });
  room.find(FIND_CONSTRUCTION_SITES).forEach(function (cs) {
    if (cs.structureType !== STRUCTURE_ROAD && cs.structureType !== STRUCTURE_CONTAINER) m.set(cs.pos.x, cs.pos.y, 0xff);
  });
  return m;
}

function recordVeinseekerAccessibility(remoteRoom, sourceId, accessible, reason) {
  // Source-level diagnostic written when a visible source is checked for
  // harvest tiles/pathing. Scout and SourceEnergy reports can explain rejected
  // sources without needing to redo the full accessibility search.
  if (!remoteRoom || !sourceId) return;
  var rm = getRoomMemoryBucket(remoteRoom);
  rm.lastVeinseekerAccessibility = {
    sourceId: sourceId,
    accessible: !!accessible,
    reason: reason || (accessible ? 'ok' : 'unknown'),
    checkedAt: Game.time
  };
  if (!rm.lastVeinseekerAccessibilityBySource) rm.lastVeinseekerAccessibilityBySource = {};
  rm.lastVeinseekerAccessibilityBySource[sourceId] = {
    sourceId: sourceId,
    accessible: !!accessible,
    reason: reason || (accessible ? 'ok' : 'unknown'),
    checkedAt: Game.time
  };
}

function evaluateVisibleSourceAccessibility(homeName, remoteRoomName, sourceObj) {
  if (!sourceObj || !sourceObj.pos || !remoteRoomName) return { accessible: false, reason: 'source-missing' };
  var room = Game.rooms[remoteRoomName]; if (!room) return { accessible: true, reason: 'room-not-visible' };
  if (!VEINSEEKER_REJECT_INACCESSIBLE_SOURCES) return { accessible: true, reason: 'check-disabled' };
  var terrain = room.getTerrain();
  var openTiles = 0;
  var hasHarvestTile = false;
  for (var dx = -1; dx <= 1; dx++) {
    for (var dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      var x = sourceObj.pos.x + dx;
      var y = sourceObj.pos.y + dy;
      if (x < 1 || x > 48 || y < 1 || y > 48) continue;
      if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
      openTiles++;
      var look = room.lookForAt(LOOK_STRUCTURES, x, y) || [];
      var sites = room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y) || [];
      var blocked = false;
      for (var i = 0; i < look.length; i++) {
        var st = look[i];
        if (!st) continue;
        if (st.structureType === STRUCTURE_ROAD || st.structureType === STRUCTURE_CONTAINER) continue;
        if (st.structureType === STRUCTURE_RAMPART && st.my) continue;
        blocked = true; break;
      }
      if (!blocked) {
        for (var s = 0; s < sites.length; s++) {
          var site = sites[s];
          if (!site) continue;
          if (site.structureType === STRUCTURE_ROAD || site.structureType === STRUCTURE_CONTAINER) continue;
          blocked = true; break;
        }
      }
      if (!blocked) hasHarvestTile = true;
    }
  }
  if (!openTiles) return { accessible: false, reason: 'no-open-harvest-tiles' };
  if (!hasHarvestTile) return { accessible: false, reason: 'harvest-tiles-blocked-by-structures' };
  var start = getRoomEntryAnchor(homeName, remoteRoomName);
  var ret = PathFinder.search(start, { pos: sourceObj.pos, range: 1 }, {
    maxOps: MAX_PF_OPS,
    plainCost: PLAIN_COST,
    swampCost: SWAMP_COST,
    roomCallback: roomCostMatrixForVeinseeker
  });
  if (ret.incomplete || !ret.path || !ret.path.length) return { accessible: false, reason: 'path-to-source-incomplete' };
  return { accessible: true, reason: 'ok' };
}

// ============================
  // Invader lock detection
  // ============================
  function isRoomLockedByInvaderCore(roomName){
    return BeeToolbox.isRoomInvaderLocked(roomName, { ttl: INVADER_LOCK_MEMO_TTL });
  }

  // ============================
  // Picking & exclusivity
  // ============================
  function pickRemoteSource(creep){
    var memAssign = ensureAssignmentsMem();
    var homeName = getHomeName(creep);

    if ((Game.time + creep.name.charCodeAt(0)) % 50 === 0) markValidRemoteSourcesForHome(homeName);
    var anchor = getAnchorPos(homeName);

    var scoutPlan = (SourceEnergyManager && typeof SourceEnergyManager.getApprovedRemotesFromScout === 'function') ? SourceEnergyManager.getApprovedRemotesFromScout(homeName) : null;
    var scoutPlanUsed = !!(scoutPlan && scoutPlan.approvedRooms && scoutPlan.approvedRooms.length);
    var approvedSourceFilterUsed = false;
    var approvedSources = Object.create(null);
    if (scoutPlanUsed && scoutPlan.approvedSources && scoutPlan.approvedSources.length) {
      approvedSourceFilterUsed = true;
      for (var asi = 0; asi < scoutPlan.approvedSources.length; asi++) {
        var ap = scoutPlan.approvedSources[asi];
        if (!ap || !ap.sourceId || !ap.targetRoom) continue;
        approvedSources[ap.targetRoom + ':' + ap.sourceId] = true;
      }
    }
    var neighborRooms = scoutPlanUsed ? scoutPlan.approvedRooms.slice(0) : bfsNeighborRooms(homeName, REMOTE_RADIUS);
    var roomRanks = [];
    for (i = 0; i < neighborRooms.length; i++) { rn = neighborRooms[i]; if (shouldAvoidRoom(creep, rn)) continue;
       roomRanks.push({ roomName: rn, routeDistance: getRouteDistanceBetweenRooms(homeName, rn), linearDistance: Game.map.getRoomLinearDistance(homeName, rn) }); 
      }
    roomRanks.sort(function (a, b) { if (a.routeDistance !== b.routeDistance) return a.routeDistance - b.routeDistance; if (a.linearDistance !== b.linearDistance) return a.linearDistance - b.linearDistance; return a.roomName < b.roomName ? -1 : 1; });
    neighborRooms = []; for (i = 0; i < roomRanks.length; i++) neighborRooms.push(roomRanks[i].roomName);
    var candidates=[], avoided=[], i, rn;
    var candidateBySid = {};
    var inaccessibleSources = 0;
    var rejectedCloserRooms = [];
    var topCandidateScores = [];

    // 1) Visible candidates
    for (i=0;i<neighborRooms.length;i++){
      rn=neighborRooms[i];
      var localOwnedReasonVisible = getVeinseekerLocalOwnedRoomBlockReason(homeName, rn);
      if (localOwnedReasonVisible) continue;
      if (isVeinseekerRoomUnsafe(rn)) continue;
      var room=Game.rooms[rn]; if (!room) continue;

      var sources = room.find(FIND_SOURCES);
      var roomInaccessible = 0;
      for (var j=0;j<sources.length;j++){
        var s=sources[j];
        if (approvedSourceFilterUsed && !approvedSources[rn + ':' + s.id]) continue;
        if (isVeinseekerSourceBlocked(rn, s.id)) continue;
        var access = evaluateVisibleSourceAccessibility(homeName, rn, s);
        recordVeinseekerAccessibility(rn, s.id, access.accessible, access.reason);
        if (!access.accessible) {
          inaccessibleSources++;
          roomInaccessible++;
          markVeinseekerSourceBlocked(rn, s.id, 'source-inaccessible-blocked-by-structures', VEINSEEKER_INACCESSIBLE_BLOCK_TTL);
          continue;
        }
        var cost = pfCostCached(anchor, s.pos, s.id);
          if (!isUsablePathCost(cost)) continue;
        var lin = Game.map.getRoomLinearDistance(homeName, rn);
        var routeDistance = getRouteDistanceBetweenRooms(homeName, rn);

        if (shouldAvoid(creep, s.id)){ avoided.push({id:s.id,roomName:rn,cost:cost,lin:lin,left:avoidRemaining(creep,s.id)}); continue; }
        var assignedNow = maCount(memAssign, s.id);
        var slotCapNow = getSourceMaxSlots(s.id);
        if (assignedNow >= slotCapNow) continue;
        var firstOpenBonus = assignedNow === 0 ? VEINSEEKER_FIRST_OPEN_BONUS : (PREFER_EMPTY_SOURCES_BEFORE_STACKING ? 0 : 50);
        var stackPenalty = assignedNow > 0 ? VEINSEEKER_SECONDARY_SOURCE_SCORE_PENALTY : 0;
        var underHarvestBonus = 0;
        if (s.energy >= VEINSEEKER_UNDERHARVEST_ENERGY_THRESHOLD) underHarvestBonus -= 120;
        if (s.energyCapacity >= 3000) {
          var owners = maOwners(memAssign, s.id);
          var primary = owners.length ? Game.creeps[owners[0]] : null;
          var workParts = primary ? primary.getActiveBodyparts(WORK) : 0;
          if (workParts < VEINSEEKER_RESERVED_SOURCE_SECOND_MIN_WORK) underHarvestBonus -= 100;
        }

        var sticky = (creep.memory.sourceId===s.id) ? 1 : 0;
        candidates.push({
          id:s.id, roomName:rn, routeDistance: routeDistance, lin:lin, pathCost: cost,
          firstOpenBonus: firstOpenBonus, stackPenalty: stackPenalty, underHarvestBonus: underHarvestBonus,
          sticky:sticky, assigned: assignedNow, candidateKind: 'visible'
        });
        candidateBySid[s.id] = true;
      }
      if (sources.length > 0 && roomInaccessible >= sources.length) {
        markVeinseekerRoomBlocked(rn, 'all-sources-inaccessible', VEINSEEKER_INACCESSIBLE_BLOCK_TTL);
      }
    }

    // 2) Memory-known candidates (always merged with visible list)
    for (i=0;i<neighborRooms.length;i++){
      rn=neighborRooms[i];
      var localOwnedReasonMem = getVeinseekerLocalOwnedRoomBlockReason(homeName, rn);
      if (localOwnedReasonMem) continue;
      if (isVeinseekerRoomUnsafe(rn)) continue;
      var rm = getRoomMemoryBucket(rn); if (!rm || !rm.sources) continue;
      var roomVisible = Game.rooms[rn];
      var intelTick = null;
      if (rm.intel) {
        if (typeof rm.intel.lastScanAt === 'number') intelTick = rm.intel.lastScanAt;
        if (typeof rm.intel.lastVisited === 'number') intelTick = Math.max(intelTick || 0, rm.intel.lastVisited);
        if (typeof rm.intel.t === 'number') intelTick = Math.max(intelTick || 0, rm.intel.t);
      }
      if (rm.scout && typeof rm.scout.lastVisited === 'number') intelTick = Math.max(intelTick || 0, rm.scout.lastVisited);
      if (!roomVisible && (intelTick == null || (Game.time - intelTick) > VEINSEEKER_REMOTE_INTEL_TTL)) continue;
      for (var sid in rm.sources){
        if (candidateBySid[sid]) continue;
        if (approvedSourceFilterUsed && !approvedSources[rn + ':' + sid]) continue;
        if (isVeinseekerSourceBlocked(rn, sid)) continue;
        if (shouldAvoid(creep, sid)){ avoided.push({id:sid,roomName:rn,cost:1e9,lin:99,left:avoidRemaining(creep,sid)}); continue; }
        var cap2 = getSourceMaxSlots(sid);
        var assigned2 = maCount(memAssign, sid);
        if (assigned2 >= cap2) continue;

        var lin2 = Game.map.getRoomLinearDistance(homeName, rn);

        var routeDistance2 = getRouteDistanceBetweenRooms(homeName, rn);
        if (routeDistance2 === Infinity ||
            routeDistance2 == null ||
            isNaN(routeDistance2)) {
          continue;
        }

        var synth = (lin2*350)+800;
        var sticky2 = (creep.memory.sourceId===sid) ? 1 : 0;
        var stackPenalty2 = assigned2 > 0 ? VEINSEEKER_SECONDARY_SOURCE_SCORE_PENALTY : 0;
        var firstOpenBonus2 = assigned2 === 0 ? VEINSEEKER_FIRST_OPEN_BONUS : (PREFER_EMPTY_SOURCES_BEFORE_STACKING ? 0 : 50);
        candidates.push({
          id:sid, roomName:rn, routeDistance: routeDistance2, lin:lin2, pathCost: synth,
          firstOpenBonus: firstOpenBonus2, stackPenalty: stackPenalty2, underHarvestBonus: 0,
          sticky:sticky2, assigned: assigned2, candidateKind: 'memory'
        });
      }
    }

    if (!candidates.length){
      if (!avoided.length) {
        if (Memory.rooms && Memory.rooms[homeName]) {
          Memory.rooms[homeName].lastVeinseekerSelection = {
            tick: Game.time, creep: creep.name, selectedRoom: null, selectedSourceId: null, selectedDistance: null,
            candidateRoomsSorted: neighborRooms.slice(0), scoutPlanUsed: scoutPlanUsed, approvedSourceFilterUsed: approvedSourceFilterUsed, approvedSourcesCount: scoutPlan && scoutPlan.approvedSources ? scoutPlan.approvedSources.length : 0, rejectedCloserRooms: rejectedCloserRooms, topCandidates: [], fallback: (!scoutPlan || !scoutPlan.approvedRooms || !scoutPlan.approvedRooms.length) ? 'bfs-diagnostics-fallback' : null
          };
        }
        logVeinseekerNoSafeSource(creep, 'home=' + homeName + ' inaccessibleSources=' + inaccessibleSources + ' candidates=0');
        return null;
      }
      avoided.sort(function(a,b){ return (a.left-b.left)||(a.cost-b.cost)||(a.lin-b.lin)||(a.id<b.id?-1:1); });
      var soonest = avoided[0];
      if (soonest.left <= 5) candidates.push(soonest); else return null;
    }

    candidates.sort(function(a,b){
      if (b.sticky !== a.sticky) return (b.sticky - a.sticky);
      if (a.routeDistance !== b.routeDistance) return a.routeDistance - b.routeDistance;
      if (a.lin !== b.lin) return a.lin - b.lin;
      var availA = a.assigned;
      var availB = b.assigned;
      if (availA !== availB) return availA - availB;
      var scoreA = a.pathCost + a.stackPenalty + a.firstOpenBonus + a.underHarvestBonus;
      var scoreB = b.pathCost + b.stackPenalty + b.firstOpenBonus + b.underHarvestBonus;
      if (scoreA !== scoreB) return scoreA - scoreB;
      return (a.id<b.id?-1:1);
    });

    for (i = 0; i < candidates.length && i < 5; i++) {
      topCandidateScores.push({
        sourceId: candidates[i].id,
        roomName: candidates[i].roomName,
        sticky: candidates[i].sticky,
        routeDistance: candidates[i].routeDistance,
        linearDistance: candidates[i].lin,
        pathCost: candidates[i].pathCost,
        assigned: candidates[i].assigned,
        firstOpenBonus: candidates[i].firstOpenBonus,
        stackPenalty: candidates[i].stackPenalty,
        underHarvestBonus: candidates[i].underHarvestBonus
        , candidateKind: candidates[i].candidateKind
      });
    }

    // (Fixed loop condition)
    for (var k=0; k<candidates.length; k++){
      var best=candidates[k];
      if (!tryClaimSourceForTick(creep, best.id)) continue;

      for (var c = 0; c < candidates.length; c++) {
        var cand = candidates[c];
        if (cand.id === best.id && cand.roomName === best.roomName) continue;
        if (cand.routeDistance < best.routeDistance) {
          rejectedCloserRooms.push({
            roomName: cand.roomName,
            sourceId: cand.id,
            reason: cand.sticky ? 'sticky-preferred' : 'distance-rank-lower',
            candidateKind: cand.candidateKind
          });
        } else if (cand.routeDistance === best.routeDistance && cand.lin === best.lin && cand.assigned > best.assigned) {
          rejectedCloserRooms.push({
            roomName: cand.roomName,
            sourceId: cand.id,
            reason: 'less-availability',
            candidateKind: cand.candidateKind
          });
        }
      }

      // Reserve immediately
      maInc(memAssign, best.id, best.roomName);
      maSetOwner(memAssign, best.id, creep.name, best.roomName);
      resolveOwnershipForSid(best.id);

      // Visuals + say:
      var srcObj = Game.getObjectById(best.id);
      if (srcObj) {
        debugSay(creep, '🎯SRC');
        debugDrawLine(creep, srcObj, CFG.DRAW.PICK_COLOR, "PICK");
        debugRing(creep.room, srcObj.pos, CFG.DRAW.PICK_COLOR, shortSid(best.id));
      } else {
        var center = new RoomPosition(25,25,best.roomName);
        debugSay(creep, '🎯'+best.roomName);
        debugDrawLine(creep, center, CFG.DRAW.TRAVEL_COLOR, "PICK?");
      }

      if (creep.memory._lastLogSid !== best.id){
        console.log('🧭 '+creep.name+' pick src='+best.id.slice(-6)+' room='+best.roomName+' route='+best.routeDistance+' path='+best.pathCost+(best.sticky?' (sticky)':''));
        creep.memory._lastLogSid = best.id;
      }
      if (Memory.rooms && Memory.rooms[homeName]) {
        Memory.rooms[homeName].lastVeinseekerSelection = {
          tick: Game.time,
          creep: creep.name,
          selectedRoom: best.roomName,
          selectedSourceId: best.id,
          selectedDistance: best.routeDistance,
          candidateRoomsSorted: neighborRooms.slice(0), scoutPlanUsed: scoutPlanUsed, approvedSourceFilterUsed: approvedSourceFilterUsed, approvedSourcesCount: scoutPlan && scoutPlan.approvedSources ? scoutPlan.approvedSources.length : 0,
          rejectedCloserRooms: rejectedCloserRooms,
          topCandidates: topCandidateScores
        };
      }
      return best;
    }

    return null;
  }

  function releaseAssignment(creep){
    // Release both SourceEnergy.Manager's home plan and the legacy
    // Memory.remoteAssignments model, then put this creep on a retarget
    // cooldown so it does not immediately reclaim the same bad source.
    SourceEnergyManager.releaseSource(creep);
    var memAssign = ensureAssignmentsMem();
    var sid = creep.memory.sourceId;

    if (sid){
      maDec(memAssign, sid);
      var owner = maOwner(memAssign, sid);
      if (owner === creep.name) maClearOwner(memAssign, sid);
      markAvoid(creep, sid, AVOID_TTL);
    }

    creep.memory.sourceId   = null;
    creep.memory.targetRoom = null;
    creep.memory.assigned   = false;
    creep.memory._retargetAt = Game.time + RETARGET_COOLDOWN;

    debugSay(creep, '🌓YIELD');
  }

  function validateExclusiveSource(creep){
    // Final ownership guard before harvesting. If another Veinseeker has a stronger
    // claim to this source, this creep yields and clears its assignment rather
    // than competing on the same tile forever.
    if (!creep.memory || !creep.memory.sourceId) return true;

    var sid = creep.memory.sourceId;
    var memAssign = ensureAssignmentsMem();
    var owners = maOwners(memAssign, sid);
    var winners = getLiveVeinseekerContendersForSource(sid);
    var cap = getSourceMaxSlots(sid);
    if (owners.length && owners.indexOf(creep.name) === -1 && winners.length <= cap){
      resolveOwnershipForSid(sid);
      owners = maOwners(memAssign, sid);
    }
    if (owners.length && owners.indexOf(creep.name) === -1){
      creep.memory._forceYield = true;
      releaseAssignment(creep);
      return false;
    }
    if (winners.length <= cap){
      if (!owners.length) maSetOwner(memAssign, sid, creep.name, creep.memory.targetRoom||null);
      return true;
    }
    resolveOwnershipForSid(sid);
    var refreshed = maOwners(memAssign, sid);
    if (refreshed.indexOf(creep.name) === -1){
      console.log('🚦 '+creep.name+' yielding duplicate source '+sid.slice(-6)+' (backing off).');
      releaseAssignment(creep);
      return false;
    }
    return true;
  }


  // ============================
  // Teaching helpers for the run loop
  // ============================
  function ensureVeinseekerIdentity(creep) {
    if (!creep || !creep.memory) return;
    creep.memory.role = 'Veinseeker';
    if (creep.memory.task === 'veinseeker') {
      creep.memory.task = 'veinseeker';
    } else if (!creep.memory.task) {
      creep.memory.task = 'veinseeker';
    }
  }

  function trackMovementBreadcrumb(creep) {
    if (!creep || !creep.memory) return;
    var lastX = typeof creep.memory._lx === 'number' ? creep.memory._lx : 0;
    var lastY = typeof creep.memory._ly === 'number' ? creep.memory._ly : 0;
    var lastR = creep.memory._lr || '';
    var samePos = (lastX===creep.pos.x && lastY===creep.pos.y && lastR===creep.pos.roomName);
    var stuckTicks = typeof creep.memory._stuck === 'number' ? creep.memory._stuck : 0;
    creep.memory._stuck = samePos ? (stuckTicks + 1) : 0;
    creep.memory._lx = creep.pos.x; creep.memory._ly = creep.pos.y; creep.memory._lr = creep.pos.roomName;
  }

  function idleAtAnchor(creep, label) {
    var anchor = getAnchorPos(getHomeName(creep));
    debugSay(creep, label || 'IDLE');
    debugDrawLine(creep, anchor, CFG.DRAW.IDLE_COLOR, label || 'IDLE');
    creep.travelTo(anchor, { range: 2, reusePath: CFG.PATH_REUSE, maxOps: CFG.TRAVEL_MAX_OPS || 4000 });
  }

  function shouldReleaseForEndOfLife(creep) {
    if (creep.ticksToLive!==undefined && creep.ticksToLive<5 && creep.memory.assigned){
      releaseAssignment(creep);
      return true;
    }
    return false;
  }

  function respectCooldown(creep) {
    if (creep.memory._retargetAt && Game.time < creep.memory._retargetAt){
      idleAtAnchor(creep, '…cd');
      return true;
    }
    return false;
  }

  function handleForcedYield(creep) {
    if (!creep.memory._forceYield) return false;
    delete creep.memory._forceYield;
    releaseAssignment(creep);
    return true;
  }

  function releaseIfLocalOwnedVeinseekerAssignment(creep) {
    if (!creep || !creep.memory || !creep.memory.targetRoom) return false;
    var homeName = getHomeName(creep);
    var reason = getVeinseekerLocalOwnedRoomBlockReason(homeName, creep.memory.targetRoom);
    if (!reason) return false;
    var interval = CFG.NO_SAFE_ASSIGN_LOG_INTERVAL || 25;
    if (!creep.memory._lastLocalOwnedAssignLog || (Game.time - creep.memory._lastLocalOwnedAssignLog) >= interval) {
      console.log('🏠 Veinseeker ' + creep.name + ' releasing local-owned assignment room=' + creep.memory.targetRoom + ' reason=' + reason);
      creep.memory._lastLocalOwnedAssignLog = Game.time;
    }
    releaseAssignment(creep);
    idleAtAnchor(creep, 'LOCAL');
    return true;
  }

  function ensureActiveAssignment(creep) {
    // Primary Veinseeker assignment flow. Prefer the scored remote-source picker,
    // mirror the claim into SourceEnergy.Manager, and fall back to legacy room
    // selection only when the scored picker cannot find a safe source.
    if (creep.memory.sourceId && creep.memory.targetRoom) {
      clearRemoteUnassignedTimeout(creep);
      return true;
    }

    var pick = pickRemoteSource(creep);
    if (pick){
      creep.memory.sourceId   = pick.id;
      creep.memory.targetRoom = pick.roomName;
      creep.memory.assigned   = true;
      creep.memory._assignTick = Game.time;
      clearRemoteUnassignedTimeout(creep);
      SourceEnergyManager.claimSource(creep, pick.id, pick.roomName);
      return true;
    }

    roleVeinseeker.initializeAndAssign(creep);
    if (!creep.memory.targetRoom || !creep.memory.sourceId){
      if (maybeSuicideIfRemoteUnassignedTooLong(creep, creep.memory._lastNoSafeAssignDetails || 'no-safe-remote-assignment')) return false;
      idleAtAnchor(creep, 'IDLE');
      return false;
    }
    creep.memory._assignTick = creep.memory._assignTick || Game.time;
    clearRemoteUnassignedTimeout(creep);
    return true;
  }

function getAssignedRemoteSourceTravelPos(creep) {
  if (!creep || !creep.memory || !creep.memory.targetRoom || !creep.memory.sourceId) {
    return null;
  }

  var roomName = creep.memory.targetRoom;
  var sid = creep.memory.sourceId;

  // If the room is visible, use the real source position.
  var sourceObj = Game.getObjectById(sid);
  if (sourceObj && sourceObj.pos) return sourceObj.pos;

  // Otherwise use source memory from remote room intel.
  var roomMem = Memory.rooms && Memory.rooms[roomName];
  var sourceMem = roomMem && roomMem.sources && roomMem.sources[sid];

  if (sourceMem) {
    if (typeof sourceMem.x === 'number' && typeof sourceMem.y === 'number') {
      return new RoomPosition(sourceMem.x, sourceMem.y, roomName);
    }

    if (sourceMem.pos &&
        typeof sourceMem.pos.x === 'number' &&
        typeof sourceMem.pos.y === 'number') {
      return new RoomPosition(sourceMem.pos.x, sourceMem.pos.y, roomName);
    }
  }

  return null;
}

  function travelToAssignedRoom(creep) {
    if (!creep.memory.targetRoom || creep.pos.roomName === creep.memory.targetRoom) return false;

    var sourceTravelPos = getAssignedRemoteSourceTravelPos(creep);
    var dest = sourceTravelPos || new RoomPosition(25, 25, creep.memory.targetRoom);
    var range = sourceTravelPos ? 1 : 20;

    debugSay(creep, '➡️' + creep.memory.targetRoom);
    debugDrawLine(creep, dest, CFG.DRAW.TRAVEL_COLOR, sourceTravelPos ? 'SRCROOM' : 'ROOM');

    veinseekerTravelToAssigned(
      creep,
      dest,
      { range: range, reusePath: 20 },
      creep.memory.sourceId,
      'path-to-room'
    );

    return true;
  }

  function prepareVeinseeker(creep) {
    ensureVeinseekerIdentity(creep);
    auditOncePerTick();
    if (!creep.memory.home) getHomeName(creep);
    trackMovementBreadcrumb(creep);
  }

  // Memory keys:
  // - sourceId: remote source assigned this tick
  // - targetRoom: room name for the assignment
  function determineVeinseekerState(creep) {
    var state = 'HARVEST';
    if (!creep.memory.targetRoom || !creep.memory.sourceId) state = 'UNASSIGNED';
    else if (creep.pos.roomName !== creep.memory.targetRoom) state = 'TRAVEL';
    creep.memory.state = state;
    return state;
  }

  function clearRemoteUnassignedTimeout(creep) {
    if (!creep || !creep.memory) return;
    delete creep.memory._remoteUnassignedSince;
    delete creep.memory._remoteUnassignedReason;
  }

  function getRemoteVeinseekerAge(creep) {
    if (!creep || !creep.memory) return null;
    if (typeof creep.memory.bornAt === 'number') return Math.max(0, Game.time - creep.memory.bornAt);
    if (typeof creep.ticksToLive === 'number' && typeof CREEP_LIFE_TIME === 'number') {
      return Math.max(0, CREEP_LIFE_TIME - creep.ticksToLive);
    }
    return null;
  }

  function maybeSuicideIfRemoteUnassignedTooLong(creep, reason) {
    if (!creep || !creep.memory || creep.spawning) return false;
    if (creep.memory.targetRoom && creep.memory.sourceId) {
      clearRemoteUnassignedTimeout(creep);
      return false;
    }

    if (typeof creep.memory._remoteUnassignedSince !== 'number') {
      creep.memory._remoteUnassignedSince = Game.time;
    }
    creep.memory._remoteUnassignedReason = reason || creep.memory._lastNoSafeAssignDetails || 'no-safe-remote-assignment';

    var age = getRemoteVeinseekerAge(creep);
    var unassignedTicks = Math.max(0, Game.time - creep.memory._remoteUnassignedSince);
    var expired = age !== null
      ? age >= VEINSEEKER_UNASSIGNED_SUICIDE_TICKS
      : unassignedTicks >= VEINSEEKER_UNASSIGNED_SUICIDE_TICKS;

    if (!expired) return false;

    var detail = creep.memory._remoteUnassignedReason;
    var ageText = age !== null ? age : ('unassigned ' + unassignedTicks);
    console.log('Veinseeker ' + creep.name + ' suiciding after ' + ageText + ' ticks without a remote assignment. reason=' + detail);
    SourceEnergyManager.releaseSource(creep);
    creep.suicide();
    return true;
  }


  function upsertRemoteContainerBuildStatus(creep, source, container, site, plannedPos) {
    return SourceWorkerManager.upsertRemoteContainerBuildStatus(creep, source, container, site, plannedPos, {
      getHomeName: getHomeName
    });
  }
function upsertRemoteContainerStatus(creep, source, container) {
    return SourceWorkerManager.upsertRemoteContainerStatus(creep, source, container, {
      getHomeName: getHomeName
    });
  }

  function upsertRemoteHaulRequest(creep, source, container) {
    return SourceWorkerManager.upsertRemoteHaulRequest(creep, source, container, {
      getHomeName: getHomeName,
      isRoomUnsafe: isVeinseekerRoomUnsafe
    });
  }

  function publishRemoteLooseEnergyRequests(creep, source, container) {
    return SourceWorkerManager.publishRemoteLooseEnergyRequests(creep, source, container, {
      getHomeName: getHomeName,
      isRoomUnsafe: isVeinseekerRoomUnsafe
    });
  }

  function getContainerFreeEnergy(container) {
    if (!container || !container.store) return 0;
    return container.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
  }

  function writeRemoteOverflowDiag(creep, source, container, action, reason) {
    if (!creep || !source || !source.id) return;
    var roomName = source.pos ? source.pos.roomName : creep.memory.targetRoom;
    var srec = getSourceMemory(roomName, source.id);
    var diag = {
      tick: Game.time,
      creepName: creep.name,
      homeRoom: getHomeName(creep),
      remoteRoom: roomName || null,
      sourceId: source.id,
      containerId: container && container.id ? container.id : null,
      action: action || 'drop',
      reason: reason || 'remote-source-container-overflow',
      carried: creep.store ? (creep.store.getUsedCapacity(RESOURCE_ENERGY) || 0) : 0,
      containerEnergy: container && container.store ? (container.store[RESOURCE_ENERGY] || 0) : null,
      containerCapacity: container && container.store ? (container.store.getCapacity(RESOURCE_ENERGY) || 0) : null
    };
    srec.overflow = diag;
    var homeName = getHomeName(creep);
    if (homeName) {
      if (!Memory.rooms) Memory.rooms = {};
      if (!Memory.rooms[homeName]) Memory.rooms[homeName] = {};
      Memory.rooms[homeName].lastRemoteVeinseekerOverflow = diag;
    }
  }

  function dropRemoteSourceOverflow(creep, source, container, reason) {
    if (!creep || !source || !creep.store || creep.store.getUsedCapacity(RESOURCE_ENERGY) <= 0) return false;
    if (container && getContainerFreeEnergy(container) > 0) return false;
    var nearSource = source.pos && creep.pos.getRangeTo(source) <= 1;
    var nearContainer = container && creep.pos.getRangeTo(container) <= 1;
    if (!nearSource && !nearContainer) return false;

    // Full remote containers should create haul pressure, not leave the miner
    // full and idle. Drop only beside the source/container so pickup is local.
    if (container) {
      upsertRemoteContainerStatus(creep, source, container);
      upsertRemoteHaulRequest(creep, source, container);
    }
    publishRemoteLooseEnergyRequests(creep, source, container);
    writeRemoteOverflowDiag(creep, source, container, 'drop', reason);
    debugSay(creep, 'overflow');
    debugRing(creep.room, creep.pos, CFG.DRAW.OFFLOAD, 'DROP');
    creep.drop(RESOURCE_ENERGY);
    return true;
  }

  function findAssignedSourceContainer(creep, source) {
    return SourceWorkerManager.findAssignedSourceContainer(creep, source, {
      getSourceMemory: getSourceMemory
    });
  }

  function getRemoteSeatPosFromMemory(creep) {
    if (!creep || !creep.memory) return null;
    if (typeof creep.memory.seatX !== 'number' ||
        typeof creep.memory.seatY !== 'number' ||
        !creep.memory.seatRoom) {
      return null;
    }
    return new RoomPosition(creep.memory.seatX, creep.memory.seatY, creep.memory.seatRoom);
  }

  function rememberRemoteSeat(creep, pos) {
    if (!creep || !creep.memory || !pos) return;
    creep.memory.seatX = pos.x;
    creep.memory.seatY = pos.y;
    creep.memory.seatRoom = pos.roomName;
  }

  function remoteSeatBelongsToSource(pos, source) {
    if (!pos || !source) return false;
    var seats = SourceWorkerManager.buildHarvestSeatList(source);
    var key = SourceWorkerManager.getHarvestSeatKey(pos);
    for (var i = 0; i < seats.length; i++) {
      if (SourceWorkerManager.getHarvestSeatKey(seats[i]) === key) return true;
    }
    return false;
  }

  function collectRemoteReservedSeats(sourceId, roomName, excludeName) {
    var reserved = {};
    if (!sourceId || !roomName) return reserved;
    for (var name in Game.creeps) {
      if (!Game.creeps.hasOwnProperty(name)) continue;
      if (excludeName && name === excludeName) continue;
      var other = Game.creeps[name];
      if (!other || !other.memory) continue;
      var roleName = other.memory.role ? String(other.memory.role).toLowerCase() : '';
      var taskName = other.memory.task ? String(other.memory.task).toLowerCase() : '';
      if (taskName !== 'veinseeker' && roleName !== 'veinseeker') continue;
      if (other.memory.sourceId !== sourceId) continue;
      if (other.memory.targetRoom !== roomName) continue;
      var seat = getRemoteSeatPosFromMemory(other);
      if (!seat) continue;
      reserved[SourceWorkerManager.getHarvestSeatKey(seat)] = other.name;
    }
    return reserved;
  }

  function writeRemoteSeatProblem(creep, source, reason, anchorPos) {
    if (!source || !source.id || !creep || !creep.memory) return;
    var roomName = creep.memory.targetRoom || (source.pos && source.pos.roomName);
    var srec = getSourceMemory(roomName, source.id);
    srec.containerSeatProblem = {
      tick: Game.time,
      reason: reason || 'remote-no-open-compatible-seat',
      creep: creep.name,
      anchor: anchorPos ? { x: anchorPos.x, y: anchorPos.y, roomName: anchorPos.roomName } : null
    };
  }

  function chooseRemoteHarvestSeat(creep, source, anchorPos) {
    var reserved = collectRemoteReservedSeats(source.id, source.pos.roomName, creep.name);
    var current = getRemoteSeatPosFromMemory(creep);
    if (current && remoteSeatBelongsToSource(current, source)) {
      var reservedBy = reserved[SourceWorkerManager.getHarvestSeatKey(current)];
      if ((!reservedBy || reservedBy === creep.name) &&
          !SourceWorkerManager.isTileOccupiedByAnyCreep(current, creep.name)) {
        return current;
      }
    }

    var seat = SourceWorkerManager.chooseOpenHarvestSeat(source, creep.name, reserved);
    if (seat) {
      rememberRemoteSeat(creep, seat);
      return seat;
    }

    writeRemoteSeatProblem(creep, source, 'remote-no-open-compatible-seat', anchorPos);
    return null;
  }

  function shouldRepairAssignedContainer(creep, container) {
    if (!CFG.remoteContainerRepairEnabled) return false;
    if (!creep || !container || !container.hitsMax) return false;
    if (isVeinseekerRoomUnsafe(container.pos.roomName)) return false;
    return (container.hits / container.hitsMax) <= (CFG.remoteContainerRepairStartPct || 0.5);
  }

  function markContainerRepairMaintenanceHold(creep, container, source) {
    return SourceWorkerManager.markContainerRepairMaintenanceHold(creep, container, source);
  }



  function ensureSourceContainerOrSite(source) {
    return SourceWorkerManager.ensureSourceContainerOrSite(source);
  }

  // ============================
  // Main role
  // ============================
  var roleVeinseeker = {
    role: 'Veinseeker',
    run: function(creep){
      // Main role pipeline:
      // prepare identity/audits -> ensure/release assignment -> validate safety
      // and uniqueness -> travel if needed -> harvest/build/repair/offload.
      prepareVeinseeker(creep);

      var state = determineVeinseekerState(creep);

      if (shouldReleaseForEndOfLife(creep)) return;
      if (respectCooldown(creep)) {
        if (state === 'UNASSIGNED') maybeSuicideIfRemoteUnassignedTooLong(creep, creep.memory._lastNoSafeAssignDetails || 'retarget-cooldown-unassigned');
        return;
      }
      if (handleForcedYield(creep)) return;
      if (releaseIfLocalOwnedVeinseekerAssignment(creep)) return;

      if (!ensureActiveAssignment(creep)) return;
      if (releaseIfLocalOwnedVeinseekerAssignment(creep)) return;

      state = determineVeinseekerState(creep);
      if (state === 'UNASSIGNED') {
        roleVeinseeker.initializeAndAssign(creep);
        return;
      }

      if (creep.memory.targetRoom && isRoomLockedByInvaderCore(creep.memory.targetRoom)){
        debugSay(creep, '⛔LOCK');
        var center = new RoomPosition(25,25,creep.memory.targetRoom);
        debugDrawLine(creep, center, CFG.DRAW.TRAVEL_COLOR, "LOCK");
        console.log('⛔ '+creep.name+' skipping locked room '+creep.memory.targetRoom+' (Invader activity).');
        releaseAssignment(creep);
        return;
      }

      if (!validateExclusiveSource(creep)) return;

      if (creep.memory.targetRoom && isVeinseekerRoomUnsafe(creep.memory.targetRoom)) {
        debugSay(creep, '🚫SAFE');
        var roomMem = (Memory.rooms && Memory.rooms[creep.memory.targetRoom]) || {};
        if (!creep.memory._lastUnsafeLog || (Game.time - creep.memory._lastUnsafeLog) >= 25) {
          console.log('🚫 Veinseeker ' + creep.name + ' releasing unsafe room ' + creep.memory.targetRoom + ' reason=' + (roomMem.sourceWorkerBlockedReason || 'unsafe'));
          creep.memory._lastUnsafeLog = Game.time;
        }
        releaseAssignment(creep);
        idleAtAnchor(creep, 'SAFE');
        return;
      }

      if (state === 'TRAVEL') {
        if (travelToAssignedRoom(creep)) return;
        state = determineVeinseekerState(creep);
      }

      if (state === 'UNASSIGNED') {
        roleVeinseeker.initializeAndAssign(creep);
        if (!creep.memory.targetRoom || !creep.memory.sourceId){
          if (maybeSuicideIfRemoteUnassignedTooLong(creep, creep.memory._lastNoSafeAssignDetails || 'no-safe-remote-assignment')) return;
          if (Game.time % 25 === 0) console.log('🚫 Forager '+creep.name+' could not be assigned a room/source.');
          return;
        }
      }

      clearRemoteUnassignedTimeout(creep);
      var targetRoomObj = Game.rooms[creep.memory.targetRoom];
      if (targetRoomObj && BeeToolbox && BeeToolbox.logSourcesInRoom){ try { BeeToolbox.logSourcesInRoom(targetRoomObj); } catch (e) {} }

      if (targetRoomObj) {
        var veinseekerThreat = evaluateRoomThreat(targetRoomObj, 'Veinseeker');
        if (veinseekerThreat && veinseekerThreat.threat && veinseekerThreat.threat.hasThreat && veinseekerThreat.canEscalate) {
          ensureRemoteDefensePlan(targetRoomObj, veinseekerThreat.threat, veinseekerThreat.distance);
        } else if (targetRoomObj && (!veinseekerThreat || !veinseekerThreat.canEscalate || !veinseekerThreat.threat || !veinseekerThreat.threat.hasThreat)) {
          softenRemoteDefensePlan(targetRoomObj.name);
        }
      }

      var tmem = getRoomMemoryBucket(creep.memory.targetRoom);
      if (tmem && tmem.hostile){
        console.log('⚠️ Forager '+creep.name+' avoiding hostile room '+creep.memory.targetRoom);
        debugSay(creep, '⚠️HOST');
        releaseAssignment(creep);
        return;
      }
      if (!tmem || !tmem.sources) return;

      var ctl = targetRoomObj && targetRoomObj.controller;
      if (ctl) { ensureControllerFlag(ctl); debugRing(targetRoomObj, ctl.pos, CFG.DRAW.TRAVEL_COLOR, "CTRL"); }

      state = determineVeinseekerState(creep);
      if (state === 'HARVEST') {
        roleVeinseeker.harvestSource(creep);
        return;
      }
      if (state === 'TRAVEL') {
        travelToAssignedRoom(creep);
        return;
      }
      idleAtAnchor(creep, 'IDLE');
    },

    // ---- Legacy fallback (no vision) — now radius-bounded ----
    getNearbyRoomsWithSources: function(creep){
      var homeName = getHomeName(creep);

      var inRadius = {};
      var ring = bfsNeighborRooms(homeName, REMOTE_RADIUS);
      for (var i=0; i<ring.length; i++) inRadius[ring[i]] = true;

      var all = Object.keys(Memory.rooms||{});
      var filtered = all.filter(function(roomName){
        var rm = Memory.rooms[roomName];
        if (!rm || !rm.sources) return false;
        if (!inRadius[roomName]) return false;
        if (shouldAvoidRoom(creep, roomName)) return false;
        var localOwnedReason = getVeinseekerLocalOwnedRoomBlockReason(homeName, roomName);
        if (localOwnedReason) return false;
        if (rm.hostile) return false;
        if (isVeinseekerRoomUnsafe(roomName)) return false;
        if (isRoomLockedByInvaderCore(roomName)) return false;
        return roomName !== Memory.firstSpawnRoom;
      });

      return filtered.sort(function(a,b){
        return Game.map.getRoomLinearDistance(homeName, a) - Game.map.getRoomLinearDistance(homeName, b);
      });
    },

    findRoomWithLeastForagers: function(creep,rooms, homeName){
      if (!rooms || !rooms.length) return null;

      var inRadius = {};
      var ring = bfsNeighborRooms(homeName, REMOTE_RADIUS);
      for (var i=0; i<ring.length; i++) inRadius[ring[i]] = true;

      var best=null, lowest=Infinity;
      for (var j=0;j<rooms.length;j++){
        var rn=rooms[j];

        // If this creep recently failed room travel to this remote room,
        // skip it for a short time instead of picking it again immediately.
        if (shouldAvoidRoom(creep, rn)) continue;

        if (!inRadius[rn]) continue;
        if (isVeinseekerLocalOwnedRoom(homeName, rn)) continue;
        if (isVeinseekerRoomUnsafe(rn)) continue;
        if (isRoomLockedByInvaderCore(rn)) continue;

        var rm=getRoomMemoryBucket(rn), sources = rm.sources?Object.keys(rm.sources):[]; if (!sources.length) continue;

        var count=0;
        for (var name in Game.creeps){
          var c=Game.creeps[name];
          if (c && c.memory && c.memory.task==='veinseeker' && c.memory.targetRoom===rn) count++;
        }
        var avg = count / Math.max(1,sources.length);
        if (avg < lowest){ lowest=avg; best=rn; }
      }
      return best;
    },

    initializeAndAssign: function(creep){
      // Legacy fallback assignment path. The newer SourceEnergy/BeeSpawnManager
      // flow normally preassigns sourceId/targetRoom; this path still helps old
      // or manually spawned Veinseeker creeps find a safe source from room Memory.
      var targetRooms = roleVeinseeker.getNearbyRoomsWithSources(creep);
      if (!creep.memory.targetRoom || !creep.memory.sourceId){
        var least = roleVeinseeker.findRoomWithLeastForagers(creep, targetRooms, getHomeName(creep));
        if (!least){
          var report = roleVeinseeker.buildNoSafeAssignmentReport(creep);
          logVeinseekerNoSafeSource(creep, report);
          delete creep.memory.targetRoom;
          delete creep.memory.sourceId;
          delete creep.memory.assigned;
          return;
        }
        creep.memory.targetRoom = least;

        var roomMemory = getRoomMemoryBucket(creep.memory.targetRoom);
        var sid = roleVeinseeker.assignSource(creep, roomMemory);
        if (sid){
          creep.memory.sourceId = sid;
          creep.memory.assigned = true;
          creep.memory._assignTick = Game.time;

          var memAssign = ensureAssignmentsMem();
          maInc(memAssign, sid, creep.memory.targetRoom);
          maSetOwner(memAssign, sid, creep.name, creep.memory.targetRoom);

          debugSay(creep, '🎯SRC');
          var srcObj = Game.getObjectById(sid);
          if (srcObj) { debugDrawLine(creep, srcObj, CFG.DRAW.PICK_COLOR, "ASSIGN"); debugRing(creep.room, srcObj.pos, CFG.DRAW.PICK_COLOR, shortSid(sid)); }
          else { var center = new RoomPosition(25,25,creep.memory.targetRoom); debugDrawLine(creep, center, CFG.DRAW.TRAVEL_COLOR, "ASSIGN"); }

          if (creep.memory._lastLogSid !== sid){
            console.log('🐝 '+creep.name+' assigned to source: '+sid+' in '+creep.memory.targetRoom);
            creep.memory._lastLogSid = sid;
          }
        }else{
          logVeinseekerNoSafeSource(creep, 'room=' + creep.memory.targetRoom + ' has no safe/open sources');
          creep.memory.targetRoom=null; creep.memory.sourceId=null;
        }
      }
    },

    buildNoSafeAssignmentReport: function(creep) {
      var homeName = getHomeName(creep);
      var ring = bfsNeighborRooms(homeName, REMOTE_RADIUS);
      var memAssign = ensureAssignmentsMem();
      var blocked = 0, staleIntel = 0, noSources = 0, fullSources = 0, noRoute = 0;
      var localOwnedRooms = 0, homeRooms = 0, ownedSpawnRooms = 0;
      for (var i = 0; i < ring.length; i++) {
        var rn = ring[i];
        if (rn === Memory.firstSpawnRoom) continue;
        var localOwnedReason = getVeinseekerLocalOwnedRoomBlockReason(homeName, rn);
        if (localOwnedReason) {
          if (localOwnedReason === 'home-room') homeRooms++;
          else if (localOwnedReason === 'owned-spawn-room') ownedSpawnRooms++;
          else localOwnedRooms++;
          continue;
        }
        if (isVeinseekerRoomUnsafe(rn)) { blocked++; continue; }
        var rm = getRoomMemoryBucket(rn);
        if (!rm || !rm.sources || !Object.keys(rm.sources).length) { noSources++; continue; }
        var roomRoute = null;
        try { roomRoute = Game.map.findRoute(homeName, rn); } catch (e) { roomRoute = ERR_NO_PATH; }
        if (roomRoute === ERR_NO_PATH || roomRoute == null) { noRoute++; continue; }
        var sids = Object.keys(rm.sources);
        var hasOpen = false;
        var freshSeen = false;
        for (var si = 0; si < sids.length; si++) {
          var sid = sids[si];
          var rec = rm.sources[sid] || {};
          if (typeof rec.lastSeen === 'number' && (Game.time - rec.lastSeen) <= 2000) freshSeen = true;
          if (maCount(memAssign, sid) < getSourceMaxSlots(sid)) hasOpen = true;
        }
        if (!freshSeen) staleIntel++;
        if (!hasOpen) fullSources++;
      }
      var blockedSources = 0;
      var blockedReasonCounts = {};
      for (var ri = 0; ri < ring.length; ri++) {
        var roomName = ring[ri];
        var roomMem = getRoomMemoryBucket(roomName);
        var localOwnedReason2 = getVeinseekerLocalOwnedRoomBlockReason(homeName, roomName);
        if (localOwnedReason2) {
          blockedReasonCounts[roomName + ':' + localOwnedReason2] = (blockedReasonCounts[roomName + ':' + localOwnedReason2] || 0) + 1;
        } else if (isVeinseekerRoomUnsafe(roomName)) {
          var reason = roomMem.sourceWorkerBlockedReason || 'memory-blocked';
          blockedReasonCounts[roomName + ':' + reason] = (blockedReasonCounts[roomName + ':' + reason] || 0) + 1;
        }
        if (!roomMem || !roomMem.sources) continue;
        var sourceIds = Object.keys(roomMem.sources);
        for (var bi = 0; bi < sourceIds.length; bi++) {
          if (isVeinseekerSourceBlocked(roomName, sourceIds[bi])) blockedSources++;
        }
      }
      var topRejected = [];
      var homeMem = Memory.rooms && Memory.rooms[homeName] ? Memory.rooms[homeName] : null;
      var lastSel = homeMem && homeMem.lastVeinseekerSelection ? homeMem.lastVeinseekerSelection : null;
      if (lastSel && lastSel.rejectedCloserRooms && lastSel.rejectedCloserRooms.length) {
        var rejectCount = {};
        for (var rj = 0; rj < lastSel.rejectedCloserRooms.length; rj++) {
          var rr = lastSel.rejectedCloserRooms[rj];
          var key = (rr.roomName || 'unknown') + ':' + (rr.reason || 'unknown');
          rejectCount[key] = (rejectCount[key] || 0) + 1;
        }
        for (var rk in rejectCount) topRejected.push({ key: rk, count: rejectCount[rk] });
        topRejected.sort(function (a, b) { return b.count - a.count; });
      }
      var blockedReasonKeys = Object.keys(blockedReasonCounts);
      var blockedReasonStr = blockedReasonKeys.length ? blockedReasonKeys.slice(0, 5).join(',') : 'none';
      var topRejectedStr = topRejected.slice(0, 3).map(function (x) { return x.key + 'x' + x.count; }).join(',');
      return 'blockedRooms=' + blocked +
        ' localOwnedRooms=' + localOwnedRooms +
        ' homeRooms=' + homeRooms +
        ' ownedSpawnRooms=' + ownedSpawnRooms +
        ' blockedSources=' + blockedSources +
        ' blockedReasonCounts=' + blockedReasonStr +
        ' staleIntel=' + staleIntel +
        ' noSources=' + noSources +
        ' fullSources=' + fullSources +
        ' noRoute=' + noRoute +
        ' approvedSourceFilterUsed=' + (lastSel ? !!lastSel.approvedSourceFilterUsed : false) +
        ' scoutPlanUsed=' + (lastSel ? !!lastSel.scoutPlanUsed : false) +
        ' topRejectedRooms=' + (topRejectedStr || 'none');
    },

    assignSource: function(creep, roomMemory){
      // Pick a source inside an already-selected target room, preferring totally
      // free sources, then this creep's sticky source, then partially occupied
      // sources that still have capacity.
      if (!roomMemory || !roomMemory.sources) return null;
      if (creep.memory && creep.memory.targetRoom && isVeinseekerLocalOwnedRoom(getHomeName(creep), creep.memory.targetRoom)) return null;
      if (creep.memory && creep.memory.targetRoom && isVeinseekerRoomUnsafe(creep.memory.targetRoom)) return null;
      var sids = Object.keys(roomMemory.sources); if (!sids.length) return null;

      var memAssign = ensureAssignmentsMem();
      var free=[], sticky=[], rest=[];
      for (var i=0;i<sids.length;i++){
        var sid=sids[i];
        if (isVeinseekerSourceBlocked(creep.memory.targetRoom, sid)) continue;
        var owners = maOwners(memAssign, sid);
        var cnt   = maCount(memAssign, sid);
        var cap = getSourceMaxSlots(sid);
        if (cnt >= cap) continue;

        if (creep.memory.sourceId===sid) sticky.push(sid);
        else if (!owners.length) free.push(sid);
        else rest.push(sid);
      }

      var pick = free[0] || sticky[0] || rest[0] || null;
      if (!pick) return null;

      if (!tryClaimSourceForTick(creep, pick)) return null;
      return pick;
    },


    harvestSource: function(creep){
      // Harvest loop for the assigned source. It also maintains remote container
      // build/status/haul Memory, so changing it affects Truckers, Repair,
      // SourceEnergy.Manager, and BeeSpawnManager quota decisions.
      if (!creep.memory.targetRoom || !creep.memory.sourceId){
        if (Game.time%25===0) console.log('Forager '+creep.name+' missing targetRoom/sourceId'); return;
      }

      if (creep.memory.targetRoom && isVeinseekerRoomUnsafe(creep.memory.targetRoom)) {
        debugSay(creep, '🚫SAFE');
        var targetMem = (Memory.rooms && Memory.rooms[creep.memory.targetRoom]) || {};
        if (!creep.memory._lastUnsafeLog || (Game.time - creep.memory._lastUnsafeLog) >= 25) {
          console.log('🚫 Veinseeker ' + creep.name + ' releasing unsafe room ' + creep.memory.targetRoom + ' reason=' + (targetMem.sourceWorkerBlockedReason || 'unsafe'));
          creep.memory._lastUnsafeLog = Game.time;
        }
        releaseAssignment(creep);
        return;
      }

      if (creep.room.name !== creep.memory.targetRoom){
        var dest = new RoomPosition(25,25,creep.memory.targetRoom);
        debugSay(creep, '➡️'+creep.memory.targetRoom);
        debugDrawLine(creep, dest, CFG.DRAW.TRAVEL_COLOR, "ROOM");
        veinseekerTravelToAssigned(creep, dest, { range: 20, reusePath: 20 }, creep.memory.sourceId, 'room-travel');
        return;
      }

      if (isRoomLockedByInvaderCore(creep.room.name)){
        debugSay(creep, '⛔LOCK');
        console.log('⛔ '+creep.name+' bailing from locked room '+creep.room.name+'.');
        releaseAssignment(creep); return;
      }

      var sid = creep.memory.sourceId;
      var src = Game.getObjectById(sid);
      if (!src){ if (Game.time%25===0) console.log('Source not found for '+creep.name); releaseAssignment(creep); return; }

      ensureSourceFlag(src);
      var srec = getSourceMemory(creep.room.name, sid); srec.x = src.pos.x; srec.y = src.pos.y;

      if (creep.room.controller) ensureControllerFlag(creep.room.controller);

      var rm = getRoomMemoryBucket(creep.memory.targetRoom);
      rm.sources = rm.sources || {};
      if (rm.sources[sid] && rm.sources[sid].entrySteps == null){
        var res = PathFinder.search(creep.pos, { pos: src.pos, range: 1 }, { plainCost: PLAIN_COST, swampCost: SWAMP_COST, maxOps: MAX_PF_OPS });
        if (!res.incomplete) rm.sources[sid].entrySteps = res.path.length;
      }

      var stuckTicks = typeof creep.memory._stuck === 'number' ? creep.memory._stuck : 0;

      // A remote miner is supposed to stand still once it reaches the source.
      // Being stationary beside the source is productive, not stuck.
      if (creep.pos.getRangeTo(src) <= 1) {
        creep.memory._stuck = 0;
      } else if (stuckTicks >= VEINSEEKER_STUCK_SOURCE_BLOCK_TICKS) {
        markVeinseekerSourceBlocked(
          creep.memory.targetRoom,
          sid,
          'stuck-source-path',
          VEINSEEKER_STUCK_SOURCE_BLOCK_TTL
        );
        releaseAssignment(creep);
        idleAtAnchor(creep, 'STUCK');
        return;
      }

      var infra = ensureSourceContainerOrSite(src);
      var container = findAssignedSourceContainer(creep, src) || infra.container;
      var site = infra.site;
      var plannedPos = infra.plannedPos || null;
      upsertRemoteContainerBuildStatus(creep, src, container, site, plannedPos);

      creep.memory.assignedSource = sid;
      debugRing(creep.room, src.pos, CFG.DRAW.SRC_COLOR, 'SRC');

      var anchorPos = (container && container.pos) || (site && site.pos) || plannedPos || null;
      var seatPos = anchorPos ? chooseRemoteHarvestSeat(creep, src, anchorPos) : chooseRemoteHarvestSeat(creep, src, null);
      var usingFallbackSeat = false;
      if (!seatPos && anchorPos) {
        usingFallbackSeat = true;
        seatPos = anchorPos;
        rememberRemoteSeat(creep, seatPos);
        writeRemoteSeatProblem(creep, src, 'remote-compatible-seat-fallback-to-anchor', anchorPos);
      } else if (seatPos) {
        rememberRemoteSeat(creep, seatPos);
      }

      if (container) {
        creep.memory.assignedContainer = container.id;
        creep.memory.containerId = container.id;
        srec.containerId = container.id;
        delete creep.memory.planX;
        delete creep.memory.planY;
        upsertRemoteContainerStatus(creep, src, container);
        debugRing(creep.room, container.pos, CFG.DRAW.SEAT, 'SEAT');
      } else if (site) {
        delete creep.memory.assignedContainer;
        delete creep.memory.containerId;
        delete creep.memory.planX;
        delete creep.memory.planY;
        debugRing(creep.room, site.pos, CFG.DRAW.BUILD_COLOR, 'SITE');
      } else {
        delete creep.memory.assignedContainer;
        delete creep.memory.containerId;
        if (plannedPos) {
          creep.memory.planX = plannedPos.x;
          creep.memory.planY = plannedPos.y;
          debugRing(creep.room, plannedPos, CFG.DRAW.SEAT, 'PLAN');
        }
      }

      var containerHitsPct = (container && container.hitsMax) ? (container.hits / container.hitsMax) : 1;
      if (creep.memory.sourceWorkerRepairingContainer) {
        if (!container || isVeinseekerRoomUnsafe(container.pos.roomName) || containerHitsPct >= (CFG.remoteContainerRepairStopPct || 0.85)) {
          creep.memory.sourceWorkerRepairingContainer = false;
        }
      } else if (shouldRepairAssignedContainer(creep, container)) {
        creep.memory.sourceWorkerRepairingContainer = true;
      }

      if (container && creep.memory.sourceWorkerRepairingContainer) creep.memory.state = 'REPAIR_CONTAINER';
      else if (!container && site) creep.memory.state = 'BUILD_CONTAINER';

      var transferredToContainerThisTick = false;
      var builtSiteThisTick = false;
      if (container && !creep.memory.sourceWorkerRepairingContainer &&
          seatPos && !creep.pos.isEqualTo(seatPos) &&
          creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0 &&
          creep.pos.getRangeTo(container) <= 1 &&
          container.store &&
          container.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        debugDrawLine(creep, container, CFG.DRAW.OFFLOAD, 'CONT');
        var preSeatTransfer = creep.transfer(container, RESOURCE_ENERGY);
        if (preSeatTransfer === ERR_FULL) {
          dropRemoteSourceOverflow(creep, src, container, 'remote-container-full-before-seat');
        }
        transferredToContainerThisTick = true;
      } else if (container && !creep.memory.sourceWorkerRepairingContainer &&
          seatPos && !creep.pos.isEqualTo(seatPos) &&
          creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0 &&
          creep.pos.getRangeTo(container) <= 1 &&
          container.store &&
          container.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) {
        dropRemoteSourceOverflow(creep, src, container, 'remote-container-full-before-seat');
      } else if (!container && site &&
          seatPos && !creep.pos.isEqualTo(seatPos) &&
          creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0 &&
          creep.pos.getRangeTo(site) <= 3) {
        debugDrawLine(creep, site, CFG.DRAW.BUILD_COLOR, 'SITE');
        creep.build(site);
        builtSiteThisTick = true;
        upsertRemoteContainerBuildStatus(creep, src, container, site, plannedPos);
      }

      if (seatPos && !creep.pos.isEqualTo(seatPos)) {
        if (container) debugDrawLine(creep, container, CFG.DRAW.TRAVEL_COLOR, 'SEAT');
        else if (site) debugDrawLine(creep, site, CFG.DRAW.BUILD_COLOR, 'SITE');
        else debugDrawLine(creep, src, CFG.DRAW.TRAVEL_COLOR, 'SRC');
        veinseekerTravelToAssigned(creep, seatPos, { range: 0, reusePath: 10 }, sid, usingFallbackSeat ? 'anchor-travel' : 'seat-travel');
        return;
      }
      if (!seatPos && creep.pos.getRangeTo(src) > 1) { debugDrawLine(creep, src, CFG.DRAW.TRAVEL_COLOR, 'SRC'); veinseekerTravelToAssigned(creep, src, { range: 1, reusePath: 10 }, sid, 'source-travel'); return; }
      clearVeinseekerPathFailure(creep, sid);

      if (container && creep.memory.sourceWorkerRepairingContainer) {
        upsertRemoteHaulRequest(creep, src, container);
        markContainerRepairMaintenanceHold(creep, container, src);
        var minEnergy = CFG.remoteContainerRepairMinContainerEnergy || 100;
        var withdrawAmount = CFG.remoteContainerRepairWithdrawAmount || 50;
        if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
          if (creep.pos.getRangeTo(container) > 3) {
            veinseekerTravelToAssigned(creep, seatPos || container.pos, { range: seatPos ? 0 : 3, reusePath: 5 }, sid, 'repair-position');
            return;
          }
          creep.repair(container);
          creep.say('🔧 box', true);
          return;
        }
        var available = (container.store && container.store[RESOURCE_ENERGY]) || 0;
        var maxTake = Math.max(0, available - minEnergy);
        var need = Math.min(withdrawAmount, creep.store.getFreeCapacity(RESOURCE_ENERGY), maxTake);
        if (need > 0) {
          if (creep.pos.getRangeTo(container) > 1) {
            veinseekerTravelToAssigned(creep, seatPos || container.pos, { range: seatPos ? 0 : 1, reusePath: 5 }, sid, 'repair-withdraw-position');
            return;
          }
          creep.withdraw(container, RESOURCE_ENERGY, need);
          return;
        }
        creep.harvest(src);
        return;
      }

      debugSay(creep, '⛏️SRC');
      var rc = creep.harvest(src);
      if (rc === OK) touchSourceActive(creep.room.name, sid);
      if (rc === OK) clearVeinseekerPathFailure(creep, sid);
      debugDrawLine(creep, src, CFG.DRAW.SRC_COLOR, 'SRC');

      if (container && !transferredToContainerThisTick &&
          creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0 &&
          creep.pos.getRangeTo(container) <= 1 &&
          container.store &&
          container.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        debugDrawLine(creep, container, CFG.DRAW.OFFLOAD, 'CONT');
        var postHarvestTransfer = creep.transfer(container, RESOURCE_ENERGY);
        if (postHarvestTransfer === ERR_FULL) {
          dropRemoteSourceOverflow(creep, src, container, 'remote-container-full-after-harvest');
        }
      } else if (container && !transferredToContainerThisTick &&
          creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0 &&
          creep.pos.getRangeTo(container) <= 1 &&
          container.store &&
          container.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) {
        dropRemoteSourceOverflow(creep, src, container, 'remote-container-full-after-harvest');
      } else if (!container && site && !builtSiteThisTick &&
          creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0 &&
          creep.pos.getRangeTo(site) <= 3) {
        debugDrawLine(creep, site, CFG.DRAW.BUILD_COLOR, 'SITE');
        creep.build(site);
        upsertRemoteContainerBuildStatus(creep, src, container, site, plannedPos);
      } else if (!container && !site && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
        writeRemoteOverflowDiag(creep, src, null, 'drop', 'remote-no-container-or-site');
        creep.drop(RESOURCE_ENERGY);
      }
      if (container) upsertRemoteHaulRequest(creep, src, container);
      publishRemoteLooseEnergyRequests(creep, src, container);
    }
  };

roleVeinseeker.MAX_VEINSEEKER_PER_SOURCE = MAX_VEINSEEKER_PER_SOURCE;

module.exports = {
  run: function (creep) { return roleVeinseeker.run(creep); },
  MAX_VEINSEEKER_PER_SOURCE: MAX_VEINSEEKER_PER_SOURCE
};
