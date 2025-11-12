'use strict';

var Traveler = require('Traveler');
var CombatAPI = require('Combat.API');
var BeeCombatSquads = require('BeeCombatSquads');

var roleCombatArcher = {
  run: function (creep) {
    if (!creep) return;
    var ctx = BeeCombatSquads.resolveCreep(creep);
    if (!ctx || !ctx.flagName) return;
    var info = ctx.info || {};

    var targetId = CombatAPI.focusFireTarget(ctx.flagName);
    var target = targetId ? Game.getObjectById(targetId) : null;
    if (target) {
      if (creep.pos.inRangeTo(target, 3)) {
        creep.rangedAttack(target);
      } else {
        Traveler.travelTo(creep, target, { range: 3, ignoreCreeps: false });
      }
      return;
    }

    var leader = info.leader && info.leader.id !== creep.id ? info.leader : null;
    if (leader) {
      Traveler.travelTo(creep, leader, { range: 1, ignoreCreeps: false });
      return;
    }

    if (info.rallyPos) {
      Traveler.travelTo(creep, info.rallyPos, { range: 1, ignoreCreeps: false });
    }
  }
};

module.exports = roleCombatArcher;
