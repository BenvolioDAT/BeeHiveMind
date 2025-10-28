var Traveler = require('Traveler');
var TaskSquad = require('Task.Squad');
var CoreSpawn = require('core.spawn');

var CONFIG = {
  focusSticky: 15,
  fleeHpPct: 0.35,
  towerAvoidRadius: 20,
  maxRooms: 10,
  reusePath: 10,
  maxOps: 2000,
  waitForMedic: false,
  doorBash: true,
  edgePenalty: 8
};

var _myUsernameCacheTick = -1;
var _myUsernameCache = null;

function _getMyUsername() {
  if (_myUsernameCacheTick === Game.time) {
    return _myUsernameCache;
  }
  _myUsernameCacheTick = Game.time;
  var name = null;
  var key;
  for (key in Game.spawns) {
    if (!Game.spawns.hasOwnProperty(key)) continue;
    var spawn = Game.spawns[key];
    if (spawn && spawn.my && spawn.owner) {
      name = spawn.owner.username;
      break;
    }
  }
  if (!name) {
    for (key in Game.creeps) {
      if (!Game.creeps.hasOwnProperty(key)) continue;
      var creep = Game.creeps[key];
      if (creep && creep.my && creep.owner) {
        name = creep.owner.username;
        break;
      }
    }
  }
  _myUsernameCache = name;
  return _myUsernameCache;
}

function _isEnemyUsername(username) {
  if (!username) return false;
  if (TaskSquad && typeof TaskSquad.isAlly === 'function' && TaskSquad.isAlly(username)) {
    return false;
  }
  var mine = _getMyUsername();
  if (mine && username === mine) return false;
  return true;
}

function _isEnemyCreep(creep) {
  if (!creep || !creep.owner) return false;
  return _isEnemyUsername(creep.owner.username);
}

function _shouldWaitForMedic(attacker) {
  if (!attacker) return false;
  var medic = null;
  for (var name in Game.creeps) {
    if (!Game.creeps.hasOwnProperty(name)) continue;
    var candidate = Game.creeps[name];
    if (!candidate || !candidate.my || !candidate.memory) continue;
    if (candidate.memory.role !== 'CombatMedic') continue;
    if (candidate.memory.followTarget !== attacker.id) continue;
    medic = candidate;
    break;
  }
  if (!medic) return false;
  if (attacker.memory && attacker.memory.noWaitForMedic) return false;
  if (attacker.memory && attacker.memory.waitTicks > 0) {
    attacker.memory.waitTicks--;
    return true;
  }
  if (!attacker.pos.inRangeTo(medic, 2)) {
    if (attacker.memory) attacker.memory.waitTicks = 2;
    return true;
  }
  return false;
}

function _squadRoster(squadId, excludeName, room) {
  var sid = squadId || 'Alpha';
  var roster = [];
  if (TaskSquad && typeof TaskSquad.getCachedMembers === 'function') {
    var cached = TaskSquad.getCachedMembers(sid) || [];
    for (var i = 0; i < cached.length; i++) {
      var member = cached[i];
      if (!member || !member.my) continue;
      if (excludeName && member.name === excludeName) continue;
      roster.push(member);
    }
  }
  if (!roster.length && room) {
    var nearby = room.find(FIND_MY_CREEPS, {
      filter: function (ally) {
        if (!ally || !ally.memory) return false;
        if (excludeName && ally.name === excludeName) return false;
        return (ally.memory.squadId || 'Alpha') === sid;
      }
    });
    roster = nearby || [];
  }
  return roster;
}

function _combatAuxHeal(creep) {
  if (!creep) return false;
  if (!creep.getActiveBodyparts || !creep.getActiveBodyparts(HEAL)) return false;
  if (creep.hits < creep.hitsMax) {
    creep.heal(creep);
    return true;
  }
  var sid = (creep.memory && creep.memory.squadId) || 'Alpha';
  var mates = _squadRoster(sid, creep.name, creep.room);
  var wounded = [];
  for (var i = 0; i < mates.length; i++) {
    var member = mates[i];
    if (!member || member.hits >= member.hitsMax) continue;
    wounded.push(member);
  }
  if (!wounded.length) return false;
  var target = wounded[0];
  var bestRatio = target.hits / Math.max(1, target.hitsMax);
  for (var j = 1; j < wounded.length; j++) {
    var ratio = wounded[j].hits / Math.max(1, wounded[j].hitsMax);
    if (ratio < bestRatio) {
      bestRatio = ratio;
      target = wounded[j];
    }
  }
  if (!target) return false;
  if (creep.pos.isNearTo(target)) {
    creep.heal(target);
    return true;
  }
  if (creep.pos.inRangeTo(target, 3)) {
    creep.rangedHeal(target);
    return true;
  }
  return false;
}

function _isInTowerDanger(pos, radius) {
  if (!pos) return false;
  var room = Game.rooms[pos.roomName];
  if (!room) return false;
  var limit = (typeof radius === 'number') ? radius : 20;
  var towers = room.find(FIND_HOSTILE_STRUCTURES, {
    filter: function (structure) {
      if (!structure || structure.structureType !== STRUCTURE_TOWER) return false;
      if (structure.owner && !_isEnemyUsername(structure.owner.username)) return false;
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

function _stepToward(creep, destination, range) {
  if (!creep || !destination) return ERR_INVALID_TARGET;
  var targetPos = destination.pos || destination;
  var desiredRange = (typeof range === 'number') ? range : 1;
  if (TaskSquad && typeof TaskSquad.stepToward === 'function') {
    return TaskSquad.stepToward(creep, targetPos, desiredRange);
  }
  return Traveler.travelTo(creep, targetPos, {
    range: desiredRange,
    maxRooms: CONFIG.maxRooms,
    reusePath: CONFIG.reusePath
  });
}

function _retreatToRally(creep, options) {
  if (!creep) return false;
  var opts = options || {};
  var range = (opts.range != null) ? opts.range : 1;
  var anchorProvider = opts.anchorProvider;
  var rally = opts.rallyFlag || Game.flags.MedicRally || Game.flags.Rally;
  if (!rally && typeof anchorProvider === 'function') {
    rally = anchorProvider(creep);
  }
  if (rally) {
    _stepToward(creep, rally.pos || rally, range);
    return true;
  }
  var bad = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS, {
    filter: function (enemy) {
      return _isEnemyCreep(enemy);
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

function _positionScore(creep, pos, target, options, threats) {
  var opts = options || {};
  var edgePenalty = (opts.edgePenalty != null) ? opts.edgePenalty : 8;
  var towerRadius = (opts.towerRadius != null) ? opts.towerRadius : 20;
  var score = 0;
  var i;
  if (target && pos.getRangeTo(target) > 1) {
    score += 5;
  }
  for (i = 0; i < threats.length; i++) {
    if (threats[i].pos.getRangeTo(pos) <= 1) score += 20;
  }
  if (_isInTowerDanger(pos, towerRadius)) score += 50;
  if (pos.x === 0 || pos.x === 49 || pos.y === 0 || pos.y === 49) score += edgePenalty;
  var look = pos.look();
  for (i = 0; i < look.length; i++) {
    var entry = look[i];
    if (entry.type === LOOK_TERRAIN && entry.terrain === 'wall') {
      return null;
    }
    if (entry.type === LOOK_CREEPS) {
      return null;
    }
    if (entry.type === LOOK_STRUCTURES) {
      var structure = entry.structure;
      var st = structure.structureType;
      if (st === STRUCTURE_ROAD) {
        score -= 1;
      } else if (st !== STRUCTURE_CONTAINER && (st !== STRUCTURE_RAMPART || !structure.my)) {
        return null;
      }
    }
  }
  return score;
}

function _combatBestAdjacentTile(creep, target, options) {
  if (!creep || !target) return creep && creep.pos;
  var room = creep.room;
  if (!room) return creep.pos;
  var threats = room.find(FIND_HOSTILE_CREEPS, {
    filter: function (enemy) {
      if (!_isEnemyCreep(enemy)) return false;
      return enemy.getActiveBodyparts(ATTACK) > 0 && enemy.hits > 0;
    }
  });
  var best = creep.pos;
  var bestScore = 1e9;
  for (var dx = -1; dx <= 1; dx++) {
    for (var dy = -1; dy <= 1; dy++) {
      if (!dx && !dy) continue;
      var x = creep.pos.x + dx;
      var y = creep.pos.y + dy;
      if (x <= 0 || x >= 49 || y <= 0 || y >= 49) continue;
      var pos = new RoomPosition(x, y, creep.room.name);
      if (!pos.isNearTo(target)) continue;
      var score = _positionScore(creep, pos, target, options, threats);
      if (score === null) continue;
      if (score < bestScore) {
        bestScore = score;
        best = pos;
      }
    }
  }
  return best;
}

function _combatGuardSquadmate(creep, options) {
  if (!creep) return false;
  var opts = options || {};
  var squadId = opts.squadId || (creep.memory && creep.memory.squadId) || 'Alpha';
  var protectRoles = opts.protectRoles || { CombatArcher: true, CombatMedic: true, Dismantler: true };
  var threatFilter = opts.threatFilter || function (enemy) {
    return enemy.getActiveBodyparts(ATTACK) > 0;
  };
  var mates = _squadRoster(squadId, creep.name, creep.room);
  var threatened = [];
  for (var i = 0; i < mates.length; i++) {
    var ally = mates[i];
    if (!ally || !ally.memory) continue;
    var role = ally.memory.task || ally.memory.role || '';
    if (!protectRoles[role]) continue;
    var near = ally.pos.findInRange(FIND_HOSTILE_CREEPS, 1, {
      filter: function (enemy) {
        if (!_isEnemyCreep(enemy)) return false;
        return threatFilter(enemy);
      }
    });
    if (near && near.length) {
      threatened.push(ally);
    }
  }
  if (!threatened.length) return false;
  var buddy = creep.pos.findClosestByRange(threatened);
  if (!buddy) return false;
  if (creep.pos.isNearTo(buddy)) {
    if (TaskSquad && typeof TaskSquad.tryFriendlySwap === 'function' && TaskSquad.tryFriendlySwap(creep, buddy.pos)) {
      return true;
    }
    var dangers = buddy.pos.findInRange(FIND_HOSTILE_CREEPS, 1, {
      filter: function (enemy) {
        if (!_isEnemyCreep(enemy)) return false;
        return threatFilter(enemy);
      }
    });
    if (dangers && dangers.length) {
      var best = _combatBestAdjacentTile(creep, dangers[0], options);
      if (best && creep.pos.getRangeTo(best) === 1 && (best.x !== creep.pos.x || best.y !== creep.pos.y)) {
        creep.move(creep.pos.getDirectionTo(best));
        return true;
      }
    }
    return false;
  }
  _stepToward(creep, buddy.pos, 1);
  return true;
}

function _combatBlockingDoor(creep, target) {
  if (!creep || !target) return null;
  var walls = creep.pos.findInRange(FIND_STRUCTURES, 1, {
    filter: function (structure) {
      if (!structure) return false;
      if (structure.structureType === STRUCTURE_RAMPART && structure.my) return false;
      return structure.structureType === STRUCTURE_RAMPART || structure.structureType === STRUCTURE_WALL;
    }
  });
  if (!walls.length) return null;
  var best = null;
  var bestDist = Infinity;
  for (var i = 0; i < walls.length; i++) {
    var dist = walls[i].pos.getRangeTo(target);
    if (dist < bestDist) {
      bestDist = dist;
      best = walls[i];
    }
  }
  if (!best) return null;
  if (best.pos.getRangeTo(target) < creep.pos.getRangeTo(target)) {
    return best;
  }
  return null;
}

function _combatWeakestHostile(creep, range) {
  if (!creep) return null;
  var maxRange = (typeof range === 'number') ? range : 2;
  var hostiles = creep.pos.findInRange(FIND_HOSTILE_CREEPS, maxRange, {
    filter: function (enemy) {
      return _isEnemyCreep(enemy);
    }
  });
  if (!hostiles.length) return null;
  var weakest = hostiles[0];
  var bestRatio = weakest.hits / Math.max(1, weakest.hitsMax);
  for (var i = 1; i < hostiles.length; i++) {
    var ratio = hostiles[i].hits / Math.max(1, hostiles[i].hitsMax);
    if (ratio < bestRatio) {
      bestRatio = ratio;
      weakest = hostiles[i];
    }
  }
  return weakest;
}

var CombatMelee = {
  run: function (creep) {
    if (creep.spawning) return;

    creep.memory = creep.memory || {};
    var mem = creep.memory;
    if (!mem.state) mem.state = 'rally';
    var squadId = mem.squadId || TaskSquad.getSquadId(creep);
    var squadRole = mem.squadRole || mem.task || 'CombatMelee';
    var rallyPos = TaskSquad.getRallyPos(squadId) || TaskSquad.getAnchor(creep);
    TaskSquad.registerMember(squadId, creep.name, squadRole, {
      creep: creep,
      rallyPos: rallyPos,
      rallied: rallyPos ? creep.pos.inRangeTo(rallyPos, 1) : false
    });

    if (mem.state === 'rally') {
      if (rallyPos && !creep.pos.inRangeTo(rallyPos, 1)) {
        Traveler.travelTo(creep, rallyPos, { range: 1, maxRooms: CONFIG.maxRooms, reusePath: 5 });
        return;
      }
      if (TaskSquad.isReady(squadId)) {
        mem.state = 'engage';
      } else {
        return;
      }
    }

    // (0) optional: wait for medic if you want tighter stack
    if (CONFIG.waitForMedic && _shouldWaitForMedic(creep)) {
      var rf = Game.flags.Rally || Game.flags.MedicRally || TaskSquad.getAnchor(creep);
      if (rf) _stepToward(creep, rf.pos || rf, 0);
      return;
    }

    // quick self/buddy healing if we have HEAL
    _combatAuxHeal(creep);

    // (1) emergency bail if low HP or in tower ring
    var lowHp = (creep.hits / creep.hitsMax) < CONFIG.fleeHpPct;
    if (lowHp || _isInTowerDanger(creep.pos, CONFIG.towerAvoidRadius)) {
      _retreatToRally(creep, { anchorProvider: TaskSquad.getAnchor, range: 1 });
      var adjBad = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 1, { filter: _isEnemyCreep })[0];
      if (adjBad) creep.attack(adjBad);
      return;
    }

    // (2) bodyguard: interpose for squishy squadmates
    if (_combatGuardSquadmate(creep, {
      edgePenalty: CONFIG.edgePenalty,
      towerRadius: CONFIG.towerAvoidRadius
    })) {
      var hugger = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 1, { filter: _isEnemyCreep })[0];
      if (hugger) creep.attack(hugger);
      return;
    }

    // (3) squad shared target
    var target = TaskSquad.sharedTarget(creep);
    if (!target) {
      var anc = TaskSquad.getAnchor(creep);
      if (anc) _stepToward(creep, anc, 1);
      return;
    }
    if (target.owner && !_isEnemyUsername(target.owner.username)) {
      TaskSquad.noteFriendlyFireAvoid(creep.name, target.owner.username, 'melee-sharedTarget');
      return;
    }

    // (4) approach & strike
    if (creep.pos.isNearTo(target)) {
      // Explicit Invader Core handling: stand and swing
      if (target.structureType && target.structureType === STRUCTURE_INVADER_CORE) {
        creep.say('⚔ core!');
        creep.attack(target);
        return;
      }

      // Normal melee attack
      creep.attack(target);

      // Micro-step to a safer/better adjacent tile (avoid tower/edges/melee stacks)
      var better = _combatBestAdjacentTile(creep, target, { edgePenalty: CONFIG.edgePenalty, towerRadius: CONFIG.towerAvoidRadius });
      if (better && (better.x !== creep.pos.x || better.y !== creep.pos.y)) {
        var dir = creep.pos.getDirectionTo(better);
        creep.move(dir);
      }
      return;
    }

    // (5) door bash if a blocking wall/rampart is the nearer path at range 1
    if (CONFIG.doorBash) {
      var blocker = _combatBlockingDoor(creep, target);
      if (blocker && creep.pos.isNearTo(blocker)) {
        creep.attack(blocker);
        return;
      }
    }

    // (6) close in via Traveler-powered TaskSquad (polite traffic + swaps)
    _stepToward(creep, target.pos, 1);

    // opportunistic hit if we brushed into melee
    var adj = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 1, { filter: _isEnemyCreep })[0];
    if (adj) creep.attack(adj);

    // (7) occasional opportunistic retarget to weaklings in 1..2
    if (Game.time % 3 === 0) {
      var weak = _combatWeakestHostile(creep, 2);
      if (weak && (weak.hits / weak.hitsMax) < 0.5) target = weak;
    }
  }
};

module.exports = CombatMelee;

var COMBAT_MELEE_BODY_TIERS = [
  [
    TOUGH, TOUGH, TOUGH, TOUGH,
    ATTACK, ATTACK, ATTACK, ATTACK,
    MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE
  ],
  [
    TOUGH,
    ATTACK,
    MOVE, MOVE
  ]
];

module.exports.BODY_TIERS = COMBAT_MELEE_BODY_TIERS.map(function (tier) {
  return tier.slice();
});

module.exports.getSpawnBody = function (energy) {
  return CoreSpawn.pickLargestAffordable(COMBAT_MELEE_BODY_TIERS, energy);
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
    namePrefix: 'CombatMelee',
    memory: {
      role: 'Worker_Bee',
      task: 'CombatMelee',
      home: room && room.name
    }
  };
};
