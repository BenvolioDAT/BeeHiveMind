// Design Notes:
// - Provides deterministic road planning helpers shared by room and remote planners.
// - Exposes computeHub(), getOrCreatePath(), materializePath(), ensureRemoteRoads(),
//   and getActiveRemoteRooms() so other modules can rely on a single road graph.
// - Paths are cached in Memory.rooms[room].roadPlanner.paths keyed by logical names to
//   keep re-planning cheap and idempotent. materializePath() only queues construction
//   sites for missing tiles so repeated runs never spam sites.
// - Remote planning honours throttles (MAX_ACTIVE_REMOTES, STORAGE_ENERGY_MIN_BEFORE_REMOTES)
//   and scores candidates by round-trip path length plus swamp penalties.
// - Road repairs hook: when a tile is missing or below ROAD_REPAIR_THRESHOLD, the edge is
//   marked "dirty" so higher level repair logic can react.

'use strict';

var BeeToolbox = require('BeeToolbox');
var Logger = require('core.logger');
var LOG_LEVEL = Logger.LOG_LEVEL;
var roadLog = Logger.createLogger('RoadPlanner', LOG_LEVEL.BASIC);

BeeToolbox.registerEconomyOverrides('RoadPlannerLegacy', {
  STORAGE_ENERGY_MIN_BEFORE_REMOTES: 40000,
  MAX_ACTIVE_REMOTES: 2,
  ROAD_REPAIR_THRESHOLD: 0.4
});

var RoadPlanner = {};

RoadPlanner.CONFIG = {
  MAX_ACTIVE_REMOTES: BeeToolbox.ECON_CFG.MAX_ACTIVE_REMOTES,
  STORAGE_ENERGY_MIN_BEFORE_REMOTES: BeeToolbox.ECON_CFG.STORAGE_ENERGY_MIN_BEFORE_REMOTES,
  ROAD_REPAIR_THRESHOLD: BeeToolbox.ECON_CFG.ROAD_REPAIR_THRESHOLD,
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
};

function _syncEconomyConfig() {
  var cfg = BeeToolbox.ECON_CFG;
  RoadPlanner.CONFIG.MAX_ACTIVE_REMOTES = cfg.MAX_ACTIVE_REMOTES;
  RoadPlanner.CONFIG.STORAGE_ENERGY_MIN_BEFORE_REMOTES = cfg.STORAGE_ENERGY_MIN_BEFORE_REMOTES;
  RoadPlanner.CONFIG.ROAD_REPAIR_THRESHOLD = cfg.ROAD_REPAIR_THRESHOLD;
}
_syncEconomyConfig();

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
      costs.set(s.pos.x, s.pos.y, RoadPlanner.CONFIG.ROAD_COST);
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

function _shouldLogThrottle(roomName, reason) {
  if (!roomName) return false;
  Memory._remoteThrottleLog = Memory._remoteThrottleLog || {};
  var rec = Memory._remoteThrottleLog[roomName];
  if (!rec) {
    rec = {};
    Memory._remoteThrottleLog[roomName] = rec;
  }
  var key = reason || 'generic';
  var last = rec[key] || 0;
  if ((Game.time || 0) - last < RoadPlanner.CONFIG.THROTTLE_LOG_INTERVAL) return false;
  rec[key] = Game.time || 0;
  Memory._remoteThrottleLog[roomName] = rec;
  return true;
}

function _logRemoteThrottle(roomName, storage, threshold, active, max, reason) {
  if (!_shouldLogThrottle(roomName, reason)) return;
  var text = '[Remotes] Skipped planning: storage=' + storage + '/threshold=' + threshold;
  text += ', active=' + active + '/max=' + max;
  text += ', reason=' + reason + ', room=' + roomName;
  roadLog.info(text);
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
    if (BeeToolbox.isObject(mem.reservedTiles) && mem.reservedTiles[key]) return true;
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

RoadPlanner.computeHub = function (room) {
  if (!room) return null;
  if (room.storage) return room.storage.pos;
  var spawns = room.find(FIND_MY_SPAWNS);
  if (spawns && spawns.length) return spawns[0].pos;
  if (room.controller && room.controller.my) return room.controller.pos;
  return new RoomPosition(25, 25, room.name);
};

RoadPlanner.getOrCreatePath = function (fromPos, toPos, opts) {
  if (!fromPos || !toPos) return null;
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
        rec.expires = (rec.lastPlanned || 0) + RoadPlanner.CONFIG.PATH_CACHE_TTL;
      }
      if (mem.dirty[key] && mem.dirty[key] > (rec.lastPlanned || 0)) {
        needsRecalc = true;
      }
      if (!needsRecalc && rec.expires <= now) {
        needsRecalc = true;
      }
      if (!needsRecalc && vision) {
        if (rec.lastVision && vision.lastSeen && (vision.lastSeen - rec.lastVision) > RoadPlanner.CONFIG.VISION_DIRTY_DELTA) {
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
      if (now - (rec.lastPlanned || 0) < RoadPlanner.CONFIG.NULL_RETRY_TTL) {
        return null;
      }
      needsRecalc = true;
    } else {
      needsRecalc = true;
    }
  }

  var searchOpts = {
    maxOps: RoadPlanner.CONFIG.MAX_OPS,
    maxRooms: RoadPlanner.CONFIG.MAX_ROOMS,
    plainCost: RoadPlanner.CONFIG.PLAIN_COST,
    swampCost: RoadPlanner.CONFIG.SWAMP_COST,
    roomCallback: function (rn) {
      return _getCostMatrix(rn, opts);
    }
  };

  var result = PathFinder.search(fromPos, { pos: toPos, range: opts && opts.range ? opts.range : 1 }, searchOpts);
  if (result.incomplete || !result.path || !result.path.length) {
    mem.paths[key] = {
      nullResult: true,
      lastPlanned: now,
      expires: now + RoadPlanner.CONFIG.NULL_RETRY_TTL,
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
    expires: now + RoadPlanner.CONFIG.PATH_CACHE_TTL,
    lastVision: vision ? vision.lastSeen : null,
    obstacleSignature: vision ? vision.obstacleSignature : null,
    nullResult: false
  };
  if (mem.dirty[key]) delete mem.dirty[key];

  return mem.paths[key].path;
};

RoadPlanner.materializePath = function (path, opts) {
  if (!path || !path.length) return 0;
  var placed = 0;
  var throttle = opts && opts.maxSites ? opts.maxSites : 3;
  var dirtyKey = opts && opts.dirtyKey ? opts.dirtyKey : null;
  var dirtyRoom = opts && opts.roomName ? opts.roomName : (path[0] ? path[0].roomName : null);

  for (var i = 0; i < path.length && placed < throttle; i++) {
    var step = path[i];
    var room = Game.rooms[step.roomName];
    if (!room) continue;
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

    if (room.createConstructionSite(step.x, step.y, STRUCTURE_ROAD) === OK) {
      placed++;
    }
  }

  if (dirtyKey && dirtyRoom && placed > 0) {
    var mem = _roomMem(dirtyRoom);
    mem.dirty[dirtyKey] = Game.time;
  }

  return placed;
};

RoadPlanner._scoreRemote = function (rec) {
  if (!rec) return Infinity;
  var cfg = RoadPlanner.CONFIG.REMOTE_ROI_WEIGHTING;
  var score = (rec.length || 999) * (cfg.pathLength || 1);
  score += (rec.swamp || 0) * (cfg.swampTiles || 0);
  if (rec.hostile) score += cfg.hostilePenalty || 0;
  return score;
};

RoadPlanner.ensureRemoteRoads = function (homeRoom) {
  if (!homeRoom || !homeRoom.controller || !homeRoom.controller.my) return;
  _syncEconomyConfig();

  var mem = _roomMem(homeRoom.name);
  if (!mem.remoteInfo) mem.remoteInfo = {};

  if (homeRoom.controller.level < 4) return;
  var active = RoadPlanner.getActiveRemoteRooms(homeRoom);
  var storageEnergy = homeRoom.storage ? (homeRoom.storage.store[RESOURCE_ENERGY] | 0) : 0;
  if (!homeRoom.storage || storageEnergy < RoadPlanner.CONFIG.STORAGE_ENERGY_MIN_BEFORE_REMOTES) {
    _logRemoteThrottle(homeRoom.name, storageEnergy, RoadPlanner.CONFIG.STORAGE_ENERGY_MIN_BEFORE_REMOTES, active.length, RoadPlanner.CONFIG.MAX_ACTIVE_REMOTES, 'storage');
    return;
  }

  if (active.length >= RoadPlanner.CONFIG.MAX_ACTIVE_REMOTES) {
    _logRemoteThrottle(homeRoom.name, storageEnergy, RoadPlanner.CONFIG.STORAGE_ENERGY_MIN_BEFORE_REMOTES, active.length, RoadPlanner.CONFIG.MAX_ACTIVE_REMOTES, 'limit');
    return;
  }

  var hub = RoadPlanner.computeHub(homeRoom);
  if (!hub) return;

  var flags = Game.flags;
  var candidates = [];
  for (var name in flags) {
    if (!BeeToolbox.hasOwn(flags, name)) continue;
    var flag = flags[name];
    if (!flag || flag.color !== COLOR_YELLOW || flag.secondaryColor !== COLOR_YELLOW) continue;
    if (BeeToolbox.safeLinearDistance(homeRoom.name, flag.pos.roomName) > RoadPlanner.CONFIG.MAX_ROOMS) continue;

    var key = homeRoom.name + ':remote:' + flag.pos.roomName + ':' + flag.pos.x + ',' + flag.pos.y;
    var cached = mem.paths[key];
    if (!cached || (Game.time - (cached.lastPlanned || 0)) > 1000) {
      var path = RoadPlanner.getOrCreatePath(hub, flag.pos, { label: key, range: 1 });
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
    return RoadPlanner._scoreRemote(a) - RoadPlanner._scoreRemote(b);
  });

  var allowed = RoadPlanner.CONFIG.MAX_ACTIVE_REMOTES - active.length;
  if (allowed < 1) allowed = 1;

  for (var i = 0; i < candidates.length && allowed > 0; i++) {
    var cand = candidates[i];
    // Acceptance test: For N candidate remote flags, select the best ROI paths up to MAX_ACTIVE_REMOTES.
    var pathRec = mem.paths[cand.pathKey];
    var candPath = pathRec && pathRec.path;
    if (!candPath || !candPath.length) {
      continue;
    }
    if (active.indexOf(cand.flag.pos.roomName) !== -1) {
      RoadPlanner.materializePath(candPath, { maxSites: 5, dirtyKey: cand.pathKey, roomName: homeRoom.name });
      RoadPlanner._ensureRemoteContainer(cand.flag);
      continue;
    }
    RoadPlanner.materializePath(candPath, { maxSites: 5, dirtyKey: cand.pathKey, roomName: homeRoom.name });
    mem.remoteInfo[cand.flag.name] = {
      roomName: cand.flag.pos.roomName,
      sourceX: cand.flag.pos.x,
      sourceY: cand.flag.pos.y,
      key: cand.pathKey
    };
    RoadPlanner._ensureRemoteContainer(cand.flag);
    allowed--;
  }
};

RoadPlanner._ensureRemoteContainer = function (flag) {
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
};

RoadPlanner.getActiveRemoteRooms = function (homeRoom) {
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
    if (BeeToolbox.hasOwn(rooms, rn)) list.push(rn);
  }
  return list;
};

module.exports = RoadPlanner;
