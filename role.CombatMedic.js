'use strict';

var Traveler = require('Traveler');
var BeeCombatSquads = require('BeeCombatSquads');
var BeeSelectors = require('BeeSelectors');

function _nearestWounded(creep, ids) {
  if (!ids || !ids.length) return null;
  var wounded = [];
  for (var i = 0; i < ids.length; i++) {
    var ally = Game.getObjectById(ids[i]);
    if (!ally || ally.id === creep.id) continue;
    if (ally.hits < ally.hitsMax) wounded.push(ally);
  }
  if (!wounded.length) return null;
  return BeeSelectors.findClosestByRange(creep.pos, wounded);
}

var roleCombatMedic = {
  run: function (creep) {
    if (!creep) return;
    var ctx = BeeCombatSquads.resolveCreep(creep);
    if (!ctx || !ctx.flagName) return;
    var info = ctx.info || {};

    var leader = info.leader && info.leader.id !== creep.id ? info.leader : null;
    var buddy = info.buddy && info.buddy.id !== creep.id ? info.buddy : null;
    var healTarget = null;

    if (creep.hits < creep.hitsMax) healTarget = creep;
    else if (leader && leader.hits < leader.hitsMax) healTarget = leader;
    else if (buddy && buddy.hits < buddy.hitsMax) healTarget = buddy;
    else healTarget = _nearestWounded(creep, info.creepIds || []);

    if (healTarget) {
      if (healTarget.id === creep.id) {
        creep.heal(creep);
      } else if (creep.pos.inRangeTo(healTarget, 1)) {
        creep.heal(healTarget);
      } else if (creep.pos.inRangeTo(healTarget, 3)) {
        creep.rangedHeal(healTarget);
      }
    }

    var moveTarget = null;
    if (leader) {
      if (creep.pos.getRangeTo(leader) > 2) moveTarget = leader;
    }
    if (!moveTarget && healTarget && healTarget.id !== creep.id && !creep.pos.inRangeTo(healTarget, 1)) {
      moveTarget = healTarget;
    }
    if (!moveTarget && buddy) {
      if (creep.pos.getRangeTo(buddy) > 2) moveTarget = buddy;
    }
    if (!moveTarget && info.rallyPos) moveTarget = info.rallyPos;

    if (moveTarget) {
      Traveler.travelTo(creep, moveTarget, { range: 1, ignoreCreeps: false });
    }
  }
};

module.exports = roleCombatMedic;
