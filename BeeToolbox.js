
var Traveler = require('Traveler');
var Logger = require('core.logger');
var CoreConfig = require('core.config');
var LOG_LEVEL = Logger.LOG_LEVEL;
var toolboxLog = Logger.createLogger('Toolbox', LOG_LEVEL.BASIC);

// This utility file gets touched by nearly every role.  The more we can keep the
// helpers flat and well-named, the easier it is for a new contributor to spot a
// guard or data cache they can reuse in their own logic.

function _norm(name) {
  if (!name) return '';
  return String(name).toLowerCase();
}

var _ALLY_MAP = {};
var _allyList = CoreConfig.ALLY_USERNAMES || [];
for (var _ai = 0; _ai < _allyList.length; _ai++) {
  var _allyName = _allyList[_ai];
  if (typeof _allyName === 'string' && _allyName.length > 0) {
    _ALLY_MAP[_norm(_allyName)] = true;
  }
}

function isAlly(username) {
  var key = _norm(username);
  if (!key) return false;
  return _ALLY_MAP[key] === true;
}

function isNpcHostileOwner(ownerName) {
  var key = _norm(ownerName);
  if (!key) return false;
  if (key === 'invader') return true;
  if (CoreConfig.TREAT_SOURCE_KEEPERS_AS_PVE && key === 'source keeper') return true;
  return false;
}

var _myNameTick = -1;
var _myNameCache = null;

function _myUsername() {
  if (!Game) return null;
  if (_myNameTick === Game.time) return _myNameCache;
  _myNameTick = Game.time;
  _myNameCache = null;

  var k;
  for (k in Game.spawns) {
    if (!Game.spawns.hasOwnProperty(k)) continue;
    var s = Game.spawns[k];
    if (s && s.owner && s.owner.username) {
      _myNameCache = s.owner.username;
      return _myNameCache;
    }
  }

  for (k in Game.rooms) {
    if (!Game.rooms.hasOwnProperty(k)) continue;
    var r = Game.rooms[k];
    if (!r || !r.controller) continue;
    if (r.controller.my && r.controller.owner && r.controller.owner.username) {
      _myNameCache = r.controller.owner.username;
      return _myNameCache;
    }
  }

  return _myNameCache;
}

function _isAllyUsername(name) {
  return isAlly(name);
}

function _isFriendlyUsername(name) {
  if (!name) return false;
  if (isAlly(name)) return true;
  var me = _myUsername();
  return !!(me && name === me);
}

function _isNpcOwner(name) {
  if (!name) return false;
  if (isNpcHostileOwner(name)) return true;
  return false;
}

function _isNpcTarget(obj) {
  if (!obj) return false;
  if (obj.owner && obj.owner.username && _isNpcOwner(obj.owner.username)) return true;
  if (obj.structureType === STRUCTURE_INVADER_CORE) return true;
  return false;
}

function _isNpcCreep(obj) { return _isNpcTarget(obj); }
function _isNpcStruct(obj) { return _isNpcTarget(obj); }

function _isAllyObject(obj) {
  if (!obj || !obj.owner) return false;
  return _isAllyUsername(obj.owner.username);
}

function _isFriendlyObject(obj) {
  if (!obj || !obj.owner) return false;
  return _isFriendlyUsername(obj.owner.username);
}

function _isMyRoom(room) {
  if (!room || !room.controller) return false;
  if (room.controller.my) return true;
  if (!room.controller.reservation || !room.controller.reservation.username) return false;
  var me = _myUsername();
  return !!(me && room.controller.reservation.username === me);
}

function _isAllyRoom(room) {
  if (!room || !room.controller) return false;
  if (room.controller.owner && _isAllyUsername(room.controller.owner.username)) return true;
  if (room.controller.reservation && _isAllyUsername(room.controller.reservation.username)) return true;
  return false;
}

function _isForeignPlayerRoom(room) {
  if (!room || !room.controller) return false;
  if (room.controller.my) return false;
  var me = _myUsername();
  if (room.controller.owner && room.controller.owner.username) {
    var ownerName = room.controller.owner.username;
    if (_isNpcOwner(ownerName)) return false;
    if (me && ownerName === me) return false;
    return true;
  }
  if (room.controller.reservation && room.controller.reservation.username) {
    var resName = room.controller.reservation.username;
    if (_isNpcOwner(resName)) return false;
    if (me && resName === me) return false;
    return true;
  }
  return false;
}

function _canEngageTarget(attacker, target) {
  if (!attacker || !target) return false;
  if (_isFriendlyObject(target)) return false;

  var room = attacker.room;
  if (!room && target.pos && target.pos.roomName) {
    room = Game.rooms[target.pos.roomName];
  }
  if (!room) return false;
  if (_isAllyRoom(room)) return false;

  var npc = _isNpcTarget(target);
  if (npc) {
    if (_isForeignPlayerRoom(room)) {
      return CoreConfig.ALLOW_INVADERS_IN_FOREIGN_ROOMS !== false;
    }
    return true;
  }

  var ownerName = target.owner && target.owner.username;
  if (ownerName && !_isFriendlyUsername(ownerName)) {
    if (CoreConfig.ALLOW_PVP === false && !_isMyRoom(room)) {
      return false;
    }
  }

  if (_isForeignPlayerRoom(room)) {
    return CoreConfig.ALLOW_PVP !== false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// 🚶 Shared Traveler wrapper
// ---------------------------------------------------------------------------

/**
 * BeeTravel — Unified wrapper around Traveler.
 * Supports BOTH call styles:
 *   BeeTravel(creep, target, { range: 1, ignoreCreeps: true })
 *   BeeTravel(creep, target, 1, /* reuse= * / 30, { ignoreCreeps:true })
 */
function BeeTravel(creep, target, a3, a4, a5) {
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

// Interval (in ticks) before we rescan containers adjacent to sources.
// Kept small enough to react to construction/destruction, but large enough
// to avoid expensive FIND_STRUCTURES work every few ticks.
var SOURCE_CONTAINER_SCAN_INTERVAL = 50;

// ---------------------------------------------------------------------------
// ⚡ Energy cache builders (shared by couriers, builders, etc.)
// ---------------------------------------------------------------------------

function ensureGlobalEnergyCache() {
  if (typeof global === 'undefined') return null;
  if (!global.__energyTargets || global.__energyTargets.tick !== Game.time) {
    global.__energyTargets = { tick: Game.time, rooms: {} };
  }
  if (!global.__energyTargets.rooms) {
    global.__energyTargets.rooms = {};
  }
  return global.__energyTargets;
}

function buildEnergyCacheForRoom(room) {
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
}

function getRoomEnergyCache(room) {
  if (!room) return { ruins: [], tombstones: [], dropped: [], containers: [] };
  var globalCache = ensureGlobalEnergyCache();
  if (!globalCache) {
    return buildEnergyCacheForRoom(room);
  }

  var roomCache = globalCache.rooms[room.name];
  if (!roomCache) {
    roomCache = buildEnergyCacheForRoom(room);
    globalCache.rooms[room.name] = roomCache;
  }
  return roomCache;
}

function refreshRoomEnergyCache(room) {
  if (!room) return { ruins: [], tombstones: [], dropped: [], containers: [] };
  var globalCache = ensureGlobalEnergyCache();
  var newCache = buildEnergyCacheForRoom(room);
  if (globalCache) {
    globalCache.rooms[room.name] = newCache;
  }
  return newCache;
}

function getEnergyTargetsFromCache(room, key, validator) {
  var cache = getRoomEnergyCache(room);
  var ids = cache[key] || [];
  var filtered = filterTargets(ids, validator);
  cache[key] = filtered.ids;

  // If nothing in cache is usable anymore, refresh the room intel once and try again.
  if (filtered.objects.length === 0) {
    cache = refreshRoomEnergyCache(room);
    ids = cache[key] || [];
    filtered = filterTargets(ids, validator);
    cache[key] = filtered.ids;
  }

  return filtered.objects;
}

// Light helper shared by initial cache pass and the refresh fallback.
function filterTargets(ids, validator) {
  var objects = [];
  var keptIds = [];

  for (var i = 0; i < ids.length; i++) {
    var obj = Game.getObjectById(ids[i]);
    if (!obj || (validator && !validator(obj))) continue;

    objects.push(obj);
    keptIds.push(ids[i]);
  }

  return { objects: objects, ids: keptIds };
}

function withdrawOrPickup(creep, targets, action) {
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
    BeeTravel(creep, target, { range: 1, ignoreCreeps: true });
  }
  return result === OK;
}

// Helper used by collectEnergy: gives us a single line per category, which is
// much easier for a new reader to reason about than inlining the filtering and
// movement calls four times in a row.
function gatherEnergyFromCategory(creep, room, key, validator, action) {
  if (!creep || !room) return false;
  var targets = getEnergyTargetsFromCache(room, key, validator);
  return withdrawOrPickup(creep, targets, action);
}

// Lower numbers are tried first when delivering energy; kept in one place so
// deliverEnergy's scan can stay minimal.
var DELIVER_PRIORITY = {};
DELIVER_PRIORITY[STRUCTURE_STORAGE]   = 1;
DELIVER_PRIORITY[STRUCTURE_EXTENSION] = 2;
DELIVER_PRIORITY[STRUCTURE_SPAWN]     = 3;
DELIVER_PRIORITY[STRUCTURE_TOWER]     = 4;
DELIVER_PRIORITY[STRUCTURE_CONTAINER] = 5;

var BeeToolbox = {

  isAlly: function (name) { return isAlly(name); },
  
  isAllyUsername: function (name) { return _isAllyUsername(name); },
  isFriendlyUsername: function (name) { return _isFriendlyUsername(name); },
  isAllyObject: function (obj) { return _isAllyObject(obj); },
  isFriendlyObject: function (obj) { return _isFriendlyObject(obj); },
  isNpcOwner: function (name) { return _isNpcOwner(name); },
  isNpcHostileOwner: function (name) { return isNpcHostileOwner(name); },
  isNpcTarget: function (obj) { return _isNpcTarget(obj); },
  isNpcHostileCreep: function (obj) { return _isNpcCreep(obj); },
  isNpcHostileStruct: function (obj) { return _isNpcStruct(obj); },
  isMyRoom: function (room) { return _isMyRoom(room); },
  isAllyRoom: function (room) { return _isAllyRoom(room); },
  isForeignPlayerRoom: function (room) { return _isForeignPlayerRoom(room); },
  canEngageTarget: function (attacker, target) { return _canEngageTarget(attacker, target); },
  myUsername: function () { return _myUsername(); },

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
    var now = Game.time;
    var nextScan = typeof scanState.nextScan === 'number' ? scanState.nextScan : 0;

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

  _ensureGlobalEnergyCache: ensureGlobalEnergyCache,
  _buildEnergyCacheForRoom: buildEnergyCacheForRoom,
  _getRoomEnergyCache: getRoomEnergyCache,
  _refreshRoomEnergyCache: refreshRoomEnergyCache,
  _getEnergyTargetsFromCache: getEnergyTargetsFromCache,

  collectEnergy: function (creep) {
    if (!creep) return;
    var room = creep.room;
    if (!room) return;

    // Learner tip: when you have a waterfall of similar attempts, hide the
    // repeated logic in a helper (gatherEnergyFromCategory) so the high level
    // tells a clear story of "check ruins → tombstones → dropped → containers".
    if (gatherEnergyFromCategory(creep, room, 'ruins', function (target) {
      return target.store && target.store[RESOURCE_ENERGY] > 0;
    }, 'withdraw')) return;

    if (gatherEnergyFromCategory(creep, room, 'tombstones', function (target) {
      return target.store && target.store[RESOURCE_ENERGY] > 0;
    }, 'withdraw')) return;

    if (gatherEnergyFromCategory(creep, room, 'dropped', function (target) {
      return target.resourceType === RESOURCE_ENERGY && target.amount > 0;
    }, 'pickup')) return;

    if (gatherEnergyFromCategory(creep, room, 'containers', function (target) {
      return target.structureType === STRUCTURE_CONTAINER && target.store && target.store[RESOURCE_ENERGY] > 0;
    }, 'withdraw')) return;

    var storage = creep.room.storage;
    if (storage && storage.store && storage.store[RESOURCE_ENERGY] > 0) {
      var res = creep.withdraw(storage, RESOURCE_ENERGY);
      if (res === ERR_NOT_IN_RANGE) {
        BeeTravel(creep, storage, { range: 1 });
      }
    }
  },

  deliverEnergy: function (creep, structureTypes) {
    if (!creep) return ERR_INVALID_TARGET;
    var carry = creep.store ? creep.store.getUsedCapacity(RESOURCE_ENERGY) : 0;
    if (carry <= 0) return ERR_NOT_ENOUGH_RESOURCES;

    // Normalize the target list so callers can pass a single type or an array.
    // If nothing is provided, default to the common fill targets (spawn/
    // extensions/towers) so couriers focus on bootstrapping before storage.
    var types = [];
    if (Array.isArray(structureTypes)) {
      types = structureTypes;
    } else if (structureTypes) {
      types = [structureTypes];
    } else {
      types = [
        STRUCTURE_EXTENSION,
        STRUCTURE_SPAWN,
        STRUCTURE_TOWER
      ];
    }

    // Build a quick lookup so the single-pass scan below stays readable.
    var allowedTypes = {};
    for (var i = 0; i < types.length; i++) {
      allowedTypes[types[i]] = true;
    }
    if (!Object.keys(allowedTypes).length) return ERR_NOT_FOUND;

    var sources = allowedTypes[STRUCTURE_CONTAINER] ? creep.room.find(FIND_SOURCES) : [];

    // Pick the best target in one pass: highest priority, then closest.
    var best = null;
    var bestPriority = Infinity;
    var bestDist = Infinity;

    var structures = creep.room.find(FIND_STRUCTURES);
    for (var s = 0; s < structures.length; s++) {
      var struct = structures[s];
      if (!allowedTypes[struct.structureType]) continue;

      if (!struct.store || struct.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) continue;

      // Skip drop-off containers that sit right next to a source.
      if (struct.structureType === STRUCTURE_CONTAINER && sources.length) {
        var nearSource = false;
        for (var j = 0; j < sources.length; j++) {
          if (struct.pos.inRangeTo(sources[j].pos, 1)) {
            nearSource = true;
            break;
          }
        }
        if (nearSource) continue;
      }

      var priority = DELIVER_PRIORITY[struct.structureType] || 99;
      var dist = creep.pos.getRangeTo(struct);
      if (priority < bestPriority || (priority === bestPriority && dist < bestDist)) {
        bestPriority = priority;
        bestDist = dist;
        best = struct;
      }
    }

    if (!best) return ERR_NOT_FOUND;

    var r = creep.transfer(best, RESOURCE_ENERGY);
    if (r === ERR_NOT_IN_RANGE) {
      BeeToolbox.BeeTravel(creep, best, { range: 1 });
    }
    return r;
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
  // Acceptance: BeeToolbox.findAttackTarget only returns Invader creeps/structures (PvE-only)
  findAttackTarget: function (creep) {
    if (!creep) return null;

    // 1) hostile creeps
    var hostile = creep.pos.findClosestByPath(FIND_HOSTILE_CREEPS, { filter: _isNpcCreep });
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
          if (s.structureType === STRUCTURE_RAMPART && _isNpcStruct(s)) return s;
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
      filter: function (s) { return _isNpcStruct(s) && prioTypes[s.structureType] === true; }
    });
    if (prio) {
      return firstBarrierOnPath(creep, prio) || prio;
    }

    // 4) any other hostile structure (not controller/walls/closed ramparts)
    var other = creep.pos.findClosestByPath(FIND_HOSTILE_STRUCTURES, {
      filter: function (s) {
        if (!_isNpcStruct(s)) return false;
        if (s.structureType === STRUCTURE_CONTROLLER) return false;
        if (s.structureType === STRUCTURE_WALL) return false;
        if (s.structureType === STRUCTURE_RAMPART && _isNpcStruct(s)) return false;
        return true;
      }
    });
    if (other) {
      return firstBarrierOnPath(creep, other) || other;
    }

    // 5) nothing sensible
    return null;
  },

  // Combat medic pacing helpers moved into Combat.API/role logic (2024 refactor).

  // ---------------------------------------------------------------------------
  // 🚚 MOVEMENT: Traveler wrapper
  // ---------------------------------------------------------------------------

  BeeTravel: BeeTravel

}; // end BeeToolbox

module.exports = BeeToolbox;
