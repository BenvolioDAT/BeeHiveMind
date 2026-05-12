'use strict';

var ROLE_NAMES = Object.freeze({
  BASE_HARVEST: 'BaseHarvest',
  BUILDER: 'Builder',
  COURIER: 'Courier',
  LUNA: 'Luna',
  QUEEN: 'Queen',
  REPAIR: 'Repair',
  SCOUT: 'Scout',
  UPGRADER: 'Upgrader'
});

var ROLE_ALIASES = Object.freeze({
  baseharvest: ROLE_NAMES.BASE_HARVEST,
  harvest: ROLE_NAMES.BASE_HARVEST,
  builder: ROLE_NAMES.BUILDER,
  courier: ROLE_NAMES.COURIER,
  luna: ROLE_NAMES.LUNA,
  queen: ROLE_NAMES.QUEEN,
  repair: ROLE_NAMES.REPAIR,
  scout: ROLE_NAMES.SCOUT,
  upgrader: ROLE_NAMES.UPGRADER
});

function normalizeRoleName(roleName) {
  if (!roleName || typeof roleName !== 'string') return roleName;
  var key = roleName.toLowerCase();
  return ROLE_ALIASES[key] || roleName;
}

module.exports = {
  ROLE_NAMES: ROLE_NAMES,
  normalizeRoleName: normalizeRoleName
};
