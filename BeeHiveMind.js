"use strict";

var CoreLogger = require('core.logger');
var spawnLogic = require('spawn.logic');
var roleWorkerBee = require('role.Worker_Bee');
var RoomPlanner = require('Planner.Room');
var RoadPlanner = require('Planner.Road');
var TradeEnergy = require('Trade.Energy');
var TaskLuna = require('Task.Luna');
var BeeToolbox = require('BeeToolbox');

var LOG_LEVEL = CoreLogger.LOG_LEVEL;
var hiveLog = CoreLogger.createLogger('HiveMind', LOG_LEVEL.BASIC);

var ROLE_DISPATCH = Object.freeze({
  Worker_Bee: roleWorkerBee.run
});

var ROLE_DEFAULT_TASK = Object.freeze({
  Queen: 'queen',
  Scout: 'scout',
  repair: 'repair'
});

var DYING_SOON_TTL = 60;
var DEFAULT_LUNA_PER_SOURCE = (TaskLuna && typeof TaskLuna.MAX_LUNA_PER_SOURCE === 'number')
  ? TaskLuna.MAX_LUNA_PER_SOURCE
  : 1;

var GLOBAL_CACHE = global.__BHM_CACHE || (global.__BHM_CACHE = { tick: -1 });

/**
 * Shallow clone a task count dictionary into a fresh object.
 * @param {object} source Original count mapping.
 * @returns {object} Clone with the same numeric values.
 * @sideeffects None.
 * @cpu O(n) over keys.
 * @memory Allocates a new object storing primitive values.
 */
function cloneCounts(source) {
  var result = Object.create(null);
  if (!source) return result;
  for (var key in source) {
    if (!BeeToolbox.hasOwn(source, key)) continue;
    result[key] = source[key];
  }
  return result;
}

/**
 * Build and cache frequently used data for the current tick.
 * @returns {object} The shared cache object for this tick.
 * @sideeffects Populates global.__BHM_CACHE with per-tick state.
 * @cpu Moderate on first call per tick due to object scans.
 * @memory Keeps lightweight arrays and maps for reuse during the tick.
 */
function prepareTickCaches() {
  var tick = Game.time | 0;
  var cache = GLOBAL_CACHE;
  if (cache.tick === tick) {
    return cache;
  }

  cache.tick = tick;

  var ownedRooms = [];
  var roomsMap = Object.create(null);
  for (var roomName in Game.rooms) {
    if (!BeeToolbox.hasOwn(Game.rooms, roomName)) continue;
    var room = Game.rooms[roomName];
    if (!room || !room.controller || !room.controller.my) continue;
    ownedRooms.push(room);
    roomsMap[room.name] = room;
  }
  cache.roomsOwned = ownedRooms;
  cache.roomsMap = roomsMap;

  var spawns = [];
  for (var spawnName in Game.spawns) {
    if (!BeeToolbox.hasOwn(Game.spawns, spawnName)) continue;
    var spawnObj = Game.spawns[spawnName];
    if (spawnObj) spawns.push(spawnObj);
  }
  cache.spawns = spawns;

  var creeps = [];
  var roleCounts = Object.create(null);
  var lunaCountsByHome = Object.create(null);

  for (var creepName in Game.creeps) {
    if (!BeeToolbox.hasOwn(Game.creeps, creepName)) continue;
    var creep = Game.creeps[creepName];
    if (!creep) continue;
    creeps.push(creep);

    var ttl = creep.ticksToLive;
    if (typeof ttl === 'number' && ttl <= DYING_SOON_TTL) {
      continue;
    }

    if (!creep.memory) creep.memory = {};
    var creepMemory = creep.memory;
    var task = creepMemory.task;
    if (task === 'remoteharvest') {
      task = 'luna';
      creepMemory.task = 'luna';
    }

    if (!task) continue;

    roleCounts[task] = (roleCounts[task] || 0) + 1;

    if (task === 'luna') {
      var homeName = creepMemory.home || creepMemory._home || (creep.room ? creep.room.name : null);
      if (homeName) {
        lunaCountsByHome[homeName] = (lunaCountsByHome[homeName] || 0) + 1;
      }
    }
  }

  cache.creeps = creeps;
  cache.roleCounts = roleCounts;
  cache.lunaCountsByHome = lunaCountsByHome;

  var roomSiteCounts = Object.create(null);
  var totalSites = 0;
  for (var siteId in Game.constructionSites) {
    if (!BeeToolbox.hasOwn(Game.constructionSites, siteId)) continue;
    var site = Game.constructionSites[siteId];
    if (!site || !site.my) continue;
    totalSites += 1;
    var siteRoomName = site.pos && site.pos.roomName;
    if (siteRoomName) {
      roomSiteCounts[siteRoomName] = (roomSiteCounts[siteRoomName] || 0) + 1;
    }
  }
  cache.roomSiteCounts = roomSiteCounts;
  cache.totalSites = totalSites;

  var remotesByHome = Object.create(null);
  if (RoadPlanner && typeof RoadPlanner.getActiveRemoteRooms === 'function') {
    for (var idx = 0; idx < ownedRooms.length; idx++) {
      var ownedRoom = ownedRooms[idx];
      remotesByHome[ownedRoom.name] = RoadPlanner.getActiveRemoteRooms(ownedRoom) || [];
    }
  }
  cache.remotesByHome = remotesByHome;

  return cache;
}

/**
 * Resolve a default task string for a creep role.
 * @param {string} role Role identifier stored on creep memory.
 * @returns {string|undefined} Default task name when one exists.
 * @sideeffects None.
 * @cpu O(1).
 * @memory None.
 */
function defaultTaskForRole(role) {
  if (!role) return undefined;
  return ROLE_DEFAULT_TASK[role];
}

/**
 * Determine whether a room needs an additional builder.
 * @param {Room} room Owned room under evaluation.
 * @param {object} cache Per-tick cache data.
 * @returns {number} Desired builder count (0 or 1).
 * @sideeffects None.
 * @cpu O(remotes) to inspect cached lists.
 * @memory Temporary counters only.
 */
function needBuilder(room, cache) {
  if (!room) return 0;
  var localSites = cache.roomSiteCounts[room.name] || 0;
  var remotes = cache.remotesByHome[room.name] || [];
  var remoteSites = 0;
  for (var i = 0; i < remotes.length; i++) {
    var remoteRoomName = remotes[i];
    remoteSites += cache.roomSiteCounts[remoteRoomName] || 0;
  }
  return (localSites + remoteSites) > 0 ? 1 : 0;
}

/**
 * Count known sources for a remote room from memory intel.
 * @param {object} mem Memory blob for the remote room.
 * @returns {number} Number of sources recorded.
 * @sideeffects None.
 * @cpu O(keys) when enumerating stored sources.
 * @memory None.
 */
function countSourcesInMemory(mem) {
  if (!mem) return 0;
  if (mem.sources && typeof mem.sources === 'object') {
    var count = 0;
    for (var key in mem.sources) {
      if (BeeToolbox.hasOwn(mem.sources, key)) count += 1;
    }
    return count;
  }
  if (mem.intel && typeof mem.intel.sources === 'number') {
    return mem.intel.sources | 0;
  }
  return 0;
}

/**
 * Compute how many luna (remote harvest) creeps a home room should spawn.
 * @param {Room} room Owned room dispatching remote harvesters.
 * @param {object} cache Per-tick cache data.
 * @returns {number} Target number of luna creeps for the room.
 * @sideeffects Reads Memory.remoteAssignments for active tasks.
 * @cpu Moderate depending on remote count.
 * @memory Temporary maps only.
 */
function determineLunaQuota(room, cache) {
  if (!room) return 0;

  var remotes = cache.remotesByHome[room.name] || [];
  if (remotes.length === 0) return 0;

  var remoteSet = Object.create(null);
  for (var i = 0; i < remotes.length; i++) {
    remoteSet[remotes[i]] = true;
  }

  var roomsMem = Memory.rooms || {};
  var totalSources = 0;

  for (i = 0; i < remotes.length; i++) {
    var remoteName = remotes[i];
    var mem = roomsMem[remoteName] || {};

    if (mem.hostile) continue;

    if (mem._invaderLock && mem._invaderLock.locked) {
      var lockTick = typeof mem._invaderLock.t === 'number' ? mem._invaderLock.t : null;
      if (lockTick === null || (Game.time - lockTick) <= 1500) {
        continue;
      }
    }

    var sourceCount = 0;
    var visibleRoom = Game.rooms[remoteName];
    if (visibleRoom) {
      var sources = visibleRoom.find(FIND_SOURCES);
      sourceCount = Array.isArray(sources) ? sources.length : 0;
    }

    if (sourceCount === 0) {
      sourceCount = countSourcesInMemory(mem);
    }

    if (sourceCount === 0 && Array.isArray(mem.sources)) {
      sourceCount = mem.sources.length;
    }

    totalSources += sourceCount;
  }

  if (totalSources <= 0) {
    totalSources = remotes.length;
  }

  var assignments = Memory.remoteAssignments || {};
  var active = 0;
  for (var assignKey in assignments) {
    if (!BeeToolbox.hasOwn(assignments, assignKey)) continue;
    var entry = assignments[assignKey];
    if (!entry) continue;
    var remoteRoomName = entry.roomName || entry.room;
    if (!remoteRoomName || !remoteSet[remoteRoomName]) continue;
    var count = entry.count | 0;
    if (!count && entry.owner) count = 1;
    if (count > 0) active += count;
  }

  var desired = Math.max(totalSources * DEFAULT_LUNA_PER_SOURCE, active);
  return desired;
}

var BeeHiveMind = {
  /**
   * Main entry point executed each tick to coordinate the colony.
   * @returns {void}
   * @sideeffects Manages memory, creeps, spawns, planners, and trade routines.
   * @cpu High but amortized via caches.
   * @memory Writes to Memory and global cache structures.
   */
  run: function () {
    this.initializeMemory();
    var cache = prepareTickCaches();

    var ownedRooms = cache.roomsOwned || [];
    for (var i = 0; i < ownedRooms.length; i++) {
      this.manageRoom(ownedRooms[i], cache);
    }

    this.runCreeps(cache);
    this.manageSpawns(cache);

    if (TradeEnergy && typeof TradeEnergy.runAll === 'function') {
      TradeEnergy.runAll();
    }
  },

  /**
   * Execute per-room planning hooks for owned rooms.
   * @param {Room} room Room to manage.
   * @param {object} cache Per-tick cache data.
   * @returns {void}
   * @sideeffects May place construction sites or road plans.
   * @cpu Moderate depending on planner work.
   * @memory No additional persistent data.
   */
  manageRoom: function (room, cache) {
    if (!room) return;
    if (RoomPlanner && typeof RoomPlanner.ensureSites === 'function') {
      RoomPlanner.ensureSites(room, cache);
    }
    if (RoadPlanner && typeof RoadPlanner.ensureRemoteRoads === 'function') {
      RoadPlanner.ensureRemoteRoads(room, cache);
    }
  },

  /**
   * Run behavior logic for each cached creep.
   * @param {object} cache Per-tick cache data.
   * @returns {void}
   * @sideeffects Issues creep actions and may log errors.
   * @cpu High proportional to creep count.
   * @memory No new persistent data.
   */
  runCreeps: function (cache) {
    var creeps = cache.creeps || [];
    for (var i = 0; i < creeps.length; i++) {
      var creep = creeps[i];
      if (!creep) continue;
      this.assignTask(creep);
      var roleName = (creep.memory && creep.memory.role) ? creep.memory.role : null;
      var roleFn = ROLE_DISPATCH[roleName];
      if (typeof roleFn === 'function') {
        try {
          roleFn(creep);
        } catch (error) {
          hiveLog.debug('⚠️ Role error for ' + (creep.name || 'unknown') + ' (' + (roleName || 'unset') + ')', error);
        }
      } else {
        hiveLog.info('🐝 Unknown role: ' + (roleName || 'undefined') + ' (Creep: ' + (creep.name || 'unknown') + ')');
      }
    }
  },

  /**
   * Assign a default task to creeps lacking explicit orders.
   * @param {Creep} creep Creep requiring a task assignment.
   * @returns {void}
   * @sideeffects Mutates creep.memory.task when empty.
   * @cpu O(1).
   * @memory None.
   */
  assignTask: function (creep) {
    if (!creep || !creep.memory) return;
    if (creep.memory.task) return;
    var defaultTask = defaultTaskForRole(creep.memory.role);
    if (defaultTask) {
      creep.memory.task = defaultTask;
    }
  },

  /**
   * Spawn creeps based on task quotas for each spawn structure.
   * @param {object} cache Per-tick cache data.
   * @returns {void}
   * @sideeffects Calls spawn logic modules to create creeps.
   * @cpu Moderate depending on spawn count and quotas.
   * @memory Updates count tracking maps during the tick.
   */
  manageSpawns: function (cache) {
    var roleCounts = cloneCounts(cache.roleCounts);
    var lunaCountsByHome = cloneCounts(cache.lunaCountsByHome);
    var spawns = cache.spawns || [];

    for (var i = 0; i < spawns.length; i++) {
      var spawner = spawns[i];
      if (!spawner || spawner.spawning) continue;

      if (typeof spawnLogic.Spawn_Squad === 'function') {
        // Squad spawning left disabled by default; enable when configured externally.
      }

      var room = spawner.room;
      if (!room) continue;
      var workerTaskLimits = {
        baseharvest: 2,
        courier: 1,
        queen: 1,
        upgrader: 1,
        builder: needBuilder(room, cache),
        repair: 0,
        luna: determineLunaQuota(room, cache),
        scout: 1,
        CombatArcher: 0,
        CombatMelee: 0,
        CombatMedic: 0,
        Dismantler: 0,
        Trucker: 0,
        Claimer: 0
      };

      for (var task in workerTaskLimits) {
        if (!BeeToolbox.hasOwn(workerTaskLimits, task)) continue;
        var limit = workerTaskLimits[task] | 0;
        var current = (task === 'luna')
          ? (lunaCountsByHome[room.name] || 0)
          : (roleCounts[task] || 0);
        if (current >= limit) {
          continue;
        }

        if (!spawnLogic || typeof spawnLogic.Calculate_Spawn_Resource !== 'function' || typeof spawnLogic.Spawn_Worker_Bee !== 'function') {
          break;
        }

        var spawnResource = spawnLogic.Calculate_Spawn_Resource(spawner);
        var didSpawn = spawnLogic.Spawn_Worker_Bee(spawner, task, spawnResource);
        if (didSpawn) {
          roleCounts[task] = (roleCounts[task] || 0) + 1;
          if (task === 'luna') {
            lunaCountsByHome[room.name] = (lunaCountsByHome[room.name] || 0) + 1;
          }
        }
        break;
      }
    }
  },

  /**
   * Placeholder for remote operations (reserved for future use).
   * @returns {void}
   * @sideeffects None currently.
   * @cpu None.
   * @memory None.
   */
  manageRemoteOps: function () {
    // Reserved for future remote task coordination.
  },

  /**
   * Ensure Memory.rooms exists and contains valid objects.
   * @returns {void}
   * @sideeffects Initializes Memory.rooms entries to empty objects.
   * @cpu O(n) over existing room keys.
   * @memory May allocate empty objects for missing rooms.
   */
  initializeMemory: function () {
    if (!Memory.rooms) {
      Memory.rooms = {};
      return;
    }

    for (var roomName in Memory.rooms) {
      if (!BeeToolbox.hasOwn(Memory.rooms, roomName)) continue;
      if (!Memory.rooms[roomName]) {
        Memory.rooms[roomName] = {};
      }
    }
  }
};

module.exports = BeeHiveMind;
