var LOG_LEVEL = Object.freeze({
  NONE: 0,
  BASIC: 1,
  DEBUG: 2
});

var settings = module.exports.settings || (module.exports.settings = {});

if (!settings.Spawn) {
  settings.Spawn = {
    USE_CENTRAL: true,
    LOG_PARITY_CHECKS: true,
    NAME_PREFIX: 'Bee',
    ROLE_OVERRIDES: {
      baseharvest: false,
      courier: false,
      queen: false,
      builder: false,
      upgrader: false,
      repair: false,
      scout: true,
      trucker: false,
      claimer: false,
      dismantler: false,
      CombatMelee: false,
      CombatArcher: false,
      CombatMedic: false,
      'luna.remoteMiner': false,
      'luna.remoteHauler': false,
      'luna.reserver': false
    }
  };
} else {
  if (typeof settings.Spawn.USE_CENTRAL !== 'boolean') {
    settings.Spawn.USE_CENTRAL = true;
  }
  if (typeof settings.Spawn.LOG_PARITY_CHECKS !== 'boolean') {
    settings.Spawn.LOG_PARITY_CHECKS = true;
  }
  if (typeof settings.Spawn.NAME_PREFIX !== 'string') {
    settings.Spawn.NAME_PREFIX = 'Bee';
  }
  if (!settings.Spawn.ROLE_OVERRIDES || typeof settings.Spawn.ROLE_OVERRIDES !== 'object') {
    settings.Spawn.ROLE_OVERRIDES = {};
  }
  var spawnRoleDefaults = {
    baseharvest: false,
    courier: false,
    queen: false,
    builder: false,
    upgrader: false,
    repair: false,
    scout: true,
    trucker: false,
    claimer: false,
    dismantler: false,
    CombatMelee: false,
    CombatArcher: false,
    CombatMedic: false,
    'luna.remoteMiner': false,
    'luna.remoteHauler': false,
    'luna.reserver': false
  };
  for (var roleKey in spawnRoleDefaults) {
    if (!Object.prototype.hasOwnProperty.call(spawnRoleDefaults, roleKey)) continue;
    if (typeof settings.Spawn.ROLE_OVERRIDES[roleKey] !== 'boolean') {
      settings.Spawn.ROLE_OVERRIDES[roleKey] = spawnRoleDefaults[roleKey];
    }
  }
}

settings.logging = settings.logging || Object.freeze({
  /** Default log level applied on boot. */
  defaultLevel: LOG_LEVEL.NONE
});

var workerSettings = settings['Worker'] || (settings['Worker'] = {});
// @used_in: core.spawn.js (task counts & queue)
if (!workerSettings.DEFAULT_ROLE_REQUIREMENTS) {
  workerSettings.DEFAULT_ROLE_REQUIREMENTS = {
    baseharvest: 2,
    builder: 2,
    repair: 1,
    courier: 2,
    queen: 1,
    upgrader: 2,
    scout: 1
  };
}
if (!workerSettings.DEFAULT_PRIORITY_QUEUE) {
  workerSettings.DEFAULT_PRIORITY_QUEUE = [
    'baseharvest',
    'courier',
    'queen',
    'builder',
    'upgrader',
    'repair'
  ];
}

settings.pixels = settings.pixels || Object.freeze({
  /** Toggle CPU bucket based pixel generation. */
  enabled: true,
  /** Minimum bucket value before attempting pixel generation. */
  bucketThreshold: 9990,
  /** Optional modulus so pixels are generated every N ticks. */
  tickModulo: 5
});

settings.maintenance = settings.maintenance || Object.freeze({
  /** How often to rescan repair targets inside BeeMaintenance. */
  repairScanInterval: 5,
  /** How long before the stale room sweep runs. */
  roomSweepInterval: 50
});

var combatSettings = settings.Combat || (settings.Combat = {});
if (!Array.isArray(combatSettings.SQUAD_CALLSIGNS) || combatSettings.SQUAD_CALLSIGNS.length === 0) {
  combatSettings.SQUAD_CALLSIGNS = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];
}
if (typeof combatSettings.MAX_ACTIVE_SQUADS_GLOBAL !== 'number' || combatSettings.MAX_ACTIVE_SQUADS_GLOBAL <= 0) {
  combatSettings.MAX_ACTIVE_SQUADS_GLOBAL = Math.min(2, combatSettings.SQUAD_CALLSIGNS.length);
}
if (typeof combatSettings.MAX_ACTIVE_SQUADS_PER_COLONY !== 'number' || combatSettings.MAX_ACTIVE_SQUADS_PER_COLONY <= 0) {
  combatSettings.MAX_ACTIVE_SQUADS_PER_COLONY = 1;
}

var economySettings = settings.Economy || (settings.Economy = {});
if (typeof economySettings.STORAGE_ENERGY_MIN_BEFORE_REMOTES !== 'number') {
  economySettings.STORAGE_ENERGY_MIN_BEFORE_REMOTES = 80000;
}
if (typeof economySettings.MAX_ACTIVE_REMOTES !== 'number') {
  economySettings.MAX_ACTIVE_REMOTES = 2;
}
if (typeof economySettings.ROAD_REPAIR_THRESHOLD !== 'number') {
  economySettings.ROAD_REPAIR_THRESHOLD = 0.45;
}
if (typeof economySettings.STORAGE_HEALTHY_RATIO !== 'number') {
  economySettings.STORAGE_HEALTHY_RATIO = 0.7;
}
if (typeof economySettings.CPU_MIN_BUCKET !== 'number') {
  economySettings.CPU_MIN_BUCKET = 500;
}
if (!economySettings.roads) {
  economySettings.roads = { minRCL: 3, disableGate: false };
} else {
  if (typeof economySettings.roads.minRCL !== 'number') {
    economySettings.roads.minRCL = 3;
  }
  if (typeof economySettings.roads.disableGate !== 'boolean') {
    economySettings.roads.disableGate = false;
  }
}
if (!economySettings.remoteRoads) {
  economySettings.remoteRoads = { minStorageEnergy: 40000 };
} else if (typeof economySettings.remoteRoads.minStorageEnergy !== 'number') {
  economySettings.remoteRoads.minStorageEnergy = 40000;
}
if (!economySettings.queen) {
  economySettings.queen = { allowCourierFallback: true };
} else if (typeof economySettings.queen.allowCourierFallback !== 'boolean') {
  economySettings.queen.allowCourierFallback = true;
}

var taskLunaSettings = settings.TaskLuna || (settings.TaskLuna = {});
if (typeof taskLunaSettings.maxHarvestersPerSource !== 'number') {
  taskLunaSettings.maxHarvestersPerSource = 1;
}
if (typeof taskLunaSettings.reserverRefreshAt !== 'number') {
  taskLunaSettings.reserverRefreshAt = 1200;
}
if (typeof taskLunaSettings.haulerTripTimeMax !== 'number') {
  taskLunaSettings.haulerTripTimeMax = 150;
}
if (typeof taskLunaSettings.containerFullDropPolicy !== 'string') {
  taskLunaSettings.containerFullDropPolicy = 'avoid';
}
if (typeof taskLunaSettings.containerFullDropThreshold !== 'number') {
  taskLunaSettings.containerFullDropThreshold = 0.85;
}
if (typeof taskLunaSettings.logLevel !== 'string') {
  taskLunaSettings.logLevel = 'BASIC';
}
if (typeof taskLunaSettings.healthLogInterval !== 'number') {
  taskLunaSettings.healthLogInterval = 150;
}
if (typeof taskLunaSettings.memoryAuditInterval !== 'number') {
  taskLunaSettings.memoryAuditInterval = 150;
}
if (typeof taskLunaSettings.minerHandoffBuffer !== 'number') {
  taskLunaSettings.minerHandoffBuffer = 40;
}
if (typeof taskLunaSettings.selfTestKey !== 'string') {
  taskLunaSettings.selfTestKey = 'lunaSelfTest';
}

var courierSettings = settings.Courier || (settings.Courier = {});
if (typeof courierSettings.travelReuse !== 'number') {
  courierSettings.travelReuse = 15;
}
if (typeof courierSettings.travelRange !== 'number') {
  courierSettings.travelRange = 1;
}
if (typeof courierSettings.travelStuck !== 'number') {
  courierSettings.travelStuck = 2;
}
if (typeof courierSettings.travelRepath !== 'number') {
  courierSettings.travelRepath = 0.1;
}
if (typeof courierSettings.travelMaxOps !== 'number') {
  courierSettings.travelMaxOps = 4000;
}
if (typeof courierSettings.towerRefillThreshold !== 'number') {
  courierSettings.towerRefillThreshold = 0.7;
}
if (typeof courierSettings.minWithdrawAmount !== 'number') {
  courierSettings.minWithdrawAmount = 50;
}

var towerSettings = settings.Tower || (settings.Tower = {});
if (typeof towerSettings.REPAIR_ENERGY_MIN !== 'number') {
  towerSettings.REPAIR_ENERGY_MIN = 400;
}

var mainSettings = settings.Main || (settings.Main = {});
if (typeof mainSettings.SOURCE_CONTAINER_SCAN_INTERVAL !== 'number') {
  mainSettings.SOURCE_CONTAINER_SCAN_INTERVAL = 50;
}

var tradeSettings = settings.Trade || (settings.Trade = {});
var tradeEnergySettings = tradeSettings.energy || (tradeSettings.energy = {});
if (typeof tradeEnergySettings.keepStorage !== 'number') {
  tradeEnergySettings.keepStorage = 600000;
}
if (typeof tradeEnergySettings.keepTerminal !== 'number') {
  tradeEnergySettings.keepTerminal = 50000;
}
if (typeof tradeEnergySettings.minPrice !== 'number') {
  tradeEnergySettings.minPrice = 0.15;
}
if (typeof tradeEnergySettings.minEffectiveCpe !== 'number') {
  tradeEnergySettings.minEffectiveCpe = 0.0;
}
if (typeof tradeEnergySettings.maxPerDeal !== 'number') {
  tradeEnergySettings.maxPerDeal = 20000;
}
if (typeof tradeEnergySettings.cooldownTicks !== 'number') {
  tradeEnergySettings.cooldownTicks = 25;
}
if (typeof tradeEnergySettings.minOrderAmount !== 'number') {
  tradeEnergySettings.minOrderAmount = 2000;
}
if (typeof tradeEnergySettings.scanTopN !== 'number') {
  tradeEnergySettings.scanTopN = 20;
}
if (typeof tradeEnergySettings.maxDistance !== 'number') {
  tradeEnergySettings.maxDistance = Infinity;
}
if (typeof tradeEnergySettings.historyRefresh !== 'number') {
  tradeEnergySettings.historyRefresh = 5000;
}

var beeHiveSettings = settings['BeeHiveMind'] || (settings['BeeHiveMind'] = {});
if (!beeHiveSettings.ROAD_GATE_DEFAULTS) {
  beeHiveSettings.ROAD_GATE_DEFAULTS = {
    minRCL: economySettings.roads.minRCL,
    disableGate: economySettings.roads.disableGate
  };
}
// @used_in:
//   BeeHiveMind.js:61
//   BeeHiveMind.js:74
//   BeeHiveMind.js:88
if (!beeHiveSettings.ECON_DEFAULTS) {
  beeHiveSettings.ECON_DEFAULTS = economySettings;
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
//   Task.Trucker.js:20
//   Task.Trucker.js:141
if (typeof truckerSettings.MIN_DROPPED !== 'number') {
  truckerSettings.MIN_DROPPED = 50;
}
// @used_in:
//   Task.Trucker.js:21
//   Task.Trucker.js:106
//   Task.Trucker.js:125
//   Task.Trucker.js:189
//   Task.Trucker.js:222
//   Task.Trucker.js:236
if (typeof truckerSettings.LOCAL_SEARCH_RADIUS !== 'number') {
  truckerSettings.LOCAL_SEARCH_RADIUS = 12;
}
// @used_in:
//   Task.Trucker.js:22
//   Task.Trucker.js:187
//   Task.Trucker.js:214
//   Task.Trucker.js:228
if (typeof truckerSettings.WIDE_SEARCH_RADIUS !== 'number') {
  truckerSettings.WIDE_SEARCH_RADIUS = 50;
}
// @used_in:
//   Task.Trucker.js:23
//   Task.Trucker.js:104
if (typeof truckerSettings.WIDE_SEARCH_COOLDOWN !== 'number') {
  truckerSettings.WIDE_SEARCH_COOLDOWN = 25;
}
// @used_in:
//   Task.Trucker.js:24
//   Task.Trucker.js:103
if (!truckerSettings.ALLOWED_RESOURCES || !truckerSettings.ALLOWED_RESOURCES.length) {
  truckerSettings.ALLOWED_RESOURCES = [RESOURCE_ENERGY, RESOURCE_POWER];
}
// @used_in:
//   Task.Trucker.js:25
//   Task.Trucker.js:31
//   Task.Trucker.js:34
//   Task.Trucker.js:106
//   Task.Trucker.js:125
//   Task.Trucker.js:189
//   Task.Trucker.js:214
//   Task.Trucker.js:228

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
module.exports.getEconomySettings = function () {
  return settings.Economy || (settings['BeeHiveMind'] && settings['BeeHiveMind'].ECON_DEFAULTS) || {};
};
