// Planner.Road.clean.refactor.cpu.js
// CPU-minded, staged road planner for Screeps
// - Builds a home-room logistics spine (spawn → storage) and spokes to sources (+ optional controller).
// - Plans + drip-places ROAD sites to remote sources used by your remote-harvest creeps.
// - Audits occasionally and relaunches placements if tiles decay.
// Design goals: cut repeated work per tick; reuse path/state; avoid allocations in hot loops.

'use strict';

var BeeToolbox = require('BeeToolbox');

/** =========================
 *  Config (tweak here)
 *  ========================= */
var CFG = Object.freeze({
  // Pathfinding weights
  plainCost: 2,
  swampCost: 10,
  roadCost: 1,

  // Pathfinding safety caps (prevent expensive searches on mega routes)
  maxRoomsPlanning: 10,        // cap path search footprint (tune for your empire layout)
  maxOpsPlanning: 20000,       // PathFinder ops guardrail; lower on CPU pinches

  // Placement behavior
  placeBudgetPerTick: 10,      // ROAD sites we attempt per tick across a path
  globalCSiteSafetyLimit: 95,  // skip if near 100 cap
  plannerTickModulo: 3,        // run ensureRemoteRoads only 1/modulo ticks (staggered by room)

  // Auditing: regular interval + tiny random chance to smooth load
  auditInterval: 100,          // bumped for calmer CPU
  randomAuditChance: 0.01,     // 1% background audit on off-ticks

  // Home network
  includeControllerSpoke: true,

  // NEW: hard cap on how far (in room hops) we will plan remote roads from this home.
  // Set to 0 (or negative) to disable radius limiting.
  maxRemoteRadius: 3
});

/** =========================
 *  One-tick caches (zero cost across module calls the same tick)
 *  ========================= */
var _tick = function () {
  return Game.time;
};

if (!global.__RPM) {
  global.__RPM = {
    csiteCountTick: -1,
    csiteCount: 0,
    cmTick: -1,
    cm: Object.create(null), // roomName -> CostMatrix (per tick)
    remoteTick: -1,
    remotes: [],
    spawnsTick: -1,
    spawnsByRoom: Object.create(null)
  };
}

/** Get global construction site count once per tick. */
function getCSiteCountOnce() {
  if (__RPM.csiteCountTick === _tick()) return __RPM.csiteCount;
  __RPM.csiteCountTick = _tick();
  var total = 0;
  for (var id in Game.constructionSites) {
    if (Object.prototype.hasOwnProperty.call(Game.constructionSites, id)) {
      total++;
    }
  }
  __RPM.csiteCount = total;
  return __RPM.csiteCount;
}

/** Cached active remote rooms (scan creeps once per tick). */
function activeRemotesOncePerTick() {
  if (__RPM.remoteTick === _tick()) return __RPM.remotes;
  var seen = Object.create(null);
  for (var name in Game.creeps) {
    if (!Game.creeps.hasOwnProperty(name)) continue;
    var c = Game.creeps[name];
    if (c && c.memory && c.memory.task === 'luna' && c.memory.targetRoom) {
      seen[c.memory.targetRoom] = true;
    }
  }
  var list = [];
  for (var roomName in seen) {
    if (Object.prototype.hasOwnProperty.call(seen, roomName)) {
      list.push(roomName);
    }
  }
  __RPM.remotes = list;
  __RPM.remoteTick = _tick();
  return __RPM.remotes;
}

function getRoomSpawnsOnce(room) {
  if (!room) return [];
  if (__RPM.spawnsTick !== _tick()) {
    __RPM.spawnsTick = _tick();
    __RPM.spawnsByRoom = Object.create(null);
  }
  var cached = __RPM.spawnsByRoom[room.name];
  if (cached) return cached;
  var list = room.find(FIND_MY_SPAWNS);
  __RPM.spawnsByRoom[room.name] = list;
  return list;
}

/** =========================
 *  Fast tile checks (avoid allocations)
 *  ========================= */
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

/** =========================
 *  RoadPlanner module
 *  ========================= */
var RoadPlanner = {
  /**
   * Call this from your main loop (once per owned room, or just your primary room).
   * CPU guards:
   *  - Stagger by room via plannerTickModulo
   *  - Remote list cached once per tick
   *  - Per-room CostMatrix cached per tick
   * @param {Room} homeRoom
   */
  ensureRemoteRoads: function (homeRoom) {
    if (!homeRoom || !homeRoom.controller || !homeRoom.controller.my) return;
    var self = this;

    // Stagger work across rooms/ticks to flatten spikes:
    if (CFG.plannerTickModulo > 1) {
      var h = 0;
      for (var i = 0; i < homeRoom.name.length; i++) {
        h = (h * 31 + homeRoom.name.charCodeAt(i)) | 0;
      }
      if (((_tick() + (h & 3)) % CFG.plannerTickModulo) !== 0) return;
    }

    var mem = self._memory(homeRoom);

    // NEW: prune any previously stored remote paths that are now beyond the radius cap
    self._pruneOutOfRadiusPaths(homeRoom, mem);

    // Require some anchor in early game
    var spawns = getRoomSpawnsOnce(homeRoom);
    if (!spawns.length && !homeRoom.storage) return;

    // 1) Staged home logistics network
    self._ensureStagedHomeNetwork(homeRoom, spawns);

    // 2) Remote spokes for any active remote-harvest creeps (list cached once per tick)
    var activeRemotes = activeRemotesOncePerTick();
    for (var rIdx = 0; rIdx < activeRemotes.length; rIdx++) {
      var remoteName = activeRemotes[rIdx];
      // NEW: skip remotes beyond the configured radius from this home
      if (CFG.maxRemoteRadius > 0) {
        var dist = BeeToolbox.safeLinearDistance(homeRoom.name, remoteName);
        if (dist > CFG.maxRemoteRadius) continue;
      }

      var rmem = Memory.rooms && Memory.rooms[remoteName];
      if (!rmem || !rmem.sources) continue;            // needs your exploration/memory elsewhere
      var remoteRoom = Game.rooms[remoteName];
      if (!remoteRoom) continue;                       // only plan when visible (safe + accurate)

      var sources = remoteRoom.find(FIND_SOURCES);
      for (var sIdx = 0; sIdx < sources.length; sIdx++) {
        var src = sources[sIdx];
        var key = remoteName + ':' + src.id;
        // Plan once, then drip-place and audit thereafter
        if (!mem.paths[key]) {
          var harvestPos = self._chooseHarvestTile(src);
          var goal = harvestPos ? { pos: harvestPos, range: 0 } : { pos: src.pos, range: 1 };

          var ret = PathFinder.search(self._getAnchorPos(homeRoom), goal, {
            plainCost: CFG.plainCost,
            swampCost: CFG.swampCost,
            maxRooms: CFG.maxRoomsPlanning,
            maxOps: CFG.maxOpsPlanning,
            roomCallback: function (roomName) {
              return self._roomCostMatrix(roomName);
            }
          });

          if (!ret.path || !ret.path.length || ret.incomplete) continue;

          var plainPath = [];
          for (var pIdx = 0; pIdx < ret.path.length; pIdx++) {
            var p = ret.path[pIdx];
            plainPath.push({ x: p.x, y: p.y, roomName: p.roomName });
          }

          mem.paths[key] = {
            i: 0,
            done: false,
            // Store minimal plain objects (no RoomPosition instances)
            path: plainPath
          };
        }

        self._dripPlaceAlongPath(homeRoom, key, CFG.placeBudgetPerTick);
        self._auditAndRelaunch(homeRoom, key, 1);
      }
    }
  },

  // ---------- Home network (staged) ----------

  _getAnchorPos: function (homeRoom, cachedSpawns) {
    if (homeRoom.storage) return homeRoom.storage.pos;
    var spawns = cachedSpawns || getRoomSpawnsOnce(homeRoom);
    return spawns.length ? spawns[0].pos : null;
  },

  _planTrackPlaceAudit: function (homeRoom, fromPos, goalPos, key, range) {
    if (!fromPos || !goalPos) return;
    var self = this;
    var actualRange = typeof range === 'number' ? range : 1;
    var mem = self._memory(homeRoom);

    if (!mem.paths[key]) {
      var ret = PathFinder.search(fromPos, { pos: goalPos, range: actualRange }, {
        plainCost: CFG.plainCost,
        swampCost: CFG.swampCost,
        maxRooms: CFG.maxRoomsPlanning,
        maxOps: CFG.maxOpsPlanning,
        roomCallback: function (roomName) {
          return self._roomCostMatrix(roomName);
        }
      });
      if (!ret.path || !ret.path.length || ret.incomplete) return;

      var plainPath = [];
      for (var pIdx = 0; pIdx < ret.path.length; pIdx++) {
        var p = ret.path[pIdx];
        plainPath.push({ x: p.x, y: p.y, roomName: p.roomName });
      }

      mem.paths[key] = {
        i: 0,
        done: false,
        path: plainPath
      };
    }

    this._dripPlaceAlongPath(homeRoom, key, CFG.placeBudgetPerTick);
    this._auditAndRelaunch(homeRoom, key, 1);
  },

  _ensureStagedHomeNetwork: function (homeRoom, cachedSpawns) {
    var spawns = cachedSpawns || getRoomSpawnsOnce(homeRoom);
    var anchor = this._getAnchorPos(homeRoom, spawns);
    if (!anchor) return;

    // (A) Spokes to sources
    var sources = homeRoom.find(FIND_SOURCES);
    for (var i = 0; i < sources.length; i++) {
      var src = sources[i];
      var harv = this._chooseHarvestTile(src) || src.pos;
      var range = (harv === src.pos) ? 1 : 0;
      var stage = homeRoom.storage ? 'storage' : 'spawn';
      var key = homeRoom.name + ':LOCAL:source' + i + ':from=' + stage;
      this._planTrackPlaceAudit(homeRoom, anchor, harv, key, range);
    }

    // (B) Optional spoke to controller
    if (CFG.includeControllerSpoke && homeRoom.controller) {
      var stageC = homeRoom.storage ? 'storage' : 'spawn';
      var keyC = homeRoom.name + ':LOCAL:controller:from=' + stageC;
      this._planTrackPlaceAudit(homeRoom, anchor, homeRoom.controller.pos, keyC, 1);
    }

    // (C) Spawn ↔ storage backbone once storage exists
    if (homeRoom.storage) {
      if (spawns.length) {
        var keyS = homeRoom.name + ':LOCAL:spawn0-to-storage';
        this._planTrackPlaceAudit(homeRoom, spawns[0].pos, homeRoom.storage.pos, keyS, 1);
      }
    }
  },

  // ---------- Path placement + auditing ----------

  _dripPlaceAlongPath: function (homeRoom, key, budget) {
    if (getCSiteCountOnce() > CFG.globalCSiteSafetyLimit) return;

    var mem = this._memory(homeRoom);
    var rec = mem.paths[key];
    if (!rec || rec.done) return;

    var placed = 0;
    var iterations = 0;

    while (rec.i < rec.path.length && placed < budget) {
      iterations++;
      if (iterations > budget + 10) break;

      var step = rec.path[rec.i];
      var roomObj = Game.rooms[step.roomName];
      if (!roomObj) break; // need visibility to place

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
  },

  _auditAndRelaunch: function (homeRoom, key, maxFixes) {
    var fixes = typeof maxFixes === 'number' ? maxFixes : 1;
    var mem = this._memory(homeRoom);
    var rec = mem.paths[key];
    if (!rec || !rec.done || !Array.isArray(rec.path) || !rec.path.length) return;

    var onInterval = (_tick() % CFG.auditInterval) === 0;
    var randomTick = Math.random() < CFG.randomAuditChance;
    if (!onInterval && !randomTick) return;

    var fixed = 0;
    for (var idx = 0; idx < rec.path.length && fixed < fixes; idx++) {
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
  },

  // ---------- Cost matrix (per-tick cache) ----------

  _roomCostMatrix: function (roomName) {
    var room = Game.rooms[roomName];
    if (!room) return;

    if (__RPM.cmTick !== _tick()) {
      __RPM.cmTick = _tick();
      __RPM.cm = Object.create(null);
    }
    var cached = __RPM.cm[roomName];
    if (cached) return cached;

    var costs = new PathFinder.CostMatrix();

    var structs = room.find(FIND_STRUCTURES);
    for (var i = 0; i < structs.length; i++) {
      var s = structs[i];
      if (s.structureType === STRUCTURE_ROAD) {
        costs.set(s.pos.x, s.pos.y, CFG.roadCost);
      } else if (
        s.structureType !== STRUCTURE_CONTAINER &&
        (s.structureType !== STRUCTURE_RAMPART || !s.my)
      ) {
        costs.set(s.pos.x, s.pos.y, 0xff);
      }
    }

    var sites = room.find(FIND_CONSTRUCTION_SITES);
    for (var j = 0; j < sites.length; j++) {
      var cs = sites[j];
      if (cs.structureType !== STRUCTURE_ROAD) {
        costs.set(cs.pos.x, cs.pos.y, 0xff);
      }
    }

    var sources = room.find(FIND_SOURCES);
    for (var k = 0; k < sources.length; k++) {
      var src = sources[k];
      costs.set(src.pos.x, src.pos.y, 0xff);
    }
    var minerals = room.find(FIND_MINERALS);
    for (var m = 0; m < minerals.length; m++) {
      var mineral = minerals[m];
      costs.set(mineral.pos.x, mineral.pos.y, 0xff);
    }

    __RPM.cm[roomName] = costs;
    return costs;
  },

  // ---------- Memory + info ----------

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
    var rooms = Object.create(null);
    var paths = mem.paths || {};
    var keys = Object.keys(paths);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var prefix = key.split(':')[0];
      rooms[prefix] = true;
    }
    var list = [];
    for (var roomName in rooms) {
      if (Object.prototype.hasOwnProperty.call(rooms, roomName)) {
        list.push(roomName);
      }
    }
    return list;
  },

  _discoverActiveRemoteRoomsFromCreeps: function () {
    return activeRemotesOncePerTick();
  },

  // ---------- NEW: radius pruning ----------

  /**
   * Remove any stored path keyed to a remote room that exceeds CFG.maxRemoteRadius
   * from this home. Keeps LOCAL keys intact.
   * @param {Room} homeRoom
   * @param {*} mem roadPlanner memory (this._memory(homeRoom))
   */
  _pruneOutOfRadiusPaths: function (homeRoom, mem) {
    if (!mem || !mem.paths) return;
    if (CFG.maxRemoteRadius <= 0) return; // disabled

    var home = homeRoom.name;
    var keys = Object.keys(mem.paths);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      // Keys are either "RoomName:sourceId" for remotes or "Home:LOCAL:..." for local
      // We only prune when the prefix is a room name different from home (remote case)
      var remotePrefix = key.split(':')[0];
      if (!remotePrefix || remotePrefix === home || remotePrefix === 'LOCAL') continue;

      var dist = BeeToolbox.safeLinearDistance(home, remotePrefix);
      if (dist > CFG.maxRemoteRadius) {
        delete mem.paths[key];
      }
    }
  },

  // ---------- Discovery helpers ----------

  _chooseHarvestTile: function (src) {
    var room = Game.rooms[src.pos.roomName];
    if (!room) return null;

    var terrain = room.getTerrain();

    // Any container-adjacent tile? Return immediately.
    for (var dx = -1; dx <= 1; dx++) {
      for (var dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        var x = src.pos.x + dx;
        var y = src.pos.y + dy;
        if (x <= 0 || x >= 49 || y <= 0 || y >= 49) continue;
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
        var structs = room.lookForAt(LOOK_STRUCTURES, x, y);
        for (var i = 0; i < structs.length; i++) {
          if (structs[i].structureType === STRUCTURE_CONTAINER) {
            return new RoomPosition(x, y, room.name);
          }
        }
      }
    }

    // Otherwise score tiles (road bonus, swamp penalty)
    var best = null;
    var bestScore = -Infinity;
    for (var sdx = -1; sdx <= 1; sdx++) {
      for (var sdy = -1; sdy <= 1; sdy++) {
        if (sdx === 0 && sdy === 0) continue;
        var sx = src.pos.x + sdx;
        var sy = src.pos.y + sdy;
        if (sx <= 0 || sx >= 49 || sy <= 0 || sy >= 49) continue;

        var t = terrain.get(sx, sy);
        if (t === TERRAIN_MASK_WALL) continue;

        var structures = room.lookForAt(LOOK_STRUCTURES, sx, sy);
        var score = 0;
        for (var si = 0; si < structures.length; si++) {
          if (structures[si].structureType === STRUCTURE_ROAD) score += 5;
        }
        if (t === TERRAIN_MASK_SWAMP) score -= 2;

        if (score > bestScore) {
          bestScore = score;
          best = new RoomPosition(sx, sy, room.name);
        }
      }
    }
    return best;
  }
};

module.exports = RoadPlanner;
