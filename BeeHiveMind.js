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
// * global.__BHM.* (tick caches shared with core.selectors, role modules).
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
//   core.maintenance owns stale cleanup, SourceEnergy.Manager owns remote Veinseeker
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
var CoreSelectors        = require('core.selectors');
var MovementActions      = require('Movement.Actions');
var MovementManager      = require('Movement.Manager');
var BeeSpawnManager      = require('BeeSpawnManager');
var Roles                = require('core.roles');
var RoleRegistry         = require('role.registry');
var MemoryUtils          = require('core.memory');
var RoomPlanner          = require('Planner.Room');
var RoadPlanner          = require('Planner.Road');
var TradeEnergy          = require('Trade.Energy');
var CpuProfiler         = require('core.cpuProfiler');
var CoreConfig          = require('core.config');
var SourceEconomy       = require('Source.Economy');
var BeeToolbox          = require('BeeToolbox');

// Keep references to the role modules so validation can check the intended
// mapping (e.g. a swapped import would surface as a role name mismatch).
var roleModules = RoleRegistry.modules;
var creepRoles = RoleRegistry.runners;

// Capture missing bindings once so we can quickly spot miswired role imports.
var warnedMissingRoles = Object.create(null);
var warnedMismatchedRoleNames = Object.create(null);

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
  return Roles.canonicalRoleName(name);
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
    SourceEconomy.refreshRoomEconomyOnce(room);
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

function ensureNestedMap(root, key) {
  if (!root[key]) root[key] = Object.create(null);
  return root[key];
}

function ensureCountRecord(root, key, defaults) {
  if (!root[key]) {
    var rec = {};
    for (var field in defaults) {
      if (Object.prototype.hasOwnProperty.call(defaults, field)) rec[field] = defaults[field];
    }
    root[key] = rec;
  }
  return root[key];
}

function addCreepToHomeRoleIndex(index, homeRoom, roleName, creep) {
  if (!homeRoom || !roleName || !creep) return;
  var byRole = ensureNestedMap(index, homeRoom);
  if (!byRole[roleName]) byRole[roleName] = [];
  byRole[roleName].push(creep);
}

function addCreepToHomeRoleModeIndex(index, homeRoom, roleName, mode, creep) {
  if (!homeRoom || !roleName || !creep) return;
  var byRole = ensureNestedMap(index, homeRoom);
  var byMode = ensureNestedMap(byRole, roleName);
  var modeKey = mode || 'default';
  if (!byMode[modeKey]) byMode[modeKey] = [];
  byMode[modeKey].push(creep);
}

function incrementHomeRoleCount(index, homeRoom, roleName, amount) {
  if (!homeRoom || !roleName) return;
  var byRole = ensureNestedMap(index, homeRoom);
  byRole[roleName] = (byRole[roleName] || 0) + (amount || 1);
}

function incrementHomeRoleModeCount(index, homeRoom, roleName, mode, amount) {
  if (!homeRoom || !roleName) return;
  var byRole = ensureNestedMap(index, homeRoom);
  var byMode = ensureNestedMap(byRole, roleName);
  var modeKey = mode || 'default';
  byMode[modeKey] = (byMode[modeKey] || 0) + (amount || 1);
}

function indexLowTtlCreep(index, homeRoom, roleName, creep) {
  if (!homeRoom || !roleName || !creep || typeof creep.ticksToLive !== 'number') return;
  var byRole = ensureNestedMap(index, homeRoom);
  if (!byRole[roleName]) byRole[roleName] = [];
  byRole[roleName].push({
    name: creep.name,
    ttl: creep.ticksToLive,
    spawning: !!creep.spawning
  });
}

function incrementQueueCountIndexes(byRole, byRoleMode, byRoleTask, roomName, item) {
  if (!roomName || !item) return;
  var roleName = canonicalRoleName(item.role) || item.role;
  if (!roleName) return;
  var roomRole = ensureNestedMap(byRole, roomName);
  roomRole[roleName] = (roomRole[roleName] || 0) + 1;

  var roomRoleMode = ensureNestedMap(byRoleMode, roomName);
  var roleMode = ensureNestedMap(roomRoleMode, roleName);
  var modeKey = item.mode || 'default';
  roleMode[modeKey] = (roleMode[modeKey] || 0) + 1;

  var roomRoleTask = ensureNestedMap(byRoleTask, roomName);
  var roleTask = ensureNestedMap(roomRoleTask, roleName);
  var taskKey = item.task || 'default';
  roleTask[taskKey] = (roleTask[taskKey] || 0) + 1;
}

function estimateRemoteRoundTripTicks(homeRoom, remoteRoom) {
  if (BeeToolbox && typeof BeeToolbox.estimateRemoteRoundTripTicks === 'function') {
    return BeeToolbox.estimateRemoteRoundTripTicks(homeRoom, remoteRoom);
  }
  if (!homeRoom || !remoteRoom || !Game.map) return 9999;
  return Math.max(1, (Game.map.getRoomLinearDistance(homeRoom, remoteRoom) || 1) * 100);
}

// Function header: prepareTickCaches()
// Inputs: none
// Output: populated global.__BHM cache for this tick (rooms, spawns, counts, selectors).
// Side-effects: mutates global.__BHM; calls core.selectors.prepareRoomSnapshot for each owned room.
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
  var creepsByHomeRole = Object.create(null);
  var creepsByHomeRoleMode = Object.create(null);
  var liveCountsByHomeRole = Object.create(null);
  var liveCountsByHomeRoleMode = Object.create(null);
  var lowTtlByHomeRole = Object.create(null);
  var truckerAssignmentCountsByHome = Object.create(null);
  var repairAssignmentCountsByHome = Object.create(null);
  var creepNames = Object.keys(Game.creeps);
  for (var j = 0; j < creepNames.length; j++) {
    var creep = Game.creeps[creepNames[j]];
    creeps.push(creep);

    var roleName = ensureCreepRole(creep);
    var homeRoom = (creep.memory && creep.memory.home) || null;
    if (!homeRoom && creep.memory && creep.memory._home) homeRoom = creep.memory._home;
    if (!homeRoom && creep.memory && creep.memory.targetRoom) homeRoom = creep.memory.targetRoom;
    if (!homeRoom && creep.room) homeRoom = creep.room.name;
    var mode = creep.memory && creep.memory.mode ? creep.memory.mode : 'default';

    addCreepToHomeRoleIndex(creepsByHomeRole, homeRoom, roleName, creep);
    addCreepToHomeRoleModeIndex(creepsByHomeRoleMode, homeRoom, roleName, mode, creep);
    indexLowTtlCreep(lowTtlByHomeRole, homeRoom, roleName, creep);

    if (!creep.spawning) {
      incrementHomeRoleCount(liveCountsByHomeRole, homeRoom, roleName, 1);
      incrementHomeRoleModeCount(liveCountsByHomeRoleMode, homeRoom, roleName, mode, 1);
    }

    if (roleName === 'Trucker' && homeRoom) {
      var truckerCounts = ensureCountRecord(truckerAssignmentCountsByHome, homeRoom, {
        truckersOnLocalJobs: 0,
        truckersOnRemoteJobs: 0,
        truckersOnRemotePickup: 0,
        truckersOnRemoteReturn: 0,
        remoteCapableTruckers: 0
      });
      var job = creep.memory && creep.memory.dispatchJob;
      if (job && (job.type === 'REMOTE_PICKUP' || job.type === 'REMOTE_RETURN')) {
        truckerCounts.truckersOnRemoteJobs++;
        if (job.type === 'REMOTE_PICKUP') truckerCounts.truckersOnRemotePickup++;
        if (job.type === 'REMOTE_RETURN') truckerCounts.truckersOnRemoteReturn++;
        if (job.type === 'REMOTE_RETURN') {
          truckerCounts.remoteCapableTruckers++;
        } else {
          var remoteRoom = job.roomName || creep.memory.requestRoom || creep.memory.targetRoom;
          var requiredTtl = estimateRemoteRoundTripTicks(homeRoom, remoteRoom);
          var carryingEnergy = creep.store && creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0;
          if (typeof creep.ticksToLive !== 'number' || creep.ticksToLive >= requiredTtl || carryingEnergy) {
            truckerCounts.remoteCapableTruckers++;
          }
        }
      } else {
        truckerCounts.truckersOnLocalJobs++;
      }
    }

    if (roleName === 'Repair' && homeRoom) {
      var repairCounts = ensureCountRecord(repairAssignmentCountsByHome, homeRoom, {
        liveLocalRepair: 0,
        liveRemoteEmergencyRepair: 0
      });
      if (creep.memory && creep.memory.task === 'remoteContainerEmergencyRepair') {
        repairCounts.liveRemoteEmergencyRepair++;
      } else {
        repairCounts.liveLocalRepair++;
      }
    }

    // Avoid counting expiring creeps against quotas
    var ttl = creep.ticksToLive;
    if (typeof ttl === 'number' && ttl <= DYING_SOON_TTL) {
      continue;
    }

    roleCounts[roleName] = (roleCounts[roleName] || 0) + 1;

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

  // Spawn queues: scan once up-front. SpawnManager refreshes these indexes only
  // when it mutates a room queue later in the tick.
  var queueCountsByRoomRole = Object.create(null);
  var queueCountsByRoomRoleMode = Object.create(null);
  var queueCountsByRoomRoleTask = Object.create(null);
  for (var qi = 0; qi < ownedRooms.length; qi++) {
    var queueRoom = ownedRooms[qi];
    var queueMem = Memory.rooms && Memory.rooms[queueRoom.name];
    var queue = queueMem && Array.isArray(queueMem.spawnQueue) ? queueMem.spawnQueue : [];
    for (var qj = 0; qj < queue.length; qj++) {
      incrementQueueCountIndexes(queueCountsByRoomRole, queueCountsByRoomRoleMode, queueCountsByRoomRoleTask, queueRoom.name, queue[qj]);
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
  if (CoreSelectors && typeof CoreSelectors.prepareRoomSnapshot === 'function') {
    for (var n = 0; n < ownedRooms.length; n++) {
      var snapRoom = ownedRooms[n];
      if (!snapRoom || !snapRoom.name) continue;
      try {
        snapshots[snapRoom.name] = CpuProfiler.measure('core.selectors.prepareRoomSnapshot', function () {
          return CoreSelectors.prepareRoomSnapshot(snapRoom);
        });
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
  C.creepsByHomeRole = creepsByHomeRole;
  C.creepsByHomeRoleMode = creepsByHomeRoleMode;
  C.liveCountsByHomeRole = liveCountsByHomeRole;
  C.liveCountsByHomeRoleMode = liveCountsByHomeRoleMode;
  C.lowTtlByHomeRole = lowTtlByHomeRole;
  C.queueCountsByRoomRole = queueCountsByRoomRole;
  C.queueCountsByRoomRoleMode = queueCountsByRoomRoleMode;
  C.queueCountsByRoomRoleTask = queueCountsByRoomRoleTask;
  C.queueCountsDirtyByRoom = Object.create(null);
  C.queueSortedTickByRoom = Object.create(null);
  C.truckerAssignmentCountsByHome = truckerAssignmentCountsByHome;
  C.repairAssignmentCountsByHome = repairAssignmentCountsByHome;
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

    // Expose action/selectors globally for console debugging.
    // Teaching tip: doing this up-front ensures any role file that executes
    // later in the tick can immediately access the helpers.
    if (MovementActions) global.MovementActions = MovementActions;
    if (CoreSelectors) global.CoreSelectors = CoreSelectors;

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
      var tradeInterval = CoreConfig.settings && CoreConfig.settings.tradeEnergyInterval;
      tradeInterval = Math.max(1, Number(tradeInterval) || 7);
      if (Game.time % tradeInterval === 0) {
        CpuProfiler.measure('TradeEnergy.runAll', function () {
          TradeEnergy.runAll();
        });
      }
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
      CpuProfiler.measure('RoadPlanner.ensureRemoteRoads', function () {
        RoadPlanner.ensureRemoteRoads(room);
      });
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
    var roomsMem = MemoryUtils.ensureMemoryRoot('rooms');
    var roomNames = Object.keys(roomsMem);
    for (var i = 0; i < roomNames.length; i++) {
      var roomName = roomNames[i];
      if (!roomsMem[roomName] || typeof roomsMem[roomName] !== 'object') {
        // Always initialise to an object so downstream code can safely do
        // Memory.rooms[name].foo without crashing.
        roomsMem[roomName] = {};
      }
    }
  }
};

module.exports = BeeHiveMind;
