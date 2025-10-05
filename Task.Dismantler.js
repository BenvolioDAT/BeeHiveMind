// Task.Dismantler.js — rampart breacher (ES5-only)
'use strict';

var TaskSquad = require('Task.Squad');
var ThreatAnalyzer = require('Combat.ThreatAnalyzer.es5');

var CFG = {
  towerMarginPct: 1.1,
  safeRange: 3,
};

function _collectSquad(creep) {
  var sid = TaskSquad.getSquadId(creep);
  var list = [];
  for (var name in Game.creeps) {
    var c = Game.creeps[name];
    if (!c || !c.my || !c.memory) continue;
    if (TaskSquad.getSquadId(c) !== sid) continue;
    list.push(c);
  }
  return list;
}

function _chooseStructure(creep) {
  var structures = creep.room.find(FIND_HOSTILE_STRUCTURES);
  if (!structures || !structures.length) return null;
  var best = null;
  var bestScore = -Infinity;
  for (var i = 0; i < structures.length; i++) {
    var s = structures[i];
    var score = 0;
    if (s.structureType === STRUCTURE_TOWER) score += 500;
    else if (s.structureType === STRUCTURE_SPAWN) score += 200;
    else if (s.structureType === STRUCTURE_RAMPART) score += 150;
    else if (s.structureType === STRUCTURE_WALL) score += 120;
    else if (s.structureType === STRUCTURE_STORAGE || s.structureType === STRUCTURE_TERMINAL) score += 80;
    else score += 30;
    var range = creep.pos.getRangeTo(s);
    score -= range;
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

var TaskDismantler = {
  run: function (creep) {
    if (!creep || creep.spawning) return;

    if (TaskSquad.shouldRecycle(creep)) {
      if (TaskSquad.recycle(creep)) return;
    }

    if (creep.memory.delay && Game.time < creep.memory.delay) return;

    var squad = _collectSquad(creep);
    var towerDps = ThreatAnalyzer.projectedTowerPressure(creep.pos.roomName, squad);
    var hps = ThreatAnalyzer.totalSquadHps(squad);
    var marginOk = hps * CFG.towerMarginPct >= towerDps;
    var intent = TaskSquad.getIntent(creep);
    var anchor = TaskSquad.getAnchor(creep);

    if (!marginOk && intent !== 'BREACH') {
      if (anchor) TaskSquad.stepToward(creep, anchor, CFG.safeRange);
      return;
    }

    var target = TaskSquad.sharedTarget(creep);
    if (!target) target = _chooseStructure(creep);

    if (!target) {
      if (anchor) TaskSquad.stepToward(creep, anchor, 1);
      return;
    }

    if (target.structureType === STRUCTURE_INVADER_CORE) {
      if (creep.pos.inRangeTo(target, 1)) {
        creep.attack(target);
      } else {
        TaskSquad.stepToward(creep, target.pos, 1);
      }
      return;
    }

    if (creep.pos.isNearTo(target)) {
      var rc = creep.dismantle(target);
      if (rc === ERR_INVALID_TARGET) {
        creep.attack(target);
      }
      if (target.hits && target.hits <= 1000) delete creep.memory.tid;
      return;
    }

    TaskSquad.stepToward(creep, target.pos || target, 1);
  }
};

module.exports = TaskDismantler;
