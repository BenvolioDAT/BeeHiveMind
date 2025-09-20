// BeeHiveMind.cpu.es5.js
// ES5-safe, CPU-minded hive brain:
// - One-pass per-tick caches (rooms, spawns, creeps, roleCounts, siteCounts)
// - TradeEnergy.runAll() once per tick (not per room)
// - Spawning loops only spawns (no nested rooms×spawns×creeps hurricanes)
// - NeedBuilder() uses cached global construction sites (no per-remote .find())
// - Room/road planners still run per-room, but your versions are already tick-gated

'use strict';

// -------- Logging --------
var LOG_LEVEL = { NONE: 0, BASIC: 1, DEBUG: 2 };
// Toggle here:
var currentLogLevel = LOG_LEVEL.BASIC;

// -------- Requires --------
var spawnLogic      = require('spawn.logic');
var roleWorker_Bee  = require('role.Worker_Bee');
var TaskBuilder     = require('Task.Builder');
var RoomPlanner     = require('Planner.Room');
var RoadPlanner     = require('Planner.Road');
var TradeEnergy     = require('Trade.Energy');

// Map role name -> run function (extend as you add roles)
var creepRoles = {
  Worker_Bee: roleWorker_Bee.run
};

// Small logger
function log(level, msg) { if (currentLogLevel >= level) console.log(msg); }

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
  var DYING_SOON_TTL = 80;
  var roleCounts = {};
  var creeps = [];
  for (var cn in Game.creeps) {
    if (!Game.creeps.hasOwnProperty(cn)) continue;
    var c = Game.creeps[cn];
    creeps.push(c);
    var ttl = c.ticksToLive;
    if (typeof ttl === 'number' && ttl <= DYING_SOON_TTL) continue; // let the next wave replace
    var t = c.memory && c.memory.task;
    if (t) roleCounts[t] = (roleCounts[t] || 0) + 1;
  }
  C.creeps = creeps;
  C.roleCounts = roleCounts;

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
          if (currentLogLevel >= LOG_LEVEL.DEBUG) {
            console.log('⚠️ Role error for ' + (creep.name || 'unknown') + ' (' + roleName + '): ' + e);
          }
        }
      } else {
        if (currentLogLevel >= LOG_LEVEL.BASIC) {
          var cName = creep.name || 'unknown';
          var r = roleName || 'undefined';
          console.log('🐝 Unknown role: ' + r + ' (Creep: ' + cName + ')');
        }
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
      return (local + remote) > 0 ? 3 : 0;
    }

    // snapshot of counts (we mutate this as we schedule spawns to avoid double-filling)
    var roleCounts = {};
    for (var k in C.roleCounts) if (C.roleCounts.hasOwnProperty(k)) roleCounts[k] = C.roleCounts[k];

    // Iterate each spawn once
    for (var s = 0; s < C.spawns.length; s++) {
      var spawner = C.spawns[s];
      if (!spawner || spawner.spawning) continue;

      var room = spawner.room;
      // Quotas per task (cheap to compute per spawn; could memoize by room name if desired)
      var workerTaskLimits = {
        baseharvest:   2,
        builder:       NeedBuilder(room),
        upgrader:      1,
        repair:        0,
        courier:       1,
        remoteharvest: 8,
        scout:         1,
        queen:         2,
        CombatArcher:  2,
        CombatMelee:   0,
        CombatMedic:   1,
        Dismantler:    0,
        Trucker:       0,
        Claimer:       4,
      };

      // find first underfilled task and try to spawn it
      var task;
      for (task in workerTaskLimits) {
        if (!workerTaskLimits.hasOwnProperty(task)) continue;
        var limit = workerTaskLimits[task] | 0;
        var count = roleCounts[task] | 0;
        if (count < limit) {
          var spawnResource = spawnLogic.Calculate_Spawn_Resource(spawner);
          var didSpawn = spawnLogic.Spawn_Worker_Bee(spawner, task, spawnResource);
          if (didSpawn) {
            roleCounts[task] = count + 1; // reflect immediately so other spawns see the bump
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
  }
};

module.exports = BeeHiveMind;
