"use strict";

/*
 * Design Notes: Adaptive BaseHarvester Scaling
 * ------------------------------------------------------------
 * Base harvesters are now scaled using the room's energy capacity.
 * Rooms step through predefined body tiers (small → medium → max)
 * as extensions are added. Replacement creeps respect the target
 * tier, preferring upgrades when the energy economy allows it and
 * falling back to emergency spawns only when necessary to preserve
 * uptime.
 */

// ---------- Logging ----------
var Logger = require('core.logger');
var BeeToolbox = require('BeeToolbox');
var LOG_LEVEL = Logger.LOG_LEVEL;
var spawnLog = Logger.createLogger('Spawn', LOG_LEVEL.BASIC);

var HARVESTER_CFG = BeeToolbox && BeeToolbox.HARVESTER_CFG
  ? BeeToolbox.HARVESTER_CFG
  : { MAX_WORK: 6, RENEWAL_TTL: 150, EMERGENCY_TTL: 50 };

function calculateBodyCost(body) {
  if (!body || !body.length) return 0;
  var cost = 0;
  for (var i = 0; i < body.length; i++) {
    var part = body[i];
    cost += BODYPART_COST[part] || 0;
  }
  return cost;
}

function countBodyParts(body, partType) {
  if (!body || !body.length) return 0;
  var total = 0;
  for (var i = 0; i < body.length; i++) {
    if (body[i] === partType) total++;
  }
  return total;
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
    B(5,1,5),
    // 650–799 energy → mid-tier miner with carry assist
    B(4,1,4),
    // 500–649 energy → bridge tier while expanding extensions
    B(3,1,3),
    // 350–499 energy → starter miner once extensions unlock
    B(2,1,2),
    // <350 energy → emergency spawn (RCL1 bootstrap)
    B(1,1,1)
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
    B(1, 2, 2)     // 300 energy, 5 parts, 100 carry
  ],
  upgrader: [
    // Larger bodies listed first so higher RCLs still prefer beefier creeps
    B(4,4,4),
    B(4,3,4),
    B(3,2,4),
    B(3,1,4),
    B(2,1,3),
    B(1,1,1)
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
    B(1,2,3),
    B(1,1,2),
    B(1,1,1)
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
    C(4,4),
    C(3,3),
    C(2,2),
    C(1,1)
  ]
};

function cloneBodyArray(body) {
  if (!body || !body.length) return [];
  var out = [];
  for (var i = 0; i < body.length; i++) {
    out.push(body[i]);
  }
  return out;
}

function buildHarvesterTiers() {
  var tiers = [];
  var configs = CONFIGS.baseharvest || [];
  for (var i = 0; i < configs.length; i++) {
    var body = configs[i];
    if (!body || !body.length) continue;
    var workCount = countBodyParts(body, WORK);
    if (HARVESTER_CFG && typeof HARVESTER_CFG.MAX_WORK === 'number' && workCount > HARVESTER_CFG.MAX_WORK) {
      continue;
    }
    tiers.push({ body: cloneBodyArray(body), cost: calculateBodyCost(body), work: workCount });
  }
  tiers.sort(function (a, b) { return a.cost - b.cost; });
  return tiers;
}

var HARVESTER_BODY_TIERS = buildHarvesterTiers();

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
// Returns the largest body from CONFIGS[taskKey] that fits energyAvailable.
function Generate_Body_From_Config(taskKey, energyAvailable) {
  var list = CONFIGS[taskKey];
  if (!list) {
    if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
      spawnLog.debug('No config for task:', taskKey);
    }
    return [];
  }
  for (var i = 0; i < list.length; i++) {
    var body = list[i];
    var cost = _.sum(body, function (part) { return BODYPART_COST[part]; }); // Screeps global
    if (cost <= energyAvailable) {
      if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
        spawnLog.debug('Picked', taskKey, 'body:', '[' + body + ']', 'cost', cost, '(avail', energyAvailable + ')');
      }
      return body;
    }
  }
  if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
    var last = list[list.length - 1];
    var minCost = _.sum(last, function (p) { return BODYPART_COST[p]; });
    spawnLog.debug('Insufficient energy for', taskKey, '(need at least', minCost, ')');
  }
  return [];
}

function getHarvesterBodyForEnergy(energyAvailable) {
  if (!HARVESTER_BODY_TIERS.length) return [];
  var best = null;
  for (var i = 0; i < HARVESTER_BODY_TIERS.length; i++) {
    var tier = HARVESTER_BODY_TIERS[i];
    if (tier.cost <= energyAvailable) {
      best = tier;
    } else {
      break;
    }
  }
  return best ? cloneBodyArray(best.body) : [];
}

function getBestHarvesterBody(room) {
  if (!HARVESTER_BODY_TIERS.length) return [];
  var capacity = 0;
  if (room && typeof room.energyCapacityAvailable === 'number') {
    capacity = room.energyCapacityAvailable;
  } else if (typeof room === 'number') {
    capacity = room;
  }
  var best = null;
  for (var i = 0; i < HARVESTER_BODY_TIERS.length; i++) {
    var tier = HARVESTER_BODY_TIERS[i];
    if (tier.cost <= capacity) {
      best = tier;
    } else {
      break;
    }
  }
  if (best) return cloneBodyArray(best.body);
  return cloneBodyArray(HARVESTER_BODY_TIERS[0].body);
}

function Select_Builder_Body(capacityEnergy, availableEnergy) {
  var configs = CONFIGS.builder;
  if (!configs || !configs.length) return [];

  var filtered = [];
  for (var i = 0; i < configs.length; i++) {
    var body = configs[i];
    if (!body || !body.length) continue;
    var cost = _.sum(body, function (part) { return BODYPART_COST[part]; }) || 0;
    if (!cost || cost > capacityEnergy) continue;

    var insertAt = filtered.length;
    for (var j = 0; j < filtered.length; j++) {
      if (cost > filtered[j].cost) {
        insertAt = j;
        break;
      }
    }
    filtered.splice(insertAt, 0, { index: i, cost: cost });
  }

  if (!filtered.length) return [];

  for (var k = 0; k < filtered.length; k++) {
    if (availableEnergy >= filtered[k].cost) {
      return configs[filtered[k].index];
    }
  }

  return [];
}

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
  var bodyCost = _.sum(body, function (p) { return BODYPART_COST[p]; }) || 0;

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
    body = cloneBodyArray(overrideBody);
  } else if (normalizedLower === 'builder') {
    var capacity = 0;
    if (spawn && spawn.room) {
      capacity = spawn.room.energyCapacityAvailable || 0;
    }
    if (capacity < energy) {
      capacity = energy;
    }
    body = Select_Builder_Body(capacity, energy);
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

  var dist = BeeToolbox.safeLinearDistance(spawn.room.name, targetRoom, true);
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
  Spawn_Worker_Bee: Spawn_Worker_Bee
};
