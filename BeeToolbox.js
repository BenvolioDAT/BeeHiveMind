// BeeToolbox.js — ES5-safe helpers shared across roles/tasks
// NOTE: Compatible with Screeps runtime (no arrow funcs, no const/let, no includes, etc.)

'use strict';

var Traveler = require('Traveler');
var Logger = require('core.logger');
var LOG_LEVEL = Logger.LOG_LEVEL;
var toolboxLog = Logger.createLogger('Toolbox', LOG_LEVEL.BASIC);

var RUNTIME_STATE = global.__beeToolboxRuntime;
if (!RUNTIME_STATE) {
  RUNTIME_STATE = {
    planner: {},
    audit: {},
    spawnNotes: {},
    capabilities: {}
  };
  global.__beeToolboxRuntime = RUNTIME_STATE;
}

var DEBUG_INTERVAL = 75; // refresh Memory.debug.rclReport roughly every 75 ticks

function normalizeRoomArg(roomOrName) {
  if (!roomOrName) return null;
  if (typeof roomOrName === 'string') return roomOrName;
  if (roomOrName.name) return roomOrName.name;
  if (roomOrName.room && roomOrName.room.name) return roomOrName.room.name;
  return null;
}

// Interval (in ticks) before we rescan containers adjacent to sources.
// Kept small enough to react to construction/destruction, but large enough
// to avoid expensive FIND_STRUCTURES work every few ticks.
var SOURCE_CONTAINER_SCAN_INTERVAL = 50;

var BeeToolbox = {

  // ---------------------------------------------------------------------------
  // 🧰 GENERIC HELPERS
  // ---------------------------------------------------------------------------

  /**
   * Determine if an object owns a property key without walking the prototype chain.
   * @param {object} obj Potential owner of the key.
   * @param {string} key Property name to inspect.
   * @returns {boolean} True when the property exists directly on the object.
   * @sideeffects None.
   * @cpu O(1).
   * @memory None beyond call stack.
   */
  hasOwn: function (obj, key) {
    return !!(obj && Object.prototype.hasOwnProperty.call(obj, key));
  },

  /**
   * Determine if a string is a valid Screeps room name (e.g. W12N34).
   * @param {string} name Candidate room name.
   * @returns {boolean} True when the name matches the required pattern.
   */
  isValidRoomName: function (name) {
    if (typeof name !== 'string') return false;
    return /^[WE]\d+[NS]\d+$/.test(name);
  },

  /**
   * Safely compute linear distance between rooms, guarding against invalid inputs.
   * @param {string} a Origin room name.
   * @param {string} b Destination room name.
   * @param {boolean} allowInexact Optional Screeps flag to allow highway approximations.
   * @returns {number} Distance or a high sentinel when names are invalid.
   */
  safeLinearDistance: function (a, b, allowInexact) {
    if (!BeeToolbox.isValidRoomName(a) || !BeeToolbox.isValidRoomName(b)) {
      return 9999;
    }
    if (!Game || !Game.map || typeof Game.map.getRoomLinearDistance !== 'function') {
      return 9999;
    }
    return Game.map.getRoomLinearDistance(a, b, allowInexact);
  },

  /**
   * Check whether a value behaves like an object (non-null, type object).
   * @param {*} value Candidate value.
   * @returns {boolean} True when the value is an object.
   * @sideeffects None.
   * @cpu O(1).
   * @memory None beyond call stack.
   */
  isObject: function (value) {
    return value !== null && typeof value === 'object';
  },

  /**
   * Retrieve the controller level for an owned room (0 when uncontrolled).
   * Used by multiple managers to scale behaviour with the room progression.
   * @param {Room} room Screeps room reference.
   * @returns {number} Numeric controller level or 0 when unavailable.
   */
  getRoomRcl: function (room) {
    if (!room || !room.controller || !room.controller.my) return 0;
    return room.controller.level | 0;
  },

  /**
   * Retrieve the tier descriptor for a room based on controller level.
   * @param {Room} room Room to inspect.
   * @returns {{ level: number, tier: string }} Tuple describing the room tier.
   */
  getRclTier: function (room) {
    var rcl = BeeToolbox.getRoomRcl(room);
    return { level: rcl, tier: BeeToolbox.getRclTierName(rcl) };
  },

  /**
   * Map a numeric controller level into a coarse progression tier string.
   * The tiers are reused by spawning, task priorities, and planners.
   * @param {number} rcl Controller level value.
   * @returns {string} Tier identifier (early|developing|expansion|late).
   */
  getRclTierName: function (rcl) {
    if (!rcl) return 'early';
    if (rcl <= 2) return 'early';
    if (rcl <= 4) return 'developing';
    if (rcl <= 6) return 'expansion';
    return 'late';
  },

  /**
   * Determine the maximum number of a structure type allowed at the provided RCL.
   * @param {string} structureType Screeps structure constant.
   * @param {number} rcl Controller level (defaults to current highest owned when omitted).
   * @returns {number} Maximum allowed count.
   */
  getMaxAllowed: function (structureType, rcl) {
    if (!structureType) return 0;
    var level = (rcl == null) ? BeeToolbox.getHighestOwnedRcl() : (rcl | 0);
    if (level < 0) level = 0;
    var table = (typeof CONTROLLER_STRUCTURES !== 'undefined') ? CONTROLLER_STRUCTURES[structureType] : null;
    if (!table) return 0;
    var allowed = table[level];
    if (allowed == null) {
      // Walk downward to find last defined entry (handles sparse tables gracefully)
      for (var lvl = level; lvl >= 0; lvl--) {
        if (table[lvl] != null) {
          allowed = table[lvl];
          break;
        }
      }
    }
    return (allowed == null) ? 0 : (allowed | 0);
  },

  /**
   * Count structures of the provided type already present in the room.
   * @param {Room} room Room to inspect.
   * @param {string} structureType Screeps structure constant.
   * @returns {number} Count of existing (fully built) structures owned by the player.
   */
  countExisting: function (room, structureType) {
    if (!room || !structureType) return 0;
    var list = room.find(FIND_MY_STRUCTURES, {
      filter: function (s) { return s.structureType === structureType; }
    });
    return list ? list.length : 0;
  },

  /**
   * Count construction sites of the provided type in the room.
   * @param {Room} room Room to inspect.
   * @param {string} structureType Screeps structure constant.
   * @returns {number} Count of friendly construction sites of that type.
   */
  countSites: function (room, structureType) {
    if (!room || !structureType) return 0;
    var list = room.find(FIND_CONSTRUCTION_SITES, {
      filter: function (s) {
        return s.my && s.structureType === structureType;
      }
    });
    return list ? list.length : 0;
  },

  /**
   * Determine whether the room still needs more of the provided structure type.
   * @param {Room} room Room reference.
   * @param {string} structureType Screeps structure constant.
   * @param {number} rcl Optional explicit controller level.
   * @returns {boolean} True when existing + sites is below the maximum allowed.
   */
  needsMore: function (room, structureType, rcl) {
    if (!room || !structureType) return false;
    var existing = BeeToolbox.countExisting(room, structureType);
    var sites = BeeToolbox.countSites(room, structureType);
    var allowed = BeeToolbox.getMaxAllowed(structureType, (rcl == null) ? BeeToolbox.getRoomRcl(room) : rcl);
    return (existing + sites) < allowed;
  },

  /**
   * Check if a room can afford a body configuration at full energy capacity.
   * @param {Room} room Target room.
   * @param {string[]} bodyParts Array of body part constants.
   * @returns {boolean} True when body cost is within energy capacity.
   */
  canAffordBody: function (room, bodyParts) {
    if (!room || !bodyParts || !bodyParts.length) return false;
    var capacity = BeeToolbox.energyCapacity(room);
    var cost = 0;
    for (var i = 0; i < bodyParts.length; i++) {
      cost += BODYPART_COST[bodyParts[i]] || 0;
    }
    return cost <= capacity;
  },

  /**
   * Retrieve the room's spawning energy capacity.
   * @param {Room} room Target room or null.
   * @returns {number} Available capacity (spawns + extensions).
   */
  energyCapacity: function (room) {
    if (!room) return 0;
    if (typeof room.energyCapacityAvailable === 'number') {
      return room.energyCapacityAvailable | 0;
    }
    var sum = 0;
    var structures = room.find(FIND_MY_STRUCTURES);
    for (var i = 0; i < structures.length; i++) {
      var s = structures[i];
      if (!s.store) continue;
      if (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) {
        sum += s.store.getCapacity(RESOURCE_ENERGY) || 0;
      }
    }
    return sum;
  },

  /**
   * Retrieve the room's currently available spawning energy.
   * @param {Room} room Target room or null.
   * @returns {number} Energy currently stored in spawns + extensions.
   */
  energyAvailable: function (room) {
    if (!room) return 0;
    if (typeof room.energyAvailable === 'number') {
      return room.energyAvailable | 0;
    }
    var sum = 0;
    var structures = room.find(FIND_MY_STRUCTURES);
    for (var i = 0; i < structures.length; i++) {
      var s = structures[i];
      if (!s.store) continue;
      if (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) {
        sum += s.store[RESOURCE_ENERGY] || 0;
      }
    }
    return sum;
  },

  /**
   * Store transient planner data for later consumers (TaskManager, reporters, etc.).
   * @param {string} roomName Room identifier.
   * @param {object} data Planner summary data.
   */
  storePlannerState: function (roomName, data) {
    if (!roomName) return;
    RUNTIME_STATE.planner[roomName] = data || null;
  },

  /**
   * Retrieve the stored planner snapshot for a room.
   * @param {string} roomName Room identifier.
   * @returns {object|null} Planner data or null when absent.
   */
  getPlannerState: function (roomName) {
    if (!roomName) return null;
    return RUNTIME_STATE.planner[roomName] || null;
  },

  /**
   * Retrieve the runtime planner mapping for all rooms.
   * @returns {object} Internal planner mapping.
   */
  getAllPlannerStates: function () {
    return RUNTIME_STATE.planner;
  },

  /**
   * Store construction audit data (built vs sites etc.).
   * @param {string} roomName Room identifier.
   * @param {object} data Audit summary data.
   */
  storeAuditState: function (roomName, data) {
    if (!roomName) return;
    RUNTIME_STATE.audit[roomName] = data || null;
  },

  /**
   * Retrieve construction audit information for a room.
   * @param {string} roomName Room identifier.
   * @returns {object|null} Audit summary or null.
   */
  getAuditState: function (roomName) {
    if (!roomName) return null;
    return RUNTIME_STATE.audit[roomName] || null;
  },

  /**
   * Reset transient planner/audit caches. Intended for the top-level pipeline each tick.
   */
  resetPlannerRuntime: function () {
    RUNTIME_STATE.planner = {};
    RUNTIME_STATE.audit = {};
    RUNTIME_STATE.spawnNotes = {};
    RUNTIME_STATE.capabilities = {};
  },

  /**
   * Record a spawn downshift note to be surfaced in debug reports.
   * @param {string} roomName Room identifier.
   * @param {string} reason Human-readable explanation.
   */
  noteSpawnDownshift: function (roomName, reason) {
    if (!roomName || !reason) return;
    if (!RUNTIME_STATE.spawnNotes[roomName]) {
      RUNTIME_STATE.spawnNotes[roomName] = [];
    }
    RUNTIME_STATE.spawnNotes[roomName].push({ tick: Game.time, reason: reason });
  },

  /**
   * Retrieve and clear spawn downshift notes for a room.
   * @param {string} roomName Room identifier.
   * @returns {Array} Array of notes consumed this tick.
   */
  consumeSpawnNotes: function (roomName) {
    if (!roomName) return [];
    var notes = RUNTIME_STATE.spawnNotes[roomName] || [];
    RUNTIME_STATE.spawnNotes[roomName] = [];
    return notes;
  },

  /**
   * Update Memory.debug.rclReport for a room at the configured cadence.
   * @param {string} roomName Room identifier.
   * @param {object} payload Summary including structures/nextSteps fields.
   * @param {Array} spawnNotes Optional spawn downshift notes.
   */
  refreshRoomReport: function (roomName, payload, spawnNotes) {
    if (!roomName) return;
    if (!Memory.debug) Memory.debug = {};
    if (!Memory.debug.rclReport) Memory.debug.rclReport = {};
    if (!Memory.debug.rclReport[roomName]) {
      Memory.debug.rclReport[roomName] = {
        lastTick: 0,
        structures: {},
        spawnNotes: [],
        nextSteps: [],
        console: false
      };
    }
    var entry = Memory.debug.rclReport[roomName];
    var shouldUpdate = !entry.lastTick || (Game.time - entry.lastTick) >= DEBUG_INTERVAL;
    if (!shouldUpdate && !payload) {
      return;
    }
    entry.lastTick = Game.time;
    if (payload && payload.structures) {
      entry.structures = payload.structures;
    }
    if (payload && payload.nextSteps) {
      entry.nextSteps = payload.nextSteps;
    }
    if (spawnNotes) {
      entry.spawnNotes = spawnNotes;
    }
    if (entry.console) {
      try {
        console.log('[RCL] ' + roomName + ' planned=' + JSON.stringify(entry.structures) + ' next=' + JSON.stringify(entry.nextSteps));
        if (entry.spawnNotes && entry.spawnNotes.length) {
          console.log('[RCL] ' + roomName + ' spawnNotes=' + JSON.stringify(entry.spawnNotes));
        }
      } catch (e) {}
    }
  },

  /**
   * Determine the highest controller level across all owned rooms.
   * @returns {number} Highest detected RCL, or 0 when no rooms are owned.
   */
  getHighestOwnedRcl: function () {
    var highest = 0;
    for (var roomName in Game.rooms) {
      if (!BeeToolbox.hasOwn(Game.rooms, roomName)) continue;
      var room = Game.rooms[roomName];
      var rcl = BeeToolbox.getRoomRcl(room);
      if (rcl > highest) {
        highest = rcl;
      }
    }
    return highest;
  },

  /**
   * Retrieve combined planner and audit information for a structure type.
   * @param {(Room|string)} roomOrName Room reference or room name.
   * @param {string} structureType Screeps structure constant.
   * @returns {object} Summary with desired/existing/sites/missing counts.
   */
  getPlannerStructureSummary: function (roomOrName, structureType) {
    var roomName = normalizeRoomArg(roomOrName);
    var summary = {
      roomName: roomName,
      type: structureType,
      desired: 0,
      existing: 0,
      sites: 0,
      planned: 0,
      blocked: 0,
      allowed: 0,
      missing: 0
    };

    if (!roomName || !structureType) {
      return summary;
    }

    var plan = BeeToolbox.getPlannerState(roomName);
    if (plan && plan.structures && plan.structures[structureType]) {
      var entry = plan.structures[structureType];
      summary.desired = (entry.desired | 0);
      summary.existing = (entry.existing | 0);
      summary.sites = (entry.sites | 0);
      summary.planned = (entry.planned | 0);
      summary.blocked = (entry.blocked | 0);
      summary.allowed = (entry.desired | 0);
      summary.missing = Math.max(0, (entry.desired | 0) - (entry.existing | 0) - (entry.sites | 0));
    }

    var audit = BeeToolbox.getAuditState(roomName);
    if (audit && audit.structures && audit.structures[structureType]) {
      var auditEntry = audit.structures[structureType];
      if ((auditEntry.existing | 0) > summary.existing) {
        summary.existing = auditEntry.existing | 0;
      }
      if ((auditEntry.sites | 0) > summary.sites) {
        summary.sites = auditEntry.sites | 0;
      }
      if ((auditEntry.allowed | 0) > summary.allowed) {
        summary.allowed = auditEntry.allowed | 0;
      }
      if ((auditEntry.missing | 0) > summary.missing) {
        summary.missing = auditEntry.missing | 0;
      }
    }

    var room = (Game.rooms && roomName) ? Game.rooms[roomName] : null;
    if (room) {
      var existing = BeeToolbox.countExisting(room, structureType);
      var sites = BeeToolbox.countSites(room, structureType);
      if (existing > summary.existing) summary.existing = existing;
      if (sites > summary.sites) summary.sites = sites;
    }

    if (!summary.allowed) {
      var rcl = plan && plan.rcl ? plan.rcl : BeeToolbox.getRoomRcl(room);
      summary.allowed = BeeToolbox.getMaxAllowed(structureType, rcl);
    }
    if (!summary.desired && summary.allowed) {
      summary.desired = summary.allowed;
    }
    if (!summary.missing) {
      var deficit = (summary.desired | 0) - (summary.existing | 0) - (summary.sites | 0);
      if (deficit > 0) summary.missing = deficit;
    }

    return summary;
  },

  /**
   * High-level structure status summary including totals and remaining slots.
   * @param {(Room|string)} roomOrName Room reference or name.
   * @param {string} structureType Screeps structure constant.
   * @returns {object} Status with existing, sites, total, and remaining counts.
   */
  getStructureStatus: function (roomOrName, structureType) {
    var status = BeeToolbox.getPlannerStructureSummary(roomOrName, structureType);
    status.total = (status.existing | 0) + (status.sites | 0);
    status.remaining = Math.max(0, (status.desired | 0) - status.total);
    return status;
  },

  /**
   * Describe the current capabilities of a room (storage, links, containers, etc.).
   * @param {(Room|string)} roomOrName Room reference or room name.
   * @returns {object} Capability descriptor for the current tick.
   */
  getRoomCapabilities: function (roomOrName) {
    var roomName = normalizeRoomArg(roomOrName);
    if (!roomName) {
      return {
        roomName: null,
        rcl: 0,
        tier: 'early'
      };
    }

    var cache = RUNTIME_STATE.capabilities[roomName];
    if (cache && cache.tick === Game.time) {
      return cache.data;
    }

    var room = (Game.rooms && Game.rooms[roomName]) ? Game.rooms[roomName] : null;
    var rcl = BeeToolbox.getRoomRcl(room);
    var tier = BeeToolbox.getRclTierName(rcl);

    var info = {
      roomName: roomName,
      rcl: rcl,
      tier: tier,
      hasController: !!(room && room.controller && room.controller.my),
      hasStorage: false,
      storageId: null,
      storageEnergy: 0,
      storagePlanned: false,
      storageRemaining: 0,
      hasTerminal: false,
      terminalId: null,
      controllerLinkId: null,
      controllerContainerId: null,
      sourceContainerCount: 0,
      energyCapacity: room ? BeeToolbox.energyCapacity(room) : 0,
      energyAvailable: room ? BeeToolbox.energyAvailable(room) : 0
    };

    var storageStatus = BeeToolbox.getStructureStatus(roomName, STRUCTURE_STORAGE);
    info.storagePlanned = (storageStatus.desired | 0) > 0;
    info.storageRemaining = storageStatus.remaining | 0;

    if (room) {
      if (room.storage) {
        info.hasStorage = true;
        info.storageId = room.storage.id;
        info.storageEnergy = (room.storage.store && room.storage.store[RESOURCE_ENERGY]) || 0;
      }
      if (room.terminal) {
        info.hasTerminal = true;
        info.terminalId = room.terminal.id;
      }

      var containers = room.find(FIND_STRUCTURES, {
        filter: function (s) {
          return s.structureType === STRUCTURE_CONTAINER && s.pos.findInRange(FIND_SOURCES, 1).length > 0;
        }
      });
      info.sourceContainerCount = containers ? containers.length : 0;

      if (room.controller) {
        var nearLink = room.controller.pos.findInRange(FIND_MY_STRUCTURES, 2, {
          filter: function (s) { return s.structureType === STRUCTURE_LINK; }
        });
        if (nearLink && nearLink.length) {
          info.controllerLinkId = nearLink[0].id;
        }
        var nearContainer = room.controller.pos.findInRange(FIND_STRUCTURES, 2, {
          filter: function (s) { return s.structureType === STRUCTURE_CONTAINER; }
        });
        if (nearContainer && nearContainer.length) {
          info.controllerContainerId = nearContainer[0].id;
        }
      }
    }

    RUNTIME_STATE.capabilities[roomName] = {
      tick: Game.time,
      data: info
    };

    return info;
  },

  /**
   * Evaluate if an object has no enumerable own properties.
   * @param {object} obj Object to evaluate.
   * @returns {boolean} True if the object is empty.
   * @sideeffects None.
   * @cpu O(n) over enumerable keys.
   * @memory None beyond iteration variables.
   */
  isEmptyObject: function (obj) {
    if (!BeeToolbox.isObject(obj)) return true;
    for (var key in obj) {
      if (BeeToolbox.hasOwn(obj, key)) {
        return false;
      }
    }
    return true;
  },

  // ---------------------------------------------------------------------------
  // 📒 SOURCE & CONTAINER INTEL
  // ---------------------------------------------------------------------------

  /**
   * Persist the list of energy sources within a room to room memory.
   * @param {Room} room Screeps room to scan.
   * @returns {void}
   * @sideeffects Ensures Memory.rooms[room.name].sources exists and is populated.
   * @cpu O(sources) on first scan, O(1) on subsequent ticks.
   * @memory Stores source identifiers in persistent memory.
   */
  logSourcesInRoom: function (room) {
    if (!room) return;

    if (!Memory.rooms) Memory.rooms = {};
    if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};
    if (!Memory.rooms[room.name].sources) Memory.rooms[room.name].sources = {};

    // If already populated, skip (CPU hygiene)
    var hasAny = false;
    for (var k in Memory.rooms[room.name].sources) { if (Memory.rooms[room.name].sources.hasOwnProperty(k)) { hasAny = true; break; } }
    if (hasAny) return;

    var sources = room.find(FIND_SOURCES);
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];
      if (!Memory.rooms[room.name].sources[s.id]) {
        Memory.rooms[room.name].sources[s.id] = {}; // room coords optional if you like
        if (Logger.shouldLog(LOG_LEVEL.BASIC)) {
          toolboxLog.info('Logged source', s.id, 'in room', room.name);
        }
      }
    }
    if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
      try {
        toolboxLog.debug('Final sources in', room.name + ':', JSON.stringify(Memory.rooms[room.name].sources));
      } catch (e) {}
    }
  },

  /**
   * Track containers adjacent to energy sources within the room.
   * @param {Room} room Screeps room to inspect.
   * @returns {void}
   * @sideeffects Updates Memory.rooms[room.name].sourceContainers with container IDs.
   * @cpu Moderate when scans execute due to FIND_STRUCTURES, otherwise minimal.
   * @memory Persists container assignments and scan timestamps.
   */
  logSourceContainersInRoom: function (room) {
    if (!room) return;
    if (!Memory.rooms) Memory.rooms = {};
    if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};
    if (!Memory.rooms[room.name].sourceContainers) Memory.rooms[room.name].sourceContainers = {};

    var roomMem = Memory.rooms[room.name];
    if (!roomMem._toolbox) roomMem._toolbox = {};
    if (!roomMem._toolbox.sourceContainerScan) roomMem._toolbox.sourceContainerScan = {};

    var scanState = roomMem._toolbox.sourceContainerScan;
    var now = Game.time | 0;
    var nextScan = scanState.nextScan | 0;

    if (nextScan && now < nextScan) {
      return; // recently scanned; skip heavy find work
    }

    var containers = room.find(FIND_STRUCTURES, {
      filter: function (s) {
        if (s.structureType !== STRUCTURE_CONTAINER) return false;
        var near = s.pos.findInRange(FIND_SOURCES, 1);
        return near && near.length > 0;
      }
    });

    var found = {};
    for (var i = 0; i < containers.length; i++) {
      var c = containers[i];
      found[c.id] = true;
      if (!roomMem.sourceContainers.hasOwnProperty(c.id)) {
        roomMem.sourceContainers[c.id] = null; // unassigned
        if (Logger.shouldLog(LOG_LEVEL.BASIC)) {
          toolboxLog.info('Registered container', c.id, 'near source in', room.name);
        }
      }
    }

    // Remove containers that no longer exist next to sources (destroyed / moved).
    for (var cid in roomMem.sourceContainers) {
      if (!roomMem.sourceContainers.hasOwnProperty(cid)) continue;
      if (!found[cid]) {
        delete roomMem.sourceContainers[cid];
      }
    }

    scanState.lastScanTick = now;
    scanState.nextScan = now + SOURCE_CONTAINER_SCAN_INTERVAL;
    scanState.lastKnownCount = containers.length;
  },

  /**
   * Reserve an unassigned source container for a courier creep.
   * @param {Creep} creep Courier creep requesting a container.
   * @returns {void}
   * @sideeffects Writes creep.memory.assignedContainer and updates Memory.rooms[targetRoom].sourceContainers.
   * @cpu Iterates over stored container map; low overhead.
   * @memory No additional persistent memory allocations beyond assignment strings.
   */
  assignContainerFromMemory: function (creep) {
    if (!creep || creep.memory.assignedContainer) return;

    var targetRoom = creep.memory.targetRoom;
    if (!targetRoom || !Memory.rooms || !Memory.rooms[targetRoom]) return;

    var mem = Memory.rooms[targetRoom];
    if (!mem.sourceContainers) return;

    for (var containerId in mem.sourceContainers) {
      if (!mem.sourceContainers.hasOwnProperty(containerId)) continue;
      var assigned = mem.sourceContainers[containerId];
      if (!assigned || !Game.creeps[assigned]) {
        creep.memory.assignedContainer = containerId;
        mem.sourceContainers[containerId] = creep.name;
        if (Logger.shouldLog(LOG_LEVEL.BASIC)) {
          toolboxLog.info('Courier', creep.name, 'pre-assigned to container', containerId, 'in', targetRoom);
        }
        return;
      }
    }
  },

  /**
   * Flag a room as hostile when an invader core is detected.
   * @param {Room} room Room to analyze.
   * @returns {void}
   * @sideeffects Sets Memory.rooms[room.name].hostile when a core is present.
   * @cpu Low due to targeted FIND_HOSTILE_STRUCTURES query.
   * @memory Minimal; only stores a boolean flag.
   */
  logHostileStructures: function (room) {
    if (!room) return;
    var invaderCore = room.find(FIND_HOSTILE_STRUCTURES, {
      filter: function (s) { return s.structureType === STRUCTURE_INVADER_CORE; }
    });
    if (invaderCore.length > 0) {
      if (!Memory.rooms) Memory.rooms = {};
      if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};
      Memory.rooms[room.name].hostile = true;
      if (Logger.shouldLog(LOG_LEVEL.BASIC)) {
        toolboxLog.warn('Marked', room.name, 'as hostile due to Invader Core.');
      }
    }
  },

  // ---------------------------------------------------------------------------
  // 🔁 SIMPLE STATE HELPERS
  // ---------------------------------------------------------------------------

  /**
   * Flip a creep's returning flag based on carried energy.
   * @param {Creep} creep Worker creep to update.
   * @returns {void}
   * @sideeffects Mutates creep.memory.returning.
   * @cpu O(1).
   * @memory No new allocations.
   */
  updateReturnState: function (creep) {
    if (!creep) return;
    if (creep.memory.returning && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.returning = false;
    }
    if (!creep.memory.returning && creep.store.getFreeCapacity() === 0) {
      creep.memory.returning = true;
    }
  },

  /**
   * Discover nearby rooms that already have source intel recorded in memory.
   * @param {string} roomName Origin room name.
   * @param {number} range Manhattan radius to inspect.
   * @returns {string[]} Array of neighboring room names with known sources.
   * @sideeffects None.
   * @cpu O(range^2) string work.
   * @memory Allocates a transient array of room names.
   */
  getNearbyRoomsWithSources: function (roomName, range) {
    range = (typeof range === 'number') ? range : 1;
    if (!roomName) return [];

    var match = /([WE])(\d+)([NS])(\d+)/.exec(roomName);
    if (!match) return [];

    var ew = match[1], xStr = match[2], ns = match[3], yStr = match[4];
    var x = parseInt(xStr, 10);
    var y = parseInt(yStr, 10);
    var out = [];

    for (var dx = -range; dx <= range; dx++) {
      for (var dy = -range; dy <= range; dy++) {
        if (dx === 0 && dy === 0) continue;

        var newX = (ew === 'W') ? (x - dx) : (x + dx);
        var newY = (ns === 'N') ? (y - dy) : (y + dy);
        var newEW = newX >= 0 ? 'E' : 'W';
        var newNS = newY >= 0 ? 'S' : 'N';
        var rn = newEW + Math.abs(newX) + newNS + Math.abs(newY);

        var mem = (Memory.rooms && Memory.rooms[rn]) ? Memory.rooms[rn] : null;
        if (mem && mem.sources) {
          // has at least one key?
          var hasKey = false;
          for (var k in mem.sources) { if (mem.sources.hasOwnProperty(k)) { hasKey = true; break; } }
          if (hasKey) out.push(rn);
        }
      }
    }
    return out;
  },

  // ---------------------------------------------------------------------------
  // ⚡ ENERGY GATHER & DELIVERY
  // ---------------------------------------------------------------------------

  /**
   * Prepare a per-tick global energy target cache structure.
   * @returns {object|null} Cache bucket stored on global or a fresh object when global unavailable.
   * @sideeffects Mutates global.__energyTargets each tick.
   * @cpu O(1).
   * @memory Keeps lightweight cache per room each tick.
   */
  _ensureGlobalEnergyCache: function () {
    if (typeof global === 'undefined') return null;
    if (!global.__energyTargets || global.__energyTargets.tick !== Game.time) {
      global.__energyTargets = { tick: Game.time, rooms: {} };
    }
    if (!global.__energyTargets.rooms) {
      global.__energyTargets.rooms = {};
    }
    return global.__energyTargets;
  },

  /**
   * Build a list of energy-bearing objects within a room.
   * @param {Room} room Room to analyze.
   * @returns {object} Cache with arrays of object IDs keyed by energy source type.
   * @sideeffects None beyond returned structure.
   * @cpu Moderate due to multiple FIND queries.
   * @memory Allocates arrays of identifiers.
   */
  _buildEnergyCacheForRoom: function (room) {
    var cache = { ruins: [], tombstones: [], dropped: [], containers: [] };
    if (!room) return cache;

    var ruins = room.find(FIND_RUINS, {
      filter: function (r) { return r.store && r.store[RESOURCE_ENERGY] > 0; }
    });
    for (var i = 0; i < ruins.length; i++) {
      cache.ruins.push(ruins[i].id);
    }

    var tombstones = room.find(FIND_TOMBSTONES, {
      filter: function (t) { return t.store && t.store[RESOURCE_ENERGY] > 0; }
    });
    for (var j = 0; j < tombstones.length; j++) {
      cache.tombstones.push(tombstones[j].id);
    }

    var dropped = room.find(FIND_DROPPED_RESOURCES, {
      filter: function (r) { return r.resourceType === RESOURCE_ENERGY && r.amount > 0; }
    });
    for (var k = 0; k < dropped.length; k++) {
      cache.dropped.push(dropped[k].id);
    }

    var containers = room.find(FIND_STRUCTURES, {
      filter: function (s) {
        return s.structureType === STRUCTURE_CONTAINER && s.store && s.store[RESOURCE_ENERGY] > 0;
      }
    });
    for (var m = 0; m < containers.length; m++) {
      cache.containers.push(containers[m].id);
    }

    return cache;
  },

  /**
   * Fetch the cached energy lookup for a room, rebuilding when missing.
   * @param {Room} room Room of interest.
   * @returns {object} Energy cache entry.
   * @sideeffects May update global cache.
   * @cpu Low when cache exists; moderate when rebuilding.
   * @memory Reuses cached arrays.
   */
  _getRoomEnergyCache: function (room) {
    if (!room) return { ruins: [], tombstones: [], dropped: [], containers: [] };
    var globalCache = BeeToolbox._ensureGlobalEnergyCache();
    if (!globalCache) {
      return BeeToolbox._buildEnergyCacheForRoom(room);
    }

    var roomCache = globalCache.rooms[room.name];
    if (!roomCache) {
      roomCache = BeeToolbox._buildEnergyCacheForRoom(room);
      globalCache.rooms[room.name] = roomCache;
    }
    return roomCache;
  },

  /**
   * Force a rebuild of the room energy cache.
   * @param {Room} room Room to refresh.
   * @returns {object} Newly built cache.
   * @sideeffects Replaces cache entry for the room.
   * @cpu Moderate due to repeated FIND calls.
   * @memory Reallocates arrays for the refreshed cache.
   */
  _refreshRoomEnergyCache: function (room) {
    if (!room) return { ruins: [], tombstones: [], dropped: [], containers: [] };
    var globalCache = BeeToolbox._ensureGlobalEnergyCache();
    var newCache = BeeToolbox._buildEnergyCacheForRoom(room);
    if (globalCache) {
      globalCache.rooms[room.name] = newCache;
    }
    return newCache;
  },

  /**
   * Retrieve live energy targets from cache while validating availability.
   * @param {Room} room Room of interest.
   * @param {string} key Cache key (ruins, tombstones, dropped, containers).
   * @param {function} validator Callback verifying objects still hold energy.
   * @returns {Array} Array of Screeps objects ready for interaction.
   * @sideeffects Updates cached ID lists to reflect validity.
   * @cpu Low when cache entries valid; moderate when rebuild required.
   * @memory No additional persistent use; temporary arrays only.
   */
  _getEnergyTargetsFromCache: function (room, key, validator) {
    var cache = BeeToolbox._getRoomEnergyCache(room);
    var ids = cache[key] || [];
    var valid = [];
    var updatedIds = [];

    for (var i = 0; i < ids.length; i++) {
      var obj = Game.getObjectById(ids[i]);
      if (!obj || (validator && !validator(obj))) {
        continue;
      }
      valid.push(obj);
      updatedIds.push(ids[i]);
    }

    cache[key] = updatedIds;

    if (valid.length === 0) {
      cache = BeeToolbox._refreshRoomEnergyCache(room);
      ids = cache[key] || [];
      valid = [];
      updatedIds = [];
      for (var j = 0; j < ids.length; j++) {
        var refreshedObj = Game.getObjectById(ids[j]);
        if (!refreshedObj || (validator && !validator(refreshedObj))) {
          continue;
        }
        valid.push(refreshedObj);
        updatedIds.push(ids[j]);
      }
      cache[key] = updatedIds;
    }

    return valid;
  },
  
  /**
   * Pull energy from prioritized cached targets for a creep.
   * @param {Creep} creep Worker creep to refuel.
   * @returns {void}
   * @sideeffects Initiates movement and pickup/withdraw actions; may refresh caches.
   * @cpu Moderate depending on pathfinding and cache refreshes.
   * @memory Uses cached ID arrays; no persistent allocation.
   */
  collectEnergy: function (creep) {
    if (!creep) return;

    function tryWithdraw(targets, action) {
      if (!targets || !targets.length) return false;

      var target = creep.pos.findClosestByPath(targets);
      if (!target) return false;

      var result;
      if (action === 'pickup') {
        result = creep.pickup(target);
      } else {
        result = creep.withdraw(target, RESOURCE_ENERGY);
      }
      if (result === ERR_NOT_IN_RANGE) {
        BeeToolbox.BeeTravel(creep, target, { range: 1, ignoreCreeps: true });
      }
      return result === OK;
    }

    var room = creep.room;
    
    // Ruins with energy
    //if (tryWithdraw(creep.room.find(FIND_RUINS, { filter: function (r) { return r.store && r.store[RESOURCE_ENERGY] > 0; } }), 'withdraw')) return;
    if (tryWithdraw(BeeToolbox._getEnergyTargetsFromCache(room, 'ruins', function (target) {
      return target.store && target.store[RESOURCE_ENERGY] > 0;
    }), 'withdraw')) return;
    // Tombstones with energy
    //if (tryWithdraw(creep.room.find(FIND_TOMBSTONES, { filter: function (t) { return t.store && t.store[RESOURCE_ENERGY] > 0; } }), 'withdraw')) return;
    if (tryWithdraw(BeeToolbox._getEnergyTargetsFromCache(room, 'tombstones', function (target) {
      return target.store && target.store[RESOURCE_ENERGY] > 0;
    }), 'withdraw')) return;
    // Dropped energy
    //if (tryWithdraw(creep.room.find(FIND_DROPPED_RESOURCES, { filter: function (r) { return r.resourceType === RESOURCE_ENERGY; } }), 'pickup')) return;
    if (tryWithdraw(BeeToolbox._getEnergyTargetsFromCache(room, 'dropped', function (target) {
      return target.resourceType === RESOURCE_ENERGY && target.amount > 0;
    }), 'pickup')) return;
    // Containers with energy
    //if (tryWithdraw(creep.room.find(FIND_STRUCTURES, { filter: function (s) { return s.structureType === STRUCTURE_CONTAINER && s.store && s.store[RESOURCE_ENERGY] > 0; } }), 'withdraw')) return;
    if (tryWithdraw(BeeToolbox._getEnergyTargetsFromCache(room, 'containers', function (target) {
      return target.structureType === STRUCTURE_CONTAINER && target.store && target.store[RESOURCE_ENERGY] > 0;
    }), 'withdraw')) return;
    
    // Storage
    var storage = creep.room.storage;
    if (storage && storage.store && storage.store[RESOURCE_ENERGY] > 0) {
      var res = creep.withdraw(storage, RESOURCE_ENERGY);
      if (res === ERR_NOT_IN_RANGE) {
        BeeToolbox.BeeTravel(creep, storage, { range: 1 });
      }
    }
  },

  /**
   * Transfer carried energy to the highest priority target structure.
   * @param {Creep} creep Worker creep delivering energy.
   * @param {string[]} structureTypes Array of acceptable structure type constants.
   * @returns {number} Screeps return code indicating action status.
   * @sideeffects Issues transfer or move orders.
   * @cpu Moderate due to filtering and pathfinding.
   * @memory No new persistent data.
   */
  deliverEnergy: function (creep, structureTypes) {
    if (!creep) return ERR_INVALID_TARGET;
    structureTypes = structureTypes || [];

    var STRUCTURE_PRIORITY = {};
    STRUCTURE_PRIORITY[STRUCTURE_EXTENSION] = 2;
    STRUCTURE_PRIORITY[STRUCTURE_SPAWN]     = 3;
    STRUCTURE_PRIORITY[STRUCTURE_TOWER]     = 4;
    STRUCTURE_PRIORITY[STRUCTURE_STORAGE]   = 1;
    STRUCTURE_PRIORITY[STRUCTURE_CONTAINER] = 5;

    var sources = creep.room.find(FIND_SOURCES);

    var targets = creep.room.find(FIND_STRUCTURES, {
      filter: function (s) {
        // filter by type list
        var okType = false;
        for (var i = 0; i < structureTypes.length; i++) {
          if (s.structureType === structureTypes[i]) { okType = true; break; }
        }
        if (!okType) return false;

        // exclude source-adjacent containers
        if (s.structureType === STRUCTURE_CONTAINER) {
          for (var j = 0; j < sources.length; j++) {
            if (s.pos.inRangeTo(sources[j].pos, 1)) return false;
          }
        }
        return s.store && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
      }
    });

    // sort by priority then distance
    targets.sort(function (a, b) {
      var pa = STRUCTURE_PRIORITY[a.structureType] || 99;
      var pb = STRUCTURE_PRIORITY[b.structureType] || 99;
      if (pa !== pb) return pa - pb;
      var da = creep.pos.getRangeTo(a);
      var db = creep.pos.getRangeTo(b);
      return da - db;
    });

    if (targets.length) {
      var t = targets[0];
      var r = creep.transfer(t, RESOURCE_ENERGY);
      if (r === ERR_NOT_IN_RANGE) {
        BeeToolbox.BeeTravel(creep, t, { range: 1 });
      }
      return r;
    }
    return ERR_NOT_FOUND;
  },

  // Ensure a CONTAINER exists 0–1 tiles from targetSource; place site if missing
  /**
   * Guarantee a container is built adjacent to a harvesting source.
   * @param {Creep} creep Builder or worker creep executing the task.
   * @param {Source} targetSource Source requiring container support.
   * @returns {void}
   * @sideeffects May create construction sites or issue build orders.
   * @cpu Moderate when scanning terrain and creating sites.
   * @memory No persistent data beyond possible construction site objects.
   */
  ensureContainerNearSource: function (creep, targetSource) {
    if (!creep || !targetSource) return;

    var sourcePos = targetSource.pos;

    var containersNearby = sourcePos.findInRange(FIND_STRUCTURES, 1, {
      filter: function (st) { return st.structureType === STRUCTURE_CONTAINER; }
    });
    if (containersNearby && containersNearby.length > 0) return;

    var constructionSites = sourcePos.findInRange(FIND_CONSTRUCTION_SITES, 1, {
      filter: function (site) { return site.structureType === STRUCTURE_CONTAINER; }
    });
    if (constructionSites && constructionSites.length > 0) {
      if (creep.build(constructionSites[0]) === ERR_NOT_IN_RANGE) {
        BeeToolbox.BeeTravel(creep, constructionSites[0], { range: 1 });
      }
      return;
    }

    var roomTerrain = Game.map.getRoomTerrain(sourcePos.roomName);
    var offsets = [
      { x: -1, y:  0 }, { x:  1, y:  0 }, { x:  0, y: -1 }, { x:  0, y:  1 },
      { x: -1, y: -1 }, { x:  1, y: -1 }, { x: -1, y:  1 }, { x:  1, y:  1 }
    ];

    for (var i = 0; i < offsets.length; i++) {
      var pos = { x: sourcePos.x + offsets[i].x, y: sourcePos.y + offsets[i].y };
      var terrain = roomTerrain.get(pos.x, pos.y);
      if (terrain === TERRAIN_MASK_WALL) continue;

      var result = creep.room.createConstructionSite(pos.x, pos.y, STRUCTURE_CONTAINER);
      if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
        toolboxLog.debug('Attempted to place container at (' + pos.x + ',' + pos.y + '): Result ' + result);
      }
      if (result === OK) {
        BeeToolbox.BeeTravel(creep, new RoomPosition(pos.x, pos.y, sourcePos.roomName), { range: 0 });
        return;
      }
    }
  },

  // ---------------------------------------------------------------------------
  // 🎯 TARGET SELECTION (COMBAT)
  // ---------------------------------------------------------------------------

  // Priorities: hostiles → invader core → prio structures → other structures → (no walls/ramparts unless blocking)
  /**
   * Choose the highest priority hostile target for an offensive creep.
   * @param {Creep} creep Attacking creep seeking a target.
   * @returns {Structure|Creep|null} Target object or null if none found.
   * @sideeffects None beyond computation.
   * @cpu Moderate due to multiple FIND queries.
   * @memory Temporary arrays only.
   */
  findAttackTarget: function (creep) {
    if (!creep) return null;

    // 1) hostile creeps
    var hostile = creep.pos.findClosestByPath(FIND_HOSTILE_CREEPS);
    if (hostile) return hostile;

    // 2) invader core
    var core = creep.pos.findClosestByPath(FIND_STRUCTURES, {
      filter: function (s) { return s.structureType === STRUCTURE_INVADER_CORE && s.hits > 0; }
    });
    if (core) return core;

    // helper: first blocking barrier on the path to "toTarget"
    function firstBarrierOnPath(fromCreep, toTarget) {
      if (!fromCreep || !toTarget || !toTarget.pos) return null;
      var path = fromCreep.room.findPath(fromCreep.pos, toTarget.pos, { ignoreCreeps: true, maxOps: 1000 });
      for (var i = 0; i < path.length; i++) {
        var step = path[i];
        var structs = fromCreep.room.lookForAt(LOOK_STRUCTURES, step.x, step.y);
        for (var j = 0; j < structs.length; j++) {
          var s = structs[j];
          if (s.structureType === STRUCTURE_WALL) return s;
          if (s.structureType === STRUCTURE_RAMPART && !s.my && !s.isPublic) return s;
        }
      }
      return null;
    }

    // 3) priority hostile structures
    var prioTypes = {};
    prioTypes[STRUCTURE_TOWER] = true;
    prioTypes[STRUCTURE_SPAWN] = true;
    prioTypes[STRUCTURE_STORAGE] = true;
    prioTypes[STRUCTURE_TERMINAL] = true;
    prioTypes[STRUCTURE_LAB] = true;
    prioTypes[STRUCTURE_FACTORY] = true;
    prioTypes[STRUCTURE_POWER_SPAWN] = true;
    prioTypes[STRUCTURE_NUKER] = true;
    prioTypes[STRUCTURE_EXTENSION] = true;

    var prio = creep.pos.findClosestByPath(FIND_HOSTILE_STRUCTURES, {
      filter: function (s) { return prioTypes[s.structureType] === true; }
    });
    if (prio) {
      return firstBarrierOnPath(creep, prio) || prio;
    }

    // 4) any other hostile structure (not controller/walls/closed ramparts)
    var other = creep.pos.findClosestByPath(FIND_HOSTILE_STRUCTURES, {
      filter: function (s) {
        if (s.structureType === STRUCTURE_CONTROLLER) return false;
        if (s.structureType === STRUCTURE_WALL) return false;
        if (s.structureType === STRUCTURE_RAMPART && !s.my && !s.isPublic) return false;
        return true;
      }
    });
    if (other) {
      return firstBarrierOnPath(creep, other) || other;
    }

    // 5) nothing sensible
    return null;
  },

  // Should an attacker pause to let its medic catch up?
  /**
   * Decide if an attacker should pause to let its assigned medic close distance.
   * @param {Creep} attacker Combat creep potentially waiting.
   * @returns {boolean} True when the unit should wait.
   * @sideeffects Mutates attacker.memory.waitTicks and may trigger move orders.
   * @cpu Low.
   * @memory Uses existing creep memory fields only.
   */
  shouldWaitForMedic: function (attacker) {
    if (!attacker) return false;

    // find linked medic by role + followTarget
    var medic = _.find(Game.creeps, function (c) {
      return c.memory && c.memory.role === 'CombatMedic' && c.memory.followTarget === attacker.id;
    });
    if (!medic) return false;
    if (attacker.memory && attacker.memory.noWaitForMedic) return false;

    if (attacker.memory.waitTicks === undefined) attacker.memory.waitTicks = 0;

    var nearExit = (attacker.pos.x <= 3 || attacker.pos.x >= 46 || attacker.pos.y <= 3 || attacker.pos.y >= 46);

    if (!attacker.memory.advanceDone && !attacker.pos.inRangeTo(medic, 2)) {
      attacker.memory.waitTicks = 2;
      if (nearExit) {
        var center = new RoomPosition(25, 25, attacker.room.name);
        var dir = attacker.pos.getDirectionTo(center);
        attacker.move(dir);
        attacker.say('🚶 Clear exit');
        return true;
      }
      return true;
    }
    if (attacker.memory.waitTicks > 0) {
      attacker.memory.waitTicks--;
      return true;
    }
    return false;
  },

  // ---------------------------------------------------------------------------
  // 🛡️ COMBAT HELPERS
  // ---------------------------------------------------------------------------

  /**
   * Determine if a position is within danger range of any hostile tower.
   * @param {RoomPosition} pos Screeps position to inspect.
   * @param {number} radius Maximum range from a tower considered dangerous.
   * @returns {boolean} True if any hostile tower is within the radius.
   * @sideeffects None.
   * @cpu O(towers).
   * @memory Temporary list only.
   */
  isInTowerDanger: function (pos, radius) {
    if (!pos) return false;
    var room = Game.rooms[pos.roomName];
    if (!room) return false;
    var limit = (typeof radius === 'number') ? radius : 20;
    var towers = room.find(FIND_HOSTILE_STRUCTURES, {
      filter: function (s) { return s.structureType === STRUCTURE_TOWER; }
    });
    for (var i = 0; i < towers.length; i++) {
      if (towers[i].pos.getRangeTo(pos) <= limit) {
        return true;
      }
    }
    return false;
  },

  /**
   * Estimate per-tick damage from hostile towers focused on a position.
   * @param {Room} room The room containing the position.
   * @param {RoomPosition} pos Target position for damage estimation.
   * @returns {number} Estimated damage for one tick.
   * @sideeffects None.
   * @cpu O(towers).
   * @memory No persistent allocations.
   */
  estimateTowerDamage: function (room, pos) {
    if (!room || !pos) return 0;
    var towers = room.find(FIND_HOSTILE_STRUCTURES, {
      filter: function (s) { return s.structureType === STRUCTURE_TOWER; }
    });
    var total = 0;
    for (var i = 0; i < towers.length; i++) {
      var dist = towers[i].pos.getRangeTo(pos);
      if (dist <= TOWER_OPTIMAL_RANGE) {
        total += TOWER_POWER_ATTACK;
      } else {
        var capped = Math.min(dist, TOWER_FALLOFF_RANGE);
        var frac = (capped - TOWER_OPTIMAL_RANGE) / Math.max(1, (TOWER_FALLOFF_RANGE - TOWER_OPTIMAL_RANGE));
        var fall = TOWER_POWER_ATTACK * (1 - (TOWER_FALLOFF * frac));
        total += Math.max(0, Math.floor(fall));
      }
    }
    return total;
  },

  /**
   * Check if a range sits inside the configured hold band for archer behavior.
   * @param {number} range Current distance to target.
   * @param {number} desiredRange Preferred range to hold.
   * @param {number} holdBand Acceptable slack range above desired.
   * @returns {boolean} True if range lies inside the hold band.
   * @sideeffects None.
   * @cpu O(1).
   * @memory None.
   */
  combatInHoldBand: function (range, desiredRange, holdBand) {
    if (typeof range !== 'number') return false;
    var desired = (typeof desiredRange === 'number') ? desiredRange : 1;
    var band = (typeof holdBand === 'number') ? holdBand : 0;
    if (range < desired) return false;
    if (range > (desired + band)) return false;
    return true;
  },

  /**
   * List hostile threats (attackers and towers) in a room.
   * @param {Room} room Screeps room to scan.
   * @returns {Array} Array of hostile creeps/structures threatening the room.
   * @sideeffects None.
   * @example
   * var threats = BeeToolbox.combatThreats(creep.room);
   */
  /**
   * Enumerate hostile creeps and towers posing threats inside a room.
   * @param {Room} room Room to analyze.
   * @returns {object} Object containing hostile arrays.
   * @sideeffects None beyond computation.
   * @cpu Moderate due to FIND operations.
   * @memory Temporary arrays returned to caller.
   */
  combatThreats: function (room) {
    if (!room) return [];
    var creeps = room.find(FIND_HOSTILE_CREEPS, {
      filter: function (h) {
        return h.getActiveBodyparts(ATTACK) > 0 || h.getActiveBodyparts(RANGED_ATTACK) > 0;
      }
    });
    var towers = room.find(FIND_HOSTILE_STRUCTURES, {
      filter: function (s) { return s.structureType === STRUCTURE_TOWER; }
    });
    return creeps.concat(towers);
  },

  /**
   * Fire at the closest valid hostile within ranged distance.
   * @param {Creep} creep Acting ranged creep.
   * @returns {boolean} True if an attack was attempted.
   * @sideeffects Performs ranged attack orders.
   * @example
   * BeeToolbox.combatShootOpportunistic(creep);
   */
  /**
   * Fire at the best opportunistic hostile within range for a ranged creep.
   * @param {Creep} creep Ranged combat creep.
   * @returns {boolean} True when an attack was issued.
   * @sideeffects Executes rangedAttack on the creep.
   * @cpu Low.
   * @memory None.
   */
  combatShootOpportunistic: function (creep) {
    if (!creep) return false;
    var closer = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
    if (closer && creep.pos.inRangeTo(closer, 3)) {
      creep.rangedAttack(closer);
      return true;
    }
    return false;
  },

  /**
   * Primary archer attack logic with mass-attack fallback.
   * @param {Creep} creep Archer creep issuing attacks.
   * @param {RoomObject} target Preferred target.
   * @param {Object} config Behavior configuration ({ desiredRange, massAttackThreshold }).
   * @returns {boolean} True if any attack order was issued.
   * @sideeffects Issues ranged attacks.
   * @example
   * BeeToolbox.combatShootPrimary(creep, hostile, { desiredRange: 2 });
   */
  /**
   * Execute primary ranged attack logic against a selected target.
   * @param {Creep} creep Ranged combat creep.
   * @param {Creep|Structure} target Target to attack.
   * @param {object} config Additional behavior flags.
   * @returns {boolean} True when an attack or move command issued.
   * @sideeffects Issues attack and movement orders.
   * @cpu Moderate because of range checks and movement.
   * @memory No persistent usage.
   */
  combatShootPrimary: function (creep, target, config) {
    if (!creep || !target) return false;
    var opts = config || {};
    var threshold = (opts.massAttackThreshold != null) ? opts.massAttackThreshold : 3;
    var hostiles = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 3);
    if (hostiles.length >= threshold) {
      creep.rangedMassAttack();
      return true;
    }
    var range = creep.pos.getRangeTo(target);
    if (range <= 3) {
      creep.rangedAttack(target);
      return true;
    }
    return BeeToolbox.combatShootOpportunistic(creep);
  },

  /**
   * Attempt a flee path away from threats, with TaskSquad-friendly swap support.
   * @param {Creep} creep Creep that should flee.
   * @param {Array} fromThings Array of hostile objects to avoid.
   * @param {number} safeRange Desired separation distance.
   * @param {Object} options Extra knobs ({ maxOps, taskSquad, roomCallback }).
   * @returns {boolean} True if a flee move was attempted.
   * @sideeffects Orders movement and may swap tiles via TaskSquad.
   * @example
   * BeeToolbox.combatFlee(creep, [hostile], 3, { maxOps: 2000, taskSquad: TaskSquad });
   */
  /**
   * Flee away from threats using Traveler pathing.
   * @param {Creep} creep Creep attempting to retreat.
   * @param {Array} fromThings Array of hostile objects or positions.
   * @param {number} safeRange Desired minimum distance from threats.
   * @param {object} options Traveler options override.
   * @returns {number} Traveler result code from travelTo.
   * @sideeffects Issues movement orders.
   * @cpu Moderate due to pathfinding.
   * @memory Relies on Traveler's caching (no new persistent data).
   */
  combatFlee: function (creep, fromThings, safeRange, options) {
    if (!creep) return false;
    var goals = [];
    var i;
    var fleeRange = (typeof safeRange === 'number') ? safeRange : 3;
    var opts = options || {};
    var taskSquad = opts.taskSquad;
    var maxOps = (opts.maxOps != null) ? opts.maxOps : 2000;
    var roomCallback = opts.roomCallback || BeeToolbox.roomCallback;

    if (fromThings && fromThings.length) {
      for (i = 0; i < fromThings.length; i++) {
        if (!fromThings[i] || !fromThings[i].pos) continue;
        goals.push({ pos: fromThings[i].pos, range: fleeRange });
      }
    }

    var search = PathFinder.search(creep.pos, goals, {
      flee: true,
      maxOps: maxOps,
      roomCallback: function (roomName) {
        if (roomCallback) {
          var custom = roomCallback(roomName);
          if (custom !== undefined && custom !== null) return custom;
        }
        var room = Game.rooms[roomName];
        if (!room) return false;
        var costs = new PathFinder.CostMatrix();
        var structures = room.find(FIND_STRUCTURES);
        for (var s = 0; s < structures.length; s++) {
          var structure = structures[s];
          if (structure.structureType === STRUCTURE_ROAD) {
            costs.set(structure.pos.x, structure.pos.y, 1);
          } else if (structure.structureType !== STRUCTURE_CONTAINER && (structure.structureType !== STRUCTURE_RAMPART || !structure.my)) {
            costs.set(structure.pos.x, structure.pos.y, 0xFF);
          }
        }
        return costs;
      }
    });

    if (search && search.path && search.path.length) {
      var step = search.path[0];
      if (step) {
        var np = new RoomPosition(step.x, step.y, creep.pos.roomName);
        if (!taskSquad || !taskSquad.tryFriendlySwap || !taskSquad.tryFriendlySwap(creep, np)) {
          creep.move(creep.pos.getDirectionTo(step));
        }
        return true;
      }
    }

    var bad = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
    if (bad) {
      var dir = creep.pos.getDirectionTo(bad);
      var zero = (dir - 1 + 8) % 8;
      var back = ((zero + 4) % 8) + 1;
      creep.move(back);
      return true;
    }
    return false;
  },

  /**
   * TaskSquad-aware step helper (Traveler shim).
   * @param {Creep} creep Unit to move.
   * @param {RoomPosition|RoomObject} targetPos Destination position or object.
   * @param {number} range Desired range to stop at.
   * @param {Object} taskSquad Optional Task.Squad module for stepToward usage.
   * @returns {number|undefined} Traveler/stepToward result when available.
   * @sideeffects Moves the creep.
   * @example
   * BeeToolbox.combatStepToward(creep, hostile.pos, 1, TaskSquad);
   */
  /**
   * Advance a combat creep toward a target position while respecting task squad rules.
   * @param {Creep} creep Combat creep to move.
   * @param {RoomPosition} targetPos Destination position.
   * @param {number} range Desired stopping range.
   * @param {object} taskSquad Optional squad metadata.
   * @returns {number} Movement result code.
   * @sideeffects Issues move orders via Traveler.
   * @cpu Moderate because of pathfinding.
   * @memory Depends on Traveler's cache; no extra persistence.
   */
  combatStepToward: function (creep, targetPos, range, taskSquad) {
    if (!creep || !targetPos) return ERR_INVALID_TARGET;
    var destination = (targetPos.pos || targetPos);
    var desiredRange = (typeof range === 'number') ? range : 1;
    if (taskSquad && taskSquad.stepToward) {
      return taskSquad.stepToward(creep, destination, desiredRange);
    }
    return BeeToolbox.BeeTravel(creep, destination, { range: desiredRange });
  },

  /**
   * Heal self or squadmates opportunistically when HEAL parts exist.
   * @param {Creep} creep Healer or hybrid creep.
   * @param {string} squadId Optional squad identifier override.
   * @returns {boolean} True if any heal command issued.
   * @sideeffects Executes heal/rangedHeal calls.
   * @example
   * BeeToolbox.combatAuxHeal(creep, 'Alpha');
   */
  /**
   * Perform passive heal support for nearby squadmates.
   * @param {Creep} creep Medic creep to act.
   * @param {string} squadId Squad identifier filter.
   * @returns {boolean} True when a heal command executed.
   * @sideeffects Issues heal commands.
   * @cpu Moderate due to filtering.
   * @memory No persistent data.
   */
  combatAuxHeal: function (creep, squadId) {
    if (!creep) return false;
    var healParts = creep.getActiveBodyparts(HEAL);
    if (!healParts) return false;

    if (creep.hits < creep.hitsMax) {
      creep.heal(creep);
      return true;
    }

    var sid = squadId || (creep.memory && creep.memory.squadId) || 'Alpha';
    var mates = _.filter(Game.creeps, function (c) {
      return c && c.my && c.id !== creep.id && c.memory && c.memory.squadId === sid && c.hits < c.hitsMax;
    });
    if (!mates.length) return false;
    var target = _.min(mates, function (c) { return c.hits / Math.max(1, c.hitsMax); });
    if (!target) return false;

    if (creep.pos.isNearTo(target)) {
      creep.heal(target);
      return true;
    }
    if (creep.pos.inRangeTo(target, 3)) {
      creep.rangedHeal(target);
      return true;
    }
    return false;
  },

  /**
   * Guard vulnerable squadmates by swapping or stepping toward them.
   * @param {Creep} creep Melee protector.
   * @param {Object} options Options ({ taskSquad, squadId, protectRoles, threatFilter }).
   * @returns {boolean} True if guard action executed.
   * @sideeffects May move or swap tiles.
   * @example
   * BeeToolbox.combatGuardSquadmate(creep, { taskSquad: TaskSquad });
   */
  /**
   * Position a guard near a squadmate and engage threats attacking them.
   * @param {Creep} creep Guard creep executing behavior.
   * @param {object} options Configuration overrides.
   * @returns {boolean} True when defending actions executed.
   * @sideeffects Issues move and attack commands.
   * @cpu Moderate with multiple searches.
   * @memory Temporary arrays only.
   */
  combatGuardSquadmate: function (creep, options) {
    if (!creep) return false;
    var opts = options || {};
    var squadId = opts.squadId || (creep.memory && creep.memory.squadId) || 'Alpha';
    var taskSquad = opts.taskSquad;
    var protectRoles = opts.protectRoles || { CombatArcher: true, CombatMedic: true, Dismantler: true };
    var threatFilter = opts.threatFilter || function (h) {
      return h.getActiveBodyparts(ATTACK) > 0;
    };

    var threatened = _.filter(Game.creeps, function (ally) {
      if (!ally || !ally.my || !ally.memory || ally.memory.squadId !== squadId) return false;
      var role = ally.memory.task || ally.memory.role || '';
      if (!protectRoles[role]) return false;
      var nearThreats = ally.pos.findInRange(FIND_HOSTILE_CREEPS, 1, { filter: threatFilter });
      return nearThreats.length > 0;
    });
    if (!threatened.length) return false;

    var buddy = creep.pos.findClosestByRange(threatened);
    if (!buddy) return false;

    if (creep.pos.isNearTo(buddy)) {
      if (taskSquad && taskSquad.tryFriendlySwap && taskSquad.tryFriendlySwap(creep, buddy.pos)) {
        return true;
      }
      var bad = buddy.pos.findInRange(FIND_HOSTILE_CREEPS, 1, { filter: threatFilter })[0];
      if (bad) {
        var best = BeeToolbox.combatBestAdjacentTile(creep, bad, {
          edgePenalty: opts.edgePenalty,
          towerRadius: opts.towerRadius
        });
        if (best && creep.pos.getRangeTo(best) === 1) {
          creep.move(creep.pos.getDirectionTo(best));
          return true;
        }
      }
      return false;
    }

    BeeToolbox.combatStepToward(creep, buddy.pos, 1, taskSquad);
    return true;
  },

  /**
   * Score adjacent tiles for melee positioning.
   * @param {Creep} creep Melee creep evaluating movement.
   * @param {RoomObject} target Target to remain adjacent to.
   * @param {Object} options Extra options ({ edgePenalty, towerRadius }).
   * @returns {RoomPosition} Best adjacent position (may equal current).
   * @sideeffects None.
   * @example
   * var pos = BeeToolbox.combatBestAdjacentTile(creep, hostile, { edgePenalty: 8 });
   */
  /**
   * Identify the optimal adjacent tile around a target for melee engagement.
   * @param {Creep} creep Evaluating creep.
   * @param {Creep|Structure} target Object to surround.
   * @param {object} options Behavior tuning parameters.
   * @returns {RoomPosition|null} Best adjacent position or null.
   * @sideeffects None.
   * @cpu Moderate due to path/terrain checks.
   * @memory Temporary arrays and calculations only.
   */
  combatBestAdjacentTile: function (creep, target, options) {
    if (!creep || !target) return creep && creep.pos;
    var room = creep.room;
    var opts = options || {};
    var edgePenalty = (opts && opts.edgePenalty != null) ? opts.edgePenalty : 8;
    var towerRadius = (opts && opts.towerRadius != null) ? opts.towerRadius : 20;
    var best = creep.pos;
    var bestScore = 1e9;
    var threats = room ? room.find(FIND_HOSTILE_CREEPS, {
      filter: function (h) {
        return h.getActiveBodyparts(ATTACK) > 0 && h.hits > 0;
      }
    }) : [];

    for (var dx = -1; dx <= 1; dx++) {
      for (var dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        var x = creep.pos.x + dx;
        var y = creep.pos.y + dy;
        if (x <= 0 || x >= 49 || y <= 0 || y >= 49) continue;
        var pos = new RoomPosition(x, y, creep.room.name);
        if (!pos.isNearTo(target)) continue;

        var look = pos.look();
        var impass = false;
        var onRoad = false;
        for (var i = 0; i < look.length; i++) {
          var o = look[i];
          if (o.type === LOOK_TERRAIN && o.terrain === 'wall') { impass = true; break; }
          if (o.type === LOOK_CREEPS) { impass = true; break; }
          if (o.type === LOOK_STRUCTURES) {
            var st = o.structure.structureType;
            if (st === STRUCTURE_ROAD) onRoad = true;
            else if (st !== STRUCTURE_CONTAINER && (st !== STRUCTURE_RAMPART || !o.structure.my)) { impass = true; break; }
          }
        }
        if (impass) continue;

        var score = 0;
        for (var t = 0; t < threats.length; t++) {
          if (threats[t].pos.getRangeTo(pos) <= 1) score += 20;
        }
        if (BeeToolbox.isInTowerDanger(pos, towerRadius)) score += 50;
        if (x === 0 || x === 49 || y === 0 || y === 49) score += edgePenalty;
        if (onRoad) score -= 1;

        if (score < bestScore) {
          bestScore = score;
          best = pos;
        }
      }
    }
    return best;
  },

  /**
   * Identify a hostile structure blocking melee pathing right next to the creep.
   * @param {Creep} creep Acting melee creep.
   * @param {RoomObject} target Target the creep wants to reach.
   * @returns {Structure|null} Blocking wall or rampart if one exists.
   * @sideeffects None.
   * @example
   * var blocker = BeeToolbox.combatBlockingDoor(creep, target);
   */
  /**
   * Detect a blocking structure at an entrance when pursuing a target.
   * @param {Creep} creep Attacking creep.
   * @param {RoomObject} target Intended hostile target.
   * @returns {Structure|null} Blocking structure if found.
   * @sideeffects None.
   * @cpu Moderate because of spatial scans.
   * @memory Temporary lists only.
   */
  combatBlockingDoor: function (creep, target) {
    if (!creep || !target) return null;
    var closeStructs = creep.pos.findInRange(FIND_STRUCTURES, 1, {
      filter: function (s) {
        return (s.structureType === STRUCTURE_RAMPART && !s.my) || s.structureType === STRUCTURE_WALL;
      }
    });
    if (!closeStructs.length) return null;
    var best = _.min(closeStructs, function (s) { return s.pos.getRangeTo(target); });
    if (!best) return null;
    var distNow = creep.pos.getRangeTo(target);
    var distThru = best.pos.getRangeTo(target);
    return distThru < distNow ? best : null;
  },

  /**
   * Return the weakest hostile within a given range band.
   * @param {Creep} creep Reference creep.
   * @param {number} range Maximum range to consider.
   * @returns {Creep|null} Hostile creep with lowest health fraction.
   * @sideeffects None.
   * @example
   * var weak = BeeToolbox.combatWeakestHostile(creep, 2);
   */
  /**
   * Select the weakest hostile unit within a specific range.
   * @param {Creep} creep Evaluating creep.
   * @param {number} range Search radius.
   * @returns {Creep|null} Weakest hostile or null.
   * @sideeffects None.
   * @cpu Moderate due to filtering.
   * @memory Temporary arrays only.
   */
  combatWeakestHostile: function (creep, range) {
    if (!creep) return null;
    var maxRange = (typeof range === 'number') ? range : 2;
    var xs = creep.pos.findInRange(FIND_HOSTILE_CREEPS, maxRange);
    if (!xs.length) return null;
    return _.min(xs, function (c) { return c.hits / Math.max(1, c.hitsMax); });
  },

  /**
   * Retreat toward rally flags or anchor, else back away from closest hostile.
   * @param {Creep} creep Creep that should retreat.
   * @param {Object} options Options ({ taskSquad, anchorProvider, range }).
   * @returns {boolean} True if any retreat movement occurred.
   * @sideeffects Issues movement commands.
   * @example
   * BeeToolbox.combatRetreatToRally(creep, { taskSquad: TaskSquad });
   */
  /**
   * Retreat a creep toward a rally point while healing if possible.
   * @param {Creep} creep Retreating creep.
   * @param {object} options Contains rallyPos and healWhileMoving flags.
   * @returns {boolean} True when retreat orders issued.
   * @sideeffects Issues move/heal commands and updates memory flags.
   * @cpu Moderate from movement.
   * @memory Minimal; only memory flags toggled.
   */
  combatRetreatToRally: function (creep, options) {
    if (!creep) return false;
    var opts = options || {};
    var range = (opts.range != null) ? opts.range : 1;
    var anchorProvider = opts.anchorProvider;
    var rally = opts.rallyFlag || Game.flags.MedicRally || Game.flags.Rally;
    if (!rally && typeof anchorProvider === 'function') {
      rally = anchorProvider(creep);
    }
    if (rally) {
      BeeToolbox.combatStepToward(creep, rally.pos || rally, range, opts.taskSquad);
      return true;
    }
    var bad = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
    if (bad) {
      var dir = creep.pos.getDirectionTo(bad);
      var zero = (dir - 1 + 8) % 8;
      var back = ((zero + 4) % 8) + 1;
      creep.move(back);
      return true;
    }
    return false;
  },

  /**
   * Find the most injured ally within range of a position.
   * @param {RoomPosition} origin Center position for the scan.
   * @param {number} range Maximum search radius.
   * @returns {Creep|null} Ally with lowest health fraction.
   * @sideeffects None.
   * @example
   * var target = BeeToolbox.findLowestInjuredAlly(creep.pos, 3);
   */
  /**
   * Locate the most injured friendly creep near a position.
   * @param {RoomObject|RoomPosition} origin Search origin.
   * @param {number} range Search radius.
   * @returns {Creep|null} Ally requiring healing or null.
   * @sideeffects None.
   * @cpu Moderate due to FIND filtering.
   * @memory Temporary arrays only.
   */
  findLowestInjuredAlly: function (origin, range) {
    if (!origin) return null;
    var rad = (typeof range === 'number') ? range : 3;
    var allies = origin.findInRange(FIND_MY_CREEPS, rad, {
      filter: function (ally) { return ally.hits < ally.hitsMax; }
    });
    if (!allies.length) return null;
    return _.min(allies, function (ally) { return ally.hits / Math.max(1, ally.hitsMax); });
  },

  /**
   * Attempt to heal or ranged-heal a target.
   * @param {Creep} creep Healer creep.
   * @param {Creep} target Patient to heal.
   * @returns {boolean} True if a heal command succeeded.
   * @sideeffects Issues heal or rangedHeal.
   * @example
   * if (!BeeToolbox.tryHealTarget(creep, buddy)) { creep.say('No heal'); }
   */
  /**
   * Attempt to heal a target creep with optimal method based on range.
   * @param {Creep} creep Medic or hybrid creep.
   * @param {Creep} target Ally to heal.
   * @returns {boolean} True when a heal action occurred.
   * @sideeffects Issues heal or rangedHeal commands.
   * @cpu Low.
   * @memory None.
   */
  tryHealTarget: function (creep, target) {
    if (!creep || !target) return false;
    if (target.hits >= target.hitsMax) return false;
    if (creep.pos.isNearTo(target)) {
      return creep.heal(target) === OK;
    }
    if (creep.pos.inRangeTo(target, 3)) {
      return creep.rangedHeal(target) === OK;
    }
    return false;
  },

  /**
   * Count creeps of a given role following a target within a squad.
   * @param {string} squadId Squad identifier.
   * @param {string} targetId Target creep id to follow.
   * @param {string} roleName Role or task name to match.
   * @returns {number} Number of creeps following the target.
   * @sideeffects None.
   * @example
   * var medics = BeeToolbox.countRoleFollowingTarget('Alpha', buddy.id, 'CombatMedic');
   */
  /**
   * Count creeps of a specific role following a target within a squad.
   * @param {string} squadId Squad identifier.
   * @param {string} targetId ID of the followed creep.
   * @param {string} roleName Role name to match.
   * @returns {number} Number of matching creeps.
   * @sideeffects None.
   * @cpu O(creeps).
   * @memory Temporary counters only.
   */
  countRoleFollowingTarget: function (squadId, targetId, roleName) {
    if (!targetId) return 0;
    var sid = squadId || 'Alpha';
    var role = roleName || '';
    var count = 0;
    for (var name in Game.creeps) {
      if (!Game.creeps.hasOwnProperty(name)) continue;
      var creep = Game.creeps[name];
      if (!creep || !creep.my || !creep.memory) continue;
      if ((creep.memory.squadId || 'Alpha') !== sid) continue;
      var r = creep.memory.task || creep.memory.role;
      if (r !== role) continue;
      if (creep.memory.followTarget === targetId) count++;
    }
    return count;
  },

  // ---------------------------------------------------------------------------
  // 🚚 MOVEMENT: Traveler wrapper
  // ---------------------------------------------------------------------------

  /**
   * BeeTravel — Unified wrapper around Traveler.
   * Supports BOTH call styles:
   *   BeeTravel(creep, target, { range: 1, ignoreCreeps: true })
   *   BeeTravel(creep, target, 1, /* reuse= * / 30, { ignoreCreeps:true })
   */
  /**
   * Travel to a destination using Traveler while preserving legacy signatures.
   * @param {Creep} creep Moving creep.
   * @param {RoomObject|RoomPosition} target Destination or object with pos.
   * @param {*} a3 Legacy argument (range or options).
   * @param {*} a4 Legacy argument (unused).
   * @param {*} a5 Legacy argument (options object in legacy mode).
   * @returns {number} Traveler travel result or moveTo fallback.
   * @sideeffects Issues movement commands and may update Traveler state.
   * @cpu Moderate because of pathfinding.
   * @memory Relies on Traveler caching without new persistent data.
   */
  BeeTravel: function (creep, target, a3, a4, a5) {
    if (!creep || !target) return ERR_INVALID_TARGET;

    // Normalize destination
    var destination = (target && target.pos) ? target.pos : target;

    // Parse arguments (support old signature)
    var opts = {};
    if (typeof a3 === 'object') {
      opts = a3 || {};
    } else {
      // legacy: (range, reuse, opts)
      if (typeof a3 === 'number') opts.range = a3;
      if (typeof a5 === 'object') {
        // copy a5 into opts
        for (var k5 in a5) { if (a5.hasOwnProperty(k5)) opts[k5] = a5[k5]; }
      }
      // a4 was "reusePath" in older code; Traveler manages caching itself.
    }

    // Defaults (ES5 extend)
    var options = {
      range: (opts.range != null) ? opts.range : 1,
      ignoreCreeps: (opts.ignoreCreeps != null) ? opts.ignoreCreeps : true,
      useFindRoute: (opts.useFindRoute != null) ? opts.useFindRoute : true,
      stuckValue: (opts.stuckValue != null) ? opts.stuckValue : 2,
      repath: (opts.repath != null) ? opts.repath : 0.05,
      returnData: {}
    };
    for (var k in opts) { if (opts.hasOwnProperty(k)) options[k] = opts[k]; }

    try {
      return Traveler.travelTo(creep, destination, options);
    } catch (e) {
      // Fallback to vanilla moveTo if something odd happens
      if (creep.pos && destination) {
        var rp = (destination.x != null) ? destination : new RoomPosition(destination.x, destination.y, destination.roomName);
        return creep.moveTo(rp, { reusePath: 20, maxOps: 2000 });
      }
    }
  }

}; // end BeeToolbox

module.exports = BeeToolbox;
