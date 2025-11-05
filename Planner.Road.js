'use strict';

/**
 * What changed & why:
 * - Converted to ES5 syntax, added cadence cooldowns, and retained Harabi-style staged road planning.
 * - Keeps remote paths drip-fed with small batches and surfaces visuals/light radius pruning to avoid CPU spikes.
 */

var CFG = Object.freeze({
  plainCost: 2,
  swampCost: 10,
  roadCost: 1,
  maxRoomsPlanning: 4,
  maxOpsPlanning: 20000,
  placeBudgetPerTick: 3,
  globalCSiteSafetyLimit: 3,
  plannerTickModulo: 3,
  auditInterval: 100,
  randomAuditChance: 0.01,
  includeControllerSpoke: true,
  maxRemoteRadius: 1,
  cooldownPlaced: 5,
  cooldownNone: 20
});

function currentTick() { return Game.time; }

if (!global.__RPM) {
  global.__RPM = {
    csiteCountTick: -1,
    csiteCount: 0,
    cmTick: -1,
    cm: {},
    remoteTick: -1,
    remotes: []
  };
}

function getCSiteCountOnce() {
  if (global.__RPM.csiteCountTick === currentTick()) return global.__RPM.csiteCount;
  global.__RPM.csiteCountTick = currentTick();
  global.__RPM.csiteCount = Object.keys(Game.constructionSites).length;
  return global.__RPM.csiteCount;
}

function activeRemotesOncePerTick() {
  if (global.__RPM.remoteTick === currentTick()) return global.__RPM.remotes;
  var set = {};
  var name;
  for (name in Game.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Game.creeps, name)) continue;
    var c = Game.creeps[name];
    if (c && c.memory && c.memory.task === 'luna' && c.memory.targetRoom) {
      set[c.memory.targetRoom] = true;
    }
  }
  var out = [];
  for (name in set) if (Object.prototype.hasOwnProperty.call(set, name)) out.push(name);
  global.__RPM.remotes = out;
  global.__RPM.remoteTick = currentTick();
  return global.__RPM.remotes;
}

function hasRoadOrRoadSiteFast(room, x, y) {
  var sArr = room.lookForAt(LOOK_STRUCTURES, x, y);
  for (var i = 0; i < sArr.length; i++) {
    if (sArr[i].structureType === STRUCTURE_ROAD) return true;
  }
  var siteArr = room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y);
  for (var j = 0; j < siteArr.length; j++) {
    if (siteArr[j].structureType === STRUCTURE_ROAD) return true;
  }
  return false;
}

var RoadPlanner = {
  ensureRemoteRoads: function (homeRoom) {
    if (!homeRoom || !homeRoom.controller || !homeRoom.controller.my) return;
    if (CFG.plannerTickModulo > 1) {
      var hash = 0;
      for (var idx = 0; idx < homeRoom.name.length; idx++) hash = (hash * 31 + homeRoom.name.charCodeAt(idx)) | 0;
      if (((currentTick() + (hash & 3)) % CFG.plannerTickModulo) !== 0) return;
    }
    var mem = this._memory(homeRoom);
    if (mem.nextTick && currentTick() < mem.nextTick) return;
    this._pruneOutOfRadiusPaths(homeRoom, mem);
    var spawns = homeRoom.find(FIND_MY_SPAWNS);
    if (!spawns.length && !homeRoom.storage) return;
    var placements = 0;
    placements += this._ensureStagedHomeNetwork(homeRoom);
    var activeRemotes = activeRemotesOncePerTick();
    for (var r = 0; r < activeRemotes.length; r++) {
      var remoteName = activeRemotes[r];
      if (CFG.maxRemoteRadius > 0) {
        var dist = Game.map.getRoomLinearDistance(homeRoom.name, remoteName);
        if (dist > CFG.maxRemoteRadius) continue;
      }
      var remoteRoom = Game.rooms[remoteName];
      if (!remoteRoom) continue;
      var sources = remoteRoom.find(FIND_SOURCES);
      for (var s = 0; s < sources.length; s++) {
        var src = sources[s];
        var key = remoteName + ':' + src.id;
        if (!mem.paths[key]) {
          var harvestPos = this._chooseHarvestTile(src);
          var goal = harvestPos ? { pos: harvestPos, range: 0 } : { pos: src.pos, range: 1 };
          var search = PathFinder.search(this._getAnchorPos(homeRoom), goal, {
            plainCost: CFG.plainCost,
            swampCost: CFG.swampCost,
            maxRooms: CFG.maxRoomsPlanning,
            maxOps: CFG.maxOpsPlanning,
            roomCallback: this._roomCostMatrix
          });
          if (!search.path || !search.path.length || search.incomplete) continue;
          var storedPath = [];
          for (var p = 0; p < search.path.length; p++) {
            var step = search.path[p];
            storedPath.push({ x: step.x, y: step.y, roomName: step.roomName });
          }
          mem.paths[key] = { i: 0, done: false, path: storedPath };
        }
        placements += this._dripPlaceAlongPath(homeRoom, key, CFG.placeBudgetPerTick);
        placements += this._auditAndRelaunch(homeRoom, key, 1);
      }
    }
    if (placements > 0) mem.nextTick = currentTick() + CFG.cooldownPlaced;
    else mem.nextTick = currentTick() + CFG.cooldownNone;
  },

  _getAnchorPos: function (homeRoom) {
    if (homeRoom.storage) return homeRoom.storage.pos;
    var spawns = homeRoom.find(FIND_MY_SPAWNS);
    return spawns.length ? spawns[0].pos : null;
  },

  _planTrackPlaceAudit: function (homeRoom, fromPos, goalPos, key, range) {
    if (!fromPos || !goalPos) return 0;
    var mem = this._memory(homeRoom);
    if (!mem.paths[key]) {
      var search = PathFinder.search(fromPos, { pos: goalPos, range: range }, {
        plainCost: CFG.plainCost,
        swampCost: CFG.swampCost,
        maxRooms: CFG.maxRoomsPlanning,
        maxOps: CFG.maxOpsPlanning,
        roomCallback: this._roomCostMatrix
      });
      if (!search.path || !search.path.length || search.incomplete) return 0;
      var storedPath = [];
      for (var p = 0; p < search.path.length; p++) {
        var step = search.path[p];
        storedPath.push({ x: step.x, y: step.y, roomName: step.roomName });
      }
      mem.paths[key] = { i: 0, done: false, path: storedPath };
    }
    var placed = this._dripPlaceAlongPath(homeRoom, key, CFG.placeBudgetPerTick);
    placed += this._auditAndRelaunch(homeRoom, key, 1);
    return placed;
  },

  _ensureStagedHomeNetwork: function (homeRoom) {
    var anchor = this._getAnchorPos(homeRoom);
    if (!anchor) return 0;
    var placed = 0;
    if (homeRoom.visual) {
      try { homeRoom.visual.circle(anchor, { radius: 1.2, stroke: '#00ffaa', opacity: 0.2 }); } catch (e) {}
    }
    var sources = homeRoom.find(FIND_SOURCES);
    for (var i = 0; i < sources.length; i++) {
      var src = sources[i];
      var harv = this._chooseHarvestTile(src) || src.pos;
      var range = (harv === src.pos) ? 1 : 0;
      var stage = homeRoom.storage ? 'storage' : 'spawn';
      var key = homeRoom.name + ':LOCAL:source' + i + ':from=' + stage;
      placed += this._planTrackPlaceAudit(homeRoom, anchor, harv, key, range);
    }
    if (CFG.includeControllerSpoke && homeRoom.controller) {
      var stageC = homeRoom.storage ? 'storage' : 'spawn';
      var keyC = homeRoom.name + ':LOCAL:controller:from=' + stageC;
      placed += this._planTrackPlaceAudit(homeRoom, anchor, homeRoom.controller.pos, keyC, 1);
    }
    if (homeRoom.storage) {
      var spawnList = homeRoom.find(FIND_MY_SPAWNS);
      if (spawnList.length) {
        var keyS = homeRoom.name + ':LOCAL:spawn0-to-storage';
        placed += this._planTrackPlaceAudit(homeRoom, spawnList[0].pos, homeRoom.storage.pos, keyS, 1);
      }
    }
    return placed;
  },

  _dripPlaceAlongPath: function (homeRoom, key, budget) {
    if (getCSiteCountOnce() > CFG.globalCSiteSafetyLimit) return 0;
    var mem = this._memory(homeRoom);
    var rec = mem.paths[key];
    if (!rec || rec.done) return 0;
    var placed = 0;
    var attempts = 0;
    while (rec.i < rec.path.length && placed < budget) {
      attempts++;
      if (attempts > budget + 10) break;
      var step = rec.path[rec.i];
      var roomObj = Game.rooms[step.roomName];
      if (!roomObj) break;
      if (roomObj.getTerrain().get(step.x, step.y) !== TERRAIN_MASK_WALL) {
        if (!hasRoadOrRoadSiteFast(roomObj, step.x, step.y)) {
          var rc = roomObj.createConstructionSite(step.x, step.y, STRUCTURE_ROAD);
          if (rc === OK) {
            placed++;
            if (getCSiteCountOnce() > CFG.globalCSiteSafetyLimit) break;
          } else if (rc === ERR_FULL) {
            break;
          }
        }
      }
      rec.i++;
    }
    if (rec.i >= rec.path.length) rec.done = true;
    return placed;
  },

  _auditAndRelaunch: function (homeRoom, key, maxFixes) {
    var mem = this._memory(homeRoom);
    var rec = mem.paths[key];
    if (!rec || !rec.done || !rec.path || !rec.path.length) return 0;
    var onInterval = (currentTick() % CFG.auditInterval) === 0;
    var randomTick = Math.random() < CFG.randomAuditChance;
    if (!onInterval && !randomTick) return 0;
    var fixed = 0;
    for (var idx = 0; idx < rec.path.length && fixed < maxFixes; idx++) {
      var step = rec.path[idx];
      var roomObj = Game.rooms[step.roomName];
      if (!roomObj) continue;
      if (roomObj.getTerrain().get(step.x, step.y) === TERRAIN_MASK_WALL) continue;
      if (!hasRoadOrRoadSiteFast(roomObj, step.x, step.y)) {
        var rc = roomObj.createConstructionSite(step.x, step.y, STRUCTURE_ROAD);
        if (rc === OK) {
          if (typeof rec.i !== 'number' || rec.i > idx) rec.i = idx;
          rec.done = false;
          fixed++;
          if (getCSiteCountOnce() > CFG.globalCSiteSafetyLimit) break;
        } else if (rc === ERR_FULL) {
          break;
        }
      }
    }
    return fixed;
  },

  _roomCostMatrix: function (roomName) {
    var room = Game.rooms[roomName];
    if (!room) return;
    if (global.__RPM.cmTick !== currentTick()) {
      global.__RPM.cmTick = currentTick();
      global.__RPM.cm = {};
    }
    if (global.__RPM.cm[roomName]) return global.__RPM.cm[roomName];
    var costs = new PathFinder.CostMatrix();
    var structs = room.find(FIND_STRUCTURES);
    for (var i = 0; i < structs.length; i++) {
      var s = structs[i];
      if (s.structureType === STRUCTURE_ROAD) {
        costs.set(s.pos.x, s.pos.y, CFG.roadCost);
      } else if (s.structureType !== STRUCTURE_CONTAINER && (s.structureType !== STRUCTURE_RAMPART || !s.my)) {
        costs.set(s.pos.x, s.pos.y, 0xff);
      }
    }
    var sites = room.find(FIND_CONSTRUCTION_SITES);
    for (var j = 0; j < sites.length; j++) {
      var cs = sites[j];
      if (cs.structureType !== STRUCTURE_ROAD) costs.set(cs.pos.x, cs.pos.y, 0xff);
    }
    var sources = room.find(FIND_SOURCES);
    for (var k = 0; k < sources.length; k++) costs.set(sources[k].pos.x, sources[k].pos.y, 0xff);
    var minerals = room.find(FIND_MINERALS);
    for (var m = 0; m < minerals.length; m++) costs.set(minerals[m].pos.x, minerals[m].pos.y, 0xff);
    global.__RPM.cm[roomName] = costs;
    return costs;
  },

  _memory: function (homeRoom) {
    if (!Memory.rooms) Memory.rooms = {};
    if (!Memory.rooms[homeRoom.name]) Memory.rooms[homeRoom.name] = {};
    var r = Memory.rooms[homeRoom.name];
    if (!r.roadPlanner) r.roadPlanner = { paths: {} };
    if (!r.roadPlanner.paths) r.roadPlanner.paths = {};
    return r.roadPlanner;
  },

  getActiveRemoteRooms: function (homeRoom) {
    var mem = this._memory(homeRoom);
    var rooms = {};
    var key;
    for (key in mem.paths) {
      if (!Object.prototype.hasOwnProperty.call(mem.paths, key)) continue;
      rooms[key.split(':')[0]] = true;
    }
    var list = [];
    for (key in rooms) if (Object.prototype.hasOwnProperty.call(rooms, key)) list.push(key);
    return list;
  },

  _pruneOutOfRadiusPaths: function (homeRoom, mem) {
    if (!mem || !mem.paths) return;
    if (CFG.maxRemoteRadius <= 0) return;
    var home = homeRoom.name;
    for (var key in mem.paths) {
      if (!Object.prototype.hasOwnProperty.call(mem.paths, key)) continue;
      var prefix = key.split(':')[0];
      if (!prefix || prefix === home || prefix === 'LOCAL') continue;
      var dist = Game.map.getRoomLinearDistance(home, prefix);
      if (dist > CFG.maxRemoteRadius) delete mem.paths[key];
    }
  },

  _chooseHarvestTile: function (src) {
    var room = Game.rooms[src.pos.roomName];
    if (!room) return null;
    var terrain = room.getTerrain();
    var dx, dy;
    for (dx = -1; dx <= 1; dx++) {
      for (dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        var x = src.pos.x + dx;
        var y = src.pos.y + dy;
        if (x <= 0 || x >= 49 || y <= 0 || y >= 49) continue;
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
        var structs = room.lookForAt(LOOK_STRUCTURES, x, y);
        for (var i = 0; i < structs.length; i++) {
          if (structs[i].structureType === STRUCTURE_CONTAINER) return new RoomPosition(x, y, room.name);
        }
      }
    }
    var best = null;
    var bestScore = -Infinity;
    for (dx = -1; dx <= 1; dx++) {
      for (dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        var bx = src.pos.x + dx;
        var by = src.pos.y + dy;
        if (bx <= 0 || bx >= 49 || by <= 0 || by >= 49) continue;
        var t = terrain.get(bx, by);
        if (t === TERRAIN_MASK_WALL) continue;
        var score = 0;
        var structures = room.lookForAt(LOOK_STRUCTURES, bx, by);
        for (var j = 0; j < structures.length; j++) {
          if (structures[j].structureType === STRUCTURE_ROAD) score += 5;
        }
        if (t === TERRAIN_MASK_SWAMP) score -= 2;
        if (score > bestScore) {
          bestScore = score;
          best = new RoomPosition(bx, by, room.name);
        }
      }
    }
    return best;
  }
};

module.exports = RoadPlanner;
