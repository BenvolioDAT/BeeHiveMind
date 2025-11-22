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
var roleBeeWorker        = require('role.BeeWorker');
var roleRepair           = require('role.Repair');
var roleDismantler       = require('role.Dismantler');
var roleBeeArmy          = require('role.BeeArmy');
var RoomPlanner          = require('Planner.Room');
var RoadPlanner          = require('Planner.Road');
var TradeEnergy          = require('Trade.Energy');

// Map role -> run fn (extend as you add roles)
// Default role map; specific roles (queen, courier etc.) may be registered
// elsewhere by mutating this object.
var creepRoles = {
  BaseHarvest: roleBeeWorker.runBaseHarvest,
  Builder: roleBeeWorker.runBuilder,
  Courier: roleBeeWorker.runCourier,
  Repair: roleRepair.run,
  Upgrader: roleBeeWorker.runUpgrader,
  Dismantler: roleDismantler.run,
  Luna: roleBeeWorker.runLuna,
  Scout: roleBeeWorker.runScout,
  Queen: roleBeeWorker.runQueen,
  Trucker: roleBeeWorker.runTrucker,
  Claimer: roleBeeWorker.runClaimer,
  CombatArcher: roleBeeArmy.runArcher,
  CombatMedic: roleBeeArmy.runMedic,
  CombatMelee: roleBeeArmy.runMelee
};

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
  map.remoteharvest = 'Luna';

  return map;
}

var ROLE_ALIAS_MAP = createRoleAliasMap();

function canonicalRoleName(name) {
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

function ensureCreepRole(creep) {
  // Novice tip: always guard against falsy values before dereferencing.
  if (!creep) return 'Idle';
  var mem = creep.memory || (creep.memory = {});

  // Prefer deterministic values; canonicalRoleName normalises any
  // mis-capitalised or legacy entries.
  var canonical = canonicalRoleName(mem.role) || canonicalRoleName(mem.task);
  if (!canonical) canonical = 'Idle';

  if (canonical === 'Luna' && mem && mem.task === 'remoteharvest') {
    mem.task = 'luna';
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
  // Early return: if we've already computed caches this tick, reuse them.
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
        // Teaching moment: catching errors allows the tick to continue even
        // if one room fails to generate a snapshot.
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
      // Habit: only push valid items so later functions can assume clean data.
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

    var roleName = ensureCreepRole(creep);
    roleCounts[roleName] = (roleCounts[roleName] || 0) + 1;

    if (roleName === 'Luna') {
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
    BeeHiveMind.initializeMemory();

    // Expose action/selectors globally for console debugging and legacy modules
    // expecting global symbols.
    // Teaching tip: doing this up-front ensures any role file that executes
    // later in the tick can immediately access the helpers.
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
    // Working from general to specific keeps the mental model tidy: rooms
    // come first, then creeps that exist inside those rooms.
    var rooms = C.roomsOwned;
    for (var i = 0; i < rooms.length; i++) {
      BeeHiveMind.manageRoom(rooms[i], C);
    }

    // 2) Per-creep behavior
    BeeHiveMind.runCreeps(C);

    if (MovementManager && typeof MovementManager.resolveAndMove === 'function') {
      // Execute queued movement intents after all roles finish issuing actions.
      // This mirrors a "commit" phase in a database transaction—everyone
      // proposes moves, then we resolve conflicts once.
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
      // Encourage small, single-purpose helpers: ensureSites focuses purely
      // on layout decisions so this coordinator stays readable.
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
      var roleName = ensureCreepRole(creep);
      var roleFn = creepRoles[roleName];
      if (typeof roleFn !== 'function') {
        // Soft fallback so a mis-typed role never crashes the tick.
        //roleFn = roleIdle.run;
      }
      try {
        roleFn(creep);
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
