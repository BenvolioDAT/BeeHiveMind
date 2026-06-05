'use strict';

// -----------------------------------------------------------------------------
// spawn.logic.js - body selection and spawn execution helpers
// Owns:
// * Canonical role-name normalization for spawn requests.
// * getBodyForRole(), minEnergyFor(), Generate_Creep_Name(), spawnRole(), and
//   Spawn_Squad() APIs consumed by BeeSpawnManager and legacy callers.
// Memory paths read/written:
// * Writes new creep memory only through spawn.spawnCreep({ memory: mem }).
// * Reads/writes Memory.squads for squad spawn cooldowns, desiredCounts, and
//   lastSpawnAt/lastSpawnRole diagnostics.
// Usually called by:
// * BeeSpawnManager.dequeueAndSpawn() for ordinary role queue items.
// * BeeSpawnManager.trySpawnSquad()/remote-defense flow for combat roles.
// Depends on:
// * Spawn.BodyConfig.js for role body tables and Combat.Squads for threat
//   based squad spawning.
// Do not casually change:
// * Canonical role names, memory copy behavior, squad memory fields, or body
//   list ordering. Those are part of the spawn queue contract.
// -----------------------------------------------------------------------------

var Logger = require('core.logger');
var LOG_LEVEL = Logger.LOG_LEVEL;
var spawnLog = Logger.createLogger('Spawn', LOG_LEVEL.BASIC);
var CombatSquads = require('Combat.Squads');
var SquadFlagIntel = CombatSquads.SquadFlagIntel || null;
var CoreConfig = require('core.config');
var BodyUtils = require('core.body');
var Roles = require('core.roles');
var UpgraderRoleConfig = require('role.Upgrader.Config');
var VeinseekerRoleConfig = require('role.Veinseeker.Config');
// Body definitions now live in Spawn.BodyConfig.js (registry of role body lists).
var BodyConfig = require('Spawn.BodyConfig');

var UPGRADER_CONFIG = {
  minUpgraders: UpgraderRoleConfig.UPGRADE_MIN_CREEPS || 1,
  maxUpgraders: UpgraderRoleConfig.UPGRADE_MAX_CREEPS_DEFAULT || 4,
  storageEnergyForExtraUpgraders: UpgraderRoleConfig.UPGRADE_STORAGE_EXTRA_UPGRADERS_AT || 50000,
  storageEnergyForMaxUpgraders: UpgraderRoleConfig.UPGRADE_STORAGE_MAX_UPGRADERS_AT || 150000,
  emergencyTicksToDowngrade: UpgraderRoleConfig.UPGRADE_DOWNGRADE_DANGER_TICKS || 5000,
  debug: UpgraderRoleConfig.UPGRADE_SPAWN_DEBUG === true
};

var VEINSEEKER_CONFIG = {
  targetWorkPartsPerSource: VeinseekerRoleConfig.VEINSEEKER_TARGET_WORK_PARTS_PER_SOURCE || 6,
  minimumWorkPartsPerCreep: VeinseekerRoleConfig.VEINSEEKER_MINIMUM_WORK_PARTS_PER_CREEP || 2,
  ignoreCreepWhenTicksToLiveBelow: VeinseekerRoleConfig.VEINSEEKER_IGNORE_TTL_BELOW || 100,
  maxVeinseekersPerSource: VeinseekerRoleConfig.VEINSEEKER_MAX_PER_SOURCE || 4,
  debug: VeinseekerRoleConfig.VEINSEEKER_SPAWN_DEBUG === true
};

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
// Role configuration (canonical names only)
// -----------------------------------------------------------------------------
// getBodyForRole() still picks the first affordable body from each largest→smallest list.
// This keeps spawn behavior the same while making body tuning easier to maintain.
var ROLE_CONFIGS = BodyConfig.ROLE_CONFIGS;

function normalizeRole(role) {
  // All spawn queue entries eventually pass through this gate. Returning null
  // rejects unknown roles before body selection or spawn memory is created.
  return Roles.canonicalSpawnRole(role);
}

function calculateBodyCost(body) {
  return BodyUtils.calculateBodyCost(body);
}

function getBodyCost(body) {
  // Public wrapper for queue managers. Keeping the old internal function name
  // lets existing code stay readable while newer callers use getBodyCost().
  return calculateBodyCost(body);
}

function cloneBody(body) {
  return BodyUtils.cloneBody(body);
}

function getBodySignature(body) {
  // A signature is a stable, cheap string that lets Memory show whether two
  // bodies are the same shape without storing a second full body array.
  return BodyUtils.getBodySignature(body);
}

function summarizeBody(body) {
  // Keep the summary beginner-readable in Memory: counts by part plus a short
  // text value ordered like Screeps body definitions are usually discussed.
  return BodyUtils.summarizeBody(body);
}

function makeBodyPlan(roleName, body, cost, tierIndex, energyUsedForPlan) {
  var canonicalRole = normalizeRole(roleName);
  if (!canonicalRole || !body || !body.length) return null;
  return {
    role: canonicalRole,
    body: cloneBody(body),
    cost: cost,
    signature: getBodySignature(body),
    summary: summarizeBody(body),
    tierIndex: tierIndex,
    energyUsedForPlan: energyUsedForPlan
  };
}

function getBodyListForRole(canonicalRole, context) {
  var entry = ROLE_CONFIGS[canonicalRole];
  if (!entry) return null;
  if (Array.isArray(entry)) return entry;
  if (canonicalRole === 'Veinseeker') {
    var mode = context && context.mode === 'remote' ? 'remote' : 'home';
    return entry[mode] || entry.home || entry.remote || null;
  }
  return entry.default || null;
}

function getClaimerBodyPlanForEnergy(energy, context) {
  context = context || {};
  var available = Math.max(0, Number(energy) || 0);
  var maxClaimParts = Math.max(1, Math.min(25, Math.ceil(Number(context.maxClaimParts) || 2)));
  var desiredClaimParts = Math.max(1, Math.min(maxClaimParts, Math.ceil(Number(context.desiredClaimParts) || maxClaimParts)));
  for (var claims = desiredClaimParts; claims >= 1; claims--) {
    var body = [];
    for (var c = 0; c < claims; c++) body.push(CLAIM);
    for (var m = 0; m < claims; m++) body.push(MOVE);
    var cost = calculateBodyCost(body);
    if (cost <= available) {
      return makeBodyPlan('Claimer', body, cost, -1, available);
    }
  }
  return null;
}

function getBestBodyPlanForEnergy(roleName, energy, context) {
  // Config arrays are ordered largest-to-smallest. The first affordable entry
  // is the best plan for the supplied energy number.
  var canonicalRole = normalizeRole(roleName);
  if (!canonicalRole) return null;
  var available = typeof energy === 'number' ? energy : 0;

  if (canonicalRole === 'Trucker' && context && (context.mode || context.desiredCarryParts || context.roaded !== undefined)) {
    var truckerPlan = BodyUtils.getBestTruckerBodyPlan(available, context);
    if (truckerPlan && truckerPlan.body && truckerPlan.body.length) {
      return makeBodyPlan(canonicalRole, truckerPlan.body, truckerPlan.cost, -1, available);
    }
  }

  if (canonicalRole === 'Upgrader' && context && context.targetWorkParts) {
    var upgraderPlan = BodyUtils.getBestUpgraderBodyPlan(available, context.targetWorkParts, context);
    if (upgraderPlan && upgraderPlan.body && upgraderPlan.body.length) {
      return makeBodyPlan(canonicalRole, upgraderPlan.body, upgraderPlan.cost, -1, available);
    }
  }

  if (canonicalRole === 'Veinseeker' && context && (context.targetWorkParts || context.minimumWorkPartsPerCreep)) {
    var veinseekerPlan = BodyUtils.getBestVeinseekerBodyPlan(
      available,
      context.targetWorkParts || VEINSEEKER_CONFIG.targetWorkPartsPerSource,
      {
        mode: context.mode === 'remote' ? 'remote' : 'home',
        minimumWorkPartsPerCreep: context.minimumWorkPartsPerCreep || VEINSEEKER_CONFIG.minimumWorkPartsPerCreep,
        bodyPatternReason: context.bodyPatternReason || 'source-work-target'
      }
    );
    if (veinseekerPlan && veinseekerPlan.body && veinseekerPlan.body.length) {
      return makeBodyPlan(canonicalRole, veinseekerPlan.body, veinseekerPlan.cost, -1, available);
    }
  }

  if (canonicalRole === 'Claimer' && context && (context.desiredClaimParts || context.maxClaimParts)) {
    var claimerPlan = getClaimerBodyPlanForEnergy(available, context);
    if (claimerPlan && claimerPlan.body && claimerPlan.body.length) {
      return claimerPlan;
    }
  }

  var list = getBodyListForRole(canonicalRole, context);
  if (!list || !list.length) return null;

  for (var i = 0; i < list.length; i++) {
    var body = list[i];
    var cost = calculateBodyCost(body);
    if (cost <= available) {
      return makeBodyPlan(canonicalRole, body, cost, i, available);
    }
  }
  return null;
}

function getBestBodyPlanForRoomCapacity(roleName, room, context) {
  // Capacity planning answers "what should this room be able to support when
  // full?", which is different from "what can it afford this tick?".
  var targetRoom = room;
  if (targetRoom && targetRoom.room) targetRoom = targetRoom.room;
  if (typeof targetRoom === 'string') targetRoom = Game.rooms[targetRoom];
  var capacity = targetRoom && typeof targetRoom.energyCapacityAvailable === 'number'
    ? targetRoom.energyCapacityAvailable
    : 0;
  return getBestBodyPlanForEnergy(roleName, capacity, context);
}

function getBodyForRole(roleName, energyAvailable, context) {
  // Body tables are ordered largest-to-smallest. The first affordable body is
  // what spawnRole will use, so reordering body configs changes spawn behavior.
  if (!roleName) return [];

  var energy = typeof energyAvailable === 'number' ? energyAvailable : 0;
  var canonicalRole = normalizeRole(roleName);
  var list = canonicalRole ? getBodyListForRole(canonicalRole, context) : null;
  if (!list) {
    if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
      spawnLog.debug('No config for role', roleName);
    }
    return [];
  }

  // Config arrays are ordered largest→smallest; pick the first body we can afford.
  var plan = getBestBodyPlanForEnergy(canonicalRole, energy, context);
  if (plan) {
    if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
      spawnLog.debug('Picked', canonicalRole, 'body [' + plan.body + ']', 'cost', plan.cost, 'avail', energy);
    }
    return cloneBody(plan.body);
  }

  if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
    var cheapest = list[list.length - 1];
    var minCost = cheapest ? calculateBodyCost(cheapest) : 0;
    spawnLog.debug('Insufficient energy for', canonicalRole, 'need at least', minCost, 'have', energy);
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
  // Ordinary spawn entry point. It copies queue-item memory, normalizes role,
  // selects the body, creates a unique name, and calls spawn.spawnCreep.
  if (!spawn) return false;

  // Resolve the requested role into our canonical spelling before continuing.
  var canonicalRole = normalizeRole(roleName);
  if (!canonicalRole) {
    if (Logger.shouldLog(LOG_LEVEL.WARN)) {
      spawnLog.warn('Unknown role requested:', roleName);
    }
    return false;
  }

  var energy = typeof availableEnergy === 'number' ? availableEnergy : 0;
  var mem = copyMemory(memory);
  var bodyPlan = getBestBodyPlanForEnergy(canonicalRole, energy, mem);
  if (!bodyPlan || !bodyPlan.body || !bodyPlan.body.length) return false;
  var body = cloneBody(bodyPlan.body);

  var creepName = Generate_Creep_Name(canonicalRole);
  if (!creepName) return false;

  // Always persist canonical role spelling so all role modules can trust it.
  var requestedRole = mem.role || roleName;
  mem.role = canonicalRole;
  if (requestedRole && String(requestedRole) !== canonicalRole) {
    mem.requestedRole = String(requestedRole);
  }
  if (mem.skipTaskMemory) {
    delete mem.skipTaskMemory;
  }

  if (canonicalRole === 'Veinseeker') {
    mem.task = 'veinseeker';
    mem.mode = mem.mode === 'remote' ? 'remote' : 'home';
    var targetSourceId = mem.assignedSource || mem.sourceId || mem.replaceSourceId || mem.replacementTargetSourceId || null;
    if (mem.mode === 'remote' && (!targetSourceId || !mem.targetRoom)) {
      return false;
    }
    if (targetSourceId) {
      mem.assignedSource = targetSourceId;
      mem.sourceId = targetSourceId;
      if (!mem.replacementTargetSourceId) mem.replacementTargetSourceId = targetSourceId;
      if (mem.sourceWorkerSpawnMode === 'upgradeReplacement' && !mem.replaceSourceId) {
        mem.replaceSourceId = targetSourceId;
      }
    }
    if (mem.replaceCreepName && !mem.replacementFor) {
      mem.replacementFor = mem.replaceCreepName;
    }
    if (mem.replacementFor && !mem.replaceCreepName) {
      mem.replaceCreepName = mem.replacementFor;
    }
    mem.bornBodyCost = bodyPlan.cost;
    mem.bornBodySignature = bodyPlan.signature;
    mem.bornBodySummary = bodyPlan.summary;
    mem.bornAt = Game.time;
  }

  // Keep combat squad data beside the spawn call so new creeps hit the ground
  // with their rally room and wait timer already set.
  if (canonicalRole === 'CombatMelee' ||
      canonicalRole === 'CombatMedic' ||
      canonicalRole === 'CombatArcher') {
    var sid = mem.squadId || (memory && memory.squadId);
    var targetRoom = mem.targetRoom || (memory && memory.targetRoom);
    var squadFlag = mem.squadFlag || (memory && memory.squadFlag);
    if (sid && !mem.squadId) mem.squadId = sid;
    if (targetRoom && !mem.targetRoom) mem.targetRoom = targetRoom;
    if (squadFlag && !mem.squadFlag) mem.squadFlag = squadFlag;
    if (!mem.assignedAt) mem.assignedAt = Game.time;
    if (!mem.state) mem.state = 'rally';
    if (!mem.waitUntil) mem.waitUntil = Game.time + 25;
    // buddyId / stickTargetId handled by roles post-spawn
  }

  var result = spawn.spawnCreep(body, creepName, { memory: mem });
  if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
    spawnLog.debug('spawnRole', canonicalRole, 'body [' + body + ']', 'cost', calculateBodyCost(body), 'avail', energy, 'result', result);
  }
  if (result === OK) {
    if (canonicalRole === 'Veinseeker' && mem.replacementFor) {
      var oldCreep = Game.creeps[mem.replacementFor];
      if (oldCreep && oldCreep.memory) {
        oldCreep.memory.retireAfterReplacementReady = true;
        oldCreep.memory.retireReason = mem.sourceWorkerSpawnMode === 'upgradeReplacement'
          ? 'sourceWorkerBodyUpgrade'
          : 'sourceWorkerTtlReplacement';
        oldCreep.memory.replacingCreepName = creepName;
        oldCreep.memory.replacementSourceId = mem.replaceSourceId || mem.assignedSource || mem.sourceId || null;
      }
    }
    if (Logger.shouldLog(LOG_LEVEL.BASIC)) {
      spawnLog.info('Spawned', canonicalRole, '->', creepName);
    }
    return true;
  }
  return false;
}

// -----------------------------------------------------------------------------
// Energy accounting
// -----------------------------------------------------------------------------
function Calculate_Spawn_Resource(spawnOrRoom) {
  // Energy accounting shim kept for legacy callers. BeeSpawnManager normally
  // passes a specific spawn so this returns room.energyAvailable for that room.
  if (spawnOrRoom) {
    // Allow spawns, room objects, or room names.
    var room = spawnOrRoom.room || (typeof spawnOrRoom === 'string'
      ? Game.rooms[spawnOrRoom]
      : spawnOrRoom);
    return room ? room.energyAvailable : 0;
  }

  // Fallback path: sum all spawn + extension stores when no room hint is
  // provided. This mirrors how Screeps counts capacity in the UI.
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
// focused on decisions, not on repeated Memory guard noise.
function ensureSquadMemory(id) {
  // Squad Memory is keyed as "SquadX" even when callers pass "X". This keeps
  // old flags and newer remote-defense buckets pointed at the same record.
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
  var threat = typeof score === 'number' ? score : 0;
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

function normalizeRoomName(roomLike) {
  if (!roomLike) return null;
  if (typeof roomLike === 'string') return roomLike;
  // Accept both direct roomName carriers and nested squad target objects:
  // { targetRoom: "W8S57" } and { target: { roomName: "W8S57" } }.
  if (typeof roomLike.targetRoom === 'string') return roomLike.targetRoom;
  if (roomLike.target && typeof roomLike.target.roomName === 'string') return roomLike.target.roomName;
  if (typeof roomLike.roomName === 'string') return roomLike.roomName;
  if (roomLike.pos && typeof roomLike.pos.roomName === 'string') return roomLike.pos.roomName;
  if (roomLike.room && typeof roomLike.room.name === 'string') return roomLike.room.name;
  if (typeof roomLike.name === 'string') return roomLike.name;
  return null;
}

// Decide whether a remote room is too far from the spawn room based on linear room distance.
// If the inputs are not valid room names, log the problem and return true so we fail safe.
function distanceTooFar(spawnRoomName, targetRoom) {
  if (!Game.map || typeof Game.map.getRoomLinearDistance !== 'function') return false;

  var originRoomName = normalizeRoomName(spawnRoomName);
  var targetRoomName = normalizeRoomName(targetRoom);

  if (!originRoomName || !targetRoomName) {
    console.log('[Spawn][distanceTooFar] invalid room names', spawnRoomName, targetRoom);
    return true;
  }

  var dist = Game.map.getRoomLinearDistance(originRoomName, targetRoomName, true);
  if (typeof dist !== 'number') {
    console.log('[Spawn][distanceTooFar] unable to compute distance', originRoomName, targetRoomName, dist);
    return true;
  }
  return dist > 3;
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
    var needed = typeof plan.need === 'number' ? plan.need : 0;
    S.desiredCounts[plan.role] = needed;
  }
  S.lastEvaluated = Game.time;
}

// Keep spawning side-effects in one loop so it's obvious when we early return.
/**
 * spawnMissingSquadRole consumes desiredSquadLayout() output and asks
 * spawnRole() to create whichever role is currently missing, carrying
 * squadId/flag/target data along so combat creeps spawn ready to rally.
*/
function spawnMissingSquadRole(spawn, layout, id, targetRoom, avail, S, squadFlag) {
  for (var i = 0; i < layout.length; i++) {
    var plan = layout[i];
    var need = typeof plan.need === 'number' ? plan.need : 0;
    if (need <= 0) continue;
    var have = haveSquadCount(id, plan.role);
    if (have < need) {
      var extraMemory = {
        squadId: id,
        role: plan.role,
        targetRoom: targetRoom,
        squadFlag: squadFlag,
        home: spawn.room.name,
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
  var targetRoom = normalizeRoomName(flagData.targetRoom);
  if (!targetRoom) return false;
  if (distanceTooFar(spawn.room.name, targetRoom)) return false;

  var threatScore = SquadFlagIntel && typeof SquadFlagIntel.threatScoreForRoom === 'function'
    ? SquadFlagIntel.threatScoreForRoom(targetRoom)
    : 0;
  var live = null;
  if (CombatSquads && typeof CombatSquads.getLiveThreatForRoom === 'function') {
    live = CombatSquads.getLiveThreatForRoom(targetRoom);
    if (live && live.score > threatScore) {
      threatScore = live.score;
    }
  }
  var safeThreatScore = typeof threatScore === 'number' ? threatScore : 0;
  if (safeThreatScore <= 0 && (!live || !live.hasThreat)) {
    combatSpawnLog('[SpawnSkip]', id, 'room', targetRoom, 'score', safeThreatScore,
      'liveScore', live ? live.score : 0);
    return false;
  }
  var layout = desiredSquadLayout(safeThreatScore);
  if (!layout.length) return false;

  stampSquadPlanMemory(S, layout, targetRoom, safeThreatScore, flagData.flag);

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

function minEnergyFor(roleName, context) {
  // Minimum-cost cache used by BeeSpawnManager's energy gate. It must reflect
  // the cheapest configured body, not the first/largest body.
  var canonicalRole = normalizeRole(roleName);
  if (!canonicalRole) return 0;
  var cacheKey = canonicalRole;
  if (canonicalRole === 'Veinseeker') {
    cacheKey += ':' + (context && context.mode === 'remote' ? 'remote' : 'home');
    if (context && (context.targetWorkParts || context.minimumWorkPartsPerCreep)) {
      var minimumWork = context.minimumWorkPartsPerCreep || VEINSEEKER_CONFIG.minimumWorkPartsPerCreep;
      var minimumPlan = BodyUtils.getBestVeinseekerBodyPlan(10000, minimumWork, {
        mode: context.mode === 'remote' ? 'remote' : 'home',
        minimumWorkPartsPerCreep: minimumWork,
        bodyPatternReason: 'minimum-source-miner'
      });
      return minimumPlan && minimumPlan.cost ? minimumPlan.cost : 200;
    }
  }
  if (Object.prototype.hasOwnProperty.call(MIN_ENERGY_CACHE, cacheKey)) {
    return MIN_ENERGY_CACHE[cacheKey];
  }
  var list = getBodyListForRole(canonicalRole, context);
  if (!list || !list.length) {
    MIN_ENERGY_CACHE[cacheKey] = 0;
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
  MIN_ENERGY_CACHE[cacheKey] = finalCost;
  return finalCost;
}

module.exports = {
  ROLE_CONFIGS: ROLE_CONFIGS,
  UPGRADER_CONFIG: UPGRADER_CONFIG,
  VEINSEEKER_CONFIG: VEINSEEKER_CONFIG,
  normalizeRole: normalizeRole,
  getBodyCost: getBodyCost,
  calculateBodyCost: calculateBodyCost,
  cloneBody: cloneBody,
  getBodySignature: getBodySignature,
  summarizeBody: summarizeBody,
  getBestBodyPlanForEnergy: getBestBodyPlanForEnergy,
  getBestBodyPlanForRoomCapacity: getBestBodyPlanForRoomCapacity,
  getBodyForRole: getBodyForRole,
  spawnRole: spawnRole,
  minEnergyFor: minEnergyFor,
  Calculate_Spawn_Resource: Calculate_Spawn_Resource,
  Generate_Creep_Name: Generate_Creep_Name,
  Spawn_Squad: Spawn_Squad
};
