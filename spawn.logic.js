'use strict';

// CHANGELOG:
// - Removed CONFIGS; use ROLE_CONFIGS for canonical role definitions.
// - Removed directRoleForTask/TASK_ALIAS helpers; use normalizeRole() instead.
// - Removed deprecated Generate_* and Spawn_Worker_Bee shims; call spawnRole()/getBodyForRole().

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
    //CM(30, 15),
    //CM(29, 15),
    //CM(28, 14),
    //CM(27, 14),
    //CM(26, 13),
    //CM(25, 13),
    CM(24, 12),
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
    //B(3, 6, 9),
    //B(2, 4, 6),
    //B(2, 2, 4),
    B(1, 1, 2),
    B(1, 1, 1)
  ],
  Repair: [
    B(5, 2, 7),
    B(4, 1, 5),
    B(2, 1, 3)
  ],
  Upgrader: [
    B(10,5, 5),
    B(5, 5, 5),
    B(4, 4, 8),
    B(4, 3, 7),
    B(3, 3, 6),
    B(3, 2, 5),
    B(2, 2, 4),
    B(2, 1, 3),
    B(1, 1, 2),
    B(1, 1, 1)
  ],
  Queen: [
    //B(0, 22, 22),
    //B(0, 21, 21),
    //B(0, 20, 20),
    //B(0, 19, 19),
    B(0, 18, 9),
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

// ES5-safe combat squad memory initializer
function _initSquadMemory(mem, squadId, targetRoom, squadFlag) {
  if (!mem) mem = {};
  if (squadId && !mem.squadId) mem.squadId = squadId;
  if (targetRoom && !mem.targetRoom) mem.targetRoom = targetRoom;
  if (squadFlag && !mem.squadFlag) mem.squadFlag = squadFlag;
  if (!mem.assignedAt) mem.assignedAt = Game.time;
  if (!mem.state) mem.state = 'rally';
  if (!mem.waitUntil) mem.waitUntil = Game.time + 25;
  // buddyId / stickTargetId handled by roles post-spawn
  return mem;
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
  if (mem.skipTaskMemory) {
    delete mem.skipTaskMemory;
  }
  if (canonicalRole === 'CombatMelee' ||
      canonicalRole === 'CombatMedic' ||
      canonicalRole === 'CombatArcher') {
    var sid = mem.squadId || (memory && memory.squadId);
    var targetRoom = mem.targetRoom || (memory && memory.targetRoom);
    var squadFlag = mem.squadFlag || (memory && memory.squadFlag);
    mem = _initSquadMemory(mem, sid, targetRoom, squadFlag);
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
var SQUAD_COOLDOWN_TICKS = 1;

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
  var threat = score | 0;
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

// Guard rails: don't march squads across the whole shard accidentally.
function distanceTooFar(spawnRoomName, targetRoom) {
  if (!Game.map || typeof Game.map.getRoomLinearDistance !== 'function') return false;
  var dist = Game.map.getRoomLinearDistance(spawnRoomName, targetRoom, true);
  return typeof dist === 'number' && dist > 3;
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
    S.desiredCounts[plan.role] = plan.need | 0;
  }
  S.lastEvaluated = Game.time;
}

// Keep spawning side-effects in one loop so it's obvious when we early return.
/**
 * spawnMissingSquadRole consumes desiredSquadLayout() output and asks
 * spawnRole() to create whichever role is currently missing, injecting
 * squadId/flag/target data via _initSquadMemory.
 */
function spawnMissingSquadRole(spawn, layout, id, targetRoom, avail, S, squadFlag) {
  for (var i = 0; i < layout.length; i++) {
    var plan = layout[i];
    if ((plan.need | 0) <= 0) continue;
    var have = haveSquadCount(id, plan.role);
    if (have < plan.need) {
      var extraMemory = {
        squadId: id,
        role: plan.role,
        targetRoom: targetRoom,
        squadFlag: squadFlag,
        skipTaskMemory: true
      };
      var ok = spawnRole(spawn, plan.role, avail, extraMemory);
      if (ok) {
        S.lastSpawnAt = Game.time;
        S.lastSpawnRole = plan.role;
        combatSpawnLog('[SpawnSquad]', id, 'role', plan.role, 'room', targetRoom,
          'flag', squadFlag || 'n/a', 'via', spawn.name);
        return true;
      }
      combatSpawnLog('[SpawnSquadFail]', id, 'role', plan.role, 'room', targetRoom,
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
  var targetRoom = flagData.targetRoom;
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
  if ((threatScore | 0) <= 0 && (!live || !live.hasThreat)) {
    combatSpawnLog('[SpawnSkip]', id, 'room', targetRoom, 'score', threatScore,
      'liveScore', live ? live.score : 0);
    return false;
  }
  var layout = desiredSquadLayout(threatScore);
  if (!layout.length) return false;

  stampSquadPlanMemory(S, layout, targetRoom, threatScore, flagData.flag);

  if (S.lastSpawnAt && Game.time - S.lastSpawnAt < SQUAD_COOLDOWN_TICKS) {
    return false;
  }

  var avail = Calculate_Spawn_Resource(spawn);
  combatSpawnLog('[SpawnEval]', id, 'room', targetRoom, 'score', threatScore,
    'layout', JSON.stringify(layout));
  return spawnMissingSquadRole(spawn, layout, id, targetRoom, avail, S,
    flagData.flag ? flagData.flag.name : null);
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
