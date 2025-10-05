// Task.CombatMelee.js — disciplined vanguard micro (ES5-only)
'use strict';

var TaskSquad = require('Task.Squad');
var ThreatAnalyzer = require('Combat.ThreatAnalyzer.es5');

var CFG = {
  fleeHp: 0.35,
  anchorRange: 1,
  guardRange: 1,
  towerMarginPct: 1.05,
  bashDoors: true,
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

function _healSelf(creep) {
  if (!creep) return;
  if (creep.getActiveBodyparts(HEAL) <= 0) return;
  if (creep.hits < creep.hitsMax) {
    creep.heal(creep);
    return;
  }
  var sid = TaskSquad.getSquadId(creep);
  var allies = creep.pos.findInRange(FIND_MY_CREEPS, 1, {
    filter: function (ally) {
      if (!ally || !ally.my || !ally.memory) return false;
      if (TaskSquad.getSquadId(ally) !== sid) return false;
      return ally.hits < ally.hitsMax;
    }
  });
  if (allies.length) creep.heal(allies[0]);
}

function _adjacentHostile(creep) {
  var list = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 1, {
    filter: function (h) { return h.hits > 0; }
  });
  return list.length ? list[0] : null;
}

function _doorBlock(creep, target) {
  if (!target || !target.pos) return null;
  var path = creep.pos.findPathTo(target, { ignoreCreeps: true, maxOps: 50, ignoreDestructibleStructures: false });
  if (!path || !path.length) return null;
  var step = path[0];
  var pos = new RoomPosition(step.x, step.y, creep.room.name);
  var wall = pos.lookFor(LOOK_STRUCTURES);
  for (var i = 0; i < wall.length; i++) {
    var st = wall[i];
    if (st.structureType === STRUCTURE_WALL || st.structureType === STRUCTURE_RAMPART) {
      if (!st.my) return st;
    }
  }
  return null;
}

var TaskCombatMelee = {
  run: function (creep) {
    if (!creep || creep.spawning) return;

    if (TaskSquad.shouldRecycle(creep)) {
      if (TaskSquad.recycle(creep)) return;
    }

    _healSelf(creep);

    var intent = TaskSquad.getIntent(creep);
    var anchor = TaskSquad.getAnchor(creep);
    var squad = _collectSquad(creep);
    var towerDps = ThreatAnalyzer.projectedTowerPressure(creep.pos.roomName, squad);
    var hps = ThreatAnalyzer.totalSquadHps(squad);
    var marginOk = hps * CFG.towerMarginPct >= towerDps;

    if (intent === 'RETREAT' || (creep.hits / Math.max(1, creep.hitsMax)) < CFG.fleeHp || !marginOk) {
      if (anchor) TaskSquad.stepToward(creep, anchor, CFG.anchorRange);
      return;
    }

    var target = TaskSquad.sharedTarget(creep);
    if (!target) {
      if (anchor) TaskSquad.stepToward(creep, anchor, CFG.anchorRange);
      return;
    }

    if (creep.pos.isNearTo(target)) {
      creep.attack(target);
      return;
    }

    if (CFG.bashDoors) {
      var door = _doorBlock(creep, target);
      if (door && creep.pos.isNearTo(door)) {
        creep.attack(door);
        return;
      }
    }

    TaskSquad.stepToward(creep, target.pos || target, 1);

    var adjacent = _adjacentHostile(creep);
    if (adjacent) creep.attack(adjacent);
  }
};

module.exports = TaskCombatMelee;
