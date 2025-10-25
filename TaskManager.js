'use strict';

/**
 * TaskManager orchestrates creep task execution and reassignment.
 * The Screeps runtime supports many ES6 features, yet this implementation
 * deliberately adheres to ES5 syntax (no const/let, arrow functions, or
 * destructuring) to keep the codebase consistent for the entire team.
 */

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

/**
 * Default per-role counts that prevent the colony from starving.
 * Object.freeze is ES5-compliant (Screeps reference: https://docs.screeps.com/api/#Object.freeze).
 */
var DEFAULT_ROLE_REQUIREMENTS = Object.freeze({
  baseharvest: 2,
  builder: 2,
  repair: 1,
  courier: 2,
  queen: 1,
  upgrader: 2,
  scout: 1
});

/**
 * Economic priorities force energy income to be satisfied before utility roles.
 */
var DEFAULT_PRIORITY_QUEUE = Object.freeze([
  'baseharvest',
  'courier',
  'queen',
  'builder',
  'upgrader',
  'repair'
]);

/**
 * Registry containing all task modules keyed by commonly used name variants.
 */
var taskRegistry = Object.create(null);

/**
 * Per-tick cache avoids re-deriving creep counts and shortages during the same tick.
 */
var colonyCache = (global.__taskManagerCache = global.__taskManagerCache || {
  tick: -1,
  activeCounts: null,
  needs: null,
  needsTick: -1
});

/**
 * registerTaskModule
 * Input: taskIdentifier (string), taskModule (object with run function).
 * Output: none.
 * Side-effects: mutates the registry used to resolve task modules.
 * Reasoning: enforces consistent validation before a module is exposed.
 */
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

/**
 * deriveTaskCounts
 * Input: none.
 * Output: object keyed by task name containing live creep counts.
 * Side-effects: reads Game.creeps (Screeps docs: https://docs.screeps.com/api/#Game.creeps).
 * Reasoning: caches per tick to avoid repeatedly iterating the global creep list.
 */
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

/**
 * mergeRoleRequirements
 * Input: defaults (object), overrides (object).
 * Output: merged object describing desired counts.
 * Side-effects: none (creates a fresh object).
 * Reasoning: ensures Memory overrides never mutate the frozen defaults.
 */
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

/**
 * evaluateColonyNeeds
 * Input: none.
 * Output: object describing role shortages this tick.
 * Side-effects: reads Memory.colonyNeeds (https://docs.screeps.com/api/#Memory).
 * Reasoning: caches derived shortages so TaskManager decisions stay consistent per tick.
 */
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

/**
 * resolveTaskModule
 * Input: taskName (string).
 * Output: module or null when no registration exists.
 * Side-effects: none.
 * Reasoning: supports loose naming (lowercase, capitalized) without duplicating logic in callers.
 */
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

/**
 * determinePriorityQueue
 * Input: none.
 * Output: array describing role priorities.
 * Side-effects: reads Memory.colonyNeeds.priorityOrder when present.
 * Reasoning: allows operators to override runtime priorities without touching code.
 */
function determinePriorityQueue() {
  if (Memory.colonyNeeds && Memory.colonyNeeds.priorityOrder && Memory.colonyNeeds.priorityOrder.length) {
    return Memory.colonyNeeds.priorityOrder;
  }
  return DEFAULT_PRIORITY_QUEUE;
}

/**
 * chooseFallbackTask
 * Input: creep (Creep), previousTaskName (string).
 * Output: fallback task string or null when no alternative exists.
 * Side-effects: reads current shortages to find a replacement assignment.
 * Reasoning: prevents creeps from idling indefinitely when their recorded task is unknown.
 */
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

/**
 * executeTask
 * Input: creep (Creep).
 * Output: none.
 * Side-effects: invokes the resolved task module's run method, which issues Screeps intents
 *              such as creep.travelTo or resource actions (https://docs.screeps.com/api/#Creep).
 * Reasoning: centralizes error handling and fallback selection for unknown tasks.
 */
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

/**
 * markTaskMemory
 * Input: creep (Creep).
 * Output: none.
 * Side-effects: clears common task-specific keys from creep memory.
 * Reasoning: prevents stale assignments persisting after TaskManager retasks a creep.
 */
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

module.exports = {
  /**
   * run delegates to the active task and handles fallback logic when missing.
   */
  run: executeTask,

  /**
   * isTaskNeeded reports whether the colony currently lacks creeps for the role.
   */
  isTaskNeeded: function (taskName) {
    var shortages = evaluateColonyNeeds();
    return (shortages[taskName] || 0) > 0;
  },

  /**
   * getHighestPriorityTask returns the most urgent role name based on shortages and priorities.
   */
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

  /**
   * clearTaskMemory exposes markTaskMemory for other modules (e.g., spawn logic) to reuse.
   */
  clearTaskMemory: markTaskMemory
};
