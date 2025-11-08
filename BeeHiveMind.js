'use strict';

/**
 * BeeHiveMind – tick orchestrator (with spawn queue + debug breadcrumbs)
 * Readability-first refactor: same strategy, clearer structure & comments.
 */

// ----------------------------- Dependencies -----------------------------
const CoreLogger     = require('core.logger');
const { LOG_LEVEL }  = CoreLogger;
const hiveLog        = CoreLogger.createLogger('HiveMind', LOG_LEVEL.BASIC);

const BeeVisualsSpawnPanel = require('BeeVisuals.SpawnPanel');
const spawnLogic     = require('spawn.logic');
const roleWorker_Bee = require('role.Worker_Bee');
const TaskBuilder    = require('Task.Builder');       // kept for your ecosystem
const RoomPlanner    = require('Planner.Room');
const RoadPlanner    = require('Planner.Road');
const TradeEnergy    = require('Trade.Energy');
const TaskLuna       = require('Task.Luna');

// Map role -> run fn (extend as you add roles)
const creepRoles = { Worker_Bee: roleWorker_Bee.run };

// --------------------------- Tunables & Constants ------------------------
const DYING_SOON_TTL        = 60;     // Skip creeps about to expire when counting quotas
const INVADER_LOCK_TTL      = 1500;   // Mem lock suppression window for remotes

// --- Spawn Queue knobs ---
const QUEUE_RETRY_COOLDOWN  = 5;      // ticks to wait before retrying a failed queue item
const QUEUE_HARD_LIMIT      = 20;     // per-room queue sanity cap

// --- Debug knobs ---
const DEBUG_SPAWN_QUEUE     = true;   // flip to false to silence most debug
const DBG_EVERY             = 5;      // periodic summaries every N ticks

// Role priorities (higher spawns first; tweak to taste)
const ROLE_PRIORITY = {
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
 *  NEW: minimal energy per role (used to "lock the head" of the queue).
 *  If the top-priority role isn't affordable yet, we WAIT instead of
 *  letting lower priorities jump ahead.
 *  --------------------------------------------------------------------- */
const ROLE_MIN_ENERGY = {
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
function minEnergyFor(role) {
  if (spawnLogic && typeof spawnLogic.minEnergyFor === 'function') {
    const v = spawnLogic.minEnergyFor(role);
    if (typeof v === 'number') return v;
  }
  return ROLE_MIN_ENERGY[role] || 200;
}

// --------------------------- Global Tick Cache ---------------------------
if (!global.__BHM) global.__BHM = {};

/** Prepare and return the per-tick cache (idempotent). */
function prepareTickCaches() {
  const C = global.__BHM;
  const now = Game.time;
  if (C.tick === now) return C;

  C.tick = now;
  C.roomsOwned       = getOwnedRooms();
  C.roomsMap         = indexByName(C.roomsOwned);
  C.spawns           = getAllSpawns();
  const creepScan    = buildCreepAndRoleCounts();
  C.creeps           = creepScan.creeps;
  C.roleCounts       = creepScan.roleCounts;
  C.lunaCountsByHome = creepScan.lunaCountsByHome;

  const sites        = computeConstructionSiteCounts();
  C.roomSiteCounts   = sites.byRoom;
  C.totalSites       = sites.total;

  C.remotesByHome    = computeRemotesByHome(C.roomsOwned);

  return C;
}

/** Return all owned rooms (controller.my). */
function getOwnedRooms() {
  const result = [];
  for (const room of Object.values(Game.rooms)) {
    if (room && room.controller && room.controller.my) result.push(room);
  }
  return result;
}

/** Return an object map: name -> room */
function indexByName(rooms) {
  const map = {};
  for (const r of rooms) map[r.name] = r;
  return map;
}

/** Return all spawns as an array. */
function getAllSpawns() { return Object.values(Game.spawns); }

/** Scan creeps once for counts (task-based) and per-home Luna counts. */
function buildCreepAndRoleCounts() {
  const creeps           = [];
  const roleCounts       = Object.create(null);
  const lunaCountsByHome = Object.create(null);

  for (const c of Object.values(Game.creeps)) {
    creeps.push(c);

    // Avoid counting expiring creeps against quotas
    const ttl = c.ticksToLive;
    if (typeof ttl === 'number' && ttl <= DYING_SOON_TTL) continue;

    // Normalize task
    let task = c.memory && c.memory.task;
    if (task === 'remoteharvest' && c.memory) {
      task = 'luna';
      c.memory.task = 'luna';
    }
    if (!task) continue;

    roleCounts[task] = (roleCounts[task] || 0) + 1;

    if (task === 'luna') {
      let home = (c.memory && c.memory.home) || null;
      if (!home && c.memory && c.memory._home) home = c.memory._home;
      if (!home && c.room) home = c.room.name;
      if (home) lunaCountsByHome[home] = (lunaCountsByHome[home] || 0) + 1;
    }
  }

  return { creeps, roleCounts, lunaCountsByHome };
}

/** Count my construction sites overall and by room. */
function computeConstructionSiteCounts() {
  const byRoom = Object.create(null);
  let total = 0;
  for (const site of Object.values(Game.constructionSites)) {
    if (!site || !site.my) continue;
    total += 1;
    const rn = site.pos && site.pos.roomName;
    if (rn) byRoom[rn] = (byRoom[rn] || 0) + 1;
  }
  return { byRoom, total };
}

/** For each owned room, fetch its active remotes via RoadPlanner (once per tick). */
function computeRemotesByHome(ownedRooms) {
  const out = Object.create(null);
  const hasHelper = RoadPlanner && typeof RoadPlanner.getActiveRemoteRooms === 'function';
  if (!hasHelper) return out;
  for (const home of ownedRooms) out[home.name] = RoadPlanner.getActiveRemoteRooms(home) || [];
  return out;
}

// ------------------------------ Debug utils ------------------------------
function tickEvery(n) { return Game.time % n === 0; }
function dlog() {
  if (!DEBUG_SPAWN_QUEUE) return;
  try { hiveLog.debug.apply(hiveLog, arguments); } catch (e) { /* noop */ }
}
function fmt(room) { return room && room.name ? room.name : String(room); }
function energyStatus(room) {
  const a = room.energyAvailable | 0;
  const c = room.energyCapacityAvailable | 0;
  return a + '/' + c;
}

// ------------------------------ Spawn Queue ------------------------------
// Memory helpers
function ensureRoomQueue(roomName) {
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
  if (!Array.isArray(Memory.rooms[roomName].spawnQueue)) Memory.rooms[roomName].spawnQueue = [];
  return Memory.rooms[roomName].spawnQueue;
}
function queuedCount(roomName, role) {
  const q = ensureRoomQueue(roomName);
  let n = 0; for (let i = 0; i < q.length; i++) if (q[i] && q[i].role === role) n++;
  return n;
}
function enqueue(roomName, role, opts) {
  const q = ensureRoomQueue(roomName);
  if (q.length >= QUEUE_HARD_LIMIT) {
    dlog('🐝 [Queue]', roomName, 'queue full (', q.length, '/', QUEUE_HARD_LIMIT, '), skip enqueue of', role);
    return false;
  }
  const item = {
    role,
    home: roomName,
    created: Game.time,
    priority: ROLE_PRIORITY[role] || 0,
    retryAt: 0,
    ...(opts || {})   // hints: body tier, targets, flags, etc.
  };
  q.push(item);
  dlog('➕ [Queue]', roomName, 'enqueued', role, '(prio', item.priority + ')');
  return true;
}
function pruneOverfilledQueue(roomName, quotas, C) {
  const q = ensureRoomQueue(roomName);
  const before = q.length;

  // Highest priority first, then oldest
  q.sort((a, b) => (b.priority - a.priority) || (a.created - b.created));

  // Allowed remaining per role = quota - active
  const remaining = {};
  for (const role of Object.keys(quotas)) {
    const active = (role === 'luna')
      ? (C.lunaCountsByHome && C.lunaCountsByHome[roomName] | 0)
      : (C.roleCounts[role] | 0);
    remaining[role] = Math.max(0, (quotas[role] | 0) - active);
  }

  const kept = [];
  const used = Object.create(null);
  for (let i = 0; i < q.length; i++) {
    const it = q[i];
    const left = remaining[it.role] | 0;
    const usedSoFar = used[it.role] | 0;
    if (usedSoFar < left) { kept.push(it); used[it.role] = usedSoFar + 1; }
  }
  Memory.rooms[roomName].spawnQueue = kept;

  const dropped = before - kept.length;
  if (dropped > 0 || tickEvery(DBG_EVERY)) {
    dlog('🧹 [Queue]', roomName, 'prune:',
      'before=', before, 'kept=', kept.length, 'dropped=', dropped,
      'remaining=', JSON.stringify(remaining));
  }
}

// Signals
function getBuilderNeed(C, room) {
  if (!room) return 0;
  const local = C.roomSiteCounts[room.name] || 0;
  let remote = 0;
  const remotes = C.remotesByHome[room.name] || [];
  for (const rn of remotes) remote += (C.roomSiteCounts[rn] || 0);
  const need = (local + remote) > 0 ? 1 : 0;
  if (tickEvery(DBG_EVERY)) dlog('🧱 [Signal] builderNeed', fmt(room), 'local=', local, 'remote=', remote, '->', need);
  return need;
}
function determineLunaQuota(C, room) {
  if (!room) return 0;
  const remotes = C.remotesByHome[room.name] || [];
  if (!remotes.length) return 0;

  const remoteSet = Object.create(null);
  for (const rn of remotes) remoteSet[rn] = true;

  const roomsMem  = Memory.rooms || {};
  const perSource = (TaskLuna && TaskLuna.MAX_LUNA_PER_SOURCE) || 1;

  let totalSources = 0;
  for (const remoteName of remotes) {
    const mem = roomsMem[remoteName] || {};
    if (mem.hostile) continue;
    if (mem._invaderLock && mem._invaderLock.locked) {
      const lockTick = (typeof mem._invaderLock.t === 'number') ? mem._invaderLock.t : null;
      if (lockTick == null || (Game.time - lockTick) <= INVADER_LOCK_TTL) continue;
    }
    let srcCount = 0;
    const live = Game.rooms[remoteName];
    if (live) {
      const found = live.find(FIND_SOURCES);
      srcCount = found ? found.length : 0;
    }
    if (srcCount === 0 && mem.sources) {
      for (const sid in mem.sources) if (Object.prototype.hasOwnProperty.call(mem.sources, sid)) srcCount++;
    }
    if (srcCount === 0 && mem.intel && typeof mem.intel.sources === 'number') {
      srcCount = mem.intel.sources | 0;
    }
    totalSources += srcCount;
  }
  if (totalSources <= 0 && remotes.length > 0) totalSources = remotes.length;

  // Never below current active assignments
  let active = 0;
  const assignments = Memory.remoteAssignments || {};
  for (const aid in assignments) {
    if (!Object.prototype.hasOwnProperty.call(assignments, aid)) continue;
    const entry = assignments[aid]; if (!entry) continue;
    const rName = entry.roomName || entry.room;
    if (!rName || !remoteSet[rName]) continue;
    let count = entry.count || 0;
    if (!count && entry.owner) count = 1;
    if (count > 0) active += count;
  }

  const desired = Math.max(active, totalSources * perSource);
  if (tickEvery(DBG_EVERY)) dlog('🌙 [Signal] lunaQuota', fmt(room), 'remotes=', remotes.length, 'sources=', totalSources, 'active=', active, '->', desired);
  return desired;
}

// Per-room quota policy (tweak here to change strategy)
function computeRoomQuotas(C, room) {
  const quotas = {
    baseharvest:  2,
    courier:      1,
    queen:        1,
    upgrader:     3,
    builder:      getBuilderNeed(C, room),
    scout:        1,
    // Switch to determineLunaQuota(C, room) when you're ready:
    luna:         1, // determineLunaQuota(C, room),
    repair:       0,
    CombatArcher: 0,
    CombatMelee:  0,
    CombatMedic:  0,
    Dismantler:   0,
    Trucker:      0,
    Claimer:      0
  };
  if (tickEvery(DBG_EVERY)) dlog('🎯 [Quotas]', fmt(room), JSON.stringify(quotas));
  return quotas;
}

// Fill queue with deficits (active + queued < quota)
function fillQueueForRoom(C, room) {
  const quotas   = computeRoomQuotas(C, room);
  const roomName = room.name;

  // Optional: enable dynamic Luna
  // quotas.luna = determineLunaQuota(C, room);

  // Reconcile/drop surplus first
  pruneOverfilledQueue(roomName, quotas, C);

  for (const role of Object.keys(quotas)) {
    const limit   = quotas[role] | 0;
    const active  = (role === 'luna')
      ? (C.lunaCountsByHome && C.lunaCountsByHome[roomName] | 0)
      : (C.roleCounts[role] | 0);
    const queued  = queuedCount(roomName, role);
    const deficit = Math.max(0, limit - active - queued);

    if (deficit > 0 && tickEvery(DBG_EVERY)) {
      dlog('📥 [Queue]', roomName, 'role=', role, 'limit=', limit, 'active=', active, 'queued=', queued, 'deficit=', deficit);
    }
    for (let i = 0; i < deficit; i++) enqueue(roomName, role);
  }
}

/** -----------------------------------------------------------------------
 *  NEW dequeue: priority barrier + energy gate
 *  - Sort queue (prio desc, then oldest)
 *  - Only consider items with the current HIGHEST priority
 *  - If room energy < min for that priority, WAIT (don’t back-off, don’t
 *    look at lower priorities)
 *  - Otherwise spawn the oldest eligible item at that priority
 *  --------------------------------------------------------------------- */
function dequeueAndSpawn(spawner) {
  if (!spawner || spawner.spawning) return false;
  const room = spawner.room;
  const roomName = room.name;
  const q = ensureRoomQueue(roomName);
  if (!q.length) {
    if (tickEvery(DBG_EVERY)) dlog('🕳️ [Queue]', roomName, 'empty (energy', energyStatus(room) + ')');
    return false;
  }

  // Highest priority first, then oldest
  q.sort((a, b) => (b.priority - a.priority) || (a.created - b.created));

  // Establish the head priority (barrier)
  const headPriority = q[0].priority;
  const headRole     = q[0].role;

  // Energy gate: if we can't afford the head priority, HOLD
  const needed = minEnergyFor(headRole);
  if ((room.energyAvailable | 0) < needed) {
    if (tickEvery(DBG_EVERY)) dlog('⛽ [QueueHold]', roomName, 'prio', headPriority, 'role', headRole,
                                   'need', needed, 'have', room.energyAvailable);
    return false;
  }

  // Oldest, not-cooling-down item at the head priority
  let pickIndex = -1;
  for (let i = 0; i < q.length; i++) {
    const it = q[i];
    if (!it) continue;
    if (it.priority !== headPriority) break;         // stop once we leave the head block
    if (it.retryAt && Game.time < it.retryAt) continue;
    pickIndex = i;
    break;
  }
  if (pickIndex === -1) {
    if (tickEvery(DBG_EVERY)) dlog('⏸️ [Queue]', roomName, 'head priority cooling down');
    return false;
  }

  const item = q[pickIndex];
  dlog('🎬 [SpawnTry]', roomName, 'role=', item.role, 'prio=', item.priority,
       'age=', (Game.time - item.created), 'energy=', energyStatus(room));

  const spawnResource =
    (spawnLogic && typeof spawnLogic.Calculate_Spawn_Resource === 'function')
      ? spawnLogic.Calculate_Spawn_Resource(spawner)
      : null;

  const ok =
    (spawnLogic && typeof spawnLogic.Spawn_Worker_Bee === 'function')
      ? spawnLogic.Spawn_Worker_Bee(spawner, item.role, spawnResource, item)
      : false;

  if (ok) {
    dlog('✅ [SpawnOK]', roomName, 'spawned', item.role, 'at', spawner.name);
    q.splice(pickIndex, 1);
    return true;
  } else {
    // Only back-off if we *could afford it* but still failed (e.g., name collision)
    item.retryAt = Game.time + QUEUE_RETRY_COOLDOWN;
    dlog('⏳ [SpawnWait]', roomName, item.role, 'backoff to', item.retryAt, '(energy', energyStatus(room) + ')');
    return false; // one attempt per spawn per tick
  }
}

// ------------------------------ Main Module ------------------------------
const BeeHiveMind = {
  /** Top-level tick entrypoint. */
  run() {
    BeeHiveMind.initializeMemory();
    // Visual overlays (spawn HUD + queue)
    if (BeeVisualsSpawnPanel && typeof BeeVisualsSpawnPanel.drawVisuals === 'function') {
      BeeVisualsSpawnPanel.drawVisuals();
    }

    const C = prepareTickCaches();

    // 1) Per-room planning
    for (const room of C.roomsOwned) BeeHiveMind.manageRoom(room, C);

    // 2) Per-creep behavior
    BeeHiveMind.runCreeps(C);

    // 3) Spawning (queue-based)
    BeeHiveMind.manageSpawns(C);

    // 4) Trading
    if (TradeEnergy && typeof TradeEnergy.runAll === 'function') {
      // if (Game.time % 3 === 0) TradeEnergy.runAll();
      TradeEnergy.runAll();
    }
  },

  /** Room loop – keep lean. */
  manageRoom(room, C) {
    if (!room) return;

    if (RoomPlanner && typeof RoomPlanner.ensureSites === 'function') RoomPlanner.ensureSites(room);
    if (RoadPlanner && typeof RoadPlanner.ensureRemoteRoads === 'function') RoadPlanner.ensureRemoteRoads(room);
    void C;
  },

  /** Creep loop – dispatch by role with safe fallback. */
  runCreeps(C) {
    for (const creep of C.creeps) {
      BeeHiveMind.assignTask(creep);
      const roleName = (creep.memory && creep.memory.role) || 'Worker_Bee';
      let roleFn = creepRoles[roleName];
      if (typeof roleFn !== 'function') roleFn = roleWorker_Bee.run;
      try { roleFn(creep); }
      catch (e) { hiveLog.debug('⚠️ Role error for', (creep.name || 'unknown'), '(' + roleName + '):', e); }
    }
  },

  /** Assign default task from role if missing. */
  assignTask(creep) {
    if (!creep || (creep.memory && creep.memory.task)) return;
    const role = creep.memory && creep.memory.role;
    if (role === 'Queen')        creep.memory.task = 'queen';
    else if (role === 'Scout')   creep.memory.task = 'scout';
    else if (role === 'repair')  creep.memory.task = 'repair';
  },

  /**
   * Queue-based spawn manager.
   * - Builds queues per room from quota deficits.
   * - First available spawn handles squads once per tick.
   * - Each spawn dequeues at most one item and attempts to spawn it.
   */
  manageSpawns(C) {
    if (!C || !Array.isArray(C.spawns) || !Array.isArray(C.roomsOwned)) return;

    // 0) Build/refresh queues per owned room (only for rooms with a spawn)
    for (const room of C.roomsOwned) {
      if (!room.find(FIND_MY_SPAWNS).length) continue;
      ensureRoomQueue(room.name);
      fillQueueForRoom(C, room);
    }

    // 1) Squad maintenance — only the first available spawn should attempt it
    let squadHandled = false;

    // 2) Each spawn: try squad (once), then dequeue one worker
    for (const spawner of C.spawns) {
      if (!spawner || spawner.spawning) continue;

      if (!squadHandled && spawnLogic && typeof spawnLogic.Spawn_Squad === 'function') {
        const didSquad = spawnLogic.Spawn_Squad(spawner, 'Alpha');
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
  manageRemoteOps() {},

  /** Normalize Memory.rooms to objects. */
  initializeMemory() {
    if (!Memory.rooms) Memory.rooms = {};
    for (const roomName of Object.keys(Memory.rooms)) {
      if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
    }
  }
};

module.exports = BeeHiveMind;
