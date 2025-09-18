// Task.Courier.js — dynamic picker (no static container assignment)
// Chooses the fullest source-container, stays committed (short cooldown),
// scoops any fat dropped piles near that container, then delivers.
//
// Optional dep: BeeToolbox.BeeTravel(creep, target, {range, reusePath})

var BeeToolbox = require('BeeToolbox');

// -----------------------------
// Tunables
// -----------------------------
var RETARGET_COOLDOWN = 10;       // ticks to wait before switching containers
var DROPPED_NEAR_CONTAINER_R = 2; // how close to the container we consider "near"
var DROPPED_ALONG_ROUTE_R = 2;    // opportunistic pickup while en route (short detours)
var DROPPED_BIG_MIN = 150;        // big dropped energy threshold
var CONTAINER_MIN = 50;           // ignore tiny trickles in containers

// -----------------------------
// Small helpers (ES5-safe)
// -----------------------------
function go(creep, dest, range, reuse) {
  range = (range != null) ? range : 1;
  reuse = (reuse != null) ? reuse : 10;
  if (BeeToolbox && BeeToolbox.BeeTravel) {
    BeeToolbox.BeeTravel(creep, dest, { range: range, reusePath: reuse });
  } else if (creep.pos.getRangeTo(dest) > range) {
    creep.moveTo(dest, { reusePath: reuse });
  }
}

function isGoodContainer(c) {
  return c && c.structureType === STRUCTURE_CONTAINER &&
         c.store && (c.store[RESOURCE_ENERGY] || 0) >= CONTAINER_MIN;
}

function isSourceContainer(c) {
  if (!c || c.structureType !== STRUCTURE_CONTAINER) return false;
  return c.pos.findInRange(FIND_SOURCES, 1).length > 0;
}

function findBestSourceContainer(room) {
  var containers = room.find(FIND_STRUCTURES, {
    filter: function(s) {
      return s.structureType === STRUCTURE_CONTAINER &&
             (s.store && (s.store[RESOURCE_ENERGY] || 0) >= CONTAINER_MIN);
    }
  });
  if (!containers.length) return null;

  containers.sort(function(a, b) {
    // Source-adjacent first
    var as = isSourceContainer(a) ? 0 : 1;
    var bs = isSourceContainer(b) ? 0 : 1;
    if (as !== bs) return as - bs;

    // More energy first
    var ea = (a.store && a.store[RESOURCE_ENERGY]) || 0;
    var eb = (b.store && b.store[RESOURCE_ENERGY]) || 0;
    if (eb !== ea) return eb - ea;

    // Tie-breaker: closer to room center (rough heuristic)
    var da = Math.abs(a.pos.x - 25) + Math.abs(a.pos.y - 25);
    var db = Math.abs(b.pos.x - 25) + Math.abs(b.pos.y - 25);
    return da - db;
  });

  return containers[0];
}

function isClearlyBetter(best, current) {
  var be = (best && best.store && best.store[RESOURCE_ENERGY]) || 0;
  var ce = (current && current.store && current.store[RESOURCE_ENERGY]) || 0;
  // Switch if 25% more energy or at least +200
  return be >= ce * 1.25 || (be - ce) >= 200;
}

function selectDropoffTarget(creep) {
  var room = creep.room;

  // Prefer Storage, then Terminal
  if (room.storage && ((room.storage.store.getFreeCapacity(RESOURCE_ENERGY) || 0) > 0)) {
    return room.storage;
  }
  if (room.terminal && ((room.terminal.store.getFreeCapacity(RESOURCE_ENERGY) || 0) > 0)) {
    return room.terminal;
  }

  // Any non-source container with free capacity
  var container = creep.pos.findClosestByPath(FIND_STRUCTURES, {
    filter: function(s) {
      return s.structureType === STRUCTURE_CONTAINER &&
             !isSourceContainer(s) &&
             ((s.store.getFreeCapacity(RESOURCE_ENERGY) || 0) > 0);
    }
  });
  if (container) return container;

  return null;
}

// -----------------------------
// Main role
// -----------------------------
var TaskCourier = {
  run: function(creep) {
    // State machine bootstrap
    if (creep.memory.transferring && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.transferring = false;
    }
    if (!creep.memory.transferring && creep.store.getFreeCapacity() === 0) {
      creep.memory.transferring = true;
    }

    // Sticky target fields
    if (creep.memory.pickupContainerId === undefined) creep.memory.pickupContainerId = null;
    if (creep.memory.retargetAt === undefined) creep.memory.retargetAt = 0;

    if (creep.memory.transferring) {
      TaskCourier.deliverEnergy(creep);
    } else {
      TaskCourier.collectEnergy(creep);
    }
  },

  // -----------------------------
  // Energy collection
  // -----------------------------
  collectEnergy: function(creep) {
    var room = creep.room;

    // Decide container (keep sticky unless clearly better and cooldown passed)
    var container = Game.getObjectById(creep.memory.pickupContainerId);
    var now = Game.time | 0;

    if (!isGoodContainer(container) || now >= (creep.memory.retargetAt || 0)) {
      var best = findBestSourceContainer(room);
      if (!container || (best && container.id !== best.id && isClearlyBetter(best, container))) {
        container = best || null;
        creep.memory.pickupContainerId = container ? container.id : null;
        creep.memory.retargetAt = now + RETARGET_COOLDOWN;
      }
    }

    // Opportunistic: big pile near us? grab it
    var nearbyBigArr = creep.pos.findInRange(FIND_DROPPED_RESOURCES, DROPPED_ALONG_ROUTE_R, {
      filter: function(r) { return r.resourceType === RESOURCE_ENERGY && r.amount >= DROPPED_BIG_MIN; }
    });
    var nearbyBig = nearbyBigArr && nearbyBigArr[0];
    if (nearbyBig) {
      if (creep.pickup(nearbyBig) === ERR_NOT_IN_RANGE) go(creep, nearbyBig, 1, 10);
      return;
    }

    // If we have a target container, check drops near it first, then withdraw
    if (container) {
      var drops = container.pos.findInRange(FIND_DROPPED_RESOURCES, DROPPED_NEAR_CONTAINER_R, {
        filter: function(r) { return r.resourceType === RESOURCE_ENERGY && r.amount > 0; }
      });
      if (drops.length) {
        var bestDrop = creep.pos.findClosestByPath(drops) || drops[0];
        var pr = creep.pickup(bestDrop);
        if (pr === ERR_NOT_IN_RANGE) { go(creep, bestDrop, 1, 5); return; }
        // fall through to also try withdrawing if still room
      }

      if (((container.store && container.store[RESOURCE_ENERGY]) || 0) > 0) {
        var wr = creep.withdraw(container, RESOURCE_ENERGY);
        if (wr === ERR_NOT_IN_RANGE) { go(creep, container, 1, 5); return; }
        if (wr === OK) return;
        if (wr === ERR_NOT_ENOUGH_RESOURCES) creep.memory.retargetAt = Game.time; // allow quick retarget
      } else {
        creep.memory.retargetAt = Game.time;
      }
    }

    // Tombstones / ruins
    var grave = creep.pos.findClosestByPath(FIND_TOMBSTONES, {
                  filter: function(t){ return (t.store[RESOURCE_ENERGY] || 0) > 0; }
                }) ||
                creep.pos.findClosestByPath(FIND_RUINS, {
                  filter: function(r){ return (r.store[RESOURCE_ENERGY] || 0) > 0; }
                });
    if (grave) {
      var gw = creep.withdraw(grave, RESOURCE_ENERGY);
      if (gw === ERR_NOT_IN_RANGE) { go(creep, grave, 1, 5); }
      return;
    }

    // Any dropped energy (>=50) as a last-ditch pickup
    var dropped = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
      filter: function(r) { return r.resourceType === RESOURCE_ENERGY && r.amount >= 50; }
    });
    if (dropped) {
      if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) go(creep, dropped, 1, 5);
      return;
    }

    // Final fallback: storage/terminal
    var storeLike = (room.storage && room.storage.store[RESOURCE_ENERGY] > 0) ? room.storage
                  : (room.terminal && room.terminal.store[RESOURCE_ENERGY] > 0) ? room.terminal
                  : null;
    if (storeLike) {
      var sr = creep.withdraw(storeLike, RESOURCE_ENERGY);
      if (sr === ERR_NOT_IN_RANGE) { go(creep, storeLike, 1, 5); }
      return;
    }

    // Idle near anchor for usefulness next tick
    var anchor = room.storage || creep.pos.findClosestByRange(FIND_MY_SPAWNS);
    if (anchor && !creep.pos.inRangeTo(anchor, 3)) go(creep, anchor, 3, 10);
  },

  // -----------------------------
  // Delivery (internal)
  // -----------------------------
  deliverEnergy: function(creep) {
    var target = selectDropoffTarget(creep);
    if (!target) {
      var anchor = creep.room.storage || creep.pos.findClosestByRange(FIND_MY_SPAWNS);
      if (anchor && !creep.pos.inRangeTo(anchor, 3)) go(creep, anchor, 3, 10);
      return;
    }

    var tr = creep.transfer(target, RESOURCE_ENERGY);
    if (tr === ERR_NOT_IN_RANGE) { go(creep, target, 1, 5); return; }
    if (tr === OK && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.transferring = false;
    }
  }
};

module.exports = TaskCourier;
