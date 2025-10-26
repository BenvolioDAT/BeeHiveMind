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

var DEFAULT_ROLE_REQUIREMENTS = Object.freeze({
  baseharvest: 2,
  builder: 2,
  repair: 1,
  courier: 2,
  queen: 1,
  upgrader: 2,
  scout: 1
});

var DEFAULT_PRIORITY_QUEUE = Object.freeze([
  'baseharvest',
  'courier',
  'queen',
  'builder',
  'upgrader',
  'repair'
]);

var taskRegistry = Object.create(null);
var colonyCache = (global.__workerTaskCache = global.__workerTaskCache || {
  tick: -1,
  activeCounts: null,
  needs: null,
  needsTick: -1
});

function registerTaskModule(taskIdentifier, taskModule) {
  if (!taskIdentifier || !taskModule || typeof taskModule.run !== 'function') {
    if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
      taskLog.debug('Skipped registering invalid task module for', taskIdentifier);
    }
    return;
  }
  taskRegistry[taskIdentifier] = taskModule;
}

registerTaskModule('baseharvest', TaskBaseHarvest);
registerTaskModule('luna', TaskLuna);
registerTaskModule('builder', TaskBuilder);
registerTaskModule('courier', TaskCourier);
registerTaskModule('queen', TaskQueen);
registerTaskModule('scout', TaskScout);
registerTaskModule('repair', TaskRepair);
registerTaskModule('upgrader', TaskUpgrader);
registerTaskModule('CombatMedic', TaskCombatMedic);
registerTaskModule('CombatMelee', TaskCombatMelee);
registerTaskModule('CombatArcher', TaskCombatArcher);
registerTaskModule('Dismantler', TaskDismantler);
registerTaskModule('idle', TaskIdle);
registerTaskModule('Trucker', TaskTrucker);
registerTaskModule('Claimer', TaskClaimer);

function resolveTaskModule(taskName) {
  if (!taskName) {
    return null;
  }
  if (taskRegistry[taskName]) {
    return taskRegistry[taskName];
  }
  var loweredName = String(taskName).toLowerCase();
  if (taskRegistry[loweredName]) {
    return taskRegistry[loweredName];
  }
  var capitalizedName = taskName.charAt(0).toUpperCase() + taskName.slice(1);
  if (taskRegistry[capitalizedName]) {
    return taskRegistry[capitalizedName];
  }
  return null;
}

function deriveTaskCounts() {
  if (colonyCache.tick === Game.time && colonyCache.activeCounts) {
    return colonyCache.activeCounts;
  }

  colonyCache.tick = Game.time;
  var countsByTask = Object.create(null);

  for (var creepName in Game.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Game.creeps, creepName)) {
      continue;
    }
    var creep = Game.creeps[creepName];
    if (!creep || !creep.memory) {
      countsByTask.idle = (countsByTask.idle || 0) + 1;
      continue;
    }
    var taskKey = creep.memory.task || 'idle';
    countsByTask[taskKey] = (countsByTask[taskKey] || 0) + 1;
  }

  colonyCache.activeCounts = countsByTask;
  return countsByTask;
}

function mergeRoleRequirements(defaults, overrides) {
  var merged = Object.create(null);
  var propertyName;

  for (propertyName in defaults) {
    if (Object.prototype.hasOwnProperty.call(defaults, propertyName)) {
      merged[propertyName] = defaults[propertyName];
    }
  }

  for (propertyName in overrides) {
    if (Object.prototype.hasOwnProperty.call(overrides, propertyName)) {
      merged[propertyName] = overrides[propertyName];
    }
  }

  return merged;
}

function evaluateColonyNeeds() {
  if (colonyCache.needsTick === Game.time && colonyCache.needs) {
    return colonyCache.needs;
  }

  var overrides = (Memory.colonyNeeds && Memory.colonyNeeds.overrides) || {};
  var desiredCounts = mergeRoleRequirements(DEFAULT_ROLE_REQUIREMENTS, overrides);
  var observedCounts = deriveTaskCounts();
  var shortages = Object.create(null);

  var requirementKey;
  for (requirementKey in desiredCounts) {
    if (!Object.prototype.hasOwnProperty.call(desiredCounts, requirementKey)) {
      continue;
    }
    var requiredCount = desiredCounts[requirementKey] | 0;
    var currentCount = observedCounts[requirementKey] | 0;
    if (currentCount < requiredCount) {
      shortages[requirementKey] = requiredCount - currentCount;
    }
  }

  colonyCache.needsTick = Game.time;
  colonyCache.needs = shortages;
  return shortages;
}

function determinePriorityQueue() {
  if (Memory.colonyNeeds && Memory.colonyNeeds.priorityOrder && Memory.colonyNeeds.priorityOrder.length) {
    return Memory.colonyNeeds.priorityOrder;
  }
  return DEFAULT_PRIORITY_QUEUE;
}

function chooseFallbackTask(creep, previousTaskName) {
  var currentNeeds = evaluateColonyNeeds();
  var priorityQueue = determinePriorityQueue();
  for (var index = 0; index < priorityQueue.length; index++) {
    var candidateName = priorityQueue[index];
    if (candidateName === previousTaskName) {
      continue;
    }
    if ((currentNeeds[candidateName] | 0) > 0 && resolveTaskModule(candidateName)) {
      return candidateName;
    }
  }
  if (resolveTaskModule('idle')) {
    return 'idle';
  }
  return null;
}

function markTaskMemory(creep) {
  if (!creep || !creep.memory) {
    return;
  }
  delete creep.memory.assignedSource;
  delete creep.memory.targetRoom;
  delete creep.memory.assignedContainer;
  delete creep.memory.sourceId;
  delete creep.memory.seat;
  delete creep.memory.pickupId;
  delete creep.memory.pickupAction;
  delete creep.memory.dropoffId;
  delete creep.memory.mode;
}

function executeTask(creep) {
  if (!creep) {
    return;
  }

  var memoryTaskName = creep.memory && creep.memory.task;
  var activeTaskModule = resolveTaskModule(memoryTaskName);

  if (activeTaskModule) {
    activeTaskModule.run(creep);
    return;
  }

  if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
    taskLog.debug('No task module registered for', memoryTaskName, 'requested by', creep.name);
  }

  creep.say('No task!');
  if (!creep.memory) {
    return;
  }

  var previousTaskName = creep.memory.task;
  delete creep.memory.task;

  var fallbackTaskName = chooseFallbackTask(creep, previousTaskName);
  if (fallbackTaskName) {
    creep.memory.task = fallbackTaskName;
    var fallbackModule = resolveTaskModule(fallbackTaskName);
    if (fallbackModule && typeof fallbackModule.run === 'function') {
      fallbackModule.run(creep);
    }
    return;
  }

  if (TaskIdle && typeof TaskIdle.run === 'function') {
    creep.memory.task = 'idle';
    TaskIdle.run(creep);
  }
}

var WorkerTaskManager = {
  run: executeTask,
  isTaskNeeded: function (taskName) {
    var shortages = evaluateColonyNeeds();
    return (shortages[taskName] || 0) > 0;
  },
  getHighestPriorityTask: function (creep) {
    var shortages = evaluateColonyNeeds();
    var priorityQueue = determinePriorityQueue();
    for (var index = 0; index < priorityQueue.length; index++) {
      var taskName = priorityQueue[index];
      if ((shortages[taskName] | 0) > 0) {
        return taskName;
      }
    }
    return 'idle';
  },
  clearTaskMemory: markTaskMemory
};

var roleWorker_Bee = {
  run: function (creep) {
    if (!creep || creep.spawning) {
      return;
    }

    if (!creep.memory.task) {
      creep.memory.task = WorkerTaskManager.getHighestPriorityTask(creep);
    }

    WorkerTaskManager.run(creep);
  }
};

module.exports = roleWorker_Bee;
