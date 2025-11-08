var Logger = require('core.logger');
var LOG_LEVEL = Logger.LOG_LEVEL;
var taskLog = Logger.createLogger('TaskManager', LOG_LEVEL.BASIC);

var TaskIdle = require('./Task.Idle');
var TaskBuilder = require('./Task.Builder');
var TaskRepair = require('./Task.Repair');
var TaskUpgrader = require('./Task.Upgrader');

var DEFAULT_NEEDS = Object.freeze({
  builder: 1,
  repair: 1,
  upgrader: 1,
});

var DEFAULT_PRIORITY = Object.freeze([
  'repair',
  'builder',
  'upgrader',
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
registerTask('builder', TaskBuilder);
registerTask('repair', TaskRepair);
registerTask('upgrader', TaskUpgrader);
registerTask('idle', TaskIdle);

var cache = (global.__taskManagerCache = global.__taskManagerCache || {
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
  // Execute the assigned task for the provided creep.
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

  // Check if the colony currently needs more creeps for a given task.
  isTaskNeeded: function (taskName) {
    var needs = colonyNeeds();
    return (needs[taskName] || 0) > 0;
  },

  // Get the highest priority task that still has unmet demand.
  getHighestPriorityTask: function (creep) {
    var needs = colonyNeeds();
    var priorityList = getPriorityList();
    for (var i = 0; i < priorityList.length; i++) {
      var task = priorityList[i];
      if ((needs[task] | 0) > 0) return task;
    }
    return 'idle';
  },

  // Remove task-related fields from the creep's memory.
  clearTaskMemory: function (creep) {
    if (!creep || !creep.memory) return;
    delete creep.memory.assignedSource;
    delete creep.memory.targetRoom;
    delete creep.memory.assignedContainer;
    delete creep.memory.sourceId;
  },
};
