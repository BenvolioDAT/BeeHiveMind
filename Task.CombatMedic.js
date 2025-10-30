// Task.CombatMedic.js — Traveler/Task.Squad-aware healer (ES5-safe)
// - Uses TaskSquad.stepToward for all navigation (Traveler under the hood)
// - One heal per tick (prioritizes buddy/patient/self)
// - Enforces max medics per target to prevent dogpiles
// - Triage prefers targets under tower pressure
// - Avoids stepping into melee tiles if rangedHeal suffices
'use strict';

var BeeToolbox = require('BeeToolbox');
var TaskSquad  = require('Task.Squad');

var CONFIG = {
  followRange: 1,          // how close we try to stay to buddy
  triageRange: 4,          // scan radius for patients
  criticalPct: 0.75,       // "critical" if below this fraction
  fleePct: 0.35,
  stickiness: 25,          // ticks before re-evaluating buddy
  reusePath: 3,
  maxRooms: 2,
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

    // ---------- helpers ----------
    function lowestInRange(origin, range) {
      var allies = origin.findInRange(FIND_MY_CREEPS, range, { filter: function (a){ return a.hits < a.hitsMax; } });
      if (!allies.length) return null;
      return _.min(allies, function (a){ return a.hits / Math.max(1, a.hitsMax); });
    }

    function moveSmart(targetPos, range) {
      if (!targetPos) return ERR_NO_PATH;
      return TaskSquad.stepToward(creep, (targetPos.pos || targetPos), range);
    }

    function tryHeal(target) {
      if (!canHeal || healedThisTick || !target) return;
      if (target.hits >= target.hitsMax) return;
      if (creep.pos.isNearTo(target)) {
        if (creep.heal(target) === OK) healedThisTick = true;
      } else if (creep.pos.inRangeTo(target, 3)) {
        if (creep.rangedHeal(target) === OK) healedThisTick = true;
      }
    }

    function countMedicsFollowing(targetId) {
      var sid = creep.memory.squadId || 'Alpha';
      var n = 0;
      for (var name in Game.creeps) {
        var c = Game.creeps[name];
        if (!c || !c.my || !c.memory) continue;
        if ((c.memory.squadId || 'Alpha') !== sid) continue;
        if ((c.memory.task || c.memory.role) !== 'CombatMedic') continue;
        if (c.memory.followTarget === targetId) n++;
      }
      return n;
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
      var candidates = _.filter(Game.creeps, function (a){
        if (!a || !a.my || !a.memory) return false;
        if (a.memory.squadId !== squadId) return false;
        var t = a.memory.task || a.memory.role || '';
        return !!CombatRoles[t];
      });

      if (candidates.length) {
        var anyInjured = _.some(candidates, function(a){ return a.hits < a.hitsMax; });
        if (anyInjured) {
          var selfRef = this;
          buddy = _.min(candidates, function (a){
            return (a.hits - selfRef._estimateTowerDamage(creep.room, a.pos)) / Math.max(1, a.hitsMax);
          });
        } else {
          // Prefer melee as anchor if nobody is hurt
          buddy = _.find(candidates, function(a){
            var t = a.memory.task || a.memory.role || '';
            return t === 'CombatMelee';
          }) || candidates[0];
        }

        // per-target medic cap
        if (buddy && CONFIG.maxMedicsPerTarget > 0) {
          var count = countMedicsFollowing(buddy.id);
          if (count >= CONFIG.maxMedicsPerTarget) {
            var alt = null, bestLoad = 999, i;
            for (i=0;i<candidates.length;i++){
              var cand = candidates[i];
              var load = countMedicsFollowing(cand.id);
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
      if (anc) moveSmart(anc.pos || anc, 1);
      if (!healedThisTick) tryHeal(lowestInRange(creep.pos, CONFIG.triageRange));
      return;
    }

    // ---------- 3) flee logic (keep heals going) ----------
    var underHp = (creep.hits / creep.hitsMax) < CONFIG.fleePct;
    var hostilesNear = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 3, { filter: function (h){ return h.getActiveBodyparts(ATTACK)>0 || h.getActiveBodyparts(RANGED_ATTACK)>0; } });
    var needToFlee = underHp || (hostilesNear.length && this._inTowerDanger(creep.pos));
    if (needToFlee) {
      var bad = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
      if (bad) {
        var flee = PathFinder.search(creep.pos, [{ pos: bad.pos, range: 4 }], { flee: true });
        if (!flee.incomplete && flee.path.length) {
          creep.move(creep.pos.getDirectionTo(flee.path[0]));
        }
      } else {
        moveSmart(buddy.pos, 3);
      }
      // heal while fleeing: buddy > anyone in 3 > self
      if (!healedThisTick) {
        if (buddy.hits < buddy.hitsMax && creep.pos.inRangeTo(buddy, 3)) tryHeal(buddy);
        if (!healedThisTick) tryHeal(lowestInRange(creep.pos, 3));
        if (!healedThisTick && canHeal && creep.hits < creep.hitsMax) {
          if (creep.heal(creep) === OK) healedThisTick = true;
        }
      }
      return;
    }

    // ---------- 4) follow buddy with safe spacing ----------
    var wantRange = CONFIG.followRange;
    var meleeThreat = creep.pos.findInRange(FIND_HOSTILE_CREEPS, CONFIG.avoidMeleeRange, {
      filter: function (h){ return h.getActiveBodyparts(ATTACK)>0 && h.hits>0; }
    }).length > 0;

    if (!creep.pos.inRangeTo(buddy, wantRange)) {
      moveSmart(buddy.pos, wantRange);
      // heal while approaching
      if (!healedThisTick) {
        if (buddy.hits < buddy.hitsMax) tryHeal(buddy);
        if (!healedThisTick) tryHeal(lowestInRange(creep.pos, 3));
      }
    } else if (meleeThreat) {
      // small nudge away from closest melee if we're too close
      var hm = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS, {
        filter: function (h){ return h.getActiveBodyparts(ATTACK)>0 && h.hits>0; }
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
      var room2 = creep.room, self2 = this;
      var scored = _.map(triageSet, function (a) {
        var exp = a.hits - self2._estimateTowerDamage(room2, a.pos);
        return { a: a, key: exp / Math.max(1, a.hitsMax) };
      });
      var worst = _.min(scored, 'key');
      var patient = worst && worst.a;

      if (patient) {
        // Do not step onto melee tiles if rangedHeal will do
        var desiredRange = creep.pos.inRangeTo(patient, 1) ? 1 : (creep.pos.inRangeTo(patient, 3) ? 3 : 1);
        moveSmart(patient.pos, desiredRange === 1 ? 1 : 2);
        tryHeal(patient); // rangedHeal during approach, heal if adjacent
      }
    } else {
      // ---------- 6) fallback: stick to buddy, heal buddy/nearby ----------
      if (!creep.pos.inRangeTo(buddy, wantRange)) moveSmart(buddy.pos, wantRange);
      if (!healedThisTick) {
        if (buddy.hits < buddy.hitsMax) tryHeal(buddy);
        if (!healedThisTick) tryHeal(lowestInRange(creep.pos, 3));
      }
    }

    // ---------- 7) last: self-heal if still unused ----------
    if (!healedThisTick && canHeal && creep.hits < creep.hitsMax) {
      if (creep.heal(creep) === OK) healedThisTick = true;
    }
  },

  // Quick tower damage estimate (simple & cheap)
  _estimateTowerDamage: function (room, pos) {
    if (!room || !pos) return 0;
    var towers = room.find(FIND_HOSTILE_STRUCTURES, { filter: function (s){ return s.structureType === STRUCTURE_TOWER; } });
    var total = 0;
    for (var i=0;i<towers.length;i++) {
      var d = towers[i].pos.getRangeTo(pos);
      if (d <= TOWER_OPTIMAL_RANGE) total += TOWER_POWER_ATTACK;
      else {
        var capped = Math.min(d, TOWER_FALLOFF_RANGE);
        var frac = (capped - TOWER_OPTIMAL_RANGE) / Math.max(1, (TOWER_FALLOFF_RANGE - TOWER_OPTIMAL_RANGE));
        var fall = TOWER_POWER_ATTACK * (1 - (TOWER_FALLOFF * frac));
        total += Math.max(0, Math.floor(fall));
      }
    }
    return total;
  },

  _inTowerDanger: function (pos) {
    var room = Game.rooms[pos.roomName]; if (!room) return false;
    var towers = room.find(FIND_HOSTILE_STRUCTURES, { filter: function (s){ return s.structureType===STRUCTURE_TOWER; } });
    for (var i=0;i<towers.length;i++) {
      if (towers[i].pos.getRangeTo(pos) <= CONFIG.towerAvoidRadius) return true;
    }
    return false;
  }
};

module.exports = TaskCombatMedic;
