'use strict';

var Logger = require('core.logger');
var LOG_LEVEL = Logger.LOG_LEVEL;
var taskLog = Logger.createLogger('TaskManager', LOG_LEVEL.BASIC);
var BeeToolbox = require('BeeToolbox');

var TaskIdle = require('./Task.Idle');
var TaskBaseHarvest = require('./Task.BaseHarvest');
var TaskLuna = require('./Task.Luna');
var TaskBuilder = require('./Task.Builder');
var TaskCourier = require('./Task.Courier');
var TaskQueen = require('./Task.Queen');
var TaskScout = require('./Task.Scout');
var TaskRepair = require('./Task.Repair');
var TaskUpgrader = require('./Task.Upgrader');
var TaskCombatArcher = require('./Task.CombatArcher');
var TaskCombatMedic = require('./Task.CombatMedic');
var TaskCombatMelee = require('./Task.CombatMelee');
var TaskDismantler = require('./Task.Dismantler');
var TaskTrucker = require('Task.Trucker');
var TaskClaimer = require('Task.Claimer');

var DEFAULT_NEEDS = Object.freeze({
  baseharvest: 2,
  builder: 2,
  repair: 1,
  courier: 2,
  upgrader: 2,
  scout: 1
});

var DEFAULT_PRIORITY = Object.freeze([
  'baseharvest',
  'courier',
  'builder',
  'upgrader',
  'repair',
  'luna',
  'scout',
  'CombatMelee',
  'CombatArcher',
  'CombatMedic',
  'Trucker',
  'Claimer'
]);

// Controller-level specific task mix keeps priorities aligned with colony growth.
var RCL_NEED_PROFILES = Object.freeze([
  {
    min: 1,
    max: 2,
    tier: 'early',
    needs: {
      baseharvest: 3,
      upgrader: 2,
      courier: 1,
      builder: 0,
      repair: 0,
      scout: 0
    },
    priority: ['baseharvest', 'upgrader', 'courier', 'builder']
  },
  {
    min: 3,
    max: 4,
    tier: 'developing',
    needs: {
      baseharvest: 3,
      upgrader: 2,
      courier: 1,
      builder: 1,
      repair: 1,
      scout: 1
    },
    priority: ['baseharvest', 'courier', 'builder', 'repair', 'upgrader', 'scout']
  },
  {
    min: 5,
    max: 6,
    tier: 'expansion',
    needs: {
      baseharvest: 3,
      upgrader: 2,
      courier: 2,
      builder: 2,
      repair: 1,
      scout: 1,
      luna: 2,
      Trucker: 1
    },
    priority: ['baseharvest', 'courier', 'builder', 'upgrader', 'repair', 'luna', 'Trucker', 'scout']
  },
  {
    min: 7,
    max: 8,
    tier: 'late',
    needs: {
      baseharvest: 3,
      upgrader: 3,
      courier: 2,
      builder: 2,
      repair: 2,
      scout: 1,
      luna: 3,
      Trucker: 1,
      CombatMelee: 1,
      CombatArcher: 1,
      CombatMedic: 1
    },
    priority: ['baseharvest', 'courier', 'builder', 'upgrader', 'repair', 'luna', 'Trucker', 'CombatMelee', 'CombatArcher', 'CombatMedic', 'scout']
  }
]);

var TASK_REGISTRY = Object.create(null);

function registerTask(name, module) {
  if (!name || !module || typeof module.run !== 'function') {
    if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
      taskLog.debug('Skipped registering invalid task module for', name);
    }
    return;
  }
  TASK_REGISTRY[name] = module;
}

registerTask('baseharvest', TaskBaseHarvest);
registerTask('luna', TaskLuna);
registerTask('builder', TaskBuilder);
registerTask('courier', TaskCourier);
registerTask('queen', TaskQueen);
registerTask('scout', TaskScout);
registerTask('repair', TaskRepair);
registerTask('upgrader', TaskUpgrader);
registerTask('CombatMedic', TaskCombatMedic);
registerTask('CombatMelee', TaskCombatMelee);
registerTask('CombatArcher', TaskCombatArcher);
registerTask('Dismantler', TaskDismantler);
registerTask('idle', TaskIdle);
registerTask('Trucker', TaskTrucker);
registerTask('Claimer', TaskClaimer);

var cache = (global.__taskManagerCache = global.__taskManagerCache || {
  tick: -1,
  counts: null,
  needs: null,
  needsTick: -1
});

function getTaskCounts() {
  if (cache.tick === Game.time && cache.counts) return cache.counts;
  cache.tick = Game.time;
  var counts = Object.create(null);
  for (var creepName in Game.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Game.creeps, creepName)) continue;
    var creep = Game.creeps[creepName];
    if (!creep || !creep.memory) {
      counts.idle = (counts.idle || 0) + 1;
      continue;
    }
    var task = creep.memory.task || 'idle';
    counts[task] = (counts[task] || 0) + 1;
  }
  cache.counts = counts;
  return cache.counts;
}

function mergeNeeds(defaults, overrides) {
  var result = Object.create(null);
  var key;
  for (key in defaults) {
    if (Object.prototype.hasOwnProperty.call(defaults, key)) {
      result[key] = defaults[key];
    }
  }
  for (key in overrides) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) {
      result[key] = overrides[key];
    }
  }
  return result;
}

function getNeedProfileForRcl(rcl) {
  if (!rcl) {
    return RCL_NEED_PROFILES.length ? RCL_NEED_PROFILES[0] : null;
  }
  for (var i = 0; i < RCL_NEED_PROFILES.length; i++) {
    var profile = RCL_NEED_PROFILES[i];
    if (rcl >= profile.min && rcl <= profile.max) {
      return profile;
    }
  }
  return RCL_NEED_PROFILES.length ? RCL_NEED_PROFILES[RCL_NEED_PROFILES.length - 1] : null;
}

function baseNeedsForRcl(rcl) {
  var profile = getNeedProfileForRcl(rcl);
  if (!profile) {
    return mergeNeeds(DEFAULT_NEEDS, {});
  }
  var overrides = Object.create(null);
  if (profile.needs) {
    for (var key in profile.needs) {
      if (Object.prototype.hasOwnProperty.call(profile.needs, key)) {
        overrides[key] = profile.needs[key];
      }
    }
  }
  if (profile.tier === 'early' && rcl <= 1) {
    overrides.courier = 0;
  }
  return mergeNeeds(DEFAULT_NEEDS, overrides);
}

function colonyNeeds(context) {
  if (!context && cache.needsTick === Game.time && cache.needs) return cache.needs;

  var overrides = (Memory.colonyNeeds && Memory.colonyNeeds.overrides) || {};
  var plannerStates = BeeToolbox.getAllPlannerStates() || {};
  var aggregateNeeds = Object.create(null);
  var highestRcl = 0;
  var manualSquad = false;
  if (Memory && Memory.squadFlags) {
    if (Memory.squadFlags.force === true) manualSquad = true;
    if (Memory.squadFlags.global && Memory.squadFlags.global.force === true) manualSquad = true;
  }

  for (var roomName in plannerStates) {
    if (!Object.prototype.hasOwnProperty.call(plannerStates, roomName)) continue;
    var plan = plannerStates[roomName];
    var room = Game.rooms && Game.rooms[roomName];
    var rcl = plan && typeof plan.rcl === 'number' ? plan.rcl : BeeToolbox.getRoomRcl(room);
    if (rcl > highestRcl) highestRcl = rcl;
    var roomNeeds = baseNeedsForRcl(rcl);

    var storageEntry = plan && plan.structures ? plan.structures[STRUCTURE_STORAGE] : null;
    var hasStorage = storageEntry && (storageEntry.existing | 0) > 0;
    var storageEnergy = 0;
    if (room && room.storage) {
      hasStorage = true;
      storageEnergy = (room.storage.store && room.storage.store[RESOURCE_ENERGY]) || 0;
    }
    var cpuHealthy = (!Game || !Game.cpu || typeof Game.cpu.bucket !== 'number') ? true : (Game.cpu.bucket >= 4000);
    if (!hasStorage) {
      roomNeeds.queen = 0;
    }
    if (!hasStorage || storageEnergy < 20000 || !cpuHealthy) {
      roomNeeds.luna = 0;
      roomNeeds.Trucker = 0;
    }

    var hostiles = 0;
    if (room) {
      var hostileList = room.find ? room.find(FIND_HOSTILE_CREEPS) : [];
      hostiles = hostileList ? hostileList.length : 0;
    }
    if (hostiles === 0 && !manualSquad) {
      roomNeeds.CombatMelee = 0;
      roomNeeds.CombatArcher = 0;
      roomNeeds.CombatMedic = 0;
    }

    for (var key in roomNeeds) {
      if (!Object.prototype.hasOwnProperty.call(roomNeeds, key)) continue;
      aggregateNeeds[key] = (aggregateNeeds[key] || 0) + (roomNeeds[key] | 0);
    }
  }

  if (highestRcl === 0) {
    highestRcl = BeeToolbox.getHighestOwnedRcl();
    var fallbackNeeds = baseNeedsForRcl(highestRcl);
    for (var fb in fallbackNeeds) {
      if (!Object.prototype.hasOwnProperty.call(fallbackNeeds, fb)) continue;
      aggregateNeeds[fb] = (aggregateNeeds[fb] || 0) + (fallbackNeeds[fb] | 0);
    }
  }

  var needsConfig = mergeNeeds(aggregateNeeds, overrides);
  var counts = getTaskCounts();
  var shortage = Object.create(null);

  for (var taskKey in needsConfig) {
    if (!Object.prototype.hasOwnProperty.call(needsConfig, taskKey)) continue;
    var required = needsConfig[taskKey] | 0;
    var current = counts[taskKey] | 0;
    if (current < required) {
      shortage[taskKey] = required - current;
    }
  }

  if (!context) {
    cache.needsTick = Game.time;
    cache.needs = shortage;
  }
  return shortage;
}

function getTaskModule(taskName) {
  if (!taskName) return null;
  if (TASK_REGISTRY[taskName]) return TASK_REGISTRY[taskName];
  var lowered = String(taskName).toLowerCase();
  if (TASK_REGISTRY[lowered]) return TASK_REGISTRY[lowered];
  var capitalized = taskName.charAt(0).toUpperCase() + taskName.slice(1);
  if (TASK_REGISTRY[capitalized]) return TASK_REGISTRY[capitalized];
  return null;
}

function getPriorityList() {
  if (Memory.colonyNeeds && Memory.colonyNeeds.priorityOrder && Memory.colonyNeeds.priorityOrder.length) {
    return Memory.colonyNeeds.priorityOrder;
  }
  var profile = getNeedProfileForRcl(BeeToolbox.getHighestOwnedRcl());
  if (profile && profile.priority && profile.priority.length) {
    return profile.priority;
  }
  return DEFAULT_PRIORITY;
}

module.exports = {
  run: function (creep) {
    if (!creep) return;
    var taskName = creep.memory && creep.memory.task;
    var taskModule = getTaskModule(taskName);

    if (taskModule) {
      taskModule.run(creep);
    } else {
      if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
        taskLog.debug('No task module registered for', taskName, 'requested by', creep.name);
      }
      creep.say('No task!');
    }
  },

  isTaskNeeded: function (taskName, context) {
    var needs = colonyNeeds(context);
    return (needs[taskName] || 0) > 0;
  },

  getHighestPriorityTask: function (creep, context) {
    var needs = colonyNeeds(context);
    var priorityList = getPriorityList();
    for (var i = 0; i < priorityList.length; i++) {
      var task = priorityList[i];
      if ((needs[task] | 0) > 0) return task;
    }
    return 'idle';
  },

  clearTaskMemory: function (creep) {
    if (!creep || !creep.memory) return;
    delete creep.memory.assignedSource;
    delete creep.memory.targetRoom;
    delete creep.memory.assignedContainer;
    delete creep.memory.sourceId;
  }
};
