// Task.Dismantler.js — Tower window aware siege (ES5)
'use strict';

var BeeToolbox = require('BeeToolbox');
var TaskSquad  = require('Task.Squad');

var CONFIG = {
  commitMargin: 48,
  delayFlag: 'DismantleHold'
};

var TaskDismantler = {
  run: function (creep) {
    if (!creep || creep.spawning) return;

    if (this._shouldDelay(creep)) return;

    var target = this._resolveTarget(creep);
    if (!target) {
      this._rally(creep);
      return;
    }

    if (!this._towerWindowOpen(creep, target)) {
      this._rally(creep);
      return;
    }

    if (!creep.pos.isNearTo(target)) {
      TaskSquad.stepToward(creep, target.pos, 1);
      return;
    }

    var rc = creep.dismantle(target);
    if (rc === ERR_INVALID_TARGET && creep.getActiveBodyparts(ATTACK) > 0) {
      creep.attack(target);
    }
    if (!target.hits || target.hits <= 1000) {
      delete creep.memory.tid;
    }
  },

  _shouldDelay: function (creep) {
    if (creep.memory && creep.memory.delay && Game.time < creep.memory.delay) return true;
    var flag = Game.flags[CONFIG.delayFlag];
    if (flag && flag.room && flag.room.name === creep.pos.roomName) {
      if (flag.color === COLOR_YELLOW) return true;
    }
    return false;
  },

  _rally: function (creep) {
    var anchor = TaskSquad.getAnchor ? TaskSquad.getAnchor(creep) : null;
    if (!anchor) {
      var fallback = Game.flags.Rally || Game.flags.Attack;
      if (fallback) anchor = fallback.pos;
    }
    if (anchor) TaskSquad.stepToward(creep, anchor, 1);
  },

  _resolveTarget: function (creep) {
    var id = creep.memory ? creep.memory.tid : null;
    var existing = id ? Game.getObjectById(id) : null;
    if (existing && existing.hits > 0) return existing;
    var room = creep.room;
    if (!room) return null;
    var priority = this._priorityStructures(room);
    var choice = creep.pos.findClosestByPath(priority);
    if (choice) {
      creep.memory.tid = choice.id;
      return choice;
    }
    delete creep.memory.tid;
    return null;
  },

  _priorityStructures: function (room) {
    var list = [];
    function _push(arr) {
      if (!arr) return;
      for (var i = 0; i < arr.length; i++) list.push(arr[i]);
    }
    _push(room.find(FIND_HOSTILE_STRUCTURES, { filter: function (s) { return s.structureType === STRUCTURE_TOWER; } }));
    _push(room.find(FIND_HOSTILE_STRUCTURES, { filter: function (s) { return s.structureType === STRUCTURE_SPAWN; } }));
    _push(room.find(FIND_HOSTILE_STRUCTURES, { filter: function (s) { return s.structureType === STRUCTURE_INVADER_CORE; } }));
    _push(room.find(FIND_HOSTILE_STRUCTURES, {
      filter: function (s) {
        if (!s || s.hits == null) return false;
        if (s.structureType === STRUCTURE_CONTROLLER) return false;
        if (s.structureType === STRUCTURE_ROAD) return false;
        if (s.structureType === STRUCTURE_CONTAINER) return false;
        return true;
      }
    }));
    return list;
  },

  _towerWindowOpen: function (creep, target) {
    var dps = BeeToolbox.calcTowerDps(creep.room, target.pos || target);
    if (dps <= 0) return true;
    if (this._hasCover(creep.pos)) return true;
    var hps = this._nearbyHps(creep);
    creep.memory = creep.memory || {};
    creep.memory.expectedHps = hps;
    return (hps - dps) >= CONFIG.commitMargin;
  },

  _hasCover: function (pos) {
    var look = pos.lookFor(LOOK_STRUCTURES);
    for (var i = 0; i < look.length; i++) {
      var st = look[i];
      if (st.structureType === STRUCTURE_RAMPART && st.my) return true;
    }
    return false;
  },

  _nearbyHps: function (creep) {
    var sum = 0;
    var medics = creep.pos.findInRange(FIND_MY_CREEPS, 3, {
      filter: function (c) {
        var role = c.memory && (c.memory.task || c.memory.role);
        return role === 'CombatMedic';
      }
    });
    for (var i = 0; i < medics.length; i++) {
      sum += medics[i].getActiveBodyparts(HEAL) * 12;
    }
    sum += creep.getActiveBodyparts(HEAL) * 12;
    return sum;
  }
};

module.exports = TaskDismantler;
