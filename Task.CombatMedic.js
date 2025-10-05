// Task.CombatMedic.js — calm triage discipline (ES5-only)
'use strict';

var TaskSquad = require('Task.Squad');
var ThreatAnalyzer = require('Combat.ThreatAnalyzer.es5');

var CFG = {
  followRange: 1,
  stickiness: 20,
  triageRange: 4,
  selfCritical: 0.45,
  fleeHp: 0.35,
  towerMarginPct: 1.05,
};

var FRONTLINE_ROLES = { CombatMelee: 1, Dismantler: 1, CombatArcher: 1 };

function _mem(creep) {
  creep.memory = creep.memory || {};
  if (!creep.memory.medic) creep.memory.medic = {};
  return creep.memory.medic;
}

function _hpPct(unit) {
  if (!unit || !unit.hitsMax) return 1;
  return unit.hits / Math.max(1, unit.hitsMax);
}

function _chooseBuddy(creep) {
  var sid = TaskSquad.getSquadId(creep);
  var best = null;
  var bestScore = 9999;
  for (var name in Game.creeps) {
    var c = Game.creeps[name];
    if (!c || !c.my || !c.memory) continue;
    if (TaskSquad.getSquadId(c) !== sid) continue;
    var role = c.memory.task || c.memory.role || '';
    if (!FRONTLINE_ROLES[role]) continue;
    if (c.id === creep.id) continue;
    var hpScore = _hpPct(c);
    if (hpScore < bestScore) {
      best = c;
      bestScore = hpScore;
    }
  }
  return best;
}

function _healTarget(creep, target) {
  if (!creep || !target) return false;
  if (target.hits >= target.hitsMax) return false;
  if (creep.pos.isNearTo(target)) {
    return creep.heal(target) === OK;
  }
  if (creep.pos.inRangeTo(target, 3)) {
    return creep.rangedHeal(target) === OK;
  }
  return false;
}

function _nearestHurt(creep, range, squadId) {
  var list = creep.pos.findInRange(FIND_MY_CREEPS, range || CFG.triageRange, {
    filter: function (ally) {
      if (!ally || !ally.my || !ally.memory) return false;
      if (squadId && TaskSquad.getSquadId(ally) !== squadId) return false;
      return ally.hits < ally.hitsMax;
    }
  });
  if (!list.length) return null;
  var best = list[0];
  var bestPct = _hpPct(best);
  for (var i = 1; i < list.length; i++) {
    var cand = list[i];
    var pct = _hpPct(cand);
    if (pct < bestPct) {
      best = cand;
      bestPct = pct;
    }
  }
  return best;
}

var TaskCombatMedic = {
  run: function (creep) {
    if (!creep || creep.spawning) return;
    var M = _mem(creep);

    if (TaskSquad.shouldRecycle(creep)) {
      if (TaskSquad.recycle(creep)) return;
    }

    var intent = TaskSquad.getIntent(creep);
    var squadId = TaskSquad.getSquadId(creep);
    var buddy = Game.getObjectById(M.buddyId);
    if (!buddy || !buddy.my || buddy.hits <= 0 || (M.buddyAt && Game.time - M.buddyAt > CFG.stickiness)) {
      buddy = _chooseBuddy(creep);
      if (buddy) {
        M.buddyId = buddy.id;
        M.buddyAt = Game.time;
      } else {
        delete M.buddyId;
      }
    }

    var anchor = TaskSquad.getAnchor(creep);
    var towerDps = ThreatAnalyzer.estimateTowerDps(creep.pos.roomName, creep.pos);
    var towerHps = creep.getActiveBodyparts(HEAL) * 12;
    var hpPct = _hpPct(creep);

    // Heal priority: self critical → buddy → nearest ally → self top-off
    if (hpPct < CFG.selfCritical) {
      if (_healTarget(creep, creep)) return;
    }

    if (buddy && buddy.hits < buddy.hitsMax && _healTarget(creep, buddy)) {
      // heal executed
    } else {
      var other = _nearestHurt(creep, CFG.triageRange, squadId);
      if (other && other.id !== creep.id && (!buddy || other.id !== buddy.id)) {
        if (_healTarget(creep, other)) {
          // done
        }
      }
    }

    if (hpPct < CFG.selfCritical && creep.hits < creep.hitsMax) {
      creep.heal(creep);
    }

    var shouldRetreat = false;
    if (intent === 'RETREAT') shouldRetreat = true;
    if (towerDps > towerHps * CFG.towerMarginPct) shouldRetreat = true;
    if (hpPct < CFG.fleeHp) shouldRetreat = true;

    if (shouldRetreat && anchor) {
      TaskSquad.stepToward(creep, anchor, 0);
      return;
    }

    if (buddy) {
      if (!creep.pos.inRangeTo(buddy, CFG.followRange)) {
        TaskSquad.stepToward(creep, buddy.pos, CFG.followRange);
        return;
      }
      if (intent === 'BREACH' || intent === 'ASSAULT') {
        // stay tucked but do not enter melee range if not necessary
        if (creep.pos.getRangeTo(buddy) < CFG.followRange && anchor) {
          TaskSquad.stepToward(creep, anchor, CFG.followRange + 1);
        }
      }
    } else if (anchor) {
      TaskSquad.stepToward(creep, anchor, 1);
    }
  }
};

module.exports = TaskCombatMedic;
