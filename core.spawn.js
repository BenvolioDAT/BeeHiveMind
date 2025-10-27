'use strict';

function availableEnergy(spawnOrRoom) {
  if (!spawnOrRoom) return 0;
  if (typeof spawnOrRoom.energyAvailable === 'number') {
    return spawnOrRoom.energyAvailable;
  }
  if (spawnOrRoom.room && typeof spawnOrRoom.room.energyAvailable === 'number') {
    return spawnOrRoom.room.energyAvailable;
  }
  return 0;
}

function isAffordable(body, available) {
  if (!Array.isArray(body)) return false;
  var total = 0;
  for (var i = 0; i < body.length; i++) {
    total += BODYPART_COST[body[i]] || 0;
    if (total > available) {
      return false;
    }
  }
  return total <= available;
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
  if (!Array.isArray(body)) return out;
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
      if (!Object.prototype.hasOwnProperty.call(spec.memory, key)) continue;
      memory[key] = spec.memory[key];
    }
  }

  return spawn.spawnCreep(spec.body, name, { memory: memory });
}

module.exports = {
  availableEnergy: availableEnergy,
  isAffordable: isAffordable,
  generateName: generateName,
  spawnFromSpec: spawnFromSpec
};
