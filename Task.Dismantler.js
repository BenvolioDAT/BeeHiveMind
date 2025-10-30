var TaskSquad = require('Task.Squad');
var CoreSpawn = require('core.spawn');
var TaskSpawn = require('Task.Spawn');

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
    var debugInfo = {
      role: 'dismantler',
      state: (creep.memory && creep.memory.state) || 'active',
      intent: 'none',
      intentResult: null,
      reason: null,
      targetId: null,
      targetRange: null
    };

    if (creep.spawning) {
      debugInfo.reason = 'spawning';
      TaskSquad.logCombat(creep, debugInfo);
      return;
    }

    if (creep.memory.delay && Game.time < creep.memory.delay) {
      debugInfo.reason = 'delay';
      TaskSquad.logCombat(creep, debugInfo);
      return;
    }

    var target = Game.getObjectById(creep.memory.tid);
    if (target && target.owner && !isEnemyUsername(target.owner.username)) {
      TaskSquad.noteFriendlyFireAvoid(creep.name, target.owner.username, 'dismantler-memoryTarget');
      debugInfo.reason = 'friendlyFire';
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
      debugInfo.reason = 'friendlyFire';
      delete creep.memory.tid;
      target = null;
    }

    try {
      if (target) {
        debugInfo.targetId = target.id;
        debugInfo.targetRange = creep.pos.getRangeTo(target);
        var inMelee = creep.pos.isNearTo(target);
        var range = debugInfo.targetRange;

        if (target.structureType === STRUCTURE_INVADER_CORE) {
          if (range <= 3 && creep.getActiveBodyparts(RANGED_ATTACK) > 0) {
            debugInfo.intent = 'ranged';
            debugInfo.intentResult = creep.rangedAttack(target);
          }
          if (inMelee && creep.getActiveBodyparts(ATTACK) > 0) {
            debugInfo.intent = 'melee';
            debugInfo.intentResult = creep.attack(target);
          }
          if (!inMelee) {
            debugInfo.intent = 'move';
            debugInfo.intentResult = creep.moveTo(target, { reusePath: 10, maxRooms: 1 });
          }
          debugInfo.reason = debugInfo.reason || 'core';
          return;
        }

        if (inMelee) {
          var rc = creep.dismantle(target);
          debugInfo.intent = 'dismantle';
          debugInfo.intentResult = rc;
          if (rc === ERR_INVALID_TARGET && creep.getActiveBodyparts(ATTACK) > 0) {
            debugInfo.intent = 'melee';
            debugInfo.intentResult = creep.attack(target);
          }
          if (target.hits && target.hits <= 1000) delete creep.memory.tid;
        } else {
          debugInfo.intent = 'move';
          debugInfo.intentResult = creep.moveTo(target, { reusePath: 10, maxRooms: 1 });
        }
      } else {
        var rally = Game.flags.Rally || Game.flags.Attack;
        if (rally) {
          debugInfo.intent = 'move';
          debugInfo.intentResult = creep.moveTo(rally, { reusePath: 20 });
          debugInfo.reason = 'rally';
        } else {
          debugInfo.reason = debugInfo.reason || 'idle';
        }
      }
    } finally {
      TaskSquad.logCombat(creep, debugInfo);
    }
  }
};

module.exports = TaskDismantler;

function loadDismantlerTiersFromSpec() {
  if (!TaskSpawn || typeof TaskSpawn.getTierList !== 'function') {
    return null;
  }
  var tiers = TaskSpawn.getTierList('dismantler');
  if (!Array.isArray(tiers) || !tiers.length) {
    return null;
  }
  var copies = [];
  for (var i = 0; i < tiers.length; i++) {
    var tier = tiers[i];
    if (!tier || !Array.isArray(tier.parts)) {
      continue;
    }
    copies.push(tier.parts.slice());
  }
  return copies.length ? copies : null;
}

var DISMANTLER_BODY_TIERS = loadDismantlerTiersFromSpec() || [
  [
    WORK, WORK, WORK, WORK, WORK,
    MOVE, MOVE, MOVE, MOVE, MOVE
  ]
];

module.exports.BODY_TIERS = DISMANTLER_BODY_TIERS.map(function (tier) {
  return tier.slice();
});

function cloneSpawnContext(context) {
  if (!context || typeof context !== 'object') {
    return {};
  }
  var copy = {};
  for (var key in context) {
    if (!Object.prototype.hasOwnProperty.call(context, key)) {
      continue;
    }
    copy[key] = context[key];
  }
  return copy;
}

module.exports.getSpawnBody = function (energyOrRoom, roomOrContext, maybeContext) {
  var spawnModule = TaskSpawn;
  var room = null;
  var context = {};

  if (typeof energyOrRoom === 'number') {
    room = roomOrContext || null;
    context = cloneSpawnContext(maybeContext);
    if (context.availableEnergy == null) {
      context.availableEnergy = energyOrRoom;
    }
  } else {
    room = energyOrRoom || null;
    context = cloneSpawnContext(roomOrContext);
  }

  if (spawnModule && typeof spawnModule.getBodyFor === 'function') {
    var info = spawnModule.getBodyFor('dismantler', room, context) || {};
    if (info && Array.isArray(info.parts) && info.parts.length) {
      return info.parts.slice();
    }
  }

  var available = context.availableEnergy;
  if (available == null && room && typeof room.energyAvailable === 'number') {
    available = room.energyAvailable;
  }
  if (available == null && typeof energyOrRoom === 'number') {
    available = energyOrRoom;
  }
  if (available == null) {
    available = 0;
  }
  var fallback = CoreSpawn.pickLargestAffordable(DISMANTLER_BODY_TIERS, available);
  return Array.isArray(fallback) ? fallback.slice() : [];
};

module.exports.getSpawnSpec = function (room, ctx) {
  var context = cloneSpawnContext(ctx);
  var info = TaskSpawn && typeof TaskSpawn.getBodyFor === 'function'
    ? TaskSpawn.getBodyFor('dismantler', room, context)
    : null;
  var body = info && Array.isArray(info.parts) ? info.parts.slice() : null;
  if (!body || !body.length) {
    var available = (context && typeof context.availableEnergy === 'number') ? context.availableEnergy : null;
    if (available === null && room && typeof room.energyAvailable === 'number') {
      available = room.energyAvailable;
    }
    var fallback = CoreSpawn.pickLargestAffordable(DISMANTLER_BODY_TIERS, available || 0);
    body = Array.isArray(fallback) ? fallback.slice() : [];
  }
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
