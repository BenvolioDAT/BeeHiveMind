'use strict';

// -----------------------------------------------------------------------------
// Spawn.BodyConfig.js - registry of role body configuration modules
// Owns:
// * The ROLE_CONFIGS object imported by spawn.logic.js.
// * The mapping from canonical role names to each role.*.Body.Config.js file.
// Memory paths:
// * None. This file is pure configuration glue.
// Usually called by:
// * spawn.logic.js and SourceEnergy.Manager diagnostics.
// Systems that depend on it:
// * BeeSpawnManager queue energy gates and spawn.logic body selection.
// Do not casually change:
// * ROLE_CONFIGS keys. They must match canonical role names used by
//   BeeHiveMind, BeeSpawnManager, and spawn.logic.
// -----------------------------------------------------------------------------

var ROLE_CONFIGS = {
  // Keys in ROLE_CONFIGS must match canonical role names used in spawn.logic.js.
  // If you add a new role later, add its matching key + require entry here.
  Veinseeker: require('role.Veinseeker.Body.Config'),
  Builder: require('role.Builder.Body.Config'),
  Repair: require('role.Repair.Body.Config'),
  Upgrader: require('role.Upgrader.Body.Config'),
  Queen: require('role.Queen.Body.Config'),
  Scout: require('role.Scout.Body.Config'),
  CombatMelee: require('role.CombatMelee.Body.Config'),
  CombatArcher: require('role.CombatArcher.Body.Config'),
  CombatMedic: require('role.CombatMedic.Body.Config'),
  Dismantler: require('role.Dismantler.Body.Config'),
  Claimer: require('role.Claimer.Body.Config'),
  Trucker: require('role.Trucker.Body.Config')
};

module.exports = { ROLE_CONFIGS: ROLE_CONFIGS };
