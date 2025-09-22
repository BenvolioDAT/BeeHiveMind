// role.TaskBuilder.cpu.es5.js
// ES5-safe, CPU-lean Builder with per-tick site caching, anti-stuck movement,
// friendly swaps, per-site reservations, and correct fallback so we don't
// withdraw then immediately re-deposit energy.

'use strict';

var BeeToolbox = require('BeeToolbox');

// =============================
// Tunables
// =============================
var BUILDERS_PER_SITE_CAP = 2;   // allow up to N builders per site per tick
var IDLE_NEAR_SITE_RANGE  = 2;   // where to wait if no reservation available

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

  for (var id in Game.constructionSites) {
    if (!Game.constructionSites.hasOwnProperty(id)) continue;
    var s = Game.constructionSites[id];
    var rn = s.pos.roomName;
    if (!byRoom[rn]) { byRoom[rn] = []; rooms.push(rn); }
    byRoom[rn].push(s);
  }

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
  if (room.storage && (room.storage.store[RESOURCE_ENERGY] | 0) > 0) return room.storage;
  if (room.terminal && (room.terminal.store[RESOURCE_ENERGY] | 0) > 0) return room.terminal;

  var cand = room.find(FIND_STRUCTURES, {
    filter: function(s) {
      if (!s.store) return false;
      if (s.structureType !== STRUCTURE_CONTAINER && s.structureType !== STRUCTURE_LINK) return false;
      return (s.store[RESOURCE_ENERGY] | 0) > 0;
    }
  });
  return cand.length ? _nearest(new RoomPosition(25, 25, room.name), cand) : null;
}

// -------- Anti-stuck & movement --------
function _edgeSafe(pos) { return pos.x > 1 && pos.x < 48 && pos.y > 1 && pos.y < 48; }

function _recordStuck(creep) {
  var m = creep.memory._stk || { x: -1, y: -1, t: 0 };
  if (creep.pos.x === m.x && creep.pos.y === m.y) m.t = (m.t | 0) + 1;
  else { m.x = creep.pos.x; m.y = creep.pos.y; m.t = 0; }
  creep.memory._stk = m;
  return m.t | 0;
}

function _lateralNudge(creep) {
  var dirs = [TOP, TOP_RIGHT, RIGHT, BOTTOM_RIGHT, BOTTOM, BOTTOM_LEFT, LEFT, TOP_LEFT];
  var dxs = [-1, 0, 1, 1, 1, 0, -1, -1];
  var dys = [-1, -1, -1, 0, 1, 1, 1, 0];
  for (var i = 0; i < 8; i++) {
    var d = dirs[i];
    var nx = creep.pos.x + dxs[i], ny = creep.pos.y + dys[i];
    if (nx < 1 || nx > 48 || ny < 1 || ny > 48) continue;
    var terr = creep.room.getTerrain().get(nx, ny);
    if (terr === TERRAIN_MASK_WALL) continue;
    var occ = creep.room.lookForAt(LOOK_CREEPS, nx, ny);
    if (occ && occ.length) continue;
    creep.move(d);
    break;
  }
}

// ---- Friendly swap helpers ----
function _posInDir(pos, dir) {
  var map = {
    1: {dx: 0,  dy: -1}, 2: {dx: 1,  dy: -1}, 3: {dx: 1,  dy: 0}, 4: {dx: 1,  dy: 1},
    5: {dx: 0,  dy: 1},  6: {dx: -1, dy: 1},  7: {dx: -1, dy: 0}, 8: {dx: -1, dy: -1}
  };
  var off = map[dir]; if (!off) return new RoomPosition(pos.x, pos.y, pos.roomName);
  return new RoomPosition(pos.x + off.dx, pos.y + off.dy, pos.roomName);
}

function _tryFriendlySwap(creep, dir) {
  if (!dir) return false;
  var np = _posInDir(creep.pos, dir);
  if (np.x < 0 || np.x > 49 || np.y < 0 || np.y > 49) return false;

  var blockers = creep.room.lookForAt(LOOK_CREEPS, np);
  if (!blockers || !blockers.length) return false;
  var mate = null;
  for (var i = 0; i < blockers.length; i++) { if (blockers[i].my) { mate = blockers[i]; break; } }
  if (!mate) return false;

  var meLoad = creep.store ? creep.store.getUsedCapacity(RESOURCE_ENERGY) : 0;
  var maLoad = mate.store ? mate.store.getUsedCapacity(RESOURCE_ENERGY) : 0;

  var iGo = false;
  if (meLoad < maLoad) iGo = true;
  else if (meLoad === maLoad) {
    var meFat = creep.fatigue | 0, maFat = mate.fatigue | 0;
    if (meFat < maFat) iGo = true;
    else if (meFat === maFat) iGo = (creep.ticksToLive | 0) < (mate.ticksToLive | 0);
  }

  if (iGo) {
    var back = dir + 4; if (back > 8) back -= 8;
    var ok = mate.move(back);
    if (ok === OK) { creep.move(dir); return true; }
  }
  return false;
}

// ---- Per-site reservation (limit builders/site/tick) ----
if (!global.__SITE_RES) global.__SITE_RES = { tick: -1, slots: {} };
function _reserveSite(siteId, cap) {
  var R = global.__SITE_RES;
  if (R.tick !== Game.time) { R.tick = Game.time; R.slots = {}; }
  var used = R.slots[siteId] | 0;
  if (used >= (cap | 0)) return false;
  R.slots[siteId] = used + 1;
  return true;
}

// Choose the best reservable site from a list (weight -> distance), trying next-best if the first is taken.
function _pickReservableSite(creep, list, cap, weights) {
  if (!list || !list.length) return null;
  var tried = {};
  for (var attempt = 0; attempt < list.length; attempt++) {
    var best = null, bestW = -1, bestD = 1e9, bestIdx = -1;
    for (var i = 0; i < list.length; i++) {
      if (tried[i]) continue;
      var s = list[i];
      var w = (weights && weights[s.structureType]) || 0;
      var d = creep.pos.getRangeTo(s.pos);
      if (w > bestW || (w === bestW && d < bestD)) { best = s; bestW = w; bestD = d; bestIdx = i; }
    }
    if (!best) break;
    tried[bestIdx] = true;
    if (_reserveSite(best.id, cap)) return best; // got a slot; use it
  }
  return null;
}

// Unified mover with anti-stuck + friendly swap
function go(creep, dest, opts) {
  if (!dest) return;
  opts = opts || {};
  var range = (opts.range != null) ? opts.range : 1;

  var stuck = _recordStuck(creep);
  var baseReuse = (opts.reusePath != null) ? opts.reusePath : 35;
  if (range <= 3) baseReuse = Math.min(baseReuse, 10);
  if (stuck >= 2) baseReuse = Math.min(baseReuse, 5);
  var ignoreCreeps = (stuck >= 2) ? false : true;

  if (!_edgeSafe(creep.pos)) { _lateralNudge(creep); }

  var path = creep.pos.findPathTo(dest, {
    ignoreCreeps: ignoreCreeps,
    range: range,
    maxOps: (stuck >= 3) ? 3000 : 1500,
    plainCost: 2, swampCost: 6
  });

  if (path && path.length) {
    var step = path[0];
    var dir = creep.pos.getDirectionTo(step.x, step.y);
    var res = creep.move(dir);
    if (res !== OK) {
      if (_tryFriendlySwap(creep, dir)) return;
      if (stuck >= 3) _lateralNudge(creep);
    }
    return;
  }

  if (BeeToolbox && BeeToolbox.BeeTravel) {
    try { BeeToolbox.BeeTravel(creep, dest, { range: range, reusePath: baseReuse }); return; } catch (e) {}
  }

  var moveRes = creep.moveTo(dest, {
    range: range,
    reusePath: baseReuse,
    ignoreCreeps: ignoreCreeps,
    maxOps: (stuck >= 3) ? 3000 : 1800,
    plainCost: 2, swampCost: 6
  });
  if (stuck >= 3 && moveRes === ERR_NO_PATH) _lateralNudge(creep);
}

// -----------------------------
// TaskBuilder module
// -----------------------------
var TaskBuilder = {
  structureLimits: { 'tower': 6, 'extension': 60, 'container': 1, 'rampart': 2, 'road': 20 },

  siteWeights: { 'tower': 5, 'container': 4, 'extension': 3, 'rampart': 2, 'road': 1 },

  structurePlacements: [ /* paste your existing placements here */ ],

  run: function (creep) {
    // Toggle build state
    if (creep.memory.building && creep.store[RESOURCE_ENERGY] === 0) creep.memory.building = false;
    if (!creep.memory.building && creep.store.getFreeCapacity() === 0) creep.memory.building = true;

    if (creep.memory.building) {
      // ---- BUILD PHASE ----
      var C = _prepareBuilderSites();
      var here = creep.pos.roomName;
      var weights = TaskBuilder.siteWeights;

      // 1) Prefer sites in current room
      var localList = C.byRoom[here] || [];

      if (localList.length) {
        // Pick a reservable site (tries next-best if first is already capped)
        var site = _pickReservableSite(creep, localList, BUILDERS_PER_SITE_CAP, weights);

        if (site) {
          if (creep.pos.inRangeTo(site.pos, 3)) {
            var r = creep.build(site);
            if (r === ERR_NOT_IN_RANGE) { go(creep, site, { range: 3 }); }
            else if (r === ERR_INVALID_TARGET) { _lateralNudge(creep); }
          } else {
            go(creep, site, { range: 3 });
          }
          return;
        } else {
          // No slot free this tick: WAIT near best local site instead of dumping energy
          var bestLocal = C.bestByRoom[here];
          if (bestLocal) { go(creep, bestLocal.pos, { range: IDLE_NEAR_SITE_RANGE }); return; }
        }
      }

      // 2) Otherwise go to the NEAREST room that has sites (including 'here' case)
      if (C.rooms.length) {
        var nearestRoom = null, bestDist = 1e9;
        for (var r2 = 0; r2 < C.rooms.length; r2++) {
          var rn = C.rooms[r2];
          var dist = Game.map.getRoomLinearDistance(here, rn);
          if (dist < bestDist) { bestDist = dist; nearestRoom = rn; }
        }

        // If the nearest room is *this* room, we already tried; just idle near its best site.
        if (nearestRoom === here) {
          var bestHere = C.bestByRoom[here];
          if (bestHere) { go(creep, bestHere.pos, { range: IDLE_NEAR_SITE_RANGE }); return; }
        } else {
          if (Game.rooms[nearestRoom]) {
            // With vision: try to reserve & build its best site
            var bestSite = C.bestByRoom[nearestRoom];
            if (bestSite) {
              if (_reserveSite(bestSite.id, BUILDERS_PER_SITE_CAP)) {
                if (creep.pos.inRangeTo(bestSite.pos, 3)) {
                  var r3 = creep.build(bestSite);
                  if (r3 === ERR_NOT_IN_RANGE) go(creep, bestSite, { range: 3 });
                  else if (r3 === ERR_INVALID_TARGET) _lateralNudge(creep);
                } else {
                  go(creep, bestSite, { range: 3 });
                }
                return;
              } else {
                // No slot free there either: move toward it and wait close
                go(creep, bestSite.pos, { range: IDLE_NEAR_SITE_RANGE }); return;
              }
            } else {
              go(creep, new RoomPosition(25, 25, nearestRoom), { range: 20 }); return;
            }
          } else {
            // No vision: head to room center
            go(creep, new RoomPosition(25, 25, nearestRoom), { range: 20 }); return;
          }
        }
      }

      // 3) Only if there are truly NO sites anywhere do we dump energy + recycle
      if (C.rooms.length === 0) {
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
        if (spawn) { if (creep.pos.getRangeTo(spawn) > 1) go(creep, spawn, { range: 1 }); else spawn.recycleCreep(creep); }
        else creep.suicide();
        return;
      }

      // If we got here, just chill near the best known site in this room or home anchor
      var bestFallback = C.bestByRoom[here];
      if (bestFallback) { go(creep, bestFallback.pos, { range: IDLE_NEAR_SITE_RANGE }); return; }
      go(creep, getHomeAnchorPos(ensureHome(creep)), { range: 2 }); return;

    } else {
      // ---- REFUEL PHASE ----
      var homeName = ensureHome(creep);

      var src = findWithdrawTargetInRoom(creep.room);
      if (src) {
        var r1 = creep.withdraw(src, RESOURCE_ENERGY);
        if (r1 === ERR_NOT_IN_RANGE) go(creep, src, { range: 1 });
        return;
      }

      if (creep.pos.roomName !== homeName) { go(creep, getHomeAnchorPos(homeName), { range: 1 }); return; }

      src = findWithdrawTargetInRoom(creep.room);
      if (src) {
        var r2 = creep.withdraw(src, RESOURCE_ENERGY);
        if (r2 === ERR_NOT_IN_RANGE) go(creep, src, { range: 1 });
        return;
      }

      var source = creep.pos.findClosestByRange(FIND_SOURCES_ACTIVE);
      if (source) { var r3 = creep.harvest(source); if (r3 === ERR_NOT_IN_RANGE) go(creep, source); return; }

      go(creep, getHomeAnchorPos(homeName), { range: 2 }); return;
    }
  },

  // ——— Utilities kept for compatibility ———
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
      if (res === OK) { placed++; siteCounts[type] = (siteCounts[type] | 0) + 1; }
    }

    mem.nextPlanTick = Game.time + (placed ? 10 : 25);
  },

  buildPredefinedStructures: function (creep) { /* unchanged */ },
  buildStructures: function (creep, targetPosition, structureType) { /* unchanged */ },
  countStructures: function (room, structureType) { /* unchanged */ }
};

module.exports = TaskBuilder;
