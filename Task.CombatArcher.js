// Task.CombatArcher.js — Stoic archer (no dancing) + DPS-first + safe kiting (ES5-safe)
'use strict';

var Traveler = null;
try {
  Traveler = require('Traveler');
} catch (error) {
  Traveler = null;
}
var TaskSquad = require('Task.Squad');

var _cachedUsername = null;

function _getMyUsername() {
  if (_cachedUsername) return _cachedUsername;
  if (!Game) return null;
  var name;
  if (Game.spawns) {
    for (name in Game.spawns) {
      if (!Game.spawns.hasOwnProperty(name)) continue;
      var spawn = Game.spawns[name];
      if (spawn && spawn.my && spawn.owner && spawn.owner.username) {
        _cachedUsername = spawn.owner.username;
        return _cachedUsername;
      }
    }
  }
  if (Game.creeps) {
    for (name in Game.creeps) {
      if (!Game.creeps.hasOwnProperty(name)) continue;
      var creep = Game.creeps[name];
      if (creep && creep.my && creep.owner && creep.owner.username) {
        _cachedUsername = creep.owner.username;
        return _cachedUsername;
      }
    }
  }
  return _cachedUsername;
}

function isEnemyUsername(username) {
  if (!username) return false;
  if (TaskSquad && typeof TaskSquad.isAlly === 'function' && TaskSquad.isAlly(username)) {
    return false;
  }
  var mine = _getMyUsername();
  if (mine && username === mine) {
    return false;
  }
  return true;
}

function isEnemyCreep(creep) {
  if (!creep || !creep.owner) return false;
  return isEnemyUsername(creep.owner.username);
}

function _noteFriendlyFire(creep, target, context) {
  if (!creep || !target || !target.owner || !target.owner.username) return;
  if (!TaskSquad || typeof TaskSquad.noteFriendlyFireAvoid !== 'function') return;
  TaskSquad.noteFriendlyFireAvoid(creep.name, target.owner.username, context);
}

function shouldWaitForMedic(attacker) {
  if (!attacker) return false;
  var medic = null;
  if (Game && Game.creeps) {
    for (var name in Game.creeps) {
      if (!Game.creeps.hasOwnProperty(name)) continue;
      var c = Game.creeps[name];
      if (!c || !c.memory) continue;
      if (c.memory.role === 'CombatMedic' && c.memory.followTarget === attacker.id) {
        medic = c;
        break;
      }
    }
  }
  if (!medic) return false;
  attacker.memory = attacker.memory || {};
  if (attacker.memory.noWaitForMedic) return false;
  if (attacker.memory.waitTicks === undefined) attacker.memory.waitTicks = 0;

  var nearExit = (attacker.pos.x <= 3 || attacker.pos.x >= 46 || attacker.pos.y <= 3 || attacker.pos.y >= 46);

  if (!attacker.memory.advanceDone && !attacker.pos.inRangeTo(medic, 2)) {
    attacker.memory.waitTicks = 2;
    if (nearExit) {
      var center = new RoomPosition(25, 25, attacker.room.name);
      var dir = attacker.pos.getDirectionTo(center);
      attacker.move(dir);
      attacker.say('🚶 Clear exit');
      return true;
    }
    return true;
  }

  if (attacker.memory.waitTicks > 0) {
    attacker.memory.waitTicks--;
    return true;
  }

  return false;
}

function isInTowerDanger(pos, radius) {
  if (!pos) return false;
  var room = Game.rooms && Game.rooms[pos.roomName];
  if (!room) return false;
  var limit = (typeof radius === 'number') ? radius : 20;
  var towers = room.find(FIND_HOSTILE_STRUCTURES, {
    filter: function (structure) {
      if (!structure || structure.structureType !== STRUCTURE_TOWER) return false;
      if (structure.owner && !isEnemyUsername(structure.owner.username)) return false;
      return true;
    }
  });
  for (var i = 0; i < towers.length; i++) {
    if (towers[i].pos.getRangeTo(pos) <= limit) {
      return true;
    }
  }
  return false;
}

function combatInHoldBand(range, desiredRange, holdBand) {
  if (typeof range !== 'number') return false;
  var desired = (typeof desiredRange === 'number') ? desiredRange : 1;
  var band = (typeof holdBand === 'number') ? holdBand : 0;
  if (range < desired) return false;
  if (range > (desired + band)) return false;
  return true;
}

function combatThreats(room) {
  if (!room) return [];
  var threats = [];
  var hostiles = room.find(FIND_HOSTILE_CREEPS, {
    filter: function (c) {
      if (!isEnemyCreep(c)) return false;
      return c.getActiveBodyparts(ATTACK) > 0 || c.getActiveBodyparts(RANGED_ATTACK) > 0;
    }
  });
  for (var i = 0; i < hostiles.length; i++) {
    threats.push(hostiles[i]);
  }
  var towers = room.find(FIND_HOSTILE_STRUCTURES, {
    filter: function (structure) {
      if (!structure || structure.structureType !== STRUCTURE_TOWER) return false;
      if (structure.owner && !isEnemyUsername(structure.owner.username)) return false;
      return true;
    }
  });
  for (var j = 0; j < towers.length; j++) {
    threats.push(towers[j]);
  }
  return threats;
}

function combatShootOpportunistic(creep) {
  if (!creep) return false;
  var closer = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS, {
    filter: function (c) {
      return isEnemyCreep(c);
    }
  });
  if (closer && creep.pos.inRangeTo(closer, 3)) {
    creep.rangedAttack(closer);
    return true;
  }
  return false;
}

function combatShootPrimary(creep, target, config) {
  if (!creep || !target) return false;
  var opts = config || {};
  var threshold = (opts.massAttackThreshold != null) ? opts.massAttackThreshold : 3;
  var hostiles = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 3, {
    filter: function (c) {
      return isEnemyCreep(c);
    }
  });
  if (hostiles.length >= threshold) {
    creep.rangedMassAttack();
    return true;
  }
  var range = creep.pos.getRangeTo(target);
  if (range <= 3) {
    if (target.owner && !isEnemyCreep(target)) {
      _noteFriendlyFire(creep, target, 'ranged-attack');
      return false;
    }
    creep.rangedAttack(target);
    return true;
  }
  return combatShootOpportunistic(creep);
}

function _runRoomCallback(roomCallback, roomName, matrix) {
  if (typeof roomCallback !== 'function') return undefined;
  try {
    return roomCallback(roomName, matrix);
  } catch (error) {
    return undefined;
  }
}

function combatFlee(creep, fromThings, safeRange, options) {
  if (!creep) return false;
  var goals = [];
  var fleeRange = (typeof safeRange === 'number') ? safeRange : 3;
  var opts = options || {};
  var taskSquad = opts.taskSquad;
  var maxOps = (opts.maxOps != null) ? opts.maxOps : 2000;
  var roomCallback = opts.roomCallback;

  if (fromThings && fromThings.length) {
    for (var i = 0; i < fromThings.length; i++) {
      var thing = fromThings[i];
      if (!thing || !thing.pos) continue;
      if (thing.owner && !isEnemyUsername(thing.owner.username)) continue;
      goals.push({ pos: thing.pos, range: fleeRange });
    }
  }

  if (!goals.length) {
    return false;
  }

  var search = PathFinder.search(creep.pos, goals, {
    flee: true,
    maxOps: maxOps,
    roomCallback: function (roomName) {
      if (!Game || !Game.rooms) return false;
      var room = Game.rooms[roomName];
      if (!room) return false;
      var costs = new PathFinder.CostMatrix();
      var structures = room.find(FIND_STRUCTURES);
      for (var s = 0; s < structures.length; s++) {
        var structure = structures[s];
        if (structure.structureType === STRUCTURE_ROAD) {
          costs.set(structure.pos.x, structure.pos.y, 1);
        } else if (structure.structureType !== STRUCTURE_CONTAINER && (structure.structureType !== STRUCTURE_RAMPART || !structure.my)) {
          costs.set(structure.pos.x, structure.pos.y, 0xFF);
        }
      }
      if (typeof roomCallback === 'function') {
        var custom = _runRoomCallback(roomCallback, roomName, costs.clone());
        if (custom !== undefined && custom !== null) {
          return custom;
        }
      }
      return costs;
    }
  });

  if (search && search.path && search.path.length) {
    var step = search.path[0];
    if (step) {
      var nextPos = (step instanceof RoomPosition) ? step : new RoomPosition(step.x, step.y, step.roomName || creep.pos.roomName);
      if (!taskSquad || !taskSquad.tryFriendlySwap || !taskSquad.tryFriendlySwap(creep, nextPos)) {
        creep.move(creep.pos.getDirectionTo(nextPos));
      }
      return true;
    }
  }

  var bad = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS, {
    filter: function (c) {
      return isEnemyCreep(c);
    }
  });
  if (bad) {
    var dir = creep.pos.getDirectionTo(bad);
    var zero = (dir - 1 + 8) % 8;
    var back = ((zero + 4) % 8) + 1;
    creep.move(back);
    return true;
  }

  return false;
}

function stepToward(creep, targetPos, range, taskSquad) {
  if (!creep || !targetPos) return ERR_INVALID_TARGET;
  var destination = (targetPos.pos || targetPos);
  var desiredRange = (typeof range === 'number') ? range : 1;
  if (taskSquad && typeof taskSquad.stepToward === 'function') {
    return taskSquad.stepToward(creep, destination, desiredRange);
  }
  var opts = { range: desiredRange };
  if (typeof creep.travelTo === 'function') {
    return creep.travelTo(destination, opts);
  }
  if (Traveler && typeof Traveler.travelTo === 'function') {
    return Traveler.travelTo(creep, destination, opts);
  }
  return creep.moveTo(destination, opts);
}

var CONFIG = {
  desiredRange: 2,          // ideal standoff distance
  kiteIfAtOrBelow: 2,       // if target ≤ this range, back off
  approachSlack: 1,         // hysteresis: only advance if range > desiredRange + this
  holdBand: 1,              // hysteresis: OK to hold if range in [desiredRange, desiredRange+holdBand]
  shuffleCooldown: 2,       // ticks to wait after any move before moving again
  fleeHpPct: 0.40,
  focusSticky: 15,
  maxRooms: 10,
  reusePath: 10,
  maxOps: 2000,
  towerAvoidRadius: 20,
  waitForMedic: true
};

var TaskCombatArcher = {
  run: function (creep) {
    if (creep.spawning) return;

    creep.memory = creep.memory || {};
    var mem = creep.memory;
    if (!mem.state) mem.state = 'rally';
    var squadId = mem.squadId || TaskSquad.getSquadId(creep);
    var squadRole = mem.squadRole || mem.task || 'CombatArcher';
    var rallyPos = TaskSquad.getRallyPos(squadId) || (Game.flags.Rally && Game.flags.Rally.pos) || null;
    TaskSquad.registerMember(squadId, creep.name, squadRole, {
      creep: creep,
      rallyPos: rallyPos,
      rallied: rallyPos ? creep.pos.inRangeTo(rallyPos, 1) : false
    });

    if (mem.state === 'rally') {
      if (rallyPos && !creep.pos.inRangeTo(rallyPos, 1)) {
        creep.travelTo(rallyPos, { range: 1, reusePath: CONFIG.reusePath, maxRooms: CONFIG.maxRooms });
        return;
      }
      if (TaskSquad.isReady(squadId)) {
        mem.state = 'engage';
      } else {
        return;
      }
    }

    // (0) Optional: wait for medic / rally
    if (CONFIG.waitForMedic && shouldWaitForMedic(creep)) {
      var rf = Game.flags.Rally || Game.flags.MedicRally || TaskSquad.getAnchor(creep);
      if (rf) stepToward(creep, (rf.pos || rf), 0, TaskSquad);
      return;
    }

    // (1) Acquire target or rally
    var target = TaskSquad.sharedTarget(creep);
    if (!target) {
      var anc = TaskSquad.getAnchor(creep) || (Game.flags.Rally && Game.flags.Rally.pos) || null;
      if (anc) stepToward(creep, anc, 0, TaskSquad);
      combatShootOpportunistic(creep); // still shoot if anything in range
      return;
    }
    if (target.owner && !isEnemyUsername(target.owner.username)) {
      TaskSquad.noteFriendlyFireAvoid(creep.name, target.owner.username, 'archer-sharedTarget');
      return;
    }

    // (2) Update memory about target motion (for "don’t move if they aren’t" logic)
    var mem = creep.memory;
    if (!mem.archer) mem.archer = {};
    var A = mem.archer;

    var tpos = target.pos;
    var tMoved = true;
    if (A.tX === tpos.x && A.tY === tpos.y && A.tR === tpos.roomName) {
      tMoved = false;
    }
    A.tX = tpos.x; A.tY = tpos.y; A.tR = tpos.roomName; A.lastSeen = Game.time;

    // (3) Danger gates first
    var lowHp = (creep.hits / Math.max(1, creep.hitsMax)) < CONFIG.fleeHpPct;
    var dangerAdj = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 1, { filter: function (h){
      if (!isEnemyCreep(h)) return false;
      return h.getActiveBodyparts(ATTACK)>0 || h.getActiveBodyparts(RANGED_ATTACK)>0;
    }}).length > 0;
    var inTowerBad = isInTowerDanger(creep.pos, CONFIG.towerAvoidRadius);

    if (lowHp || dangerAdj || inTowerBad) {
      combatFlee(
        creep,
        combatThreats(creep.room).concat([target]),
        3,
        { maxOps: CONFIG.maxOps, taskSquad: TaskSquad }
      );
      combatShootOpportunistic(creep); // still try to shoot after stepping
      A.movedAt = Game.time;
      return;
    }

    // (4) Combat first: fire before footwork
    combatShootPrimary(creep, target, { desiredRange: CONFIG.desiredRange, massAttackThreshold: 3 });

    // (5) Decide if we should move at all (anti-dance)
    var range = creep.pos.getRangeTo(target);

    // Cooldown: if we moved very recently, hold to prevent jitter
    if (typeof A.movedAt === 'number' && (Game.time - A.movedAt) < CONFIG.shuffleCooldown) {
      return; // hold position
    }

    // If target is NOT moving and we are within a comfy band, HOLD.
    if (!tMoved && combatInHoldBand(range, CONFIG.desiredRange, CONFIG.holdBand)) {
      return; // statuesque elegance achieved 🗿
    }

    // If we have a good shot and no extra need to adjust, also prefer holding in the band
    var hostilesIn3 = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 3, { filter: isEnemyCreep });
    if (hostilesIn3 && hostilesIn3.length && combatInHoldBand(range, CONFIG.desiredRange, CONFIG.holdBand)) {
      return;
    }

    // (6) Movement with hysteresis: only advance if too far; only kite if truly close
    var moved = false;
    if (range <= CONFIG.kiteIfAtOrBelow) {
      if (combatFlee(creep, [target], 3, { maxOps: CONFIG.maxOps, taskSquad: TaskSquad })) {
        moved = true;
      }
    } else if (range > (CONFIG.desiredRange + CONFIG.approachSlack)) {
      stepToward(creep, target.pos, CONFIG.desiredRange, TaskSquad); moved = true;
    } else {
      // in band but target moved: do nothing (don’t orbit/strafe)
    }

    if (moved) A.movedAt = Game.time;
  },
};

module.exports = TaskCombatArcher;

var BODY_COSTS = (typeof BODYPART_COST !== 'undefined') ? BODYPART_COST : (global && global.BODYPART_COST) || {};

var COMBAT_ARCHER_BODY_TIERS = [
  [
    TOUGH, TOUGH,
    RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK,
    MOVE, MOVE, MOVE, MOVE, MOVE, MOVE
  ],
  [
    TOUGH,
    RANGED_ATTACK, RANGED_ATTACK,
    MOVE, MOVE, MOVE
  ]
];

function costOfBody(body) {
  if (!Array.isArray(body)) return 0;
  var total = 0;
  for (var i = 0; i < body.length; i++) {
    total += BODY_COSTS[body[i]] || 0;
  }
  return total;
}

function pickLargestAffordable(tiers, energy) {
  if (!Array.isArray(tiers) || !tiers.length) return [];
  var available = (typeof energy === 'number') ? energy : 0;
  for (var i = 0; i < tiers.length; i++) {
    var candidate = tiers[i];
    if (!Array.isArray(candidate)) continue;
    if (costOfBody(candidate) <= available) {
      return candidate.slice();
    }
  }
  return [];
}

module.exports.BODY_TIERS = COMBAT_ARCHER_BODY_TIERS.map(function (tier) {
  return tier.slice();
});

module.exports.getSpawnBody = function (energy) {
  return pickLargestAffordable(COMBAT_ARCHER_BODY_TIERS, energy);
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
    namePrefix: 'CombatArcher',
    memory: {
      role: 'Worker_Bee',
      task: 'CombatArcher',
      home: room && room.name
    }
  };
};
