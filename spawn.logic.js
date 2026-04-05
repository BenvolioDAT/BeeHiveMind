'use strict';

// Spawn logic lives here so older require('spawn.logic') calls keep working.
// BeeSpawnManager delegates body selection and squad spawning to this module,
// so we keep the APIs intact and favor clear, linear helpers for novices.

var Logger = require('core.logger');
var LOG_LEVEL = Logger.LOG_LEVEL;
var spawnLog = Logger.createLogger('Spawn', LOG_LEVEL.BASIC);
var BeeCombatSquads = require('BeeCombatSquads');
var SquadFlagIntel = BeeCombatSquads.SquadFlagIntel || null;
var CoreConfig = require('core.config');

function combatDebugEnabled() {
  return Boolean(CoreConfig && CoreConfig.settings && CoreConfig.settings.combat &&
    CoreConfig.settings.combat.DEBUG_LOGS);
}

function combatSpawnLog() {
  if (!combatDebugEnabled()) return;
  try {
    spawnLog.info.apply(spawnLog, arguments);
  } catch (e) {
    // swallow logging errors
  }
}

function combatPlannerDebugEnabled() {
  return Boolean(CoreConfig && CoreConfig.settings && CoreConfig.settings.combat &&
    CoreConfig.settings.combat.DEBUG_PLANNER);
}

function combatPlannerLogEvery() {
  var cfg = CoreConfig && CoreConfig.settings && CoreConfig.settings.combat;
  var step = cfg && typeof cfg.DEBUG_PLANNER_EVERY === 'number' ? cfg.DEBUG_PLANNER_EVERY : 15;
  if (step < 1) step = 1;
  return step;
}

function plannerDebugLogDecision(key, fields) {
  if (!combatPlannerDebugEnabled()) return;
  if (!global.__combatPlannerLogCache || global.__combatPlannerLogCache.tick !== Game.time) {
    global.__combatPlannerLogCache = { tick: Game.time, entries: {} };
  }
  var map = global.__combatPlannerLogCache.entries;
  var safeKey = String(key || 'unknown');
  var sig = JSON.stringify(fields || {});
  var rec = map[safeKey];
  var every = combatPlannerLogEvery();
  if (rec && rec.sig === sig && (Game.time - rec.last) < every) {
    return;
  }
  map[safeKey] = { sig: sig, last: Game.time };
  try {
    spawnLog.info('[CombatPlan]', safeKey, sig);
  } catch (e) {}
}

// -----------------------------------------------------------------------------
// Body builders (ES5-only helpers to construct Screeps body arrays)
// -----------------------------------------------------------------------------
// Role-specific configurations
// The ( ... ) The Spread Operator.
//This code block the Spread Operator is taken the Array flatten it to one Array with out the Spread Operator
//the Array turn into a nested Array meaning ( [work],[carry],[move],) we want ( [work, carry, move,] )
const Claimer = (Claim, Move) =>  [
  ...Array(Claim).fill(CLAIM),
  ...Array(Move).fill(MOVE)
];

const WorkBody = (Work, Carry, Move) => [
  ...Array(Work).fill(WORK),
  ...Array(Carry).fill(CARRY),
  ...Array(Move).fill(MOVE)
];

const CombatBody = (Tough, Attack, Move, Range_attack, Heal) => [
  ...Array(Tough).fill(TOUGH),
  ...Array(Attack).fill(ATTACK),
  ...Array(Move).fill(MOVE),
  ...Array(Range_attack).fill(RANGED_ATTACK),
  ...Array(Heal).fill(HEAL),
];
// -----------------------------------------------------------------------------
// Role configuration (canonical names only)
// -----------------------------------------------------------------------------
var ROLE_CONFIGS = {
  BaseHarvest: [
    WorkBody(6, 1, 5),
    WorkBody(5, 1, 5),
    WorkBody(4, 1, 4),
    WorkBody(3, 1, 3),
    WorkBody(2, 1, 2),
    WorkBody(1, 1, 1),
  ],
  Courier: [
    //WorkBody(0, 30, 15),
    //WorkBody(0, 29, 15),
    //WorkBody(0, 28, 14),
    //WorkBody(0, 27, 14),
    //WorkBody(0, 26, 13),
    //WorkBody(0, 25, 13),
    WorkBody(0, 24, 12),
    WorkBody(0, 23, 23),
    WorkBody(0, 22, 22),
    WorkBody(0, 21, 21),
    WorkBody(0, 20, 20),
    WorkBody(0, 19, 19),
    WorkBody(0, 18, 18),
    WorkBody(0, 17, 17),
    WorkBody(0, 16, 16),
    WorkBody(0, 15, 15),
    WorkBody(0, 14, 14),
    WorkBody(0, 13, 13),
    WorkBody(0, 12, 12),
    WorkBody(0, 11, 11),
    WorkBody(0, 10, 10),
    WorkBody(0, 9, 9),
    WorkBody(0, 8, 8),
    WorkBody(0, 7, 7),
    WorkBody(0, 6, 6),
    WorkBody(0, 5, 5),
    WorkBody(0, 4, 4),
    WorkBody(0, 3, 3),
    WorkBody(0, 2, 2),
    WorkBody(0, 1, 1),
  ],
  Builder: [
    WorkBody(3, 6, 9),
    WorkBody(2, 4, 6),
    WorkBody(2, 2, 4),
    WorkBody(1, 1, 2),
    WorkBody(1, 1, 1),
  ],
  Repair: [
    WorkBody(5, 2, 7),
    WorkBody(4, 1, 5),
    WorkBody(2, 1, 3),
  ],
  Upgrader: [
    WorkBody(10,5, 5),
    WorkBody(5, 5, 5),
    WorkBody(4, 4, 8),
    WorkBody(4, 3, 7),
    WorkBody(3, 3, 6),
    WorkBody(3, 2, 5),
    WorkBody(2, 2, 4),
    WorkBody(2, 1, 3),
    WorkBody(1, 1, 2),
    WorkBody(1, 1, 1),
  ],
  Queen: [
    //WorkBody(0, 22, 22),
    //WorkBody(0, 21, 21),
    //WorkBody(0, 20, 20),
    //WorkBody(0, 19, 19),
    WorkBody(0, 18, 9),
    WorkBody(0, 18, 18),
    WorkBody(0, 17, 17),
    WorkBody(0, 16, 16),
    WorkBody(0, 15, 15),
    WorkBody(0, 14, 14),
    WorkBody(0, 13, 13),
    WorkBody(0, 12, 12),
    WorkBody(0, 11, 11),
    WorkBody(0, 10, 10),
    WorkBody(0, 9, 9),
    WorkBody(0, 8, 8),
    WorkBody(0, 7, 7),
    WorkBody(0, 6, 6),
    WorkBody(0, 5, 5),
    WorkBody(0, 4, 4),
    WorkBody(0, 3, 3),
    WorkBody(0, 2, 2),
    WorkBody(0, 1, 1),
  ],
  Luna: [
    WorkBody(3, 4, 7),
    WorkBody(2, 4, 6),
    WorkBody(2, 3, 5),
    WorkBody(1, 3, 4),
    WorkBody(1, 2, 3),
    WorkBody(1, 1, 2),
    WorkBody(1, 1, 1),
  ],
  Scout: [
    WorkBody(0, 0, 1)
  ],
  CombatMelee: [
    CombatBody(0, 2, 2, 0, 0),
  ],
  CombatArcher: [
    CombatBody(0, 0, 1, 1, 0),
  ],
  CombatMedic: [
    CombatBody(0, 0, 4, 0, 4),
    CombatBody(0, 0, 3, 0, 3),
    CombatBody(0, 0, 2, 0, 2),
    CombatBody(0, 0, 1, 0, 1),
  ],
  Dismantler: [
    WorkBody(5, 0, 5)
  ],
  Claimer: [
    Claimer(2, 2),
    Claimer(1, 1)
  ]
};

var COMBAT_BODY_TEMPLATES = {
  CombatMelee: [
    CombatBody(0, 1, 1, 0, 0), // tier 0: emergency cheap responder
    CombatBody(0, 2, 2, 0, 0), // tier 1: current baseline
    CombatBody(2, 4, 4, 0, 0), // tier 2: durable frontline
    CombatBody(4, 6, 6, 0, 0)  // tier 3: heavier response
  ],
  CombatArcher: [
    CombatBody(0, 0, 1, 1, 0), // tier 0: emergency kite
    CombatBody(0, 0, 2, 2, 0), // tier 1: baseline ranged pair
    CombatBody(1, 0, 5, 4, 0), // tier 2: mobile pressure
    CombatBody(2, 0, 8, 6, 0)  // tier 3: stronger ranged backbone
  ],
  CombatMedic: [
    CombatBody(0, 0, 1, 0, 1), // tier 0: bare minimum sustain
    CombatBody(0, 0, 2, 0, 2), // tier 1: baseline sustain
    CombatBody(1, 0, 4, 0, 3), // tier 2: mobile sustain with buffer
    CombatBody(2, 0, 6, 0, 5)  // tier 3: sustained combat medic
  ]
};

var ROLE_CANONICAL = [
  'BaseHarvest',
  'Courier',
  'Builder',
  'Repair',
  'Upgrader',
  'Queen',
  'Luna',
  'Scout',
  'CombatMelee',
  'CombatArcher',
  'CombatMedic',
  'Dismantler',
  'Claimer'
];

var ROLE_NORMALIZE_MAP = (function () {
  var map = Object.create(null);
  for (var i = 0; i < ROLE_CANONICAL.length; i++) {
    var role = ROLE_CANONICAL[i];
    map[role] = role;
    map[role.toLowerCase()] = role;
  }
  map.remoteharvest = 'Luna';
  map.trucker = 'Courier';
  map.worker = 'BaseHarvest';
  map.harvester = 'BaseHarvest';
  return map;
})();

function normalizeRole(role) {
  if (role === undefined || role === null) return null;
  var key = String(role);
  if (!key) return null;

  // Try exact match first, then lowercase alias (e.g. "baseharvest" → BaseHarvest).
  var canonical = ROLE_NORMALIZE_MAP[key] || ROLE_NORMALIZE_MAP[key.toLowerCase()];
  return canonical || null;
}

function calculateBodyCost(body) {
  var total = 0;
  for (var i = 0; i < body.length; i++) {
    var part = body[i];
    total += BODYPART_COST[part] || 0;
  }
  return total;
}

function cloneBody(body) {
  var copy = [];
  for (var i = 0; i < body.length; i++) {
    copy.push(body[i]);
  }
  return copy;
}

function isCombatRole(roleName) {
  return roleName === 'CombatMelee' || roleName === 'CombatArcher' || roleName === 'CombatMedic';
}

function clampCombatTier(roleName, tier) {
  var list = COMBAT_BODY_TEMPLATES[roleName];
  if (!list || !list.length) return 0;
  var maxTier = list.length - 1;
  if (typeof tier !== 'number') return maxTier;
  if (tier < 0) return 0;
  if (tier > maxTier) return maxTier;
  return tier;
}

function getRoleBodyCatalog(roleName, opts) {
  if (isCombatRole(roleName) && COMBAT_BODY_TEMPLATES[roleName]) {
    var cap = clampCombatTier(roleName, opts && opts.combatBodyTierCap);
    var tiers = COMBAT_BODY_TEMPLATES[roleName];
    var out = [];
    for (var ti = cap; ti >= 0; ti--) {
      out.push(tiers[ti]);
    }
    return out;
  }
  return ROLE_CONFIGS[roleName] || null;
}

function getBodyForRole(roleName, energyAvailable, opts) {
  if (!roleName) return [];

  var energy = typeof energyAvailable === 'number' ? energyAvailable : 0;
  var list = getRoleBodyCatalog(roleName, opts);
  if (!list) {
    if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
      spawnLog.debug('No config for role', roleName);
    }
    return [];
  }

  // Config arrays are ordered largest→smallest; pick the first body we can afford.
  for (var i = 0; i < list.length; i++) {
    var body = list[i];
    var cost = calculateBodyCost(body);
    if (cost <= energy) {
      if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
        spawnLog.debug('Picked', roleName, 'body [' + body + ']', 'cost', cost, 'avail', energy);
      }
      return cloneBody(body);
    }
  }

  if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
    var cheapest = list[list.length - 1];
    var minCost = cheapest ? calculateBodyCost(cheapest) : 0;
    spawnLog.debug('Insufficient energy for', roleName, 'need at least', minCost, 'have', energy);
  }
  return [];
}

function Generate_Creep_Name(role, max) {
  var limit = typeof max === 'number' ? max : 70;
  for (var i = 1; i <= limit; i++) {
    var name = role + '_' + i;
    if (!Game.creeps[name]) return name;
  }
  return null;
}

function copyMemory(source) {
  var target = {};
  if (!source) return target;
  for (var key in source) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    target[key] = source[key];
  }
  return target;
}

function spawnRole(spawn, roleName, availableEnergy, memory) {
  if (!spawn) return false;

  // Resolve the requested role into our canonical spelling before continuing.
  var canonicalRole = normalizeRole(roleName);
  if (!canonicalRole) {
    if (Logger.shouldLog(LOG_LEVEL.WARN)) {
      spawnLog.warn('Unknown role requested:', roleName);
    }
    return false;
  }

  var energy = typeof availableEnergy === 'number' ? availableEnergy : 0;
  var bodyOpts = null;
  if (isCombatRole(canonicalRole)) {
    bodyOpts = {
      combatBodyTierCap: (memory && typeof memory.combatBodyTierCap === 'number')
        ? memory.combatBodyTierCap
        : undefined
    };
  }
  var body = getBodyForRole(canonicalRole, energy, bodyOpts);
  if (!body || !body.length) return false;

  var creepName = Generate_Creep_Name(canonicalRole);
  if (!creepName) return false;

  // Copy over provided memory so we never mutate the caller's object.
  var mem = copyMemory(memory);
  if (!mem.role) mem.role = canonicalRole;
  if (mem.skipTaskMemory) {
    delete mem.skipTaskMemory;
  }

  // Keep combat squad data beside the spawn call so new creeps hit the ground
  // with their rally room and wait timer already set.
  if (canonicalRole === 'CombatMelee' ||
      canonicalRole === 'CombatMedic' ||
      canonicalRole === 'CombatArcher') {
    var sid = mem.squadId || (memory && memory.squadId);
    var targetRoom = mem.targetRoom || (memory && memory.targetRoom);
    var squadFlag = mem.squadFlag || (memory && memory.squadFlag);
    if (sid && !mem.squadId) mem.squadId = sid;
    if (targetRoom && !mem.targetRoom) mem.targetRoom = targetRoom;
    if (squadFlag && !mem.squadFlag) mem.squadFlag = squadFlag;
    if (!mem.assignedAt) mem.assignedAt = Game.time;
    if (!mem.state) mem.state = 'rally';
    if (!mem.waitUntil) mem.waitUntil = Game.time + 25;
    if (typeof mem.combatBodyTierCap === 'number' && !mem.bodyTierCap) {
      mem.bodyTierCap = mem.combatBodyTierCap;
    }
    // buddyId / stickTargetId handled by roles post-spawn
  }

  var result = spawn.spawnCreep(body, creepName, { memory: mem });
  if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
    spawnLog.debug('spawnRole', canonicalRole, 'body [' + body + ']', 'cost', calculateBodyCost(body), 'avail', energy, 'result', result);
  }
  if (result === OK) {
    if (Logger.shouldLog(LOG_LEVEL.BASIC)) {
      spawnLog.info('Spawned', canonicalRole, '=>', creepName);
    }
    return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// Energy accounting
// -----------------------------------------------------------------------------
function Calculate_Spawn_Resource(spawnOrRoom) {
  if (spawnOrRoom) {
    // Allow spawns, room objects, or room names.
    var room = spawnOrRoom.room || (typeof spawnOrRoom === 'string'
      ? Game.rooms[spawnOrRoom]
      : spawnOrRoom);
    return room ? room.energyAvailable : 0;
  }

  // Fallback path: sum all spawn + extension stores when no room hint is
  // provided. This mirrors how Screeps counts capacity in the UI.
  var spawnEnergy = 0;
  for (var name in Game.spawns) {
    if (!Object.prototype.hasOwnProperty.call(Game.spawns, name)) continue;
    var structure = Game.spawns[name];
    spawnEnergy += (structure.store && structure.store[RESOURCE_ENERGY]) || 0;
  }
  var extensionEnergy = _.sum(Game.structures, function (s) {
    if (s.structureType !== STRUCTURE_EXTENSION) return 0;
    if (!s.store) return 0;
    return s.store[RESOURCE_ENERGY] || 0;
  });
  return spawnEnergy + extensionEnergy;
}

// -----------------------------------------------------------------------------
// Squad spawning (delegates to spawnRole)
// -----------------------------------------------------------------------------
var SQUAD_COOLDOWN_TICKS = 1;

var ECONOMY_STATES = {
  CRITICAL: 'CRITICAL',
  STRAINED: 'STRAINED',
  HEALTHY: 'HEALTHY',
  RICH: 'RICH'
};

var MATURITY_STAGES = {
  EARLY: 'EARLY',
  MID: 'MID',
  LATE: 'LATE',
  ENDGAME: 'ENDGAME'
};

var FIGHT_TYPES = {
  HOME_DEFENSE: 'HOME_DEFENSE',
  SK_PVE: 'SK_PVE',
  BORDER_RESPONSE: 'BORDER_RESPONSE',
  INVASION_RESPONSE: 'INVASION_RESPONSE',
  PLANNED_OFFENSE: 'PLANNED_OFFENSE'
};

var THREAT_TIERS = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
  SEVERE: 'SEVERE'
};

function normalizeSquadKey(id) {
  if (!id) return null;
  var key = String(id);
  if (key.indexOf('Squad') === 0) return key;
  return 'Squad' + key;
}

// Novice tip: hide the boilerplate Memory guards so orchestration logic stays
// focused on decisions, not on `if (!Memory.foo)` noise.
function ensureSquadMemory(id) {
  if (!id) return {};
  if (!Memory.squads) Memory.squads = {};
  var key = normalizeSquadKey(id);
  if (!key) return {};
  if (!Memory.squads[key]) {
    if (Memory.squads[id] && id !== key) {
      Memory.squads[key] = Memory.squads[id];
      delete Memory.squads[id];
    } else {
      Memory.squads[key] = {};
    }
  }
  return Memory.squads[key];
}

// Teaching habit: keep combat math in one helper so adjusting threat levels
// never requires scrolling through spawn orchestration code.
/**
 * desiredSquadLayout translates a numeric threat score into a blend of melee,
 * ranged, and medic creeps. Spawn_Squad + BeeSpawnManager rely on this so the
 * formation stays consistent with intel scoring.
 */
function desiredSquadLayout(score) {
  var threat = typeof score === 'number' ? score : 0;
  if (threat <= 0) return [];
  var melee = 1;
  var medic = 1;
  var archer = 0;

  if (threat >= 12) melee = 2;
  if (threat >= 18) medic = 2;
  if (threat >= 10 && threat < 22) archer = 1;
  else if (threat >= 22) archer = 2;

  var order = [{ role: 'CombatMelee', need: melee }];
  if (archer > 0) order.push({ role: 'CombatArcher', need: archer });
  order.push({ role: 'CombatMedic', need: medic });
  return order;
}

function normalizeRoomName(roomLike) {
  if (!roomLike) return null;
  if (typeof roomLike === 'string') return roomLike;
  if (typeof roomLike.roomName === 'string') return roomLike.roomName;
  if (roomLike.pos && typeof roomLike.pos.roomName === 'string') return roomLike.pos.roomName;
  if (roomLike.room && typeof roomLike.room.name === 'string') return roomLike.room.name;
  if (typeof roomLike.name === 'string') return roomLike.name;
  return null;
}

function plannerConfig() {
  var combatCfg = CoreConfig && CoreConfig.settings && CoreConfig.settings.combat;
  var planner = combatCfg && combatCfg.planner ? combatCfg.planner : {};
  return {
    economy: planner.economy || {},
    threatTiers: planner.threatTiers || {}
  };
}

function classifyRoomMaturity(room) {
  if (!room) return MATURITY_STAGES.EARLY;
  var rcl = (room.controller && typeof room.controller.level === 'number') ? room.controller.level : 0;
  var cap = room.energyCapacityAvailable || 0;
  if (rcl >= 8 || cap >= 2600) return MATURITY_STAGES.ENDGAME;
  if (rcl >= 6 || cap >= 1800) return MATURITY_STAGES.LATE;
  if (rcl >= 4 || cap >= 800) return MATURITY_STAGES.MID;
  return MATURITY_STAGES.EARLY;
}

function roomStockEnergy(room) {
  if (!room) return 0;
  var storageEnergy = room.storage && room.storage.store ? (room.storage.store[RESOURCE_ENERGY] || 0) : 0;
  var terminalEnergy = room.terminal && room.terminal.store ? (room.terminal.store[RESOURCE_ENERGY] || 0) : 0;
  return storageEnergy + terminalEnergy;
}

function classifyEconomyState(room, maturity) {
  if (!room) return ECONOMY_STATES.CRITICAL;
  var cfg = plannerConfig().economy;
  var storageEnergy = room.storage && room.storage.store ? (room.storage.store[RESOURCE_ENERGY] || 0) : 0;
  var terminalEnergy = room.terminal && room.terminal.store ? (room.terminal.store[RESOURCE_ENERGY] || 0) : 0;
  var stock = storageEnergy + terminalEnergy;
  var cap = room.energyCapacityAvailable || 0;
  var rcl = (room.controller && typeof room.controller.level === 'number') ? room.controller.level : 0;

  var criticalStorage = typeof cfg.CRITICAL_STORAGE === 'number' ? cfg.CRITICAL_STORAGE : 20000;
  var strainedStorage = typeof cfg.STRAINED_STORAGE === 'number' ? cfg.STRAINED_STORAGE : 80000;
  var healthyStorage = typeof cfg.HEALTHY_STORAGE === 'number' ? cfg.HEALTHY_STORAGE : 180000;
  var criticalTerminal = typeof cfg.CRITICAL_TERMINAL === 'number' ? cfg.CRITICAL_TERMINAL : 10000;
  var strainedTerminal = typeof cfg.STRAINED_TERMINAL === 'number' ? cfg.STRAINED_TERMINAL : 40000;
  var healthyTerminal = typeof cfg.HEALTHY_TERMINAL === 'number' ? cfg.HEALTHY_TERMINAL : 100000;
  var earlyCap = typeof cfg.EARLY_CAPACITY === 'number' ? cfg.EARLY_CAPACITY : 550;
  var midCap = typeof cfg.MID_CAPACITY === 'number' ? cfg.MID_CAPACITY : 1300;
  var lateCap = typeof cfg.LATE_CAPACITY === 'number' ? cfg.LATE_CAPACITY : 2300;

  if (!room.storage && !room.terminal) {
    if (cap <= earlyCap || rcl <= 3) return ECONOMY_STATES.CRITICAL;
    if (cap <= midCap || rcl <= 5) return ECONOMY_STATES.STRAINED;
    if (cap <= lateCap || maturity === MATURITY_STAGES.LATE) return ECONOMY_STATES.HEALTHY;
    return ECONOMY_STATES.RICH;
  }

  if (storageEnergy <= criticalStorage && terminalEnergy <= criticalTerminal) {
    return ECONOMY_STATES.CRITICAL;
  }
  if (stock <= strainedStorage || (terminalEnergy > 0 && terminalEnergy <= strainedTerminal)) {
    return ECONOMY_STATES.STRAINED;
  }
  if (stock <= healthyStorage || (terminalEnergy > 0 && terminalEnergy <= healthyTerminal)) {
    return ECONOMY_STATES.HEALTHY;
  }
  return ECONOMY_STATES.RICH;
}

function classifyThreatTier(score) {
  var t = typeof score === 'number' ? score : 0;
  var cfg = plannerConfig().threatTiers;
  var lowMax = typeof cfg.LOW_MAX === 'number' ? cfg.LOW_MAX : 7;
  var medMax = typeof cfg.MEDIUM_MAX === 'number' ? cfg.MEDIUM_MAX : 15;
  var highMax = typeof cfg.HIGH_MAX === 'number' ? cfg.HIGH_MAX : 24;
  if (t <= lowMax) return THREAT_TIERS.LOW;
  if (t <= medMax) return THREAT_TIERS.MEDIUM;
  if (t <= highMax) return THREAT_TIERS.HIGH;
  return THREAT_TIERS.SEVERE;
}

function listOwnedRoomNames() {
  var set = {};
  var out = [];
  for (var roomName in Game.rooms) {
    if (!Object.prototype.hasOwnProperty.call(Game.rooms, roomName)) continue;
    var room = Game.rooms[roomName];
    if (!room || !room.controller || !room.controller.my) continue;
    if (set[room.name]) continue;
    set[room.name] = true;
    out.push(room.name);
  }
  for (var sName in Game.spawns) {
    if (!Object.prototype.hasOwnProperty.call(Game.spawns, sName)) continue;
    var sp = Game.spawns[sName];
    if (!sp || !sp.my || !sp.room) continue;
    if (set[sp.room.name]) continue;
    set[sp.room.name] = true;
    out.push(sp.room.name);
  }
  return out;
}

function isMyRoom(roomName) {
  if (!roomName) return false;
  var owned = listOwnedRoomNames();
  for (var i = 0; i < owned.length; i++) {
    if (owned[i] === roomName) return true;
  }
  return false;
}

function containsSourceKeeperHostiles(room) {
  if (!room || typeof room.find !== 'function') return false;
  var hostiles = room.find(FIND_HOSTILE_CREEPS) || [];
  for (var i = 0; i < hostiles.length; i++) {
    var c = hostiles[i];
    if (!c || !c.owner || !c.owner.username) continue;
    if (String(c.owner.username).toLowerCase() === 'source keeper') return true;
  }
  return false;
}

function containsPlayerHostiles(room) {
  if (!room || typeof room.find !== 'function') return false;
  var hostiles = room.find(FIND_HOSTILE_CREEPS) || [];
  for (var i = 0; i < hostiles.length; i++) {
    var c = hostiles[i];
    if (!c || !c.owner || !c.owner.username) continue;
    var owner = String(c.owner.username).toLowerCase();
    if (owner !== 'invader' && owner !== 'source keeper') return true;
  }
  return false;
}

function distanceClass(spawnRoomName, targetRoomName) {
  if (!spawnRoomName || !targetRoomName || !Game.map || typeof Game.map.getRoomLinearDistance !== 'function') {
    return 'local';
  }
  var dist = Game.map.getRoomLinearDistance(spawnRoomName, targetRoomName, true);
  if (typeof dist !== 'number' || dist <= 1) return 'local';
  if (dist <= 3) return 'border';
  return 'far';
}

function classifyFightType(spawn, squadId, targetRoom, flagData, threatTier) {
  var targetName = normalizeRoomName(targetRoom);
  if (!targetName) return FIGHT_TYPES.BORDER_RESPONSE;
  if (isMyRoom(targetName)) return FIGHT_TYPES.HOME_DEFENSE;

  var target = Game.rooms[targetName];
  if (target && containsSourceKeeperHostiles(target)) return FIGHT_TYPES.SK_PVE;

  var distType = distanceClass(spawn && spawn.room ? spawn.room.name : null, targetName);
  var playerThreat = target ? containsPlayerHostiles(target) : false;
  var name = String(squadId || '');
  var isAutoDefenseName = (name.indexOf('Squad') === 0) && name.length > 5;

  if (playerThreat && (threatTier === THREAT_TIERS.HIGH || threatTier === THREAT_TIERS.SEVERE)) {
    return FIGHT_TYPES.INVASION_RESPONSE;
  }
  if (distType === 'local' || distType === 'border') return FIGHT_TYPES.BORDER_RESPONSE;
  if (flagData && flagData.flag && !isAutoDefenseName) return FIGHT_TYPES.PLANNED_OFFENSE;
  return FIGHT_TYPES.BORDER_RESPONSE;
}

function baseCountsForThreat(threatTier) {
  if (threatTier === THREAT_TIERS.SEVERE) return { CombatMelee: 2, CombatArcher: 2, CombatMedic: 2 };
  if (threatTier === THREAT_TIERS.HIGH) return { CombatMelee: 2, CombatArcher: 1, CombatMedic: 1 };
  if (threatTier === THREAT_TIERS.MEDIUM) return { CombatMelee: 1, CombatArcher: 1, CombatMedic: 1 };
  return { CombatMelee: 1, CombatArcher: 0, CombatMedic: 1 };
}

function capCounts(totalCap, counts) {
  if (!counts) return counts;
  var total = (counts.CombatMelee || 0) + (counts.CombatArcher || 0) + (counts.CombatMedic || 0);
  if (total <= totalCap) return counts;
  while (total > totalCap) {
    if ((counts.CombatArcher || 0) > 0) {
      counts.CombatArcher -= 1;
      total -= 1;
      continue;
    }
    if ((counts.CombatMedic || 0) > 1) {
      counts.CombatMedic -= 1;
      total -= 1;
      continue;
    }
    if ((counts.CombatMelee || 0) > 1) {
      counts.CombatMelee -= 1;
      total -= 1;
      continue;
    }
    break;
  }
  return counts;
}

function applyFightTypeDoctrine(fightType, threatTier, counts) {
  if (!counts) counts = { CombatMelee: 1, CombatArcher: 0, CombatMedic: 1 };
  if (fightType === FIGHT_TYPES.HOME_DEFENSE) {
    if (threatTier === THREAT_TIERS.LOW) {
      counts.CombatMedic = 0;
      if (counts.CombatMelee < 1) counts.CombatMelee = 1;
    }
    return counts;
  }
  if (fightType === FIGHT_TYPES.SK_PVE) {
    if (counts.CombatMelee > 2) counts.CombatMelee = 2;
    if (counts.CombatArcher > 1) counts.CombatArcher = 1;
    if (counts.CombatMedic > 1) counts.CombatMedic = 1;
    if (counts.CombatMelee < 1) counts.CombatMelee = 1;
    return counts;
  }
  if (fightType === FIGHT_TYPES.BORDER_RESPONSE) {
    if (counts.CombatMedic < 1 && threatTier !== THREAT_TIERS.LOW) counts.CombatMedic = 1;
    return counts;
  }
  if (fightType === FIGHT_TYPES.INVASION_RESPONSE) {
    if (counts.CombatMelee < 2) counts.CombatMelee = 2;
    if (counts.CombatMedic < 1) counts.CombatMedic = 1;
    return counts;
  }
  // Planned offense: keep current threat shape, caller/economy handles allow/deny.
  return counts;
}

function bodyTierCapsForEconomy(economyState, fightType, threatTier, maturity) {
  var cap = {
    CombatMelee: 1,
    CombatArcher: 1,
    CombatMedic: 1
  };
  if (economyState === ECONOMY_STATES.STRAINED) {
    cap = { CombatMelee: 2, CombatArcher: 1, CombatMedic: 1 };
  } else if (economyState === ECONOMY_STATES.HEALTHY) {
    cap = { CombatMelee: 2, CombatArcher: 2, CombatMedic: 2 };
  } else if (economyState === ECONOMY_STATES.RICH) {
    cap = { CombatMelee: 3, CombatArcher: 3, CombatMedic: 3 };
  }

  if (maturity === MATURITY_STAGES.EARLY) {
    if (cap.CombatMelee > 1) cap.CombatMelee = 1;
    if (cap.CombatArcher > 1) cap.CombatArcher = 1;
    if (cap.CombatMedic > 1) cap.CombatMedic = 1;
  } else if (maturity === MATURITY_STAGES.MID) {
    if (cap.CombatMelee > 2) cap.CombatMelee = 2;
    if (cap.CombatArcher > 2) cap.CombatArcher = 2;
    if (cap.CombatMedic > 2) cap.CombatMedic = 2;
  }

  if (fightType === FIGHT_TYPES.HOME_DEFENSE && threatTier === THREAT_TIERS.LOW) {
    if (cap.CombatArcher > 1) cap.CombatArcher = 1;
    if (cap.CombatMedic > 1) cap.CombatMedic = 1;
  }
  if (fightType === FIGHT_TYPES.SK_PVE) {
    if (cap.CombatMedic > 2) cap.CombatMedic = 2;
  }
  return cap;
}

function squadTotalCapForEconomy(economyState) {
  if (economyState === ECONOMY_STATES.CRITICAL) return 2;
  if (economyState === ECONOMY_STATES.STRAINED) return 3;
  if (economyState === ECONOMY_STATES.HEALTHY) return 5;
  return 6;
}

function reinforcementModeForState(economyState, fightType) {
  if (economyState === ECONOMY_STATES.CRITICAL) return 'CHEAP_HOLD';
  if (economyState === ECONOMY_STATES.STRAINED) return 'CAUTIOUS';
  if (fightType === FIGHT_TYPES.HOME_DEFENSE) return 'FAST_RESPONSE';
  if (economyState === ECONOMY_STATES.RICH) return 'SUSTAINED';
  return 'BALANCED';
}

function plannedOffenseAllowed(economyState) {
  return economyState === ECONOMY_STATES.HEALTHY || economyState === ECONOMY_STATES.RICH;
}

function combatPlanner(spawn, squadId, flagData, threatScore, liveThreat) {
  var spawnRoom = spawn && spawn.room ? spawn.room : null;
  var targetRoom = normalizeRoomName(flagData && flagData.targetRoom);
  var maturity = classifyRoomMaturity(spawnRoom);
  var economyState = classifyEconomyState(spawnRoom, maturity);
  var tier = classifyThreatTier(threatScore);
  var fightType = classifyFightType(spawn, squadId, targetRoom, flagData, tier);

  var allowSpawn = true;
  var denyReason = '';
  if (fightType === FIGHT_TYPES.PLANNED_OFFENSE && !plannedOffenseAllowed(economyState)) {
    allowSpawn = false;
    denyReason = 'planned_offense_blocked_' + economyState.toLowerCase();
  }
  if (economyState === ECONOMY_STATES.CRITICAL && fightType !== FIGHT_TYPES.HOME_DEFENSE && fightType !== FIGHT_TYPES.SK_PVE) {
    allowSpawn = false;
    denyReason = denyReason || 'critical_economy_nonessential_combat';
  }

  var counts = baseCountsForThreat(tier);
  counts = applyFightTypeDoctrine(fightType, tier, counts);
  counts = capCounts(squadTotalCapForEconomy(economyState), counts);

  var bodyCaps = bodyTierCapsForEconomy(economyState, fightType, tier, maturity);
  var cooldown = SQUAD_COOLDOWN_TICKS;
  if (economyState === ECONOMY_STATES.CRITICAL) cooldown = 20;
  else if (economyState === ECONOMY_STATES.STRAINED) cooldown = 8;
  else if (fightType === FIGHT_TYPES.HOME_DEFENSE && tier === THREAT_TIERS.SEVERE) cooldown = 1;
  else if (economyState === ECONOMY_STATES.HEALTHY) cooldown = 3;
  else cooldown = 1;

  var plan = {
    economyState: economyState,
    maturity: maturity,
    fightType: fightType,
    threatTier: tier,
    desiredCountsByRole: counts,
    bodyTierCapByRole: bodyCaps,
    reinforcementMode: reinforcementModeForState(economyState, fightType),
    allowSpawn: allowSpawn,
    denyReason: denyReason,
    squadCooldownTicks: cooldown,
    stockEnergy: roomStockEnergy(spawnRoom),
    targetRoom: targetRoom,
    liveThreat: liveThreat || null
  };

  plannerDebugLogDecision((squadId || 'unknown') + '@' + (spawnRoom ? spawnRoom.name : 'no_room'), {
    room: spawnRoom ? spawnRoom.name : null,
    squadId: squadId || null,
    targetRoom: targetRoom,
    fightType: plan.fightType,
    threatTier: plan.threatTier,
    economyState: plan.economyState,
    maturity: plan.maturity,
    desired: plan.desiredCountsByRole,
    bodyCap: plan.bodyTierCapByRole,
    allow: plan.allowSpawn,
    deny: plan.denyReason || null,
    mode: plan.reinforcementMode
  });
  return plan;
}

// Decide whether a remote room is too far from the spawn room based on linear room distance.
// If the inputs are not valid room names, log the problem and return true so we fail safe.
function distanceTooFar(spawnRoomName, targetRoom) {
  if (!Game.map || typeof Game.map.getRoomLinearDistance !== 'function') return false;

  var originRoomName = normalizeRoomName(spawnRoomName);
  var targetRoomName = normalizeRoomName(targetRoom);

  if (!originRoomName || !targetRoomName) {
    console.log('[Spawn][distanceTooFar] invalid room names', spawnRoomName, targetRoom);
    return true;
  }

  var dist = Game.map.getRoomLinearDistance(originRoomName, targetRoomName, true);
  if (typeof dist !== 'number') {
    console.log('[Spawn][distanceTooFar] unable to compute distance', originRoomName, targetRoomName, dist);
    return true;
  }
  return dist > 3;
}

function matchesSquadRole(mem, taskName) {
  if (!mem || !taskName) return false;
  var target = String(taskName).toLowerCase();
  var role = mem.role ? String(mem.role).toLowerCase() : null;
  if (role === target) return true;
  var task = mem.task ? String(mem.task).toLowerCase() : null;
  if (task === target) return true;
  var bornTask = mem.bornTask ? String(mem.bornTask).toLowerCase() : null;
  if (bornTask === target) return true;
  return false;
}

// Separate counting logic lets beginners test the squad pipeline in isolation.
function haveSquadCount(id, taskName) {
  var live = _.sum(Game.creeps, function (c) {
    if (!c || !c.my || !c.memory) return 0;
    if (c.memory.squadId !== id) return 0;
    return matchesSquadRole(c.memory, taskName) ? 1 : 0;
  });
  var hatching = _.sum(Memory.creeps, function (mem, name) {
    if (!mem) return 0;
    if (mem.squadId !== id) return 0;
    if (!matchesSquadRole(mem, taskName)) return 0;
    return Game.creeps[name] ? 0 : 1;
  });
  return live + hatching;
}

// Teaching habit: whenever you mutate Memory, wrap it in a helper and list
// every field you touch. Future you will thank you during bug hunts.
function stampSquadPlanMemory(S, layout, targetRoom, threatScore, flag) {
  S.targetRoom = targetRoom;
  S.lastKnownScore = threatScore;
  S.flagName = flag ? flag.name : null;
  S.desiredCounts = {};
  for (var li = 0; li < layout.length; li++) {
    var plan = layout[li];
    var needed = typeof plan.need === 'number' ? plan.need : 0;
    S.desiredCounts[plan.role] = needed;
  }
  S.lastEvaluated = Game.time;
}

function plannerToLayout(plan) {
  if (!plan || !plan.desiredCountsByRole) return [];
  var counts = plan.desiredCountsByRole;
  var layout = [];
  var meleeNeed = counts.CombatMelee || 0;
  var archerNeed = counts.CombatArcher || 0;
  var medicNeed = counts.CombatMedic || 0;
  if (meleeNeed > 0) layout.push({ role: 'CombatMelee', need: meleeNeed });
  if (archerNeed > 0) layout.push({ role: 'CombatArcher', need: archerNeed });
  if (medicNeed > 0) layout.push({ role: 'CombatMedic', need: medicNeed });
  return layout;
}

// Keep spawning side-effects in one loop so it's obvious when we early return.
/**
 * spawnMissingSquadRole consumes desiredSquadLayout() output and asks
 * spawnRole() to create whichever role is currently missing, carrying
 * squadId/flag/target data along so combat creeps spawn ready to rally.
*/
function spawnMissingSquadRole(spawn, layout, id, targetRoom, avail, S, squadFlag, plan) {
  for (var i = 0; i < layout.length; i++) {
    var entry = layout[i];
    var need = typeof entry.need === 'number' ? entry.need : 0;
    if (need <= 0) continue;
    var have = haveSquadCount(id, entry.role);
    if (have < need) {
      var bodyCap = null;
      if (plan && plan.bodyTierCapByRole &&
          entry && entry.role && entry.role.indexOf('Combat') === 0 &&
          Object.prototype.hasOwnProperty.call(plan.bodyTierCapByRole, entry.role)) {
        bodyCap = plan.bodyTierCapByRole[entry.role];
      }
      var extraMemory = {
        squadId: id,
        role: entry.role,
        targetRoom: targetRoom,
        squadFlag: squadFlag,
        skipTaskMemory: true
      };
      if (typeof bodyCap === 'number') {
        extraMemory.combatBodyTierCap = bodyCap;
      }
      var ok = spawnRole(spawn, entry.role, avail, extraMemory);
      if (ok) {
        S.lastSpawnAt = Game.time;
        S.lastSpawnRole = entry.role;
        combatSpawnLog('[SpawnSquad]', id, 'role', entry.role, 'room', targetRoom,
          'flag', squadFlag || 'n/a', 'via', spawn.name);
        return true;
      }
      combatSpawnLog('[SpawnSquadFail]', id, 'role', entry.role, 'room', targetRoom,
        'flag', squadFlag || 'n/a', 'via', spawn.name);
      return false;
    }
  }
  return false;
}

// The exported entry point becomes a tidy checklist: resolve target ->
// evaluate plan -> spawn missing roles.
/**
 * Spawn_Squad ties SquadFlagIntel → desiredSquadLayout → spawnMissingSquadRole
 * together. It is the only exported entry for squad spawning so every caller
 * benefits from consistent threat gating + logging.
 */
function Spawn_Squad(spawn, squadId) {
  var id = squadId || 'Alpha';
  if (!spawn || spawn.spawning) return false;

  var S = ensureSquadMemory(id);
  var flagData = SquadFlagIntel && typeof SquadFlagIntel.resolveSquadTarget === 'function'
    ? SquadFlagIntel.resolveSquadTarget(id)
    : { flag: null, targetRoom: null };
  var targetRoom = normalizeRoomName(flagData.targetRoom);
  if (!targetRoom) return false;
  if (distanceTooFar(spawn.room.name, targetRoom)) return false;

  var threatScore = SquadFlagIntel && typeof SquadFlagIntel.threatScoreForRoom === 'function'
    ? SquadFlagIntel.threatScoreForRoom(targetRoom)
    : 0;
  var live = null;
  if (BeeCombatSquads && typeof BeeCombatSquads.getLiveThreatForRoom === 'function') {
    live = BeeCombatSquads.getLiveThreatForRoom(targetRoom);
    if (live && live.score > threatScore) {
      threatScore = live.score;
    }
  }
  var safeThreatScore = typeof threatScore === 'number' ? threatScore : 0;
  if (safeThreatScore <= 0 && (!live || !live.hasThreat)) {
    combatSpawnLog('[SpawnSkip]', id, 'room', targetRoom, 'score', safeThreatScore,
      'liveScore', live ? live.score : 0);
    return false;
  }
  var planner = combatPlanner(spawn, id, flagData, safeThreatScore, live);
  if (!planner.allowSpawn) {
    combatSpawnLog('[SpawnDeny]', id, 'room', targetRoom, 'reason', planner.denyReason,
      'econ', planner.economyState, 'fight', planner.fightType);
    return false;
  }

  var layout = plannerToLayout(planner);
  if (!layout.length) return false;

  stampSquadPlanMemory(S, layout, targetRoom, safeThreatScore, flagData.flag);
  S.combatPlan = {
    economyState: planner.economyState,
    maturity: planner.maturity,
    fightType: planner.fightType,
    threatTier: planner.threatTier,
    bodyTierCapByRole: planner.bodyTierCapByRole,
    reinforcementMode: planner.reinforcementMode,
    denyReason: planner.denyReason || null,
    desiredCounts: planner.desiredCountsByRole
  };

  if (S.lastSpawnAt && Game.time - S.lastSpawnAt < planner.squadCooldownTicks) {
    return false;
  }

  var avail = Calculate_Spawn_Resource(spawn);
  combatSpawnLog('[SpawnEval]', id, 'room', targetRoom, 'score', threatScore,
    'layout', JSON.stringify(layout));
  return spawnMissingSquadRole(spawn, layout, id, targetRoom, avail, S,
    flagData.flag ? flagData.flag.name : null, planner);
}

// -----------------------------------------------------------------------------
// minEnergyFor cache
// -----------------------------------------------------------------------------
var MIN_ENERGY_CACHE = {};

function minEnergyFor(roleName) {
  var canonicalRole = normalizeRole(roleName);
  if (!canonicalRole) return 0;
  if (Object.prototype.hasOwnProperty.call(MIN_ENERGY_CACHE, canonicalRole)) {
    return MIN_ENERGY_CACHE[canonicalRole];
  }
  var list = getRoleBodyCatalog(canonicalRole, null);
  if (!list || !list.length) {
    MIN_ENERGY_CACHE[canonicalRole] = 0;
    return 0;
  }
  var minCost = null;
  for (var i = 0; i < list.length; i++) {
    var cost = calculateBodyCost(list[i]);
    if (minCost === null || cost < minCost) {
      minCost = cost;
    }
  }
  var finalCost = minCost === null ? 0 : minCost;
  MIN_ENERGY_CACHE[canonicalRole] = finalCost;
  return finalCost;
}

module.exports = {
  ROLE_CONFIGS: ROLE_CONFIGS,
  normalizeRole: normalizeRole,
  getBodyForRole: getBodyForRole,
  spawnRole: spawnRole,
  minEnergyFor: minEnergyFor,
  Calculate_Spawn_Resource: Calculate_Spawn_Resource,
  Generate_Creep_Name: Generate_Creep_Name,
  Spawn_Squad: Spawn_Squad
};
