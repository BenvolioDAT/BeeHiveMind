// BeeHiveMind.cpu.es5.js
// ES5-safe, CPU-minded hive brain:
// - One-pass per-tick caches (rooms, spawns, creeps, roleCounts, siteCounts)
// - TradeEnergy.runAll() once per tick (not per room)
// - Spawning loops only spawns (no nested rooms×spawns×creeps hurricanes)
// - NeedBuilder() uses cached global construction sites (no per-remote .find())
// - Room/road planners still run per-room, but your versions are already tick-gated

'use strict';

var CoreLogger = require('core.logger');
var LOG_LEVEL = CoreLogger.LOG_LEVEL;
var hiveLog = CoreLogger.createLogger('HiveMind', LOG_LEVEL.BASIC);

// -------- Requires --------
var spawnLogic      = require('spawn.logic');
var roleWorker_Bee  = require('role.Worker_Bee');
var TaskBuilder     = require('Task.Builder');
var RoomPlanner     = require('Planner.Room');
var RoadPlanner     = require('Planner.Road');
var TradeEnergy     = require('Trade.Energy');
var TaskLuna        = require('Task.Luna');
var EconomyManager  = require('EconomyManager');

// Map role name -> run function (extend as you add roles)
var creepRoles = {
  Worker_Bee: roleWorker_Bee.run
};

// ------- Per-tick global cache (cheap lookups, no double work) -------
if (!global.__BHM) global.__BHM = {};
function prepareTickCaches() {
  var T = Game.time;
  var C = global.__BHM;
  if (C.tick === T) return C; // already prepared

  C.tick = T;

  // Owned rooms list + map
  var rooms = [];
  var roomsMap = {};
  for (var rn in Game.rooms) {
    if (!Game.rooms.hasOwnProperty(rn)) continue;
    var rr = Game.rooms[rn];
    if (rr && rr.controller && rr.controller.my) {
      rooms.push(rr);
      roomsMap[rn] = rr;
    }
  }
  C.roomsOwned = rooms;
  C.roomsMap = roomsMap;

  // Spawns list
  var spawns = [];
  for (var sn in Game.spawns) {
    if (!Game.spawns.hasOwnProperty(sn)) continue;
    spawns.push(Game.spawns[sn]);
  }
  C.spawns = spawns;

  // Creeps list + roleCounts (by creep.memory.task), skipping dying-soon
  var DYING_SOON_TTL = 60;
  var roleCounts = {};
  var lunaCountsByHome = {};
  var creeps = [];
  for (var cn in Game.creeps) {
    if (!Game.creeps.hasOwnProperty(cn)) continue;
    var c = Game.creeps[cn];
    creeps.push(c);
    var ttl = c.ticksToLive;
    if (typeof ttl === 'number' && ttl <= DYING_SOON_TTL) continue; // let the next wave replace
    var t = c.memory && c.memory.task;
    if (t === 'remoteharvest' && c.memory) {
      t = 'luna';
      c.memory.task = 'luna';
    }
    if (t) {
      roleCounts[t] = (roleCounts[t] || 0) + 1;
      if (t === 'luna') {
        var homeName = (c.memory && c.memory.home) || null;
        if (!homeName && c.memory && c.memory._home) homeName = c.memory._home;
        if (!homeName && c.room) homeName = c.room.name;
        if (homeName) {
          lunaCountsByHome[homeName] = (lunaCountsByHome[homeName] || 0) + 1;
        }
      }
    }
  }
  C.creeps = creeps;
  C.roleCounts = roleCounts;
  C.lunaCountsByHome = lunaCountsByHome;

  // Global construction site counts by room (my sites)
  var roomSiteCounts = {};
  var totalSites = 0;
  for (var id in Game.constructionSites) {
    if (!Game.constructionSites.hasOwnProperty(id)) continue;
    var site = Game.constructionSites[id];
    // Screeps Game.constructionSites are your sites; still check for robustness
    if (site && site.my) {
      totalSites++;
      var rname = site.pos.roomName;
      roomSiteCounts[rname] = (roomSiteCounts[rname] || 0) + 1;
    }
  }
  C.roomSiteCounts = roomSiteCounts;
  C.totalSites = totalSites;

  // Active remote rooms by home (use RoadPlanner helper once per home)
  var remotesByHome = {};
  if (RoadPlanner && typeof RoadPlanner.getActiveRemoteRooms === 'function') {
    for (var i = 0; i < rooms.length; i++) {
      var home = rooms[i];
      var list = RoadPlanner.getActiveRemoteRooms(home) || [];
      remotesByHome[home.name] = list;
    }
  }
  C.remotesByHome = remotesByHome;
  C.workerTaskLimitsByRoom = {};

  return C;
}

var BeeHiveMind = {
  // ---------------- Main tick ----------------
  run: function () {
    BeeHiveMind.initializeMemory();

    var C = prepareTickCaches();

    // Per-room management (planners already tick-gated in your CPU versions)
    for (var i = 0; i < C.roomsOwned.length; i++) {
      BeeHiveMind.manageRoom(C.roomsOwned[i], C);
    }

    // Per-creep roles
    BeeHiveMind.runCreeps(C);

    // Spawning — one pass over spawns, using cached counts and site info
    BeeHiveMind.manageSpawns(C);

    // Energy market decisions (once per tick, not per room)
    if (TradeEnergy && typeof TradeEnergy.runAll === 'function') {
      // gate a little if you want to: e.g., run every 3 ticks
      // if (Game.time % 3 === 0) TradeEnergy.runAll();
      TradeEnergy.runAll();
    }
  },

  // ------------- Room loop -------------
// lean room loop: planners only (no market spam)
  manageRoom: function (room, C) {
    if (!room) return;

    if (EconomyManager && typeof EconomyManager.updateRoom === 'function') {
      EconomyManager.updateRoom(room);
    }

    if (RoomPlanner && RoomPlanner.ensureSites) RoomPlanner.ensureSites(room);
    if (RoadPlanner && RoadPlanner.ensureRemoteRoads) RoadPlanner.ensureRemoteRoads(room);

    // Add light per-room logic here if needed (avoid heavy .find loops per tick)
  },

  // ------------- Creep loop -------------
  runCreeps: function (C) {
    var map = creepRoles;
    for (var i = 0; i < C.creeps.length; i++) {
      var creep = C.creeps[i];
      BeeHiveMind.assignTask(creep); // idempotent when already set
      var roleName = creep.memory && creep.memory.role;
      var roleFn = map[roleName];
      if (typeof roleFn === 'function') {
        try {
          roleFn(creep);
        } catch (e) {
          hiveLog.debug('⚠️ Role error for', (creep.name || 'unknown'), '(' + roleName + '):', e);
        }
      } else {
        var cName = creep.name || 'unknown';
        var r = roleName || 'undefined';
        hiveLog.info('🐝 Unknown role:', r, '(Creep:', cName + ')');
      }
    }
  },

  // ------------- Task defaults -------------
  assignTask: function (creep) {
    if (!creep || (creep.memory && creep.memory.task)) return;
    var role = creep.memory && creep.memory.role;
    if (role === 'Queen') creep.memory.task = 'queen';
    else if (role === 'Scout') creep.memory.task = 'scout';
    else if (role === 'repair') creep.memory.task = 'repair';
    // else leave undefined; spawner logic will create needed ones
  },

  // ------------- Spawning -------------
  manageSpawns: function (C) {
    // helper: builder need (local + remote) using per-tick cached site counts
    function NeedBuilder(room) {
      if (!room) return 0;
      var local = C.roomSiteCounts[room.name] | 0;
      var remote = 0;
      var list = C.remotesByHome[room.name] || [];
      for (var i = 0; i < list.length; i++) {
        var rn = list[i];
        remote += (C.roomSiteCounts[rn] | 0);
      }
      return (local + remote) > 0 ? 2 : 0;
    }

    function DetermineLunaQuota(room) {
      if (!room) return 0;

      var remotes = C.remotesByHome[room.name] || [];
      if (!remotes.length) return 0;

      var remotesSorted = remotes.slice();
      if (remotesSorted.length > 1) {
        remotesSorted.sort(function (a, b) {
          return Game.map.getRoomLinearDistance(room.name, a) - Game.map.getRoomLinearDistance(room.name, b);
        });
      }

      var maxRoomsPerHome = (TaskLuna && TaskLuna.MAX_REMOTE_ROOMS_PER_HOME) || 0;
      if (maxRoomsPerHome > 0 && remotesSorted.length > maxRoomsPerHome) {
        remotesSorted = remotesSorted.slice(0, maxRoomsPerHome);
      }

      var remoteSet = {};
      for (var r = 0; r < remotesSorted.length; r++) {
        remoteSet[remotesSorted[r]] = true;
      }

      var roomsMem = Memory.rooms || {};
      var totalSources = 0;
      var perSource = (TaskLuna && TaskLuna.MAX_LUNA_PER_SOURCE) || 1;

      for (var j = 0; j < remotesSorted.length; j++) {
        var remoteName = remotesSorted[j];
        var mem = roomsMem[remoteName] || {};

        if (mem.hostile) continue;

        if (mem._invaderLock && mem._invaderLock.locked) {
          var lockTick = typeof mem._invaderLock.t === 'number' ? mem._invaderLock.t : null;
          if (lockTick == null || (Game.time - lockTick) <= 1500) {
            continue;
          }
        }

        var sourceCount = 0;
        var remoteRoom = Game.rooms[remoteName];
        if (remoteRoom) {
          var found = remoteRoom.find(FIND_SOURCES);
          sourceCount = found ? found.length : 0;
        }

        if (sourceCount === 0 && mem.sources) {
          for (var sid in mem.sources) {
            if (mem.sources.hasOwnProperty(sid)) sourceCount++;
          }
        }

        if (sourceCount === 0 && mem.intel && typeof mem.intel.sources === 'number') {
          sourceCount = mem.intel.sources | 0;
        }

        totalSources += sourceCount;
      }

      if (totalSources <= 0 && remotesSorted.length > 0) {
        totalSources = remotesSorted.length;
      }

      var assignments = Memory.remoteAssignments || {};
      var active = 0;
      for (var aid in assignments) {
        if (!assignments.hasOwnProperty(aid)) continue;
        var entry = assignments[aid];
        if (!entry) continue;
        var remoteRoomName = entry.roomName || entry.room;
        if (!remoteRoomName || !remoteSet[remoteRoomName]) continue;
        var count = entry.count | 0;
        if (!count && entry.owner) count = 1;
        if (count > 0) active += count;
      }

      var desired = totalSources * perSource;
      if (active > desired) desired = active;

      var maxActive = (TaskLuna && TaskLuna.MAX_ACTIVE_LUNA_PER_HOME) || 0;
      if (maxActive > 0 && desired > maxActive) desired = maxActive;

      return desired;
    }

    // snapshot of counts (we mutate this as we schedule spawns to avoid double-filling)
    var roleCounts = {};
    for (var k in C.roleCounts) if (C.roleCounts.hasOwnProperty(k)) roleCounts[k] = C.roleCounts[k];
    var lunaCountsByHome = {};
    if (C.lunaCountsByHome) {
      for (var hk in C.lunaCountsByHome) {
        if (C.lunaCountsByHome.hasOwnProperty(hk)) lunaCountsByHome[hk] = C.lunaCountsByHome[hk];
      }
    }

    // Iterate each spawn once
    for (var s = 0; s < C.spawns.length; s++) {
      var spawner = C.spawns[s];
      if (!spawner || spawner.spawning) continue;
        // --- Squad spawning (run before normal quotas) ---
        // Only the first spawn attempts squad maintenance to avoid double-spawning.
        if (typeof spawnLogic.Spawn_Squad === 'function') {
          if (spawnLogic.Spawn_Squad(spawner, 'Alpha')) continue; // try to fill Alpha first
          if (spawnLogic.Spawn_Squad(spawner, 'Bravo')) continue; // then try Bravo
          if (spawnLogic.Spawn_Squad(spawner, 'Charlie')) continue;
          if (spawnLogic.Spawn_Squad(spawner, 'Delta')) continue;
        }
      var room = spawner.room;
      // Quotas per task (cheap to compute per spawn; could memoize by room name if desired)
      var workerTaskLimits = {
        baseharvest:   2,
        builder:       NeedBuilder(room),
        upgrader:      1,
        repair:        0,
        courier:       1,
        queen:         2,
        luna:          DetermineLunaQuota(room),
        scout:         1,
        CombatArcher:  0,
        CombatMelee:   0,
        CombatMedic:   0,
        Dismantler:    0,
        Trucker:       0,
        Claimer:       0,
      };

      if (!C.workerTaskLimitsByRoom) C.workerTaskLimitsByRoom = {};
      C.workerTaskLimitsByRoom[room.name] = workerTaskLimits;

      // find first underfilled task and try to spawn it
      var task;
      for (task in workerTaskLimits) {
        if (!workerTaskLimits.hasOwnProperty(task)) continue;
        var limit = workerTaskLimits[task] | 0;
        var count = roleCounts[task] | 0;
        if (task === 'luna') {
          count = lunaCountsByHome[room.name] | 0;
        }
        if (count < limit) {
          var spawnResource = spawnLogic.Calculate_Spawn_Resource(spawner);
          var didSpawn = spawnLogic.Spawn_Worker_Bee(spawner, task, spawnResource);
          if (didSpawn) {
            roleCounts[task] = count + 1; // reflect immediately so other spawns see the bump
            if (task === 'luna') {
              lunaCountsByHome[room.name] = (lunaCountsByHome[room.name] | 0) + 1;
            }
          }
          break; // only one attempt per spawn per tick, either way
        }
      }
    }
  },

  // ------------- Remote ops hook -------------
  manageRemoteOps: function () {
    // assignment, scouting, claiming, etc. (stub)
  },

  // ------------- Memory init -------------
  initializeMemory: function () {
    if (!Memory.rooms) Memory.rooms = {};
    for (var roomName in Memory.rooms) {
      if (!Memory.rooms.hasOwnProperty(roomName)) continue;
      if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
    }
  },

  getWorkerTaskLimits: function (room) {
    var roomName = null;
    if (room) {
      if (typeof room === 'string') roomName = room;
      else if (room.name) roomName = room.name;
    }
    if (!roomName) return null;

    var C = prepareTickCaches();
    var map = C.workerTaskLimitsByRoom || {};
    var limits = map[roomName];
    if (!limits) return null;

    var copy = {};
    for (var key in limits) {
      if (!limits.hasOwnProperty(key)) continue;
      copy[key] = limits[key];
    }
    return copy;
  }
};

module.exports = BeeHiveMind;
