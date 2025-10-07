'use strict';

var BeeToolbox = require('BeeToolbox');
var BeeMaintenance = require('BeeMaintenance');
var Logger = require('core.logger');
var LOG_LEVEL = Logger.LOG_LEVEL;
var repairLog = Logger.createLogger('TaskRepair', LOG_LEVEL.DEBUG);

if (!global.__repairReservations) {
  global.__repairReservations = { tick: -1, map: {} };
}

function reservationMap() {
  var state = global.__repairReservations;
  if (!state || state.tick !== Game.time) {
    global.__repairReservations = { tick: Game.time, map: {} };
    state = global.__repairReservations;
  }
  return state.map;
}

function reserveRepairTarget(targetId, creepName) {
  if (!targetId) return false;
  var map = reservationMap();
  var entry = map[targetId];
  if (!entry || entry.name === creepName) {
    map[targetId] = { name: creepName, tick: Game.time };
    return true;
  }
  return false;
}

function releaseRepairTarget(targetId, creepName) {
  if (!targetId) return;
  var map = reservationMap();
  var entry = map[targetId];
  if (!entry) return;
  if (!creepName || entry.name === creepName) {
    delete map[targetId];
  }
}

function moveToTarget(creep, dest, range) {
  range = (range != null) ? range : 3;
  if (BeeToolbox && typeof BeeToolbox.BeeTravel === 'function') {
    BeeToolbox.BeeTravel(creep, dest.pos || dest, { range: range, reusePath: 15 });
    return;
  }
  if (creep.travelTo) {
    creep.travelTo(dest, { range: range, reusePath: 15 });
    return;
  }
  creep.moveTo(dest, { reusePath: 15 });
}

function ensureRepairAssignment(creep, room, queue) {
  var currentId = creep.memory.repairTargetId;
  var current = currentId ? Game.getObjectById(currentId) : null;
  if (current && current.hits >= current.hitsMax) {
    releaseRepairTarget(currentId, creep.name);
    current = null;
    creep.memory.repairTargetId = null;
  }

  if (current) return current;

  if (currentId) {
    releaseRepairTarget(currentId, creep.name);
    creep.memory.repairTargetId = null;
  }

  if (!queue || !queue.length) return null;

  for (var i = 0; i < queue.length; i++) {
    var entry = queue[i];
    if (!entry || !entry.id) continue;
    if (!reserveRepairTarget(entry.id, creep.name)) continue;
    var obj = Game.getObjectById(entry.id);
    if (!obj || obj.hits >= obj.hitsMax) {
      releaseRepairTarget(entry.id, creep.name);
      continue;
    }
    creep.memory.repairTargetId = entry.id;
    return obj;
  }

  return null;
}

function tryAcquireEnergy(creep, caps) {
  var opts = {
    minAmount: 80,
    allowStorage: true,
    allowContainers: true,
    allowDropped: true,
    allowRemains: true,
    allowLinks: true,
    preferPos: creep.pos
  };
  if (caps && caps.hasTerminal) {
    opts.allowTerminal = true;
  }
  if (!caps || !caps.hasStorage) {
    opts.allowSpawn = true;
    opts.allowSourceContainers = true;
  } else {
    opts.allowSourceContainers = false;
  }

  var target = BeeToolbox.pickEnergyWithdrawTarget(creep, opts);
  if (!target) return false;

  var rc;
  if (target.resourceType === RESOURCE_ENERGY && target.amount != null) {
    rc = creep.pickup(target);
    if (rc === ERR_NOT_IN_RANGE) moveToTarget(creep, target, 1);
    return true;
  }

  if (target.store && target.store[RESOURCE_ENERGY] != null) {
    rc = creep.withdraw(target, RESOURCE_ENERGY);
    if (rc === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, target, 1);
    } else if (rc === ERR_NOT_ENOUGH_RESOURCES) {
      return false;
    }
    return true;
  }

  if (typeof target.energy === 'number' && target.energy > 0) {
    rc = creep.withdraw(target, RESOURCE_ENERGY);
    if (rc === ERR_NOT_IN_RANGE) moveToTarget(creep, target, 1);
    return true;
  }

  return false;
}

var TaskRepair = {
  run: function (creep) {
    if (!creep || creep.spawning) return;

    var room = creep.room;
    if (!room) return;

    var signals = BeeToolbox.getRoomTaskSignals(room);
    var caps = signals.capabilities;
    var queue = BeeMaintenance.findStructuresNeedingRepair(room);
    var target = ensureRepairAssignment(creep, room, queue);

    if (!target) {
      if (creep.memory.repairTargetId) {
        releaseRepairTarget(creep.memory.repairTargetId, creep.name);
        creep.memory.repairTargetId = null;
      }
      creep.memory.task = 'idle';
      if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
        repairLog.debug('No repair targets available for room', signals.roomName);
      }
      return;
    }

    var carried = creep.store ? (creep.store.getUsedCapacity(RESOURCE_ENERGY) | 0) : 0;
    if (carried <= 0) {
      if (tryAcquireEnergy(creep, caps)) return;

      if (creep.getActiveBodyparts(WORK) > 0) {
        var source = creep.pos.findClosestByRange(FIND_SOURCES_ACTIVE);
        if (source) {
          if (creep.harvest(source) === ERR_NOT_IN_RANGE) {
            moveToTarget(creep, source, 1);
          }
        }
      }
      return;
    }

    var rc = creep.repair(target);
    if (rc === ERR_NOT_IN_RANGE) {
      moveToTarget(creep, target, 3);
      return;
    }

    if (rc !== OK) {
      if (rc === ERR_INVALID_TARGET || rc === ERR_NOT_ENOUGH_RESOURCES) {
        releaseRepairTarget(target.id, creep.name);
        creep.memory.repairTargetId = null;
      }
      return;
    }

    if (target.hits >= target.hitsMax) {
      releaseRepairTarget(target.id, creep.name);
      creep.memory.repairTargetId = null;
    }
  }
};

module.exports = TaskRepair;
