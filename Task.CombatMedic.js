// Task.CombatMedic.js — Traveler/Task.Squad-aware healer (ES5-safe)
// - Uses TaskSquad.stepToward for all navigation (Traveler under the hood)
// - One heal per tick (prioritizes buddy/patient/self)
// - Enforces max medics per target to prevent dogpiles
// - Triage prefers targets under tower pressure
// - Avoids stepping into melee tiles if rangedHeal suffices
'use strict';

var BeeToolbox = require('BeeToolbox');
var TaskSquad  = require('./Task.Squad');

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
          var standby = BeeToolbox.findLowestInjuredAlly(creep.pos, CONFIG.triageRange);
          if (BeeToolbox.tryHealTarget(creep, standby)) healedThisTick = true;
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
            var towerDelta = BeeToolbox.estimateTowerDamage(creep.room, injured.pos);
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
          var count = followMap ? (followMap[buddy.id] || 0) : BeeToolbox.countRoleFollowingTarget(squadId, buddy.id, 'CombatMedic');
          if (count >= CONFIG.maxMedicsPerTarget) {
            var alt = null, bestLoad = 999;
            for (j = 0; j < candidates.length; j++) {
              var cand = candidates[j];
              var load = followMap ? (followMap[cand.id] || 0) : BeeToolbox.countRoleFollowingTarget(squadId, cand.id, 'CombatMedic');
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
      if (anc) BeeToolbox.combatStepToward(creep, anc.pos || anc, 1, TaskSquad);
      if (!healedThisTick) {
        var triage = BeeToolbox.findLowestInjuredAlly(creep.pos, CONFIG.triageRange);
        if (BeeToolbox.tryHealTarget(creep, triage)) healedThisTick = true;
      }
      return;
    }

    // ---------- 3) flee logic (keep heals going) ----------
    var underHp = (creep.hits / creep.hitsMax) < CONFIG.fleePct;
    var hostilesNear = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 3, { filter: function (h){
      if (!BeeToolbox.isEnemyCreep(h)) return false;
      return h.getActiveBodyparts(ATTACK)>0 || h.getActiveBodyparts(RANGED_ATTACK)>0;
    } });
    var needToFlee = underHp || (hostilesNear.length && BeeToolbox.isInTowerDanger(creep.pos, CONFIG.towerAvoidRadius));
    if (needToFlee) {
      var bad = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS, { filter: BeeToolbox.isEnemyCreep });
      if (bad) {
        var flee = PathFinder.search(creep.pos, [{ pos: bad.pos, range: 4 }], { flee: true });
        if (!flee.incomplete && flee.path.length) {
          creep.move(creep.pos.getDirectionTo(flee.path[0]));
        }
      } else {
        BeeToolbox.combatStepToward(creep, buddy.pos, 3, TaskSquad);
      }
      // heal while fleeing: buddy > anyone in 3 > self
      if (!healedThisTick) {
        if (buddy.hits < buddy.hitsMax && creep.pos.inRangeTo(buddy, 3) && BeeToolbox.tryHealTarget(creep, buddy)) {
          healedThisTick = true;
        }
        if (!healedThisTick) {
          var nearby = BeeToolbox.findLowestInjuredAlly(creep.pos, 3);
          if (BeeToolbox.tryHealTarget(creep, nearby)) healedThisTick = true;
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
        if (!BeeToolbox.isEnemyCreep(h)) return false;
        return h.getActiveBodyparts(ATTACK)>0 && h.hits>0;
      }
    }).length > 0;

    if (!creep.pos.inRangeTo(buddy, wantRange)) {
      BeeToolbox.combatStepToward(creep, buddy.pos, wantRange, TaskSquad);
      // heal while approaching
      if (!healedThisTick) {
        if (buddy.hits < buddy.hitsMax && BeeToolbox.tryHealTarget(creep, buddy)) {
          healedThisTick = true;
        }
        if (!healedThisTick) {
          var triage3 = BeeToolbox.findLowestInjuredAlly(creep.pos, 3);
          if (BeeToolbox.tryHealTarget(creep, triage3)) healedThisTick = true;
        }
      }
    } else if (meleeThreat) {
      // small nudge away from closest melee if we're too close
      var hm = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS, {
        filter: function (h){
          if (!BeeToolbox.isEnemyCreep(h)) return false;
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
        var exp = a.hits - BeeToolbox.estimateTowerDamage(room2, a.pos);
        return { a: a, key: exp / Math.max(1, a.hitsMax) };
      });
      var worst = _.min(scored, 'key');
      var patient = worst && worst.a;

      if (patient) {
        // Do not step onto melee tiles if rangedHeal will do
        var desiredRange = creep.pos.inRangeTo(patient, 1) ? 1 : (creep.pos.inRangeTo(patient, 3) ? 3 : 1);
        BeeToolbox.combatStepToward(creep, patient.pos, desiredRange === 1 ? 1 : 2, TaskSquad);
        if (!healedThisTick && BeeToolbox.tryHealTarget(creep, patient)) {
          healedThisTick = true;
        }
      }
    } else {
      // ---------- 6) fallback: stick to buddy, heal buddy/nearby ----------
      if (!creep.pos.inRangeTo(buddy, wantRange)) BeeToolbox.combatStepToward(creep, buddy.pos, wantRange, TaskSquad);
      if (!healedThisTick) {
        if (buddy.hits < buddy.hitsMax && BeeToolbox.tryHealTarget(creep, buddy)) {
          healedThisTick = true;
        }
        if (!healedThisTick) {
          var triageNear = BeeToolbox.findLowestInjuredAlly(creep.pos, 3);
          if (BeeToolbox.tryHealTarget(creep, triageNear)) healedThisTick = true;
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
