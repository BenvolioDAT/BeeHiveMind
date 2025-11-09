'use strict';

var Logger = require('core.logger');
var LOG_LEVEL = Logger.LOG_LEVEL;
var taskLog = Logger.createLogger('TaskManager', LOG_LEVEL.BASIC);

var RoleIdle = require('role.Idle');
var RoleBuilder = require('role.Builder');
var RoleRepair = require('role.Repair');
var RoleUpgrader = require('role.Upgrader');

var DEFAULT_NEEDS = Object.freeze({
  Builder: 1,
  Repair: 1,
  Upgrader: 1
});

var DEFAULT_PRIORITY = Object.freeze([
  'Repair',
  'Builder',
  'Upgrader'
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
  TASK_REGISTRY[String(name).toLowerCase()] = module;
}
registerTask('Builder', RoleBuilder);
registerTask('Repair', RoleRepair);
registerTask('Upgrader', RoleUpgrader);
registerTask('Idle', RoleIdle);

var cache = (global.__taskManagerCache = global.__taskManagerCache || {
  tick: -1,
  counts: null,
  needs: null,
  needsTick: -1
});

function getTaskModule(taskName) {
  if (!taskName) return TASK_REGISTRY.Idle || TASK_REGISTRY.idle;
  if (TASK_REGISTRY[taskName]) return TASK_REGISTRY[taskName];
  var lower = String(taskName).toLowerCase();
  if (TASK_REGISTRY[lower]) return TASK_REGISTRY[lower];
  var capitalized = lower.charAt(0).toUpperCase() + lower.slice(1);
  if (TASK_REGISTRY[capitalized]) return TASK_REGISTRY[capitalized];
  return TASK_REGISTRY.Idle || TASK_REGISTRY.idle;
}

function getTaskCounts() {
  if (cache.tick === Game.time && cache.counts) return cache.counts;
  cache.tick = Game.time;
  var counts = Object.create(null);
  var names = Object.keys(Game.creeps);
  for (var i = 0; i < names.length; i++) {
    var creep = Game.creeps[names[i]];
    if (!creep) continue;
    var mem = creep.memory || {};
    var module = getTaskModule(mem.role || mem.task);
    var key = (module && module.role) ? module.role : 'Idle';
    counts[key] = (counts[key] | 0) + 1;
  }
  cache.counts = counts;
  return counts;
}

function canonicalKey(name) {
  var module = getTaskModule(name);
  if (module && module.role) return module.role;
  return name;
}

function mergeNeeds(defaults, overrides) {
  var result = {};
  var key;
  for (key in defaults) {
    if (Object.prototype.hasOwnProperty.call(defaults, key)) {
      var canonical = canonicalKey(key);
      result[canonical] = defaults[key];
    }
  }
  for (key in overrides) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) {
      var canonicalOverride = canonicalKey(key);
      result[canonicalOverride] = overrides[key];
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

function getPriorityList() {
  if (Memory.colonyNeeds && Memory.colonyNeeds.priorityOrder && Memory.colonyNeeds.priorityOrder.length) {
    return Memory.colonyNeeds.priorityOrder;
  }
  return DEFAULT_PRIORITY;
}

module.exports = {
  run: function (creep) {
    if (!creep) return;
    var mem = creep.memory || {};
    var module = getTaskModule(mem.role || mem.task);

    if (module && typeof module.run === 'function') {
      module.run(creep);
    } else {
      if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
        taskLog.debug('No task module registered for', mem && (mem.role || mem.task), 'requested by', creep.name);
      }
      creep.say('No task!');
    }
  },

  isTaskNeeded: function (taskName) {
    var needs = colonyNeeds();
    var module = getTaskModule(taskName);
    var key = (module && module.role) ? module.role : taskName;
    return (needs[key] || 0) > 0;
  },

  getHighestPriorityTask: function () {
    var needs = colonyNeeds();
    var priorityList = getPriorityList();
    for (var i = 0; i < priorityList.length; i++) {
      var task = priorityList[i];
      var module = getTaskModule(task);
      var key = (module && module.role) ? module.role : task;
      if ((needs[key] | 0) > 0) return key;
    }
    return 'Idle';
  },

  clearTaskMemory: function (creep) {
    if (!creep || !creep.memory) return;
    delete creep.memory.assignedSource;
    delete creep.memory.targetRoom;
    delete creep.memory.assignedContainer;
    delete creep.memory.sourceId;
  }
};
