'use strict';

// Central role catalog. Keep role names here in sync with public role.* modules,
// spawn body configs, and Memory role strings.
var ROLE = Object.freeze({
  IDLE: 'Idle',
  VEINSEEKER: 'Veinseeker',
  BUILDER: 'Builder',
  REPAIR: 'Repair',
  UPGRADER: 'Upgrader',
  DISMANTLER: 'Dismantler',
  SCOUT: 'Scout',
  QUEEN: 'Queen',
  TRUCKER: 'Trucker',
  CLAIMER: 'Claimer',
  COMBAT_ARCHER: 'CombatArcher',
  COMBAT_MEDIC: 'CombatMedic',
  COMBAT_MELEE: 'CombatMelee'
});

var RUNNABLE_ROLES = Object.freeze([
  ROLE.IDLE,
  ROLE.VEINSEEKER,
  ROLE.BUILDER,
  ROLE.REPAIR,
  ROLE.UPGRADER,
  ROLE.DISMANTLER,
  ROLE.SCOUT,
  ROLE.QUEEN,
  ROLE.TRUCKER,
  ROLE.CLAIMER,
  ROLE.COMBAT_ARCHER,
  ROLE.COMBAT_MEDIC,
  ROLE.COMBAT_MELEE
]);

var SPAWNABLE_ROLES = Object.freeze([
  ROLE.VEINSEEKER,
  ROLE.BUILDER,
  ROLE.REPAIR,
  ROLE.UPGRADER,
  ROLE.QUEEN,
  ROLE.SCOUT,
  ROLE.COMBAT_MELEE,
  ROLE.COMBAT_ARCHER,
  ROLE.COMBAT_MEDIC,
  ROLE.DISMANTLER,
  ROLE.CLAIMER,
  ROLE.TRUCKER
]);

var ROLE_TASKS = Object.freeze({
  Veinseeker: 'veinseeker',
  Builder: 'builder',
  Repair: 'repair',
  Upgrader: 'upgrader',
  Dismantler: 'dismantler',
  Scout: 'scout',
  Queen: 'queen',
  Trucker: 'haulUnified',
  Claimer: 'claimer',
  CombatArcher: 'combat',
  CombatMedic: 'combat',
  CombatMelee: 'combat',
  Idle: 'idle'
});

var LEGACY_ALIASES = Object.freeze({
  worker_bee: ROLE.IDLE,
  Worker_Bee: ROLE.IDLE,
  worker: ROLE.VEINSEEKER,
  harvester: ROLE.VEINSEEKER,
  sourceworker: ROLE.VEINSEEKER,
  baseharvest: ROLE.VEINSEEKER,
  luna: ROLE.VEINSEEKER,
  remoteharvest: ROLE.VEINSEEKER,
  courier: ROLE.TRUCKER
});

function hasOwn(obj, key) {
  return obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function addAlias(map, key, role) {
  if (!key || !role) return;
  map[key] = role;
  map[String(key).toLowerCase()] = role;
}

function createAliasMap(extraAliases) {
  var map = Object.create(null);
  for (var i = 0; i < RUNNABLE_ROLES.length; i++) {
    addAlias(map, RUNNABLE_ROLES[i], RUNNABLE_ROLES[i]);
  }

  for (var alias in LEGACY_ALIASES) {
    if (hasOwn(LEGACY_ALIASES, alias)) addAlias(map, alias, LEGACY_ALIASES[alias]);
  }
  if (extraAliases) {
    for (var extra in extraAliases) {
      if (hasOwn(extraAliases, extra)) addAlias(map, extra, extraAliases[extra]);
    }
  }
  return map;
}

var DEFAULT_ALIAS_MAP = createAliasMap();

function canonicalRoleName(value, opts) {
  if (value === undefined || value === null) return null;
  opts = opts || {};

  var key = String(value);
  if (!key) return null;

  var map = opts.aliasMap || DEFAULT_ALIAS_MAP;
  if (hasOwn(map, key)) return map[key];

  var lower = key.toLowerCase();
  if (hasOwn(map, lower)) return map[lower];

  if (opts.capitalizedFallback) {
    var fallback = key.charAt(0).toUpperCase() + key.slice(1);
    if (hasOwn(map, fallback)) return map[fallback];
  }

  return opts.allowUnknown ? key : null;
}

function isSpawnableRole(roleName) {
  var canonical = canonicalRoleName(roleName);
  if (!canonical || canonical === ROLE.IDLE) return false;
  for (var i = 0; i < SPAWNABLE_ROLES.length; i++) {
    if (SPAWNABLE_ROLES[i] === canonical) return true;
  }
  return false;
}

function canonicalSpawnRole(roleName) {
  var canonical = canonicalRoleName(roleName);
  return isSpawnableRole(canonical) ? canonical : null;
}

function taskForRole(roleName) {
  var canonical = canonicalRoleName(roleName, {
    allowUnknown: true,
    capitalizedFallback: true
  });
  if (hasOwn(ROLE_TASKS, canonical)) return ROLE_TASKS[canonical];
  return String(roleName || '').toLowerCase();
}

function createRunnerMap(roleModules) {
  var runners = {};
  if (!roleModules) return runners;
  for (var i = 0; i < RUNNABLE_ROLES.length; i++) {
    var roleName = RUNNABLE_ROLES[i];
    if (roleName === ROLE.IDLE) continue;
    var mod = roleModules[roleName];
    if (mod && typeof mod.run === 'function') runners[roleName] = mod.run;
  }
  return runners;
}

module.exports = {
  ROLE: ROLE,
  RUNNABLE_ROLES: RUNNABLE_ROLES,
  SPAWNABLE_ROLES: SPAWNABLE_ROLES,
  ROLE_TASKS: ROLE_TASKS,
  createAliasMap: createAliasMap,
  canonicalRoleName: canonicalRoleName,
  canonicalRole: canonicalRoleName,
  canonicalSpawnRole: canonicalSpawnRole,
  isSpawnableRole: isSpawnableRole,
  taskForRole: taskForRole,
  createRunnerMap: createRunnerMap
};
