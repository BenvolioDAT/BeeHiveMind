// BeeMaintenance.cpu.es5.js
// ES5-safe, CPU-lean maintenance utilities.
// - Throttled memory cleanup (rooms/creeps/assignments)
// - Robust stale-room detection using multiple "last seen" fields
// - Cached, interval-based repair target list per room (sorted & filtered)
// - No ES6 (no const/let/arrows/includes/template strings)

'use strict';

var BeeMaintenance = (function () {
  // -----------------------------
  // Tunables (all ES5-safe)
  // -----------------------------
  var CFG = {
    ROOM_STALE_TICKS:      600,  // how long without vision before pruning a room
    ROOM_PRUNE_INTERVAL:    200,  // run stale-room cleanup every N ticks
    MEMORY_SWEEP_INTERVAL:   10,  // run heavy creep/assignment sweeps every N ticks
    REPAIR_SCAN_INTERVAL:    5,  // rebuild repair list every N ticks per room
    REPAIR_MAX_RAMPART:   30000,  // rampart cap
    REPAIR_MAX_WALL:      30000,  // wall cap
    LOG: false                // set true if you want cleanup logs
  };

  // -----------------------------
  // Small helpers
  // -----------------------------
  function _now() { return Game.time | 0; }

  function _log(msg) { if (CFG.LOG) console.log(msg); }

  // Safely read a "last seen" timestamp from room memory written by various systems
  function _lastSeen(mem) {
    if (!mem) return -Infinity;
    // prefer a unified custom stamp if present
    if (typeof mem.lastSeenAt === 'number') return mem.lastSeenAt;
    // fallbacks to your other modules' fields
    if (mem.scout && typeof mem.scout.lastVisited === 'number') return mem.scout.lastVisited;
    if (mem.intel && typeof mem.intel.lastVisited === 'number') return mem.intel.lastVisited;
    if (typeof mem.lastVisited === 'number') return mem.lastVisited;
    return -Infinity;
  }

  // Keep per-room maintenance sub-bucket
  function _roomMaint(roomName) {
    if (!Memory.rooms) Memory.rooms = {};
    if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
    var r = Memory.rooms[roomName];
    if (!r._maint) r._maint = {};
    return r._maint;
  }

  // -----------------------------
  // Public: prune old/inactive room memory (cheap, interval)
  // -----------------------------
  function cleanStaleRooms() {
    var T = _now();
    if ((T % CFG.ROOM_PRUNE_INTERVAL) !== 0) {
      // still stamp "lastSeenAt" for visible rooms cheaply
      for (var rn in Game.rooms) {
        if (!Game.rooms.hasOwnProperty(rn)) continue;
        if (!Memory.rooms) Memory.rooms = {};
        if (!Memory.rooms[rn]) Memory.rooms[rn] = {};
        Memory.rooms[rn].lastSeenAt = T;
      }
      return;
    }

    // stamp for visible rooms (helps stale detection)
    for (var rn2 in Game.rooms) {
      if (!Game.rooms.hasOwnProperty(rn2)) continue;
      if (!Memory.rooms) Memory.rooms = {};
      if (!Memory.rooms[rn2]) Memory.rooms[rn2] = {};
      Memory.rooms[rn2].lastSeenAt = T;
    }

    Memory.recentlyCleanedRooms = []; // optional report

    if (!Memory.rooms) return;

    for (var roomName in Memory.rooms) {
      if (!Memory.rooms.hasOwnProperty(roomName)) continue;
      // if we can currently see it, it's not stale
      if (Game.rooms[roomName]) continue;

      var mem = Memory.rooms[roomName];
      var seenAt = _lastSeen(mem);
      if (seenAt !== -Infinity && (T - seenAt) > CFG.ROOM_STALE_TICKS) {
        delete Memory.rooms[roomName];
        Memory.recentlyCleanedRooms.push(roomName);
        _log('🧼 Cleaned room mem: ' + roomName);
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
        if (!Memory.creeps.hasOwnProperty(name)) continue;
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
      if (!Memory.rooms.hasOwnProperty(roomName)) continue;
      var roomMemory = Memory.rooms[roomName];

      // Nurse_Bee source claims: keep only Worker_Bee / Worker_Bees that still exist
      if (roomMemory.sources) {
        for (var sourceId in roomMemory.sources) {
          if (!roomMemory.sources.hasOwnProperty(sourceId)) continue;
          var assignedCreeps = roomMemory.sources[sourceId];
          if (!assignedCreeps || !assignedCreeps.length) continue;

          var pruned = [];
          for (var i = 0; i < assignedCreeps.length; i++) {
            var cid = assignedCreeps[i];
            var cr  = Game.getObjectById(cid); // returns null if not visible or dead; but IDs of creeps are not stable—if you stored names, prefer Game.creeps[name]
            if (!cr) continue;
            var role = (cr.memory && cr.memory.role) || '';
            if (role === 'Worker_Bee' || role === 'Worker_Bees') pruned.push(cid);
          }
          roomMemory.sources[sourceId] = pruned;
        }
      }

      // Courier_Bee container assignments: drop if creep gone
      if (roomMemory.sourceContainers) {
        for (var containerId in roomMemory.sourceContainers) {
          if (!roomMemory.sourceContainers.hasOwnProperty(containerId)) continue;
          var assigned = roomMemory.sourceContainers[containerId];
          if (assigned && !Game.creeps[assigned]) {
            delete roomMemory.sourceContainers[containerId];
            _log('🧹 Unassigned container ' + containerId + ' in ' + roomName);
          }
        }
      }

      // Remove entries for containers that no longer exist
      var containers = roomMemory.sourceContainers;
      if (containers) {
        for (var cid in containers) {
          if (!containers.hasOwnProperty(cid)) continue;
          if (!Game.getObjectById(cid)) {
            delete containers[cid];
            _log('🧼 Removed non-existent container ' + cid + ' from ' + roomName);
          }
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

    var mem = Memory.rooms[room.name];
    var m   = _roomMaint(room.name);

    // build priority order (ES5-safe: assign keys)
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
      m.priorityOrder[STRUCTURE_ROAD]      = 13; // even if you ignore roads, keeping the key is fine
    }
    var priorityOrder = m.priorityOrder;

    var T = _now();
    var nextScan = m.nextRepairScanTick | 0;

    // If not time to rescan, return cached (and soft-filter obvious fully repaired ones)
    if (T < nextScan && m.cachedRepairTargets && m.cachedRepairTargets.length) {
      // cheap refresh: drop fully repaired
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
        // Skip roads altogether (fast bail)
        if (s.structureType === STRUCTURE_ROAD) {//return false;
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

    // Build new targets (simple loop, no find()/includes()/arrows)
    var targets = [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      targets.push({
        id: s.id,
        hits: s.hits,
        hitsMax: s.hitsMax,
        type: s.structureType
      });
    }

    // Sort by priority then damage (ascending)
    targets.sort(function (a, b) {
      var pa = priorityOrder[a.type] != null ? priorityOrder[a.type] : 99;
      var pb = priorityOrder[b.type] != null ? priorityOrder[b.type] : 99;
      if (pa !== pb) return pa - pb;
      return a.hits - b.hits;
    });

    // Cache + schedule next scan
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
