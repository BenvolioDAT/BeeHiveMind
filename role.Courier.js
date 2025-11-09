// role.Courier – Energy hauler (ES5-safe) with SAY + DRAW breadcrumbs
// Collect priority: Source CONTAINER -> big DROPS (en route) -> drops NEAR container -> GRAVES/RUINS -> misc DROPS -> STORAGE/TERMINAL
// Deliver priority: SPAWNS/EXTENSIONS -> TOWERS (<= pct) -> STORAGE
//
// Shares PIB + same-tick reservation scheme with Queen to avoid target dogpiles.

var BeeToolbox = require('BeeToolbox');

// ============================
// Tunables
// ============================
var CFG = Object.freeze({
  // Pathing
  PATH_REUSE: 40,
  MAX_OPS_MOVE: 2000,
  TRAVEL_MAX_OPS: 4000,

  // Targeting cadences
  RETARGET_COOLDOWN: 10,          // ticks before switching pickup container
  GRAVE_SCAN_COOLDOWN: 20,        // room-level cooldown for tombstone/ruin scans
  BETTER_CONTAINER_DELTA: 150,    // how much more energy makes a source container "clearly better"

  // Thresholds / radii
  CONTAINER_MIN: 50,              // ignore tiny trickles in containers
  DROPPED_BIG_MIN: 150,           // opportunistic pickup threshold
  DROPPED_NEAR_CONTAINER_R: 2,    // radius around source container
  DROPPED_ALONG_ROUTE_R: 2,       // radius around the creep while traveling

  // Towers
  TOWER_REFILL_AT_OR_BELOW: 0.70, // refill towers when <= 70%

  // Debug UI
  DEBUG_SAY: false,                // creep.say breadcrumbs
  DEBUG_DRAW: true,               // RoomVisual lines + labels
  DRAW: {
    WD_COLOR: "#6ec1ff",          // withdraw lines
    FILL_COLOR: "#6effa1",        // delivery lines
    DROP_COLOR: "#ffe66e",        // dropped energy
    GRAVE_COLOR: "#ffb0e0",       // tombstones/ruins
    IDLE_COLOR: "#bfbfbf",        // idle
    WIDTH: 0.12,
    OPACITY: 0.45,
    FONT: 0.6
  }
});

// ============================
// Per-tick room cache
// ============================
if (!global.__COURIER) global.__COURIER = { tick: -1, rooms: {} };

function _roomCache(room) {
  var G = global.__COURIER;
  if (G.tick !== Game.time) {
    G.tick = Game.time;
    G.rooms = {};
  }
  var R = G.rooms[room.name];
  if (R) return R;

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
    srcIds: srcIds,                 // ids of source-adjacent containers
    otherIds: otherIds,             // ids of non-source containers (rarely used here)
    bestSrcId: bestId,
    bestSrcEnergy: bestEnergy,
    nextGraveScanAt: (Game.time + 1),
    graves: []                      // tombstones/ruins with energy
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

// ============================
// Movement + tiny utils (ES5-safe)
// ============================
function go(creep, dest, range, reuse) {
  range = (range != null) ? range : 1;
  reuse = (reuse != null) ? reuse : CFG.PATH_REUSE;

  // Traveler first (preferred)
  if (creep.travelTo) {
    var tOpts = {
      range: range,
      reusePath: reuse,
      ignoreCreeps: false,
      stuckValue: 2,
      repath: 0.05,
      maxOps: CFG.TRAVEL_MAX_OPS
    };
    if (BeeToolbox && BeeToolbox.roomCallback) tOpts.roomCallback = BeeToolbox.roomCallback;
    creep.travelTo((dest.pos || dest), tOpts);
    return;
  }

  // Fallback
  if (creep.pos.getRangeTo(dest) > range) {
    creep.moveTo(dest, { reusePath: reuse, maxOps: CFG.MAX_OPS_MOVE });
  }
}

function debugSay(creep, msg) {
  if (CFG.DEBUG_SAY) creep.say(msg, true);
}

function debugDraw(creep, target, color, label) {
  if (!CFG.DEBUG_DRAW || !creep || !target) return;
  var room = creep.room;
  if (!room || !room.visual) return;

  var tpos = target.pos || target.position;
  if (!tpos || tpos.roomName !== room.name) return;

  try {
    room.visual.line(creep.pos, tpos, {
      color: color,
      width: CFG.DRAW.WIDTH,
      opacity: CFG.DRAW.OPACITY,
      lineStyle: "solid"
    });
    if (label) {
      room.visual.text(label, tpos.x, tpos.y - 0.3, {
        color: color,
        opacity: CFG.DRAW.OPACITY,
        font: CFG.DRAW.FONT,
        align: "center"
      });
    }
  } catch (e) {}
}

function isGoodContainer(c) {
  return c && c.structureType === STRUCTURE_CONTAINER &&
         c.store && ((c.store[RESOURCE_ENERGY] | 0) >= CFG.CONTAINER_MIN);
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

function _energyOf(c) {
  return (c && c.store && c.store[RESOURCE_ENERGY]) | 0;
}

function _clearlyBetter(a, b) {
  var ae = _energyOf(a);
  var be = _energyOf(b);
  return ae > (be + CFG.BETTER_CONTAINER_DELTA);
}

// ============================
// PIB + same-tick reservations (shared with Queen)
// ============================
function _qrMap() {
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

// Effective free capacity that respects reservations
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

  if (rc === ERR_NOT_IN_RANGE) { go(creep, target, 1, CFG.PATH_REUSE); return rc; }

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

// ============================
// Targeting helpers for DELIVERY
// ============================
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
      if (pct > CFG.TOWER_REFILL_AT_OR_BELOW) return false; // only if low enough
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

// ============================
// Main role
// ============================
var roleCourier = {
  role: 'Courier',
  run: function (creep) {
    // State bootstrap
    if (creep.memory.transferring && creep.store[RESOURCE_ENERGY] === 0) { creep.memory.transferring = false; }
    if (!creep.memory.transferring && creep.store.getFreeCapacity() === 0) { creep.memory.transferring = true; }

    // Sticky fields
    if (creep.memory.pickupContainerId === undefined) creep.memory.pickupContainerId = null;
    if (creep.memory.retargetAt === undefined) creep.memory.retargetAt = 0;
    if (creep.memory.dropoffId === undefined) creep.memory.dropoffId = null;

    if (creep.memory.transferring) {
      roleCourier.deliverEnergy(creep);
    } else {
      roleCourier.collectEnergy(creep);
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
          if (e >= CFG.CONTAINER_MIN && e > bestEnergy) { bestEnergy = e; bestObj = c; }
        }
        best = bestObj;
      }
      if (!container || (best && container.id !== best.id && _clearlyBetter(best, container))) {
        container = best || null;
        creep.memory.pickupContainerId = container ? container.id : null;
        creep.memory.retargetAt = now + CFG.RETARGET_COOLDOWN;
      }
    }

    // Opportunistic: big pile near us (en route)
    var nearby = creep.pos.findInRange(FIND_DROPPED_RESOURCES, CFG.DROPPED_ALONG_ROUTE_R, {
      filter: function (r) { return r.resourceType === RESOURCE_ENERGY && (r.amount | 0) >= CFG.DROPPED_BIG_MIN; }
    });
    if (nearby && nearby.length) {
      var pile = _closestByRange(creep.pos, nearby);
      debugSay(creep, '↘️Drop');
      debugDraw(creep, pile, CFG.DRAW.DROP_COLOR, "DROP*");
      if (creep.pickup(pile) === ERR_NOT_IN_RANGE) go(creep, pile, 1, 20);
      return;
    }

    // If we have a source container: try drops near it first, then withdraw
    if (container) {
      var drops = container.pos.findInRange(FIND_DROPPED_RESOURCES, CFG.DROPPED_NEAR_CONTAINER_R, {
        filter: function (r) { return r.resourceType === RESOURCE_ENERGY && (r.amount | 0) > 0; }
      });
      if (drops.length) {
        var bestDrop = _closestByRange(creep.pos, drops);
        debugSay(creep, '↘️Drop');
        debugDraw(creep, bestDrop, CFG.DRAW.DROP_COLOR, "DROP");
        var pr = creep.pickup(bestDrop);
        if (pr === ERR_NOT_IN_RANGE) { go(creep, bestDrop, 1, 20); return; }
        if (pr === OK && creep.store.getFreeCapacity() === 0) { creep.memory.transferring = true; return; }
      }

      var energyIn = (container.store && container.store[RESOURCE_ENERGY]) | 0;
      if (energyIn > 0) {
        debugSay(creep, '↘️Con');
        debugDraw(creep, container, CFG.DRAW.WD_COLOR, "CON");
        var wr = creep.withdraw(container, RESOURCE_ENERGY);
        if (wr === ERR_NOT_IN_RANGE) { go(creep, container, 1, CFG.PATH_REUSE); return; }
        if (wr === OK) { if (creep.store.getFreeCapacity() === 0) creep.memory.transferring = true; return; }
        if (wr === ERR_NOT_ENOUGH_RESOURCES) creep.memory.retargetAt = Game.time; // allow quick retarget
      } else {
        creep.memory.retargetAt = Game.time;
      }
    }

    // Graves/ruins scan (cooldown)
    if ((rc.nextGraveScanAt | 0) <= Game.time) {
      rc.nextGraveScanAt = Game.time + CFG.GRAVE_SCAN_COOLDOWN;
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
        debugSay(creep, '↘️Grv');
        debugDraw(creep, grave, CFG.DRAW.GRAVE_COLOR, "GRAVE");
        var gw = creep.withdraw(grave, RESOURCE_ENERGY);
        if (gw === ERR_NOT_IN_RANGE) { go(creep, grave, 1, 20); }
        return;
      }
    }

    // Any nearby dropped (>=50) as last resort before storage
    var dropped = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
      filter: function (r) { return r.resourceType === RESOURCE_ENERGY && (r.amount | 0) >= 50; }
    });
    if (dropped) {
      debugSay(creep, '↘️Drop');
      debugDraw(creep, dropped, CFG.DRAW.DROP_COLOR, "DROP");
      if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) go(creep, dropped, 1, 20);
      return;
    }

    // Final fallback: storage/terminal
    var storeLike = (room.storage && (room.storage.store[RESOURCE_ENERGY] | 0) > 0) ? room.storage
                  : (room.terminal && (room.terminal.store[RESOURCE_ENERGY] | 0) > 0) ? room.terminal
                  : null;
    if (storeLike) {
      debugSay(creep, storeLike.structureType === STRUCTURE_STORAGE ? '↘️Sto' : '↘️Term');
      debugDraw(creep, storeLike, CFG.DRAW.WD_COLOR, storeLike.structureType === STRUCTURE_STORAGE ? "STO" : "TERM");
      var sr = creep.withdraw(storeLike, RESOURCE_ENERGY);
      if (sr === ERR_NOT_IN_RANGE) { go(creep, storeLike, 1, CFG.PATH_REUSE); }
      return;
    }

    // Idle near anchor
    var anchor = room.storage || creep.pos.findClosestByRange(FIND_MY_SPAWNS) || creep.pos;
    debugSay(creep, 'IDLE');
    debugDraw(creep, (anchor.pos || anchor), CFG.DRAW.IDLE_COLOR, "IDLE");
    if (!creep.pos.inRangeTo(anchor, 3)) go(creep, anchor, 3, CFG.PATH_REUSE);
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

      if (!target) {
        var anchor = creep.room.storage || creep.pos.findClosestByRange(FIND_MY_SPAWNS) || creep.pos;
        debugSay(creep, 'IDLE');
        debugDraw(creep, (anchor.pos || anchor), CFG.DRAW.IDLE_COLOR, "IDLE");
        if (!creep.pos.inRangeTo(anchor, 3)) go(creep, anchor, 3, CFG.PATH_REUSE);
        return;
      }
      creep.memory.dropoffId = target.id;
    }

    // Reserve and deliver (so other Couriers/Queen avoid this target)
    var reserved = reserveFill(creep, target, carryAmt, RESOURCE_ENERGY);
    if (reserved > 0) {
      // Label + color by type
      var st = target.structureType;
      if (st === STRUCTURE_EXTENSION) { debugSay(creep, '→ EXT'); debugDraw(creep, target, CFG.DRAW.FILL_COLOR, "EXT"); }
      else if (st === STRUCTURE_SPAWN) { debugSay(creep, '→ SPN'); debugDraw(creep, target, CFG.DRAW.FILL_COLOR, "SPN"); }
      else if (st === STRUCTURE_TOWER) { debugSay(creep, '→ TWR'); debugDraw(creep, target, CFG.DRAW.FILL_COLOR, "TWR"); }
      else if (st === STRUCTURE_STORAGE) { debugSay(creep, '→ STO'); debugDraw(creep, target, CFG.DRAW.FILL_COLOR, "STO"); }
      else { debugSay(creep, '→ FILL'); debugDraw(creep, target, CFG.DRAW.FILL_COLOR, "FILL"); }

      var tr = transferTo(creep, target, RESOURCE_ENERGY);
      if (tr === OK && (creep.store[RESOURCE_ENERGY] | 0) === 0) {
        creep.memory.transferring = false;
        creep.memory.dropoffId = null;
      }
    } else {
      // Couldn’t reserve (no effective free). Clear sticky and try again next tick.
      creep.memory.dropoffId = null;
    }
  }
};

module.exports = roleCourier;
