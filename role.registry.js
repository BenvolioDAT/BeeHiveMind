'use strict';

var Roles = require('core.roles');

var roleModules = {
  Veinseeker: require('role.Veinseeker'),
  Builder: require('role.Builder'),
  Repair: require('role.Repair'),
  Upgrader: require('role.Upgrader'),
  Dismantler: require('role.Dismantler'),
  Scout: require('role.Scout'),
  Queen: require('role.Queen'),
  Trucker: require('role.Trucker'),
  Claimer: require('role.Claimer'),
  CombatArcher: require('role.CombatArcher'),
  CombatMedic: require('role.CombatMedic'),
  CombatMelee: require('role.CombatMelee')
};

module.exports = {
  modules: roleModules,
  runners: Roles.createRunnerMap(roleModules)
};
