// TaskLuna.clean.js
// Luna harvester ("forager"): mines a remote source and hauls energy home.
//
// This revision:
// - Stores count + owner per source in Memory.remoteAssignments[sourceId] = {count, owner, roomName, since}
// - Creep memory always carries {sourceId, targetRoom}
// - Duplicate resolver elects 1 winner (oldest _assignTick, then name), losers yield
// - Removes stale owners when creeps die or retarget
// - SOURCE FLAGS: create on source tile and prune when unused/locked (with grace TTL)
// - NEW: CONTROLLER FLAGS: create a flag on the remote room's controller while the room is being worked;
//        automatically remove it when there are no Luna creeps assigned/in that room.
// - Legacy fallback hard-caps to REMOTE_RADIUS; ES5-safe; Traveler/BeeTravel for movement.

'use strict';

// ============================
// Dependencies
// ============================
var BeeToolbox = require('BeeToolbox');
var RoadPlanner = require('Planner.Road');
var RoomPlanner = require('Planner.Room');
var Logger = require('core.logger');
var spawnLogic = require('spawn.logic');
try { require('Traveler'); } catch (e) {} // ensure creep.travelTo exists

var CFG = (global.CFG = global.CFG || {});
if (typeof CFG.DEBUG_LUNA !== 'boolean') CFG.DEBUG_LUNA = false;

var LOG_LEVEL = Logger.LOG_LEVEL;
var lunaLog = Logger.createLogger('Luna', LOG_LEVEL.BASIC);

// ============================
// Tunables
// ============================
// NOTE: REMOTE_RADIUS is measured in "room hops" from the home room.
var REMOTE_RADIUS = 4;

var MAX_PF_OPS    = 3000;
var PLAIN_COST    = 2;
var SWAMP_COST    = 10;
var RP_CONFIG = RoadPlanner && RoadPlanner.CONFIG ? RoadPlanner.CONFIG : {};
var ECON_CFG = BeeToolbox.ECON_CFG || {};

var DEBUG_CACHE = (global.__lunaDebugCache = global.__lunaDebugCache || { tick: -1, rooms: {}, creeps: {} });

function debugEnabled() {
  return CFG.DEBUG_LUNA === true;
}

function _resetDebugCacheIfNeeded() {
  if (!debugEnabled()) return;
  if (DEBUG_CACHE.tick === Game.time) return;
  DEBUG_CACHE.tick = Game.time;
  DEBUG_CACHE.rooms = {};
  DEBUG_CACHE.creeps = {};
}

function logDebug(roomName, action, result, details) {
  if (!debugEnabled()) return;
  var msg = '[LUNA] room=' + (roomName || '??') + ' action=' + action + ' result=' + result;
  if (details) {
    if (details.reason) msg += ' reason=' + details.reason;
    if (details.bodyCost != null) msg += ' body=' + details.bodyCost;
    if (details.energyAvailable != null && details.energyCapacity != null) {
      msg += ' energy=' + details.energyAvailable + '/' + details.energyCapacity;
    }
    if (details.nextAttempt != null) msg += ' next=' + details.nextAttempt;
  }
  console.log(msg);
}

function recordRoomDebugStatus(roomName, status, reason, plan) {
  if (!debugEnabled()) return;
  _resetDebugCacheIfNeeded();
  DEBUG_CACHE.rooms[roomName || 'unknown'] = {
    status: status || 'UNKNOWN',
    reason: reason || null,
    nextAttempt: plan && plan.nextAttempt != null ? plan.nextAttempt : null,
    energyAvailable: plan && plan.energyAvailable != null ? plan.energyAvailable : null,
    energyCapacity: plan && plan.energyCapacity != null ? plan.energyCapacity : null,
    bodyCost: plan && plan.bodyCost != null ? plan.bodyCost : null,
    tier: plan && plan.bodyTier != null ? plan.bodyTier : null
  };
}

function recordCreepDebugInfo(creep, info) {
  if (!debugEnabled()) return;
  if (!creep) return;
  _resetDebugCacheIfNeeded();
  DEBUG_CACHE.creeps[creep.name || ('creep_' + Game.time)] = {
    room: creep.pos && creep.pos.roomName || null,
    x: creep.pos && creep.pos.x,
    y: creep.pos && creep.pos.y,
    state: info && info.state || 'UNKNOWN',
    ttl: creep.ticksToLive,
    target: info && info.target || null,
    load: info && info.load,
    reason: info && info.reason || null
  };
}

function ensureSpawnMemo() {
  if (!Memory._lunaSpawn) Memory._lunaSpawn = {};
  return Memory._lunaSpawn;
}

function getSpawnMemo(homeName) {
  var map = ensureSpawnMemo();
  var key = homeName || 'unknown';
  if (!map[key]) map[key] = { status: 'INIT', reason: null, nextAttempt: Game.time, counter: 0 };
  return map[key];
}

function updateSpawnStatus(homeName, status, reason, plan) {
  var memo = getSpawnMemo(homeName);
  memo.status = status || memo.status;
  memo.reason = reason || null;
  memo.nextAttempt = plan && plan.nextAttempt != null ? plan.nextAttempt : (Game.time + 5);
  memo.energyAvailable = plan && plan.energyAvailable != null ? plan.energyAvailable : memo.energyAvailable;
  memo.energyCapacity = plan && plan.energyCapacity != null ? plan.energyCapacity : memo.energyCapacity;
  memo.bodyCost = plan && plan.bodyCost != null ? plan.bodyCost : memo.bodyCost;
  memo.bodyTier = plan && plan.bodyTier != null ? plan.bodyTier : memo.bodyTier;
  memo.lastResult = plan && plan.lastResult != null ? plan.lastResult : memo.lastResult;
  memo.updatedAt = Game.time;
  if (plan && plan.body && plan.body.length) memo.body = plan.body.slice();
  recordRoomDebugStatus(homeName, memo.status, memo.reason, memo);
  logDebug(homeName, 'spawnPlan', memo.status, {
    reason: memo.reason,
    bodyCost: memo.bodyCost,
    energyAvailable: memo.energyAvailable,
    energyCapacity: memo.energyCapacity,
    nextAttempt: memo.nextAttempt
  });
  return memo;
}

function calculateBodyCost(body) {
  if (!body || !body.length) return 0;
  var total = 0;
  for (var i = 0; i < body.length; i++) {
    total += BODYPART_COST[body[i]] || 0;
  }
  return total;
}

function cloneBody(body) {
  if (!body || !body.length) return [];
  var out = [];
  for (var i = 0; i < body.length; i++) out.push(body[i]);
  return out;
}

var LUNA_BODY_CONFIGS = null;

function ensureLunaBodyConfigs() {
  if (LUNA_BODY_CONFIGS) return LUNA_BODY_CONFIGS;
  LUNA_BODY_CONFIGS = [];
  if (spawnLogic && spawnLogic.configurations && spawnLogic.configurations.length) {
    for (var i = 0; i < spawnLogic.configurations.length; i++) {
      var cfg = spawnLogic.configurations[i];
      if (!cfg || cfg.task !== 'luna') continue;
      var bodyList = cfg.body || [];
      for (var j = 0; j < bodyList.length; j++) {
        var body = bodyList[j];
        if (!body || !body.length) continue;
        // Bodies mirror spawn.logic tiers: roughly 2 CARRY per WORK with MOVE headroom to cover remote haul distance.
        LUNA_BODY_CONFIGS.push(cloneBody(body));
      }
    }
  }
  if (!LUNA_BODY_CONFIGS.length) {
    LUNA_BODY_CONFIGS.push([WORK, CARRY, MOVE]);
  }
  return LUNA_BODY_CONFIGS;
}

function pickLunaBodyForEnergy(energy) {
  var configs = ensureLunaBodyConfigs();
  var best = null;
  for (var i = 0; i < configs.length; i++) {
    var body = configs[i];
    var cost = calculateBodyCost(body);
    if (cost <= energy) {
      best = { body: cloneBody(body), cost: cost, index: i };
      break;
    }
  }
  return best;
}

function getIdealLunaBodyForCapacity(capacity) {
  var configs = ensureLunaBodyConfigs();
  var ideal = null;
  for (var i = 0; i < configs.length; i++) {
    var body = configs[i];
    var cost = calculateBodyCost(body);
    if (cost <= capacity) {
      if (!ideal || cost > ideal.cost) ideal = { body: cloneBody(body), cost: cost, index: i };
    }
  }
  if (ideal) return ideal;
  if (configs.length) {
    var fallback = cloneBody(configs[configs.length - 1]);
    return { body: fallback, cost: calculateBodyCost(fallback), index: configs.length - 1 };
  }
  return { body: [WORK, CARRY, MOVE], cost: calculateBodyCost([WORK, CARRY, MOVE]), index: 0 };
}

function getMinimumLunaCost() {
  var configs = ensureLunaBodyConfigs();
  if (!configs.length) return calculateBodyCost([WORK, CARRY, MOVE]);
  var last = configs[configs.length - 1];
  return calculateBodyCost(last);
}

function sanitizeRoomName(name) {
  if (!name) return 'UNKNOWN';
  return String(name).replace(/[^A-Za-z0-9]/g, '');
}

function generateLunaName(homeName) {
  var memo = getSpawnMemo(homeName);
  var baseRoom = sanitizeRoomName(homeName || 'HOME');
  var counter = memo.counter | 0;
  var name;
  do {
    counter += 1;
    name = 'Luna_' + baseRoom + '_' + counter;
  } while (Game.creeps[name]);
  memo.counter = counter;
  return name;
}

function hasAvailableRemoteSlot(homeName) {
  var memAssign = ensureAssignmentsMem();
  var open = 0;
  for (var sid in memAssign) {
    if (!memAssign.hasOwnProperty(sid)) continue;
    var entry = _maEnsure(memAssign[sid], memAssign[sid] && memAssign[sid].roomName);
    if (!entry) continue;
    var roomName = entry.roomName || entry.room || null;
    if (roomName && BeeToolbox.safeLinearDistance(homeName, roomName) > REMOTE_RADIUS) continue;
    var count = entry.count | 0;
    if (count < MAX_LUNA_PER_SOURCE) {
      open += (MAX_LUNA_PER_SOURCE - count);
    }
  }
  if (open > 0) return true;

  var rooms = Memory.rooms || {};
  for (var rn in rooms) {
    if (!rooms.hasOwnProperty(rn)) continue;
    if (BeeToolbox.safeLinearDistance(homeName, rn) > REMOTE_RADIUS) continue;
    var rm = rooms[rn];
    if (!rm || rm.hostile) continue;
    var sources = rm.sources ? Object.keys(rm.sources) : [];
    if (sources.length > 0) return true;
  }
  return false;
}

function planSpawnForRoom(spawn, context) {
  var room = spawn && spawn.room;
  var homeName = room ? room.name : (context && context.homeName) || null;
  var plan = {
    homeName: homeName,
    spawnName: (spawn && spawn.name) || null,
    shouldSpawn: false,
    status: 'BLOCKED',
    reason: 'UNSET',
    energyAvailable: 0,
    energyCapacity: 0,
    current: 0,
    limit: 0,
    nextAttempt: Game.time + 5,
    body: null,
    bodyCost: 0,
    bodyTier: null
  };

  if (!spawn || !room || !room.controller || !room.controller.my) {
    plan.reason = 'INVALID_ROOM';
    plan.status = 'BLOCKED';
    plan.nextAttempt = Game.time + 50;
    updateSpawnStatus(homeName, plan.status, plan.reason, plan);
    return plan;
  }

  plan.energyAvailable = (context && typeof context.availableEnergy === 'number')
    ? context.availableEnergy
    : (room.energyAvailable || 0);
  plan.energyCapacity = (context && typeof context.capacityEnergy === 'number')
    ? context.capacityEnergy
    : (room.energyCapacityAvailable || plan.energyAvailable);
  plan.current = (context && context.current) || 0;
  plan.limit = (context && context.limit) || 0;

  if (plan.limit <= 0) {
    plan.reason = 'QUOTA_ZERO';
    plan.status = 'SATURATED';
    plan.nextAttempt = Game.time + 25;
    updateSpawnStatus(homeName, plan.status, plan.reason, plan);
    return plan;
  }

  if (plan.current >= plan.limit) {
    plan.reason = 'QUOTA_MET';
    plan.status = 'SATURATED';
    plan.nextAttempt = Game.time + 25;
    updateSpawnStatus(homeName, plan.status, plan.reason, plan);
    return plan;
  }

  var remoteState = homeAllowsNewRemote(homeName);
  if (!remoteState.allowed) {
    plan.reason = 'REMOTE_GATED';
    plan.status = 'BLOCKED';
    plan.nextAttempt = Game.time + 50;
    updateSpawnStatus(homeName, plan.status, plan.reason, plan);
    return plan;
  }

  if (!hasAvailableRemoteSlot(homeName)) {
    plan.reason = 'NO_OPEN_SOURCES';
    plan.status = 'DEFERRED';
    plan.nextAttempt = Game.time + 25;
    updateSpawnStatus(homeName, plan.status, plan.reason, plan);
    return plan;
  }

  var bodyPlan = pickLunaBodyForEnergy(plan.energyAvailable);
  var ideal = getIdealLunaBodyForCapacity(plan.energyCapacity);
  if (!bodyPlan || !bodyPlan.body || !bodyPlan.body.length) {
    plan.body = ideal.body;
    plan.bodyCost = ideal.cost;
    plan.bodyTier = ideal.index;
    plan.reason = 'ERR_NO_ENERGY';
    plan.status = 'DEFERRED';
    plan.nextAttempt = Game.time + 10;
    updateSpawnStatus(homeName, plan.status, plan.reason, plan);
    return plan;
  }

  plan.body = bodyPlan.body;
  plan.bodyCost = bodyPlan.cost;
  plan.bodyTier = bodyPlan.index;
  plan.reason = (ideal && bodyPlan.cost < ideal.cost) ? 'DOWNSHIFT' : 'IDEAL';
  plan.status = 'READY';
  plan.shouldSpawn = true;
  plan.nextAttempt = Game.time;
  updateSpawnStatus(homeName, plan.status, plan.reason, plan);
  return plan;
}

function spawnFromPlan(spawn, plan) {
  if (!spawn || !plan || !plan.body || !plan.body.length) return ERR_INVALID_ARGS;
  var homeName = plan.homeName || (spawn.room ? spawn.room.name : null);
  var name = plan.name || generateLunaName(homeName);
  var memory = {
    role: 'Worker_Bee',
    task: 'luna',
    bornTask: 'luna',
    home: homeName,
    birthBody: plan.body.slice(),
    spawnTick: Game.time,
    lunaState: 'INIT',
    returning: false,
    planReason: plan.reason,
    planCost: plan.bodyCost
  };

  if (plan.extraMemory) {
    for (var key in plan.extraMemory) {
      if (plan.extraMemory.hasOwnProperty(key)) {
        memory[key] = plan.extraMemory[key];
      }
    }
  }

  var result = spawn.spawnCreep(plan.body, name, { memory: memory });
  plan.lastResult = result;

  if (result === OK) {
    var memo = getSpawnMemo(homeName);
    memo.status = 'HATCHING';
    memo.reason = 'SPAWNING';
    memo.nextAttempt = Game.time + 1;
    memo.lastResult = result;
    memo.lastSpawnName = name;
    memo.bodyCost = plan.bodyCost;
    memo.energyAvailable = plan.energyAvailable;
    memo.energyCapacity = plan.energyCapacity;
    recordRoomDebugStatus(homeName, memo.status, memo.reason, memo);
    logDebug(homeName, 'spawn', 'OK', { bodyCost: plan.bodyCost, energyAvailable: plan.energyAvailable, energyCapacity: plan.energyCapacity });
  } else if (result === ERR_NAME_EXISTS) {
    plan.name = generateLunaName(homeName);
    plan.nextAttempt = Game.time + 1;
    updateSpawnStatus(homeName, 'DEFERRED', 'NAME_COLLISION', plan);
  } else if (result === ERR_NOT_ENOUGH_ENERGY) {
    plan.nextAttempt = Game.time + 10;
    updateSpawnStatus(homeName, 'DEFERRED', 'ERR_NOT_ENOUGH_ENERGY', plan);
  } else if (result === ERR_BUSY) {
    plan.nextAttempt = Game.time + 2;
    updateSpawnStatus(homeName, 'DEFERRED', 'SPAWN_BUSY', plan);
  } else {
    plan.nextAttempt = Game.time + 5;
    updateSpawnStatus(homeName, 'BLOCKED', 'ERR_' + result, plan);
  }

  return result;
}

function noteSpawnBlocked(homeName, reason, nextAttempt, availableEnergy, capacityEnergy) {
  var plan = {
    nextAttempt: nextAttempt != null ? nextAttempt : (Game.time + 1),
    energyAvailable: availableEnergy,
    energyCapacity: capacityEnergy
  };
  updateSpawnStatus(homeName, 'DEFERRED', reason, plan);
}

var LUNA_STATE = {
  INIT: 'INIT',
  ACQUIRE: 'ACQUIRE_TARGET',
  TRAVEL: 'TRAVEL',
  HARVEST: 'MINE',
  DELIVER: 'DEPOSIT',
  RECOVER: 'RECOVER',
  RETIRE: 'RETIRE'
};

var LUNA_STATE_DISPLAY = {
  INIT: 'IDLE',
  ACQUIRE_TARGET: 'IDLE',
  TRAVEL: 'TRAVEL',
  MINE: 'MINING',
  DEPOSIT: 'HAULING',
  RECOVER: 'RECOVER',
  RETIRE: 'RETIRE'
};

function getLunaState(creep) {
  if (!creep || !creep.memory) return LUNA_STATE.INIT;
  var state = creep.memory.lunaState;
  if (!state || !LUNA_STATE_DISPLAY[state]) {
    creep.memory.lunaState = LUNA_STATE.INIT;
    creep.memory._stateSince = Game.time;
    state = LUNA_STATE.INIT;
  }
  return state;
}

function setLunaState(creep, newState, reason) {
  if (!creep || !creep.memory) return;
  if (!newState || !LUNA_STATE_DISPLAY[newState]) newState = LUNA_STATE.INIT;
  var current = creep.memory.lunaState;
  if (current === newState) return;
  creep.memory.lunaState = newState;
  creep.memory._stateSince = Game.time;
  creep.memory._stateReason = reason || null;
  if (debugEnabled()) {
    recordCreepDebugInfo(creep, {
      state: LUNA_STATE_DISPLAY[newState] || newState,
      target: creep.memory && creep.memory.targetRoom,
      load: creep.store ? creep.store.getUsedCapacity(RESOURCE_ENERGY) : null,
      reason: reason || null
    });
  }
}

function stateAge(creep) {
  if (!creep || !creep.memory) return 0;
  var since = creep.memory._stateSince | 0;
  return Game.time - since;
}

var MAX_LUNA_PER_SOURCE = 1;
var MAX_ACTIVE_REMOTES = (typeof ECON_CFG.MAX_ACTIVE_REMOTES === 'number') ? ECON_CFG.MAX_ACTIVE_REMOTES : 2;
var STORAGE_ENERGY_MIN_BEFORE_REMOTES = (typeof ECON_CFG.STORAGE_ENERGY_MIN_BEFORE_REMOTES === 'number')
  ? ECON_CFG.STORAGE_ENERGY_MIN_BEFORE_REMOTES
  : 40000;
var REMOTE_ROI_WEIGHTING = RP_CONFIG.REMOTE_ROI_WEIGHTING || { pathLength: 1, swampTiles: 3, hostilePenalty: 5000 };
var THROTTLE_LOG_INTERVAL = (typeof RP_CONFIG.THROTTLE_LOG_INTERVAL === 'number') ? RP_CONFIG.THROTTLE_LOG_INTERVAL : 1000;

var PF_CACHE_TTL = 150;
var INVADER_LOCK_MEMO_TTL = 1500;

var AVOID_TTL = 30;
var RETARGET_COOLDOWN = 5;
var OTHER_OWNER_AVOID_TTL = 500;

// Small bias to keep the current owner briefly (soft preference only)
var ASSIGN_STICKY_TTL = 50;

// Anti-stuck
var STUCK_WINDOW = 4;

// Flag pruning cadence & grace (sources only)
var FLAG_PRUNE_PERIOD   = 25;   // how often to scan for source-flag deletions
var FLAG_RETENTION_TTL  = 200;  // keep a source-flag this many ticks since last activity

// ============================
// Helpers: short id, flags
// ============================
function shortSid(id) {
  if (!id || typeof id !== 'string') return '??????';
  var n = id.length; return id.substr(n - 6);
}

function _roomMem(roomName){
  Memory.rooms = Memory.rooms || {};
  return (Memory.rooms[roomName] = (Memory.rooms[roomName] || {}));
}
function _sourceMem(roomName, sid) {
  var rm = _roomMem(roomName);
  rm.sources = rm.sources || {};
  return (rm.sources[sid] = (rm.sources[sid] || {}));
}

// mark activity each time we touch/own/harvest a source
function touchSourceActive(roomName, sid) {
  if (!roomName || !sid) return;
  var srec = _sourceMem(roomName, sid);
  srec.lastActive = Game.time;
}

/** Ensure exactly one flag exists on this source tile (idempotent) and touch lastActive. */
function ensureSourceFlag(source) {
  if (!source || !source.pos || !source.room) return;

  var roomName = source.pos.roomName;
  var srec = _sourceMem(roomName, source.id);

  // reuse previous flag if it still matches this tile
  if (srec.flagName) {
    var f = Game.flags[srec.flagName];
    if (f &&
        f.pos.x === source.pos.x &&
        f.pos.y === source.pos.y &&
        f.pos.roomName === roomName) {
      touchSourceActive(roomName, source.id);
      return;
    }
  }

  // does a properly-named flag already sit here? adopt it
  var flagsHere = source.pos.lookFor(LOOK_FLAGS) || [];
  var expectedPrefix = 'SRC-' + roomName + '-';
  var sidTail = shortSid(source.id);
  for (var i = 0; i < flagsHere.length; i++) {
    var fh = flagsHere[i];
    if (typeof fh.name === 'string' &&
        fh.name.indexOf(expectedPrefix) === 0 &&
        fh.name.indexOf(sidTail) !== -1) {
      srec.flagName = fh.name;
      touchSourceActive(roomName, source.id);
      return;
    }
  }

  // create a new one
  var base = expectedPrefix + sidTail;
  var name = base, tries = 1;
  while (Game.flags[name]) { tries++; name = base + '-' + tries; if (tries > 10) break; }
  var rc = source.room.createFlag(source.pos, name, COLOR_YELLOW, COLOR_YELLOW);
  if (typeof rc === 'string') {
    srec.flagName = rc;
    touchSourceActive(roomName, source.id);
  }
}

function _shouldLogThrottle(roomName, reason) {
  if (!roomName) return false;
  Memory._remoteThrottleLog = Memory._remoteThrottleLog || {};
  var rec = Memory._remoteThrottleLog[roomName];
  if (!rec) {
    rec = {};
    Memory._remoteThrottleLog[roomName] = rec;
  }
  var key = reason || 'generic';
  var last = rec[key] || 0;
  if ((Game.time || 0) - last < THROTTLE_LOG_INTERVAL) return false;
  rec[key] = Game.time || 0;
  Memory._remoteThrottleLog[roomName] = rec;
  return true;
}

function _logRemoteThrottle(roomName, storage, threshold, active, max, reason) {
  if (!_shouldLogThrottle(roomName, reason)) return;
  var msg = '[Remotes] Skipped planning: storage=' + storage + '/threshold=' + threshold;
  msg += ', active=' + active + '/max=' + max;
  msg += ', reason=' + reason + ', room=' + roomName;
  lunaLog.info(msg);
}

// ============================
// NEW: Controller flag helpers (Reserve:roomName style)
// ============================
function ensureControllerFlag(ctrl){
  if (!ctrl) return;
  var roomName = ctrl.pos.roomName;
  var rm = _roomMem(roomName);

  // Expected flag name for this room’s controller
  var expect = 'Reserve:' + roomName;

  // If we already know a flag name and it’s still valid, reuse
  if (rm.controllerFlagName) {
    var f0 = Game.flags[rm.controllerFlagName];
    if (f0 &&
        f0.pos.x === ctrl.pos.x &&
        f0.pos.y === ctrl.pos.y &&
        f0.pos.roomName === roomName) {
      return; // still good
    }
  }

  // Adopt any Reserve:roomName flag already sitting on this controller
  var flagsHere = ctrl.pos.lookFor(LOOK_FLAGS) || [];
  for (var i = 0; i < flagsHere.length; i++) {
    if (flagsHere[i].name === expect) {
      rm.controllerFlagName = expect;
      return;
    }
  }

  // Otherwise create a new one (idempotent: if it fails, we’ll adopt next tick)
  var rc = ctrl.room.createFlag(ctrl.pos, expect, COLOR_WHITE, COLOR_PURPLE);
  if (typeof rc === 'string') rm.controllerFlagName = rc;
}

function pruneControllerFlagIfNoForagers(roomName, roomCountMap){
  var rm = _roomMem(roomName);
  var fname = rm.controllerFlagName;
  if (!fname) return;

  // Only prune if no active foragers are assigned/in this room
  var count = roomCountMap && roomCountMap[roomName] ? roomCountMap[roomName] : 0;
  if (count > 0) return;

  var f = Game.flags[fname];
  if (f) {
    try { f.remove(); } catch (e) {}
  }
  delete rm.controllerFlagName;
}

// ============================
// Avoid-list (per creep)
// ============================
function _ensureAvoid(creep){ if (!creep.memory._avoid) creep.memory._avoid = {}; return creep.memory._avoid; }
function shouldAvoid(creep, sid){ var a=_ensureAvoid(creep); var t=a[sid]; return (typeof t==='number' && Game.time<t); }
function markAvoid(creep, sid, ttl){ var a=_ensureAvoid(creep); a[sid] = Game.time + (ttl!=null?ttl:AVOID_TTL); }
function avoidRemaining(creep, sid){ var a=_ensureAvoid(creep); var t=a[sid]; if (typeof t!=='number') return 0; var left=t-Game.time; return left>0?left:0; }

// ============================
// Foreign ownership/hostile detection helpers
// ============================
var detectForeignPresence = BeeToolbox.detectForeignPresence || function(){ return { avoid: false }; };
var markRoomForeignAvoid = BeeToolbox.markRoomForeignAvoid || function(){ };

// ============================
// Per-tick *claim* (same-tick contention guard)
// ============================
function _claimTable(){ var sc=Memory._sourceClaim; if(!sc||sc.t!==Game.time){ Memory._sourceClaim={t:Game.time,m:{}}; } return Memory._sourceClaim.m; }
function tryClaimSourceForTick(creep, sid){
  var m=_claimTable(), cur=m[sid];
  if (!cur){ m[sid]=creep.name; return true; }
  if (creep.name < cur){ m[sid]=creep.name; return true; }
  return cur===creep.name;
}

// ============================
// remoteAssignments model
// ============================
function ensureAssignmentsMem(){ if(!Memory.remoteAssignments) Memory.remoteAssignments={}; return Memory.remoteAssignments; }
function _maEnsure(entry, roomName){
  if (!entry || typeof entry !== 'object') entry = { count: 0, owner: null, roomName: roomName||null, since: null };
  if (typeof entry.count !== 'number') entry.count = (entry.count|0);
  if (!('owner' in entry)) entry.owner = null;
  if (!('roomName' in entry)) entry.roomName = roomName||null;
  if (!('since' in entry)) entry.since = null;
  return entry;
}
function maCount(memAssign, sid){
  var e = memAssign[sid];
  if (!e) return 0;
  if (typeof e === 'number') return e; // backward compat
  return e.count|0;
}
function maOwner(memAssign, sid){
  var e = memAssign[sid];
  if (!e || typeof e === 'number') return null;
  return e.owner || null;
}
function maSetOwner(memAssign, sid, owner, roomName){
  var e = _maEnsure(memAssign[sid], roomName);
  e.owner = owner; e.roomName = roomName || e.roomName; e.since = Game.time;
  memAssign[sid] = e;
  // PRUNE / lastActive: any time we set owner, bump activity so source-flag isn't pruned
  if (e.roomName) touchSourceActive(e.roomName, sid);
}
function maClearOwner(memAssign, sid){
  var e = _maEnsure(memAssign[sid], null);
  e.owner = null; e.since = null;
  memAssign[sid] = e;
}
function maInc(memAssign, sid, roomName){
  var e = _maEnsure(memAssign[sid], roomName); e.count = (e.count|0) + 1; memAssign[sid]=e;
}
function maDec(memAssign, sid){
  var e = _maEnsure(memAssign[sid], null); e.count = Math.max(0,(e.count|0)-1); memAssign[sid]=e;
}

// ============================
// Ownership / duplicate resolver
// ============================
function resolveOwnershipForSid(sid){
  var memAssign = ensureAssignmentsMem();
  var e = _maEnsure(memAssign[sid], null);

  // Collect live contenders
  var contenders = [];
  for (var name in Game.creeps){
    var c = Game.creeps[name];
    if (!c || !c.memory) continue;
    if (c.memory.task === 'luna' && c.memory.sourceId === sid){
      contenders.push(c);
    }
  }

  // If no contenders, clear owner; counts refresh in audit
  if (!contenders.length){
    maClearOwner(memAssign, sid);
    return null;
  }

  // Elect one: oldest _assignTick wins; tie-break by name
  contenders.sort(function(a,b){
    var at = a.memory._assignTick||0, bt=b.memory._assignTick||0;
    if (at!==bt) return at-bt;
    return a.name<b.name?-1:1;
  });
  var winner = contenders[0];

  // Bless the winner
  maSetOwner(memAssign, sid, winner.name, winner.memory.targetRoom||null);

  // Force losers to yield
  for (var i=1; i<contenders.length; i++){
    var loser = contenders[i];
    if (loser && loser.memory && loser.memory.sourceId === sid){
      loser.memory._forceYield = true;
    }
  }

  return winner.name;
}

// Audits all sids once per tick: recompute counts, scrub dead owners, and prune flags
function auditRemoteAssignments(){
  var memAssign = ensureAssignmentsMem();

  // Reset counts to 0
  for (var sid in memAssign){
    memAssign[sid] = _maEnsure(memAssign[sid], memAssign[sid].roomName||null);
    memAssign[sid].count = 0;
  }

  // Count live assignments + per-room counts (for controller flags)
  var roomCounts = {}; // roomName -> number of Luna harvesters assigned/in that room
  for (var name in Game.creeps){
    var c = Game.creeps[name];
    if (!c || !c.memory) continue;
    if (c.memory.task === 'luna') {
      if (c.memory.sourceId){
        var sid2 = c.memory.sourceId;
        var e2 = _maEnsure(memAssign[sid2], c.memory.targetRoom||null);
        e2.count = (e2.count|0) + 1;
        memAssign[sid2] = e2;
      }
      if (c.memory.targetRoom){
        var rn = c.memory.targetRoom;
        roomCounts[rn] = (roomCounts[rn]|0) + 1;
      }
    }
  }

  // Scrub owners / resolve duplicates
  for (var sid3 in memAssign){
    var owner = maOwner(memAssign, sid3);
    if (owner){
      var oc = Game.creeps[owner];
      if (!oc || !oc.memory || oc.memory.sourceId !== sid3){
        resolveOwnershipForSid(sid3);
      }else{
        if (memAssign[sid3].count > MAX_LUNA_PER_SOURCE){
          resolveOwnershipForSid(sid3);
        }
      }
    }else{
      if (memAssign[sid3].count > 0){
        resolveOwnershipForSid(sid3);
      }
    }
  }

  // PRUNE: source flags on cadence
  if ((Game.time % FLAG_PRUNE_PERIOD) === 0) pruneUnusedSourceFlags();

  // NEW: Controller flag prune — remove the controller flag in rooms with zero foragers
  // We do this every audit so it's snappy (no TTL needed).
  var rooms = Memory.rooms || {};
  for (var roomName in rooms) {
    if (!rooms.hasOwnProperty(roomName)) continue;
    pruneControllerFlagIfNoForagers(roomName, roomCounts);
  }
}

function auditOncePerTick(){
  if (Memory._auditRemoteAssignmentsTick !== Game.time){
    auditRemoteAssignments();
    Memory._auditRemoteAssignmentsTick = Game.time;
  }
}

// ============================
// Flag pruning (sources)
// ============================
function pruneUnusedSourceFlags(){
  var memAssign = ensureAssignmentsMem();
  var now = Game.time;

  // Walk all known rooms/sources in memory
  var rooms = Memory.rooms || {};
  for (var roomName in rooms){
    if (!rooms.hasOwnProperty(roomName)) continue;
    var rm = rooms[roomName]; if (!rm || !rm.sources) continue;

    var roomLocked = isRoomLockedByInvaderCore(roomName);

    for (var sid in rm.sources){
      if (!rm.sources.hasOwnProperty(sid)) continue;
      var srec = rm.sources[sid] || {};
      var flagName = srec.flagName;
      if (!flagName) continue; // nothing to remove

      // Decide if the flag is removable:
      var e = _maEnsure(memAssign[sid], rm.sources[sid].roomName || roomName);
      var count  = e.count|0;
      var owner  = e.owner || null;
      var last   = srec.lastActive|0;

      var inactiveLong = (now - last) > FLAG_RETENTION_TTL;
      var nobodyOwns   = (count === 0 && owner == null);

      if (roomLocked || (nobodyOwns && inactiveLong)) {
        var f = Game.flags[flagName];
        // Only remove if the flag still sits on the source tile; otherwise just clean memory.
        if (f) {
          var prefix = 'SRC-' + roomName + '-';
          var looksLikeOurs = (typeof flagName === 'string' && flagName.indexOf(prefix) === 0);
          var posMatches = (!srec.x || !srec.y) ? true : (f.pos.x === srec.x && f.pos.y === srec.y);
          var srcObj = Game.getObjectById(sid);
          var tileOk = srcObj ? (f.pos.x === srcObj.pos.x && f.pos.y === srcObj.pos.y && f.pos.roomName === srcObj.pos.roomName) : true;

          if (looksLikeOurs && (posMatches && tileOk)) {
            try { f.remove(); } catch (e1) {}
          }
        }
        // Always clear the memory pointer so we can recreate later if needed
        delete srec.flagName;
        rm.sources[sid] = srec;
      }
    }
  }
}

// ============================
// Pathing helpers (Traveler-first)
// ============================
if (!Memory._pfCost) Memory._pfCost = {};

function pfCostCached(anchorPos, targetPos, sourceId) {
  var key = anchorPos.roomName + ':' + sourceId;
  var rec = Memory._pfCost[key];
  if (rec && (Game.time - rec.t) < PF_CACHE_TTL) {
    return { cost: rec.c, length: rec.l || 0, swamp: rec.s || 0 };
  }
  var meta = pfCost(anchorPos, targetPos);
  Memory._pfCost[key] = { c: meta.cost, l: meta.length, s: meta.swamp, t: Game.time };
  return meta;
}
function pfCost(anchorPos, targetPos) {
  var ret = PathFinder.search(
    anchorPos,
    { pos: targetPos, range: 1 },
    {
      maxOps: MAX_PF_OPS,
      plainCost: PLAIN_COST,
      swampCost: SWAMP_COST,
      roomCallback: function(roomName) {
        var room = Game.rooms[roomName]; if (!room) return;
        var m = new PathFinder.CostMatrix();
        room.find(FIND_STRUCTURES).forEach(function(s){
          if (s.structureType===STRUCTURE_ROAD) m.set(s.pos.x,s.pos.y,1);
          else if (s.structureType!==STRUCTURE_CONTAINER && (s.structureType!==STRUCTURE_RAMPART || !s.my)) m.set(s.pos.x,s.pos.y,0xff);
        });
        room.find(FIND_CONSTRUCTION_SITES).forEach(function(cs){ if (cs.structureType!==STRUCTURE_ROAD) m.set(cs.pos.x,cs.pos.y,0xff); });
        return m;
      }
    }
  );
  if (ret.incomplete) return { cost: Infinity, length: 0, swamp: 0 };
  var swamp = 0;
  var pathLen = ret.path ? ret.path.length : 0;
  if (ret.path) {
    for (var i = 0; i < ret.path.length; i++) {
      var step = ret.path[i];
      if (Game.map.getRoomTerrain(step.roomName).get(step.x, step.y) === TERRAIN_MASK_SWAMP) swamp++;
    }
  }
  return { cost: ret.cost, length: pathLen, swamp: swamp };
}
function go(creep, dest, opts){
  opts = opts || {};
  var desired = (opts.range!=null) ? opts.range : 1;
  if (creep.pos.getRangeTo(dest) <= desired) return;
  var tOpts = {
    range: desired,
    reusePath: (opts.reusePath!=null?opts.reusePath:15),
    ignoreCreeps: true,
    stuckValue: 2,
    repath: 0.05,
    maxOps: 6000
  };
  if (BeeToolbox && BeeToolbox.roomCallback) tOpts.roomCallback = BeeToolbox.roomCallback;
  creep.travelTo((dest.pos||dest), tOpts);
}

// ============================
// Room discovery & anchor
// ============================
function getHomeName(creep){
  if (creep.memory.home) return creep.memory.home;
  var spawns = Object.keys(Game.spawns).map(function(k){return Game.spawns[k];});
  if (spawns.length){
    var best = spawns[0], bestD = BeeToolbox.safeLinearDistance(creep.pos.roomName, best.pos.roomName);
    for (var i=1;i<spawns.length;i++){
      var s=spawns[i], d=BeeToolbox.safeLinearDistance(creep.pos.roomName, s.pos.roomName);
      if (d<bestD){ best=s; bestD=d; }
    }
    creep.memory.home = best.pos.roomName; return creep.memory.home;
  }
  creep.memory.home = creep.pos.roomName; return creep.memory.home;
}
function getAnchorPos(homeName){
  var r = Game.rooms[homeName];
  if (r){
    if (r.storage) return r.storage.pos;
    var spawns = r.find(FIND_MY_SPAWNS); if (spawns.length) return spawns[0].pos;
    if (r.controller && r.controller.my) return r.controller.pos;
  }
  return new RoomPosition(25,25,homeName);
}
function bfsNeighborRooms(startName, radius){
  radius = radius==null?1:radius;
  var seen={}; seen[startName]=true;
  var frontier=[startName];
  for (var depth=0; depth<radius; depth++){
    var next=[];
    for (var f=0; f<frontier.length; f++){
      var rn=frontier[f], exits=Game.map.describeExits(rn)||{};
      for (var dir in exits){ var n=exits[dir]; if(!seen[n]){ seen[n]=true; next.push(n);} }
    }
    frontier=next;
  }
  var out=[]; for (var k in seen) if (k!==startName) out.push(k);
  return out;
}

function homeAllowsNewRemote(homeName){
  var state = { allowed: false, allowNewRoom: false, active: [], activeSet: {} };
  var room = Game.rooms[homeName];
  if (!room || !room.controller || !room.controller.my) return state;
  if (room.controller.level < 4) return state;
  var active = (RoadPlanner && typeof RoadPlanner.getActiveRemoteRooms === 'function')
    ? RoadPlanner.getActiveRemoteRooms(room)
    : [];
  state.active = active;
  var set = {};
  for (var i = 0; i < active.length; i++) { set[active[i]] = true; }
  state.activeSet = set;

  var storageEnergy = room.storage ? (room.storage.store[RESOURCE_ENERGY] || 0) : 0;
  if (!room.storage) {
    _logRemoteThrottle(homeName, storageEnergy, STORAGE_ENERGY_MIN_BEFORE_REMOTES, active.length, MAX_ACTIVE_REMOTES, 'storage');
    return state;
  }
  if (storageEnergy < STORAGE_ENERGY_MIN_BEFORE_REMOTES) {
    _logRemoteThrottle(homeName, storageEnergy, STORAGE_ENERGY_MIN_BEFORE_REMOTES, active.length, MAX_ACTIVE_REMOTES, 'storage');
    return state;
  }

  // Acceptance test: throttle expansion until home milestones + storage energy threshold are satisfied.
  var plan = RoomPlanner && typeof RoomPlanner.plan === 'function' ? RoomPlanner.plan(room) : null;
  if (plan && plan.readyForRemotes === false) return state;

  state.allowed = true;
  state.allowNewRoom = active.length < MAX_ACTIVE_REMOTES;
  if (!state.allowNewRoom) {
    _logRemoteThrottle(homeName, storageEnergy, STORAGE_ENERGY_MIN_BEFORE_REMOTES, active.length, MAX_ACTIVE_REMOTES, 'limit');
  }
  return state;
}

function remoteScore(meta, linear){
  if (!meta) return 999999;
  var score = (meta.length || meta.cost || 9999) * (REMOTE_ROI_WEIGHTING.pathLength || 1);
  score += (meta.swamp || 0) * (REMOTE_ROI_WEIGHTING.swampTiles || 0);
  score += (linear || 0) * 5;
  return score;
}

// ============================
// Flagging helper (sources)
// ============================
function markValidRemoteSourcesForHome(homeName){
  var anchor=getAnchorPos(homeName);
  var memAssign=ensureAssignmentsMem();
  var rooms=bfsNeighborRooms(homeName, REMOTE_RADIUS);

  for (var i=0;i<rooms.length;i++){
    var rn=rooms[i], room=Game.rooms[rn]; if(!room) continue;
    var rm = _roomMem(rn);
    if (rm.hostile) continue;
    var foreign = detectForeignPresence(rn, room, rm);
    if (foreign.avoid){ if (!foreign.memo) markRoomForeignAvoid(rm, foreign.owner, foreign.reason, OTHER_OWNER_AVOID_TTL); continue; }
    if (isRoomLockedByInvaderCore(rn)) continue;

    if (rm._lastValidFlagScan && (Game.time - rm._lastValidFlagScan) < 300) continue;
    rm._lastValidFlagScan = Game.time;

    var sources = room.find(FIND_SOURCES);
    for (var j=0;j<sources.length;j++){
      var s=sources[j];
      var e=_maEnsure(memAssign[s.id], rn);
      if (maCount(memAssign, s.id) >= MAX_LUNA_PER_SOURCE) continue;
      var cost = pfCostCached(anchor, s.pos, s.id); if (cost===Infinity) continue;
      ensureSourceFlag(s);
      // record tile for safer prune compares
      var srec = _sourceMem(rn, s.id); srec.x = s.pos.x; srec.y = s.pos.y;
      memAssign[s.id] = e; // persist shape
    }
  }
}

// ============================
// Invader lock detection
// ============================
function isRoomLockedByInvaderCore(roomName){
  if (!roomName) return false;
  var rm = _roomMem(roomName);
  var now = Game.time, room = Game.rooms[roomName];

  if (room){
    var locked=false;
    var cores = room.find(FIND_STRUCTURES, { filter:function(s){return s.structureType===STRUCTURE_INVADER_CORE;} });
    if (cores && cores.length>0) locked=true;
    if (!locked && room.controller && room.controller.reservation &&
        room.controller.reservation.username==='Invader'){ locked=true; }
    if (!locked && BeeToolbox && BeeToolbox.isRoomInvaderLocked){
      try{ if (BeeToolbox.isRoomInvaderLocked(room)) locked=true; }catch(e){}
    }
    rm._invaderLock = { locked: locked, t: now };
    return locked;
  }

  if (rm._invaderLock && typeof rm._invaderLock.locked==='boolean' && typeof rm._invaderLock.t==='number'){
    if ((now - rm._invaderLock.t) <= INVADER_LOCK_MEMO_TTL) return rm._invaderLock.locked;
  }
  return false;
}

// ============================
// Picking & exclusivity
// ============================
function pickRemoteSource(creep){
  var memAssign = ensureAssignmentsMem();
  var homeName = getHomeName(creep);

  var remoteState = homeAllowsNewRemote(homeName);
  if (!remoteState.allowed) return null;

  if ((Game.time + creep.name.charCodeAt(0)) % 50 === 0) markValidRemoteSourcesForHome(homeName);
  var anchor = getAnchorPos(homeName);

  var neighborRooms = bfsNeighborRooms(homeName, REMOTE_RADIUS);
  var candidates=[], avoided=[], i, rn;

  // 1) With vision
  for (i=0;i<neighborRooms.length;i++){
    rn=neighborRooms[i];
    if (isRoomLockedByInvaderCore(rn)) continue;
    var room=Game.rooms[rn]; if (!room) continue;
    var rm = _roomMem(rn);
    if (rm.hostile) continue;
    var foreign = detectForeignPresence(rn, room, rm);
    if (foreign.avoid){ if (!foreign.memo) markRoomForeignAvoid(rm, foreign.owner, foreign.reason, OTHER_OWNER_AVOID_TTL); continue; }

    var sources = room.find(FIND_SOURCES);
    for (var j=0;j<sources.length;j++){
      var s=sources[j];
      if (!remoteState.allowNewRoom && !remoteState.activeSet[s.pos.roomName]) continue;
      var metaCost = pfCostCached(anchor, s.pos, s.id); if (!metaCost || metaCost.cost===Infinity) continue;
      var lin = BeeToolbox.safeLinearDistance(homeName, rn);
      var score = remoteScore(metaCost, lin);

      if (shouldAvoid(creep, s.id)){
        avoided.push({id:s.id,roomName:rn,cost:metaCost.cost,lin:lin,left:avoidRemaining(creep,s.id),score:score});
        continue;
      }
      // Skip if another owner is active
      var ownerNow = maOwner(memAssign, s.id);
      if (ownerNow && ownerNow !== creep.name) continue;
      if (maCount(memAssign, s.id) >= MAX_LUNA_PER_SOURCE) continue;

      var sticky = (creep.memory.sourceId===s.id) ? 1 : 0;
      candidates.push({ id:s.id, roomName:rn, cost:metaCost.cost, lin:lin, sticky:sticky, score:score });
    }
  }

  // 2) No vision → use Memory.rooms.*.sources
  if (!candidates.length){
    for (i=0;i<neighborRooms.length;i++){
      rn=neighborRooms[i]; if (isRoomLockedByInvaderCore(rn)) continue;
      var rm = _roomMem(rn);
      if (rm.hostile) continue;
      var foreignNV = detectForeignPresence(rn, Game.rooms[rn], rm);
      if (foreignNV.avoid){ if (!foreignNV.memo) markRoomForeignAvoid(rm, foreignNV.owner, foreignNV.reason, OTHER_OWNER_AVOID_TTL); continue; }
      if (!rm.sources) continue;
      for (var sid in rm.sources){
        if (!remoteState.allowNewRoom && !remoteState.activeSet[rn]) continue;
        if (shouldAvoid(creep, sid)){
          avoided.push({id:sid,roomName:rn,cost:1e9,lin:99,left:avoidRemaining(creep,sid),score:scoreNV});
          continue;
        }
        var ownerNow2 = maOwner(memAssign, sid);
        if (ownerNow2 && ownerNow2 !== creep.name) continue;
        if (maCount(memAssign, sid) >= MAX_LUNA_PER_SOURCE) continue;

        var lin2 = BeeToolbox.safeLinearDistance(homeName, rn);
        var synth = (lin2*200)+800;
        var scoreNV = remoteScore({ cost: synth, length: lin2*50, swamp: 0 }, lin2);
        var sticky2 = (creep.memory.sourceId===sid) ? 1 : 0;
        candidates.push({ id:sid, roomName:rn, cost:synth, lin:lin2, sticky:sticky2, score:scoreNV });
      }
    }
  }

  if (!candidates.length){
    if (!avoided.length) return null;
    avoided.sort(function(a,b){ return (a.left-b.left)||((a.score||remoteScore({cost:a.cost,length:a.cost,swamp:0},a.lin))-(b.score||remoteScore({cost:b.cost,length:b.cost,swamp:0},b.lin))); });
    var soonest = avoided[0];
    if (soonest.left <= 5) {
      soonest.sticky = soonest.sticky || 0;
      soonest.score = soonest.score || remoteScore({cost:soonest.cost,length:soonest.cost,swamp:0},soonest.lin);
      candidates.push(soonest);
    } else return null;
  }

  candidates.sort(function(a,b){
    if (b.sticky !== a.sticky) return (b.sticky - a.sticky);
    if (a.score !== b.score) return a.score - b.score;
    return (a.lin-b.lin) || (a.id<b.id?-1:1);
  });

  for (var k=0;k+candidates.length>k;k++){
    var best=candidates[k];
    if (!tryClaimSourceForTick(creep, best.id)) continue;

    // Reserve immediately
    maInc(memAssign, best.id, best.roomName);
    maSetOwner(memAssign, best.id, creep.name, best.roomName);

    if (creep.memory._lastLogSid !== best.id){
      console.log('🧭 '+creep.name+' pick src='+best.id.slice(-6)+' room='+best.roomName+' cost='+best.cost+(best.sticky?' (sticky)':''));
      creep.memory._lastLogSid = best.id;
    }
    return best;
  }

  return null;
}

function releaseAssignment(creep){
  var memAssign = ensureAssignmentsMem();
  var sid = creep.memory.sourceId;

  if (sid){
    maDec(memAssign, sid);
    var owner = maOwner(memAssign, sid);
    if (owner === creep.name) maClearOwner(memAssign, sid);
    markAvoid(creep, sid, AVOID_TTL);
  }

  creep.memory.sourceId   = null;
  creep.memory.targetRoom = null;
  creep.memory.assigned   = false;
  creep.memory._retargetAt = Game.time + RETARGET_COOLDOWN;
  delete creep.memory._lastForeignLog;
}

// If duplicates exist, loser yields this tick (no repick same tick)
function validateExclusiveSource(creep){
  if (!creep.memory || !creep.memory.sourceId) return true;

  var sid = creep.memory.sourceId;
  var memAssign = ensureAssignmentsMem();
  var owner = maOwner(memAssign, sid);

  // If someone else is the recorded owner, we yield
  if (owner && owner !== creep.name){
    releaseAssignment(creep);
    return false;
  }

  // Hard scan in case of races
  var winners=[];
  for (var name in Game.creeps){
    var c=Game.creeps[name];
    if (c && c.memory && c.memory.task==='luna' && c.memory.sourceId===sid){
      winners.push(c);
    }
  }
  if (winners.length <= MAX_LUNA_PER_SOURCE){
    // become/keep owner if none set
    if (!owner) maSetOwner(memAssign, sid, creep.name, creep.memory.targetRoom||null);
    return true;
  }

  winners.sort(function(a,b){
    var at=a.memory._assignTick||0, bt=b.memory._assignTick||0;
    if (at!==bt) return at-bt;
    return a.name<b.name?-1:1;
  });
  var win = winners[0];
  maSetOwner(memAssign, sid, win.name, win.memory.targetRoom||null);

  // If we're not the winner, yield
  if (win.name !== creep.name){
    console.log('🚦 '+creep.name+' yielding duplicate source '+sid.slice(-6)+' (backing off).');
    releaseAssignment(creep);
    return false;
  }
  return true;
}

// ============================
// Main role
// ============================
var TaskLuna = {
  run: function(creep){
    if (!creep) return;
    if (creep.memory && creep.memory.task === 'remoteharvest') {
      creep.memory.task = 'luna';
    }

    auditOncePerTick();

    if (creep.memory && !creep.memory.home) getHomeName(creep);

    if (creep.memory) {
      var lastX = creep.memory._lx | 0;
      var lastY = creep.memory._ly | 0;
      var lastR = creep.memory._lr || '';
      var samePos = (lastX === creep.pos.x && lastY === creep.pos.y && lastR === creep.pos.roomName);
      creep.memory._stuck = samePos ? ((creep.memory._stuck | 0) + 1) : 0;
      creep.memory._lx = creep.pos.x;
      creep.memory._ly = creep.pos.y;
      creep.memory._lr = creep.pos.roomName;
    }

    var state = getLunaState(creep);

    if (creep.ticksToLive !== undefined && creep.ticksToLive < 5 && creep.memory && creep.memory.assigned) {
      releaseAssignment(creep);
      setLunaState(creep, LUNA_STATE.RETIRE, 'lowTTL');
      state = LUNA_STATE.RETIRE;
    }

    if (creep.memory && creep.memory._forceYield) {
      delete creep.memory._forceYield;
      releaseAssignment(creep);
      setLunaState(creep, LUNA_STATE.RECOVER, 'yield');
      state = LUNA_STATE.RECOVER;
    }

    if (creep.memory && creep.memory._retargetAt && Game.time < creep.memory._retargetAt) {
      setLunaState(creep, LUNA_STATE.RECOVER, 'cooldown');
      state = LUNA_STATE.RECOVER;
    }

    switch (state) {
      case LUNA_STATE.INIT:
        this.stepInit(creep);
        break;
      case LUNA_STATE.ACQUIRE:
        this.stepAcquire(creep);
        break;
      case LUNA_STATE.TRAVEL:
        this.stepTravel(creep);
        break;
      case LUNA_STATE.HARVEST:
        this.stepHarvest(creep);
        break;
      case LUNA_STATE.DELIVER:
        this.stepDeliver(creep);
        break;
      case LUNA_STATE.RECOVER:
        this.stepRecover(creep);
        break;
      case LUNA_STATE.RETIRE:
        this.stepRetire(creep);
        break;
      default:
        setLunaState(creep, LUNA_STATE.INIT, 'unknown');
        break;
    }

    if (debugEnabled()) {
      recordCreepDebugInfo(creep, {
        state: LUNA_STATE_DISPLAY[creep.memory.lunaState] || creep.memory.lunaState,
        target: creep.memory && creep.memory.targetRoom,
        load: creep.store ? creep.store.getUsedCapacity(RESOURCE_ENERGY) : null,
        reason: creep.memory._stateReason || null
      });
    }
  },

  stepInit: function(creep) {
    if (!creep || !creep.memory) return;
    creep.memory.returning = false;
    getHomeName(creep);
    setLunaState(creep, LUNA_STATE.ACQUIRE, 'init');
  },

  stepAcquire: function(creep) {
    if (!creep || !creep.memory) return;
    creep.memory.returning = false;

    if (creep.ticksToLive !== undefined && creep.ticksToLive <= 3) {
      releaseAssignment(creep);
      setLunaState(creep, LUNA_STATE.RETIRE, 'aging');
      return;
    }

    if (!creep.memory.sourceId || !creep.memory.targetRoom) {
      var pick = pickRemoteSource(creep);
      if (pick) {
        creep.memory.sourceId = pick.id;
        creep.memory.targetRoom = pick.roomName;
        creep.memory.assigned = true;
        creep.memory._assignTick = Game.time;
      } else {
        this.initializeAndAssign(creep);
        if (!creep.memory.sourceId) {
          creep.memory._retargetAt = Game.time + RETARGET_COOLDOWN;
          setLunaState(creep, LUNA_STATE.RECOVER, 'noSource');
          return;
        }
      }
    }

    if (!creep.memory.targetRoom || !creep.memory.sourceId) {
      setLunaState(creep, LUNA_STATE.RECOVER, 'missingAssign');
      return;
    }

    if (isRoomLockedByInvaderCore(creep.memory.targetRoom)) {
      releaseAssignment(creep);
      creep.memory._retargetAt = Game.time + RETARGET_COOLDOWN;
      setLunaState(creep, LUNA_STATE.RECOVER, 'invaderLock');
      return;
    }

    if (!validateExclusiveSource(creep)) {
      creep.memory._retargetAt = Game.time + RETARGET_COOLDOWN;
      setLunaState(creep, LUNA_STATE.RECOVER, 'duplicate');
      return;
    }

    var targetRoomObj = Game.rooms[creep.memory.targetRoom];
    if (targetRoomObj && BeeToolbox && BeeToolbox.logSourcesInRoom) {
      BeeToolbox.logSourcesInRoom(targetRoomObj);
    }

    var tmem = _roomMem(creep.memory.targetRoom);
    if (tmem && tmem.hostile) {
      releaseAssignment(creep);
      creep.memory._retargetAt = Game.time + RETARGET_COOLDOWN;
      setLunaState(creep, LUNA_STATE.RECOVER, 'hostile');
      return;
    }

    var foreignRun = detectForeignPresence(creep.memory.targetRoom, targetRoomObj, tmem);
    if (foreignRun.avoid) {
      if (!foreignRun.memo) markRoomForeignAvoid(tmem, foreignRun.owner, foreignRun.reason, OTHER_OWNER_AVOID_TTL);
      if (!creep.memory._lastForeignLog || (Game.time - creep.memory._lastForeignLog) >= 10) {
        var reasonNote = foreignRun.reason || 'foreign presence';
        var ownerNote = foreignRun.owner ? (' by ' + foreignRun.owner) : '';
        console.log('⚠️ Forager ' + creep.name + ' avoiding room ' + creep.memory.targetRoom + ' due to ' + reasonNote + ownerNote + '.');
        creep.memory._lastForeignLog = Game.time;
      }
      releaseAssignment(creep);
      creep.memory._retargetAt = Game.time + RETARGET_COOLDOWN;
      setLunaState(creep, LUNA_STATE.RECOVER, 'foreign');
      return;
    }

    var tmemSources = tmem && tmem.sources;
    if (!tmemSources || !tmemSources[creep.memory.sourceId]) {
      delete creep.memory.sourceId;
      setLunaState(creep, LUNA_STATE.ACQUIRE, 'missingSourceMem');
      return;
    }

    var ctl = targetRoomObj && targetRoomObj.controller;
    if (ctl) ensureControllerFlag(ctl);

    if (creep.pos.roomName === creep.memory.targetRoom) {
      setLunaState(creep, LUNA_STATE.HARVEST, 'inRoom');
    } else {
      setLunaState(creep, LUNA_STATE.TRAVEL, 'travel');
    }
  },

  stepTravel: function(creep) {
    if (!creep || !creep.memory) return;
    if (!creep.memory.targetRoom || !creep.memory.sourceId) {
      setLunaState(creep, LUNA_STATE.ACQUIRE, 'lostTarget');
      return;
    }
    if (creep.pos.roomName === creep.memory.targetRoom) {
      setLunaState(creep, LUNA_STATE.HARVEST, 'arrived');
      return;
    }
    go(creep, new RoomPosition(25, 25, creep.memory.targetRoom), { range: 20, reusePath: 20 });
  },

  stepHarvest: function(creep) {
    if (!creep || !creep.memory) return;
    if (!creep.memory.targetRoom || !creep.memory.sourceId) {
      setLunaState(creep, LUNA_STATE.ACQUIRE, 'lostSource');
      return;
    }
    if (creep.store && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
      creep.memory.returning = true;
      setLunaState(creep, LUNA_STATE.DELIVER, 'full');
      return;
    }
    if (creep.pos.roomName !== creep.memory.targetRoom) {
      setLunaState(creep, LUNA_STATE.TRAVEL, 'wrongRoom');
      return;
    }
    if (!validateExclusiveSource(creep)) {
      creep.memory._retargetAt = Game.time + RETARGET_COOLDOWN;
      setLunaState(creep, LUNA_STATE.RECOVER, 'contested');
      return;
    }

    this.harvestSource(creep);

    if (creep.store && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
      creep.memory.returning = true;
      setLunaState(creep, LUNA_STATE.DELIVER, 'full');
    }
  },

  stepDeliver: function(creep) {
    if (!creep || !creep.memory) return;
    if (!creep.store || creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
      creep.memory.returning = false;
      setLunaState(creep, LUNA_STATE.ACQUIRE, 'empty');
      return;
    }
    this.returnToStorage(creep);
  },

  stepRecover: function(creep) {
    if (!creep || !creep.memory) return;
    var home = getHomeName(creep);
    var anchor = getAnchorPos(home);
    go(creep, anchor, { range: 2, reusePath: 10 });
    if (!creep.memory._retargetAt || Game.time >= creep.memory._retargetAt) {
      delete creep.memory._retargetAt;
      setLunaState(creep, LUNA_STATE.ACQUIRE, 'recovered');
    }
  },

  stepRetire: function(creep) {
    if (!creep || !creep.memory) return;
    creep.memory.returning = true;
    if (creep.store && creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
      this.returnToStorage(creep);
    } else {
      var anchor = getAnchorPos(getHomeName(creep));
      go(creep, anchor, { range: 2, reusePath: 15 });
    }
  },

  // ---- Legacy fallback (no vision) — now radius-bounded ----
  getNearbyRoomsWithSources: function(creep){
    var homeName = getHomeName(creep);

    // Build an allowlist with BFS radius (room hops from home)
    var inRadius = {};
    var ring = bfsNeighborRooms(homeName, REMOTE_RADIUS);
    for (var i=0; i<ring.length; i++) inRadius[ring[i]] = true;

    var all = Object.keys(Memory.rooms||{});
    var filtered = all.filter(function(roomName){
      var rm = Memory.rooms[roomName];
      if (!rm || !rm.sources) return false;
      if (!inRadius[roomName]) return false;                 // ★ enforce radius here
      if (rm.hostile) return false;
      var foreign = detectForeignPresence(roomName, Game.rooms[roomName], rm);
      if (foreign.avoid){ if (!foreign.memo) markRoomForeignAvoid(rm, foreign.owner, foreign.reason, OTHER_OWNER_AVOID_TTL); return false; }
      if (isRoomLockedByInvaderCore(roomName)) return false;
      return roomName !== Memory.firstSpawnRoom;
    });

    // Sort by linear distance from home (cheap tiebreaker)
    return filtered.sort(function(a,b){
      return BeeToolbox.safeLinearDistance(homeName, a) - BeeToolbox.safeLinearDistance(homeName, b);
    });
  },

  findRoomWithLeastForagers: function(rooms, homeName){
    if (!rooms || !rooms.length) return null;

    // Guard: enforce radius again (cheap insurance if caller changes later)
    var inRadius = {};
    var ring = bfsNeighborRooms(homeName, REMOTE_RADIUS);
    for (var i=0; i<ring.length; i++) inRadius[ring[i]] = true;

    var best=null, lowest=Infinity;
    for (var j=0;j<rooms.length;j++){
      var rn=rooms[j];
      if (!inRadius[rn]) continue;                 // ★ radius fence
      if (isRoomLockedByInvaderCore(rn)) continue;

      var rm=_roomMem(rn);
      if (rm.hostile) continue;
      var foreign = detectForeignPresence(rn, Game.rooms[rn], rm);
      if (foreign.avoid){ if (!foreign.memo) markRoomForeignAvoid(rm, foreign.owner, foreign.reason, OTHER_OWNER_AVOID_TTL); continue; }
      var sources = rm.sources?Object.keys(rm.sources):[]; if (!sources.length) continue;

      var count=0;
      for (var name in Game.creeps){
        var c=Game.creeps[name];
        if (c && c.memory && c.memory.task==='luna' && c.memory.targetRoom===rn) count++;
      }
      var avg = count / Math.max(1,sources.length);
      if (avg < lowest){ lowest=avg; best=rn; }
    }
    return best;
  },

  initializeAndAssign: function(creep){
    var homeName = getHomeName(creep);
    var remoteState = homeAllowsNewRemote(homeName);
    if (!remoteState.allowed) return;
    var targetRooms = this.getNearbyRoomsWithSources(creep);
    if (!remoteState.allowNewRoom) {
      var filtered = [];
      for (var i = 0; i < targetRooms.length; i++) {
        var rn = targetRooms[i];
        if (remoteState.activeSet[rn]) filtered.push(rn);
      }
      targetRooms = filtered;
    }
    if (!creep.memory.targetRoom || !creep.memory.sourceId){
      var least = this.findRoomWithLeastForagers(targetRooms, homeName);
      if (!least){ if (Game.time%25===0) console.log('🚫 Forager '+creep.name+' found no suitable room with unclaimed sources.'); return; }
      creep.memory.targetRoom = least;

      var roomMemory = _roomMem(creep.memory.targetRoom);
      var sid = this.assignSource(creep, roomMemory);
      if (sid){
        creep.memory.sourceId = sid;
        creep.memory.assigned = true;
        creep.memory._assignTick = Game.time;

        var memAssign = ensureAssignmentsMem();
        maInc(memAssign, sid, creep.memory.targetRoom);
        maSetOwner(memAssign, sid, creep.name, creep.memory.targetRoom);

        if (creep.memory._lastLogSid !== sid){
          console.log('🐝 '+creep.name+' assigned to source: '+sid+' in '+creep.memory.targetRoom);
          creep.memory._lastLogSid = sid;
        }
      }else{
        if (Game.time%25===0) console.log('No available sources for creep: '+creep.name);
        creep.memory.targetRoom=null; creep.memory.sourceId=null;
      }
    }
  },

  assignSource: function(creep, roomMemory){
    if (!roomMemory || !roomMemory.sources) return null;
    var sids = Object.keys(roomMemory.sources); if (!sids.length) return null;

    var memAssign = ensureAssignmentsMem();
    // Prefer free → then sticky (self) → finally any
    var free=[], sticky=[], rest=[];
    for (var i=0;i<sids.length;i++){
      var sid=sids[i];
      var owner = maOwner(memAssign, sid);
      var cnt   = maCount(memAssign, sid);
      if (owner && owner !== creep.name) continue;           // taken
      if (cnt >= MAX_LUNA_PER_SOURCE) continue;          // full

      if (creep.memory.sourceId===sid) sticky.push(sid);
      else if (!owner) free.push(sid);
      else rest.push(sid);
    }

    var pick = free[0] || sticky[0] || rest[0] || null;
    if (!pick) return null;

    if (!tryClaimSourceForTick(creep, pick)) return null; // rare
    return pick;
  },

  updateReturnState: function(creep){
    if (!creep.memory.returning && creep.store.getFreeCapacity(RESOURCE_ENERGY)===0) creep.memory.returning=true;
    if (creep.memory.returning && creep.store.getUsedCapacity(RESOURCE_ENERGY)===0) creep.memory.returning=false;
  },

  returnToStorage: function(creep){
    var homeName=getHomeName(creep);
    if (creep.room.name !== homeName){ go(creep,new RoomPosition(25,25,homeName),{range:20,reusePath:20}); return; }

    var pri=creep.room.find(FIND_STRUCTURES,{filter:function(s){
      return (s.structureType===STRUCTURE_EXTENSION || s.structureType===STRUCTURE_SPAWN) &&
             s.store && s.store.getFreeCapacity(RESOURCE_ENERGY)>0; }});
    if (pri.length){ var a=creep.pos.findClosestByPath(pri); if (a){ var rc=creep.transfer(a,RESOURCE_ENERGY); if (rc===ERR_NOT_IN_RANGE) go(creep,a); return; } }

    var stor=creep.room.storage;
    if (stor && stor.store && stor.store.getFreeCapacity(RESOURCE_ENERGY)>0){ var rc2=creep.transfer(stor,RESOURCE_ENERGY); if (rc2===ERR_NOT_IN_RANGE) go(creep,stor); return; }

    var conts=creep.room.find(FIND_STRUCTURES,{filter:function(s){ return s.structureType===STRUCTURE_CONTAINER && s.store && s.store.getFreeCapacity(RESOURCE_ENERGY)>0; }});
    if (conts.length){ var b=creep.pos.findClosestByPath(conts); if (b){ var rc3=creep.transfer(b,RESOURCE_ENERGY); if (rc3===ERR_NOT_IN_RANGE) go(creep,b); return; } }

    var anchor=getAnchorPos(homeName); go(creep,anchor,{range:2});
  },

  harvestSource: function(creep){
    if (!creep.memory.targetRoom || !creep.memory.sourceId){
      if (Game.time%25===0) console.log('Forager '+creep.name+' missing targetRoom/sourceId'); return;
    }

    if (creep.room.name !== creep.memory.targetRoom){
      go(creep,new RoomPosition(25,25,creep.memory.targetRoom),{range:20,reusePath:20}); return;
    }

    if (isRoomLockedByInvaderCore(creep.room.name)){
      console.log('⛔ '+creep.name+' bailing from locked room '+creep.room.name+'.');
      releaseAssignment(creep); return;
    }

    var sid = creep.memory.sourceId;
    var src = Game.getObjectById(sid);
    if (!src){ if (Game.time%25===0) console.log('Source not found for '+creep.name); releaseAssignment(creep); return; }

    ensureSourceFlag(src); // will touch lastActive
    // also remember tile for safer prune compare
    var srec = _sourceMem(creep.room.name, sid); srec.x = src.pos.x; srec.y = src.pos.y;

    // NEW: keep controller flag fresh while active in the room
    if (creep.room.controller) ensureControllerFlag(creep.room.controller);

    var rm = _roomMem(creep.memory.targetRoom);
    rm.sources = rm.sources || {};
    if (rm.sources[sid] && rm.sources[sid].entrySteps == null){
      var res = PathFinder.search(creep.pos, { pos: src.pos, range: 1 }, { plainCost: PLAIN_COST, swampCost: SWAMP_COST, maxOps: MAX_PF_OPS });
      if (!res.incomplete) rm.sources[sid].entrySteps = res.path.length;
    }

    if ((creep.memory._stuck|0) >= STUCK_WINDOW){ go(creep, src, { range:1, reusePath:3 }); creep.say('🚧'); }

    var rc = creep.harvest(src);
    if (rc===ERR_NOT_IN_RANGE) go(creep, src, { range:1, reusePath:15 });
    else if (rc===OK){
      // harvesting is also activity
      touchSourceActive(creep.room.name, sid);
    }
  },

  planSpawnForRoom: function(spawn, context) {
    return planSpawnForRoom(spawn, context);
  },

  spawnFromPlan: function(spawn, plan) {
    return spawnFromPlan(spawn, plan);
  },

  noteSpawnBlocked: function(homeName, reason, nextAttempt, availableEnergy, capacityEnergy) {
    noteSpawnBlocked(homeName, reason, nextAttempt, availableEnergy, capacityEnergy);
  }
};

TaskLuna.MAX_LUNA_PER_SOURCE = MAX_LUNA_PER_SOURCE;

module.exports = TaskLuna;
