// -----------------------------------------------------------------------------
// BeeHiveMind.js – global orchestrator for each Screeps tick
// Responsibilities:
// * Prepares per-tick caches (rooms, creeps, selectors) and exposes them to
//   task/role modules.
// * Manages per-room spawn queues, enforcing quotas and energy gates.
// * Dispatches creep roles (including Task.Queen via role assignments) after
//   initialising movement and visuals.
// * Triggers auxiliary systems (Trade.Energy, planners) at deterministic points.
// Data touched:
// * global.__BHM.* (tick caches shared with BeeSelectors, Task modules).
// * Memory.rooms[roomName].spawnQueue (array of spawn jobs).
// * creep.memory.task/role for implicit task assignment.
// Entry point: main.js requires BeeHiveMind and calls run() once per tick.
// -----------------------------------------------------------------------------
'use strict';

/**
 * BeeHiveMind – tick orchestrator (with spawn queue + debug breadcrumbs)
 * Readability-first refactor: same strategy, clearer structure & comments.
 */

// ----------------------------- Dependencies -----------------------------
var CoreLogger          = require('core.logger');      // Logging utility (core.logger.js)
var LOG_LEVEL           = CoreLogger.LOG_LEVEL;
var hiveLog             = CoreLogger.createLogger('HiveMind', LOG_LEVEL.BASIC);

var BeeVisualsSpawnPanel = require('BeeVisuals.SpawnPanel'); // UI overlay for spawn queues
var BeeSelectors         = require('BeeSelectors');
var BeeActions           = require('BeeActions');
var MovementManager      = require('Movement.Manager');
var spawnLogic           = require('spawn.logic');          // Contains body plans and spawn helpers
var roleWorker_Bee       = require('role.Worker_Bee');
var TaskBuilder          = require('Task.Builder');         // kept for your ecosystem
var RoomPlanner          = require('Planner.Room');
var RoadPlanner          = require('Planner.Road');
var TradeEnergy          = require('Trade.Energy');
var TaskLuna             = require('Task.Luna');

// Map role -> run fn (extend as you add roles)
// Default role map; specific roles (queen, courier etc.) may be registered
// elsewhere by mutating this object.
var creepRoles = { Worker_Bee: roleWorker_Bee.run };

// --------------------------- Tunables & Constants ------------------------
// Grouped knobs to make strategy tweaks easy to find.
var DYING_SOON_TTL        = 60;     // Skip creeps about to expire when counting quotas
var INVADER_LOCK_TTL      = 1500;   // Mem lock suppression window for remotes

// --- Spawn Queue knobs ---
var QUEUE_RETRY_COOLDOWN  = 5;      // ticks to wait before retrying a failed queue item
var QUEUE_HARD_LIMIT      = 20;     // per-room queue sanity cap

// --- Debug knobs ---
var DEBUG_SPAWN_QUEUE     = true;   // flip to false to silence most debug
var DBG_EVERY             = 5;      // periodic summaries every N ticks

// Role priorities (higher spawns first; tweak to taste)
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

/** -----------------------------------------------------------------------
 *  Minimal energy per role (used to "lock the head" of the queue).
 *  If the top-priority role isn't affordable yet, we WAIT instead of letting
 *  lower priorities jump ahead.
 *  --------------------------------------------------------------------- */
var ROLE_MIN_ENERGY = {
  baseharvest: 200,   // WORK+CARRY+MOVE (adjust to your tiers)
  courier:     150,
  queen:       200,
  upgrader:    200,
  builder:     200,
  luna:        250,   // starter remote miner
  repair:      200,
  Claimer:     650,   // CLAIM+MOVE
  scout:       50,
  Trucker:     200,
  Dismantler:  150,
  CombatArcher:200,
  CombatMelee: 200,
  CombatMedic: 200
};

// Function header: minEnergyFor(role)
// Inputs: role string
// Output: minimum energy threshold before spawning role (spawnLogic override or fallback table).
// Side-effects: none.
function minEnergyFor(role) {
  if (spawnLogic && typeof spawnLogic.minEnergyFor === 'function') {
    var override = spawnLogic.minEnergyFor(role);
    if (typeof override === 'number') {
      return override;
    }
  }
  return ROLE_MIN_ENERGY[role] || 200;
}

// --------------------------- Global Tick Cache ---------------------------
if (!global.__BHM) global.__BHM = {};

// Tick cache fields populated each tick:
// global.__BHM = {
//   tick, roomsOwned, roomsMap, roomSnapshots,
//   spawns, creeps, roleCounts, lunaCountsByHome,
//   roomSiteCounts, totalSites, remotesByHome
// }.

// Function header: objectValues(obj)
// Inputs: plain object
// Output: array of own enumerable property values (ES5-compatible Object.values replacement).
function objectValues(obj) {
  var values = [];
  if (!obj) return values;
  for (var key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      values.push(obj[key]);
    }
  }
  return values;
}

// Function header: prepareTickCaches()
// Inputs: none
// Output: populated global.__BHM cache for this tick (rooms, spawns, counts, selectors).
// Side-effects: mutates global.__BHM; calls BeeSelectors.prepareRoomSnapshot for each owned room.
function prepareTickCaches() {
  var C = global.__BHM;
  var now = Game.time;
  if (C.tick === now) return C;

  C.tick = now;
  C.roomsOwned       = getOwnedRooms();
  C.roomsMap         = indexByName(C.roomsOwned);
  C.roomSnapshots    = Object.create(null);
  C.spawns           = getAllSpawns();

  var creepScan      = buildCreepAndRoleCounts();
  C.creeps           = creepScan.creeps;
  C.roleCounts       = creepScan.roleCounts;
  C.lunaCountsByHome = creepScan.lunaCountsByHome;

  var sites          = computeConstructionSiteCounts();
  C.roomSiteCounts   = sites.byRoom;
  C.totalSites       = sites.total;

  C.remotesByHome    = computeRemotesByHome(C.roomsOwned);

  if (BeeSelectors && typeof BeeSelectors.prepareRoomSnapshot === 'function') {
    var owned = C.roomsOwned;
    for (var i = 0; i < owned.length; i++) {
      var room = owned[i];
      if (!room || !room.name) continue;
      try {
        C.roomSnapshots[room.name] = BeeSelectors.prepareRoomSnapshot(room);
      } catch (err) {
        hiveLog.debug('⚠️ Selector snapshot failed for', fmt(room), err);
      }
    }
  }

  return C;
}

// Function header: getOwnedRooms()
// Inputs: none
// Output: array of rooms where controller.my === true (visibility dependent).
function getOwnedRooms() {
  var result = [];
  var names = Object.keys(Game.rooms);
  for (var i = 0; i < names.length; i++) {
    var room = Game.rooms[names[i]];
    if (room && room.controller && room.controller.my) {
      result.push(room);
    }
  }
  return result;
}

// Function header: indexByName(rooms)
// Inputs: array of Room objects
// Output: object mapping room.name to Room instance.
function indexByName(rooms) {
  var map = {};
  for (var i = 0; i < rooms.length; i++) {
    var room = rooms[i];
    map[room.name] = room;
  }
  return map;
}

// Function header: getAllSpawns()
// Inputs: none
// Output: array of owned StructureSpawn instances (from Game.spawns values).
function getAllSpawns() {
  return objectValues(Game.spawns);
}

// Function header: buildCreepAndRoleCounts()
// Inputs: none
// Output: {creeps, roleCounts, lunaCountsByHome}; excludes soon-to-expire creeps.
// Side-effects: rewrites creep.memory.task 'remoteharvest' -> 'luna' for consistency.
function buildCreepAndRoleCounts() {
  var creeps = [];
  var roleCounts = Object.create(null);
  var lunaCountsByHome = Object.create(null);

  var names = Object.keys(Game.creeps);
  for (var i = 0; i < names.length; i++) {
    var creep = Game.creeps[names[i]];
    creeps.push(creep);

    // Avoid counting expiring creeps against quotas
    var ttl = creep.ticksToLive;
    if (typeof ttl === 'number' && ttl <= DYING_SOON_TTL) {
      continue;
    }

    // Normalize task
    var task = creep.memory && creep.memory.task;
    if (task === 'remoteharvest' && creep.memory) {
      task = 'luna';
      creep.memory.task = 'luna';
    }
    if (!task) {
      continue;
    }

    roleCounts[task] = (roleCounts[task] || 0) + 1;

    if (task === 'luna') {
      var home = (creep.memory && creep.memory.home) || null;
      if (!home && creep.memory && creep.memory._home) home = creep.memory._home;
      if (!home && creep.room) home = creep.room.name;
      if (home) {
        lunaCountsByHome[home] = (lunaCountsByHome[home] || 0) + 1;
      }
    }
  }

  return { creeps: creeps, roleCounts: roleCounts, lunaCountsByHome: lunaCountsByHome };
}

// Function header: computeConstructionSiteCounts()
// Inputs: none
// Output: {byRoom, total} for owned construction sites (Game.constructionSites snapshot).
function computeConstructionSiteCounts() {
  var byRoom = Object.create(null);
  var total = 0;
  var sites = objectValues(Game.constructionSites);
  for (var i = 0; i < sites.length; i++) {
    var site = sites[i];
    if (!site || !site.my) continue;
    total += 1;
    var rn = site.pos && site.pos.roomName;
    if (rn) {
      byRoom[rn] = (byRoom[rn] || 0) + 1;
    }
  }
  return { byRoom: byRoom, total: total };
}

// Function header: computeRemotesByHome(ownedRooms)
// Inputs: array of owned rooms
// Output: map of home room name -> active remote room list (from RoadPlanner).
function computeRemotesByHome(ownedRooms) {
  var out = Object.create(null);
  var hasHelper = RoadPlanner && typeof RoadPlanner.getActiveRemoteRooms === 'function';
  if (!hasHelper) return out;
  for (var i = 0; i < ownedRooms.length; i++) {
    var home = ownedRooms[i];
    out[home.name] = RoadPlanner.getActiveRemoteRooms(home) || [];
  }
  return out;
}

// ------------------------------ Debug utils ------------------------------
// Function header: tickEvery(n)
// Inputs: integer interval n
// Output: boolean true when Game.time modulo n equals zero (used to rate-limit logs).
function tickEvery(n) {
  return Game.time % n === 0;
}

// Function header: dlog(...args)
// Inputs: arbitrary debug payload
// Output: none; routes to hiveLog when DEBUG_SPAWN_QUEUE enabled.
function dlog() {
  if (!DEBUG_SPAWN_QUEUE) return;
  try {
    hiveLog.debug.apply(hiveLog, arguments);
  } catch (e) {
    // swallow logging errors in production
  }
}

// Function header: fmt(room)
// Inputs: Room instance or name
// Output: string representation for logs.
function fmt(room) {
  return room && room.name ? room.name : String(room);
}

// Function header: energyStatus(room)
// Inputs: Room object
// Output: "available/capacity" string snapshot of energy.
function energyStatus(room) {
  var available = room.energyAvailable | 0;
  var capacity = room.energyCapacityAvailable | 0;
  return available + '/' + capacity;
}

// ------------------------------ Spawn Queue ------------------------------
// Queue item shape (stored in Memory.rooms[room].spawnQueue):
// { role, home, created, priority, retryAt, ...opts }

// Function header: ensureRoomQueue(roomName)
// Inputs: owned room name
// Output: spawn queue array from Memory.rooms[roomName].spawnQueue (initialised if missing).
// Side-effects: creates Memory.rooms and queue array when absent.
function ensureRoomQueue(roomName) {
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
  if (!Array.isArray(Memory.rooms[roomName].spawnQueue)) {
    Memory.rooms[roomName].spawnQueue = [];
  }
  return Memory.rooms[roomName].spawnQueue;
}

// Function header: queuedCount(roomName, role)
// Inputs: roomName string, role string
// Output: number of queue entries with matching role.
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

// Function header: enqueue(roomName, role, opts)
// Inputs: room name, role key, optional metadata (body, flags)
// Output: true when enqueued, false when queue already at QUEUE_HARD_LIMIT.
// Side-effects: pushes to Memory queue and logs.
function enqueue(roomName, role, opts) {
  var q = ensureRoomQueue(roomName);
  if (q.length >= QUEUE_HARD_LIMIT) {
    dlog('🐝 [Queue]', roomName, 'queue full (', q.length, '/', QUEUE_HARD_LIMIT, '), skip enqueue of', role);
    return false;
  }

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

// Function header: compareQueueItems(a, b)
// Inputs: queue items a/b
// Output: sorting order (higher priority first, then oldest).
function compareQueueItems(a, b) {
  var priorityDiff = (b.priority - a.priority) || 0;
  if (priorityDiff !== 0) return priorityDiff;
  return (a.created - b.created) || 0;
}

// Function header: pruneOverfilledQueue(roomName, quotas, C)
// Inputs: roomName string, quotas map, tick cache C
// Output: none; compacts queue to respect remaining quota space.
// Side-effects: replaces Memory queue with kept entries; logs summary.
function pruneOverfilledQueue(roomName, quotas, C) {
  var q = ensureRoomQueue(roomName);
  var before = q.length;

  // Highest priority first, then oldest
  q.sort(compareQueueItems);

  // Allowed remaining per role = quota - active
  var remaining = {};
  var quotaRoles = Object.keys(quotas);
  for (var i = 0; i < quotaRoles.length; i++) {
    var role = quotaRoles[i];
    var active = (role === 'luna')
      ? ((C.lunaCountsByHome && C.lunaCountsByHome[roomName]) | 0)
      : (C.roleCounts[role] | 0);
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
  Memory.rooms[roomName].spawnQueue = kept; // Persist trimmed queue back to Memory.rooms[roomName].spawnQueue.

  var dropped = before - kept.length;
  if (dropped > 0 || tickEvery(DBG_EVERY)) {
    dlog('🧹 [Queue]', roomName, 'prune:',
      'before=', before, 'kept=', kept.length, 'dropped=', dropped,
      'remaining=', JSON.stringify(remaining));
  }
}

// Signals
// Function header: getBuilderNeed(C, room)
// Inputs: tick cache C, owned room
// Output: 1 when there are construction sites locally or in attached remotes; 0 otherwise.
// Side-effects: emits debug log every DBG_EVERY ticks.
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

// Function header: determineLunaQuota(C, room)
// Inputs: tick cache C, owned room
// Output: desired remote miner count based on remote intel and active assignments.
// Side-effects: reads Memory.remoteAssignments, Memory.rooms.* locks.
function determineLunaQuota(C, room) {
  if (!room) return 0;
  var remotes = C.remotesByHome[room.name] || [];
  if (!remotes.length) return 0;

  var remoteSet = Object.create(null);
  for (var i = 0; i < remotes.length; i++) {
    remoteSet[remotes[i]] = true;
  }

  var roomsMem = Memory.rooms || {};
  var perSource = (TaskLuna && TaskLuna.MAX_LUNA_PER_SOURCE) || 1;

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

  // Never below current active assignments
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

// Per-room quota policy (tweak here to change strategy)
// Function header: computeRoomQuotas(C, room)
// Inputs: tick cache C, owned room
// Output: quotas object for spawn queue planning.
// Side-effects: debug logging every DBG_EVERY ticks.
function computeRoomQuotas(C, room) {
  var quotas = {
    baseharvest:  2,
    courier:      1,
    queen:        1,
    upgrader:     2,
    builder:      getBuilderNeed(C, room),
    scout:        1,
    // Switch to determineLunaQuota(C, room) when you're ready:
    luna:         2, // determineLunaQuota(C, room),
    repair:       0,
    CombatArcher: 0,
    CombatMelee:  0,
    CombatMedic:  0,
    Dismantler:   0,
    Trucker:      0,
    Claimer:      0
  };
  if (tickEvery(DBG_EVERY)) {
    dlog('🎯 [Quotas]', fmt(room), JSON.stringify(quotas));
  }
  return quotas;
}

// Fill queue with deficits (active + queued < quota)
// Function header: fillQueueForRoom(C, room)
// Inputs: tick cache C, owned room
// Output: none; reconciles queue with quotas and enqueues deficits.
function fillQueueForRoom(C, room) {
  var quotas = computeRoomQuotas(C, room);
  var roomName = room.name;

  // Optional: enable dynamic Luna
  // quotas.luna = determineLunaQuota(C, room);

  // Reconcile/drop surplus first
  pruneOverfilledQueue(roomName, quotas, C);

  var roles = Object.keys(quotas);
  for (var i = 0; i < roles.length; i++) {
    var role = roles[i];
    var limit = quotas[role] | 0;
    var active = (role === 'luna')
      ? ((C.lunaCountsByHome && C.lunaCountsByHome[roomName]) | 0)
      : (C.roleCounts[role] | 0);
    var queued = queuedCount(roomName, role);
    var deficit = Math.max(0, limit - active - queued);

    if (deficit > 0 && tickEvery(DBG_EVERY)) {
      dlog('📥 [Queue]', roomName, 'role=', role, 'limit=', limit,
        'active=', active, 'queued=', queued, 'deficit=', deficit);
    }
    for (var j = 0; j < deficit; j++) {
      enqueue(roomName, role);
    }
  }
}

/** -----------------------------------------------------------------------
 *  Dequeue strategy: priority barrier + energy gate.
 *  - Sort queue (prio desc, then oldest)
 *  - Only consider items with the current HIGHEST priority
 *  - If room energy < min for that priority, WAIT (don’t look at lower priorities)
 *  - Otherwise spawn the oldest eligible item at that priority
 *  --------------------------------------------------------------------- */
// Function header: dequeueAndSpawn(spawner)
// Inputs: StructureSpawn spawner
// Output: true when spawn succeeds, false otherwise (including energy holds and cooldown waits).
// Side-effects: sorts and mutates Memory spawn queue, calls spawnLogic.Spawn_Worker_Bee, sets retryAt.
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

  // Highest priority first, then oldest
  q.sort(compareQueueItems);

  // Establish the head priority (barrier)
  var headPriority = q[0].priority;
  var headRole = q[0].role;

  // Energy gate: if we can't afford the head priority, HOLD
  var needed = minEnergyFor(headRole);
  if ((room.energyAvailable | 0) < needed) {
    if (tickEvery(DBG_EVERY)) {
      dlog('⛽ [QueueHold]', roomName, 'prio', headPriority, 'role', headRole,
        'need', needed, 'have', room.energyAvailable);
    }
    return false;
  }

  // Oldest, not-cooling-down item at the head priority
  var pickIndex = -1;
  for (var i = 0; i < q.length; i++) {
    var it = q[i];
    if (!it) continue;
    if (it.priority !== headPriority) {
      break; // stop once we leave the head block
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

  var spawnResource = null;
  if (spawnLogic && typeof spawnLogic.Calculate_Spawn_Resource === 'function') {
    spawnResource = spawnLogic.Calculate_Spawn_Resource(spawner);
  }

  var ok = false;
  if (spawnLogic && typeof spawnLogic.Spawn_Worker_Bee === 'function') {
    ok = spawnLogic.Spawn_Worker_Bee(spawner, item.role, spawnResource, item);
  }

  if (ok) {
    dlog('✅ [SpawnOK]', roomName, 'spawned', item.role, 'at', spawner.name);
    q.splice(pickIndex, 1);
    return true;
  }

  // Only back-off if we *could afford it* but still failed (e.g., name collision)
  item.retryAt = Game.time + QUEUE_RETRY_COOLDOWN;
  dlog('⏳ [SpawnWait]', roomName, item.role, 'backoff to', item.retryAt,
    '(energy', energyStatus(room) + ')');
  return false; // one attempt per spawn per tick
}

// ------------------------------ Main Module ------------------------------
var BeeHiveMind = {
  /** Top-level tick entrypoint. */
  // Function header: run()
  // Inputs: none
  // Output: none; orchestrates tick: memory init → visuals → caches → rooms → creeps → movement → spawns → trade.
  // Side-effects: updates global.__BHM, Memory rooms, MovementManager state.
  run: function run() {
    BeeHiveMind.initializeMemory();

    // Expose action/selectors globally for console debugging and legacy modules
    // expecting global symbols.
    if (BeeActions) global.BeeActions = BeeActions;
    if (BeeSelectors) global.BeeSelectors = BeeSelectors;

    if (MovementManager && typeof MovementManager.startTick === 'function') {
      // Reset movement queue before any role enqueues requests.
      MovementManager.startTick();
    }

    // Visual overlays (spawn HUD + queue)
    if (BeeVisualsSpawnPanel && typeof BeeVisualsSpawnPanel.drawVisuals === 'function') {
      BeeVisualsSpawnPanel.drawVisuals();
    }

    var C = prepareTickCaches();

    // 1) Per-room planning
    var rooms = C.roomsOwned;
    for (var i = 0; i < rooms.length; i++) {
      BeeHiveMind.manageRoom(rooms[i], C);
    }

    // 2) Per-creep behavior
    BeeHiveMind.runCreeps(C);

    if (MovementManager && typeof MovementManager.resolveAndMove === 'function') {
      // Execute queued movement intents after all roles finish issuing actions.
      MovementManager.resolveAndMove();
    }

    // 3) Spawning (queue-based)
    BeeHiveMind.manageSpawns(C);

    // 4) Trading
    if (TradeEnergy && typeof TradeEnergy.runAll === 'function') {
      // if (Game.time % 3 === 0) TradeEnergy.runAll();
      TradeEnergy.runAll();
    }
  },

  /** Room loop – keep lean. */
  // Function header: manageRoom(room, C)
  // Inputs: owned room, tick cache C
  // Output: none; triggers planner helpers for construction/roads.
  manageRoom: function manageRoom(room, C) {
    if (!room) return;

    if (RoomPlanner && typeof RoomPlanner.ensureSites === 'function') {
      RoomPlanner.ensureSites(room);
    }
    if (RoadPlanner && typeof RoadPlanner.ensureRemoteRoads === 'function') {
      RoadPlanner.ensureRemoteRoads(room);
    }
    void C; // placeholder to hint future use
  },

  /** Creep loop – dispatch by role with safe fallback. */
  // Function header: runCreeps(C)
  // Inputs: tick cache C containing creeps array
  // Output: none; hands off each creep to its role.run and handles errors.
  runCreeps: function runCreeps(C) {
    var creeps = C.creeps;
    for (var i = 0; i < creeps.length; i++) {
      var creep = creeps[i];
      BeeHiveMind.assignTask(creep);
      var roleName = (creep.memory && creep.memory.role) || 'Worker_Bee';
      var roleFn = creepRoles[roleName];
      if (typeof roleFn !== 'function') {
        roleFn = roleWorker_Bee.run;
      }
      try {
        roleFn(creep);
      } catch (e) {
        hiveLog.debug('⚠️ Role error for', (creep.name || 'unknown'), '(' + roleName + '):', e);
      }
    }
  },

  /** Assign default task from role if missing. */
  // Function header: assignTask(creep)
  // Inputs: creep object
  // Output: none; sets creep.memory.task for queen/scout/repair roles when absent.
  assignTask: function assignTask(creep) {
    if (!creep || (creep.memory && creep.memory.task)) return;
    var role = creep.memory && creep.memory.role;
    if (role === 'Queen') {
      creep.memory.task = 'queen';
    } else if (role === 'Scout') {
      creep.memory.task = 'scout';
    } else if (role === 'repair') {
      creep.memory.task = 'repair';
    }
  },

  /**
   * Queue-based spawn manager.
   * - Builds queues per room from quota deficits.
   * - First available spawn handles squads once per tick.
   * - Each spawn dequeues at most one item and attempts to spawn it.
   */
  // Function header: manageSpawns(C)
  // Inputs: tick cache C (roomsOwned, spawns arrays, role counts)
  // Output: none; keeps per-room spawn queues and triggers spawnLogic.
  manageSpawns: function manageSpawns(C) {
    if (!C || !Array.isArray(C.spawns) || !Array.isArray(C.roomsOwned)) return;

    // 0) Build/refresh queues per owned room (only for rooms with a spawn)
    var rooms = C.roomsOwned;
    for (var i = 0; i < rooms.length; i++) {
      var room = rooms[i];
      if (!room.find(FIND_MY_SPAWNS).length) continue;
      ensureRoomQueue(room.name);
      fillQueueForRoom(C, room);
    }

    // 1) Squad maintenance — only the first available spawn should attempt it
    var squadHandled = false;

    // 2) Each spawn: try squad (once), then dequeue one worker
    var spawns = C.spawns;
    for (var j = 0; j < spawns.length; j++) {
      var spawner = spawns[j];
      if (!spawner || spawner.spawning) continue;

      if (!squadHandled && spawnLogic && typeof spawnLogic.Spawn_Squad === 'function') {
        var didSquad = spawnLogic.Spawn_Squad(spawner, 'Alpha');
        if (didSquad) {
          squadHandled = true;
          dlog('🛡️ [Squad]', spawner.room.name, 'Alpha maintained at', spawner.name);
          continue; // this spawn consumed its attempt this tick
        }
        // add more formations as you enable them:
        // if (spawnLogic.Spawn_Squad(spawner, 'Bravo')) { squadHandled = true; dlog(...); continue; }
        // if (spawnLogic.Spawn_Squad(spawner, 'Charlie')) { squadHandled = true; dlog(...); continue; }
      }

      // pull from the spawn's room queue
      dequeueAndSpawn(spawner);
    }
  },

  /** Stub hook for future remote ops. */
  // Function header: manageRemoteOps()
  // Inputs/Outputs: none; placeholder for remote automation pipeline.
  manageRemoteOps: function manageRemoteOps() {},

  /** Normalize Memory.rooms to objects. */
  // Function header: initializeMemory()
  // Inputs: none
  // Output: none; ensures Memory.rooms entries are non-null objects (prevents later property access errors).
  initializeMemory: function initializeMemory() {
    if (!Memory.rooms) Memory.rooms = {};
    var roomNames = Object.keys(Memory.rooms);
    for (var i = 0; i < roomNames.length; i++) {
      var roomName = roomNames[i];
      if (!Memory.rooms[roomName]) {
        Memory.rooms[roomName] = {};
      }
    }
  }
};

module.exports = BeeHiveMind;
