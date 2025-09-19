// role.TaskBuilder.cpu.es5.js
// ES5-safe, CPU-trimmed Builder with per-tick site caching & cheap selection.

'use strict';

var BeeToolbox = require('BeeToolbox');

// -----------------------------
// Global, per-tick builder cache
// -----------------------------
if (!global.__BUI) global.__BUI = { tick: -1, byRoom: {}, rooms: [], bestByRoom: {} };

function _prepareBuilderSites() {
  var G = global.__BUI;
  if (G.tick === Game.time) return G;

  var byRoom = {};
  var rooms = [];
  var bestByRoom = {};

  // Group sites by room (global cap is 100 — cheap)
  for (var id in Game.constructionSites) {
    if (!Game.constructionSites.hasOwnProperty(id)) continue;
    var s = Game.constructionSites[id];
    var rn = s.pos.roomName;
    if (!byRoom[rn]) { byRoom[rn] = []; rooms.push(rn); }
    byRoom[rn].push(s);
  }

  // Pre-pick "best" site per room using weights; break ties by proximity to room center
  var weights = TaskBuilder.siteWeights;
  for (var r = 0; r < rooms.length; r++) {
    var rn2 = rooms[r];
    var list = byRoom[rn2];
    var best = null, bestW = -1, bestD = 1e9;
    var center = new RoomPosition(25, 25, rn2);
    for (var i = 0; i < list.length; i++) {
      var site = list[i];
      var w = (weights && weights[site.structureType]) || 0;
      var d = (site.pos.roomName === rn2) ? site.pos.getRangeTo(center) : 999;
      if (w > bestW || (w === bestW && d < bestD)) { best = site; bestW = w; bestD = d; }
    }
    bestByRoom[rn2] = best;
  }

  G.tick = Game.time;
  G.byRoom = byRoom;
  G.rooms = rooms;
  G.bestByRoom = bestByRoom;
  return G;
}

// -----------------------------
// Small helpers (ES5-safe)
// -----------------------------
function ensureHome(creep) {
  if (creep.memory.home) return creep.memory.home;
  var keys = Object.keys(Game.spawns);
  if (keys.length) {
    var best = Game.spawns[keys[0]];
    var bestD = Game.map.getRoomLinearDistance(creep.pos.roomName, best.pos.roomName);
    for (var i = 1; i < keys.length; i++) {
      var sp = Game.spawns[keys[i]];
      var d  = Game.map.getRoomLinearDistance(creep.pos.roomName, sp.pos.roomName);
      if (d < bestD) { best = sp; bestD = d; }
    }
    creep.memory.home = best.pos.roomName;
  } else {
    creep.memory.home = creep.pos.roomName;
  }
  return creep.memory.home;
}

function getHomeAnchorPos(homeName) {
  var room = Game.rooms[homeName];
  if (room) {
    if (room.storage) return room.storage.pos;
    var sp = room.find(FIND_MY_SPAWNS);
    if (sp.length) return sp[0].pos;
    if (room.controller && room.controller.my) return room.controller.pos;
  }
  return new RoomPosition(25, 25, homeName);
}

function _nearest(pos, arr) {
  var best = null, bestD = 1e9;
  for (var i = 0; i < arr.length; i++) {
    var o = arr[i]; if (!o) continue;
    var d = pos.getRangeTo(o);
    if (d < bestD) { bestD = d; best = o; }
  }
  return best;
}

function findWithdrawTargetInRoom(room) {
  if (!room) return null;
  // fast path: storage -> terminal
  if (room.storage && (room.storage.store[RESOURCE_ENERGY] | 0) > 0) return room.storage;
  if (room.terminal && (room.terminal.store[RESOURCE_ENERGY] | 0) > 0) return room.terminal;

  // then nearest container/link with energy (no sorting)
  var cand = room.find(FIND_STRUCTURES, {
    filter: function(s) {
      if (!s.store) return false;
      if (s.structureType !== STRUCTURE_CONTAINER && s.structureType !== STRUCTURE_LINK) return false;
      return (s.store[RESOURCE_ENERGY] | 0) > 0;
    }
  });
  return cand.length ? _nearest(new RoomPosition(25, 25, room.name), cand) : null;
}

function go(creep, dest, opts) {
  opts = opts || {};
  var range = (opts.range != null) ? opts.range : 1;
  var reuse = (opts.reusePath != null) ? opts.reusePath : 35; // higher reuse → cheaper CPU
  if (BeeToolbox && BeeToolbox.BeeTravel) {
    try { BeeToolbox.BeeTravel(creep, dest, { range: range, reusePath: reuse }); return; } catch (e) {}
  }
  if (creep.pos.getRangeTo(dest) > range) creep.moveTo(dest, { reusePath: reuse, maxOps: 1800 });
}

// -----------------------------
// TaskBuilder module
// -----------------------------
var TaskBuilder = {
  // NOTE: keys are structureType strings (e.g., 'tower')
  structureLimits: {
    'tower':     6,
    'extension': 60,
    'container': 1,
    'rampart':   2,
    'road':      20
  },

  siteWeights: {
    'tower':     5,
    'container': 4,
    'extension': 3,
    'rampart':   2,
    'road':      1
  },

  // Preplanned placements (relative to first spawn).
  structurePlacements: [ /* — unchanged list from your version — */ ],

  run: function (creep) {
    // Toggle build state
    if (creep.memory.building && creep.store[RESOURCE_ENERGY] === 0) creep.memory.building = false;
    if (!creep.memory.building && creep.store.getFreeCapacity() === 0) creep.memory.building = true;

    if (creep.memory.building) {
      // ---- BUILD PHASE (CPU-lean) ----
      var C = _prepareBuilderSites();
      var here = creep.pos.roomName;

      // 1) Prefer sites in current room
      var localList = C.byRoom[here] || [];
      if (localList.length) {
        // single-pass pick: highest weight, then nearest (no sort)
        var weights = TaskBuilder.siteWeights;
        var best = null, bestW = -1, bestD = 1e9;
        for (var i = 0; i < localList.length; i++) {
          var s = localList[i];
          var w = (weights && weights[s.structureType]) || 0;
          var d = creep.pos.getRangeTo(s.pos);
          if (w > bestW || (w === bestW && d < bestD)) { best = s; bestW = w; bestD = d; }
        }
        if (creep.build(best) === ERR_NOT_IN_RANGE) { go(creep, best, { range: 3 }); }
        return;
      }

      // 2) No local sites: move toward the NEAREST room that has sites
      if (C.rooms.length) {
        var nearestRoom = null, bestDist = 1e9;
        for (var r = 0; r < C.rooms.length; r++) {
          var rn = C.rooms[r];
          var dist = Game.map.getRoomLinearDistance(here, rn);
          if (dist < bestDist) { bestDist = dist; nearestRoom = rn; }
        }
        // If we can see target room, build its pre-picked "best" site; else move toward its center
        if (nearestRoom === here) {
          // (shouldn’t happen because we had no localList), but guard anyway
        } else if (Game.rooms[nearestRoom]) {
          var bestSite = C.bestByRoom[nearestRoom];
          if (bestSite) {
            if (creep.build(bestSite) === ERR_NOT_IN_RANGE) { go(creep, bestSite, { range: 3 }); }
          } else {
            go(creep, new RoomPosition(25, 25, nearestRoom), { range: 20 });
          }
        } else {
          // No vision: rally to center of the target room (cheap pathing)
          go(creep, new RoomPosition(25, 25, nearestRoom), { range: 20 });
        }
        return;
      }

      // 3) No sites anywhere → dump energy (cheap) then recycle
      if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
        var sink = creep.pos.findClosestByRange(FIND_STRUCTURES, {
          filter: function(s) {
            if (!s.store || (s.store.getFreeCapacity(RESOURCE_ENERGY) | 0) <= 0) return false;
            return (s.structureType === STRUCTURE_STORAGE  ||
                    s.structureType === STRUCTURE_TERMINAL ||
                    s.structureType === STRUCTURE_SPAWN    ||
                    s.structureType === STRUCTURE_EXTENSION||
                    s.structureType === STRUCTURE_TOWER    ||
                    s.structureType === STRUCTURE_CONTAINER||
                    s.structureType === STRUCTURE_LINK);
          }
        });
        if (sink) {
          if (creep.transfer(sink, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) go(creep, sink, { range: 1 });
          return;
        }
      }
      var spawn = creep.pos.findClosestByRange(FIND_MY_SPAWNS);
      if (spawn) {
        if (creep.pos.getRangeTo(spawn) > 1) go(creep, spawn, { range: 1 });
        else spawn.recycleCreep(creep);
      } else {
        creep.suicide();
      }
      return;

    } else {
      // ---- REFUEL PHASE (cheap) ----
      var homeName = ensureHome(creep);

      // 1) Try current room quick-pick
      var src = findWithdrawTargetInRoom(creep.room);
      if (src) {
        var r1 = creep.withdraw(src, RESOURCE_ENERGY);
        if (r1 === ERR_NOT_IN_RANGE) go(creep, src, { range: 1 });
        return;
      }

      // 2) Go home if not there
      if (creep.pos.roomName !== homeName) {
        go(creep, getHomeAnchorPos(homeName), { range: 1 });
        return;
      }

      // 3) Try again with home vision
      src = findWithdrawTargetInRoom(creep.room);
      if (src) {
        var r2 = creep.withdraw(src, RESOURCE_ENERGY);
        if (r2 === ERR_NOT_IN_RANGE) go(creep, src, { range: 1 });
        return;
      }

      // 4) Last resort: harvest active source
      var source = creep.pos.findClosestByRange(FIND_SOURCES_ACTIVE);
      if (source) {
        var r3 = creep.harvest(source);
        if (r3 === ERR_NOT_IN_RANGE) go(creep, source);
        return;
      }

      // 5) Idle near home anchor
      go(creep, getHomeAnchorPos(homeName), { range: 2 });
      return;
    }
  },

  // ——— Utilities you already used elsewhere ———

  // Plan construction sites periodically (now with counted caches per call)
  ensureSites: function(room) {
    if (!room || !room.controller || !room.controller.my) return;
    var spawns = room.find(FIND_MY_SPAWNS);
    if (!spawns.length) return;
    var center = spawns[0].pos;

    var MAX_SITES_PER_TICK = 5;
    if (!Memory.rooms) Memory.rooms = {};
    if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};
    var mem = Memory.rooms[room.name];

    var next = mem.nextPlanTick || 0;
    if (Game.time < next) return;

    // Pre-count built & site totals ONCE
    var builtCounts = {};
    var structs = room.find(FIND_STRUCTURES);
    for (var i1 = 0; i1 < structs.length; i1++) {
      var st = structs[i1].structureType;
      builtCounts[st] = (builtCounts[st] | 0) + 1;
    }
    var siteCounts = {};
    var sitesExisting = room.find(FIND_CONSTRUCTION_SITES);
    for (var j1 = 0; j1 < sitesExisting.length; j1++) {
      var st2 = sitesExisting[j1].structureType;
      siteCounts[st2] = (siteCounts[st2] | 0) + 1;
    }

    var rcl = room.controller.level;
    var placed = 0;

    for (var i = 0; i < TaskBuilder.structurePlacements.length; i++) {
      if (placed >= MAX_SITES_PER_TICK) break;

      var p = TaskBuilder.structurePlacements[i];
      var tx = center.x + p.x, ty = center.y + p.y;
      if (tx < 0 || tx > 49 || ty < 0 || ty > 49) continue;

      var target = new RoomPosition(tx, ty, room.name);
      if (target.lookFor(LOOK_STRUCTURES).length > 0) continue;
      if (target.lookFor(LOOK_CONSTRUCTION_SITES).length > 0) continue;

      var type = p.type;
      var rclLimit = (CONTROLLER_STRUCTURES[type] && CONTROLLER_STRUCTURES[type][rcl] != null)
                      ? CONTROLLER_STRUCTURES[type][rcl] : Infinity;
      var softLimit = (TaskBuilder.structureLimits && TaskBuilder.structureLimits[type] != null)
                      ? TaskBuilder.structureLimits[type] : Infinity;
      var allowed = Math.min(rclLimit, softLimit);

      var have = ((builtCounts[type] | 0) + (siteCounts[type] | 0));
      if (have >= allowed) continue;

      var terr = room.getTerrain().get(target.x, target.y);
      if (terr === TERRAIN_MASK_WALL) continue;

      var res = room.createConstructionSite(target, type);
      if (res === OK) {
        placed++;
        siteCounts[type] = (siteCounts[type] | 0) + 1; // keep the count accurate inside this pass
      }
    }

    mem.nextPlanTick = Game.time + (placed ? 10 : 25);
  },

  // Kept for compatibility with your visuals/other modules:
  buildPredefinedStructures: function (creep) { /* unchanged from your version */ },
  buildStructures: function (creep, targetPosition, structureType) { /* unchanged */ },
  countStructures: function (room, structureType) { /* unchanged */ }
};

module.exports = TaskBuilder;
