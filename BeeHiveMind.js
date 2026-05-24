// -----------------------------------------------------------------------------
// BeeHiveMind.js – global orchestrator for each Screeps tick
// Responsibilities:
// * Prepares per-tick caches (rooms, creeps, selectors) and exposes them to
//   role modules.
// * Manages per-room spawn queues, enforcing quotas and energy gates.
// * Dispatches creep roles (including role.Queen via role assignments) after
//   initialising movement and visuals.
// * Triggers auxiliary systems (Trade.Energy, planners) at deterministic points.
// Data touched:
// * global.__BHM.* (tick caches shared with BeeSelectors, role modules).
// * Memory.rooms[roomName].spawnQueue (array of spawn jobs).
// * creep.memory.role for implicit role assignment.
// Entry point: main.js requires BeeHiveMind and calls run() once per tick.
// -----------------------------------------------------------------------------
'use strict';

// Additional ownership notes:
// * BeeHiveMind is the tick coordinator, not the owner of role behavior. It
//   normalizes role memory, builds global.__BHM tick caches, calls room
//   planners, dispatches role.run(), resolves movement, then delegates spawn
//   queues to BeeSpawnManager.
// * Persistent Memory ownership lives in the specialist modules:
//   BeeMaintenance owns stale cleanup, SourceEnergy.Manager owns remote Veinseeker
//   planning, Movement.Manager owns only transient movement intents, and each
//   role owns its own creep.memory fields.

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
var BeeSpawnManager      = require('BeeSpawnManager');
var Veinseeker           = require('role.Veinseeker');
var Builder              = require('role.Builder');
var Queen                = require('role.Queen');
var Upgrader             = require('role.Upgrader');
var Scout                = require('role.Scout');
var Trucker              = require('role.Trucker');
var Claimer              = require('role.Claimer');
var CombatArcher         = require('role.CombatArcher');
var CombatMedic          = require('role.CombatMedic');
var CombatMelee          = require('role.CombatMelee');
var roleRepair           = require('role.Repair');
var roleDismantler       = require('role.Dismantler');
var RoomPlanner          = require('Planner.Room');
var RoadPlanner          = require('Planner.Road');
var TradeEnergy          = require('Trade.Energy');
var CpuProfiler         = require('core.cpuProfiler');
var CoreConfig          = require('core.config');
var BeeSourceEconomy    = require('BeeSourceEconomy');

// Keep references to the role modules so validation can check the intended
// mapping (e.g. a swapped import would surface as a role name mismatch).
var roleModules = {
  Veinseeker: Veinseeker,
  Builder: Builder,
  Repair: roleRepair,
  Upgrader: Upgrader,
  Dismantler: roleDismantler,
  Scout: Scout,
  Queen: Queen,
  Trucker: Trucker,
  Claimer: Claimer,
  CombatArcher: CombatArcher,
  CombatMedic: CombatMedic,
  CombatMelee: CombatMelee
};

// Map role -> run fn (extend as you add roles)
// Default role map; specific roles may be registered
// elsewhere by mutating this object.
var creepRoles = {
  Veinseeker: roleModules.Veinseeker && roleModules.Veinseeker.run,
  Builder: roleModules.Builder && roleModules.Builder.run,
  Repair: roleModules.Repair && roleModules.Repair.run,
  Upgrader: roleModules.Upgrader && roleModules.Upgrader.run,
  Dismantler: roleModules.Dismantler && roleModules.Dismantler.run,
  Scout: roleModules.Scout && roleModules.Scout.run,
  Queen: roleModules.Queen && roleModules.Queen.run,
  Trucker: roleModules.Trucker && roleModules.Trucker.run,
  Claimer: roleModules.Claimer && roleModules.Claimer.run,
  CombatArcher: roleModules.CombatArcher && roleModules.CombatArcher.run,
  CombatMedic: roleModules.CombatMedic && roleModules.CombatMedic.run,
  CombatMelee: roleModules.CombatMelee && roleModules.CombatMelee.run
};

// Capture missing bindings once so we can quickly spot miswired role imports.
var warnedMissingRoles = Object.create(null);
var warnedMismatchedRoleNames = Object.create(null);

/**
 * Helper factory that builds our alias lookup object.
 * Extracted from an IIFE so newer developers can read it step-by-step,
 * place breakpoints, or expand the logic without digging through
 * nested scopes.
 */
function createRoleAliasMap() {
  var map = Object.create(null);

  // Canonical roles are the ones that exist in code.  Aliases (like
  // "worker_bee") are mapped to one of these canonical spellings.
  var canonicalRoles = [
    'Idle',
    'Veinseeker',
    'Builder',
    'Repair',
    'Upgrader',
    'Dismantler',
    'Scout',
    'Queen',
    'Trucker',
    'Claimer',
    'CombatArcher',
    'CombatMedic',
    'CombatMelee'
  ];

  // The loop below intentionally uses a classic "for" so that folks who
  // are new to Screeps (and maybe coding in general) can easily translate
  // it to pseudocode or another language.
  for (var i = 0; i < canonicalRoles.length; i++) {
    var name = canonicalRoles[i];
    map[name] = name;
    map[name.toLowerCase()] = name;
  }

  // Friendly aliases that appear in historical memory dumps.
  map.worker_bee = 'Idle';
  map['Worker_Bee'] = 'Idle';
  return map;
}

var ROLE_ALIAS_MAP = createRoleAliasMap();

function migrateLegacySourceWorkersToVeinseeker() {
  if (!Memory.__BHM) Memory.__BHM = {};
  if (!Memory.__BHM.migrations) Memory.__BHM.migrations = {};
  if (Memory.__BHM.migrations.veinseekerRoleMigrationDone) return;

  function lower(value) {
    return value == null ? '' : String(value).toLowerCase();
  }

  function shouldMigrateMemory(mem) {
    if (!mem) return false;
    var role = lower(mem.role);
    var task = lower(mem.task);
    return role === 'baseharvest' || role === 'luna' ||
      task === 'baseharvest' || task === 'luna' || task === 'remoteharvest';
  }

  function normalizeMemory(mem) {
    if (!mem || !shouldMigrateMemory(mem)) return false;
    var role = lower(mem.role);
    var task = lower(mem.task);
    var remoteMode = role === 'luna' || task === 'luna' || task === 'remoteharvest';
    if (!remoteMode && mem.targetRoom && mem.home && mem.targetRoom !== mem.home) remoteMode = true;
    mem.role = 'Veinseeker';
    mem.task = 'veinseeker';
    mem.mode = remoteMode ? 'remote' : 'home';
    if (mem.baseHarvestSpawnMode && !mem.sourceWorkerSpawnMode) {
      mem.sourceWorkerSpawnMode = mem.baseHarvestSpawnMode;
    }
    if (mem.lunaRepairingContainer && !mem.sourceWorkerRepairingContainer) {
      mem.sourceWorkerRepairingContainer = mem.lunaRepairingContainer;
    }
    delete mem.baseHarvestSpawnMode;
    delete mem.lunaRepairingContainer;
    return true;
  }

  var migratedCreeps = 0;
  for (var name in Game.creeps) {
    if (Object.prototype.hasOwnProperty.call(Game.creeps, name) && normalizeMemory(Game.creeps[name].memory)) {
      migratedCreeps++;
    }
  }

  var migratedMemoryCreeps = 0;
  if (Memory.creeps) {
    for (var memName in Memory.creeps) {
      if (Object.prototype.hasOwnProperty.call(Memory.creeps, memName) && normalizeMemory(Memory.creeps[memName])) {
        migratedMemoryCreeps++;
      }
    }
  }

  var migratedQueueItems = 0;
  var migratedBlockedRecords = 0;
  if (Memory.rooms) {
    for (var roomName in Memory.rooms) {
      if (!Object.prototype.hasOwnProperty.call(Memory.rooms, roomName)) continue;
      var roomMem = Memory.rooms[roomName];
      if (!roomMem) continue;
      if (roomMem.lunaBlockedUntil != null && roomMem.sourceWorkerBlockedUntil == null) roomMem.sourceWorkerBlockedUntil = roomMem.lunaBlockedUntil;
      if (roomMem.lunaBlockedReason != null && roomMem.sourceWorkerBlockedReason == null) roomMem.sourceWorkerBlockedReason = roomMem.lunaBlockedReason;
      if (roomMem.lunaBlockedAt != null && roomMem.sourceWorkerBlockedAt == null) roomMem.sourceWorkerBlockedAt = roomMem.lunaBlockedAt;
      if (roomMem.lunaBlocked != null && roomMem.sourceWorkerBlocked == null) roomMem.sourceWorkerBlocked = roomMem.lunaBlocked;
      if (roomMem.lunaUnsafe != null && roomMem.sourceWorkerUnsafe == null) roomMem.sourceWorkerUnsafe = roomMem.lunaUnsafe;
      if (roomMem.lunaInvaderLockUntil != null && roomMem.sourceWorkerInvaderLockUntil == null) roomMem.sourceWorkerInvaderLockUntil = roomMem.lunaInvaderLockUntil;
      delete roomMem.lunaBlockedUntil;
      delete roomMem.lunaBlockedReason;
      delete roomMem.lunaBlockedAt;
      delete roomMem.lunaBlocked;
      delete roomMem.lunaUnsafe;
      delete roomMem.lunaInvaderLockUntil;
      var sourceIds = roomMem.sources ? Object.keys(roomMem.sources) : [];
      for (var s = 0; s < sourceIds.length; s++) {
        var srcMem = roomMem.sources[sourceIds[s]];
        if (!srcMem) continue;
        if (srcMem.lunaBlockedUntil != null && srcMem.sourceWorkerBlockedUntil == null) srcMem.sourceWorkerBlockedUntil = srcMem.lunaBlockedUntil;
        if (srcMem.lunaBlockedReason != null && srcMem.sourceWorkerBlockedReason == null) srcMem.sourceWorkerBlockedReason = srcMem.lunaBlockedReason;
        delete srcMem.lunaBlockedUntil;
        delete srcMem.lunaBlockedReason;
        migratedBlockedRecords++;
      }
      var q = roomMem.spawnQueue;
      if (!Array.isArray(q)) continue;
      for (var i = 0; i < q.length; i++) {
        if (normalizeMemory(q[i])) migratedQueueItems++;
      }
    }
  }

  var migratedRemoteSources = 0;
  if (Memory.__BHM.remoteHarvest && !Memory.__BHM.sourceEnergy) {
    Memory.__BHM.sourceEnergy = Memory.__BHM.remoteHarvest;
  }
  var remoteRoot = Memory.__BHM.sourceEnergy || Memory.__BHM.remoteHarvest;
  if (remoteRoot && remoteRoot.homes) {
    for (var homeRoom in remoteRoot.homes) {
      if (!Object.prototype.hasOwnProperty.call(remoteRoot.homes, homeRoom)) continue;
      var home = remoteRoot.homes[homeRoom];
      if (!home) continue;
      if (home.desiredLuna != null && home.desiredVeinseeker == null) home.desiredVeinseeker = home.desiredLuna;
      if (home.liveLuna != null && home.liveVeinseeker == null) home.liveVeinseeker = home.liveLuna;
      if (home.queuedLuna != null && home.queuedVeinseeker == null) home.queuedVeinseeker = home.queuedLuna;
      delete home.desiredLuna;
      delete home.liveLuna;
      delete home.queuedLuna;
      var sourceIds = home.sources ? Object.keys(home.sources) : [];
      for (var s = 0; s < sourceIds.length; s++) {
        var rec = home.sources[sourceIds[s]];
        if (!rec) continue;
        if (rec.assignedLuna != null && rec.assignedVeinseeker == null) rec.assignedVeinseeker = rec.assignedLuna;
        delete rec.assignedLuna;
        migratedRemoteSources++;
      }
    }
  }
  delete Memory.__BHM.remoteHarvest;

  Memory.__BHM.migrations.veinseekerRoleMigrationDone = true;
  Memory.__BHM.migrations.veinseekerRoleMigration = {
    tick: Game.time,
    migratedCreeps: migratedCreeps,
    migratedMemoryCreeps: migratedMemoryCreeps,
    migratedQueueItems: migratedQueueItems,
    migratedRemoteSources: migratedRemoteSources,
    migratedBlockedRecords: migratedBlockedRecords
  };
}

function canonicalRoleName(name) {
  // Normalize legacy/alias role strings before dispatch. This protects the
  // role runner and quota cache from old creep memory such as "veinseeker".
  // Defensive coding pattern: immediately handle null/undefined to avoid
  // sprinkling guard clauses everywhere else.
  if (!name) return null;
  if (creepRoles[name]) return name;
  var key = String(name);
  if (ROLE_ALIAS_MAP[key]) return ROLE_ALIAS_MAP[key];
  var lower = key.toLowerCase();
  if (ROLE_ALIAS_MAP[lower]) return ROLE_ALIAS_MAP[lower];
  return null;
}

function validateRoleBindings() {
  // Lightweight wiring check. It logs missing/mismatched role modules but does
  // not stop the tick; role behavior remains owned by the role modules.
  var roles = Object.keys(creepRoles);
  for (var i = 0; i < roles.length; i++) {
    var name = roles[i];
    var fn = creepRoles[name];
    if (typeof fn === 'function') continue;
    if (warnedMissingRoles[name]) continue;
    warnedMissingRoles[name] = true;
    hiveLog.debug('⚠️ Missing run() for role', name, '- verify role.' + name + '.js exports run');
  }

  for (var j = 0; j < roles.length; j++) {
    var checkName = roles[j];
    var checkModule = roleModules[checkName];
    if (!checkModule || !checkModule.role) continue;
    if (checkModule.role === checkName) continue;
    if (warnedMismatchedRoleNames[checkName]) continue;
    warnedMismatchedRoleNames[checkName] = true;
    hiveLog.debug(
      '⚠️ Role name mismatch:',
      'expected', checkName,
      'but module exports role=', checkModule.role,
      '- verify role.' + checkName + '.js wiring'
    );
  }
}

function ensureCreepRole(creep) {
  // Creep memory migration/normalization point. This is intentionally early in
  // the tick because role counts, spawn quotas, and runCreeps all trust
  // creep.memory.role after this function returns.
  // Novice tip: always guard against falsy values before dereferencing.
  if (!creep) return 'Idle';
  var mem = creep.memory || (creep.memory = {});

  // Retired-role migration must run before canonical validation because
  // runCreeps() executes before manageSpawns() each tick.
  var roleLower = mem.role ? String(mem.role).toLowerCase() : '';
  var taskLower = mem.task ? String(mem.task).toLowerCase() : '';
  var migratedRetiredCourier = false;
  if (roleLower === 'courier' || taskLower === 'courier') {
    mem.role = 'Trucker';
    if (taskLower === 'courier') mem.task = 'haulUnified';
    mem.retiredCourierMigratedAt = Game.time;
    migratedRetiredCourier = true;
  }

  if (migratedRetiredCourier) {
    if (!Memory.__BHM) Memory.__BHM = {};
    var diag = Memory.__BHM.retiredCourierMigration || { tick: Game.time, migratedCreeps: 0, lastCreepName: null };
    diag.tick = Game.time;
    diag.migratedCreeps = (diag.migratedCreeps || 0) + 1;
    diag.lastCreepName = creep.name || null;
    Memory.__BHM.retiredCourierMigration = diag;
  }

  // Prefer deterministic values; canonicalRoleName normalises any
  // mis-capitalised or legacy entries.
  var canonical = canonicalRoleName(mem.role) || canonicalRoleName(mem.task);
  if (!canonical) canonical = 'Idle';

  if (canonical === 'Veinseeker' && mem && mem.task === 'veinseeker') {
    mem.task = 'veinseeker';
  }

  mem.role = canonical;
  if (mem.bornRole) delete mem.bornRole;
  return canonical;
}

// --------------------------- Tunables & Constants ------------------------
// Grouped knobs to make strategy tweaks easy to find.
var DYING_SOON_TTL        = 60;     // Skip creeps about to expire when counting quotas

// --------------------------- Global Tick Cache ---------------------------
if (!global.__BHM) global.__BHM = {};

// Tick cache fields populated each tick:
// global.__BHM = {
//   tick, roomsOwned, roomsMap, roomSnapshots,
//   spawns, creeps, roleCounts, veinseekerCountsByHome,
//   roomSiteCounts, totalSites, remotesByHome
// }.

// Function header: objectValues(obj)
// Inputs: plain object
// Output: array of own enumerable property values (ES5-compatible Object.values replacement).

function refreshSourceEconomyForOwnedRooms() {
  if (!global.__BHM || !global.__BHM.roomsOwned) return;
  for (var i = 0; i < global.__BHM.roomsOwned.length; i++) {
    var room = global.__BHM.roomsOwned[i];
    BeeSourceEconomy.refreshOwnedRoomSources(room);
    BeeSourceEconomy.refreshVeinseekerStats(room);
    BeeSourceEconomy.refreshTruckerCarryStats(room);
    BeeSourceEconomy.calculatePendingEnergy(room);
  }
}
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
  // Build one tick-local snapshot of rooms, spawns, creeps, role counts,
  // construction sites, remotes, and selector room snapshots. Most downstream
  // systems read global.__BHM instead of repeating expensive scans.
  var C = global.__BHM;
  var now = Game.time;
  // Early return: if we've already computed caches this tick, reuse them.
  if (C.tick === now) return C;

  // Rooms: gather owned list and a name lookup without bouncing to helpers.
  var ownedRooms = [];
  var ownedMap = Object.create(null);
  var roomNames = Object.keys(Game.rooms);
  for (var i = 0; i < roomNames.length; i++) {
    var room = Game.rooms[roomNames[i]];
    if (room && room.controller && room.controller.my) {
      ownedRooms.push(room);
      ownedMap[room.name] = room;
    }
  }

  // Spawns: simple snapshot; objectValues keeps the ES5-compatible conversion.
  var spawns = objectValues(Game.spawns);

  // Creeps: single pass to keep counts near the data source.
  var creeps = [];
  var roleCounts = Object.create(null);
  var roleCountsByRoom = Object.create(null);
  var veinseekerCountsByHome = Object.create(null);
  var creepNames = Object.keys(Game.creeps);
  for (var j = 0; j < creepNames.length; j++) {
    var creep = Game.creeps[creepNames[j]];
    creeps.push(creep);

    // Avoid counting expiring creeps against quotas
    var ttl = creep.ticksToLive;
    if (typeof ttl === 'number' && ttl <= DYING_SOON_TTL) {
      continue;
    }

    var roleName = ensureCreepRole(creep);
    roleCounts[roleName] = (roleCounts[roleName] || 0) + 1;

    var homeRoom = (creep.memory && creep.memory.home) || null;
    if (!homeRoom && creep.memory && creep.memory._home) homeRoom = creep.memory._home;
    if (!homeRoom && creep.memory && creep.memory.targetRoom) homeRoom = creep.memory.targetRoom;
    if (!homeRoom && creep.room) homeRoom = creep.room.name;
    if (homeRoom) {
      if (!roleCountsByRoom[homeRoom]) roleCountsByRoom[homeRoom] = Object.create(null);
      roleCountsByRoom[homeRoom][roleName] = (roleCountsByRoom[homeRoom][roleName] || 0) + 1;
    }

    if (roleName === 'Veinseeker') {
      var home = (creep.memory && creep.memory.home) || null;
      if (!home && creep.memory && creep.memory._home) home = creep.memory._home;
      if (!home && creep.room) home = creep.room.name;
      if (home) {
        veinseekerCountsByHome[home] = (veinseekerCountsByHome[home] || 0) + 1;
      }
    }
  }

  // Construction sites: owned counts per room + total.
  var byRoom = Object.create(null);
  var totalSites = 0;
  var sites = objectValues(Game.constructionSites);
  for (var k = 0; k < sites.length; k++) {
    var site = sites[k];
    if (!site || !site.my) continue;
    totalSites += 1;
    var rn = site.pos && site.pos.roomName;
    if (rn) {
      byRoom[rn] = (byRoom[rn] || 0) + 1;
    }
  }

  // Remote rooms: always keep together with room data so it's easy to spot.
  var remotesByHome = Object.create(null);
  var hasHelper = RoadPlanner && typeof RoadPlanner.getActiveRemoteRooms === 'function';
  if (hasHelper) {
    for (var m = 0; m < ownedRooms.length; m++) {
      var home = ownedRooms[m];
      remotesByHome[home.name] = RoadPlanner.getActiveRemoteRooms(home) || [];
    }
  }

  // Room snapshots for selectors sit at the end so they can reuse the cache fields above.
  var snapshots = Object.create(null);
  if (BeeSelectors && typeof BeeSelectors.prepareRoomSnapshot === 'function') {
    for (var n = 0; n < ownedRooms.length; n++) {
      var snapRoom = ownedRooms[n];
      if (!snapRoom || !snapRoom.name) continue;
      try {
        snapshots[snapRoom.name] = BeeSelectors.prepareRoomSnapshot(snapRoom);
      } catch (err) {
        hiveLog.debug('⚠️ Selector snapshot failed for', fmt(snapRoom), err);
        // Teaching moment: catching errors allows the tick to continue even
        // if one room fails to generate a snapshot.
      }
    }
  }

  C.tick            = now;
  C.roomsOwned      = ownedRooms;
  C.roomsMap        = ownedMap;
  C.roomSnapshots   = snapshots;
  C.spawns          = spawns;
  C.creeps          = creeps;
  C.roleCounts      = roleCounts;
  C.roleCountsByRoom = roleCountsByRoom;
  C.veinseekerCountsByHome = veinseekerCountsByHome;
  C.roomSiteCounts  = byRoom;
  C.totalSites      = totalSites;
  C.remotesByHome   = remotesByHome;

  return C;
}

// Function header: fmt(room)
// Inputs: Room instance or name
// Output: string representation for logs.
function fmt(room) {
  return room && room.name ? room.name : String(room);
}

// ------------------------------ Main Module ------------------------------
var BeeHiveMind = {
  /** Top-level tick entrypoint. */
  // Function header: run()
  // Inputs: none
  // Output: none; orchestrates tick: memory init → visuals → caches → rooms → creeps → movement → spawns → trade.
  // Side-effects: updates global.__BHM, Memory rooms, MovementManager state.
  run: function run() {
    CpuProfiler.start('BeeHiveMind.total');
    CpuProfiler.measure('initializeMemory', BeeHiveMind.initializeMemory);
    CpuProfiler.measure('migrateLegacySourceWorkersToVeinseeker', migrateLegacySourceWorkersToVeinseeker);

    // Expose action/selectors globally for console debugging and legacy modules
    // expecting global symbols.
    // Teaching tip: doing this up-front ensures any role file that executes
    // later in the tick can immediately access the helpers.
    if (BeeActions) global.BeeActions = BeeActions;
    if (BeeSelectors) global.BeeSelectors = BeeSelectors;

    // Verify role bindings once per tick so missing modules are visible in logs.
    CpuProfiler.measure('validateRoleBindings', validateRoleBindings);

    if (MovementManager && typeof MovementManager.startTick === 'function') {
      // Reset movement queue before any role enqueues requests.
      CpuProfiler.measure('MovementManager.startTick', function () {
        MovementManager.startTick();
      });
    }

    // Visual overlays (spawn HUD + queue)
    if (BeeVisualsSpawnPanel && typeof BeeVisualsSpawnPanel.drawVisuals === 'function') {
      CpuProfiler.measure('BeeVisualsSpawnPanel.drawVisuals', function () {
        BeeVisualsSpawnPanel.drawVisuals();
      });
    }

    var C = CpuProfiler.measure('prepareTickCaches', prepareTickCaches);

    // 1) Per-room planning
    // Working from general to specific keeps the mental model tidy: rooms
    // come first, then creeps that exist inside those rooms.
    var rooms = C.roomsOwned;
    for (var i = 0; i < rooms.length; i++) {
      CpuProfiler.measure('manageRoom.total', function () {
        BeeHiveMind.manageRoom(rooms[i]);
      });
    }

    // 2) Per-creep behavior
    CpuProfiler.measure('runCreeps.total', function () {
      BeeHiveMind.runCreeps(C);
    });
    CpuProfiler.measure('refreshSourceEconomyForOwnedRooms', refreshSourceEconomyForOwnedRooms);

    if (MovementManager && typeof MovementManager.resolveAndMove === 'function') {
      // Execute queued movement intents after all roles finish issuing actions.
      // This mirrors a "commit" phase in a database transaction—everyone
      // proposes moves, then we resolve conflicts once.
      CpuProfiler.measure('MovementManager.resolveAndMove', function () {
        MovementManager.resolveAndMove();
      });
    }

    // 3) Spawning (queue-based)
    CpuProfiler.measure('manageSpawns', function () {
      BeeHiveMind.manageSpawns(C);
    });

    // 4) Trading
    if (TradeEnergy && typeof TradeEnergy.runAll === 'function') {
      // if (Game.time % 3 === 0) TradeEnergy.runAll();
      CpuProfiler.measure('TradeEnergy.runAll', function () {
        TradeEnergy.runAll();
      });
    }
    CpuProfiler.end('BeeHiveMind.total');
  },

  /** Room loop – keep lean. */
  // Function header: manageRoom(room)
  // Inputs: owned room
  // Output: none; triggers planner helpers for construction/roads.
  manageRoom: function manageRoom(room) {
    if (!room) return;

    if (RoomPlanner && typeof RoomPlanner.ensureSites === 'function') {
      // Encourage small, single-purpose helpers: ensureSites focuses purely
      // on layout decisions so this coordinator stays readable.
      RoomPlanner.ensureSites(room);
    }
    if (RoadPlanner && typeof RoadPlanner.ensureRemoteRoads === 'function') {
      RoadPlanner.ensureRemoteRoads(room);
    }
  },

  /** Creep loop – dispatch by role with safe fallback. */
  // Function header: runCreeps(C)
  // Inputs: tick cache C containing creeps array
  // Output: none; hands off each creep to its role.run and handles errors.
  runCreeps: function runCreeps(C) {
    var creeps = C.creeps;
    var roleProfilingEnabled =
      CpuProfiler.isEnabled() &&
      CoreConfig.settings.cpuProfiler &&
      CoreConfig.settings.cpuProfiler.includeRoleBreakdown === true;

    for (var i = 0; i < creeps.length; i++) {
      var creep = creeps[i];
      var roleName = ensureCreepRole(creep);
      var roleFn = creepRoles[roleName];
      if (typeof roleFn !== 'function') {
        // Skip unknown roles so a typo never stops the loop.
        continue;
      }
      try {
        if (roleProfilingEnabled) {
          var roleSection = 'role.' + roleName;
          var isCombatRole = roleName.indexOf('Combat') === 0;
          CpuProfiler.start(roleSection);
          CpuProfiler.start('role.total');
          if (isCombatRole) CpuProfiler.start('role.Combat*');
          try {
            roleFn(creep);
          } finally {
            if (isCombatRole) CpuProfiler.end('role.Combat*');
            CpuProfiler.end('role.total');
            CpuProfiler.end(roleSection);
          }
        } else {
          roleFn(creep);
        }
      } catch (e) {
        hiveLog.debug('⚠️ Role error for', (creep.name || 'unknown'), '(' + roleName + '):', e);
      }
    }
  },

  ensureRole: ensureCreepRole,

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
    // By delegating to BeeSpawnManager we practice "composition": this file
    // orchestrates high-level flow, while the spawn manager owns the details
    // of quota math and energy budgeting.
    BeeSpawnManager.manageSpawns(C);
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
        // Always initialise to an object so downstream code can safely do
        // Memory.rooms[name].foo without crashing.
        Memory.rooms[roomName] = {};
      }
    }
  }
};

module.exports = BeeHiveMind;
