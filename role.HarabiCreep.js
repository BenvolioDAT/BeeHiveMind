'use strict';

// -----------------------------------------------------------------------------
// role.HarabiCreep.js - shared Harabi-style creep rules for local role modules
// Responsibilities:
// * Normalize role identity and home memory before role-specific logic runs.
// * Provide Harabi-style idler, movement, and combat utility helpers.
// * Keep role modules small: role files own decisions, this file owns common
//   lifecycle and low-level creep rules.
// Reference shape: sy-harabi/screeps-harabi-bot-sample role utility modules.
// -----------------------------------------------------------------------------

var MovementManager = require('Movement.Manager');
var BeeToolbox = require('BeeToolbox');
var Roles = require('core.roles');

var COMBAT_PART_POWER = {};
COMBAT_PART_POWER[ATTACK] = ATTACK_POWER;
COMBAT_PART_POWER[RANGED_ATTACK] = RANGED_ATTACK_POWER;
COMBAT_PART_POWER[HEAL] = HEAL_POWER;

var ATTACKER_PARTS = [ATTACK, RANGED_ATTACK];
var COMBATANT_PARTS = [ATTACK, RANGED_ATTACK, HEAL];
var THREAT_PARTS = [ATTACK, RANGED_ATTACK, HEAL, WORK, CLAIM];

function normalizeGoals(goals) {
  goals = Array.isArray(goals) ? goals : [goals];
  var out = [];
  for (var i = 0; i < goals.length; i++) {
    var goal = goals[i];
    if (!goal) continue;
    var pos = goal.pos || goal;
    if (!pos || pos.x == null || pos.y == null || !pos.roomName) continue;
    var range = goal.range;
    if (range == null) range = 0;
    range = Number(range);
    if (isNaN(range)) range = 0;
    out.push({ pos: pos, range: range });
  }
  return out;
}

function getHomeRoomName(creep) {
  if (!creep) return null;
  if (creep.memory) {
    if (creep.memory.home) return creep.memory.home;
    if (creep.memory._home) return creep.memory._home;
    if (creep.memory.spawnRoom) return creep.memory.spawnRoom;
  }
  if (creep.room && creep.room.name) return creep.room.name;
  return null;
}

function ensureHome(creep) {
  if (!creep || !creep.memory) return null;
  var home = getHomeRoomName(creep);
  if (!home) return null;
  creep.memory.home = home;
  return home;
}

function getHeap(creep) {
  if (!creep || !creep.name) return {};
  if (!global.__BHM) global.__BHM = {};
  if (!global.__BHM.harabiCreepHeap || global.__BHM.harabiCreepHeap.tick !== Game.time) {
    global.__BHM.harabiCreepHeap = { tick: Game.time, creeps: {} };
  }
  var bucket = global.__BHM.harabiCreepHeap.creeps;
  if (!bucket[creep.name]) bucket[creep.name] = {};
  return bucket[creep.name];
}

function clearTargetMemory(creep) {
  if (!creep || !creep.memory) return;
  delete creep.memory.targetId;
  delete creep.memory.combatTargetId;
  delete creep.memory.deliveryTargetId;
  delete creep.memory.targetDroppedEnergyId;
}

var HarabiCreep = {
  setIdler: function (creep) {
    if (!creep || !creep.memory) return;
    creep.memory.role = 'Idle';
    creep.memory.task = undefined;
    creep.memory.state = 'IDLE';
    clearTargetMemory(creep);
  },

  ensureIdentity: function (creep, roleName, opts) {
    if (!creep || !creep.memory) return;
    opts = opts || {};
    creep.memory.role = roleName;
    if (!creep.memory.task) creep.memory.task = opts.task || Roles.taskForRole(roleName);
    ensureHome(creep);
    if (!creep.memory.state) creep.memory.state = opts.defaultState || 'IDLE';
  },

  wrapRole: function (roleName, runFn, opts) {
    opts = opts || {};
    return {
      role: roleName,
      run: function (creep) {
        if (!creep) return;
        HarabiCreep.ensureIdentity(creep, roleName, opts);
        if (creep.spawning && opts.runWhileSpawning !== true) return;
        return runFn(creep);
      }
    };
  },

  wrapModule: function (roleModule, opts) {
    if (!roleModule || typeof roleModule.run !== 'function') return roleModule;
    var roleName = roleModule.role || (opts && opts.role);
    var originalRun = roleModule.run;
    roleModule.run = function (creep) {
      if (!creep) return;
      HarabiCreep.ensureIdentity(creep, roleName, opts || {});
      if (creep.spawning && (!opts || opts.runWhileSpawning !== true)) return;
      return originalRun(creep);
    };
    return roleModule;
  },

  heap: getHeap,
  getHomeRoomName: getHomeRoomName,
  ensureHome: ensureHome,

  getBodyCost: function (body) {
    var cost = 0;
    if (!body) return cost;
    for (var i = 0; i < body.length; i++) {
      var part = body[i];
      var type = part && (part.type || part);
      cost += BODYPART_COST[type] || 0;
    }
    return cost;
  },

  getCombatStat: function (creep) {
    var attack = 0;
    var ranged = 0;
    var heal = 0;
    if (!creep || !creep.body) return { attack: attack, ranged: ranged, heal: heal };
    for (var i = 0; i < creep.body.length; i++) {
      var part = creep.body[i];
      if (!part || part.hits <= 0) continue;
      var amount = COMBAT_PART_POWER[part.type] || 0;
      if (!amount) continue;
      if (part.boost && BOOSTS[part.type] && BOOSTS[part.type][part.boost]) {
        amount *= BOOSTS[part.type][part.boost][part.type] || 1;
      }
      if (part.type === ATTACK) attack += amount;
      else if (part.type === RANGED_ATTACK) ranged += amount;
      else if (part.type === HEAL) heal += amount;
    }
    return { attack: attack, ranged: ranged, heal: heal };
  },

  hasAnyActivePart: function (creep, parts) {
    if (!creep || !parts) return false;
    for (var i = 0; i < parts.length; i++) {
      if (creep.getActiveBodyparts(parts[i]) > 0) return true;
    }
    return false;
  },

  isAttacker: function (creep) {
    return HarabiCreep.hasAnyActivePart(creep, ATTACKER_PARTS);
  },

  isCombatant: function (creep) {
    return HarabiCreep.hasAnyActivePart(creep, COMBATANT_PARTS);
  },

  isThreat: function (creep) {
    return HarabiCreep.hasAnyActivePart(creep, THREAT_PARTS);
  },

  moveCreep: function (creep, goals, opts) {
    if (!creep || creep.spawning) return ERR_INVALID_ARGS;
    if (creep.fatigue || creep.getActiveBodyparts(MOVE) === 0) return ERR_TIRED;
    opts = opts || {};

    var normalized = normalizeGoals(goals);
    if (!normalized.length) return ERR_INVALID_TARGET;

    var inGoal = false;
    var insideFleeRange = false;
    for (var i = 0; i < normalized.length; i++) {
      var goalRange = creep.pos.getRangeTo(normalized[i].pos);
      if (goalRange <= normalized[i].range) {
        inGoal = true;
      }
      if (goalRange < normalized[i].range) insideFleeRange = true;
    }
    if (!opts.flee && inGoal) return OK;
    if (opts.flee && !insideFleeRange) return OK;

    var best = normalized[0];
    var bestRange = creep.pos.getRangeTo(best.pos);
    for (var j = 1; j < normalized.length; j++) {
      var range = creep.pos.getRangeTo(normalized[j].pos);
      if (range < bestRange) {
        best = normalized[j];
        bestRange = range;
      }
    }

    var priority = opts.priority;
    if (priority == null && opts.intentType && MovementManager.PRIORITIES) {
      priority = MovementManager.PRIORITIES[opts.intentType];
    }
    if (priority == null && MovementManager.PRIORITIES) priority = MovementManager.PRIORITIES.default;
    if (priority == null) priority = 0;

    if (MovementManager && typeof MovementManager.request === 'function') {
      return MovementManager.request(creep, best.pos, priority, {
        range: best.range,
        reusePath: opts.reusePath,
        ignoreCreeps: opts.ignoreCreeps,
        maxOps: opts.maxOps,
        plainCost: opts.plainCost,
        swampCost: opts.swampCost,
        flee: opts.flee,
        intentType: opts.intentType || 'default'
      });
    }

    if (typeof creep.travelTo === 'function') {
      return creep.travelTo(best.pos, {
        range: best.range,
        reusePath: opts.reusePath || 20,
        ignoreCreeps: opts.ignoreCreeps,
        maxOps: opts.maxOps || 4000,
        flee: opts.flee || false
      });
    }

    if (BeeToolbox && typeof BeeToolbox.BeeTravel === 'function') {
      return BeeToolbox.BeeTravel(creep, best.pos, { range: best.range, reusePath: opts.reusePath || 20 });
    }

    return ERR_NO_PATH;
  },

  combatScore: function (creep) {
    var stat = HarabiCreep.getCombatStat(creep);
    return stat.attack + stat.ranged + stat.heal;
  },

  findHostiles: function (room) {
    if (!room) return [];
    return room.find(FIND_HOSTILE_CREEPS, {
      filter: function (hostile) {
        return hostile && hostile.owner && !HarabiCreep.isAlly(hostile) && HarabiCreep.isThreat(hostile);
      }
    });
  },

  isAlly: function (creep) {
    if (!creep || !creep.owner) return false;
    var allies = (Memory.diplomacy && Memory.diplomacy.allies) || [];
    if (!Array.isArray(allies)) return false;
    return allies.indexOf(creep.owner.username) !== -1;
  },

  pickCombatTarget: function (creep) {
    if (!creep || !creep.room) return null;
    var hostiles = HarabiCreep.findHostiles(creep.room);
    if (!hostiles.length) return null;

    var best = null;
    var bestScore = -Infinity;
    var bestRange = Infinity;
    for (var i = 0; i < hostiles.length; i++) {
      var hostile = hostiles[i];
      var stat = HarabiCreep.getCombatStat(hostile);
      var score = (stat.heal * 2) + stat.ranged + stat.attack;
      var range = creep.pos.getRangeTo(hostile);
      if (score > bestScore || (score === bestScore && range < bestRange)) {
        best = hostile;
        bestScore = score;
        bestRange = range;
      }
    }
    return best || creep.pos.findClosestByRange(hostiles);
  },

  recordCombatMemory: function (creep, status, target) {
    if (!creep || !creep.memory) return;
    creep.memory.combatStatus = status;
    creep.memory.combatTargetId = target && target.id ? target.id : null;
    creep.memory.combatTargetRoom = target && target.pos ? target.pos.roomName : (creep.room && creep.room.name);
    creep.memory.combatLastSeen = Game.time;
    creep.memory.state = String(status || 'idle').toUpperCase();
  }
};

module.exports = HarabiCreep;
