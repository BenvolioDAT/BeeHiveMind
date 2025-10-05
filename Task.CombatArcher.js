// Task.CombatArcher.js — disciplined archer micro (ES5-only)
'use strict';

var BeeToolbox = require('BeeToolbox');
var TaskSquad  = require('Task.Squad');
var ThreatAnalyzer = require('Combat.ThreatAnalyzer.es5');

var CFG = {
  desiredRange: 3,             // maintain 3 range sweet spot
  holdSlack: 1,                // acceptable extra distance before advancing
  kiteTrigger: 2,              // if target ≤ this range we backpedal
  fleeHpPct: 0.40,
  maxTowerSafe: 300,           // tower DPS threshold for standing ground
  waitForMedic: true,
  fallbackRange: 2,
  kiteRange: 4,
};

function _archerMem(creep) {
  creep.memory = creep.memory || {};
  if (!creep.memory.archer) creep.memory.archer = {};
  return creep.memory.archer;
}

function _towerDps(pos) {
  if (!pos) return 0;
  return ThreatAnalyzer.estimateTowerDps(pos.roomName, pos);
}

function _shouldHold(creep, target, range, info) {
  if (!target || range == null) return false;
  if (range < CFG.desiredRange) return false;
  if (range > CFG.desiredRange + CFG.holdSlack) return false;
  if (info && info.targetMoved) return false;
  if (info && info.intent === 'KITE') return false;
  if (info && info.towerDps > CFG.maxTowerSafe) return false;
  return true;
}

function _shouldRetreat(info) {
  if (!info) return false;
  if (info.intent === 'RETREAT') return true;
  if (info.hpPct < CFG.fleeHpPct) return true;
  if (info.towerDps > info.hps) return true;
  return false;
}

function _healWhileMoving(creep, info) {
  if (!creep || creep.getActiveBodyparts(HEAL) <= 0) return;
  if (info && info.lowSelf) {
    creep.heal(creep);
    return;
  }
  var squadId = TaskSquad.getSquadId(creep);
  var allies = creep.pos.findInRange(FIND_MY_CREEPS, 3, {
    filter: function (c) {
      if (!c || !c.my || !c.memory) return false;
      return c.memory.squadId === squadId && c.hits < c.hitsMax;
    }
  });
  if (allies.length) {
    var buddy = creep.pos.findClosestByRange(allies);
    if (buddy) {
      if (creep.pos.isNearTo(buddy)) creep.heal(buddy);
      else creep.rangedHeal(buddy);
    }
  }
}

function _fire(creep, target) {
  if (!target) {
    var opportunistic = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
    if (opportunistic && creep.pos.inRangeTo(opportunistic, 3)) creep.rangedAttack(opportunistic);
    return;
  }
  var in3 = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 3);
  if (in3.length >= 3) {
    creep.rangedMassAttack();
    return;
  }
  if (creep.pos.inRangeTo(target, 3)) {
    creep.rangedAttack(target);
    return;
  }
  _fire(creep, null);
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
    var target = TaskSquad.sharedTarget(creep);
    var anchorPos = TaskSquad.getAnchor(creep);

    if (!target) {
      if (intent === 'RETREAT' && anchorPos) {
        TaskSquad.stepToward(creep, anchorPos, 0);
      } else if (anchorPos) {
        TaskSquad.stepToward(creep, anchorPos, CFG.fallbackRange);
      }
      _fire(creep, null);
      return;
    }

    var targetPos = target.pos || target;
    var range = creep.pos.getRangeTo(targetPos);

    var towerDps = _towerDps(creep.pos);
    var hpPct = creep.hits / Math.max(1, creep.hitsMax);
    var hps = creep.getActiveBodyparts(HEAL) * 12;
    var info = {
      intent: intent,
      towerDps: towerDps,
      hpPct: hpPct,
      hps: hps,
      targetMoved: !(A.tX === targetPos.x && A.tY === targetPos.y && A.tR === targetPos.roomName),
      lowSelf: hpPct < 0.45,
    };
    A.tX = targetPos.x; A.tY = targetPos.y; A.tR = targetPos.roomName; A.lastSeen = Game.time;

    _fire(creep, target);
    _healWhileMoving(creep, info);

    if (_shouldRetreat(info)) {
      if (anchorPos) TaskSquad.stepToward(creep, anchorPos, CFG.kiteRange);
      else TaskSquad.stepToward(creep, targetPos, CFG.kiteRange);
      A.movedAt = Game.time;
      return;
    }

    if (_shouldHold(creep, targetPos, range, info)) {
      return;
    }

    if (range <= CFG.kiteTrigger) {
      TaskSquad.stepToward(creep, targetPos, CFG.kiteRange);
      A.movedAt = Game.time;
      return;
    }

    if (range > CFG.desiredRange + CFG.holdSlack) {
      TaskSquad.stepToward(creep, targetPos, CFG.desiredRange);
      A.movedAt = Game.time;
      return;
    }
  }
};

module.exports = TaskCombatArcher;
