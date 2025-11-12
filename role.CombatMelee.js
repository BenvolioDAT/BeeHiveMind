'use strict';

var Traveler = require('Traveler');
var CombatAPI = require('Combat.API');
var BeeCombatSquads = require('BeeCombatSquads');

var roleCombatMelee = {
  run: function (creep) {
    if (!creep) return;
    var ctx = BeeCombatSquads.resolveCreep(creep);
    if (!ctx || !ctx.flagName) return;
    var info = ctx.info || {};

    var targetId = CombatAPI.focusFireTarget(ctx.flagName);
    var target = targetId ? Game.getObjectById(targetId) : null;
    if (target) {
      if (creep.pos.inRangeTo(target, 1)) {
        if (creep.getActiveBodyparts(ATTACK) > 0) creep.attack(target);
        if (creep.getActiveBodyparts(RANGED_ATTACK) > 0) creep.rangedAttack(target);
      } else {
        Traveler.travelTo(creep, target, { range: 1, ignoreCreeps: false });
      }
    } else if (info.rallyPos) {
      Traveler.travelTo(creep, info.rallyPos, { range: 1, ignoreCreeps: false });
    }

    if (creep.hits < creep.hitsMax && creep.getActiveBodyparts(HEAL) > 0) {
      creep.heal(creep);
    }
  }
};

module.exports = roleCombatMelee;
