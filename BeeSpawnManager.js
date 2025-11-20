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

var spawnLogic  = require('spawn.logic');
var roleBeeWorker = require('role.BeeWorker');
var BeeCombatSquads = require('BeeCombatSquads');
var SquadFlagIntel = BeeCombatSquads.SquadFlagIntel || null;

// --------------------------- Tunables & Constants ------------------------
var QUEUE_RETRY_COOLDOWN  = 5;
var QUEUE_HARD_LIMIT      = 20;
var DEBUG_SPAWN_QUEUE     = true;
var DBG_EVERY             = 5;
var INVADER_LOCK_TTL      = 1500;

var ROLE_PRIORITY = {
  baseharvest: 100,
  courier:      95,
  queen:        90,
  upgrader:     80,
  builder:      75,
  luna:         70,
  repair:       60,
  Claimer:      55,
  scout:        40,
  Trucker:      35,
  Dismantler:   30,
  CombatArcher: 25,
  CombatMelee:  25,
  CombatMedic:  25
};

var ROLE_MIN_ENERGY = {
  baseharvest: 200,
  courier:     150,
  queen:       200,
  upgrader:    200,
  builder:     200,
  luna:        250,
  repair:      200,
  Claimer:     650,
  scout:       50,
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
  var available = room.energyAvailable | 0;
  var capacity = room.energyCapacityAvailable | 0;
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
    var active = (canonical === 'Luna')
      ? ((C.lunaCountsByHome && C.lunaCountsByHome[roomName]) | 0)
      : (C.roleCounts[canonical] | 0);
    remaining[role] = Math.max(0, (quotas[role] | 0) - active);
  }

  var kept = [];
  var used = Object.create(null);
  for (var j = 0; j < q.length; j++) {
    var it = q[j];
    if (!it) continue;
    var left = remaining[it.role] | 0;
    var usedSoFar = used[it.role] | 0;
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

// Novice tip: keep state lookups tiny helpers so you can audit each role's math.
function activeCountForRole(C, role, roomName) {
  var canonical = canonicalRole(role);
  if (canonical === 'Luna') {
    return (C.lunaCountsByHome && C.lunaCountsByHome[roomName]) | 0;
  }
  return C.roleCounts[canonical] | 0;
}

function roleDeficit(C, roomName, role, limit) {
  var active = activeCountForRole(C, role, roomName);
  var queued = queuedCount(roomName, role);
  return Math.max(0, (limit | 0) - active - queued);
}

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
  var need = (local + remoteTotal) > 0 ? 2 : 0;
  if (tickEvery(DBG_EVERY)) {
    dlog('🧱 [Signal] builderNeed', fmt(room), 'local=', local, 'remote=', remoteTotal, '->', need);
  }
  return need;
}

function determineLunaQuota(C, room) {
  if (!room) return 0;
  var remotes = C.remotesByHome[room.name] || [];
  if (!remotes.length) return 0;

  var remoteSet = Object.create(null);
  for (var i = 0; i < remotes.length; i++) {
    remoteSet[remotes[i]] = true;
  }

  var roomsMem = Memory.rooms || {};
  var perSource = (roleBeeWorker && roleBeeWorker.Luna && roleBeeWorker.Luna.MAX_LUNA_PER_SOURCE) || 1;

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
      srcCount = mem.intel.sources | 0;
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
  return desired;
}

function computeRoomQuotas(C, room) {
  // Teaching habit: start with conservative defaults, then patch in signals
  // (builder need, remote miners, etc.) so every change is a single diff.
  var quotas = {
    baseharvest:  2,
    courier:      1,
    queen:        1,
    upgrader:     2,
    builder:      getBuilderNeed(C, room),
    scout:        1,
    luna:         4,
    repair:       0,
    Trucker:      0,
    Claimer:      1,
  };
  if (tickEvery(DBG_EVERY)) {
    dlog('🎯 [Quotas]', fmt(room), JSON.stringify(quotas));
  }
  return quotas;
}

function fillQueueForRoom(C, room) {
  var quotas = computeRoomQuotas(C, room);
  var roomName = room.name;

  pruneOverfilledQueue(roomName, quotas, C);

  // Iterate quotas in plain English order so future maintainers can eyeball
  // which roles will be enqueued before touching the code.
  var roles = Object.keys(quotas);
  for (var i = 0; i < roles.length; i++) {
    var role = roles[i];
    var limit = quotas[role] | 0;
    var deficit = roleDeficit(C, roomName, role, limit);
    if (deficit > 0 && tickEvery(DBG_EVERY)) {
      var active = activeCountForRole(C, role, roomName);
      var queued = queuedCount(roomName, role);
      dlog('📥 [Queue]', roomName, 'role=', role, 'limit=', limit,
        'active=', active, 'queued=', queued, 'deficit=', deficit);
    }
    for (var j = 0; j < deficit; j++) {
      enqueue(roomName, role);
    }
  }
}

function dequeueAndSpawn(spawner) {
  if (!spawner || spawner.spawning) return false;
  var room = spawner.room;
  var roomName = room.name;
  var q = ensureRoomQueue(roomName);
  if (!q.length) {
    if (tickEvery(DBG_EVERY)) {
      dlog('🕳️ [Queue]', roomName, 'empty (energy', energyStatus(room) + ')');
    }
    return false;
  }

  q.sort(compareQueueItems);

  var headPriority = q[0].priority;
  var headRole = q[0].role;

  var needed = minEnergyFor(headRole);
  if ((room.energyAvailable | 0) < needed) {
    if (tickEvery(DBG_EVERY)) {
      dlog('⛽ [QueueHold]', roomName, 'prio', headPriority, 'role', headRole,
        'need', needed, 'have', room.energyAvailable);
    }
    return false;
  }

  var pickIndex = -1;
  for (var i = 0; i < q.length; i++) {
    var it = q[i];
    if (!it) continue;
    if (it.priority !== headPriority) {
      break;
    }
    if (it.retryAt && Game.time < it.retryAt) {
      continue;
    }
    pickIndex = i;
    break;
  }
  if (pickIndex === -1) {
    if (tickEvery(DBG_EVERY)) {
      dlog('⏸️ [Queue]', roomName, 'head priority cooling down');
    }
    return false;
  }

  var item = q[pickIndex];
  dlog('🎬 [SpawnTry]', roomName, 'role=', item.role, 'prio=', item.priority,
    'age=', (Game.time - item.created), 'energy=', energyStatus(room));

  // Calculate_Spawn_Resource lets us centralize "what counts as energy" logic
  // (spawns-only vs room energy) without duplicating it inside every manager.
  var spawnResource = null;
  if (spawnLogic && typeof spawnLogic.Calculate_Spawn_Resource === 'function') {
    spawnResource = spawnLogic.Calculate_Spawn_Resource(spawner);
  }

  var ok = false;
  if (spawnLogic && typeof spawnLogic.spawnRole === 'function') {
    ok = spawnLogic.spawnRole(spawner, item.role, spawnResource, item);
  }

  if (ok) {
    dlog('✅ [SpawnOK]', roomName, 'spawned', item.role, 'at', spawner.name);
    q.splice(pickIndex, 1);
    return true;
  }

  item.retryAt = Game.time + QUEUE_RETRY_COOLDOWN;
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
