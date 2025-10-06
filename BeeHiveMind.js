// CHANGES:
// - Adjusted spawn loop to stop breaking on failed attempts and improved builder prioritization per tick.
// - Added builder spawn fallback coordination with diagnostics and cached body helpers.
// - Maintained construction tracking utilities for logging and quota calculations.
// - Refined builder demand calculations to only consider owned construction in home and remote rooms.

"use strict";

var CoreLogger = require('core.logger');
var spawnLogic = require('spawn.logic');
var roleWorkerBee = require('role.Worker_Bee');
var RoomPlanner = require('Planner.Room');
var RoadPlanner = require('Planner.Road');
var TradeEnergy = require('Trade.Energy');
var TaskLuna = require('Task.Luna');
var BeeToolbox = require('BeeToolbox');
var Blackboard = require('AI.Blackboard');
var EconomyAI = require('AI.Economy');
var ExpansionAI = require('AI.Expansion');

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

function ensureAiCache() {
  if (!GLOBAL_CACHE.aiState) {
    GLOBAL_CACHE.aiState = { tick: -1, rooms: Object.create(null) };
  }
  var ai = GLOBAL_CACHE.aiState;
  if (ai.tick !== (Game.time | 0)) {
    ai.tick = Game.time | 0;
    ai.rooms = Object.create(null);
  }
  return ai;
}

function structureTypeForPlan(type) {
  if (type === 'container') return STRUCTURE_CONTAINER;
  if (type === 'link') return STRUCTURE_LINK;
  if (type === 'road') return STRUCTURE_ROAD;
  return null;
}

function applyConstructionPlans(room, cache, plans) {
  if (!room || !plans || !plans.length) return;
  if (!cache) cache = prepareTickCaches();
  var totalSites = cache.totalSites || 0;
  var limit = 90;
  for (var i = 0; i < plans.length; i++) {
    if (totalSites >= limit) break;
    var plan = plans[i];
    if (!plan || !plan.pos) continue;
    var structureType = structureTypeForPlan(plan.type);
    if (!structureType) continue;
    var pos = plan.pos;
    if (typeof pos.x !== 'number' || typeof pos.y !== 'number' || typeof pos.roomName !== 'string') continue;
    var targetRoom = Game.rooms[pos.roomName];
    if (!targetRoom) continue;
    var terrain = targetRoom.getTerrain();
    if (terrain.get(pos.x, pos.y) === TERRAIN_MASK_WALL) continue;
    var existing = targetRoom.lookForAt(LOOK_STRUCTURES, pos.x, pos.y);
    var skip = false;
    for (var s = 0; s < existing.length; s++) {
      if (existing[s].structureType === structureType) { skip = true; break; }
    }
    if (skip) continue;
    var sites = targetRoom.lookForAt(LOOK_CONSTRUCTION_SITES, pos.x, pos.y);
    for (var cs = 0; cs < sites.length; cs++) {
      if (sites[cs].structureType === structureType) { skip = true; break; }
    }
    if (skip) continue;
    var rc = targetRoom.createConstructionSite(pos.x, pos.y, structureType);
    if (rc === OK) {
      totalSites += 1;
    }
  }
  cache.totalSites = totalSites;
}

function storeLinkPlan(room, linkPlan) {
  if (!linkPlan) return;
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};
  var src = Array.isArray(linkPlan.sourceIds) ? linkPlan.sourceIds : [];
  var sink = Array.isArray(linkPlan.sinkIds) ? linkPlan.sinkIds : [];
  var existing = Memory.rooms[room.name].aiLinkPlan;
  var same = false;
  if (existing && Array.isArray(existing.sourceIds) && Array.isArray(existing.sinkIds)) {
    if (existing.sourceIds.length === src.length && existing.sinkIds.length === sink.length) {
      same = true;
      for (var i = 0; i < src.length; i++) {
        if (existing.sourceIds[i] !== src[i]) { same = false; break; }
      }
      if (same) {
        for (var j = 0; j < sink.length; j++) {
          if (existing.sinkIds[j] !== sink[j]) { same = false; break; }
        }
      }
    }
  }
  if (same) {
    existing.updated = Game.time | 0;
    return;
  }
  Memory.rooms[room.name].aiLinkPlan = {
    sourceIds: src.slice(),
    sinkIds: sink.slice(),
    updated: Game.time | 0
  };
}

function normalizeExpansionRole(role) {
  if (!role) return null;
  var str = String(role);
  var lower = str.toLowerCase();
  if (lower === 'remoteharvest' || lower === 'remoteharvester' || lower === 'luna') return 'luna';
  if (lower === 'trucker') return 'Trucker';
  if (lower === 'claimer') return 'Claimer';
  if (lower === 'scout') return 'scout';
  if (lower === 'courier') return 'courier';
  if (lower === 'builder') return 'builder';
  if (lower === 'baseharvest') return 'baseharvest';
  if (lower === 'upgrader') return 'upgrader';
  return str;
}

function reorderTasks(taskOrder, spawnWeights) {
  if (!spawnWeights) return taskOrder;
  var list = [];
  for (var i = 0; i < taskOrder.length; i++) {
    var task = taskOrder[i];
    var weight = spawnWeights[task];
    if (typeof weight !== 'number') {
      weight = spawnWeights[normalizeExpansionRole(task)];
    }
    var priority = 1;
    if (typeof weight === 'number') {
      var bounded = BeeToolbox.bound(weight, 0.1, 5);
      priority = 1 / bounded;
    }
    list.push({ task: task, priority: priority, index: i });
  }
  list.sort(function (a, b) {
    if (a.priority === b.priority) {
      return a.index - b.index;
    }
    return a.priority - b.priority;
  });
  var result = [];
  for (var j = 0; j < list.length; j++) {
    result.push(list[j].task);
  }
  return result;
}

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

/**
 * Normalize remote room descriptors into an array of room name strings.
 * @param {*} input Source data describing remote rooms.
 * @returns {string[]} Array of remote room names without duplicates.
 * @sideeffects None.
 * @cpu O(n) over provided descriptors.
 * @memory Allocates arrays for normalized output.
 */
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

/**
 * Basic heuristic to detect Screeps room name strings.
 * @param {string} name Candidate value.
 * @returns {boolean} True when the string resembles a room name.
 */
function looksLikeRoomName(name) {
  if (typeof name !== 'string') return false;
  if (name.length < 4) return false;
  var first = name.charAt(0);
  if (first !== 'W' && first !== 'E') return false;
  if (name.indexOf('N') === -1 && name.indexOf('S') === -1) return false;
  return true;
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
 * Determine how many construction sites require builder attention.
 * @param {Room} room Owned room under evaluation.
 * @param {object} cache Per-tick cache data.
 * @returns {number} Count of construction sites in home and remotes.
 * @sideeffects None.
 * @cpu O(remotes) to inspect cached lists.
 * @memory Temporary counters only.
 */
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

/**
 * Compute the total energy cost of a body definition.
 * @param {string[]} body Array of body part constants.
 * @returns {number} Aggregate energy cost for the body.
 * @sideeffects None.
 * @cpu O(parts) per evaluation.
 * @memory None.
 */
function calculateBodyCost(body) {
  if (!body || !body.length) return 0;
  var cost = 0;
  for (var i = 0; i < body.length; i++) {
    var part = body[i];
    cost += BODYPART_COST[part] || 0;
  }
  return cost;
}

/**
 * Fetch cached builder body configurations from spawn logic.
 * @returns {Array} Array of builder body arrays.
 * @sideeffects Caches the configuration on the global cache for reuse.
 * @cpu Low; iterates exported configuration list once per reset.
 * @memory Stores references to configuration arrays.
 */
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

/**
 * Determine the failure reason when a builder cannot be spawned.
 * @param {number} available Current room energy available.
 * @param {number} capacity Room energy capacity available.
 * @returns {string} Diagnostic reason identifier.
 * @sideeffects None.
 * @cpu O(configs) for builder body inspection.
 * @memory None.
 */
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

    this.runAI(cache);

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
   * Execute AI planning stages and cache decisions for this tick.
   * @param {object} cache Shared per-tick cache data.
   * @returns {void}
   */
  runAI: function (cache) {
    var aiCache = ensureAiCache();
    var rooms = (cache && cache.roomsOwned) ? cache.roomsOwned : [];
    for (var i = 0; i < rooms.length; i++) {
      var room = rooms[i];
      if (!room) continue;

      var kpis = null;
      if (Blackboard && typeof Blackboard.tick === 'function') {
        kpis = Blackboard.tick(room);
      }
      if (!kpis && Blackboard && typeof Blackboard.get === 'function') {
        kpis = Blackboard.get(room.name);
      }

      var economy = { spawnWeights: {}, buildPlans: [], linkPlan: null };
      if (EconomyAI && typeof EconomyAI.decideEconomy === 'function') {
        economy = EconomyAI.decideEconomy(room, kpis);
      }

      var expansionTargets = [];
      if (ExpansionAI && typeof ExpansionAI.rankExpansionTargets === 'function') {
        expansionTargets = ExpansionAI.rankExpansionTargets(room, kpis) || [];
      }

      var bestTarget = expansionTargets.length ? expansionTargets[0] : null;
      var stable = false;
      if (kpis) {
        var storagePct = kpis.storageFillPct || 0;
        var defense = kpis.defenseReadiness || {};
        var hostiles = !!defense.activeHostiles;
        stable = (storagePct >= 0.25) && !hostiles;
      }

      var plan = null;
      if (bestTarget && bestTarget.score > 0 && stable && ExpansionAI && typeof ExpansionAI.planFOB === 'function') {
        plan = ExpansionAI.planFOB(room, bestTarget);
      }

      aiCache.rooms[room.name] = {
        kpis: kpis,
        economy: economy,
        expansionTargets: expansionTargets,
        expansionPlan: plan,
        bestTarget: bestTarget,
        stable: stable
      };

      if (Memory.ai && Memory.ai.rooms && Memory.ai.rooms[room.name]) {
        if (plan) {
          Memory.ai.rooms[room.name].expansion = {
            target: bestTarget ? bestTarget.roomName : null,
            score: bestTarget ? bestTarget.score : 0,
            updated: Game.time | 0
          };
        } else if (Memory.ai.rooms[room.name].expansion) {
          delete Memory.ai.rooms[room.name].expansion;
        }
      }
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
    var aiCache = ensureAiCache();
    var aiRoom = aiCache.rooms[room.name] || null;
    if (aiRoom && aiRoom.economy) {
      applyConstructionPlans(room, cache, aiRoom.economy.buildPlans);
      if (aiRoom.economy.linkPlan) {
        storeLinkPlan(room, aiRoom.economy.linkPlan);
      }
    }
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
    var aiCache = ensureAiCache();
    var builderFailLog = GLOBAL_CACHE.builderFailLog || (GLOBAL_CACHE.builderFailLog = Object.create(null));
    var defaultTaskOrder = [
      'queen',
      'baseharvest',
      'courier',
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
      'builder'
    ];

    for (var i = 0; i < spawns.length; i++) {
      var spawner = spawns[i];
      if (!spawner) continue;

      if (typeof spawnLogic.Spawn_Squad === 'function') {
        // Squad spawning left disabled by default; enable when configured externally.
      }

      var room = spawner.room;
      if (!room) continue;
      var aiRoomData = aiCache.rooms[room.name] || {};
      var spawnWeights = (aiRoomData.economy && aiRoomData.economy.spawnWeights) ? aiRoomData.economy.spawnWeights : null;
      var expansionPlan = aiRoomData.expansionPlan || null;

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
      taskOrder = reorderTasks(taskOrder, spawnWeights);

      var workerTaskLimits = {
        baseharvest: 2,
        courier: 1,
        queen: 2,
        upgrader: 4,
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

      if (spawnWeights) {
        for (var weightKey in spawnWeights) {
          if (!BeeToolbox.hasOwn(spawnWeights, weightKey)) continue;
          var weightVal = spawnWeights[weightKey];
          if (typeof weightVal !== 'number') continue;
          var normalizedKey = normalizeExpansionRole(weightKey);
          if (!normalizedKey) continue;
          if (!BeeToolbox.hasOwn(workerTaskLimits, normalizedKey)) continue;
          var baseLimit = workerTaskLimits[normalizedKey] || 0;
          if (baseLimit <= 0 && weightVal <= 0) {
            workerTaskLimits[normalizedKey] = 0;
            continue;
          }
          if (baseLimit <= 0 && weightVal > 1) {
            workerTaskLimits[normalizedKey] = Math.round(weightVal);
            continue;
          }
          var boundedWeight = BeeToolbox.bound(weightVal, 0, 3);
          var adjustedLimit = Math.round(baseLimit * boundedWeight);
          if (baseLimit > 0 && adjustedLimit < 1 && boundedWeight > 0) adjustedLimit = 1;
          workerTaskLimits[normalizedKey] = adjustedLimit;
        }
      }

      if (expansionPlan && expansionPlan.spawnQueue && expansionPlan.spawnQueue.length) {
        for (var sq = 0; sq < expansionPlan.spawnQueue.length; sq++) {
          var order = expansionPlan.spawnQueue[sq];
          if (!order) continue;
          var taskName = normalizeExpansionRole(order.role);
          var desiredCount = order.count | 0;
          if (!taskName || desiredCount <= 0) continue;
          if (!BeeToolbox.hasOwn(workerTaskLimits, taskName)) {
            workerTaskLimits[taskName] = desiredCount;
          } else {
            if (workerTaskLimits[taskName] < desiredCount) {
              workerTaskLimits[taskName] = desiredCount;
            }
          }
        }
      }

      if (builderLimit > 0 && workerTaskLimits.builder < builderLimit) {
        workerTaskLimits.builder = builderLimit;
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
