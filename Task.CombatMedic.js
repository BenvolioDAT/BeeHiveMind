var TaskSquad = require('Task.Squad');

var Traveler = null;
try {
  Traveler = require('Traveler');
} catch (error) {
  Traveler = null;
}
var CoreSpawn = require('core.spawn');

var CONFIG = {
  followRange: 1,          // how close we try to stay to buddy
  triageRange: 4,          // scan radius for patients
  criticalPct: 0.75,       // "critical" if below this fraction
  fleePct: 0.35,
  stickiness: 25,          // ticks before re-evaluating buddy
  reusePath: 3,
  maxRooms: 10,
  towerAvoidRadius: 20,
  maxMedicsPerTarget: 1,   // enforce per-buddy medic cap
  avoidMeleeRange: 2       // try to keep >=2 tiles from enemy melee
};

// Which combat tasks we consider "frontline" squadmates
var CombatRoles = { CombatMelee:1, CombatArcher:1, Dismantler:1 };

var _cachedUsername = null;

function getMyUsername() {
  if (_cachedUsername && _cachedUsername.tick === Game.time) return _cachedUsername.name;
  var name = null;
  if (Game.spawns) {
    for (var spawnName in Game.spawns) {
      if (!Object.prototype.hasOwnProperty.call(Game.spawns, spawnName)) continue;
      var spawn = Game.spawns[spawnName];
      if (spawn && spawn.my && spawn.owner && spawn.owner.username) {
        name = spawn.owner.username;
        break;
      }
    }
  }
  if (!name && Game.creeps) {
    for (var creepName in Game.creeps) {
      if (!Object.prototype.hasOwnProperty.call(Game.creeps, creepName)) continue;
      var creep = Game.creeps[creepName];
      if (creep && creep.my && creep.owner && creep.owner.username) {
        name = creep.owner.username;
        break;
      }
    }
  }
  if (!name && Game.structures) {
    for (var structName in Game.structures) {
      if (!Object.prototype.hasOwnProperty.call(Game.structures, structName)) continue;
      var structure = Game.structures[structName];
      if (structure && structure.my && structure.owner && structure.owner.username) {
        name = structure.owner.username;
        break;
      }
    }
  }
  _cachedUsername = { name: name, tick: Game.time };
  return name;
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
  var myName = getMyUsername();
  if (myName && username === myName) return false;
  return true;
}

function isEnemyCreep(creep) {
  if (!creep || !creep.owner) return false;
  return isEnemyUsername(creep.owner.username);
}

function findLowestInjuredAlly(origin, range) {
  if (!origin) return null;
  var radius = (typeof range === 'number') ? range : 3;
  var allies = origin.findInRange(FIND_MY_CREEPS, radius, {
    filter: function (ally) { return ally.hits < ally.hitsMax; }
  });
  if (!allies.length) return null;
  return _.min(allies, function (ally) { return ally.hits / Math.max(1, ally.hitsMax); });
}

function tryHealTarget(creep, target) {
  if (!creep || !target) return false;
  if (target.hits >= target.hitsMax) return false;
  if (creep.pos.isNearTo(target)) {
    return creep.heal(target) === OK;
  }
  if (creep.pos.inRangeTo(target, 3)) {
    return creep.rangedHeal(target) === OK;
  }
  return false;
}

function isInTowerDanger(pos, radius) {
  if (!pos) return false;
  var room = Game.rooms[pos.roomName];
  if (!room) return false;
  var limit = (typeof radius === 'number') ? radius : 20;
  var towers = room.find(FIND_HOSTILE_STRUCTURES, {
    filter: function (s) {
      if (s.structureType !== STRUCTURE_TOWER) return false;
      if (s.owner && !isEnemyUsername(s.owner.username)) return false;
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

function estimateTowerDamage(room, pos) {
  if (!room || !pos) return 0;
  var towers = room.find(FIND_HOSTILE_STRUCTURES, {
    filter: function (s) {
      if (s.structureType !== STRUCTURE_TOWER) return false;
      if (s.owner && !isEnemyUsername(s.owner.username)) return false;
      return true;
    }
  });
  var total = 0;
  for (var i = 0; i < towers.length; i++) {
    var dist = towers[i].pos.getRangeTo(pos);
    if (dist <= TOWER_OPTIMAL_RANGE) {
      total += TOWER_POWER_ATTACK;
    } else {
      var capped = Math.min(dist, TOWER_FALLOFF_RANGE);
      var frac = (capped - TOWER_OPTIMAL_RANGE) / Math.max(1, (TOWER_FALLOFF_RANGE - TOWER_OPTIMAL_RANGE));
      var fall = TOWER_POWER_ATTACK * (1 - (TOWER_FALLOFF * frac));
      total += Math.max(0, Math.floor(fall));
    }
  }
  return total;
}

function normalizePos(target) {
  if (!target) return null;
  if (target instanceof RoomPosition) return target;
  if (target.pos instanceof RoomPosition) return target.pos;
  if (typeof target.x === 'number' && typeof target.y === 'number' && target.roomName) {
    return new RoomPosition(target.x, target.y, target.roomName);
  }
  return null;
}

function travelTo(creep, destination, range) {
  if (!creep || !destination) return ERR_INVALID_TARGET;
  var opts = { range: (typeof range === 'number') ? range : 1 };
  if (Traveler && typeof Traveler.travelTo === 'function') {
    try {
      return Traveler.travelTo(creep, destination, opts);
    } catch (error) {
      // fall through to vanilla moveTo
    }
  }
  return creep.moveTo(destination, { reusePath: 5 });
}

function combatStepToward(creep, targetPos, range, taskSquad) {
  if (!creep || !targetPos) return ERR_INVALID_TARGET;
  var destination = normalizePos(targetPos);
  if (!destination) return ERR_INVALID_TARGET;
  var desiredRange = (typeof range === 'number') ? range : 1;
  if (taskSquad && typeof taskSquad.stepToward === 'function') {
    var handled = taskSquad.stepToward(creep, destination, desiredRange);
    if (handled !== undefined && handled !== ERR_INVALID_TARGET) {
      return handled;
    }
  }
  return travelTo(creep, destination, desiredRange);
}

function countRoleFollowingTarget(squadId, targetId, roleName) {
  if (!targetId) return 0;
  var sid = squadId || 'Alpha';
  var role = roleName || '';
  if (TaskSquad && typeof TaskSquad.getFollowLoad === 'function') {
    var cached = TaskSquad.getFollowLoad(sid, targetId, role);
    if (cached !== null && cached !== undefined) return cached;
  }
  var count = 0;
  for (var name in Game.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Game.creeps, name)) continue;
    var creep = Game.creeps[name];
    if (!creep || !creep.my || !creep.memory) continue;
    if ((creep.memory.squadId || 'Alpha') !== sid) continue;
    var r = creep.memory.task || creep.memory.role;
    if (r !== role) continue;
    if (creep.memory.followTarget === targetId) count++;
  }
  return count;
}

var TaskCombatMedic = {
  run: function (creep) {
    if (creep.spawning) return;

    var now = Game.time;
    var bodyHeal = creep.getActiveBodyparts(HEAL);
    var canHeal = bodyHeal > 0;
    var healedThisTick = false; // cast at most once/tick

    creep.memory = creep.memory || {};
    var mem = creep.memory;
    if (!mem.state) mem.state = 'rally';
    var squadId = mem.squadId || TaskSquad.getSquadId(creep);
    var squadRole = mem.squadRole || mem.task || 'CombatMedic';
    var rallyPos = TaskSquad.getRallyPos(squadId) || TaskSquad.getAnchor(creep);
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
        if (!healedThisTick) {
          var standby = findLowestInjuredAlly(creep.pos, CONFIG.triageRange);
          if (tryHealTarget(creep, standby)) healedThisTick = true;
        }
        return;
      }
    }

    // ---------- 1) choose / refresh buddy ----------
    var buddy = Game.getObjectById(creep.memory.followTarget);
    var needNewBuddy = (!buddy || !buddy.my || buddy.hits <= 0);
    if (!needNewBuddy && creep.memory.assignedAt && (now - creep.memory.assignedAt) > CONFIG.stickiness) {
      needNewBuddy = true;
    }

    if (needNewBuddy) {
      delete creep.memory.followTarget;
      delete creep.memory.assignedAt;

      var squadId = creep.memory.squadId || 'Alpha';
      var cachedMembers = TaskSquad.getCachedMembers ? TaskSquad.getCachedMembers(squadId) : null;
      var candidates = [];
      if (cachedMembers && cachedMembers.length) {
        for (var idx = 0; idx < cachedMembers.length; idx++) {
          var member = cachedMembers[idx];
          if (!member || !member.my || !member.memory) continue;
          if ((member.memory.squadId || 'Alpha') !== squadId) continue;
          var taskName = member.memory.task || member.memory.role || '';
          if (CombatRoles[taskName]) candidates.push(member);
        }
      } else {
        // Fallback if the cache is unavailable for some reason.
        candidates = _.filter(Game.creeps, function (a){
          if (!a || !a.my || !a.memory) return false;
          if (a.memory.squadId !== squadId) return false;
          var t = a.memory.task || a.memory.role || '';
          return !!CombatRoles[t];
        });
      }

      if (candidates.length) {
        var anyInjured = false;
        var j;
        for (j = 0; j < candidates.length; j++) {
          if (candidates[j].hits < candidates[j].hitsMax) { anyInjured = true; break; }
        }
        if (anyInjured) {
          var worstScore = null;
          for (j = 0; j < candidates.length; j++) {
            var injured = candidates[j];
            var towerDelta = estimateTowerDamage(creep.room, injured.pos);
            var score = (injured.hits - towerDelta) / Math.max(1, injured.hitsMax);
            if (worstScore === null || score < worstScore) {
              worstScore = score;
              buddy = injured;
            }
          }
        } else {
          // Prefer melee as anchor if nobody is hurt
          for (j = 0; j < candidates.length; j++) {
            var candRole = candidates[j].memory.task || candidates[j].memory.role || '';
            if (candRole === 'CombatMelee') { buddy = candidates[j]; break; }
            if (!buddy) buddy = candidates[j];
          }
        }

        var followMap = null;
        if (TaskSquad.getRoleFollowMap) {
          followMap = TaskSquad.getRoleFollowMap(squadId, 'CombatMedic');
        }

        // per-target medic cap
        if (buddy && CONFIG.maxMedicsPerTarget > 0) {
          var count = followMap ? (followMap[buddy.id] || 0) : countRoleFollowingTarget(squadId, buddy.id, 'CombatMedic');
          if (count >= CONFIG.maxMedicsPerTarget) {
            var alt = null, bestLoad = 999;
            for (j = 0; j < candidates.length; j++) {
              var cand = candidates[j];
              var load = followMap ? (followMap[cand.id] || 0) : countRoleFollowingTarget(squadId, cand.id, 'CombatMedic');
              if (load < bestLoad) { bestLoad = load; alt = cand; }
            }
            if (alt) buddy = alt;
          }
        }

        if (buddy) { creep.memory.followTarget = buddy.id; creep.memory.assignedAt = now; }
      }
    }

    // ---------- 2) no buddy? hover at anchor/rally and still heal ----------
    if (!buddy) {
      var anc = TaskSquad.getAnchor(creep) || Game.flags.MedicRally || Game.flags.Rally;
      if (anc) combatStepToward(creep, anc.pos || anc, 1, TaskSquad);
      if (!healedThisTick) {
        var triage = findLowestInjuredAlly(creep.pos, CONFIG.triageRange);
        if (tryHealTarget(creep, triage)) healedThisTick = true;
      }
      return;
    }

    // ---------- 3) flee logic (keep heals going) ----------
    var underHp = (creep.hits / creep.hitsMax) < CONFIG.fleePct;
    var hostilesNear = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 3, { filter: function (h){
      if (!isEnemyCreep(h)) return false;
      return h.getActiveBodyparts(ATTACK)>0 || h.getActiveBodyparts(RANGED_ATTACK)>0;
    } });
    var needToFlee = underHp || (hostilesNear.length && isInTowerDanger(creep.pos, CONFIG.towerAvoidRadius));
    if (needToFlee) {
      var bad = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS, { filter: isEnemyCreep });
      if (bad) {
        var flee = PathFinder.search(creep.pos, [{ pos: bad.pos, range: 4 }], { flee: true });
        if (!flee.incomplete && flee.path.length) {
          creep.move(creep.pos.getDirectionTo(flee.path[0]));
        }
      } else {
        combatStepToward(creep, buddy.pos, 3, TaskSquad);
      }
      // heal while fleeing: buddy > anyone in 3 > self
      if (!healedThisTick) {
        if (buddy.hits < buddy.hitsMax && creep.pos.inRangeTo(buddy, 3) && tryHealTarget(creep, buddy)) {
          healedThisTick = true;
        }
        if (!healedThisTick) {
          var nearby = findLowestInjuredAlly(creep.pos, 3);
          if (tryHealTarget(creep, nearby)) healedThisTick = true;
        }
        if (!healedThisTick && canHeal && creep.hits < creep.hitsMax) {
          if (creep.heal(creep) === OK) healedThisTick = true;
        }
      }
      return;
    }

    // ---------- 4) follow buddy with safe spacing ----------
    var wantRange = CONFIG.followRange;
    var meleeThreat = creep.pos.findInRange(FIND_HOSTILE_CREEPS, CONFIG.avoidMeleeRange, {
      filter: function (h){
        if (!isEnemyCreep(h)) return false;
        return h.getActiveBodyparts(ATTACK)>0 && h.hits>0;
      }
    }).length > 0;

    if (!creep.pos.inRangeTo(buddy, wantRange)) {
      combatStepToward(creep, buddy.pos, wantRange, TaskSquad);
      // heal while approaching
      if (!healedThisTick) {
        if (buddy.hits < buddy.hitsMax && tryHealTarget(creep, buddy)) {
          healedThisTick = true;
        }
        if (!healedThisTick) {
          var triage3 = findLowestInjuredAlly(creep.pos, 3);
          if (tryHealTarget(creep, triage3)) healedThisTick = true;
        }
      }
    } else if (meleeThreat) {
      // small nudge away from closest melee if we're too close
      var hm = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS, {
        filter: function (h){
          if (!isEnemyCreep(h)) return false;
          return h.getActiveBodyparts(ATTACK)>0 && h.hits>0;
        }
      });
      if (hm && creep.pos.getRangeTo(hm) < CONFIG.avoidMeleeRange) {
        var dir = hm.pos.getDirectionTo(creep.pos); // step away
        creep.move(dir);
      }
    }

    // ---------- 5) damage-aware triage ----------
    var triageSet = creep.pos.findInRange(
      FIND_MY_CREEPS,
      CONFIG.triageRange,
      { filter: function(a){ return a.hits < a.hitsMax; } }
    );

    if (triageSet && triageSet.length) {
      var room2 = creep.room;
      var scored = _.map(triageSet, function (a) {
        var exp = a.hits - estimateTowerDamage(room2, a.pos);
        return { a: a, key: exp / Math.max(1, a.hitsMax) };
      });
      var worst = _.min(scored, 'key');
      var patient = worst && worst.a;

      if (patient) {
        // Do not step onto melee tiles if rangedHeal will do
        var desiredRange = creep.pos.inRangeTo(patient, 1) ? 1 : (creep.pos.inRangeTo(patient, 3) ? 3 : 1);
        combatStepToward(creep, patient.pos, desiredRange === 1 ? 1 : 2, TaskSquad);
        if (!healedThisTick && tryHealTarget(creep, patient)) {
          healedThisTick = true;
        }
      }
    } else {
      // ---------- 6) fallback: stick to buddy, heal buddy/nearby ----------
      if (!creep.pos.inRangeTo(buddy, wantRange)) combatStepToward(creep, buddy.pos, wantRange, TaskSquad);
      if (!healedThisTick) {
        if (buddy.hits < buddy.hitsMax && tryHealTarget(creep, buddy)) {
          healedThisTick = true;
        }
        if (!healedThisTick) {
          var triageNear = findLowestInjuredAlly(creep.pos, 3);
          if (tryHealTarget(creep, triageNear)) healedThisTick = true;
        }
      }
    }

    // ---------- 7) last: self-heal if still unused ----------
    if (!healedThisTick && canHeal && creep.hits < creep.hitsMax) {
      if (creep.heal(creep) === OK) healedThisTick = true;
    }
  }
};

module.exports = TaskCombatMedic;

var COMBAT_MEDIC_BODY_TIERS = [
  [
    MOVE, MOVE,
    HEAL, HEAL
  ],
  [
    MOVE,
    HEAL
  ]
];

module.exports.BODY_TIERS = COMBAT_MEDIC_BODY_TIERS.map(function (tier) {
  return tier.slice();
});

module.exports.getSpawnBody = function (energy) {
  return CoreSpawn.pickLargestAffordable(COMBAT_MEDIC_BODY_TIERS, energy);
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
    namePrefix: 'CombatMedic',
    memory: {
      role: 'Worker_Bee',
      task: 'CombatMedic',
      home: room && room.name
    }
  };
};
