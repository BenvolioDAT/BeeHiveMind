'use strict';

var Traveler = require('Traveler');
var Logger = require('core.logger');
var AllianceManager = require('AllianceManager');
var LOG_LEVEL = Logger.LOG_LEVEL;
var toolboxLog = Logger.createLogger('Toolbox', LOG_LEVEL.BASIC);

var ECON_DEFAULTS = {
  STORAGE_ENERGY_MIN_BEFORE_REMOTES: 80000,
  MAX_ACTIVE_REMOTES: 2,
  ROAD_REPAIR_THRESHOLD: 0.45
};

var HARVESTER_CFG = {
  MAX_WORK: 6,
  RENEWAL_TTL: 150,
  EMERGENCY_TTL: 50
};

if (!global.__beeEconomyConfig) {
  global.__beeEconomyConfig = {
    STORAGE_ENERGY_MIN_BEFORE_REMOTES: ECON_DEFAULTS.STORAGE_ENERGY_MIN_BEFORE_REMOTES,
    MAX_ACTIVE_REMOTES: ECON_DEFAULTS.MAX_ACTIVE_REMOTES,
    ROAD_REPAIR_THRESHOLD: ECON_DEFAULTS.ROAD_REPAIR_THRESHOLD
  };
}

var _econOverrideLog = {};

function _logEconomyOverride(sourceName, key, value) {
  var cacheKey = sourceName + ':' + key;
  if (_econOverrideLog[cacheKey]) return;
  _econOverrideLog[cacheKey] = Game.time || 0;
  toolboxLog.info('ECON_CFG override from', sourceName, key, '→', value);
}

var _cachedUsername = null;
var DEFAULT_FOREIGN_AVOID_TTL = 500;
var _cachedTaskSquadModule;

function _getTaskSquadModule() {
  // Lazy require to avoid circular dependency cost when Task.Squad already imported BeeToolbox.
  if (_cachedTaskSquadModule === undefined) {
    try { _cachedTaskSquadModule = require('Task.Squad'); }
    catch (err) { _cachedTaskSquadModule = null; }
  }
  return _cachedTaskSquadModule;
}

var IMPORTANT_FOREIGN_STRUCTURES = {};
IMPORTANT_FOREIGN_STRUCTURES[STRUCTURE_TOWER] = true;
IMPORTANT_FOREIGN_STRUCTURES[STRUCTURE_SPAWN] = true;
IMPORTANT_FOREIGN_STRUCTURES[STRUCTURE_EXTENSION] = true;
IMPORTANT_FOREIGN_STRUCTURES[STRUCTURE_STORAGE] = true;
IMPORTANT_FOREIGN_STRUCTURES[STRUCTURE_TERMINAL] = true;
IMPORTANT_FOREIGN_STRUCTURES[STRUCTURE_NUKER] = true;
IMPORTANT_FOREIGN_STRUCTURES[STRUCTURE_POWER_SPAWN] = true;
IMPORTANT_FOREIGN_STRUCTURES[STRUCTURE_OBSERVER] = true;
IMPORTANT_FOREIGN_STRUCTURES[STRUCTURE_FACTORY] = true;
IMPORTANT_FOREIGN_STRUCTURES[STRUCTURE_LAB] = true;
IMPORTANT_FOREIGN_STRUCTURES[STRUCTURE_LINK] = true;

var SOURCE_CONTAINER_SCAN_INTERVAL = 50;

function isAllyUsername(username) {
  if (!username) return false;
  if (AllianceManager && typeof AllianceManager.isAlly === 'function') {
    return AllianceManager.isAlly(username);
  }
  return false;
}

function isEnemyUsername(username) {
  if (!username) return false;
  if (isAllyUsername(username)) return false;
  if (BeeToolbox && typeof BeeToolbox.getMyUsername === 'function') {
    var mine = BeeToolbox.getMyUsername();
    if (mine && username === mine) return false;
  } else if (_cachedUsername && username === _cachedUsername) {
    return false;
  }
  return true;
}

function isEnemyCreepObject(creep) {
  if (!creep || !creep.owner) return false;
  return isEnemyUsername(creep.owner.username);
}

function isEnemyStructureObject(structure) {
  if (!structure || !structure.owner) return false;
  return isEnemyUsername(structure.owner.username);
}

function noteFriendlySkip(creep, target, context) {
  if (!creep || !target || !target.owner || !target.owner.username) return;
  if (!AllianceManager || typeof AllianceManager.noteFriendlyFireAvoid !== 'function') return;
  AllianceManager.noteFriendlyFireAvoid(creep.name, target.owner.username, context);
}

var BeeToolbox = {

  // ---------------------------------------------------------------------------
  // 🧰 GENERIC HELPERS
  // ---------------------------------------------------------------------------

  hasOwn: function (obj, key) {
    return !!(obj && Object.prototype.hasOwnProperty.call(obj, key));
  },

  isValidRoomName: function (name) {
    if (typeof name !== 'string') return false;
    return /^[WE]\d+[NS]\d+$/.test(name);
  },

  safeLinearDistance: function (a, b, allowInexact) {
    if (!BeeToolbox.isValidRoomName(a) || !BeeToolbox.isValidRoomName(b)) {
      return 9999;
    }
    if (!Game || !Game.map || typeof Game.map.getRoomLinearDistance !== 'function') {
      return 9999;
    }
    return Game.map.getRoomLinearDistance(a, b, allowInexact);
  },

  isObject: function (value) {
    return value !== null && typeof value === 'object';
  },

  isEmptyObject: function (obj) {
    if (!BeeToolbox.isObject(obj)) return true;
    for (var key in obj) {
      if (BeeToolbox.hasOwn(obj, key)) {
        return false;
      }
    }
    return true;
  },

  /**
   * Compute energy per tick for a given source capacity. Pure helper.
   * @param {number} capacity - Total energy contained in the source when full.
   * @returns {number} energy per tick (float).
   */
  energyPerTickFromCapacity: function (capacity) {
    if (!capacity || capacity <= 0) return 0;
    return capacity / ENERGY_REGEN_TIME;
  },

  /**
   * Estimate a neutral room's source capacity based on reservation status.
   * @param {boolean} isReserved - true if controller is reserved by us.
   * @param {boolean} isKeeperRoom - true if source is in an SK room (higher yield).
   * @returns {number} expected full capacity.
   */
  estimateRemoteSourceCapacity: function (isReserved, isKeeperRoom) {
    if (isKeeperRoom) return 4000;
    return isReserved ? 3000 : 1500;
  },

  /**
   * Estimate two-way trip length in ticks for a hauler on a path.
   * @param {number} pathLength - Number of tiles in the cached path (one-way).
   * @param {object} opts - Optional tuning values {speedMultiplier, buffer}.
   * @returns {number} total expected ticks to go source→home→source.
   */
  estimateRoundTripTicks: function (pathLength, opts) {
    var length = pathLength || 0;
    if (length <= 0) return 0;
    var speed = (opts && opts.speedMultiplier) ? opts.speedMultiplier : 1;
    var buffer = (opts && opts.buffer != null) ? opts.buffer : 4;
    var travel = Math.ceil((length * 2) / speed);
    return travel + buffer;
  },

  /**
   * Estimate number of haulers required to move a flow of energy.
   * Pure math (no game object references).
   *
   * @param {number} pathLength - Tiles one-way between source and deposit.
   * @param {number} energyPerTick - Energy produced per tick at the source.
   * @param {number} haulerCapacity - Energy one hauler can transport per trip.
   * @param {number} tripTimeMax - Optional cap to avoid oversizing.
   * @returns {{count:number, roundTrip:number, energyPerTrip:number}}
   */
  estimateHaulerRequirement: function (pathLength, energyPerTick, haulerCapacity, tripTimeMax) {
    var capacity = haulerCapacity || 0;
    if (capacity <= 0) {
      return { count: 0, roundTrip: 0, energyPerTrip: 0 };
    }
    var roundTrip = BeeToolbox.estimateRoundTripTicks(pathLength, { buffer: 6 });
    if (tripTimeMax && roundTrip > tripTimeMax) {
      roundTrip = tripTimeMax;
    }
    var energyPerTrip = energyPerTick * roundTrip;
    var count = 0;
    if (energyPerTrip > 0) {
      count = Math.ceil(energyPerTrip / capacity);
    }
    if (count < 1 && energyPerTick > 0) count = 1;
    return {
      count: count,
      roundTrip: roundTrip,
      energyPerTrip: energyPerTrip
    };
  },

  // ensures combat plans trigger from scout intel
  consumeAttackTargets: function (options) {
    Memory.attackTargets = Memory.attackTargets || {};
    var results = [];
    if (!Memory.attackTargets || typeof Memory.attackTargets !== 'object') {
      return results;
    }
    var now = Game.time | 0;
    var maxAge = (options && options.maxAge != null) ? options.maxAge : 2000;
    var requeueInterval = (options && options.requeueInterval != null) ? options.requeueInterval : 150;
    for (var rn in Memory.attackTargets) {
      if (!this.hasOwn(Memory.attackTargets, rn)) continue;
      var rec = Memory.attackTargets[rn];
      if (!rec || typeof rec !== 'object') {
        delete Memory.attackTargets[rn];
        continue;
      }
      var roomName = rec.roomName || rn;
      if (!roomName) {
        delete Memory.attackTargets[rn];
        continue;
      }
      if (this.isValidRoomName && !this.isValidRoomName(roomName)) {
        delete Memory.attackTargets[rn];
        continue;
      }
      var owner = rec.owner || null;
      if (owner && typeof isEnemyUsername === 'function' && !isEnemyUsername(owner)) {
        continue;
      }
      var updatedAt = rec.updatedAt | 0;
      if (maxAge > 0 && (now - updatedAt) > maxAge) {
        delete Memory.attackTargets[rn];
        continue;
      }
      var lastConsumed = rec.lastConsumedAt | 0;
      if (requeueInterval > 0 && (now - lastConsumed) < requeueInterval) {
        continue;
      }
      rec.lastConsumedAt = now;
      Memory.attackTargets[rn] = rec;
      results.push({
        roomName: roomName,
        owner: owner,
        type: rec.type || null,
        count: rec.count || 0,
        threat: rec.threat || null,
        updatedAt: updatedAt,
        source: rec.source || null
      });
    }
    return results;
  },

  /**
   * Count body parts of a specific type.
   * @param {Array} body - Array of body part constants.
   * @param {string} part - Body part constant (WORK, CARRY, MOVE, ...).
   * @returns {number} count.
   */
  countBodyParts: function (body, part) {
    if (!body || !body.length) return 0;
    var total = 0;
    for (var i = 0; i < body.length; i++) {
      if (body[i] === part) total++;
    }
    return total;
  },

  /**
   * Calculate the total carry capacity for a body definition.
   * @param {Array} body - Body array (symbols or BodyPartDefinition objects).
   * @returns {number} total energy capacity when full.
   */
  bodyCarryCapacity: function (body) {
    if (!body || !body.length) return 0;
    var total = 0;
    for (var i = 0; i < body.length; i++) {
      var part = body[i];
      var partType = part && part.type ? part.type : part;
      if (partType === CARRY) total += CARRY_CAPACITY;
    }
    return total;
  },

  /**
   * Estimate the lead time required to replace a creep.
   * @param {number} travelTicks - Estimated ticks to travel from spawn to seat.
   * @param {number} bodyLength - Body length (used for spawn time calc).
   * @returns {number} ticks before expiry that a replacement should be queued.
   */
  estimateSpawnLeadTime: function (travelTicks, bodyLength) {
    var spawnTicks = (bodyLength || 0) * CREEP_SPAWN_TIME;
    if (spawnTicks < 0) spawnTicks = 0;
    var travel = travelTicks || 0;
    var buffer = 20;
    return spawnTicks + travel + buffer;
  },

  /**
   * Detect whether a room is a highway (either W0* or *N0 style).
   * @param {string} roomName - Room coordinate.
   * @returns {boolean} true if the room is a highway.
   */
  isHighwayRoom: function (roomName) {
    if (!BeeToolbox.isValidRoomName(roomName)) return false;
    var parsed = /([WE])(\d+)([NS])(\d+)/.exec(roomName);
    if (!parsed) return false;
    var x = parseInt(parsed[2], 10);
    var y = parseInt(parsed[4], 10);
    return (x % 10 === 0) || (y % 10 === 0);
  },

  // ---------------------------------------------------------------------------
  // 📒 SOURCE & CONTAINER INTEL
  // ---------------------------------------------------------------------------

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

  getRoomMemory: function (roomName) {
    if (!BeeToolbox.isValidRoomName(roomName)) return null;
    Memory.rooms = Memory.rooms || {};
    if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
    return Memory.rooms[roomName];
  },

  getMyUsername: function () {
    if (_cachedUsername) return _cachedUsername;
    var name = null;
    var k;
    for (k in Game.spawns) {
      if (!Game.spawns.hasOwnProperty(k)) continue;
      var sp = Game.spawns[k];
      if (sp && sp.owner && sp.owner.username) { name = sp.owner.username; break; }
    }
    if (!name) {
      for (k in Game.creeps) {
        if (!Game.creeps.hasOwnProperty(k)) continue;
        var c = Game.creeps[k];
        if (c && c.owner && c.owner.username) { name = c.owner.username; break; }
      }
    }
    _cachedUsername = name || 'me';
    return _cachedUsername;
  },

  cleanupRoomForeignAvoid: function (roomMem) {
    if (!roomMem) return;
    if (typeof roomMem._avoidOtherOwnerUntil === 'number' && roomMem._avoidOtherOwnerUntil <= Game.time) {
      delete roomMem._avoidOtherOwnerUntil;
      delete roomMem._avoidOtherOwnerBy;
      delete roomMem._avoidOtherOwnerReason;
    }
  },

  markRoomForeignAvoid: function (roomMem, owner, reason, ttl) {
    if (!roomMem) return;
    var expire = Game.time + (typeof ttl === 'number' ? ttl : DEFAULT_FOREIGN_AVOID_TTL);
    roomMem._avoidOtherOwnerUntil = expire;
    roomMem._avoidOtherOwnerBy = owner || null;
    roomMem._avoidOtherOwnerReason = reason || null;
  },

  detectForeignPresence: function (roomName, roomObj, roomMem) {
    var mem = roomMem;
    if (!mem) mem = BeeToolbox.getRoomMemory(roomName);
    if (mem) BeeToolbox.cleanupRoomForeignAvoid(mem);

    if (mem && typeof mem._avoidOtherOwnerUntil === 'number' && mem._avoidOtherOwnerUntil > Game.time) {
      return {
        avoid: true,
        owner: mem._avoidOtherOwnerBy || null,
        reason: mem._avoidOtherOwnerReason || 'recentForeign',
        memo: true
      };
    }

    var myName = BeeToolbox.getMyUsername();

    if (roomObj) {
      var ctrl = roomObj.controller;
      if (ctrl) {
        if (ctrl.my === false && ctrl.owner && ctrl.owner.username && ctrl.owner.username !== myName) {
          return { avoid: true, owner: ctrl.owner.username, reason: 'controllerOwned' };
        }
        if (ctrl.reservation && ctrl.reservation.username && ctrl.reservation.username !== myName) {
          return { avoid: true, owner: ctrl.reservation.username, reason: 'reserved' };
        }
      }

      var hostiles = roomObj.find(FIND_HOSTILE_CREEPS, {
        filter: function (h) {
          if (!h || !h.owner) return false;
          var uname = h.owner.username;
          if (uname === 'Invader' || uname === 'Source Keeper') return false;
          if (isAllyUsername(uname)) return false;
          return uname !== myName;
        }
      }) || [];
      if (hostiles.length) {
        return { avoid: true, owner: (hostiles[0].owner && hostiles[0].owner.username) || null, reason: 'hostileCreeps' };
      }

      var hostileStructs = roomObj.find(FIND_HOSTILE_STRUCTURES, {
        filter: function (s) {
          if (!s || !s.owner) return false;
          if (s.owner.username === myName) return false;
          if (isAllyUsername(s.owner.username)) return false;
          return IMPORTANT_FOREIGN_STRUCTURES[s.structureType] === true;
        }
      }) || [];
      if (hostileStructs.length) {
        return { avoid: true, owner: (hostileStructs[0].owner && hostileStructs[0].owner.username) || null, reason: 'hostileStructures' };
      }
    }

    if (mem && mem.intel) {
      var intel = mem.intel;
      if (intel.owner && intel.owner !== myName && !isAllyUsername(intel.owner)) {
        return { avoid: true, owner: intel.owner, reason: 'intelOwner' };
      }
      if (intel.reservation && intel.reservation !== myName && !isAllyUsername(intel.reservation)) {
        return { avoid: true, owner: intel.reservation, reason: 'intelReservation' };
      }
    }

    return { avoid: false };
  },

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

  updateReturnState: function (creep) {
    if (!creep) return;
    if (creep.memory.returning && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.returning = false;
    }
    if (!creep.memory.returning && creep.store.getFreeCapacity() === 0) {
      creep.memory.returning = true;
    }
  },

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

  _refreshRoomEnergyCache: function (room) {
    if (!room) return { ruins: [], tombstones: [], dropped: [], containers: [] };
    var globalCache = BeeToolbox._ensureGlobalEnergyCache();
    var newCache = BeeToolbox._buildEnergyCacheForRoom(room);
    if (globalCache) {
      globalCache.rooms[room.name] = newCache;
    }
    return newCache;
  },

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

  // FIX: Cache energy sink targets per room so delivery routines stop issuing full-room structure scans.
  _ensureEnergySinkCache: function () {
    if (typeof global === 'undefined') return null;
    if (!global.__energySinks || global.__energySinks.tick !== Game.time) {
      global.__energySinks = { tick: Game.time, rooms: {} };
    }
    if (!global.__energySinks.rooms) {
      global.__energySinks.rooms = {};
    }
    return global.__energySinks;
  },

  _buildEnergySinkCacheForRoom: function (room) {
    var data = { byType: {} };
    if (!room) return data;

    var sources = room.find(FIND_SOURCES) || [];
    var structures = room.find(FIND_STRUCTURES, {
      filter: function (s) {
        if (!s || !s.store || typeof s.store.getFreeCapacity !== 'function') return false;
        return s.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
      }
    });

    for (var i = 0; i < structures.length; i++) {
      var structure = structures[i];
      if (!structure) continue;
      if (structure.structureType === STRUCTURE_CONTAINER) {
        var nearSource = false;
        for (var s = 0; s < sources.length; s++) {
          var source = sources[s];
          if (!source || !source.pos) continue;
          if (structure.pos.inRangeTo(source.pos, 1)) { nearSource = true; break; }
        }
        if (nearSource) continue;
      }

      var list = data.byType[structure.structureType];
      if (!list) {
        list = [];
        data.byType[structure.structureType] = list;
      }
      list.push(structure);
    }

    return data;
  },

  _getEnergySinkTargets: function (room, structureTypes) {
    if (!room) return [];
    var types = structureTypes || [];
    if (!types.length) return [];

    var cache = BeeToolbox._ensureEnergySinkCache();
    var roomCache = cache ? cache.rooms[room.name] : null;
    if (!roomCache) {
      roomCache = BeeToolbox._buildEnergySinkCacheForRoom(room);
      if (cache) {
        cache.rooms[room.name] = roomCache;
      }
    }

    var results = [];
    for (var t = 0; t < types.length; t++) {
      var type = types[t];
      var list = roomCache.byType[type];
      if (!list || !list.length) continue;
      for (var j = 0; j < list.length; j++) {
        var structure = list[j];
        if (!structure || !structure.store || typeof structure.store.getFreeCapacity !== 'function') continue;
        if (structure.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) continue;
        results.push(structure);
      }
    }
    return results;
  },

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

  deliverEnergy: function (creep, structureTypes) {
    if (!creep) return ERR_INVALID_TARGET;
    structureTypes = structureTypes || [];

    var STRUCTURE_PRIORITY = {};
    STRUCTURE_PRIORITY[STRUCTURE_EXTENSION] = 2;
    STRUCTURE_PRIORITY[STRUCTURE_SPAWN]     = 3;
    STRUCTURE_PRIORITY[STRUCTURE_TOWER]     = 4;
    STRUCTURE_PRIORITY[STRUCTURE_STORAGE]   = 1;
    STRUCTURE_PRIORITY[STRUCTURE_CONTAINER] = 5;

    // FIX: Pull candidate sinks from the cached per-room list to avoid repeating full structure scans each tick.
    var targets = BeeToolbox._getEnergySinkTargets(creep.room, structureTypes) || [];

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

  findAttackTarget: function (creep) {
    if (!creep) return null;

    // 1) hostile creeps
    var hostile = creep.pos.findClosestByPath(FIND_HOSTILE_CREEPS, {
      filter: function (c) { return isEnemyCreepObject(c); }
    });
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
      filter: function (s) {
        if (!prioTypes[s.structureType]) return false;
        if (!s.owner) return true;
        return isEnemyStructureObject(s);
      }
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
        if (s.owner && !isEnemyStructureObject(s)) return false;
        return true;
      }
    });
    if (other) {
      return firstBarrierOnPath(creep, other) || other;
    }

    // 5) nothing sensible
    return null;
  },

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

  isInTowerDanger: function (pos, radius) {
    if (!pos) return false;
    var room = Game.rooms[pos.roomName];
    if (!room) return false;
    var limit = (typeof radius === 'number') ? radius : 20;
    var towers = room.find(FIND_HOSTILE_STRUCTURES, {
      filter: function (s) {
        if (s.structureType !== STRUCTURE_TOWER) return false;
        if (s.owner && !isEnemyStructureObject(s)) return false;
        return true;
      }
    });
    for (var i = 0; i < towers.length; i++) {
      if (towers[i].pos.getRangeTo(pos) <= limit) {
        return true;
      }
    }
    return false;
  },

  estimateTowerDamage: function (room, pos) {
    if (!room || !pos) return 0;
    var towers = room.find(FIND_HOSTILE_STRUCTURES, {
      filter: function (s) {
        if (s.structureType !== STRUCTURE_TOWER) return false;
        if (s.owner && !isEnemyStructureObject(s)) return false;
        return true;
      }
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

  combatInHoldBand: function (range, desiredRange, holdBand) {
    if (typeof range !== 'number') return false;
    var desired = (typeof desiredRange === 'number') ? desiredRange : 1;
    var band = (typeof holdBand === 'number') ? holdBand : 0;
    if (range < desired) return false;
    if (range > (desired + band)) return false;
    return true;
  },

  combatThreats: function (room) {
    if (!room) return [];
    var creeps = room.find(FIND_HOSTILE_CREEPS, {
      filter: function (h) {
        if (!isEnemyCreepObject(h)) return false;
        return h.getActiveBodyparts(ATTACK) > 0 || h.getActiveBodyparts(RANGED_ATTACK) > 0;
      }
    });
    var towers = room.find(FIND_HOSTILE_STRUCTURES, {
      filter: function (s) { return s.structureType === STRUCTURE_TOWER; }
    });
    return creeps.concat(towers);
  },

  combatShootOpportunistic: function (creep) {
    if (!creep) return false;
    var closer = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS, {
      filter: function (c) { return isEnemyCreepObject(c); }
    });
    if (closer && creep.pos.inRangeTo(closer, 3)) {
      creep.rangedAttack(closer);
      return true;
    }
    return false;
  },

  combatShootPrimary: function (creep, target, config) {
    if (!creep || !target) return false;
    var opts = config || {};
    var threshold = (opts.massAttackThreshold != null) ? opts.massAttackThreshold : 3;
    var hostiles = creep.pos.findInRange(FIND_HOSTILE_CREEPS, 3, {
      filter: function (c) { return isEnemyCreepObject(c); }
    });
    if (hostiles.length >= threshold) {
      creep.rangedMassAttack();
      return true;
    }
    var range = creep.pos.getRangeTo(target);
    if (range <= 3) {
      if (target.owner && !isEnemyCreepObject(target)) {
        noteFriendlySkip(creep, target, 'ranged-attack');
        return false;
      }
      creep.rangedAttack(target);
      return true;
    }
    return BeeToolbox.combatShootOpportunistic(creep);
  },

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
        if (fromThings[i].owner && !isEnemyUsername(fromThings[i].owner.username)) continue;
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

    var bad = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS, {
      filter: function (c) { return isEnemyCreepObject(c); }
    });
    if (bad) {
      var dir = creep.pos.getDirectionTo(bad);
      var zero = (dir - 1 + 8) % 8;
      var back = ((zero + 4) % 8) + 1;
      creep.move(back);
      return true;
    }
    return false;
  },

  combatStepToward: function (creep, targetPos, range, taskSquad) {
    if (!creep || !targetPos) return ERR_INVALID_TARGET;
    var destination = (targetPos.pos || targetPos);
    var desiredRange = (typeof range === 'number') ? range : 1;
    if (taskSquad && taskSquad.stepToward) {
      return taskSquad.stepToward(creep, destination, desiredRange);
    }
    return BeeToolbox.BeeTravel(creep, destination, { range: desiredRange });
  },

  // FIX: Expose a squad roster helper so combat utilities can iterate the current squad without filtering every creep.
  _getSquadMembers: function (squadId, excludeName) {
    var sid = squadId || 'Alpha';
    var roster = [];
    if (Memory && Memory.squads && Memory.squads[sid] && Memory.squads[sid].members) {
      var bucket = Memory.squads[sid].members;
      for (var name in bucket) {
        if (!BeeToolbox.hasOwn(bucket, name)) continue;
        if (excludeName && name === excludeName) continue;
        var creep = Game.creeps[name];
        if (!creep || !creep.my) continue;
        roster.push(creep);
      }
    }
    return roster;
  },

  combatAuxHeal: function (creep, squadId) {
    if (!creep) return false;
    var healParts = creep.getActiveBodyparts(HEAL);
    if (!healParts) return false;

    if (creep.hits < creep.hitsMax) {
      creep.heal(creep);
      return true;
    }

    var sid = squadId || (creep.memory && creep.memory.squadId) || 'Alpha';
    // FIX: Pull wounded squadmates from the squad roster (with a room-level fallback) instead of filtering every creep in the world each tick.
    var roster = BeeToolbox._getSquadMembers(sid, creep.name);
    if ((!roster || !roster.length) && creep.room) {
      roster = creep.room.find(FIND_MY_CREEPS, {
        filter: function (ally) {
          return ally && ally.id !== creep.id && ally.memory && ally.memory.squadId === sid;
        }
      });
    }

    var mates = [];
    if (roster && roster.length) {
      for (var i = 0; i < roster.length; i++) {
        var member = roster[i];
        if (!member || member.hits >= member.hitsMax) continue;
        mates.push(member);
      }
    }

    if (!mates.length) return false;

    var target = mates[0];
    var bestRatio = target.hits / Math.max(1, target.hitsMax);
    for (var m = 1; m < mates.length; m++) {
      var ratio = mates[m].hits / Math.max(1, mates[m].hitsMax);
      if (ratio < bestRatio) {
        bestRatio = ratio;
        target = mates[m];
      }
    }
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

  combatGuardSquadmate: function (creep, options) {
    if (!creep) return false;
    var opts = options || {};
    var squadId = opts.squadId || (creep.memory && creep.memory.squadId) || 'Alpha';
    var taskSquad = opts.taskSquad;
    var protectRoles = opts.protectRoles || { CombatArcher: true, CombatMedic: true, Dismantler: true };
    var threatFilter = opts.threatFilter || function (h) {
      return h.getActiveBodyparts(ATTACK) > 0;
    };

    // FIX: Only scan the current squad (or the local room) to find threatened allies instead of iterating every creep globally.
    var roster = BeeToolbox._getSquadMembers(squadId, null);
    if ((!roster || !roster.length) && creep.room) {
      roster = creep.room.find(FIND_MY_CREEPS, {
        filter: function (ally) {
          return ally && ally.memory && ally.memory.squadId === squadId;
        }
      });
    }

    var threatened = [];
    if (roster && roster.length) {
      for (var r = 0; r < roster.length; r++) {
        var ally = roster[r];
        if (!ally || ally.id === creep.id) continue;
        if (!ally.memory || ally.memory.squadId !== squadId) continue;
        var role = ally.memory.task || ally.memory.role || '';
        if (!protectRoles[role]) continue;
        var nearThreats = ally.pos.findInRange(FIND_HOSTILE_CREEPS, 1, {
          filter: function (c) {
            if (!isEnemyCreepObject(c)) return false;
            return threatFilter(c);
          }
        });
        if (nearThreats && nearThreats.length > 0) {
          threatened.push(ally);
        }
      }
    }
    if (!threatened.length) return false;

    var buddy = creep.pos.findClosestByRange(threatened);
    if (!buddy) return false;

    if (creep.pos.isNearTo(buddy)) {
      if (taskSquad && taskSquad.tryFriendlySwap && taskSquad.tryFriendlySwap(creep, buddy.pos)) {
        return true;
      }
      var badList = buddy.pos.findInRange(FIND_HOSTILE_CREEPS, 1, {
        filter: function (c) {
          if (!isEnemyCreepObject(c)) return false;
          return threatFilter(c);
        }
      });
      var bad = badList[0];
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
        if (!isEnemyCreepObject(h)) return false;
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

  combatWeakestHostile: function (creep, range) {
    if (!creep) return null;
    var maxRange = (typeof range === 'number') ? range : 2;
    var xs = creep.pos.findInRange(FIND_HOSTILE_CREEPS, maxRange, {
      filter: function (c) { return isEnemyCreepObject(c); }
    });
    if (!xs.length) return null;
    return _.min(xs, function (c) { return c.hits / Math.max(1, c.hitsMax); });
  },

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
    var bad = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS, {
      filter: function (c) { return isEnemyCreepObject(c); }
    });
    if (bad) {
      var dir = creep.pos.getDirectionTo(bad);
      var zero = (dir - 1 + 8) % 8;
      var back = ((zero + 4) % 8) + 1;
      creep.move(back);
      return true;
    }
    return false;
  },

  findLowestInjuredAlly: function (origin, range) {
    if (!origin) return null;
    var rad = (typeof range === 'number') ? range : 3;
    var allies = origin.findInRange(FIND_MY_CREEPS, rad, {
      filter: function (ally) { return ally.hits < ally.hitsMax; }
    });
    if (!allies.length) return null;
    return _.min(allies, function (ally) { return ally.hits / Math.max(1, ally.hitsMax); });
  },

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

  countRoleFollowingTarget: function (squadId, targetId, roleName) {
    if (!targetId) return 0;
    var sid = squadId || 'Alpha';
    var role = roleName || '';

    var taskSquad = _getTaskSquadModule();
    if (taskSquad && typeof taskSquad.getFollowLoad === 'function') {
      // Use TaskSquad's per-tick cache so callers avoid O(n) scans on every query.
      var cached = taskSquad.getFollowLoad(sid, targetId, role);
      if (cached !== null && cached !== undefined) return cached;
    }

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

BeeToolbox.isAllyUsername = isAllyUsername;
BeeToolbox.isEnemyUsername = isEnemyUsername;
BeeToolbox.isEnemyCreep = isEnemyCreepObject;
BeeToolbox.isEnemyStructure = isEnemyStructureObject;

BeeToolbox.ECON_CFG = global.__beeEconomyConfig;
BeeToolbox.HARVESTER_CFG = HARVESTER_CFG;

BeeToolbox.registerEconomyOverrides = function (sourceName, overrides) {
  if (!overrides) return BeeToolbox.ECON_CFG;
  var cfg = BeeToolbox.ECON_CFG;
  for (var key in overrides) {
    if (!BeeToolbox.hasOwn(overrides, key)) continue;
    if (cfg[key] === overrides[key]) continue;
    cfg[key] = overrides[key];
    _logEconomyOverride(sourceName || 'unknown', key, overrides[key]);
  }
  return cfg;
};

module.exports = BeeToolbox;
