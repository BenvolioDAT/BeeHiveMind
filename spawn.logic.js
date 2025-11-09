'use strict';

// CHANGELOG:
// - Removed CONFIGS; use ROLE_CONFIGS for canonical role definitions.
// - Removed directRoleForTask/TASK_ALIAS helpers; use normalizeRole() instead.
// - Removed deprecated Generate_* and Spawn_Worker_Bee shims; call spawnRole()/getBodyForRole().

var Logger = require('core.logger');
var LOG_LEVEL = Logger.LOG_LEVEL;
var spawnLog = Logger.createLogger('Spawn', LOG_LEVEL.BASIC);

// -----------------------------------------------------------------------------
// Body builders (ES5-only helpers to construct Screeps body arrays)
// -----------------------------------------------------------------------------
function pushParts(target, part, count) {
  for (var i = 0; i < count; i++) {
    target.push(part);
  }
}

function buildBody() {
  return [];
}

function B(w, c, m) {
  var body = buildBody();
  pushParts(body, WORK, w || 0);
  pushParts(body, CARRY, c || 0);
  pushParts(body, MOVE, m || 0);
  return body;
}

function CM(c, m) {
  var body = buildBody();
  pushParts(body, CARRY, c || 0);
  pushParts(body, MOVE, m || 0);
  return body;
}

function WM(w, m) {
  var body = buildBody();
  pushParts(body, WORK, w || 0);
  pushParts(body, MOVE, m || 0);
  return body;
}

function MH(m, h) {
  var body = buildBody();
  pushParts(body, MOVE, m || 0);
  pushParts(body, HEAL, h || 0);
  return body;
}

function TAM(t, a, m) {
  var body = buildBody();
  pushParts(body, TOUGH, t || 0);
  pushParts(body, ATTACK, a || 0);
  pushParts(body, MOVE, m || 0);
  return body;
}

function R(t, r, m) {
  var body = buildBody();
  pushParts(body, TOUGH, t || 0);
  pushParts(body, RANGED_ATTACK, r || 0);
  pushParts(body, MOVE, m || 0);
  return body;
}

function A(t, a, r, h, w, c, m) {
  var body = buildBody();
  pushParts(body, TOUGH, t || 0);
  pushParts(body, ATTACK, a || 0);
  pushParts(body, RANGED_ATTACK, r || 0);
  pushParts(body, HEAL, h || 0);
  pushParts(body, WORK, w || 0);
  pushParts(body, CARRY, c || 0);
  pushParts(body, MOVE, m || 0);
  return body;
}

function C(c, m) {
  var body = buildBody();
  pushParts(body, CLAIM, c || 0);
  pushParts(body, MOVE, m || 0);
  return body;
}

// -----------------------------------------------------------------------------
// Role configuration (canonical names only)
// -----------------------------------------------------------------------------
var ROLE_CONFIGS = {
  BaseHarvest: [
    B(6, 1, 5),
    B(5, 1, 5),
    B(4, 1, 4),
    B(3, 1, 3),
    B(2, 1, 2),
    B(1, 1, 1)
  ],
  Courier: [
    CM(30, 15),
    CM(23, 23),
    CM(22, 22),
    CM(21, 21),
    CM(20, 20),
    CM(19, 19),
    CM(18, 18),
    CM(17, 17),
    CM(16, 16),
    CM(15, 15),
    CM(14, 14),
    CM(13, 13),
    CM(12, 12),
    CM(11, 11),
    CM(10, 10),
    CM(9, 9),
    CM(8, 8),
    CM(7, 7),
    CM(6, 6),
    CM(5, 5),
    CM(4, 4),
    CM(3, 3),
    CM(2, 2),
    CM(1, 1)
  ],
  Builder: [
    B(3, 6, 9),
    B(2, 4, 6),
    B(2, 2, 4),
    B(1, 1, 2),
    B(1, 1, 1)
  ],
  Repair: [
    B(5, 2, 7),
    B(4, 1, 5),
    B(2, 1, 3)
  ],
  Upgrader: [
    B(3, 2, 5),
    B(2, 2, 4),
    B(2, 1, 3),
    B(1, 1, 2),
    B(1, 1, 1)
  ],
  Queen: [
    B(0, 22, 22),
    B(0, 21, 21),
    B(0, 20, 20),
    B(0, 19, 19),
    B(0, 18, 18),
    B(0, 17, 17),
    B(0, 16, 16),
    B(0, 15, 15),
    B(0, 14, 14),
    B(0, 13, 13),
    B(0, 12, 12),
    B(0, 11, 11),
    B(0, 10, 10),
    B(0, 9, 9),
    B(0, 8, 8),
    B(0, 7, 7),
    B(0, 6, 6),
    B(0, 5, 5),
    B(0, 4, 4),
    B(0, 3, 3),
    B(0, 2, 2),
    B(0, 1, 1)
  ],
  Luna: [
    B(3, 4, 7),
    B(2, 4, 6),
    B(2, 3, 5),
    B(1, 3, 4),
    B(1, 2, 3),
    B(1, 1, 2),
    B(1, 1, 1)
  ],
  Scout: [
    B(0, 0, 1)
  ],
  CombatMelee: [
    A(0, 2, 0, 0, 0, 0, 2)
  ],
  CombatArcher: [
    R(2, 4, 6),
    R(1, 2, 3)
  ],
  CombatMedic: [
    MH(4, 4),
    MH(3, 3),
    MH(2, 2),
    MH(1, 1)
  ],
  Dismantler: [
    WM(5, 5)
  ],
  Claimer: [
    C(2, 2),
    C(1, 1)
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
  if (!role && role !== 0) return null;
  var key = String(role);
  if (!key) return null;
  if (ROLE_NORMALIZE_MAP[key]) return ROLE_NORMALIZE_MAP[key];
  var lower = key.toLowerCase();
  if (ROLE_NORMALIZE_MAP[lower]) return ROLE_NORMALIZE_MAP[lower];
  return null;
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

function getBodyForRole(roleName, energyAvailable) {
  var energy = energyAvailable | 0;
  if (!roleName) return [];
  var list = ROLE_CONFIGS[roleName];
  if (!list) {
    if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
      spawnLog.debug('No config for role', roleName);
    }
    return [];
  }
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
  var canonicalRole = normalizeRole(roleName);
  if (!canonicalRole) {
    if (Logger.shouldLog(LOG_LEVEL.WARN)) {
      spawnLog.warn('Unknown role requested:', roleName);
    }
    return false;
  }
  var energy = availableEnergy | 0;
  var body = getBodyForRole(canonicalRole, energy);
  if (!body || !body.length) {
    return false;
  }
  var creepName = Generate_Creep_Name(canonicalRole);
  if (!creepName) {
    return false;
  }
  var mem = copyMemory(memory);
  if (!mem.role) mem.role = canonicalRole;
  if (!mem.bornRole) mem.bornRole = canonicalRole;
  if (mem.skipTaskMemory) {
    delete mem.skipTaskMemory;
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
    var room = null;
    if (spawnOrRoom.room) {
      room = spawnOrRoom.room;
    } else if (typeof spawnOrRoom === 'string') {
      room = Game.rooms[spawnOrRoom];
    } else {
      room = spawnOrRoom;
    }
    if (!room) return 0;
    return room.energyAvailable;
  }

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
function Spawn_Squad(spawn, squadId) {
  var id = squadId || 'Alpha';
  if (!spawn || spawn.spawning) return false;

  if (!Memory.squads) Memory.squads = {};
  if (!Memory.squads[id]) Memory.squads[id] = {};
  var S = Memory.squads[id];
  var COOLDOWN_TICKS = 1;

  function desiredLayout(score) {
    var threat = score | 0;
    var melee = 2;
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

  var flagName = 'Squad' + id;
  var altFlagName = 'Squad_' + id;
  var flag = Game.flags[flagName] || Game.flags[altFlagName] || Game.flags[id] || null;
  var squadFlagsMem = Memory.squadFlags || {};
  var bindings = squadFlagsMem.bindings || {};

  var targetRoom = bindings[flagName] || bindings[altFlagName] || bindings[id] || null;
  if (!targetRoom && flag && flag.pos) targetRoom = flag.pos.roomName;
  if (!targetRoom) return false;

  if (Game.map && typeof Game.map.getRoomLinearDistance === 'function') {
    var dist = Game.map.getRoomLinearDistance(spawn.room.name, targetRoom, true);
    if (typeof dist === 'number' && dist > 3) return false;
  }

  var roomInfo = squadFlagsMem.rooms && squadFlagsMem.rooms[targetRoom] ? squadFlagsMem.rooms[targetRoom] : null;
  var threatScore = roomInfo && typeof roomInfo.lastScore === 'number' ? roomInfo.lastScore : 0;
  var layout = desiredLayout(threatScore);
  if (!layout.length) return false;

  S.targetRoom = targetRoom;
  S.lastKnownScore = threatScore;
  S.flagName = flag ? flag.name : null;
  S.desiredCounts = {};
  for (var li = 0; li < layout.length; li++) {
    var plan = layout[li];
    S.desiredCounts[plan.role] = plan.need | 0;
  }
  S.lastEvaluated = Game.time;

  function matchesSquadRole(mem, taskName) {
    if (!mem || !taskName) return false;
    var target = String(taskName).toLowerCase();
    var role = mem.role ? String(mem.role).toLowerCase() : null;
    if (role === target) return true;
    var bornRole = mem.bornRole ? String(mem.bornRole).toLowerCase() : null;
    if (bornRole === target) return true;
    var task = mem.task ? String(mem.task).toLowerCase() : null;
    if (task === target) return true;
    var bornTask = mem.bornTask ? String(mem.bornTask).toLowerCase() : null;
    if (bornTask === target) return true;
    return false;
  }

  function haveCount(taskName) {
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

  if (S.lastSpawnAt && Game.time - S.lastSpawnAt < COOLDOWN_TICKS) {
    return false;
  }

  var avail = Calculate_Spawn_Resource(spawn);

  for (var i = 0; i < layout.length; i++) {
    var plan = layout[i];
    if ((plan.need | 0) <= 0) continue;
    var have = haveCount(plan.role);
    if (have < plan.need) {
      var extraMemory = {
        squadId: id,
        role: plan.role,
        targetRoom: targetRoom,
        skipTaskMemory: true
      };
      var ok = spawnRole(spawn, plan.role, avail, extraMemory);
      if (ok) {
        S.lastSpawnAt = Game.time;
        S.lastSpawnRole = plan.role;
        return true;
      }
      return false;
    }
  }
  return false;
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
  var list = ROLE_CONFIGS[canonicalRole];
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
