"use strict";

var CoreLogger = require('core.logger');
var CoreConfig = require('core.config');
var LOG_LEVEL = CoreLogger.LOG_LEVEL;
var planLog = CoreLogger.createLogger('BuilderPlanner', LOG_LEVEL.BASIC);

var getEconomySettings = (typeof CoreConfig.getEconomySettings === 'function')
  ? CoreConfig.getEconomySettings
  : function () {
    var hive = CoreConfig.settings && CoreConfig.settings['BeeHiveMind'];
    return hive && hive.ECON_DEFAULTS ? hive.ECON_DEFAULTS : {};
  };

function _ensureEconomyConfig() {
  var defaults = getEconomySettings();
  var cfg = null;
  if (typeof global !== 'undefined' && global && typeof global.__beeEconomyConfig === 'object') {
    cfg = global.__beeEconomyConfig;
  }
  var roadDefaults = defaults.roads || { minRCL: 3, disableGate: false };
  var remoteRoadDefaults = defaults.remoteRoads || { minStorageEnergy: 40000 };
  if (!cfg) {
    cfg = {
      STORAGE_ENERGY_MIN_BEFORE_REMOTES: defaults.STORAGE_ENERGY_MIN_BEFORE_REMOTES,
      MAX_ACTIVE_REMOTES: defaults.MAX_ACTIVE_REMOTES,
      ROAD_REPAIR_THRESHOLD: defaults.ROAD_REPAIR_THRESHOLD,
      STORAGE_HEALTHY_RATIO: defaults.STORAGE_HEALTHY_RATIO,
      CPU_MIN_BUCKET: defaults.CPU_MIN_BUCKET,
      remoteRoads: { minStorageEnergy: remoteRoadDefaults.minStorageEnergy },
      roads: {
        minRCL: roadDefaults.minRCL,
        disableGate: roadDefaults.disableGate
      }
    };
    if (typeof global !== 'undefined' && global) {
      global.__beeEconomyConfig = cfg;
    }
  } else {
    if (typeof cfg.STORAGE_ENERGY_MIN_BEFORE_REMOTES !== 'number') {
      cfg.STORAGE_ENERGY_MIN_BEFORE_REMOTES = defaults.STORAGE_ENERGY_MIN_BEFORE_REMOTES;
    }
    if (typeof cfg.MAX_ACTIVE_REMOTES !== 'number') {
      cfg.MAX_ACTIVE_REMOTES = defaults.MAX_ACTIVE_REMOTES;
    }
    if (typeof cfg.ROAD_REPAIR_THRESHOLD !== 'number') {
      cfg.ROAD_REPAIR_THRESHOLD = defaults.ROAD_REPAIR_THRESHOLD;
    }
    if (typeof cfg.STORAGE_HEALTHY_RATIO !== 'number') {
      cfg.STORAGE_HEALTHY_RATIO = defaults.STORAGE_HEALTHY_RATIO;
    }
    if (typeof cfg.CPU_MIN_BUCKET !== 'number') {
      cfg.CPU_MIN_BUCKET = defaults.CPU_MIN_BUCKET;
    }
    if (!cfg.remoteRoads || typeof cfg.remoteRoads !== 'object') {
      cfg.remoteRoads = { minStorageEnergy: remoteRoadDefaults.minStorageEnergy };
    } else if (typeof cfg.remoteRoads.minStorageEnergy !== 'number') {
      cfg.remoteRoads.minStorageEnergy = remoteRoadDefaults.minStorageEnergy;
    }
    if (!cfg.roads || typeof cfg.roads !== 'object') {
      cfg.roads = { minRCL: roadDefaults.minRCL, disableGate: roadDefaults.disableGate };
    } else {
      if (typeof cfg.roads.minRCL !== 'number') {
        cfg.roads.minRCL = roadDefaults.minRCL;
      }
      if (cfg.roads.disableGate !== true && cfg.roads.disableGate !== false) {
        cfg.roads.disableGate = roadDefaults.disableGate;
      }
    }
  }
  return cfg;
}

var ECON_CFG = _ensureEconomyConfig();

function _refreshEconomyConfig() {
  ECON_CFG = _ensureEconomyConfig();
  return ECON_CFG;
}

function hasOwn(obj, key) {
  return !!(obj && Object.prototype.hasOwnProperty.call(obj, key));
}

function isObject(value) {
  return value !== null && typeof value === 'object';
}

function looksLikeRoomName(name) {
  if (typeof name !== 'string') return false;
  if (name.length < 4) return false;
  var first = name.charAt(0);
  if (first !== 'W' && first !== 'E') return false;
  if (name.indexOf('N') === -1 && name.indexOf('S') === -1) return false;
  return true;
}

function isValidRoomName(name) {
  if (typeof name !== 'string') return false;
  return /^[WE]\d+[NS]\d+$/.test(name);
}

function safeLinearDistance(a, b, allowInexact) {
  if (!isValidRoomName(a) || !isValidRoomName(b)) {
    return 9999;
  }
  if (!Game || !Game.map || typeof Game.map.getRoomLinearDistance !== 'function') {
    return 9999;
  }
  return Game.map.getRoomLinearDistance(a, b, allowInexact);
}

function normalizeRemoteRooms(input) {
  var result = [];
  var seen = Object.create(null);

  function addName(value) {
    if (!value) return;
    var name = null;
    if (typeof value === 'string') {
      name = value;
    } else if (typeof value.roomName === 'string') {
      name = value.roomName;
    } else if (typeof value.name === 'string') {
      name = value.name;
    }
    if (!name) return;
    if (seen[name]) return;
    seen[name] = true;
    result.push(name);
  }

  if (!input) {
    return result;
  }

  if (typeof input === 'string') {
    addName(input);
    return result;
  }

  if (Array.isArray(input)) {
    for (var i = 0; i < input.length; i++) {
      addName(input[i]);
    }
    return result;
  }

  if (typeof input === 'object') {
    if (typeof input.roomName === 'string' || typeof input.name === 'string') {
      addName(input);
      return result;
    }
    for (var key in input) {
      if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
      addName(input[key]);
      if (looksLikeRoomName(key)) {
        addName(key);
      }
    }
  }

  return result;
}

function shouldLogThrottled(store, key, interval) {
  if (!store) return true;
  var tick = Game.time | 0;
  var last = store[key] || 0;
  if (tick - last < interval) {
    return false;
  }
  store[key] = tick;
  return true;
}

function isTraceEnabled(memoryKey) {
  if (!Memory || !memoryKey) return false;
  if (Object.prototype.hasOwnProperty.call(Memory, memoryKey)) {
    return !!Memory[memoryKey];
  }
  return false;
}

function _roadGateLog(room, rcl, minRCL) {
  if (!Memory || !Memory.__traceRoads) return;
  if (!room || !room.name) return;
  if (!Memory.__roadGateLog) Memory.__roadGateLog = {};
  var record = Memory.__roadGateLog;
  if (record[room.name] === Game.time) return;
  record[room.name] = Game.time;
  console.log('[ROAD-GATE]', room.name, rcl, minRCL, 'blocked');
}

function shouldPlaceRoads(room) {
  var econ = _refreshEconomyConfig();
  var targetRoom = null;
  if (room && room.name) {
    targetRoom = room;
  } else if (typeof room === 'string' && Game && Game.rooms) {
    targetRoom = Game.rooms[room] || null;
  }

  var cfg = econ && econ.roads ? econ.roads : null;
  var minRCL = (cfg && typeof cfg.minRCL === 'number') ? cfg.minRCL : 3;
  var disableGate = !!(cfg && cfg.disableGate);

  var econMem = null;
  if (targetRoom && targetRoom.memory && targetRoom.memory.econ) {
    econMem = targetRoom.memory.econ;
  } else if (!targetRoom && typeof room === 'string' && Memory && Memory.rooms && Memory.rooms[room] && Memory.rooms[room].econ) {
    econMem = Memory.rooms[room].econ;
  }
  if (econMem && econMem.roads) {
    var override = econMem.roads;
    if (override && typeof override.minRCL === 'number') {
      minRCL = override.minRCL;
    }
    if (override && override.disableGate === true) {
      disableGate = true;
    } else if (override && override.disableGate === false) {
      disableGate = false;
    }
  }

  if (disableGate) return true;
  if (!targetRoom || !targetRoom.controller) return false;

  var rcl = targetRoom.controller.level || 0;
  if (targetRoom.controller && targetRoom.controller.my) {
    rcl = targetRoom.controller.level || 0;
  }

  if (rcl >= minRCL) return true;
  _roadGateLog(targetRoom, rcl, minRCL);
  return false;
}

var CONFIG = {
  road: {
    MAX_ACTIVE_REMOTES: ECON_CFG.MAX_ACTIVE_REMOTES,
    STORAGE_ENERGY_MIN_BEFORE_REMOTES: ECON_CFG.STORAGE_ENERGY_MIN_BEFORE_REMOTES,
    ROAD_REPAIR_THRESHOLD: ECON_CFG.ROAD_REPAIR_THRESHOLD,
    REMOTE_ROI_WEIGHTING: {
      pathLength: 1,
      swampTiles: 3,
      hostilePenalty: 5000
    },
    PLAIN_COST: 2,
    SWAMP_COST: 10,
    ROAD_COST: 1,
    MAX_OPS: 20000,
    MAX_ROOMS: 12,
    PATH_CACHE_TTL: 800,
    NULL_RETRY_TTL: 200,
    VISION_DIRTY_DELTA: 50,
    THROTTLE_LOG_INTERVAL: 1000
  },
  room: {
    MAX_SITES_PER_TICK: 5
  }
};

var BuilderPlanner = { CONFIG: CONFIG };

function _syncEconomyConfig() {
  var cfg = _refreshEconomyConfig();
  var roadCfg = CONFIG.road;
  roadCfg.MAX_ACTIVE_REMOTES = cfg.MAX_ACTIVE_REMOTES;
  var remoteCfg = cfg.remoteRoads || {};
  var minStorage = (remoteCfg && typeof remoteCfg.minStorageEnergy === 'number')
    ? remoteCfg.minStorageEnergy
    : cfg.STORAGE_ENERGY_MIN_BEFORE_REMOTES;
  roadCfg.STORAGE_ENERGY_MIN_BEFORE_REMOTES = minStorage;
  roadCfg.ROAD_REPAIR_THRESHOLD = cfg.ROAD_REPAIR_THRESHOLD;
}
_syncEconomyConfig();

var _roadCacheTrace = global.__roadPlannerCacheTrace || (global.__roadPlannerCacheTrace = {});

function _traceRoadCache(roomName, info) {
  if (!Memory || Memory.__tracePlannerCache !== true) return;
  var key = roomName || 'unknown';
  var last = _roadCacheTrace[key] || 0;
  if (Game.time && (Game.time - last) < 100) return;
  _roadCacheTrace[key] = Game.time || 0;
  console.log('[PlannerCache] road home=' + key + ' info=' + info);
}

function _roomMem(roomName) {
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
  var rm = Memory.rooms[roomName];
  if (!rm.roadPlanner) rm.roadPlanner = { paths: {}, dirty: {}, vision: {} };
  if (!rm.roadPlanner.paths) rm.roadPlanner.paths = {};
  if (!rm.roadPlanner.dirty) rm.roadPlanner.dirty = {};
  if (!rm.roadPlanner.vision) rm.roadPlanner.vision = {};
  return rm.roadPlanner;
}

function _cacheKey(fromPos, toPos, opts) {
  var base = fromPos.roomName + '>' + toPos.roomName + '|' + fromPos.x + ',' + fromPos.y + '>' + toPos.x + ',' + toPos.y;
  if (opts && opts.label) base += '#' + opts.label;
  return base;
}

function _getCostMatrix(roomName, opts) {
  var room = Game.rooms[roomName];
  if (!room) return;
  var costs = new PathFinder.CostMatrix();

  var structures = room.find(FIND_STRUCTURES);
  for (var i = 0; i < structures.length; i++) {
    var s = structures[i];
    if (s.structureType === STRUCTURE_ROAD) {
      costs.set(s.pos.x, s.pos.y, CONFIG.road.ROAD_COST);
      continue;
    }
    if (s.structureType === STRUCTURE_CONTAINER) {
      continue;
    }
    if (s.structureType === STRUCTURE_RAMPART && s.my) {
      continue;
    }
    costs.set(s.pos.x, s.pos.y, 0xff);
  }

  var sites = room.find(FIND_CONSTRUCTION_SITES);
  for (var j = 0; j < sites.length; j++) {
    var cs = sites[j];
    if (cs.structureType === STRUCTURE_ROAD) continue;
    costs.set(cs.pos.x, cs.pos.y, 0xff);
  }

  if (opts && opts.reservations) {
    for (var k = 0; k < opts.reservations.length; k++) {
      var rp = opts.reservations[k];
      if (!rp) continue;
      costs.set(rp.x, rp.y, 0xff);
    }
  }

  return costs;
}

function _obstacleSignature(room) {
  if (!room) return null;
  var structures = room.find(FIND_STRUCTURES);
  var hash = 0;
  for (var i = 0; i < structures.length; i++) {
    var s = structures[i];
    if (s.structureType === STRUCTURE_ROAD) continue;
    if (s.structureType === STRUCTURE_CONTAINER) continue;
    if (s.structureType === STRUCTURE_RAMPART && s.my) continue;
    hash = (hash + s.pos.x * 17 + s.pos.y * 29 + s.structureType.length * 13) % 2147483647;
  }
  var sites = room.find(FIND_CONSTRUCTION_SITES);
  for (var j = 0; j < sites.length; j++) {
    var cs = sites[j];
    if (cs.structureType === STRUCTURE_ROAD) continue;
    hash = (hash + cs.pos.x * 19 + cs.pos.y * 31 + cs.structureType.length * 11) % 2147483647;
  }
  return hash;
}

function _touchVision(roomName) {
  var mem = _roomMem(roomName);
  var vision = mem.vision[roomName] || {};
  var room = Game.rooms[roomName];
  if (room) {
    vision.lastSeen = Game.time;
    vision.obstacleSignature = _obstacleSignature(room);
    mem.vision[roomName] = vision;
  }
  return mem.vision[roomName] || null;
}

function _logRemoteThrottle(roomName, storage, threshold, active, max, reason) {
  if (!roomName) return;
  Memory._remoteThrottleLog = Memory._remoteThrottleLog || {};
  var key = roomName + '|' + (reason || 'generic');
  if (!shouldLogThrottled(Memory._remoteThrottleLog, key, CONFIG.road.THROTTLE_LOG_INTERVAL)) return;
  var text = '[Remotes] Skipped planning: storage=' + storage + '/threshold=' + threshold;
  text += ', active=' + active + '/max=' + max;
  text += ', reason=' + reason + ', room=' + roomName;
  planLog.info(text);
}

function _isArray(value) {
  return !!(value && typeof value.length === 'number' && typeof value.splice === 'function');
}

function _isReservedTile(room, x, y) {
  if (!room || !room.memory) return false;
  var mem = room.memory;
  var key = x + ':' + y;
  if (mem.noBuild && mem.noBuild[key]) return true;
  if (mem.reservedTiles) {
    if (isObject(mem.reservedTiles) && mem.reservedTiles[key]) return true;
    if (_isArray(mem.reservedTiles)) {
      for (var i = 0; i < mem.reservedTiles.length; i++) {
        var entry = mem.reservedTiles[i];
        if (entry && entry.x === x && entry.y === y) return true;
      }
    }
  }
  if (mem.stampReservations && _isArray(mem.stampReservations)) {
    for (var j = 0; j < mem.stampReservations.length; j++) {
      var sr = mem.stampReservations[j];
      if (sr && sr.x === x && sr.y === y) return true;
    }
  }
  return false;
}

function _ringHasContainer(room, ring) {
  for (var i = 0; i < ring.length; i++) {
    var pos = ring[i];
    var structs = room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y);
    for (var s = 0; s < structs.length; s++) {
      if (structs[s].structureType === STRUCTURE_CONTAINER) return true;
    }
    var sites = room.lookForAt(LOOK_CONSTRUCTION_SITES, pos.x, pos.y);
    for (var c = 0; c < sites.length; c++) {
      if (sites[c].structureType === STRUCTURE_CONTAINER) return true;
    }
  }
  return false;
}

function computeHub(room) {
  if (!room) return null;
  if (room.storage) return room.storage.pos;
  var spawns = room.find(FIND_MY_SPAWNS);
  if (spawns && spawns.length) return spawns[0].pos;
  if (room.controller && room.controller.my) return room.controller.pos;
  return new RoomPosition(25, 25, room.name);
}

function getOrCreatePath(fromPos, toPos, opts) {
  if (!fromPos || !toPos) return null;
  var gateRoom = null;
  if (opts && opts.roomName && Game.rooms && Game.rooms[opts.roomName]) {
    gateRoom = Game.rooms[opts.roomName];
  } else if (fromPos.roomName && Game.rooms && Game.rooms[fromPos.roomName]) {
    gateRoom = Game.rooms[fromPos.roomName];
  }
  if (gateRoom && !shouldPlaceRoads(gateRoom)) {
    return null;
  }
  var roomName = fromPos.roomName;
  var key = _cacheKey(fromPos, toPos, opts || {});
  var mem = _roomMem(roomName);
  var now = Game.time || 0;
  var vision = _touchVision(roomName);
  var rec = mem.paths[key];
  var needsRecalc = false;

  if (rec) {
    if (rec.path && rec.path.length) {
      if (!rec.expires) {
        rec.expires = (rec.lastPlanned || 0) + CONFIG.road.PATH_CACHE_TTL;
      }
      if (mem.dirty[key] && mem.dirty[key] > (rec.lastPlanned || 0)) {
        needsRecalc = true;
      }
      if (!needsRecalc && rec.expires <= now) {
        needsRecalc = true;
      }
      if (!needsRecalc && vision) {
        if (rec.lastVision && vision.lastSeen && (vision.lastSeen - rec.lastVision) > CONFIG.road.VISION_DIRTY_DELTA) {
          needsRecalc = true;
        }
        if (!needsRecalc && rec.obstacleSignature != null && vision.obstacleSignature != null && rec.obstacleSignature !== vision.obstacleSignature) {
          needsRecalc = true;
        }
      }
      if (!needsRecalc) {
        return rec.path;
      }
    } else if (rec.nullResult) {
      if (now - (rec.lastPlanned || 0) < CONFIG.road.NULL_RETRY_TTL) {
        return null;
      }
      needsRecalc = true;
    } else {
      needsRecalc = true;
    }
  }

  var searchOpts = {
    maxOps: CONFIG.road.MAX_OPS,
    maxRooms: CONFIG.road.MAX_ROOMS,
    plainCost: CONFIG.road.PLAIN_COST,
    swampCost: CONFIG.road.SWAMP_COST,
    roomCallback: function (rn) {
      return _getCostMatrix(rn, opts);
    }
  };

  var result = PathFinder.search(fromPos, { pos: toPos, range: opts && opts.range ? opts.range : 1 }, searchOpts);
  if (result.incomplete || !result.path || !result.path.length) {
    mem.paths[key] = {
      nullResult: true,
      lastPlanned: now,
      expires: now + CONFIG.road.NULL_RETRY_TTL,
      lastVision: vision ? vision.lastSeen : null,
      obstacleSignature: vision ? vision.obstacleSignature : null
    };
    return null;
  }

  var plain = [];
  var swamp = 0;
  for (var i = 0; i < result.path.length; i++) {
    var step = result.path[i];
    plain.push({ x: step.x, y: step.y, roomName: step.roomName });
    if (Game.map.getRoomTerrain(step.roomName).get(step.x, step.y) === TERRAIN_MASK_SWAMP) {
      swamp++;
    }
  }

  mem.paths[key] = {
    path: plain,
    length: result.path.length,
    swamp: swamp,
    lastPlanned: now,
    expires: now + CONFIG.road.PATH_CACHE_TTL,
    lastVision: vision ? vision.lastSeen : null,
    obstacleSignature: vision ? vision.obstacleSignature : null,
    nullResult: false
  };
  if (mem.dirty[key]) delete mem.dirty[key];

  return mem.paths[key].path;
}

function materializePath(path, opts) {
  if (!path || !path.length) return 0;
  var anchorRoom = null;
  if (opts && opts.roomName && Game.rooms && Game.rooms[opts.roomName]) {
    anchorRoom = Game.rooms[opts.roomName];
  } else if (opts && opts.room && opts.room.name && Game.rooms && Game.rooms[opts.room.name]) {
    anchorRoom = Game.rooms[opts.room.name];
  }
  if (anchorRoom && !shouldPlaceRoads(anchorRoom)) {
    return 0;
  }
  var placed = 0;
  var throttle = opts && opts.maxSites ? opts.maxSites : 3;
  var dirtyKey = opts && opts.dirtyKey ? opts.dirtyKey : null;
  var dirtyRoom = opts && opts.roomName ? opts.roomName : (path[0] ? path[0].roomName : null);

  for (var i = 0; i < path.length && placed < throttle; i++) {
    var step = path[i];
    var room = Game.rooms[step.roomName];
    if (!room) continue;
    var gateRoom = anchorRoom || room;
    var allowPlacement = true;
    if (gateRoom) {
      allowPlacement = shouldPlaceRoads(gateRoom);
    }
    if (!allowPlacement) {
      continue;
    }
    if (step.x <= 0 || step.x >= 49 || step.y <= 0 || step.y >= 49) continue;

    var terrain = room.getTerrain().get(step.x, step.y);
    if (terrain === TERRAIN_MASK_WALL) continue;

    var hasRoad = false;
    var structures = room.lookForAt(LOOK_STRUCTURES, step.x, step.y);
    for (var s = 0; s < structures.length; s++) {
      if (structures[s].structureType === STRUCTURE_ROAD) {
        hasRoad = true;
        break;
      }
    }
    if (hasRoad) continue;

    var sites = room.lookForAt(LOOK_CONSTRUCTION_SITES, step.x, step.y);
    var siteExists = false;
    for (var j = 0; j < sites.length; j++) {
      if (sites[j].structureType === STRUCTURE_ROAD) {
        siteExists = true;
        break;
      }
    }
    if (siteExists) continue;

    if (allowPlacement && room.createConstructionSite(step.x, step.y, STRUCTURE_ROAD) === OK) {
      placed++;
    }
  }

  if (dirtyKey && dirtyRoom && placed > 0) {
    var mem = _roomMem(dirtyRoom);
    mem.dirty[dirtyKey] = Game.time;
  }

  return placed;
}

function _scoreRemote(rec) {
  if (!rec) return Infinity;
  var cfg = CONFIG.road.REMOTE_ROI_WEIGHTING;
  var score = (rec.length || 999) * (cfg.pathLength || 1);
  score += (rec.swamp || 0) * (cfg.swampTiles || 0);
  if (rec.hostile) score += cfg.hostilePenalty || 0;
  return score;
}

function ensureRemoteRoads(homeRoom, cache) {
  if (!homeRoom || !homeRoom.controller || !homeRoom.controller.my) return;
  if (!shouldPlaceRoads(homeRoom)) return;
  _syncEconomyConfig();

  var mem = _roomMem(homeRoom.name);
  if (!mem.remoteInfo) mem.remoteInfo = {};

  if (homeRoom.controller.level < 4) return;
  var active = null;
  if (cache && cache.remotesByHome && cache.remotesByHome[homeRoom.name]) {
    active = normalizeRemoteRooms(cache.remotesByHome[homeRoom.name]);
    _traceRoadCache(homeRoom.name, 'hintRemotes=' + active.length);
  } else {
    active = getActiveRemoteRooms(homeRoom);
  }
  if (!Array.isArray(active)) active = [];
  var minStorageEnergy = CONFIG.road.STORAGE_ENERGY_MIN_BEFORE_REMOTES;
  var roomMem = Memory.rooms && Memory.rooms[homeRoom.name];
  if (roomMem && roomMem.econ && roomMem.econ.remoteRoads && typeof roomMem.econ.remoteRoads.minStorageEnergy === 'number') {
    minStorageEnergy = roomMem.econ.remoteRoads.minStorageEnergy;
    _traceRoadCache(homeRoom.name, 'override=' + minStorageEnergy);
  }
  var storageEnergy = homeRoom.storage ? (homeRoom.storage.store[RESOURCE_ENERGY] | 0) : 0;
  if (!homeRoom.storage || storageEnergy < minStorageEnergy) {
    _logRemoteThrottle(homeRoom.name, storageEnergy, minStorageEnergy, active.length, CONFIG.road.MAX_ACTIVE_REMOTES, 'storage');
    return;
  }

  if (active.length >= CONFIG.road.MAX_ACTIVE_REMOTES) {
    _logRemoteThrottle(homeRoom.name, storageEnergy, minStorageEnergy, active.length, CONFIG.road.MAX_ACTIVE_REMOTES, 'limit');
    return;
  }

  var hub = computeHub(homeRoom);
  if (!hub) return;

  var flags = Game.flags;
  var candidates = [];
  for (var name in flags) {
    if (!hasOwn(flags, name)) continue;
    var flag = flags[name];
    if (!flag || flag.color !== COLOR_YELLOW || flag.secondaryColor !== COLOR_YELLOW) continue;
    if (safeLinearDistance(homeRoom.name, flag.pos.roomName) > CONFIG.road.MAX_ROOMS) continue;

    var key = homeRoom.name + ':remote:' + flag.pos.roomName + ':' + flag.pos.x + ',' + flag.pos.y;
    var cached = mem.paths[key];
    if (!cached || (Game.time - (cached.lastPlanned || 0)) > 1000) {
      var path = getOrCreatePath(hub, flag.pos, { label: key, range: 1 });
      if (!path) continue;
      cached = mem.paths[_cacheKey(hub, flag.pos, { label: key })];
    }
    if (!cached) continue;

    var info = {
      key: key,
      pathKey: _cacheKey(hub, flag.pos, { label: key }),
      flag: flag,
      length: cached.length || cached.path.length,
      swamp: cached.swamp || 0,
      hostile: false
    };
    candidates.push(info);
  }

  candidates.sort(function (a, b) {
    return _scoreRemote(a) - _scoreRemote(b);
  });

  var allowed = CONFIG.road.MAX_ACTIVE_REMOTES - active.length;
  if (allowed < 1) allowed = 1;

  for (var i = 0; i < candidates.length && allowed > 0; i++) {
    var cand = candidates[i];
    var pathRec = mem.paths[cand.pathKey];
    var candPath = pathRec && pathRec.path;
    if (!candPath || !candPath.length) {
      continue;
    }
    if (active.indexOf(cand.flag.pos.roomName) !== -1) {
      materializePath(candPath, { maxSites: 5, dirtyKey: cand.pathKey, roomName: homeRoom.name });
      _ensureRemoteContainer(cand.flag);
      continue;
    }
    materializePath(candPath, { maxSites: 5, dirtyKey: cand.pathKey, roomName: homeRoom.name });
    mem.remoteInfo[cand.flag.name] = {
      roomName: cand.flag.pos.roomName,
      sourceX: cand.flag.pos.x,
      sourceY: cand.flag.pos.y,
      key: cand.pathKey
    };
    _ensureRemoteContainer(cand.flag);
    allowed--;
  }
}

function _ensureRemoteContainer(flag) {
  if (!flag) return;
  var room = flag.room;
  if (!room) return;
  var terrain = room.getTerrain();
  var ring = [];
  for (var dx = -1; dx <= 1; dx++) {
    for (var dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      var x = flag.pos.x + dx;
      var y = flag.pos.y + dy;
      if (x <= 0 || x >= 49 || y <= 0 || y >= 49) continue;
      if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
      ring.push({ x: x, y: y, dx: dx, dy: dy });
    }
  }
  if (!ring.length) return;
  if (_ringHasContainer(room, ring)) return;

  var best = null;
  for (var r = 0; r < ring.length; r++) {
    var pos = ring[r];
    if (_isReservedTile(room, pos.x, pos.y)) continue;
    var structs = room.lookForAt(LOOK_STRUCTURES, pos.x, pos.y);
    var blocked = false;
    var hasRoad = false;
    for (var s = 0; s < structs.length; s++) {
      var st = structs[s];
      if (st.structureType === STRUCTURE_CONTAINER) return;
      if (st.structureType === STRUCTURE_ROAD) { hasRoad = true; continue; }
      if (st.structureType === STRUCTURE_RAMPART && st.my) continue;
      blocked = true;
      break;
    }
    if (blocked) continue;
    var sites = room.lookForAt(LOOK_CONSTRUCTION_SITES, pos.x, pos.y);
    var hasRoadSite = false;
    for (var c = 0; c < sites.length; c++) {
      var site = sites[c];
      if (site.structureType === STRUCTURE_CONTAINER) return;
      if (site.structureType === STRUCTURE_ROAD) { hasRoadSite = true; continue; }
      blocked = true;
      break;
    }
    if (blocked) continue;
    var score = Math.abs(pos.dx) + Math.abs(pos.dy);
    if (hasRoad || hasRoadSite) {
      score += 5;
    }
    if (!best || score < best.score) {
      best = { x: pos.x, y: pos.y, score: score };
    }
  }
  if (!best) return;
  var finalStructs = room.lookForAt(LOOK_STRUCTURES, best.x, best.y);
  for (var i2 = 0; i2 < finalStructs.length; i2++) {
    if (finalStructs[i2].structureType === STRUCTURE_CONTAINER) return;
    if (finalStructs[i2].structureType !== STRUCTURE_ROAD && finalStructs[i2].structureType !== STRUCTURE_RAMPART) return;
  }
  var finalSites = room.lookForAt(LOOK_CONSTRUCTION_SITES, best.x, best.y);
  for (var j2 = 0; j2 < finalSites.length; j2++) {
    if (finalSites[j2].structureType === STRUCTURE_CONTAINER) return;
    if (finalSites[j2].structureType !== STRUCTURE_ROAD) return;
  }
  room.createConstructionSite(best.x, best.y, STRUCTURE_CONTAINER);
}

function getActiveRemoteRooms(homeRoom) {
  if (!homeRoom) return [];
  var mem = _roomMem(homeRoom.name);
  var rooms = {};
  var keys = Object.keys(mem.paths);
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i];
    var labelIndex = key.indexOf('#');
    var label = labelIndex >= 0 ? key.substring(labelIndex + 1) : key;
    if (label.indexOf(homeRoom.name + ':remote:') !== 0) continue;
    var pathRec = mem.paths[key];
    if (!pathRec || !pathRec.path || !pathRec.path.length) continue;
    var last = pathRec.path[pathRec.path.length - 1];
    if (!last) continue;
    rooms[last.roomName] = true;
  }
  var list = [];
  for (var rn in rooms) {
    if (hasOwn(rooms, rn)) list.push(rn);
  }
  return list;
}

var _roomCacheTrace = global.__roomPlannerCacheTrace || (global.__roomPlannerCacheTrace = {});

function _traceRoomCache(roomName, info) {
  if (!Memory || Memory.__tracePlannerCache !== true) return;
  var key = roomName || 'unknown';
  var last = _roomCacheTrace[key] || 0;
  if (Game.time && (Game.time - last) < 100) return;
  _roomCacheTrace[key] = Game.time || 0;
  console.log('[PlannerCache] room=' + key + ' info=' + info);
}

function _logExtensionPlanning(room, info) {
  if (!isTraceEnabled('__traceExtensions')) return;
  if (!room || !info) return;
  var gates = info.gates || {};
  var text = 'EXT-PLAN ' + room.name;
  text += ' rcl=' + info.rcl;
  text += ' allowed=' + info.allowed;
  text += ' existing=' + info.existing;
  text += ' sites=' + info.sites;
  text += ' action=' + info.action;
  if (info.rc != null) {
    text += ' rc=' + info.rc;
  }
  text += ' gates=' + JSON.stringify(gates);
  console.log(text);
}

var HUB_STAMP = [
  { key: 'storage',      type: STRUCTURE_STORAGE,   dx: 0,  dy: 0,  rcl: 4, priority: 5 },
  { key: 'terminal',     type: STRUCTURE_TERMINAL,  dx: 1,  dy: 0,  rcl: 6, priority: 8 },
  { key: 'factory',      type: STRUCTURE_FACTORY,   dx: -1, dy: 0,  rcl: 7, priority: 9 },
  { key: 'powerSpawn',   type: STRUCTURE_POWER_SPAWN, dx: 0, dy: 1, rcl: 8, priority: 10 },
  { key: 'nuker',        type: STRUCTURE_NUKER,     dx: 1,  dy: 1,  rcl: 8, priority: 11 },
  { key: 'tower_core',   type: STRUCTURE_TOWER,     dx: 0,  dy: -2, rcl: 4, priority: 4 },
  { key: 'tower_west',   type: STRUCTURE_TOWER,     dx: -2, dy: -2, rcl: 6, priority: 7 },
  { key: 'lab_1',        type: STRUCTURE_LAB,       dx: 2,  dy: 1,  rcl: 6, priority: 12 },
  { key: 'lab_2',        type: STRUCTURE_LAB,       dx: 2,  dy: 2,  rcl: 6, priority: 12 },
  { key: 'lab_3',        type: STRUCTURE_LAB,       dx: 1,  dy: 2,  rcl: 6, priority: 12 },
  { key: 'observer',     type: STRUCTURE_OBSERVER,  dx: -2, dy: 2,  rcl: 8, priority: 13 }
];

var EXTENSION_BLOCKS = [
  { key: 'extA', rcl: 3, offsets: [
    {dx: 2, dy: 0}, {dx: -2, dy: 0}, {dx: 0, dy: 2}, {dx: 0, dy: -2}, {dx: 2, dy: 1},
    {dx: 1, dy: 2}, {dx: -1, dy: 2}, {dx: -2, dy: 1}, {dx: 2, dy: -1}, {dx: 1, dy: -2}
  ] },
  { key: 'extB', rcl: 4, offsets: [
    {dx: -1, dy: -2}, {dx: -2, dy: -1}, {dx: -2, dy: -2}, {dx: 3, dy: 0}, {dx: -3, dy: 0},
    {dx: 0, dy: 3}, {dx: 0, dy: -3}, {dx: 3, dy: 1}, {dx: 1, dy: 3}, {dx: -1, dy: 3}
  ] },
  { key: 'extC', rcl: 5, offsets: [
    {dx: -3, dy: -1}, {dx: -3, dy: 1}, {dx: 3, dy: -1}, {dx: 3, dy: 1}, {dx: 2, dy: 3},
    {dx: -2, dy: 3}, {dx: -3, dy: 2}, {dx: 3, dy: 2}, {dx: 2, dy: -3}, {dx: -2, dy: -3}
  ] },
  { key: 'extD', rcl: 6, offsets: [
    {dx: 4, dy: 0}, {dx: -4, dy: 0}, {dx: 4, dy: 1}, {dx: 4, dy: -1}, {dx: -4, dy: 1},
    {dx: -4, dy: -1}, {dx: 1, dy: 4}, {dx: -1, dy: 4}, {dx: 1, dy: -4}, {dx: -1, dy: -4}
  ] }
];

var HUB_ROAD_RING = [
  {dx: 0, dy: -1}, {dx: 1, dy: -1}, {dx: 1, dy: 0}, {dx: 1, dy: 1},
  {dx: 0, dy: 1}, {dx: -1, dy: 1}, {dx: -1, dy: 0}, {dx: -1, dy: -1}
];

if (!global.__ROOM_PLAN_CACHE) {
  global.__ROOM_PLAN_CACHE = { tick: -1, plans: {} };
}

function _apply(anchor, offset) {
  return new RoomPosition(anchor.x + offset.dx, anchor.y + offset.dy, anchor.roomName);
}

function _inBounds(pos) {
  return pos.x > 1 && pos.x < 48 && pos.y > 1 && pos.y < 48;
}

function _structureState(room) {
  var state = { built: {}, sites: {} };
  var structs = room.find(FIND_STRUCTURES);
  for (var i = 0; i < structs.length; i++) {
    var s = structs[i];
    if (!state.built[s.structureType]) state.built[s.structureType] = [];
    state.built[s.structureType].push(s.pos);
  }
  var sites = room.find(FIND_CONSTRUCTION_SITES);
  for (var j = 0; j < sites.length; j++) {
    var cs = sites[j];
    if (!state.sites[cs.structureType]) state.sites[cs.structureType] = [];
    state.sites[cs.structureType].push(cs.pos);
  }
  return state;
}

function _hasStructureOrSite(state, type, pos) {
  var arr = state.built[type] || [];
  for (var i = 0; i < arr.length; i++) {
    var p = arr[i];
    if (p.x === pos.x && p.y === pos.y && p.roomName === pos.roomName) return true;
  }
  arr = state.sites[type] || [];
  for (var j = 0; j < arr.length; j++) {
    var p2 = arr[j];
    if (p2.x === pos.x && p2.y === pos.y && p2.roomName === pos.roomName) return true;
  }
  return false;
}

function _hasRoad(room, state, pos) {
  var built = state.built[STRUCTURE_ROAD] || [];
  for (var i = 0; i < built.length; i++) {
    var p = built[i];
    if (p.x === pos.x && p.y === pos.y && p.roomName === pos.roomName) return true;
  }
  var sites = state.sites[STRUCTURE_ROAD] || [];
  for (var j = 0; j < sites.length; j++) {
    var ps = sites[j];
    if (ps.x === pos.x && ps.y === pos.y && ps.roomName === pos.roomName) return true;
  }
  return false;
}

function _planHubStructures(room, anchor) {
  var planned = [];
  for (var i = 0; i < HUB_STAMP.length; i++) {
    var entry = HUB_STAMP[i];
    var pos = _apply(anchor, entry);
    if (!_inBounds(pos)) continue;
    planned.push({
      key: entry.key,
      type: entry.type,
      pos: pos,
      rcl: entry.rcl,
      priority: entry.priority || 10,
      category: 'hub'
    });
  }
  return planned;
}

function _planExtensions(anchor) {
  var list = [];
  for (var i = 0; i < EXTENSION_BLOCKS.length; i++) {
    var block = EXTENSION_BLOCKS[i];
    for (var j = 0; j < block.offsets.length; j++) {
      var pos = _apply(anchor, block.offsets[j]);
      if (!_inBounds(pos)) continue;
      list.push({
        key: block.key + ':' + j,
        type: STRUCTURE_EXTENSION,
        pos: pos,
        rcl: block.rcl,
        priority: block.rcl,
        category: 'extension',
        group: block.key
      });
    }
  }
  return list;
}

function _chooseWalkable(room, center, preferList) {
  var terrain = room.getTerrain();
  var options = preferList || [];
  for (var i = 0; i < options.length; i++) {
    var off = options[i];
    var x = center.x + off.dx;
    var y = center.y + off.dy;
    if (x <= 0 || x >= 49 || y <= 0 || y >= 49) continue;
    if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
    return new RoomPosition(x, y, center.roomName);
  }
  for (var dx = -2; dx <= 2; dx++) {
    for (var dy = -2; dy <= 2; dy++) {
      if (dx === 0 && dy === 0) continue;
      var nx = center.x + dx;
      var ny = center.y + dy;
      if (nx <= 0 || nx >= 49 || ny <= 0 || ny >= 49) continue;
      if (terrain.get(nx, ny) === TERRAIN_MASK_WALL) continue;
      return new RoomPosition(nx, ny, center.roomName);
    }
  }
  return null;
}

function _planLinks(room, hubPos) {
  var list = [];
  var hubLink = _chooseWalkable(room, hubPos, [
    {dx: -1, dy: -1}, {dx: 1, dy: -1}, {dx: -1, dy: 1}, {dx: 1, dy: 1},
    {dx: 0, dy: -1}, {dx: 0, dy: 1}
  ]);
  if (hubLink) {
    list.push({
      key: 'link:hub',
      type: STRUCTURE_LINK,
      pos: hubLink,
      rcl: 5,
      priority: 6,
      category: 'link'
    });
  }

  if (room.controller) {
    var ctrlLink = _chooseWalkable(room, room.controller.pos, [
      {dx: 1, dy: 0}, {dx: -1, dy: 0}, {dx: 0, dy: 1}, {dx: 0, dy: -1},
      {dx: 1, dy: 1}, {dx: -1, dy: 1}, {dx: 1, dy: -1}, {dx: -1, dy: -1}
    ]);
    if (ctrlLink) {
      list.push({
        key: 'link:controller',
        type: STRUCTURE_LINK,
        pos: ctrlLink,
        rcl: 5,
        priority: 6,
        category: 'link'
      });
    }
  }
  return list;
}

function _planSourceContainers(room) {
  var list = [];
  var sources = room.find(FIND_SOURCES);
  var terrain = room.getTerrain();
  for (var i = 0; i < sources.length; i++) {
    var src = sources[i];
    var best = null;
    for (var dx = -1; dx <= 1; dx++) {
      for (var dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        var x = src.pos.x + dx;
        var y = src.pos.y + dy;
        if (x <= 0 || x >= 49 || y <= 0 || y >= 49) continue;
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
        var score = Math.abs(dx) + Math.abs(dy);
        if (!best || score < best.score) {
          best = { x: x, y: y, score: score };
        }
      }
    }
    if (!best) continue;
    list.push({
      key: 'src:' + src.id,
      type: STRUCTURE_CONTAINER,
      pos: new RoomPosition(best.x, best.y, room.name),
      rcl: 2,
      priority: 3,
      category: 'container',
      sourceId: src.id
    });
  }
  var minerals = room.find(FIND_MINERALS);
  if (minerals.length) {
    var min = minerals[0];
    var bestMin = null;
    for (var dx2 = -1; dx2 <= 1; dx2++) {
      for (var dy2 = -1; dy2 <= 1; dy2++) {
        if (dx2 === 0 && dy2 === 0) continue;
        var mx = min.pos.x + dx2;
        var my = min.pos.y + dy2;
        if (mx <= 0 || mx >= 49 || my <= 0 || my >= 49) continue;
        if (terrain.get(mx, my) === TERRAIN_MASK_WALL) continue;
        var scoreMin = Math.abs(dx2) + Math.abs(dy2);
        if (!bestMin || scoreMin < bestMin.score) {
          bestMin = { x: mx, y: my, score: scoreMin };
        }
      }
    }
    if (bestMin) {
      list.push({
        key: 'mineral:' + min.id,
        type: STRUCTURE_CONTAINER,
        pos: new RoomPosition(bestMin.x, bestMin.y, room.name),
        rcl: 5,
        priority: 7,
        category: 'container'
      });
    }
  }
  return list;
}

function _planControllerRing(room) {
  if (!room.controller) return [];
  var tiles = [];
  var ctrl = room.controller;
  for (var dx = -1; dx <= 1; dx++) {
    for (var dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      var x = ctrl.pos.x + dx;
      var y = ctrl.pos.y + dy;
      if (x <= 0 || x >= 49 || y <= 0 || y >= 49) continue;
      tiles.push({ x: x, y: y, roomName: room.name });
    }
  }
  return tiles;
}

function _missingRoadTiles(room, state, path, terrain) {
  var missing = [];
  for (var i = 0; i < path.length; i++) {
    var step = path[i];
    if (terrain.get(step.x, step.y) === TERRAIN_MASK_WALL) continue;
    if (!_hasRoad(room, state, step)) {
      missing.push(step);
    }
  }
  return missing;
}

function _planRoadGraph(room, hubPos, state) {
  var graph = {};
  var sources = room.find(FIND_SOURCES);
  var terrain = room.getTerrain();

  for (var i = 0; i < sources.length; i++) {
    var src = sources[i];
    var key = 'hub:source:' + src.id;
    var path = getOrCreatePath(hubPos, src.pos, { label: key, range: 1 });
    if (path && path.length) {
      graph[key] = {
        key: key,
        from: hubPos,
        to: src.pos,
        path: path,
        missing: _missingRoadTiles(room, state, path, terrain),
        category: 'critical'
      };
    }
  }

  if (room.controller) {
    var keyCtrl = 'hub:controller';
    var ctrlPath = getOrCreatePath(hubPos, room.controller.pos, { label: keyCtrl, range: 1 });
    if (ctrlPath && ctrlPath.length) {
      graph[keyCtrl] = {
        key: keyCtrl,
        from: hubPos,
        to: room.controller.pos,
        path: ctrlPath,
        missing: _missingRoadTiles(room, state, ctrlPath, terrain),
        category: 'critical'
      };
    }
  }

  var minerals = room.find(FIND_MINERALS);
  if (minerals.length) {
    var minKey = 'hub:mineral';
    var minPath = getOrCreatePath(hubPos, minerals[0].pos, { label: minKey, range: 1 });
    if (minPath && minPath.length) {
      graph[minKey] = {
        key: minKey,
        from: hubPos,
        to: minerals[0].pos,
        path: minPath,
        missing: _missingRoadTiles(room, state, minPath, terrain),
        category: 'support'
      };
    }
  }

  var hubRing = [];
  for (var r = 0; r < HUB_ROAD_RING.length; r++) {
    var rp = _apply(hubPos, HUB_ROAD_RING[r]);
    if (!_inBounds(rp)) continue;
    hubRing.push({ x: rp.x, y: rp.y, roomName: rp.roomName });
  }
  graph['hub:ring'] = {
    key: 'hub:ring',
    from: hubPos,
    to: hubPos,
    path: hubRing,
    missing: _missingRoadTiles(room, state, hubRing, terrain),
    category: 'hub'
  };

  return graph;
}

function _collectNeeds(structPlan, roadGraph, state, rcl) {
  var needs = [];
  for (var i = 0; i < structPlan.length; i++) {
    var task = structPlan[i];
    if (task.rcl > rcl) continue;
    if (_hasStructureOrSite(state, task.type, task.pos)) continue;
    needs.push(task);
  }
  for (var key in roadGraph) {
    if (!hasOwn(roadGraph, key)) continue;
    var edge = roadGraph[key];
    if (edge.category === 'critical' && rcl >= 2) {
      for (var j = 0; j < edge.missing.length; j++) {
        needs.push({
          key: key + ':road:' + j,
          type: STRUCTURE_ROAD,
          pos: edge.missing[j],
          rcl: 2,
          priority: 2,
          category: 'road'
        });
      }
    }
    if (edge.key === 'hub:ring' && rcl >= 4) {
      for (var k = 0; k < edge.missing.length; k++) {
        needs.push({
          key: key + ':road:' + k,
          type: STRUCTURE_ROAD,
          pos: edge.missing[k],
          rcl: 4,
          priority: 5,
          category: 'road'
        });
      }
    }
  }
  return needs;
}

function _readyForRemotes(structPlan, state) {
  var storageReady = false;
  var towerReady = false;
  var extBlockA = true;
  var extBlockB = true;
  for (var i = 0; i < structPlan.length; i++) {
    var task = structPlan[i];
    if (task.type === STRUCTURE_STORAGE) {
      if (_hasStructureOrSite(state, task.type, task.pos)) storageReady = true;
    }
    if (task.key && task.key.indexOf('tower') === 0 && task.rcl <= 4) {
      if (_hasStructureOrSite(state, task.type, task.pos)) towerReady = true;
    }
    if (task.group === 'extA') {
      if (!_hasStructureOrSite(state, task.type, task.pos)) extBlockA = false;
    }
    if (task.group === 'extB') {
      if (!_hasStructureOrSite(state, task.type, task.pos)) extBlockB = false;
    }
  }
  return storageReady && towerReady && extBlockA && extBlockB;
}

function plan(room) {
  if (!room || !room.controller || !room.controller.my) return null;
  var cache = global.__ROOM_PLAN_CACHE;
  if (cache.tick === Game.time && cache.plans[room.name]) {
    return cache.plans[room.name];
  }

  var hubPos = computeHub(room);
  if (!hubPos) return null;

  var state = _structureState(room);
  var hubStructs = _planHubStructures(room, hubPos);
  var extensions = _planExtensions(hubPos);
  var containers = _planSourceContainers(room);
  var links = _planLinks(room, hubPos);
  var structPlan = hubStructs.concat(extensions).concat(containers).concat(links);

  var roadGraph = _planRoadGraph(room, hubPos, state);
  var needsByRCL = {};
  var maxRCL = room.controller.level || 1;
  for (var r = 1; r <= maxRCL; r++) {
    needsByRCL[r] = _collectNeeds(structPlan, roadGraph, state, r);
  }

  var planRec = {
    roomName: room.name,
    anchor: hubPos,
    hub: hubPos,
    structures: structPlan,
    roads: roadGraph,
    needsByRCL: needsByRCL,
    readyForRemotes: _readyForRemotes(structPlan, state)
  };

  cache.tick = Game.time;
  cache.plans[room.name] = planRec;
  return planRec;
}

function _taskPriority(task) {
  if (!task) return 0;
  if (task.type === STRUCTURE_STORAGE) return 120;
  if (task.type === STRUCTURE_SPAWN) return 118;
  if (task.category === 'road') {
    return 1;
  }
  if (task.category === 'extension') {
    if (task.group === 'extA') return 114;
    if (task.group === 'extB') return 113;
    if (task.group === 'extC') return 111;
    if (task.group === 'extD') return 109;
    return 105;
  }
  if (task.type === STRUCTURE_TOWER) return 108;
  if (task.category === 'container') return 106;
  if (task.category === 'link') return 104;
  if (task.category === 'hub') return 80 - (task.priority || 0);
  return 10;
}

function ensureSites(room, cache) {
  if (!room || !room.controller || !room.controller.my) return;
  if (!cache) cache = null;
  var roomPlan = plan(room);
  if (!roomPlan) {
    if (isTraceEnabled('__traceExtensions')) {
      var currentLevel = room.controller.level || 1;
      var allowedIfAny = 0;
      if (typeof CONTROLLER_STRUCTURES === 'object' && CONTROLLER_STRUCTURES && CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION]) {
        allowedIfAny = CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION][currentLevel] || 0;
      }
      var builtCount = (room.find(FIND_MY_STRUCTURES, { filter: { structureType: STRUCTURE_EXTENSION } }) || []).length;
      var siteCount = (room.find(FIND_CONSTRUCTION_SITES, { filter: { structureType: STRUCTURE_EXTENSION } }) || []).length;
      _logExtensionPlanning(room, {
        rcl: currentLevel,
        allowed: allowedIfAny,
        existing: builtCount,
        sites: siteCount,
        action: 'skip-no-plan',
        rc: null,
        gates: { hasPlan: false }
      });
    }
    return;
  }

  var state = _structureState(room);
  var currentRCL = room.controller.level || 1;
  var extExisting = (state.built[STRUCTURE_EXTENSION] || []).length;
  var cachedExtSites = null;
  if (cache && cache.roomSiteCounts && typeof cache.roomSiteCounts[room.name] === 'number') {
    cachedExtSites = cache.roomSiteCounts[room.name] | 0;
    _traceRoomCache(room.name, 'extSitesHint=' + cachedExtSites);
  }
  var extSites = (state.sites[STRUCTURE_EXTENSION] || []).length;
  if (cachedExtSites != null && cachedExtSites > extSites) {
    extSites = cachedExtSites;
  }
  var extAllowed = 0;
  if (typeof CONTROLLER_STRUCTURES === 'object' && CONTROLLER_STRUCTURES && CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION]) {
    extAllowed = CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION][currentRCL] || 0;
  }
  var tasks = [];
  for (var r = 1; r <= currentRCL; r++) {
    var needList = roomPlan.needsByRCL[r] || [];
    for (var n = 0; n < needList.length; n++) {
      tasks.push(needList[n]);
    }
  }

  tasks.sort(function (a, b) {
    var pa = _taskPriority(a);
    var pb = _taskPriority(b);
    if (pa !== pb) return pb - pa;
    if (a.rcl !== b.rcl) return a.rcl - b.rcl;
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    return a.key < b.key ? -1 : 1;
  });

  var extensionTaskCount = 0;
  for (var pre = 0; pre < tasks.length; pre++) {
    if (tasks[pre].type === STRUCTURE_EXTENSION) {
      extensionTaskCount++;
    }
  }

  var placed = 0;
  var extensionLogs = 0;
  for (var i = 0; i < tasks.length && placed < CONFIG.room.MAX_SITES_PER_TICK; i++) {
    var task = tasks[i];
    var alreadyPresent = _hasStructureOrSite(state, task.type, task.pos);
    if (task.type === STRUCTURE_EXTENSION && isTraceEnabled('__traceExtensions')) {
      var gates = {
        hasPlan: true,
        hasAnchor: !!(roomPlan && roomPlan.anchor),
        tasksAvailable: extensionTaskCount > 0,
        underCap: (extExisting + extSites) < extAllowed,
        maxSitesAvailable: placed < CONFIG.room.MAX_SITES_PER_TICK,
        alreadyPresent: alreadyPresent
      };
      if (alreadyPresent) {
        _logExtensionPlanning(room, {
          rcl: currentRCL,
          allowed: extAllowed,
          existing: extExisting,
          sites: extSites,
          action: 'skip-existing',
          rc: null,
          gates: gates
        });
        extensionLogs++;
      }
    }
    if (alreadyPresent) continue;
    if (task.type === STRUCTURE_ROAD) {
      if (!shouldPlaceRoads(room)) {
        continue;
      }
      var stubPath = [];
      if (task.pos) {
        stubPath.push({ x: task.pos.x, y: task.pos.y, roomName: task.pos.roomName });
      }
      if (stubPath.length) {
        var created = materializePath(stubPath, { maxSites: 1, dirtyKey: task.key, roomName: room.name });
        if (created > 0) {
          placed += created;
        }
      }
      continue;
    }
    var rc = room.createConstructionSite(task.pos.x, task.pos.y, task.type);
    if (rc === OK) {
      placed++;
      if (task.type === STRUCTURE_EXTENSION) {
        extSites++;
      }
    }
    if (task.type === STRUCTURE_EXTENSION && isTraceEnabled('__traceExtensions')) {
      var gatesAfter = {
        hasPlan: true,
        hasAnchor: !!(roomPlan && roomPlan.anchor),
        tasksAvailable: extensionTaskCount > 0,
        underCap: (extExisting + extSites) < extAllowed,
        maxSitesAvailable: placed < CONFIG.room.MAX_SITES_PER_TICK,
        alreadyPresent: false
      };
      _logExtensionPlanning(room, {
        rcl: currentRCL,
        allowed: extAllowed,
        existing: extExisting,
        sites: extSites,
        action: 'attempt',
        rc: rc,
        gates: gatesAfter
      });
      extensionLogs++;
    }
  }

  if (isTraceEnabled('__traceExtensions')) {
    if (extensionTaskCount === 0 && extAllowed > 0) {
      _logExtensionPlanning(room, {
        rcl: currentRCL,
        allowed: extAllowed,
        existing: extExisting,
        sites: extSites,
        action: 'skip-no-extension-tasks',
        rc: null,
        gates: {
          hasPlan: true,
          hasAnchor: !!(roomPlan && roomPlan.anchor),
          tasksAvailable: false,
          underCap: (extExisting + extSites) < extAllowed,
          maxSitesAvailable: placed < CONFIG.room.MAX_SITES_PER_TICK
        }
      });
    } else if (extensionTaskCount > 0 && extensionLogs === 0) {
      _logExtensionPlanning(room, {
        rcl: currentRCL,
        allowed: extAllowed,
        existing: extExisting,
        sites: extSites,
        action: 'skip-max-sites-preempted',
        rc: null,
        gates: {
          hasPlan: true,
          hasAnchor: !!(roomPlan && roomPlan.anchor),
          tasksAvailable: true,
          underCap: (extExisting + extSites) < extAllowed,
          maxSitesAvailable: false
        }
      });
    }
  }
}

BuilderPlanner.ensureSites = ensureSites;
BuilderPlanner.plan = plan;
BuilderPlanner.ensureRemoteRoads = ensureRemoteRoads;
BuilderPlanner.getActiveRemoteRooms = getActiveRemoteRooms;
BuilderPlanner.computeHub = computeHub;
BuilderPlanner.getOrCreatePath = getOrCreatePath;
BuilderPlanner.materializePath = materializePath;
BuilderPlanner._ensureRemoteContainer = _ensureRemoteContainer;

module.exports = BuilderPlanner;
