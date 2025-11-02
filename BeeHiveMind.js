'use strict';

/**
 * BeeHiveMind – tick orchestrator
 * Readability-first refactor: same behavior, clearer structure & comments.
 *
 * Notes:
 * - Uses ES6 const/let and for..of for clarity.
 * - Keeps per-tick caching to avoid repeated scans.
 * - Spawning still uses your spawn.logic entry points.
 */

// ----------------------------- Dependencies -----------------------------
const CoreLogger   = require('core.logger');
const { LOG_LEVEL } = CoreLogger;
const hiveLog      = CoreLogger.createLogger('HiveMind', LOG_LEVEL.BASIC);

const spawnLogic   = require('spawn.logic');
const roleWorker_Bee = require('role.Worker_Bee');
const TaskBuilder  = require('Task.Builder');       // (kept; not directly used here but likely used elsewhere)
const RoomPlanner  = require('Planner.Room');
const RoadPlanner  = require('Planner.Road');
const TradeEnergy  = require('Trade.Energy');
const TaskLuna     = require('Task.Luna');

// Map role -> run fn (extend as you add roles)
const creepRoles = {
  Worker_Bee: roleWorker_Bee.run
};

// --------------------------- Tunables & Constants ------------------------
const DYING_SOON_TTL   = 60;   // Skip creeps about to expire when counting quotas
const INVADER_LOCK_TTL = 1500; // Mem lock suppression window for remotes

// --------------------------- Global Tick Cache ---------------------------
if (!global.__BHM) global.__BHM = {};

/**
 * Prepare and return the per-tick cache object.
 * Idempotent: cheap to call; exits early if already prepared this tick.
 */
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

/** Return all spawns as an array (no filtering). */
function getAllSpawns() {
  return Object.values(Game.spawns);
}

/**
 * Scan creeps once: collect list, roleCounts (by memory.task),
 * and special luna counts grouped by "home".
 * - Aliases old 'remoteharvest' task to 'luna' (persists fix in memory).
 * - Skips creeps that will die very soon to avoid overcounting.
 */
function buildCreepAndRoleCounts() {
  const creeps           = [];
  const roleCounts       = Object.create(null);
  const lunaCountsByHome = Object.create(null);

  for (const c of Object.values(Game.creeps)) {
    creeps.push(c);

    // Avoid counting expiring creeps against quotas; let new wave replace them
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
      // Resolve home preferencing: memory.home -> memory._home -> current room
      let home = (c.memory && c.memory.home) || null;
      if (!home && c.memory && c.memory._home) home = c.memory._home;
      if (!home && c.room) home = c.room.name;
      if (home) lunaCountsByHome[home] = (lunaCountsByHome[home] || 0) + 1;
    }
  }

  return { creeps, roleCounts, lunaCountsByHome };
}

/**
 * Count my construction sites overall and by room.
 */
function computeConstructionSiteCounts() {
  const byRoom = Object.create(null);
  let total = 0;

  for (const site of Object.values(Game.constructionSites)) {
    if (!site || !site.my) continue; // Screeps exposes only your sites, but keep defensive check
    total += 1;
    const rn = site.pos && site.pos.roomName;
    if (rn) byRoom[rn] = (byRoom[rn] || 0) + 1;
  }

  return { byRoom, total };
}

/**
 * For each owned home room, fetch its active remotes via RoadPlanner
 * (once per tick, centralized here).
 */
function computeRemotesByHome(ownedRooms) {
  const out = Object.create(null);
  const hasHelper = RoadPlanner && typeof RoadPlanner.getActiveRemoteRooms === 'function';
  if (!hasHelper) return out;

  for (const home of ownedRooms) {
    out[home.name] = RoadPlanner.getActiveRemoteRooms(home) || [];
  }
  return out;
}

// ------------------------------ Main Module ------------------------------
const BeeHiveMind = {
  /**
   * Top-level tick entrypoint.
   * Order: init memory -> prep caches -> per-room -> per-creep -> spawn -> trade.
   */
  run() {
    BeeHiveMind.initializeMemory();

    const C = prepareTickCaches();

    // 1) Per-room planning (keep light; heavy .find loops belong inside planners)
    for (const room of C.roomsOwned) {
      BeeHiveMind.manageRoom(room, C);
    }

    // 2) Per-creep behavior
    BeeHiveMind.runCreeps(C);

    // 3) Spawning (one pass over spawns using cached counts/intel)
    BeeHiveMind.manageSpawns(C);

    // 4) Market / energy trade (global decisions)
    if (TradeEnergy && typeof TradeEnergy.runAll === 'function') {
      // Example gate: run every 3 ticks to reduce churn
      // if (Game.time % 3 === 0) TradeEnergy.runAll();
      TradeEnergy.runAll();
    }
  },

  /**
   * Room loop – call site/road planners. Keep this lean per tick.
   */
  manageRoom(room, C) {
    if (!room) return;

    if (RoomPlanner && typeof RoomPlanner.ensureSites === 'function') {
      RoomPlanner.ensureSites(room);
    }
    if (RoadPlanner && typeof RoadPlanner.ensureRemoteRoads === 'function') {
      RoadPlanner.ensureRemoteRoads(room);
    }

    // Add light per-room logic here if needed (avoid repeated room-wide scans)
    void C; // (explicitly mark as used if you add logic later)
  },

  /**
   * Creep loop – ensure tasks, then dispatch by role with safe fallback.
   */
  runCreeps(C) {
    for (const creep of C.creeps) {
      BeeHiveMind.assignTask(creep); // idempotent if already set

      const roleName = (creep.memory && creep.memory.role) || 'Worker_Bee';
      let roleFn = creepRoles[roleName];
      if (typeof roleFn !== 'function') roleFn = roleWorker_Bee.run;

      try {
        roleFn(creep);
      } catch (e) {
        hiveLog.debug('⚠️ Role error for', (creep.name || 'unknown'), '(' + roleName + '):', e);
      }
    }
  },

  /**
   * Assign default task from role if missing (simple, non-invasive).
   */
  assignTask(creep) {
    if (!creep || (creep.memory && creep.memory.task)) return;

    const role = creep.memory && creep.memory.role;
    if (role === 'Queen')        creep.memory.task = 'queen';
    else if (role === 'Scout')   creep.memory.task = 'scout';
    else if (role === 'repair')  creep.memory.task = 'repair';
    // else: leave undefined, spawn logic will decide what to create next
  },

  /**
   * Spawn manager – once per spawn, per tick.
   * - Maintains squads first (single-spawn responsibility prevents double-spawn).
   * - Fills worker task quotas using cached counts and remote intel.
   */
  manageSpawns(C) {
    // Local helpers (read-only; pure) --------------------------------------

    /** Builder need: returns 1 if any local/remote sites exist, else 0. */
    const getBuilderNeed = (room) => {
      if (!room) return 0;
      const local = C.roomSiteCounts[room.name] || 0;
      let remote = 0;
      const remotes = C.remotesByHome[room.name] || [];
      for (const rn of remotes) remote += (C.roomSiteCounts[rn] || 0);
      return (local + remote) > 0 ? 1 : 0;
    };

    /**
     * Determine desired # of Luna (remote harvesters) for a given home room.
     * - Counts sources in remotes (live room intel, memory.sources, or mem.intel.sources).
     * - Respects hostile/locked rooms.
     * - Ensures we never downscale below current active assignments.
     */
    const determineLunaQuota = (room) => {
      if (!room) return 0;

      const remotes = C.remotesByHome[room.name] || [];
      if (!remotes.length) return 0;

      // Set of remote room names for quick membership checks
      const remoteSet = Object.create(null);
      for (const rn of remotes) remoteSet[rn] = true;

      const roomsMem  = Memory.rooms || {};
      const perSource = (TaskLuna && TaskLuna.MAX_LUNA_PER_SOURCE) || 1;

      let totalSources = 0;

      for (const remoteName of remotes) {
        const mem = roomsMem[remoteName] || {};

        // Skip hostile/locked remotes
        if (mem.hostile) continue;
        if (mem._invaderLock && mem._invaderLock.locked) {
          const lockTick = (typeof mem._invaderLock.t === 'number') ? mem._invaderLock.t : null;
          if (lockTick == null || (Game.time - lockTick) <= INVADER_LOCK_TTL) continue;
        }

        // Prefer live intel when visible
        let srcCount = 0;
        const live = Game.rooms[remoteName];
        if (live) {
          const found = live.find(FIND_SOURCES);
          srcCount = found ? found.length : 0;
        }

        // Fall back to coarse memory intel
        if (srcCount === 0 && mem.sources) {
          for (const _sid in mem.sources) {
            if (Object.prototype.hasOwnProperty.call(mem.sources, _sid)) srcCount += 1;
          }
        }
        if (srcCount === 0 && mem.intel && typeof mem.intel.sources === 'number') {
          srcCount = mem.intel.sources | 0; // safe here; value already numeric
        }

        totalSources += srcCount;
      }

      // As a last resort, assume 1 source per remote
      if (totalSources <= 0 && remotes.length > 0) totalSources = remotes.length;

      // Never scale under active assignments
      let desired = totalSources * perSource;
      let active = 0;

      const assignments = Memory.remoteAssignments || {};
      for (const aid in assignments) {
        if (!Object.prototype.hasOwnProperty.call(assignments, aid)) continue;
        const entry = assignments[aid];
        if (!entry) continue;
        const rName = entry.roomName || entry.room;
        if (!rName || !remoteSet[rName]) continue;
        let count = entry.count || 0;
        if (!count && entry.owner) count = 1; // legacy truthy owner means “1”
        if (count > 0) active += count;
      }

      if (active > desired) desired = active;
      return desired;
    };

    // Clone role counts so we can mutate as we schedule spawns
    const roleCounts       = Object.assign({}, C.roleCounts);
    const lunaCountsByHome = Object.assign({}, C.lunaCountsByHome || {});

    // Iterate spawns once each
    for (const spawner of C.spawns) {
      if (!spawner || spawner.spawning) continue;

      // 1) Squad maintenance (only first spawn should do it to avoid double-spawns)
      if (spawnLogic && typeof spawnLogic.Spawn_Squad === 'function') {
        // Try Alpha; if it spawned, skip to next spawn
        if (spawnLogic.Spawn_Squad(spawner, 'Alpha')) continue;
        // Uncomment as you introduce more formations:
        // if (spawnLogic.Spawn_Squad(spawner, 'Bravo')) continue;
        // if (spawnLogic.Spawn_Squad(spawner, 'Charlie')) continue;
        // if (spawnLogic.Spawn_Squad(spawner, 'Delta')) continue;
      }

      const room = spawner.room;

      // 2) Compute quotas (cheap per-spawn; may be memoized room-wide if needed)
      const workerTaskLimits = {
        baseharvest:  2,
        courier:      1,
        queen:        1,
        upgrader:     2,
        builder:      getBuilderNeed(room),
        scout:        1,
        // Switch to determineLunaQuota(room) when ready; left as 4 for stability.
        luna:         4, // determineLunaQuota(room),
        repair:       0,
        CombatArcher: 0,
        CombatMelee:  0,
        CombatMedic:  0,
        Dismantler:   0,
        Trucker:      0,
        Claimer:      0
      };

      // 3) Find first underfilled task, attempt to spawn it, then move on
      for (const task of Object.keys(workerTaskLimits)) {
        const limit = Number(workerTaskLimits[task]) || 0;

        // Use special per-home count for 'luna'
        let currentCount = (task === 'luna')
          ? (Number(lunaCountsByHome[room.name]) || 0)
          : (Number(roleCounts[task]) || 0);

        if (currentCount >= limit) continue;

        const spawnResource = (spawnLogic && typeof spawnLogic.Calculate_Spawn_Resource === 'function')
          ? spawnLogic.Calculate_Spawn_Resource(spawner)
          : null;

        const didSpawn = (spawnLogic && typeof spawnLogic.Spawn_Worker_Bee === 'function')
          ? spawnLogic.Spawn_Worker_Bee(spawner, task, spawnResource)
          : false;

        if (didSpawn) {
          // Reflect the new spawn immediately so later spawns see the updated counts
          if (task === 'luna') {
            lunaCountsByHome[room.name] = (Number(lunaCountsByHome[room.name]) || 0) + 1;
          } else {
            roleCounts[task] = (Number(roleCounts[task]) || 0) + 1;
          }
        }
        // Either way, only one attempt per spawn per tick
        break;
      }
    }
  },

  /**
   * Stub for future remote ops orchestration (claiming/scouting/etc).
   */
  manageRemoteOps() {
    // Intentionally empty (future hook)
  },

  /**
   * Normalize Memory.rooms to objects (defensive init).
   */
  initializeMemory() {
    if (!Memory.rooms) Memory.rooms = {};
    for (const roomName of Object.keys(Memory.rooms)) {
      if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
    }
  }
};

module.exports = BeeHiveMind;
