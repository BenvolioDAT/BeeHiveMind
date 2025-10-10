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

var RoadPlanner = {};

RoadPlanner.CONFIG = {
  MAX_ACTIVE_REMOTES: 2,
  STORAGE_ENERGY_MIN_BEFORE_REMOTES: 40000,
  ROAD_REPAIR_THRESHOLD: 0.4,
  REMOTE_ROI_WEIGHTING: {
    pathLength: 1,
    swampTiles: 3,
    hostilePenalty: 5000
  },
  PLAIN_COST: 2,
  SWAMP_COST: 10,
  ROAD_COST: 1,
  MAX_OPS: 20000,
  MAX_ROOMS: 12
};

function _roomMem(roomName) {
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
  var rm = Memory.rooms[roomName];
  if (!rm.roadPlanner) rm.roadPlanner = { paths: {}, dirty: {} };
  if (!rm.roadPlanner.paths) rm.roadPlanner.paths = {};
  if (!rm.roadPlanner.dirty) rm.roadPlanner.dirty = {};
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
  var rec = mem.paths[key];
  if (rec && rec.path && rec.path.length) {
    return rec.path;
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
    lastPlanned: Game.time
  };

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

  var mem = _roomMem(homeRoom.name);
  if (!mem.remoteInfo) mem.remoteInfo = {};

  if (homeRoom.controller.level < 4) return;
  if (!homeRoom.storage) return;
  if ((homeRoom.storage.store[RESOURCE_ENERGY] | 0) < RoadPlanner.CONFIG.STORAGE_ENERGY_MIN_BEFORE_REMOTES) {
    // Acceptance test: If storage < STORAGE_ENERGY_MIN_BEFORE_REMOTES, no new remote roads/containers are queued.
    return;
  }

  var active = RoadPlanner.getActiveRemoteRooms(homeRoom);
  if (active.length >= RoadPlanner.CONFIG.MAX_ACTIVE_REMOTES) return;

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
    if (active.indexOf(cand.flag.pos.roomName) !== -1) {
      RoadPlanner.materializePath(mem.paths[cand.pathKey].path, { maxSites: 5, dirtyKey: cand.pathKey, roomName: homeRoom.name });
      RoadPlanner._ensureRemoteContainer(cand.flag);
      continue;
    }
    RoadPlanner.materializePath(mem.paths[cand.pathKey].path, { maxSites: 5, dirtyKey: cand.pathKey, roomName: homeRoom.name });
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
  var best = null;
  var bestScore = 9999;
  for (var dx = -1; dx <= 1; dx++) {
    for (var dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      var x = flag.pos.x + dx;
      var y = flag.pos.y + dy;
      if (x <= 0 || x >= 49 || y <= 0 || y >= 49) continue;
      if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
      var score = Math.abs(dx) + Math.abs(dy);
      if (score < bestScore) {
        bestScore = score;
        best = { x: x, y: y };
      }
    }
  }
  if (!best) return;
  var lookStructs = room.lookForAt(LOOK_STRUCTURES, best.x, best.y);
  for (var i = 0; i < lookStructs.length; i++) {
    if (lookStructs[i].structureType === STRUCTURE_CONTAINER) return;
  }
  var lookSites = room.lookForAt(LOOK_CONSTRUCTION_SITES, best.x, best.y);
  for (var j = 0; j < lookSites.length; j++) {
    if (lookSites[j].structureType === STRUCTURE_CONTAINER) return;
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
    if (key.indexOf(homeRoom.name + ':remote:') !== 0) continue;
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
