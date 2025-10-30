var CoreLogger = require('core.logger');
var CoreConfig = require('core.config');

var LOG_LEVEL = (CoreLogger && CoreLogger.LOG_LEVEL) ? CoreLogger.LOG_LEVEL : { BASIC: 1, DEBUG: 2 };
var taskLog = (CoreLogger && typeof CoreLogger.createLogger === 'function')
  ? CoreLogger.createLogger('Worker_Bee', LOG_LEVEL.BASIC)
  : { debug: function () {}, info: function () {}, warn: function () {}, error: function () {} };

var colonyCache = global.__workerTaskCache;
if (!colonyCache || colonyCache.__ver !== 'WORKER_CACHE_v1') {
  colonyCache = {
    __ver: 'WORKER_CACHE_v1',
    tick: -1,
    counts: Object.create(null),
    needs: Object.create(null)
  };
}
global.__workerTaskCache = colonyCache;

var missingModuleWarnings = Object.create(null);

function costOfBody(body) {
  if (!Array.isArray(body)) {
    return 0;
  }
  var total = 0;
  for (var i = 0; i < body.length; i++) {
    total += BODYPART_COST[body[i]] || 0;
  }
  return total;
}

function pickLargestAffordable(tiers, energy) {
  if (!Array.isArray(tiers)) {
    return [];
  }
  var i;
  for (i = 0; i < tiers.length; i++) {
    var candidate = tiers[i];
    if (costOfBody(candidate) <= energy) {
      return Array.isArray(candidate) ? candidate.slice() : [];
    }
  }
  return [];
}

function _warnMissingModule(moduleName, error) {
  if (!moduleName || missingModuleWarnings[moduleName]) {
    return;
  }
  missingModuleWarnings[moduleName] = Game && Game.time ? Game.time : 1;
  if (CoreLogger && typeof CoreLogger.shouldLog === 'function' && taskLog && typeof taskLog.debug === 'function') {
    if (CoreLogger.shouldLog(LOG_LEVEL.DEBUG)) {
      taskLog.debug('Failed to require module', moduleName, error);
    }
  }
}

var TASK_MODULE_ALIASES = {
  baseharvest: 'Task.BaseHarvest',
  luna: 'Task.Luna',
  builder: 'Task.Builder',
  courier: 'Task.Courier',
  queen: 'Task.Queen',
  scout: 'Task.Scout',
  repair: 'Task.Repair',
  upgrader: 'Task.Upgrader',
  combatarcher: 'Task.CombatArcher',
  combatmedic: 'Task.CombatMedic',
  combatmelee: 'Task.CombatMelee',
  dismantler: 'Task.Dismantler',
  trucker: 'Task.Trucker',
  claimer: 'Task.Claimer'
};

function _workerCfg() {
  if (!CoreConfig || !CoreConfig.settings) {
    return {};
  }
  return CoreConfig.settings['Worker'] || {};
}

function _defaultRoleReq() {
  var cfg = _workerCfg();
  if (cfg.DEFAULT_ROLE_REQUIREMENTS) {
    return cfg.DEFAULT_ROLE_REQUIREMENTS;
  }
  return {
    baseharvest: 2,
    builder: 1,
    repair: 1,
    courier: 2,
    queen: 1,
    upgrader: 1,
    scout: 1
  };
}

function _defaultPriority() {
  var cfg = _workerCfg();
  if (cfg.DEFAULT_PRIORITY_QUEUE) {
    return cfg.DEFAULT_PRIORITY_QUEUE;
  }
  return [
    'baseharvest',
    'courier',
    'queen',
    'builder',
    'upgrader',
    'repair'
  ];
}

function _cap(s) {
  var str = String(s || '');
  if (!str) {
    return str;
  }
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function _moduleName(task) {
  return 'Task.' + _cap(task);
}

function _resolveModuleName(task) {
  var name = String(task || '');
  if (!name) {
    return null;
  }
  if (name.indexOf('Task.') === 0) {
    return name;
  }
  var normalized = name.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  if (TASK_MODULE_ALIASES[normalized]) {
    return TASK_MODULE_ALIASES[normalized];
  }
  return _moduleName(name);
}

function _taskAvailable(task) {
  var moduleName = _resolveModuleName(task);
  if (!moduleName) {
    return false;
  }
  var mod = null;
  try {
    mod = require(moduleName);
  } catch (err) {
    mod = null;
    _warnMissingModule(moduleName, err);
  }
  return !!(mod && typeof mod.run === 'function');
}

function _runTaskByName(creep, task) {
  var moduleName = _resolveModuleName(task);
  if (!moduleName) {
    return false;
  }
  var mod = null;
  try {
    mod = require(moduleName);
  } catch (err) {
    mod = null;
    _warnMissingModule(moduleName, err);
  }
  if (mod && typeof mod.run === 'function') {
    try {
      mod.run(creep);
      return true;
    } catch (error) {
      if (taskLog && typeof taskLog.debug === 'function') {
        taskLog.debug('Task error ' + task + ' for ' + (creep && creep.name ? creep.name : '?'), error);
      }
    }
  }
  return false;
}

function mergeRoleRequirements(defaults, overrides) {
  var merged = Object.create(null);
  var key;

  defaults = defaults || {};
  overrides = overrides || {};

  for (key in defaults) {
    if (Object.prototype.hasOwnProperty.call(defaults, key)) {
      merged[key] = defaults[key];
    }
  }

  for (key in overrides) {
    if (Object.prototype.hasOwnProperty.call(overrides, key)) {
      merged[key] = overrides[key];
    }
  }

  return merged;
}

function deriveTaskCounts() {
  if (colonyCache.tick === Game.time && colonyCache.counts) {
    return colonyCache.counts;
  }

  var counts = Object.create(null);
  var creepName;

  for (creepName in Game.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Game.creeps, creepName)) {
      continue;
    }
    var creep = Game.creeps[creepName];
    if (!creep || !creep.memory) {
      counts.idle = (counts.idle || 0) + 1;
      continue;
    }
    var taskName = creep.memory.task || 'idle';
    counts[taskName] = (counts[taskName] || 0) + 1;
  }

  colonyCache.tick = Game.time;
  colonyCache.counts = counts;
  colonyCache.needs = Object.create(null);
  return counts;
}

function evaluateColonyNeeds(counts, defaults, overrides) {
  var desired = mergeRoleRequirements(defaults, overrides);
  var shortages = Object.create(null);
  var key;

  counts = counts || Object.create(null);

  for (key in desired) {
    if (!Object.prototype.hasOwnProperty.call(desired, key)) {
      continue;
    }
    var required = desired[key] | 0;
    var current = counts[key] | 0;
    if (current < required) {
      shortages[key] = required - current;
    }
  }

  colonyCache.needs = shortages;
  return shortages;
}

function determinePriorityQueue(defaultQueue, overrideQueue) {
  if (overrideQueue && overrideQueue.length) {
    return overrideQueue;
  }
  return defaultQueue;
}

function chooseFallbackTask(creep, needs, queue, lastTask) {
  var shortages = needs || colonyCache.needs || Object.create(null);
  var priorityQueue = queue && queue.length ? queue : _defaultPriority();
  var index;

  for (index = 0; index < priorityQueue.length; index++) {
    var candidate = priorityQueue[index];
    if (!candidate || candidate === lastTask) {
      continue;
    }
    if ((shortages[candidate] | 0) > 0 && _taskAvailable(candidate)) {
      return candidate;
    }
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

function run(creep) {
  if (!creep || creep.spawning) {
    return;
  }

  if (!creep.memory) {
    creep.memory = {};
  }

  var counts = deriveTaskCounts();
  var defaults = _defaultRoleReq();
  var overrides = (Memory.colonyNeeds && Memory.colonyNeeds.overrides) || {};
  var needs = evaluateColonyNeeds(counts, defaults, overrides);
  var priorityQueue = determinePriorityQueue(_defaultPriority(), (Memory.colonyNeeds && Memory.colonyNeeds.priorityOrder) || null);

  if (!creep.memory.task) {
    var initialTask = chooseFallbackTask(creep, needs, priorityQueue, null);
    if (initialTask) {
      creep.memory.task = initialTask;
    }
  }

  var currentTask = creep.memory.task;
  if (currentTask && _runTaskByName(creep, currentTask)) {
    return;
  }

  if (CoreLogger && typeof CoreLogger.shouldLog === 'function' && taskLog && typeof taskLog.debug === 'function') {
    if (CoreLogger.shouldLog(LOG_LEVEL.DEBUG)) {
      taskLog.debug('No task module registered for', currentTask, 'requested by', creep.name);
    }
  }

  if (typeof creep.say === 'function') {
    creep.say('No task!');
  }

  var memory = creep.memory;
  if (!memory) {
    return;
  }

  var previousTask = currentTask;
  delete memory.task;
  markTaskMemory(creep);

  counts = deriveTaskCounts();
  needs = evaluateColonyNeeds(counts, defaults, overrides);
  var fallbackTask = chooseFallbackTask(creep, needs, priorityQueue, previousTask);
  if (fallbackTask) {
    memory.task = fallbackTask;
    if (_runTaskByName(creep, fallbackTask)) {
      return;
    }
    return;
  }

  if (typeof creep.say === 'function' && !memory._idleSaid) {
    creep.say('⏸');
    memory._idleSaid = 1;
  }
}

function availableEnergy(spawnOrRoom) {
  if (!spawnOrRoom) {
    return 0;
  }
  if (typeof spawnOrRoom.energyAvailable === 'number') {
    return spawnOrRoom.energyAvailable;
  }
  if (spawnOrRoom.room && typeof spawnOrRoom.room.energyAvailable === 'number') {
    return spawnOrRoom.room.energyAvailable;
  }
  return 0;
}

function isAffordable(body, available) {
  if (!Array.isArray(body)) {
    return false;
  }
  return costOfBody(body) <= available;
}

function generateName(prefix) {
  var base = (typeof prefix === 'string' && prefix.length) ? prefix : 'Worker';
  for (var i = 1; i <= 70; i++) {
    var name = base + '_' + i;
    if (!Game.creeps || !Game.creeps[name]) {
      return name;
    }
  }
  return null;
}

function copyBody(body) {
  var out = [];
  if (!Array.isArray(body)) {
    return out;
  }
  for (var i = 0; i < body.length; i++) {
    out.push(body[i]);
  }
  return out;
}

function spawnFromSpec(spawn, task, spec) {
  if (!spawn || !spec || !Array.isArray(spec.body) || !spec.body.length) {
    return ERR_INVALID_ARGS;
  }
  var available = availableEnergy(spawn);
  if (!isAffordable(spec.body, available)) {
    return ERR_NOT_ENOUGH_ENERGY;
  }

  var prefixSource = (spec.namePrefix != null) ? spec.namePrefix : task;
  var prefix = (typeof prefixSource === 'string' && prefixSource.length)
    ? prefixSource
    : String(task || 'Worker');
  var name = generateName(prefix);
  if (!name) {
    return ERR_NAME_EXISTS;
  }

  var memory = {
    role: 'Worker_Bee',
    task: task,
    bornTask: task,
    birthBody: copyBody(spec.body)
  };
  if (spawn && spawn.room && typeof spawn.room.name === 'string') {
    memory.home = spawn.room.name;
  }

  if (spec.memory && typeof spec.memory === 'object') {
    for (var key in spec.memory) {
      if (!Object.prototype.hasOwnProperty.call(spec.memory, key)) {
        continue;
      }
      memory[key] = spec.memory[key];
    }
  }

  return spawn.spawnCreep(spec.body, name, { memory: memory });
}

module.exports = {
  run: run,
  availableEnergy: availableEnergy,
  isAffordable: isAffordable,
  generateName: generateName,
  spawnFromSpec: spawnFromSpec,
  markTaskMemory: markTaskMemory,
  costOfBody: costOfBody,
  pickLargestAffordable: pickLargestAffordable
};
