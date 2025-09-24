// Task.CombatMedic.js — Squad-aware healer (ES5-safe)
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

    if (creep.hits < creep.hitsMax && canHeal) {
      creep.heal(creep);
    }

    // follow the most critical squadmate if not already assigned
    var buddy = Game.getObjectById(creep.memory.followTarget);
    if (!buddy || !buddy.my || buddy.hits <= 0) {
      // pick weakest squadmate in room
      var squadId = creep.memory.squadId || 'Alpha';
      var candidates = _.filter(Game.creeps, function (a){
        if (!a.my || !a.memory) return false;
        if (a.memory.squadId !== squadId) return false;
        if (!CombatRoles[a.memory.task] && a.memory.role !== 'CombatMelee' && a.memory.role !== 'CombatArcher' && a.memory.role !== 'Dismantler') return false;
        return true;
      });
      if (candidates.length) {
        buddy = _.min(candidates, function (a){ return a.hits / a.hitsMax; });
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

    // normal: stay glued near buddy (rear position)
    if (!creep.pos.inRangeTo(buddy, CONFIG.followRange)) {
      // one cooperative step (allows friendly swap through TaskSquad)
      TaskSquad.stepToward(creep, buddy.pos, CONFIG.followRange);
    }

    // triage prioritization
    var crit = lowestInRange(creep.pos, CONFIG.triageRange);
    if (crit && (crit.hits / crit.hitsMax) <= CONFIG.criticalPct && crit.id !== buddy.id) {
      if (creep.pos.isNearTo(crit)) creep.heal(crit);
      else { moveSmart(crit.pos, 1); if (creep.pos.inRangeTo(crit,3)) creep.rangedHeal(crit); }
    } else {
      // prioritize buddy
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

    // refresh / reconsider
    if (creep.memory.assignedAt && (now - creep.memory.assignedAt) > CONFIG.stickiness) {
      var inj = lowestInRange(creep.pos, CONFIG.triageRange);
      if (inj && (inj.hits / inj.hitsMax) < 0.5 && inj.id !== buddy.id) {
        delete creep.memory.followTarget;
        delete creep.memory.assignedAt;
      } else {
        creep.memory.assignedAt = now;
      }
    }
  },

  _inTowerDanger: function (pos) {
    var room = Game.rooms[pos.roomName]; if (!room) return false;
    var towers = room.find(FIND_HOSTILE_STRUCTURES, { filter: function (s){ return s.structureType===STRUCTURE_TOWER; } });
    for (var i=0;i<towers.length;i++) if (towers[i].pos.getRangeTo(pos) <= CONFIG.towerAvoidRadius) return true;
    return false;
  }
};

module.exports = TaskCombatMedic;
