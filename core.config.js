'use strict';

var LOG_LEVEL = Object.freeze({
  NONE: 0,
  BASIC: 1,
  DEBUG: 2
});

var settings = module.exports.settings || (module.exports.settings = {});

settings.logging = settings.logging || Object.freeze({
  /** Default log level applied on boot. */
  defaultLevel: LOG_LEVEL.NONE
});

settings.pixels = settings.pixels || Object.freeze({
  /** Toggle CPU bucket based pixel generation. */
  enabled: false,
  /** Minimum bucket value before attempting pixel generation. */
  bucketThreshold: 9900,
  /** Optional modulus so pixels are generated every N ticks. */
  tickModulo: 5
});

settings.maintenance = settings.maintenance || Object.freeze({
  /** How often to rescan repair targets inside BeeMaintenance. */
  repairScanInterval: 5,
  /** How long before the stale room sweep runs. */
  roomSweepInterval: 50
});

var beeHiveSettings = settings['BeeHiveMind'] || (settings['BeeHiveMind'] = {});
if (!beeHiveSettings.ROAD_GATE_DEFAULTS) {
  beeHiveSettings.ROAD_GATE_DEFAULTS = { minRCL: 3, disableGate: false };
}
// @used_in:
//   BeeHiveMind.js:61
//   BeeHiveMind.js:74
//   BeeHiveMind.js:88
if (!beeHiveSettings.ECON_DEFAULTS) {
  beeHiveSettings.ECON_DEFAULTS = {
    STORAGE_ENERGY_MIN_BEFORE_REMOTES: 80000,
    MAX_ACTIVE_REMOTES: 2,
    ROAD_REPAIR_THRESHOLD: 0.45,
    STORAGE_HEALTHY_RATIO: 0.7,
    CPU_MIN_BUCKET: 500,
    roads: beeHiveSettings.ROAD_GATE_DEFAULTS,
    remoteRoads: { minStorageEnergy: 40000 },
    queen: { allowCourierFallback: true }
  };
}
// @used_in:
//   BeeHiveMind.js:62
//   BeeHiveMind.js:68
//   BeeHiveMind.js:93
//   BeeHiveMind.js:100
//   BeeHiveMind.js:106
if (!beeHiveSettings.HARVESTER_DEFAULTS) {
  beeHiveSettings.HARVESTER_DEFAULTS = { MAX_WORK: 6, RENEWAL_TTL: 150, EMERGENCY_TTL: 50 };
}
// @used_in:
//   BeeHiveMind.js:63
//   BeeHiveMind.js:836
if (typeof beeHiveSettings.DYING_SOON_TTL !== 'number') {
  beeHiveSettings.DYING_SOON_TTL = 60;
}
// @used_in:
//   BeeHiveMind.js:866
//   BeeHiveMind.js:1179

var truckerSettings = settings['Task.Trucker'] || (settings['Task.Trucker'] = {});
if (typeof truckerSettings.PICKUP_FLAG_DEFAULT !== 'string') {
  truckerSettings.PICKUP_FLAG_DEFAULT = 'E-Pickup';
}
// @used_in:
//   Task.Trucker.js:22
//   Task.Trucker.js:129
if (typeof truckerSettings.MIN_DROPPED !== 'number') {
  truckerSettings.MIN_DROPPED = 50;
}
// @used_in:
//   Task.Trucker.js:23
//   Task.Trucker.js:94
//   Task.Trucker.js:113
//   Task.Trucker.js:176
if (typeof truckerSettings.LOCAL_SEARCH_RADIUS !== 'number') {
  truckerSettings.LOCAL_SEARCH_RADIUS = 12;
}
// @used_in:
//   Task.Trucker.js:24
//   Task.Trucker.js:174
if (typeof truckerSettings.WIDE_SEARCH_RADIUS !== 'number') {
  truckerSettings.WIDE_SEARCH_RADIUS = 50;
}
// @used_in:
//   Task.Trucker.js:25
//   Task.Trucker.js:92
if (typeof truckerSettings.WIDE_SEARCH_COOLDOWN !== 'number') {
  truckerSettings.WIDE_SEARCH_COOLDOWN = 25;
}
// @used_in:
//   Task.Trucker.js:26
//   Task.Trucker.js:91

var queenSettings = settings['Task.Queen'] || (settings['Task.Queen'] = {});
if (typeof queenSettings.ENABLE_COURIER_FALLBACK !== 'boolean') {
  queenSettings.ENABLE_COURIER_FALLBACK = true;
}
// @used_in:
//   Task.Queen.js:22
//   Task.Queen.js:549
if (typeof queenSettings.DEFAULT_TRAVEL_RANGE !== 'number') {
  queenSettings.DEFAULT_TRAVEL_RANGE = 1;
}
// @used_in:
//   Task.Queen.js:31
//   Task.Queen.js:91
if (typeof queenSettings.DEFAULT_TRAVEL_REUSE !== 'number') {
  queenSettings.DEFAULT_TRAVEL_REUSE = 15;
}
// @used_in:
//   Task.Queen.js:32
//   Task.Queen.js:92
if (typeof queenSettings.DEFAULT_TRAVEL_STUCK !== 'number') {
  queenSettings.DEFAULT_TRAVEL_STUCK = 2;
}
// @used_in:
//   Task.Queen.js:33
//   Task.Queen.js:94
if (typeof queenSettings.DEFAULT_TRAVEL_REPATH !== 'number') {
  queenSettings.DEFAULT_TRAVEL_REPATH = 0.1;
}
// @used_in:
//   Task.Queen.js:34
//   Task.Queen.js:95
if (typeof queenSettings.DEFAULT_TRAVEL_MAX_OPS !== 'number') {
  queenSettings.DEFAULT_TRAVEL_MAX_OPS = 4000;
}
// @used_in:
//   Task.Queen.js:35
//   Task.Queen.js:96
if (typeof queenSettings.DEFAULT_TOWER_REFILL_THRESHOLD !== 'number') {
  queenSettings.DEFAULT_TOWER_REFILL_THRESHOLD = 0.7;
}
// @used_in:
//   Task.Queen.js:36
//   Task.Queen.js:193

var upgraderSettings = settings['Task.Upgrader'] || (settings['Task.Upgrader'] = {});
if (typeof upgraderSettings.UPGRADER_SIGN_TEXT !== 'string') {
  upgraderSettings.UPGRADER_SIGN_TEXT = 'BeeNice Please.';
}
// @used_in:
//   Task.Upgrader.js:71
//   Task.Upgrader.js:189
//   Task.Upgrader.js:191
if (typeof upgraderSettings.UPGRADER_REFILL_DELAY !== 'number') {
  upgraderSettings.UPGRADER_REFILL_DELAY = 5;
}
// @used_in:
//   Task.Upgrader.js:72
//   Task.Upgrader.js:253
if (typeof upgraderSettings.MIN_PICKUP_AMOUNT !== 'number') {
  upgraderSettings.MIN_PICKUP_AMOUNT = 50;
}
// @used_in:
//   Task.Upgrader.js:73
//   Task.Upgrader.js:149
if (typeof upgraderSettings.MAX_CONTAINER_RANGE !== 'number') {
  upgraderSettings.MAX_CONTAINER_RANGE = 5;
}
// @used_in:
//   Task.Upgrader.js:74
//   Task.Upgrader.js:135
if (typeof upgraderSettings.MAX_LINK_RANGE !== 'number') {
  upgraderSettings.MAX_LINK_RANGE = 3;
}
// @used_in:
//   Task.Upgrader.js:75
//   Task.Upgrader.js:138
if (typeof upgraderSettings.MAX_UPGRADE_RANGE !== 'number') {
  upgraderSettings.MAX_UPGRADE_RANGE = 3;
}
// @used_in:
//   Task.Upgrader.js:76
//   Task.Upgrader.js:231
//   Task.Upgrader.js:244

var squadSettings = settings['Task.Squad'] || (settings['Task.Squad'] = {});
// @used_in:
//   Task.CombatMelee.js:54
//   Task.CombatArcher.js:43
//   Task.Dismantler.js:40
//   Task.Scout.js:92
//   BeeHiveMind.js:765
//   tower.logic.js:16
squadSettings.FRIENDLY_USERNAMES = [
  'haha233jpg',
  'Court_of_Silver',
  'xianda1314',
  'Lumen',
  'ControlNet',
  'xel',
  'bg8kiw',
  'Kazkel'
];

module.exports.LOG_LEVEL = LOG_LEVEL;
module.exports.settings = settings;
