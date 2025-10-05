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
var CombatSquadPlanner = require('Combat.SquadPlanner.es5');
var BodyConfigsCombat = require('bodyConfigs.combat.es5');

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
  var combatTiers = BodyConfigsCombat[taskKey];
  if (combatTiers && combatTiers.length) {
    for (var i = 0; i < combatTiers.length; i++) {
      var tier = combatTiers[i];
      var body = tier.body;
      var cost = _.sum(body, function (part) { return BODYPART_COST[part]; });
      if (cost <= energyAvailable) {
        if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
          spawnLog.debug('Picked combat body', taskKey, tier.tier, 'cost', cost, 'avail', energyAvailable);
        }
        return body.slice();
      }
    }
    var lastTier = combatTiers[combatTiers.length - 1];
    return lastTier.body.slice();
  }

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
function Spawn_Worker_Bee(spawn, neededTask, availableEnergy, extraMemory) {
  const body = getBodyForTask(neededTask, availableEnergy);
  const name = Generate_Creep_Name(neededTask || 'Worker');
  const bodyCost = _.sum(body, p => BODYPART_COST[p]) || 0;

  if (!body || !body.length) {
    if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
      spawnLog.debug('No body available for task', neededTask, 'with energy', availableEnergy);
    }
    return false;
  }

  if (EconomyManager && typeof EconomyManager.shouldSpawn === 'function') {
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


const SQUAD_ORDER = ['Alpha', 'Bravo', 'Charlie', 'Delta'];
const MIN_THREAT_FOR_SQUAD = 5;
const RECENT_THREAT_WINDOW = 50;
const ROOM_INFO_STALE_TICKS = 150; // if we have no vision this long, treat threat intel as stale

function normalizeSquadId(raw) {
  if (!raw) return null;
  if (raw.indexOf('Squad') === 0) {
    return raw.replace(/^Squad_?/, '');
  }
  return raw;
}

function resolveSquadBinding(id) {
  const squadFlagsMem = Memory.squadFlags || {};
  const bindings = squadFlagsMem.bindings || {};
  const names = ['Squad' + id, 'Squad_' + id, id];
  let chosenName = null;
  let targetRoom = null;
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    if (bindings[n]) {
      chosenName = n;
      targetRoom = bindings[n];
      break;
    }
  }
  let flag = null;
  if (chosenName) flag = Game.flags[chosenName] || null;
  if (!flag) {
    for (let j = 0; j < names.length; j++) {
      const f = Game.flags[names[j]];
      if (f) { flag = f; if (!chosenName) chosenName = f.name; if (!targetRoom && f.pos) targetRoom = f.pos.roomName; break; }
    }
  }
  if (!targetRoom && flag && flag.pos) targetRoom = flag.pos.roomName;
  const roomsMem = squadFlagsMem.rooms || {};
  const roomInfo = targetRoom ? roomsMem[targetRoom] || null : null;
  const threatScore = roomInfo && typeof roomInfo.lastScore === 'number' ? roomInfo.lastScore : 0;
  return { flagName: chosenName, flag: flag || null, targetRoom, roomInfo, threatScore };
}

function computeSquadContext() {
  if (!global.__SQUAD_SPAWN_CTX__ || global.__SQUAD_SPAWN_CTX__.tick !== Game.time) {
    const infoById = {};
    const roomsNeeding = [];
    const roleCountBySquad = {};
    const activeById = {};

    function noteRole(sid, role) {
      if (!sid || !role) return;
      if (!roleCountBySquad[sid]) roleCountBySquad[sid] = {};
      roleCountBySquad[sid][role] = (roleCountBySquad[sid][role] || 0) + 1;
      activeById[sid] = (activeById[sid] || 0) + 1;
    }

    for (let i = 0; i < SQUAD_ORDER.length; i++) {
      const sid = SQUAD_ORDER[i];
      infoById[sid] = resolveSquadBinding(sid);
      const binding = infoById[sid];
      const roomInfo = binding && binding.roomInfo;
      const lastSeen = roomInfo && typeof roomInfo.lastSeen === 'number' ? roomInfo.lastSeen : 0;
      const seenAgo = lastSeen ? (Game.time - lastSeen) : Infinity;
      const seenRecently = seenAgo <= ROOM_INFO_STALE_TICKS;
      const rawScore = binding ? (binding.threatScore | 0) : 0;
      const threatScore = seenRecently ? rawScore : 0;
      const lastThreatAt = roomInfo && typeof roomInfo.lastThreatAt === 'number' ? roomInfo.lastThreatAt : 0;
      const recent = seenRecently && lastThreatAt ? (Game.time - lastThreatAt) <= RECENT_THREAT_WINDOW : false;

      if (binding) {
        binding.effectiveThreat = threatScore;
        binding.seenRecently = seenRecently;
        binding.isRecent = recent;
        binding.lastSeen = lastSeen;
      }

      if (binding && binding.targetRoom && (threatScore >= MIN_THREAT_FOR_SQUAD || recent)) {
        roomsNeeding.push({ id: sid, threat: Math.max(threatScore, recent ? MIN_THREAT_FOR_SQUAD : threatScore) });
      }
    }

    const names = Object.keys(Game.creeps);
    for (let idx = 0; idx < names.length; idx++) {
      const c = Game.creeps[names[idx]];
      if (!c || !c.my || !c.memory) continue;
      const sid = normalizeSquadId(c.memory.squadId || c.memory.SquadId);
      if (!sid) continue;
      const role = c.memory.task || c.memory.role;
      noteRole(sid, role);
    }

    for (const cname in Memory.creeps) {
      if (!Memory.creeps.hasOwnProperty(cname)) continue;
      if (Game.creeps[cname]) continue;
      const mem = Memory.creeps[cname];
      if (!mem) continue;
      const sid = normalizeSquadId(mem.squadId || mem.SquadId);
      if (!sid) continue;
      const role = mem.task || mem.role;
      noteRole(sid, role);
    }

    roomsNeeding.sort(function (a, b) { return b.threat - a.threat; });
    const prioritized = roomsNeeding.map(function (e) { return e.id; });

    const incompleteById = {};
    if (Memory.squads) {
      for (let i = 0; i < SQUAD_ORDER.length; i++) {
        const sid = SQUAD_ORDER[i];
        const squadMem = Memory.squads[sid];
        if (!squadMem || !squadMem.desiredCounts) continue;
        const desired = squadMem.desiredCounts;
        const counts = roleCountBySquad[sid] || {};
        let missing = false;
        for (const role in desired) {
          if (!desired.hasOwnProperty(role)) continue;
          const have = counts[role] || 0;
          if (have < (desired[role] | 0)) { missing = true; break; }
        }
        if (missing) incompleteById[sid] = true;
      }
    }

    global.__SQUAD_SPAWN_CTX__ = {
      tick: Game.time,
      data: {
        infoById,
        roomsNeeding,
        prioritized,
        roleCountBySquad,
        activeById,
        incompleteById,
      }
    };
  }
  return global.__SQUAD_SPAWN_CTX__.data;
}

function determineSquadCap(room, ctx) {
  const needed = ctx.roomsNeeding.length;
  if (needed <= 0) return 0;

  let stored = 0;
  let avgNet = 0;
  if (EconomyManager && typeof EconomyManager.getLedger === 'function') {
    const ledger = EconomyManager.getLedger(room);
    if (ledger) {
      stored = ledger.currentStored || 0;
      avgNet = ledger.averageNet || 0;
    }
  }

  if (!stored) {
    stored = room.energyAvailable || 0;
    if (room.storage && room.storage.store) stored += room.storage.store[RESOURCE_ENERGY] || 0;
    if (room.terminal && room.terminal.store) stored += room.terminal.store[RESOURCE_ENERGY] || 0;
  }

  let cap = Math.min(needed, SQUAD_ORDER.length);

  if (stored < 2000 || avgNet < -200) {
    cap = Math.min(cap, 1);
  } else if (stored < 6000 || avgNet < 0) {
    cap = Math.min(cap, 2);
  }

  if (cap <= 0 && needed > 0) cap = 1;
  return cap;
}

// --- REPLACE your existing Spawn_Squad with this hardened version ---
function Spawn_Squad(spawn, squadId) {
  if (!spawn || spawn.spawning) return false;
  squadId = squadId || 'Alpha';

  if (!Memory.squads) Memory.squads = {};
  if (!Memory.squads[squadId]) Memory.squads[squadId] = {};
  var S = Memory.squads[squadId];
  var COOLDOWN_TICKS = 3;

  var ctx = computeSquadContext();
  var binding = ctx.infoById[squadId] || resolveSquadBinding(squadId);
  if (!binding || !binding.targetRoom) {
    S.recall = true;
    S.desiredCounts = {};
    S.targetRoom = null;
    return false;
  }

  if (Game.map && typeof Game.map.getRoomLinearDistance === 'function') {
    var dist = Game.map.getRoomLinearDistance(spawn.room.name, binding.targetRoom, true);
    if (typeof dist === 'number' && dist > 4) {
      S.recall = true;
      return false;
    }
  }

  var squadCap = determineSquadCap(spawn.room, ctx);
  var prioritizedIds = ctx.prioritized || [];
  var allowedIds = prioritizedIds.slice(0, squadCap);
  if (allowedIds.indexOf(squadId) === -1) {
    S.recall = true;
    return false;
  }

  var threatScore = binding.effectiveThreat != null ? binding.effectiveThreat : (binding.threatScore | 0);
  var seenRecently = binding && binding.seenRecently;
  var recent = binding && binding.isRecent;
  if (!seenRecently && !recent) {
    S.recall = true;
    return false;
  }

  var desired = CombatSquadPlanner.desiredCounts(threatScore);
  S.desiredCounts = desired;
  S.recall = false;
  S.targetRoom = binding.targetRoom;
  S.flagName = binding.flag ? binding.flag.name : (binding.flagName || null);
  S.homeRoom = spawn.room.name;
  S.lastKnownScore = threatScore;
  S.lastEvaluated = Game.time;

  var orderIndex = SQUAD_ORDER.indexOf(squadId);
  if (orderIndex > -1) {
    for (var idx = 0; idx < orderIndex; idx++) {
      var priorId = SQUAD_ORDER[idx];
      if (allowedIds.indexOf(priorId) === -1) continue;
      if (ctx.incompleteById[priorId]) return true;
    }
  }

  if (S.lastSpawnAt && (Game.time - S.lastSpawnAt) < COOLDOWN_TICKS) {
    return false;
  }

  function have(role) {
    var live = _.sum(Game.creeps, function (c) {
      if (!c || !c.my || !c.memory) return 0;
      if ((c.memory.squadId || c.memory.SquadId) !== squadId) return 0;
      return (c.memory.task === role || c.memory.role === role) ? 1 : 0;
    });
    var spawningCount = _.sum(Memory.creeps, function (mem, name) {
      if (!mem) return 0;
      if (Game.creeps[name]) return 0;
      if ((mem.squadId || mem.SquadId) !== squadId) return 0;
      return (mem.task === role || mem.role === role) ? 1 : 0;
    });
    return live + spawningCount;
  }

  var energyAvailable = spawn.room.energyAvailable;
  var order = ['CombatMelee', 'CombatMedic', 'CombatArcher', 'Dismantler'];
  for (var i = 0; i < order.length; i++) {
    var role = order[i];
    var need = desired[role] || 0;
    if (need <= 0) continue;
    var haveCount = have(role);
    if (haveCount >= need) continue;
    if (!CombatSquadPlanner.reserveRole(squadId, role)) continue;
    var tier = CombatSquadPlanner.chooseBody(role, energyAvailable, spawn.room.energyCapacityAvailable);
    if (!tier || energyAvailable < tier.minEnergy) {
      continue;
    }
    var memory = { squadId: squadId, role: role, task: role, targetRoom: binding.targetRoom, homeRoom: spawn.room.name };
    var ok = Spawn_Worker_Bee(spawn, role, energyAvailable, memory);
    if (ok) {
      S.lastSpawnAt = Game.time;
      S.lastSpawnRole = role;
      return true;
    }
  }

  return false;
}

module.exports = {
  // utilities
  Generate_Creep_Name,
  Calculate_Spawn_Resource,
  configurations: Object.entries(CONFIGS).map(([task, body]) => ({ task, body })), // preserve your original shape
  Generate_Body_From_Config,
  Spawn_Creep_Role,
    // + new helper
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
