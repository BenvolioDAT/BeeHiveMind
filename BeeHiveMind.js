"use strict";

const CoreLogger = require('core.logger');
const spawnLogic = require('spawn.logic');
const roleWorkerBee = require('role.Worker_Bee');
const RoomPlanner = require('Planner.Room');
const RoadPlanner = require('Planner.Road');
const TradeEnergy = require('Trade.Energy');
const TaskLuna = require('Task.Luna');

const { LOG_LEVEL } = CoreLogger;
const hiveLog = CoreLogger.createLogger("HiveMind", LOG_LEVEL.BASIC);

const ROLE_DISPATCH = Object.freeze({
  Worker_Bee: roleWorkerBee.run,
});

const ROLE_DEFAULT_TASK = Object.freeze({
  Queen: "queen",
  Scout: "scout",
  repair: "repair",
});

const DYING_SOON_TTL = 60;
const DEFAULT_LUNA_PER_SOURCE = TaskLuna && typeof TaskLuna.MAX_LUNA_PER_SOURCE === "number"
  ? TaskLuna.MAX_LUNA_PER_SOURCE
  : 1;

const GLOBAL_CACHE = global.__BHM_CACHE || (global.__BHM_CACHE = { tick: -1 });

function cloneCounts(source) {
  return Object.assign(Object.create(null), source || {});
}

function prepareTickCaches() {
  const tick = Game.time;
  const cache = GLOBAL_CACHE;
  if (cache.tick === tick) {
    return cache;
  }

  cache.tick = tick;

  const ownedRooms = [];
  const roomsMap = Object.create(null);
  for (const room of Object.values(Game.rooms)) {
    if (!room || !room.controller || !room.controller.my) continue;
    ownedRooms.push(room);
    roomsMap[room.name] = room;
  }
  cache.roomsOwned = ownedRooms;
  cache.roomsMap = roomsMap;

  cache.spawns = Object.values(Game.spawns).filter(Boolean);

  const creeps = [];
  const roleCounts = Object.create(null);
  const lunaCountsByHome = Object.create(null);

  for (const creep of Object.values(Game.creeps)) {
    if (!creep) continue;
    creeps.push(creep);

    const ttl = creep.ticksToLive;
    if (typeof ttl === "number" && ttl <= DYING_SOON_TTL) continue;

    if (!creep.memory) creep.memory = {};
    const creepMemory = creep.memory;
    let task = creepMemory.task;
    if (task === "remoteharvest") {
      task = "luna";
      creepMemory.task = "luna";
    }

    if (!task) continue;

    roleCounts[task] = (roleCounts[task] || 0) + 1;

    if (task === "luna") {
      const homeName = creepMemory.home || creepMemory._home || (creep.room && creep.room.name);
      if (homeName) {
        lunaCountsByHome[homeName] = (lunaCountsByHome[homeName] || 0) + 1;
      }
    }
  }

  cache.creeps = creeps;
  cache.roleCounts = roleCounts;
  cache.lunaCountsByHome = lunaCountsByHome;

  const roomSiteCounts = Object.create(null);
  let totalSites = 0;
  for (const site of Object.values(Game.constructionSites)) {
    if (!site || !site.my) continue;
    totalSites += 1;
    const roomName = site.pos.roomName;
    roomSiteCounts[roomName] = (roomSiteCounts[roomName] || 0) + 1;
  }
  cache.roomSiteCounts = roomSiteCounts;
  cache.totalSites = totalSites;

  const remotesByHome = Object.create(null);
  if (RoadPlanner && typeof RoadPlanner.getActiveRemoteRooms === "function") {
    for (const room of ownedRooms) {
      remotesByHome[room.name] = RoadPlanner.getActiveRemoteRooms(room) || [];
    }
  }
  cache.remotesByHome = remotesByHome;

  return cache;
}

function defaultTaskForRole(role) {
  if (!role) return undefined;
  return ROLE_DEFAULT_TASK[role];
}

function needBuilder(room, cache) {
  if (!room) return 0;
  const localSites = cache.roomSiteCounts[room.name] || 0;
  const remotes = cache.remotesByHome[room.name] || [];
  const remoteSites = remotes.reduce(
    (total, remoteRoomName) => total + (cache.roomSiteCounts[remoteRoomName] || 0),
    0,
  );
  return localSites + remoteSites > 0 ? 1 : 0;
}

function countSourcesInMemory(mem) {
  if (!mem) return 0;
  if (mem.sources && typeof mem.sources === "object") {
    return Object.keys(mem.sources).length;
  }
  if (mem.intel && typeof mem.intel.sources === "number") {
    return mem.intel.sources | 0;
  }
  return 0;
}

function determineLunaQuota(room, cache) {
  if (!room) return 0;

  const remotes = cache.remotesByHome[room.name] || [];
  if (remotes.length === 0) return 0;

  const remoteSet = new Set(remotes);
  const roomsMem = Memory.rooms || {};
  let totalSources = 0;

  for (const remoteName of remotes) {
    const mem = roomsMem[remoteName] || {};

    if (mem.hostile) continue;

    if (mem._invaderLock && mem._invaderLock.locked) {
      const lockTick = typeof mem._invaderLock.t === "number" ? mem._invaderLock.t : null;
      if (lockTick == null || Game.time - lockTick <= 1500) {
        continue;
      }
    }

    let sourceCount = 0;
    const visibleRoom = Game.rooms[remoteName];
    if (visibleRoom) {
      const sources = visibleRoom.find(FIND_SOURCES);
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

  const assignments = Memory.remoteAssignments || {};
  let active = 0;
  for (const entry of Object.values(assignments)) {
    if (!entry) continue;
    const remoteRoomName = entry.roomName || entry.room;
    if (!remoteRoomName || !remoteSet.has(remoteRoomName)) continue;
    let count = entry.count | 0;
    if (!count && entry.owner) count = 1;
    if (count > 0) active += count;
  }

  const desired = Math.max(totalSources * DEFAULT_LUNA_PER_SOURCE, active);
  return desired;
}

const BeeHiveMind = {
  run() {
    this.initializeMemory();
    const cache = prepareTickCaches();

    for (const room of cache.roomsOwned) {
      this.manageRoom(room, cache);
    }

    this.runCreeps(cache);
    this.manageSpawns(cache);

    if (TradeEnergy && typeof TradeEnergy.runAll === "function") {
      TradeEnergy.runAll();
    }
  },

  manageRoom(room, cache) {
    if (!room) return;
    if (RoomPlanner && typeof RoomPlanner.ensureSites === "function") {
      RoomPlanner.ensureSites(room, cache);
    }
    if (RoadPlanner && typeof RoadPlanner.ensureRemoteRoads === "function") {
      RoadPlanner.ensureRemoteRoads(room, cache);
    }
  },

  runCreeps(cache) {
    for (const creep of cache.creeps) {
      this.assignTask(creep);
      const roleName = creep.memory && creep.memory.role;
      const roleFn = ROLE_DISPATCH[roleName];
      if (typeof roleFn === "function") {
        try {
          roleFn(creep);
        } catch (error) {
          hiveLog.debug("⚠️ Role error for", creep.name || "unknown", `(${roleName})`, error);
        }
      } else {
        hiveLog.info("🐝 Unknown role:", roleName || "undefined", ` (Creep: ${creep.name || "unknown"})`);
      }
    }
  },

  assignTask(creep) {
    if (!creep) return;
    if (creep.memory && creep.memory.task) return;
    const defaultTask = defaultTaskForRole(creep.memory && creep.memory.role);
    if (defaultTask) {
      creep.memory.task = defaultTask;
    }
  },

  manageSpawns(cache) {
    const roleCounts = cloneCounts(cache.roleCounts);
    const lunaCountsByHome = cloneCounts(cache.lunaCountsByHome);

    for (const spawner of cache.spawns) {
      if (!spawner || spawner.spawning) continue;

      if (typeof spawnLogic.Spawn_Squad === "function") {
        // Squad spawning disabled by default; enable if squads are configured.
        // if (spawnLogic.Spawn_Squad(spawner, "Alpha")) continue;
        // if (spawnLogic.Spawn_Squad(spawner, "Bravo")) continue;
        // if (spawnLogic.Spawn_Squad(spawner, "Charlie")) continue;
        // if (spawnLogic.Spawn_Squad(spawner, "Delta")) continue;
      }

      const room = spawner.room;
      const workerTaskLimits = {
        baseharvest: 2,
        courier: 1,
        queen: 1,
        upgrader: 1,
        builder: needBuilder(room, cache),
        repair: 0,
        luna: determineLunaQuota(room, cache),
        scout: 0,
        CombatArcher: 0,
        CombatMelee: 0,
        CombatMedic: 0,
        Dismantler: 0,
        Trucker: 0,
        Claimer: 0,
      };

      for (const [task, limitRaw] of Object.entries(workerTaskLimits)) {
        const limit = limitRaw | 0;
        const current = task === "luna"
          ? (lunaCountsByHome[room.name] || 0)
          : (roleCounts[task] || 0);

        if (current >= limit) continue;

        const spawnResource = spawnLogic.Calculate_Spawn_Resource(spawner);
        const didSpawn = spawnLogic.Spawn_Worker_Bee(spawner, task, spawnResource);
        if (didSpawn) {
          roleCounts[task] = (roleCounts[task] || 0) + 1;
          if (task === "luna") {
            lunaCountsByHome[room.name] = (lunaCountsByHome[room.name] || 0) + 1;
          }
        }
        break;
      }
    }
  },

  manageRemoteOps() {
    // Hook reserved for assignment, scouting, claiming, etc.
  },

  initializeMemory() {
    if (!Memory.rooms) {
      Memory.rooms = {};
      return;
    }

    for (const roomName of Object.keys(Memory.rooms)) {
      if (!Memory.rooms[roomName]) {
        Memory.rooms[roomName] = {};
      }
    }
  },
};

module.exports = BeeHiveMind;
