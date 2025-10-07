// BeeMaintenance.cpu.es5.js
// ES5-safe, CPU-lean maintenance utilities.
// - Throttled memory cleanup (rooms/creeps/assignments)
// - Deep compaction: remove empty sub-objects & delete truly-empty rooms
// - Robust stale-room detection + grace window
// - Cached, interval-based repair target list per room
// - No ES6 syntax

'use strict';

var CoreConfig = require('core.config');
var Logger = require('core.logger');
var BeeToolbox = require('BeeToolbox');
var LOG_LEVEL = Logger.LOG_LEVEL;
var maintLog = Logger.createLogger('Maintenance', LOG_LEVEL.DEBUG);

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

  function priorityForType(priorityMap, type) {
    if (!priorityMap) return 99;
    if (priorityMap[type] != null) return priorityMap[type];
    if (priorityMap.default != null) return priorityMap.default;
    return 99;
  }

  // Derive repair thresholds and priorities from the room's current capabilities and RCL tier.
  function computeRepairSettings(room) {
    var caps = BeeToolbox.getRoomCapabilities(room);
    var tier = caps.tier || 'early';

    var thresholds = {
      road: 1500,
      container: 120000,
      rampart: 5000,
      wall: 10000
    };

    if (tier === 'developing') {
      thresholds.road = 2500;
      thresholds.container = 180000;
      thresholds.rampart = 20000;
      thresholds.wall = 60000;
    } else if (tier === 'expansion') {
      thresholds.road = 3500;
      thresholds.container = 220000;
      thresholds.rampart = 60000;
      thresholds.wall = 200000;
    } else if (tier === 'late') {
      thresholds.road = 4500;
      thresholds.container = 240000;
      thresholds.rampart = 200000;
      thresholds.wall = 600000;
    }

    thresholds.rampart = Math.min(thresholds.rampart, CFG.REPAIR_MAX_RAMPART);
    thresholds.wall = Math.min(thresholds.wall, CFG.REPAIR_MAX_WALL);

    if (!caps.hasStorage) {
      thresholds.container = Math.max(thresholds.container, 200000);
    }

    var roadStatus = BeeToolbox.getStructureStatus(room, STRUCTURE_ROAD);
    if ((roadStatus.remaining | 0) > 0) {
      thresholds.road = Math.max(thresholds.road, 2500);
    }

    var priorityOrder = {
      default: 8
    };

    priorityOrder[STRUCTURE_SPAWN] = 1;
    priorityOrder[STRUCTURE_TOWER] = 1;
    priorityOrder[STRUCTURE_EXTENSION] = 2;
    priorityOrder[STRUCTURE_STORAGE] = 2;
    priorityOrder[STRUCTURE_LINK] = 3;
    priorityOrder[STRUCTURE_TERMINAL] = 3;
    priorityOrder[STRUCTURE_CONTAINER] = caps.hasStorage ? 3 : 1;
    priorityOrder[STRUCTURE_ROAD] = (tier === 'early') ? 5 : 6;
    priorityOrder[STRUCTURE_RAMPART] = (tier === 'late') ? 4 : 6;
    priorityOrder[STRUCTURE_WALL] = (tier === 'late') ? 7 : 8;
    priorityOrder[STRUCTURE_LAB] = 4;

    if (caps.storageEnergy < 20000 && caps.hasStorage) {
      priorityOrder[STRUCTURE_STORAGE] = 1;
    }

    if ((roadStatus.remaining | 0) > 0) {
      priorityOrder[STRUCTURE_ROAD] = 4;
    }

    var containerStatus = BeeToolbox.getStructureStatus(room, STRUCTURE_CONTAINER);
    if ((containerStatus.remaining | 0) > 0) {
      priorityOrder[STRUCTURE_CONTAINER] = 2;
    }

    return {
      thresholds: thresholds,
      priority: priorityOrder,
      tier: tier
    };
  }

  function shouldRepairStructure(structure, thresholds) {
    if (!structure) return false;
    var hits = structure.hits | 0;
    var hitsMax = structure.hitsMax | 0;
    var type = structure.structureType;

    if (type === STRUCTURE_ROAD) {
      var roadCap = thresholds.road || (hitsMax * 0.60);
      roadCap = Math.min(hitsMax, roadCap);
      return hits < roadCap;
    }
    if (type === STRUCTURE_RAMPART) {
      var rampCap = thresholds.rampart || CFG.REPAIR_MAX_RAMPART;
      rampCap = Math.min(hitsMax || rampCap, rampCap);
      return hits < rampCap;
    }
    if (type === STRUCTURE_WALL) {
      var wallCap = thresholds.wall || CFG.REPAIR_MAX_WALL;
      wallCap = Math.min(hitsMax || wallCap, wallCap);
      return hits < wallCap;
    }
    if (type === STRUCTURE_CONTAINER) {
      var contCap = thresholds.container || hitsMax;
      contCap = Math.min(hitsMax || contCap, contCap);
      return hits < contCap;
    }
    return hits < hitsMax;
  }

  // -----------------------------
  // Small helpers
  // -----------------------------

  /**
   * Read the current game time as an integer.
   * @returns {number} Current Game.time value.
   * @sideeffects None.
   * @cpu O(1).
   * @memory None.
   */
  function _now() { return Game.time | 0; }

  /**
   * Emit a debug log entry when debug logging is enabled.
   * @param {string} msg Message to log.
   * @returns {void}
   * @sideeffects Writes to console when enabled.
   * @cpu O(1).
   * @memory None.
   */
  function _log(msg) { if (CFG.LOG) maintLog.debug(msg); }

  /**
   * Safely read the most recent visibility timestamp recorded in room memory.
   * @param {object} mem Room memory reference.
   * @returns {number} Last seen tick or -Infinity if unknown.
   * @sideeffects None.
   * @cpu O(1).
   * @memory None.
   */
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
  /**
   * Prune stale metadata within a room memory blob.
   * @param {string} roomName Room identifier for logging context.
   * @param {object} mem Room memory object to compact.
   * @returns {boolean} True when the room memory is effectively empty afterwards.
   * @sideeffects Deletes stale keys from the provided memory object.
   * @cpu Moderate depending on nested keys.
   * @memory No new allocations beyond iteration temporaries.
   */
  function _compactRoomMem(roomName, mem) {
    if (!mem) return true;
    var now = _now();

    // Drop old "blocked" hints
    if (BeeToolbox.hasOwn(mem, 'blocked') && typeof mem.blocked === 'number') {
      if (now - mem.blocked > CFG.BLOCK_MARK_TTL) delete mem.blocked;
    }

    // Empty sub-objects pruning
    // sources: object keyed by id; keep only if any key remains
    if (BeeToolbox.isObject(mem.sources)) {
      // if stored as array: normalize drop if empty
      var hasSrc = false;
      for (var s in mem.sources) { if (BeeToolbox.hasOwn(mem.sources, s)) { hasSrc = true; break; } }
      if (!hasSrc) delete mem.sources;
    }

    // sourceContainers: id -> creepName; drop non-existent containers & empty map
    if (BeeToolbox.isObject(mem.sourceContainers)) {
      for (var cid in mem.sourceContainers) {
        if (!BeeToolbox.hasOwn(mem.sourceContainers, cid)) continue;
        if (!Game.getObjectById(cid)) delete mem.sourceContainers[cid];
      }
      var anyCont = false;
      for (cid in mem.sourceContainers) { if (BeeToolbox.hasOwn(mem.sourceContainers, cid)) { anyCont = true; break; } }
      if (!anyCont) delete mem.sourceContainers;
    }

    // intel: drop if it has no meaningful fields
    if (BeeToolbox.isObject(mem.intel)) {
      var intel = mem.intel;
      // remove empty arrays/zeroish
      if (BeeToolbox.isObject(intel.portals) && intel.portals.length === 0) delete intel.portals;
      if (BeeToolbox.isObject(intel.deposits) && intel.deposits.length === 0) delete intel.deposits;
      if (intel.powerBank === null) delete intel.powerBank;

      // detect "empty intel"
      var intelHas = false;
      var keepKeys = ['lastVisited','lastScanAt','sources','owner','reservation','rcl','safeMode','invaderCore','keeperLairs','mineral','enemySpawns','enemyTowers','hostiles','powerBank','portals','deposits'];
      for (var i1 = 0; i1 < keepKeys.length; i1++) {
        var kk = keepKeys[i1];
        if (BeeToolbox.hasOwn(intel, kk)) { intelHas = true; break; }
      }
      if (!intelHas) delete mem.intel;
    }

    // scout: keep only with lastVisited
    if (BeeToolbox.isObject(mem.scout)) {
      if (typeof mem.scout.lastVisited !== 'number') delete mem.scout;
    }

    // internal maintenance bucket: drop if fully empty
    if (BeeToolbox.isObject(mem._maint)) {
      // cachedRepairTargets can go stale; drop if empty
      if (BeeToolbox.isObject(mem._maint.cachedRepairTargets) && mem._maint.cachedRepairTargets.length === 0) {
        delete mem._maint.cachedRepairTargets;
      }
      var anyM = false;
      for (var mk in mem._maint) { if (BeeToolbox.hasOwn(mem._maint, mk)) { anyM = true; break; } }
      if (!anyM) delete mem._maint;
    }

    // If only trivial crumbs remain (e.g., lastSeenAt), consider empty after grace
    var keys = [];
    for (var k in mem) { if (BeeToolbox.hasOwn(mem, k)) keys.push(k); }

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
  /**
   * Periodically remove stale or empty room memory entries.
   * @returns {void}
   * @sideeffects Deletes keys from Memory.rooms and updates Memory.recentlyCleanedRooms.
   * @cpu Moderate when sweep triggers; minimal otherwise.
   * @memory No persistent allocations beyond logs.
   */
  function cleanStaleRooms() {
    var T = _now();

    // Cheap visibility stamp WITHOUT creating new room entries
    // (This avoids generating empty objects just by looking at rooms.)
    for (var rn in Game.rooms) {
      if (!BeeToolbox.hasOwn(Game.rooms, rn)) continue;
      if (Memory.rooms && Memory.rooms[rn]) {
        Memory.rooms[rn].lastSeenAt = T;
      }
    }

    if ((T % CFG.ROOM_PRUNE_INTERVAL) !== 0) return;

    if (!Memory.rooms) return;

    Memory.recentlyCleanedRooms = []; // optional report

    // Pass 1: delete rooms clearly stale by "last seen"
    for (var roomName in Memory.rooms) {
      if (!BeeToolbox.hasOwn(Memory.rooms, roomName)) continue;
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
      if (!BeeToolbox.hasOwn(Memory.rooms, roomName)) continue;
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
  /**
   * Reconcile creep and assignment memory with live game state.
   * @returns {void}
   * @sideeffects Deletes Memory.creeps entries, cleans Memory.rooms substructures, and prunes assignments.
   * @cpu Moderate on sweep ticks.
   * @memory No additional persistent data.
   */
  function cleanUpMemory() {
    var T = _now();

    // Always: remove memory of dead creeps (cheap)
    if (Memory.creeps) {
      for (var name in Memory.creeps) {
        if (!BeeToolbox.hasOwn(Memory.creeps, name)) continue;
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
      if (!BeeToolbox.hasOwn(Memory.rooms, roomName)) continue;
      var roomMemory = Memory.rooms[roomName];

      // Nurse/Worker source claims:
      if (BeeToolbox.isObject(roomMemory.sources)) {
        for (var sourceId in roomMemory.sources) {
          if (!BeeToolbox.hasOwn(roomMemory.sources, sourceId)) continue;

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
          } else if (BeeToolbox.isObject(assignedCreeps)) {
            // treat as object of arbitrary fields; drop obviously empty
            if (BeeToolbox.isEmptyObject(assignedCreeps)) {
              delete roomMemory.sources[sourceId];
            }
          }
        }
        // drop sources map if empty
        var anySrc = false;
        for (sourceId in roomMemory.sources) { if (BeeToolbox.hasOwn(roomMemory.sources, sourceId)) { anySrc = true; break; } }
        if (!anySrc) delete roomMemory.sources;
      }

      // Courier_Bee container assignments: drop if creep gone
      if (BeeToolbox.isObject(roomMemory.sourceContainers)) {
        for (var containerId in roomMemory.sourceContainers) {
          if (!BeeToolbox.hasOwn(roomMemory.sourceContainers, containerId)) continue;
          var assigned = roomMemory.sourceContainers[containerId];
          if (assigned && !Game.creeps[assigned]) {
            delete roomMemory.sourceContainers[containerId];
            _log('🧹 Unassigned container ' + containerId + ' in ' + roomName);
          }
        }
        // drop map if empty OR containers vanished
        for (containerId in roomMemory.sourceContainers) {
          if (!BeeToolbox.hasOwn(roomMemory.sourceContainers, containerId)) continue;
          if (!Game.getObjectById(containerId)) delete roomMemory.sourceContainers[containerId];
        }
        var anyCont = false;
        for (containerId in roomMemory.sourceContainers) { if (BeeToolbox.hasOwn(roomMemory.sourceContainers, containerId)) { anyCont = true; break; } }
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
  /**
   * List structures in need of repair, cached per room for performance.
   * @param {Room} room Room to analyze.
   * @returns {Array} Array of repair target descriptors sorted by priority.
   * @sideeffects Writes cached data into Memory.rooms[room.name]._maint.
   * @cpu Moderate when rescanning, low when using cache.
   * @memory Stores target arrays in persistent memory for reuse.
   */
  function findStructuresNeedingRepair(room) {
    if (!room) return [];
    if (!Memory.rooms) Memory.rooms = {};
    if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};

    var m = Memory.rooms[room.name]._maint;
    if (!m) {
      Memory.rooms[room.name]._maint = {};
      m = Memory.rooms[room.name]._maint;
    }

    var settings = computeRepairSettings(room);
    var priorityOrder = settings.priority;
    var thresholds = settings.thresholds;
    m.priorityOrder = priorityOrder;

    var T = _now();
    var nextScan = m.nextRepairScanTick | 0;

    // If not time to rescan, return cached (and drop fully repaired)
    if (T < nextScan && m.cachedRepairTargets && m.cachedRepairTargets.length) {
      var kept = [];
      for (var i0 = 0; i0 < m.cachedRepairTargets.length; i0++) {
        var t = m.cachedRepairTargets[i0];
        var obj = Game.getObjectById(t.id);
        if (!obj) continue;
        if (!shouldRepairStructure(obj, thresholds)) continue;
        kept.push({
          id: obj.id,
          hits: obj.hits,
          hitsMax: obj.hitsMax,
          type: obj.structureType,
          priority: priorityForType(priorityOrder, obj.structureType),
          ratio: (obj.hitsMax > 0) ? (obj.hits / obj.hitsMax) : 1
        });
      }
      kept.sort(function (a, b) {
        if (a.priority !== b.priority) return a.priority - b.priority;
        if (a.ratio !== b.ratio) return a.ratio - b.ratio;
        return a.hits - b.hits;
      });
      m.cachedRepairTargets = kept;
      return kept;
    }

    // Full rescan (throttled)
    var list = room.find(FIND_STRUCTURES, {
      filter: function (s) {
        return shouldRepairStructure(s, thresholds);
      }
    });

    var targets = [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      targets.push({
        id: s.id,
        hits: s.hits,
        hitsMax: s.hitsMax,
        type: s.structureType,
        priority: priorityForType(priorityOrder, s.structureType),
        ratio: (s.hitsMax > 0) ? (s.hits / s.hitsMax) : 1
      });
    }

    targets.sort(function (a, b) {
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (a.ratio !== b.ratio) return a.ratio - b.ratio;
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
