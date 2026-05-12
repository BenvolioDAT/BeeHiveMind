'use strict';

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
var roleLuna    = require('role.Luna');
var BeeCombatSquads = require('BeeCombatSquads');
var SquadFlagIntel = BeeCombatSquads.SquadFlagIntel || null;

// --------------------------- Tunables & Constants ------------------------
var QUEUE_RETRY_COOLDOWN  = 5;
var QUEUE_HARD_LIMIT      = 20;
var DEBUG_SPAWN_QUEUE     = true;
var DBG_EVERY             = 5;
var INVADER_LOCK_TTL      = 1500;
var DYING_SOON_TTL        = 60;
var STABILITY_HISTORY_WINDOW = 150;
var RECOVERY_MIN_HOLD_TICKS = 25;
var RECOVERY_CLEAR_STABLE_TICKS = 15;
var COMBAT_RELAX_AFTER_TICKS = 250;
var BAND_BUDGET_MIN_SAMPLES = 5;
var FEEDBACK_ALPHA = 0.20;
var FEEDBACK_WINDOW_TICKS = 200;
var SCOUT_STARVATION_TICKS = 20;
var BUILDER_STARVATION_TICKS = 20;

var RECOVERY_BAND_BUDGET_CAPS = {
  COMBAT: 0.20,
  GROWTH: 0.25,
  SUPPORT: 0.20,
  SITUATIONAL: 0.10
};

var ROLE_PRIORITY = {
  BaseHarvest: 100,
  Courier:      95,
  Queen:        90,
  Upgrader:     80,
  Builder:      75,
  Luna:         70,
  Repair:       60,
  Claimer:      55,
  Scout:        40,
  Trucker:      35,
  Dismantler:   30,
  CombatArcher: 25,
  CombatMelee:  25,
  CombatMedic:  25
};

var ROLE_MIN_ENERGY = {
  BaseHarvest: 200,
  Courier:     150,
  Queen:       200,
  Upgrader:    200,
  Builder:     200,
  Luna:        250,
  Repair:      200,
  Claimer:     650,
  Scout:       50,
  Trucker:     200,
  Dismantler:  150,
  CombatArcher:200,
  CombatMelee: 200,
  CombatMedic: 200
};

var ROLE_ALIAS_MAP = (function () {
  var map = Object.create(null);
  var canon = [
    'BaseHarvest',
    'Builder',
    'Courier',
    'Repair',
    'Upgrader',
    'Dismantler',
    'Luna',
    'Scout',
    'Queen',
    'Trucker',
    'Claimer',
    'CombatArcher',
    'CombatMedic',
    'CombatMelee'
  ];
  for (var i = 0; i < canon.length; i++) {
    var name = canon[i];
    map[name] = name;
    map[name.toLowerCase()] = name;
  }
  map.remoteharvest = 'Luna';
  return map;
})();

var ROLE_BAND = {
  BaseHarvest: 'SURVIVAL',
  Courier: 'SURVIVAL',
  Queen: 'SURVIVAL',
  Upgrader: 'ECONOMY',
  Luna: 'ECONOMY',
  Builder: 'GROWTH',
  Repair: 'SUPPORT',
  Scout: 'SUPPORT',
  Trucker: 'SITUATIONAL',
  Claimer: 'SITUATIONAL',
  Dismantler: 'SITUATIONAL',
  CombatArcher: 'COMBAT',
  CombatMelee: 'COMBAT',
  CombatMedic: 'COMBAT'
};

var BAND_PRIORITY_BONUS = {
  SURVIVAL: 10,
  ECONOMY: 6,
  GROWTH: 3,
  SUPPORT: 1,
  SITUATIONAL: 0,
  COMBAT: 0
};

var PROTECTED_ROLE_FLOORS = {
  BaseHarvest: 1,
  Courier: 1,
  Queen: 1
};

var FLOOR_ROLE_SET = {
  BaseHarvest: true,
  Courier: true,
  Queen: true
};

function canonicalRole(role) {
  if (!role) return null;
  var key = String(role);
  if (ROLE_ALIAS_MAP[key]) return ROLE_ALIAS_MAP[key];
  var lower = key.toLowerCase();
  if (ROLE_ALIAS_MAP[lower]) return ROLE_ALIAS_MAP[lower];
  var fallback = key.charAt(0).toUpperCase() + key.slice(1);
  if (ROLE_ALIAS_MAP[fallback]) return ROLE_ALIAS_MAP[fallback];
  return key;
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

function minEnergyFor(role) {
  if (spawnLogic && typeof spawnLogic.minEnergyFor === 'function') {
    var override = spawnLogic.minEnergyFor(role);
    if (typeof override === 'number') {
      return override;
    }
  }
  return ROLE_MIN_ENERGY[role] || 200;
}

function roleBand(role) {
  var canonical = canonicalRole(role);
  return ROLE_BAND[canonical] || 'SITUATIONAL';
}

function rolePriority(role) {
  var canonical = canonicalRole(role);
  var base = ROLE_PRIORITY[canonical] || 0;
  var band = roleBand(canonical);
  return base + (BAND_PRIORITY_BONUS[band] || 0);
}

function plannerConfig() {
  var planner = CoreConfig && CoreConfig.settings && CoreConfig.settings.combat && CoreConfig.settings.combat.planner
    ? CoreConfig.settings.combat.planner
    : {};
  return {
    economy: planner.economy || {}
  };
}

function classifyRoomMaturity(room) {
  if (!room) return 'EARLY';
  var rcl = (room.controller && typeof room.controller.level === 'number') ? room.controller.level : 0;
  var cap = room.energyCapacityAvailable || 0;
  if (rcl >= 8 || cap >= 2600) return 'ENDGAME';
  if (rcl >= 6 || cap >= 1800) return 'LATE';
  if (rcl >= 4 || cap >= 800) return 'MID';
  return 'EARLY';
}

function classifyEconomyState(room, maturity) {
  if (!room) return 'CRITICAL';
  var cfg = plannerConfig().economy;
  var storageEnergy = room.storage && room.storage.store ? (room.storage.store[RESOURCE_ENERGY] || 0) : 0;
  var terminalEnergy = room.terminal && room.terminal.store ? (room.terminal.store[RESOURCE_ENERGY] || 0) : 0;
  var stock = storageEnergy + terminalEnergy;
  var cap = room.energyCapacityAvailable || 0;
  var rcl = (room.controller && typeof room.controller.level === 'number') ? room.controller.level : 0;

  var criticalStorage = typeof cfg.CRITICAL_STORAGE === 'number' ? cfg.CRITICAL_STORAGE : 20000;
  var strainedStorage = typeof cfg.STRAINED_STORAGE === 'number' ? cfg.STRAINED_STORAGE : 80000;
  var healthyStorage = typeof cfg.HEALTHY_STORAGE === 'number' ? cfg.HEALTHY_STORAGE : 180000;
  var criticalTerminal = typeof cfg.CRITICAL_TERMINAL === 'number' ? cfg.CRITICAL_TERMINAL : 10000;
  var strainedTerminal = typeof cfg.STRAINED_TERMINAL === 'number' ? cfg.STRAINED_TERMINAL : 40000;
  var healthyTerminal = typeof cfg.HEALTHY_TERMINAL === 'number' ? cfg.HEALTHY_TERMINAL : 100000;
  var earlyCap = typeof cfg.EARLY_CAPACITY === 'number' ? cfg.EARLY_CAPACITY : 550;
  var midCap = typeof cfg.MID_CAPACITY === 'number' ? cfg.MID_CAPACITY : 1300;
  var lateCap = typeof cfg.LATE_CAPACITY === 'number' ? cfg.LATE_CAPACITY : 2300;

  if (!room.storage && !room.terminal) {
    if (cap <= earlyCap || rcl <= 3) return 'CRITICAL';
    if (cap <= midCap || rcl <= 5) return 'STRAINED';
    if (cap <= lateCap || maturity === 'LATE') return 'HEALTHY';
    return 'RICH';
  }

  if (storageEnergy <= criticalStorage && terminalEnergy <= criticalTerminal) return 'CRITICAL';
  if (stock <= strainedStorage || (terminalEnergy > 0 && terminalEnergy <= strainedTerminal)) return 'STRAINED';
  if (stock <= healthyStorage || (terminalEnergy > 0 && terminalEnergy <= healthyTerminal)) return 'HEALTHY';
  return 'RICH';
}

function clampInt(n, min, max) {
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function buildBacklogBucket(totalSites, criticalSites) {
  if (criticalSites > 0 || totalSites >= 30) return 'CRITICAL';
  if (totalSites >= 15) return 'HIGH';
  if (totalSites >= 5) return 'MEDIUM';
  if (totalSites > 0) return 'LOW';
  return 'NONE';
}

function repairBacklogBucket(totalRepairs, criticalRepairs) {
  if (criticalRepairs > 0 || totalRepairs >= 30) return 'CRITICAL';
  if (totalRepairs >= 15) return 'HIGH';
  if (totalRepairs >= 6) return 'MEDIUM';
  if (totalRepairs > 0) return 'LOW';
  return 'NONE';
}

function roleBodyGuidance(role, planner) {
  var canonical = canonicalRole(role);
  if (!canonical || canonical === 'BaseHarvest') return 0;
  if (canonical === 'Scout') return { capIndex: 0, reason: 'SCOUT_FIXED' };
  var p = planner || {};
  var maturity = p.maturity || 'EARLY';
  var economyState = p.economyState || 'CRITICAL';
  var signals = p.signals || {};
  var recoveryBias = !!p.recoveryBias;
  var cap = 0;
  var reason = ['BASE'];

  if (economyState === 'CRITICAL') { cap = 3; reason.push('ECON_CRITICAL'); }
  else if (economyState === 'STRAINED') { cap = 2; reason.push('ECON_STRAINED'); }
  else if (economyState === 'HEALTHY') { cap = 1; reason.push('ECON_HEALTHY'); }
  else { cap = 0; reason.push('ECON_RICH'); }

  if (recoveryBias) { cap += 1; reason.push('RECOVERY_BIAS'); }

  if (canonical === 'Courier') {
    if ((signals.remoteCount || 0) >= 2 && economyState !== 'CRITICAL') {
      cap -= 1;
      reason.push('REMOTE_LOAD');
    }
    if ((signals.remoteCount || 0) === 0 && maturity === 'EARLY') {
      cap += 1;
      reason.push('EARLY_LOCAL_ONLY');
    }
  } else if (canonical === 'Builder') {
    if (signals.buildBacklogBucket === 'CRITICAL') { cap -= 1; reason.push('BUILD_CRITICAL'); }
    else if (signals.buildBacklogBucket === 'HIGH') { reason.push('BUILD_HIGH'); }
    else if (signals.buildBacklogBucket === 'LOW' || signals.buildBacklogBucket === 'NONE') {
      cap += 1;
      reason.push('BUILD_LIGHT');
    }
  } else if (canonical === 'Repair') {
    if (signals.repairBacklogBucket === 'CRITICAL') { cap -= 1; reason.push('REPAIR_CRITICAL'); }
    else if (signals.repairBacklogBucket === 'LOW' || signals.repairBacklogBucket === 'NONE') {
      cap += 1;
      reason.push('REPAIR_LIGHT');
    }
  } else if (canonical === 'Upgrader') {
    if (economyState === 'RICH' && maturity !== 'EARLY') {
      cap -= 1;
      reason.push('UPGRADE_RICH');
    }
    if (economyState === 'CRITICAL' || economyState === 'STRAINED') {
      cap += 1;
      reason.push('UPGRADE_CONSERVE');
    }
  } else if (canonical === 'Luna') {
    if ((signals.remoteCount || 0) >= 2 && (economyState === 'HEALTHY' || economyState === 'RICH')) {
      cap -= 1;
      reason.push('REMOTE_BREADTH');
    }
    if (economyState === 'CRITICAL' || economyState === 'STRAINED') {
      cap += 1;
      reason.push('REMOTE_CONSERVE');
    }
  } else if (canonical === 'Queen') {
    // Stage-4 light touch only: keep queen stable, only soften body in weak states.
    if (economyState === 'CRITICAL' || recoveryBias) {
      cap = Math.max(cap, 1);
      reason.push('QUEEN_RECOVERY_FRIENDLY');
    } else {
      cap = 0;
      reason.push('QUEEN_FULL');
    }
  }

  if (maturity === 'EARLY') { cap = Math.max(cap, 2); reason.push('MAT_EARLY_CAP'); }
  else if (maturity === 'MID') { cap = Math.max(cap, 1); reason.push('MAT_MID_CAP'); }

  cap = clampInt(cap, 0, 5);
  return { capIndex: cap, reason: reason.join('|') };
}

function bodyCapIndexForRole(role, planner) {
  return roleBodyGuidance(role, planner).capIndex;
}

function ensureSpawnDebug(roomName) {
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
  if (!Memory.rooms[roomName].spawnDebug) Memory.rooms[roomName].spawnDebug = {};
  return Memory.rooms[roomName].spawnDebug;
}

function compactEnergy(room) {
  return {
    energyAvailable: room ? (room.energyAvailable || 0) : 0,
    energyCapacityAvailable: room ? (room.energyCapacityAvailable || 0) : 0
  };
}

function emaUpdate(prev, sample, alpha) {
  if (typeof prev !== 'number') return sample;
  return (prev * (1 - alpha)) + (sample * alpha);
}

function ensureFeedbackState(debug) {
  if (!debug.feedback) {
    debug.feedback = {
      windowTicks: FEEDBACK_WINDOW_TICKS,
      alpha: FEEDBACK_ALPHA,
      lastSignals: null,
      roles: {
        Courier: { emaOutput: 0, emaAction: 0, emaCount: 0, emaPerCreep: 0, status: 'INIT', chronic: 0, bias: 0, signalQuality: 'LOW_SAMPLE', signalSource: 'PROXY_ONLY' },
        Builder: { emaOutput: 0, emaAction: 0, emaCount: 0, emaPerCreep: 0, status: 'INIT', chronic: 0, bias: 0, signalQuality: 'LOW_SAMPLE', signalSource: 'PROXY_ONLY' },
        Repair: { emaOutput: 0, emaAction: 0, emaCount: 0, emaPerCreep: 0, status: 'INIT', chronic: 0, bias: 0, signalQuality: 'LOW_SAMPLE', signalSource: 'PROXY_ONLY' },
        Luna: { emaOutput: 0, emaAction: 0, emaCount: 0, emaPerCreep: 0, status: 'INIT', chronic: 0, bias: 0, signalQuality: 'LOW_SAMPLE', signalSource: 'PROXY_ONLY' },
        Upgrader: { emaOutput: 0, emaAction: 0, emaCount: 0, emaPerCreep: 0, status: 'INIT', chronic: 0, bias: 0, signalQuality: 'LOW_SAMPLE', signalSource: 'PROXY_ONLY' }
      },
      chronic: {},
      adjustments: {},
      tuningHints: [],
      lunaROI: null
    };
  }
  return debug.feedback;
}

function computeLunaRemoteROI(room, lunaSignal, economy, lunaFeedback) {
  var remotes = lunaSignal && typeof lunaSignal.remoteCount === 'number' ? lunaSignal.remoteCount : 0;
  var sources = lunaSignal && typeof lunaSignal.totalSources === 'number' ? lunaSignal.totalSources : 0;
  if (remotes <= 0) {
    return {
      score: 0,
      bucket: 'DISABLED',
      reasons: ['NO_REMOTES'],
      hostileRatio: 0,
      sourcesPerRemote: 0
    };
  }

  var hostileLocked = 0;
  var remoteNames = (global.__BHM && global.__BHM.remotesByHome && room && global.__BHM.remotesByHome[room.name])
    ? global.__BHM.remotesByHome[room.name]
    : [];
  var roomsMem = Memory.rooms || {};
  for (var i = 0; i < remoteNames.length; i++) {
    var rn = remoteNames[i];
    var mem = roomsMem[rn] || {};
    if (mem.hostile) hostileLocked += 1;
    if (mem._invaderLock && mem._invaderLock.locked) hostileLocked += 1;
  }
  if (hostileLocked > remotes) hostileLocked = remotes;
  var hostileRatio = remotes > 0 ? (hostileLocked / remotes) : 0;
  var sourcesPerRemote = remotes > 0 ? (sources / remotes) : 0;
  var score = 0.55;
  var reasons = [];

  score += Math.min(0.20, sourcesPerRemote * 0.08);
  if (sourcesPerRemote >= 1.5) reasons.push('GOOD_SOURCE_DENSITY');
  score -= Math.min(0.30, hostileRatio * 0.45);
  if (hostileRatio > 0.35) reasons.push('HOSTILE_PRESSURE');
  if (economy === 'CRITICAL') { score -= 0.15; reasons.push('ECON_CRITICAL'); }
  else if (economy === 'STRAINED') { score -= 0.08; reasons.push('ECON_STRAINED'); }
  if (lunaFeedback && lunaFeedback.emaPerCreep < 0.20) {
    score -= 0.08;
    reasons.push('LOW_LUNA_FEEDBACK');
  }
  if (lunaFeedback && lunaFeedback.emaPerCreep > 0.60) {
    score += 0.05;
    reasons.push('STRONG_LUNA_FEEDBACK');
  }
  score = Math.max(0, Math.min(1, score));

  var bucket = 'FAIR';
  if (score < 0.35) bucket = 'POOR';
  else if (score > 0.70) bucket = 'GOOD';

  return {
    score: score,
    bucket: bucket,
    reasons: reasons,
    hostileRatio: hostileRatio,
    sourcesPerRemote: sourcesPerRemote
  };
}

function collectRoleActionCounts(C, room) {
  var empty = { Courier: 0, Builder: 0, Repair: 0, Luna: 0, Upgrader: 0, samples: 0, available: false };
  if (!room || typeof room.getEventLog !== 'function') return empty;
  var events = room.getEventLog();
  if (!events || !events.length) return empty;
  var byId = Object.create(null);
  if (C && C.creeps && C.creeps.length) {
    for (var i = 0; i < C.creeps.length; i++) {
      var cr = C.creeps[i];
      if (!cr || !cr.id || !cr.memory) continue;
      var rr = canonicalRole(cr.memory.role || cr.memory.task);
      if (!rr) continue;
      byId[cr.id] = rr;
    }
  }
  var out = { Courier: 0, Builder: 0, Repair: 0, Luna: 0, Upgrader: 0, samples: 0, available: true };
  for (var e = 0; e < events.length; e++) {
    var ev = events[e];
    if (!ev || !ev.objectId) continue;
    var role = byId[ev.objectId];
    if (!role) continue;
    out.samples += 1;
    if (ev.event === EVENT_TRANSFER && role === 'Courier') {
      var amount = ev.data && typeof ev.data.amount === 'number' ? ev.data.amount : 0;
      out.Courier += amount > 0 ? Math.max(1, Math.floor(amount / 100)) : 1;
    } else if (ev.event === EVENT_BUILD && role === 'Builder') {
      out.Builder += 1;
    } else if (ev.event === EVENT_REPAIR && role === 'Repair') {
      out.Repair += 1;
    } else if (ev.event === EVENT_UPGRADE_CONTROLLER && role === 'Upgrader') {
      out.Upgrader += 1;
    } else if ((ev.event === EVENT_HARVEST || ev.event === EVENT_TRANSFER) && role === 'Luna') {
      out.Luna += 1;
    }
  }
  return out;
}

function ensureStabilityState(debug) {
  if (!debug.stability) {
    debug.stability = {
      recovery: {
        active: false,
        enteredAt: null,
        clearSince: null,
        reason: 'INIT'
      },
      starvation: {
        BaseHarvest: { since: null, duration: 0, unmet: false, lastTick: null },
        Courier: { since: null, duration: 0, unmet: false, lastTick: null },
        Queen: { since: null, duration: 0, unmet: false, lastTick: null },
        Builder: { since: null, duration: 0, unmet: false, lastTick: null },
        Repair: { since: null, duration: 0, unmet: false, lastTick: null }
      }
    };
  }
  if (!Array.isArray(debug.spawnHistory)) debug.spawnHistory = [];
  return debug.stability;
}

function pruneSpawnHistory(debug) {
  if (!debug || !Array.isArray(debug.spawnHistory)) return;
  var cutoff = Game.time - STABILITY_HISTORY_WINDOW;
  var kept = [];
  for (var i = 0; i < debug.spawnHistory.length; i++) {
    var rec = debug.spawnHistory[i];
    if (!rec || typeof rec.t !== 'number') continue;
    if (rec.t < cutoff) continue;
    kept.push(rec);
  }
  debug.spawnHistory = kept;
}

function pushSpawnHistory(debug, role, band, source, reason) {
  if (!debug) return;
  if (!Array.isArray(debug.spawnHistory)) debug.spawnHistory = [];
  debug.spawnHistory.push({
    t: Game.time,
    role: role || 'Unknown',
    band: band || 'SITUATIONAL',
    source: source || 'queue',
    reason: reason || null
  });
  pruneSpawnHistory(debug);
}

function computeBandUsage(debug) {
  pruneSpawnHistory(debug);
  var counts = {
    SURVIVAL: 0,
    ECONOMY: 0,
    GROWTH: 0,
    SUPPORT: 0,
    SITUATIONAL: 0,
    COMBAT: 0
  };
  var total = 0;
  if (!debug || !Array.isArray(debug.spawnHistory)) {
    return {
      total: 0,
      counts: counts,
      shares: {
        SURVIVAL: 0,
        ECONOMY: 0,
        GROWTH: 0,
        SUPPORT: 0,
        SITUATIONAL: 0,
        COMBAT: 0
      }
    };
  }
  for (var i = 0; i < debug.spawnHistory.length; i++) {
    var rec = debug.spawnHistory[i];
    if (!rec || !rec.band) continue;
    var b = rec.band;
    if (!Object.prototype.hasOwnProperty.call(counts, b)) continue;
    counts[b] += 1;
    total += 1;
  }
  var shares = {};
  var keys = Object.keys(counts);
  for (var j = 0; j < keys.length; j++) {
    var key = keys[j];
    shares[key] = total > 0 ? (counts[key] / total) : 0;
  }
  return { total: total, counts: counts, shares: shares };
}

function computeUrgentBacklogSignals(room, plannerSignals) {
  var build = plannerSignals && plannerSignals.criticalBuildBacklog > 0;
  var repair = plannerSignals && plannerSignals.criticalRepairBacklog > 0;
  if (room) {
    if (!build && countCriticalBuildBacklog(room) > 0) build = true;
    if (!repair && countCriticalRepairBacklog(room) > 0) repair = true;
  }
  return { builder: build, repair: repair };
}

function budgetBlocksRole(arb, role, band, hasUrgentException) {
  if (!arb || !arb.recoveryMode) return false;
  if (!arb.bandUsage || arb.bandUsage.total < BAND_BUDGET_MIN_SAMPLES) return false;
  if (FLOOR_ROLE_SET[role]) return false;
  if (hasUrgentException) return false;
  var cap = arb.budgetCaps && arb.budgetCaps[band];
  if (typeof cap !== 'number') return false;
  var share = arb.bandUsage.shares && typeof arb.bandUsage.shares[band] === 'number'
    ? arb.bandUsage.shares[band]
    : 0;
  return share > cap;
}

function isUpgraderSafetyRequired(room) {
  if (!room || !room.controller || !room.controller.my) return false;
  var lvl = room.controller.level || 0;
  if (lvl <= 2) return true;
  var downgrade = room.controller.ticksToDowngrade || 0;
  return downgrade > 0 && downgrade < 4000;
}

function countRoleWithQueue(C, roomName, role) {
  var canonical = canonicalRole(role);
  var live = getRoomLocalLiveCount(C, roomName, canonical);
  var queued = queuedCount(roomName, canonical);
  return { live: live, queued: queued, total: live + queued };
}

function getRoomLocalLiveCount(C, roomName, role) {
  var canonical = canonicalRole(role);
  if (!canonical) return 0;
  if (canonical === 'Luna') {
    return ((C && C.lunaCountsByHome && C.lunaCountsByHome[roomName]) || 0);
  }
  // Planner quotas are computed per room, so default to room-local live counts
  // for every non-combat role in that room.  This prevents one room's creeps
  // from masking deficits in another room.
  return countRoleInRoom(C, roomName, canonical);
}

function suppressedBandsForState(economyState, recoveryMode) {
  var map = {};
  if (economyState === 'CRITICAL') {
    map.GROWTH = true;
    map.SUPPORT = true;
    map.SITUATIONAL = true;
  } else if (economyState === 'STRAINED') {
    map.SITUATIONAL = true;
  }
  if (recoveryMode) {
    map.GROWTH = true;
    map.SUPPORT = true;
    map.SITUATIONAL = true;
  }
  return map;
}

function buildArbitrationState(C, room, roomName, quotas) {
  var debug = ensureSpawnDebug(roomName);
  var stability = ensureStabilityState(debug);
  var planner = debug.planner || {};
  var economy = planner.economyState || classifyEconomyState(room, classifyRoomMaturity(room));

  var floors = {};
  floors.BaseHarvest = (quotas.BaseHarvest > 0) ? PROTECTED_ROLE_FLOORS.BaseHarvest : 0;
  floors.Courier = (quotas.Courier > 0) ? PROTECTED_ROLE_FLOORS.Courier : 0;
  floors.Queen = (quotas.Queen > 0) ? PROTECTED_ROLE_FLOORS.Queen : 0;
  floors.UpgraderSafety = isUpgraderSafetyRequired(room) ? 1 : 0;

  var unmet = [];
  var unmetSurvival = [];
  var unmetEconomy = [];
  var rolesToCheck = ['BaseHarvest', 'Courier', 'Queen'];
  for (var i = 0; i < rolesToCheck.length; i++) {
    var role = rolesToCheck[i];
    var floor = floors[role] || 0;
    if (floor <= 0) continue;
    var counts = countRoleWithQueue(C, roomName, role);
    if (counts.total < floor) {
      unmet.push(role);
      unmetSurvival.push(role);
    }
  }
  if (floors.UpgraderSafety > 0) {
    var upCounts = countRoleWithQueue(C, roomName, 'Upgrader');
    if (upCounts.total < floors.UpgraderSafety) {
      unmet.push('Upgrader');
      unmetEconomy.push('Upgrader');
    }
  }

  var queue = ensureRoomQueue(roomName);
  var rawRecovery = false;
  if (economy === 'CRITICAL') rawRecovery = true;
  if (unmet.length > 0) rawRecovery = true;
  if (queue.length >= 8 && unmet.length > 0) rawRecovery = true;

  // Stage-3 hysteresis:
  // - enter recovery immediately when raw trigger is true
  // - once active, require a minimum hold duration and a stable clear window
  //   before exiting, to prevent rapid on/off flapping.
  var rec = stability.recovery;
  if (rawRecovery) {
    if (!rec.active) {
      rec.active = true;
      rec.enteredAt = Game.time;
    }
    rec.clearSince = null;
    rec.reason = 'RECOVERY_TRIGGER';
  } else if (rec.active) {
    var held = rec.enteredAt != null ? (Game.time - rec.enteredAt) : 0;
    if (held < RECOVERY_MIN_HOLD_TICKS) {
      rec.reason = 'HOLD_MIN_TICKS';
    } else {
      if (rec.clearSince == null) rec.clearSince = Game.time;
      var clearFor = Game.time - rec.clearSince;
      if (clearFor >= RECOVERY_CLEAR_STABLE_TICKS) {
        rec.active = false;
        rec.enteredAt = null;
        rec.clearSince = null;
        rec.reason = 'CLEARED_STABLE';
      } else {
        rec.reason = 'HOLD_CLEAR_WINDOW';
      }
    }
  } else {
    rec.reason = 'STABLE';
  }
  var recoveryMode = rec.active;
  var recoveryActiveDuration = rec.active && rec.enteredAt != null ? (Game.time - rec.enteredAt) : 0;
  var clearStableTicks = rec.clearSince != null ? (Game.time - rec.clearSince) : 0;
  rec.activeDuration = recoveryActiveDuration;
  rec.clearStableTicks = clearStableTicks;
  rec.minHoldTicks = RECOVERY_MIN_HOLD_TICKS;
  rec.clearStableTarget = RECOVERY_CLEAR_STABLE_TICKS;
  rec.lastRawTrigger = rawRecovery;

  // Starvation duration tracking for critical floor roles + optional Builder/Repair.
  var starvation = stability.starvation;
  var trackedRoles = ['BaseHarvest', 'Courier', 'Queen', 'Builder', 'Repair'];
  for (var sr = 0; sr < trackedRoles.length; sr++) {
    var trackedRole = trackedRoles[sr];
    var isUnmet = false;
    if (trackedRole === 'Builder') {
      isUnmet = ((quotas.Builder || 0) > 0) && (countRoleWithQueue(C, roomName, 'Builder').total <= 0);
    } else if (trackedRole === 'Repair') {
      isUnmet = ((quotas.Repair || 0) > 0) && (countRoleWithQueue(C, roomName, 'Repair').total <= 0);
    } else {
      for (var um = 0; um < unmetSurvival.length; um++) {
        if (unmetSurvival[um] === trackedRole) { isUnmet = true; break; }
      }
    }
    if (isUnmet) {
      if (starvation[trackedRole].since == null) starvation[trackedRole].since = Game.time;
      starvation[trackedRole].duration = Game.time - starvation[trackedRole].since;
      starvation[trackedRole].unmet = true;
      starvation[trackedRole].lastTick = Game.time;
    } else {
      starvation[trackedRole].since = null;
      starvation[trackedRole].duration = 0;
      starvation[trackedRole].unmet = false;
      starvation[trackedRole].lastTick = Game.time;
    }
  }

  var suppressedBands = suppressedBandsForState(economy, recoveryMode);
  var bandUsage = computeBandUsage(debug);

  var urgentBacklog = computeUrgentBacklogSignals(room, planner.signals || null);
  var roleTotals = {
    Builder: countRoleWithQueue(C, roomName, 'Builder').total,
    Scout: countRoleWithQueue(C, roomName, 'Scout').total,
    Repair: countRoleWithQueue(C, roomName, 'Repair').total
  };

  var st = {
    tick: Game.time,
    economyState: economy,
    rawRecovery: rawRecovery,
    recoveryMode: recoveryMode,
    recoveryHoldReason: rec.reason,
    recoveryEnterTick: rec.enteredAt,
    recoveryActiveDuration: recoveryActiveDuration,
    recoveryMinHoldTicks: RECOVERY_MIN_HOLD_TICKS,
    recoveryClearStableTarget: RECOVERY_CLEAR_STABLE_TICKS,
    recoveryClearStableTicks: clearStableTicks,
    floors: floors,
    unmetFloors: unmet,
    unmetSurvivalFloors: unmetSurvival,
    unmetEconomyFloors: unmetEconomy,
    starvationDuration: {
      BaseHarvest: starvation.BaseHarvest.duration,
      Courier: starvation.Courier.duration,
      Queen: starvation.Queen.duration,
      Builder: starvation.Builder.duration,
      Repair: starvation.Repair.duration
    },
    starvationState: starvation,
    suppressedBands: suppressedBands,
    urgentBacklog: urgentBacklog,
    roleTotals: roleTotals,
    bandUsageWindow: STABILITY_HISTORY_WINDOW,
    bandUsage: bandUsage,
    bandBudgetWindow: {
      ticks: STABILITY_HISTORY_WINDOW,
      samples: bandUsage.total,
      counts: bandUsage.counts,
      shares: bandUsage.shares,
      caps: RECOVERY_BAND_BUDGET_CAPS,
      overCap: {
        SURVIVAL: false,
        ECONOMY: false,
        GROWTH: bandUsage.shares.GROWTH > RECOVERY_BAND_BUDGET_CAPS.GROWTH,
        SUPPORT: bandUsage.shares.SUPPORT > RECOVERY_BAND_BUDGET_CAPS.SUPPORT,
        SITUATIONAL: bandUsage.shares.SITUATIONAL > RECOVERY_BAND_BUDGET_CAPS.SITUATIONAL,
        COMBAT: bandUsage.shares.COMBAT > RECOVERY_BAND_BUDGET_CAPS.COMBAT
      }
    },
    budgetCaps: RECOVERY_BAND_BUDGET_CAPS,
    blockedRoleReasons: {}
  };
  st.energyAvailable = room && typeof room.energyAvailable === 'number' ? room.energyAvailable : 0;
  debug.arbitration = st;
  return st;
}

function isEmergencyDefenseNeeded(roomName) {
  if (!roomName) return false;
  var score = SquadFlagIntel && typeof SquadFlagIntel.threatScoreForRoom === 'function'
    ? (SquadFlagIntel.threatScoreForRoom(roomName) || 0)
    : 0;
  if (score > 0) return true;
  var room = Game.rooms[roomName];
  if (!room || typeof room.find !== 'function') return false;
  var hostiles = room.find(FIND_HOSTILE_CREEPS) || [];
  return hostiles.length > 0;
}

function recordBlockedRoleReason(debug, role, reason) {
  if (!debug || !role || !reason) return;
  if (!debug.arbitration) debug.arbitration = {};
  if (!debug.arbitration.blockedRoleReasons) debug.arbitration.blockedRoleReasons = {};
  debug.arbitration.blockedRoleReasons[role] = reason;
}

function queueItemAllowed(item, arb) {
  if (!item || !arb) return { allowed: true, reason: 'NO_ARB' };
  var role = canonicalRole(item.role);
  var band = roleBand(role);
  var builderException = role === 'Builder' && arb.urgentBacklog && arb.urgentBacklog.builder &&
    arb.recoveryMode && ((arb.roleTotals && arb.roleTotals.Builder) || 0) < 1;
  var repairException = role === 'Repair' && arb.urgentBacklog && arb.urgentBacklog.repair &&
    arb.recoveryMode && ((arb.roleTotals && arb.roleTotals.Repair) || 0) < 1;
  var hasUrgentException = builderException || repairException;

  if (arb.suppressedBands && arb.suppressedBands[band]) {
    if (builderException) return { allowed: true, reason: 'EXCEPTION_CRITICAL_BUILD' };
    if (repairException) return { allowed: true, reason: 'EXCEPTION_CRITICAL_REPAIR' };
    return { allowed: false, reason: 'BAND_SUPPRESSED_' + band };
  }
  if (arb.unmetSurvivalFloors && arb.unmetSurvivalFloors.length > 0 && !FLOOR_ROLE_SET[role]) {
    if (hasUrgentException) {
      return builderException
        ? { allowed: true, reason: 'EXCEPTION_CRITICAL_BUILD' }
        : { allowed: true, reason: 'EXCEPTION_CRITICAL_REPAIR' };
    }
    return { allowed: false, reason: 'WAITING_ON_SURVIVAL' };
  }
  if (arb.unmetEconomyFloors && arb.unmetEconomyFloors.length > 0) {
    if (role !== 'Upgrader' && !FLOOR_ROLE_SET[role]) {
      return { allowed: false, reason: 'WAITING_ON_ECONOMY' };
    }
  }
  if (arb.recoveryMode && (band === 'SITUATIONAL' || band === 'SUPPORT' || band === 'GROWTH')) {
    if ((role === 'Builder' || role === 'Scout') && (!arb.unmetSurvivalFloors || !arb.unmetSurvivalFloors.length)) {
      var age = Math.max(0, Game.time - (item.created || Game.time));
      var threshold = role === 'Builder' ? BUILDER_STARVATION_TICKS : SCOUT_STARVATION_TICKS;
      var total = (arb.roleTotals && typeof arb.roleTotals[role] === 'number') ? arb.roleTotals[role] : 0;
      if (total <= 0 && age >= threshold && (arb.energyAvailable || 0) >= minEnergyFor(role)) {
        return { allowed: true, reason: 'EXCEPTION_SUPPORT_ANTI_STARVATION' };
      }
    }
    if (hasUrgentException) {
      return builderException
        ? { allowed: true, reason: 'EXCEPTION_CRITICAL_BUILD' }
        : { allowed: true, reason: 'EXCEPTION_CRITICAL_REPAIR' };
    }
    return { allowed: false, reason: 'RECOVERY_SUPPRESS_' + band };
  }
  // Stage-3 budget guardrails: prevent lower bands from monopolizing
  // recent spawn history during recovery.
  if (budgetBlocksRole(arb, role, band, hasUrgentException)) {
    return { allowed: false, reason: 'BUDGET_BLOCK_' + band };
  }
  return { allowed: true, reason: 'ALLOWED' };
}

// ------------------------------ Spawn Queue ------------------------------
function ensureRoomQueue(roomName) {
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
  if (!Array.isArray(Memory.rooms[roomName].spawnQueue)) {
    Memory.rooms[roomName].spawnQueue = [];
  }
  return Memory.rooms[roomName].spawnQueue;
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

function getQueuedRoleItems(roomName, roleName) {
  var q = ensureRoomQueue(roomName);
  var target = canonicalRole(roleName);
  var items = [];
  for (var i = 0; i < q.length; i++) {
    var it = q[i];
    if (!it || !it.role) continue;
    if (canonicalRole(it.role) !== target) continue;
    items.push(it);
  }
  return items;
}

function countRoleInRoom(C, roomName, roleName) {
  if (!C || !C.creeps || !roomName || !roleName) return 0;
  var target = canonicalRole(roleName);
  if (!target) return 0;
  var count = 0;
  for (var i = 0; i < C.creeps.length; i++) {
    var creep = C.creeps[i];
    if (!creep || !creep.my || !creep.room || creep.room.name !== roomName) continue;
    var ttl = creep.ticksToLive;
    if (typeof ttl === 'number' && ttl <= DYING_SOON_TTL) continue;
    var role = creep.memory && (creep.memory.role || creep.memory.task);
    if (canonicalRole(role) === target) count += 1;
  }
  return count;
}

function countWorkParts(body) {
  if (!body || !body.length) return 0;
  var work = 0;
  for (var i = 0; i < body.length; i++) {
    var part = body[i];
    var partType = part && part.type ? part.type : part;
    if (partType === WORK) work += 1;
  }
  return work;
}

function creepWorkParts(creep) {
  if (!creep) return 0;
  if (typeof creep.getActiveBodyparts === 'function') {
    return creep.getActiveBodyparts(WORK);
  }
  return countWorkParts(creep.body || []);
}

function getBaseHarvestLiveWork(C, roomName) {
  if (!C || !C.creeps || !roomName) return 0;
  var total = 0;
  for (var i = 0; i < C.creeps.length; i++) {
    var creep = C.creeps[i];
    if (!creep || !creep.my || !creep.room || creep.room.name !== roomName) continue;
    var ttl = creep.ticksToLive;
    if (typeof ttl === 'number' && ttl <= DYING_SOON_TTL) continue;
    var role = creep.memory && (creep.memory.role || creep.memory.task);
    if (canonicalRole(role) !== 'BaseHarvest') continue;
    total += creepWorkParts(creep);
  }
  return total;
}

function getPlannedBaseHarvestBody(roomName) {
  var room = Game.rooms[roomName];
  var energy = room ? (room.energyAvailable || 0) : 0;
  var body = null;
  if (spawnLogic && typeof spawnLogic.getBodyForRole === 'function') {
    body = spawnLogic.getBodyForRole('BaseHarvest', energy);
  }
  if (!body || !body.length) {
    var cfg = spawnLogic && spawnLogic.ROLE_CONFIGS && spawnLogic.ROLE_CONFIGS.BaseHarvest;
    if (cfg && cfg.length) body = cfg[cfg.length - 1];
  }
  return body || [];
}

function getBaseHarvestQueuedWork(roomName) {
  var items = getQueuedRoleItems(roomName, 'BaseHarvest');
  if (!items.length) return 0;
  var body = getPlannedBaseHarvestBody(roomName);
  var perCreepWork = Math.max(1, countWorkParts(body));
  return items.length * perCreepWork;
}

function countCoveredSourcesByMiner(C, room) {
  if (!C || !C.creeps || !room) return 0;
  var covered = Object.create(null);
  for (var i = 0; i < C.creeps.length; i++) {
    var creep = C.creeps[i];
    if (!creep || !creep.my || !creep.room || creep.room.name !== room.name) continue;
    var ttl = creep.ticksToLive;
    if (typeof ttl === 'number' && ttl <= DYING_SOON_TTL) continue;
    var role = creep.memory && (creep.memory.role || creep.memory.task);
    if (canonicalRole(role) !== 'BaseHarvest') continue;
    var sid = creep.memory && creep.memory.assignedSource;
    if (!sid) continue;
    covered[sid] = true;
  }
  return Object.keys(covered).length;
}

function computeBaseHarvestWorkTarget(room, C) {
  if (!room) return 0;
  var sources = room.find(FIND_SOURCES);
  var sourceCount = sources ? sources.length : 0;
  if (sourceCount <= 0) return 0;

  // Baseline saturation math for normal home sources: 5 WORK each.
  var target = sourceCount * 5;

  // Simple, stable uptime buffer:
  // without collectors, miners lose time offloading instead of pure harvesting.
  var collectorCount = countRoleInRoom(C, room.name, 'Courier') + countRoleInRoom(C, room.name, 'Queen');
  if (collectorCount <= 0) {
    target += sourceCount;
  }

  // If source containers are not built yet, add a tiny buffer for movement churn.
  var missingContainers = 0;
  for (var i = 0; i < sourceCount; i++) {
    var containers = sources[i].pos.findInRange(FIND_STRUCTURES, 1, {
      filter: function (s) { return s.structureType === STRUCTURE_CONTAINER; }
    });
    if (!containers || !containers.length) {
      missingContainers += 1;
    }
  }
  target += missingContainers;

  return target;
}


function collectBaseHarvestSourceState(C, roomName, sources) {
  var state = { liveBySource: Object.create(null), lowTtlBySource: Object.create(null), unassignedLive: 0, sourceIds: [] };
  for (var i = 0; i < sources.length; i++) {
    var sid = sources[i] && sources[i].id;
    if (sid) state.sourceIds.push(sid);
  }
  if (!C || !C.creeps) return state;
  for (var j = 0; j < C.creeps.length; j++) {
    var creep = C.creeps[j];
    if (!creep || !creep.my || !creep.room || creep.room.name !== roomName) continue;
    var role = creep.memory && (creep.memory.role || creep.memory.task);
    if (canonicalRole(role) !== 'BaseHarvest') continue;
    var sidLive = creep.memory && creep.memory.assignedSource;
    if (sidLive) {
      state.liveBySource[sidLive] = (state.liveBySource[sidLive] || 0) + 1;
      var ttl = typeof creep.ticksToLive === 'number' ? creep.ticksToLive : null;
      if (ttl !== null && ttl > 0 && ttl <= DYING_SOON_TTL) state.lowTtlBySource[sidLive] = true;
    } else {
      state.unassignedLive += 1;
    }
  }
  return state;
}

function countQueuedOrSpawningSourceReplacement(roomName, sourceId) {
  var q = ensureRoomQueue(roomName);
  var count = 0;
  for (var i = 0; i < q.length; i++) {
    var it = q[i];
    if (!it || canonicalRole(it.role) !== 'BaseHarvest') continue;
    if ((it.assignedSource || null) === sourceId) count += 1;
  }
  var room = Game.rooms[roomName];
  if (room) {
    var spawns = room.find(FIND_MY_SPAWNS) || [];
    for (var s = 0; s < spawns.length; s++) {
      var spawning = spawns[s].spawning;
      if (!spawning) continue;
      var c = Game.creeps[spawning.name];
      if (!c || !c.memory) continue;
      if (canonicalRole(c.memory.role || c.memory.task) !== 'BaseHarvest') continue;
      if ((c.memory.assignedSource || null) === sourceId) count += 1;
    }
  }
  return count;
}

function summarizeBaseHarvestQueueState(roomName) {
  var q = ensureRoomQueue(roomName);
  var queuedTotal = 0;
  var queuedBySource = Object.create(null);
  for (var i = 0; i < q.length; i++) {
    var it = q[i];
    if (!it || canonicalRole(it.role) !== 'BaseHarvest') continue;
    queuedTotal += 1;
    if (!it.assignedSource) continue;
    queuedBySource[it.assignedSource] = (queuedBySource[it.assignedSource] || 0) + 1;
  }
  var spawningTotal = 0;
  var spawningBySource = Object.create(null);
  var room = Game.rooms[roomName];
  if (room) {
    var spawns = room.find(FIND_MY_SPAWNS) || [];
    for (var s = 0; s < spawns.length; s++) {
      var spawning = spawns[s].spawning;
      if (!spawning) continue;
      var c = Game.creeps[spawning.name];
      if (!c || canonicalRole(c.memory && (c.memory.role || c.memory.task)) !== 'BaseHarvest') continue;
      spawningTotal += 1;
      if (!c.memory || !c.memory.assignedSource) continue;
      spawningBySource[c.memory.assignedSource] = (spawningBySource[c.memory.assignedSource] || 0) + 1;
    }
  }
  return { queuedTotal: queuedTotal, spawningTotal: spawningTotal, queuedBySource: queuedBySource, spawningBySource: spawningBySource };
}

function computeBaseHarvestQuotaDynamic(C, room) {
  if (!room) return 0;
  var sources = room.find(FIND_SOURCES);
  var sourceCount = sources ? sources.length : 0;
  if (sourceCount <= 0) return 0;

  var state = collectBaseHarvestSourceState(C, room.name, sources);
  var replacementNeeded = 0;
  for (var i = 0; i < state.sourceIds.length; i++) {
    var sid = state.sourceIds[i];
    if (!state.lowTtlBySource[sid]) continue;
    if (countQueuedOrSpawningSourceReplacement(room.name, sid) > 0) continue;
    replacementNeeded += 1;
  }

  var quota = sourceCount + Math.min(1, replacementNeeded);
  var maxWithOverlap = sourceCount + 1;
  if (quota > maxWithOverlap) quota = maxWithOverlap;

  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};
  if (!Memory.rooms[room.name].spawnDebug) Memory.rooms[room.name].spawnDebug = {};
  var queueSummary = summarizeBaseHarvestQueueState(room.name);
  var liveTotal = getRoomLocalLiveCount(C, room.name, 'BaseHarvest');
  var plannedTotal = liveTotal + queueSummary.queuedTotal + queueSummary.spawningTotal;
  Memory.rooms[room.name].spawnDebug.baseHarvest = {
    sourceCount: sourceCount,
    sourceIds: state.sourceIds.slice(),
    perSourceLive: state.liveBySource,
    unassignedLive: state.unassignedLive,
    lowTtlSources: Object.keys(state.lowTtlBySource),
    liveTotal: liveTotal,
    queuedTotal: queueSummary.queuedTotal,
    spawningTotal: queueSummary.spawningTotal,
    plannedTotal: plannedTotal,
    allowedCap: quota,
    overCap: plannedTotal > quota,
    suppressedReasons: [],
    queuedBySource: queueSummary.queuedBySource,
    spawningBySource: queueSummary.spawningBySource,
    queuedReasons: [],
    replacementNeeded: replacementNeeded,
    quota: quota
  };

  return Math.max(0, quota);
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
    role: canonicalRole(role),
    home: roomName,
    created: Game.time,
    priority: rolePriority(role),
    retryAt: 0
  };
  var seq = Memory.__spawnQueueSeq || 0;
  item.id = item.id || (String(Game.time) + ':' + String(item.role) + ':' + String(seq));
  Memory.__spawnQueueSeq = seq + 1;
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
    remaining[canonical] = Math.max(0, (quotas[role] || 0) - active);
  }

  var room = Game.rooms[roomName];
  var sourceCount = 0;
  if (room && typeof room.find === 'function') sourceCount = (room.find(FIND_SOURCES) || []).length;
  var baseHarvestCap = quotas && typeof quotas.BaseHarvest === 'number' ? quotas.BaseHarvest : sourceCount;
  var baseHarvestLive = getRoomLocalLiveCount(C, roomName, 'BaseHarvest');
  var baseHarvestSpawning = summarizeBaseHarvestQueueState(roomName).spawningTotal || 0;
  var kept = [];
  var used = Object.create(null);
  var keptBaseHarvest = 0;
  for (var j = 0; j < q.length; j++) {
    var it = q[j];
    if (!it) continue;
    if (!it.role) continue;
    var canonicalItemRole = canonicalRole(it.role);
    if (!canonicalItemRole) continue;
    it.role = canonicalItemRole;
    var left = remaining[canonicalItemRole] || 0;
    var usedSoFar = used[canonicalItemRole] || 0;
    if (canonicalItemRole === "BaseHarvest" && (baseHarvestLive + baseHarvestSpawning + keptBaseHarvest) >= baseHarvestCap) continue;
    if (canonicalItemRole === "BaseHarvest" && it.assignedSource) {
      var liveForSource = 0;
      var lowTtlIncumbent = false;
      if (C && C.creeps) {
        for (var ci = 0; ci < C.creeps.length; ci++) {
          var c = C.creeps[ci];
          if (!c || !c.my || !c.room || c.room.name !== roomName) continue;
          if (canonicalRole(c.memory && (c.memory.role || c.memory.task)) !== "BaseHarvest") continue;
          if ((c.memory && c.memory.assignedSource) === it.assignedSource) {
            liveForSource += 1;
            var ttl = typeof c.ticksToLive === 'number' ? c.ticksToLive : null;
            if (ttl !== null && ttl > 0 && ttl <= DYING_SOON_TTL) lowTtlIncumbent = true;
          }
        }
      }
      var allowHandoff = liveForSource > 0;
      if (!allowHandoff || !lowTtlIncumbent) continue;
      if (countQueuedOrSpawningSourceReplacement(roomName, it.assignedSource) > 1) continue;
      if (usedSoFar >= Math.max(left, 1)) continue;
      kept.push(it);
      keptBaseHarvest += 1;
      used[canonicalItemRole] = usedSoFar + 1;
      continue;
    }
    if (usedSoFar < left) {
      kept.push(it);
      if (canonicalItemRole === "BaseHarvest") keptBaseHarvest += 1;
      used[canonicalItemRole] = usedSoFar + 1;
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
  var need = (local + remoteTotal) > 0 ? 1 : 0;
  if (tickEvery(DBG_EVERY)) {
    dlog('🧱 [Signal] builderNeed', fmt(room), 'local=', local, 'remote=', remoteTotal, '->', need);
  }
  return need;
}

function getRepairBacklog(room) {
  if (!room || !Memory.rooms || !Memory.rooms[room.name]) return 0;
  var list = Memory.rooms[room.name].repairTargets;
  if (!Array.isArray(list)) return 0;
  return list.length;
}

function getRepairWorkloadSummary(room) {
  if (!room || !Memory.rooms || !Memory.rooms[room.name]) return null;
  var maint = Memory.rooms[room.name]._maint;
  if (!maint || !maint.repairWorkload) return null;
  return maint.repairWorkload;
}

function countCriticalBuildBacklog(room) {
  if (!room || typeof room.find !== 'function') return 0;
  var sites = room.find(FIND_CONSTRUCTION_SITES) || [];
  var count = 0;
  for (var i = 0; i < sites.length; i++) {
    var t = sites[i].structureType;
    if (t === STRUCTURE_SPAWN || t === STRUCTURE_EXTENSION || t === STRUCTURE_TOWER) {
      count += 1;
    }
  }
  return count;
}

function countCriticalRepairBacklog(room) {
  if (!room || !Memory.rooms || !Memory.rooms[room.name]) return 0;
  var list = Memory.rooms[room.name].repairTargets;
  if (!Array.isArray(list)) return 0;
  var count = 0;
  for (var i = 0; i < list.length; i++) {
    var entry = list[i];
    if (!entry || !entry.type) continue;
    if (entry.type === STRUCTURE_SPAWN ||
        entry.type === STRUCTURE_EXTENSION ||
        entry.type === STRUCTURE_TOWER ||
        entry.type === STRUCTURE_CONTAINER) {
      count += 1;
    }
  }
  return count;
}

function summarizeCriticalRepairCount(workload, fallbackCriticalCount) {
  if (!workload || !workload.categories) return fallbackCriticalCount || 0;
  var critical = (workload.categories.critical && workload.categories.critical.count) || 0;
  var emergency = workload.emergencyCriticalCount || 0;
  return critical + emergency;
}

function computeNonCombatPlan(C, room, debug) {
  var maturity = classifyRoomMaturity(room);
  var economy = classifyEconomyState(room, maturity);
  var localSites = C.roomSiteCounts[room.name] || 0;
  var remotes = C.remotesByHome[room.name] || [];
  var remoteCount = remotes.length;
  var remoteSites = 0;
  for (var i = 0; i < remotes.length; i++) {
    remoteSites += (C.roomSiteCounts[remotes[i]] || 0);
  }
  var totalSites = localSites + remoteSites;
  var repairBacklogRaw = getRepairBacklog(room);
  var repairWorkload = getRepairWorkloadSummary(room);
  var repairBacklog = repairWorkload && typeof repairWorkload.totalCount === 'number'
    ? repairWorkload.totalCount
    : repairBacklogRaw;
  var criticalBuildBacklog = countCriticalBuildBacklog(room);
  var criticalRepairBacklogRaw = countCriticalRepairBacklog(room);
  var criticalRepairBacklog = summarizeCriticalRepairCount(repairWorkload, criticalRepairBacklogRaw);
  var repairMeaningfulScore = repairWorkload && typeof repairWorkload.meaningfulScore === 'number'
    ? repairWorkload.meaningfulScore
    : repairBacklog;
  var repairRoadNetwork = repairWorkload && repairWorkload.roadNetwork
    ? repairWorkload.roadNetwork
    : null;
  var lunaSignal = determineLunaQuota(C, room);
  var lunaDesired = lunaSignal.desired;
  var buildBucket = buildBacklogBucket(totalSites, criticalBuildBacklog);
  var repairBucket = repairBacklogBucket(repairBacklog, criticalRepairBacklog);
  var repairDemandReason = 'REPAIR_BUCKET_' + repairBucket;
  if (repairWorkload && repairWorkload.emergencyCriticalCount > 0) {
    repairDemandReason = 'REPAIR_EMERGENCY_CRITICAL';
  } else if (repairMeaningfulScore >= 4) {
    repairDemandReason = 'REPAIR_MEANINGFUL_PRESSURE_HIGH';
  } else if (repairMeaningfulScore >= 2) {
    repairDemandReason = 'REPAIR_MEANINGFUL_PRESSURE_MED';
  } else if (repairMeaningfulScore > 0) {
    repairDemandReason = 'REPAIR_MEANINGFUL_PRESSURE_LOW';
  }
  var recoveryBias = (economy === 'CRITICAL') ||
    ((economy === 'STRAINED') && (criticalBuildBacklog > 0 || criticalRepairBacklog > 0));

  var desired = {
    Courier: 2,
    Queen: 1,
    Upgrader: 1,
    Builder: 0,
    Scout: 1,
    Luna: lunaDesired,
    Repair: 0,
    Trucker: 0,
    Claimer: 0
  };

  var demandClampReasons = {};
  var plannerAdjustments = {
    demand: { Courier: 0, Builder: 0, Repair: 0, Luna: 0, Upgrader: 0 },
    bodyBias: { Courier: 0, Builder: 0, Repair: 0, Luna: 0, Upgrader: 0 },
    basis: { Courier: 'NONE', Builder: 'NONE', Repair: 'NONE', Luna: 'NONE', Upgrader: 'NONE' },
    reasons: []
  };

  if (economy === 'CRITICAL') {
    desired.Courier = (remoteCount > 0) ? 2 : 1;
    desired.Upgrader = 0;
    // Keep at least one upgrader before mature economy infrastructure exists.
    // Without this guard, rooms that classify as CRITICAL pre-storage can
    // become permanently stuck with zero upgrade throughput.
    if (!room.storage && !room.terminal) {
      desired.Upgrader = 1;
      demandClampReasons.UpgraderBootstrap = 'CRITICAL_BOOTSTRAP_KEEP_ONE';
    }
    desired.Builder = (buildBucket === 'CRITICAL' || buildBucket === 'HIGH' || buildBucket === 'MEDIUM') ? 1 : 0;
    desired.Repair = (repairBucket === 'CRITICAL') ? 1 : 0;
    desired.Luna = Math.min(lunaDesired, remoteCount > 0 ? 1 : 0);
    demandClampReasons.Courier = 'CRITICAL_KEEP_SMALL_FAST';
    demandClampReasons.Upgrader = 'CRITICAL_CONSERVE';
    demandClampReasons.Builder = 'CRITICAL_BUILD_BOUND';
    demandClampReasons.Repair = 'CRITICAL_REPAIR_ONLY';
    demandClampReasons.Luna = 'CRITICAL_REMOTE_BOUND';
  } else if (economy === 'STRAINED') {
    desired.Courier = (maturity === 'EARLY') ? 1 : 2;
    if (remoteCount >= 2) desired.Courier += 1;
    desired.Courier = clampInt(desired.Courier, 1, 3);
    desired.Upgrader = 1;
    desired.Builder = (buildBucket === 'CRITICAL' || buildBucket === 'HIGH') ? 2 : (buildBucket === 'MEDIUM' ? 1 : 0);
    desired.Repair = (repairBucket === 'CRITICAL' || repairBucket === 'HIGH') ? 1 : 0;
    desired.Luna = Math.min(lunaDesired, Math.max(1, remoteCount));
    demandClampReasons.Courier = 'STRAINED_REMOTE_AWARE';
    demandClampReasons.Builder = 'STRAINED_BUILD_BOUND';
    demandClampReasons.Repair = 'STRAINED_REPAIR_BOUND';
    demandClampReasons.Upgrader = 'STRAINED_KEEP_ONE';
    demandClampReasons.Luna = 'STRAINED_REMOTE_CLAMP';
  } else if (economy === 'HEALTHY') {
    desired.Courier = (maturity === 'LATE' || maturity === 'ENDGAME') ? 3 : 2;
    if (remoteCount >= 2) desired.Courier += 1;
    desired.Courier = clampInt(desired.Courier, 2, 4);
    desired.Upgrader = (maturity === 'EARLY') ? 1 : 2;
    desired.Builder = (buildBucket === 'CRITICAL') ? 3 : (buildBucket === 'HIGH' ? 2 : (buildBucket === 'MEDIUM' ? 1 : 0));
    desired.Repair = (repairBucket === 'CRITICAL') ? 2 : (repairBucket === 'HIGH' || repairBucket === 'MEDIUM' ? 1 : 0);
    desired.Luna = Math.min(lunaDesired, Math.max(1, remoteCount * 2));
    demandClampReasons.Courier = 'HEALTHY_REMOTE_SCALE';
    demandClampReasons.Builder = 'HEALTHY_BACKLOG_SCALE';
    demandClampReasons.Repair = 'HEALTHY_REPAIR_SCALE';
    demandClampReasons.Upgrader = 'HEALTHY_PROGRESS';
    demandClampReasons.Luna = 'HEALTHY_REMOTE_SCALE';
  } else {
    desired.Courier = (maturity === 'LATE' || maturity === 'ENDGAME') ? 4 : 3;
    if (remoteCount >= 2) desired.Courier += 1;
    desired.Courier = clampInt(desired.Courier, 2, 5);
    desired.Upgrader = (maturity === 'ENDGAME') ? 2 : 3;
    desired.Builder = (buildBucket === 'CRITICAL') ? 3 : (buildBucket === 'HIGH' ? 2 : (buildBucket === 'MEDIUM' ? 1 : 0));
    desired.Repair = (repairBucket === 'CRITICAL') ? 2 : (repairBucket === 'HIGH' || repairBucket === 'MEDIUM' ? 1 : 0);
    desired.Luna = Math.min(lunaDesired, Math.max(1, remoteCount * 2));
    demandClampReasons.Courier = 'RICH_FULLER_LOGISTICS';
    demandClampReasons.Builder = 'RICH_BACKLOG_SCALE';
    demandClampReasons.Repair = 'RICH_REPAIR_SCALE';
    demandClampReasons.Upgrader = 'RICH_PROGRESS';
    demandClampReasons.Luna = 'RICH_REMOTE_SCALE';
  }

  if (repairWorkload && repairWorkload.emergencyCriticalCount > 0) {
    desired.Repair = Math.max(desired.Repair, 1);
    demandClampReasons.RepairEmergency = 'REPAIR_EMERGENCY_FLOOR';
  }

  // Recovery-bias guardrail: keep optional non-protected growth roles bounded.
  if (recoveryBias) {
    desired.Builder = Math.min(desired.Builder, criticalBuildBacklog > 0 ? 1 : 0);
    desired.Repair = Math.min(desired.Repair, criticalRepairBacklog > 0 ? 1 : 0);
    desired.Upgrader = Math.min(desired.Upgrader, 1);
    desired.Courier = Math.max(1, Math.min(desired.Courier, 2));
    desired.Luna = Math.min(desired.Luna, remoteCount > 0 ? 1 : 0);
    demandClampReasons.recoveryBias = 'RECOVERY_BIAS_CLAMP';
  }

  // Stage-5 bounded feedback loop:
  // observe simple per-role proxy output and apply tiny clamped nudges.
  var feedback = ensureFeedbackState(debug || ensureSpawnDebug(room.name));
  var prev = feedback.lastSignals;
  var cap = room.energyCapacityAvailable || 0;
  var avail = room.energyAvailable || 0;
  var missingEnergy = Math.max(0, cap - avail);
  var controllerLevel = room.controller && room.controller.level ? room.controller.level : 0;
  var controllerProgress = room.controller && typeof room.controller.progress === 'number' ? room.controller.progress : 0;
  var currentSignals = {
    tick: Game.time,
    totalSites: totalSites,
    repairBacklog: repairBacklog,
    repairBacklogRaw: repairBacklogRaw,
    repairMeaningfulScore: repairMeaningfulScore,
    repairDemandReason: repairDemandReason,
    repairRoadsSeen: repairRoadNetwork ? (repairRoadNetwork.damagedSeen || 0) : 0,
    repairRoadsPlannedAccepted: repairRoadNetwork ? (repairRoadNetwork.plannedAccepted || 0) : 0,
    repairRoadsUnplannedRejected: repairRoadNetwork ? (repairRoadNetwork.unplannedRejected || 0) : 0,
    missingEnergy: missingEnergy,
    controllerLevel: controllerLevel,
    controllerProgress: controllerProgress
  };

  var courierOutput = 0;
  var builderOutput = 0;
  var repairOutput = 0;
  var upgraderOutput = 0;
  if (prev) {
    courierOutput = Math.max(0, (prev.missingEnergy || 0) - missingEnergy);
    builderOutput = Math.max(0, (prev.totalSites || 0) - totalSites);
    repairOutput = Math.max(0, (prev.repairBacklog || 0) - repairBacklog);
    if (prev.controllerLevel === controllerLevel) {
      upgraderOutput = Math.max(0, controllerProgress - (prev.controllerProgress || 0));
    } else if (controllerLevel > prev.controllerLevel) {
      upgraderOutput = 1000; // bounded proxy reward for level-up tick.
    }
  }
  var courierCount = C.roleCounts.Courier || 0;
  var builderCount = C.roleCounts.Builder || 0;
  var repairCount = C.roleCounts.Repair || 0;
  var upgraderCount = C.roleCounts.Upgrader || 0;
  var lunaCount = (C.lunaCountsByHome && C.lunaCountsByHome[room.name]) || 0;
  var actionCounts = collectRoleActionCounts(C, room);

  var fr = feedback.roles;
  fr.Courier.emaOutput = emaUpdate(fr.Courier.emaOutput, courierOutput, FEEDBACK_ALPHA);
  fr.Builder.emaOutput = emaUpdate(fr.Builder.emaOutput, builderOutput, FEEDBACK_ALPHA);
  fr.Repair.emaOutput = emaUpdate(fr.Repair.emaOutput, repairOutput, FEEDBACK_ALPHA);
  fr.Upgrader.emaOutput = emaUpdate(fr.Upgrader.emaOutput, upgraderOutput, FEEDBACK_ALPHA);
  fr.Luna.emaOutput = emaUpdate(fr.Luna.emaOutput, lunaSignal.totalSources > 0 ? lunaSignal.activeAssignments / lunaSignal.totalSources : 0, FEEDBACK_ALPHA);
  fr.Courier.emaAction = emaUpdate(fr.Courier.emaAction, actionCounts.Courier, FEEDBACK_ALPHA);
  fr.Builder.emaAction = emaUpdate(fr.Builder.emaAction, actionCounts.Builder, FEEDBACK_ALPHA);
  fr.Repair.emaAction = emaUpdate(fr.Repair.emaAction, actionCounts.Repair, FEEDBACK_ALPHA);
  fr.Upgrader.emaAction = emaUpdate(fr.Upgrader.emaAction, actionCounts.Upgrader, FEEDBACK_ALPHA);
  fr.Luna.emaAction = emaUpdate(fr.Luna.emaAction, actionCounts.Luna, FEEDBACK_ALPHA);

  fr.Courier.emaCount = emaUpdate(fr.Courier.emaCount, courierCount, FEEDBACK_ALPHA);
  fr.Builder.emaCount = emaUpdate(fr.Builder.emaCount, builderCount, FEEDBACK_ALPHA);
  fr.Repair.emaCount = emaUpdate(fr.Repair.emaCount, repairCount, FEEDBACK_ALPHA);
  fr.Upgrader.emaCount = emaUpdate(fr.Upgrader.emaCount, upgraderCount, FEEDBACK_ALPHA);
  fr.Luna.emaCount = emaUpdate(fr.Luna.emaCount, lunaCount, FEEDBACK_ALPHA);

  fr.Courier.emaPerCreep = fr.Courier.emaOutput / Math.max(1, fr.Courier.emaCount);
  fr.Builder.emaPerCreep = fr.Builder.emaOutput / Math.max(1, fr.Builder.emaCount);
  fr.Repair.emaPerCreep = fr.Repair.emaOutput / Math.max(1, fr.Repair.emaCount);
  fr.Upgrader.emaPerCreep = fr.Upgrader.emaOutput / Math.max(1, fr.Upgrader.emaCount);
  fr.Luna.emaPerCreep = fr.Luna.emaOutput / Math.max(1, fr.Luna.emaCount);

  fr.Courier.status = fr.Courier.emaPerCreep < 25 ? 'UNDERPERFORMING' : 'HEALTHY';
  fr.Builder.status = (buildBucket === 'HIGH' || buildBucket === 'CRITICAL') && fr.Builder.emaPerCreep < 0.25
    ? 'UNDERPERFORMING'
    : (buildBucket === 'NONE' && builderCount > 0 ? 'SATURATED' : 'HEALTHY');
  fr.Repair.status = (repairBucket === 'HIGH' || repairBucket === 'CRITICAL') && fr.Repair.emaPerCreep < 0.20
    ? 'UNDERPERFORMING'
    : (repairBucket === 'LOW' && repairCount > 1 ? 'SATURATED' : 'HEALTHY');
  fr.Upgrader.status = (economy === 'CRITICAL' || economy === 'STRAINED') && fr.Upgrader.emaPerCreep < 15
    ? 'UNDERPERFORMING'
    : 'HEALTHY';
  fr.Luna.status = fr.Luna.emaPerCreep < 0.15 ? 'UNDERPERFORMING' : 'HEALTHY';

  function refreshSignalQuality(role, minAction) {
    var rec = fr[role];
    if (!actionCounts.available || actionCounts.samples < 2) {
      rec.signalQuality = 'LOW_SAMPLE';
      rec.signalSource = 'PROXY_ONLY';
      return;
    }
    if (rec.emaAction >= minAction) {
      rec.signalQuality = 'ACTION_CONFIRMED';
      rec.signalSource = 'PROXY_PLUS_ACTION';
      return;
    }
    if (rec.emaPerCreep <= 0) {
      rec.signalQuality = 'WEAK_NOISY';
      rec.signalSource = 'ACTION_WEAK';
      return;
    }
    rec.signalQuality = 'PROXY_DOMINANT';
    rec.signalSource = 'PROXY_PLUS_ACTION';
  }
  refreshSignalQuality('Courier', 0.8);
  refreshSignalQuality('Builder', 0.3);
  refreshSignalQuality('Repair', 0.3);
  refreshSignalQuality('Upgrader', 0.3);
  refreshSignalQuality('Luna', 0.3);

  function markChronic(role, condition) {
    var rec = fr[role];
    rec.chronic = condition ? Math.min(8, (rec.chronic || 0) + 1) : Math.max(0, (rec.chronic || 0) - 1);
    return rec.chronic >= 3;
  }

  var chronicCourier = markChronic('Courier', desired.Courier >= 2 && courierCount >= 1 && fr.Courier.emaPerCreep < 25 &&
    missingEnergy > (cap * 0.35) && fr.Courier.signalQuality !== 'ACTION_CONFIRMED');
  var chronicBuilder = markChronic('Builder', (buildBucket === 'HIGH' || buildBucket === 'CRITICAL') && builderCount > 0 &&
    fr.Builder.emaPerCreep < 0.25 && fr.Builder.signalQuality !== 'ACTION_CONFIRMED');
  var chronicRepair = markChronic('Repair', (repairBucket === 'HIGH' || repairBucket === 'CRITICAL') && repairCount > 0 &&
    fr.Repair.emaPerCreep < 0.20 && fr.Repair.signalQuality !== 'ACTION_CONFIRMED');
  var chronicUpgrader = markChronic('Upgrader', (economy === 'CRITICAL' || economy === 'STRAINED') && upgraderCount > 0 &&
    fr.Upgrader.emaPerCreep < 15 && fr.Upgrader.signalQuality !== 'ACTION_CONFIRMED');
  var lunaROI = computeLunaRemoteROI(room, lunaSignal, economy, fr.Luna);
  var chronicLuna = markChronic('Luna', lunaSignal.desired > 0 && lunaCount > 0 &&
    (lunaROI.bucket === 'POOR' || fr.Luna.emaPerCreep < 0.15) && fr.Luna.signalQuality !== 'ACTION_CONFIRMED');

  var tuningHints = [];
  if (!actionCounts.available || actionCounts.samples < 2) {
    tuningHints.push('Action signal low-sample; planner currently proxy-dominant.');
  }
  if (chronicCourier) {
    desired.Courier = clampInt(desired.Courier + 1, 1, 5);
    plannerAdjustments.demand.Courier = 1;
    plannerAdjustments.bodyBias.Courier = -1;
    plannerAdjustments.basis.Courier = fr.Courier.signalSource;
    plannerAdjustments.reasons.push('COURIER_CHRONIC_THROUGHPUT');
    tuningHints.push('Courier appears underperforming; nudging count +1 and fuller body tier.');
  }
  if (chronicBuilder && !recoveryBias && economy !== 'CRITICAL') {
    desired.Builder = clampInt(desired.Builder + 1, 0, 3);
    plannerAdjustments.demand.Builder = 1;
    plannerAdjustments.bodyBias.Builder = -1;
    plannerAdjustments.basis.Builder = fr.Builder.signalSource;
    plannerAdjustments.reasons.push('BUILDER_BACKLOG_PERSIST');
    tuningHints.push('Builder backlog not clearing; nudging builder demand/body up within cap.');
  }
  if (chronicRepair && !recoveryBias && economy !== 'CRITICAL') {
    desired.Repair = clampInt(desired.Repair + 1, 0, 2);
    plannerAdjustments.demand.Repair = 1;
    plannerAdjustments.bodyBias.Repair = -1;
    plannerAdjustments.basis.Repair = fr.Repair.signalSource;
    plannerAdjustments.reasons.push('REPAIR_BACKLOG_PERSIST');
    tuningHints.push('Repair backlog remains high; nudging repair demand/body up within cap.');
  }
  if (chronicUpgrader && (economy === 'CRITICAL' || economy === 'STRAINED')) {
    desired.Upgrader = clampInt(desired.Upgrader - 1, 0, 3);
    plannerAdjustments.demand.Upgrader = -1;
    plannerAdjustments.bodyBias.Upgrader = 1;
    plannerAdjustments.basis.Upgrader = fr.Upgrader.signalSource;
    plannerAdjustments.reasons.push('UPGRADER_WEAK_ROI');
    tuningHints.push('Upgrader ROI weak in low economy; nudging demand/body down.');
  }
  if (lunaROI.bucket === 'POOR' || chronicLuna) {
    desired.Luna = clampInt(desired.Luna - 1, 0, Math.max(0, lunaSignal.desired));
    plannerAdjustments.demand.Luna = -1;
    plannerAdjustments.bodyBias.Luna = 1;
    plannerAdjustments.basis.Luna = fr.Luna.signalSource;
    plannerAdjustments.reasons.push('LUNA_POOR_REMOTE_ROI');
    tuningHints.push('Remote ROI poor; reducing Luna enthusiasm slightly.');
  } else if (lunaROI.bucket === 'GOOD' && !recoveryBias && (economy === 'HEALTHY' || economy === 'RICH')) {
    desired.Luna = clampInt(desired.Luna + 1, 0, Math.max(0, lunaSignal.desired + 1));
    plannerAdjustments.demand.Luna = 1;
    plannerAdjustments.bodyBias.Luna = -1;
    plannerAdjustments.basis.Luna = fr.Luna.signalSource;
    plannerAdjustments.reasons.push('LUNA_GOOD_REMOTE_ROI');
    tuningHints.push('Remote ROI good; allowing slight Luna boost.');
  }

  // Re-apply hard safety clamps after feedback nudge.
  if (recoveryBias) {
    desired.Builder = Math.min(desired.Builder, criticalBuildBacklog > 0 ? 1 : 0);
    desired.Repair = Math.min(desired.Repair, criticalRepairBacklog > 0 ? 1 : 0);
    desired.Upgrader = Math.min(desired.Upgrader, 1);
    desired.Courier = Math.max(1, Math.min(desired.Courier, 2));
    desired.Luna = Math.min(desired.Luna, remoteCount > 0 ? 1 : 0);
  }

  feedback.lastSignals = currentSignals;
  feedback.chronic = {
    Courier: chronicCourier,
    Builder: chronicBuilder,
    Repair: chronicRepair,
    Upgrader: chronicUpgrader,
    Luna: chronicLuna
  };
  fr.Courier.bias = plannerAdjustments.demand.Courier;
  fr.Builder.bias = plannerAdjustments.demand.Builder;
  fr.Repair.bias = plannerAdjustments.demand.Repair;
  fr.Upgrader.bias = plannerAdjustments.demand.Upgrader;
  fr.Luna.bias = plannerAdjustments.demand.Luna;
  feedback.adjustments = plannerAdjustments;
  feedback.tuningHints = tuningHints;
  feedback.lunaROI = lunaROI;

  // Queen stays simple by design; very light-touch efficiency bump in rich mature rooms.
  if (economy === 'RICH' && (maturity === 'LATE' || maturity === 'ENDGAME') && remoteCount >= 2) {
    desired.Queen = 2;
    demandClampReasons.Queen = 'RICH_REMOTE_BUFFER';
  } else {
    desired.Queen = 1;
    demandClampReasons.Queen = 'QUEEN_BASELINE';
  }

  // Keep Scout intentionally simple for Stage-1 (lightweight visibility role).
  desired.Scout = 1;

  var reasons = {
    Builder: buildBucket === 'NONE' ? 'NO_BACKLOG' : ('BUILD_' + buildBucket + '_' + totalSites),
    Repair: repairBucket === 'NONE' ? 'REPAIR_LOW_PRIORITY' : ('REPAIR_' + repairBucket + '_' + repairBacklog + '_' + repairDemandReason),
    Upgrader: 'ECON_' + economy,
    Luna: lunaDesired > 0 ? ('REMOTE_' + lunaDesired) : 'REMOTE_DISABLED',
    Courier: 'REMOTE_' + remoteCount + '_ECON_' + economy,
    Queen: demandClampReasons.Queen || 'QUEEN_BASELINE'
  };

  var bodyGuidance = {};
  var tunedRoles = ['Courier', 'Builder', 'Repair', 'Upgrader', 'Luna', 'Queen'];
  for (var r = 0; r < tunedRoles.length; r++) {
    var role = tunedRoles[r];
    var guided = roleBodyGuidance(role, {
      maturity: maturity,
      economyState: economy,
      recoveryBias: recoveryBias,
      signals: {
        remoteCount: remoteCount,
        buildBacklogBucket: buildBucket,
        repairBacklogBucket: repairBucket
      }
    });
    var bodyBias = plannerAdjustments && plannerAdjustments.bodyBias && typeof plannerAdjustments.bodyBias[role] === 'number'
      ? plannerAdjustments.bodyBias[role]
      : 0;
    var adjustedCap = clampInt(guided.capIndex + bodyBias, 0, 5);
    bodyGuidance[role] = {
      capIndex: adjustedCap,
      reason: guided.reason + (bodyBias !== 0 ? ('|FEEDBACK_BIAS_' + bodyBias) : '|FEEDBACK_BIAS_0')
    };
  };

  return {
    desired: desired,
    economyState: economy,
    maturity: maturity,
    signals: {
      localSites: localSites,
      remoteSites: remoteSites,
      remoteCount: remoteCount,
      lunaDesiredRaw: lunaSignal.rawDesired,
      lunaSources: lunaSignal.totalSources,
      lunaActiveAssignments: lunaSignal.activeAssignments,
      repairBacklog: repairBacklog,
      criticalBuildBacklog: criticalBuildBacklog,
      criticalRepairBacklog: criticalRepairBacklog,
      criticalRepairBacklogRaw: criticalRepairBacklogRaw,
      buildBacklogBucket: buildBucket,
      repairBacklogBucket: repairBucket,
      repairWorkload: repairWorkload,
      repairMeaningfulScore: repairMeaningfulScore,
      repairDemandReason: repairDemandReason,
      repairRoadNetwork: repairRoadNetwork ? {
        damagedSeen: repairRoadNetwork.damagedSeen || 0,
        plannedAccepted: repairRoadNetwork.plannedAccepted || 0,
        unplannedRejected: repairRoadNetwork.unplannedRejected || 0,
        remotePlannedAccepted: repairRoadNetwork.remotePlannedAccepted || 0,
        remoteUnplannedRejected: repairRoadNetwork.remoteUnplannedRejected || 0,
        excludedReasons: repairRoadNetwork.excludedReasons || {}
      } : null
    },
    recoveryBias: recoveryBias,
    demandClampReasons: demandClampReasons,
    plannerAdjustments: plannerAdjustments,
    feedbackSummary: {
      roles: feedback.roles,
      chronic: feedback.chronic,
      actionMetrics: {
        Courier: 'EVENT_TRANSFER_AMOUNT_PROXY',
        Builder: 'EVENT_BUILD_COUNT',
        Repair: 'EVENT_REPAIR_COUNT',
        Luna: 'EVENT_HARVEST_OR_TRANSFER_COUNT',
        Upgrader: 'EVENT_UPGRADE_COUNT'
      },
      actionSamples: actionCounts.samples,
      lunaROI: feedback.lunaROI,
      tuningHints: feedback.tuningHints
    },
    bodyGuidance: bodyGuidance,
    reasons: reasons
  };
}

function determineLunaQuota(C, room) {
  if (!room) return { desired: 0, rawDesired: 0, remoteCount: 0, totalSources: 0, activeAssignments: 0 };
  var remotes = C.remotesByHome[room.name] || [];
  if (!remotes.length) return { desired: 0, rawDesired: 0, remoteCount: 0, totalSources: 0, activeAssignments: 0 };

  var remoteSet = Object.create(null);
  for (var i = 0; i < remotes.length; i++) {
    remoteSet[remotes[i]] = true;
  }

  var roomsMem = Memory.rooms || {};
  var perSource = (roleLuna && roleLuna.MAX_LUNA_PER_SOURCE) || 1;

  var totalSources = 0;
  for (var j = 0; j < remotes.length; j++) {
    var remoteName = remotes[j];
    var mem = roomsMem[remoteName] || {};
    if (mem.hostile) continue;
    if (mem._invaderLock && mem._invaderLock.locked) {
      var lockTick = (typeof mem._invaderLock.t === 'number') ? mem._invaderLock.t : null;
      if (lockTick == null || (Game.time - lockTick) <= INVADER_LOCK_TTL) {
        continue;
      }
    }

    var srcCount = 0;
    var live = Game.rooms[remoteName];
    if (live) {
      var found = live.find(FIND_SOURCES);
      srcCount = found ? found.length : 0;
    }
    if (srcCount === 0 && mem.sources) {
      for (var sid in mem.sources) {
        if (Object.prototype.hasOwnProperty.call(mem.sources, sid)) {
          srcCount++;
        }
      }
    }
    if (srcCount === 0 && mem.intel && typeof mem.intel.sources === 'number') {
      srcCount = mem.intel.sources || 0;
    }
    totalSources += srcCount;
  }
  if (totalSources <= 0 && remotes.length > 0) {
    totalSources = remotes.length;
  }

  var active = 0;
  var assignments = Memory.remoteAssignments || {};
  for (var aid in assignments) {
    if (!Object.prototype.hasOwnProperty.call(assignments, aid)) continue;
    var entry = assignments[aid];
    if (!entry) continue;
    var rName = entry.roomName || entry.room;
    if (!rName || !remoteSet[rName]) continue;
    var count = entry.count || 0;
    if (!count && entry.owner) count = 1;
    if (count > 0) active += count;
  }

  var desired = Math.max(active, totalSources * perSource);
  if (tickEvery(DBG_EVERY)) {
    dlog('🌙 [Signal] lunaQuota', fmt(room), 'remotes=', remotes.length,
      'sources=', totalSources, 'active=', active, '->', desired);
  }
  return {
    desired: desired,
    rawDesired: desired,
    remoteCount: remotes.length,
    totalSources: totalSources,
    activeAssignments: active
  };
}

function computeRoomQuotas(C, room) {
  // Stage-1 planner layer:
  // BaseHarvest remains protected/specialized and keeps its current authority.
  var debug = ensureSpawnDebug(room.name);
  var baseHarvestQuota = computeBaseHarvestQuotaDynamic(C, room);
  var nonCombatPlan = computeNonCombatPlan(C, room, debug);
  var desired = nonCombatPlan.desired;

  var quotas = {
    BaseHarvest: baseHarvestQuota,
    Courier: desired.Courier,
    Queen: desired.Queen,
    Upgrader: desired.Upgrader,
    Builder: desired.Builder,
    Scout: desired.Scout,
    Luna: desired.Luna,
    Repair: desired.Repair,
    Trucker: desired.Trucker,
    Claimer: desired.Claimer
  };

  debug.planner = {
    tick: Game.time,
    economyState: nonCombatPlan.economyState,
    maturity: nonCombatPlan.maturity,
    combatPressure: (SquadFlagIntel && typeof SquadFlagIntel.threatScoreForRoom === 'function')
      ? (SquadFlagIntel.threatScoreForRoom(room.name) || 0)
      : 0,
    signals: nonCombatPlan.signals,
    recoveryBias: nonCombatPlan.recoveryBias,
    demandClampReasons: nonCombatPlan.demandClampReasons,
    plannerAdjustments: nonCombatPlan.plannerAdjustments,
    feedbackSummary: nonCombatPlan.feedbackSummary,
    bodyGuidance: nonCombatPlan.bodyGuidance,
    reasons: nonCombatPlan.reasons,
    quotas: quotas
  };
  if (tickEvery(DBG_EVERY)) {
    dlog('🎯 [Quotas]', fmt(room), JSON.stringify(quotas));
  }
  return quotas;
}

function fillQueueForRoom(C, room) {
  var quotas = computeRoomQuotas(C, room);
  var roomName = room.name;
  var debug = ensureSpawnDebug(roomName);
  var arbitration = buildArbitrationState(C, room, roomName, quotas);
  var roleStats = {};

  pruneOverfilledQueue(roomName, quotas, C);
  var bhDebug = debug.baseHarvest || {};
  var bhQueuedReasons = [];
  var bhSuppressedReasons = [];
  var baseHarvestSourceMode = false;
  if (room && typeof room.find === 'function') {
    var sources = room.find(FIND_SOURCES) || [];
    if (sources.length > 0) {
      baseHarvestSourceMode = true;
      var sourceCount = sources.length;
      var sourceState = collectBaseHarvestSourceState(C, roomName, sources);
      var queueSummary = summarizeBaseHarvestQueueState(roomName);
      var liveTotal = getRoomLocalLiveCount(C, roomName, 'BaseHarvest');
      var unassignedLive = sourceState.unassignedLive || 0;
      var queuedTotal = queueSummary.queuedTotal || 0;
      var spawningTotal = queueSummary.spawningTotal || 0;
      var plannedTotal = liveTotal + queuedTotal + spawningTotal;
      var allowedCap = sourceCount;
      if ((bhDebug.lowTtlSources && bhDebug.lowTtlSources.length > 0) || ((bhDebug.replacementNeeded || 0) > 0)) {
        allowedCap = sourceCount + 1;
      }
      for (var si = 0; si < sources.length; si++) {
        var source = sources[si];
        var sourceId = source.id;
        var liveForSource = sourceState.liveBySource[sourceId] || 0;
        var lowTtl = !!sourceState.lowTtlBySource[sourceId];
        var queuedOrSpawning = countQueuedOrSpawningSourceReplacement(roomName, sourceId);
        if (liveForSource <= 0 && queuedOrSpawning <= 0) {
          if (liveTotal >= sourceCount && unassignedLive > 0) {
            bhSuppressedReasons.push({ sourceId: sourceId, reason: 'SOURCE_MISSING_BUT_UNASSIGNED_LIVE_EXISTS' });
            continue;
          }
          if (plannedTotal >= allowedCap) {
            bhSuppressedReasons.push({ sourceId: sourceId, reason: 'BASEHARVEST_ROOM_CAP_SUPPRESS' });
            continue;
          }
          enqueue(roomName, 'BaseHarvest', { assignedSource: sourceId, plannerReason: 'SOURCE_MISSING_INCUMBENT' });
          bhQueuedReasons.push({ sourceId: sourceId, reason: 'SOURCE_MISSING_INCUMBENT' });
          queuedTotal += 1;
          plannedTotal += 1;
          continue;
        }
        if (liveForSource > 0 && lowTtl && queuedOrSpawning <= 0) {
          if (plannedTotal >= allowedCap) {
            bhSuppressedReasons.push({ sourceId: sourceId, reason: 'BASEHARVEST_ROOM_CAP_SUPPRESS' });
            continue;
          }
          enqueue(roomName, 'BaseHarvest', { assignedSource: sourceId, plannerReason: 'SOURCE_REPLACEMENT_HANDOFF' });
          bhQueuedReasons.push({ sourceId: sourceId, reason: 'SOURCE_REPLACEMENT_HANDOFF' });
          queuedTotal += 1;
          plannedTotal += 1;
        }
      }
      bhDebug.sourceCount = sourceCount;
      bhDebug.perSourceLive = sourceState.liveBySource;
      bhDebug.liveTotal = liveTotal;
      bhDebug.unassignedLive = unassignedLive;
      bhDebug.queuedTotal = queuedTotal;
      bhDebug.spawningTotal = spawningTotal;
      bhDebug.plannedTotal = plannedTotal;
      bhDebug.allowedCap = allowedCap;
      bhDebug.overCap = plannedTotal > allowedCap;
      bhDebug.queuedBySource = queueSummary.queuedBySource;
      bhDebug.spawningBySource = queueSummary.spawningBySource;
    } else {
      bhQueuedReasons.push({ reason: 'FALLBACK_NO_SOURCES_FOUND' });
    }
  } else {
    bhQueuedReasons.push({ reason: 'FALLBACK_NO_SAFE_ROOM_SOURCE_DATA' });
  }

  // Iterate quotas in plain English order so future maintainers can eyeball
  // which roles will be enqueued before touching the code.
  var roles = Object.keys(quotas);
  for (var i = 0; i < roles.length; i++) {
    var role = roles[i];
    if (canonicalRole(role) === 'BaseHarvest' && baseHarvestSourceMode) {
      roleStats.BaseHarvest = roleStats.BaseHarvest || {};
      roleStats.BaseHarvest.reason = 'SOURCE_SPECIFIC_QUEUE_MODE';
      continue;
    }
    var limit = quotas[role] || 0;
    var canonical = canonicalRole(role);
    var active = getRoomLocalLiveCount(C, roomName, canonical);
    var queued = queuedCount(roomName, role);
    var deficit = Math.max(0, limit - active - queued);
    var surplus = Math.max(0, active + queued - limit);
    roleStats[canonical] = {
      band: roleBand(canonical),
      desired: limit,
      live: active,
      localLive: active,
      queued: queued,
      deficit: deficit,
      surplus: surplus
    };

    if (deficit <= 0 && !surplus) {
      roleStats[canonical].reason = 'ROLE_AT_TARGET';
    } else if (deficit <= 0 && surplus > 0) {
      roleStats[canonical].reason = 'SURPLUS';
    }

    if (deficit > 0 && tickEvery(DBG_EVERY)) {
      dlog('📥 [Queue]', roomName, 'role=', role, 'limit=', limit,
        'active=', active, 'queued=', queued, 'deficit=', deficit);
    }
    for (var j = 0; j < deficit; j++) {
      var guidance = null;
      var guidanceSource = 'RECOMPUTED';
      var plannerBodyGuidance = debug && debug.planner && debug.planner.bodyGuidance
        ? debug.planner.bodyGuidance
        : null;
      if (plannerBodyGuidance &&
          plannerBodyGuidance[canonical] &&
          typeof plannerBodyGuidance[canonical].capIndex === 'number') {
        guidance = plannerBodyGuidance[canonical];
        guidanceSource = 'PLANNER_ADJUSTED';
      } else {
        guidance = roleBodyGuidance(canonical, debug.planner || {});
      }
      var plannerCap = guidance && typeof guidance.capIndex === 'number'
        ? guidance.capIndex
        : 0;
      var capIndex = plannerCap;
      if (arbitration && arbitration.recoveryMode) {
        // Stage-2 recovery bias:
        // favor faster-to-field utility/economy creeps while recovering.
        if (canonical === 'Courier' || canonical === 'Queen' || canonical === 'Upgrader') {
          if (capIndex < 2) capIndex = 2;
        }
      }
      var enqueueReason = null;
      if (debug.planner && debug.planner.reasons && debug.planner.reasons[canonical]) {
        enqueueReason = debug.planner.reasons[canonical];
      } else if (canonical === 'Upgrader' && debug.planner && debug.planner.economyState === 'CRITICAL') {
        enqueueReason = 'ECON_CRITICAL';
      } else if (canonical === 'Luna' && limit <= 0) {
        enqueueReason = 'REMOTE_DISABLED';
      } else if (canonical === 'Repair' && limit <= 0) {
        enqueueReason = 'REPAIR_LOW_PRIORITY';
      } else {
        enqueueReason = 'NEEDS_' + canonical;
      }
      roleStats[canonical].bodyCapIndex = capIndex;
      roleStats[canonical].bodyGuidanceReason = guidance.reason || 'UNSPECIFIED';
      roleStats[canonical].bodyGuidanceSource = guidanceSource;
      roleStats[canonical].plannerBodyCapIndex = plannerCap;
      roleStats[canonical].enqueuedBodyCapIndex = capIndex;
      roleStats[canonical].demandClampReason = (debug.planner && debug.planner.demandClampReasons)
        ? (debug.planner.demandClampReasons[canonical] || debug.planner.demandClampReasons.recoveryBias || null)
        : null;
      enqueue(roomName, canonical, {
        bodyCatalogStartIndex: capIndex,
        plannerBodyCapIndex: plannerCap,
        enqueuedBodyCapIndex: capIndex,
        bodyGuidanceSource: guidanceSource,
        plannerReason: enqueueReason,
        bodyGuidanceReason: guidance.reason || null,
        demandClampReason: roleStats[canonical].demandClampReason,
        roleBand: roleBand(canonical)
      });
    }
  }

  debug.roleStats = roleStats;
  if (!debug.baseHarvest) debug.baseHarvest = {};
  debug.baseHarvest.queuedReasons = bhQueuedReasons;
  debug.baseHarvest.suppressedReasons = bhSuppressedReasons;
  var bhQueueSummary = summarizeBaseHarvestQueueState(roomName);
  debug.baseHarvest.queuedTotal = bhQueueSummary.queuedTotal;
  debug.baseHarvest.spawningTotal = bhQueueSummary.spawningTotal;
  debug.baseHarvest.queuedBySource = bhQueueSummary.queuedBySource;
  debug.baseHarvest.spawningBySource = bhQueueSummary.spawningBySource;
  debug.lastQueueTick = Game.time;
}

function pushSpawnDecisionHistory(roomName, entry) {
  if (!roomName || !entry) return;
  var debug = ensureSpawnDebug(roomName);
  if (!Array.isArray(debug.decisionHistory)) debug.decisionHistory = [];
  debug.decisionHistory.push(entry);
  if (debug.decisionHistory.length > 20) {
    debug.decisionHistory = debug.decisionHistory.slice(debug.decisionHistory.length - 20);
  }
}

function dequeueAndSpawn(spawner) {
  if (!spawner || spawner.spawning) return false;
  var room = spawner.room;
  var roomName = room.name;
  var q = ensureRoomQueue(roomName);
  var debug = ensureSpawnDebug(roomName);
  var quotas = (debug && debug.planner && debug.planner.quotas) ? debug.planner.quotas : computeRoomQuotas(global.__BHM || {}, room);
  var arb = buildArbitrationState(global.__BHM || {}, room, roomName, quotas);
  if (!q.length) {
    var emptyEnergy = compactEnergy(room);
    debug.lastDecision = {
      tick: Game.time,
      spawn: spawner.name,
      selectedRole: null,
      action: 'WAIT',
      reason: 'queue_empty',
      queueLength: q.length,
      energyAvailable: emptyEnergy.energyAvailable,
      energyCapacityAvailable: emptyEnergy.energyCapacityAvailable
    };
    if (tickEvery(DBG_EVERY)) {
      dlog('🕳️ [Queue]', roomName, 'empty (energy', energyStatus(room) + ')');
    }
    pushSpawnDecisionHistory(roomName, { time: Game.time, room: roomName, spawn: spawner.name, energyAvailable: emptyEnergy.energyAvailable, energyCapacityAvailable: emptyEnergy.energyCapacityAvailable, spawning: spawner.spawning ? spawner.spawning.name : null, queueLength: q.length, selected: null, considered: [], reason: "queue empty" });
    return false;
  }

  q.sort(compareQueueItems);

  var pickIndex = -1;
  var pickReason = null;
  var considered = [];
  for (var i = 0; i < q.length; i++) {
    var it = q[i];
    if (!it || !it.role) { considered.push({ role: null, allowed: false, reason: "malformed queue item" }); continue; }
    var canonical = canonicalRole(it.role);
    if (!canonical) { considered.push({ role: it.role, allowed: false, reason: "invalid role" }); continue; }
    var minReq = minEnergyFor(canonical);
    if (it.retryAt && Game.time < it.retryAt) { considered.push({ role: it.role, canonicalRole: canonical, priority: it.priority || 0, queueAge: Game.time - (it.created || Game.time), retryAt: it.retryAt, allowed: false, reason: "retry cooldown", minEnergyRequired: minReq }); continue; }
    var gate = queueItemAllowed(it, arb);
    if (!gate.allowed) {
      recordBlockedRoleReason(debug, canonical, gate.reason);
      considered.push({ role: it.role, canonicalRole: canonical, priority: it.priority || 0, queueAge: Game.time - (it.created || Game.time), retryAt: it.retryAt || 0, allowed: false, reason: gate.reason === "WAITING_ON_SURVIVAL" ? "blocked by survival floor" : (gate.reason.indexOf("RECOVERY")===0 ? "blocked by recovery mode" : gate.reason), minEnergyRequired: minReq });
      continue;
    }
    considered.push({ role: it.role, canonicalRole: canonical, priority: it.priority || 0, queueAge: Game.time - (it.created || Game.time), retryAt: it.retryAt || 0, allowed: true, reason: "allowed", minEnergyRequired: minReq });
    pickIndex = i;
    pickReason = gate.reason;
    break;
  }
  if (pickIndex === -1) {
    var blockedEnergy = compactEnergy(room);
    debug.lastDecision = {
      tick: Game.time,
      spawn: spawner.name,
      selectedRole: null,
      action: 'WAIT',
      reason: (debug.arbitration && debug.arbitration.unmetFloors && debug.arbitration.unmetFloors.length)
        ? 'blocked_by_recovery'
        : 'blocked_by_retry_cooldown',
      queueLength: q.length,
      energyAvailable: blockedEnergy.energyAvailable,
      energyCapacityAvailable: blockedEnergy.energyCapacityAvailable
    };
    if (tickEvery(DBG_EVERY)) {
      dlog('⏸️ [Queue]', roomName, 'head priority cooling down');
    }
    pushSpawnDecisionHistory(roomName, { time: Game.time, room: roomName, spawn: spawner.name, energyAvailable: blockedEnergy.energyAvailable, energyCapacityAvailable: blockedEnergy.energyCapacityAvailable, spawning: spawner.spawning ? spawner.spawning.name : null, queueLength: q.length, selected: null, considered: considered, reason: debug.lastDecision.reason });
    return false;
  }

  var item = q[pickIndex];
  var needed = minEnergyFor(item.role);
  if ((room.energyAvailable || 0) < needed) {
    var lowEnergy = compactEnergy(room);
    debug.lastDecision = {
      tick: Game.time,
      spawn: spawner.name,
      selectedRole: item.role,
      action: 'WAIT',
      reason: 'blocked_by_min_energy',
      queueLength: q.length,
      need: needed,
      have: room.energyAvailable || 0,
      energyAvailable: lowEnergy.energyAvailable,
      energyCapacityAvailable: lowEnergy.energyCapacityAvailable
    };
    if (tickEvery(DBG_EVERY)) {
      dlog('⛽ [QueueHold]', roomName, 'prio', item.priority, 'role', item.role,
        'need', needed, 'have', room.energyAvailable);
    }
    pushSpawnDecisionHistory(roomName, { time: Game.time, room: roomName, spawn: spawner.name, energyAvailable: lowEnergy.energyAvailable, energyCapacityAvailable: lowEnergy.energyCapacityAvailable, spawning: spawner.spawning ? spawner.spawning.name : null, queueLength: q.length, selected: { role: item.role }, considered: considered, reason: "waiting for energy" });
    return false;
  }

  dlog('🎬 [SpawnTry]', roomName, 'role=', item.role, 'prio=', item.priority,
    'age=', (Game.time - item.created), 'energy=', energyStatus(room));

  // Calculate_Spawn_Resource lets us centralize "what counts as energy" logic
  // (spawns-only vs room energy) without duplicating it inside every manager.
  var spawnResource = null;
  if (spawnLogic && typeof spawnLogic.Calculate_Spawn_Resource === 'function') {
    spawnResource = spawnLogic.Calculate_Spawn_Resource(spawner);
  }

  var spawnResult = null;
  if (spawnLogic && typeof spawnLogic.spawnRole === 'function') {
    spawnResult = spawnLogic.spawnRole(spawner, item.role, spawnResource, item);
  }
  var ok = !!(spawnResult && spawnResult.ok);

  if (ok) {
    pushSpawnHistory(debug, item.role, item.roleBand || roleBand(item.role), 'queue', item.plannerReason || 'SPAWN_OK');
    debug.lastDecision = {
      tick: Game.time,
      spawn: spawner.name,
      selectedRole: item.role,
      action: 'SPAWNED',
      reason: item.plannerReason || 'spawn_ok',
      queueLength: q.length,
      plannerBodyCapIndex: (typeof item.plannerBodyCapIndex === 'number') ? item.plannerBodyCapIndex : null,
      enqueuedBodyCapIndex: (typeof item.enqueuedBodyCapIndex === 'number') ? item.enqueuedBodyCapIndex : null,
      bodyCatalogStartIndex: (typeof item.bodyCatalogStartIndex === 'number') ? item.bodyCatalogStartIndex : null,
      bodyGuidanceSource: item.bodyGuidanceSource || null,
      bodyGuidanceReason: item.bodyGuidanceReason || null,
      demandClampReason: item.demandClampReason || null,
      selectedRoleReason: pickReason || 'ALLOWED',
      band: item.roleBand || roleBand(item.role),
      age: Game.time - item.created,
      energyAvailable: (spawnResult && typeof spawnResult.energyAvailable === 'number') ? spawnResult.energyAvailable : (room.energyAvailable || 0),
      energyCapacityAvailable: (spawnResult && typeof spawnResult.energyCapacityAvailable === 'number') ? spawnResult.energyCapacityAvailable : (room.energyCapacityAvailable || 0)
    };
    dlog('✅ [SpawnOK]', roomName, 'spawned', item.role, 'at', spawner.name);
    q.splice(pickIndex, 1);
    pushSpawnDecisionHistory(roomName, { time: Game.time, room: roomName, spawn: spawner.name, energyAvailable: debug.lastDecision.energyAvailable, energyCapacityAvailable: debug.lastDecision.energyCapacityAvailable, spawning: spawner.spawning ? spawner.spawning.name : null, queueLength: q.length, selected: { role: item.role, canonicalRole: canonicalRole(item.role), bodyCost: spawnResult.bodyCost || 0, body: spawnResult.body || [] }, considered: considered, reason: "spawned" });
    return true;
  }

  item.retryAt = Game.time + QUEUE_RETRY_COOLDOWN;
  var failEnergy = compactEnergy(room);
  debug.lastSpawnFailure = {
    tick: Game.time,
    spawn: spawner.name,
    room: roomName,
    requestedRole: item.role,
    canonicalRole: spawnResult ? spawnResult.canonicalRole : canonicalRole(item.role),
    queueItemId: item.id || null,
    body: (spawnResult && spawnResult.body) ? spawnResult.body : [],
    bodyCost: (spawnResult && typeof spawnResult.bodyCost === 'number') ? spawnResult.bodyCost : 0,
    energyAvailable: (spawnResult && typeof spawnResult.energyAvailable === 'number') ? spawnResult.energyAvailable : failEnergy.energyAvailable,
    energyCapacityAvailable: (spawnResult && typeof spawnResult.energyCapacityAvailable === 'number') ? spawnResult.energyCapacityAvailable : failEnergy.energyCapacityAvailable,
    code: (spawnResult && typeof spawnResult.code === 'number') ? spawnResult.code : null,
    reason: (spawnResult && spawnResult.reason) ? spawnResult.reason : 'spawn_failed',
    retryAt: item.retryAt
  };
  debug.lastDecision = {
    tick: Game.time,
    spawn: spawner.name,
    selectedRole: item.role,
    action: 'WAIT',
    reason: (spawnResult && spawnResult.reason) ? spawnResult.reason : 'spawn_failed_retry',
    queueLength: q.length,
    retryAt: item.retryAt,
    energyAvailable: failEnergy.energyAvailable,
    energyCapacityAvailable: failEnergy.energyCapacityAvailable
  };
  pushSpawnDecisionHistory(roomName, { time: Game.time, room: roomName, spawn: spawner.name, energyAvailable: failEnergy.energyAvailable, energyCapacityAvailable: failEnergy.energyCapacityAvailable, spawning: spawner.spawning ? spawner.spawning.name : null, queueLength: q.length, selected: { role: item.role, canonicalRole: canonicalRole(item.role), bodyCost: (spawnResult && spawnResult.bodyCost) || 0, body: (spawnResult && spawnResult.body) || [] }, considered: considered, reason: debug.lastDecision.reason || "other clear reason" });
  dlog('⏳ [SpawnWait]', roomName, item.role, 'backoff to', item.retryAt,
    '(energy', energyStatus(room) + ')');
  return false;
}

// Teaching habit: split orchestration into obvious verbs (prepare, run) so
// extending the manager later is painless.
function prepareRoomQueues(C) {
  var rooms = C.roomsOwned;
  for (var i = 0; i < rooms.length; i++) {
    var room = rooms[i];
    if (!room.find(FIND_MY_SPAWNS).length) continue;
    ensureRoomQueue(room.name);
    fillQueueForRoom(C, room);
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
  if (BeeCombatSquads && typeof BeeCombatSquads.listSquadFlags === 'function') {
    var listed = BeeCombatSquads.listSquadFlags();
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
  var roomName = spawner && spawner.room ? spawner.room.name : null;
  var debug = roomName ? ensureSpawnDebug(roomName) : null;
  var quotas = (debug && debug.planner && debug.planner.quotas) ? debug.planner.quotas : null;
  var arb = (roomName && quotas) ? buildArbitrationState(global.__BHM || {}, spawner.room, roomName, quotas) : null;
  var emergencyDefense = isEmergencyDefenseNeeded(roomName);
  var canRelaxCombat = false;
  if (arb) {
    canRelaxCombat = arb.recoveryMode &&
      !emergencyDefense &&
      (!arb.unmetSurvivalFloors || !arb.unmetSurvivalFloors.length) &&
      (!arb.unmetEconomyFloors || !arb.unmetEconomyFloors.length) &&
      (arb.recoveryActiveDuration >= COMBAT_RELAX_AFTER_TICKS);
  }

  if (arb && arb.recoveryMode && !emergencyDefense && !canRelaxCombat) {
    var combatBlockReason = 'COMBAT_POLICY_RECOVERY_BLOCK';
    if (arb.unmetSurvivalFloors && arb.unmetSurvivalFloors.length) {
      combatBlockReason = 'SURVIVAL_FLOOR_BLOCK';
    } else if (arb.unmetEconomyFloors && arb.unmetEconomyFloors.length) {
      combatBlockReason = 'ECON_FLOOR_BLOCK';
    } else if (arb.economyState === 'CRITICAL') {
      combatBlockReason = 'COMBAT_DENIED_RECOVERY';
    } else if (arb.recoveryActiveDuration < COMBAT_RELAX_AFTER_TICKS) {
      combatBlockReason = 'COMBAT_POLICY_RECOVERY_COOLDOWN';
    }
    if (debug) {
      debug.lastCombatDecision = {
        tick: Game.time,
        spawn: spawner.name,
        allowed: false,
        reason: combatBlockReason
      };
    }
    return false;
  }

  if (arb && canRelaxCombat && debug) {
    var combatShare = arb.bandUsage && arb.bandUsage.shares ? (arb.bandUsage.shares.COMBAT || 0) : 0;
    var combatCap = RECOVERY_BAND_BUDGET_CAPS.COMBAT;
    if (arb.bandUsage && arb.bandUsage.total >= BAND_BUDGET_MIN_SAMPLES && combatShare > combatCap) {
      debug.lastCombatDecision = {
        tick: Game.time,
        spawn: spawner.name,
        allowed: false,
        reason: 'COMBAT_BUDGET_BLOCK'
      };
      return false;
    }
    debug.lastCombatDecision = {
      tick: Game.time,
      spawn: spawner.name,
      allowed: true,
      reason: 'COMBAT_ALLOWED_RECOVERY_STABLE'
    };
  }

  if (debug && emergencyDefense) {
    debug.lastCombatDecision = {
      tick: Game.time,
      spawn: spawner.name,
      allowed: true,
      reason: 'COMBAT_ALLOWED_EMERGENCY'
    };
  }

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
  var spawns = C.spawns;
  var squadState = { handled: false };
  for (var i = 0; i < spawns.length; i++) {
    var spawner = spawns[i];
    if (!spawner || spawner.spawning) continue;
    if (trySpawnSquad(spawner, squadState)) {
      var dbg = ensureSpawnDebug(spawner.room.name);
      pushSpawnHistory(dbg, 'Combat', 'COMBAT', 'combat', 'COMBAT_PREEMPT');
      dbg.lastDecision = {
        tick: Game.time,
        spawn: spawner.name,
        action: 'WAIT',
        reason: 'COMBAT_PREEMPT'
      };
      continue;
    }
    dequeueAndSpawn(spawner);
  }
}

// ------------------------------ Public API ------------------------------
var BeeSpawnManager = {
  manageSpawns: function manageSpawns(C) {
    if (!C || !Array.isArray(C.spawns) || !Array.isArray(C.roomsOwned)) return;
    if (BeeCombatSquads && typeof BeeCombatSquads.refreshAutoDefensePlans === 'function') {
      // BHM Combat Fix: keep squad plans in sync before evaluating spawn needs.
      BeeCombatSquads.refreshAutoDefensePlans();
    }
    prepareRoomQueues(C);
    runSpawnPass(C);
  }
};

module.exports = BeeSpawnManager;
