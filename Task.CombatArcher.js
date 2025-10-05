// Task.CombatArcher.js — Range control + mass-attack discipline (ES5)
'use strict';

var BeeToolbox = require('BeeToolbox');
var TaskSquad  = require('Task.Squad');

var CONFIG = {
  desiredRange: 3,         // try to sit at 3 tiles for optimal RANGED dps
  kiteRange: 2,            // if hostile gets within 2, backpedal
  approachSlack: 1,        // only close in if > desiredRange + slack
  fleeHitsPct: 0.4,
  fleeTowerMargin: 0,
  shotMassThreshold: 3,    // mass-attack when ≥ this many hostiles in 3
  towerMarginForCommit: 60 // require at least this surplus HPS to stand under towers
};

var TaskCombatArcher = {
  run: function (creep) {
    if (!creep || creep.spawning) return;

    if (TaskSquad && TaskSquad.shouldRecycle && TaskSquad.shouldRecycle(creep)) {
      if (TaskSquad.recycle && TaskSquad.recycle(creep)) return;
    }

    var mem = creep.memory = creep.memory || {};
    var archerMem = mem.archer || (mem.archer = {});

    var intent = TaskSquad.getIntent ? TaskSquad.getIntent(creep) : 'RALLY';

    if (this._shouldRetreat(intent, creep)) {
      this._retreat(creep);
      this._fire(creep, null);
      return;
    }

    var target = TaskSquad.sharedTarget ? TaskSquad.sharedTarget(creep) : null;
    if (!target) {
      var hostiles = creep.room ? creep.room.find(FIND_HOSTILE_CREEPS) : [];
      target = BeeToolbox.pickFocusTarget(creep, hostiles);
    }

    if (!target) {
      this._moveToAnchor(creep, intent);
      this._fire(creep, null);
      return;
    }

    archerMem.focusId = target.id;

    if (BeeToolbox.shouldFlee(creep, {
      fleeHitsPct: CONFIG.fleeHitsPct,
      considerTowers: true,
      fleeTowerMargin: CONFIG.fleeTowerMargin,
      threatRange: 1
    })) {
      this._kiteFrom(creep, target);
      this._fire(creep, target);
      return;
    }

    var towerOk = BeeToolbox.isTowerFireSafe(creep.room, creep);
    if (!towerOk && intent !== 'KITE') {
      // Tower margin negative → stay near anchor unless explicitly kiting.
      this._moveToAnchor(creep, intent);
      this._fire(creep, target);
      return;
    }

    this._fire(creep, target);
    this._maintainRange(creep, target, archerMem);
  },

  _shouldRetreat: function (intent, creep) {
    if (intent === 'RETREAT') return true;
    if (intent === 'RALLY' && creep.hits < creep.hitsMax) return false;
    return false;
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

  _moveToAnchor: function (creep, intent) {
    var anchor = TaskSquad.getAnchor ? TaskSquad.getAnchor(creep) : null;
    if (!anchor) return;
    var range = (intent === 'RALLY') ? 1 : 0;
    TaskSquad.stepToward(creep, anchor, range);
  },

  _fire: function (creep, target) {
    if (!creep) return;
    var in3 = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 3);
    if (in3 && in3.length >= CONFIG.shotMassThreshold) {
      creep.rangedMassAttack();
      return;
    }
    if (target && creep.pos.inRangeTo(target, 3)) {
      creep.rangedAttack(target);
      return;
    }
    if (in3 && in3.length) {
      creep.rangedAttack(in3[0]);
    }
  },

  _kiteFrom: function (creep, target) {
    if (!creep || !target) return;
    var flee = PathFinder.search(creep.pos, [{ pos: target.pos, range: CONFIG.desiredRange }], {
      flee: true,
      maxRooms: 2,
      maxCost: 0xFF
    });
    if (flee.path && flee.path.length) {
      var step = flee.path[0];
      var pos = new RoomPosition(step.x, step.y, creep.pos.roomName);
      if (!BeeToolbox.friendlySwap(creep, pos)) {
        creep.move(creep.pos.getDirectionTo(step));
      }
    }
  },

  _maintainRange: function (creep, target, archerMem) {
    if (!target) return;
    var range = creep.pos.getRangeTo(target);
    if (range <= CONFIG.kiteRange) {
      this._kiteFrom(creep, target);
      archerMem.lastMove = Game.time;
      return;
    }
    if (range > (CONFIG.desiredRange + CONFIG.approachSlack)) {
      TaskSquad.stepToward(creep, target.pos, CONFIG.desiredRange);
      archerMem.lastMove = Game.time;
    }
  }
};

module.exports = TaskCombatArcher;
