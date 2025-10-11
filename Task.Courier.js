// Task.Courier.cpu.es5.js
// Dynamic picker, CPU-trimmed & ES5-safe.
// Priority: ruins/tombstones → big dropped → source-containers → re-check graves → misc dropped → storage.
// Optimizations:
// - Predictive Intent Buffer (PIB): plan withdraw/transfer for next tick when you'll be adjacent after 1 move.
// - After any successful action, immediately step toward the next target in the same tick.
// Optional dep: Traveler (creep.travelTo) + BeeToolbox.roomCallback

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

  var srcIds = [];
  var otherIds = [];
  var bestId = null;
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
    nextGraveScanAt: Game.time, // allow immediate first scan this tick
    graves: [] // tombstones/ruins with energy (lazily maintained)
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
function go(creep, dest, range, reuse) {
  range = (range != null) ? range : 1;
  reuse = (reuse != null) ? reuse : 40;

  // Traveler preferred
  if (creep.travelTo) {
    var tOpts = {
      range: range,
      reusePath: reuse,
      ignoreCreeps: false,
      stuckValue: 2,
      repath: 0.05,
      maxOps: 4000
    };
    if (BeeToolbox && BeeToolbox.roomCallback) tOpts.roomCallback = BeeToolbox.roomCallback;
    creep.travelTo((dest.pos || dest), tOpts);
    return;
  }

  // Fallback
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
  // Prefer storage, then terminal
  if (room.storage && ((room.storage.store.getFreeCapacity(RESOURCE_ENERGY) | 0) > 0)) return room.storage;
  if (room.terminal && ((room.terminal.store.getFreeCapacity(RESOURCE_ENERGY) | 0) > 0)) return room.terminal;

  // Nearest non-source container with free capacity
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
// Predictive Intent Buffer (PIB)
// -----------------------------
function _pibSet(creep, type, targetId, nextTargetId) {
  // type: 'withdraw' | 'transfer'
  creep.memory.pib = { t: type, id: targetId, next: nextTargetId, setAt: Game.time | 0 };
}

function _pibClear(creep) { creep.memory.pib = null; }

function _pibTry(creep) {
  var pib = creep.memory.pib;
  if (!pib) return false;

  var target = Game.getObjectById(pib.id);
  if (!target) { _pibClear(creep); return false; }

  // Only fire if in range now; otherwise abandon
  if (creep.pos.getRangeTo(target) > 1) { _pibClear(creep); return false; }

  var rc;
  if (pib.t === 'withdraw') rc = creep.withdraw(target, RESOURCE_ENERGY);
  else if (pib.t === 'transfer') rc = creep.transfer(target, RESOURCE_ENERGY);
  else rc = ERR_INVALID_ARGS;

  if (rc === OK) {
    if (pib.t === 'withdraw' && creep.store.getFreeCapacity() === 0) creep.memory.transferring = true;
    if (pib.t === 'transfer' && (creep.store[RESOURCE_ENERGY] | 0) === 0) creep.memory.transferring = false;

    // Immediately step toward the next target this tick
    var next = pib.next ? Game.getObjectById(pib.next) : null;
    if (next) go(creep, (next.pos || next), 1, 10);
  }
  // On errors like NOT_ENOUGH_RESOURCES / FULL we just drop the plan
  _pibClear(creep);
  return true; // consumed planned action this tick
}

// -----------------------------
// Ruins/Tombstones cache helpers
// -----------------------------
function _refreshGraves(rc, room, force) {
  if (force || (rc.nextGraveScanAt | 0) <= Game.time) {
    rc.nextGraveScanAt = Game.time + GRAVE_SCAN_COOLDOWN;
    var graves = room.find(FIND_TOMBSTONES, {
      filter: function (t) { return (t.store && ((t.store[RESOURCE_ENERGY] | 0) > 0)); }
    });
    var ruins = room.find(FIND_RUINS, {
      filter: function (r) { return (r.store && ((r.store[RESOURCE_ENERGY] | 0) > 0)); }
    });
    rc.graves = graves.concat(ruins);
  } else {
    // prune empties
    var kept = [];
    for (var i = 0; i < rc.graves.length; i++) {
      var g = rc.graves[i];
      if (g && g.store && ((g.store[RESOURCE_ENERGY] | 0) > 0)) kept.push(g);
    }
    rc.graves = kept;
  }
}

// Try graves first; if we withdraw OK, immediately step toward dropoff this tick.
// If distance == 2, pre-arm a withdraw for next tick via PIB, then move.
function _takeFromGraveFirst(creep, rc, nextDropoff) {
  if (!rc.graves || rc.graves.length === 0) _refreshGraves(rc, creep.room, true);
  else _refreshGraves(rc, creep.room, false);

  if (rc.graves && rc.graves.length) {
    var grave = _closestByRange(creep.pos, rc.graves);
    if (!grave) return false;

    var dist = creep.pos.getRangeTo(grave);

    if (dist >= 2) {
      if (dist === 2 && nextDropoff) _pibSet(creep, 'withdraw', grave.id, nextDropoff.id);
      go(creep, grave, 1, 20);
      return true;
    }

    // dist == 1: act now, then move toward dropoff
    var gw = creep.withdraw(grave, RESOURCE_ENERGY);
    if (gw === ERR_NOT_IN_RANGE) { go(creep, grave, 1, 20); return true; }
    if (gw === OK) {
      if (creep.store.getFreeCapacity() === 0) creep.memory.transferring = true;
      if (nextDropoff) go(creep, nextDropoff, 1, 10);
      return true;
    }
    if (gw === ERR_NOT_ENOUGH_RESOURCES) {
      // prune the one we just found empty
      var pruned = [];
      for (var i = 0; i < rc.graves.length; i++) if (rc.graves[i].id !== grave.id) pruned.push(rc.graves[i]);
      rc.graves = pruned;
    }
  }
  return false;
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

    // 🔮 If we planned an action last tick and we're now adjacent, do it before anything else.
    if (_pibTry(creep)) return;

    if (creep.memory.transferring) {
      TaskCourier.deliverEnergy(creep);
    } else {
      TaskCourier.collectEnergy(creep);
    }
  },

  // -----------------------------
  // Energy collection (ruins first + predictive)
  // -----------------------------
  collectEnergy: function (creep) {
    var room = creep.room;
    var now = Game.time | 0;
    var rc = _roomCache(room);
    var dropoffHint = _selectDropoffTarget(creep);

    // 1) Ruins/Tombstones FIRST (pass dropoff so we can move after withdraw or plan PIB)
    if (_takeFromGraveFirst(creep, rc, dropoffHint)) return;

    // 2) Opportunistic big pile near us
    var nearby = creep.pos.findInRange(FIND_DROPPED_RESOURCES, DROPPED_ALONG_ROUTE_R, {
      filter: function (r) { return r.resourceType === RESOURCE_ENERGY && (r.amount | 0) >= DROPPED_BIG_MIN; }
    });
    if (nearby && nearby.length) {
      var pile = _closestByRange(creep.pos, nearby);
      var d = creep.pos.getRangeTo(pile);
      if (d >= 2) { if (d === 2 && dropoffHint) _pibSet(creep, 'pickup', pile.id, dropoffHint.id); go(creep, pile, 1, 20); return; }
      if (creep.pickup(pile) === ERR_NOT_IN_RANGE) { go(creep, pile, 1, 20); return; }
      if (creep.store.getFreeCapacity() === 0) creep.memory.transferring = true;
      if (dropoffHint) go(creep, dropoffHint, 1, 10);
      return;
    }

    // 3) Sticky best source-adjacent container
    var container = Game.getObjectById(creep.memory.pickupContainerId);
    if (!isGoodContainer(container) || now >= (creep.memory.retargetAt | 0)) {
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
        _pibClear(creep); // target changed; clear any stale plan
      }
    }

    // Try drops near that container first, then withdraw
    if (container) {
      var drops = container.pos.findInRange(FIND_DROPPED_RESOURCES, DROPPED_NEAR_CONTAINER_R, {
        filter: function (r) { return r.resourceType === RESOURCE_ENERGY && (r.amount | 0) > 0; }
      });
      if (drops.length) {
        var bestDrop = _closestByRange(creep.pos, drops);
        var distD = creep.pos.getRangeTo(bestDrop);
        if (distD >= 2) {
          if (distD === 2 && dropoffHint) _pibSet(creep, 'pickup', bestDrop.id, dropoffHint.id);
          go(creep, bestDrop, 1, 20);
          return;
        }
        var pr = creep.pickup(bestDrop);
        if (pr === ERR_NOT_IN_RANGE) { go(creep, bestDrop, 1, 20); return; }
        if (pr === OK) {
          if (creep.store.getFreeCapacity() === 0) creep.memory.transferring = true;
          if (dropoffHint) go(creep, dropoffHint, 1, 10);
          return;
        }
      }

      var energyIn = (container.store && container.store[RESOURCE_ENERGY]) | 0;
      if (energyIn > 0) {
        var distC = creep.pos.getRangeTo(container);
        if (distC >= 2) {
          if (distC === 2 && dropoffHint) _pibSet(creep, 'withdraw', container.id, dropoffHint.id);
          go(creep, container, 1, 40);
          return;
        }
        var wr = creep.withdraw(container, RESOURCE_ENERGY);
        if (wr === ERR_NOT_IN_RANGE) { go(creep, container, 1, 40); return; }
        if (wr === OK) {
          if (creep.store.getFreeCapacity() === 0) creep.memory.transferring = true;
          if (dropoffHint) go(creep, dropoffHint, 1, 10);
          return;
        }
        if (wr === ERR_NOT_ENOUGH_RESOURCES) creep.memory.retargetAt = Game.time;
      } else {
        creep.memory.retargetAt = Game.time;
      }
    }

    // 4) Re-check graves in case something spawned/expired mid-move
    if (_takeFromGraveFirst(creep, rc, dropoffHint)) return;

    // 5) Any nearby dropped (>=50) as last resort
    var dropped = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
      filter: function (r) { return r.resourceType === RESOURCE_ENERGY && (r.amount | 0) >= 50; }
    });
    if (dropped) {
      var dd = creep.pos.getRangeTo(dropped);
      if (dd >= 2) {
        if (dd === 2 && dropoffHint) _pibSet(creep, 'pickup', dropped.id, dropoffHint.id);
        go(creep, dropped, 1, 20);
        return;
      }
      if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) { go(creep, dropped, 1, 20); return; }
      if (dropoffHint) go(creep, dropoffHint, 1, 10);
      return;
    }

    // 6) Final fallback: storage/terminal
    var storeLike = (room.storage && (room.storage.store[RESOURCE_ENERGY] | 0) > 0) ? room.storage
                  : (room.terminal && (room.terminal.store[RESOURCE_ENERGY] | 0) > 0) ? room.terminal
                  : null;
    if (storeLike) {
      var ds = creep.pos.getRangeTo(storeLike);
      if (ds >= 2) { go(creep, storeLike, 1, 40); return; }
      var sr = creep.withdraw(storeLike, RESOURCE_ENERGY);
      if (sr === ERR_NOT_IN_RANGE) { go(creep, storeLike, 1, 40); }
      return;
    }

    // Idle near anchor
    var anchor = room.storage || creep.pos.findClosestByRange(FIND_MY_SPAWNS);
    if (anchor && !creep.pos.inRangeTo(anchor, 3)) go(creep, anchor, 3, 40);
  },

  // -----------------------------
  // Delivery (predictive + post-action move)
  // -----------------------------
  deliverEnergy: function (creep) {
    // Sticky dropoff
    var target = Game.getObjectById(creep.memory.dropoffId);
    if (!target || ((target.store && (target.store.getFreeCapacity(RESOURCE_ENERGY) | 0) === 0))) {
      target = _selectDropoffTarget(creep);
      creep.memory.dropoffId = target ? target.id : null;
      _pibClear(creep); // target changed
    }
    if (!target) {
      var anchor = creep.room.storage || creep.pos.findClosestByRange(FIND_MY_SPAWNS);
      if (anchor && !creep.pos.inRangeTo(anchor, 3)) go(creep, anchor, 3, 40);
      return;
    }

    // Predictive planning when 2 tiles away
    var dist = creep.pos.getRangeTo(target);
    if (dist >= 2) {
      // Plan next transfer if exactly 2 away, and choose a likely next pickup
      if (dist === 2) {
        var rc = _roomCache(creep.room); _refreshGraves(rc, creep.room, false);
        var nextPickup = (rc.graves && rc.graves.length) ? _closestByRange(creep.pos, rc.graves)
                        : Game.getObjectById(rc.bestSrcId);
        if (nextPickup) _pibSet(creep, 'transfer', target.id, nextPickup.id);
      }
      go(creep, target, 1, 40);
      return;
    }

    // Adjacent: transfer now, then step toward next pickup immediately
    var tr = creep.transfer(target, RESOURCE_ENERGY);
    if (tr === ERR_NOT_IN_RANGE) { go(creep, target, 1, 40); return; }
    if (tr === OK) {
      var rc2 = _roomCache(creep.room); _refreshGraves(rc2, creep.room, false);
      var next = (rc2.graves && rc2.graves.length) ? _closestByRange(creep.pos, rc2.graves)
               : Game.getObjectById(rc2.bestSrcId);
      if (next) go(creep, (next.pos || next), 1, 10);
      if ((creep.store[RESOURCE_ENERGY] | 0) === 0) {
        creep.memory.transferring = false;
        creep.memory.dropoffId = null;
      }
      return;
    }
  }
};

module.exports = TaskCourier;
