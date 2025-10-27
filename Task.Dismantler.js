// Task.Dismantler.js — siege with Invader Core handling (ES5-safe)
'use strict';

var TaskSquad = require('Task.Squad');
var CoreSpawn = require('core.spawn');

var _cachedUsername = null;

function getMyUsername() {
  if (_cachedUsername) return _cachedUsername;

  var name = null;
  var k;

  for (k in Game.spawns) {
    if (!Game.spawns.hasOwnProperty(k)) continue;
    var sp = Game.spawns[k];
    if (sp && sp.owner && sp.owner.username) {
      name = sp.owner.username;
      break;
    }
  }

  if (!name) {
    for (k in Game.creeps) {
      if (!Game.creeps.hasOwnProperty(k)) continue;
      var c = Game.creeps[k];
      if (c && c.owner && c.owner.username) {
        name = c.owner.username;
        break;
      }
    }
  }

  _cachedUsername = name || 'me';
  return _cachedUsername;
}

function isAllyUsername(username) {
  if (!username) return false;
  if (TaskSquad && typeof TaskSquad.isAlly === 'function') {
    return TaskSquad.isAlly(username);
  }
  return false;
}

function isEnemyUsername(username) {
  if (!username) return false;
  if (isAllyUsername(username)) return false;
  var mine = getMyUsername();
  if (mine && username === mine) return false;
  return true;
}

function isEnemyStructure(structure) {
  if (!structure || !structure.owner || !structure.owner.username) return false;
  return isEnemyUsername(structure.owner.username);
}

var TaskDismantler = {
  run: function (creep) {
    if (creep.spawning) return;

    // Optional “wait behind decoy” start delay
    if (creep.memory.delay && Game.time < creep.memory.delay) return;

    var target = Game.getObjectById(creep.memory.tid);
    if (target && target.owner && !isEnemyUsername(target.owner.username)) {
      TaskSquad.noteFriendlyFireAvoid(creep.name, target.owner.username, 'dismantler-memoryTarget');
      delete creep.memory.tid;
      target = null;
    }

    // Small helper: pathable closest-by-path from a list
    function closest(arr) { return (arr && arr.length) ? creep.pos.findClosestByPath(arr) : null; }

    // -------- A) Acquire target --------
    if (!target) {
      // 1) High-priority threats first
      var towers = creep.room.find(FIND_HOSTILE_STRUCTURES, {
        filter: function (s) {
          if (s.structureType !== STRUCTURE_TOWER) return false;
          if (s.owner && !isEnemyStructure(s)) return false;
          return true;
        }
      });
      var spawns = creep.room.find(FIND_HOSTILE_SPAWNS, {
        filter: function (s) {
          if (!s) return false;
          if (s.owner && !isEnemyUsername(s.owner.username)) return false;
          return true;
        }
      });

      // 2) Explicitly include Invader Cores
      var cores = creep.room.find(FIND_HOSTILE_STRUCTURES, {
        filter: function (s) { return s.structureType === STRUCTURE_INVADER_CORE; }
      });

      // 3) Everything else that’s dismantle-worthy
      var others = creep.room.find(FIND_HOSTILE_STRUCTURES, {
        filter: function (s) {
          if (!s || s.hits === undefined) return false;
          if (s.owner && !isEnemyStructure(s)) return false;
          // exclude types we don't want to waste time dismantling
          if (s.structureType === STRUCTURE_CONTROLLER) return false;
          if (s.structureType === STRUCTURE_ROAD)        return false;
          if (s.structureType === STRUCTURE_CONTAINER)   return false;
          if (s.structureType === STRUCTURE_EXTENSION)   return false;
          if (s.structureType === STRUCTURE_LINK)        return false;
          if (s.structureType === STRUCTURE_TOWER)       return false;
          if (s.structureType === STRUCTURE_SPAWN)       return false;
          if (s.structureType === STRUCTURE_INVADER_CORE) return false; // handled separately
          return true;
        }
      });

      // Priority: towers → spawns → cores → others
      target = closest(towers) || closest(spawns) || closest(cores) || closest(others);

      // If the path is blocked, hit the first blocking wall/rampart
      if (target) {
        var path = creep.room.findPath(creep.pos, target.pos, { maxOps: 500, ignoreCreeps: true });
        for (var i = 0; i < path.length; i++) {
          var step = path[i];
          var structs = creep.room.lookForAt(LOOK_STRUCTURES, step.x, step.y);
          for (var j = 0; j < structs.length; j++) {
            var st = structs[j];
            if (st && st.structureType) {
              if (st.structureType === STRUCTURE_WALL) { target = st; break; }
              if (st.structureType === STRUCTURE_RAMPART && !st.my) { target = st; break; }
            }
          }
          if (target.id === (st && st.id)) break;
        }
        creep.memory.tid = target.id;
      }
    }

    // -------- B) Execute action --------
    if (target && target.owner && !isEnemyUsername(target.owner.username)) {
      TaskSquad.noteFriendlyFireAvoid(creep.name, target.owner.username, 'dismantler-active');
      delete creep.memory.tid;
      target = null;
    }

    if (target) {
      var inMelee = creep.pos.isNearTo(target);
      var range = creep.pos.getRangeTo(target);

      // Special case: Invader Core must be attacked (not dismantled)
      if (target.structureType === STRUCTURE_INVADER_CORE) {
        // Try ranged if we have it and are in range 3
        if (range <= 3 && creep.getActiveBodyparts(RANGED_ATTACK) > 0) {
          creep.rangedAttack(target);
        }
        // Close in to melee and attack if possible
        if (inMelee && creep.getActiveBodyparts(ATTACK) > 0) {
          creep.attack(target);
        }
        if (!inMelee) {
          creep.moveTo(target, { reusePath: 10, maxRooms: 1 });
        }
        // If we have no ATTACK parts at all, keep ID so escorts can kill it,
        // or you can spawn a proper smasher for cores.
        return;
      }

      // Normal hostile structure: dismantle is most efficient
      if (inMelee) {
        var rc = creep.dismantle(target);
        // If dismantle is invalid for any reason, try attack as a fallback
        if (rc === ERR_INVALID_TARGET) {
          if (creep.getActiveBodyparts(ATTACK) > 0) creep.attack(target);
        }
        // Retarget early when low hits to avoid idle ticks on empty swings
        if (target.hits && target.hits <= 1000) delete creep.memory.tid;
      } else {
        creep.moveTo(target, { reusePath: 10, maxRooms: 1 });
      }
    } else {
      // No targets: rally
      var rally = Game.flags.Rally || Game.flags.Attack;
      if (rally) creep.moveTo(rally, { reusePath: 20 });
    }
  }
};

module.exports = TaskDismantler;

var DISMANTLER_BODY_TIERS = [
  [
    WORK, WORK, WORK, WORK, WORK,
    MOVE, MOVE, MOVE, MOVE, MOVE
  ]
];

module.exports.BODY_TIERS = DISMANTLER_BODY_TIERS.map(function (tier) {
  return tier.slice();
});

module.exports.getSpawnBody = function (energy) {
  return CoreSpawn.pickLargestAffordable(DISMANTLER_BODY_TIERS, energy);
};

module.exports.getSpawnSpec = function (room, ctx) {
  var context = ctx || {};
  var available = (typeof context.availableEnergy === 'number') ? context.availableEnergy : null;
  if (available === null && room && typeof room.energyAvailable === 'number') {
    available = room.energyAvailable;
  }
  var body = module.exports.getSpawnBody(available, room, context);
  return {
    body: body,
    namePrefix: 'Dismantler',
    memory: {
      role: 'Worker_Bee',
      task: 'Dismantler',
      home: room && room.name
    }
  };
};
