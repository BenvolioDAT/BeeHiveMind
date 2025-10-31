// Task.Builder.simple.js
var BeeToolbox = require('BeeToolbox');
try { require('Traveler'); } catch (e) {} // use if available

// =============================
// Tunables (ES5-safe)
// =============================
var ALLOW_HARVEST_FALLBACK = false; // set true if you want miners-of-last-resort
var PICKUP_MIN = 50;                // ignore tiny crumbs on the floor
var SRC_CONTAINER_MIN = 100;        // minimum energy to bother withdrawing at source containers

// =============================
// Tiny movement helper
// =============================
function go(creep, dest, range, reuse) {
  range = (range != null) ? range : 1;
  reuse = (reuse != null) ? reuse : 25;

  // Prefer BeeTravel / Traveler if present
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

function _nearest(pos, arr) {
  var best = null, bestD = 1e9;
  for (var i = 0; i < arr.length; i++) {
    var o = arr[i]; if (!o) continue;
    var d = pos.getRangeTo(o.pos || o);
    if (d < bestD) { bestD = d; best = o; }
  }
  return best;
}

function _isSourceContainer(s) {
  return s && s.structureType === STRUCTURE_CONTAINER &&
         s.pos && s.pos.findInRange(FIND_SOURCES, 1).length > 0;
}

// =============================
// Energy intake (no mining unless allowed)
// =============================
function collectEnergy(creep) {
  // 1) Dropped energy nearby (prefer floor snacks 😋)
  var dropped = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
    filter: function (r) { return r.resourceType === RESOURCE_ENERGY && (r.amount | 0) >= PICKUP_MIN; }
  });
  if (dropped) {
    if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) go(creep, dropped, 1, 15);
    return true;
  }

  // 2) Tombstones / Ruins
  var tomb = creep.pos.findClosestByRange(FIND_TOMBSTONES, {
    filter: function (t) { return (t.store[RESOURCE_ENERGY] | 0) > 0; }
  });
  if (tomb) {
    var tr = creep.withdraw(tomb, RESOURCE_ENERGY);
    if (tr === ERR_NOT_IN_RANGE) go(creep, tomb, 1, 20);
    return true;
  }
  var ruin = creep.pos.findClosestByRange(FIND_RUINS, {
    filter: function (r) { return (r.store[RESOURCE_ENERGY] | 0) > 0; }
  });
  if (ruin) {
    var rr = creep.withdraw(ruin, RESOURCE_ENERGY);
    if (rr === ERR_NOT_IN_RANGE) go(creep, ruin, 1, 20);
    return true;
  }

  // 3) Source-adjacent containers (the usual miner drop-off)
  var srcContainers = creep.room.find(FIND_STRUCTURES, {
    filter: function (s) {
      if (!_isSourceContainer(s) || !s.store) return false;
      return (s.store[RESOURCE_ENERGY] | 0) >= SRC_CONTAINER_MIN;
    }
  });
  if (srcContainers.length) {
    var c = _nearest(creep.pos, srcContainers);
    var cr = creep.withdraw(c, RESOURCE_ENERGY);
    if (cr === ERR_NOT_IN_RANGE) go(creep, c, 1, 25);
    return true;
  }

  // 4) Any container/link/storage/terminal with energy
  var stores = creep.room.find(FIND_STRUCTURES, {
    filter: function (s) {
      if (!s.store) return false;
      var t = s.structureType;
      if (t !== STRUCTURE_CONTAINER && t !== STRUCTURE_LINK &&
          t !== STRUCTURE_STORAGE  && t !== STRUCTURE_TERMINAL) return false;
      return (s.store[RESOURCE_ENERGY] | 0) > 0;
    }
  });
  if (stores.length) {
    var s2 = _nearest(creep.pos, stores);
    var sr = creep.withdraw(s2, RESOURCE_ENERGY);
    if (sr === ERR_NOT_IN_RANGE) go(creep, s2, 1, 25);
    return true;
  }

  // 5) Optional last-resort: mine
  if (ALLOW_HARVEST_FALLBACK) {
    var src = creep.pos.findClosestByRange(FIND_SOURCES_ACTIVE);
    if (src) {
      var hr = creep.harvest(src);
      if (hr === ERR_NOT_IN_RANGE) go(creep, src, 1, 20);
      return true;
    }
  }

  // Nothing to do—hover near storage/spawn so you’re useful next tick
  var anchor = creep.room.storage || _nearest(creep.pos, creep.room.find(FIND_MY_SPAWNS)) || creep.pos;
  if (anchor && anchor.pos) go(creep, anchor, 2, 20);
  return false;
}

// =============================
// Pick a build target (simple & sticky)
// =============================
function getStickySite(creep) {
  var id = creep.memory.siteId;
  if (!id) return null;
  var live = Game.constructionSites[id];
  if (live) return live;
  creep.memory.siteId = null;
  return null;
}

function pickBuildSite(creep) {
  // Prefer sites in our current room
  var local = creep.room.find(FIND_CONSTRUCTION_SITES);
  if (local.length) {
    // Very light priority: spawns/extensions/towers > everything else, then nearest
    var prio = { 'spawn': 5, 'extension': 4, 'tower': 3, 'container': 2, 'road': 1 };
    var best = null, bestScore = -1, bestD = 1e9;
    for (var i = 0; i < local.length; i++) {
      var s = local[i];
      var score = prio[s.structureType] || 0;
      var d = creep.pos.getRangeTo(s.pos);
      if (score > bestScore || (score === bestScore && d < bestD)) { best = s; bestScore = score; bestD = d; }
    }
    if (best) { creep.memory.siteId = best.id; return best; }
  }

  // Otherwise, any visible site in other rooms (closest by linear distance)
  var any = null, bestDist = 1e9;
  for (var id in Game.constructionSites) {
    if (!Game.constructionSites.hasOwnProperty(id)) continue;
    var site = Game.constructionSites[id];
    var dist = Game.map.getRoomLinearDistance(creep.pos.roomName, site.pos.roomName);
    if (dist < bestDist) { bestDist = dist; any = site; }
  }
  if (any) { creep.memory.siteId = any.id; return any; }

  return null;
}

// =============================
// Do the actual building
// =============================
function buildWork(creep, site) {
  if (!site) return false;
  if (creep.pos.inRangeTo(site.pos, 3)) {
    var r = creep.build(site);
    if (r === ERR_NOT_ENOUGH_RESOURCES) return false;
    if (r === ERR_INVALID_TARGET) { creep.memory.siteId = null; return false; }
    return true;
  } else {
    go(creep, site, 3, 15);
    return true;
  }
}

// =============================
// Public API
// =============================
var TaskBuilder = {
  run: function (creep) {
    // State flip
    if (creep.memory.building && creep.store[RESOURCE_ENERGY] === 0) creep.memory.building = false;
    if (!creep.memory.building && creep.store.getFreeCapacity() === 0) creep.memory.building = true;

    if (creep.memory.building) {
      // Build phase: stick to current site if possible
      var site = getStickySite(creep) || pickBuildSite(creep);
      if (site) {
        if (!buildWork(creep, site)) {
          // ran dry or invalid target—flip state or clear and try again next tick
          if ((creep.store[RESOURCE_ENERGY] | 0) === 0) creep.memory.building = false;
          else creep.memory.siteId = null;
        }
        return;
      }

      // No sites anywhere—dump energy into something useful
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

      // Chill at storage/spawn
      var anchor = creep.room.storage || _nearest(creep.pos, creep.room.find(FIND_MY_SPAWNS)) || creep.pos;
      if (anchor && anchor.pos) go(creep, anchor, 2, 20);
      return;
    }

    // Refuel phase (no mining unless allowed)
    collectEnergy(creep);
  }
};

module.exports = TaskBuilder;
