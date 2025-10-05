// Task.CombatArcher.js — disciplined archer micro (ES5-only)
'use strict';

var BeeToolbox = require('BeeToolbox');
var TaskSquad  = require('Task.Squad');

var CFG = {
  desiredRange: 3,             // maintain 3 range sweet spot
  holdSlack: 1,                // acceptable extra distance before advancing
  kiteTrigger: 2,              // if target ≤ this range we backpedal
  fleeHpPct: 0.40,
  waitForMedic: true,
  fallbackRange: 2,
  kiteRange: 4,
};

function _archerMem(creep) {
  creep.memory = creep.memory || {};
  if (!creep.memory.archer) creep.memory.archer = {};
  return creep.memory.archer;
}

var DIRS = [
  null,
  { x: 0, y: -1 },
  { x: 1, y: -1 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
  { x: -1, y: 1 },
  { x: -1, y: 0 },
  { x: -1, y: -1 }
];

function _supportHps(creep) {
  if (!creep) return 0;
  var squadId = TaskSquad.getSquadId(creep);
  var allies = creep.pos.findInRange(FIND_MY_CREEPS, 2, {
    filter: function (ally) {
      if (!ally || !ally.my || ally.id === creep.id) return false;
      if (ally.getActiveBodyparts(HEAL) <= 0) return false;
      return TaskSquad.getSquadId(ally) === squadId;
    }
  });
  var total = 0;
  for (var i = 0; i < allies.length; i++) {
    total += allies[i].getActiveBodyparts(HEAL) * 12;
  }
  return total;
}

function _stepAway(creep, threatPos, anchorPos) {
  if (!creep) return false;
  if (anchorPos) {
    TaskSquad.stepToward(creep, anchorPos, CFG.kiteRange);
    return true;
  }
  if (!threatPos) return false;
  var pos = threatPos.pos ? threatPos.pos : threatPos;
  if (!pos) return false;
  if (creep.travelTo) {
    creep.travelTo(pos, { flee: true, range: CFG.desiredRange + 1, maxRooms: 1, ignoreCreeps: false });
    return true;
  }
  var terrain = creep.room ? creep.room.getTerrain() : null;
  var bestDir = 0;
  var bestRange = -1;
  for (var d = 1; d <= 8; d++) {
    var off = DIRS[d];
    if (!off) continue;
    var nx = creep.pos.x + off.x;
    var ny = creep.pos.y + off.y;
    if (nx <= 0 || nx >= 49 || ny <= 0 || ny >= 49) continue;
    if (terrain && terrain.get(nx, ny) === TERRAIN_MASK_WALL) continue;
    var range = Math.max(Math.abs(nx - pos.x), Math.abs(ny - pos.y));
    if (range > bestRange) {
      bestRange = range;
      bestDir = d;
    }
  }
  if (bestDir > 0) {
    creep.move(bestDir);
    return true;
  }
  return false;
}

function _resolveTarget(creep, shared) {
  if (shared) return shared;
  return BeeToolbox.pickFocusTarget(creep, null);
}

function _massAttackBetter(creep, focus, hostiles) {
  if (!creep) return false;
  hostiles = hostiles || [];
  if (!hostiles.length) return false;
  var total = 0;
  for (var i = 0; i < hostiles.length; i++) {
    var h = hostiles[i];
    if (!h || h.hits <= 0) continue;
    var dist = creep.pos.getRangeTo(h);
    if (dist <= 1) total += 10;
    else if (dist === 2) total += 4;
    else if (dist === 3) total += 1;
  }
  var single = 0;
  if (focus && focus.hits != null && creep.pos.inRangeTo(focus, 3)) single = 10;
  if (total >= single + 8) return true;
  if (hostiles.length >= 3 && total >= 12) return true;
  return false;
}

function _performRanged(creep, focus) {
  if (!creep) return;
  var hostiles = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 3, {
    filter: function (h) { return h && h.hits > 0; }
  });
  if (_massAttackBetter(creep, focus, hostiles)) {
    creep.rangedMassAttack();
    return;
  }
  if (focus && focus.pos && focus.hits != null && creep.pos.inRangeTo(focus, 3)) {
    creep.rangedAttack(focus);
    return;
  }
  if (hostiles.length) {
    var picked = BeeToolbox.pickFocusTarget(creep, hostiles);
    if (picked && picked.hits != null && creep.pos.inRangeTo(picked, 3)) {
      creep.rangedAttack(picked);
      return;
    }
  }
  if (hostiles.length) {
    creep.rangedAttack(hostiles[0]);
  }
}

var TaskCombatArcher = {
  run: function (creep) {
    if (!creep || creep.spawning) return;
    var A = _archerMem(creep);

    if (TaskSquad.shouldRecycle(creep)) {
      if (TaskSquad.recycle(creep)) return;
    }

    if (CFG.waitForMedic && BeeToolbox && BeeToolbox.shouldWaitForMedic && BeeToolbox.shouldWaitForMedic(creep)) {
      var anchor = TaskSquad.getAnchor(creep);
      if (anchor) TaskSquad.stepToward(creep, anchor, 0);
      return;
    }

    var intent = TaskSquad.getIntent(creep);
    var anchorPos = TaskSquad.getAnchor(creep);
    var shared = TaskSquad.sharedTarget(creep);
    var target = _resolveTarget(creep, shared);
    var targetPos = target && target.pos ? target.pos : null;
    if (!targetPos && target && target.x != null && target.y != null) {
      targetPos = target;
    }
    if (!targetPos && A.tR === creep.pos.roomName) {
      targetPos = new RoomPosition(A.tX || creep.pos.x, A.tY || creep.pos.y, A.tR || creep.pos.roomName);
    }

    var supportHps = _supportHps(creep);
    creep.memory = creep.memory || {};
    creep.memory.supportHps = supportHps;
    creep.memory.towerMarginPct = 1.1;
    var flee = false;
    if (intent === 'RETREAT') flee = true;
    else if (BeeToolbox && BeeToolbox.shouldFlee) {
      flee = BeeToolbox.shouldFlee(creep, {
        fleeHp: CFG.fleeHpPct,
        supportHps: supportHps,
        towerMargin: 1.1
      });
    }

    BeeToolbox.healBestTarget(creep, {
      squadId: TaskSquad.getSquadId(creep),
      range: 3,
      selfCritical: CFG.fleeHpPct
    });

    if (!targetPos) {
      if (flee && anchorPos) {
        TaskSquad.stepToward(creep, anchorPos, CFG.kiteRange);
      } else if (anchorPos) {
        TaskSquad.stepToward(creep, anchorPos, CFG.fallbackRange);
      }
      _performRanged(creep, null);
      return;
    }

    A.tX = targetPos.x; A.tY = targetPos.y; A.tR = targetPos.roomName; A.lastSeen = Game.time;

    if (flee) {
      _stepAway(creep, targetPos, anchorPos);
      _performRanged(creep, target && target.hits != null ? target : null);
      return;
    }

    var range = creep.pos.getRangeTo(targetPos);
    if (range < CFG.desiredRange) {
      _stepAway(creep, targetPos, anchorPos);
    } else if (range > CFG.desiredRange + CFG.holdSlack) {
      TaskSquad.stepToward(creep, targetPos, CFG.desiredRange);
    } else if (intent === 'KITE' && range <= CFG.kiteTrigger) {
      _stepAway(creep, targetPos, anchorPos);
    }

    _performRanged(creep, target && target.hits != null ? target : null);
  }
};

module.exports = TaskCombatArcher;
