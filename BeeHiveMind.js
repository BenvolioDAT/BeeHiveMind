
"use strict";

var CoreLogger = require('core.logger');
var spawnLogic = require('spawn.logic');
var roleWorkerBee = require('role.Worker_Bee');
var RoomPlanner = require('Planner.Room');
var RoadPlanner = require('Planner.Road');
var TradeEnergy = require('Trade.Energy');
var TaskLuna = require('Task.Luna');
var TaskBaseHarvest = require('Task.BaseHarvest');
var BeeVisuals = require('BeeVisuals');
var BeeToolbox = require('BeeToolbox');
var SquadFlagManager = require('SquadFlagManager');
var TaskSquad = require('./Task.Squad');
var TaskCombatArcher = require('Task.CombatArcher');
var TaskCombatMelee = require('Task.CombatMelee');
var TaskCombatMedic = require('Task.CombatMedic');

var LOG_LEVEL = CoreLogger.LOG_LEVEL;
var hiveLog = CoreLogger.createLogger('HiveMind', LOG_LEVEL.BASIC);

var HARVESTER_CFG = BeeToolbox && BeeToolbox.HARVESTER_CFG
  ? BeeToolbox.HARVESTER_CFG
  : { MAX_WORK: 6, RENEWAL_TTL: 150, EMERGENCY_TTL: 50 };

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

function calculateBodyCost(body) {
  if (!body || !body.length) return 0;
  var total = 0;
  for (var i = 0; i < body.length; i++) {
    total += BODYPART_COST[body[i]] || 0;
  }
  return total;
}

function determineHarvesterRoom(memory, creep) {
  if (!memory) memory = {};
  var keys = ['home', '_home', 'spawnRoom', 'origin', 'targetRoom'];
  for (var i = 0; i < keys.length; i++) {
    var value = memory[keys[i]];
    if (typeof value === 'string' && value.length) {
      return value;
    }
  }
  if (creep && creep.room && creep.room.name) {
    return creep.room.name;
  }
  return null;
}

function buildHarvesterIntelCache() {
  var store = GLOBAL_CACHE.harvesterIntel;
  var tick = Game.time | 0;
  if (!store || store.tick !== tick) {
    store = { tick: tick, perRoom: Object.create(null) };

    for (var creepName in Game.creeps) {
      if (!BeeToolbox.hasOwn(Game.creeps, creepName)) continue;
      var creep = Game.creeps[creepName];
      if (!creep || !creep.memory || creep.memory.task !== 'baseharvest') continue;
      var roomName = determineHarvesterRoom(creep.memory, creep);
      if (!roomName) continue;
      var info = store.perRoom[roomName];
      if (!info) {
        info = { active: 0, hatching: 0, lowestTtl: null, highestCost: 0 };
        store.perRoom[roomName] = info;
      }
      info.active += 1;
      var ttl = creep.ticksToLive;
      if (typeof ttl === 'number') {
        if (info.lowestTtl === null || ttl < info.lowestTtl) {
          info.lowestTtl = ttl;
        }
      }
      var birthBody = (creep.memory && creep.memory.birthBody && creep.memory.birthBody.length)
        ? creep.memory.birthBody
        : null;
      if (!birthBody || !birthBody.length) {
        birthBody = [];
        var b;
        for (b = 0; b < creep.body.length; b++) {
          birthBody.push(creep.body[b].type);
        }
      }
      var cost = calculateBodyCost(birthBody);
      if (cost > info.highestCost) {
        info.highestCost = cost;
      }
    }

    if (Memory.creeps) {
      for (var name in Memory.creeps) {
        if (!BeeToolbox.hasOwn(Memory.creeps, name)) continue;
        if (Game.creeps[name]) continue;
        var mem = Memory.creeps[name];
        if (!mem || mem.task !== 'baseharvest') continue;
        var memRoom = determineHarvesterRoom(mem, null);
        if (!memRoom) continue;
        var memInfo = store.perRoom[memRoom];
        if (!memInfo) {
          memInfo = { active: 0, hatching: 0, lowestTtl: null, highestCost: 0 };
          store.perRoom[memRoom] = memInfo;
        }
        memInfo.hatching += 1;
        var memCost = calculateBodyCost(mem.birthBody || mem.body || []);
        if (memCost > memInfo.highestCost) {
          memInfo.highestCost = memCost;
        }
      }
    }

    GLOBAL_CACHE.harvesterIntel = store;
  }
  return store.perRoom;
}

function ensureHarvesterIntelForRoom(room) {
  if (!room) {
    return { active: 0, hatching: 0, lowestTtl: null, highestCost: 0, sources: 0, desiredCount: 0, coverage: 0 };
  }
  var perRoom = buildHarvesterIntelCache();
  var info = perRoom[room.name];
  if (!info) {
    info = { active: 0, hatching: 0, lowestTtl: null, highestCost: 0 };
    perRoom[room.name] = info;
  }
  if (!info.sourcesComputed) {
    var sources = room.find(FIND_SOURCES) || [];
    var sourceCount = sources.length || 0;
    info.sources = sourceCount;
    info.desiredCount = sourceCount > 0 ? sourceCount : 1;
    info.sourcesComputed = true;
  }
  info.coverage = (info.active | 0) + (info.hatching | 0);
  return info;
}

function planHarvesterSpawn(room, spawnEnergy, spawnCapacity, intel) {
  var plan = { shouldSpawn: false, body: [], cost: 0 };
  if (!room || !spawnLogic) return plan;

  var targetBody = (typeof spawnLogic.getBestHarvesterBody === 'function')
    ? spawnLogic.getBestHarvesterBody(room)
    : spawnLogic.Generate_BaseHarvest_Body(spawnCapacity);
  var targetCost = calculateBodyCost(targetBody);
  var fallbackBody = (typeof spawnLogic.Generate_BaseHarvest_Body === 'function')
    ? spawnLogic.Generate_BaseHarvest_Body(spawnEnergy)
    : [];
  var fallbackCost = calculateBodyCost(fallbackBody);

  var desired = intel && typeof intel.desiredCount === 'number' ? intel.desiredCount : 1;
  var coverage = intel && typeof intel.coverage === 'number' ? intel.coverage : 0;
  var active = intel && typeof intel.active === 'number' ? intel.active : 0;
  var hatching = intel && typeof intel.hatching === 'number' ? intel.hatching : 0;
  var lowestTtl = (intel && typeof intel.lowestTtl === 'number') ? intel.lowestTtl : null;
  var highestCost = intel && typeof intel.highestCost === 'number' ? intel.highestCost : 0;

  if (coverage < desired) {
    var canAffordTarget = targetBody && targetBody.length && spawnEnergy >= targetCost && targetCost > 0;
    var chosenBody = canAffordTarget ? targetBody : fallbackBody;
    var chosenCost = canAffordTarget ? targetCost : fallbackCost;
    if (chosenBody && chosenBody.length && chosenCost > 0 && spawnEnergy >= chosenCost) {
      plan.shouldSpawn = true;
      plan.body = chosenBody;
      plan.cost = chosenCost;
    }
    return plan;
  }

  if (active <= 0) {
    return plan;
  }

  if (lowestTtl === null || lowestTtl > HARVESTER_CFG.RENEWAL_TTL) {
    return plan;
  }

  if (hatching > 0) {
    return plan;
  }

  var canUpgrade = targetCost > highestCost;
  if (targetBody && targetBody.length && targetCost > 0 && spawnEnergy >= targetCost) {
    plan.shouldSpawn = true;
    plan.body = targetBody;
    plan.cost = targetCost;
    return plan;
  }

  if (!canUpgrade && fallbackBody && fallbackBody.length && fallbackCost > 0 && spawnEnergy >= fallbackCost && fallbackCost === targetCost) {
    plan.shouldSpawn = true;
    plan.body = fallbackBody;
    plan.cost = fallbackCost;
    return plan;
  }

  if (lowestTtl <= HARVESTER_CFG.EMERGENCY_TTL && fallbackBody && fallbackBody.length && fallbackCost > 0 && spawnEnergy >= fallbackCost) {
    plan.shouldSpawn = true;
    plan.body = fallbackBody;
    plan.cost = fallbackCost;
    return plan;
  }

  if (!canUpgrade && targetCost > 0 && spawnEnergy >= targetCost && targetBody && targetBody.length) {
    plan.shouldSpawn = true;
    plan.body = targetBody;
    plan.cost = targetCost;
  }

  return plan;
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
    if (task === 'luna') {
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
    var remoteSeen = Object.create(null);
    if (RoadPlanner && typeof RoadPlanner.getActiveRemoteRooms === 'function') {
      var activeRemotes = normalizeRemoteRooms(RoadPlanner.getActiveRemoteRooms(ownedRoom));
      for (var ar = 0; ar < activeRemotes.length; ar++) {
        addRemoteCandidate(remoteNames, remoteSeen, activeRemotes[ar]);
      }
    }
    gatherRemotesFromAssignments(ownedRoom.name, remoteNames, remoteSeen);
    gatherRemotesFromLedger(ownedRoom.name, remoteNames, remoteSeen);
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

function addRemoteCandidate(target, seen, remoteName) {
  if (!remoteName || typeof remoteName !== 'string') return;
  if (!looksLikeRoomName(remoteName)) return;
  if (seen[remoteName]) return;
  seen[remoteName] = true;
  target.push(remoteName);
}

function processAssignmentRecord(homeName, key, record, target, seen) {
  if (!homeName || !record) return;
  if (typeof record === 'string') {
    if (key === homeName && looksLikeRoomName(record)) {
      addRemoteCandidate(target, seen, record);
    } else if (looksLikeRoomName(key) && record === homeName) {
      addRemoteCandidate(target, seen, key);
    }
    return;
  }
  if (Array.isArray(record)) {
    for (var i = 0; i < record.length; i++) {
      processAssignmentRecord(homeName, key, record[i], target, seen);
    }
    return;
  }
  if (typeof record !== 'object') return;

  var remoteName = null;
  if (typeof record.roomName === 'string') remoteName = record.roomName;
  else if (typeof record.remote === 'string') remoteName = record.remote;
  else if (typeof record.targetRoom === 'string') remoteName = record.targetRoom;
  else if (typeof record.room === 'string') remoteName = record.room;
  else if (looksLikeRoomName(key)) remoteName = key;

  var assignedHome = null;
  if (typeof record.home === 'string') assignedHome = record.home;
  else if (typeof record.homeRoom === 'string') assignedHome = record.homeRoom;
  else if (typeof record.spawn === 'string') assignedHome = record.spawn;
  else if (typeof record.origin === 'string') assignedHome = record.origin;
  else if (typeof record.base === 'string') assignedHome = record.base;
  else if (!looksLikeRoomName(key)) assignedHome = key;

  if (assignedHome === homeName && typeof remoteName === 'string') {
    addRemoteCandidate(target, seen, remoteName);
  }

  for (var nestedKey in record) {
    if (!BeeToolbox.hasOwn(record, nestedKey)) continue;
    if (nestedKey === 'roomName' || nestedKey === 'remote' || nestedKey === 'targetRoom' || nestedKey === 'room' ||
        nestedKey === 'home' || nestedKey === 'homeRoom' || nestedKey === 'spawn' || nestedKey === 'origin' || nestedKey === 'base') {
      continue;
    }
    processAssignmentRecord(homeName, nestedKey, record[nestedKey], target, seen);
  }
}

function gatherRemotesFromAssignments(homeName, target, seen) {
  if (!homeName || !Memory.remoteAssignments) return;
  var assignments = Memory.remoteAssignments;
  for (var key in assignments) {
    if (!BeeToolbox.hasOwn(assignments, key)) continue;
    processAssignmentRecord(homeName, key, assignments[key], target, seen);
  }
}

function gatherRemotesFromLedger(homeName, target, seen) {
  if (!homeName || !Memory.remotes) return;
  for (var remoteName in Memory.remotes) {
    if (!BeeToolbox.hasOwn(Memory.remotes, remoteName)) continue;
    if (remoteName === 'version') continue;
    var entry = Memory.remotes[remoteName];
    if (!entry || typeof entry !== 'object') continue;
    var ledgerHome = null;
    if (typeof entry.home === 'string') ledgerHome = entry.home;
    else if (typeof entry.homeRoom === 'string') ledgerHome = entry.homeRoom;
    else if (typeof entry.origin === 'string') ledgerHome = entry.origin;
    if (ledgerHome !== homeName) continue;
    var finalRemote = null;
    if (typeof entry.roomName === 'string') finalRemote = entry.roomName;
    else finalRemote = remoteName;
    addRemoteCandidate(target, seen, finalRemote);
  }
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
  if (typeof bucket.spawnCooldownUntil !== 'number') bucket.spawnCooldownUntil = 0;
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

/* === FIX: Squad spawn blocking === */
function buildSquadSpawnPlans(cache) {
  var plansByHome = Object.create(null);
  if (!SquadFlagManager || typeof SquadFlagManager.getActiveSquads !== 'function') {
    return plansByHome;
  }

  var roomsOwned = (cache && cache.roomsOwned) || [];
  var active = SquadFlagManager.getActiveSquads({ ownedRooms: roomsOwned }) || [];
  var intelQueue = [];
  var seenTargets = Object.create(null);

  for (var i = 0; i < active.length; i++) {
    var intel = active[i];
    if (!intel) continue;
    if (intel.targetRoom) {
      seenTargets[intel.targetRoom] = true;
    }
    intelQueue.push(intel);
  }

  // ensures combat plans trigger from scout intel
  var fallbackIntel = [];
  if (BeeToolbox && typeof BeeToolbox.consumeAttackTargets === 'function') {
    fallbackIntel = BeeToolbox.consumeAttackTargets({ maxAge: 2500, requeueInterval: 200 }) || [];
  } else if (Memory.attackTargets && typeof Memory.attackTargets === 'object') {
    fallbackIntel = [];
    for (var tn in Memory.attackTargets) {
      if (!Object.prototype.hasOwnProperty.call(Memory.attackTargets, tn)) continue;
      var raw = Memory.attackTargets[tn];
      if (!raw || typeof raw !== 'object') continue;
      var owner = raw.owner || null;
      if (owner && BeeToolbox && typeof BeeToolbox.isEnemyUsername === 'function' && !BeeToolbox.isEnemyUsername(owner)) {
        continue;
      }
      fallbackIntel.push(raw);
    }
  }

  for (var f = 0; f < fallbackIntel.length; f++) {
    var rec = fallbackIntel[f];
    if (!rec) continue;
    var roomName = rec.roomName || rec.targetRoom || rec.room || null;
    if (!roomName || (BeeToolbox && typeof BeeToolbox.isValidRoomName === 'function' && !BeeToolbox.isValidRoomName(roomName))) {
      continue;
    }
    if (seenTargets[roomName]) {
      continue;
    }
    seenTargets[roomName] = true;
    var detailInfo = {
      hasRanged: rec.type === 'creep',
      hasAttack: rec.type === 'creep',
      hasHeal: false,
      hasHostileTower: rec.type === STRUCTURE_TOWER,
      hasHostileSpawn: rec.type === STRUCTURE_SPAWN,
      hostileCount: rec.count || 0
    };
    var baseScore = 10;
    if (rec.type === 'creep') {
      baseScore = Math.max(baseScore, 10 + ((rec.count || 0) * 3));
    } else if (rec.type === STRUCTURE_TOWER) {
      baseScore = Math.max(baseScore, 20);
    } else if (rec.type === STRUCTURE_SPAWN) {
      baseScore = Math.max(baseScore, 16);
    } else if (rec.type === 'controller') {
      baseScore = Math.max(baseScore, 18);
    }
    intelQueue.push({
      squadId: 'Scout' + roomName,
      targetRoom: roomName,
      rallyPos: new RoomPosition(25, 25, roomName),
      threatScore: baseScore,
      details: detailInfo,
      source: rec.source || 'scout'
    });
  }

  for (i = 0; i < intelQueue.length; i++) {
    intel = intelQueue[i];
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

    if (bucket.spawnCooldownUntil && bucket.spawnCooldownUntil > Game.time) {
      // Skip planning while cooldown is active so failed squads do not block other spawns.
      continue;
    }

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

/* === FIX: Squad spawn blocking === */
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
  var capacity = room.energyCapacityAvailable || available;
  var body = (spawnLogic && typeof spawnLogic.getBodyForTask === 'function')
    ? spawnLogic.getBodyForTask(plan.role, available)
    : [];
  var cost = calculateBodyCost(body);

  if (!body.length || cost <= 0) {
    // Check the best possible body at full capacity to decide if the plan is ever viable.
    var bestBody = (spawnLogic && typeof spawnLogic.getBodyForTask === 'function')
      ? spawnLogic.getBodyForTask(plan.role, capacity)
      : [];
    var bestCost = calculateBodyCost(bestBody);
    if (!bestBody.length || bestCost <= 0 || bestCost > capacity) {
      return 'skip';
    }
    body = bestBody;
    cost = bestCost;
  }

  if (cost > capacity) {
    // Abort plans that can never fit within the room's energy capacity.
    return 'skip';
  }

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
    // Clear any previous cooldown once spawning succeeds so follow-up members queue normally.
    bucket.spawnCooldownUntil = 0;
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

  if (TaskLuna && typeof TaskLuna.getHomeQuota === 'function') {
    var quota = TaskLuna.getHomeQuota(room.name);
    if (quota > 0) return quota;
  }

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

    if (TaskLuna && typeof TaskLuna.tick === 'function') {
      TaskLuna.tick(cache);
    }

    var ownedRooms = cache.roomsOwned || [];
    for (var i = 0; i < ownedRooms.length; i++) {
      this.manageRoom(ownedRooms[i], cache);
    }

    this.runCreeps(cache);

    if (TaskLuna && typeof TaskLuna.report === 'function') {
      TaskLuna.report(cache);
    }

    this.manageSpawns(cache);

    if (TradeEnergy && typeof TradeEnergy.runAll === 'function') {
      TradeEnergy.runAll();
    }

    this.runVisuals(cache);
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

  runVisuals: function (cache) {
    if (!BeeVisuals) return;
    var rooms = (cache && cache.roomsOwned) || [];
    var remoteUi = (TaskLuna && TaskLuna.LUNA_UI) ? TaskLuna.LUNA_UI : null;
    var baseUi = (TaskBaseHarvest && TaskBaseHarvest.BASE_UI) ? TaskBaseHarvest.BASE_UI : null;
    for (var i = 0; i < rooms.length; i++) {
      var room = rooms[i];
      if (!room || !room.name) continue;
      if (typeof BeeVisuals.clearRoomHUD === 'function') {
        BeeVisuals.clearRoomHUD(room.name);
      }
      if (remoteUi && remoteUi.enabled && typeof BeeVisuals.drawRemoteHUD === 'function' && TaskLuna && typeof TaskLuna.getVisualLedgersForHome === 'function') {
        var ledgers = TaskLuna.getVisualLedgersForHome(room.name) || [];
        for (var r = 0; r < ledgers.length; r++) {
          var ledger = ledgers[r];
          if (!ledger) continue;
          var anchorX = (remoteUi.anchor && remoteUi.anchor.x != null) ? remoteUi.anchor.x : 1;
          var anchorYBase = (remoteUi.anchor && remoteUi.anchor.y != null) ? remoteUi.anchor.y : 1;
          var anchorY = anchorYBase + (r * 1.1);
          var options = {
            drawBudget: remoteUi.drawBudget,
            showPaths: remoteUi.showPaths,
            showLegend: remoteUi.showLegend,
            palette: remoteUi.palette,
            scale: remoteUi.scale,
            anchor: { x: anchorX, y: anchorY },
            ownerRoomName: room.name
          };
          BeeVisuals.drawRemoteHUD(ledger.roomName || ledger.remote || ledger.name, ledger, options);
        }
      }
      if (baseUi && baseUi.enabled && typeof BeeVisuals.drawBaseHarvestHUD === 'function' && TaskBaseHarvest && typeof TaskBaseHarvest.getBaseSeatsForVisual === 'function') {
        var seats = TaskBaseHarvest.getBaseSeatsForVisual(room.name) || [];
        var baseOptions = {
          drawBudget: baseUi.drawBudget,
          showPaths: baseUi.showPaths,
          palette: baseUi.palette,
          scale: baseUi.scale
        };
        BeeVisuals.drawBaseHarvestHUD(room.name, seats, baseOptions);
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
    var harvesterIntelByRoom = Object.create(null);
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

      var harvesterIntel = harvesterIntelByRoom[room.name];
      if (!harvesterIntel) {
        harvesterIntel = ensureHarvesterIntelForRoom(room);
        harvesterIntelByRoom[room.name] = harvesterIntel;
      }

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
        if (TaskLuna && typeof TaskLuna.noteSpawnBlocked === 'function') {
          try {
            TaskLuna.noteSpawnBlocked(room.name, 'SPAWN_BUSY', Game.time + 1, spawnResource, spawnCapacity);
          } catch (lunaNoteErr) {}
        }
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
        var currentPlan = planQueue[0];
        var planOutcome = trySpawnSquadMember(spawner, currentPlan);
        if (planOutcome === 'spawned') {
          planQueue.shift();
          roomSpawned[room.name] = true;
          continue;
        }
        if (planOutcome === 'waiting') {
          roomSpawned[room.name] = true;
          continue;
        }
        if (planOutcome === 'skip') {
          // Drop impossible plans for a while so they stop hogging the spawn slot.
          planQueue.shift();
          var skipBucket = ensureSquadMemoryRecord(currentPlan.squadId);
          skipBucket.spawnCooldownUntil = Game.time + 50;
          continue;
        }
        if (planOutcome === 'failed') {
          // Back off briefly after an unexpected failure so other roles can spawn.
          planQueue.shift();
          var planBucket = ensureSquadMemoryRecord(currentPlan.squadId);
          planBucket.spawnCooldownUntil = Game.time + 10;
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
        baseharvest: harvesterIntel.desiredCount || 1,
        courier: 1,
        queen: 2,
        upgrader: 2,
        repair: 0,
        luna: determineLunaQuota(room, cache),
        builder: builderLimit,
        scout: 2,
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
          : (task === 'baseharvest' ? (harvesterIntel.coverage || 0) : (roleCounts[task] || 0));
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
        if (task === 'luna') {
          var lunaPlan = null;
          if (TaskLuna && typeof TaskLuna.planSpawnForRoom === 'function') {
            try {
              lunaPlan = TaskLuna.planSpawnForRoom(spawner, {
                availableEnergy: spawnResource,
                capacityEnergy: spawnCapacity,
                current: current,
                limit: limit
              });
            } catch (planErr) {
              lunaPlan = null;
            }
          }
          if (!lunaPlan || lunaPlan.shouldSpawn !== true) {
            continue;
          }
          var spawnResult;
          if (TaskLuna && typeof TaskLuna.spawnFromPlan === 'function') {
            try {
              spawnResult = TaskLuna.spawnFromPlan(spawner, lunaPlan);
            } catch (spawnErr) {
              spawnResult = spawnErr && typeof spawnErr === 'number' ? spawnErr : ERR_INVALID_TARGET;
            }
          } else {
            spawnResult = spawnLogic.Spawn_Worker_Bee(spawner, task, spawnResource);
          }
          if (spawnResult === OK || spawnResult === true) {
            didSpawn = true;
          } else if (spawnResult === ERR_BUSY) {
            roomSpawned[room.name] = true;
            continue;
          } else {
            continue;
          }
        } else if (task === 'baseharvest') {
          var harvesterPlan = planHarvesterSpawn(room, spawnResource, spawnCapacity, harvesterIntel);
          if (!harvesterPlan.shouldSpawn) {
            continue;
          }
          var overrideBody = harvesterPlan.body && harvesterPlan.body.slice ? harvesterPlan.body.slice() : harvesterPlan.body;
          var harvesterMemory = { home: room.name, _harvesterBodyOverride: overrideBody };
          didSpawn = spawnLogic.Spawn_Worker_Bee(spawner, task, spawnResource, harvesterMemory);
          if (didSpawn === true) {
            harvesterIntel.hatching = (harvesterIntel.hatching || 0) + 1;
            harvesterIntel.coverage = (harvesterIntel.coverage || 0) + 1;
            if (!harvesterIntel.highestCost || harvesterPlan.cost > harvesterIntel.highestCost) {
              harvesterIntel.highestCost = harvesterPlan.cost;
            }
          }
        } else if (task === 'builder') {
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
  
  manageRemoteOps: function () {
    // Reserved for future remote task coordination.
  },

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
