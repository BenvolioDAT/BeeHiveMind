
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
  LOG: Logger.shouldLog(LOG_LEVEL.DEBUG)
};

// -----------------------------
// Shared utilities
// -----------------------------

function _now() { return Game.time | 0; }
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

function _dropEmptyIntel(mem) {
  if (!_isObject(mem.intel)) return;
  var intel = mem.intel;
  if (_isObject(intel.portals) && intel.portals.length === 0) delete intel.portals;
  if (_isObject(intel.deposits) && intel.deposits.length === 0) delete intel.deposits;
  if (intel.powerBank === null) delete intel.powerBank;

  var keepKeys = ['lastVisited','lastScanAt','sources','owner','reservation','rcl','safeMode','invaderCore','keeperLairs','mineral','enemySpawns','enemyTowers','hostiles','powerBank','portals','deposits'];
  for (var i1 = 0; i1 < keepKeys.length; i1++) {
    if (_hasOwn(intel, keepKeys[i1])) {
      return; // found something meaningful to keep
    }
  }
  delete mem.intel;
}

function _dropEmptyMaintBucket(mem) {
  if (!_isObject(mem._maint)) return;
  if (_isObject(mem._maint.cachedRepairTargets) && mem._maint.cachedRepairTargets.length === 0) {
    delete mem._maint.cachedRepairTargets;
  }
  for (var mk in mem._maint) {
    if (_hasOwn(mem._maint, mk)) {
      return;
    }
  }
  delete mem._maint;
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
    for (var s in mem.sources) { if (_hasOwn(mem.sources, s)) { hasSrc = true; break; } }
    if (!hasSrc) delete mem.sources;
  }

  if (_isObject(mem.sourceContainers)) {
    for (var cid in mem.sourceContainers) {
      if (!_hasOwn(mem.sourceContainers, cid)) continue;
      if (!Game.getObjectById(cid)) delete mem.sourceContainers[cid];
    }
    var anyCont = false;
    for (cid in mem.sourceContainers) { if (_hasOwn(mem.sourceContainers, cid)) { anyCont = true; break; } }
    if (!anyCont) delete mem.sourceContainers;
  }

  _dropEmptyIntel(mem);

  if (_isObject(mem.scout) && typeof mem.scout.lastVisited !== 'number') {
    delete mem.scout;
  }

  _dropEmptyMaintBucket(mem);

  var keys = [];
  for (var k in mem) { if (_hasOwn(mem, k)) keys.push(k); }

  if (keys.length === 0) return true;

  if (keys.length === 1 && keys[0] === 'lastSeenAt') {
    var ls = mem.lastSeenAt | 0;
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

function _removeDeadCreepMemory() {
  if (!Memory.creeps) return;
  for (var name in Memory.creeps) {
    if (!Memory.creeps.hasOwnProperty(name)) continue;
    if (!Game.creeps[name]) {
      delete Memory.creeps[name];
      _log('🧼 Removed creep mem: ' + name);
    }
  }
}

// Source assignment bookkeeping toggles between arrays (ordered creep lists)
// and objects (per-role slots).  Walk both forms carefully so we do not throw
// away valid claims just because a different role wrote the data.
function _pruneSourceAssignments(roomMemory) {
  if (!_isObject(roomMemory.sources)) return;
  for (var sourceId in roomMemory.sources) {
    if (!roomMemory.sources.hasOwnProperty(sourceId)) continue;
    var assignedCreeps = roomMemory.sources[sourceId];
    if (assignedCreeps && assignedCreeps.length >= 0) {
      var kept = [];
      for (var i = 0; i < assignedCreeps.length; i++) {
        if (Game.creeps[assignedCreeps[i]]) kept.push(assignedCreeps[i]);
      }
      if (kept.length) {
        roomMemory.sources[sourceId] = kept;
      } else {
        delete roomMemory.sources[sourceId];
      }
    } else if (_isObject(assignedCreeps) && _isEmptyObject(assignedCreeps)) {
      delete roomMemory.sources[sourceId];
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
      return s.hits < s.hitsMax;
    }
  });

  var targets = [];
  for (var i = 0; i < list.length; i++) {
    var s = list[i];
    targets.push({ id: s.id, hits: s.hits, hitsMax: s.hitsMax, type: s.structureType });
  }

  targets.sort(function (a, b) {
    var pa = priorityOrder[a.type] != null ? priorityOrder[a.type] : 99;
    var pb = priorityOrder[b.type] != null ? priorityOrder[b.type] : 99;
    if (pa !== pb) return pa - pb;
    return a.hits - b.hits;
  });

  bucket.cachedRepairTargets = targets;
  bucket.nextRepairScanTick = _now() + CFG.REPAIR_SCAN_INTERVAL;
  return targets;
}

function findStructuresNeedingRepair(room) {
  if (!room) return [];
  var bucket = _ensureMaintBucket(room.name);
  var priorityOrder = _ensurePriorityTable(bucket);
  var now = _now();

  if (now < (bucket.nextRepairScanTick | 0)) {
    var cached = _trimCachedTargets(bucket);
    if (cached.length) {
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