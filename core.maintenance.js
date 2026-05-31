
// -----------------------------------------------------------------------------
// core.maintenance.js - stale Memory cleanup and repair target discovery
// Owns:
// * Periodic cleanup for dead creep memory, stale/empty Memory.rooms buckets,
//   source/container assignment leftovers, and remote container status TTLs.
// * Repair target discovery via findStructuresNeedingRepair(), which main.js
//   writes into Memory.rooms[roomName].repairTargets.
// Memory paths read/written:
// * Memory.creeps, Memory.rooms[*], Memory.recentlyCleanedRooms.
// * Memory.rooms[*].sourceContainers.
// * Memory.__BHM.remoteContainerStatus, preserving Veinseeker/Repair critical data
//   longer than ordinary status snapshots.
// Usually called by:
// * main.js before BeeHiveMind.run().
// Systems that depend on it:
// * role.Repair.Logic.js consumes repairTargets; Veinseeker/SourceEnergy rely on
//   source metadata surviving cleanup.
// Do not casually change:
// * The distinction between assignment maps and source metadata. Deleting
//   Memory.rooms[remote].sources metadata can break remote mining planning.
// -----------------------------------------------------------------------------

var CoreConfig = require('core.config');
var Logger = require('core.logger');
var BeeToolbox = require('BeeToolbox');
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
  REMOTE_CONTAINER_STATUS_SWEEP_INTERVAL: maintCfg.remoteContainerStatusSweepInterval || 500,
  REMOTE_CONTAINER_STATUS_STALE_TICKS: maintCfg.remoteContainerStatusStaleTicks || 150,
  REMOTE_CONTAINER_STATUS_MEMORY_TTL: maintCfg.remoteContainerStatusMemoryTtl || 20000,
  REMOTE_CONTAINER_STATUS_CRITICAL_MEMORY_TTL: maintCfg.remoteContainerStatusCriticalMemoryTtl || 50000,
  REPAIR_MAX_RAMPART:      10000,
  REPAIR_MAX_WALL:         10000,
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
  // Compact a single room bucket without assuming one module owns every field.
  // This function removes known-empty/stale subtrees but preserves source
  // metadata shapes used by Veinseeker and SourceEnergy.
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
    var keepContainer = false;
    for (var cid in mem.sourceContainers) {
      if (!_hasOwn(mem.sourceContainers, cid)) continue;
      if (!Game.getObjectById(cid)) {
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

  for (var roomName in Memory.rooms) {
    if (!Memory.rooms.hasOwnProperty(roomName)) continue;
    if (Game.rooms[roomName]) continue;

    var mem = Memory.rooms[roomName];
    var seenAt = _lastSeen(mem);
    if (seenAt !== -Infinity && (now - seenAt) > CFG.ROOM_STALE_TICKS) {
      delete Memory.rooms[roomName];
      Memory.recentlyCleanedRooms.push(roomName);
      _log('🧼 Cleaned stale room mem: ' + roomName);
    }
  }
}

function _compactRemainingRooms() {
  if (!Memory.rooms) return;

  for (var roomName in Memory.rooms) {
    if (!Memory.rooms.hasOwnProperty(roomName)) continue;
    var mem = Memory.rooms[roomName];

    if (_compactRoomMem(roomName, mem)) {
      if (!Game.rooms[roomName]) {
        delete Memory.rooms[roomName];
        Memory.recentlyCleanedRooms.push(roomName);
        _log('🧼 Deleted empty room mem: ' + roomName);
      }
    }
  }
}

function cleanStaleRooms() {
  // Lightweight visible-room stamp runs every call; expensive pruning only runs
  // on ROOM_PRUNE_INTERVAL so cleanup stays predictable.
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
  // Dead creep cleanup also releases old source/container assignments so new
  // creeps are not blocked by dead owners.
  if (!Memory.creeps) return;
  for (var name in Memory.creeps) {
    if (!Memory.creeps.hasOwnProperty(name)) continue;
    if (Game.creeps[name]) continue;

    var creepMem = Memory.creeps[name];
    _releaseContainerAssignment(name, creepMem);

    delete Memory.creeps[name];
    _log('🧼 Removed creep mem: ' + name);
  }
}

// Source assignment bookkeeping toggles between arrays (ordered creep lists)
// and objects (per-role slots).  Walk both forms carefully so we do not throw
// away valid claims just because a different role wrote the data.
function isSourceMetadataRecord(sourceRecord) {
  if (!_isObject(sourceRecord) || Array.isArray(sourceRecord)) return false;

  // Remote source entries now carry scouting/build intel (PR #309+), not just
  // role-slot assignments.  If any intel-ish key exists, treat the record as
  // metadata and preserve it during cleanup.
  var metadataKeys = {
    x: true,
    y: true,
    pos: true,
    flagName: true,
    lastActive: true,
    lastSeen: true,
    containerId: true,
    container: true,
    entrySteps: true,
    roomName: true,
    sourceId: true
  };

  for (var key in sourceRecord) {
    if (_hasOwn(sourceRecord, key) && metadataKeys[key]) return true;
  }
  return false;
}

function isLikelyAssignmentMap(sourceRecord) {
  if (!_isObject(sourceRecord) || Array.isArray(sourceRecord)) return false;
  if (isSourceMetadataRecord(sourceRecord)) return false;

  var assignmentLikeKeys = {
    miner: true,
    harvester: true,
    veinseeker: true,
    sourceWorker: true,
    veinseeker: true,
    veinseeker: true,
    sourceEnergy: true,
    hauler: true,
    trucker: true,
    courier: true,
    builder: true,
    repair: true,
    upgrader: true,
    queen: true,
    scout: true,
    claimer: true,
    owner: true,
    assigned: true,
    assignedCreep: true,
    creep: true
  };

  var hasAssignmentSignal = false;
  for (var key in sourceRecord) {
    if (!_hasOwn(sourceRecord, key)) continue;
    var value = sourceRecord[key];

    if (value == null) {
      if (assignmentLikeKeys[key]) hasAssignmentSignal = true;
      continue;
    }

    if (typeof value !== 'string') return false;
    if (assignmentLikeKeys[key]) hasAssignmentSignal = true;
    if (Game.creeps[value]) hasAssignmentSignal = true;
  }

  return hasAssignmentSignal;
}

function _pruneSourceAssignments(roomMemory) {
  if (!_isObject(roomMemory.sources)) return;
  for (var sourceId in roomMemory.sources) {
    if (!roomMemory.sources.hasOwnProperty(sourceId)) continue;
    var assignedCreeps = roomMemory.sources[sourceId];
    if (Array.isArray(assignedCreeps)) {
      // Array form: keep only live creep names so miners do not reserve slots forever.
      var kept = [];
      for (var i = 0; i < assignedCreeps.length; i++) {
        if (Game.creeps[assignedCreeps[i]]) kept.push(assignedCreeps[i]);
      }
      if (kept.length) roomMemory.sources[sourceId] = kept;
      else delete roomMemory.sources[sourceId];
      continue;
    }

    if (_isObject(assignedCreeps)) {
      if (isSourceMetadataRecord(assignedCreeps)) {
        // Metadata-shaped records are consumed by Veinseeker/SourceEnergy (including
        // source container/build progress state). Do not prune top-level keys.
        continue;
      }

      if (isLikelyAssignmentMap(assignedCreeps)) {
        // Assignment-map form: drop role slots that point at dead creeps so
        // reassignment can happen.
        var keptSlots = {};
        for (var role in assignedCreeps) {
          if (!assignedCreeps.hasOwnProperty(role)) continue;
          var creepName = assignedCreeps[role];
          if (creepName && Game.creeps[creepName]) {
            keptSlots[role] = creepName;
          }
        }
        if (_isEmptyObject(keptSlots)) delete roomMemory.sources[sourceId];
        else roomMemory.sources[sourceId] = keptSlots;
        continue;
      }

      // Unknown source object shapes are preserved deliberately. Source memory
      // now stores intel/build metadata, and future fields should survive
      // cleanup even if this maintenance pass does not recognize them yet.
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
    if (!Game.getObjectById(containerId)) delete roomMemory.sourceContainers[containerId];
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
  _pruneSourceAssignments(roomMemory);
  _pruneContainerAssignments(roomName, roomMemory);

  if (_compactRoomMem(roomName, roomMemory) && !Game.rooms[roomName]) {
    delete Memory.rooms[roomName];
    _log('🧼 Deleted empty room mem (sweep): ' + roomName);
  }
}

function cleanUpMemory() {
  var now = _now();
  _removeDeadCreepMemory();
  _pruneRemoteContainerStatus(now);

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

function _pruneRemoteContainerStatus(now) {
  // Remote container status is shared by Veinseeker, Trucker, Repair, and
  // BeeSpawnManager. Keep critical/missing/low-HP records longer so emergency
  // repair and vision refresh have enough time to react.
  // Maintenance cleanup is TTL/visibility driven: keep status fresh while
  // visible/live, and prune dead or expired memory snapshots on cadence.
  var interval = CFG.REMOTE_CONTAINER_STATUS_SWEEP_INTERVAL || 500;
  if (interval > 1 && (now % interval) !== 0) return;
  var root = Memory.__BHM;
  if (!root || !_isObject(root.remoteContainerStatus)) return;
  var staleTicks = CFG.REMOTE_CONTAINER_STATUS_STALE_TICKS || 150;
  var defaultTtl = CFG.REMOTE_CONTAINER_STATUS_MEMORY_TTL || 20000;
  var criticalTtl = CFG.REMOTE_CONTAINER_STATUS_CRITICAL_MEMORY_TTL || 50000;
  for (var id in root.remoteContainerStatus) {
    if (!Object.prototype.hasOwnProperty.call(root.remoteContainerStatus, id)) continue;
    var entry = root.remoteContainerStatus[id];
    if (!entry || typeof entry !== 'object') { delete root.remoteContainerStatus[id]; continue; }
    var updated = entry && typeof entry.updated === 'number' ? entry.updated : 0;
    var age = now - updated;
    entry.lastSeenAgo = age;
    entry.stale = age > staleTicks;
    var roomName = entry.remoteRoom || entry.roomName;
    var ident = BeeToolbox.getRemoteContainerIdentity(entry);
    var containerId = ident.containerId || id;
    var room = roomName ? Game.rooms[roomName] : null;
    if (room) {
      if (!BeeToolbox.isLiveContainerId(containerId)) {
        delete root.remoteContainerStatus[id];
        continue;
      }
    }
    var hitsPct = typeof entry.containerHitsPct === 'number' ? entry.containerHitsPct : null;
    var isCritical = entry.status === 'missing' || entry.status === 'critical' || entry.status === 'lowHp' || (hitsPct != null && hitsPct <= 0.40);
    var ttl = isCritical ? criticalTtl : defaultTtl;
    if (age > ttl) delete root.remoteContainerStatus[id];
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
  order[STRUCTURE_SPAWN]     = 2;
  order[STRUCTURE_EXTENSION] = 3;
  order[STRUCTURE_TOWER]     = 4;
  order[STRUCTURE_STORAGE]   = 5;
  order[STRUCTURE_TERMINAL]  = 6;
  order[STRUCTURE_LINK]      = 7;
  order[STRUCTURE_LAB]       = 8;
  order[STRUCTURE_OBSERVER]  = 9;
  order[STRUCTURE_RAMPART]   = 10;
  order[STRUCTURE_WALL]      = 11;
  order[STRUCTURE_ROAD]      = 99; // Roads are always last, but still repaired eventually.
  bucket.priorityOrder = order;
  return order;
}

function getRepairPriority(entryOrStructure) {
  if (!entryOrStructure) return 999;
  var type = entryOrStructure.type || entryOrStructure.structureType;
  if (!type) return 999;
  var table = _ensurePriorityTable(_ensureMaintBucket('global'));
  return table[type] != null ? table[type] : 50;
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

// When the cache goes empty (or the cadence expires) we fall back to a full
// scan.  Sorting by priority and damage keeps the result deterministic.
function _scanRepairTargets(room, bucket, priorityOrder) {
  var list = room.find(FIND_STRUCTURES, {
    filter: function (s) {
      if (s.structureType === STRUCTURE_ROAD) {
        return s.hits < (s.hitsMax * 0.60);
      }
      if (s.structureType === STRUCTURE_RAMPART) {
        return s.hits < Math.min(s.hitsMax, CFG.REPAIR_MAX_RAMPART);
      }
      if (s.structureType === STRUCTURE_WALL) {
        return s.hits < Math.min(s.hitsMax, CFG.REPAIR_MAX_WALL);
      }
      if (s.structureType === STRUCTURE_CONTAINER) {
        return s.hits < (s.hitsMax * 0.80);
      }
      return s.hits < s.hitsMax;
    }
  });

  var targets = [];
  for (var i = 0; i < list.length; i++) {
    var s = list[i];
    targets.push({ id: s.id, hits: s.hits, hitsMax: s.hitsMax, type: s.structureType, priority: getRepairPriority(s) });
  }

  if (targets.length > 1) {
    targets.sort(function (a, b) {
      var pa = getRepairPriority(a);
      var pb = getRepairPriority(b);
      if (pa !== pb) return pa - pb;
      return a.hits - b.hits;
    });
  }

  bucket.cachedRepairTargets = targets;
  bucket.nextRepairScanTick = _now() + CFG.REPAIR_SCAN_INTERVAL;
  return targets;
}

function findStructuresNeedingRepair(room) {
  // Public repair target scanner. main.js writes the returned array into
  // Memory.rooms[room].repairTargets, where towers and Repair creeps consume it.
  if (!room) return [];
  var bucket = _ensureMaintBucket(room.name);
  var priorityOrder = _ensurePriorityTable(bucket);
  var now = _now();

  var nextScanTick = (typeof bucket.nextRepairScanTick === 'number') ? bucket.nextRepairScanTick : 0;
  if (now < nextScanTick) {
    var cached = _trimCachedTargets(bucket);
    if (cached.length) {
      return cached;
    }
  }

  return _scanRepairTargets(room, bucket, priorityOrder);
}

var Maintenance = {
  cleanStaleRooms: cleanStaleRooms,
  cleanUpMemory: cleanUpMemory,
  findStructuresNeedingRepair: findStructuresNeedingRepair,
  getRepairPriority: getRepairPriority
};

module.exports = Maintenance;
