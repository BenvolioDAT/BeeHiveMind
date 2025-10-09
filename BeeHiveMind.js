
"use strict";

var CoreLogger = require('core.logger');
var spawnLogic = require('spawn.logic');
var roleWorkerBee = require('role.Worker_Bee');
var RoomPlanner = require('Planner.Room');
var RoadPlanner = require('Planner.Road');
var TradeEnergy = require('Trade.Energy');
var TaskLuna = require('Task.Luna');
var BeeToolbox = require('BeeToolbox');
var SquadFlagManager = require('SquadFlagManager');
var TaskSquad = require('./Task.Squad');
var TaskCombatArcher = require('Task.CombatArcher');
var TaskCombatMelee = require('Task.CombatMelee');
var TaskCombatMedic = require('Task.CombatMedic');

var LOG_LEVEL = CoreLogger.LOG_LEVEL;
var hiveLog = CoreLogger.createLogger('HiveMind', LOG_LEVEL.BASIC);

var SQUAD_ROLE_RUNNERS = {
  CombatArcher: (TaskCombatArcher && typeof TaskCombatArcher.run === 'function') ? TaskCombatArcher.run : null,
  CombatMelee: (TaskCombatMelee && typeof TaskCombatMelee.run === 'function') ? TaskCombatMelee.run : null,
  CombatMedic: (TaskCombatMedic && typeof TaskCombatMedic.run === 'function') ? TaskCombatMedic.run : null
};

function runSquadRole(creep) {
  if (!creep || !creep.memory) return;
  var role = creep.memory.squadRole || creep.memory.task;
  if (!role) return;
  var handler = SQUAD_ROLE_RUNNERS[role];
  if (typeof handler === 'function') {
    handler(creep);
    return;
  }
}

var ROLE_DISPATCH = Object.freeze({
  Worker_Bee: roleWorkerBee.run,
  squad: runSquadRole,
  CombatArcher: SQUAD_ROLE_RUNNERS.CombatArcher,
  CombatMelee: SQUAD_ROLE_RUNNERS.CombatMelee,
  CombatMedic: SQUAD_ROLE_RUNNERS.CombatMedic
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

function cloneCounts(source) {
  var result = Object.create(null);
  if (!source) return result;
  for (var key in source) {
    if (!BeeToolbox.hasOwn(source, key)) continue;
    result[key] = source[key];
  }
  return result;
}

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
  for (var idx = 0; idx < ownedRooms.length; idx++) {
    var ownedRoom = ownedRooms[idx];
    var remoteNames = [];
    if (RoadPlanner && typeof RoadPlanner.getActiveRemoteRooms === 'function') {
      remoteNames = normalizeRemoteRooms(RoadPlanner.getActiveRemoteRooms(ownedRoom));
    }
    remotesByHome[ownedRoom.name] = remoteNames;
  }
  cache.remotesByHome = remotesByHome;

  return cache;
}

function normalizeRemoteRooms(input) {
  var result = [];
  var seen = Object.create(null);

  function addName(value) {
    if (!value) return;
    var name = null;
    if (typeof value === 'string') {
      name = value;
    } else if (typeof value.roomName === 'string') {
      name = value.roomName;
    } else if (typeof value.name === 'string') {
      name = value.name;
    }
    if (!name) return;
    if (seen[name]) return;
    seen[name] = true;
    result.push(name);
  }

  if (!input) {
    return result;
  }

  if (typeof input === 'string') {
    addName(input);
    return result;
  }

  if (Array.isArray(input)) {
    for (var i = 0; i < input.length; i++) {
      addName(input[i]);
    }
    return result;
  }

  if (typeof input === 'object') {
    if (typeof input.roomName === 'string' || typeof input.name === 'string') {
      addName(input);
      return result;
    }
    for (var key in input) {
      if (!BeeToolbox.hasOwn(input, key)) continue;
      addName(input[key]);
      if (looksLikeRoomName(key)) {
        addName(key);
      }
    }
  }

  return result;
}

function looksLikeRoomName(name) {
  if (typeof name !== 'string') return false;
  if (name.length < 4) return false;
  var first = name.charAt(0);
  if (first !== 'W' && first !== 'E') return false;
  if (name.indexOf('N') === -1 && name.indexOf('S') === -1) return false;
  return true;
}

function defaultTaskForRole(role) {
  if (!role) return undefined;
  return ROLE_DEFAULT_TASK[role];
}

function needBuilder(room, cache) {
  if (!room) return 0;
  cache = cache || prepareTickCaches();

  var roomSiteCounts = cache.roomSiteCounts || Object.create(null);
  var totalSites = roomSiteCounts[room.name] || 0;

  var remoteNames;
  if (RoadPlanner && typeof RoadPlanner.getActiveRemoteRooms === 'function') {
    remoteNames = normalizeRemoteRooms(RoadPlanner.getActiveRemoteRooms(room));
  } else {
    remoteNames = cache.remotesByHome[room.name] || [];
  }

  for (var i = 0; i < remoteNames.length; i++) {
    var remoteRoomName = remoteNames[i];
    totalSites += roomSiteCounts[remoteRoomName] || 0;
  }

  return totalSites;
}

function calculateBodyCost(body) {
  if (!body || !body.length) return 0;
  var cost = 0;
  for (var i = 0; i < body.length; i++) {
    var part = body[i];
    cost += BODYPART_COST[part] || 0;
  }
  return cost;
}

function getBuilderBodyConfigs() {
  if (GLOBAL_CACHE.builderBodyConfigs) {
    return GLOBAL_CACHE.builderBodyConfigs;
  }
  var result = [];
  if (spawnLogic && spawnLogic.configurations && typeof spawnLogic.configurations.length === 'number') {
    for (var i = 0; i < spawnLogic.configurations.length; i++) {
      var entry = spawnLogic.configurations[i];
      if (!entry || entry.task !== 'builder') continue;
      var bodies = entry.body;
      if (Array.isArray(bodies)) {
        for (var j = 0; j < bodies.length; j++) {
          result.push(bodies[j]);
        }
      }
      break;
    }
  }
  GLOBAL_CACHE.builderBodyConfigs = result;
  return result;
}

function determineBuilderFailureReason(available, capacity) {
  var configs = getBuilderBodyConfigs();
  if (!configs.length) {
    return 'BODY_INVALID';
  }
  var minCost = null;
  var capacityFits = false;
  var availableFits = false;
  for (var i = 0; i < configs.length; i++) {
    var body = configs[i];
    var cost = calculateBodyCost(body);
    if (!cost) continue;
    if (minCost === null || cost < minCost) {
      minCost = cost;
    }
    if (cost <= capacity) {
      capacityFits = true;
    }
    if (cost <= available) {
      availableFits = true;
    }
  }
  if (minCost === null) {
    return 'BODY_INVALID';
  }
  if (!capacityFits) {
    return 'ENERGY_OVER_CAPACITY';
  }
  if (!availableFits) {
    return 'ENERGY_LOW_AVAILABLE';
  }
  return 'OTHER_FAIL';
}

function ensureSquadMemoryRecord(squadId) {
  var id = squadId || 'Alpha';
  if (!Memory.squads) Memory.squads = {};
  if (!Memory.squads[id]) {
    Memory.squads[id] = { targetId: null, targetAt: 0, anchor: null, anchorAt: 0 };
  }
  var bucket = Memory.squads[id];
  if (!bucket.desiredRoles) bucket.desiredRoles = {};
  if (!bucket.roleOrder || !bucket.roleOrder.length) bucket.roleOrder = ['CombatMelee', 'CombatArcher', 'CombatMedic'];
  if (!bucket.minReady || bucket.minReady < 1) bucket.minReady = 1;
  if (!bucket.members) bucket.members = bucket.members || {};
  return bucket;
}

function chooseHomeRoom(targetRoom, roomsOwned, preferred) {
  if (preferred && Game.rooms[preferred] && Game.rooms[preferred].controller && Game.rooms[preferred].controller.my) {
    return preferred;
  }
  if (!roomsOwned || !roomsOwned.length || !BeeToolbox || !BeeToolbox.isValidRoomName(targetRoom)) {
    return preferred || null;
  }
  var best = preferred || null;
  var bestDist = Infinity;
  for (var i = 0; i < roomsOwned.length; i++) {
    var room = roomsOwned[i];
    if (!room || !room.controller || !room.controller.my) continue;
    var dist = BeeToolbox.safeLinearDistance(room.name, targetRoom, true);
    if (dist < bestDist) {
      bestDist = dist;
      best = room.name;
    }
  }
  return best || preferred || null;
}

function gatherSquadCensus(squadId) {
  var counts = Object.create(null);
  var total = 0;
  var name;

  for (name in Game.creeps) {
    if (!BeeToolbox.hasOwn(Game.creeps, name)) continue;
    var creep = Game.creeps[name];
    if (!creep || !creep.memory || creep.memory.squadId !== squadId) continue;
    var role = creep.memory.squadRole || creep.memory.task || creep.memory.role;
    if (!role) continue;
    counts[role] = (counts[role] || 0) + 1;
    total += 1;
  }

  for (name in Memory.creeps) {
    if (!BeeToolbox.hasOwn(Memory.creeps, name)) continue;
    if (Game.creeps[name]) continue;
    var mem = Memory.creeps[name];
    if (!mem || mem.squadId !== squadId) continue;
    var mrole = mem.squadRole || mem.task || mem.role;
    if (!mrole) continue;
    counts[mrole] = (counts[mrole] || 0) + 1;
    total += 1;
  }

  return { counts: counts, total: total };
}

function deriveSquadDesiredRoles(intel, bucket) {
  var score = (intel && typeof intel.threatScore === 'number') ? intel.threatScore : 0;
  var details = (intel && intel.details) ? intel.details : {};
  var melee = 1;
  var medic = 1;
  var archer = 0;

  if (details.hasRanged || score >= 10) {
    archer = 1;
  }
  if (details.hasHostileTower || score >= 18) {
    melee = 2;
    medic = Math.max(medic, 2);
  }
  if (details.hasHeal) {
    medic = Math.max(medic, 2);
  }
  if (score >= 22 || (details.hasRanged && details.hasHostileTower)) {
    archer = Math.max(archer, 2);
  }

  var desired = Object.create(null);
  desired.CombatMelee = melee;
  desired.CombatMedic = medic;
  if (archer > 0) {
    desired.CombatArcher = archer;
  }

  bucket.desiredRoles = desired;
  var order = ['CombatMelee'];
  if (archer > 0) {
    order.push('CombatArcher');
  }
  order.push('CombatMedic');
  bucket.roleOrder = order;

  var total = melee + medic + (archer > 0 ? archer : 0);
  bucket.minReady = total > 0 ? total : 1;

  return desired;
}

function selectNextSquadRole(bucket, desired, counts) {
  var order = (bucket && bucket.roleOrder && bucket.roleOrder.length)
    ? bucket.roleOrder
    : ['CombatMelee', 'CombatArcher', 'CombatMedic'];
  for (var i = 0; i < order.length; i++) {
    var role = order[i];
    var need = desired[role] || 0;
    if (need <= 0) continue;
    var have = counts[role] || 0;
    if (have < need) {
      return role;
    }
  }
  return null;
}

function buildSquadSpawnPlans(cache) {
  var plansByHome = Object.create(null);
  if (!SquadFlagManager || typeof SquadFlagManager.getActiveSquads !== 'function') {
    return plansByHome;
  }

  var roomsOwned = (cache && cache.roomsOwned) || [];
  var active = SquadFlagManager.getActiveSquads({ ownedRooms: roomsOwned }) || [];

  for (var i = 0; i < active.length; i++) {
    var intel = active[i];
    if (!intel) continue;
    var id = intel.squadId || 'Alpha';
    var bucket = ensureSquadMemoryRecord(id);
    if (intel.rallyPos) {
      bucket.rally = { x: intel.rallyPos.x, y: intel.rallyPos.y, roomName: intel.rallyPos.roomName };
    }
    if (intel.targetRoom) {
      bucket.targetRoom = intel.targetRoom;
    }
    bucket.home = chooseHomeRoom(intel.targetRoom, roomsOwned, bucket.home || intel.homeRoom);

    var desired = deriveSquadDesiredRoles(intel, bucket);
    var census = gatherSquadCensus(id);
    var nextRole = selectNextSquadRole(bucket, desired, census.counts);

    var totalNeeded = 0;
    var key;
    for (key in desired) {
      if (!BeeToolbox.hasOwn(desired, key)) continue;
      totalNeeded += desired[key] || 0;
    }
    if (totalNeeded > 0) {
      bucket.minReady = totalNeeded;
    }

    if (!nextRole) {
      continue;
    }

    var home = bucket.home || chooseHomeRoom(intel.targetRoom, roomsOwned, null);
    if (!home && roomsOwned.length) {
      home = roomsOwned[0].name;
    }
    if (!home) {
      continue;
    }

    if (!plansByHome[home]) {
      plansByHome[home] = [];
    }
    plansByHome[home].push({
      squadId: id,
      role: nextRole,
      homeRoom: home,
      targetRoom: intel.targetRoom,
      threatScore: intel.threatScore || 0,
      details: intel.details || null,
      desired: desired,
      counts: census.counts,
      totalNeeded: totalNeeded,
      rallyPos: intel.rallyPos
    });
  }

  for (var homeRoom in plansByHome) {
    if (!BeeToolbox.hasOwn(plansByHome, homeRoom)) continue;
    plansByHome[homeRoom].sort(function (a, b) {
      return (b.threatScore || 0) - (a.threatScore || 0);
    });
  }

  return plansByHome;
}

function trySpawnSquadMember(spawner, plan) {
  if (!spawner || !plan) {
    return 'failed';
  }
  var room = spawner.room;
  if (!room) {
    return 'failed';
  }

  var available = (spawnLogic && typeof spawnLogic.Calculate_Spawn_Resource === 'function')
    ? spawnLogic.Calculate_Spawn_Resource(spawner)
    : (room.energyAvailable || 0);
  var body = (spawnLogic && typeof spawnLogic.getBodyForTask === 'function')
    ? spawnLogic.getBodyForTask(plan.role, available)
    : [];
  var cost = calculateBodyCost(body);

  if (!body.length || cost > available) {
    return 'waiting';
  }

  if (Game.cpu && Game.cpu.bucket != null && Game.cpu.bucket < 500) {
    return 'waiting';
  }

  if (!spawnLogic || typeof spawnLogic.Generate_Creep_Name !== 'function') {
    return 'failed';
  }

  var name = spawnLogic.Generate_Creep_Name(plan.role);
  if (!name) {
    return 'failed';
  }

  var homeRoom = plan.homeRoom || room.name;
  var memory = {
    role: 'squad',
    squadRole: plan.role,
    squadId: plan.squadId,
    task: plan.role,
    home: homeRoom,
    state: 'rally',
    targetRoom: plan.targetRoom,
    bornTask: plan.role,
    birthBody: body.slice()
  };

  var result = spawner.spawnCreep(body, name, { memory: memory });
  if (result === OK) {
    var bucket = ensureSquadMemoryRecord(plan.squadId);
    bucket.home = homeRoom;
    bucket.lastSpawnTick = Game.time;
    bucket.lastSpawnRole = plan.role;
    if (plan.totalNeeded > 0) {
      bucket.minReady = plan.totalNeeded;
    }
    hiveLog.info('🛡️[Squad ' + plan.squadId + '] Spawning ' + plan.role + ' @ RCL' + ((room.controller && room.controller.level) || 0) + ' (cost ~' + cost + ')');
    return 'spawned';
  }

  if (result === ERR_NOT_ENOUGH_ENERGY) {
    return 'waiting';
  }

  return 'failed';
}

function logBuilderSpawnBlock(spawner, room, builderSites, reason, available, capacity, builderFailLog) {
  if (!room || builderSites <= 0) {
    return;
  }
  var roomName = room.name || null;
  if (!roomName) {
    return;
  }
  var lastLogTick = builderFailLog[roomName] || 0;
  if ((Game.time - lastLogTick) < 50) {
    return;
  }
  builderFailLog[roomName] = Game.time;
  var spawnName = (spawner && spawner.name) ? spawner.name : 'spawn';
  var message = '[' + spawnName + '] builder wanted: sites=' + builderSites + ' reason=' + reason + ' (avail/cap ' + available + '/' + capacity + ')';
  hiveLog.info(message);
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

  manageRoom: function (room, cache) {
    if (!room) return;
    if (RoomPlanner && typeof RoomPlanner.ensureSites === 'function') {
      RoomPlanner.ensureSites(room, cache);
    }
    if (RoadPlanner && typeof RoadPlanner.ensureRemoteRoads === 'function') {
      RoadPlanner.ensureRemoteRoads(room, cache);
    }
  },

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

  assignTask: function (creep) {
    if (!creep || !creep.memory) return;
    if (creep.memory.task) return;
    if (creep.memory.role === 'squad') return;
    var defaultTask = defaultTaskForRole(creep.memory.role);
    if (defaultTask) {
      creep.memory.task = defaultTask;
    }
  },

  manageSpawns: function (cache) {
    var roleCounts = cloneCounts(cache.roleCounts);
    var lunaCountsByHome = cloneCounts(cache.lunaCountsByHome);
    var spawns = cache.spawns || [];
    var builderFailLog = GLOBAL_CACHE.builderFailLog || (GLOBAL_CACHE.builderFailLog = Object.create(null));
    var squadPlansByRoom = buildSquadSpawnPlans(cache);
    var roomSpawned = Object.create(null);
    var defaultTaskOrder = [
      'queen',
      'baseharvest',
      'courier',
      'builder',
      'upgrader',
      'repair',
      'luna',
      'scout',
      'CombatArcher',
      'CombatMelee',
      'CombatMedic',
      'Dismantler',
      'Trucker',
      'Claimer',
      
    ];

    for (var i = 0; i < spawns.length; i++) {
      var spawner = spawns[i];
      if (!spawner) continue;

      var room = spawner.room;
      if (!room) continue;

      if (roomSpawned[room.name]) {
        continue;
      }

      var builderSites = needBuilder(room, cache);
      var builderLimit = builderSites > 0 ? 1 : 0;

      var spawnResource = (spawnLogic && typeof spawnLogic.Calculate_Spawn_Resource === 'function')
        ? spawnLogic.Calculate_Spawn_Resource(spawner)
        : (room.energyAvailable || 0);
      var spawnCapacity = room.energyCapacityAvailable || spawnResource;

      if (spawner.spawning) {
        if (builderLimit > 0) {
          logBuilderSpawnBlock(spawner, room, builderSites, 'SPAWN_BUSY', spawnResource, spawnCapacity, builderFailLog);
        }
        continue;
      }

      var planQueue = squadPlansByRoom[room.name];
      if (!planQueue) {
        planQueue = [];
        squadPlansByRoom[room.name] = planQueue;
      }

      if (!roomSpawned[room.name] && planQueue.length) {
        var planOutcome = trySpawnSquadMember(spawner, planQueue[0]);
        if (planOutcome === 'spawned') {
          planQueue.shift();
          roomSpawned[room.name] = true;
          continue;
        }
        if (planOutcome === 'waiting') {
          roomSpawned[room.name] = true;
          continue;
        }
      }

      if (roomSpawned[room.name]) {
        continue;
      }

      var taskOrder = defaultTaskOrder.slice();
      if (builderLimit > 0) {
        var builderIndex = -1;
        var queenIndex = -1;
        for (var orderIdx = 0; orderIdx < taskOrder.length; orderIdx++) {
          if (taskOrder[orderIdx] === 'builder') {
            builderIndex = orderIdx;
          }
          if (taskOrder[orderIdx] === 'queen') {
            queenIndex = orderIdx;
          }
        }
        if (builderIndex !== -1) {
          taskOrder.splice(builderIndex, 1);
          if (queenIndex === -1) {
            queenIndex = 0;
          }
          taskOrder.splice(queenIndex + 1, 0, 'builder');
        }
      }

      var workerTaskLimits = {
        baseharvest: 2,
        courier: 1,
        queen: 2,
        upgrader: 2,
        builder: builderLimit,
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

      for (var orderPos = 0; orderPos < taskOrder.length; orderPos++) {
        var task = taskOrder[orderPos];
        if (!BeeToolbox.hasOwn(workerTaskLimits, task)) continue;
        var limit = workerTaskLimits[task] | 0;
        if (!limit) {
          if (task === 'builder' && builderLimit > 0) {
            logBuilderSpawnBlock(spawner, room, builderSites, 'LIMIT_ZERO', spawnResource, spawnCapacity, builderFailLog);
          }
          continue;
        }

        var current = (task === 'luna')
          ? (lunaCountsByHome[room.name] || 0)
          : (roleCounts[task] || 0);
        if (current >= limit) {
          if (task === 'builder' && builderLimit > 0) {
            logBuilderSpawnBlock(spawner, room, builderSites, 'ROLE_LIMIT_REACHED', spawnResource, spawnCapacity, builderFailLog);
          }
          continue;
        }

        if (!spawnLogic || typeof spawnLogic.Spawn_Worker_Bee !== 'function') {
          if (task === 'builder' && builderLimit > 0) {
            logBuilderSpawnBlock(spawner, room, builderSites, 'OTHER_FAIL', spawnResource, spawnCapacity, builderFailLog);
          }
          continue;
        }

        var didSpawn = false;
        if (task === 'builder') {
          didSpawn = spawnLogic.Spawn_Worker_Bee(spawner, task, spawnResource);
          if (didSpawn !== true && builderLimit > 0) {
            var reason = determineBuilderFailureReason(spawnResource, spawnCapacity);
            logBuilderSpawnBlock(spawner, room, builderSites, reason, spawnResource, spawnCapacity, builderFailLog);
          }
        } else {
          didSpawn = spawnLogic.Spawn_Worker_Bee(spawner, task, spawnResource);
        }

        if (didSpawn === true) {
          roleCounts[task] = (roleCounts[task] || 0) + 1;
          if (task === 'luna') {
            lunaCountsByHome[room.name] = (lunaCountsByHome[room.name] || 0) + 1;
          }
          roomSpawned[room.name] = true;
          break;
        }
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
