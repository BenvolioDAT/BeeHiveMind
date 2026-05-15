'use strict';

// This file is the body config registry used by spawn.logic.js.
// spawn.logic.js imports this one file instead of importing every role file directly.
// Each role.*.Body.Config.js exports the body choices for one role.
// Keeping the registry here keeps spawn logic cleaner and body tuning centralized.

var ROLE_CONFIGS = {
  // Keys in ROLE_CONFIGS must match canonical role names used in spawn.logic.js.
  // If you add a new role later, add its matching key + require entry here.
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
  Claimer: require('role.Claimer.Body.Config'),
  Trucker: require('role.Trucker.Body.Config')
};

module.exports = { ROLE_CONFIGS: ROLE_CONFIGS };
