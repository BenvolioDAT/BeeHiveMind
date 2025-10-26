"use strict";

// ---------- Logging ----------
var Logger = require('core.logger');
var LOG_LEVEL = Logger.LOG_LEVEL;
var spawnLog = Logger.createLogger('Spawn', LOG_LEVEL.BASIC);

// ---------- Local Helpers (detached from BeeToolbox) ----------
var HARVESTER_DEFAULTS = { MAX_WORK: 6, RENEWAL_TTL: 150, EMERGENCY_TTL: 50 };
var GLOBAL_REF = (typeof global !== 'undefined') ? global : null;
var HARVESTER_CFG = (GLOBAL_REF && GLOBAL_REF.__beeHarvesterConfig && typeof GLOBAL_REF.__beeHarvesterConfig === 'object')
  ? GLOBAL_REF.__beeHarvesterConfig
  : HARVESTER_DEFAULTS;

function costOfBody(body) {
  if (!Array.isArray(body) || !body.length) return 0;
  var total = 0;
  for (var i = 0; i < body.length; i++) {
    var part = body[i];
    total += BODYPART_COST[part] || 0;
  }
  return total;
}

function cloneBody(body) {
  if (!Array.isArray(body)) return [];
  return body.slice();
}

function normalizeBodyTier(entry) {
  if (!entry) return null;
  var body = null;
  var cost = null;

  if (Array.isArray(entry)) {
    body = entry;
  } else if (entry && Array.isArray(entry.body)) {
    body = entry.body;
    if (typeof entry.cost === 'number') cost = entry.cost;
  } else if (entry && Array.isArray(entry.parts)) {
    body = entry.parts;
    if (typeof entry.cost === 'number') cost = entry.cost;
  }

  if (!body || !body.length) return null;

  var normalized = { body: body.slice() };
  normalized.cost = (cost != null) ? cost : costOfBody(body);
  if (normalized.cost <= 0) return null;
  return normalized;
}

function evaluateBodyTiers(tiers, available, capacity) {
  var normalized = [];
  if (Array.isArray(tiers)) {
    for (var i = 0; i < tiers.length; i++) {
      var norm = normalizeBodyTier(tiers[i]);
      if (norm) normalized.push(norm);
    }
  }

  var result = {
    tiers: normalized,
    availableBody: [],
    availableCost: 0,
    capacityBody: [],
    capacityCost: 0,
    idealBody: [],
    idealCost: 0,
    minCost: 0
  };

  if (!normalized.length) {
    return result;
  }

  var first = normalized[0];
  var last = normalized[normalized.length - 1];
  result.idealBody = first.body.slice();
  result.idealCost = first.cost;
  result.minCost = last.cost;

  var foundCapacity = false;
  for (var j = 0; j < normalized.length; j++) {
    var tier = normalized[j];
    if (!foundCapacity && tier.cost <= capacity) {
      result.capacityBody = tier.body.slice();
      result.capacityCost = tier.cost;
      foundCapacity = true;
    }
    if (!result.availableBody.length && tier.cost <= available) {
      result.availableBody = tier.body.slice();
      result.availableCost = tier.cost;
    }
  }

  if (!foundCapacity) {
    result.capacityBody = last.body.slice();
    result.capacityCost = last.cost;
  }

  if (!result.availableBody.length && result.capacityBody.length && result.capacityCost <= available) {
    result.availableBody = result.capacityBody.slice();
    result.availableCost = result.capacityCost;
  }

  return result;
}

function selectAffordableBody(configs, available, capacity) {
  var list = Array.isArray(configs) ? configs : [];
  var targetCapacity = (capacity != null) ? capacity : available;
  var info = evaluateBodyTiers(list, available || 0, targetCapacity || 0);
  var body = [];
  if (info && info.availableBody && info.availableBody.length) {
    body = info.availableBody.slice();
  }
  var cost = 0;
  if (info && typeof info.availableCost === 'number' && info.availableCost > 0) {
    cost = info.availableCost;
  } else if (body.length) {
    cost = costOfBody(body);
  }
  return {
    body: body,
    cost: cost,
    minCost: info ? info.minCost : 0,
    info: info
  };
}

function countBodyParts(body, part) {
  if (!Array.isArray(body) || !body.length) return 0;
  var total = 0;
  for (var i = 0; i < body.length; i++) {
    if (body[i] === part) total++;
  }
  return total;
}

function isValidRoomName(name) {
  if (typeof name !== 'string') return false;
  return /^[WE]\d+[NS]\d+$/.test(name);
}

function safeLinearDistance(a, b, allowInexact) {
  if (!isValidRoomName(a) || !isValidRoomName(b)) {
    return 9999;
  }
  if (!Game || !Game.map || typeof Game.map.getRoomLinearDistance !== 'function') {
    return 9999;
  }
  return Game.map.getRoomLinearDistance(a, b, allowInexact);
}

function repeatPart(target, part, count) {
  for (var i = 0; i < count; i++) {
    target.push(part);
  }
}
// ---------- Shorthand Body Builders ----------
// B(w,c,m) creates [WORK x w, CARRY x c, MOVE x m]
function B(w, c, m) {
  var arr = [];
  repeatPart(arr, WORK, w);
  repeatPart(arr, CARRY, c);
  repeatPart(arr, MOVE, m);
  return arr;
}
// CM(c,m) = [CARRY x c, MOVE x m]
function CM(c, m) {
  var arr = [];
  repeatPart(arr, CARRY, c);
  repeatPart(arr, MOVE, m);
  return arr;
}
// WM(w,m) = [WORK x w, MOVE x m]
function WM(w, m) {
  var arr = [];
  repeatPart(arr, WORK, w);
  repeatPart(arr, MOVE, m);
  return arr;
}
// MH(m,h) = [MOVE x m, HEAL x h]
function MH(m, h) {
  var arr = [];
  repeatPart(arr, MOVE, m);
  repeatPart(arr, HEAL, h);
  return arr;
}
// TAM(t,a,m) = [TOUGH x t, ATTACK x a, MOVE x m]
function TAM(t, a, m) {
  var arr = [];
  repeatPart(arr, TOUGH, t);
  repeatPart(arr, ATTACK, a);
  repeatPart(arr, MOVE, m);
  return arr;
}
// R(t,r,m) = [TOUGH x t, RANGED_ATTACK x r, MOVE x m]
function R(t, r, m) {
  var arr = [];
  repeatPart(arr, TOUGH, t);
  repeatPart(arr, RANGED_ATTACK, r);
  repeatPart(arr, MOVE, m);
  return arr;
}
// A(...) = mixed arms builder for quick experiments
function A(t, a, r, h, w, c, m) {
  var arr = [];
  repeatPart(arr, TOUGH, t);
  repeatPart(arr, ATTACK, a);
  repeatPart(arr, RANGED_ATTACK, r);
  repeatPart(arr, HEAL, h);
  repeatPart(arr, WORK, w);
  repeatPart(arr, CARRY, c);
  repeatPart(arr, MOVE, m);
  return arr;
}
// C(c,m) = [CLAIM x c, MOVE x m]
function C(c, m) {
  var arr = [];
  repeatPart(arr, CLAIM, c);
  repeatPart(arr, MOVE, m);
  return arr;
}

// ---------- Role Configs (largest first is preferred) ----------
var CONFIGS = {
  // Workers
  baseharvest: [
    // ≥850 energy → full miner (6 WORK cap via HARVESTER_CFG)
    B(6,0,5),
    // 800–849 energy → beefy workhorse, adds carry buffer for link/container handoff
    B(5,0,5),
    // 650–799 energy → mid-tier miner with carry assist
    B(4,0,4),
    // 500–649 energy → bridge tier while expanding extensions
    B(3,0,3),
    // 350–499 energy → starter miner once extensions unlock
    B(2,0,2),
    // <350 energy → emergency spawn (RCL1 bootstrap)
    B(1,0,1)
  ],
  courier: [
    CM(30,15),
    CM(23,23),
    CM(22,22),
    CM(21,21),
    CM(20,20),
    CM(19,19),
    CM(18,18),
    CM(17,17),
    CM(16,16),
    CM(15,15),
    CM(14,14),
    CM(13,13),
    CM(12,12),
    CM(11,11),
    CM(10,10),
    CM(9,9),
    CM(8,8),
    CM(7,7),
    CM(6,6),
    CM(5,5),
    CM(4,4),
    CM(3,3),
    CM(2,2),
    CM(1,1)
  ],
  builder: [
    B(6,12,18),
    // Long-haul “road layer” — balanced for 2–3 rooms out
    B(4, 8, 12),   // 1200 energy, 24 parts, 400 carry
    // Mid-range — solid for 1–2 rooms out
    B(3, 6, 9),    // 900 energy, 18 parts, 300 carry
    // Budget scout/seed — starter road + container drop
    B(2, 4, 6),    // 600 energy, 12 parts, 200 carry
    // Emergency mini — drops a container + token road
    B(2, 2, 4),    // 500 energy, 8 parts, 100 carry
    // Starter body for RCL2+ rooms to guarantee at least one builder
    B(1, 2, 3),
    B(1, 1, 2),
    B(1, 1, 1),     // 300 energy, 5 parts, 100 carry
  ],
  upgrader: [
    // Larger bodies listed first so higher RCLs still prefer beefier creeps
    B(8,8,8),
    B(8,7,7),
    B(8,6,6),
    B(8,5,5),
    B(8,4,4),
    B(7,4,4),
    B(6,4,4),
    B(5,4,4),
    B(4,4,4),
    B(4,3,4),
    B(3,2,4),
    B(3,1,4),
    B(2,1,3),
    B(1,1,2),
    B(1,1,1),
  ],
  remoteMiner: [
    B(6,1,4),
    B(5,1,4),
    B(4,1,3),
    B(3,1,3),
    B(2,1,2),
    B(1,1,1)
  ],
  remoteHauler: [
    CM(25,13),
    CM(20,10),
    CM(18,9),
    CM(15,8),
    CM(12,6),
    CM(10,5),
    CM(8,4),
    CM(6,3),
    CM(4,2),
    CM(2,1),
    CM(1,1)
  ],
  reserver: [
    C(2,2),
    C(1,2),
    C(1,1)
  ],
  repair: [
    B(5,2,7),
    B(4,1,5),
    B(2,1,3)
  ],
  Queen: [ // keeping capitalization to match your original key
    B(0,22,22),
    B(0,21,21),
    B(0,20,20),
    B(0,19,19),
    B(0,18,18),
    B(0,17,17),
    B(0,16,16),
    B(0,15,15),
    B(0,14,14),
    B(0,13,13),
    B(0,12,12),
    B(0,11,11),
    B(0,10,10),
    B(0,9,9),
    B(0,8,8),
    B(0,7,7),
    B(0,6,6),
    B(0,5,5),
    B(0,4,4),
    B(0,3,3),
    B(0,2,2),
    B(0,1,1)
  ],
  luna: [
    B(3,6,5),
    B(3,5,4),
    B(3,4,3),
    B(3,3,3),
    B(3,2,2),
    B(2,2,2),
    B(1,1,1)
  ],
  Scout: [
    B(0,0,1)
  ],

  // Combat
  CombatMelee: [
    //TAM(6,6,12),
    TAM(4,4,8),
    TAM(1,1,2)
  ],
  CombatArcher: [
    //R(6,8,14),
    //R(4,6,10),//1140
    R(2,4,6),
    R(1,2,3)
  ],
  CombatMedic: [
   // MH(12,12),
   // MH(10,10),
    //MH(8,8),
    //MH(6,6),
   // MH(5,5),
    //MH(4,4),
    //MH(3,3),
    MH(2,2),
    MH(1,1)
  ],
  Dismantler: [
    //WM(25,25),
    //WM(20,20),
    //WM(15,15),
    WM(5,5)
  ],

  // Special
  Claimer: [
    //C(4,4),
    //C(3,3),
    C(2,2),
    C(1,1)
  ]
};

function resolveHarvesterConfigs() {
  var configs = CONFIGS.baseharvest || [];
  if (!HARVESTER_CFG || typeof HARVESTER_CFG.MAX_WORK !== 'number') {
    return configs;
  }
  var filtered = [];
  for (var i = 0; i < configs.length; i++) {
    var body = configs[i];
    if (!body || !body.length) {
      continue;
    }
    var workCount = countBodyParts(body, WORK);
    if (workCount > HARVESTER_CFG.MAX_WORK) {
      continue;
    }
    filtered.push(body);
  }
  return filtered.length ? filtered : configs;
}

function generateBodyFromConfig(taskKey, availableEnergy, capacityEnergy) {
  var list = CONFIGS[taskKey];
  if (!list) {
    if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
      spawnLog.debug('No config for task:', taskKey);
    }
    return [];
  }
  var selection = selectAffordableBody(list, availableEnergy, capacityEnergy != null ? capacityEnergy : availableEnergy);
  if (selection.body.length) {
    if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
      spawnLog.debug('Picked', taskKey, 'body:', '[' + selection.body + ']', 'cost', selection.cost, '(avail', availableEnergy + ')');
    }
    return selection.body;
  }
  if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
    var minCost = selection.minCost || 0;
    if (minCost > 0) {
      spawnLog.debug('Insufficient energy for', taskKey, '(need at least', minCost, ')');
    } else {
      spawnLog.debug('Insufficient energy for', taskKey, '(no valid tiers)');
    }
  }
  return [];
}

function getHarvesterBodyForEnergy(energyAvailable) {
  var configs = resolveHarvesterConfigs();
  var info = evaluateBodyTiers(configs, energyAvailable || 0, energyAvailable || 0);
  if (info && info.availableBody && info.availableBody.length) {
    return info.availableBody;
  }
  return [];
}

function getBestHarvesterBody(roomOrCapacity) {
  var capacity = 0;
  if (roomOrCapacity && typeof roomOrCapacity.energyCapacityAvailable === 'number') {
    capacity = roomOrCapacity.energyCapacityAvailable;
  } else if (typeof roomOrCapacity === 'number') {
    capacity = roomOrCapacity;
  }
  var configs = resolveHarvesterConfigs();
  var info = evaluateBodyTiers(configs, capacity || 0, capacity || 0);
  if (info && info.capacityBody && info.capacityBody.length) {
    return info.capacityBody;
  }
  if (info && info.idealBody && info.idealBody.length) {
    return info.idealBody;
  }
  return [];
}

function selectBuilderBody(capacityEnergy, availableEnergy) {
  var configs = CONFIGS.builder || [];
  if (!configs.length) return [];
  var cap = (capacityEnergy != null) ? capacityEnergy : availableEnergy;
  var info = evaluateBodyTiers(configs, availableEnergy || 0, cap || 0);
  if (info && info.availableBody && info.availableBody.length) {
    return info.availableBody;
  }
  return [];
}

function Generate_Body_From_Config(taskKey, energyAvailable, capacityEnergy) {
  return generateBodyFromConfig(taskKey, energyAvailable, capacityEnergy);
}

// ---------- Task Aliases (normalize user-facing names) ----------
// This lets getBodyForTask('Trucker') resolve to courier configs, etc.
var TASK_ALIAS = {
  trucker: 'courier',
  queen: 'Queen',
  scout: 'Scout',
  claimer: 'Claimer',
  remoteharvest: 'luna'
  // pass-throughs (lowercased) will resolve automatically if present
};

// ---------- Energy Accounting ----------
// Returns *total available* energy across all spawns + extensions.
// Returns energy available for spawning.
// - If you pass a spawn, room, or roomName => returns that ROOM's energy (spawns + extensions).
// - If you pass nothing => falls back to empire-wide total (old behavior).
function Calculate_Spawn_Resource(spawnOrRoom) {
  // Per-room mode
  if (spawnOrRoom) {
    var room =
      (spawnOrRoom.room && spawnOrRoom.room) ||           // a spawn (or structure)
      (typeof spawnOrRoom === 'string' ? Game.rooms[spawnOrRoom] : spawnOrRoom); // roomName or Room
    if (!room) return 0;

    // Fast, built-in sum of spawns+extensions for this room
    return room.energyAvailable;
  }

  // ---- Backward-compat (empire-wide) ----
  var spawnEnergy = 0;
  for (var name in Game.spawns) {
    if (!Object.prototype.hasOwnProperty.call(Game.spawns, name)) continue;
    spawnEnergy += Game.spawns[name].store[RESOURCE_ENERGY] || 0;
  }
  var extensionEnergy = _.sum(Game.structures, function (s) {
    return s.structureType === STRUCTURE_EXTENSION ? (s.store[RESOURCE_ENERGY] || 0) : 0;
  });
  return spawnEnergy + extensionEnergy;
}

// ---------- Body Selection ----------

// Helper to normalize a requested task into a CONFIGS key.
function normalizeTask(task) {
  if (!task) return task;
  var lower = String(task).toLowerCase();
  var key = TASK_ALIAS[task] || TASK_ALIAS[lower] || task;
  return key;
}

// ---------- Role-specific wrappers (kept for API compatibility) ----------
function Generate_Courier_Body(e) { return Generate_Body_From_Config('courier', e); }
function Generate_BaseHarvest_Body(e) { return getHarvesterBodyForEnergy(e); }
function Generate_Builder_Body(e) { return Generate_Body_From_Config('builder', e); }
function Generate_Repair_Body(e) { return Generate_Body_From_Config('repair', e); }
function Generate_Queen_Body(e) { return Generate_Body_From_Config('Queen', e); }
function Generate_Luna_Body(e) { return Generate_Body_From_Config('luna', e); }
function Generate_RemoteMiner_Body(e) { return Generate_Body_From_Config('remoteMiner', e); }
function Generate_RemoteHauler_Body(e) { return Generate_Body_From_Config('remoteHauler', e); }
function Generate_Reserver_Body(e) { return Generate_Body_From_Config('reserver', e); }
function Generate_Upgrader_Body(e) { return Generate_Body_From_Config('upgrader', e); }
function Generate_Scout_Body(e) { return Generate_Body_From_Config('Scout', e); }
function Generate_CombatMelee_Body(e) { return Generate_Body_From_Config('CombatMelee', e); }
function Generate_CombatArcher_Body(e) { return Generate_Body_From_Config('CombatArcher', e); }
function Generate_CombatMedic_Body(e) { return Generate_Body_From_Config('CombatMedic', e); }
function Generate_Dismantler_Config_Body(e) { return Generate_Body_From_Config('Dismantler', e); }
function Generate_Claimer_Body(e) { return Generate_Body_From_Config('Claimer', e); }

// ---------- Task → Body helper (kept for API compatibility) ----------
function getBodyForTask(task, energyAvailable) {
  var key = normalizeTask(task);
  switch (key) {
    case 'builder':        return Generate_Builder_Body(energyAvailable);
    case 'repair':         return Generate_Repair_Body(energyAvailable);
    case 'baseharvest':    return Generate_BaseHarvest_Body(energyAvailable);
    case 'upgrader':       return Generate_Upgrader_Body(energyAvailable);
    case 'courier':        return Generate_Courier_Body(energyAvailable);
    case 'luna':           return Generate_Luna_Body(energyAvailable);
    case 'Scout':          return Generate_Scout_Body(energyAvailable);
    case 'Queen':          return Generate_Queen_Body(energyAvailable);
    case 'CombatArcher':   return Generate_CombatArcher_Body(energyAvailable);
    case 'CombatMelee':    return Generate_CombatMelee_Body(energyAvailable);
    case 'CombatMedic':    return Generate_CombatMedic_Body(energyAvailable);
    case 'Dismantler':     return Generate_Dismantler_Config_Body(energyAvailable);
    case 'Claimer':        return Generate_Claimer_Body(energyAvailable);
    // Aliases
    case 'trucker':        return Generate_Courier_Body(energyAvailable);
    default:
      if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
        spawnLog.debug('Unknown task:', task);
      }
      return [];
  }
}

// ---------- Naming ----------
function Generate_Creep_Name(role, max) {
  var limit = typeof max === 'number' ? max : 70;
  for (var i = 1; i <= limit; i++) {
    var name = role + '_' + i;
    if (!Game.creeps[name]) return name;
  }
  return null; // ran out of slots
}

// ---------- Spawn Helpers ----------
// Spawns a role using a provided body-gen function; merges memory.role automatically.
function Spawn_Creep_Role(spawn, roleName, generateBodyFn, availableEnergy, memory) {
  var mem = memory || {};
  var body = generateBodyFn(availableEnergy);
  var bodyCost = costOfBody(body);

  if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
    spawnLog.debug('Attempt', roleName, 'body=[' + body + ']', 'cost=' + bodyCost, 'avail=' + availableEnergy);
  }

  if (!body.length || availableEnergy < bodyCost) {
    if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
      spawnLog.debug('Not enough energy for', roleName + '.', 'Need', bodyCost, 'have', availableEnergy + '.');
    }
    return false;
  }

  var name = Generate_Creep_Name(roleName);
  if (!name) return false;

  mem.role = roleName; // ensure role is set
  var result = spawn.spawnCreep(body, name, { memory: mem });

  if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
    spawnLog.debug('Result', roleName + '/' + name + ':', result);
  }
  if (result === OK) {
    if (Logger.shouldLog(LOG_LEVEL.BASIC)) {
      spawnLog.info('🟢 Spawned', roleName + ':', name);
    }
    return true;
  }
  return false;
}

// Spawns a generic "Worker_Bee" with a task (kept for your existing callsites).
function Spawn_Worker_Bee(spawn, neededTask, availableEnergy, extraMemory) {
  var energy = typeof availableEnergy === 'number' ? availableEnergy : Calculate_Spawn_Resource(spawn);
  if (!energy || energy < 0) {
    energy = 0;
  }

  var normalizedTask = normalizeTask(neededTask);
  var normalizedLower = normalizedTask ? String(normalizedTask).toLowerCase() : '';
  var body;
  var overrideBody = (extraMemory && extraMemory._harvesterBodyOverride) ? extraMemory._harvesterBodyOverride : null;

  if (overrideBody && overrideBody.length) {
    body = cloneBody(overrideBody);
  } else if (normalizedLower === 'builder') {
    var capacity = 0;
    if (spawn && spawn.room) {
      capacity = spawn.room.energyCapacityAvailable || 0;
    }
    if (capacity < energy) {
      capacity = energy;
    }
    body = selectBuilderBody(capacity, energy);
  } else if (normalizedLower === 'baseharvest' && spawn && spawn.room) {
    body = getBestHarvesterBody(spawn.room);
  } else {
    body = getBodyForTask(neededTask, energy);
  }

  if (extraMemory && extraMemory._harvesterBodyOverride) {
    delete extraMemory._harvesterBodyOverride;
  }

  if (!body || !body.length) {
    if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
      spawnLog.debug('No body available for', neededTask, 'energy', energy);
    }
    return false;
  }
  var name = Generate_Creep_Name(neededTask || 'Worker');
  var memory = {
    role: 'Worker_Bee',
    task: neededTask,
    bornTask: neededTask,
    birthBody: body.slice()
  };
  if (extraMemory) {
    for (var key in extraMemory) {
      if (Object.prototype.hasOwnProperty.call(extraMemory, key)) {
        memory[key] = extraMemory[key];
      }
    }
  }
  var res = spawn.spawnCreep(body, name, { memory: memory });
  if (res === OK) {
    if (Logger.shouldLog(LOG_LEVEL.BASIC)) {
      spawnLog.info('🟢 Spawned Creep:', name, 'for task', neededTask);
    }
    return true;
  }
  return false;
}

// --- REPLACE your existing Spawn_Squad with this hardened version ---
function Spawn_Squad(spawn, squadId) {
  var squadName = typeof squadId === 'string' ? squadId : 'Alpha';
  if (!spawn || spawn.spawning) return false;

  // Per-squad memory book-keeping to avoid rapid duplicate spawns
  if (!Memory.squads) Memory.squads = {};
  if (!Memory.squads[squadName]) Memory.squads[squadName] = {};
  var S = Memory.squads[squadName];
  var COOLDOWN_TICKS = 3;                  // don’t spawn same-squad twice within 5 ticks

  function desiredLayout(score) {
    var threat = score | 0;
    var melee = 1;
    var medic = 1;
    var archer = 0;

    if (threat >= 12) melee = 2;
    if (threat >= 18) medic = 2;
    if (threat >= 10 && threat < 22) archer = 1;
    else if (threat >= 22) archer = 2;

    var order = [
      { role: 'CombatMelee', need: melee }
    ];
    if (archer > 0) order.push({ role: 'CombatArcher', need: archer });
    order.push({ role: 'CombatMedic', need: medic });
    return order;
  }

  var flagName = 'Squad' + squadName;
  var altFlagName = 'Squad_' + squadName;
  var flag = Game.flags[flagName] || Game.flags[altFlagName] || Game.flags[squadName] || null;
  var squadFlagsMem = Memory.squadFlags || {};
  var bindings = squadFlagsMem.bindings || {};

  var targetRoom = bindings[flagName] || bindings[altFlagName] || bindings[squadName] || null;
  if (!targetRoom && flag && flag.pos) targetRoom = flag.pos.roomName;
  if (!targetRoom) return false;

  var dist = safeLinearDistance(spawn.room.name, targetRoom, true);
  if (dist > 3) return false; // too far to be considered "nearby"

  var roomInfo = (squadFlagsMem.rooms && squadFlagsMem.rooms[targetRoom]) || null;
  var threatScore = roomInfo && typeof roomInfo.lastScore === 'number' ? roomInfo.lastScore : 0;
  var layout = desiredLayout(threatScore);
  if (!layout.length) return false;

  S.targetRoom = targetRoom;
  S.lastKnownScore = threatScore;
  S.flagName = flag ? flag.name : null;
  S.desiredCounts = {};
  for (var li = 0; li < layout.length; li++) {
    S.desiredCounts[layout[li].role] = layout[li].need | 0;
  }
  S.lastEvaluated = Game.time;

  // Count squad members by role (includes spawning eggs)
  function haveCount(taskName) {
    // count live creeps
    var live = _.sum(Game.creeps, function (c) {
      return c.my && c.memory && c.memory.squadId === squadName && c.memory.task === taskName ? 1 : 0;
    });
    // count "eggs" currently spawning (Memory is set immediately when you spawn)
    var hatching = _.sum(Memory.creeps, function (mem, name) {
      if (!mem) return 0;
      if (mem.squadId !== squadName) return 0;
      if (mem.task !== taskName) return 0;
      // Only count if not yet in Game.creeps (i.e., still spawning)
      return Game.creeps[name] ? 0 : 1;
    });
    return live + hatching;
  }

  // Simple cooldown guard
  if (S.lastSpawnAt && (Game.time - S.lastSpawnAt) < COOLDOWN_TICKS) {
    return false;
  }

  var avail = Calculate_Spawn_Resource(spawn);

  // Find the first underfilled slot (in order) and spawn exactly one
  for (var i = 0; i < layout.length; i++) {
    var plan = layout[i];
    if ((plan.need | 0) <= 0) continue;
    var have = haveCount(plan.role);

    if (have < plan.need) {
      var extraMemory = { squadId: squadName, role: plan.role, targetRoom: targetRoom };
      var ok = Spawn_Worker_Bee(spawn, plan.role, avail, extraMemory);
      if (ok) {
        S.lastSpawnAt = Game.time;
        S.lastSpawnRole = plan.role;
        return true;
      } else {
        // If we failed due to energy, bail; don’t try other roles this tick
        return false;
      }
    }
  }

  // Nothing missing → ensure cooldown resets slowly (optional)
  return false;
}

function _isKnownSquadId(name) {
  if (typeof name !== 'string') return false;
  if (Memory && Memory.squads && Memory.squads[name]) return true;
  var flags = Game && Game.flags ? Game.flags : {};
  if (flags['Squad' + name]) return true;
  if (flags['Squad_' + name]) return true;
  if (flags[name]) return true;
  return false;
}

function Spawn_Squad_Compat(spawn, arg1, arg2) {
  if (!spawn) return false;
  // Legacy callers may pass (spawn, squadId)
  if (_isKnownSquadId(arg1)) {
    return Spawn_Squad(spawn, arg1);
  }

  var plan = null;
  if (arg1 && typeof arg1 === 'object') {
    plan = arg1;
  } else if (arg2 && typeof arg2 === 'object') {
    plan = arg2;
  }

  var squadId = 'Alpha';
  if (plan && typeof plan.squadId === 'string') {
    squadId = plan.squadId;
  } else if (typeof arg1 === 'string' && !_isKnownSquadId(arg1)) {
    squadId = 'Alpha';
  } else if (typeof arg1 === 'string') {
    squadId = arg1;
  }

  // If caller provided a role, spawn a single member using worker helper.
  var role = null;
  if (typeof arg1 === 'string' && !_isKnownSquadId(arg1)) {
    role = arg1;
  }
  if (plan && typeof plan.role === 'string') {
    role = plan.role;
  }

  if (!role) {
    return Spawn_Squad(spawn, squadId);
  }

  var energy = Calculate_Spawn_Resource(spawn);
  var extraMemory = { squadId: squadId, role: role };
  if (plan && plan.targetRoom) {
    extraMemory.targetRoom = plan.targetRoom;
  }
  return Spawn_Worker_Bee(spawn, role, energy, extraMemory);
}

function buildConfigurationsExport() {
  var list = [];
  for (var task in CONFIGS) {
    if (!Object.prototype.hasOwnProperty.call(CONFIGS, task)) continue;
    list.push({ task: task, body: CONFIGS[task] });
  }
  return list;
}

// ---------- Exports ----------
module.exports = {
  // utilities
  Generate_Creep_Name: Generate_Creep_Name,
  Calculate_Spawn_Resource: Calculate_Spawn_Resource,
  configurations: buildConfigurationsExport(), // preserve your original shape
  Generate_Body_From_Config: Generate_Body_From_Config,
  Spawn_Creep_Role: Spawn_Creep_Role,
  // + new helper
  Spawn_Squad: Spawn_Squad,
  // role generators (compat)
  Generate_Courier_Body: Generate_Courier_Body,
  Generate_BaseHarvest_Body: Generate_BaseHarvest_Body,
  Generate_Upgrader_Body: Generate_Upgrader_Body,
  Generate_Builder_Body: Generate_Builder_Body,
  Generate_Repair_Body: Generate_Repair_Body,
  Generate_RemoteMiner_Body: Generate_RemoteMiner_Body,
  Generate_RemoteHauler_Body: Generate_RemoteHauler_Body,
  Generate_Reserver_Body: Generate_Reserver_Body,
  Generate_Queen_Body: Generate_Queen_Body,
  Generate_Luna_Body: Generate_Luna_Body,
  Generate_Scout_Body: Generate_Scout_Body,
  Generate_CombatMelee_Body: Generate_CombatMelee_Body,
  Generate_CombatArcher_Body: Generate_CombatArcher_Body,
  Generate_CombatMedic_Body: Generate_CombatMedic_Body,
  Generate_Dismantler_Config_Body: Generate_Dismantler_Config_Body,
  Generate_Claimer_Body: Generate_Claimer_Body,

  // existing helpers
  getBodyForTask: getBodyForTask,
  getBestHarvesterBody: getBestHarvesterBody,
  Spawn_Worker_Bee: Spawn_Worker_Bee,
  Spawn_Squad_Compat: Spawn_Squad_Compat
};
