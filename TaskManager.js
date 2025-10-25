'use strict';

var Logger = require('core.logger');
var LOG_LEVEL = Logger.LOG_LEVEL;
var taskLog = Logger.createLogger('TaskManager', LOG_LEVEL.BASIC);

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
  queen: 1,
  upgrader: 2,
  scout: 1
});

// Economic priority ensures worker bees refill the income pipeline before utility duties.
var DEFAULT_PRIORITY = Object.freeze([
  'baseharvest',
  'courier',
  'queen',
  'builder',
  'upgrader',
  'repair'
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

function colonyNeeds() {
  if (cache.needsTick === Game.time && cache.needs) return cache.needs;

  var overrides = (Memory.colonyNeeds && Memory.colonyNeeds.overrides) || {};
  var needsConfig = mergeNeeds(DEFAULT_NEEDS, overrides);
  var counts = getTaskCounts();
  var shortage = Object.create(null);

  for (var key in needsConfig) {
    if (!Object.prototype.hasOwnProperty.call(needsConfig, key)) continue;
    var required = needsConfig[key] | 0;
    var current = counts[key] | 0;
    if (current < required) {
      shortage[key] = required - current;
    }
  }

  cache.needsTick = Game.time;
  cache.needs = shortage;
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
  return DEFAULT_PRIORITY;
}

/* === FIX: Missing task handler recovery === */
function selectFallbackTask(creep, previousTask) {
  var needs = colonyNeeds();
  var priorityList = getPriorityList();
  for (var i = 0; i < priorityList.length; i++) {
    var candidate = priorityList[i];
    if (candidate === previousTask) continue;
    if ((needs[candidate] | 0) > 0 && getTaskModule(candidate)) {
      return candidate;
    }
  }
  if (getTaskModule('idle')) {
    return 'idle';
  }
  return null;
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
      if (creep.memory) {
        var previousTask = creep.memory.task;
        delete creep.memory.task;
        var fallbackTask = selectFallbackTask(creep, previousTask);
        if (fallbackTask) {
          creep.memory.task = fallbackTask;
          var fallbackModule = getTaskModule(fallbackTask);
          if (fallbackModule && fallbackModule.run) {
            fallbackModule.run(creep);
          }
        } else if (TaskIdle && typeof TaskIdle.run === 'function') {
          creep.memory.task = 'idle';
          TaskIdle.run(creep);
        }
      }
    }
  },

  isTaskNeeded: function (taskName) {
    var needs = colonyNeeds();
    return (needs[taskName] || 0) > 0;
  },

  getHighestPriorityTask: function (creep) {
    var needs = colonyNeeds();
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
