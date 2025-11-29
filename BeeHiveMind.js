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
var BaseHarvest          = require('role.BaseHarvest');
var Builder              = require('role.Builder');
var Courier              = require('role.Courier');
var Queen                = require('role.Queen');
var Upgrader             = require('role.Upgrader');
var Luna                 = require('role.Luna');
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

// Keep references to the role modules so validation can check the intended
// mapping (e.g. a swapped import would surface as a role name mismatch).
var roleModules = {
  BaseHarvest: BaseHarvest,
  Builder: Builder,
  Courier: Courier,
  Repair: roleRepair,
  Upgrader: Upgrader,
  Dismantler: roleDismantler,
  Luna: Luna,
  Scout: Scout,
  Queen: Queen,
  Trucker: Trucker,
  Claimer: Claimer,
  CombatArcher: CombatArcher,
  CombatMedic: CombatMedic,
  CombatMelee: CombatMelee
};

// Map role -> run fn (extend as you add roles)
// Default role map; specific roles (queen, courier etc.) may be registered
// elsewhere by mutating this object.
var creepRoles = {
  BaseHarvest: roleModules.BaseHarvest && roleModules.BaseHarvest.run,
  Builder: roleModules.Builder && roleModules.Builder.run,
  Courier: roleModules.Courier && roleModules.Courier.run,
  Repair: roleModules.Repair && roleModules.Repair.run,
  Upgrader: roleModules.Upgrader && roleModules.Upgrader.run,
  Dismantler: roleModules.Dismantler && roleModules.Dismantler.run,
  Luna: roleModules.Luna && roleModules.Luna.run,
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

function validateRoleBindings() {
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
  var lunaCountsByHome = Object.create(null);
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

    if (roleName === 'Luna') {
      var home = (creep.memory && creep.memory.home) || null;
      if (!home && creep.memory && creep.memory._home) home = creep.memory._home;
      if (!home && creep.room) home = creep.room.name;
      if (home) {
        lunaCountsByHome[home] = (lunaCountsByHome[home] || 0) + 1;
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
  C.lunaCountsByHome = lunaCountsByHome;
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
    BeeHiveMind.initializeMemory();

    // Expose action/selectors globally for console debugging and legacy modules
    // expecting global symbols.
    // Teaching tip: doing this up-front ensures any role file that executes
    // later in the tick can immediately access the helpers.
    if (BeeActions) global.BeeActions = BeeActions;
    if (BeeSelectors) global.BeeSelectors = BeeSelectors;

    // Verify role bindings once per tick so missing modules are visible in logs.
    validateRoleBindings();

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
      BeeHiveMind.manageRoom(rooms[i]);
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
    for (var i = 0; i < creeps.length; i++) {
      var creep = creeps[i];
      var roleName = ensureCreepRole(creep);
      var roleFn = creepRoles[roleName];
      if (typeof roleFn !== 'function') {
        // Skip unknown roles so a typo never stops the loop.
        continue;
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
