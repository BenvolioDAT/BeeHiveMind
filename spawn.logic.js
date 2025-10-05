'use strict';

var Logger = require('core.logger');
var LOG_LEVEL = Logger.LOG_LEVEL;
var spawnLog = Logger.createLogger('Spawn', LOG_LEVEL.BASIC);

var BeeToolbox = require('BeeToolbox');
var EconomyManager = require('EconomyManager');
var CombatConfigs = require('bodyConfigs.combat.es5');

var WORKER_TIERS = {
  baseharvest: [
    { name: 'low',  body: [WORK, WORK, CARRY, MOVE] },
    { name: 'mid',  body: [WORK, WORK, WORK, CARRY, MOVE, MOVE] },
    { name: 'high', body: [WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE] }
  ],
  courier: [
    { name: 'low', body: [CARRY, CARRY, MOVE, MOVE] },
    { name: 'mid', body: [CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE] },
    { name: 'high', body: [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE] }
  ],
  builder: [
    { name: 'low', body: [WORK, CARRY, CARRY, MOVE, MOVE] },
    { name: 'mid', body: [WORK, WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE] },
    { name: 'high', body: [WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE] }
  ],
  repair: [
    { name: 'low', body: [WORK, CARRY, MOVE] },
    { name: 'mid', body: [WORK, WORK, CARRY, CARRY, MOVE, MOVE] },
    { name: 'high', body: [WORK, WORK, WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE] }
  ],
  upgrader: [
    { name: 'low', body: [WORK, WORK, CARRY, MOVE] },
    { name: 'mid', body: [WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE] },
    { name: 'high', body: [WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE] }
  ],
  Queen: [
    { name: 'low', body: [CARRY, CARRY, MOVE] },
    { name: 'mid', body: [CARRY, CARRY, CARRY, CARRY, MOVE, MOVE] },
    { name: 'high', body: [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE] }
  ],
  luna: [
    { name: 'low', body: [WORK, CARRY, MOVE, MOVE] },
    { name: 'mid', body: [WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE] },
    { name: 'high', body: [WORK, WORK, WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE] }
  ],
  Scout: [
    { name: 'low', body: [MOVE] }
  ],
  Claimer: [
    { name: 'low', body: [CLAIM, MOVE] },
    { name: 'mid', body: [CLAIM, CLAIM, MOVE, MOVE] }
  ]
};

var configurations = [];
function _populateConfigurations() {
  configurations.length = 0;
  var task;
  for (task in WORKER_TIERS) {
    if (!WORKER_TIERS.hasOwnProperty(task)) continue;
    configurations.push({ task: task, body: WORKER_TIERS[task][0].body });
  }
  for (task in CombatConfigs) {
    if (!CombatConfigs.hasOwnProperty(task)) continue;
    var tiers = CombatConfigs[task];
    if (tiers && tiers.length) configurations.push({ task: task, body: tiers[0].body });
  }
}
_populateConfigurations();

var TASK_ALIAS = {
  trucker: 'courier',
  queen: 'Queen',
  scout: 'Scout',
  claimer: 'Claimer'
};

function _clone(arr) {
  var out = [];
  for (var i = 0; i < arr.length; i++) out.push(arr[i]);
  return out;
}

function _bodyCost(parts) {
  var total = 0;
  for (var i = 0; i < parts.length; i++) total += BODYPART_COST[parts[i]] || 0;
  return total;
}

function Calculate_Spawn_Resource(target) {
  if (target) {
    var room = target.room || (Game.rooms[target] || target);
    if (room && room.energyAvailable != null) {
      return room.energyAvailable;
    }
  }
  var total = 0;
  for (var name in Game.spawns) {
    if (!Game.spawns.hasOwnProperty(name)) continue;
    var sp = Game.spawns[name];
    total += sp.store[RESOURCE_ENERGY] || 0;
  }
  for (var id in Game.structures) {
    if (!Game.structures.hasOwnProperty(id)) continue;
    var st = Game.structures[id];
    if (st.structureType === STRUCTURE_EXTENSION) {
      total += st.store[RESOURCE_ENERGY] || 0;
    }
  }
  return total;
}

function _tiersFor(taskKey) {
  if (CombatConfigs[taskKey]) {
    return CombatConfigs[taskKey];
  }
  if (WORKER_TIERS[taskKey]) return WORKER_TIERS[taskKey];
  return null;
}

function Generate_Body_From_Config(taskKey, energy) {
  var tiers = _tiersFor(taskKey);
  if (!tiers || !tiers.length) return [];
  if (CombatConfigs[taskKey]) {
    return BeeToolbox.buildBodyByBudget(taskKey, energy, tiers);
  }
  var chosen = tiers[0].body;
  for (var i = 0; i < tiers.length; i++) {
    var cost = _bodyCost(tiers[i].body);
    if (cost <= energy) {
      chosen = tiers[i].body;
    } else {
      break;
    }
  }
  return _clone(chosen);
}

function normalizeTask(task) {
  if (!task) return task;
  var lower = task.toLowerCase ? task.toLowerCase() : task;
  return TASK_ALIAS[lower] || TASK_ALIAS[task] || task;
}

function getBodyForTask(task, energy) {
  var key = normalizeTask(task);
  return Generate_Body_From_Config(key, energy);
}

function Generate_Creep_Name(role, max) {
  var limit = max || 70;
  for (var i = 1; i <= limit; i++) {
    var name = role + '_' + i;
    if (!Game.creeps[name]) return name;
  }
  return null;
}

function _shouldSpawn(spawn, roleName, cost) {
  if (EconomyManager && typeof EconomyManager.shouldSpawn === 'function') {
    return EconomyManager.shouldSpawn(spawn.room, roleName, cost);
  }
  return true;
}

function _recordCost(spawn, cost) {
  if (EconomyManager && typeof EconomyManager.recordSpawnCost === 'function') {
    EconomyManager.recordSpawnCost(spawn.room, cost);
  }
}

function Spawn_Creep_Role(spawn, roleName, generateBodyFn, availableEnergy, memory) {
  if (!spawn || spawn.spawning) return false;
  if (!BeeToolbox.ensureUniqueReservation('spawn:' + spawn.name, 1)) return false;
  var body = generateBodyFn(availableEnergy);
  if (!body || !body.length) return false;
  var cost = _bodyCost(body);
  if (availableEnergy < cost) return false;
  if (!_shouldSpawn(spawn, roleName, cost)) return false;
  var name = Generate_Creep_Name(roleName);
  if (!name) return false;
  var mem = memory || {};
  mem.role = roleName;
  var result = spawn.spawnCreep(body, name, { memory: mem });
  if (result === OK) {
    _recordCost(spawn, cost);
    if (Logger.shouldLog(LOG_LEVEL.BASIC)) {
      spawnLog.info('spawned', roleName, '→', name);
    }
    return true;
  }
  return false;
}

function Spawn_Worker_Bee(spawn, task, energy, extraMemory) {
  var mem = extraMemory || {};
  mem.role = 'Worker_Bee';
  mem.task = task;
  mem.bornTask = task;
  return Spawn_Creep_Role(spawn, 'Worker_Bee', function (avail) {
    return getBodyForTask(task, avail);
  }, energy, mem);
}

function _countSquadMembers(squadId, taskName) {
  var count = 0;
  for (var cname in Game.creeps) {
    if (!Game.creeps.hasOwnProperty(cname)) continue;
    var c = Game.creeps[cname];
    if (!c || !c.my || !c.memory) continue;
    if ((c.memory.squadId || 'Alpha') !== squadId) continue;
    if ((c.memory.task || c.memory.role) !== taskName) continue;
    count++;
  }
  for (var n in Memory.creeps) {
    if (!Memory.creeps.hasOwnProperty(n)) continue;
    if (Game.creeps[n]) continue;
    var mem = Memory.creeps[n];
    if (!mem) continue;
    if ((mem.squadId || 'Alpha') !== squadId) continue;
    if ((mem.task || mem.role) !== taskName) continue;
    count++;
  }
  return count;
}

function _planLayout(energy, threatType, threatScore) {
  var layout = [];
  var melee = 1;
  var medic = 1;
  var archer = 0;
  if (threatType === 'FORTRESS') {
    if (energy >= 2600) { melee = 2; medic = 2; archer = 1; }
    else if (energy >= 1800) { melee = 2; medic = 1; archer = 1; }
    else { melee = 1; medic = 1; archer = 1; }
  } else {
    if (threatScore >= 15 || energy >= 1600) { melee = 1; medic = 1; archer = 1; }
  }
  layout.push({ role: 'CombatMelee', need: melee });
  if (archer > 0) layout.push({ role: 'CombatArcher', need: archer });
  layout.push({ role: 'CombatMedic', need: medic });
  layout.push({ role: 'Dismantler', need: threatType === 'FORTRESS' ? 1 : 0 });
  return layout;
}

function Spawn_Squad(spawn, binding) {
  if (!spawn || !binding) return false;
  var squadId = binding.squadId || 'Alpha';
  var threatScore = binding.threatScore || 0;
  var threatType = binding.threatType || 'NPC';
  var layout = _planLayout(Calculate_Spawn_Resource(spawn), threatType, threatScore);
  var energy = Calculate_Spawn_Resource(spawn);
  for (var i = 0; i < layout.length; i++) {
    var need = layout[i];
    if ((need.need || 0) <= 0) continue;
    var have = _countSquadMembers(squadId, need.role);
    if (have >= need.need) continue;
    var mem = { squadId: squadId, task: need.role, homeRoom: spawn.room.name, targetRoom: binding.targetRoom, threatType: threatType };
    var ok = Spawn_Creep_Role(spawn, need.role, function (avail) {
      return getBodyForTask(need.role, avail);
    }, energy, mem);
    if (ok) return true;
    return true;
  }
  return false;
}

module.exports = {
  Generate_Creep_Name: Generate_Creep_Name,
  Calculate_Spawn_Resource: Calculate_Spawn_Resource,
  configurations: configurations,
  Generate_Body_From_Config: Generate_Body_From_Config,
  Spawn_Creep_Role: Spawn_Creep_Role,
  Spawn_Squad: Spawn_Squad,
  Generate_Courier_Body: function (e) { return Generate_Body_From_Config('courier', e); },
  Generate_BaseHarvest_Body: function (e) { return Generate_Body_From_Config('baseharvest', e); },
  Generate_Upgrader_Body: function (e) { return Generate_Body_From_Config('upgrader', e); },
  Generate_Builder_Body: function (e) { return Generate_Body_From_Config('builder', e); },
  Generate_Repair_Body: function (e) { return Generate_Body_From_Config('repair', e); },
  Generate_Queen_Body: function (e) { return Generate_Body_From_Config('Queen', e); },
  Generate_Luna_Body: function (e) { return Generate_Body_From_Config('luna', e); },
  Generate_Scout_Body: function (e) { return Generate_Body_From_Config('Scout', e); },
  Generate_CombatMelee_Body: function (e) { return Generate_Body_From_Config('CombatMelee', e); },
  Generate_CombatArcher_Body: function (e) { return Generate_Body_From_Config('CombatArcher', e); },
  Generate_CombatMedic_Body: function (e) { return Generate_Body_From_Config('CombatMedic', e); },
  Generate_Dismantler_Config_Body: function (e) { return Generate_Body_From_Config('Dismantler', e); },
  Generate_Claimer_Body: function (e) { return Generate_Body_From_Config('Claimer', e); },
  getBodyForTask: getBodyForTask,
  Spawn_Worker_Bee: Spawn_Worker_Bee
};
