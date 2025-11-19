'use strict';

var BeeHelper = require('role.BeeHelper');
var BeeToolbox = require('BeeToolbox');
var CFG = BeeHelper.config;

var roleTrucker = (function () {
  var module = { exports: {} };
  var exports = module.exports;
  // ============================
  // Tiny debug helpers
  // ============================
  function truckerSay(creep, msg) {
    if (CFG.DEBUG_SAY && creep && msg) creep.say(msg, true);
  }
  function truckerDrawLine(room, a, b, color) {
    if (!CFG.DEBUG_DRAW || !room || !a || !b) return;
    room.visual.line((a.pos || a), (b.pos || b), { color: color || "#fff", opacity: 0.6, width: 0.08 });
  }
  function truckerDrawRing(room, pos, color) {
    if (!CFG.DEBUG_DRAW || !room || !pos) return;
    room.visual.circle((pos.pos || pos), { radius: 0.45, stroke: color || "#fff", fill: "transparent", opacity: 0.5 });
  }
  function truckerDrawLabel(room, pos, text, color) {
    if (!CFG.DEBUG_DRAW || !room || !pos || !text) return;
    room.visual.text(text, (pos.pos || pos).x, (pos.pos || pos).y - 0.6, { color: color || "#ddd", font: 0.8, align: "center" });
  }

  // ============================
  // Small utilities
  // ============================
  // Returns a fallback room name (first spawn or neutral park) if home missing.
  function getFirstSpawnRoomFallback(creep) {
    return Memory.firstSpawnRoom || (creep && creep.room && creep.room.name) || CFG.PARK_POS.roomName;
  }

  // Picks the resource type we carry the most of so deposits stay tidy.
  function getPrimaryStoreType(creep) {
    // choose the resource we carry the most of (for deposit order)
    if (!creep || !creep.store) return null;
    var best = null, amt = 0, k;
    for (k in creep.store) {
      if (!creep.store.hasOwnProperty(k)) continue;
      if (creep.store[k] > amt) { amt = creep.store[k]; best = k; }
    }
    return best;
  }

  // Finds dropped resources near a position, prioritising energy piles.
  function findDroppedResourcesNear(pos, radius) {
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

  // Lists viable deposit structures for the requested resource type.
  function getDepositTargets(creep, resType) {
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

  function determineTruckerState(creep) {
    ensureRoleDefaults(creep);
    updateReturnState(creep);
    var state = creep.memory.returning ? 'RETURN' : 'COLLECT';
    creep.memory.state = state;
    return state;
  }

  // ============================
  // Main role
  // ============================
  function run(creep) {
    if (creep.spawning) return;

    var state = determineTruckerState(creep);
    if (state === 'RETURN') {
      returnTruckerToStorage(creep);
      return;
    }
    collectFromFlagRoom(creep);
  }

  // ----------------------------
  // A) Collect phase
  // ----------------------------
  function collectFromFlagRoom(creep) {
    var flag = Game.flags[creep.memory.pickupFlag];

    if (!flag) {
      // No flag present → go park at home
      var home = creep.memory.homeRoom || getFirstSpawnRoomFallback(creep);
      var park = new RoomPosition(25, 25, home);
      truckerSay(creep, "❓Flag");
      truckerDrawLabel(creep.room, creep.pos, "No flag", CFG.DRAW.IDLE);
      if (!creep.pos.inRangeTo(park, 2)) {
        truckerDrawLine(creep.room, creep.pos, park, CFG.DRAW.TRAVEL);
        creep.travelTo(park, { range: 2, reusePath: CFG.PATH_REUSE });
      }
      return;
    }

    // Cross-room travel to flag
    if (creep.room.name !== flag.pos.roomName) {
      truckerSay(creep, "🚛➡️📍");
      truckerDrawLine(creep.room, creep.pos, flag.pos, CFG.DRAW.TRAVEL);
      creep.travelTo(flag.pos, { range: 1, reusePath: CFG.PATH_REUSE });
      return;
    }

    // Visual anchor for the flag
    truckerDrawRing(creep.room, flag.pos, CFG.DRAW.FLAG);
    truckerDrawLabel(creep.room, flag.pos, "Pickup", CFG.DRAW.FLAG);

    // Opportunistic: if standing on or next to any dropped resource, scoop it
    var underfoot = creep.pos.findInRange(FIND_DROPPED_RESOURCES, 1, {
      filter: function (r) {
        if (!r || r.amount <= 0) return false;
        if (!CFG.ALLOW_NON_ENERGY) return r.resourceType === RESOURCE_ENERGY;
        return true;
      }
    });
    if (underfoot && underfoot.length) {
      truckerSay(creep, "⬇️");
      truckerDrawLabel(creep.room, creep.pos, "Pickup underfoot", CFG.DRAW.LOOT);
      creep.pickup(underfoot[0]);
      return;
    }

    // Look for piles near the flag (energy prioritized)
    var piles = findDroppedResourcesNear(flag.pos, CFG.SEARCH_RADIUS);
    if (!piles || !piles.length) {
      // Nothing visible — poke around the flag a bit
      if (!creep.pos.inRangeTo(flag.pos, 2)) {
        truckerSay(creep, "🧭");
        truckerDrawLine(creep.room, creep.pos, flag.pos, CFG.DRAW.TRAVEL);
        creep.travelTo(flag.pos, { range: 1, reusePath: CFG.PATH_REUSE });
      } else {
        truckerSay(creep, "🧐");
        truckerDrawLabel(creep.room, creep.pos, "No loot here", CFG.DRAW.IDLE);
      }
      return;
    }

    // Go to the best pile (closest-by-path from sorted list)
    var target = creep.pos.findClosestByPath(piles) || piles[0];
    if (!target) return;

    if (creep.pickup(target) === ERR_NOT_IN_RANGE) {
      truckerSay(creep, "📦");
      truckerDrawLine(creep.room, creep.pos, target.pos, CFG.DRAW.LOOT);
      creep.travelTo(target, { range: 1, reusePath: CFG.PATH_REUSE });
    } else {
      truckerDrawLabel(creep.room, target.pos, "Pickup", CFG.DRAW.LOOT);
    }
  }

  // ----------------------------
  // B) Return phase
  // ----------------------------
  function returnTruckerToStorage(creep) {
    var home = creep.memory.homeRoom || getFirstSpawnRoomFallback(creep);

    // Head to home room first
    if (creep.room.name !== home) {
      truckerSay(creep, "🏠↩️");
      var mid = new RoomPosition(25, 25, home);
      truckerDrawLine(creep.room, creep.pos, mid, CFG.DRAW.RETURN);
      creep.travelTo(mid, { range: 1, reusePath: CFG.PATH_REUSE });
      return;
    }

    // Pick a resource type to deposit (largest first)
    var resType = getPrimaryStoreType(creep);
    if (!resType) {
      // Nothing to drop off → idle near storage/spawn
      var idle = creep.room.storage || _.first(creep.room.find(FIND_MY_SPAWNS));
      if (idle) {
        truckerSay(creep, "🅿️");
        truckerDrawRing(creep.room, idle.pos, CFG.DRAW.IDLE);
        creep.travelTo(idle.pos, { range: 2, reusePath: CFG.PATH_REUSE });
      }
      return;
    }

    // Choose a good deposit target for this specific resource
    var targets = getDepositTargets(creep, resType);
    if (targets && targets.length) {
      var t = targets[0];
      var rc = creep.transfer(t, resType);
      if (rc === ERR_NOT_IN_RANGE) {
        truckerSay(creep, "📦➡️🏦");
        truckerDrawLine(creep.room, creep.pos, t.pos, CFG.DRAW.DEPOSIT);
        creep.travelTo(t, { range: 1, reusePath: CFG.PATH_REUSE });
      } else if (rc === OK) {
        truckerDrawLabel(creep.room, t.pos, "Deposit " + resType, CFG.DRAW.DEPOSIT);
      } else {
        // Could be full now; try next, or shuffle toward storage for safety
        var next = targets[1] || creep.room.storage || _.first(creep.room.find(FIND_MY_SPAWNS));
        if (next) {
          truckerDrawLine(creep.room, creep.pos, (next.pos || next), CFG.DRAW.DEPOSIT);
          creep.travelTo((next.pos || next), { range: 1, reusePath: CFG.PATH_REUSE });
        }
      }
    } else {
      // Nowhere to deposit this type → park near storage
      var s = creep.room.storage || _.first(creep.room.find(FIND_MY_SPAWNS));
      truckerSay(creep, "🤷 full");
      if (s) {
        truckerDrawRing(creep.room, s.pos, CFG.DRAW.IDLE);
        creep.travelTo(s.pos, { range: 2, reusePath: CFG.PATH_REUSE });
      }
    }
  }

  module.exports = {
    role: 'Trucker',
    run: run
  };

  // ============================
  // Teaching helpers (state)
  // ============================
  function ensureRoleDefaults(creep) {
    if (!creep.memory.pickupFlag) {
      creep.memory.pickupFlag = CFG.PICKUP_FLAG_DEFAULT;
    }
    if (!creep.memory.homeRoom) {
      creep.memory.homeRoom = getFirstSpawnRoomFallback(creep);
    }
    if (creep.memory.returning === undefined) creep.memory.returning = false;
  }

  // Memory keys:
  // - pickupFlag: flag name defining the harvest area
  // - homeRoom: drop-off room
  // - returning: boolean toggled when cargo is full

  function updateReturnState(creep) {
    if (BeeToolbox && typeof BeeToolbox.updateReturnState === 'function') {
      BeeToolbox.updateReturnState(creep);
      return;
    }
    if (creep.memory.returning && creep.store.getUsedCapacity() === 0) {
      creep.memory.returning = false;
    }
    if (!creep.memory.returning && creep.store.getFreeCapacity() === 0) {
      creep.memory.returning = true;
    }
  }

  return module.exports;
})();

module.exports = roleTrucker;
