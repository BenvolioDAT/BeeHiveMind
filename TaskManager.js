'use strict';

const Logger = require('core.logger');
const LOG_LEVEL = Logger.LOG_LEVEL;
const taskLog = Logger.createLogger('TaskManager', LOG_LEVEL.BASIC);

const TaskIdle = require('./Task.Idle');
const TaskBaseHarvest = require('./Task.BaseHarvest');
const TaskLuna = require('./Task.Luna');
const TaskBuilder = require('./Task.Builder');
const TaskCourier = require('./Task.Courier');
const TaskQueen = require('./Task.Queen');
const TaskScout = require('./Task.Scout');
const TaskRepair = require('./Task.Repair');
const TaskUpgrader = require('./Task.Upgrader');
const TaskCombatArcher = require('./Task.CombatArcher');
const TaskCombatMedic = require('./Task.CombatMedic');
const TaskCombatMelee = require('./Task.CombatMelee');
const TaskDismantler = require('./Task.Dismantler');
const TaskTrucker = require('Task.Trucker');
const TaskClaimer = require('Task.Claimer');

const DEFAULT_NEEDS = Object.freeze({
  baseharvest: 2,
  builder: 2,
  repair: 1,
  courier: 2,
  upgrader: 2,
  scout: 1,
});

const DEFAULT_PRIORITY = Object.freeze([
  'baseharvest',
  'repair',
  'builder',
  'courier',
  'upgrader',
]);

const TASK_REGISTRY = Object.create(null);

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

const cache = (global.__taskManagerCache = global.__taskManagerCache || {
  tick: -1,
  counts: null,
  needs: null,
  needsTick: -1,
});

function getTaskCounts() {
  if (cache.tick === Game.time && cache.counts) return cache.counts;
  cache.tick = Game.time;
  cache.counts = _.countBy(Game.creeps, function (c) {
    return c && c.memory ? c.memory.task || 'idle' : 'idle';
  });
  return cache.counts;
}

function mergeNeeds(defaults, overrides) {
  var result = {};
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
  var shortage = {};

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

module.exports = {
  run(creep) {
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

  isTaskNeeded(taskName) {
    var needs = colonyNeeds();
    return (needs[taskName] || 0) > 0;
  },

  getHighestPriorityTask(creep) {
    var needs = colonyNeeds();
    var priorityList = getPriorityList();
    for (var i = 0; i < priorityList.length; i++) {
      var task = priorityList[i];
      if ((needs[task] | 0) > 0) return task;
    }
    return 'idle';
  },

  clearTaskMemory(creep) {
    if (!creep || !creep.memory) return;
    delete creep.memory.assignedSource;
    delete creep.memory.targetRoom;
    delete creep.memory.assignedContainer;
    delete creep.memory.sourceId;
  },
};
