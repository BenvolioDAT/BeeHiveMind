'use strict';

// Documentation map for this file:
// Owns Memory.rooms[roomName].spawnQueue plus quota diagnostics such as
// lastRoleQuotas, lastTruckerQuota, lastRepairQuota, lastQueenQuota, and
// lastRemoteVision. BeeHiveMind calls manageSpawns(C) once per tick, after role
// logic has had a chance to update haul/status Memory. SourceEnergy.Manager
// provides Veinseeker source reservations and audits; spawn.logic chooses bodies and
// performs spawn.spawnCreep; Combat.Squads supplies combat pressure. Avoid
// changing queue priority, quota math, or the order of Veinseeker reserve/enqueue/
// unreserve calls without checking the SourceEnergy.Manager ownership model.

// -----------------------------------------------------------------------------
// BeeSpawnManager.js – dedicated spawning subsystem extracted from BeeHiveMind
// Responsibilities:
// * Maintain per-room spawn queues in Memory.
// * Fill queues based on quota deficits and signal helpers.
// * Enforce priority + energy gates before spawning.
// * Delegate to spawn.logic for body planning & spawn execution.
// -----------------------------------------------------------------------------

var CoreLogger  = require('core.logger');
var LOG_LEVEL   = CoreLogger.LOG_LEVEL;
var spawnLog    = CoreLogger.createLogger('HiveMind', LOG_LEVEL.BASIC);
var CoreConfig  = require('core.config');

var spawnLogic  = require('spawn.logic');
var VeinseekerConfig  = require('role.Veinseeker.Config');
var TruckerConfig = require('role.Trucker.Config');
var RepairConfig = require('role.Repair.Config');
var QueenConfig = require('role.Queen.Config');
var SourceEnergyManager = require('SourceEnergy.Manager');
var SourceWorkerManager = require('SourceWorker.Manager');
var BeeToolbox = require('BeeToolbox');
var CombatSquads = require('Combat.Squads');
var Roles = require('core.roles');
var SquadFlagIntel = CombatSquads.SquadFlagIntel || null;

// --------------------------- Tunables & Constants ------------------------
var QUEUE_RETRY_COOLDOWN  = 5;
var QUEUE_HARD_LIMIT      = 20;
var DEBUG_SPAWN_QUEUE     = true;
var DBG_EVERY             = 5;
var INVADER_LOCK_TTL = (CoreConfig.settings && CoreConfig.settings.toolbox && CoreConfig.settings.toolbox.defaultInvaderLockTtl) || 1500;
var REPLACEMENT_TTL = {
  Veinseeker: 80
};

var VEINSEEKER_ENABLE_BODY_UPGRADES = VeinseekerConfig.VEINSEEKER_ENABLE_BODY_UPGRADES !== false;
var VEINSEEKER_WAIT_FOR_BEST_BODY = VeinseekerConfig.VEINSEEKER_WAIT_FOR_BEST_BODY !== false;
var VEINSEEKER_UPGRADE_REPLACEMENTS_ENABLED = VeinseekerConfig.VEINSEEKER_UPGRADE_REPLACEMENTS_ENABLED !== false;
var VEINSEEKER_MAX_UPGRADE_WAIT_TICKS = VeinseekerConfig.VEINSEEKER_MAX_UPGRADE_WAIT_TICKS || 150;
var VEINSEEKER_REPLACEMENT_SAFE_TTL = VeinseekerConfig.VEINSEEKER_REPLACEMENT_SAFE_TTL || 120;
var VEINSEEKER_CRITICAL_TTL = VeinseekerConfig.VEINSEEKER_CRITICAL_TTL || 60;

var ROLE_PRIORITY = {
  Veinseeker: 70,
  Queen:        90,
  CombatMelee:  88,
  CombatArcher: 87,
  CombatMedic:  86,
  Upgrader:     80,
  Builder:      75,
  Repair:       60,
  Claimer:      55,
  Scout:        40,
  Trucker:      95,
  Dismantler:   30,
  
};

var VEINSEEKER_EMERGENCY_PRIORITY = 110;
var VEINSEEKER_NORMAL_PRIORITY = 100;
var VEINSEEKER_UPGRADE_PRIORITY = 65;

var ROLE_MIN_ENERGY = {
  Veinseeker: 200,
  Queen:       200,
  Upgrader:    200,
  Builder:     200,
  Repair:      200,
  Claimer:     650,
  Scout:       50,
  Trucker:     200,
  Dismantler:  150,
  CombatArcher:200,
  CombatMelee: 200,
  CombatMedic: 200
};

function canonicalRole(role) {
  return Roles.canonicalRoleName(role, {
    allowUnknown: true,
    capitalizedFallback: true
  });
}

// ------------------------------ Debug utils ------------------------------
function tickEvery(n) {
  return Game.time % n === 0;
}

function dlog() {
  if (!DEBUG_SPAWN_QUEUE) return;
  try {
    spawnLog.debug.apply(spawnLog, arguments);
  } catch (e) {
    // swallow logging errors in production
  }
}

function fmt(room) {
  return room && room.name ? room.name : String(room);
}

function energyStatus(room) {
  var available = room.energyAvailable || 0;
  var capacity = room.energyCapacityAvailable || 0;
  return available + '/' + capacity;
}

function minEnergyFor(role, context) {
  if (spawnLogic && typeof spawnLogic.minEnergyFor === 'function') {
    var override = spawnLogic.minEnergyFor(role, context);
    if (typeof override === 'number') {
      return override;
    }
  }
  return ROLE_MIN_ENERGY[role] || 200;
}

function squadSpawningEnabled() {
  return Boolean(
    CoreConfig &&
    CoreConfig.settings &&
    CoreConfig.settings.combat &&
    CoreConfig.settings.combat.ENABLE_SQUAD_SPAWNING === true
  );
}

function remoteDefenseSpawningEnabled() {
  return Boolean(
    CoreConfig &&
    CoreConfig.settings &&
    CoreConfig.settings.combat &&
    CoreConfig.settings.combat.ENABLE_REMOTE_DEFENSE_SPAWNING === true
  );
}

function ensureRoomMemory(roomName) {
  return BeeToolbox.getRoomMemoryBucket(roomName);
}

function getCheapestCombatRoleEnergy() {
  var roles = ['CombatMelee', 'CombatArcher', 'CombatMedic'];
  var cheapest = null;
  for (var i = 0; i < roles.length; i++) {
    var cost = minEnergyFor(roles[i]);
    if (typeof cost !== 'number' || cost <= 0) continue;
    if (cheapest === null || cost < cheapest) cheapest = cost;
  }
  return cheapest === null ? 200 : cheapest;
}

function hasBaseRoleDeficit(C, roomName) {
  var veinseeker = countLiveHomeVeinseekers(roomName);
  // Trucker replaced Courier as the protected base hauler role.
  var trucker = getRoomLocalLiveCount(C, roomName, 'Trucker');
  var queen = getRoomLocalLiveCount(C, roomName, 'Queen');
  return veinseeker < 1 || trucker < 1 || queen < 1;
}

function countLiveHomeVeinseekers(roomName) {
  var count = 0;
  for (var name in Game.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Game.creeps, name)) continue;
    var creep = Game.creeps[name];
    if (!creep || !creep.my || !creep.memory) continue;
    if (canonicalRole(creep.memory.role) !== 'Veinseeker') continue;
    if (creep.memory.mode === 'remote') continue;
    if (getCreepHomeRoomName(creep) !== roomName) continue;
    if (creep.spawning) continue;
    count++;
  }
  return count;
}

function countLiveRemoteVeinseekers(roomName) {
  var count = 0;
  for (var name in Game.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Game.creeps, name)) continue;
    var creep = Game.creeps[name];
    if (!creep || !creep.my || !creep.memory) continue;
    if (canonicalRole(creep.memory.role) !== 'Veinseeker') continue;
    if (creep.memory.mode !== 'remote') continue;
    if (getCreepHomeRoomName(creep) !== roomName) continue;
    if (creep.spawning) continue;
    count++;
  }
  return count;
}

function countQueuedRemoteVeinseekers(roomName) {
  var q = ensureRoomQueue(roomName);
  var count = 0;
  for (var i = 0; i < q.length; i++) {
    if (q[i] && q[i].role === 'Veinseeker' && q[i].mode === 'remote') count++;
  }
  return count;
}

function isRemoteDefenseTargetAllowed(targetRoom) {
  var myName = getMyUsernameForSpawnManager();
  var allowPvp = Boolean(CoreConfig && CoreConfig.ALLOW_PVP);
  var mem = Memory.rooms && Memory.rooms[targetRoom] ? Memory.rooms[targetRoom] : null;
  var intel = mem && mem.intel ? mem.intel : null;
  var owner = intel && intel.owner ? intel.owner : null;
  var reservation = intel && intel.reservation ? intel.reservation : null;
  if (owner && myName && owner !== myName && !allowPvp) return false;
  if (reservation && myName && reservation !== myName && !allowPvp) return false;
  return true;
}

function evaluateRemoteDefensePlan(squadName) {
  var key = normalizedSquadName(squadName);
  var bucket = Memory.squads && Memory.squads[key] ? Memory.squads[key] : null;
  var out = {
    squadName: key,
    targetRoom: null,
    score: 0,
    hasThreat: false,
    skippedReasons: []
  };
  if (!bucket || bucket.remoteDefense !== true) {
    out.skippedReasons.push('notRemoteDefense');
    return out;
  }
  if (!bucket.targetRoom) {
    out.skippedReasons.push('missingTargetRoom');
    return out;
  }
  out.targetRoom = bucket.targetRoom;
  var score = bucket.lastKnownScore || 0;
  if (SquadFlagIntel && typeof SquadFlagIntel.threatScoreForRoom === 'function') {
    var intelScore = SquadFlagIntel.threatScoreForRoom(bucket.targetRoom) || 0;
    if (intelScore > score) score = intelScore;
  }
  var live = null;
  if (CombatSquads && typeof CombatSquads.getLiveThreatForRoom === 'function') {
    live = CombatSquads.getLiveThreatForRoom(bucket.targetRoom);
    if (live && typeof live.score === 'number' && live.score > score) score = live.score;
  }
  out.score = score;
  out.hasThreat = score > 0 || Boolean(live && live.hasThreat);
  if (!out.hasThreat) out.skippedReasons.push('noThreat');
  return out;
}

function gatherRemoteDefensePlans() {
  var picks = [];
  if (!Memory.squads) return picks;
  for (var squadName in Memory.squads) {
    if (!Object.prototype.hasOwnProperty.call(Memory.squads, squadName)) continue;
    var plan = evaluateRemoteDefensePlan(squadName);
    if (plan.hasThreat) picks.push(plan);
  }
  picks.sort(function (a, b) { return b.score - a.score; });
  return picks;
}

function writeRemoteDefenseDiag(roomName, diag) {
  var roomMem = ensureRoomMemory(roomName);
  roomMem.lastRemoteDefenseSpawnEval = diag;
}

// ------------------------------ Spawn Queue ------------------------------
function ensureRoomQueue(roomName) {
  // Room queues are the persistent boundary between quota math and actual
  // spawning. Queue items can outlive the tick that created them, so each item
  // must carry enough memory for spawn.logic to create the right creep later.
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
  if (!Array.isArray(Memory.rooms[roomName].spawnQueue)) {
    Memory.rooms[roomName].spawnQueue = [];
  }
  return Memory.rooms[roomName].spawnQueue;
}

function cleanupRetiredCourierState(roomName) {
  // Historical Memory may still contain Courier queue items/creeps. This keeps
  // old saves compatible by migrating them to Trucker before quota math runs.
  var q = ensureRoomQueue(roomName);
  var removedQueueItems = 0;
  var kept = [];
  for (var i = 0; i < q.length; i++) {
    var item = q[i];
    if (!item) continue;
    var itemRole = item.role == null ? '' : String(item.role).toLowerCase();
    if (itemRole === 'courier') {
      removedQueueItems++;
      continue;
    }
    kept.push(item);
  }
  Memory.rooms[roomName].spawnQueue = kept;

  var migratedCreeps = 0;
  for (var name in Game.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Game.creeps, name)) continue;
    var creep = Game.creeps[name];
    if (!creep || !creep.memory) continue;
    var home = creep.memory.home || (creep.room && creep.room.name);
    if (home !== roomName) continue;
    var creepRole = creep.memory.role == null ? '' : String(creep.memory.role).toLowerCase();
    if (creepRole === 'courier') {
      creep.memory.role = 'Trucker';
      migratedCreeps++;
    }
  }

  Memory.rooms[roomName].lastCourierCleanup = {
    tick: Game.time,
    removedQueueItems: removedQueueItems,
    migratedCreeps: migratedCreeps,
    notes: 'retired role cleanup'
  };
}

function queuedCount(roomName, role) {
  var q = ensureRoomQueue(roomName);
  var count = 0;
  for (var i = 0; i < q.length; i++) {
    if (q[i] && q[i].role === role) {
      count++;
    }
  }
  return count;
}

function getRoomLocalLiveCount(C, roomName, role) {
  if (!C || !roomName || !role) return 0;

  if (role === 'Veinseeker') {
    return (C.veinseekerCountsByHome && C.veinseekerCountsByHome[roomName]) || 0;
  }

  var byRoom = C.roleCountsByRoom || {};
  var roomCounts = byRoom[roomName] || {};
  return roomCounts[role] || 0;
}

function countRoleNeedingReplacement(roomName, role, threshold) {
  if (!roomName || !role || !threshold || threshold <= 0) return 0;
  var count = 0;
  for (var name in Game.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Game.creeps, name)) continue;
    var creep = Game.creeps[name];
    if (!creep || !creep.memory) continue;
    var creepRole = canonicalRole(creep.memory.role);
    if (creepRole !== role) continue;
    var home = creep.memory.home || (creep.room && creep.room.name);
    if (home !== roomName) continue;
    if (typeof creep.ticksToLive !== 'number') continue;
    if (creep.ticksToLive <= threshold) count++;
  }
  return count;
}

function isVeinseekerRole(role) {
  return canonicalRole(role) === 'Veinseeker';
}

function isVeinseekerQueueItem(item) {
  return item && isVeinseekerRole(item.role) && item.mode !== 'remote';
}

function getVeinseekerSourceIdFromMemory(mem) {
  return SourceWorkerManager.getSourceIdFromMemory(mem);
}

function getVeinseekerQueueSourceId(item) {
  return SourceWorkerManager.getQueueSourceId(item);
}

function getCreepHomeRoomName(creep) {
  if (!creep) return null;
  if (creep.memory && creep.memory.home) return creep.memory.home;
  if (creep.memory && creep.memory._home) return creep.memory._home;
  if (creep.room && creep.room.name) return creep.room.name;
  return null;
}

function getVeinseekerDesiredPlan(room) {
  if (!room || !spawnLogic || typeof spawnLogic.getBestBodyPlanForRoomCapacity !== 'function') return null;
  return spawnLogic.getBestBodyPlanForRoomCapacity('Veinseeker', room, { mode: 'home' });
}

function makeVeinseekerPlanDiag(plan) {
  if (!plan) {
    return {
      cost: 0,
      signature: '',
      summary: null,
      tierIndex: -1
    };
  }
  return {
    cost: plan.cost || 0,
    signature: plan.signature || '',
    summary: plan.summary || null,
    tierIndex: typeof plan.tierIndex === 'number' ? plan.tierIndex : -1
  };
}

function isVeinseekerSafelyHarvesting(creep, source) {
  return SourceWorkerManager.isHomeVeinseekerSafelyHarvesting(creep, source, {
    safeTtl: VEINSEEKER_REPLACEMENT_SAFE_TTL
  });
}

function buildVeinseekerCoverageReport(room) {
  return SourceWorkerManager.buildHomeCoverageReport(room, {
    ensureRoomQueue: ensureRoomQueue,
    ensureRoomMemory: ensureRoomMemory,
    spawnLogic: spawnLogic,
    safeTtl: VEINSEEKER_REPLACEMENT_SAFE_TTL
  });
}
function removeLegacyVeinseekerQueueItems(roomName) {
  // Older saves may have source-less Veinseeker items. Source-aware queueing
  // will replace them immediately with one item per source, so keeping them can
  // create duplicate miners with no assignment target.
  var q = ensureRoomQueue(roomName);
  var kept = [];
  var removed = 0;
  for (var i = 0; i < q.length; i++) {
    var item = q[i];
    if (isVeinseekerQueueItem(item) && !getVeinseekerQueueSourceId(item)) {
      removed++;
      continue;
    }
    kept.push(item);
  }
  if (removed > 0) {
    ensureRoomMemory(roomName).lastVeinseekerLegacyQueueCleanup = {
      tick: Game.time,
      removed: removed
    };
  }
  Memory.rooms[roomName].spawnQueue = kept;
}

function addVeinseekerPlanFields(opts, plan) {
  if (!opts || !plan) return opts;
  opts.desiredBodyCost = plan.cost || 0;
  opts.desiredBodySignature = plan.signature || '';
  opts.desiredBodySummary = plan.summary || null;
  opts.desiredBodyTierIndex = typeof plan.tierIndex === 'number' ? plan.tierIndex : -1;
  return opts;
}

function makeQueueSpaceForEmergencyVeinseeker(roomName) {
  var q = ensureRoomQueue(roomName);
  if (q.length < QUEUE_HARD_LIMIT) return true;
  for (var i = q.length - 1; i >= 0; i--) {
    var item = q[i];
    if (isVeinseekerQueueItem(item) && item.sourceWorkerSpawnMode === 'upgradeReplacement') {
      q.splice(i, 1);
      ensureRoomMemory(roomName).lastVeinseekerEmergencyQueueSpace = {
        tick: Game.time,
        removedMode: 'upgradeReplacement',
        removedSourceId: getVeinseekerQueueSourceId(item),
        reason: 'emergency-veinseeker-needed-queue-full'
      };
      return true;
    }
  }
  return false;
}

function enqueueVeinseekerForSource(roomName, sourceId, mode, desiredPlan, extra) {
  if (mode === 'emergency' && !makeQueueSpaceForEmergencyVeinseeker(roomName)) {
    return false;
  }
  var opts = {
    task: 'veinseeker',
    mode: 'home',
    home: roomName,
    sourceId: sourceId,
    assignedSource: sourceId,
    sourceWorkerSpawnMode: mode,
    created: Game.time,
    priority: mode === 'upgradeReplacement'
      ? VEINSEEKER_UPGRADE_PRIORITY
      : (mode === 'emergency' ? VEINSEEKER_EMERGENCY_PRIORITY : VEINSEEKER_NORMAL_PRIORITY)
  };
  addVeinseekerPlanFields(opts, desiredPlan);
  if (extra) {
    for (var key in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, key)) {
        opts[key] = extra[key];
      }
    }
  }
  return enqueue(roomName, 'Veinseeker', opts);
}

function copyVeinseekerSourceStatus(rec, status) {
  if (!rec || !status) return rec;
  var fields = [
    'sourceId', 'seats', 'live', 'queued', 'liveWork', 'queuedWork',
    'spawnPending', 'spawnPendingWork', 'desiredWork', 'freeWork',
    'saturatedByWork', 'saturatedBySeats', 'hasOpenSeat', 'selectedSeat',
    'hasCoverage', 'emergencyNeeded', 'upgradeNeeded', 'bestLiveCost',
    'bestLiveName', 'replacementQueued', 'reason', 'activeLive',
    'bestLiveSignature', 'bestSafeLiveName', 'bestSafeLiveCost',
    'lowestTtlName', 'lowestTtl', 'replacementInProgress'
  ];
  for (var i = 0; i < fields.length; i++) {
    rec[fields[i]] = status[fields[i]];
  }
  return rec;
}

function refreshVeinseekerSourceCapacity(roomName, source, rec, desiredPlan) {
  if (!roomName || !source || !rec) return;
  var status = SourceWorkerManager.getSourceMiningStatus(roomName, source, desiredPlan, {
    ensureRoomQueue: ensureRoomQueue,
    safeTtl: VEINSEEKER_REPLACEMENT_SAFE_TTL
  });
  copyVeinseekerSourceStatus(rec, status);
}

function noteVeinseekerSourceSkip(report, sourceId, rec, reason) {
  rec.reason = reason;
  report.diag.decisions.push({
    sourceId: sourceId,
    action: 'skip',
    reason: reason,
    live: rec.live,
    queued: rec.queued,
    liveWork: rec.liveWork,
    queuedWork: rec.queuedWork,
    desiredWork: rec.desiredWork,
    freeWork: rec.freeWork,
    seats: rec.seats,
    saturatedByWork: !!rec.saturatedByWork,
    saturatedBySeats: !!rec.saturatedBySeats,
    hasOpenSeat: !!rec.hasOpenSeat,
    selectedSeat: rec.selectedSeat || null
  });
}

function isLowTtlVeinseekerReplacementAllowed(rec) {
  if (!rec) return false;
  if (!rec.lowestTtlName || rec.lowestTtl === null) return false;
  if (rec.queued > 0 || rec.replacementQueued || rec.replacementInProgress) return false;
  return rec.lowestTtl <= (REPLACEMENT_TTL.Veinseeker || 80);
}

function queueVeinseekerSourceNeeds(room, report) {
  if (!room || !report || !report.diag || !report.sources) return;
  var roomName = room.name;
  var sources = report.sources || [];
  var desiredPlan = report.desiredPlan;
  for (var i = 0; i < sources.length; i++) {
    var source = sources[i];
    var rec = report.diag.sources[source.id];
    if (!rec) continue;

    refreshVeinseekerSourceCapacity(roomName, source, rec, desiredPlan);
    if (rec.desiredWork <= 0) {
      noteVeinseekerSourceSkip(report, source.id, rec, 'skip-no-desired-work');
      continue;
    }

    if (rec.emergencyNeeded) {
      if (enqueueVeinseekerForSource(roomName, source.id, 'emergency', desiredPlan, {
        priority: VEINSEEKER_EMERGENCY_PRIORITY
      })) {
        rec.queued++;
        refreshVeinseekerSourceCapacity(roomName, source, rec, desiredPlan);
        rec.reason = 'queued-emergency-no-active-coverage';
        report.diag.decisions.push({
          sourceId: source.id,
          action: 'enqueue',
          mode: 'emergency',
          live: rec.live,
          queued: rec.queued,
          liveWork: rec.liveWork,
          queuedWork: rec.queuedWork,
          desiredWork: rec.desiredWork,
          freeWork: rec.freeWork,
          seats: rec.seats,
          saturatedByWork: !!rec.saturatedByWork,
          saturatedBySeats: !!rec.saturatedBySeats,
          selectedSeat: rec.selectedSeat || null,
          reason: rec.reason
        });
      }
      continue;
    }

    if (rec.queued > 0 || rec.replacementQueued) {
      noteVeinseekerSourceSkip(report, source.id, rec, rec.replacementQueued ? 'skip-replacement-already-queued' : 'skip-queued-veinseeker-covers-source');
      continue;
    }

    if (isLowTtlVeinseekerReplacementAllowed(rec)) {
      if (enqueueVeinseekerForSource(roomName, source.id, 'normal', desiredPlan, {
        priority: VEINSEEKER_NORMAL_PRIORITY,
        replaceCreepName: rec.lowestTtlName,
        replacementFor: rec.lowestTtlName,
        replaceSourceId: source.id
      })) {
        refreshVeinseekerSourceCapacity(roomName, source, rec, desiredPlan);
        rec.reason = 'queued-normal-low-ttl-replacement';
        report.diag.decisions.push({
          sourceId: source.id,
          action: 'enqueue',
          mode: 'normal',
          replaceCreepName: rec.lowestTtlName,
          live: rec.live,
          queued: rec.queued,
          liveWork: rec.liveWork,
          queuedWork: rec.queuedWork,
          desiredWork: rec.desiredWork,
          freeWork: rec.freeWork,
          seats: rec.seats,
          saturatedByWork: !!rec.saturatedByWork,
          saturatedBySeats: !!rec.saturatedBySeats,
          selectedSeat: rec.selectedSeat || null,
          reason: rec.reason
        });
      }
      continue;
    }

    if (rec.saturatedByWork) {
      noteVeinseekerSourceSkip(report, source.id, rec, 'skip-source-work-saturated');
      continue;
    }
    if (rec.saturatedBySeats || !rec.hasOpenSeat) {
      noteVeinseekerSourceSkip(report, source.id, rec, rec.saturatedBySeats ? 'skip-source-seat-saturated' : 'skip-no-open-harvest-seat');
      continue;
    }

    if (rec.freeWork > 0 && rec.live > 0) {
      if (enqueueVeinseekerForSource(roomName, source.id, 'normal', desiredPlan, {
        priority: VEINSEEKER_NORMAL_PRIORITY
      })) {
        refreshVeinseekerSourceCapacity(roomName, source, rec, desiredPlan);
        rec.reason = 'queued-normal-source-work-deficit';
        report.diag.decisions.push({
          sourceId: source.id,
          action: 'enqueue',
          mode: 'normal',
          live: rec.live,
          queued: rec.queued,
          liveWork: rec.liveWork,
          queuedWork: rec.queuedWork,
          desiredWork: rec.desiredWork,
          freeWork: rec.freeWork,
          seats: rec.seats,
          saturatedByWork: !!rec.saturatedByWork,
          saturatedBySeats: !!rec.saturatedBySeats,
          selectedSeat: rec.selectedSeat || null,
          reason: rec.reason
        });
      }
      continue;
    }

    if (VEINSEEKER_ENABLE_BODY_UPGRADES &&
        VEINSEEKER_UPGRADE_REPLACEMENTS_ENABLED &&
        rec.upgradeNeeded &&
        rec.bestSafeLiveName) {
      if (enqueueVeinseekerForSource(roomName, source.id, 'upgradeReplacement', desiredPlan, {
        priority: VEINSEEKER_UPGRADE_PRIORITY,
        replaceCreepName: rec.bestSafeLiveName,
        replacementFor: rec.bestSafeLiveName,
        replaceSourceId: source.id
      })) {
        refreshVeinseekerSourceCapacity(roomName, source, rec, desiredPlan);
        rec.reason = 'queued-upgrade-replacement';
        report.diag.decisions.push({
          sourceId: source.id,
          action: 'enqueue',
          mode: 'upgradeReplacement',
          replaceCreepName: rec.bestSafeLiveName,
          live: rec.live,
          queued: rec.queued,
          liveWork: rec.liveWork,
          queuedWork: rec.queuedWork,
          desiredWork: rec.desiredWork,
          freeWork: rec.freeWork,
          seats: rec.seats,
          saturatedByWork: !!rec.saturatedByWork,
          saturatedBySeats: !!rec.saturatedBySeats,
          selectedSeat: rec.selectedSeat || null,
          reason: rec.reason
        });
      }
      continue;
    }

    noteVeinseekerSourceSkip(report, source.id, rec, 'skip-no-source-work-deficit');
  }
  ensureRoomMemory(roomName).lastVeinseekerBodyPlan = report.diag;
}

function queueRemoteVeinseekerNeeds(roomName) {
  var desired = determineVeinseekerQuota(null, { name: roomName }) || 0;
  var live = countLiveRemoteVeinseekers(roomName);
  var queued = countQueuedRemoteVeinseekers(roomName);
  var deficit = Math.max(0, desired - live - queued);
  var diag = {
    tick: Game.time,
    desired: desired,
    live: live,
    queued: queued,
    enqueued: 0,
    skipped: 0,
    reason: null
  };
  for (var i = 0; i < deficit; i++) {
    var pick = SourceEnergyManager.reserveSourceForQueue(roomName);
    if (!pick) {
      diag.skipped++;
      diag.reason = 'no-free-source-slots';
      break;
    }
    var ok = enqueue(roomName, 'Veinseeker', {
      task: 'veinseeker',
      mode: 'remote',
      home: roomName,
      sourceId: pick.sourceId,
      targetRoom: pick.targetRoom,
      priority: ROLE_PRIORITY.Veinseeker || 70
    });
    if (ok) {
      diag.enqueued++;
    } else {
      SourceEnergyManager.unreserveSourceForQueue(roomName, pick.sourceId);
      diag.skipped++;
      diag.reason = 'queue-full';
      break;
    }
  }
  ensureRoomMemory(roomName).lastVeinseekerRemoteQueue = diag;
}

function enqueue(roomName, role, opts) {
  var q = ensureRoomQueue(roomName);
  if (q.length >= QUEUE_HARD_LIMIT) {
    dlog('🐝 [Queue]', roomName, 'queue full (', q.length, '/', QUEUE_HARD_LIMIT, '), skip enqueue of', role);
    return false;
  }

  // Teaching habit: build objects in a single literal so it is obvious which
  // metadata we persist for each queued role.
  var item = {
    role: role,
    home: roomName,
    created: Game.time,
    priority: ROLE_PRIORITY[role] || 0,
    retryAt: 0
  };
  if (opts) {
    for (var key in opts) {
      if (Object.prototype.hasOwnProperty.call(opts, key)) {
        item[key] = opts[key];
      }
    }
  }

  q.push(item);
  dlog('➕ [Queue]', roomName, 'enqueued', role, '(prio', item.priority + ')');
  return true;
}

function compareQueueItems(a, b) {
  var priorityDiff = (b.priority - a.priority) || 0;
  if (priorityDiff !== 0) return priorityDiff;
  return (a.created - b.created) || 0;
}

function pruneOverfilledQueue(roomName, quotas, C) {
  var q = ensureRoomQueue(roomName);
  var before = q.length;

  q.sort(compareQueueItems);

  // Defensive habit: track how many spawn slots remain per role so we do not
  // waste CPU dequeuing later.
  var remaining = {};
  var quotaRoles = Object.keys(quotas);
  for (var i = 0; i < quotaRoles.length; i++) {
    var role = quotaRoles[i];
    var canonical = canonicalRole(role);
    var active = getRoomLocalLiveCount(C, roomName, canonical);
    remaining[role] = Math.max(0, (quotas[role] || 0) - active);
  }

  var kept = [];
  var used = Object.create(null);
  for (var j = 0; j < q.length; j++) {
    var it = q[j];
    if (!it) continue;
    if (isVeinseekerRole(it.role) && getVeinseekerQueueSourceId(it)) {
      kept.push(it);
      continue;
    }
    var left = remaining[it.role] || 0;
    var usedSoFar = used[it.role] || 0;
    if (usedSoFar < left) {
      kept.push(it);
      used[it.role] = usedSoFar + 1;
    }
  }
  Memory.rooms[roomName].spawnQueue = kept;

  var dropped = before - kept.length;
  if (dropped > 0 || tickEvery(DBG_EVERY)) {
    dlog('🧹 [Queue]', roomName, 'prune:',
      'before=', before, 'kept=', kept.length, 'dropped=', dropped,
      'remaining=', JSON.stringify(remaining));
  }
}


function getMyUsernameForSpawnManager() {
  // Spawn quota/safety code only needs our account name. BeeToolbox caches it
  // per tick, which keeps this helper simple without changing queue behavior.
  return BeeToolbox.myUsername();
}

function refreshVisibleVeinseekerRemoteSafety(room) {
  return BeeToolbox.refreshVisibleRemoteSafety(room);
}

function isVeinseekerRemoteRoomUnsafe(remoteName) {
  return BeeToolbox.isRemoteRoomUnsafe(remoteName, { invaderLockTtl: INVADER_LOCK_TTL });
}

// Novice tip: keep state lookups tiny helpers so you can audit each role's math.
// ------------------------------ Signals ---------------------------------
function getBuilderNeed(C, room) {
  if (!room) return 0;
  var local = C.roomSiteCounts[room.name] || 0;
  var remoteTotal = 0;
  var remotes = C.remotesByHome[room.name] || [];
  for (var i = 0; i < remotes.length; i++) {
    var rn = remotes[i];
    remoteTotal += (C.roomSiteCounts[rn] || 0);
  }
  var totalSites = local + remoteTotal;
  var rcl = (room.controller && room.controller.level) || 0;
  var maxByRcl = 4;
  var need = 0;

  if (rcl <= 2) {
    maxByRcl = 2;
  } else if (rcl === 3) {
    maxByRcl = 3;
  }

  if (totalSites <= 0) {
    need = 0;
  } else if (totalSites >= 15) {
    need = 4;
  } else if (totalSites >= 8) {
    need = 3;
  } else {
    need = 2;
  }

  if (need > maxByRcl) {
    need = maxByRcl;
  }

  if (tickEvery(DBG_EVERY)) {
    dlog('🧱 [Signal] builderNeed', fmt(room),
      'local=', local,
      'remote=', remoteTotal,
      'total=', totalSites,
      'rcl=', rcl,
      'need=', need);
  }
  return need;
}


function getRouteDistanceBetweenRooms(homeName, remoteName) {
  return BeeToolbox.getRouteDistanceBetweenRooms(homeName, remoteName);
}

function determineVeinseekerQuota(C, room) {
  // SourceEnergy.Manager owns desiredVeinseeker. BeeSpawnManager only reads that
  // audited plan and turns deficits into spawn queue items.
  if (!room) return 0;
  var home = SourceEnergyManager.ensureHomeMemory(room.name);
  return home.desiredVeinseeker || 0;
}

function pruneBlockedVeinseekerQueueItems(roomName) {
  // Queue cleanup must run before new quota fills. If a remote room/source was
  // blocked after a Veinseeker was queued, release the SourceEnergy reservation so a
  // future safe source can be picked.
  var q = ensureRoomQueue(roomName);
  var kept = [];
  var removed = 0;
  var removedItems = [];
  for (var i = 0; i < q.length; i++) {
    var it = q[i];
    if (!it || it.role !== 'Veinseeker' || it.mode !== 'remote') { kept.push(it); continue; }

    var reason = null;
    if (!it.targetRoom) {
      reason = 'missing-target-room';
    } else {
      var localOwnedCheck = (SourceEnergyManager && typeof SourceEnergyManager.isLocalOwnedRoomForVeinseeker === 'function') ? SourceEnergyManager.isLocalOwnedRoomForVeinseeker(roomName, it.targetRoom) : { blocked: false };
      if (localOwnedCheck && localOwnedCheck.blocked) reason = localOwnedCheck.reason || 'local-owned-room';
      else if (isVeinseekerRemoteRoomUnsafe(it.targetRoom)) reason = 'room-unsafe';
    }
    if (!reason) {
      var sMem = Memory.rooms && Memory.rooms[it.targetRoom] && Memory.rooms[it.targetRoom].sources && Memory.rooms[it.targetRoom].sources[it.sourceId];
      if (sMem && sMem.sourceWorkerBlockedUntil && sMem.sourceWorkerBlockedUntil > Game.time) {
        reason = 'source-blocked';
      }
    }

    if (reason) {
      if (it.sourceId) SourceEnergyManager.unreserveSourceForQueue(roomName, it.sourceId);
      removed++;
      removedItems.push({
        sourceId: it.sourceId || null,
        targetRoom: it.targetRoom || null,
        reason: reason
      });
      continue;
    }

    kept.push(it);
  }
  var roomMem = ensureRoomMemory(roomName);
  roomMem.spawnQueue = kept;
  roomMem.lastVeinseekerQueuePrune = {
    tick: Game.time,
    removed: removed,
    kept: kept.length,
    removedItems: removedItems
  };
}

function computeEarlyUpgraderQuota(room) {
  if (!room) {
    return 1;
  }

  var controller = room.controller;
  if (!controller || !controller.my) return 1;

  var rcl = controller.level || 1;
  var ticksToDowngrade = controller.ticksToDowngrade || 0;
  var downgradeDanger = ticksToDowngrade > 0 && ticksToDowngrade <= 4000;
  var downgradeWarning = ticksToDowngrade > 0 && ticksToDowngrade <= 8000;

  var sourceContainerEnergy = 0;
  var sourceContainerCapacity = 0;
  var sources = room.find(FIND_SOURCES);
  for (var i = 0; i < sources.length; i++) {
    var source = sources[i];
    var nearby = source.pos.findInRange(FIND_STRUCTURES, 1);
    for (var j = 0; j < nearby.length; j++) {
      var structure = nearby[j];
      if (structure.structureType !== STRUCTURE_CONTAINER) continue;
      if (!structure.store) continue;
      sourceContainerEnergy += structure.store[RESOURCE_ENERGY] || 0;
      sourceContainerCapacity += structure.store.getCapacity(RESOURCE_ENERGY) || 0;
    }
  }

  var sourceContainerFillRatio = 0;
  if (sourceContainerCapacity > 0) {
    sourceContainerFillRatio = sourceContainerEnergy / sourceContainerCapacity;
  }

  var droppedEnergy = 0;
  var drops = room.find(FIND_DROPPED_RESOURCES);
  for (var k = 0; k < drops.length; k++) {
    var drop = drops[k];
    if (drop.resourceType === RESOURCE_ENERGY) {
      droppedEnergy += drop.amount || 0;
    }
  }

  var storedEnergy = 0;
  if (room.storage && room.storage.store) {
    storedEnergy += room.storage.store[RESOURCE_ENERGY] || 0;
  }
  if (room.terminal && room.terminal.store) {
    storedEnergy += room.terminal.store[RESOURCE_ENERGY] || 0;
  }
  var energySurplus = sourceContainerEnergy + droppedEnergy + storedEnergy;

  // Keep RCL 2-4 conservative unless downgrade pressure says otherwise.
  var quota = 1;
  if (rcl <= 4) {
    if (downgradeWarning) quota = 2;
    if (downgradeDanger) quota = 3;
    if (sourceContainerFillRatio >= 0.95 && droppedEnergy >= 1500) quota = Math.max(quota, 2);
    return quota;
  }

  if (downgradeDanger) {
    return 4;
  }
  if (downgradeWarning) {
    quota = 2;
  }
  if (energySurplus >= 2000 || sourceContainerFillRatio >= 0.75 || droppedEnergy >= 300) quota = Math.max(quota, 2);
  if (energySurplus >= 6000 || sourceContainerFillRatio >= 0.90 || droppedEnergy >= 700) quota = Math.max(quota, 3);
  if (energySurplus >= 12000 || (sourceContainerFillRatio >= 0.95 && droppedEnergy >= 1000)) quota = Math.max(quota, 4);
  if (energySurplus >= 25000 || (sourceContainerFillRatio >= 0.95 && droppedEnergy >= 2000)) quota = Math.max(quota, 5);
  if (energySurplus >= 45000 || (sourceContainerFillRatio >= 0.95 && droppedEnergy >= 3500)) quota = Math.max(quota, 6);
  return quota;
}

function getLocalDefenseThreat(room) {
  if (!room) return 0;

  try {
    if (CombatSquads && typeof CombatSquads.getLiveThreatForRoom === 'function') {
      var liveThreat = CombatSquads.getLiveThreatForRoom(room.name);
      if (typeof liveThreat === 'number') {
        return liveThreat > 0 ? liveThreat : 0;
      }
      if (liveThreat && liveThreat.hasThreat === true) {
        return (typeof liveThreat.score === 'number' && liveThreat.score > 0) ? liveThreat.score : 1;
      }
      if (liveThreat && typeof liveThreat.score === 'number' && liveThreat.score > 0) {
        return liveThreat.score;
      }
    }
  } catch (e) {
    // Ignore Combat.Squads threat lookup failures and fall through to local scan.
  }

  var hostiles = room.find(FIND_HOSTILE_CREEPS) || [];
  return hostiles.length;
}

function computeLocalDefenseQuotas(room) {
  var threat = getLocalDefenseThreat(room);
  var hasThreat = threat > 0;
  var energyCap = (room && room.energyCapacityAvailable) || 0;

  if (!hasThreat) {
    return {
      CombatMelee: 0,
      CombatArcher: 0,
      CombatMedic: 0
    };
  }

  var combatMelee = energyCap >= 550 ? 2 : 1;
  var combatArcher = energyCap >= 800 ? 1 : 0;
  var combatMedic = combatMelee > 0 ? (energyCap >= 800 ? 1 : 0) : 0;

  return {
    CombatMelee: combatMelee,
    CombatArcher: combatArcher,
    CombatMedic: combatMedic
  };
}

function getLocalContainerPressure(roomName) {
  var out = { localPressure: 'none', containersOverUrgent: 0, containersOverCritical: 0 };
  var room = Game.rooms[roomName];
  if (!room) return out;
  var pickupAt = Math.max(0, TruckerConfig.LOCAL_CONTAINER_PICKUP_AT || 1000);
  var urgentAt = Math.max(pickupAt, TruckerConfig.LOCAL_CONTAINER_URGENT_AT || 1600);
  var criticalAt = Math.max(urgentAt, TruckerConfig.LOCAL_CONTAINER_CRITICAL_AT || 1900);
  var containers = room.find(FIND_STRUCTURES, { filter: function (s) { return s.structureType === STRUCTURE_CONTAINER && s.store; } });
  for (var i = 0; i < containers.length; i++) {
    var energy = containers[i].store[RESOURCE_ENERGY] || 0;
    if (energy >= urgentAt) out.containersOverUrgent++;
    if (energy >= criticalAt) out.containersOverCritical++;
  }
  if (out.containersOverCritical > 0) out.localPressure = 'critical';
  else if (out.containersOverUrgent > 0) out.localPressure = 'urgent';
  return out;
}

function estimateRemoteRoundTripTicks(homeRoom, remoteRoom) {
  return BeeToolbox.estimateRemoteRoundTripTicks(homeRoom, remoteRoom);
}

function countHomeTruckersByAssignment(roomName) {
  var local = 0;
  var remote = 0;
  var remotePickup = 0;
  var remoteReturn = 0;
  var remoteCapable = 0;
  for (var name in Game.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Game.creeps, name)) continue;
    var c = Game.creeps[name];
    if (!c || !c.memory) continue;
    if (canonicalRole(c.memory.role) !== 'Trucker') continue;
    if ((c.memory.home || (c.room && c.room.name)) !== roomName) continue;
    var job = c.memory.dispatchJob;
    if (job && (job.type === 'REMOTE_PICKUP' || job.type === 'REMOTE_RETURN')) {
      remote++;
      if (job.type === 'REMOTE_PICKUP') remotePickup++;
      if (job.type === 'REMOTE_RETURN') remoteReturn++;
      if (job.type === 'REMOTE_RETURN') {
        // Already returning with energy from remote pipeline; count as fulfilling remote side
        // even if TTL is below full outbound round-trip estimate.
        remoteCapable++;
      } else {
        var remoteRoom = job.roomName || c.memory.requestRoom || c.memory.targetRoom;
        var required = estimateRemoteRoundTripTicks(roomName, remoteRoom);
        if (typeof c.ticksToLive !== 'number' || c.ticksToLive >= required || (c.store && c.store.getUsedCapacity(RESOURCE_ENERGY) > 0)) remoteCapable++;
      }
    } else {
      local++;
    }
  }
  return {
    truckersOnLocalJobs: local,
    truckersOnRemoteJobs: remote,
    truckersOnRemotePickup: remotePickup,
    truckersOnRemoteReturn: remoteReturn,
    remoteCapableTruckers: remoteCapable
  };
}


function computeTruckerQuotaForHome(roomName) {
  // Trucker quota is workload-based. Veinseeker creates remoteHaulRequests; this
  // helper counts fresh/safe/large-enough requests, adds local container
  // pressure, and returns both a final quota and skip diagnostics.
  var requests = Memory.__BHM && Memory.__BHM.remoteHaulRequests ? Memory.__BHM.remoteHaulRequests : {};
  var active = 0;
  var urgent = 0;
  var remoteEnergyWaiting = 0;
  var remoteRoomsSeen = {};
  var staleSkipped = 0;
  var unsafeSkipped = 0;
  var lowEnergySkipped = 0;
  var maintenanceSkipped = 0;
  var wrongHomeSkipped = 0;
  for (var id in requests) {
    if (!Object.prototype.hasOwnProperty.call(requests, id)) continue;
    var req = requests[id];
    if (!req || req.homeRoom !== roomName) { wrongHomeSkipped++; continue; }
    if (TruckerConfig.shouldBlockRemoteHaulForMaintenance(req)) { maintenanceSkipped++; continue; }
    if ((req.amount || 0) < TruckerConfig.MIN_HAUL_REQUEST_ENERGY) { lowEnergySkipped++; continue; }
    if ((Game.time - (req.updated || 0)) > TruckerConfig.REQUEST_STALE_TICKS) { staleSkipped++; continue; }
    if (isVeinseekerRemoteRoomUnsafe(req.remoteRoom || req.roomName)) { unsafeSkipped++; continue; }
    active++;
    if (req.urgent) urgent++;
    remoteEnergyWaiting += Math.max(0, req.amount || 0);
    remoteRoomsSeen[req.remoteRoom || req.roomName || ('unknown:' + id)] = true;
  }
  var activeRemoteRooms = Object.keys(remoteRoomsSeen).length;
  var localPressure = getLocalContainerPressure(roomName);
  var localDesiredTruckers = Math.max(0, TruckerConfig.LOCAL_TRUCKER_BASE_QUOTA || 0);
  if (localPressure.localPressure === 'urgent' || localPressure.localPressure === 'critical') localDesiredTruckers += 1;
  var maxTotalTruckers = Math.max(0, TruckerConfig.MAX_TOTAL_TRUCKERS_PER_HOME || 0);
  if (maxTotalTruckers > 0) localDesiredTruckers = Math.min(localDesiredTruckers, maxTotalTruckers);

  var remoteByEnergy = Math.ceil(remoteEnergyWaiting / 1600);
  var remoteByRooms = activeRemoteRooms > 1 ? (activeRemoteRooms - 1) : 0;
  var remoteByUrgency = urgent > 0 ? 1 : 0;
  var remoteDesired = 0;
  if (active > 0) remoteDesired = Math.max(1, remoteByEnergy + remoteByRooms + remoteByUrgency);
  remoteDesired = Math.min(remoteDesired, Math.max(0, TruckerConfig.MAX_TRUCKERS_PER_HOME || 0));

  var finalTruckerQuota = localDesiredTruckers + remoteDesired;
  if (maxTotalTruckers > 0) finalTruckerQuota = Math.min(finalTruckerQuota, maxTotalTruckers);

  return {
    activeRequests: active,
    urgentRequests: urgent,
    remoteEnergyWaiting: remoteEnergyWaiting,
    activeRemoteRooms: activeRemoteRooms,
    localDesiredTruckers: localDesiredTruckers,
    remoteDesiredTruckers: remoteDesired,
    desiredTruckers: remoteDesired,
    finalTruckerQuota: finalTruckerQuota,
    skipped: {
      stale: staleSkipped,
      unsafe: unsafeSkipped,
      lowEnergy: lowEnergySkipped,
      maintenance: maintenanceSkipped,
      wrongHome: wrongHomeSkipped
    }
  };
}

function hasMeaningfulRepairTarget(target) {
  if (!target || !target.id) return false;
  var obj = Game.getObjectById(target.id);
  if (!obj || typeof obj.hits !== 'number' || typeof obj.hitsMax !== 'number' || obj.hitsMax <= 0) return false;
  if (obj.hits >= obj.hitsMax) return false;
  var pct = obj.hits / obj.hitsMax;
  var type = obj.structureType;
  if (type === STRUCTURE_ROAD) return pct < 0.60;
  if (type === STRUCTURE_CONTAINER) return pct < 0.80;
  if (type === STRUCTURE_SPAWN || type === STRUCTURE_EXTENSION || type === STRUCTURE_TOWER || type === STRUCTURE_STORAGE || type === STRUCTURE_TERMINAL || type === STRUCTURE_LINK || type === STRUCTURE_LAB) return pct < 0.90;
  if (type === STRUCTURE_RAMPART || type === STRUCTURE_WALL) return true;
  return false;
}

function computeLocalRepairQuotaForRoom(room) {
  if (!room) return 0;
  if (hasRemoteContainerRepairDemand(room.name)) return 1;
  var towers = room.find(FIND_MY_STRUCTURES, { filter: function (s) { return s.structureType === STRUCTURE_TOWER; } });
  if (towers && towers.length > 0) return 0;
  var mem = (Memory.rooms && Memory.rooms[room.name]) || {};
  var queue = Array.isArray(mem.repairTargets) ? mem.repairTargets : [];
  for (var i = 0; i < queue.length; i++) {
    if (hasMeaningfulRepairTarget(queue[i])) return 1;
  }
  return 0;
}


function hasRemoteContainerRepairDemand(roomName) {
  var root = Memory.__BHM && Memory.__BHM.remoteContainerStatus ? Memory.__BHM.remoteContainerStatus : null;
  if (!root || !roomName) return false;
  for (var id in root) {
    if (!Object.prototype.hasOwnProperty.call(root, id)) continue;
    var st = root[id];
    if (!st || st.homeRoom !== roomName) continue;
    if (typeof st.containerHitsPct !== 'number') continue;
    if (st.containerHitsPct <= 0.75 && st.containerHitsPct > (RepairConfig.remoteContainerEmergencyRepairStartPct || 0.40)) {
      if (!isVeinseekerRemoteRoomUnsafe(st.remoteRoom || st.roomName)) return true;
    }
  }
  return false;
}
function countRemoteEmergencyRepairAssignments(roomName) {
  if (!roomName) return 0;
  var count = 0;
  for (var name in Game.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Game.creeps, name)) continue;
    var creep = Game.creeps[name];
    if (!creep || !creep.memory) continue;
    if (canonicalRole(creep.memory.role) !== 'Repair') continue;
    if (creep.memory.task !== 'remoteContainerEmergencyRepair') continue;
    if ((creep.memory.home || (creep.room && creep.room.name)) !== roomName) continue;
    count++;
  }
  var q = ensureRoomQueue(roomName);
  for (var i = 0; i < q.length; i++) {
    var item = q[i];
    if (!item || item.role !== 'Repair') continue;
    if (item.task !== 'remoteContainerEmergencyRepair') continue;
    if ((item.home || roomName) !== roomName) continue;
    count++;
  }
  return count;
}

function countLocalRepairCreeps(roomName) {
  if (!roomName) return 0;
  var count = 0;
  for (var name in Game.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Game.creeps, name)) continue;
    var creep = Game.creeps[name];
    if (!creep || !creep.memory) continue;
    if (canonicalRole(creep.memory.role) !== 'Repair') continue;
    if ((creep.memory.home || (creep.room && creep.room.name)) !== roomName) continue;
    if (creep.memory.task === 'remoteContainerEmergencyRepair') continue;
    count++;
  }
  return count;
}

function isRepairAlreadyAssignedToContainer(roomName, containerId) {
  if (!roomName || !containerId) return false;
  for (var name in Game.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Game.creeps, name)) continue;
    var creep = Game.creeps[name];
    if (!creep || !creep.memory) continue;
    if (canonicalRole(creep.memory.role) !== 'Repair') continue;
    if (creep.memory.task !== 'remoteContainerEmergencyRepair') continue;
    if ((creep.memory.home || (creep.room && creep.room.name)) !== roomName) continue;
    if (creep.memory.containerId === containerId) return true;
  }
  var q = ensureRoomQueue(roomName);
  for (var i = 0; i < q.length; i++) {
    var item = q[i];
    if (!item || item.role !== 'Repair') continue;
    if (item.task !== 'remoteContainerEmergencyRepair') continue;
    if (item.containerId === containerId) return true;
  }
  return false;
}

function findEmergencyRepairRequestInBucket(requests, roomName) {
  if (!requests) return null;
  var staleTicks = (TruckerConfig && TruckerConfig.REQUEST_STALE_TICKS) || 100;
  var startPct = RepairConfig.remoteContainerEmergencyRepairStartPct || 0.40;
  var veinseekerPct = (VeinseekerConfig && VeinseekerConfig.remoteContainerRepairStartPct) || 0.50;
  for (var id in requests) {
    if (!Object.prototype.hasOwnProperty.call(requests, id)) continue;
    var req = requests[id];
    if (!req || req.homeRoom !== roomName) continue;
    if (!req.containerId) continue;
    if (typeof req.containerHitsPct !== 'number') continue;
    var isStale = (Game.time - (req.updated || 0)) > staleTicks;
    if (isStale) {
      if (req.containerHitsPct <= veinseekerPct) ensureRemoteVisionRequestFromStatus(req, roomName);
      continue;
    }
    if (req.containerHitsPct > startPct) continue;
    if (isVeinseekerRemoteRoomUnsafe(req.remoteRoom || req.roomName)) continue;
    var heldByEmergencyRepair =
      req.maintenanceUntil &&
      req.maintenanceUntil > Game.time &&
      req.maintenanceReason === 'emergencyRemoteRepair';
    if (heldByEmergencyRepair) continue;
    if (isRepairAlreadyAssignedToContainer(roomName, req.containerId)) continue;
    return req;
  }
  return null;
}

function findRemoteContainerEmergencyRepairRequest(roomName) {
  // Emergency repair can be triggered from either live container status or haul
  // request records. Both are produced by Veinseeker, so keep the field expectations
  // aligned with role.Veinseeker.Remote.js and role.Repair.Logic.js.
  if (!RepairConfig.remoteContainerEmergencyRepairEnabled) return null;
  var statusRequests = Memory.__BHM && Memory.__BHM.remoteContainerStatus ? Memory.__BHM.remoteContainerStatus : null;
  var haulRequests = Memory.__BHM && Memory.__BHM.remoteHaulRequests ? Memory.__BHM.remoteHaulRequests : null;
  var statusReq = findEmergencyRepairRequestInBucket(statusRequests, roomName);
  if (statusReq) return statusReq;
  return findEmergencyRepairRequestInBucket(haulRequests, roomName);
}


function ensureRemoteVisionRequests() { Memory.__BHM = Memory.__BHM || {}; Memory.__BHM.remoteVisionRequests = Memory.__BHM.remoteVisionRequests || {}; return Memory.__BHM.remoteVisionRequests; }
function ensureRemoteVisionRequestFromStatus(req, homeRoom) {
  // Stale low-HP remote container data needs a Scout before Repair can trust it.
  // This writes a request consumed by role.Scout.Logic.js without spawning the
  // Scout directly; queueEmergencyVisionScoutIfNeeded decides whether to enqueue.
  if (!req || !homeRoom) return null;
  var map = ensureRemoteVisionRequests();
  var key = (req.containerId || req.sourceId || (req.remoteRoom + ':' + req.x + ':' + req.y));
  var existing = map[key] || {};
  map[key] = {
    reason: 'staleRemoteContainer', homeRoom: homeRoom, targetRoom: req.remoteRoom || req.roomName,
    x: req.x, y: req.y, containerId: req.containerId || null, sourceId: req.sourceId || null,
    priority: Math.max(Number(existing.priority)||0, (req.containerHitsPct != null && req.containerHitsPct <= 0.4) ? 100 : 60),
    requestedAt: existing.requestedAt || Game.time
  };
  return map[key];
}
function findScoutAssignedToRemoteVisionRequest(roomName, requestKey) {
  for (var name in Game.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Game.creeps, name)) continue;
    var creep = Game.creeps[name];
    if (!creep || !creep.memory) continue;
    if (canonicalRole(creep.memory.role) !== 'Scout') continue;
    var scoutHome = creep.memory.home || (creep.memory.scout && creep.memory.scout.home) || (creep.room && creep.room.name);
    if (scoutHome !== roomName) continue;
    if (creep.memory.remoteVisionRequestId === requestKey) return creep;
  }
  return null;
}
function isScoutSuitableForRequest(creep, roomName, requestKey, selected) {
  if (!creep || !creep.memory || canonicalRole(creep.memory.role) !== 'Scout') return false;
  var scoutHome = creep.memory.home || (creep.memory.scout && creep.memory.scout.home) || (creep.room && creep.room.name);
  if (scoutHome !== roomName) return false;
  var currentReq = creep.memory.remoteVisionRequestId || null;
  if (currentReq && currentReq !== requestKey) return false;
  if (currentReq === requestKey) return true;
  var targetRoom = selected && selected.targetRoom;
  if (!targetRoom || !creep.pos || !creep.pos.roomName) return true;
  var dist = Game.map.getRoomLinearDistance(creep.pos.roomName, targetRoom);
  return dist <= 2;
}
function queueEmergencyVisionScoutIfNeeded(roomName) {
  // Bridge from stale remote container status to Scout spawning. The request
  // itself lives in Memory.__BHM.remoteVisionRequests; this function only queues
  // a temporary Scout when no suitable live Scout is already handling it.
  var roomMem = ensureRoomMemory(roomName);
  var maxPerHome = ((CoreConfig.settings && CoreConfig.settings.visuals && CoreConfig.settings.visuals.remoteVisionRequestMaxEmergencyScoutsPerHome) || 1);
  var reqs = ensureRemoteVisionRequests();
  var pending = 0; var selected = null; var selectedKey = null;
  for (var k in reqs) { if (!Object.prototype.hasOwnProperty.call(reqs,k)) continue; var r=reqs[k]; if (!r || r.resolvedAt) continue; if (r.homeRoom===roomName) { pending++; if (!selected || (r.priority||0)>(selected.priority||0)) { selected=r; selectedKey=k; } } }
  var assignedScout = selectedKey ? findScoutAssignedToRemoteVisionRequest(roomName, selectedKey) : null;
  var suitableScoutFound = !!assignedScout;
  if (!suitableScoutFound && selectedKey) {
    for (var n in Game.creeps) {
      if (!Object.prototype.hasOwnProperty.call(Game.creeps, n)) continue;
      if (isScoutSuitableForRequest(Game.creeps[n], roomName, selectedKey, selected)) { assignedScout = Game.creeps[n]; suitableScoutFound = true; break; }
    }
  }
  var queuedScout = false;
  if (selectedKey && !suitableScoutFound && maxPerHome > 0) {
    var q = ensureRoomQueue(roomName);
    var alreadyQueued = false;
    for (var i=0;i<q.length;i++) { var item=q[i]; if (item && item.role==='Scout' && item.task==='remoteVisionEmergency' && item.remoteVisionRequestId===selectedKey) { alreadyQueued=true; break; } }
    if (!alreadyQueued) queuedScout = enqueue(roomName, 'Scout', { task:'remoteVisionEmergency', home: roomName, remoteVisionRequestId: selectedKey, targetRoom: selected.targetRoom });
  }
  roomMem.lastRemoteVision = { pendingRequests: pending, selectedRequest: selectedKey, assignedScout: assignedScout ? assignedScout.name : null, suitableScoutFound: suitableScoutFound, queuedScout: queuedScout, reason: selectedKey ? (suitableScoutFound ? 'existingScoutSuitable' : (queuedScout ? 'queuedEmergencyScout' : 'queueSkipped')) : 'noPendingRequest' };
}


function determineQueenQuota(room) {
  // Queen quota is recorded in room Memory for debugging because bootstrap
  // rooms may intentionally keep more Queens than mature storage rooms.
  var roomMem = ensureRoomMemory(room.name);
  var roomHasStorage = !!(room && room.storage);
  var backupEnabled = !!(QueenConfig && QueenConfig.BACKUP_HARVEST_ENABLED);
  var bootstrapQuota = Math.max(1, (QueenConfig && QueenConfig.QUEEN_BOOTSTRAP_QUOTA_WITHOUT_STORAGE) || 2);
  var normalQuota = Math.max(1, (QueenConfig && QueenConfig.QUEEN_NORMAL_QUOTA) || 1);
  var useBootstrap = backupEnabled && !roomHasStorage;
  var queenQuota = useBootstrap ? bootstrapQuota : normalQuota;
  roomMem.lastQueenQuota = {
    tick: Game.time,
    queenQuota: queenQuota,
    roomHasStorage: roomHasStorage,
    mode: useBootstrap ? 'bootstrap-backup-harvest' : 'normal-logistics'
  };
  return queenQuota;
}

function computeRoomQuotas(C, room) {
  // Central quota fan-in. Every role-specific signal writes its own diagnostic
  // before the combined quotas object is returned to fillQueueForRoom().
  var localDefense = computeLocalDefenseQuotas(room);
  var localRepairQuota = computeLocalRepairQuotaForRoom(room);
  var maxRemoteEmergencyPerHome = Math.max(0, RepairConfig.remoteContainerEmergencyRepairMaxPerHome || 1);
  var activeRemoteEmergencyRepairs = countRemoteEmergencyRepairAssignments(room.name);
  var selectedEmergencyRequest = null;
  var emergencyRepairQuota = 0;
  if (maxRemoteEmergencyPerHome > 0 && activeRemoteEmergencyRepairs < maxRemoteEmergencyPerHome) {
    selectedEmergencyRequest = findRemoteContainerEmergencyRepairRequest(room.name);
    emergencyRepairQuota = selectedEmergencyRequest ? 1 : 0;
  }
  var repairQuota = localRepairQuota + emergencyRepairQuota;
  var liveLocalRepair = countLocalRepairCreeps(room.name);
  var liveRemoteEmergencyRepair = activeRemoteEmergencyRepairs;
  var roomMem = ensureRoomMemory(room.name);
  roomMem.lastRepairQuota = {
    tick: Game.time,
    localRepairQuota: localRepairQuota,
    emergencyRepairQuota: emergencyRepairQuota,
    liveLocalRepair: liveLocalRepair,
    liveRemoteEmergencyRepair: liveRemoteEmergencyRepair,
    queuedRemoteEmergencyRepair: 0,
    selectedEmergencyRequest: selectedEmergencyRequest ? {
      requestId: selectedEmergencyRequest.id || selectedEmergencyRequest.requestId || null,
      containerId: selectedEmergencyRequest.containerId || null,
      targetRoom: selectedEmergencyRequest.remoteRoom || selectedEmergencyRequest.roomName || null,
      reason: 'containerHitsPctBelowStartThreshold'
    } : null,
    finalRepairQuota: repairQuota,
    queueDecision: emergencyRepairQuota > 0 ? 'queueRemoteEmergencyRepair' : 'noRemoteEmergencyRepairQueue'
  };

  // Teaching habit: start with conservative defaults, then patch in signals
  // (builder need, remote miners, etc.) so every change is a single diff.
  var truckerQuotaMeta = computeTruckerQuotaForHome(room.name);
  var truckerQuota = truckerQuotaMeta.finalTruckerQuota || 0;

  var quotas = {
    Queen:        determineQueenQuota(room),
    Upgrader:     computeEarlyUpgraderQuota(room),
    Builder:      getBuilderNeed(C, room),
    Scout:        1,
    Repair:       repairQuota,
    Trucker:      truckerQuota,
    Claimer:      0,
    CombatMelee:  localDefense.CombatMelee,
    CombatArcher: localDefense.CombatArcher,
    CombatMedic:  localDefense.CombatMedic
  };
  if (tickEvery(DBG_EVERY)) {
    dlog('🎯 [Quotas]', fmt(room), JSON.stringify(quotas));
  }
  return quotas;
}

function fillQueueForRoom(C, room) {
  // The queue fill pass is intentionally ordered:
  // 1) compute quotas and stale emergency Scout needs,
  // 2) prune invalid Veinseeker queue items and retired Courier state,
  // 3) write quota diagnostics,
  // 4) enqueue deficits, reserving Veinseeker sources before adding queue items.
  var quotas = computeRoomQuotas(C, room);
  queueEmergencyVisionScoutIfNeeded(room.name);
  var roomName = room.name;
  pruneBlockedVeinseekerQueueItems(roomName);
  cleanupRetiredCourierState(roomName);
  removeLegacyVeinseekerQueueItems(roomName);

  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
  var truckerQuotaMeta = computeTruckerQuotaForHome(roomName);
  Memory.rooms[roomName].lastRoleQuotas = {
    tick: Game.time,
    quotas: quotas
  };
  var localTruckerBaseQuota = Math.max(0, TruckerConfig.LOCAL_TRUCKER_BASE_QUOTA || 0);
  var maxTotalTruckers = Math.max(0, TruckerConfig.MAX_TOTAL_TRUCKERS_PER_HOME || 0);
  var remoteTruckerQuota = truckerQuotaMeta.remoteDesiredTruckers || 0;
  var liveTruckers = getRoomLocalLiveCount(C, roomName, "Trucker");
  var queuedTruckers = queuedCount(roomName, "Trucker");
  var assignmentCounts = countHomeTruckersByAssignment(roomName);
  var effectiveActiveTruckers = Math.min(
    assignmentCounts.truckersOnLocalJobs,
    truckerQuotaMeta.localDesiredTruckers || localTruckerBaseQuota
  ) + Math.min(
    assignmentCounts.remoteCapableTruckers,
    truckerQuotaMeta.remoteDesiredTruckers || 0
  );
  Memory.rooms[roomName].lastLocalHaulerMode = {
    tick: Game.time,
    mode: 'trucker-primary',
    courierQuota: 0,
    truckerQuota: quotas.Trucker || 0,
    localTruckerQuota: localTruckerBaseQuota,
    localDesiredTruckers: truckerQuotaMeta.localDesiredTruckers || localTruckerBaseQuota,
    remoteDesiredTruckers: remoteTruckerQuota,
    finalTruckerQuota: truckerQuotaMeta.finalTruckerQuota || (quotas.Trucker || 0),
    maxTotalTruckers: maxTotalTruckers,
    liveTruckers: liveTruckers,
    queuedTruckers: queuedTruckers,
    truckersOnLocalJobs: assignmentCounts.truckersOnLocalJobs,
    truckersOnRemoteJobs: assignmentCounts.truckersOnRemoteJobs,
    truckersOnRemotePickup: assignmentCounts.truckersOnRemotePickup,
    truckersOnRemoteReturn: assignmentCounts.truckersOnRemoteReturn,
    remoteCapableTruckers: assignmentCounts.remoteCapableTruckers,
    effectiveActiveTruckers: effectiveActiveTruckers,
    courierRoleRetired: true
  };
  Memory.rooms[roomName].lastTruckerQuota = {
    tick: Game.time,
    activeRequests: truckerQuotaMeta.activeRequests,
    urgentRequests: truckerQuotaMeta.urgentRequests,
    remoteEnergyWaiting: truckerQuotaMeta.remoteEnergyWaiting || 0,
    activeRemoteRooms: truckerQuotaMeta.activeRemoteRooms || 0,
    localDesiredTruckers: truckerQuotaMeta.localDesiredTruckers || localTruckerBaseQuota,
    remoteDesiredTruckers: truckerQuotaMeta.remoteDesiredTruckers || 0,
    finalTruckerQuota: truckerQuotaMeta.finalTruckerQuota || (quotas.Trucker || 0),
    desiredTruckers: truckerQuotaMeta.desiredTruckers,
    liveTruckers: liveTruckers,
    queuedTruckers: queuedTruckers,
    truckersOnLocalJobs: assignmentCounts.truckersOnLocalJobs,
    truckersOnRemoteJobs: assignmentCounts.truckersOnRemoteJobs,
    truckersOnRemotePickup: assignmentCounts.truckersOnRemotePickup,
    truckersOnRemoteReturn: assignmentCounts.truckersOnRemoteReturn,
    remoteCapableTruckers: assignmentCounts.remoteCapableTruckers,
    effectiveActiveTruckers: effectiveActiveTruckers,
    skipped: truckerQuotaMeta.skipped || {},
    reasons: (truckerQuotaMeta.remoteDesiredTruckers || 0) > 0 ? "workload-based remote demand" : "no active remote haul workload"
  };

  pruneOverfilledQueue(roomName, quotas, C);
  var sourceWorkerCoverageReport = buildVeinseekerCoverageReport(room);
  queueVeinseekerSourceNeeds(room, sourceWorkerCoverageReport);
  queueRemoteVeinseekerNeeds(roomName);

  // Iterate quotas in plain English order so future maintainers can eyeball
  // which roles will be enqueued before touching the code.
  var roles = Object.keys(quotas);
  var repairDiag = ensureRoomMemory(roomName).lastRepairQuota || null;
  for (var i = 0; i < roles.length; i++) {
    var role = roles[i];
    var limit = quotas[role] || 0;
    var canonical = canonicalRole(role);
    var active = getRoomLocalLiveCount(C, roomName, canonical);
    var queued = queuedCount(roomName, role);
    if (role === 'Trucker') {
      active = effectiveActiveTruckers;
    }
    if (role === 'Repair' && repairDiag) {
      active = repairDiag.liveLocalRepair + repairDiag.liveRemoteEmergencyRepair;
    }
    // Replacement behavior: allow at most one queued replacement for low-TTL
    // workers instead of blindly over-spawning to fill a temporary dip.
    var replacementNeed = 0;
    if (REPLACEMENT_TTL[role]) {
      replacementNeed = countRoleNeedingReplacement(roomName, canonical, REPLACEMENT_TTL[role]);
      if (replacementNeed > 1) replacementNeed = 1;
    }
    var effectiveLimit = limit + replacementNeed;
    var deficit = Math.max(0, effectiveLimit - active - queued);
    if (role === 'Trucker') {
      var truckerHardCap = truckerQuotaMeta.finalTruckerQuota || limit || 0;
      if (maxTotalTruckers > 0) truckerHardCap = Math.min(truckerHardCap, maxTotalTruckers);
      var spareUnderCap = Math.max(0, truckerHardCap - liveTruckers - queuedTruckers);
      deficit = Math.min(deficit, spareUnderCap);
    }
    if (deficit > 0 && tickEvery(DBG_EVERY)) {
      dlog('📥 [Queue]', roomName, 'role=', role, 'limit=', limit,
        'active=', active, 'queued=', queued, 'deficit=', deficit);
    }
    for (var j = 0; j < deficit; j++) {
      if (role === 'Repair') {
        var emergencyReq = repairDiag && repairDiag.selectedEmergencyRequest
          ? findRemoteContainerEmergencyRepairRequest(roomName)
          : null;
        if (emergencyReq && countRemoteEmergencyRepairAssignments(roomName) < Math.max(0, RepairConfig.remoteContainerEmergencyRepairMaxPerHome || 1)) {
          enqueue(roomName, role, {
            task: 'remoteContainerEmergencyRepair',
            home: roomName,
            targetRoom: emergencyReq.remoteRoom || emergencyReq.roomName,
            containerId: emergencyReq.containerId,
            sourceId: emergencyReq.sourceId,
            requestId: emergencyReq.id,
            x: emergencyReq.x,
            y: emergencyReq.y
          });
          if (repairDiag) {
            repairDiag.queuedRemoteEmergencyRepair = (repairDiag.queuedRemoteEmergencyRepair || 0) + 1;
            repairDiag.queueDecision = 'queuedRemoteEmergencyRepair';
          }
          continue;
        }
      }
      enqueue(roomName, role);
    }
  }
}

function countLiveLocalRoleDirect(roomName, roleName) {
  var count = 0;
  for (var name in Game.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Game.creeps, name)) continue;
    var creep = Game.creeps[name];
    if (!creep || !creep.my || !creep.memory) continue;
    if (canonicalRole(creep.memory.role) !== roleName) continue;
    if (getCreepHomeRoomName(creep) !== roomName) continue;
    if (creep.spawning) continue;
    count++;
  }
  return count;
}

function sourceHasLiveVeinseekerCoverage(roomName, sourceId) {
  return SourceWorkerManager.sourceHasLiveHomeCoverage(roomName, sourceId);
}

function roomHasVeinseekerEmergency(room) {
  return SourceWorkerManager.roomHasHomeEmergency(room);
}

function roomInBaseRecoveryDanger(room) {
  if (!room) return true;
  if (countLiveLocalRoleDirect(room.name, 'Queen') < 1) return true;
  if (countLiveLocalRoleDirect(room.name, 'Trucker') < 1) return true;
  if (roomHasVeinseekerEmergency(room)) return true;
  return false;
}

function queueHasCriticalBaseNeedAfter(q, startIndex, room) {
  for (var i = startIndex + 1; i < q.length; i++) {
    var item = q[i];
    if (!item) continue;
    if (item.retryAt && Game.time < item.retryAt) continue;
    var role = canonicalRole(item.role);
    if (role === 'Queen' || role === 'Trucker') return true;
    if (role === 'Veinseeker' && item.mode !== 'remote') {
      var mode = item.sourceWorkerSpawnMode || 'normal';
      var sourceId = getVeinseekerQueueSourceId(item);
      if (mode === 'emergency') return true;
      if (sourceId && room && !sourceHasLiveVeinseekerCoverage(room.name, sourceId)) return true;
    }
  }
  return false;
}

function stampVeinseekerDesiredPlanOnItem(item, desiredPlan) {
  if (!item || !desiredPlan) return;
  item.desiredBodyCost = desiredPlan.cost || 0;
  item.desiredBodySignature = desiredPlan.signature || '';
  item.desiredBodySummary = desiredPlan.summary || null;
  item.desiredBodyTierIndex = typeof desiredPlan.tierIndex === 'number' ? desiredPlan.tierIndex : -1;
}

function writeVeinseekerSpawnGate(room, item, minEnergy, action, reason, status) {
  if (!room) return;
  var diag = {
    tick: Game.time,
    role: item ? item.role : null,
    mode: item ? (item.sourceWorkerSpawnMode || 'normal') : null,
    sourceId: item ? (item.sourceId || item.replaceSourceId || item.assignedSource || null) : null,
    energyAvailable: room.energyAvailable || 0,
    energyCapacityAvailable: room.energyCapacityAvailable || 0,
    desiredBodyCost: item ? (item.desiredBodyCost || 0) : 0,
    minEnergy: minEnergy || 0,
    action: action,
    reason: reason
  };
  if (status) {
    diag.seats = status.seats || 0;
    diag.live = status.live || 0;
    diag.queued = status.queued || 0;
    diag.liveWork = status.liveWork || 0;
    diag.queuedWork = status.queuedWork || 0;
    diag.desiredWork = status.desiredWork || 0;
    diag.freeWork = status.freeWork || 0;
    diag.saturatedByWork = !!status.saturatedByWork;
    diag.saturatedBySeats = !!status.saturatedBySeats;
    diag.hasOpenSeat = !!status.hasOpenSeat;
    diag.selectedSeat = status.selectedSeat || null;
    diag.statusReason = status.reason || null;
  }
  ensureRoomMemory(room.name).lastVeinseekerSpawnGate = diag;
}

function evaluateVeinseekerSpawnGate(room, item, q, itemIndex) {
  var minEnergy = minEnergyFor(item.role, item);
  var energyAvailable = room.energyAvailable || 0;
  var desiredPlan = getVeinseekerDesiredPlan(room);
  var sourceId = getVeinseekerQueueSourceId(item);
  var mode = item.sourceWorkerSpawnMode || 'normal';
  var age = Game.time - (item.created || Game.time);
  var desiredCost = minEnergy;
  var criticalBehind = queueHasCriticalBaseNeedAfter(q, itemIndex, room);
  var recoveryDanger = roomInBaseRecoveryDanger(room);
  var sourceStatus = null;
  var hasCoverage = sourceHasLiveVeinseekerCoverage(room.name, sourceId);

  function done(result) {
    result.sourceStatus = sourceStatus;
    return result;
  }

  if (desiredPlan) {
    stampVeinseekerDesiredPlanOnItem(item, desiredPlan);
    desiredCost = desiredPlan.cost || minEnergy;
  }
  if (desiredCost > (room.energyCapacityAvailable || 0) && desiredPlan) {
    desiredCost = desiredPlan.cost || minEnergy;
  }

  if (!sourceId) {
    if (energyAvailable >= minEnergy) {
      return done({ action: 'spawn', energyForSpawn: energyAvailable, minEnergy: minEnergy, reason: 'legacy-veinseeker-no-source' });
    }
    return done({ action: 'wait', minEnergy: minEnergy, reason: 'not-enough-energy-for-cheapest-veinseeker' });
  }

  var checkedSourceForGate = Game.getObjectById(sourceId);
  if (!checkedSourceForGate) {
    return done({ action: 'skip', minEnergy: minEnergy, reason: 'source-missing-for-home-veinseeker' });
  }

  sourceStatus = SourceWorkerManager.getSourceMiningStatus(room.name, checkedSourceForGate, desiredPlan, {
    ensureRoomQueue: function () { return q; },
    excludeQueueIndex: itemIndex,
    safeTtl: VEINSEEKER_REPLACEMENT_SAFE_TTL
  });
  hasCoverage = sourceStatus ? sourceStatus.hasCoverage : hasCoverage;

  var isReplacementItem = !!(item.replaceCreepName || item.replacementFor || mode === 'upgradeReplacement');
  if (isReplacementItem && sourceStatus &&
      (sourceStatus.queued > 0 || sourceStatus.replacementQueued || sourceStatus.replacementInProgress)) {
    return done({ action: 'skip', minEnergy: minEnergy, reason: 'replacement-already-pending-for-source' });
  }

  if (!isReplacementItem && sourceStatus) {
    if (sourceStatus.desiredWork <= 0) {
      return done({ action: 'skip', minEnergy: minEnergy, reason: 'source-has-no-work-demand' });
    }
    if (sourceStatus.saturatedByWork) {
      return done({ action: 'skip', minEnergy: minEnergy, reason: 'source-already-work-saturated' });
    }
    if (sourceStatus.saturatedBySeats) {
      return done({ action: 'skip', minEnergy: minEnergy, reason: 'source-already-seat-saturated' });
    }
    if (!sourceStatus.hasOpenSeat) {
      return done({ action: 'skip', minEnergy: minEnergy, reason: 'source-has-no-open-seat' });
    }
    if (sourceStatus.freeWork <= 0) {
      return done({ action: 'skip', minEnergy: minEnergy, reason: 'source-work-demand-already-covered' });
    }
  }

  if (mode === 'emergency' || !hasCoverage) {
    if (energyAvailable >= minEnergy) {
      return done({ action: 'spawn', energyForSpawn: energyAvailable, minEnergy: minEnergy, reason: 'emergency-source-not-covered' });
    }
    return done({ action: 'wait', minEnergy: minEnergy, reason: 'emergency-waiting-for-cheapest-body' });
  }

  if (!VEINSEEKER_ENABLE_BODY_UPGRADES || !VEINSEEKER_WAIT_FOR_BEST_BODY) {
    if (energyAvailable >= minEnergy) {
      return done({ action: 'spawn', energyForSpawn: energyAvailable, minEnergy: minEnergy, reason: 'body-upgrade-wait-disabled' });
    }
    return done({ action: 'wait', minEnergy: minEnergy, reason: 'not-enough-energy-for-cheapest-veinseeker' });
  }

  if (mode === 'upgradeReplacement') {
    var checkedOldName = item.replaceCreepName || item.replacementFor || null;
    var checkedOldCreep = checkedOldName ? Game.creeps[checkedOldName] : null;
    var checkedOldSource = checkedSourceForGate;
    if (!checkedOldCreep || !checkedOldCreep.memory) {
      if (!hasCoverage) {
        item.sourceWorkerSpawnMode = 'emergency';
        return done({ action: 'downgrade', energyForSpawn: energyAvailable, minEnergy: minEnergy, reason: 'old-missing-source-now-emergency' });
      }
      return done({ action: 'skip', minEnergy: minEnergy, reason: 'old-creep-missing-upgrade-cancelled' });
    }
    if (typeof checkedOldCreep.ticksToLive === 'number' && checkedOldCreep.ticksToLive <= VEINSEEKER_CRITICAL_TTL) {
      item.sourceWorkerSpawnMode = 'normal';
      return done({ action: 'downgrade', energyForSpawn: energyAvailable, minEnergy: minEnergy, reason: 'old-creep-critical-ttl' });
    }
    if (!isVeinseekerSafelyHarvesting(checkedOldCreep, checkedOldSource)) {
      item.sourceWorkerSpawnMode = 'normal';
      return done({ action: 'downgrade', energyForSpawn: energyAvailable, minEnergy: minEnergy, reason: 'old-creep-not-safe-for-wait' });
    }
    if (energyAvailable >= desiredCost) {
      return done({ action: 'spawn', energyForSpawn: desiredCost, minEnergy: minEnergy, reason: 'desired-body-affordable' });
    }
    if (energyAvailable < minEnergy) {
      return done({ action: 'wait', minEnergy: minEnergy, reason: 'not-enough-energy-for-cheapest-veinseeker' });
    }
    if (recoveryDanger || criticalBehind) {
      item.retryAt = Game.time + QUEUE_RETRY_COOLDOWN;
      item.sourceWorkerDeferredAt = Game.time;
      return done({ action: 'defer', minEnergy: minEnergy, reason: recoveryDanger ? 'base-recovery-danger' : 'critical-role-behind' });
    }
    if (age >= VEINSEEKER_MAX_UPGRADE_WAIT_TICKS) {
      return done({ action: 'downgrade', energyForSpawn: energyAvailable, minEnergy: minEnergy, reason: 'max-upgrade-wait-reached' });
    }
    return done({ action: 'wait', minEnergy: minEnergy, reason: 'waiting-for-room-capacity-body' });
  }

  if (energyAvailable >= desiredCost) {
    return done({ action: 'spawn', energyForSpawn: desiredCost, minEnergy: minEnergy, reason: 'desired-body-affordable' });
  }

  if (energyAvailable < minEnergy) {
    return done({ action: 'wait', minEnergy: minEnergy, reason: 'not-enough-energy-for-cheapest-veinseeker' });
  }

  if (item.replaceCreepName || item.replacementFor) {
    var normalOldName = item.replaceCreepName || item.replacementFor;
    var normalOldCreep = Game.creeps[normalOldName];
    if (!normalOldCreep || !normalOldCreep.memory) {
      if (!hasCoverage) {
        return done({ action: 'downgrade', energyForSpawn: energyAvailable, minEnergy: minEnergy, reason: 'normal-replacement-old-missing-source-now-emergency' });
      }
      return done({ action: 'skip', minEnergy: minEnergy, reason: 'normal-replacement-old-missing-cancelled' });
    }
    if (typeof normalOldCreep.ticksToLive === 'number' &&
        normalOldCreep.ticksToLive <= VEINSEEKER_REPLACEMENT_SAFE_TTL) {
      return done({ action: 'downgrade', energyForSpawn: energyAvailable, minEnergy: minEnergy, reason: 'normal-replacement-old-ttl-low' });
    }
  }

  if (criticalBehind) {
    item.retryAt = Game.time + QUEUE_RETRY_COOLDOWN;
    item.sourceWorkerDeferredAt = Game.time;
    return done({ action: 'defer', minEnergy: minEnergy, reason: 'critical-role-behind' });
  }
  if (age >= VEINSEEKER_MAX_UPGRADE_WAIT_TICKS) {
    return done({ action: 'downgrade', energyForSpawn: energyAvailable, minEnergy: minEnergy, reason: 'max-normal-wait-reached' });
  }
  return done({ action: 'wait', minEnergy: minEnergy, reason: 'normal-covered-source-waiting-for-better-body' });
}

function isNonBlockingVeinseekerQueuedWait(item) {
  if (!isVeinseekerQueueItem(item)) return false;
  return item.sourceWorkerSpawnMode === 'upgradeReplacement' || item.sourceWorkerDeferredAt === Game.time;
}

function dequeueAndSpawn(spawner) {
  // Safety-first dequeue: Veinseeker upgrades may wait for a full room body,
  // but only when they are not blocking Queen, Trucker, or emergency miners.
  if (!spawner || spawner.spawning) return false;
  var room = spawner.room;
  var roomName = room.name;
  var q = ensureRoomQueue(roomName);
  if (!q.length) {
    if (tickEvery(DBG_EVERY)) {
      dlog('[Queue]', roomName, 'empty (energy', energyStatus(room) + ')');
    }
    return false;
  }

  q.sort(compareQueueItems);

  var skippedNonBlockingVeinseeker = false;
  for (var pickIndex = 0; pickIndex < q.length; pickIndex++) {
    var item = q[pickIndex];
    if (!item) continue;

    if (item.retryAt && Game.time < item.retryAt) {
      if (isNonBlockingVeinseekerQueuedWait(item)) {
        skippedNonBlockingVeinseeker = true;
        continue;
      }
      if (!skippedNonBlockingVeinseeker) {
        if (tickEvery(DBG_EVERY)) {
          dlog('[Queue]', roomName, 'head priority cooling down');
        }
        return false;
      }
      continue;
    }

    var needed = minEnergyFor(item.role, item);
    var spawnResource = null;
    var gate = null;

    if (isVeinseekerQueueItem(item)) {
      gate = evaluateVeinseekerSpawnGate(room, item, q, pickIndex);
      writeVeinseekerSpawnGate(room, item, gate.minEnergy || needed, gate.action, gate.reason, gate.sourceStatus);
      if (gate.action === 'skip') {
        q.splice(pickIndex, 1);
        pickIndex--;
        skippedNonBlockingVeinseeker = true;
        continue;
      }
      if (gate.action === 'defer') {
        skippedNonBlockingVeinseeker = true;
        continue;
      }
      if (gate.action === 'wait') {
        if (tickEvery(DBG_EVERY)) {
          dlog('[VeinseekerGate]', roomName, 'mode', item.sourceWorkerSpawnMode || 'normal',
            'need', item.desiredBodyCost || needed, 'have', room.energyAvailable, gate.reason);
        }
        return false;
      }
      if (gate.action === 'spawn' || gate.action === 'downgrade') {
        spawnResource = gate.energyForSpawn || room.energyAvailable || 0;
      }
    } else {
      if ((room.energyAvailable || 0) < needed) {
        var waitingRole = canonicalRole(item.role);
        if (waitingRole === 'Queen' || waitingRole === 'Trucker') {
          if (tickEvery(DBG_EVERY)) {
            dlog('[QueueHold]', roomName, 'critical role', item.role,
              'need', needed, 'have', room.energyAvailable);
          }
          return false;
        }
        if (!skippedNonBlockingVeinseeker) {
          if (tickEvery(DBG_EVERY)) {
            dlog('[QueueHold]', roomName, 'prio', item.priority, 'role', item.role,
              'need', needed, 'have', room.energyAvailable);
          }
          return false;
        }
        continue;
      }
    }

    dlog('[SpawnTry]', roomName, 'role=', item.role, 'prio=', item.priority,
      'age=', (Game.time - item.created), 'energy=', energyStatus(room));

    if (spawnResource === null && spawnLogic && typeof spawnLogic.Calculate_Spawn_Resource === 'function') {
      spawnResource = spawnLogic.Calculate_Spawn_Resource(spawner);
    }

    var ok = false;
    if (spawnLogic && typeof spawnLogic.spawnRole === 'function') {
      ok = spawnLogic.spawnRole(spawner, item.role, spawnResource, item);
    }

    if (ok) {
      dlog('[SpawnOK]', roomName, 'spawned', item.role, 'at', spawner.name);
      q.splice(pickIndex, 1);
      return true;
    }

    item.retryAt = Game.time + QUEUE_RETRY_COOLDOWN;
    dlog('[SpawnWait]', roomName, item.role, 'backoff to', item.retryAt,
      '(energy', energyStatus(room) + ')');
    return false;
  }

  if (tickEvery(DBG_EVERY)) {
    dlog('[Queue]', roomName, 'no spawnable item after non-blocking waits');
  }
  return false;
}

// Teaching habit: split orchestration into obvious verbs (prepare, run) so
// extending the manager later is painless.
function prepareRoomQueues(C) {
  // Per-room queue preparation runs before any spawn tries to dequeue. Remote
  // harvest discovery and assignment audits happen here so the spawn queue sees
  // the same Veinseeker plan that diagnostics report at the end of the function.
  var rooms = C.roomsOwned;
  for (var i = 0; i < rooms.length; i++) {
    var room = rooms[i];
    if (!room.find(FIND_MY_SPAWNS).length) continue;
    // Remote harvest setup has three separate phases:
    // 1) discover which rooms are possible remotes,
    // 2) update the Veinseeker source plan/audit used by existing queue behavior,
    // 3) after queue prep, write a read-only economics report for humans.
    var remoteDiscovery = SourceEnergyManager.gatherCandidateRemoteRoomsForHome(room);
    SourceEnergyManager.buildSourcePlanForHome(room.name, remoteDiscovery.acceptedRemoteRooms || []);
    SourceEnergyManager.auditAssignmentsForHome(room.name);
    if (Memory.rooms && Memory.rooms[room.name] && Memory.rooms[room.name].lastSourceEnergyPlan) {
      Memory.rooms[room.name].lastSourceEnergyPlan.candidateRemoteRooms = remoteDiscovery.candidateRemoteRooms || [];
      Memory.rooms[room.name].lastSourceEnergyPlan.acceptedRemoteRooms = remoteDiscovery.acceptedRemoteRooms || [];
      Memory.rooms[room.name].lastSourceEnergyPlan.rejectedRemoteRooms = remoteDiscovery.rejectedRemoteRooms || [];
    }
    ensureRoomQueue(room.name);
    pruneBlockedVeinseekerQueueItems(room.name);
    fillQueueForRoom(C, room);
    // This call is intentionally last: it observes the final live/queued Veinseeker
    // counts for the tick, but it does not enqueue, dequeue, reserve, or assign.
    SourceEnergyManager.buildRemoteSourceEconomicsReport(room.name, remoteDiscovery);
  }
}

// Squad spawns are intentionally serialized so they do not starve workers.
// BHM Combat Fix: dynamically rank every squad flag so defenders spawn where
// the biggest threat is instead of hard-coding "Alpha" only.
function normalizedSquadName(name) {
  if (!name) return 'SquadAlpha';
  if (typeof name === 'string' && name.indexOf('Squad') === 0) return name;
  return 'Squad' + name;
}

/**
 * squadThreatScore blends Memory.squads + SquadFlagIntel so BeeSpawnManager
 * can rank every squad flag (auto-defense + manual) by most urgent threat.
 */
function squadThreatScore(flagName) {
  var key = normalizedSquadName(flagName);
  if (!Memory.squads || !Memory.squads[key]) return 0;
  var bucket = Memory.squads[key];
  var score = bucket.lastKnownScore || 0;
  var roomName = bucket.targetRoom || (bucket.rally && bucket.rally.roomName) || null;
  if (roomName && SquadFlagIntel && typeof SquadFlagIntel.threatScoreForRoom === 'function') {
    var intelScore = SquadFlagIntel.threatScoreForRoom(roomName) || 0;
    if (intelScore > score) score = intelScore;
  }
  return score;
}

/**
 * gatherSpawnableSquads lists every Squad flag, applies squadThreatScore,
 * then sorts descending so trySpawnSquad always attempts the hottest room
 * first.
 */
function gatherSpawnableSquads() {
  var names = [];
  if (CombatSquads && typeof CombatSquads.listSquadFlags === 'function') {
    var listed = CombatSquads.listSquadFlags();
    if (listed && listed.length) {
      for (var i = 0; i < listed.length; i++) {
        names.push(listed[i]);
      }
    }
  }
  if (!names.length && Game.flags) {
    for (var flagName in Game.flags) {
      if (!Object.prototype.hasOwnProperty.call(Game.flags, flagName)) continue;
      if (flagName.indexOf('Squad') !== 0) continue;
      names.push(flagName);
    }
  }
  if (!names.length) names.push('Alpha');
  names.sort(function (a, b) {
    return squadThreatScore(b) - squadThreatScore(a);
  });
  return names;
}

/**
 * trySpawnSquad serializes squad spawning to one per tick per spawn while
 * iterating flags in priority order (via gatherSpawnableSquads).
 */
function trySpawnSquad(spawner, squadState) {
  if (!spawnLogic || typeof spawnLogic.Spawn_Squad !== 'function') return false;
  if (squadState.handled) return false;
  var squads = gatherSpawnableSquads();
  for (var i = 0; i < squads.length; i++) {
    var name = squads[i];
    var squadIntel = SquadFlagIntel && typeof SquadFlagIntel.resolveSquadTarget === 'function'
      ? SquadFlagIntel.resolveSquadTarget(name)
      : null;
    if (!squadIntel || (!squadIntel.flag && !squadIntel.targetRoom)) {
      continue;
    }
    var ok = spawnLogic.Spawn_Squad(spawner, name);
    if (!ok) {
      continue;
    }
    squadState.handled = true;
    dlog('🛡️ [Squad]', spawner.room.name, name, 'maintained at', spawner.name);
    return true;
  }
  return false;
}

function runSpawnPass(C) {
  // Once all queues are prepared, each idle spawn gets one chance to do combat
  // defense, manual squad work, or ordinary queued spawning. This prevents one
  // busy room from consuming unlimited spawn attempts in a single tick.
  var spawns = C.spawns;
  var squadState = { handled: false };
  var remoteDefenseHandled = false;
  for (var i = 0; i < spawns.length; i++) {
    var spawner = spawns[i];
    if (!spawner || spawner.spawning) continue;
    var roomName = spawner.room && spawner.room.name;
    var diag = {
      tick: Game.time,
      chosenSquad: null,
      targetRoom: null,
      score: 0,
      skippedReasons: [],
      spawnAttempted: false
    };
    if (remoteDefenseSpawningEnabled() && !remoteDefenseHandled) {
      var cheapestCombat = getCheapestCombatRoleEnergy();
      if ((spawner.room.energyAvailable || 0) < cheapestCombat) {
        diag.skippedReasons.push('insufficientEnergy');
      } else if (hasBaseRoleDeficit(C, roomName)) {
        diag.skippedReasons.push('baseRoleDeficit');
      } else {
        var remotePlans = gatherRemoteDefensePlans();
        if (!remotePlans.length) {
          diag.skippedReasons.push('noEligiblePlans');
        } else {
          var chosen = null;
          for (var rp = 0; rp < remotePlans.length; rp++) {
            if (isRemoteDefenseTargetAllowed(remotePlans[rp].targetRoom)) {
              chosen = remotePlans[rp];
              break;
            }
          }
          if (!chosen) {
            diag.skippedReasons.push('pvpDisallowedTarget');
          } else {
            diag.chosenSquad = chosen.squadName;
            diag.targetRoom = chosen.targetRoom;
            diag.score = chosen.score;
            diag.spawnAttempted = true;
            var remoteOk = spawnLogic && typeof spawnLogic.Spawn_Squad === 'function'
              ? spawnLogic.Spawn_Squad(spawner, chosen.squadName)
              : false;
            diag.result = remoteOk ? 'spawned' : 'spawnSkipped';
            if (remoteOk) {
              remoteDefenseHandled = true;
              if (roomName) writeRemoteDefenseDiag(roomName, diag);
              continue;
            }
          }
        }
      }
    } else if (!remoteDefenseSpawningEnabled()) {
      diag.skippedReasons.push('remoteDefenseDisabled');
    } else if (remoteDefenseHandled) {
      diag.skippedReasons.push('alreadySpawnedThisTick');
    }
    if (roomName) writeRemoteDefenseDiag(roomName, diag);
    if (squadSpawningEnabled() && trySpawnSquad(spawner, squadState)) {
      continue;
    }
    dequeueAndSpawn(spawner);
  }
}

// ------------------------------ Public API ------------------------------
var BeeSpawnManager = {
  manageSpawns: function manageSpawns(C) {
    // Public entry used by BeeHiveMind. It expects the tick cache C to already
    // contain owned rooms/spawns and live role counts from prepareTickCaches().
    if (!C || !Array.isArray(C.spawns) || !Array.isArray(C.roomsOwned)) return;
    if (squadSpawningEnabled() && CombatSquads && typeof CombatSquads.refreshAutoDefensePlans === 'function') {
      // BHM Combat Fix: keep squad plans in sync before evaluating spawn needs.
      CombatSquads.refreshAutoDefensePlans();
    }
    prepareRoomQueues(C);
    runSpawnPass(C);
  }
};

module.exports = BeeSpawnManager;
