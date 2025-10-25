// Task.Dismantler.js — siege with Invader Core handling (ES5-safe)
'use strict';

var BeeToolbox = require('BeeToolbox');
var AllianceManager = require('AllianceManager');

// Confirm creep targets enemy structures (STRUCTURE_SPAWN, TOWER, EXTENSION, etc.)
var PRIORITY_TYPES = [
  STRUCTURE_TOWER,
  STRUCTURE_SPAWN,
  STRUCTURE_EXTENSION,
  STRUCTURE_STORAGE,
  STRUCTURE_TERMINAL,
  STRUCTURE_LAB,
  STRUCTURE_FACTORY,
  STRUCTURE_POWER_SPAWN,
  STRUCTURE_NUKER,
  STRUCTURE_OBSERVER,
  STRUCTURE_LINK
];

var PRIORITY_MAP = (function () {
  var map = Object.create(null);
  for (var i = 0; i < PRIORITY_TYPES.length; i++) {
    map[PRIORITY_TYPES[i]] = i;
  }
  return map;
})();

function hasPriority(type) {
  return Object.prototype.hasOwnProperty.call(PRIORITY_MAP, type);
}

function isEnemyStructureTarget(structure) {
  if (!structure) return false;
  if (structure.structureType === STRUCTURE_INVADER_CORE) return true;
  if (structure.structureType === STRUCTURE_CONTROLLER) return false;
  if (structure.structureType === STRUCTURE_ROAD) return false;
  if (structure.structureType === STRUCTURE_CONTAINER) return false;
  if (!structure.owner || !structure.owner.username) return false;
  if (BeeToolbox && typeof BeeToolbox.isEnemyStructure === 'function') {
    return BeeToolbox.isEnemyStructure(structure);
  }
  if (BeeToolbox && typeof BeeToolbox.isEnemyUsername === 'function') {
    return BeeToolbox.isEnemyUsername(structure.owner.username);
  }
  return true;
}

function travelToTarget(creep, destination, range) {
  var dest = destination && destination.pos ? destination.pos : destination;
  var opts = { range: (range != null) ? range : 1, reusePath: 5, maxRooms: 1 };
  if (creep.travelTo) {
    return creep.travelTo(dest, opts);
  }
  if (dest && dest.x != null && dest.y != null && dest.roomName) {
    return creep.moveTo(new RoomPosition(dest.x, dest.y, dest.roomName), { reusePath: 10, maxRooms: 1 });
  }
  return creep.moveTo(dest, { reusePath: 10, maxRooms: 1 });
}

function findBarrierAlongPath(creep, primaryTarget) {
  if (!creep || !primaryTarget || !creep.room) return null;
  var path = creep.room.findPath(creep.pos, primaryTarget.pos, { maxOps: 500, ignoreCreeps: true });
  for (var i = 0; i < path.length; i++) {
    var step = path[i];
    var structures = creep.room.lookForAt(LOOK_STRUCTURES, step.x, step.y) || [];
    for (var j = 0; j < structures.length; j++) {
      var st = structures[j];
      if (!st || !st.structureType) continue;
      if (st.structureType === STRUCTURE_WALL) {
        return st;
      }
      if (st.structureType === STRUCTURE_RAMPART) {
        if (st.my) continue;
        if (st.owner && st.owner.username && BeeToolbox && typeof BeeToolbox.isEnemyUsername === 'function') {
          if (!BeeToolbox.isEnemyUsername(st.owner.username)) {
            continue;
          }
        }
        return st;
      }
    }
  }
  return null;
}

var TaskDismantler = {
  run: function (creep) {
    if (!creep || creep.spawning) return;

    if (creep.memory.delay && Game.time < creep.memory.delay) return;

    var targetId = creep.memory.tid;
    var target = targetId ? Game.getObjectById(targetId) : null;

    if (target && target.owner && BeeToolbox && typeof BeeToolbox.isEnemyUsername === 'function') {
      if (!BeeToolbox.isEnemyUsername(target.owner.username)) {
        AllianceManager.noteFriendlyFireAvoid(creep.name, target.owner.username, 'dismantler-memoryTarget');
        delete creep.memory.tid;
        target = null;
      }
    }
    if (!target) {
      delete creep.memory.tid;
    }

    if (!target) {
      var room = creep.room;
      if (room) {
        var candidates = room.find(FIND_HOSTILE_STRUCTURES, {
          filter: function (s) { return isEnemyStructureTarget(s); }
        }) || [];
        var best = null;
        var bestPriority = PRIORITY_TYPES.length + 5;
        var fallback = null;
        for (var i = 0; i < candidates.length; i++) {
          var struct = candidates[i];
          if (!struct) continue;
          if (struct.structureType === STRUCTURE_INVADER_CORE) {
            best = struct;
            bestPriority = -1;
            break;
          }
          if (hasPriority(struct.structureType)) {
            var pri = PRIORITY_MAP[struct.structureType];
            if (pri < bestPriority) {
              bestPriority = pri;
              best = struct;
            }
            continue;
          }
          if (!fallback || (struct.hits || 0) < (fallback.hits || Infinity)) {
            fallback = struct;
          }
        }
        if (!best) {
          best = fallback;
        }
        if (!best) {
          var hostileSpawns = room.find(FIND_HOSTILE_SPAWNS, {
            filter: function (s) {
              if (!s || !s.owner || !s.owner.username) return false;
              if (BeeToolbox && typeof BeeToolbox.isEnemyUsername === 'function') {
                return BeeToolbox.isEnemyUsername(s.owner.username);
              }
              return true;
            }
          }) || [];
          if (hostileSpawns.length) {
            best = hostileSpawns[0];
          }
        }
        if (best) {
          var barrier = findBarrierAlongPath(creep, best);
          target = barrier || best;
          if (target && target.id) {
            creep.memory.tid = target.id;
          }
        }
      }
    }

    if (target && target.owner && BeeToolbox && typeof BeeToolbox.isEnemyUsername === 'function') {
      if (!BeeToolbox.isEnemyUsername(target.owner.username)) {
        AllianceManager.noteFriendlyFireAvoid(creep.name, target.owner.username, 'dismantler-active');
        delete creep.memory.tid;
        target = null;
      }
    }

    if (!target) {
      var rally = Game.flags.Rally || Game.flags.Attack;
      if (rally) {
        travelToTarget(creep, rally, 1);
      }
      return;
    }

    var range = creep.pos.getRangeTo(target);
    var inMelee = range <= 1;

    if (target.structureType === STRUCTURE_INVADER_CORE) {
      if (range <= 3 && creep.getActiveBodyparts(RANGED_ATTACK) > 0) {
        creep.rangedAttack(target);
      }
      if (inMelee && creep.getActiveBodyparts(ATTACK) > 0) {
        creep.attack(target);
      }
      if (!inMelee) {
        travelToTarget(creep, target, 1);
      }
      return;
    }

    if (inMelee) {
      var result = creep.dismantle(target);
      if (result === ERR_INVALID_TARGET && creep.getActiveBodyparts(ATTACK) > 0) {
        creep.attack(target);
      }
      if (target.hits && target.hits <= 1000) {
        delete creep.memory.tid;
      }
    } else {
      travelToTarget(creep, target, 1);
    }
  }
};

module.exports = TaskDismantler;
