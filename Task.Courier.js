// Task.Courier.cpu.es5.js
// Dynamic picker (no static container assignment), CPU-trimmed & ES5-safe.
//
// Key savings:
// - Per-room, once-per-tick cache of containers & "best" source container
// - Avoid PathFinder: prefer findInRange / findClosestByRange over findClosestByPath
// - Sticky targets + cooldowns to prevent thrashing
// - Limited scans for tombstones/ruins only when needed
//
// Optional dep: BeeToolbox.BeeTravel(creep, target, {range, reusePath})

'use strict';

var BeeToolbox = require('BeeToolbox');

// -----------------------------
// Tunables
// -----------------------------
var RETARGET_COOLDOWN = 10;       // ticks before switching containers
var DROPPED_NEAR_CONTAINER_R = 2; // near the source-container
var DROPPED_ALONG_ROUTE_R = 2;    // opportunistic pickup radius
var DROPPED_BIG_MIN = 150;        // big dropped energy threshold
var CONTAINER_MIN = 50;           // ignore tiny trickles in containers
var GRAVE_SCAN_COOLDOWN = 20;     // room-level cooldown for tombstone/ruin scans

// -----------------------------
// Per-tick room cache
// -----------------------------
if (!global.__COURIER) global.__COURIER = { tick: -1, rooms: {} };

function _roomCache(room) {
  var G = global.__COURIER;
  if (G.tick !== Game.time) {
    G.tick = Game.time;
    G.rooms = {};
  }
  var R = G.rooms[room.name];
  if (R) return R;

  // Build fresh cache once per room this tick
  var containers = room.find(FIND_STRUCTURES, {
    filter: function (s) { return s.structureType === STRUCTURE_CONTAINER; }
  });

  var srcIds = [];         // container ids adjacent to sources
  var otherIds = [];       // other container ids
  var bestId = null;       // highest-energy source-adjacent container
  var bestEnergy = -1;

  for (var i = 0; i < containers.length; i++) {
    var c = containers[i];
    var isSrc = c.pos.findInRange(FIND_SOURCES, 1).length > 0;
    var energy = (c.store && c.store[RESOURCE_ENERGY]) || 0;

    if (isSrc) {
      srcIds.push(c.id);
      if (energy > bestEnergy) {
        bestEnergy = energy;
        bestId = c.id;
      }
    } else {
      otherIds.push(c.id);
    }
  }

  R = {
    srcIds: srcIds,
    otherIds: otherIds,
    bestSrcId: bestId,
    bestSrcEnergy: bestEnergy,
    nextGraveScanAt: (Game.time + 1), // can be pulled forward when needed
    graves: [] // tombstones/ruins with energy (optional; lazily filled)
  };
  G.rooms[room.name] = R;
  return R;
}

function _idsToObjects(ids) {
  var out = [];
  for (var i = 0; i < ids.length; i++) {
    var o = Game.getObjectById(ids[i]);
    if (o) out.push(o);
  }
  return out;
}

// -----------------------------
// Small helpers (ES5-safe)
// -----------------------------
// -----------------------------
// Movement helper (Traveler-first)
// -----------------------------
function go(creep, dest, range, reuse) {
  range = (range != null) ? range : 1;
  reuse = (reuse != null) ? reuse : 40; // higher reuse to cut pathing CPU

  // Traveler always preferred
  if (creep.travelTo) {
    var tOpts = {
      range: range,
      reusePath: reuse,
      ignoreCreeps: false,   // let Traveler traffic manager do its thing
      stuckValue: 2,
      repath: 0.05,
      maxOps: 4000
    };
    // Allow BeeToolbox to inject a custom roomCallback if it exists
    if (BeeToolbox && BeeToolbox.roomCallback) {
      tOpts.roomCallback = BeeToolbox.roomCallback;
    }
    creep.travelTo((dest.pos || dest), tOpts);
    return;
  }

  // Fallback — only if Traveler somehow missing
  if (creep.pos.getRangeTo(dest) > range) {
    creep.moveTo(dest, { reusePath: reuse, maxOps: 2000 });
  }
}

function isGoodContainer(c) {
  return c && c.structureType === STRUCTURE_CONTAINER &&
         c.store && ((c.store[RESOURCE_ENERGY] | 0) >= CONTAINER_MIN);
}

function _closestByRange(pos, arr) {
  var best = null, bestD = 1e9;
  for (var i = 0; i < arr.length; i++) {
    var o = arr[i];
    var d = pos.getRangeTo(o);
    if (d < bestD) { bestD = d; best = o; }
  }
  return best;
}

function _selectDropoffTarget(creep) {
  var room = creep.room;
  var caps = BeeToolbox.getRoomCapabilities(room);
  var tier = caps ? caps.tier : 'early';
  // Early rooms or colonies without storage focus on feeding spawn/extension buffers first.
  var preferSpawnFirst = (tier === 'early') || !(caps && caps.hasStorage);

  var spawnTargets = room.find(FIND_MY_STRUCTURES, {
    filter: function (s) {
      if (!s.store) return false;
      if (s.structureType !== STRUCTURE_SPAWN && s.structureType !== STRUCTURE_EXTENSION) return false;
      return (s.store.getFreeCapacity(RESOURCE_ENERGY) | 0) > 0;
    }
  });

  if (preferSpawnFirst && spawnTargets.length) {
    return _closestByRange(creep.pos, spawnTargets);
  }

  var storage = null;
  if (caps && caps.storageId) {
    storage = Game.getObjectById(caps.storageId);
  }
  if (!storage && room.storage) storage = room.storage;
  if (storage && storage.store && (storage.store.getFreeCapacity(RESOURCE_ENERGY) | 0) > 0) {
    // Developing rooms keep storage topped off until a healthy reserve accumulates.
    var storageHungry = !caps || caps.storageEnergy < 40000;
    if (!preferSpawnFirst || !spawnTargets.length || storageHungry) {
      return storage;
    }
  }

  if (caps && caps.hasTerminal) {
    var terminal = caps.terminalId ? Game.getObjectById(caps.terminalId) : room.terminal;
    if (terminal && terminal.store && (terminal.store.getFreeCapacity(RESOURCE_ENERGY) | 0) > 0) {
      // Late-game economies dump excess energy into the terminal once storage is saturated.
      var storageNearlyFull = storage && storage.store && (storage.store.getFreeCapacity(RESOURCE_ENERGY) | 0) < 500;
      if (tier === 'late' || storageNearlyFull) {
        return terminal;
      }
    }
  }

  var rc = _roomCache(room);
  var others = _idsToObjects(rc.otherIds);
  var candidates = [];
  for (var i = 0; i < others.length; i++) {
    var s = others[i];
    if ((s.store.getFreeCapacity(RESOURCE_ENERGY) | 0) > 0) candidates.push(s);
  }
  if (candidates.length) return _closestByRange(creep.pos, candidates);

  return null;
}

function _clearlyBetter(best, current) {
  var be = (best && best.store && best.store[RESOURCE_ENERGY]) || 0;
  var ce = (current && current.store && current.store[RESOURCE_ENERGY]) || 0;
  // Switch if 25% more or +200 absolute
  return be >= ce * 1.25 || (be - ce) >= 200;
}

// -----------------------------
// Main role
// -----------------------------
var TaskCourier = {
  run: function (creep) {
    // State bootstrap
    if (creep.memory.transferring && creep.store[RESOURCE_ENERGY] === 0) { creep.memory.transferring = false; }
    if (!creep.memory.transferring && creep.store.getFreeCapacity() === 0) { creep.memory.transferring = true; }

    // Sticky fields
    if (creep.memory.pickupContainerId === undefined) creep.memory.pickupContainerId = null;
    if (creep.memory.retargetAt === undefined) creep.memory.retargetAt = 0;
    if (creep.memory.dropoffId === undefined) creep.memory.dropoffId = null;

    if (creep.memory.transferring) {
      TaskCourier.deliverEnergy(creep);
    } else {
      TaskCourier.collectEnergy(creep);
    }
  },

  // -----------------------------
  // Energy collection
  // -----------------------------
  collectEnergy: function (creep) {
    var room = creep.room;
    var now = Game.time | 0;
    var rc = _roomCache(room);

    // Sticky container (use cached best if ours is bad/expired)
    var container = Game.getObjectById(creep.memory.pickupContainerId);
    if (!isGoodContainer(container) || now >= (creep.memory.retargetAt | 0)) {
      // Use cached "best source" first; if empty, scan all source containers from cache
      var best = Game.getObjectById(rc.bestSrcId);
      if (!isGoodContainer(best)) {
        var srcObjs = _idsToObjects(rc.srcIds);
        var bestEnergy = -1, bestObj = null;
        for (var i = 0; i < srcObjs.length; i++) {
          var c = srcObjs[i];
          var e = (c.store && c.store[RESOURCE_ENERGY]) || 0;
          if (e >= CONTAINER_MIN && e > bestEnergy) { bestEnergy = e; bestObj = c; }
        }
        best = bestObj;
      }
      if (!container || (best && container.id !== best.id && _clearlyBetter(best, container))) {
        container = best || null;
        creep.memory.pickupContainerId = container ? container.id : null;
        creep.memory.retargetAt = now + RETARGET_COOLDOWN;
      }
    }

    // Opportunistic: big pile near us
    var nearby = creep.pos.findInRange(FIND_DROPPED_RESOURCES, DROPPED_ALONG_ROUTE_R, {
      filter: function (r) { return r.resourceType === RESOURCE_ENERGY && (r.amount | 0) >= DROPPED_BIG_MIN; }
    });
    if (nearby && nearby.length) {
      var pile = _closestByRange(creep.pos, nearby);
      if (creep.pickup(pile) === ERR_NOT_IN_RANGE) go(creep, pile, 1, 20);
      return;
    }

    // If we have a source container: try drops near it first, then withdraw
    if (container) {
      var drops = container.pos.findInRange(FIND_DROPPED_RESOURCES, DROPPED_NEAR_CONTAINER_R, {
        filter: function (r) { return r.resourceType === RESOURCE_ENERGY && (r.amount | 0) > 0; }
      });
      if (drops.length) {
        var bestDrop = _closestByRange(creep.pos, drops);
        var pr = creep.pickup(bestDrop);
        if (pr === ERR_NOT_IN_RANGE) { go(creep, bestDrop, 1, 20); return; }
        if (pr === OK && creep.store.getFreeCapacity() === 0) { creep.memory.transferring = true; return; }
      }

      var energyIn = (container.store && container.store[RESOURCE_ENERGY]) | 0;
      if (energyIn > 0) {
        var wr = creep.withdraw(container, RESOURCE_ENERGY);
        if (wr === ERR_NOT_IN_RANGE) { go(creep, container, 1, 40); return; }
        if (wr === OK) { if (creep.store.getFreeCapacity() === 0) creep.memory.transferring = true; return; }
        if (wr === ERR_NOT_ENOUGH_RESOURCES) creep.memory.retargetAt = Game.time; // allow quick retarget
      } else {
        creep.memory.retargetAt = Game.time;
      }
    }

    // Optional: graves/ruins scan (only if container path didn't work, and on cooldown)
    if ((rc.nextGraveScanAt | 0) <= Game.time) {
      rc.nextGraveScanAt = Game.time + GRAVE_SCAN_COOLDOWN;
      var graves = room.find(FIND_TOMBSTONES, {
        filter: function (t) { return ((t.store[RESOURCE_ENERGY] | 0) > 0); }
      });
      var ruins = room.find(FIND_RUINS, {
        filter: function (r) { return ((r.store[RESOURCE_ENERGY] | 0) > 0); }
      });
      rc.graves = graves.concat(ruins);
    }

    if (rc.graves && rc.graves.length) {
      var grave = _closestByRange(creep.pos, rc.graves);
      if (grave) {
        var gw = creep.withdraw(grave, RESOURCE_ENERGY);
        if (gw === ERR_NOT_IN_RANGE) { go(creep, grave, 1, 20); }
        return;
      }
    }

    // Any nearby dropped (>=50) as last resort
    var dropped = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
      filter: function (r) { return r.resourceType === RESOURCE_ENERGY && (r.amount | 0) >= 50; }
    });
    if (dropped) {
      if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) go(creep, dropped, 1, 20);
      return;
    }

    // Final fallback: storage/terminal
    var storeLike = (room.storage && (room.storage.store[RESOURCE_ENERGY] | 0) > 0) ? room.storage
                  : (room.terminal && (room.terminal.store[RESOURCE_ENERGY] | 0) > 0) ? room.terminal
                  : null;
    if (storeLike) {
      var sr = creep.withdraw(storeLike, RESOURCE_ENERGY);
      if (sr === ERR_NOT_IN_RANGE) { go(creep, storeLike, 1, 40); }
      return;
    }

    // Idle near anchor
    var anchor = room.storage || creep.pos.findClosestByRange(FIND_MY_SPAWNS);
    if (anchor && !creep.pos.inRangeTo(anchor, 3)) go(creep, anchor, 3, 40);
  },

  // -----------------------------
  // Delivery
  // -----------------------------
  deliverEnergy: function (creep) {
    // Sticky dropoff (don’t re-select every tick)
    var target = Game.getObjectById(creep.memory.dropoffId);
    if (!target || ((target.store && (target.store.getFreeCapacity(RESOURCE_ENERGY) | 0) === 0))) {
      target = _selectDropoffTarget(creep);
      creep.memory.dropoffId = target ? target.id : null;
    }
    if (!target) {
      var anchor = creep.room.storage || creep.pos.findClosestByRange(FIND_MY_SPAWNS);
      if (anchor && !creep.pos.inRangeTo(anchor, 3)) go(creep, anchor, 3, 40);
      return;
    }

    var tr = creep.transfer(target, RESOURCE_ENERGY);
    if (tr === ERR_NOT_IN_RANGE) { go(creep, target, 1, 40); return; }
    if (tr === OK && (creep.store[RESOURCE_ENERGY] | 0) === 0) {
      creep.memory.transferring = false;
      creep.memory.dropoffId = null; // free to choose best next time
    }
  }
};

module.exports = TaskCourier;
