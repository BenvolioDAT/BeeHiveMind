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

// ---------- Logging Levels ----------
const LOG_LEVEL = { NONE: 0, BASIC: 1, DEBUG: 2 };
// Flip to LOG_LEVEL.DEBUG when you want verbose logs:
const currentLogLevel = LOG_LEVEL.NONE;

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
    B(6,0,5), B(5,1,5), B(4,1,4), B(3,1,3), B(2,1,2), B(1,1,1),
  ],
  courier: [
    CM(30,15), CM(23,23), CM(22,22), CM(21,21), CM(20,20), CM(19,19), CM(18,18),
    CM(17,17), CM(16,16), CM(15,15), CM(14,14), CM(13,13), CM(12,12), CM(11,11),
    CM(10,10), CM(9,9), CM(8,8), CM(7,7), CM(6,6), CM(5,5), CM(4,4), CM(3,3),
    CM(2,2), CM(1,1),
  ],
  builder: [
    B(8,8,8), B(4,10,7), B(8,10,9), B(8,10,18), B(6,8,14), B(6,3,9),
    B(5,2,7), B(4,1,5), B(2,1,3),
  ],
  upgrader: [
    B(4,1,5), B(2,1,3),
  ],
  repair: [
    B(5,2,7), B(4,1,5), B(2,1,3),
  ],
  Queen: [ // keeping capitalization to match your original key
    B(0,22,22), B(0,21,21), B(0,20,20), B(0,19,19), B(0,18,18), B(0,17,17),
    B(0,16,16), B(0,15,15), B(0,14,14), B(0,13,13), B(0,12,12), B(0,11,11),
    B(0,10,10), B(0,9,9), B(0,8,8), B(0,7,7), B(0,6,6), B(0,5,5), B(0,4,4),
    B(0,3,3), B(1,2,3), B(1,1,2), B(1,1,1),
  ],
  remoteharvest: [
    B(8,25,17), B(5,10,8), B(5,8,4), B(5,8,13), B(5,6,11), B(5,4,9),
    B(5,2,7), B(4,2,6), B(3,2,5), B(2,2,4), B(1,1,2),
  ],
  Scout: [
    B(0,0,1),
  ],

  // Combat
  CombatMelee: [
    TAM(6,6,12), TAM(4,4,8), TAM(1,1,2),
  ],
  CombatArcher: [
    R(6,8,14), R(4,6,10), R(2,4,6), R(1,2,3),
  ],
  CombatMedic: [
    MH(12,12), MH(10,10), MH(8,8), MH(6,6), MH(5,5), MH(4,4), MH(3,3), MH(2,2), MH(1,1),
  ],
  Dismantler: [
    WM(25,25), WM(20,20), WM(15,15),
  ],

  // Special
  Claimer: [
    C(3,3), C(2,2), C(1,1),
  ],
};

// ---------- Task Aliases (normalize user-facing names) ----------
// This lets getBodyForTask('Trucker') resolve to courier configs, etc.
const TASK_ALIAS = {
  trucker: 'courier',
  queen: 'Queen',
  scout: 'Scout',
  claimer: 'Claimer',
  // pass-throughs (lowercased) will resolve automatically if present
};

// ---------- Energy Accounting ----------
// Returns *total available* energy across all spawns + extensions.
function Calculate_Spawn_Resource() {
  let spawnEnergy = 0;
  for (const name in Game.spawns) {
    spawnEnergy += Game.spawns[name].store[RESOURCE_ENERGY] || 0;
  }
  const extensionEnergy = _.sum(Game.structures, s =>
    s.structureType === STRUCTURE_EXTENSION ? (s.store[RESOURCE_ENERGY] || 0) : 0
  );
  return spawnEnergy + extensionEnergy;
}

if (currentLogLevel >= LOG_LEVEL.DEBUG) {
  console.log(`[spawn] Available energy: ${Calculate_Spawn_Resource()}`);
}

// ---------- Body Selection ----------
// Returns the largest body from CONFIGS[taskKey] that fits energyAvailable.
function Generate_Body_From_Config(taskKey, energyAvailable) {
  const list = CONFIGS[taskKey];
  if (!list) {
    if (currentLogLevel >= LOG_LEVEL.DEBUG) {
      console.log(`[spawn] No config for task: ${taskKey}`);
    }
    return [];
  }
  for (const body of list) {
    const cost = _.sum(body, part => BODYPART_COST[part]); // Screeps global
    if (cost <= energyAvailable) {
      if (currentLogLevel >= LOG_LEVEL.DEBUG) {
        console.log(`[spawn] Picked ${taskKey} body: [${body}] @ cost ${cost} (avail ${energyAvailable})`);
      }
      return body;
    }
  }
  if (currentLogLevel >= LOG_LEVEL.DEBUG) {
    console.log(`[spawn] Insufficient energy for ${taskKey} (need at least ${_.sum(_.last(list), p => BODYPART_COST[p])})`);
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
const Generate_RemoteHarvest_Body    = (e) => Generate_Body_From_Config('remoteharvest', e);
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
    case 'remoteharvest':  return Generate_RemoteHarvest_Body(energyAvailable);
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
      if (currentLogLevel >= LOG_LEVEL.DEBUG) {
        console.log(`[spawn] Unknown task: ${task}`);
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

  if (currentLogLevel >= LOG_LEVEL.DEBUG) {
    console.log(`[spawn] Attempt ${roleName} body=[${body}] cost=${bodyCost} avail=${availableEnergy}`);
  }

  if (!body.length || availableEnergy < bodyCost) {
    if (currentLogLevel >= LOG_LEVEL.DEBUG) {
      console.log(`[spawn] Not enough energy for ${roleName}. Need ${bodyCost}, have ${availableEnergy}.`);
    }
    return false;
  }

  const name = Generate_Creep_Name(roleName);
  if (!name) return false;

  memory.role = roleName; // ensure role is set
  const result = spawn.spawnCreep(body, name, { memory });

  if (currentLogLevel >= LOG_LEVEL.DEBUG) {
    console.log(`[spawn] Result ${roleName}/${name}: ${result}`);
  }
  if (result === OK) {
    if (currentLogLevel >= LOG_LEVEL.BASIC) {
      console.log(`🟢 Spawned ${roleName}: ${name}`);
    }
    return true;
  }
  return false;
}

// Spawns a generic "Worker_Bee" with a task (kept for your existing callsites).
function Spawn_Worker_Bee(spawn, neededTask, availableEnergy) {
  const body = getBodyForTask(neededTask, availableEnergy);
  const name = Generate_Creep_Name(neededTask || 'Worker');
  const memory = {
    role: 'Worker_Bee',
    task: neededTask,
    bornTask: neededTask,
    birthBody: body.slice(),
  };
  const res = spawn.spawnCreep(body, name, { memory });
  if (res === OK) {
    if (currentLogLevel >= LOG_LEVEL.BASIC) {
      console.log(`🟢 Spawned Creep: ${name} for task ${neededTask}`);
    }
    return true;
  }
  return false;
}

// ---------- Exports ----------
module.exports = {
  // utilities
  Generate_Creep_Name,
  Calculate_Spawn_Resource,
  configurations: Object.entries(CONFIGS).map(([task, body]) => ({ task, body })), // preserve your original shape
  Generate_Body_From_Config,
  Spawn_Creep_Role,

  // role generators (compat)
  Generate_Courier_Body,
  Generate_BaseHarvest_Body,
  Generate_Upgrader_Body,
  Generate_Builder_Body,
  Generate_Repair_Body,
  Generate_Queen_Body,
  Generate_RemoteHarvest_Body,
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
