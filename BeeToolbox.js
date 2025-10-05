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
  // 🛡️ COMBAT HELPERS
  // ---------------------------------------------------------------------------

  /**
   * Determine if a position is within danger range of any hostile tower.
   * @param {RoomPosition} pos Screeps position to inspect.
   * @param {number} radius Maximum range from a tower considered dangerous.
   * @returns {boolean} True if any hostile tower is within the radius.
   * @sideeffects None.
   * @example
   * if (BeeToolbox.isInTowerDanger(creep.pos, 20)) { creep.say('⚠'); }
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
   * @example
   * var dmg = BeeToolbox.estimateTowerDamage(creep.room, creep.pos);
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
   * @example
   * if (BeeToolbox.combatInHoldBand(range, 2, 1)) { return; }
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
