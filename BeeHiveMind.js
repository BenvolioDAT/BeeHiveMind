// BeeHiveMind.js (refactor, ES5-safe)

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

// Map role name -> run function
var creepRoles = {
  Worker_Bee: roleWorker_Bee.run
};

// Small logger
function log(level, msg) {
  if (currentLogLevel >= level) console.log(msg);
}

var BeeHiveMind = {
  // ---------------- Main tick ----------------
  run: function () {
    BeeHiveMind.initializeMemory();

    // Per-room management
    for (var roomName in Game.rooms) {
      if (!Game.rooms.hasOwnProperty(roomName)) continue;
      var room = Game.rooms[roomName];
      BeeHiveMind.manageRoom(room);
    }

    // Per-creep roles
    for (var name in Game.creeps) {
      if (!Game.creeps.hasOwnProperty(name)) continue;
      var creep = Game.creeps[name];
      BeeHiveMind.assignRole(creep);
    }

    // Spawns
    BeeHiveMind.manageSpawns();

    // Remote ops hook
    BeeHiveMind.manageRemoteOps();
  },

  // ------------- Room loop -------------
  manageRoom: function (room) {
    if (!room) return;

    // Continuous, low-cost site placement
    if (RoomPlanner && RoomPlanner.ensureSites) RoomPlanner.ensureSites(room);
    if (RoadPlanner && RoadPlanner.ensureRemoteRoads) RoadPlanner.ensureRemoteRoads(room);

    // Energy market decisions
    if (TradeEnergy && TradeEnergy.runAll) TradeEnergy.runAll();

    // (Room-specific logic placeholder)
  },

  // ------------- Task defaults -------------
  assignTask: function (creep) {
    if (!creep || creep.memory.task) return;

    // Simple defaults based on role
    var role = creep.memory.role;
    if (role === 'Queen') creep.memory.task = 'queen';
    else if (role === 'Scout') creep.memory.task = 'scout';
    else if (role === 'repair') creep.memory.task = 'repair';
    // else leave undefined; spawner logic will create needed ones
  },

  // ------------- Role dispatch -------------
  assignRole: function (creep) {
    if (!creep) return;
    BeeHiveMind.assignTask(creep);

    var roleName = creep.memory.role;
    var roleFn = creepRoles[roleName];

    if (typeof roleFn === 'function') {
      try {
        roleFn(creep);
      } catch (e) {
        log(LOG_LEVEL.DEBUG, '⚠️ Role error for ' + (creep.name || 'unknown') + ' (' + roleName + '): ' + e);
      }
    } else {
      var cName = creep.name || 'unknown';
      var r = roleName || 'undefined';
      console.log('🐝 Unknown role: ' + r + ' (Creep: ' + cName + ')');
    }
  },

  // ------------- Spawning -------------
  manageSpawns: function () {
    // Helper: need at least one builder if there are local+remote sites
    function NeedBuilder(room) {
      if (!room) return 0;

      var localSites = room.find(FIND_MY_CONSTRUCTION_SITES).length;

      var remoteSites = 0;
      if (RoadPlanner && typeof RoadPlanner.getActiveRemoteRooms === 'function') {
        var remotes = RoadPlanner.getActiveRemoteRooms(room) || [];
        for (var i = 0; i < remotes.length; i++) {
          var rn = remotes[i];
          var r = Game.rooms[rn];
          if (r) remoteSites += r.find(FIND_MY_CONSTRUCTION_SITES).length;
        }
      }

      return (localSites + remoteSites) > 0 ? 1 : 0;
    }

    for (var roomName in Game.rooms) {
      if (!Game.rooms.hasOwnProperty(roomName)) continue;
      var room = Game.rooms[roomName];

      // Quotas per task
      var workerTaskLimits = {
        baseharvest:   2,
        builder:       NeedBuilder(room),
        upgrader:      1,
        repair:        0,
        courier:       1,
        remoteharvest: 8,
        scout:         1,
        queen:         2,
        CombatArcher:  1,
        CombatMelee:   1,
        CombatMedic:   1,
        Dismantler:    0,
        Trucker:       0,
        Claimer:       1,
      };

      // Ghost filter: don’t count creeps that will die very soon
      var DYING_SOON_TTL = 80;
      var roleCounts = {};
      var name;

      for (name in Game.creeps) {
        if (!Game.creeps.hasOwnProperty(name)) continue;
        var c = Game.creeps[name];
        var t = c.memory.task;
        var ttl = c.ticksToLive;

        // Newborns sometimes have undefined TTL for one tick — count them
        if (typeof ttl === 'number' && ttl <= DYING_SOON_TTL) continue;

        roleCounts[t] = (roleCounts[t] || 0) + 1;
      }

      // Each spawn tries to fill one missing task
      for (var spawnName in Game.spawns) {
        if (!Game.spawns.hasOwnProperty(spawnName)) continue;
        var spawner = Game.spawns[spawnName];
        if (spawner.spawning) continue;

        // Iterate workerTaskLimits without Object.entries
        for (var task in workerTaskLimits) {
          if (!workerTaskLimits.hasOwnProperty(task)) continue;

          var limit = workerTaskLimits[task] || 0;
          var count = roleCounts[task] || 0;

          if (count < limit) {
            var spawnResource = spawnLogic.Calculate_Spawn_Resource(spawner);
            var didSpawn = spawnLogic.Spawn_Worker_Bee(spawner, task, spawnResource);
            if (didSpawn) {
              // reflect scheduled spawn in snapshot
              roleCounts[task] = count + 1;
              break; // only one attempt per spawn per tick
            }
          }
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
    // Ensure each keyed room has an object
    for (var roomName in Memory.rooms) {
      if (!Memory.rooms.hasOwnProperty(roomName)) continue;
      if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
    }
  }
};

module.exports = BeeHiveMind;
