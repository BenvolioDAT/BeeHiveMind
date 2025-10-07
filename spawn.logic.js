"use strict";
// ---------- Logging ----------
var Logger = require('core.logger');
var BeeToolbox = require('BeeToolbox');
var LOG_LEVEL = Logger.LOG_LEVEL;
var spawnLog = Logger.createLogger('Spawn', LOG_LEVEL.BASIC);

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

function bodyCost(parts) {
  if (!parts || !parts.length) return 0;
  var cost = 0;
  for (var i = 0; i < parts.length; i++) {
    cost += BODYPART_COST[parts[i]] || 0;
  }
  return cost;
}

// Helper describing the minimum controller level required for a body.
function createBodyConfig(body, minRcl, maxRcl) {
  return {
    body: body,
    minRcl: (minRcl == null) ? 1 : minRcl,
    maxRcl: (maxRcl == null) ? 8 : maxRcl
  };
}

function normalizeBodyEntry(entry) {
  if (!entry) return { body: [], minRcl: 1, maxRcl: 8 };
  if (Array.isArray(entry)) return { body: entry, minRcl: 1, maxRcl: 8 };
  var body = entry.body || [];
  var min = (entry.minRcl == null) ? 1 : entry.minRcl;
  var max = (entry.maxRcl == null) ? 8 : entry.maxRcl;
  return { body: body, minRcl: min, maxRcl: max };
}

// ---------- Role Configs (largest first is preferred) ----------
// Each config unlocks progressively as rooms reach the specified controller tier.
var CONFIGS = {
  // Workers
  baseharvest: [
    createBodyConfig(B(6,0,5), 7),   // High-RCL miners focus on throughput.
    createBodyConfig(B(5,1,5), 6),
    createBodyConfig(B(4,1,4), 5),
    createBodyConfig(B(3,1,3), 4),
    createBodyConfig(B(2,1,2), 2),   // Small harvesters keep RCL2 rooms alive.
    createBodyConfig(B(1,1,1), 1)
  ],
  courier: [
    createBodyConfig(CM(25,25), 7),   // Deep logistics once storage + links exist.
    createBodyConfig(CM(18,18), 6),
    createBodyConfig(CM(12,12), 5),
    createBodyConfig(CM(9,9), 4),
    createBodyConfig(CM(6,6), 3),
    createBodyConfig(CM(4,4), 2),    // RCL2 gains dedicated haulers.
    createBodyConfig(CM(2,2), 2),
    createBodyConfig(CM(1,1), 1)
  ],
  builder: [
    createBodyConfig(B(6,12,18), 7), // Late-game super builders for mega projects.
    createBodyConfig(B(4, 8, 12), 6),
    createBodyConfig(B(3, 6, 9), 5),
    createBodyConfig(B(2, 4, 6), 4),
    createBodyConfig(B(2, 2, 4), 3),
    createBodyConfig(B(1, 2, 2), 2)
  ],
  upgrader: [
    createBodyConfig(B(4,1,5), 6),   // Rich rooms upgrade quickly.
    createBodyConfig(B(3,1,4), 4),
    createBodyConfig(B(2,1,3), 3),
    createBodyConfig(B(1,1,1), 1)
  ],
  repair: [
    createBodyConfig(B(5,2,7), 6),
    createBodyConfig(B(4,1,5), 4),
    createBodyConfig(B(2,1,3), 3)
  ],
  Queen: [ // keeping capitalization to match your original key
    createBodyConfig(B(0,22,22), 8), // Late tech: link/lab tenders.
    createBodyConfig(B(0,18,18), 7),
    createBodyConfig(B(0,14,14), 6),
    createBodyConfig(B(0,10,10), 5),
    createBodyConfig(B(0,7,7), 4),
    createBodyConfig(B(0,5,5), 3),
    createBodyConfig(B(0,3,3), 2),
    createBodyConfig(B(1,2,3), 2),
    createBodyConfig(B(1,1,2), 1),
    createBodyConfig(B(1,1,1), 1)
  ],
  luna: [
    createBodyConfig(B(3,6,5), 7),    // Remote workhorses once roads+links exist.
    createBodyConfig(B(3,5,4), 6),
    createBodyConfig(B(3,4,3), 6),
    createBodyConfig(B(3,3,3), 5),
    createBodyConfig(B(3,2,2), 5),
    createBodyConfig(B(2,2,2), 5),
    createBodyConfig(B(1,1,1), 5)
  ],
  Scout: [
    createBodyConfig(B(0,0,1), 3)     // Scouts appear once expansion begins.
  ],

  // Combat
  CombatMelee: [
    //TAM(6,6,12),
    createBodyConfig(TAM(4,4,8), 5),
    createBodyConfig(TAM(1,1,2), 3)
  ],
  CombatArcher: [
    //R(6,8,14),
    //R(4,6,10),//1140
    createBodyConfig(R(2,4,6), 5),
    createBodyConfig(R(1,2,3), 4)
  ],
  CombatMedic: [
   // MH(12,12),
   // MH(10,10),
    //MH(8,8),
    //MH(6,6),
   // MH(5,5),
    //MH(4,4),
    //MH(3,3),
    createBodyConfig(MH(2,2), 7),
    createBodyConfig(MH(1,1), 6)
  ],
  Dismantler: [
    //WM(25,25),
    //WM(20,20),
    //WM(15,15),
    createBodyConfig(WM(5,5), 6)
  ],

  // Special
  Claimer: [
    createBodyConfig(C(4,4), 8),
    createBodyConfig(C(3,3), 7),
    createBodyConfig(C(2,2), 6),
    createBodyConfig(C(1,1), 5)
  ]
};

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
function pickBodyForTask(list, taskKey, energyAvailable, rcl, filterByRcl) {
  for (var i = 0; i < list.length; i++) {
    var entry = normalizeBodyEntry(list[i]);
    if (filterByRcl && rcl && (rcl < entry.minRcl || rcl > entry.maxRcl)) {
      continue;
    }

    var body = entry.body;
    if (!body || !body.length) continue;

    var cost = _.sum(body, function (part) { return BODYPART_COST[part]; });
    if (cost <= energyAvailable) {
      if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
        var rangeNote = '';
        if (filterByRcl && rcl) {
          rangeNote = ' (RCL ' + entry.minRcl + '-' + entry.maxRcl + ')';
        }
        spawnLog.debug('Picked', taskKey, 'body:', '[' + body + ']', 'cost', cost, '(avail', energyAvailable + ')' + rangeNote);
      }
      return body;
    }
  }
  return [];
}

function Generate_Body_From_Config(taskKey, energyAvailable, opts) {
  var list = CONFIGS[taskKey];
  if (!list) {
    if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
      spawnLog.debug('No config for task:', taskKey);
    }
    return [];
  }

  var rcl = opts && (opts.rcl || opts.roomRcl);
  var room = opts && opts.room;
  var roomName = room ? room.name : (opts && opts.roomName);
  var capacity = opts && (opts.capacity || opts.energyCapacity);
  var targetEnergy = energyAvailable;
  if (capacity && capacity < targetEnergy) {
    targetEnergy = capacity;
  }

  var preferred = pickBodyForTask(list, taskKey, targetEnergy, rcl, true);

  if (!preferred.length && capacity && capacity < energyAvailable) {
    preferred = pickBodyForTask(list, taskKey, capacity, rcl, true);
  }

  if (!preferred.length && rcl) {
    preferred = pickBodyForTask(list, taskKey, targetEnergy, null, false);
  }

  if (!preferred.length && capacity && capacity < targetEnergy) {
    preferred = pickBodyForTask(list, taskKey, capacity, null, false);
  }

  if (!preferred.length) {
    var last = normalizeBodyEntry(list[list.length - 1]);
    var minCost = bodyCost(last.body);
    if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
      spawnLog.debug('Insufficient energy for', taskKey, '(need at least', minCost, 'at RCL >=', last.minRcl + ')');
    }
    return [];
  }

  if (roomName) {
    var tierEntry = null;
    for (var i = 0; i < list.length; i++) {
      var entry = normalizeBodyEntry(list[i]);
      if (!entry.body || !entry.body.length) continue;
      if (rcl && (rcl < entry.minRcl || rcl > entry.maxRcl)) continue;
      tierEntry = entry;
      break;
    }
    if (tierEntry) {
      var tierCost = bodyCost(tierEntry.body);
      var chosenCost = bodyCost(preferred);
      // Document downshifts when the room lacks the energy capacity for the tier body.
      if (capacity && capacity < tierCost && chosenCost < tierCost) {
        BeeToolbox.noteSpawnDownshift(roomName, 'Downshifted ' + taskKey + ' to cost ' + chosenCost + ' (tier body ' + tierCost + ')');
      }
    }
  }

  return preferred;
}

// Helper to normalize a requested task into a CONFIGS key.
function normalizeTask(task) {
  if (!task) return task;
  var lower = String(task).toLowerCase();
  var key = TASK_ALIAS[task] || TASK_ALIAS[lower] || task;
  return key;
}

// ---------- Role-specific wrappers (kept for API compatibility) ----------
function Generate_Courier_Body(e, opts) { return Generate_Body_From_Config('courier', e, opts); }
function Generate_BaseHarvest_Body(e, opts) { return Generate_Body_From_Config('baseharvest', e, opts); }
function Generate_Builder_Body(e, opts) { return Generate_Body_From_Config('builder', e, opts); }
function Generate_Repair_Body(e, opts) { return Generate_Body_From_Config('repair', e, opts); }
function Generate_Queen_Body(e, opts) { return Generate_Body_From_Config('Queen', e, opts); }
function Generate_Luna_Body(e, opts) { return Generate_Body_From_Config('luna', e, opts); }
function Generate_Upgrader_Body(e, opts) { return Generate_Body_From_Config('upgrader', e, opts); }
function Generate_Scout_Body(e, opts) { return Generate_Body_From_Config('Scout', e, opts); }
function Generate_CombatMelee_Body(e, opts) { return Generate_Body_From_Config('CombatMelee', e, opts); }
function Generate_CombatArcher_Body(e, opts) { return Generate_Body_From_Config('CombatArcher', e, opts); }
function Generate_CombatMedic_Body(e, opts) { return Generate_Body_From_Config('CombatMedic', e, opts); }
function Generate_Dismantler_Config_Body(e, opts) { return Generate_Body_From_Config('Dismantler', e, opts); }
function Generate_Claimer_Body(e, opts) { return Generate_Body_From_Config('Claimer', e, opts); }

// ---------- Task → Body helper (kept for API compatibility) ----------
function getBodyForTask(task, energyAvailable, opts) {
  var key = normalizeTask(task);
  switch (key) {
    case 'builder':        return Generate_Builder_Body(energyAvailable, opts);
    case 'repair':         return Generate_Repair_Body(energyAvailable, opts);
    case 'baseharvest':    return Generate_BaseHarvest_Body(energyAvailable, opts);
    case 'upgrader':       return Generate_Upgrader_Body(energyAvailable, opts);
    case 'courier':        return Generate_Courier_Body(energyAvailable, opts);
    case 'luna':           return Generate_Luna_Body(energyAvailable, opts);
    case 'Scout':          return Generate_Scout_Body(energyAvailable, opts);
    case 'Queen':          return Generate_Queen_Body(energyAvailable, opts);
    case 'CombatArcher':   return Generate_CombatArcher_Body(energyAvailable, opts);
    case 'CombatMelee':    return Generate_CombatMelee_Body(energyAvailable, opts);
    case 'CombatMedic':    return Generate_CombatMedic_Body(energyAvailable, opts);
    case 'Dismantler':     return Generate_Dismantler_Config_Body(energyAvailable, opts);
    case 'Claimer':        return Generate_Claimer_Body(energyAvailable, opts);
    // Aliases
    case 'trucker':        return Generate_Courier_Body(energyAvailable, opts);
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
  var roomRcl = BeeToolbox.getRoomRcl(spawn && spawn.room);
  // Allow direct role spawns (like queens) to respect the same RCL-aware bodies.
  var room = spawn ? spawn.room : null;
  var capacity = BeeToolbox.energyCapacity(room);
  var body = generateBodyFn(availableEnergy, { rcl: roomRcl, room: room, capacity: capacity });
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

  // Scale Worker_Bee bodies by the home room's controller tier.
  var roomRcl = BeeToolbox.getRoomRcl(spawn ? spawn.room : null);
  var capacity = BeeToolbox.energyCapacity(spawn ? spawn.room : null);
  var bodyOptions = { rcl: roomRcl, room: spawn ? spawn.room : null, capacity: capacity };
  var body = getBodyForTask(neededTask, energy, bodyOptions);

  if (!body || !body.length) {
    if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
      spawnLog.debug('No body available for', neededTask, 'energy', energy);
    }
    if (spawn && spawn.room) {
      BeeToolbox.noteSpawnDownshift(spawn.room.name, 'Blocked ' + neededTask + ' spawn: no viable body at ' + energy + ' energy.');
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
    var bodies = [];
    var cfgList = CONFIGS[task];
    for (var i = 0; i < cfgList.length; i++) {
      bodies.push(normalizeBodyEntry(cfgList[i]).body);
    }
    list.push({ task: task, body: bodies });
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
  Spawn_Worker_Bee: Spawn_Worker_Bee
};
