
const Logger = require('core.logger');
const LOG_LEVEL = Logger.LOG_LEVEL;
const spawnLog = Logger.createLogger('Spawn', LOG_LEVEL.BASIC);
var BeeSelectors = null;
var TaskLuna = null;

try { BeeSelectors = require('BeeSelectors'); } catch (beeErr) {}
try { TaskLuna = require('Task.Luna'); } catch (lunaErr) {}

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
    B(6,1,5), 
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
  trucker: [
    A(0,0,0,0,0,25,15),
    A(0,0,0,0,0,21,14),
    A(0,0,0,0,0,18,12),
    A(0,0,0,0,0,15,10),
    A(0,0,0,0,0,12,8),
    A(0,0,0,0,0,9,6),
    A(0,0,0,0,0,6,4),
    A(0,0,0,0,0,4,3),
    A(0,0,0,0,0,2,2)
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
    B(2, 2, 4),     // 400 energy, 8 parts, 100 carry
    B(1,1,2),
    B(1,1,1),
  ],
  upgrader: [
    //B(4,1,5), 
    B(2,1,3),
    B(1,1,2),
    B(1,1,1),
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
    B(0,2,2),
    B(0,1,1),
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
    //B(3,6,5), 
    //B(3,5,4), 
    //B(3,4,3), 
    //B(3,3,3), 
    //B(3,2,2,), 
    //B(2,2,2),
    B(3,4,7),
    B(2,4,6),
    B(2,3,5),
    B(1,3,4),
    B(1,2,3),
    B(1,1,2), 
    B(1,1,1),
  ],
  Scout: [
    B(0,0,1),
  ],

  // Combat
  CombatMelee: [
    //TAM(6,6,12), 
    //TAM(4,4,8),
    //TAM(3,2,5),
    //TAM(3,1,4),
    //A(1,1,0,1,0,0,2),
    A(0,2,0,0,0,0,2),
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
    MH(4,4), 
    MH(3,3), 
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
    //4,4),
    //3,3), 
    C(2,2), 
    C(1,1),
  ],
};

// ---------- Task Aliases (normalize user-facing names) ----------
// This lets getBodyForTask('Trucker') resolve to courier configs, etc.
const TASK_ALIAS = {
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
const Generate_Trucker_Body          = (e) => Generate_Body_From_Config('trucker', e);
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
    case 'trucker':        return Generate_Trucker_Body(energyAvailable);
    case 'luna':           return Generate_Luna_Body(energyAvailable);
    case 'Scout':          return Generate_Scout_Body(energyAvailable);
    case 'Queen':          return Generate_Queen_Body(energyAvailable);
    case 'CombatArcher':   return Generate_CombatArcher_Body(energyAvailable);
    case 'CombatMelee':    return Generate_CombatMelee_Body(energyAvailable);
    case 'CombatMedic':    return Generate_CombatMedic_Body(energyAvailable);
    case 'Dismantler':     return Generate_Dismantler_Config_Body(energyAvailable);
    case 'Claimer':        return Generate_Claimer_Body(energyAvailable);
    // Aliases
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
// Remote Luna assignment helpers keep spawn-time memory aligned with Task.Luna.
function ensureRemoteSpawnMemory() {
  if (!Memory.__BHM) Memory.__BHM = {};
  if (!Memory.__BHM.remotesByHome) Memory.__BHM.remotesByHome = {};
  if (!Memory.__BHM.remoteSourceClaims) Memory.__BHM.remoteSourceClaims = {};
  if (!Memory.__BHM.avoidSources) Memory.__BHM.avoidSources = {};
}

function spawnClaimIsActive(claim) {
  if (!claim) return false;
  if (claim.creepName && Game.creeps[claim.creepName]) return true;
  if (claim.spawnName) {
    var spawnObj = Game.spawns[claim.spawnName];
    if (spawnObj && spawnObj.spawning && spawnObj.spawning.name === claim.creepName) return true;
  }
  if (claim.pending && typeof claim.pendingTick === 'number') {
    if ((Game.time - claim.pendingTick) <= 200) return true;
  }
  return false;
}

function selectLunaAssignmentForSpawn(homeRoomName, preferredRemote) {
  ensureRemoteSpawnMemory();
  if (!homeRoomName) return null;
  var remotes = Memory.__BHM.remotesByHome[homeRoomName] || [];
  if (!remotes.length) return null;
  if (!BeeSelectors || typeof BeeSelectors.getRemoteSourcesSnapshot !== 'function') return null;
  var snapshot = BeeSelectors.getRemoteSourcesSnapshot(homeRoomName) || [];
  var claims = Memory.__BHM.remoteSourceClaims;
  var avoid = Memory.__BHM.avoidSources || {};
  var flagged = [];
  var unflagged = [];
  for (var i = 0; i < snapshot.length; i++) {
    var entry = snapshot[i];
    if (!entry || !entry.sourceId) continue;
    if (remotes.indexOf(entry.roomName) === -1) continue;
    if (avoid[entry.sourceId] && avoid[entry.sourceId] > Game.time) continue;
    var claim = claims[entry.sourceId];
    if (claim) {
      if (!spawnClaimIsActive(claim)) {
        delete claims[entry.sourceId];
      } else {
        continue;
      }
    }
    if (entry.flag) flagged.push(entry);
    else unflagged.push(entry);
  }
  var ordered = [];
  if (preferredRemote) {
    for (var pf = 0; pf < flagged.length; pf++) {
      if (flagged[pf] && flagged[pf].roomName === preferredRemote) ordered.push(flagged[pf]);
    }
    for (var pu = 0; pu < unflagged.length; pu++) {
      if (unflagged[pu] && unflagged[pu].roomName === preferredRemote) ordered.push(unflagged[pu]);
    }
  }
  for (var ff = 0; ff < flagged.length; ff++) {
    if (!flagged[ff]) continue;
    if (preferredRemote && flagged[ff].roomName === preferredRemote) continue;
    ordered.push(flagged[ff]);
  }
  for (var uu = 0; uu < unflagged.length; uu++) {
    if (!unflagged[uu]) continue;
    if (preferredRemote && unflagged[uu].roomName === preferredRemote) continue;
    ordered.push(unflagged[uu]);
  }
  if (!ordered.length) return null;
  return ordered[0];
}

function registerPendingLunaClaim(sourceId, creepName, homeRoom, remoteRoom, spawn) {
  if (!sourceId || !creepName) return;
  ensureRemoteSpawnMemory();
  Memory.__BHM.remoteSourceClaims[sourceId] = {
    creepName: creepName,
    homeRoom: homeRoom,
    remoteRoom: remoteRoom,
    since: Game.time,
    spawnName: spawn || null,
    pending: true,
    pendingTick: Game.time
  };
}

function releasePendingLunaClaim(sourceId, creepName) {
  if (!sourceId || !creepName) return;
  ensureRemoteSpawnMemory();
  var claim = Memory.__BHM.remoteSourceClaims[sourceId];
  if (claim && claim.creepName === creepName && claim.pending) {
    delete Memory.__BHM.remoteSourceClaims[sourceId];
  }
}

function prepareLunaSpawnMemory(spawn, name, memory) {
  ensureRemoteSpawnMemory();
  if (!memory) memory = {};
  var warnings = [];
  if (memory.remoteRoom) {
    warnings.push('remoteRoom');
    delete memory.remoteRoom;
  }
  if (memory.sourceId) {
    warnings.push('sourceId');
    delete memory.sourceId;
  }
  if (memory.remote) {
    warnings.push('remote');
    delete memory.remote;
  }
  if (memory.targetRoom) {
    warnings.push('targetRoom');
    delete memory.targetRoom;
  }
  if (warnings.length && spawnLog && typeof spawnLog.warn === 'function') {
    spawnLog.warn('Luna spawn ignored preset fields', name || 'unknown', 'fields=' + warnings.join(','));
  }
  var homeRoom = null;
  if (memory.homeRoom) homeRoom = memory.homeRoom;
  if (!homeRoom && spawn && spawn.room && spawn.room.name) homeRoom = spawn.room.name;
  if (!homeRoom && spawn && spawn.roomName) homeRoom = spawn.roomName;
  if (!homeRoom) return { abort: true };
  memory.homeRoom = homeRoom;
  memory.state = 'init';
  return {};
}

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

  const name = Generate_Creep_Name(roleName);
  if (!name) return false;

  var lunaReservation = null;
  if (roleName === 'luna') {
    lunaReservation = prepareLunaSpawnMemory(spawn, name, memory);
    if (lunaReservation && lunaReservation.abort) {
      if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
        spawnLog.debug('Luna spawn skipped (no remote assignment)', spawn.name || 'unknown');
      }
      return false;
    }
  }

  memory.role = roleName; // ensure role is set
  const result = spawn.spawnCreep(body, name, { memory });

  if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
    spawnLog.debug('Result', roleName + '/' + name + ':', result);
  }
  if (result !== OK && lunaReservation && lunaReservation.sourceId) {
    releasePendingLunaClaim(lunaReservation.sourceId, name);
  }
  if (result === OK) {
    if (Logger.shouldLog(LOG_LEVEL.BASIC)) {
      if (roleName === 'luna') {
        var memDump = memory || {};
        // Emit the exact remote assignment so debugging live spawns is trivial.
        spawnLog.info('🟢 Spawned', roleName + ':', name, 'home=', memDump.homeRoom || 'n/a', 'remote=', memDump.remoteRoom || 'n/a', 'source=', memDump.sourceId || 'n/a');
      } else {
        spawnLog.info('🟢 Spawned', roleName + ':', name);
      }
    }
    return true;
  }
  return false;
}

// Spawns a generic "Worker_Bee" with a task (kept for your existing callsites).
function Spawn_Worker_Bee(spawn, neededTask, availableEnergy, extraMemory) {
  const body = getBodyForTask(neededTask, availableEnergy);
  const name = Generate_Creep_Name(neededTask || 'Worker');
  const memory = {
    role: 'Worker_Bee',
    task: neededTask,
    bornTask: neededTask,
    birthBody: body.slice(),
  };
  if (extraMemory) Object.assign(memory, extraMemory);
  const res = spawn.spawnCreep(body, name, { memory });
  if (res === OK) {
    if (Logger.shouldLog(LOG_LEVEL.BASIC)) {
      spawnLog.info('🟢 Spawned Creep:', name, 'for task', neededTask);
    }
    return true;
  }
  return false;
}


function normalizeIntentTask(role) {
  if (!role) return role;
  if (typeof role !== 'string') return role;
  if (role === 'hauler' || role === 'Hauler') return 'courier';
  if (role === 'HAULER') return 'courier';
  if (role === 'claimer') return 'Claimer';
  if (role === 'CLAIMER') return 'Claimer';
  if (role === 'Builder') return 'builder';
  if (role === 'Courier') return 'courier';
  return role;
}

function pickBodyForIntent(role, energyAvailable) {
  var taskKey = normalizeIntentTask(role);
  if (!taskKey) return [];
  var body = getBodyForTask(taskKey, energyAvailable);
  if (body && body.length) return body;
  if (typeof taskKey === 'string') {
    var altKey = taskKey.charAt(0).toUpperCase() + taskKey.slice(1);
    var alt = getBodyForTask(altKey, energyAvailable);
    if (alt && alt.length) return alt;
  }
  return [];
}

function deepClone(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    var arr = [];
    for (var i = 0; i < value.length; i++) {
      arr[i] = deepClone(value[i]);
    }
    return arr;
  }
  var out = {};
  for (var key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    out[key] = deepClone(value[key]);
  }
  return out;
}

function Spawn_From_Intent(spawn, intent, availableEnergy) {
  if (!spawn || !intent) return false;
  var energyBudget = availableEnergy;
  if (energyBudget === null || energyBudget === undefined) {
    energyBudget = Calculate_Spawn_Resource(spawn);
  }
  var roleKey = intent.role || intent.task || (intent.memory && intent.memory.task);
  var body = null;
  if (Array.isArray(intent.body) && intent.body.length) {
    body = intent.body.slice();
  } else {
    body = pickBodyForIntent(roleKey, energyBudget);
  }
  if (!body || !body.length) return false;
  var bodyCost = _.sum(body, function (part) { return BODYPART_COST[part] || 0; });
  if (bodyCost > energyBudget) return false;
  var name = intent.name;
  if (!name) {
    var nameRole = normalizeIntentTask(roleKey) || 'Worker';
    name = Generate_Creep_Name(nameRole);
  }
  if (!name) return false;
  var memory = deepClone(intent.memory) || {};
  if (!memory.role) {
    if (intent.role) memory.role = intent.role;
    else memory.role = 'Worker_Bee';
  }
  if (!memory.task && intent.task) memory.task = intent.task;
  if (!memory.task && memory.role && typeof memory.role === 'string') {
    memory.task = normalizeTask(memory.role);
  }
  if (!memory.bornTask && memory.task) memory.bornTask = memory.task;
  if (!memory.birthBody) memory.birthBody = body.slice();
  if (!memory.home && intent.home) memory.home = intent.home;
  if (!memory.home && intent.homeRoom) memory.home = intent.homeRoom;
  if (!memory.homeRoom && intent.homeRoom) memory.homeRoom = intent.homeRoom;
  if (!memory.homeRoom && memory.home) memory.homeRoom = memory.home;
  if (!memory.target && intent.target) memory.target = intent.target;
  if (!memory.target && intent.targetRoom) memory.target = intent.targetRoom;
  if (!memory.targetRoom && intent.targetRoom) memory.targetRoom = intent.targetRoom;
  if (!memory.targetRoom && memory.target) memory.targetRoom = memory.target;
  var result = spawn.spawnCreep(body, name, { memory: memory });
  if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
    spawnLog.debug('Intent spawn', memory.role || 'unknown', name, 'result', result);
  }
  return result === OK;
}

function getIntentHome(intent) {
  if (!intent) return null;
  if (intent.home) return intent.home;
  if (intent.homeRoom) return intent.homeRoom;
  if (intent.memory) {
    if (intent.memory.homeRoom) return intent.memory.homeRoom;
    if (intent.memory.home) return intent.memory.home;
  }
  return null;
}

function getIntentTarget(intent) {
  if (!intent) return null;
  if (intent.target) return intent.target;
  if (intent.targetRoom) return intent.targetRoom;
  if (intent.memory) {
    if (intent.memory.targetRoom) return intent.memory.targetRoom;
    if (intent.memory.target) return intent.memory.target;
  }
  return null;
}

function getIntentRole(intent) {
  if (!intent) return 'Worker';
  if (intent.role) return intent.role;
  if (intent.task) return intent.task;
  if (intent.memory) {
    if (intent.memory.role) return intent.memory.role;
    if (intent.memory.task) return intent.memory.task;
  }
  return 'Worker';
}

function ensureIntentBody(intent, energyBudget) {
  if (!intent) return null;
  if (Array.isArray(intent.body) && intent.body.length) {
    return intent.body.slice();
  }
  var intentRole = getIntentRole(intent);
  var fallback = pickBodyForIntent(intentRole, energyBudget);
  if (fallback && fallback.length) {
    return fallback;
  }
  return null;
}

function Consume_Spawn_Intents(spawn) {
  if (!spawn || spawn.spawning) return false;
  if (typeof global === 'undefined' || !global.__BHM) return false;
  var queue = global.__BHM.spawnIntents;
  if (!Array.isArray(queue) || !queue.length) return false;
  var energyBudget = Calculate_Spawn_Resource(spawn);
  if (!energyBudget) return false;
  var roomName = null;
  if (spawn.room && spawn.room.name) {
    roomName = spawn.room.name;
  }
  for (var i = 0; i < queue.length; i++) {
    var raw = queue[i];
    if (!raw) {
      queue.splice(i, 1);
      i--;
      continue;
    }
    var home = getIntentHome(raw);
    if (home && roomName && home !== roomName) {
      continue;
    }
    var role = getIntentRole(raw);
    var body = ensureIntentBody(raw, energyBudget);
    if (!body || !body.length) {
      queue.splice(i, 1);
      i--;
      continue;
    }
    var bodyCost = _.sum(body, function (part) { return BODYPART_COST[part] || 0; });
    if (bodyCost > energyBudget) {
      return false;
    }
    var attempt = deepClone(raw);
    attempt.body = body;
    var target = getIntentTarget(attempt);
    if (Logger.shouldLog(LOG_LEVEL.BASIC)) {
      spawnLog.info('ExpansionIntent role=' + role + ' target=' + (target || 'n/a'));
    }
    var ok = Spawn_From_Intent(spawn, attempt, energyBudget);
    if (ok) {
      queue.splice(i, 1);
    }
    return ok;
  }
  return false;
}


// --- REPLACE your existing Spawn_Squad with this hardened version ---
function Spawn_Squad(spawn, squadId = 'Alpha') {
  if (!spawn || spawn.spawning) return false;

  // Per-squad memory book-keeping to avoid rapid duplicate spawns
  if (!Memory.squads) Memory.squads = {};
  if (!Memory.squads[squadId]) Memory.squads[squadId] = {};
  const S = Memory.squads[squadId];
  const COOLDOWN_TICKS = 1;                  // don’t spawn same-squad twice within 5 ticks

  function desiredLayout(score) {
    const threat = score | 0;
    let melee = 2;
    let medic = 1;
    let archer = 0;

    if (threat >= 12) melee = 2;
    if (threat >= 18) medic = 2;
    if (threat >= 10 && threat < 22) archer = 1;
    else if (threat >= 22) archer = 2;

    const order = [
      { role: 'CombatMelee', need: melee },
    ];
    if (archer > 0) order.push({ role: 'CombatArcher', need: archer });
    order.push({ role: 'CombatMedic', need: medic });
    return order;
  }

  const flagName = 'Squad' + squadId;
  const altFlagName = 'Squad_' + squadId;
  const flag = Game.flags[flagName] || Game.flags[altFlagName] || Game.flags[squadId] || null;
  const squadFlagsMem = Memory.squadFlags || {};
  const bindings = squadFlagsMem.bindings || {};

  let targetRoom = bindings[flagName] || bindings[altFlagName] || bindings[squadId] || null;
  if (!targetRoom && flag && flag.pos) targetRoom = flag.pos.roomName;
  if (!targetRoom) return false;

  if (Game.map && typeof Game.map.getRoomLinearDistance === 'function') {
    const dist = Game.map.getRoomLinearDistance(spawn.room.name, targetRoom, true);
    if (typeof dist === 'number' && dist > 3) return false; // too far to be considered "nearby"
  }

  const roomInfo = (squadFlagsMem.rooms && squadFlagsMem.rooms[targetRoom]) || null;
  const threatScore = roomInfo && typeof roomInfo.lastScore === 'number' ? roomInfo.lastScore : 0;
  const layout = desiredLayout(threatScore);
  if (!layout.length) return false;

  S.targetRoom = targetRoom;
  S.lastKnownScore = threatScore;
  S.flagName = flag ? flag.name : null;
  S.desiredCounts = {};
  for (let li = 0; li < layout.length; li++) {
    S.desiredCounts[layout[li].role] = layout[li].need | 0;
  }
  S.lastEvaluated = Game.time;

  // Count squad members by role (includes spawning eggs)
  function haveCount(taskName) {
    // count live creeps
    var live = _.sum(Game.creeps, function(c){
      return c.my && c.memory && c.memory.squadId === squadId && c.memory.task === taskName ? 1 : 0;
    });
    // count "eggs" currently spawning (Memory is set immediately when you spawn)
    var hatching = _.sum(Memory.creeps, function(mem, name){
      if (!mem) return 0;
      if (mem.squadId !== squadId) return 0;
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

  const avail = Calculate_Spawn_Resource(spawn);

  // Find the first underfilled slot (in order) and spawn exactly one
  for (let i = 0; i < layout.length; i++) {
    const plan = layout[i];
    if ((plan.need | 0) <= 0) continue;
    const have = haveCount(plan.role);

    if (have < plan.need) {
      const extraMemory = { squadId: squadId, role: plan.role, targetRoom: targetRoom };
      const ok = Spawn_Worker_Bee(spawn, plan.role, avail, extraMemory);
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



// ---------- Exports ----------
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
  Spawn_From_Intent,
  Consume_Spawn_Intents,
};
