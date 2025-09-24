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

    // --- NEW: always patch ourselves first if bleeding
    if (creep.hits < creep.hitsMax && canHeal) {
      creep.heal(creep);
    }

    // choose / refresh buddy (prefer the most endangered squadmate)
    var buddy = Game.getObjectById(creep.memory.followTarget);
    if (!buddy || !buddy.my || buddy.hits <= 0) {
      var squadId = creep.memory.squadId || 'Alpha';
      var candidates = _.filter(Game.creeps, function (a){
        if (!a.my || !a.memory) return false;
        if (a.memory.squadId !== squadId) return false;
        return !!CombatRoles[a.memory.task] || a.memory.role === 'CombatMelee' || a.memory.role === 'CombatArcher' || a.memory.role === 'Dismantler';
      });
      if (candidates.length) {
        // --- NEW: prefer lowest expected health (HP minus tower pressure)
        var room = creep.room;
        var that = this;
        buddy = _.min(candidates, function (a){
          return (a.hits - that._estimateTowerDamage(room, a.pos)) / Math.max(1, a.hitsMax);
        });
        if (buddy) { creep.memory.followTarget = buddy.id; creep.memory.assignedAt = now; }
      }
    }

    // if no buddy, hover at anchor/rally
    if (!buddy) {
      var anc = TaskSquad.getAnchor(creep);
      if (anc) moveSmart(anc, 0);
      return;
    }

    // flee logic if needed (but try to stay near buddy)
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

    // stay glued near buddy (rear position)
    if (!creep.pos.inRangeTo(buddy, CONFIG.followRange)) {
      // cooperative step (allows friendly swap through TaskSquad)
      TaskSquad.stepToward(creep, buddy.pos, CONFIG.followRange);
    }

    // --- NEW: damage-aware triage (inspired by Harabi's "maximize lowest expected HP")
    var triageSet = creep.pos.findInRange(FIND_MY_CREEPS, CONFIG.triageRange);
    if (triageSet && triageSet.length) {
      var room = creep.room, self = this;
      var scored = _.map(triageSet, function (a) {
        var exp = a.hits - self._estimateTowerDamage(room, a.pos);
        return { a: a, key: exp / Math.max(1, a.hitsMax) };
      });
      var worst = _.min(scored, 'key');
      var target = worst && worst.a;

      if (target) {
        if (creep.pos.isNearTo(target)) creep.heal(target);
        else {
          moveSmart(target.pos, 1);
          if (creep.pos.inRangeTo(target, 3)) creep.rangedHeal(target);
        }
      }
    } else {
      // fallback: heal buddy / others as before
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

    // refresh buddy assignment occasionally
    if (creep.memory.assignedAt && (now - creep.memory.assignedAt) > CONFIG.stickiness) {
      delete creep.memory.followTarget;
      delete creep.memory.assignedAt;
    }
  },

  // --- NEW: quick tower damage estimate (matches Screeps constants; simple & cheap)
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
