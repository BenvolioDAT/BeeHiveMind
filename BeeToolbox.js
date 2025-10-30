// BeeToolbox.js — ES5-safe helpers shared across roles/tasks
// NOTE: Compatible with Screeps runtime (no arrow funcs, no const/let, no includes, etc.)

'use strict';

var Traveler = require('Traveler');
var Logger = require('core.logger');
var LOG_LEVEL = Logger.LOG_LEVEL;
var toolboxLog = Logger.createLogger('Toolbox', LOG_LEVEL.BASIC);

// Interval (in ticks) before we rescan containers adjacent to sources.
// Kept small enough to react to construction/destruction, but large enough
// to avoid expensive FIND_STRUCTURES work every few ticks.
var SOURCE_CONTAINER_SCAN_INTERVAL = 50;

var BeeToolbox = {

  // ---------------------------------------------------------------------------
  // 📒 SOURCE & CONTAINER INTEL
  // ---------------------------------------------------------------------------

  // Logs all sources in a room to Memory.rooms[room].sources (object keyed by source.id).
  // (Comment fixed: we store an OBJECT per source id, not an "array".)
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

  // Logs containers that are within 1 tile of any source.
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

  // Assign an unclaimed container (or one whose courier died) to the calling creep.
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

  // Mark room hostile if it contains an Invader Core.
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

  // Toggle "returning" state based on store fullness
  updateReturnState: function (creep) {
    if (!creep) return;
    if (creep.memory.returning && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.returning = false;
    }
    if (!creep.memory.returning && creep.store.getFreeCapacity() === 0) {
      creep.memory.returning = true;
    }
  },

  // Return nearby room names (within "range") that have Memory.rooms[r].sources entries
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
  // 🚚 MOVEMENT: Traveler wrapper
  // ---------------------------------------------------------------------------

  /**
   * BeeTravel — Unified wrapper around Traveler.
   * Supports BOTH call styles:
   *   BeeTravel(creep, target, { range: 1, ignoreCreeps: true })
   *   BeeTravel(creep, target, 1, /* reuse= * / 30, { ignoreCreeps:true })
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
