// role.Trucker — Flag-driven loot hauler with Debug_say & Debug_draw (ES5-safe)
var BeeToolbox = require('BeeToolbox');

// ============================
// Debug & Tunables
// ============================
var CFG = Object.freeze({
  DEBUG_SAY: true,          // creep.say breadcrumbs
  DEBUG_DRAW: true,         // RoomVisual lines/labels/rings

  // Visual palette
  DRAW: {
    TRAVEL:   "#8ab6ff",
    LOOT:     "#ffd16e",
    RETURN:   "#6effa1",
    DEPOSIT:  "#6ee7ff",
    IDLE:     "#bfbfbf",
    FLAG:     "#ffc04d"
  },

  // Behavior
  PICKUP_FLAG_DEFAULT: "E-Pickup", // default flag name to route to
  MIN_DROPPED: 50,                 // ignore tiny crumbs (energy or other)
  SEARCH_RADIUS: 50,               // how far from flag to look
  PATH_REUSE: 20,                  // reusePath hint

  // Optional: allow non-energy resource pickups (POWER, minerals, etc.)
  ALLOW_NON_ENERGY: true,

  // Fallback park if no flag & no home (harmless; rarely used)
  PARK_POS: { x:25, y:25, roomName:"W0N0" }
});

// ============================
// Tiny debug helpers
// ============================
function _say(creep, msg) {
  if (CFG.DEBUG_SAY && creep && msg) creep.say(msg, true);
}
function _line(room, a, b, color) {
  if (!CFG.DEBUG_DRAW || !room || !a || !b) return;
  room.visual.line((a.pos || a), (b.pos || b), { color: color || "#fff", opacity: 0.6, width: 0.08 });
}
function _ring(room, pos, color) {
  if (!CFG.DEBUG_DRAW || !room || !pos) return;
  room.visual.circle((pos.pos || pos), { radius: 0.45, stroke: color || "#fff", fill: "transparent", opacity: 0.5 });
}
function _label(room, pos, text, color) {
  if (!CFG.DEBUG_DRAW || !room || !pos || !text) return;
  room.visual.text(text, (pos.pos || pos).x, (pos.pos || pos).y - 0.6, { color: color || "#ddd", font: 0.8, align: "center" });
}

// ============================
// Small utilities
// ============================
function _beeTravel(creep, dest, range) {
  // Normalize to BeeToolbox.BeeTravel(creep, target, {range, reusePath})
  try {
    BeeToolbox.BeeTravel(creep, (dest.pos || dest), { range: (range != null ? range : 1), reusePath: CFG.PATH_REUSE });
  } catch (e) {
    // absolute fallback
    creep.moveTo((dest.pos || dest), { reusePath: CFG.PATH_REUSE });
  }
}

function _firstSpawnRoomFallback(creep) {
  return Memory.firstSpawnRoom || (creep && creep.room && creep.room.name) || CFG.PARK_POS.roomName;
}

function _primaryStoreType(creep) {
  // choose the resource we carry the most of (for deposit order)
  if (!creep || !creep.store) return null;
  var best = null, amt = 0, k;
  for (k in creep.store) {
    if (!creep.store.hasOwnProperty(k)) continue;
    if (creep.store[k] > amt) { amt = creep.store[k]; best = k; }
  }
  return best;
}

function _findDroppedNear(pos, radius) {
  if (!pos) return [];
  // If ALLOW_NON_ENERGY: include all resources >= MIN_DROPPED
  // else: energy only
  var arr = pos.findInRange(FIND_DROPPED_RESOURCES, radius, {
    filter: function (r) {
      if (!r || typeof r.amount !== "number") return false;
      if (CFG.ALLOW_NON_ENERGY) {
        return r.amount >= CFG.MIN_DROPPED;
      } else {
        return r.resourceType === RESOURCE_ENERGY && r.amount >= CFG.MIN_DROPPED;
      }
    }
  });
  // Prefer energy first, then biggest pile
  arr.sort(function (a, b) {
    var ae = a.resourceType === RESOURCE_ENERGY ? 1 : 0;
    var be = b.resourceType === RESOURCE_ENERGY ? 1 : 0;
    if (ae !== be) return be - ae; // energy first
    return (b.amount | 0) - (a.amount | 0);
  });
  return arr;
}

function _depositTargets(creep, resType) {
  // Return best deposit structures for resType (ordered)
  // ENERGY: storage > link (optional) > spawns/extensions > terminal > container
  // NON-ENERGY: storage > terminal
  var room = creep.room;
  if (!room) return [];
  var list = room.find(FIND_STRUCTURES, {
    filter: function (s) {
      if (!s || typeof s.store === "undefined") return false;
      var free = s.store.getFreeCapacity(resType);
      if (!free || free <= 0) return false;

      if (resType === RESOURCE_ENERGY) {
        // prefer real sinks
        return (
          s.structureType === STRUCTURE_STORAGE ||
          s.structureType === STRUCTURE_SPAWN ||
          s.structureType === STRUCTURE_EXTENSION ||
          s.structureType === STRUCTURE_TERMINAL ||
          s.structureType === STRUCTURE_LINK ||
          s.structureType === STRUCTURE_CONTAINER
        );
      } else {
        // minerals/power/etc: keep in storage/terminal
        return (
          s.structureType === STRUCTURE_STORAGE ||
          s.structureType === STRUCTURE_TERMINAL
        );
      }
    }
  });

  // order by type desirability, then path distance
  function desirability(s) {
    if (resType === RESOURCE_ENERGY) {
      if (s.structureType === STRUCTURE_STORAGE) return 10;
      if (s.structureType === STRUCTURE_LINK)     return 9;
      if (s.structureType === STRUCTURE_SPAWN)    return 8;
      if (s.structureType === STRUCTURE_EXTENSION)return 7;
      if (s.structureType === STRUCTURE_TERMINAL) return 6;
      if (s.structureType === STRUCTURE_CONTAINER)return 5;
      return 0;
    } else {
      if (s.structureType === STRUCTURE_STORAGE)  return 10;
      if (s.structureType === STRUCTURE_TERMINAL) return 9;
      return 0;
    }
  }

  list.sort(function (a, b) {
    var d = desirability(b) - desirability(a);
    if (d !== 0) return d;
    var da = creep.pos.getRangeTo(a), db = creep.pos.getRangeTo(b);
    return da - db;
  });
  return list;
}

// ============================
// Main role
// ============================
function run(creep) {
  if (creep.spawning) return;

  // ensure memory defaults
  if (!creep.memory.pickupFlag)  creep.memory.pickupFlag  = CFG.PICKUP_FLAG_DEFAULT;
  if (!creep.memory.homeRoom)    creep.memory.homeRoom    = _firstSpawnRoomFallback(creep);

  // Flip "returning" based on carry vs capacity (uses your helper)
  if (BeeToolbox && typeof BeeToolbox.updateReturnState === "function") {
    BeeToolbox.updateReturnState(creep);
  } else {
    // minimal fallback
    if (creep.memory.returning && creep.store.getUsedCapacity() === 0) creep.memory.returning = false;
    if (!creep.memory.returning && creep.store.getFreeCapacity() === 0) creep.memory.returning = true;
  }

  if (creep.memory.returning) {
    return _returnToStorage(creep);
  } else {
    return _collectFromFlagRoom(creep);
  }
}

// ----------------------------
// A) Collect phase
// ----------------------------
function _collectFromFlagRoom(creep) {
  var flag = Game.flags[creep.memory.pickupFlag];

  if (!flag) {
    // No flag present → go park at home
    var home = creep.memory.homeRoom || _firstSpawnRoomFallback(creep);
    var park = new RoomPosition(25, 25, home);
    _say(creep, "❓Flag");
    _label(creep.room, creep.pos, "No flag", CFG.DRAW.IDLE);
    if (!creep.pos.inRangeTo(park, 2)) {
      _line(creep.room, creep.pos, park, CFG.DRAW.TRAVEL);
      _beeTravel(creep, park, 2);
    }
    return;
  }

  // Cross-room travel to flag
  if (creep.room.name !== flag.pos.roomName) {
    _say(creep, "🚛➡️📍");
    _line(creep.room, creep.pos, flag.pos, CFG.DRAW.TRAVEL);
    _beeTravel(creep, flag.pos, 1);
    return;
  }

  // Visual anchor for the flag
  _ring(creep.room, flag.pos, CFG.DRAW.FLAG);
  _label(creep.room, flag.pos, "Pickup", CFG.DRAW.FLAG);

  // Opportunistic: if standing on or next to any dropped resource, scoop it
  var underfoot = creep.pos.findInRange(FIND_DROPPED_RESOURCES, 1, {
    filter: function (r) {
      if (!r || r.amount <= 0) return false;
      if (!CFG.ALLOW_NON_ENERGY) return r.resourceType === RESOURCE_ENERGY;
      return true;
    }
  });
  if (underfoot && underfoot.length) {
    _say(creep, "⬇️");
    _label(creep.room, creep.pos, "Pickup underfoot", CFG.DRAW.LOOT);
    creep.pickup(underfoot[0]);
    return;
  }

  // Look for piles near the flag (energy prioritized)
  var piles = _findDroppedNear(flag.pos, CFG.SEARCH_RADIUS);
  if (!piles || !piles.length) {
    // Nothing visible — poke around the flag a bit
    if (!creep.pos.inRangeTo(flag.pos, 2)) {
      _say(creep, "🧭");
      _line(creep.room, creep.pos, flag.pos, CFG.DRAW.TRAVEL);
      _beeTravel(creep, flag.pos, 1);
    } else {
      _say(creep, "🧐");
      _label(creep.room, creep.pos, "No loot here", CFG.DRAW.IDLE);
    }
    return;
  }

  // Go to the best pile (closest-by-path from sorted list)
  var target = creep.pos.findClosestByPath(piles) || piles[0];
  if (!target) return;

  if (creep.pickup(target) === ERR_NOT_IN_RANGE) {
    _say(creep, "📦");
    _line(creep.room, creep.pos, target.pos, CFG.DRAW.LOOT);
    _beeTravel(creep, target, 1);
  } else {
    _label(creep.room, target.pos, "Pickup", CFG.DRAW.LOOT);
  }
}

// ----------------------------
// B) Return phase
// ----------------------------
function _returnToStorage(creep) {
  var home = creep.memory.homeRoom || _firstSpawnRoomFallback(creep);

  // Head to home room first
  if (creep.room.name !== home) {
    _say(creep, "🏠↩️");
    var mid = new RoomPosition(25, 25, home);
    _line(creep.room, creep.pos, mid, CFG.DRAW.RETURN);
    _beeTravel(creep, mid, 1);
    return;
  }

  // Pick a resource type to deposit (largest first)
  var resType = _primaryStoreType(creep);
  if (!resType) {
    // Nothing to drop off → idle near storage/spawn
    var idle = creep.room.storage || _.first(creep.room.find(FIND_MY_SPAWNS));
    if (idle) {
      _say(creep, "🅿️");
      _ring(creep.room, idle.pos, CFG.DRAW.IDLE);
      _beeTravel(creep, idle.pos, 2);
    }
    return;
  }

  // Choose a good deposit target for this specific resource
  var targets = _depositTargets(creep, resType);
  if (targets && targets.length) {
    var t = targets[0];
    var rc = creep.transfer(t, resType);
    if (rc === ERR_NOT_IN_RANGE) {
      _say(creep, "📦➡️🏦");
      _line(creep.room, creep.pos, t.pos, CFG.DRAW.DEPOSIT);
      _beeTravel(creep, t, 1);
    } else if (rc === OK) {
      _label(creep.room, t.pos, "Deposit " + resType, CFG.DRAW.DEPOSIT);
    } else {
      // Could be full now; try next, or shuffle toward storage for safety
      var next = targets[1] || creep.room.storage || _.first(creep.room.find(FIND_MY_SPAWNS));
      if (next) {
        _line(creep.room, creep.pos, (next.pos || next), CFG.DRAW.DEPOSIT);
        _beeTravel(creep, (next.pos || next), 1);
      }
    }
  } else {
    // Nowhere to deposit this type → park near storage
    var s = creep.room.storage || _.first(creep.room.find(FIND_MY_SPAWNS));
    _say(creep, "🤷 full");
    if (s) {
      _ring(creep.room, s.pos, CFG.DRAW.IDLE);
      _beeTravel(creep, s.pos, 2);
    }
  }
}

module.exports = {
  role: 'Trucker',
  run: run
};
