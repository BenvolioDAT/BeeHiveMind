'use strict';

var ROLE_CONFIGS = {
  BaseHarvest: require('role.BaseHarvest.Body.Config'),
  Courier: require('role.Courier.Body.Config'),
  Builder: require('role.Builder.Body.Config'),
  Repair: require('role.Repair.Body.Config'),
  Upgrader: require('role.Upgrader.Body.Config'),
  Queen: require('role.Queen.Body.Config'),
  Luna: require('role.Luna.Body.Config'),
  Scout: require('role.Scout.Body.Config'),
  CombatMelee: require('role.CombatMelee.Body.Config'),
  CombatArcher: require('role.CombatArcher.Body.Config'),
  CombatMedic: require('role.CombatMedic.Body.Config'),
  Dismantler: require('role.Dismantler.Body.Config'),
  Claimer: require('role.Claimer.Body.Config')
};

module.exports = { ROLE_CONFIGS: ROLE_CONFIGS };
