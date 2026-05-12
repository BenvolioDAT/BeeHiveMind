'use strict';
// Spawn.Roles.js
// Owns: role canonicalization, aliases, band lookup, and priority lookup.
// Does not own: spawn queue mutation, room state, or spawn execution.
// Called by: BeeSpawnManager.

var SpawnConstants = require('Spawn.Constants');

var ROLE_PRIORITY = SpawnConstants.ROLE_PRIORITY;
var ROLE_BAND = SpawnConstants.ROLE_BAND;
var BAND_PRIORITY_BONUS = SpawnConstants.BAND_PRIORITY_BONUS;

var ROLE_ALIAS_MAP = (function () {
  var map = Object.create(null);
  var canonicalRoleNames = [
    'BaseHarvest',
    'Builder',
    'Courier',
    'Repair',
    'Upgrader',
    'Dismantler',
    'Luna',
    'Scout',
    'Queen',
    'Trucker',
    'Claimer',
    'CombatArcher',
    'CombatMedic',
    'CombatMelee'
  ];
  for (var i = 0; i < canonicalRoleNames.length; i++) {
    var name = canonicalRoleNames[i];
    map[name] = name;
    map[name.toLowerCase()] = name;
  }
  map.remoteharvest = 'Luna';
  return map;
})();

function canonicalRole(role) {
  if (!role) return null;
  var key = String(role);
  if (ROLE_ALIAS_MAP[key]) return ROLE_ALIAS_MAP[key];
  var lower = key.toLowerCase();
  if (ROLE_ALIAS_MAP[lower]) return ROLE_ALIAS_MAP[lower];
  var fallback = key.charAt(0).toUpperCase() + key.slice(1);
  if (ROLE_ALIAS_MAP[fallback]) return ROLE_ALIAS_MAP[fallback];
  return key;
}

function roleBand(role) {
  var canonical = canonicalRole(role);
  return ROLE_BAND[canonical] || 'SITUATIONAL';
}

function rolePriority(role) {
  var canonical = canonicalRole(role);
  var base = ROLE_PRIORITY[canonical] || 0;
  var band = roleBand(canonical);
  return base + (BAND_PRIORITY_BONUS[band] || 0);
}

module.exports = { canonicalRole: canonicalRole, roleBand: roleBand, rolePriority: rolePriority, ROLE_ALIAS_MAP: ROLE_ALIAS_MAP };
