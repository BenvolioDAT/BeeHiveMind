'use strict';

var BODY_COSTS = (typeof BODYPART_COST !== 'undefined') ? BODYPART_COST : (global && global.BODYPART_COST) || {};

function repairBody(workCount, carryCount, moveCount) {
  var body = [];
  var i;
  for (i = 0; i < workCount; i++) body.push(WORK);
  for (i = 0; i < carryCount; i++) body.push(CARRY);
  for (i = 0; i < moveCount; i++) body.push(MOVE);
  return body;
}

var REPAIR_BODY_TIERS = [
  repairBody(5, 2, 7),
  repairBody(4, 1, 5),
  repairBody(2, 1, 3)
];

function costOfBody(body) {
  var total = 0;
  if (!Array.isArray(body)) return total;
  for (var i = 0; i < body.length; i++) {
    var part = body[i];
    total += BODY_COSTS[part] || 0;
  }
  return total;
}

function pickLargestAffordable(tiers, energyAvailable) {
  if (!Array.isArray(tiers) || !tiers.length) return [];
  var available = typeof energyAvailable === 'number' ? energyAvailable : 0;
  for (var i = 0; i < tiers.length; i++) {
    var candidate = tiers[i];
    if (!Array.isArray(candidate)) continue;
    if (costOfBody(candidate) <= available) {
      return candidate.slice();
    }
  }
  return [];
}

// Logging Levels
var LOG_LEVEL = { NONE: 0, BASIC: 1, DEBUG: 2 };
var currentLogLevel = LOG_LEVEL.NONE;  // Adjust to LOG_LEVEL.DEBUG for more detailed logs

var REPAIR_SCAN_INTERVAL = 25;
var MAX_DEFENSE_REPAIR = 300000;
var MIN_DEFENSE_GOAL = 20000;
var DEFENSE_GOAL_BY_LEVEL = [0, 20000, 25000, 35000, 50000, 80000, 120000, 200000, 300000];
var MAX_ENERGY_RANK = 99;
var REPAIR_POWER_VALUE = typeof REPAIR_POWER === 'number' ? REPAIR_POWER : 100;
var POWER_SPAWN_TYPE = typeof STRUCTURE_POWER_SPAWN === 'string' ? STRUCTURE_POWER_SPAWN : null;

function hasEnergy(store) {
  if (!store) return false;
  if (typeof store.getUsedCapacity === 'function') {
    return (store.getUsedCapacity(RESOURCE_ENERGY) | 0) > 0;
  }
  var amount = store[RESOURCE_ENERGY];
  return amount != null && amount > 0;
}

function getStoreEnergy(target) {
  if (!target || !target.store) return 0;
  if (typeof target.store.getUsedCapacity === 'function') {
    return target.store.getUsedCapacity(RESOURCE_ENERGY) | 0;
  }
  var value = target.store[RESOURCE_ENERGY];
  return typeof value === 'number' ? value : 0;
}

function getDroppedEnergy(resource) {
  if (!resource || resource.resourceType !== RESOURCE_ENERGY) return 0;
  return resource.amount | 0;
}

function getFreeCapacity(creep) {
  if (!creep || !creep.store) return 0;
  if (typeof creep.store.getFreeCapacity === 'function') {
    var free = creep.store.getFreeCapacity(RESOURCE_ENERGY);
    return free != null ? free : 0;
  }
  var capacity = creep.storeCapacity || 0;
  var used = creep.store[RESOURCE_ENERGY] || 0;
  var remaining = capacity - used;
  return remaining > 0 ? remaining : 0;
}

function ensureRoomMemory(room) {
  if (!room) return null;
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};
  return Memory.rooms[room.name];
}

function ensureRepairTargets(memory) {
  if (!memory.repairTargets || !Array.isArray(memory.repairTargets)) {
    memory.repairTargets = [];
  }
  return memory.repairTargets;
}

function shouldRescanRepairs(memory) {
  if (!Game || typeof Game.time !== 'number') return false;
  var lastScan = memory.lastRepairScan;
  if (typeof lastScan !== 'number') return true;
  return Game.time - lastScan >= REPAIR_SCAN_INTERVAL;
}

function clampDefenseGoal(goal, maxConstant) {
  var result = goal;
  if (maxConstant != null && maxConstant > 0 && result > maxConstant) {
    result = maxConstant;
  }
  if (result > MAX_DEFENSE_REPAIR) {
    result = MAX_DEFENSE_REPAIR;
  }
  if (result < MIN_DEFENSE_GOAL) {
    result = MIN_DEFENSE_GOAL;
  }
  return result;
}

function computeDefenseGoal(structure) {
  var room = structure.room;
  var controller = room ? room.controller : null;
  var level = controller && typeof controller.level === 'number' ? controller.level : 0;
  if (level < 0) level = 0;
  if (level >= DEFENSE_GOAL_BY_LEVEL.length) {
    level = DEFENSE_GOAL_BY_LEVEL.length - 1;
  }
  var goal = DEFENSE_GOAL_BY_LEVEL[level] || MIN_DEFENSE_GOAL;
  var maxConstant = null;
  if (structure.structureType === STRUCTURE_WALL && typeof WALL_HITS_MAX === 'number') {
    maxConstant = WALL_HITS_MAX;
  } else if (structure.structureType === STRUCTURE_RAMPART && typeof RAMPART_HITS_MAX === 'number') {
    maxConstant = RAMPART_HITS_MAX;
  }
  return clampDefenseGoal(goal, maxConstant);
}

function getStructureRepairGoal(structure) {
  if (!structure) return 0;
  var type = structure.structureType;
  if (type === STRUCTURE_WALL || type === STRUCTURE_RAMPART) {
    return computeDefenseGoal(structure);
  }
  var maxHits = typeof structure.hitsMax === 'number' ? structure.hitsMax : 0;
  return maxHits;
}

function needsRepair(structure) {
  if (!structure || typeof structure.hits !== 'number') return false;
  var goal = getStructureRepairGoal(structure);
  if (goal <= 0) return false;
  if (structure.hits >= structure.hitsMax && (structure.structureType !== STRUCTURE_WALL && structure.structureType !== STRUCTURE_RAMPART)) {
    return false;
  }
  return structure.hits < goal;
}

function sortByRepairPriority(a, b) {
  var goalA = getStructureRepairGoal(a) || 1;
  var goalB = getStructureRepairGoal(b) || 1;
  var ratioA = a.hits / goalA;
  var ratioB = b.hits / goalB;
  if (ratioA !== ratioB) return ratioA - ratioB;
  return a.hits - b.hits;
}

function gatherRepairTargets(room) {
  if (!room) return [];
  var structures = room.find(FIND_STRUCTURES, {
    filter: function (structure) {
      return needsRepair(structure);
    }
  });
  structures.sort(sortByRepairPriority);
  var targets = [];
  for (var i = 0; i < structures.length; i++) {
    var structure = structures[i];
    targets.push({
      id: structure.id,
      goal: getStructureRepairGoal(structure),
      type: structure.structureType
    });
  }
  return targets;
}

function refreshRepairTargets(memory, room) {
  var list = gatherRepairTargets(room);
  memory.repairTargets = list;
  if (Game && typeof Game.time === 'number') {
    memory.lastRepairScan = Game.time;
  }
  return list;
}

function purgeInvalidRepairTargets(list) {
  if (!Array.isArray(list)) return;
  for (var i = 0; i < list.length;) {
    var entry = list[i];
    var structure = entry ? Game.getObjectById(entry.id) : null;
    if (!structure) {
      list.splice(i, 1);
      continue;
    }
    var goal = entry && typeof entry.goal === 'number' ? entry.goal : getStructureRepairGoal(structure);
    if (goal <= 0 || structure.hits >= goal || (structure.hitsMax && structure.hits >= structure.hitsMax)) {
      list.splice(i, 1);
      continue;
    }
    entry.goal = goal;
    i++;
  }
}

function isWithdrawStructureType(type) {
  if (!type) return false;
  if (type === STRUCTURE_CONTAINER || type === STRUCTURE_STORAGE || type === STRUCTURE_TERMINAL || type === STRUCTURE_LINK || type === STRUCTURE_SPAWN || type === STRUCTURE_EXTENSION) {
    return true;
  }
  if (POWER_SPAWN_TYPE && type === POWER_SPAWN_TYPE) {
    return true;
  }
  return false;
}

function getEnergyPriorityForStructure(structure) {
  if (!structure) return MAX_ENERGY_RANK;
  var type = structure.structureType;
  if (type === STRUCTURE_CONTAINER) return 1;
  if (type === STRUCTURE_LINK) return 2;
  if (type === STRUCTURE_STORAGE) return 3;
  if (type === STRUCTURE_TERMINAL) return 4;
  if (POWER_SPAWN_TYPE && type === POWER_SPAWN_TYPE) return 5;
  if (type === STRUCTURE_SPAWN || type === STRUCTURE_EXTENSION) return 6;
  return MAX_ENERGY_RANK;
}

function selectEnergySource(creep, options) {
  if (!creep || !creep.room) return null;
  var config = options || {};
  var minAmount = config.minAmount != null ? config.minAmount : 50;
  var allowStorage = config.allowStorage !== false;
  var allowDropped = config.allowDropped !== false;
  var room = creep.room;

  var tombstones = room.find(FIND_TOMBSTONES, {
    filter: function (stone) {
      return hasEnergy(stone.store);
    }
  });
  if (tombstones.length) {
    tombstones.sort(function (a, b) {
      return getStoreEnergy(b) - getStoreEnergy(a);
    });
    return { target: tombstones[0], action: 'withdraw' };
  }

  var ruins = room.find(FIND_RUINS, {
    filter: function (ruin) {
      return hasEnergy(ruin.store);
    }
  });
  if (ruins.length) {
    ruins.sort(function (a, b) {
      return getStoreEnergy(b) - getStoreEnergy(a);
    });
    return { target: ruins[0], action: 'withdraw' };
  }

  var dropped = null;
  if (allowDropped) {
    dropped = room.find(FIND_DROPPED_RESOURCES, {
      filter: function (res) {
        return res.resourceType === RESOURCE_ENERGY && (res.amount | 0) > 0;
      }
    });
    if (dropped.length) {
      dropped.sort(function (a, b) {
        return getDroppedEnergy(b) - getDroppedEnergy(a);
      });
      if (getDroppedEnergy(dropped[0]) >= minAmount) {
        return { target: dropped[0], action: 'pickup' };
      }
    }
  }

  var structures = room.find(FIND_STRUCTURES, {
    filter: function (structure) {
      if (!structure || !structure.store) return false;
      if (!isWithdrawStructureType(structure.structureType)) return false;
      if ((structure.structureType === STRUCTURE_STORAGE || structure.structureType === STRUCTURE_TERMINAL) && !allowStorage) {
        return false;
      }
      if (!hasEnergy(structure.store)) return false;
      if ((structure.structureType === STRUCTURE_CONTAINER || structure.structureType === STRUCTURE_STORAGE || structure.structureType === STRUCTURE_TERMINAL) && getStoreEnergy(structure) < minAmount) {
        return false;
      }
      return true;
    }
  });

  var bestStructure = null;
  var bestRank = MAX_ENERGY_RANK;
  var bestEnergy = 0;
  for (var i = 0; i < structures.length; i++) {
    var structure = structures[i];
    var rank = getEnergyPriorityForStructure(structure);
    var energyAmount = getStoreEnergy(structure);
    if (energyAmount <= 0) continue;
    if (rank > bestRank) continue;
    if (rank === bestRank && energyAmount <= bestEnergy) continue;
    bestStructure = structure;
    bestRank = rank;
    bestEnergy = energyAmount;
  }
  if (bestStructure) {
    return { target: bestStructure, action: 'withdraw' };
  }

  if (allowDropped && dropped && dropped.length) {
    return { target: dropped[0], action: 'pickup' };
  }

  var harvestSource = creep.pos.findClosestByPath(FIND_SOURCES_ACTIVE);
  if (!harvestSource) {
    harvestSource = creep.pos.findClosestByRange(FIND_SOURCES);
  }
  if (harvestSource) {
    return { target: harvestSource, action: 'harvest' };
  }

  return null;
}

function moveToTarget(creep, target, stroke) {
  if (!creep || !target) return;
  creep.moveTo(target, {
    visualizePathStyle: { stroke: stroke || '#ffffff', opacity: 0.3 },
    reusePath: 10
  });
}

function drawRepairVisual(room, target) {
  if (!room || !target || !room.visual) return;
  room.visual.text(
    'Repairing ' + target.structureType,
    target.pos.x,
    target.pos.y - 1,
    { align: 'center', color: 'white' }
  );
  room.visual.circle(target.pos, { radius: 0.5, fill: 'transparent', stroke: '#00ffff' });
}

function actOnEnergySelection(creep, selection) {
  if (!selection || !selection.target) return false;
  var target = selection.target;
  var action = selection.action;
  var result = ERR_INVALID_TARGET;
  if (action === 'withdraw') {
    result = creep.withdraw(target, RESOURCE_ENERGY);
  } else if (action === 'pickup') {
    result = creep.pickup(target);
  } else if (action === 'harvest') {
    result = creep.harvest(target);
  }
  if (result === ERR_NOT_IN_RANGE) {
    moveToTarget(creep, target, '#ffaa00');
    return false;
  }
  if (result === OK) {
    return true;
  }
  if (currentLogLevel >= LOG_LEVEL.DEBUG) {
    console.log('Repair energy action failed: ' + result + ' for ' + creep.name);
  }
  return false;
}

var TaskRepair = {
  run: function (creep) {
    if (!creep || !creep.room) return;

    var room = creep.room;
    var roomMemory = ensureRoomMemory(room);
    if (!roomMemory) return;

    var repairTargets = ensureRepairTargets(roomMemory);
    purgeInvalidRepairTargets(repairTargets);

    if (!repairTargets.length || shouldRescanRepairs(roomMemory)) {
      repairTargets = refreshRepairTargets(roomMemory, room);
    }

    if (creep.store[RESOURCE_ENERGY] <= 0) {
      var freeCapacity = getFreeCapacity(creep);
      var energySelection = selectEnergySource(creep, { minAmount: freeCapacity > 100 ? 100 : 0 });
      if (energySelection) {
        actOnEnergySelection(creep, energySelection);
      } else {
        var source = creep.pos.findClosestByPath(FIND_SOURCES_ACTIVE);
        if (!source) {
          source = creep.pos.findClosestByRange(FIND_SOURCES);
        }
        if (source) {
          if (creep.harvest(source) === ERR_NOT_IN_RANGE) {
            moveToTarget(creep, source, '#ffaa00');
          }
        } else if (currentLogLevel >= LOG_LEVEL.DEBUG) {
          console.log('No available energy source for repair creep ' + creep.name + ' in ' + room.name);
        }
      }
      return;
    }

    var target = null;
    var targetEntry = null;
    while (repairTargets.length) {
      var entry = repairTargets[0];
      var structure = entry ? Game.getObjectById(entry.id) : null;
      if (!structure) {
        repairTargets.shift();
        continue;
      }
      var goalHits = entry && typeof entry.goal === 'number' ? entry.goal : getStructureRepairGoal(structure);
      if (goalHits <= 0 || structure.hits >= goalHits || (structure.hitsMax && structure.hits >= structure.hitsMax)) {
        repairTargets.shift();
        continue;
      }
      entry.goal = goalHits;
      target = structure;
      targetEntry = entry;
      break;
    }

    if (!target) {
      if (!repairTargets.length) {
        repairTargets = refreshRepairTargets(roomMemory, room);
      }
      if (!repairTargets.length) {
        creep.memory.task = undefined;
      }
      return;
    }

    if (currentLogLevel >= LOG_LEVEL.DEBUG) {
      console.log('Creep ' + creep.name + ' repairing ' + target.structureType + ' at (' + target.pos.x + ', ' + target.pos.y + ') in ' + room.name);
    }

    drawRepairVisual(room, target);

    var repairResult = creep.repair(target);
    if (repairResult === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, target, '#00ffff');
      return;
    }
    if (repairResult !== OK) {
      if (currentLogLevel >= LOG_LEVEL.DEBUG) {
        console.log('Repair error: ' + repairResult + ' for creep ' + creep.name);
      }
      repairTargets.shift();
      return;
    }

    var completionGoal = targetEntry && typeof targetEntry.goal === 'number' ? targetEntry.goal : getStructureRepairGoal(target);
    if (target.hits + REPAIR_POWER_VALUE >= completionGoal || (target.hitsMax && target.hits >= target.hitsMax)) {
      repairTargets.shift();
    }
  }
};

module.exports = TaskRepair;
module.exports.BODY_TIERS = REPAIR_BODY_TIERS.map(function (tier) { return tier.slice(); });
module.exports.pickLargestAffordable = pickLargestAffordable;
module.exports.getSpawnBody = function (energy) {
  return pickLargestAffordable(REPAIR_BODY_TIERS, energy);
};
module.exports.getSpawnSpec = function (room, ctx) {
  var context = ctx || {};
  var energy = context.availableEnergy;
  var body = module.exports.getSpawnBody(energy, room, context);
  return {
    body: body,
    namePrefix: 'repair',
    memory: { role: 'Worker_Bee', task: 'repair', home: room && room.name }
  };
};
