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
var TOWER_REFILL_AT_OR_BELOW = 0.70; // refill towers when <= 70% energy

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
// Movement + tiny utils (ES5-safe)
// -----------------------------
function go(creep, dest, range, reuse) {
  range = (range != null) ? range : 1;
  reuse = (reuse != null) ? reuse : 40; // higher reuse to cut pathing CPU

  // Traveler first (preferred)
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

// -----------------------------
// PIB + same-tick reservations (shared global memory)
// Goal: avoid fighting the Queen or other Couriers
// -----------------------------
function _qrMap() {
  // Reuse the same structure the Queen uses:
  // Memory._queenRes = { tick, map: {targetId: amount} }
  if (!Memory._queenRes || Memory._queenRes.tick !== Game.time) {
    Memory._queenRes = { tick: Game.time, map: {} };
  }
  return Memory._queenRes.map;
}

function _reservedFor(structId) {
  var map = _qrMap();
  return map[structId] || 0;
}

function _pibSumReserved(roomName, targetId, resourceType) {
  resourceType = resourceType || RESOURCE_ENERGY;
  var root = Memory._PIB;
  if (!root || root.tick == null || !root.rooms) return 0;
  var R = root.rooms[roomName];
  if (!R || !R.fills) return 0;
  var byCreep = R.fills[targetId] || {};
  var total = 0;
  for (var cname in byCreep) {
    if (!byCreep.hasOwnProperty(cname)) continue;
    var rec = byCreep[cname];
    if (!rec || rec.res !== resourceType) continue;
    if (rec.untilTick > Game.time) total += (rec.amount | 0);
  }
  return total;
}

function _pibRoom(roomName) {
  var root = Memory._PIB;
  if (!root || root.tick !== Game.time) {
    Memory._PIB = { tick: Game.time, rooms: root && root.rooms ? root.rooms : {} };
    root = Memory._PIB;
  }
  if (!root.rooms[roomName]) root.rooms[roomName] = { fills: {} };
  return root.rooms[roomName];
}

function _pibReserveFill(creep, target, amount, resourceType) {
  if (!creep || !target || !amount) return 0;
  resourceType = resourceType || RESOURCE_ENERGY;
  var roomName = (target.pos && target.pos.roomName) || (creep.room && creep.room.name);
  if (!roomName) return 0;

  var R = _pibRoom(roomName);
  if (!R.fills[target.id]) R.fills[target.id] = {};

  var dist = 0;
  try { dist = creep.pos.getRangeTo(target); } catch (e) { dist = 5; }
  var eta = Math.max(2, (dist | 0) + 1);

  R.fills[target.id][creep.name] = {
    res: resourceType,
    amount: amount | 0,
    untilTick: Game.time + eta
  };
  return amount | 0;
}

function _pibReleaseFill(creep, target, resourceType) {
  if (!creep || !target) return;
  resourceType = resourceType || RESOURCE_ENERGY;
  var roomName = (target.pos && target.pos.roomName) || (creep.room && creep.room.name);
  if (!roomName) return;

  var root = Memory._PIB;
  if (!root || !root.rooms) return;
  var R = root.rooms[roomName];
  if (!R || !R.fills) return;
  var map = R.fills[target.id];
  if (map && map[creep.name]) delete map[creep.name];
  if (map && Object.keys(map).length === 0) delete R.fills[target.id];
}

// Effective free capacity that *respects* Queen/Courier reservations
function _effectiveFree(struct, resourceType) {
  resourceType = resourceType || RESOURCE_ENERGY;
  var freeNow = (struct.store && struct.store.getFreeCapacity(resourceType)) || 0;
  var sameTick = _reservedFor(struct.id) | 0;
  var roomName = (struct.pos && struct.pos.roomName) || (struct.room && struct.room.name);
  var pib = roomName ? (_pibSumReserved(roomName, struct.id, resourceType) | 0) : 0;
  return Math.max(0, freeNow - sameTick - pib);
}

// Reserve up to `amount` for this creep (same-tick + PIB)
function reserveFill(creep, target, amount, resourceType) {
  resourceType = resourceType || RESOURCE_ENERGY;
  var map = _qrMap();
  var free = _effectiveFree(target, resourceType);
  var want = Math.max(0, Math.min(amount | 0, free | 0));
  if (want > 0) {
    map[target.id] = (map[target.id] || 0) + want;
    creep.memory.dropoffId = target.id;
    _pibReserveFill(creep, target, want, resourceType);
  }
  return want;
}

// Transfer wrapper that releases PIB intent properly
function transferTo(creep, target, res) {
  res = res || RESOURCE_ENERGY;
  var rc = creep.transfer(target, res);

  if (rc === ERR_NOT_IN_RANGE) { go(creep, target, 1, 40); return rc; }

  if (rc === OK) {
    _pibReleaseFill(creep, target, res);
  } else if (rc === ERR_FULL) {
    _pibReleaseFill(creep, target, res);
    creep.memory.dropoffId = null;
  } else if (rc !== OK && rc !== ERR_TIRED && rc !== ERR_BUSY) {
    _pibReleaseFill(creep, target, res);
    creep.memory.dropoffId = null;
  }
  return rc;
}

// -----------------------------
// Targeting helpers for DELIVERY
// Priority: Spawns/Extensions -> Towers -> Storage (terminal excluded)
// All checks use _effectiveFree to avoid Queen
// -----------------------------
function _pickSpawnExt(creep) {
  var list = creep.room.find(FIND_STRUCTURES, {
    filter: function (s) {
      if (!s.store) return false;
      var t = s.structureType;
      if (t !== STRUCTURE_SPAWN && t !== STRUCTURE_EXTENSION) return false;
      return _effectiveFree(s, RESOURCE_ENERGY) > 0;
    }
  });
  return list.length ? _closestByRange(creep.pos, list) : null;
}

function _pickTower(creep) {
  var list = creep.room.find(FIND_STRUCTURES, {
    filter: function (s) {
      if (s.structureType !== STRUCTURE_TOWER || !s.store) return false;
      var used = (s.store.getUsedCapacity(RESOURCE_ENERGY) | 0);
      var cap  = (s.store.getCapacity(RESOURCE_ENERGY) | 0);
      if (cap <= 0) return false;
      var pct = used / cap;
      if (pct > TOWER_REFILL_AT_OR_BELOW) return false; // only if low enough
      return _effectiveFree(s, RESOURCE_ENERGY) > 0;
    }
  });
  return list.length ? _closestByRange(creep.pos, list) : null;
}

function _pickStorage(creep) {
  var st = creep.room.storage;
  if (!st || !st.store) return null;
  if (_effectiveFree(st, RESOURCE_ENERGY) <= 0) return null;
  return st;
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
  // Delivery (PIB-aware, avoids Queen conflicts)
  // -----------------------------
  deliverEnergy: function (creep) {
    var carryAmt = (creep.store.getUsedCapacity(RESOURCE_ENERGY) | 0);
    if (carryAmt <= 0) { creep.memory.transferring = false; creep.memory.dropoffId = null; return; }

    // Sticky dropoff if still valid and has effective free
    var target = Game.getObjectById(creep.memory.dropoffId);
    if (!target || _effectiveFree(target, RESOURCE_ENERGY) <= 0) {
      // Priority 1: spawns & extensions
      target = _pickSpawnExt(creep);
      // Priority 2: towers (below threshold)
      if (!target) target = _pickTower(creep);
      // Priority 3: storage (last choice)
      if (!target) target = _pickStorage(creep);

      // If nothing at all, idle near anchor
      if (!target) {
        var anchor = creep.room.storage || creep.pos.findClosestByRange(FIND_MY_SPAWNS);
        if (anchor && !creep.pos.inRangeTo(anchor, 3)) go(creep, anchor, 3, 40);
        return;
      }
      creep.memory.dropoffId = target.id;
    }

    // Reserve and deliver (so other Couriers/Queen avoid this target)
    var reserved = reserveFill(creep, target, carryAmt, RESOURCE_ENERGY);
    if (reserved > 0) {
      var tr = transferTo(creep, target, RESOURCE_ENERGY);
      if (tr === OK && (creep.store[RESOURCE_ENERGY] | 0) === 0) {
        creep.memory.transferring = false;
        creep.memory.dropoffId = null;
      }
      // If out of range or not OK, we moved or cleared reservation above.
    } else {
      // Couldn’t reserve (no effective free). Clear sticky and try again next tick.
      creep.memory.dropoffId = null;
    }
  }
};

module.exports = TaskCourier;
