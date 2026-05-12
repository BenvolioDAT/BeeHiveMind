
var CoreConfig = require('core.config');
var Logger = require('core.logger');
var LOG_LEVEL = Logger.LOG_LEVEL;
var maintLog = Logger.createLogger('Maintenance', LOG_LEVEL.DEBUG);

// -----------------------------
// Tunables + config helpers
// -----------------------------

var maintCfg = CoreConfig.settings.maintenance || {};
var CFG = {
  ROOM_STALE_TICKS:        600,  // prune room if unseen this long
  ROOM_PRUNE_INTERVAL:      maintCfg.roomSweepInterval || 200,
  MEMORY_SWEEP_INTERVAL:      10, // run heavy creep/assignment sweeps every N ticks
  EMPTY_ROOM_GRACE_TICKS:   300, // if a room mem is "empty-ish" this long, delete it
  BLOCK_MARK_TTL:         10000, // drop old "blocked" stamps after this long
  REPAIR_SCAN_INTERVAL:       maintCfg.repairScanInterval || 5,
  REPAIR_MAX_RAMPART:      30000,
  REPAIR_MAX_WALL:         30000,
  REPAIR_ROAD_THRESHOLD:     0.60,
  REPAIR_CONTAINER_THRESHOLD:0.80,
  REPAIR_CRITICAL_THRESHOLD: 0.85,
  REPAIR_CRITICAL_EMERGENCY: 0.35,
  REPAIR_GENERIC_THRESHOLD:  0.90,
  REPAIR_ROAD_REQUIRE_PLANNED: true,
  LOG: Logger.shouldLog(LOG_LEVEL.DEBUG)
};

// -----------------------------
// Shared utilities
// -----------------------------

function _now() { return Game.time; }
function _log(msg) { if (CFG.LOG) maintLog.debug(msg); }

function _hasOwn(obj, k) { return obj && Object.prototype.hasOwnProperty.call(obj, k); }
function _isObject(x) { return x && typeof x === 'object'; }
function _isEmptyObject(o) {
  if (!_isObject(o)) return true;
  for (var k in o) { if (_hasOwn(o, k)) return false; }
  return true;
}

// Safely read a "last seen" timestamp from room memory written by various systems
function _lastSeen(mem) {
  if (!mem) return -Infinity;
  if (typeof mem.lastSeenAt === 'number') return mem.lastSeenAt;
  if (mem.scout && typeof mem.scout.lastVisited === 'number') return mem.scout.lastVisited;
  if (mem.intel && typeof mem.intel.lastVisited === 'number') return mem.intel.lastVisited;
  if (typeof mem.lastVisited === 'number') return mem.lastVisited;
  return -Infinity;
}

// ---- Deep compaction of a single room mem ----
// Returns true if the room is "now empty" after compaction
function _compactRoomMem(roomName, mem) {
  if (!mem) return true;
  var now = _now();

  if (_hasOwn(mem, 'blocked') && typeof mem.blocked === 'number') {
    if (now - mem.blocked > CFG.BLOCK_MARK_TTL) delete mem.blocked;
  }

  if (_isObject(mem.sources)) {
    var hasSrc = false;
    for (var s in mem.sources) {
      if (_hasOwn(mem.sources, s)) { hasSrc = true; break; }
    }
    if (!hasSrc) delete mem.sources;
  }

  if (_isObject(mem.sourceContainers)) {
    var hasVision = !!(Game.rooms && Game.rooms[roomName]);
    var keepContainer = false;
    for (var cid in mem.sourceContainers) {
      if (!_hasOwn(mem.sourceContainers, cid)) continue;
      if (hasVision && !Game.getObjectById(cid)) {
        delete mem.sourceContainers[cid];
        continue;
      }
      keepContainer = true;
    }
    if (!keepContainer) delete mem.sourceContainers;
  }

  // Trim intel buckets in-place so readers can see what "empty" means.
  if (_isObject(mem.intel)) {
    var intel = mem.intel;
    if (_isObject(intel.portals) && intel.portals.length === 0) delete intel.portals;
    if (_isObject(intel.deposits) && intel.deposits.length === 0) delete intel.deposits;
    if (intel.powerBank === null) delete intel.powerBank;

    var keepKeys = ['lastVisited','lastScanAt','sources','owner','reservation','rcl','safeMode','invaderCore','keeperLairs','mineral','enemySpawns','enemyTowers','hostiles','powerBank','portals','deposits'];
    var i1;
    for (i1 = 0; i1 < keepKeys.length; i1++) {
      if (_hasOwn(intel, keepKeys[i1])) {
        break; // found something meaningful to keep
      }
    }
    if (i1 === keepKeys.length) delete mem.intel;
  }

  if (_isObject(mem.scout) && typeof mem.scout.lastVisited !== 'number') {
    delete mem.scout;
  }

  // Compact maintenance cache alongside intel so the clean-up rules live together.
  if (_isObject(mem._maint)) {
    if (_isObject(mem._maint.cachedRepairTargets) && mem._maint.cachedRepairTargets.length === 0) {
      delete mem._maint.cachedRepairTargets;
    }
    var hasMaint = false;
    for (var mk in mem._maint) {
      if (_hasOwn(mem._maint, mk)) { hasMaint = true; break; }
    }
    if (!hasMaint) delete mem._maint;
  }

  var keys = [];
  for (var k in mem) { if (_hasOwn(mem, k)) keys.push(k); }

  if (keys.length === 0) return true;

  if (keys.length === 1 && keys[0] === 'lastSeenAt') {
    var ls = typeof mem.lastSeenAt === 'number' ? mem.lastSeenAt : 0;
    if (ls && (now - ls) > CFG.EMPTY_ROOM_GRACE_TICKS) return true;
  }

  return false;
}

// -----------------------------
// Room pruning helpers
// -----------------------------

// Touch every visible room just once per tick to stamp lastSeenAt without
// accidentally creating Memory entries for unexplored rooms.
function _stampVisibleRooms(now) {
  for (var rn in Game.rooms) {
    if (!Game.rooms.hasOwnProperty(rn)) continue;
    if (Memory.rooms && Memory.rooms[rn]) {
      Memory.rooms[rn].lastSeenAt = now;
    }
  }
}

// Learner tip: splitting the prune (delete stale) and compact (tidy survivors)
// passes lets you short-circuit or instrument each stage independently.
function _deleteStaleRooms(now) {
  if (!Memory.rooms) return;
  Memory.recentlyCleanedRooms = [];
  var protectedRooms = _protectedRoomSet();

  for (var roomName in Memory.rooms) {
    if (!Memory.rooms.hasOwnProperty(roomName)) continue;
    if (Game.rooms[roomName]) continue;
    if (protectedRooms[roomName]) continue;

    var mem = Memory.rooms[roomName];
    var seenAt = _lastSeen(mem);
    if (seenAt !== -Infinity && (now - seenAt) > CFG.ROOM_STALE_TICKS) {
      delete Memory.rooms[roomName];
      Memory.recentlyCleanedRooms.push(roomName);
      _log('🧼 Cleaned stale room mem: ' + roomName);
    }
  }
}

function _protectedRoomSet() {
  var out = Object.create(null);

  // Keep currently owned rooms even if not visible this tick (shard jitter/sim).
  for (var roomName in Game.rooms) {
    if (!Game.rooms.hasOwnProperty(roomName)) continue;
    var room = Game.rooms[roomName];
    if (room && room.controller && room.controller.my) out[roomName] = true;
  }

  // Keep active planner remotes used by economy systems.
  var remotesByHome = Memory.__BHM && Memory.__BHM.remotesByHome;
  if (remotesByHome && typeof remotesByHome === 'object') {
    for (var home in remotesByHome) {
      if (!Object.prototype.hasOwnProperty.call(remotesByHome, home)) continue;
      var remotes = remotesByHome[home];
      if (!Array.isArray(remotes)) continue;
      for (var i = 0; i < remotes.length; i++) {
        if (typeof remotes[i] === 'string' && remotes[i].length > 0) out[remotes[i]] = true;
      }
    }
  }

  // Optional explicit allow-list for source intel persistence.
  if (Array.isArray(Memory.sourceIntelApprovedRooms)) {
    for (var j = 0; j < Memory.sourceIntelApprovedRooms.length; j++) {
      var rn = Memory.sourceIntelApprovedRooms[j];
      if (typeof rn === 'string' && rn.length > 0) out[rn] = true;
    }
  }

  return out;
}

function _compactRemainingRooms() {
  if (!Memory.rooms) return;
  var protectedRooms = _protectedRoomSet();

  for (var roomName in Memory.rooms) {
    if (!Memory.rooms.hasOwnProperty(roomName)) continue;
    var mem = Memory.rooms[roomName];

    if (_compactRoomMem(roomName, mem)) {
      if (!Game.rooms[roomName] && !protectedRooms[roomName]) {
        delete Memory.rooms[roomName];
        Memory.recentlyCleanedRooms.push(roomName);
        _log('🧼 Deleted empty room mem: ' + roomName);
      }
    }
  }
}

function cleanStaleRooms() {
  var now = _now();
  _stampVisibleRooms(now);

  if ((now % CFG.ROOM_PRUNE_INTERVAL) !== 0) {
    return; // keep the cheap stamp but skip the heavy pruning work
  }

  if (!Memory.rooms) return;
  _deleteStaleRooms(now);
  _compactRemainingRooms();
}

// -----------------------------
// Creep + assignment cleanup
// -----------------------------

function _releaseRemoteAssignment(creepName, creepMem) {
  if (!creepMem || !creepMem.sourceId) return;
  if (!Memory.remoteAssignments) return;

  var entry = Memory.remoteAssignments[creepMem.sourceId];
  if (entry == null) return;

  // Backwards compatibility: legacy entries may just be numbers (count).
  if (typeof entry === 'number') {
    var nextCount = Math.max(0, entry - 1);
    if (nextCount === 0) delete Memory.remoteAssignments[creepMem.sourceId];
    else Memory.remoteAssignments[creepMem.sourceId] = nextCount;
    return;
  }

  if (typeof entry.count === 'number' && entry.count > 0) {
    entry.count = Math.max(0, entry.count - 1);
  }
  if (entry.owner === creepName) {
    entry.owner = null;
    entry.since = null;
  }
  Memory.remoteAssignments[creepMem.sourceId] = entry;
}

function _releaseContainerAssignment(creepName, creepMem) {
  if (!creepMem || !creepMem.assignedContainer) return;
  if (!Memory.rooms) return;

  var containerId = creepMem.assignedContainer;
  for (var roomName in Memory.rooms) {
    if (!Memory.rooms.hasOwnProperty(roomName)) continue;
    var roomMem = Memory.rooms[roomName];
    if (!roomMem || !_isObject(roomMem.sourceContainers)) continue;
    if (roomMem.sourceContainers[containerId] === creepName) {
      roomMem.sourceContainers[containerId] = null;
    }
  }
}

function _removeDeadCreepMemory() {
  if (!Memory.creeps) return;
  for (var name in Memory.creeps) {
    if (!Memory.creeps.hasOwnProperty(name)) continue;
    if (Game.creeps[name]) continue;

    var creepMem = Memory.creeps[name];
    _releaseRemoteAssignment(name, creepMem);
    _releaseContainerAssignment(name, creepMem);

    delete Memory.creeps[name];
    _log('🧼 Removed creep mem: ' + name);
  }
}

// Source assignment bookkeeping toggles between arrays (ordered creep lists)
// and objects (per-role slots).  Walk both forms carefully so we do not throw
// away valid claims just because a different role wrote the data.
function _pruneSourceAssignments(roomName, roomMemory) {
  if (!_isObject(roomMemory.sources)) return;
  var hasVision = !!(Game.rooms && Game.rooms[roomName]);
  var liveSourcesById = null;
  if (hasVision) {
    liveSourcesById = Object.create(null);
    var liveSources = Game.rooms[roomName].find(FIND_SOURCES);
    for (var li = 0; li < liveSources.length; li++) {
      liveSourcesById[liveSources[li].id] = true;
    }
  }

  for (var sourceId in roomMemory.sources) {
    if (!roomMemory.sources.hasOwnProperty(sourceId)) continue;

    if (hasVision && !liveSourcesById[sourceId]) {
      delete roomMemory.sources[sourceId];
      continue;
    }

    var sourceEntry = roomMemory.sources[sourceId];
    if (Array.isArray(sourceEntry)) {
      var kept = [];
      for (var i = 0; i < sourceEntry.length; i++) {
        if (Game.creeps[sourceEntry[i]]) kept.push(sourceEntry[i]);
      }
      roomMemory.sources[sourceId] = kept;
      continue;
    }

    if (_isObject(sourceEntry)) {
      // Preserve all source intel fields by default.
      // We intentionally do NOT prune string fields here because source intel
      // may store non-creep metadata (flagName, roomName, sourceId, etc.).
      // If assignment-slot names become explicit in the future, only those
      // named slots should be pruned when their creep no longer exists.
      continue;
    }
  }

  for (sourceId in roomMemory.sources) {
    if (_hasOwn(roomMemory.sources, sourceId)) {
      return;
    }
  }
  delete roomMemory.sources;
}

function _pruneContainerAssignments(roomName, roomMemory) {
  if (!_isObject(roomMemory.sourceContainers)) return;
  var hasVision = !!(Game.rooms && Game.rooms[roomName]);

  for (var containerId in roomMemory.sourceContainers) {
    if (!roomMemory.sourceContainers.hasOwnProperty(containerId)) continue;
    var assigned = roomMemory.sourceContainers[containerId];
    if (assigned && !Game.creeps[assigned]) {
      delete roomMemory.sourceContainers[containerId];
      _log('🧹 Unassigned container ' + containerId + ' in ' + roomName);
    }
  }

  for (containerId in roomMemory.sourceContainers) {
    if (!_hasOwn(roomMemory.sourceContainers, containerId)) continue;
    if (hasVision && !Game.getObjectById(containerId)) delete roomMemory.sourceContainers[containerId];
  }

  for (containerId in roomMemory.sourceContainers) {
    if (_hasOwn(roomMemory.sourceContainers, containerId)) {
      return;
    }
  }
  delete roomMemory.sourceContainers;
}

// Each room sweep runs the same mini-playbook so a novice can trace the order:
// 1) drop dead claims, 2) drop stale containers, 3) compact the leftover data.
function _heavyRoomSweep(roomName, roomMemory) {
  _pruneSourceAssignments(roomName, roomMemory);
  _pruneContainerAssignments(roomName, roomMemory);

  var protectedRooms = _protectedRoomSet();
  if (_compactRoomMem(roomName, roomMemory) && !Game.rooms[roomName] && !protectedRooms[roomName]) {
    delete Memory.rooms[roomName];
    _log('🧼 Deleted empty room mem (sweep): ' + roomName);
  }
}

function cleanUpMemory() {
  var now = _now();
  _removeDeadCreepMemory();

  // Heavy work is cadence gated.  This way the cheap dead-creep prune runs
  // every tick, while the per-room scans only fire every MEMORY_SWEEP_INTERVAL
  // ticks to keep CPU predictable.
  if ((now % CFG.MEMORY_SWEEP_INTERVAL) !== 0) return;
  if (!Memory.rooms) return;

  for (var roomName in Memory.rooms) {
    if (!Memory.rooms.hasOwnProperty(roomName)) continue;
    _heavyRoomSweep(roomName, Memory.rooms[roomName]);
  }
}

// -----------------------------
// Repair cache helpers
// -----------------------------

function _ensureMaintBucket(roomName) {
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
  if (!Memory.rooms[roomName]._maint) Memory.rooms[roomName]._maint = {};
  return Memory.rooms[roomName]._maint;
}

// The repair priority table doubles as documentation: read it top-to-bottom to
// understand which structures we value most when allocating repairers.
function _ensurePriorityTable(bucket) {
  if (bucket.priorityOrder) return bucket.priorityOrder;
  var order = {};
  order[STRUCTURE_CONTAINER] = 1;
  order[STRUCTURE_RAMPART]   = 3;
  order[STRUCTURE_WALL]      = 4;
  order[STRUCTURE_STORAGE]   = 5;
  order[STRUCTURE_SPAWN]     = 6;
  order[STRUCTURE_EXTENSION] = 7;
  order[STRUCTURE_TOWER]     = 8;
  order[STRUCTURE_LINK]      = 9;
  order[STRUCTURE_TERMINAL]  = 10;
  order[STRUCTURE_LAB]       = 11;
  order[STRUCTURE_OBSERVER]  = 12;
  order[STRUCTURE_ROAD]      = 13;
  bucket.priorityOrder = order;
  return order;
}

// Cache entries outlive a single tick, so trim them against current hits to
// avoid sending creeps to already-healed structures.
function _trimCachedTargets(bucket) {
  if (!bucket.cachedRepairTargets || !bucket.cachedRepairTargets.length) return [];
  var kept = [];
  var maxR = CFG.REPAIR_MAX_RAMPART;
  var maxW = CFG.REPAIR_MAX_WALL;

  for (var i = 0; i < bucket.cachedRepairTargets.length; i++) {
    var entry = bucket.cachedRepairTargets[i];
    var obj = Game.getObjectById(entry.id);
    if (!obj) continue;
    if (obj.structureType === STRUCTURE_RAMPART) {
      if (obj.hits < Math.min(obj.hitsMax, maxR)) kept.push(entry);
    } else if (obj.structureType === STRUCTURE_WALL) {
      if (obj.hits < Math.min(obj.hitsMax, maxW)) kept.push(entry);
    } else if (obj.hits < obj.hitsMax) {
      kept.push(entry);
    }
  }

  bucket.cachedRepairTargets = kept;
  return kept;
}

function _isCriticalStructureType(type) {
  return type === STRUCTURE_SPAWN ||
    type === STRUCTURE_EXTENSION ||
    type === STRUCTURE_TOWER ||
    type === STRUCTURE_STORAGE ||
    type === STRUCTURE_LINK ||
    type === STRUCTURE_TERMINAL ||
    type === STRUCTURE_LAB ||
    type === STRUCTURE_OBSERVER;
}

function _ensurePlannedRoadIndex() {
  if (!global.__BHM_MAINT) global.__BHM_MAINT = {};
  if (global.__BHM_MAINT.roadPlanIndexTick === _now() && global.__BHM_MAINT.roadPlanIndex) {
    return global.__BHM_MAINT.roadPlanIndex;
  }
  var idx = { byRoom: {}, ownedRooms: {} };
  for (var rn in Game.rooms) {
    if (!Game.rooms.hasOwnProperty(rn)) continue;
    var roomObj = Game.rooms[rn];
    if (roomObj && roomObj.controller && roomObj.controller.my) {
      idx.ownedRooms[rn] = true;
    }
  }

  var roomsMem = Memory.rooms || {};
  var homeNames = Object.keys(idx.ownedRooms);
  for (var h = 0; h < homeNames.length; h++) {
    var homeName = homeNames[h];
    var homeMem = roomsMem[homeName];
    if (!homeMem || !homeMem.roadPlanner || !homeMem.roadPlanner.paths) continue;
    var paths = homeMem.roadPlanner.paths;
    var keys = Object.keys(paths);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var rec = paths[key];
      if (!rec || !Array.isArray(rec.path)) continue;
      var isLocalPath = key.indexOf(homeName + ':LOCAL:') === 0;
      for (var p = 0; p < rec.path.length; p++) {
        var step = rec.path[p];
        if (!step || step.x == null || step.y == null || !step.roomName) continue;
        if (!idx.byRoom[step.roomName]) idx.byRoom[step.roomName] = {};
        var posKey = step.x + ',' + step.y;
        var entry = idx.byRoom[step.roomName][posKey];
        if (!entry) {
          entry = { local: false, remote: false, homes: {} };
          idx.byRoom[step.roomName][posKey] = entry;
        }
        if (isLocalPath) entry.local = true;
        else entry.remote = true;
        entry.homes[homeName] = true;
      }
    }
  }

  global.__BHM_MAINT.roadPlanIndexTick = _now();
  global.__BHM_MAINT.roadPlanIndex = idx;
  return idx;
}

function _plannedRoadMatch(roomName, x, y) {
  var idx = _ensurePlannedRoadIndex();
  var byPos = idx.byRoom[roomName];
  if (!byPos) return { matched: false, remote: false, local: false, ownedRoom: !!idx.ownedRooms[roomName] };
  var rec = byPos[x + ',' + y];
  if (!rec) return { matched: false, remote: false, local: false, ownedRoom: !!idx.ownedRooms[roomName] };
  return {
    matched: true,
    local: !!rec.local,
    remote: !!rec.remote,
    ownedRoom: !!idx.ownedRooms[roomName]
  };
}

function _evaluateRepairTarget(structure) {
  if (!structure || structure.hits == null || structure.hitsMax == null) return null;
  var type = structure.structureType;
  var hits = structure.hits;
  var hitsMax = Math.max(1, structure.hitsMax);
  var ratio = hits / hitsMax;
  var include = false;
  var category = 'generic';
  var emergency = false;
  var goalHits = hitsMax;
  var severity = 0;

  if (type === STRUCTURE_ROAD) {
    category = 'road';
    goalHits = Math.floor(hitsMax * CFG.REPAIR_ROAD_THRESHOLD);
    var belowRoadThreshold = ratio < CFG.REPAIR_ROAD_THRESHOLD;
    var roadMatch = _plannedRoadMatch(structure.pos.roomName, structure.pos.x, structure.pos.y);
    include = belowRoadThreshold && (!CFG.REPAIR_ROAD_REQUIRE_PLANNED || roadMatch.matched);
    severity = belowRoadThreshold ? ((goalHits - hits) / Math.max(1, goalHits)) : 0;
    if (!belowRoadThreshold) return {
      include: false,
      category: category,
      severity: 0,
      road: {
        isRoad: true,
        planned: roadMatch.matched,
        remote: !roadMatch.ownedRoom,
        reason: 'ROAD_ABOVE_THRESHOLD'
      }
    };
    if (!include) return {
      include: false,
      category: category,
      severity: severity,
      road: {
        isRoad: true,
        planned: roadMatch.matched,
        remote: !roadMatch.ownedRoom,
        reason: 'ROAD_NOT_IN_PLANNED_NETWORK'
      }
    };
    return {
      include: true,
      target: {
        id: structure.id,
        hits: hits,
        hitsMax: hitsMax,
        type: type,
        ratio: ratio,
        category: category,
        emergency: false,
        goalHits: Math.max(1, goalHits),
        severity: Math.max(0, severity),
        roadPlanned: roadMatch.matched,
        roadRemote: !roadMatch.ownedRoom
      },
      category: category,
      severity: Math.max(0, severity),
      road: {
        isRoad: true,
        planned: roadMatch.matched,
        remote: !roadMatch.ownedRoom,
        reason: 'ROAD_PLANNED_INCLUDED'
      }
    };
  } else if (type === STRUCTURE_CONTAINER) {
    category = 'container';
    goalHits = Math.floor(hitsMax * CFG.REPAIR_CONTAINER_THRESHOLD);
    include = ratio < CFG.REPAIR_CONTAINER_THRESHOLD;
    severity = include ? ((goalHits - hits) / Math.max(1, goalHits)) : 0;
  } else if (type === STRUCTURE_RAMPART) {
    category = 'fort';
    goalHits = Math.min(hitsMax, CFG.REPAIR_MAX_RAMPART);
    include = hits < goalHits;
    severity = include ? ((goalHits - hits) / Math.max(1, goalHits)) : 0;
  } else if (type === STRUCTURE_WALL) {
    category = 'fort';
    goalHits = Math.min(hitsMax, CFG.REPAIR_MAX_WALL);
    include = hits < goalHits;
    severity = include ? ((goalHits - hits) / Math.max(1, goalHits)) : 0;
  } else if (_isCriticalStructureType(type)) {
    category = 'critical';
    include = ratio < CFG.REPAIR_CRITICAL_THRESHOLD;
    emergency = ratio < CFG.REPAIR_CRITICAL_EMERGENCY;
    goalHits = Math.floor(hitsMax * CFG.REPAIR_CRITICAL_THRESHOLD);
    severity = include ? ((goalHits - hits) / Math.max(1, goalHits)) : 0;
  } else {
    category = 'generic';
    include = ratio < CFG.REPAIR_GENERIC_THRESHOLD;
    goalHits = Math.floor(hitsMax * CFG.REPAIR_GENERIC_THRESHOLD);
    severity = include ? ((goalHits - hits) / Math.max(1, goalHits)) : 0;
  }

  if (!include) return { include: false, category: category, severity: 0 };
  return {
    include: true,
    target: {
      id: structure.id,
      hits: hits,
      hitsMax: hitsMax,
      type: type,
      ratio: ratio,
      category: category,
      emergency: emergency,
      goalHits: Math.max(1, goalHits),
      severity: Math.max(0, severity)
    },
    category: category,
    severity: Math.max(0, severity)
  };
}

function _emptyRepairWorkload() {
  return {
    totalCount: 0,
    meaningfulScore: 0,
    emergencyCriticalCount: 0,
    roadNetwork: {
      damagedSeen: 0,
      plannedAccepted: 0,
      unplannedRejected: 0,
      remotePlannedAccepted: 0,
      remoteUnplannedRejected: 0,
      plannedSeverity: 0,
      unplannedSeverity: 0,
      excludedReasons: {}
    },
    categories: {
      road: { count: 0, severity: 0 },
      container: { count: 0, severity: 0 },
      critical: { count: 0, severity: 0 },
      fort: { count: 0, severity: 0 },
      generic: { count: 0, severity: 0 }
    }
  };
}

function _summarizeRepairWorkload(targets, roadNetwork) {
  var summary = _emptyRepairWorkload();
  if (roadNetwork) summary.roadNetwork = roadNetwork;
  for (var i = 0; i < targets.length; i++) {
    var t = targets[i];
    if (!t || !t.category) continue;
    if (!summary.categories[t.category]) continue;
    summary.totalCount += 1;
    summary.categories[t.category].count += 1;
    summary.categories[t.category].severity += t.severity || 0;
    if (t.emergency) summary.emergencyCriticalCount += 1;
  }
  summary.meaningfulScore =
    summary.categories.critical.severity * 3 +
    summary.categories.container.severity * 2 +
    summary.categories.fort.severity * 1.5 +
    summary.categories.road.severity +
    summary.categories.generic.severity * 0.75;
  summary.meaningfulScore = Math.round(summary.meaningfulScore * 100) / 100;
  return summary;
}

// When the cache goes empty (or the cadence expires) we fall back to a full
// scan.  Sorting by priority and damage keeps the result deterministic.
function _scanRepairTargets(room, bucket, priorityOrder) {
  var list = room.find(FIND_STRUCTURES);

  var targets = [];
  var roadNetwork = _emptyRepairWorkload().roadNetwork;
  for (var i = 0; i < list.length; i++) {
    var evalTarget = _evaluateRepairTarget(list[i]);
    if (!evalTarget) continue;
    if (evalTarget.road && evalTarget.road.isRoad) {
      roadNetwork.damagedSeen += 1;
      if (evalTarget.include && evalTarget.road.planned) {
        roadNetwork.plannedAccepted += 1;
        roadNetwork.plannedSeverity += evalTarget.severity || 0;
        if (evalTarget.road.remote) roadNetwork.remotePlannedAccepted += 1;
      } else if (!evalTarget.include) {
        roadNetwork.unplannedRejected += 1;
        roadNetwork.unplannedSeverity += evalTarget.severity || 0;
        if (evalTarget.road.remote) roadNetwork.remoteUnplannedRejected += 1;
        var reason = evalTarget.road.reason || 'ROAD_REJECTED';
        roadNetwork.excludedReasons[reason] = (roadNetwork.excludedReasons[reason] || 0) + 1;
      }
    }
    if (!evalTarget.include || !evalTarget.target) continue;
    targets.push(evalTarget.target);
  }

  targets.sort(function (a, b) {
    if (!!a.emergency !== !!b.emergency) return a.emergency ? -1 : 1;
    var pa = priorityOrder[a.type] != null ? priorityOrder[a.type] : 99;
    var pb = priorityOrder[b.type] != null ? priorityOrder[b.type] : 99;
    if (pa !== pb) return pa - pb;
    if (a.ratio !== b.ratio) return a.ratio - b.ratio;
    return a.hits - b.hits;
  });

  bucket.cachedRepairTargets = targets;
  bucket.repairWorkload = _summarizeRepairWorkload(targets, roadNetwork);
  bucket.nextRepairScanTick = _now() + CFG.REPAIR_SCAN_INTERVAL;
  return targets;
}

function findStructuresNeedingRepair(room) {
  if (!room) return [];
  var bucket = _ensureMaintBucket(room.name);
  var priorityOrder = _ensurePriorityTable(bucket);
  var now = _now();

  var nextScanTick = (typeof bucket.nextRepairScanTick === 'number') ? bucket.nextRepairScanTick : 0;
  if (now < nextScanTick) {
    var cached = _trimCachedTargets(bucket);
    if (cached.length) {
      var existingRoad = (bucket.repairWorkload && bucket.repairWorkload.roadNetwork)
        ? bucket.repairWorkload.roadNetwork
        : _emptyRepairWorkload().roadNetwork;
      bucket.repairWorkload = _summarizeRepairWorkload(cached, existingRoad);
      return cached;
    }
  }

  return _scanRepairTargets(room, bucket, priorityOrder);
}

var BeeMaintenance = {
  cleanStaleRooms: cleanStaleRooms,
  cleanUpMemory: cleanUpMemory,
  findStructuresNeedingRepair: findStructuresNeedingRepair
};

module.exports = BeeMaintenance;
