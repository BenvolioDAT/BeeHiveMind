// Task.CombatMelee.js — Fortress-aware vanguard (ES5)
'use strict';

var BeeToolbox = require('BeeToolbox');
var TaskSquad  = require('Task.Squad');

var CONFIG = {
  fleeHitsPct: 0.35,
  commitMargin: 60,
  threatRange: 1,
  doorAttack: true
};

var TaskCombatMelee = {
  run: function (creep) {
    if (!creep || creep.spawning) return;

    if (TaskSquad && TaskSquad.shouldRecycle && TaskSquad.shouldRecycle(creep)) {
      if (TaskSquad.recycle && TaskSquad.recycle(creep)) return;
    }

    creep.memory = creep.memory || {};

    var intent = TaskSquad.getIntent ? TaskSquad.getIntent(creep) : 'RALLY';
    if (intent === 'RETREAT') {
      this._retreat(creep);
      this._swing(creep, null);
      return;
    }

    if (BeeToolbox.shouldFlee(creep, {
      fleeHitsPct: CONFIG.fleeHitsPct,
      considerTowers: true,
      fleeTowerMargin: 0,
      threatRange: CONFIG.threatRange
    })) {
      this._retreat(creep);
      this._swing(creep, null);
      return;
    }

    var target = TaskSquad.sharedTarget ? TaskSquad.sharedTarget(creep) : null;
    if (!target) {
      var hostiles = creep.room ? creep.room.find(FIND_HOSTILE_CREEPS) : [];
      target = BeeToolbox.pickFocusTarget(creep, hostiles);
    }

    if (!target) {
      this._holdAnchor(creep);
      return;
    }

    if (!this._canEngage(creep, target)) {
      this._holdAnchor(creep);
      return;
    }

    if (creep.pos.isNearTo(target)) {
      this._swing(creep, target);
      return;
    }

    if (target.pos) {
      TaskSquad.stepToward(creep, target.pos, 1);
      var adjacent = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 1);
      if (adjacent && adjacent.length) {
        this._swing(creep, adjacent[0]);
      }
    }
  },

  _swing: function (creep, target) {
    if (!target) {
      var adj = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 1);
      if (adj && adj.length) creep.attack(adj[0]);
      return;
    }
    if (target.structureType && this._skipDoor(creep, target)) {
      return;
    }
    creep.attack(target);
  },

  _skipDoor: function (creep, target) {
    if (!target || !target.structureType) return false;
    if (!CONFIG.doorAttack && (target.structureType === STRUCTURE_WALL || target.structureType === STRUCTURE_RAMPART)) {
      return true;
    }
    if (creep.memory && creep.memory.noDoors) {
      if (target.structureType === STRUCTURE_WALL || target.structureType === STRUCTURE_RAMPART) {
        return true;
      }
    }
    return false;
  },

  _holdAnchor: function (creep) {
    var anchor = TaskSquad.getAnchor ? TaskSquad.getAnchor(creep) : null;
    if (!anchor) return;
    TaskSquad.stepToward(creep, anchor, 0);
  },

  _retreat: function (creep) {
    var anchor = TaskSquad.getAnchor ? TaskSquad.getAnchor(creep) : null;
    if (!anchor) {
      var spawn = creep.pos.findClosestByPath(FIND_MY_SPAWNS);
      if (spawn) anchor = spawn.pos;
    }
    if (anchor) TaskSquad.stepToward(creep, anchor, 1);
  },

  _canEngage: function (creep, target) {
    if (!target) return false;
    if (target.structureType && this._skipDoor(creep, target)) return false;
    var dps = BeeToolbox.calcTowerDps(creep.room, target.pos || target);
    if (dps <= 0) return true;
    var selfHps = creep.getActiveBodyparts(HEAL) * 12;
    var squadHps = this._nearbyMedicHps(creep);
    var margin = (selfHps + squadHps) - dps;
    creep.memory.towerMargin = margin;
    creep.memory.expectedHps = selfHps + squadHps;
    return margin >= CONFIG.commitMargin;
  },

  _nearbyMedicHps: function (creep) {
    var allies = creep.pos.findInRange(FIND_MY_CREEPS, 3, {
      filter: function (c) {
        var role = c.memory && (c.memory.task || c.memory.role);
        return role === 'CombatMedic';
      }
    });
    if (!allies || !allies.length) return 0;
    var sum = 0;
    for (var i = 0; i < allies.length; i++) {
      sum += allies[i].getActiveBodyparts(HEAL) * 12;
    }
    return sum;
  }
};

module.exports = TaskCombatMelee;
