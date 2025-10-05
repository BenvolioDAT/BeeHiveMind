// Task.CombatMedic.js — Squad-aware triage (ES5)
'use strict';

var BeeToolbox = require('BeeToolbox');
var TaskSquad  = require('Task.Squad');

var CONFIG = {
  followRange: 1,
  triageRange: 4,
  fleeHitsPct: 0.35,
  towerMargin: 24,
  buddyStickTicks: 20,
  avoidMeleeRange: 2
};

var FRONTLINE = { CombatMelee: 1, CombatArcher: 1, Dismantler: 1 };

var TaskCombatMedic = {
  run: function (creep) {
    if (!creep || creep.spawning) return;

    if (TaskSquad && TaskSquad.shouldRecycle && TaskSquad.shouldRecycle(creep)) {
      if (TaskSquad.recycle && TaskSquad.recycle(creep)) return;
    }

    creep.memory = creep.memory || {};
    creep.memory.expectedHps = creep.getActiveBodyparts(HEAL) * 12;

    var intent = TaskSquad.getIntent ? TaskSquad.getIntent(creep) : 'RALLY';
    var buddy = this._resolveBuddy(creep);

    if (BeeToolbox.shouldFlee(creep, {
      fleeHitsPct: CONFIG.fleeHitsPct,
      considerTowers: true,
      fleeTowerMargin: CONFIG.towerMargin,
      threatRange: 1
    }) || intent === 'RETREAT') {
      this._retreat(creep);
      this._healLoop(creep, buddy);
      return;
    }

    if (!buddy) {
      this._idleAtAnchor(creep);
      this._healLoop(creep, null);
      return;
    }

    var range = creep.pos.getRangeTo(buddy);
    if (range > CONFIG.followRange) {
      TaskSquad.stepToward(creep, buddy.pos, CONFIG.followRange);
      this._healLoop(creep, buddy);
      return;
    }

    if (range <= CONFIG.followRange && this._meleeThreatNearby(creep)) {
      var dir = buddy.pos.getDirectionTo(creep.pos);
      creep.move(dir);
    }

    this._healLoop(creep, buddy);
  },

  _idleAtAnchor: function (creep) {
    var anchor = TaskSquad.getAnchor ? TaskSquad.getAnchor(creep) : null;
    if (!anchor) return;
    TaskSquad.stepToward(creep, anchor, 1);
  },

  _retreat: function (creep) {
    var anchor = TaskSquad.getAnchor ? TaskSquad.getAnchor(creep) : null;
    if (!anchor) {
      var spawn = creep.pos.findClosestByPath(FIND_MY_SPAWNS);
      if (spawn) anchor = spawn.pos;
    }
    if (anchor) {
      TaskSquad.stepToward(creep, anchor, 1);
    }
  },

  _healLoop: function (creep, buddy) {
    if (!creep) return;
    var healed = false;
    if (buddy && buddy.hits < buddy.hitsMax && creep.pos.inRangeTo(buddy, 3)) {
      if (creep.pos.isNearTo(buddy)) {
        healed = creep.heal(buddy) === OK;
      } else {
        healed = creep.rangedHeal(buddy) === OK;
      }
    }
    if (!healed) {
      healed = BeeToolbox.healBestTarget(creep);
    }
    if (!healed && creep.hits < creep.hitsMax) {
      creep.heal(creep);
    }
  },

  _meleeThreatNearby: function (creep) {
    var hostiles = creep.pos.findInRange(FIND_HOSTILE_CREEPS, CONFIG.avoidMeleeRange, {
      filter: function (h) { return h.getActiveBodyparts(ATTACK) > 0 && h.hits > 0; }
    });
    return hostiles && hostiles.length > 0;
  },

  _resolveBuddy: function (creep) {
    var mem = creep.memory;
    var id = mem.followTarget;
    var buddy = id ? Game.getObjectById(id) : null;
    if (buddy && buddy.hits > 0) {
      if (mem.assignedAt && (Game.time - mem.assignedAt) <= CONFIG.buddyStickTicks) {
        return buddy;
      }
    }
    var squad = mem.squadId || 'Alpha';
    var candidates = [];
    for (var name in Game.creeps) {
      if (!Game.creeps.hasOwnProperty(name)) continue;
      var c = Game.creeps[name];
      if (!c || !c.my || !c.memory) continue;
      if ((c.memory.squadId || 'Alpha') !== squad) continue;
      var role = c.memory.task || c.memory.role || '';
      if (!FRONTLINE[role]) continue;
      candidates.push(c);
    }
    if (!candidates.length) {
      delete mem.followTarget;
      return null;
    }
    var best = null;
    var bestScore = Infinity;
    for (var i = 0; i < candidates.length; i++) {
      var cand = candidates[i];
      var frac = cand.hits / Math.max(1, cand.hitsMax);
      var tower = BeeToolbox.calcTowerDps(cand.room, cand.pos);
      var score = frac + (tower / 600);
      if (score < bestScore) {
        bestScore = score;
        best = cand;
      }
    }
    if (best) {
      mem.followTarget = best.id;
      mem.assignedAt = Game.time;
      return best;
    }
    delete mem.followTarget;
    return null;
  }
};

module.exports = TaskCombatMedic;
