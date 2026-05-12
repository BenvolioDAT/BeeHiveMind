'use strict';
// Spawn.Constants.js
// Owns: shared spawn constants (priorities, bands, floors, energy mins, tunables).
// Must not own: queue mutation, counting, quota math, or spawn execution.
// Called by: BeeSpawnManager and spawn-related helper modules.

var ROLE_PRIORITY = {
  BaseHarvest: 100, Courier: 95, Queen: 90, Upgrader: 80, Builder: 75, Luna: 70,
  Repair: 60, Claimer: 55, Scout: 40, Trucker: 35, Dismantler: 30,
  CombatArcher: 25, CombatMelee: 25, CombatMedic: 25
};
var ROLE_MIN_ENERGY = { BaseHarvest:200, Courier:150, Queen:200, Upgrader:200, Builder:200, Luna:250, Repair:200, Claimer:650, Scout:50, Trucker:200, Dismantler:150, CombatArcher:200, CombatMelee:200, CombatMedic:200 };
var ROLE_BAND = { BaseHarvest:'SURVIVAL', Courier:'SURVIVAL', Queen:'SURVIVAL', Upgrader:'ECONOMY', Luna:'ECONOMY', Builder:'GROWTH', Repair:'SUPPORT', Scout:'SUPPORT', Trucker:'SITUATIONAL', Claimer:'SITUATIONAL', Dismantler:'SITUATIONAL', CombatArcher:'COMBAT', CombatMelee:'COMBAT', CombatMedic:'COMBAT' };
var PROTECTED_ROLE_FLOORS = { BaseHarvest:1, Courier:1, Queen:1 };
var FLOOR_ROLE_SET = { BaseHarvest:true, Courier:true, Queen:true };
var BAND_PRIORITY_BONUS = { SURVIVAL:10, ECONOMY:6, GROWTH:3, SUPPORT:1, SITUATIONAL:0, COMBAT:0 };
module.exports = { ROLE_PRIORITY:ROLE_PRIORITY, ROLE_MIN_ENERGY:ROLE_MIN_ENERGY, ROLE_BAND:ROLE_BAND, PROTECTED_ROLE_FLOORS:PROTECTED_ROLE_FLOORS, FLOOR_ROLE_SET:FLOOR_ROLE_SET, BAND_PRIORITY_BONUS:BAND_PRIORITY_BONUS };
