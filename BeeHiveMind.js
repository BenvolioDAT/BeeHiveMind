
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

var ECON_CFG = BeeToolbox && BeeToolbox.ECON_CFG ? BeeToolbox.ECON_CFG : null;

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

var DYING_SOON_TTL = 60;
var DEFAULT_LUNA_PER_SOURCE = (TaskLuna && typeof TaskLuna.MAX_LUNA_PER_SOURCE === 'number')
  ? TaskLuna.MAX_LUNA_PER_SOURCE
  : 1;

var GLOBAL_CACHE = global.__BHM_CACHE || (global.__BHM_CACHE = { tick: -1 });

var ECONOMIC_ROLE_MAP = Object.freeze({
  baseharvest: true,
  courier: true,
  queen: true,
  builder: true,
  upgrader: true
});

function cloneCounts(source) {
  var result = Object.create(null);
  if (!source) return result;
  for (var key in source) {
    if (!BeeToolbox.hasOwn(source, key)) continue;
    result[key] = source[key];
  }
  return result;
}

function ensureEconomyRoomRecord(target, roomName) {
  if (!target || !roomName) {
    return null;
  }
  var record = target[roomName];
  if (!record) {
    record = {
      baseharvest: 0,
      courier: 0,
      queen: 0,
      builder: 0,
      upgrader: 0
    };
    target[roomName] = record;
  }
  return record;
}

function deriveEconomyDecisionState(room, harvesterIntel, economyMap) {
  var state = {
    hasHarvester: false,
    hasCourier: false,
    hasQueen: false,
    hasBuilder: false,
    hasUpgrader: false,
    storageHealthy: false,
    allEssentialPresent: false,
    recoveryMode: false,
    allowCombat: false,
    harvesterCount: 0,
    courierCount: 0,
    queenCount: 0,
    builderCount: 0,
    upgraderCount: 0,
    storageEnergy: 0,
    storageCapacity: 0
  };

  if (!room) {
    return state;
  }

  var roomName = room.name;
  var econCounts = economyMap && economyMap[roomName];
  var activeHarvesters = 0;
  var hatchingHarvesters = 0;
  var harvesterCount = 0;
  if (harvesterIntel) {
    activeHarvesters = harvesterIntel.active | 0;
    hatchingHarvesters = harvesterIntel.hatching | 0;
    harvesterCount = (harvesterIntel.coverage | 0);
  }
  state.harvesterCount = harvesterCount;
  state.harvesterActive = activeHarvesters;
  state.harvesterHatching = hatchingHarvesters;
  state.hasHarvester = harvesterCount > 0;

  if (econCounts) {
    state.courierCount = econCounts.courier | 0;
    state.queenCount = econCounts.queen | 0;
    state.builderCount = econCounts.builder | 0;
    state.upgraderCount = econCounts.upgrader | 0;
    state.hasCourier = state.courierCount > 0;
    state.hasQueen = state.queenCount > 0;
    state.hasBuilder = state.builderCount > 0;
    state.hasUpgrader = state.upgraderCount > 0;
  }

  var storageState = BeeToolbox.storageEnergyState(room);
  state.storageCapacity = storageState.capacity;
  state.storageEnergy = storageState.energy;
  var healthyRatio = (ECON_CFG && typeof ECON_CFG.STORAGE_HEALTHY_RATIO === 'number')
    ? ECON_CFG.STORAGE_HEALTHY_RATIO
    : 0.7;
  if (BeeToolbox.isStorageHealthy(room, healthyRatio)) {
    state.storageHealthy = true;
  }

  state.allEssentialPresent = state.hasHarvester && state.hasCourier && state.hasQueen && state.hasBuilder && state.hasUpgrader;
  state.recoveryMode = !state.hasHarvester || !state.hasCourier;
  // Combat spawning is only permitted when the economy is healthy or buffered by storage.
  state.allowCombat = !state.recoveryMode && (state.storageHealthy || state.allEssentialPresent);

  return state;
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

function determineBirthBody(mem, creep) {
  return (mem && mem.birthBody && mem.birthBody.slice)
    ? mem.birthBody
    : (creep && creep.body ? creep.body.map(function (part) { return part.type; }) : []);
}

function createHarvesterIntelRecord() {
  return { active: 0, hatching: 0, lowestTtl: null, highestCost: 0, sources: 0, desiredCount: 1, coverage: 0 };
}

function ensureHarvesterIntelForRoom(room, cache) {
  if (!room || !room.name) {
    return createHarvesterIntelRecord();
  }
  cache = cache || prepareTickCaches();
  var intelMap = cache.harvesterIntelByRoom;
  if (!intelMap) {
    intelMap = Object.create(null);
    cache.harvesterIntelByRoom = intelMap;
  }
  var info = intelMap[room.name];
  if (!info) {
    info = createHarvesterIntelRecord();
    intelMap[room.name] = info;
  }
  return info;
}

function planHarvesterSpawn(room, spawnEnergy, spawnCapacity, intel) {
  var plan = { shouldSpawn: false, body: [], cost: 0 };
  if (!room || !spawnLogic) return plan;

  var targetBody = (typeof spawnLogic.getBestHarvesterBody === 'function')
    ? spawnLogic.getBestHarvesterBody(room)
    : spawnLogic.Generate_BaseHarvest_Body(spawnCapacity);
  var targetCost = BeeToolbox.costOfBody(targetBody);
  var fallbackBody = (typeof spawnLogic.Generate_BaseHarvest_Body === 'function')
    ? spawnLogic.Generate_BaseHarvest_Body(spawnEnergy)
    : [];
  var fallbackCost = BeeToolbox.costOfBody(fallbackBody);

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
  var economyByRoom = Object.create(null);
  var harvesterIntelByRoom = Object.create(null);

  function getHarvesterIntelBucket(roomName) {
    if (!roomName) return null;
    var bucket = harvesterIntelByRoom[roomName];
    if (!bucket) {
      bucket = createHarvesterIntelRecord();
      harvesterIntelByRoom[roomName] = bucket;
    }
    return bucket;
  }

  for (var creepName in Game.creeps) {
    if (!BeeToolbox.hasOwn(Game.creeps, creepName)) continue;
    var creep = Game.creeps[creepName];
    if (!creep) continue;
    creeps.push(creep);

    if (!creep.memory) creep.memory = {};
    var creepMemory = creep.memory;
    var task = creepMemory.task;
    if (task === 'luna') {
      task = 'luna';
      creepMemory.task = 'luna';
    }

    var ttl = creep.ticksToLive;

    if (task === 'baseharvest') {
      var harvesterRoomName = determineHarvesterRoom(creepMemory, creep);
      if (harvesterRoomName) {
        var intelBucket = getHarvesterIntelBucket(harvesterRoomName);
        if (intelBucket) {
          intelBucket.active += 1;
          if (typeof ttl === 'number') {
            if (intelBucket.lowestTtl === null || ttl < intelBucket.lowestTtl) {
              intelBucket.lowestTtl = ttl;
            }
          }
          var birthBody = determineBirthBody(creepMemory, creep);
        var birthCost = BeeToolbox.costOfBody(birthBody);
          if (birthCost > intelBucket.highestCost) {
            intelBucket.highestCost = birthCost;
          }
        }
      }
    }

    if (typeof ttl === 'number' && ttl <= DYING_SOON_TTL) {
      continue;
    }

    var homeName = creepMemory.home || creepMemory._home || (creep.room ? creep.room.name : null);
    if (homeName && task) {
      var econRecord = ensureEconomyRoomRecord(economyByRoom, homeName);
      if (econRecord) {
        if (task === 'baseharvest') {
          econRecord.baseharvest += 1;
        } else if (task === 'courier') {
          econRecord.courier += 1;
        } else if (task === 'queen') {
          econRecord.queen += 1;
        } else if (task === 'builder') {
          econRecord.builder += 1;
        } else if (task === 'upgrader') {
          econRecord.upgrader += 1;
        }
      }
    }

    if (!task) continue;

    roleCounts[task] = (roleCounts[task] || 0) + 1;

    if (task === 'luna') {
      if (homeName) {
        lunaCountsByHome[homeName] = (lunaCountsByHome[homeName] || 0) + 1;
      }
    }
  }

  if (Memory.creeps) {
    for (var memName in Memory.creeps) {
      if (!BeeToolbox.hasOwn(Memory.creeps, memName)) continue;
      if (Game.creeps[memName]) continue;
      var mem = Memory.creeps[memName];
      if (!mem || mem.task !== 'baseharvest') continue;
      var memRoomName = determineHarvesterRoom(mem, null);
      if (!memRoomName) continue;
      var memIntel = getHarvesterIntelBucket(memRoomName);
      if (!memIntel) continue;
      memIntel.hatching += 1;
      var memBirthBody = determineBirthBody(mem, null);
      var memCost = BeeToolbox.costOfBody(memBirthBody);
      if (memCost > memIntel.highestCost) {
        memIntel.highestCost = memCost;
      }
    }
  }

  for (var ownedIndex = 0; ownedIndex < ownedRooms.length; ownedIndex++) {
    var ownedRoomObj = ownedRooms[ownedIndex];
    if (ownedRoomObj) {
      getHarvesterIntelBucket(ownedRoomObj.name);
    }
  }

  for (var intelRoomName in harvesterIntelByRoom) {
    if (!BeeToolbox.hasOwn(harvesterIntelByRoom, intelRoomName)) continue;
    var intelRecord = harvesterIntelByRoom[intelRoomName];
    var intelRoom = roomsMap[intelRoomName];
    var sourceCount = 0;
    if (intelRoom && typeof intelRoom.find === 'function') {
      var foundSources = intelRoom.find(FIND_SOURCES) || [];
      sourceCount = foundSources.length || 0;
    } else {
      var roomMemory = (Memory.rooms && Memory.rooms[intelRoomName]) ? Memory.rooms[intelRoomName] : null;
      if (roomMemory) {
        sourceCount = BeeToolbox.countSourcesInMemory(roomMemory);
        if (!sourceCount && roomMemory.sources && roomMemory.sources.length) {
          sourceCount = roomMemory.sources.length;
        }
      }
    }
    intelRecord.sources = sourceCount;
    intelRecord.desiredCount = sourceCount > 0 ? sourceCount : 1;
    intelRecord.coverage = (intelRecord.active | 0) + (intelRecord.hatching | 0);
  }

  cache.creeps = creeps;
  cache.roleCounts = roleCounts;
  cache.lunaCountsByHome = lunaCountsByHome;
  cache.economyByRoom = economyByRoom;
  cache.harvesterIntelByRoom = harvesterIntelByRoom;

  var siteCache = BeeToolbox.constructionSiteCache();
  cache.roomSiteCounts = siteCache.counts || Object.create(null);
  cache.totalSites = siteCache.list ? siteCache.list.length : 0;

  var remotesByHome = Object.create(null);
  for (var idx = 0; idx < ownedRooms.length; idx++) {
    var ownedRoom = ownedRooms[idx];
    var baseRemotes = null;
    if (RoadPlanner && typeof RoadPlanner.getActiveRemoteRooms === 'function') {
      baseRemotes = BeeToolbox.normalizeRemoteRooms(RoadPlanner.getActiveRemoteRooms(ownedRoom));
    }
    remotesByHome[ownedRoom.name] = BeeToolbox.collectHomeRemotes(ownedRoom.name, baseRemotes);
  }
  cache.remotesByHome = remotesByHome;

  return cache;
}

function defaultTaskForRole(role) {
  if (!role) return undefined;
  role = ('' + role).toLowerCase();
  var MAP = { queen: 'queen', scout: 'scout', repair: 'repair' };
  return MAP[role];
}

function needBuilder(room, cache) {
  if (!room) return 0;
  cache = cache || prepareTickCaches();

  var roomSiteCounts = cache.roomSiteCounts || Object.create(null);
  var totalSites = roomSiteCounts[room.name] || 0;

  var remoteNames;
  if (RoadPlanner && typeof RoadPlanner.getActiveRemoteRooms === 'function') {
    remoteNames = BeeToolbox.normalizeRemoteRooms(RoadPlanner.getActiveRemoteRooms(room));
  } else {
    remoteNames = cache.remotesByHome[room.name] || [];
  }

  for (var i = 0; i < remoteNames.length; i++) {
    var remoteRoomName = remoteNames[i];
    totalSites += roomSiteCounts[remoteRoomName] || 0;
  }

  return totalSites;
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
  var tierInfo = BeeToolbox.evaluateBodyTiers(configs, available, capacity);
  if (!tierInfo.tiers || !tierInfo.tiers.length) {
    return 'BODY_INVALID';
  }
  if (!tierInfo.capacityBody.length || tierInfo.capacityCost > capacity) {
    return 'ENERGY_OVER_CAPACITY';
  }
  if (!tierInfo.availableBody.length || tierInfo.availableCost > available) {
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
  var result = { counts: Object.create(null), total: 0 };
  if (!squadId || !BeeToolbox || typeof BeeToolbox.tallyCreeps !== 'function') {
    return result;
  }
  var tally = BeeToolbox.tallyCreeps({
    includeMemory: true,
    filter: function (memory) {
      return memory && memory.squadId === squadId;
    },
    valueSelector: function (memory) {
      if (!memory) return null;
      return memory.squadRole || memory.task || memory.role || null;
    }
  });
  if (tally && tally.counts) {
    result.counts = tally.counts;
  }
  if (tally && typeof tally.total === 'number') {
    result.total = tally.total;
  }
  return result;
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

  var economyStates = GLOBAL_CACHE.economyStateByRoom;
  if (economyStates) {
    var economyState = economyStates[room.name];
    if (economyState && !economyState.allowCombat) {
      // Spawn is intentionally idled until the economy is back online.
      return 'waiting';
    }
  }

  var available = (spawnLogic && typeof spawnLogic.Calculate_Spawn_Resource === 'function')
    ? spawnLogic.Calculate_Spawn_Resource(spawner)
    : (room.energyAvailable || 0);
  var capacity = room.energyCapacityAvailable || available;
  var body = (spawnLogic && typeof spawnLogic.getBodyForTask === 'function')
    ? spawnLogic.getBodyForTask(plan.role, available)
    : [];
  var cost = BeeToolbox.costOfBody(body);

  if (!body.length || cost <= 0) {
    // Check the best possible body at full capacity to decide if the plan is ever viable.
    var bestBody = (spawnLogic && typeof spawnLogic.getBodyForTask === 'function')
      ? spawnLogic.getBodyForTask(plan.role, capacity)
      : [];
    var bestCost = BeeToolbox.costOfBody(bestBody);
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

  var cpuThreshold = (ECON_CFG && typeof ECON_CFG.CPU_MIN_BUCKET === 'number')
    ? ECON_CFG.CPU_MIN_BUCKET
    : 500;
  if (!BeeToolbox.isCpuBucketHealthy(cpuThreshold)) {
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
  if (!BeeToolbox.shouldLogThrottled(builderFailLog, roomName, 50)) {
    return;
  }
  var spawnName = (spawner && spawner.name) ? spawner.name : 'spawn';
  var message = '[' + spawnName + '] builder wanted: sites=' + builderSites + ' reason=' + reason + ' (avail/cap ' + available + '/' + capacity + ')';
  hiveLog.info(message);
}

function determineLunaQuota(room, cache) {
  if (!room) return 0;

  if (TaskLuna && typeof TaskLuna.getHomeQuota === 'function') {
    var quota = TaskLuna.getHomeQuota(room.name);
    if (quota > 0) return quota;
  }

  var remotes = cache.remotesByHome[room.name] || [];
  if (remotes.length === 0) return 0;
  var summary = null;
  if (BeeToolbox && typeof BeeToolbox.summarizeRemotes === 'function') {
    summary = BeeToolbox.summarizeRemotes(remotes);
  }
  var totalSources = summary && typeof summary.totalSources === 'number'
    ? summary.totalSources
    : remotes.length;
  if (totalSources <= 0) {
    totalSources = remotes.length;
  }
  var active = summary && typeof summary.activeAssignments === 'number'
    ? summary.activeAssignments
    : 0;
  return Math.max(totalSources * DEFAULT_LUNA_PER_SOURCE, active);
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
    var harvesterIntelByRoom = cache.harvesterIntelByRoom;
    if (!harvesterIntelByRoom) {
      harvesterIntelByRoom = Object.create(null);
      cache.harvesterIntelByRoom = harvesterIntelByRoom;
    }
    var economyStates = GLOBAL_CACHE.economyStateByRoom || (GLOBAL_CACHE.economyStateByRoom = Object.create(null));
    var economyCountsByRoom = cache.economyByRoom || Object.create(null);
    // Spawn decision order prioritizes economic recovery before utility or combat units.
    var defaultTaskOrder = [
      'baseharvest',
      'courier',
      'queen',
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
        harvesterIntel = ensureHarvesterIntelForRoom(room, cache);
        harvesterIntelByRoom[room.name] = harvesterIntel;
      }

      // Derive per-room economic health so we can gate non-essential spawns.
      var economyState = deriveEconomyDecisionState(room, harvesterIntel, economyCountsByRoom);
      economyStates[room.name] = economyState;

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
        if (!economyState.allowCombat) {
          // Economy triage pauses combat recruitment until base harvesters and couriers are online again.
        } else {
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
        queen: 1,
        upgrader: 2,
        repair: 0,
        luna: determineLunaQuota(room, cache),
        builder: builderLimit,
        scout: 1,
        CombatArcher: 0,
        CombatMelee: 0,
        CombatMedic: 0,
        Dismantler: 0,
        Trucker: 0,
        Claimer: 0
      };

      if (!economyState.hasQueen) {
        workerTaskLimits.queen = Math.max(workerTaskLimits.queen || 0, 1);
      }
      if (!economyState.hasCourier) {
        workerTaskLimits.courier = Math.max(workerTaskLimits.courier || 0, 1);
      }
      if (!economyState.hasHarvester) {
        workerTaskLimits.baseharvest = Math.max(workerTaskLimits.baseharvest || 0, 1);
      }

      // Recovery mode clamps the spawn table to economic lifelines until energy flow stabilizes.
      if (economyState.recoveryMode) {
        for (var limitKey in workerTaskLimits) {
          if (!BeeToolbox.hasOwn(workerTaskLimits, limitKey)) continue;
          if (!ECONOMIC_ROLE_MAP[limitKey]) {
            workerTaskLimits[limitKey] = 0;
          }
        }
      }

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
