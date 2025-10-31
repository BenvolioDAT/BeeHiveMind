// Task.Builder.mini.js
var BeeToolbox = require('BeeToolbox');
try { require('Traveler'); } catch (e) {} // use if available

// -----------------------------
// Tunables
// -----------------------------
var ALLOW_HARVEST_FALLBACK = false; // flip true if you really want last-resort mining
var PICKUP_MIN = 50;                // ignore tiny crumbs
var SRC_CONTAINER_MIN = 100;        // minimum energy to bother at source containers

// -----------------------------
// Tiny movement helper
// -----------------------------
function go(creep, dest, range, reuse) {
  range = (range != null) ? range : 1;
  reuse = (reuse != null) ? reuse : 25;

  try {
    if (BeeToolbox && BeeToolbox.BeeTravel) {
      BeeToolbox.BeeTravel(creep, (dest.pos || dest), { range: range, reusePath: reuse });
      return;
    }
    if (typeof creep.travelTo === 'function') {
      creep.travelTo((dest.pos || dest), { range: range, reusePath: reuse, ignoreCreeps: false, maxOps: 4000 });
      return;
    }
  } catch (e) {}
  if (creep.pos.getRangeTo(dest) > range) creep.moveTo(dest, { reusePath: reuse, maxOps: 1500 });
}

// -----------------------------
// Energy intake (prefer floor snacks)
// -----------------------------
function collectEnergy(creep) {
  // 1) Dropped
  var dropped = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
    filter: function (r) { return r.resourceType === RESOURCE_ENERGY && (r.amount | 0) >= PICKUP_MIN; }
  });
  if (dropped) { if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) go(creep, dropped, 1, 15); return true; }

  // 2) Tombstones / Ruins
  var tomb = creep.pos.findClosestByRange(FIND_TOMBSTONES, { filter: function (t) { return (t.store[RESOURCE_ENERGY] | 0) > 0; } });
  if (tomb) { var tr = creep.withdraw(tomb, RESOURCE_ENERGY); if (tr === ERR_NOT_IN_RANGE) go(creep, tomb, 1, 20); return true; }
  var ruin = creep.pos.findClosestByRange(FIND_RUINS, { filter: function (r) { return (r.store[RESOURCE_ENERGY] | 0) > 0; } });
  if (ruin) { var rr = creep.withdraw(ruin, RESOURCE_ENERGY); if (rr === ERR_NOT_IN_RANGE) go(creep, ruin, 1, 20); return true; }

  // 3) Source-adjacent container
  var srcCont = creep.pos.findClosestByRange(FIND_STRUCTURES, {
    filter: function (s) {
      if (s.structureType !== STRUCTURE_CONTAINER || !s.store) return false;
      if (s.pos.findInRange(FIND_SOURCES, 1).length === 0) return false;
      return (s.store[RESOURCE_ENERGY] | 0) >= SRC_CONTAINER_MIN;
    }
  });
  if (srcCont) { var cr = creep.withdraw(srcCont, RESOURCE_ENERGY); if (cr === ERR_NOT_IN_RANGE) go(creep, srcCont, 1, 25); return true; }

  // 4) Any store (container/link/storage/terminal)
  var storeLike = creep.pos.findClosestByRange(FIND_STRUCTURES, {
    filter: function (s) {
      if (!s.store) return false;
      var t = s.structureType;
      if (t !== STRUCTURE_CONTAINER && t !== STRUCTURE_LINK && t !== STRUCTURE_STORAGE && t !== STRUCTURE_TERMINAL) return false;
      return (s.store[RESOURCE_ENERGY] | 0) > 0;
    }
  });
  if (storeLike) { var sr = creep.withdraw(storeLike, RESOURCE_ENERGY); if (sr === ERR_NOT_IN_RANGE) go(creep, storeLike, 1, 25); return true; }

  // 5) Optional last resort: harvest
  if (ALLOW_HARVEST_FALLBACK) {
    var src = creep.pos.findClosestByRange(FIND_SOURCES_ACTIVE);
    if (src) { var hr = creep.harvest(src); if (hr === ERR_NOT_IN_RANGE) go(creep, src, 1, 20); return true; }
  }

  // Idle near something useful
  var anchor = creep.room.storage || creep.pos.findClosestByRange(FIND_MY_SPAWNS) || creep.pos;
  if (anchor && anchor.pos) go(creep, anchor, 2, 20);
  return false;
}

// -----------------------------
// Pick a build target (simple + sticky)
// -----------------------------
function pickBuildSite(creep) {
  // sticky
  var id = creep.memory.siteId;
  if (id) {
    var stick = Game.constructionSites[id];
    if (stick) return stick;
    creep.memory.siteId = null;
  }

  // prefer current room
  var local = creep.room.find(FIND_CONSTRUCTION_SITES);
  if (local.length) {
    // light priority: spawn/ext/tower first, else nearest
    var prio = { 'spawn': 5, 'extension': 4, 'tower': 3, 'container': 2, 'road': 1 };
    var best = null, bestScore = -1, bestD = 1e9;
    for (var i = 0; i < local.length; i++) {
      var s = local[i], sc = (prio[s.structureType] | 0), d = creep.pos.getRangeTo(s.pos);
      if (sc > bestScore || (sc === bestScore && d < bestD)) { best = s; bestScore = sc; bestD = d; }
    }
    if (best) { creep.memory.siteId = best.id; return best; }
  }

  // otherwise, nearest room with a site (visible or not)
  var any = null, bestDist = 1e9;
  for (var sid in Game.constructionSites) {
    if (!Game.constructionSites.hasOwnProperty(sid)) continue;
    var s2 = Game.constructionSites[sid];
    var d2 = Game.map.getRoomLinearDistance(creep.pos.roomName, s2.pos.roomName);
    if (d2 < bestDist) { bestDist = d2; any = s2; }
  }
  if (any) { creep.memory.siteId = any.id; return any; }

  return null;
}

// -----------------------------
// Build work
// -----------------------------
function doBuild(creep, site) {
  if (!site) return false;
  if (creep.pos.inRangeTo(site.pos, 3)) {
    var r = creep.build(site);
    if (r === ERR_NOT_ENOUGH_RESOURCES) return false;
    if (r === ERR_INVALID_TARGET) { creep.memory.siteId = null; return false; }
    return true;
  }
  go(creep, site, 3, 15);
  return true;
}

// -----------------------------
// Public API
// -----------------------------
var TaskBuilder = {
  run: function (creep) {
    // state flip
    if (creep.memory.building && creep.store[RESOURCE_ENERGY] === 0) creep.memory.building = false;
    if (!creep.memory.building && creep.store.getFreeCapacity() === 0) creep.memory.building = true;

    if (creep.memory.building) {
      var site = pickBuildSite(creep);
      if (site) {
        if (!doBuild(creep, site)) {
          if ((creep.store[RESOURCE_ENERGY] | 0) === 0) creep.memory.building = false;
          else creep.memory.siteId = null;
        }
        return;
      }

      // no sites: dump energy into anything useful, then idle
      if ((creep.store[RESOURCE_ENERGY] | 0) > 0) {
        var sink = creep.pos.findClosestByRange(FIND_STRUCTURES, {
          filter: function (s) {
            if (!s.store) return false;
            return (s.store.getFreeCapacity(RESOURCE_ENERGY) | 0) > 0 &&
                   (s.structureType === STRUCTURE_STORAGE   ||
                    s.structureType === STRUCTURE_TERMINAL  ||
                    s.structureType === STRUCTURE_SPAWN     ||
                    s.structureType === STRUCTURE_EXTENSION ||
                    s.structureType === STRUCTURE_TOWER     ||
                    s.structureType === STRUCTURE_CONTAINER ||
                    s.structureType === STRUCTURE_LINK);
          }
        });
        if (sink) { if (creep.transfer(sink, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) go(creep, sink, 1, 20); return; }
      }

      var anchor = creep.room.storage || creep.pos.findClosestByRange(FIND_MY_SPAWNS) || creep.pos;
      if (anchor && anchor.pos) go(creep, anchor, 2, 20);
      return;
    }

    // refuel phase (no mining unless allowed)
    collectEnergy(creep);
  }
};

module.exports = TaskBuilder;
