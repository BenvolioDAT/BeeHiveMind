"use strict";

// spawn.logic.js — cleaner, same behavior
// --------------------------------------------------------
// Purpose: Pick creep bodies by role/task from predefined configs,
//          spawn creeps with consistent names and memory,
//          and do it in a clean, beginner-friendly way.
//
// Notes for beginners:
// - In Screeps, body parts are strings like 'work', 'carry', 'move'.
// - BODYPART_COST is a global map: { move:50, work:100, carry:50, ... }.
// - We choose the *largest* body config that fits available energy.
// - Logging is gated by LOG_LEVEL; turn to DEBUG to see details.
// --------------------------------------------------------

// ---------- Logging ----------
const Logger = require('core.logger');
const LOG_LEVEL = Logger.LOG_LEVEL;
const spawnLog = Logger.createLogger('Spawn', LOG_LEVEL.BASIC);
const EconomyManager = require('EconomyManager');

const SQUAD_NAME_ORDER = ['Alpha', 'Bravo', 'Charlie', 'Delta'];
const HEAVY_THREAT_SCORE = 18;
const MIN_THREAT_SCORE = 5;
const STALE_THREAT_WINDOW = 150; // ticks after last threat sighting before we consider room calm

function _squadIndex(id) {
  if (!id) return -1;
  const key = id.replace(/^Squad/i, '').replace(/^_/, '');
  return SQUAD_NAME_ORDER.indexOf(key);
}

function _normalizeSquadId(id) {
  if (!id) return null;
  const idx = _squadIndex(id);
  return idx === -1 ? null : SQUAD_NAME_ORDER[idx];
}

function _gatherThreats() {
  const mem = Memory.squadFlags || {};
  const bindings = mem.bindings || {};
  const rooms = mem.rooms || {};
  const threats = [];

  for (const flagName in bindings) {
    if (!bindings.hasOwnProperty(flagName)) continue;
    const squadId = _normalizeSquadId(flagName);
    if (!squadId) continue;
    const roomName = bindings[flagName];
    const info = rooms[roomName] || {};
    const score = info.lastScore || 0;
    const lastThreatAt = info.lastThreatAt || 0;
    const recent = Game.time - lastThreatAt <= STALE_THREAT_WINDOW;
    if (score >= MIN_THREAT_SCORE || recent) {
      threats.push({
        squadId,
        flagName,
        roomName,
        score,
        lastThreatAt,
      });
    }
  }

  threats.sort(function (a, b) {
    if (b.score !== a.score) return b.score - a.score;
    return (b.lastThreatAt || 0) - (a.lastThreatAt || 0);
  });

  return threats;
}

function _desiredSquadCount(threats) {
  if (!threats || !threats.length) return 0;
  const top = threats[0];
  if (threats.length === 1) {
    return top.score >= HEAVY_THREAT_SCORE ? 2 : 1;
  }
  // Multiple simultaneous threats → at least two if we have them
  return Math.min(2, threats.length);
}

function _allowedSquadCount(room, threats) {
  const desired = _desiredSquadCount(threats);
  if (!EconomyManager || typeof EconomyManager.getLedger !== 'function') {
    return desired;
  }

  const ledger = EconomyManager.getLedger(room);
  if (!ledger) return desired;

  const stored = ledger.currentStored || 0;
  const avgNet = ledger.averageNet || 0;
  const avgIncome = ledger.averageIncome || 0;
  const avgSpend = ledger.averageSpend || 0;
  const historyLength = ledger.history ? ledger.history.length : 0;

  let allowed = desired;
  if (historyLength >= 5) {
    if (stored < 1500 || avgNet < 0) {
      allowed = Math.min(allowed, 1);
    }
    if (stored < 600 && avgIncome <= avgSpend) {
      allowed = Math.min(allowed, 1);
    }
    if (stored < 400 && avgNet <= 0) {
      allowed = Math.max(allowed, threats.length ? 1 : 0);
    }
  }

  return allowed;
}

function _currentSquadPlan(room) {
  if (!global.__squadSpawnPlan || global.__squadSpawnPlan.tick !== Game.time) {
    global.__squadSpawnPlan = { tick: Game.time, data: {} };
  }

  const cache = global.__squadSpawnPlan.data;
  const roomName = room && room.name;
  if (!roomName) return { allowed: 0, threats: [], bySquad: {}, desired: 0 };

  if (cache[roomName]) return cache[roomName];

  const threats = _gatherThreats();
  const desired = _desiredSquadCount(threats);
  const allowed = _allowedSquadCount(room, threats);
  const bySquad = {};

  for (let i = 0; i < threats.length; i++) {
    bySquad[threats[i].squadId] = threats[i];
  }

  const plan = { allowed, threats, bySquad, desired, highestThreat: threats.length ? threats[0].score : 0 };
  cache[roomName] = plan;
  return plan;
}

// ---------- Shorthand Body Builders ----------
// B(w,c,m) creates [WORK x w, CARRY x c, MOVE x m]
const B  = (w, c, m) => [
  ...Array(w).fill(WORK),
  ...Array(c).fill(CARRY),
  ...Array(m).fill(MOVE),
];
// CM(c,m) = [CARRY x c, MOVE x m]
const CM = (c, m) => [...Array(c).fill(CARRY), ...Array(m).fill(MOVE)];
// WM(w,m) = [WORK x w, MOVE x m]
const WM = (w, m) => [...Array(w).fill(WORK), ...Array(m).fill(MOVE)];
// MH(m,h) = [MOVE x m, HEAL x h]
const MH = (m, h) => [...Array(m).fill(MOVE), ...Array(h).fill(HEAL)];
// TAM(t,a,m) = [TOUGH x t, ATTACK x a, MOVE x m]
const TAM = (t, a, m) => [...Array(t).fill(TOUGH), ...Array(a).fill(ATTACK), ...Array(m).fill(MOVE)];
// R(t,r,m) = [TOUGH x t, RANGED_ATTACK x r, MOVE x m]
const R  = (t, r, m) => [...Array(t).fill(TOUGH), ...Array(r).fill(RANGED_ATTACK), ...Array(m).fill(MOVE)];
// A(...) = mixed arms builder for quick experiments
const A  = (t,a,r,h,w,c,m)=>[
  ...Array(t).fill(TOUGH),
  ...Array(a).fill(ATTACK),
  ...Array(r).fill(RANGED_ATTACK),
  ...Array(h).fill(HEAL),
  ...Array(w).fill(WORK),
  ...Array(c).fill(CARRY),
  ...Array(m).fill(MOVE),
];
// C(c,m) = [CLAIM x c, MOVE x m]
const C  = (c, m) => [...Array(c).fill(CLAIM), ...Array(m).fill(MOVE)];

// ---------- Role Configs (largest first is preferred) ----------
const CONFIGS = {
  // Workers
  baseharvest: [
    B(6,0,5), 
    B(5,1,5), 
    B(4,1,4), 
    B(3,1,3), 
    B(2,1,2), 
    B(1,1,1),
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
    CM(1,1),
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
    B(2, 2, 4)     // 400 energy, 8 parts, 100 carry
  ],
  upgrader: [
    //B(4,1,5), 
    B(2,1,3),
  ],
  repair: [
    B(5,2,7), 
    B(4,1,5), 
    B(2,1,3),
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
    B(1,1,1),
  ],
  luna: [
    //B(8,25,17), 
    //B(5,10,8), 
    //B(5,8,4),
    //B(5,8,13), 
    //B(5,6,11), 
    //B(5,4,9),
    //B(5,2,7), 
    //B(4,2,6),
    B(3,6,5), 
    B(3,5,4), 
    B(3,4,3), 
    B(3,3,3), 
    B(3,2,2,), 
    B(2,2,2), 
    B(1,1,1),
  ],
  Scout: [
    B(0,0,1),
  ],

  // Combat
  CombatMelee: [
    //TAM(6,6,12), 
    TAM(4,4,8), 
    TAM(1,1,2),
  ],
  CombatArcher: [
    //R(6,8,14), 
    //R(4,6,10),//1140 
    R(2,4,6), 
    R(1,2,3),
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
    MH(1,1),
  ],
  Dismantler: [
    //WM(25,25), 
    //WM(20,20), 
    //WM(15,15),
    WM(5,5),
  ],

  // Special
  Claimer: [
    C(4,4),
    C(3,3), 
    C(2,2), 
    C(1,1),
  ],
};

// ---------- Task Aliases (normalize user-facing names) ----------
// This lets getBodyForTask('Trucker') resolve to courier configs, etc.
const TASK_ALIAS = {
  trucker: 'courier',
  queen: 'Queen',
  scout: 'Scout',
  claimer: 'Claimer',
  remoteharvest: 'luna',
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
    let room =
      (spawnOrRoom.room && spawnOrRoom.room) ||           // a spawn (or structure)
      (typeof spawnOrRoom === 'string' ? Game.rooms[spawnOrRoom] : spawnOrRoom); // roomName or Room
    if (!room) return 0;

    // Fast, built-in sum of spawns+extensions for this room
    return room.energyAvailable;

    // If you ever want the manual sum instead, uncomment:
    /*
    let spawnEnergy = _.sum(room.find(FIND_MY_SPAWNS), s => s.store[RESOURCE_ENERGY] || 0);
    let extEnergy   = _.sum(room.find(FIND_MY_STRUCTURES, {filter: s => s.structureType === STRUCTURE_EXTENSION}),
                            s => s.store[RESOURCE_ENERGY] || 0);
    return spawnEnergy + extEnergy;
    */
  }

  // ---- Backward-compat (empire-wide) ----
  let spawnEnergy = 0;
  for (const name in Game.spawns) {
    spawnEnergy += Game.spawns[name].store[RESOURCE_ENERGY] || 0;
  }
  const extensionEnergy = _.sum(Game.structures, s =>
    s.structureType === STRUCTURE_EXTENSION ? (s.store[RESOURCE_ENERGY] || 0) : 0
  );
  return spawnEnergy + extensionEnergy;
}

// Optional: tweak your debug line to show per-room when you have a spawner handy
// if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
//   const anySpawn = Object.values(Game.spawns)[0];
//   spawnLog.debug(`[Energy empire=${Calculate_Spawn_Resource()} | room=${anySpawn ? Calculate_Spawn_Resource(anySpawn) : 0}]`);
// }


// ---------- Body Selection ----------
// Returns the largest body from CONFIGS[taskKey] that fits energyAvailable.
function Generate_Body_From_Config(taskKey, energyAvailable) {
  const list = CONFIGS[taskKey];
  if (!list) {
    if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
      spawnLog.debug('No config for task:', taskKey);
    }
    return [];
  }
  for (const body of list) {
    const cost = _.sum(body, part => BODYPART_COST[part]); // Screeps global
    if (cost <= energyAvailable) {
      if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
        spawnLog.debug('Picked', taskKey, 'body:', '[' + body + ']', 'cost', cost, '(avail', energyAvailable + ')');
      }
      return body;
    }
  }
  if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
    spawnLog.debug('Insufficient energy for', taskKey, '(need at least', _.sum(_.last(list), p => BODYPART_COST[p]), ')');
  }
  return [];
}

// Helper to normalize a requested task into a CONFIGS key.
function normalizeTask(task) {
  if (!task) return task;
  const key = TASK_ALIAS[task] || TASK_ALIAS[task.toLowerCase()] || task;
  return key;
}

// ---------- Role-specific wrappers (kept for API compatibility) ----------
const Generate_Courier_Body          = (e) => Generate_Body_From_Config('courier', e);
const Generate_BaseHarvest_Body      = (e) => Generate_Body_From_Config('baseharvest', e);
const Generate_Builder_Body          = (e) => Generate_Body_From_Config('builder', e);
const Generate_Repair_Body           = (e) => Generate_Body_From_Config('repair', e);
const Generate_Queen_Body            = (e) => Generate_Body_From_Config('Queen', e);
const Generate_Luna_Body             = (e) => Generate_Body_From_Config('luna', e);
const Generate_Upgrader_Body         = (e) => Generate_Body_From_Config('upgrader', e);
const Generate_Scout_Body            = (e) => Generate_Body_From_Config('Scout', e);
const Generate_CombatMelee_Body      = (e) => Generate_Body_From_Config('CombatMelee', e);
const Generate_CombatArcher_Body     = (e) => Generate_Body_From_Config('CombatArcher', e);
const Generate_CombatMedic_Body      = (e) => Generate_Body_From_Config('CombatMedic', e);
const Generate_Dismantler_Config_Body= (e) => Generate_Body_From_Config('Dismantler', e);
const Generate_Claimer_Body          = (e) => Generate_Body_From_Config('Claimer', e);

// ---------- Task → Body helper (kept for API compatibility) ----------
function getBodyForTask(task, energyAvailable) {
  const key = normalizeTask(task);
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
function Generate_Creep_Name(role, max = 70) {
  for (let i = 1; i <= max; i++) {
    const name = `${role}_${i}`;
    if (!Game.creeps[name]) return name;
  }
  return null; // ran out of slots
}

// ---------- Spawn Helpers ----------
// Spawns a role using a provided body-gen function; merges memory.role automatically.
function Spawn_Creep_Role(spawn, roleName, generateBodyFn, availableEnergy, memory = {}) {
  const body = generateBodyFn(availableEnergy);
  const bodyCost = _.sum(body, p => BODYPART_COST[p]) || 0;

  if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
    spawnLog.debug('Attempt', roleName, 'body=[' + body + ']', 'cost=' + bodyCost, 'avail=' + availableEnergy);
  }

  if (!body.length || availableEnergy < bodyCost) {
    if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
      spawnLog.debug('Not enough energy for', roleName + '.', 'Need', bodyCost, 'have', availableEnergy + '.');
    }
    return false;
  }

  if (EconomyManager && typeof EconomyManager.shouldSpawn === 'function') {
    if (!EconomyManager.shouldSpawn(spawn.room, roleName, bodyCost)) {
      return false;
    }
  }

  const name = Generate_Creep_Name(roleName);
  if (!name) return false;

  memory.role = roleName; // ensure role is set
  const result = spawn.spawnCreep(body, name, { memory });

  if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
    spawnLog.debug('Result', roleName + '/' + name + ':', result);
  }
  if (result === OK) {
    if (EconomyManager && typeof EconomyManager.recordSpawnCost === 'function') {
      EconomyManager.recordSpawnCost(spawn.room, bodyCost);
    }
    if (Logger.shouldLog(LOG_LEVEL.BASIC)) {
      spawnLog.info('🟢 Spawned', roleName + ':', name);
    }
    return true;
  }
  return false;
}

// Spawns a generic "Worker_Bee" with a task (kept for your existing callsites).
function Spawn_Worker_Bee(spawn, neededTask, availableEnergy, extraMemory, options) {
  options = options || {};
  const body = getBodyForTask(neededTask, availableEnergy);
  const name = Generate_Creep_Name(neededTask || 'Worker');
  const bodyCost = _.sum(body, p => BODYPART_COST[p]) || 0;

  if (!body || !body.length) {
    if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
      spawnLog.debug('No body available for task', neededTask, 'with energy', availableEnergy);
    }
    return false;
  }

  if (!options.force && EconomyManager && typeof EconomyManager.shouldSpawn === 'function') {
    if (!EconomyManager.shouldSpawn(spawn.room, neededTask, bodyCost)) {
      return false;
    }
  }

  const memory = {
    role: 'Worker_Bee',
    task: neededTask,
    bornTask: neededTask,
    birthBody: body.slice(),
  };
  if (extraMemory) Object.assign(memory, extraMemory);
  const res = spawn.spawnCreep(body, name, { memory });
  if (res === OK) {
    if (EconomyManager && typeof EconomyManager.recordSpawnCost === 'function') {
      EconomyManager.recordSpawnCost(spawn.room, bodyCost);
    }
    if (Logger.shouldLog(LOG_LEVEL.BASIC)) {
      spawnLog.info('🟢 Spawned Creep:', name, 'for task', neededTask);
    }
    return true;
  }
  return false;
}


// --- REPLACE your existing Spawn_Squad with this hardened version ---
function Spawn_Squad(spawn, squadId = 'Alpha') {
  if (!spawn || spawn.spawning) return { skipped: true };

  const normalizedId = _normalizeSquadId(squadId) || 'Alpha';
  const idx = _squadIndex(normalizedId);
  if (idx === -1) return { skipped: true };

  if (!Memory.squads) Memory.squads = {};
  if (!Memory.squads[normalizedId]) Memory.squads[normalizedId] = {};
  const S = Memory.squads[normalizedId];
  const COOLDOWN_TICKS = 3;

  function desiredLayout(score) {
    const threat = score | 0;
    let melee = 1;
    let medic = 1;
    let archer = 0;

    if (threat >= 12) melee = 2;
    if (threat >= HEAVY_THREAT_SCORE) medic = 2;
    if (threat >= 10 && threat < 22) archer = 1;
    else if (threat >= 22) archer = 2;

    const order = [
      { role: 'CombatMelee', need: melee },
    ];
    if (archer > 0) order.push({ role: 'CombatArcher', need: archer });
    order.push({ role: 'CombatMedic', need: medic });
    return order;
  }

  const plan = _currentSquadPlan(spawn.room);
  if (idx >= plan.allowed) {
    return { skipped: true, limit: plan.allowed };
  }

  const threatEntry = plan.bySquad[normalizedId];
  if (!threatEntry) {
    // No active threat assigned to this squad; mark desired counts as empty
    S.desiredCounts = {};
    S.targetRoom = null;
    S.lastKnownScore = 0;
    return { done: true };
  }

  if (Game.map && typeof Game.map.getRoomLinearDistance === 'function') {
    const dist = Game.map.getRoomLinearDistance(spawn.room.name, threatEntry.roomName, true);
    if (typeof dist === 'number' && dist > 3) {
      return { skipped: true, reason: 'distance' };
    }
  }

  const layout = desiredLayout(threatEntry.score);
  if (!layout.length) {
    return { done: true };
  }

  S.targetRoom = threatEntry.roomName;
  S.lastKnownScore = threatEntry.score;
  S.flagName = threatEntry.flagName || null;
  S.desiredCounts = {};
  for (let li = 0; li < layout.length; li++) {
    S.desiredCounts[layout[li].role] = layout[li].need | 0;
  }
  S.lastEvaluated = Game.time;

  function haveCount(taskName) {
    const live = _.sum(Game.creeps, function (c) {
      return c.my && c.memory && c.memory.squadId === normalizedId && c.memory.task === taskName ? 1 : 0;
    });
    const hatching = _.sum(Memory.creeps, function (mem, name) {
      if (!mem) return 0;
      if (mem.squadId !== normalizedId) return 0;
      if (mem.task !== taskName) return 0;
      return Game.creeps[name] ? 0 : 1;
    });
    return live + hatching;
  }

  if (S.lastSpawnAt && (Game.time - S.lastSpawnAt) < COOLDOWN_TICKS) {
    return { pending: true, needsMore: true };
  }

  const avail = Calculate_Spawn_Resource(spawn);

  for (let i = 0; i < layout.length; i++) {
    const rolePlan = layout[i];
    if ((rolePlan.need | 0) <= 0) continue;
    const have = haveCount(rolePlan.role);

    if (have < rolePlan.need) {
      const previewBody = getBodyForTask(rolePlan.role, avail);
      const previewCost = _.sum(previewBody, part => BODYPART_COST[part]) || 0;
      if (!previewBody.length || avail < previewCost) {
        return { pending: true, needsMore: true, reason: 'energy' };
      }

      const extraMemory = {
        squadId: normalizedId,
        role: rolePlan.role,
        targetRoom: threatEntry.roomName,
        homeRoom: spawn.room.name,
      };
      const force = plan.highestThreat >= HEAVY_THREAT_SCORE;
      const ok = Spawn_Worker_Bee(spawn, rolePlan.role, avail, extraMemory, { force });
      if (ok) {
        S.lastSpawnAt = Game.time;
        S.lastSpawnRole = rolePlan.role;
        return { spawned: true, needsMore: have + 1 < rolePlan.need };
      }
      return { pending: true, needsMore: true };
    }
  }

  return { done: true };
}



// ---------- Exports ----------
module.exports = {
  // utilities
  Generate_Creep_Name,
  Calculate_Spawn_Resource,
  configurations: Object.entries(CONFIGS).map(([task, body]) => ({ task, body })), // preserve your original shape
  Generate_Body_From_Config,
  Spawn_Creep_Role,
  Spawn_Squad,
  // role generators (compat)
  Generate_Courier_Body,
  Generate_BaseHarvest_Body,
  Generate_Upgrader_Body,
  Generate_Builder_Body,
  Generate_Repair_Body,
  Generate_Queen_Body,
  Generate_Luna_Body,
  Generate_Scout_Body,
  Generate_CombatMelee_Body,
  Generate_CombatArcher_Body,
  Generate_CombatMedic_Body,
  Generate_Dismantler_Config_Body,
  Generate_Claimer_Body,

  // existing helpers
  getBodyForTask,
  Spawn_Worker_Bee,
};
