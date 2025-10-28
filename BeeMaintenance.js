var CoreConfig = require('core.config');
var Logger = require('core.logger');
var LOG_LEVEL = Logger.LOG_LEVEL;
var maintLog = Logger.createLogger('Maintenance', LOG_LEVEL.DEBUG);

function hasOwn(obj, key) {
  return !!(obj && Object.prototype.hasOwnProperty.call(obj, key));
}

function isObject(value) {
  return value !== null && typeof value === 'object';
}

function isEmptyObject(obj) {
  if (!isObject(obj)) return true;
  for (var key in obj) {
    if (hasOwn(obj, key)) {
      return false;
    }
  }
  return true;
}

var BeeMaintenance = (function () {
  // -----------------------------
  // Tunables (all ES5-safe)
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
  // Small helpers
  // -----------------------------

  function _now() { return Game.time | 0; }

  function _log(msg) { if (CFG.LOG) maintLog.debug(msg); }

  function _lastSeen(mem) {
    if (!mem) return -Infinity;
    if (typeof mem.lastSeenAt === 'number') return mem.lastSeenAt;
    if (mem.scout && typeof mem.scout.lastVisited === 'number') return mem.scout.lastVisited;
    if (mem.intel && typeof mem.intel.lastVisited === 'number') return mem.intel.lastVisited;
    if (typeof mem.lastVisited === 'number') return mem.lastVisited;
    return -Infinity;
  }

  function _compactRoomMem(roomName, mem) {
    if (!mem) return true;
    var now = _now();

    // Drop old "blocked" hints
    if (hasOwn(mem, 'blocked') && typeof mem.blocked === 'number') {
      if (now - mem.blocked > CFG.BLOCK_MARK_TTL) delete mem.blocked;
    }

    // Empty sub-objects pruning
    // sources: object keyed by id; keep only if any key remains
    if (isObject(mem.sources)) {
      // if stored as array: normalize drop if empty
      var hasSrc = false;
      for (var s in mem.sources) { if (hasOwn(mem.sources, s)) { hasSrc = true; break; } }
      if (!hasSrc) delete mem.sources;
    }

    // sourceContainers: id -> creepName; drop non-existent containers & empty map
    if (isObject(mem.sourceContainers)) {
      for (var cid in mem.sourceContainers) {
        if (!hasOwn(mem.sourceContainers, cid)) continue;
        if (!Game.getObjectById(cid)) delete mem.sourceContainers[cid];
      }
      var anyCont = false;
      for (cid in mem.sourceContainers) { if (hasOwn(mem.sourceContainers, cid)) { anyCont = true; break; } }
      if (!anyCont) delete mem.sourceContainers;
    }

    // intel: drop if it has no meaningful fields
    if (isObject(mem.intel)) {
      var intel = mem.intel;
      // remove empty arrays/zeroish
      if (isObject(intel.portals) && intel.portals.length === 0) delete intel.portals;
      if (isObject(intel.deposits) && intel.deposits.length === 0) delete intel.deposits;
      if (intel.powerBank === null) delete intel.powerBank;

      // detect "empty intel"
      var intelHas = false;
      var keepKeys = ['lastVisited','lastScanAt','sources','owner','reservation','rcl','safeMode','invaderCore','keeperLairs','mineral','enemySpawns','enemyTowers','hostiles','powerBank','portals','deposits'];
      for (var i1 = 0; i1 < keepKeys.length; i1++) {
        var kk = keepKeys[i1];
        if (hasOwn(intel, kk)) { intelHas = true; break; }
      }
      if (!intelHas) delete mem.intel;
    }

    // scout: keep only with lastVisited
    if (isObject(mem.scout)) {
      if (typeof mem.scout.lastVisited !== 'number') delete mem.scout;
    }

    // internal maintenance bucket: drop if fully empty
    if (isObject(mem._maint)) {
      // cachedRepairTargets can go stale; drop if empty
      if (isObject(mem._maint.cachedRepairTargets) && mem._maint.cachedRepairTargets.length === 0) {
        delete mem._maint.cachedRepairTargets;
      }
      var anyM = false;
      for (var mk in mem._maint) { if (hasOwn(mem._maint, mk)) { anyM = true; break; } }
      if (!anyM) delete mem._maint;
    }

    // If only trivial crumbs remain (e.g., lastSeenAt), consider empty after grace
    var keys = [];
    for (var k in mem) { if (hasOwn(mem, k)) keys.push(k); }

    if (keys.length === 0) return true;

    if (keys.length === 1 && keys[0] === 'lastSeenAt') {
      var ls = mem.lastSeenAt | 0;
      if (ls && (now - ls) > CFG.EMPTY_ROOM_GRACE_TICKS) return true;
    }

    return false;
  }

  // -----------------------------
  // Public: prune old/inactive room memory (cheap, interval)
  // -----------------------------

  function cleanStaleRooms() {
    var T = _now();

    // Cheap visibility stamp WITHOUT creating new room entries
    // (This avoids generating empty objects just by looking at rooms.)
    for (var rn in Game.rooms) {
      if (!hasOwn(Game.rooms, rn)) continue;
      if (Memory.rooms && Memory.rooms[rn]) {
        Memory.rooms[rn].lastSeenAt = T;
      }
    }

    if ((T % CFG.ROOM_PRUNE_INTERVAL) !== 0) return;

    if (!Memory.rooms) return;

    Memory.recentlyCleanedRooms = []; // optional report

    // Pass 1: delete rooms clearly stale by "last seen"
    for (var roomName in Memory.rooms) {
      if (!hasOwn(Memory.rooms, roomName)) continue;
      if (Game.rooms[roomName]) continue; // visible now → not stale

      var mem = Memory.rooms[roomName];
      var seenAt = _lastSeen(mem);
      if (seenAt !== -Infinity && (T - seenAt) > CFG.ROOM_STALE_TICKS) {
        delete Memory.rooms[roomName];
        Memory.recentlyCleanedRooms.push(roomName);
        _log('🧼 Cleaned stale room mem: ' + roomName);
      }
    }

    // Pass 2: compact survivors & drop truly-empty rooms
    for (roomName in Memory.rooms) {
      if (!hasOwn(Memory.rooms, roomName)) continue;
      var m = Memory.rooms[roomName];

      if (_compactRoomMem(roomName, m)) {
        // Delete empty room mem only if not currently visible,
        // or if visible but kept empty beyond grace window.
        if (!Game.rooms[roomName]) {
          delete Memory.rooms[roomName];
          Memory.recentlyCleanedRooms.push(roomName);
          _log('🧼 Deleted empty room mem: ' + roomName);
        } else {
          // visible: if it's still empty after grace, delete next interval
          // (Handled by _compactRoomMem via lastSeenAt grace logic.)
        }
      }
    }
  }

  // -----------------------------
  // Public: creep + assignment cleanup (interval-gated)
  // -----------------------------

  function cleanUpMemory() {
    var T = _now();

    // Always: remove memory of dead creeps (cheap)
    if (Memory.creeps) {
      for (var name in Memory.creeps) {
        if (!hasOwn(Memory.creeps, name)) continue;
        if (!Game.creeps[name]) {
          delete Memory.creeps[name];
          _log('🧼 Removed creep mem: ' + name);
        }
      }
    }

    // Heavy parts only every N ticks
    if ((T % CFG.MEMORY_SWEEP_INTERVAL) !== 0) return;

    if (!Memory.rooms) return;

    for (var roomName in Memory.rooms) {
      if (!hasOwn(Memory.rooms, roomName)) continue;
      var roomMemory = Memory.rooms[roomName];

      // Nurse/Worker source claims:
      if (isObject(roomMemory.sources)) {
        for (var sourceId in roomMemory.sources) {
          if (!hasOwn(roomMemory.sources, sourceId)) continue;

          var assignedCreeps = roomMemory.sources[sourceId];

          // Your code comments mentioned an array, but often this is an OBJECT.
          // Support both forms conservatively:
          if (assignedCreeps && assignedCreeps.length >= 0) {
            // treat as array of creep names
            var kept = [];
            for (var i = 0; i < assignedCreeps.length; i++) {
              var nameMaybe = assignedCreeps[i];
              if (Game.creeps[nameMaybe]) kept.push(nameMaybe);
            }
            roomMemory.sources[sourceId] = kept;
            if (kept.length === 0) {
              // optional: delete empty arrays to reduce bloat
              delete roomMemory.sources[sourceId];
            }
          } else if (isObject(assignedCreeps)) {
            // treat as object of arbitrary fields; drop obviously empty
            if (isEmptyObject(assignedCreeps)) {
              delete roomMemory.sources[sourceId];
            }
          }
        }
        // drop sources map if empty
        var anySrc = false;
        for (sourceId in roomMemory.sources) { if (hasOwn(roomMemory.sources, sourceId)) { anySrc = true; break; } }
        if (!anySrc) delete roomMemory.sources;
      }

      // Courier_Bee container assignments: drop if creep gone
      if (isObject(roomMemory.sourceContainers)) {
        for (var containerId in roomMemory.sourceContainers) {
          if (!hasOwn(roomMemory.sourceContainers, containerId)) continue;
          var assigned = roomMemory.sourceContainers[containerId];
          if (assigned && !Game.creeps[assigned]) {
            delete roomMemory.sourceContainers[containerId];
            _log('🧹 Unassigned container ' + containerId + ' in ' + roomName);
          }
        }
        // drop map if empty OR containers vanished
        for (containerId in roomMemory.sourceContainers) {
          if (!hasOwn(roomMemory.sourceContainers, containerId)) continue;
          if (!Game.getObjectById(containerId)) delete roomMemory.sourceContainers[containerId];
        }
        var anyCont = false;
        for (containerId in roomMemory.sourceContainers) { if (hasOwn(roomMemory.sourceContainers, containerId)) { anyCont = true; break; } }
        if (!anyCont) delete roomMemory.sourceContainers;
      }

      // After per-room cleanup, compact and maybe delete if empty
      if (_compactRoomMem(roomName, roomMemory)) {
        if (!Game.rooms[roomName]) {
          delete Memory.rooms[roomName];
          _log('🧼 Deleted empty room mem (sweep): ' + roomName);
        }
      }
    }
  }

  // -----------------------------
  // Public: find (cached) structures needing repair
  // Returns an ARRAY of {id,hits,hitsMax,type}, sorted by priority then damage.
  // Rebuilt only every REPAIR_SCAN_INTERVAL ticks per room.
  // -----------------------------

  function findStructuresNeedingRepair(room) {
    if (!room) return [];
    if (!Memory.rooms) Memory.rooms = {};
    if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};

    var m = Memory.rooms[room.name]._maint;
    if (!m) {
      Memory.rooms[room.name]._maint = {};
      m = Memory.rooms[room.name]._maint;
    }

    if (!m.priorityOrder) {
      m.priorityOrder = {};
      m.priorityOrder[STRUCTURE_CONTAINER] = 1;
      m.priorityOrder[STRUCTURE_RAMPART]   = 3;
      m.priorityOrder[STRUCTURE_WALL]      = 4;
      m.priorityOrder[STRUCTURE_STORAGE]   = 5;
      m.priorityOrder[STRUCTURE_SPAWN]     = 6;
      m.priorityOrder[STRUCTURE_EXTENSION] = 7;
      m.priorityOrder[STRUCTURE_TOWER]     = 8;
      m.priorityOrder[STRUCTURE_LINK]      = 9;
      m.priorityOrder[STRUCTURE_TERMINAL]  = 10;
      m.priorityOrder[STRUCTURE_LAB]       = 11;
      m.priorityOrder[STRUCTURE_OBSERVER]  = 12;
      m.priorityOrder[STRUCTURE_ROAD]      = 13; // low prio; throttled below
    }
    var priorityOrder = m.priorityOrder;

    var T = _now();
    var nextScan = m.nextRepairScanTick | 0;

    // If not time to rescan, return cached (and drop fully repaired)
    if (T < nextScan && m.cachedRepairTargets && m.cachedRepairTargets.length) {
      var kept = [];
      var maxR = CFG.REPAIR_MAX_RAMPART;
      var maxW = CFG.REPAIR_MAX_WALL;
      for (var i0 = 0; i0 < m.cachedRepairTargets.length; i0++) {
        var t = m.cachedRepairTargets[i0];
        var obj = Game.getObjectById(t.id);
        if (!obj) continue;
        if (obj.structureType === STRUCTURE_RAMPART) {
          if (obj.hits < Math.min(obj.hitsMax, maxR)) kept.push(t);
        } else if (obj.structureType === STRUCTURE_WALL) {
          if (obj.hits < Math.min(obj.hitsMax, maxW)) kept.push(t);
        } else {
          if (obj.hits < obj.hitsMax) kept.push(t);
        }
      }
      m.cachedRepairTargets = kept;
      return kept;
    }

    // Full rescan (throttled)
    var list = room.find(FIND_STRUCTURES, {
      filter: function (s) {
        // Roads: repair only when under 60% to avoid constant churn
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

    m.cachedRepairTargets = targets;
    m.nextRepairScanTick  = T + CFG.REPAIR_SCAN_INTERVAL;

    return targets;
  }

  // Expose public API
  return {
    cleanStaleRooms: cleanStaleRooms,
    cleanUpMemory: cleanUpMemory,
    findStructuresNeedingRepair: findStructuresNeedingRepair
  };
})();

module.exports = BeeMaintenance;
