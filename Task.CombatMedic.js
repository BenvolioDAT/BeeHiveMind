// Task.CombatMedic.js — Squad-aware healer with damage-aware triage (ES5-safe)
'use strict';

var BeeToolbox = require('BeeToolbox');
var TaskSquad  = require('Task.Squad');

var CONFIG = {
  followRange: 1,
  triageRange: 3,
  criticalPct: 0.6,
  fleePct: 0.35,
  stickiness: 25,
  reusePath: 10,
  maxRooms: 2,
  towerAvoidRadius: 20,
  maxMedicsPerTarget: 1
};

// Which combat tasks we consider "frontline" squadmates
var CombatRoles = { CombatMelee:1, CombatArcher:1, Dismantler:1 };

var TaskCombatMedic = {
  run: function (creep) {
    if (creep.spawning) return;

    var now = Game.time;
    var bodyHeal = creep.getActiveBodyparts(HEAL);
    var canHeal = bodyHeal > 0;

    function lowestInRange(origin, range) {
      var allies = origin.findInRange(FIND_MY_CREEPS, range, { filter: function (a){ return a.hits < a.hitsMax; } });
      if (!allies.length) return null;
      return _.min(allies, function (a){ return a.hits / a.hitsMax; });
    }

    function moveSmart(targetPos, range) {
      if (!targetPos) return ERR_NO_PATH;
      return creep.moveTo(targetPos, { range: range, reusePath: CONFIG.reusePath, maxRooms: CONFIG.maxRooms, plainCost: 2, swampCost: 6 });
    }

    // 1) Self first if bleeding
    if (creep.hits < creep.hitsMax && canHeal) {
      creep.heal(creep);
    }

    // 2) Choose / refresh buddy (prefer the most endangered; else prefer melee when all healthy)
    var buddy = Game.getObjectById(creep.memory.followTarget);
    if (!buddy || !buddy.my || buddy.hits <= 0) {
      var squadId = creep.memory.squadId || 'Alpha';
      var candidates = _.filter(Game.creeps, function (a){
        if (!a || !a.my || !a.memory) return false;
        if (a.memory.squadId !== squadId) return false;
        var t = a.memory.task || a.memory.role || '';
        return !!CombatRoles[t];
      });

      if (candidates.length) {
        var room = creep.room;
        var anyInjured = _.some(candidates, function(a){ return a.hits < a.hitsMax; });

        if (anyInjured) {
          // Pick lowest expected HP (HP minus tower pressure)
          var self = this;
          buddy = _.min(candidates, function (a){
            return (a.hits - self._estimateTowerDamage(room, a.pos)) / Math.max(1, a.hitsMax);
          });
        } else {
          // Everyone healthy → prefer the melee as default bodyguard anchor
          buddy = _.find(candidates, function(a){
            var t = a.memory.task || a.memory.role || '';
            return t === 'CombatMelee';
          }) || candidates[0];
        }

        if (buddy) { creep.memory.followTarget = buddy.id; creep.memory.assignedAt = now; }
      }
    }

    // 3) If still no buddy, hover at anchor/rally
    if (!buddy) {
      var anc = TaskSquad.getAnchor(creep);
      if (anc) moveSmart(anc, 0);
      return;
    }

    // 4) Flee logic if needed (but try to stay near buddy)
    var underHp = (creep.hits / creep.hitsMax) < CONFIG.fleePct;
    var hostilesNear = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 3, { filter: function (h){ return h.getActiveBodyparts(ATTACK)>0 || h.getActiveBodyparts(RANGED_ATTACK)>0; } });
    var needToFlee = underHp || (hostilesNear.length && this._inTowerDanger(creep.pos));
    if (needToFlee) {
      var bad = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
      if (bad) {
        var flee = PathFinder.search(creep.pos, [{ pos: bad.pos, range: 4 }], { flee: true });
        if (!flee.incomplete && flee.path.length) creep.move(creep.pos.getDirectionTo(flee.path[0]));
      } else {
        moveSmart(buddy.pos, 3);
      }
      // heal while fleeing
      var tf = lowestInRange(creep.pos, 3) || (creep.pos.inRangeTo(buddy,3) ? buddy : null);
      if (tf) { if (creep.pos.isNearTo(tf)) creep.heal(tf); else creep.rangedHeal(tf); }
      return;
    }

    // 5) Stay glued near buddy (rear position)
    if (!creep.pos.inRangeTo(buddy, CONFIG.followRange)) {
      // cooperative step (allows friendly swap via TaskSquad)
      TaskSquad.stepToward(creep, buddy.pos, CONFIG.followRange);
    }

    // 6) Damage-aware triage (INJURED-ONLY — no chasing full-HP creeps)
    var triageSet = creep.pos.findInRange(
      FIND_MY_CREEPS,
      CONFIG.triageRange,
      { filter: function(a){ return a.hits < a.hitsMax; } } // ✅ injured-only
    );

    if (triageSet && triageSet.length) {
      var room2 = creep.room, self2 = this;
      var scored = _.map(triageSet, function (a) {
        var exp = a.hits - self2._estimateTowerDamage(room2, a.pos);
        return { a: a, key: exp / Math.max(1, a.hitsMax) };
      });
      var worst = _.min(scored, 'key');
      var target = worst && worst.a;

      if (target && target.hits < target.hitsMax) {
        if (creep.pos.isNearTo(target)) creep.heal(target);
        else {
          moveSmart(target.pos, 1);
          if (creep.pos.inRangeTo(target, 3)) creep.rangedHeal(target);
        }
      } else {
        // nothing valid → hold formation on buddy
        if (!creep.pos.inRangeTo(buddy, CONFIG.followRange)) {
          TaskSquad.stepToward(creep, buddy.pos, CONFIG.followRange);
        }
      }
    } else {
      // 7) Fallback: buddy-first + standard lowest-in-range
      var crit = lowestInRange(creep.pos, CONFIG.triageRange);
      if (crit && (crit.hits / crit.hitsMax) <= CONFIG.criticalPct && crit.id !== buddy.id) {
        if (creep.pos.isNearTo(crit)) creep.heal(crit);
        else { moveSmart(crit.pos, 1); if (creep.pos.inRangeTo(crit,3)) creep.rangedHeal(crit); }
      } else {
        if (creep.pos.isNearTo(buddy)) {
          if (buddy.hits < buddy.hitsMax) creep.heal(buddy);
          else {
            var other = lowestInRange(creep.pos, 1);
            if (other) creep.heal(other);
          }
        } else if (creep.pos.inRangeTo(buddy, 3)) {
          if (buddy.hits < buddy.hitsMax) creep.rangedHeal(buddy);
          else {
            var other3 = lowestInRange(creep.pos, 3);
            if (other3) creep.rangedHeal(other3);
          }
        }
      }
    }

    // 8) Refresh buddy assignment occasionally
    if (creep.memory.assignedAt && (now - creep.memory.assignedAt) > CONFIG.stickiness) {
      delete creep.memory.followTarget;
      delete creep.memory.assignedAt;
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
    for (var i=0;i<towers.length;i++) if (towers[i].pos.getRangeTo(pos) <= CONFIG.towerAvoidRadius) return true;
    return false;
  }
};

module.exports = TaskCombatMedic;
