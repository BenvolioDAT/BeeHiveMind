'use strict';
//* role.BeeWorker – consolidated creep roles that do working task.
var BeeToolbox = require('BeeToolbox');
// External selectors module; see BeeSelectors.js for source/sink scans.
var BeeSelectors = require('BeeSelectors');
// Shared action wrappers with movement intents.
var BeeActions = require('BeeActions');
// Central movement queue; roleQueen enqueues idles here.
var MovementManager = require('Movement.Manager');


// Shared debug + tuning config
var CFG = Object.freeze({
  // --- Pathing (used by Courier & any others that want it) ---
  PATH_REUSE: 40,
  MAX_OPS_MOVE: 2000,
  TRAVEL_MAX_OPS: 4000,
  //--- Pathing (used by Queen)----
  STUCK_TICKS: 6,
  MOVE_PRIORITIES: { withdraw: 60, pickup: 70, deliver: 55, idle: 5 },
  // --- Targeting cadences (Courier) ---
  RETARGET_COOLDOWN: 10,
  GRAVE_SCAN_COOLDOWN: 20,
  BETTER_CONTAINER_DELTA: 150,

  // --- Thresholds / radii (Courier) ---
  CONTAINER_MIN: 50,
  DROPPED_BIG_MIN: 150,
  DROPPED_NEAR_CONTAINER_R: 2,
  DROPPED_ALONG_ROUTE_R: 2,

  // --- Towers (Courier) ---
  TOWER_REFILL_AT_OR_BELOW: 0.70,

  // --- Debug toggles (shared) ---
  DEBUG_SAY: false,
  DEBUG_DRAW: true,

  // --- Visual styles (shared) ---
  DRAW: {
    // BaseHarvest-style visuals
    TRAVEL:   "#8ab6ff",
    SOURCE:   "#ffd16e",
    SEAT:     "#6effa1",
    QUEUE:    "#ffe66e",
    YIELD:    "#ff6e6e",
    OFFLOAD:  "#6ee7ff",
    IDLE:     "#bfbfbf",
    // Courier-style visuals
    WD_COLOR:    "#6ec1ff",  // withdraw lines
    FILL_COLOR:  "#6effa1",  // delivery lines
    DROP_COLOR:  "#ffe66e",  // dropped energy
    GRAVE_COLOR: "#ffb0e0",  // tombstones/ruins
    IDLE_COLOR:  "#bfbfbf",
    // Shared
    WIDTH:   0.12,
    OPACITY: 0.45,
    FONT:    0.6
  },
  //Upgrader role Behavior
  SIGN_TEXT: "BeeNice Please.",
  //Trucker role Behavior
  PICKUP_FLAG_DEFAULT: "E-Pickup", // default flag name to route to
  MIN_DROPPED: 50,                 // ignore tiny crumbs (energy or other)
  SEARCH_RADIUS: 50,               // how far from flag to look
  PATH_REUSE: 20,                  // reusePath hint

  // Optional: allow non-energy resource pickups (POWER, minerals, etc.)
  ALLOW_NON_ENERGY: true,

  // Fallback park if no flag & no home (harmless; rarely used)
  PARK_POS: { x:25, y:25, roomName:"W0N0" },
});

// Namespace
var roleBeeWorker = {};


roleBeeWorker.BaseHarvest = (function () {
  /** =========================
   *  Config knobs
   *  ========================= */
  var CONFIG = {
    maxHarvestersPerSource: 1,   // 1 = strict single-seat miners (best w/ container)
    avoidTicksAfterYield: 20,    // loser avoids yielded source for this many ticks
    handoffTtl: 120,             // if incumbent's TTL <= this, allow queueing
    queueRange: 2,               // (kept for semantics; queue finder picks tiles around seat)
    travelReuse: 12              // reusePath hint for travel helper
  };

  /** =========================
   *  Debug helpers
   *  ========================= */
  function debugSay(creep, msg) {
    if (CFG.DEBUG_SAY && creep && msg) creep.say(msg, true);
  }
  function _posOf(target) {
    if (!target) return null;
    if (target.pos) return target.pos;
    if (target.x != null && target.y != null && target.roomName) return target;
    return null;
  }
  function debugDrawLine(creep, target, color, label) {
    if (!CFG.DEBUG_DRAW || !creep || !target) return;
    var room = creep.room; if (!room || !room.visual) return;
    var tpos = _posOf(target); if (!tpos || tpos.roomName !== room.name) return;
    try {
      room.visual.line(creep.pos, tpos, {
        color: color, width: CFG.DRAW.WIDTH, opacity: CFG.DRAW.OPACITY, lineStyle: "solid"
      });
      if (label) {
        room.visual.text(label, tpos.x, tpos.y - 0.3, {
          color: color, opacity: CFG.DRAW.OPACITY, font: CFG.DRAW.FONT, align: "center"
        });
      }
    } catch (e) {}
  }
  function debugRing(room, pos, color, text) {
    if (!CFG.DEBUG_DRAW || !room || !room.visual || !pos) return;
    try {
      room.visual.circle(pos, { radius: 0.5, fill: "transparent", stroke: color, opacity: CFG.DRAW.OPACITY, width: CFG.DRAW.WIDTH });
      if (text) room.visual.text(text, pos.x, pos.y - 0.6, { color: color, font: CFG.DRAW.FONT, opacity: CFG.DRAW.OPACITY, align: "center" });
    } catch (e) {}
  }

  /** =========================
   *  Travel helper (BeeTravel → Traveler → moveTo)
   *  Draws a path hint to the target.
   *  ========================= */
  function go(creep, dest, range, reuse) {
    range = (range != null) ? range : 1;
    reuse = (reuse != null) ? reuse : CONFIG.travelReuse;
    var dpos = (dest && dest.pos) ? dest.pos : dest;
    if (dpos) debugDrawLine(creep, dpos, CFG.DRAW.TRAVEL, "GO");

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
    if (creep.pos.getRangeTo(dest) > range) creep.moveTo(dest, { reusePath: reuse, maxOps: 2000 });
  }

  /** =========================
   *  Small utils
   *  ========================= */

  // Terrain walkability check (no walls, inside bounds)
  function isWalkable(pos) {
    if (!pos || !pos.roomName) return false;
    if (pos.x <= 0 || pos.x >= 49 || pos.y <= 0 || pos.y >= 49) return false;
    var t = new Room.Terrain(pos.roomName);
    return t.get(pos.x, pos.y) !== TERRAIN_MASK_WALL;
  }

  // Is the tile occupied by *another* friendly creep?
  function isTileOccupiedByAlly(pos, myName) {
    var creeps = pos.lookFor(LOOK_CREEPS);
    for (var i = 0; i < creeps.length; i++) {
      var c = creeps[i];
      if (c.my && c.name !== myName) return true;
    }
    return false;
  }

  // Is the tile occupied by ANY creep (ally or not), excluding me?
  function isTileOccupiedByAnyCreep(pos, myName) {
    var creeps = pos.lookFor(LOOK_CREEPS);
    for (var i = 0; i < creeps.length; i++) {
      var c = creeps[i];
      if (!c) continue;
      if (!myName || c.name !== myName) return true;
    }
    return false;
  }

  // Count how many walkable seats around a pos (8-neighborhood)
  function countWalkableSeatsAround(pos) {
    var seats = 0;
    var t = new Room.Terrain(pos.roomName);
    for (var dx = -1; dx <= 1; dx++) {
      for (var dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        var x = pos.x + dx, y = pos.y + dy;
        if (x <= 0 || x >= 49 || y <= 0 || y >= 49) continue;
        if (t.get(x, y) !== TERRAIN_MASK_WALL) seats++;
      }
    }
    return seats;
  }

  // Find any container in range 1 of the source
  function getAdjacentContainerForSource(source) {
    var arr = source.pos.findInRange(FIND_STRUCTURES, 1, {
      filter: function (s) { return s.structureType === STRUCTURE_CONTAINER; }
    });
    return (arr && arr.length) ? arr[0] : null;
  }

  // Prefer container tile as the "seat". Else pick a deterministic adjacent tile.
  function getPreferredSeatPos(source) {
    var cont = getAdjacentContainerForSource(source);
    if (cont) return cont.pos;

    // No container: choose a stable walkable tile (sorted by y then x)
    var candidates = [];
    for (var dx = -1; dx <= 1; dx++) {
      for (var dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        var p = new RoomPosition(source.pos.x + dx, source.pos.y + dy, source.pos.roomName);
        if (isWalkable(p)) candidates.push(p);
      }
    }
    if (!candidates.length) return null;
    candidates.sort(function(a, b) { return (a.y - b.y) || (a.x - b.x); });
    return candidates[0];
  }

  function matchesRole(creep, roleName, legacyTask) {
    if (!creep || !creep.memory) return false;
    var role = creep.memory.role;
    if (role && roleName && String(role).toLowerCase() === String(roleName).toLowerCase()) return true;
    var bornRole = creep.memory.bornRole;
    if (bornRole && roleName && String(bornRole).toLowerCase() === String(roleName).toLowerCase()) return true;
    var task = creep.memory.task;
    var legacy = legacyTask || roleName;
    if (task && legacy && String(task).toLowerCase() === String(legacy).toLowerCase()) return true;
    if (task && roleName && String(task).toLowerCase() === String(roleName).toLowerCase()) return true;
    return false;
  }

  // Any friendly harvesters currently assigned to this source (live only)
  function getIncumbents(roomName, sourceId, excludeName) {
    var out = [];
    for (var name in Game.creeps) {
      var c = Game.creeps[name];
      if (!c || !c.my) continue;
      if (excludeName && name === excludeName) continue;
      if (c.memory && matchesRole(c, 'BaseHarvest', 'baseharvest') &&
          c.memory.assignedSource === sourceId &&
          c.room && c.room.name === roomName) {
        out.push(c);
      }
    }
    return out;
  }

  // Count assigned harvesters (live)
  function countAssignedHarvesters(roomName, sourceId) {
    return getIncumbents(roomName, sourceId, null).length;
  }

  /** =========================
   *  Conflict / yield logic
   *  ========================= */

  // Adjacent conflict resolver: stable winner by name; loser yields & avoids briefly.
  function resolveSourceConflict(creep, source) {
    var neighbors = source.pos.findInRange(FIND_MY_CREEPS, 1, {
      filter: function(c) {
        return c.name !== creep.name &&
               matchesRole(c, 'BaseHarvest', 'baseharvest') &&
               c.memory.assignedSource === source.id;
      }
    });

    if (neighbors.length === 0) return false;

    // If I'm effectively the only assigned miner left (others died), don't yield.
    if (countAssignedHarvesters(creep.room.name, source.id) <= 1) return false;

    var all = neighbors.concat([creep]);
    var winner = all[0];
    for (var i = 1; i < all.length; i++) {
      if (all[i].name < winner.name) winner = all[i];
    }

    if (winner.name !== creep.name) {
      creep.memory._avoidSourceId = source.id;
      creep.memory._avoidUntil    = Game.time + CONFIG.avoidTicksAfterYield;
      creep.memory.assignedSource = null;
      creep.memory._reassignCooldown = Game.time + 5;
      creep.memory.waitingForSeat = false;

      debugSay(creep, 'yield 🐝');
      debugRing(creep.room, source.pos, CFG.DRAW.YIELD, "YIELD");
      return true;
    }
    return false;
  }

  /** =========================
   *  Queue / handoff logic
   *  ========================= */

  // Return true if we should queue: source is at capacity but an incumbent is expiring soon.
  function shouldQueueForSource(creep, source, seats, used) {
    if (used < seats) return false; // not full
    var inc = getIncumbents(creep.room.name, source.id, creep.name);
    for (var i = 0; i < inc.length; i++) {
      var t = inc[i].ticksToLive;
      if (typeof t === 'number' && t <= CONFIG.handoffTtl) return true;
    }
    return false;
  }

  // Pick a queue spot near the seat (not on the seat), walkable & (ideally) unoccupied.
  function findQueueSpotNearSeat(seatPos, myName) {
    var best = null, bestScore = -Infinity;
    for (var dx = -1; dx <= 1; dx++) {
      for (var dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        var p = new RoomPosition(seatPos.x + dx, seatPos.y + dy, seatPos.roomName);
        if (!isWalkable(p)) continue;
        var occupied = isTileOccupiedByAlly(p, myName);
        var score = occupied ? -10 : 0;
        score += (-p.y * 0.01) + (-p.x * 0.001);
        if (score > bestScore) { bestScore = score; best = p; }
      }
    }
    return best;
  }

  /** =========================
   *  Source assignment
   *  ========================= */

  function assignSource(creep) {
    if (creep.spawning) return;

    if (creep.memory._reassignCooldown && Game.time < creep.memory._reassignCooldown) {
      return creep.memory.assignedSource || null;
    }

    if (creep.memory.assignedSource) return creep.memory.assignedSource;

    var sources = creep.room.find(FIND_SOURCES);
    if (!sources || !sources.length) return null;

    var best = null;
    var bestScore = -Infinity;
    var bestWillQueue = false;

    for (var i = 0; i < sources.length; i++) {
      var s = sources[i];

      if (creep.memory._avoidSourceId === s.id &&
          creep.memory._avoidUntil &&
          Game.time < creep.memory._avoidUntil) {
        continue;
      }

      var seatPos = getPreferredSeatPos(s);
      if (!seatPos) continue;

      var seats = getAdjacentContainerForSource(s) ? 1 : countWalkableSeatsAround(s.pos);
      if (CONFIG.maxHarvestersPerSource > 0) {
        seats = Math.min(seats, CONFIG.maxHarvestersPerSource);
      }

      var used = countAssignedHarvesters(creep.room.name, s.id);
      var free = seats - used;
      var willQueue = false;

      if (free <= 0) {
        if (!shouldQueueForSource(creep, s, seats, used)) continue;
        willQueue = true;
      }

      var range = creep.pos.getRangeTo(seatPos);
      var score = (free > 0 ? 1000 : 0) - range;

      if (score > bestScore) {
        bestScore = score;
        best = { source: s, seatPos: seatPos };
        bestWillQueue = willQueue;
      }
    }

    if (!best) return null;

    creep.memory.assignedSource = best.source.id;
    creep.memory.seatX = best.seatPos.x;
    creep.memory.seatY = best.seatPos.y;
    creep.memory.seatRoom = best.seatPos.roomName;
    creep.memory.waitingForSeat = !!bestWillQueue;

    debugSay(creep, bestWillQueue ? '⏳' : '🎯');
    debugRing(creep.room, best.source.pos, CFG.DRAW.SOURCE, "SRC");
    debugRing(creep.room, best.seatPos,   CFG.DRAW.SEAT,   "SEAT");

    return best.source.id;
  }

  /** =========================
   *  Offload helpers (when full)
   *  ========================= */

  function getContainerAtOrAdjacent(pos) {
    var here = pos.lookFor(LOOK_STRUCTURES);
    for (var i = 0; i < here.length; i++) {
      if (here[i].structureType === STRUCTURE_CONTAINER) return here[i];
    }
    var around = pos.findInRange(FIND_STRUCTURES, 1, {
      filter: function(s) { return s.structureType === STRUCTURE_CONTAINER; }
    });
    return (around && around.length) ? around[0] : null;
  }

  function countCreepsWithRole(roleName, legacyTask) {
    var n = 0;
    for (var name in Game.creeps) {
      var c = Game.creeps[name];
      if (c && matchesRole(c, roleName, legacyTask)) n++;
    }
    return n;
  }

  // Prefer returning to spawn/extensions; fallback to storage; then any container.
  function findEmergencyEnergySink(creep) {
    var spawn = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
      filter: function(s) {
        return s.structureType === STRUCTURE_SPAWN &&
               s.store && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
      }
    });
    if (spawn) return spawn;

    var ext = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
      filter: function(s) {
        return s.structureType === STRUCTURE_EXTENSION &&
               s.store && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
      }
    });
    if (ext) return ext;

    if (creep.room.storage && creep.room.storage.store &&
        creep.room.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
      return creep.room.storage;
    }

    var cont = creep.pos.findClosestByPath(FIND_STRUCTURES, {
      filter: function(s) {
        return s.structureType === STRUCTURE_CONTAINER &&
               s.store && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
      }
    });
    if (cont) return cont;

    return null;
  }

  /** =========================
   *  Main role
   *  ========================= */

  // Teaching helper: novice readers can follow the role flow by calling these in order.
  function ensureRoleIdentity(creep) {
    if (!creep || !creep.memory) return;
    if (!creep.memory.role || String(creep.memory.role).toLowerCase() === 'baseharvest') {
      creep.memory.role = 'BaseHarvest';
    }
    if (!creep.memory.task) creep.memory.task = 'baseharvest';
  }

  function updateHarvestingFlag(creep) {
    if (!creep) return false;
    var empty = creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
    var full  = creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0;
    if (empty && !creep.memory.harvesting) { creep.memory.harvesting = true; debugSay(creep, '⤵️MINE'); }
    else if (full && creep.memory.harvesting) { creep.memory.harvesting = false; debugSay(creep, '⤴️DROP'); }
    return creep.memory.harvesting;
  }

  function runHarvestPhase(creep) {
    var sid = assignSource(creep);
    if (!sid) { debugSay(creep, '❓'); return; }

    var source = Game.getObjectById(sid);
    if (!source) {
      creep.memory.assignedSource = null; creep.memory.waitingForSeat = false;
      return;
    }

    // Resolve local conflicts if we are in the scrum
    if (resolveSourceConflict(creep, source)) return;

    // Preferred seat position (rebuild if memory room mismatch)
    var seatPos = (creep.memory.seatRoom === creep.room.name)
      ? new RoomPosition(creep.memory.seatX, creep.memory.seatY, creep.memory.seatRoom)
      : getPreferredSeatPos(source);

    if (seatPos) {
      debugRing(creep.room, seatPos, CFG.DRAW.SEAT, "SEAT");
    }

    // Capacity math
    var seats = getAdjacentContainerForSource(source) ? 1 : countWalkableSeatsAround(source.pos);
    if (CONFIG.maxHarvestersPerSource > 0) seats = Math.min(seats, CONFIG.maxHarvestersPerSource);
    var used  = countAssignedHarvesters(creep.room.name, source.id);

    // Promote out of queue ASAP if capacity exists now
    if (used < seats) {
      creep.memory.waitingForSeat = false;
    }

    // Seat occupancy: any creep (ally or not) blocks the exact tile unless it's me
    var seatBlocked = seatPos ? (isTileOccupiedByAnyCreep(seatPos, creep.name) && !creep.pos.isEqualTo(seatPos)) : false;

    // Decide whether to queue this tick
    var shouldQ = (seatBlocked || creep.memory.waitingForSeat) && used >= seats && shouldQueueForSource(creep, source, seats, used);

    if (shouldQ) {
      var queueSpot = findQueueSpotNearSeat(seatPos, creep.name) || seatPos;
      creep.memory.waitingForSeat = true;

      debugSay(creep, '⏳');
      debugRing(creep.room, queueSpot, CFG.DRAW.QUEUE, "QUEUE");
      if (!creep.pos.isEqualTo(queueSpot)) { go(creep, queueSpot, 0, CONFIG.travelReuse); return; }

      if (creep.pos.getRangeTo(source) <= 1) {
        debugDrawLine(creep, source, CFG.DRAW.SOURCE, "HARV");
        creep.harvest(source);
      }

      if (!isTileOccupiedByAnyCreep(seatPos, creep.name) || countAssignedHarvesters(creep.room.name, source.id) < seats) {
        go(creep, seatPos, 0, CONFIG.travelReuse);
        creep.memory.waitingForSeat = false;
      }
      return;
    }

    // NO QUEUE: seat free or capacity available → go sit or harvest
    if (seatPos && !creep.pos.isEqualTo(seatPos)) {
      debugSay(creep, '🪑');
      go(creep, seatPos, 0, CONFIG.travelReuse);
      return;
    }
    creep.memory.waitingForSeat = false;

    // --- Same-tick dump+harvest ONLY if collectors exist ---
    var courierCount = countCreepsWithRole('Courier', 'courier');
    var queenCount   = countCreepsWithRole('Queen', 'queen');
    var haveCollectors = (courierCount > 0 || queenCount > 0);

    var contHere = getContainerAtOrAdjacent(creep.pos);
    if (haveCollectors && contHere && creep.pos.isEqualTo(contHere.pos)) {
      if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
        var tr = creep.transfer(contHere, RESOURCE_ENERGY);
        if (tr === ERR_FULL) { debugSay(creep, '⬇️'); creep.drop(RESOURCE_ENERGY); }
        else if (tr === ERR_NOT_IN_RANGE) { go(creep, contHere.pos, 0, CONFIG.travelReuse); return; }
      }
    }

    // Always swing the pick this tick
    debugSay(creep, '⛏️');
    debugDrawLine(creep, source, CFG.DRAW.SOURCE, "HARV");
    creep.harvest(source);
  }

  function runOffloadPhase(creep) {
    var courierCount2 = countCreepsWithRole('Courier', 'courier');
    var queenCount2   = countCreepsWithRole('Queen', 'queen');
    var haveCollectors2 = (courierCount2 > 0 || queenCount2 > 0);

    // If we DON'T have collectors, prioritize hauling to spawn/ext/storage.
    if (!haveCollectors2) {
      var sink = findEmergencyEnergySink(creep); // spawn → ext → storage → container
      if (sink) {
        debugSay(creep, '🏠');
        debugDrawLine(creep, sink, CFG.DRAW.OFFLOAD, "RETURN");
        var rs = creep.transfer(sink, RESOURCE_ENERGY);
        if (rs === ERR_NOT_IN_RANGE) { go(creep, sink, 1, CONFIG.travelReuse); return; }
        if (rs === OK) return;
      }
      debugSay(creep, '⬇️'); // absolute last resort
      creep.drop(RESOURCE_ENERGY);
      return;
    }

    // We DO have collectors → container-first flow (fast turnaround)
    var cont = getContainerAtOrAdjacent(creep.pos);
    if (cont) {
      if (!creep.pos.isEqualTo(cont.pos)) {
        debugSay(creep, '📦→');
        debugDrawLine(creep, cont, CFG.DRAW.OFFLOAD, "SEAT");
        go(creep, cont.pos, 0, CONFIG.travelReuse);
        return;
      }

      debugSay(creep, '📦');
      var tr2 = creep.transfer(cont, RESOURCE_ENERGY);
      if (tr2 === OK) return;
      if (tr2 === ERR_NOT_IN_RANGE) { go(creep, cont.pos, 0, CONFIG.travelReuse); return; }

      // Container rejected (likely full). Drop to keep miner unblocked.
      debugSay(creep, '⬇️');
      creep.drop(RESOURCE_ENERGY);
      return;
    }

    // No container next to us but collectors exist → drop for pickup
    debugSay(creep, '⬇️');
    debugRing(creep.room, creep.pos, CFG.DRAW.OFFLOAD, "DROP");
    creep.drop(RESOURCE_ENERGY);
  }

  function idleWhenEmpty(creep) {
    if (!creep || creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) return;
    debugSay(creep, '🧘');
    debugRing(creep.room, creep.pos, CFG.DRAW.IDLE, "IDLE");
  }

  var roleBaseHarvest = {
    role: 'BaseHarvest',
    run: function(creep) {
      ensureRoleIdentity(creep);

      // Habit: update our state once and branch from it instead of sprinkling conditions everywhere.
      var harvesting = updateHarvestingFlag(creep);

      if (harvesting) {
        runHarvestPhase(creep);
        return;
      }

      if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
        runOffloadPhase(creep);
        return;
      }

      idleWhenEmpty(creep);
    }
  };

  return roleBaseHarvest;
})();

roleBeeWorker.Builder = (function () {
  // ==============================
  // Tunables
  // ==============================
  var ALLOW_HARVEST_FALLBACK = false; // flip true if you really want last-resort mining
  var PICKUP_MIN = 50;                // ignore tiny crumbs
  var SRC_CONTAINER_MIN = 100;        // minimum energy to bother at source containers

  // ==============================
  // Debug helpers
  // ==============================
  function debugSay(creep, msg) {
    if (CFG.DEBUG_SAY && creep && msg) creep.say(msg, true);
  }
  function _posOf(target) {
    if (!target) return null;
    if (target.pos) return target.pos;
    if (target.x != null && target.y != null && target.roomName) return target;
    return null;
  }
  function debugDraw(creep, target, color, label) {
    if (!CFG.DEBUG_DRAW || !creep || !target) return;
    var room = creep.room; if (!room || !room.visual) return;
    var tpos = _posOf(target); if (!tpos || tpos.roomName !== room.name) return;

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
  function debugRing(room, pos, color, text) {
    if (!CFG.DEBUG_DRAW || !room || !room.visual || !pos) return;
    try {
      room.visual.circle(pos, { radius: 0.5, fill: "transparent", stroke: color, opacity: CFG.DRAW.OPACITY, width: CFG.DRAW.WIDTH });
      if (text) room.visual.text(text, pos.x, pos.y - 0.6, { color: color, font: CFG.DRAW.FONT, opacity: CFG.DRAW.OPACITY, align: "center" });
    } catch (e) {}
  }

  // ==============================
  // Tiny movement helper
  // ==============================
  function go(creep, dest, range, reuse) {
    range = (range != null) ? range : 1;
    reuse = (reuse != null) ? reuse : 25;

    var dpos = (dest && dest.pos) ? dest.pos : dest;
    if (dpos) debugDraw(creep, dpos, CFG.DRAW.TRAVEL_COLOR, "GO");

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

  // ==============================
  // Energy intake (prefer floor snacks)
  // ==============================
  function collectEnergy(creep) {
    // 1) Tombstones / Ruins
    var tomb = creep.pos.findClosestByRange(FIND_TOMBSTONES, { filter: function (t) { return (t.store[RESOURCE_ENERGY] | 0) > 0; } });
    if (tomb) {
      debugSay(creep, '🪦');
      debugDraw(creep, tomb, CFG.DRAW.TOMBSTONE_COLOR, "TOMB");
      var tr = creep.withdraw(tomb, RESOURCE_ENERGY);
      if (tr === ERR_NOT_IN_RANGE) go(creep, tomb, 1, 20);
      return true;
    }
    var ruin = creep.pos.findClosestByRange(FIND_RUINS, { filter: function (r) { return (r.store[RESOURCE_ENERGY] | 0) > 0; } });
    if (ruin) {
      debugSay(creep, '🏚️');
      debugDraw(creep, ruin, CFG.DRAW.RUIN_COLOR, "RUIN");
      var rr = creep.withdraw(ruin, RESOURCE_ENERGY);
      if (rr === ERR_NOT_IN_RANGE) go(creep, ruin, 1, 20);
      return true;
    }

    // 2) Dropped
    var dropped = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
      filter: function (r) { return r.resourceType === RESOURCE_ENERGY && (r.amount | 0) >= PICKUP_MIN; }
    });
    if (dropped) {
      debugSay(creep, '🍪');
      debugDraw(creep, dropped, CFG.DRAW.PICKUP_COLOR, "DROP");
      if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) go(creep, dropped, 1, 15);
      return true;
    }

    // 3) Source-adjacent container
    var srcCont = creep.pos.findClosestByRange(FIND_STRUCTURES, {
      filter: function (s) {
        if (s.structureType !== STRUCTURE_CONTAINER || !s.store) return false;
        if (s.pos.findInRange(FIND_SOURCES, 1).length === 0) return false;
        return (s.store[RESOURCE_ENERGY] | 0) >= SRC_CONTAINER_MIN;
      }
    });
    if (srcCont) {
      debugSay(creep, '📦');
      debugDraw(creep, srcCont, CFG.DRAW.SRC_CONT_COLOR, "SRC•CONT");
      var cr = creep.withdraw(srcCont, RESOURCE_ENERGY);
      if (cr === ERR_NOT_IN_RANGE) go(creep, srcCont, 1, 25);
      return true;
    }

    // 4) Any store (container/link/storage/terminal)
    var storeLike = creep.pos.findClosestByRange(FIND_STRUCTURES, {
      filter: function (s) {
        if (!s.store) return false;
        var t = s.structureType;
        if (t !== STRUCTURE_CONTAINER && t !== STRUCTURE_LINK && t !== STRUCTURE_STORAGE && t !== STRUCTURE_TERMINAL) return false;
        return (s.store[RESOURCE_ENERGY] | 0) > 0;
      }
    });
    if (storeLike) {
      debugSay(creep, '🏦');
      debugDraw(creep, storeLike, CFG.DRAW.STORELIKE_COLOR, "WITHDRAW");
      var sr = creep.withdraw(storeLike, RESOURCE_ENERGY);
      if (sr === ERR_NOT_IN_RANGE) go(creep, storeLike, 1, 25);
      return true;
    }

    // 5) Optional last resort: harvest
    if (ALLOW_HARVEST_FALLBACK) {
      var src = creep.pos.findClosestByRange(FIND_SOURCES_ACTIVE);
      if (src) {
        debugSay(creep, '⛏️');
        debugDraw(creep, src, CFG.DRAW.SRC_CONT_COLOR, "MINE");
        var hr = creep.harvest(src);
        if (hr === ERR_NOT_IN_RANGE) go(creep, src, 1, 20);
        return true;
      }
    }

    // Idle near something useful
    var anchor = creep.room.storage || creep.pos.findClosestByRange(FIND_MY_SPAWNS) || creep.pos;
    if (anchor && anchor.pos) {
      debugSay(creep, '🧘');
      debugDraw(creep, anchor, CFG.DRAW.IDLE_COLOR, "IDLE");
      go(creep, anchor, 2, 20);
    }
    return false;
  }

  function toggleBuilderState(creep) {
    if (creep.memory.building && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.building = false;
      debugSay(creep, '⤵️REFUEL');
    }
    if (!creep.memory.building && creep.store.getFreeCapacity() === 0) {
      creep.memory.building = true;
      debugSay(creep, '⤴️BUILD');
    }
  }

  function idleNearAnchor(creep) {
    var anchor = creep.room.storage || creep.pos.findClosestByRange(FIND_MY_SPAWNS) || creep.pos;
    if (anchor && anchor.pos) {
      debugSay(creep, '🧘');
      debugDraw(creep, anchor, CFG.DRAW.IDLE_COLOR, "IDLE");
      go(creep, anchor, 2, 20);
    }
  }

  function dumpEnergyToSink(creep) {
    if ((creep.store[RESOURCE_ENERGY] | 0) <= 0) return false;
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
    if (!sink) return false;
    debugSay(creep, '➡️SINK');
    debugDraw(creep, sink, CFG.DRAW.SINK_COLOR, "SINK");
    if (creep.transfer(sink, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) go(creep, sink, 1, 20);
    return true;
  }

  function runBuildPhase(creep) {
    var site = pickBuildSite(creep);
    if (site) {
      if (doBuild(creep, site)) return;
      if ((creep.store[RESOURCE_ENERGY] | 0) === 0) creep.memory.building = false;
      else creep.memory.siteId = null;
      return;
    }

    if (dumpEnergyToSink(creep)) return;
    idleNearAnchor(creep);
  }

  // ==============================
  // Pick a build target (simple + sticky)
  // ==============================
  function pickBuildSite(creep) {
    // sticky
    var id = creep.memory.siteId;
    if (id) {
      var stick = Game.constructionSites[id];
      if (stick) {
        debugRing(creep.room, stick.pos, CFG.DRAW.BUILD_COLOR, "STICK");
        return stick;
      }
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
      if (best) {
        creep.memory.siteId = best.id;
        debugRing(creep.room, best.pos, CFG.DRAW.BUILD_COLOR, best.structureType.toUpperCase());
        return best;
      }
    }

    // otherwise, nearest room with a site (visible or not)
    var any = null, bestDist = 1e9;
    for (var sid in Game.constructionSites) {
      if (!Game.constructionSites.hasOwnProperty(sid)) continue;
      var s2 = Game.constructionSites[sid];
      var d2 = Game.map.getRoomLinearDistance(creep.pos.roomName, s2.pos.roomName);
      if (d2 < bestDist) { bestDist = d2; any = s2; }
    }
    if (any) { creep.memory.siteId = any.id; debugRing(creep.room, any.pos, CFG.DRAW.BUILD_COLOR, "NEAR"); return any; }

    return null;
  }

  // ==============================
  // Build work
  // ==============================
  function doBuild(creep, site) {
    if (!site) return false;

    if (creep.pos.inRangeTo(site.pos, 3)) {
      debugSay(creep, '🔨');
      debugDraw(creep, site, CFG.DRAW.BUILD_COLOR, "BUILD");
      var r = creep.build(site);
      if (r === ERR_NOT_ENOUGH_RESOURCES) return false;
      if (r === ERR_INVALID_TARGET) { creep.memory.siteId = null; return false; }
      return true;
    }

    debugDraw(creep, site, CFG.DRAW.TRAVEL_COLOR, "TO•SITE");
    go(creep, site, 3, 15);
    return true;
  }

  // ==============================
  // Public API
  // ==============================
  var roleBuilder = {
    role: 'Builder',
    run: function (creep) {
      toggleBuilderState(creep);

      if (creep.memory.building) {
        runBuildPhase(creep);
        return;
      }

      // Refuel phase (no mining unless allowed)
      collectEnergy(creep);
    }
  };

  return roleBuilder;
})();

roleBeeWorker.Courier = (function () {
  // role.Courier – Energy hauler (ES5-safe) with SAY + DRAW breadcrumbs
  // Collect priority: Source CONTAINER -> big DROPS (en route) -> drops NEAR container -> GRAVES/RUINS -> misc DROPS -> STORAGE/TERMINAL
  // Deliver priority: SPAWNS/EXTENSIONS -> TOWERS (<= pct) -> STORAGE
  //
  // Shares PIB + same-tick reservation scheme with Queen to avoid target dogpiles.


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
  // Memory / state helpers
  // ============================
  function ensureCourierState(creep) {
    // Newer coders sometimes forget to guard both edges of the state machine.
    // We check the "cargo empty" and "cargo full" edges separately to keep it obvious
    // which condition flips us into delivery mode.
    if (creep.memory.transferring && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.transferring = false;
    }
    if (!creep.memory.transferring && creep.store.getFreeCapacity() === 0) {
      creep.memory.transferring = true;
    }

    // Stickies default to "null" so JSON.stringify stays light and our guards stay simple.
    if (creep.memory.pickupContainerId === undefined) creep.memory.pickupContainerId = null;
    if (creep.memory.retargetAt === undefined) creep.memory.retargetAt = 0;
    if (creep.memory.dropoffId === undefined) creep.memory.dropoffId = null;
  }

  // Break collection targets into small helpers so novice contributors can trace the flow
  // without scrolling through a mega-function.
  function pickBestSourceContainer(creep, cache, now) {
    var current = Game.getObjectById(creep.memory.pickupContainerId);
    var expired = now >= (creep.memory.retargetAt | 0);
    if (isGoodContainer(current) && !expired) return current;

    var best = Game.getObjectById(cache.bestSrcId);
    if (!isGoodContainer(best)) {
      var srcObjs = _idsToObjects(cache.srcIds);
      var bestEnergy = -1;
      for (var i = 0; i < srcObjs.length; i++) {
        var c = srcObjs[i];
        var e = (c.store && c.store[RESOURCE_ENERGY]) || 0;
        if (e >= CFG.CONTAINER_MIN && e > bestEnergy) {
          best = c;
          bestEnergy = e;
        }
      }
    }

    // Only switch when the new candidate is clearly better so we do not thrash between seats.
    if (!current || (best && current.id !== best.id && _clearlyBetter(best, current))) {
      creep.memory.pickupContainerId = best ? best.id : null;
      creep.memory.retargetAt = now + CFG.RETARGET_COOLDOWN;
      return best;
    }
    return current;
  }

  function tryPickupEnRoute(creep) {
    var nearby = creep.pos.findInRange(FIND_DROPPED_RESOURCES, CFG.DROPPED_ALONG_ROUTE_R, {
      filter: function (r) { return r.resourceType === RESOURCE_ENERGY && (r.amount | 0) >= CFG.DROPPED_BIG_MIN; }
    });
    if (!nearby || !nearby.length) return false;

    var pile = _closestByRange(creep.pos, nearby);
    debugSay(creep, '↘️Drop');
    debugDraw(creep, pile, CFG.DRAW.DROP_COLOR, "DROP*");
    if (creep.pickup(pile) === ERR_NOT_IN_RANGE) go(creep, pile, 1, 20);
    return true;
  }

  function tryContainerWorkflow(creep, container) {
    if (!isGoodContainer(container)) return false;

    // Drops near the container are low-effort fuel, so we scoop them before withdrawing.
    var drops = container.pos.findInRange(FIND_DROPPED_RESOURCES, CFG.DROPPED_NEAR_CONTAINER_R, {
      filter: function (r) { return r.resourceType === RESOURCE_ENERGY && (r.amount | 0) > 0; }
    });
    if (drops.length) {
      var bestDrop = _closestByRange(creep.pos, drops);
      debugSay(creep, '↘️Drop');
      debugDraw(creep, bestDrop, CFG.DRAW.DROP_COLOR, "DROP");
      var pr = creep.pickup(bestDrop);
      if (pr === ERR_NOT_IN_RANGE) { go(creep, bestDrop, 1, 20); return true; }
      if (pr === OK && creep.store.getFreeCapacity() === 0) { creep.memory.transferring = true; return true; }
    }

    var energyIn = (container.store && container.store[RESOURCE_ENERGY]) | 0;
    if (energyIn <= 0) {
      creep.memory.retargetAt = Game.time;
      return false;
    }

    debugSay(creep, '↘️Con');
    debugDraw(creep, container, CFG.DRAW.WD_COLOR, "CON");
    var wr = creep.withdraw(container, RESOURCE_ENERGY);
    if (wr === ERR_NOT_IN_RANGE) { go(creep, container, 1, CFG.PATH_REUSE); return true; }
    if (wr === OK) {
      if (creep.store.getFreeCapacity() === 0) creep.memory.transferring = true;
      return true;
    }
    if (wr === ERR_NOT_ENOUGH_RESOURCES) creep.memory.retargetAt = Game.time;
    return true;
  }

  function rescanGraves(roomCache, room) {
    if ((roomCache.nextGraveScanAt | 0) > Game.time) return;
    roomCache.nextGraveScanAt = Game.time + CFG.GRAVE_SCAN_COOLDOWN;
    var graves = room.find(FIND_TOMBSTONES, {
      filter: function (t) { return ((t.store[RESOURCE_ENERGY] | 0) > 0); }
    });
    var ruins = room.find(FIND_RUINS, {
      filter: function (r) { return ((r.store[RESOURCE_ENERGY] | 0) > 0); }
    });
    roomCache.graves = graves.concat(ruins);
  }

  function tryGraves(creep, roomCache) {
    if (!roomCache.graves || !roomCache.graves.length) return false;
    var grave = _closestByRange(creep.pos, roomCache.graves);
    if (!grave) return false;

    debugSay(creep, '↘️Grv');
    debugDraw(creep, grave, CFG.DRAW.GRAVE_COLOR, "GRAVE");
    var gw = creep.withdraw(grave, RESOURCE_ENERGY);
    if (gw === ERR_NOT_IN_RANGE) { go(creep, grave, 1, 20); }
    return true;
  }

  function tryGenericDrops(creep) {
    var dropped = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
      filter: function (r) { return r.resourceType === RESOURCE_ENERGY && (r.amount | 0) >= 50; }
    });
    if (!dropped) return false;
    debugSay(creep, '↘️Drop');
    debugDraw(creep, dropped, CFG.DRAW.DROP_COLOR, "DROP");
    if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) go(creep, dropped, 1, 20);
    return true;
  }

  function tryStorageWithdraw(creep) {
    var room = creep.room;
    var storeLike = (room.storage && (room.storage.store[RESOURCE_ENERGY] | 0) > 0) ? room.storage
                  : (room.terminal && (room.terminal.store[RESOURCE_ENERGY] | 0) > 0) ? room.terminal
                  : null;
    if (!storeLike) return false;
    debugSay(creep, storeLike.structureType === STRUCTURE_STORAGE ? '↘️Sto' : '↘️Term');
    debugDraw(creep, storeLike, CFG.DRAW.WD_COLOR, storeLike.structureType === STRUCTURE_STORAGE ? "STO" : "TERM");
    var sr = creep.withdraw(storeLike, RESOURCE_ENERGY);
    if (sr === ERR_NOT_IN_RANGE) { go(creep, storeLike, 1, CFG.PATH_REUSE); }
    return true;
  }

  function idleNearAnchor(creep) {
    var anchor = creep.room.storage || creep.pos.findClosestByRange(FIND_MY_SPAWNS) || creep.pos;
    debugSay(creep, 'IDLE');
    debugDraw(creep, (anchor.pos || anchor), CFG.DRAW.IDLE_COLOR, "IDLE");
    if (!creep.pos.inRangeTo(anchor, 3)) go(creep, anchor, 3, CFG.PATH_REUSE);
  }

  function ensureDropoffTarget(creep) {
    var target = Game.getObjectById(creep.memory.dropoffId);
    if (target && _effectiveFree(target, RESOURCE_ENERGY) > 0) return target;

    target = _pickSpawnExt(creep);
    if (!target) target = _pickTower(creep);
    if (!target) target = _pickStorage(creep);

    if (!target) return null;
    creep.memory.dropoffId = target.id;
    return target;
  }

  function drawDeliveryIntent(creep, target) {
    var st = target.structureType;
    if (st === STRUCTURE_EXTENSION) { debugSay(creep, '→ EXT'); debugDraw(creep, target, CFG.DRAW.FILL_COLOR, "EXT"); }
    else if (st === STRUCTURE_SPAWN) { debugSay(creep, '→ SPN'); debugDraw(creep, target, CFG.DRAW.FILL_COLOR, "SPN"); }
    else if (st === STRUCTURE_TOWER) { debugSay(creep, '→ TWR'); debugDraw(creep, target, CFG.DRAW.FILL_COLOR, "TWR"); }
    else if (st === STRUCTURE_STORAGE) { debugSay(creep, '→ STO'); debugDraw(creep, target, CFG.DRAW.FILL_COLOR, "STO"); }
    else { debugSay(creep, '→ FILL'); debugDraw(creep, target, CFG.DRAW.FILL_COLOR, "FILL"); }
  }

  // ============================
  // Main role
  // ============================
  var roleCourier = {
    role: 'Courier',
    run: function (creep) {
      ensureCourierState(creep);

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
      var now = Game.time | 0;
      var rc = _roomCache(creep.room);
      var container = pickBestSourceContainer(creep, rc, now);

      if (tryPickupEnRoute(creep)) return;
      if (container && tryContainerWorkflow(creep, container)) return;

      rescanGraves(rc, creep.room);
      if (tryGraves(creep, rc)) return;
      if (tryGenericDrops(creep)) return;
      if (tryStorageWithdraw(creep)) return;
      idleNearAnchor(creep);
    },

    // -----------------------------
    // Delivery (PIB-aware, avoids Queen conflicts)
    // -----------------------------
    deliverEnergy: function (creep) {
      var carryAmt = (creep.store.getUsedCapacity(RESOURCE_ENERGY) | 0);
      if (carryAmt <= 0) { creep.memory.transferring = false; creep.memory.dropoffId = null; return; }

      var target = ensureDropoffTarget(creep);
      if (!target) { idleNearAnchor(creep); return; }

      var reserved = reserveFill(creep, target, carryAmt, RESOURCE_ENERGY);
      if (reserved <= 0) { creep.memory.dropoffId = null; return; }

      drawDeliveryIntent(creep, target);
      var tr = transferTo(creep, target, RESOURCE_ENERGY);
      if (tr === OK && (creep.store[RESOURCE_ENERGY] | 0) === 0) {
        creep.memory.transferring = false;
        creep.memory.dropoffId = null;
      }
    }
  };

  return roleCourier;
})();

roleBeeWorker.Queen = (function () {
  // -----------------------------------------------------------------------------
  // role.Queen.js – economy hauler role
  // Responsibilities:
  // * Keeps a single "Queen" creep ferrying energy between sources (drops, links,
  //   tombstones, storage) and sinks (spawns/extensions/towers/storage terminals).
  // * Interacts with BeeSelectors.js for prioritised lists of energy sources and
  //   delivery targets, BeeActions.js for wrapped actions with movement, and
  //   Movement.Manager.js for centralised pathing priorities.
  // * Stores its finite-state machine in creep.memory._task (shape:
  //   {type, targetId, since, data}) and clears/refreshes it when targets change
  //   or run out of capacity.
  // * Uses global.__BHM.queenReservations to avoid multiple Queens double-booking
  //   the same sink in the same tick.
  // Called from: BeeHiveMind.runCreeps dispatcher -> roleQueen.run.
  // -----------------------------------------------------------------------------  
  // External selectors module; see BeeSelectors.js for source/sink scans.
  //var BeeSelectors = require('BeeSelectors');
  // Shared action wrappers with movement intents.
  //var BeeActions = require('BeeActions');
  // Central movement queue; roleQueen enqueues idles here.
  //var MovementManager = require('Movement.Manager');
  // Function header: debugSay(creep, msg)
  // Inputs: creep (Creep), msg (string emoji/text)
  // Output: none
  // Side-effects: optionally calls creep.say if CFG.DEBUG_SAY is true.
  // Preconditions: creep must be live in same tick, msg must be printable.
  // Failure modes: silently returns if debugging disabled or creep missing.
  function debugSay(creep, msg) {
    if (CFG.DEBUG_SAY && creep && msg) creep.say(msg, true);
  }

  // Function header: drawLine(creep, target, color, label)
  // Inputs: creep performing work, target (object with pos or RoomPosition),
  //         color hex string, optional label string.
  // Output: none
  // Side-effects: uses RoomVisual to draw intent lines (visible in client when
  //               CFG.DEBUG_DRAW is true).
  // Preconditions: creep.room.visual must exist; target must be visible.
  // Failure modes: try/catch absorbs RoomVisual errors (remote rooms).
  function drawLine(creep, target, color, label) {
    if (!CFG.DEBUG_DRAW || !creep || !target) return;
    var room = creep.room;
    if (!room || !room.visual) return;
    var pos = target.pos || target;
    if (!pos || pos.roomName !== room.name) return;
    try {
      room.visual.line(creep.pos, pos, {
        color: color,
        width: CFG.DRAW.WIDTH,
        opacity: CFG.DRAW.OPACITY,
        lineStyle: 'solid'
      });
      if (label) {
        room.visual.text(label, pos.x, pos.y - 0.3, {
          color: color,
          opacity: CFG.DRAW.OPACITY,
          font: CFG.DRAW.FONT,
          align: 'center'
        });
      }
    } catch (e) {}
  }

  // Function header: ensureTaskSlot(creep)
  // Inputs: creep whose memory we initialise.
  // Output: none
  // Side-effects: ensures creep.memory._task exists (null placeholder) so later
  //               code can read/write without guard checks.
  // Preconditions: creep.memory defined (Screeps always provides an object).
  function ensureTaskSlot(creep) {
    if (!creep || !creep.memory) return;
    if (!creep.memory._task) creep.memory._task = null;
  }

  // Function header: setTask(creep, task)
  // Inputs: creep, task envelope {type,targetId,since,data}
  // Output: none
  // Side-effects: overwrites creep.memory._task; this is persisted in Memory and
  //               survives restarts.
  // Preconditions: ensureTaskSlot should have been called first.
  function setTask(creep, task) {
    if (!creep || !creep.memory) return;
    creep.memory._task = task;
  }

  // Function header: clearTask(creep)
  // Inputs: creep
  // Output: none
  // Side-effects: resets creep.memory._task to null; next tick needsNewTask will
  //               select a new job.
  function clearTask(creep) {
    if (!creep || !creep.memory) return;
    creep.memory._task = null;
  }

  // Function header: getReservationBucket()
  // Inputs: none
  // Output: object map targetId -> reserved energy (per tick)
  // Side-effects: initialises global.__BHM.queenReservations for this tick; this
  //               cache is reset every tick to prevent long-term drift.
  // Preconditions: global.__BHM may already exist (BeeHiveMind initialises it).
  function getReservationBucket() {
    if (!global.__BHM) global.__BHM = {};
    if (!global.__BHM.queenReservations || global.__BHM.queenReservations.tick !== Game.time) {
      global.__BHM.queenReservations = { tick: Game.time, map: {} };
    }
    return global.__BHM.queenReservations.map;
  }

  // Function header: reserveFill(targetId, amount)
  // Inputs: targetId string, amount number (energy units planned to deliver)
  // Output: none
  // Side-effects: increments same-tick reservation counter so multiple Queens do
  //               not overfill one structure.
  function reserveFill(targetId, amount) {
    if (!targetId || amount <= 0) return;
    var map = getReservationBucket();
    var cur = map[targetId] || 0;
    map[targetId] = cur + amount;
  }

  // Function header: getReserved(targetId)
  // Inputs: targetId string
  // Output: number of energy units previously reserved this tick.
  // Side-effects: none.
  function getReserved(targetId) {
    if (!targetId) return 0;
    var map = getReservationBucket();
    return map[targetId] || 0;
  }

  // Function header: getEnergyStored(target)
  // Inputs: structure/resource with store or energy property.
  // Output: integer energy stored; handles structures with store or legacy energy.
  // Side-effects: none.
  function getEnergyStored(target) {
    if (!target) return 0;
    if (target.store) return target.store[RESOURCE_ENERGY] || 0;
    if (target.energy != null) return target.energy | 0;
    return 0;
  }

  // Function header: getFreeEnergyCapacity(target)
  // Inputs: structure with energyCapacity/store.
  // Output: how much additional energy target can accept.
  // Side-effects: none.
  function getFreeEnergyCapacity(target) {
    if (!target) return 0;
    if (target.store && target.store.getFreeCapacity) {
      return target.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
    }
    if (target.energyCapacity != null) {
      return (target.energyCapacity | 0) - (target.energy | 0);
    }
    return 0;
  }

  // Function header: createTask(type, targetId, data)
  // Inputs: type string, targetId (may be null), extra data payload (object)
  // Output: task envelope stored in creep.memory._task. since=Game.time for
  //         debugging and stale-task detection.
  // Side-effects: none (pure factory).
  function createTask(type, targetId, data) {
    return {
      type: type,
      targetId: targetId || null,
      since: Game.time,
      data: data || {}
    };
  }

  // Function header: getIdleAnchor(creep)
  // Inputs: creep
  // Output: structure used as idle anchor (storage > spawn > controller).
  // Side-effects: none; new RoomPosition created later if needed.
  // Notes: ensures idling near "base" to clear traffic lanes.
  function getIdleAnchor(creep) {
    if (!creep || !creep.room) return null;
    if (creep.room.storage) return creep.room.storage;
    var spawns = creep.room.find(FIND_MY_SPAWNS);
    if (spawns && spawns.length) return spawns[0];
    if (creep.room.controller) return creep.room.controller;
    return null;
  }

  // Function header: createIdleTask(creep)
  // Inputs: creep
  // Output: idle task envelope; task.data.pos stores static location and range.
  // Side-effects: none.
  function createIdleTask(creep) {
    var anchor = getIdleAnchor(creep);
    if (!anchor) return createTask('idle', null, null);
    var pos = anchor.pos || anchor;
    var data = {
      pos: { x: pos.x, y: pos.y, roomName: pos.roomName },
      range: 2
    };
    return createTask('idle', anchor.id || null, data);
  }

  // Function header: needsNewTask(creep, task)
  // Inputs: creep, current task envelope (may be null)
  // Output: boolean true when we must pick a fresh task (target gone, capacity
  //         mismatch, stuck for too long).
  // Side-effects: updates task.data.stuck and last position markers in-memory.
  // Preconditions: task.data is an object (initialised if missing).
  function needsNewTask(creep, task) {
    if (!task) return true;
    var target = task.targetId ? Game.getObjectById(task.targetId) : null;
    if (!task.data) task.data = {};

    if (task.type === 'withdraw') {
      // Withdraw task is invalid if target missing, creep already full, or
      // container depleted; this lets us switch to delivery/idle next tick.
      if (!target) return true;
      if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) return true;
      if (getEnergyStored(target) <= 0) return true;
    } else if (task.type === 'pickup') {
      // Dropped/tombstone tasks expire when energy is gone or creep is full.
      if (!target) return true;
      if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) return true;
      if (target.amount != null && target.amount <= 0) return true;
    } else if (task.type === 'deliver') {
      // Delivery tasks drop once the structure fills or we run out of cargo.
      if (!target) return true;
      if ((creep.store[RESOURCE_ENERGY] || 0) === 0) return true;
      if (getFreeEnergyCapacity(target) === 0) return true;
    } else if (task.type === 'idle') {
      // Always allow idle task to continue unless we have energy to move.
    }

    var data = task.data;
    if (data.lastPosX === creep.pos.x && data.lastPosY === creep.pos.y) {
      // Stuck detection: track consecutive ticks with no movement. Movement
      // priority conflicts (e.g., path blocked) cause us to repick a task, which
      // usually repaths to a new target or idles elsewhere.
      data.stuck = (data.stuck || 0) + 1;
      if (data.stuck >= CFG.STUCK_TICKS) return true;
    } else {
      // Movement happened; reset counter so task continues.
      data.stuck = 0;
      data.lastPosX = creep.pos.x;
      data.lastPosY = creep.pos.y;
    }

    return false;
  }

  // Function header: pickWithdrawTask(creep)
  // Inputs: creep (Queen)
  // Output: task envelope for withdrawing/picking up energy, prioritising drop
  //         loot -> tombstones -> ruins -> containers -> other sources.
  // Side-effects: none (no memory writes besides returned task).
  // Dependencies: BeeSelectors.getEnergySourcePriority (see BeeSelectors.js).
  function pickWithdrawTask(creep) {
    var room = creep.room;
    if (!room) return null;
    // -----------------------------
    // Queen-only preference order
    // Edit this array to change what Queens try first.
    // (If you set creep.memory.energyPref, that will override this list for THAT Queen only.)
    // Common sensible Queen order: battlefield cleanup first, then structured stores.
    var pref = (creep.memory && creep.memory.energyPref && creep.memory.energyPref.length)
    ? creep.memory.energyPref
    :['tomb','ruin','storage','drop','container','terminal','link'];
    // Build a room snapshot once
    var list = BeeSelectors.getEnergySourcePriority(room);
    if (!list || !list.length) return null;

    // Bucket snapshot entries by kind for quick access: { kind -> [targets] }
    var buckets = {};
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e || !e.target) continue;
      var k = e.kind || 'unknown';
      if (!buckets[k]) buckets[k] = [];
      buckets[k].push(e.target);
    }
    //walk the Queen's preference order; pick the closest target in the first non-empty bucket
    for (var p = 0; p < pref.length; p++) {
      var kind = pref[p];
      if (kind === 'source') continue; // Queens don't harvest
      var arr = buckets[kind];
      if (!arr || !arr.length) continue;
      // Prefer closest-by-range to reduce walking
      var best = BeeSelectors.selectClosestByRange
      ? BeeSelectors.selectClosestByRange(creep.pos, arr)
      : (function (){
          var win = null, bestD = 9999;
          for (var j = 0; j < arr.length; j++) {
            var t = arr[j];
            var d = creep.pos.getRangeTo(t);
            if (d < bestD) { bestD = d; win = t; }
          }
          return win;
        })();    
      if (!best) continue;
      // Map kind -> task
      if (kind === 'drop')      return createTask('pickup',   best.id, { source: 'drop' });
      if (kind === 'tomb')      return createTask('withdraw', best.id, { source: 'tomb' });
      if (kind === 'ruin')      return createTask('withdraw', best.id, { source: 'ruin' });
      if (kind === 'storage')   return createTask('withdraw', best.id, { source: 'storage' });
      if (kind === 'terminal')  return createTask('withdraw', best.id, { source: 'terminal' });
      if (kind === 'container') return createTask('withdraw', best.id, { source: 'container' });
      if (kind === 'link')      return createTask('withdraw', best.id, { source: 'link' });
      // Unknown kind: safe fallback
      return createTask('withdraw', best.id, { source: kind || 'energy' });
    }
    return null;
  }
  // Function header: pickDeliverTask(creep)
  // Inputs: creep with energy cargo
  // Output: task envelope targeting highest priority sink (spawn/extension,
  //         then tower, then storage/terminal)
  // Side-effects: reserves energy in global.__BHM.queenReservations to avoid
  //               over-assigning same sink; writes to reservation map only.
  // Dependencies: BeeSelectors.findSpawnLikeNeedingEnergy etc.
  function pickDeliverTask(creep) {
    var room = creep.room;
    if (!room) return null;

    var amount = creep.store[RESOURCE_ENERGY] || 0;
    if (amount <= 0) return null;

    var spawnLike = BeeSelectors.findSpawnLikeNeedingEnergy(room);
    var bestSpawn = BeeSelectors.selectClosestByRange(creep.pos, spawnLike);
    if (bestSpawn) {
      var freeSpawn = getFreeEnergyCapacity(bestSpawn);
      if (freeSpawn > getReserved(bestSpawn.id)) {
        // Reserve just enough capacity so later Queens see reduced space.
        var planAmount = Math.min(freeSpawn, amount);
        reserveFill(bestSpawn.id, planAmount);
        return createTask('deliver', bestSpawn.id, { sink: 'spawn' });
      }
    }

    var towers = BeeSelectors.findTowersNeedingEnergy(room);
    var bestTower = BeeSelectors.selectClosestByRange(creep.pos, towers);
    if (bestTower) {
      var freeTower = getFreeEnergyCapacity(bestTower);
      if (freeTower > getReserved(bestTower.id)) {
        var planTower = Math.min(freeTower, amount);
        reserveFill(bestTower.id, planTower);
        return createTask('deliver', bestTower.id, { sink: 'tower' });
      }
    }
    
    if (room.storage) {
      // [1] Gather candidate links near storage (radius 2 is typical; bump to 3 if your layout is spaced)
      var storagePos = room.storage.pos;
      var nearbyLinks = storagePos.findInRange(FIND_MY_STRUCTURES, 2, {
        filter: function (s) {
          return s.structureType === STRUCTURE_LINK;
        }
      });

      // If none are literally adjacent, fall back to "closest link in room" to be safe.
      if (!nearbyLinks || nearbyLinks.length === 0) {
        var allLinks = room.find(FIND_MY_STRUCTURES, {
          filter: function (s) {
            return s.structureType === STRUCTURE_LINK;
          }
        });
        // Choose the link closest to storage as our hub candidate
        if (allLinks && allLinks.length) {
          // If you have BeeSelectors, reuse its range helper for consistency
          // Otherwise, you could do storagePos.findClosestByRange(allLinks)
          nearbyLinks = [BeeSelectors.selectClosestByRange(storagePos, allLinks)];
        }
      }

      // [2] From the candidates, pick the one closest to the Queen (shortest run)
      var hubLink = BeeSelectors.selectClosestByRange(creep.pos, nearbyLinks);

      if (hubLink && hubLink.store) {
        // [3] Compute fill percentage and free space
        var cap  = hubLink.store.getCapacity(RESOURCE_ENERGY) || 0;
        var used = hubLink.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        var fillPct = cap > 0 ? (used / cap) : 1; // if weird zero-cap, treat as "full" to skip
        var free = cap - used;

        // [4] Only top-off if below 80% and there is real free capacity beyond any existing reservations
        if (cap > 0 && fillPct < 0.80 && free > 0) {
          // Respect your reservation system so multiple Queens don't overfill
          var reserved = getReserved(hubLink.id) || 0;
          var availForPlan = free - reserved;

          if (availForPlan > 0) {
            var planAmount = Math.min(amount, availForPlan);
            reserveFill(hubLink.id, planAmount);
            return createTask('deliver', hubLink.id, { sink: 'link_storage' });
          }
        }
      }
    }


    if (room.storage) {
      var storeFree = room.storage.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
      if (storeFree > 0) {
        // Storage fallback ensures excess energy is banked instead of idling.
        return createTask('deliver', room.storage.id, { sink: 'storage' });
      }
    }

    if (room.terminal) {
      var termFree = room.terminal.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
      if (termFree > 0) {
        return createTask('deliver', room.terminal.id, { sink: 'terminal' });
      }
    }

    return null;
  }

  // Function header: chooseNextTask(creep)
  // Inputs: creep (Queen)
  // Output: new task envelope (withdraw/pickup/deliver/idle)
  // Side-effects: none; pure decision based on current cargo and room state.
  function chooseNextTask(creep) {
    if ((creep.store[RESOURCE_ENERGY] || 0) === 0) {
      var withdrawTask = pickWithdrawTask(creep);
      if (withdrawTask) return withdrawTask;
    } else {
      var deliverTask = pickDeliverTask(creep);
      if (deliverTask) return deliverTask;
    }
    return createIdleTask(creep);
  }

  // Function header: executeTask(creep, task)
  // Inputs: creep, task envelope currently stored in memory
  // Output: none; issues actions via BeeActions.* wrappers and MovementManager.
  // Side-effects: may clearTask (memory mutation), may reserve move intents, may
  //               draw visuals. Branch per task.type ensures accurate action.
  // Failure modes: handles missing targets by clearing and returning.
  function executeTask(creep, task) {
    if (!task) return;
    var target = task.targetId ? Game.getObjectById(task.targetId) : null;
    var priority = CFG.MOVE_PRIORITIES[task.type] || 0;

    if (task.type === 'withdraw') {
      if (!target) { clearTask(creep); return; }
      drawLine(creep, target, CFG.DRAW.WITHDRAW, 'WD');
      debugSay(creep, '📥');
      // Calls BeeActions.safeWithdraw (BeeActions.js) which queues move intents
      // via Movement.Manager if not in range.
      var rc = BeeActions.safeWithdraw(creep, target, RESOURCE_ENERGY, { priority: priority, reusePath: 20 });
      if (rc === OK) {
        // When cargo full, release the task to select a delivery target next tick.
        if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) clearTask(creep);
      } else if (rc === ERR_NOT_ENOUGH_RESOURCES || rc === ERR_INVALID_TARGET) {
        // Source dried up or object vanished: clear so we re-scan.
        clearTask(creep);
      }
      return;
    }

    if (task.type === 'pickup') {
      if (!target) { clearTask(creep); return; }
      drawLine(creep, target, CFG.DRAW.PICKUP, 'P');
      debugSay(creep, '🍪');
      var pc = BeeActions.safePickup(creep, target, { priority: priority, reusePath: 10 });
      if (pc === OK) {
        if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) clearTask(creep);
      } else if (pc === ERR_INVALID_TARGET) {
        clearTask(creep);
      }
      return;
    }

    if (task.type === 'deliver') {
      if (!target) { clearTask(creep); return; }
      drawLine(creep, target, CFG.DRAW.DELIVER, 'DL');
      debugSay(creep, '🚚');
      // safeTransfer returns OK when energy actually transferred; ERR_FULL when
      // sink already filled by another hauler.
      var tr = BeeActions.safeTransfer(creep, target, RESOURCE_ENERGY, null, { priority: priority, reusePath: 20 });
      if (tr === OK) {
        if ((creep.store[RESOURCE_ENERGY] || 0) === 0) clearTask(creep);
      } else if (tr === ERR_FULL || tr === ERR_INVALID_TARGET) {
        clearTask(creep);
      }
      return;
    }

    if (task.type === 'idle') {
      var pos = task.data && task.data.pos;
      if (!pos) return;
      var anchor = new RoomPosition(pos.x, pos.y, pos.roomName);
      drawLine(creep, anchor, CFG.DRAW.IDLE, 'ID');
      // Idle behaviour simply holds position near anchor, giving way when
      // movement manager reuses path = 30 for stable parking.
      MovementManager.request(creep, anchor, priority, { range: task.data.range || 1, reusePath: 30 });
      return;
    }
  }

  var roleQueen = {
    role: 'Queen',
    // Function header: run(creep)
    // Inputs: Queen creep dispatched from BeeHiveMind role loop.
    // Output: none; drives task selection/execution and updates memory.
    // Side-effects: may call MovementManager.request, BeeActions wrappers, and
    //               mutate creep.memory._task. No return value used by caller.
    // Preconditions: creep.role/task set elsewhere (BeeHiveMind.assignTask).
    // Failure modes: gracefully exits if creep is spawning or invalid.
    run: function (creep) {
      if (!creep || creep.spawning) return;
      ensureTaskSlot(creep);

      var task = creep.memory._task;
      if (needsNewTask(creep, task)) {
        // When stale/invalid, choose a fresh job. chooseNextTask encodes gather →
        // deliver → idle lifecycle.
        task = chooseNextTask(creep);
        setTask(creep, task);
      }

      task = creep.memory._task;
      if (!task) {
        // Last-resort idle ensures memory slot never empty (prevents null checks).
        setTask(creep, createIdleTask(creep));
        task = creep.memory._task;
      }

      executeTask(creep, task);
    }
  };

  return roleQueen;
})();

roleBeeWorker.Upgrader = (function () {
  /** =========================
   *  Tiny debug helpers
   *  ========================= */
  function debugSay(creep, msg) {
    if (CFG.DEBUG_SAY && creep && typeof creep.say === 'function') creep.say(msg, true);
  }
  function _posOf(t) { return t && t.pos ? t.pos : t; }
  function _roomOf(pos) { return pos && Game.rooms[pos.roomName]; }

  function debugLine(from, to, color) {
    if (!CFG.DEBUG_DRAW || !from || !to) return;
    var f = _posOf(from), t = _posOf(to);
    if (!f || !t || f.roomName !== t.roomName) return;
    var R = _roomOf(f); if (!R || !R.visual) return;
    R.visual.line(f, t, { color: color, width: CFG.DRAW.WIDTH, opacity: CFG.DRAW.OPAC });
  }
  function debugRing(target, color, text) {
    if (!CFG.DEBUG_DRAW || !target) return;
    var p = _posOf(target); if (!p) return;
    var R = _roomOf(p); if (!R || !R.visual) return;
    R.visual.circle(p, { radius: 0.6, fill: "transparent", stroke: color, opacity: CFG.DRAW.OPAC, width: CFG.DRAW.WIDTH });
    if (text) R.visual.text(text, p.x, p.y - 0.8, { color: color, font: CFG.DRAW.FONT, opacity: 0.95, align: "center" });
  }

  /** =========================
   *  Travel wrapper (with path line)
   *  ========================= */
  function go(creep, dest, range) {
    var R = (range != null) ? range : 1;
    var dpos = _posOf(dest) || dest;
    if (creep.pos.roomName === dpos.roomName && creep.pos.getRangeTo(dpos) > R) {
      debugLine(creep.pos, dpos, CFG.DRAW.PATH);
    }
    if (creep.pos.getRangeTo(dpos) <= R) return OK;

    try {
      if (BeeToolbox && typeof BeeToolbox.BeeTravel === 'function') {
        return BeeToolbox.BeeTravel(creep, dpos, { range: R, reusePath: CFG.TRAVEL_REUSE });
      }
    } catch (e) {}
    if (typeof creep.travelTo === 'function') {
      return creep.travelTo(dpos, { range: R, reusePath: CFG.TRAVEL_REUSE, ignoreCreeps: false, maxOps: 4000 });
    }
    return creep.moveTo(dpos, { reusePath: CFG.TRAVEL_REUSE, maxOps: 1500 });
  }

  /** =========================
   *  Sign helper (unchanged logic, plus visuals)
   *  ========================= */
  function checkAndUpdateControllerSign(creep, controller) {
    if (!controller) return;
    var msg = CFG.SIGN_TEXT;

    var needs = (!controller.sign) || (controller.sign.text !== msg);
    if (!needs) return;

    if (creep.pos.inRangeTo(controller.pos, 1)) {
      var res = creep.signController(controller, msg);
      if (res === OK) {
        debugSay(creep, "🖊️");
        debugRing(controller, CFG.DRAW.CTRL, "signed");
        console.log("Upgrader " + creep.name + " updated the controller sign.");
      } else {
        console.log("Upgrader " + creep.name + " failed to update the controller sign. Error: " + res);
      }
    } else {
      debugSay(creep, "📝");
      debugLine(creep, controller, CFG.DRAW.CTRL);
      go(creep, controller, 1);
    }
  }

  function pickDroppedEnergy(creep) {
    var targetDroppedEnergyId = creep.memory.targetDroppedEnergyId;
    var droppedResource = targetDroppedEnergyId ? Game.getObjectById(targetDroppedEnergyId) : null;
    if (!droppedResource) {
      droppedResource = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
        filter: function (r) {
          return r.resourceType === RESOURCE_ENERGY && r.amount > 0;
        }
      });
      if (droppedResource) {
        creep.memory.targetDroppedEnergyId = droppedResource.id;
      }
    }
    if (droppedResource) {
      debugRing(droppedResource, CFG.DRAW.DROP, 'drop');
      debugLine(creep, droppedResource, CFG.DRAW.DROP);
      var pr = creep.pickup(droppedResource);
      if (pr === ERR_NOT_IN_RANGE) {
        go(creep, droppedResource, 1);
      } else if (pr === OK) {
        debugSay(creep, "📦");
        creep.memory.targetDroppedEnergyId = null;
      }
      return true;
    }
    creep.memory.targetDroppedEnergyId = null;
    return false;
  }

  // =========================
  // Main role
  // =========================
  return {
    role: 'Upgrader',

    run: function (creep) {
      if (!creep) return;
      ensureRoleIdentity(creep);
      toggleUpgradingState(creep);

      if (creep.memory.upgrading) {
        runUpgradePhase(creep);
        return;
      }
      runRefuelPhase(creep);
    }
  };

  function ensureRoleIdentity(creep) {
    if (creep.memory && !creep.memory.role) creep.memory.role = 'Upgrader';
  }

  function toggleUpgradingState(creep) {
    if (creep.memory.upgrading && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.upgrading = false;
      creep.memory.targetDroppedEnergyId = null;
      debugSay(creep, "🔄 refuel");
    } else if (!creep.memory.upgrading && creep.store.getFreeCapacity() === 0) {
      creep.memory.upgrading = true;
      debugSay(creep, "⚡ upgrade");
    }
  }

  function runUpgradePhase(creep) {
    var controller = creep.room.controller;
    if (!controller) return;

    if (shouldPauseAtSafeRCL8(controller)) {
      checkAndUpdateControllerSign(creep, controller);
      debugSay(creep, "⏸");
      debugRing(controller, CFG.DRAW.CTRL, "safe");
      return;
    }

    var ur = creep.upgradeController(controller);
    if (ur === ERR_NOT_IN_RANGE) {
      debugLine(creep, controller, CFG.DRAW.CTRL);
      go(creep, controller, 3);
    } else if (ur === OK) {
      debugRing(controller, CFG.DRAW.CTRL, "UP");
    }
    checkAndUpdateControllerSign(creep, controller);
  }

  function shouldPauseAtSafeRCL8(controller) {
    if (!CFG.SKIP_RCL8_IF_SAFE) return false;
    if (controller.level !== 8) return false;
    return (controller.ticksToDowngrade | 0) > CFG.RCL8_SAFE_TTL;
  }

  function runRefuelPhase(creep) {
    if (tryLinkPull(creep)) return;
    tryToolboxSweep(creep);
    if (tryWithdrawStorage(creep)) return;
    if (tryWithdrawContainer(creep)) return;
    if (pickDroppedEnergy(creep)) return;
    if (CFG.DEBUG_DRAW) debugSay(creep, "❓");
  }

  function tryLinkPull(creep) {
    var ctrl = creep.room.controller;
    if (!ctrl) return false;
    var linkNearController = creep.pos.findClosestByRange(FIND_STRUCTURES, {
      filter: function (s) {
        return s.structureType === STRUCTURE_LINK &&
          s.store && (s.store[RESOURCE_ENERGY] | 0) > 0 &&
          s.pos.inRangeTo(ctrl, 3);
      }
    });
    if (!linkNearController) return false;
    var lr = creep.withdraw(linkNearController, RESOURCE_ENERGY);
    debugRing(linkNearController, CFG.DRAW.LINK, "LINK");
    debugLine(creep, linkNearController, CFG.DRAW.LINK);
    if (lr === ERR_NOT_IN_RANGE) go(creep, linkNearController, 1);
    return true;
  }

  function tryToolboxSweep(creep) {
    try {
      if (BeeToolbox && typeof BeeToolbox.collectEnergy === 'function') {
        BeeToolbox.collectEnergy(creep);
      }
    } catch (e) {}
  }

  function tryWithdrawStorage(creep) {
    var stor = creep.room.storage;
    if (!stor || !stor.store || (stor.store[RESOURCE_ENERGY] | 0) <= 0) return false;
    debugRing(stor, CFG.DRAW.STORE, "STO");
    debugLine(creep, stor, CFG.DRAW.STORE);
    var sr = creep.withdraw(stor, RESOURCE_ENERGY);
    if (sr === ERR_NOT_IN_RANGE) go(creep, stor, 1);
    return true;
  }

  function tryWithdrawContainer(creep) {
    var containerWithEnergy = creep.pos.findClosestByPath(FIND_STRUCTURES, {
      filter: function (s) {
        return s.structureType === STRUCTURE_CONTAINER &&
          s.store && (s.store[RESOURCE_ENERGY] | 0) > 0;
      }
    });
    if (!containerWithEnergy) return false;
    debugRing(containerWithEnergy, CFG.DRAW.CONT, "CONT");
    debugLine(creep, containerWithEnergy, CFG.DRAW.CONT);
    var cr = creep.withdraw(containerWithEnergy, RESOURCE_ENERGY);
    if (cr === ERR_NOT_IN_RANGE) go(creep, containerWithEnergy, 1);
    return true;
  }
})();


// -----------------------------------------------------------------------------
// Inline legacy role.Luna (auto-generated bundle)
// -----------------------------------------------------------------------------
roleBeeWorker.Luna = (function () {
  var module = { exports: {} };
  var exports = module.exports;
  // ============================
  // Tunables (existing behaviour)
  // ============================
  // NOTE: REMOTE_RADIUS is measured in "room hops" from the home room.
  var REMOTE_RADIUS = 1;

  var MAX_PF_OPS    = 3000;
  var PLAIN_COST    = 2;
  var SWAMP_COST    = 10;
  var MAX_LUNA_PER_SOURCE = 1;

  var PF_CACHE_TTL = 150;
  var INVADER_LOCK_MEMO_TTL = 1500;

  var AVOID_TTL = 30;
  var RETARGET_COOLDOWN = 5;

  // Small bias to keep the current owner briefly (soft preference only)
  var ASSIGN_STICKY_TTL = 50;

  // Anti-stuck
  var STUCK_WINDOW = 4;

  // Flag pruning cadence & grace (sources only)
  var FLAG_PRUNE_PERIOD   = 25;   // how often to scan for source-flag deletions
  var FLAG_RETENTION_TTL  = 200;  // keep a source-flag this many ticks since last activity

  // ============================
  // Helpers: SAY + DRAW
  // ============================
  function debugSay(creep, msg) {
    if (CFG.DEBUG_SAY && creep && msg) creep.say(msg, true);
  }
  function _posOf(target) {
    if (!target) return null;
    if (target.pos) return target.pos;
    if (target.x != null && target.y != null && target.roomName) return target; // RoomPosition-like
    return null;
  }
  function debugDraw(creep, target, color, label) {
    if (!CFG.DEBUG_DRAW || !creep || !target) return;
    var room = creep.room; if (!room || !room.visual) return;

    var tpos = _posOf(target); if (!tpos || tpos.roomName !== room.name) return;

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
  function debugRing(room, pos, color, text) {
    if (!CFG.DEBUG_DRAW || !room || !room.visual || !pos) return;
    try {
      room.visual.circle(pos, { radius: 0.5, fill: "transparent", stroke: color, opacity: CFG.DRAW.OPACITY, width: CFG.DRAW.WIDTH });
      if (text) room.visual.text(text, pos.x, pos.y - 0.6, { color: color, font: CFG.DRAW.FONT, opacity: CFG.DRAW.OPACITY, align: "center" });
    } catch (e) {}
  }

  // ============================
  // Helpers: short id, flags
  // ============================
  function shortSid(id) {
    if (!id || typeof id !== 'string') return '??????';
    var n = id.length; return id.substr(n - 6);
  }

  function _roomMem(roomName){
    Memory.rooms = Memory.rooms || {};
    return (Memory.rooms[roomName] = (Memory.rooms[roomName] || {}));
  }
  function _sourceMem(roomName, sid) {
    var rm = _roomMem(roomName);
    rm.sources = rm.sources || {};
    return (rm.sources[sid] = (rm.sources[sid] || {}));
  }

  // mark activity each time we touch/own/harvest a source
  function touchSourceActive(roomName, sid) {
    if (!roomName || !sid) return;
    var srec = _sourceMem(roomName, sid);
    srec.lastActive = Game.time;
  }

  /** Ensure exactly one flag exists on this source tile (idempotent) and touch lastActive. */
  function ensureSourceFlag(source) {
    if (!source || !source.pos || !source.room) return;

    var roomName = source.pos.roomName;
    var srec = _sourceMem(roomName, source.id);

    // reuse previous flag if it still matches this tile
    if (srec.flagName) {
      var f = Game.flags[srec.flagName];
      if (f &&
          f.pos.x === source.pos.x &&
          f.pos.y === source.pos.y &&
          f.pos.roomName === roomName) {
        touchSourceActive(roomName, source.id);
        return;
      }
    }

    // does a properly-named flag already sit here? adopt it
    var flagsHere = source.pos.lookFor(LOOK_FLAGS) || [];
    var expectedPrefix = 'SRC-' + roomName + '-';
    var sidTail = shortSid(source.id);
    for (var i = 0; i < flagsHere.length; i++) {
      var fh = flagsHere[i];
      if (typeof fh.name === 'string' &&
          fh.name.indexOf(expectedPrefix) === 0 &&
          fh.name.indexOf(sidTail) !== -1) {
        srec.flagName = fh.name;
        touchSourceActive(roomName, source.id);
        return;
      }
    }

    // create a new one
    var base = expectedPrefix + sidTail;
    var name = base, tries = 1;
    while (Game.flags[name]) { tries++; name = base + '-' + tries; if (tries > 10) break; }
    var rc = source.room.createFlag(source.pos, name, COLOR_YELLOW, COLOR_YELLOW);
    if (typeof rc === 'string') {
      srec.flagName = rc;
      touchSourceActive(roomName, source.id);
    }
  }

  // ============================
  // NEW: Controller flag helpers (Reserve:roomName style)
  // ============================
  function ensureControllerFlag(ctrl){
    if (!ctrl) return;
    var roomName = ctrl.pos.roomName;
    var rm = _roomMem(roomName);

    var expect = 'Reserve:' + roomName;

    if (rm.controllerFlagName) {
      var f0 = Game.flags[rm.controllerFlagName];
      if (f0 &&
          f0.pos.x === ctrl.pos.x &&
          f0.pos.y === ctrl.pos.y &&
          f0.pos.roomName === roomName) {
        return;
      }
    }

    var flagsHere = ctrl.pos.lookFor(LOOK_FLAGS) || [];
    for (var i = 0; i < flagsHere.length; i++) {
      if (flagsHere[i].name === expect) {
        rm.controllerFlagName = expect;
        return;
      }
    }

    var rc = ctrl.room.createFlag(ctrl.pos, expect, COLOR_WHITE, COLOR_PURPLE);
    if (typeof rc === 'string') rm.controllerFlagName = rc;
  }

  function pruneControllerFlagIfNoForagers(roomName, roomCountMap){
    var rm = _roomMem(roomName);
    var fname = rm.controllerFlagName;
    if (!fname) return;

    var count = roomCountMap && roomCountMap[roomName] ? roomCountMap[roomName] : 0;
    if (count > 0) return;

    var f = Game.flags[fname];
    if (f) {
      try { f.remove(); } catch (e) {}
    }
    delete rm.controllerFlagName;
  }

  // ============================
  // Avoid-list (per creep)
  // ============================
  function _ensureAvoid(creep){ if (!creep.memory._avoid) creep.memory._avoid = {}; return creep.memory._avoid; }
  function shouldAvoid(creep, sid){ var a=_ensureAvoid(creep); var t=a[sid]; return (typeof t==='number' && Game.time<t); }
  function markAvoid(creep, sid, ttl){ var a=_ensureAvoid(creep); a[sid] = Game.time + (ttl!=null?ttl:AVOID_TTL); }
  function avoidRemaining(creep, sid){ var a=_ensureAvoid(creep); var t=a[sid]; if (typeof t!=='number') return 0; var left=t-Game.time; return left>0?left:0; }

  // ============================
  // Per-tick *claim* (same-tick contention guard)
  // ============================
  function _claimTable(){ var sc=Memory._sourceClaim; if(!sc||sc.t!==Game.time){ Memory._sourceClaim={t:Game.time,m:{}}; } return Memory._sourceClaim.m; }
  function tryClaimSourceForTick(creep, sid){
    var m=_claimTable(), cur=m[sid];
    if (!cur){ m[sid]=creep.name; return true; }
    if (creep.name < cur){ m[sid]=creep.name; return true; }
    return cur===creep.name;
  }

  // ============================
  // remoteAssignments model
  // ============================
  function ensureAssignmentsMem(){ if(!Memory.remoteAssignments) Memory.remoteAssignments={}; return Memory.remoteAssignments; }
  function _maEnsure(entry, roomName){
    if (!entry || typeof entry !== 'object') entry = { count: 0, owner: null, roomName: roomName||null, since: null };
    if (typeof entry.count !== 'number') entry.count = (entry.count|0);
    if (!('owner' in entry)) entry.owner = null;
    if (!('roomName' in entry)) entry.roomName = roomName||null;
    if (!('since' in entry)) entry.since = null;
    return entry;
  }
  function maCount(memAssign, sid){
    var e = memAssign[sid];
    if (!e) return 0;
    if (typeof e === 'number') return e; // backward compat
    return e.count|0;
  }
  function maOwner(memAssign, sid){
    var e = memAssign[sid];
    if (!e || typeof e === 'number') return null;
    return e.owner || null;
  }
  function maSetOwner(memAssign, sid, owner, roomName){
    var e = _maEnsure(memAssign[sid], roomName);
    e.owner = owner; e.roomName = roomName || e.roomName; e.since = Game.time;
    memAssign[sid] = e;
    if (e.roomName) touchSourceActive(e.roomName, sid);
  }
  function maClearOwner(memAssign, sid){
    var e = _maEnsure(memAssign[sid], null);
    e.owner = null; e.since = null;
    memAssign[sid] = e;
  }
  function maInc(memAssign, sid, roomName){
    var e = _maEnsure(memAssign[sid], roomName); e.count = (e.count|0) + 1; memAssign[sid]=e;
  }
  function maDec(memAssign, sid){
    var e = _maEnsure(memAssign[sid], null); e.count = Math.max(0,(e.count|0)-1); memAssign[sid]=e;
  }

  // ============================
  // Ownership / duplicate resolver
  // ============================
  function resolveOwnershipForSid(sid){
    var memAssign = ensureAssignmentsMem();
    var e = _maEnsure(memAssign[sid], null);

    var contenders = [];
    for (var name in Game.creeps){
      var c = Game.creeps[name];
      if (!c || !c.memory) continue;
      if (c.memory.task === 'luna' && c.memory.sourceId === sid){
        contenders.push(c);
      }
    }

    if (!contenders.length){
      maClearOwner(memAssign, sid);
      return null;
    }

    contenders.sort(function(a,b){
      var at = a.memory._assignTick||0, bt=b.memory._assignTick||0;
      if (at!==bt) return at-bt;
      return a.name<b.name?-1:1;
    });
    var winner = contenders[0];

    maSetOwner(memAssign, sid, winner.name, winner.memory.targetRoom||null);

    for (var i=1; i<contenders.length; i++){
      var loser = contenders[i];
      if (loser && loser.memory && loser.memory.sourceId === sid){
        loser.memory._forceYield = true;
      }
    }

    return winner.name;
  }

  // Audits all sids once per tick: recompute counts, scrub dead owners, and prune flags
  function auditRemoteAssignments(){
    var memAssign = ensureAssignmentsMem();

    for (var sid in memAssign){
      memAssign[sid] = _maEnsure(memAssign[sid], memAssign[sid].roomName||null);
      memAssign[sid].count = 0;
    }

    var roomCounts = {};
    for (var name in Game.creeps){
      var c = Game.creeps[name];
      if (!c || !c.memory) continue;
      if (c.memory.task === 'luna') {
        if (c.memory.sourceId){
          var sid2 = c.memory.sourceId;
          var e2 = _maEnsure(memAssign[sid2], c.memory.targetRoom||null);
          e2.count = (e2.count|0) + 1;
          memAssign[sid2] = e2;
        }
        if (c.memory.targetRoom){
          var rn = c.memory.targetRoom;
          roomCounts[rn] = (roomCounts[rn]|0) + 1;
        }
      }
    }

    for (var sid3 in memAssign){
      var owner = maOwner(memAssign, sid3);
      if (owner){
        var oc = Game.creeps[owner];
        if (!oc || !oc.memory || oc.memory.sourceId !== sid3){
          resolveOwnershipForSid(sid3);
        }else{
          if (memAssign[sid3].count > MAX_LUNA_PER_SOURCE){
            resolveOwnershipForSid(sid3);
          }
        }
      }else{
        if (memAssign[sid3].count > 0){
          resolveOwnershipForSid(sid3);
        }
      }
    }

    if ((Game.time % FLAG_PRUNE_PERIOD) === 0) pruneUnusedSourceFlags();

    var rooms = Memory.rooms || {};
    for (var roomName in rooms) {
      if (!rooms.hasOwnProperty(roomName)) continue;
      pruneControllerFlagIfNoForagers(roomName, roomCounts);
    }
  }

  function auditOncePerTick(){
    if (Memory._auditRemoteAssignmentsTick !== Game.time){
      auditRemoteAssignments();
      Memory._auditRemoteAssignmentsTick = Game.time;
    }
  }

  // ============================
  // Flag pruning (sources)
  // ============================
  function pruneUnusedSourceFlags(){
    var memAssign = ensureAssignmentsMem();
    var now = Game.time;

    var rooms = Memory.rooms || {};
    for (var roomName in rooms){
      if (!rooms.hasOwnProperty(roomName)) continue;
      var rm = rooms[roomName]; if (!rm || !rm.sources) continue;

      var roomLocked = isRoomLockedByInvaderCore(roomName);

      for (var sid in rm.sources){
        if (!rm.sources.hasOwnProperty(sid)) continue;
        var srec = rm.sources[sid] || {};
        var flagName = srec.flagName;
        if (!flagName) continue;

        var e = _maEnsure(memAssign[sid], rm.sources[sid].roomName || roomName);
        var count  = e.count|0;
        var owner  = e.owner || null;
        var last   = srec.lastActive|0;

        var inactiveLong = (now - last) > FLAG_RETENTION_TTL;
        var nobodyOwns   = (count === 0 && owner == null);

        if (roomLocked || (nobodyOwns && inactiveLong)) {
          var f = Game.flags[flagName];
          if (f) {
            var prefix = 'SRC-' + roomName + '-';
            var looksLikeOurs = (typeof flagName === 'string' && flagName.indexOf(prefix) === 0);
            var posMatches = (!srec.x || !srec.y) ? true : (f.pos.x === srec.x && f.pos.y === srec.y);
            var srcObj = Game.getObjectById(sid);
            var tileOk = srcObj ? (f.pos.x === srcObj.pos.x && f.pos.y === srcObj.pos.y && f.pos.roomName === srcObj.pos.roomName) : true;

            if (looksLikeOurs && (posMatches && tileOk)) {
              try { f.remove(); } catch (e1) {}
            }
          }
          delete srec.flagName;
          rm.sources[sid] = srec;
        }
      }
    }
  }

  // ============================
  // Pathing helpers (Traveler-first)
  // ============================
  if (!Memory._pfCost) Memory._pfCost = {};

  function pfCostCached(anchorPos, targetPos, sourceId) {
    var key = anchorPos.roomName + ':' + sourceId;
    var rec = Memory._pfCost[key];
    if (rec && (Game.time - rec.t) < PF_CACHE_TTL) return rec.c;
    var c = pfCost(anchorPos, targetPos);
    Memory._pfCost[key] = { c: c, t: Game.time };
    return c;
  }
  function pfCost(anchorPos, targetPos) {
    var ret = PathFinder.search(
      anchorPos,
      { pos: targetPos, range: 1 },
      {
        maxOps: MAX_PF_OPS,
        plainCost: PLAIN_COST,
        swampCost: SWAMP_COST,
        roomCallback: function(roomName) {
          var room = Game.rooms[roomName]; if (!room) return;
          var m = new PathFinder.CostMatrix();
          room.find(FIND_STRUCTURES).forEach(function(s){
            if (s.structureType===STRUCTURE_ROAD) m.set(s.pos.x,s.pos.y,1);
            else if (s.structureType!==STRUCTURE_CONTAINER && (s.structureType!==STRUCTURE_RAMPART || !s.my)) m.set(s.pos.x,s.pos.y,0xff);
          });
          room.find(FIND_CONSTRUCTION_SITES).forEach(function(cs){ if (cs.structureType!==STRUCTURE_ROAD) m.set(cs.pos.x,cs.pos.y,0xff); });
          return m;
        }
      }
    );
    return ret.incomplete ? Infinity : ret.cost;
  }
  function go(creep, dest, opts){
    opts = opts || {};
    var desired = (opts.range!=null) ? opts.range : 1;
    if (creep.pos.getRangeTo(dest) <= desired) return;
    var tOpts = {
      range: desired,
      reusePath: (opts.reusePath!=null?opts.reusePath:15),
      ignoreCreeps: true,
      stuckValue: 2,
      repath: 0.05,
      maxOps: 6000
    };
    if (BeeToolbox && BeeToolbox.roomCallback) tOpts.roomCallback = BeeToolbox.roomCallback;
    debugDraw(creep, dest, CFG.DRAW.TRAVEL_COLOR, "GO");
    creep.travelTo((dest.pos||dest), tOpts);
  }

  // ============================
  // Room discovery & anchor
  // ============================
  function getHomeName(creep){
    if (creep.memory.home) return creep.memory.home;
    var spawns = Object.keys(Game.spawns).map(function(k){return Game.spawns[k];});
    if (spawns.length){
      var best = spawns[0], bestD = Game.map.getRoomLinearDistance(creep.pos.roomName, best.pos.roomName);
      for (var i=1;i<spawns.length;i++){
        var s=spawns[i], d=Game.map.getRoomLinearDistance(creep.pos.roomName, s.pos.roomName);
        if (d<bestD){ best=s; bestD=d; }
      }
      creep.memory.home = best.pos.roomName; return creep.memory.home;
    }
    creep.memory.home = creep.pos.roomName; return creep.memory.home;
  }
  function getAnchorPos(homeName){
    var r = Game.rooms[homeName];
    if (r){
      if (r.storage) return r.storage.pos;
      var spawns = r.find(FIND_MY_SPAWNS); if (spawns.length) return spawns[0].pos;
      if (r.controller && r.controller.my) return r.controller.pos;
    }
    return new RoomPosition(25,25,homeName);
  }
  function bfsNeighborRooms(startName, radius){
    radius = radius==null?1:radius;
    var seen={}; seen[startName]=true;
    var frontier=[startName];
    for (var depth=0; depth<radius; depth++){
      var next=[];
      for (var f=0; f<frontier.length; f++){
        var rn=frontier[f], exits=Game.map.describeExits(rn)||{};
        for (var dir in exits){ var n=exits[dir]; if(!seen[n]){ seen[n]=true; next.push(n);} }
      }
      frontier=next;
    }
    var out=[]; for (var k in seen) if (k!==startName) out.push(k);
    return out;
  }

  // ============================
  // Flagging helper (sources)
  // ============================
  function markValidRemoteSourcesForHome(homeName){
    var anchor=getAnchorPos(homeName);
    var memAssign=ensureAssignmentsMem();
    var rooms=bfsNeighborRooms(homeName, REMOTE_RADIUS);

    for (var i=0;i<rooms.length;i++){
      var rn=rooms[i], room=Game.rooms[rn]; if(!room) continue;
      var rm = _roomMem(rn);
      if (rm.hostile) continue;
      if (isRoomLockedByInvaderCore(rn)) continue;

      if (rm._lastValidFlagScan && (Game.time - rm._lastValidFlagScan) < 300) continue;
      rm._lastValidFlagScan = Game.time;

      var sources = room.find(FIND_SOURCES);
      for (var j=0;j<sources.length;j++){
        var s=sources[j];
        var e=_maEnsure(memAssign[s.id], rn);
        if (maCount(memAssign, s.id) >= MAX_LUNA_PER_SOURCE) continue;
        var cost = pfCostCached(anchor, s.pos, s.id); if (cost===Infinity) continue;
        ensureSourceFlag(s);
        var srec = _sourceMem(rn, s.id); srec.x = s.pos.x; srec.y = s.pos.y;
        memAssign[s.id] = e;
      }
    }
  }

  // ============================
  // Invader lock detection
  // ============================
  function isRoomLockedByInvaderCore(roomName){
    if (!roomName) return false;
    var rm = _roomMem(roomName);
    var now = Game.time, room = Game.rooms[roomName];

    if (room){
      var locked=false;
      var cores = room.find(FIND_STRUCTURES, { filter:function(s){return s.structureType===STRUCTURE_INVADER_CORE;} });
      if (cores && cores.length>0) locked=true;
      if (!locked && room.controller && room.controller.reservation &&
          room.controller.reservation.username==='Invader'){ locked=true; }
      if (!locked && BeeToolbox && BeeToolbox.isRoomInvaderLocked){
        try{ if (BeeToolbox.isRoomInvaderLocked(room)) locked=true; }catch(e){}
      }
      rm._invaderLock = { locked: locked, t: now };
      return locked;
    }

    if (rm._invaderLock && typeof rm._invaderLock.locked==='boolean' && typeof rm._invaderLock.t==='number'){
      if ((now - rm._invaderLock.t) <= INVADER_LOCK_MEMO_TTL) return rm._invaderLock.locked;
    }
    return false;
  }

  // ============================
  // Picking & exclusivity
  // ============================
  function pickRemoteSource(creep){
    var memAssign = ensureAssignmentsMem();
    var homeName = getHomeName(creep);

    if ((Game.time + creep.name.charCodeAt(0)) % 50 === 0) markValidRemoteSourcesForHome(homeName);
    var anchor = getAnchorPos(homeName);

    var neighborRooms = bfsNeighborRooms(homeName, REMOTE_RADIUS);
    var candidates=[], avoided=[], i, rn;

    // 1) With vision
    for (i=0;i<neighborRooms.length;i++){
      rn=neighborRooms[i];
      if (isRoomLockedByInvaderCore(rn)) continue;
      var room=Game.rooms[rn]; if (!room) continue;

      var sources = room.find(FIND_SOURCES);
      for (var j=0;j<sources.length;j++){
        var s=sources[j];
        var cost = pfCostCached(anchor, s.pos, s.id); if (cost===Infinity) continue;
        var lin = Game.map.getRoomLinearDistance(homeName, rn);

        if (shouldAvoid(creep, s.id)){ avoided.push({id:s.id,roomName:rn,cost:cost,lin:lin,left:avoidRemaining(creep,s.id)}); continue; }
        var ownerNow = maOwner(memAssign, s.id);
        if (ownerNow && ownerNow !== creep.name) continue;
        if (maCount(memAssign, s.id) >= MAX_LUNA_PER_SOURCE) continue;

        var sticky = (creep.memory.sourceId===s.id) ? 1 : 0;
        candidates.push({ id:s.id, roomName:rn, cost:cost, lin:lin, sticky:sticky });
      }
    }

    // 2) No vision → use Memory.rooms.*.sources
    if (!candidates.length){
      for (i=0;i<neighborRooms.length;i++){
        rn=neighborRooms[i]; if (isRoomLockedByInvaderCore(rn)) continue;
        var rm = _roomMem(rn); if (!rm || !rm.sources) continue;
        for (var sid in rm.sources){
          if (shouldAvoid(creep, sid)){ avoided.push({id:sid,roomName:rn,cost:1e9,lin:99,left:avoidRemaining(creep,sid)}); continue; }
          var ownerNow2 = maOwner(memAssign, sid);
          if (ownerNow2 && ownerNow2 !== creep.name) continue;
          if (maCount(memAssign, sid) >= MAX_LUNA_PER_SOURCE) continue;

          var lin2 = Game.map.getRoomLinearDistance(homeName, rn);
          var synth = (lin2*200)+800;
          var sticky2 = (creep.memory.sourceId===sid) ? 1 : 0;
          candidates.push({ id:sid, roomName:rn, cost:synth, lin:lin2, sticky:sticky2 });
        }
      }
    }

    if (!candidates.length){
      if (!avoided.length) return null;
      avoided.sort(function(a,b){ return (a.left-b.left)||(a.cost-b.cost)||(a.lin-b.lin)||(a.id<b.id?-1:1); });
      var soonest = avoided[0];
      if (soonest.left <= 5) candidates.push(soonest); else return null;
    }

    candidates.sort(function(a,b){
      if (b.sticky !== a.sticky) return (b.sticky - a.sticky);
      return (a.cost-b.cost) || (a.lin-b.lin) || (a.id<b.id?-1:1);
    });

    // (Fixed loop condition)
    for (var k=0; k<candidates.length; k++){
      var best=candidates[k];
      if (!tryClaimSourceForTick(creep, best.id)) continue;

      // Reserve immediately
      maInc(memAssign, best.id, best.roomName);
      maSetOwner(memAssign, best.id, creep.name, best.roomName);

      // Visuals + say:
      var srcObj = Game.getObjectById(best.id);
      if (srcObj) {
        debugSay(creep, '🎯SRC');
        debugDraw(creep, srcObj, CFG.DRAW.PICK_COLOR, "PICK");
        debugRing(creep.room, srcObj.pos, CFG.DRAW.PICK_COLOR, shortSid(best.id));
      } else {
        var center = new RoomPosition(25,25,best.roomName);
        debugSay(creep, '🎯'+best.roomName);
        debugDraw(creep, center, CFG.DRAW.TRAVEL_COLOR, "PICK?");
      }

      if (creep.memory._lastLogSid !== best.id){
        console.log('🧭 '+creep.name+' pick src='+best.id.slice(-6)+' room='+best.roomName+' cost='+best.cost+(best.sticky?' (sticky)':''));
        creep.memory._lastLogSid = best.id;
      }
      return best;
    }

    return null;
  }

  function releaseAssignment(creep){
    var memAssign = ensureAssignmentsMem();
    var sid = creep.memory.sourceId;

    if (sid){
      maDec(memAssign, sid);
      var owner = maOwner(memAssign, sid);
      if (owner === creep.name) maClearOwner(memAssign, sid);
      markAvoid(creep, sid, AVOID_TTL);
    }

    creep.memory.sourceId   = null;
    creep.memory.targetRoom = null;
    creep.memory.assigned   = false;
    creep.memory._retargetAt = Game.time + RETARGET_COOLDOWN;

    debugSay(creep, '🌓YIELD');
  }

  function validateExclusiveSource(creep){
    if (!creep.memory || !creep.memory.sourceId) return true;

    var sid = creep.memory.sourceId;
    var memAssign = ensureAssignmentsMem();
    var owner = maOwner(memAssign, sid);

    if (owner && owner !== creep.name){
      releaseAssignment(creep);
      return false;
    }

    var winners=[];
    for (var name in Game.creeps){
      var c=Game.creeps[name];
      if (c && c.memory && c.memory.task==='luna' && c.memory.sourceId===sid){
        winners.push(c);
      }
    }
    if (winners.length <= MAX_LUNA_PER_SOURCE){
      if (!owner) maSetOwner(memAssign, sid, creep.name, creep.memory.targetRoom||null);
      return true;
    }

    winners.sort(function(a,b){
      var at=a.memory._assignTick||0, bt=b.memory._assignTick||0;
      if (at!==bt) return at-bt;
      return a.name<b.name?-1:1;
    });
    var win = winners[0];
    maSetOwner(memAssign, sid, win.name, win.memory.targetRoom||null);

    if (win.name !== creep.name){
      console.log('🚦 '+creep.name+' yielding duplicate source '+sid.slice(-6)+' (backing off).');
      releaseAssignment(creep);
      return false;
    }
    return true;
  }

  // ============================
  // NEW: dump energy into build/upgrade when storage is full
  // ============================
  function tryBuildOrUpgrade(creep) {
    var hasWork = (creep.getActiveBodyparts && creep.getActiveBodyparts(WORK)) | 0;
    if (!hasWork) return false;

    var site = creep.pos.findClosestByRange(FIND_CONSTRUCTION_SITES);
    if (site) {
      debugSay(creep, '🔨');
      debugDraw(creep, site, CFG.DRAW.BUILD_COLOR, "BUILD");
      var br = creep.build(site);
      if (br === ERR_NOT_IN_RANGE) go(creep, site, { range: 3, reusePath: 15 });
      return true;
    }

    var ctrl = creep.room.controller;
    if (ctrl && ctrl.my) {
      debugSay(creep, '⬆️');
      debugDraw(creep, ctrl, CFG.DRAW.UPG_COLOR, "UPG");
      var ur = creep.upgradeController(ctrl);
      if (ur === ERR_NOT_IN_RANGE) go(creep, ctrl, { range: 3, reusePath: 15 });
      return true;
    }

    return false;
  }

  // ============================
  // Teaching helpers for the run loop
  // ============================
  function ensureLunaIdentity(creep) {
    if (creep && creep.memory && creep.memory.task === 'remoteharvest') {
      creep.memory.task = 'luna';
    }
  }

  function trackMovementBreadcrumb(creep) {
    if (!creep || !creep.memory) return;
    var lastX=creep.memory._lx|0, lastY=creep.memory._ly|0, lastR=creep.memory._lr||'';
    var samePos = (lastX===creep.pos.x && lastY===creep.pos.y && lastR===creep.pos.roomName);
    creep.memory._stuck = samePos ? ((creep.memory._stuck|0)+1) : 0;
    creep.memory._lx = creep.pos.x; creep.memory._ly = creep.pos.y; creep.memory._lr = creep.pos.roomName;
  }

  function idleAtAnchor(creep, label) {
    var anchor = getAnchorPos(getHomeName(creep));
    debugSay(creep, label || 'IDLE');
    debugDraw(creep, anchor, CFG.DRAW.IDLE_COLOR, label || 'IDLE');
    go(creep, anchor, { range: 2 });
  }

  function shouldReleaseForEndOfLife(creep) {
    if (creep.ticksToLive!==undefined && creep.ticksToLive<5 && creep.memory.assigned){
      releaseAssignment(creep);
      return true;
    }
    return false;
  }

  function respectCooldown(creep) {
    if (creep.memory._retargetAt && Game.time < creep.memory._retargetAt){
      idleAtAnchor(creep, '…cd');
      return true;
    }
    return false;
  }

  function handleForcedYield(creep) {
    if (!creep.memory._forceYield) return false;
    delete creep.memory._forceYield;
    releaseAssignment(creep);
    return true;
  }

  function ensureActiveAssignment(creep) {
    if (creep.memory.sourceId) return true;

    var pick = pickRemoteSource(creep);
    if (pick){
      creep.memory.sourceId   = pick.id;
      creep.memory.targetRoom = pick.roomName;
      creep.memory.assigned   = true;
      creep.memory._assignTick = Game.time;
      return true;
    }

    roleLuna.initializeAndAssign(creep);
    if (!creep.memory.sourceId){
      idleAtAnchor(creep, 'IDLE');
      return false;
    }
    creep.memory._assignTick = creep.memory._assignTick || Game.time;
    return true;
  }

  function travelToAssignedRoom(creep) {
    if (!creep.memory.targetRoom || creep.pos.roomName === creep.memory.targetRoom) return false;
    var dest = new RoomPosition(25,25,creep.memory.targetRoom);
    debugSay(creep, '➡️'+creep.memory.targetRoom);
    debugDraw(creep, dest, CFG.DRAW.TRAVEL_COLOR, "ROOM");
    go(creep, dest, { range:20, reusePath:20 });
    return true;
  }

  // ============================
  // Main role
  // ============================
  var roleLuna = {
    role: 'Luna',
    run: function(creep){
      ensureLunaIdentity(creep);
      auditOncePerTick();
      if (!creep.memory.home) getHomeName(creep);

      trackMovementBreadcrumb(creep);

      // Carry state lives in one place; from here on we trust the boolean.
      roleLuna.updateReturnState(creep);
      if (creep.memory.returning){ roleLuna.returnToStorage(creep); return; }

      if (shouldReleaseForEndOfLife(creep)) return;
      if (respectCooldown(creep)) return;
      if (handleForcedYield(creep)) return;

      if (!ensureActiveAssignment(creep)) return;

      // If room got locked by invader activity, drop and repick
      if (creep.memory.targetRoom && isRoomLockedByInvaderCore(creep.memory.targetRoom)){
        debugSay(creep, '⛔LOCK');
        var center = new RoomPosition(25,25,creep.memory.targetRoom);
        debugDraw(creep, center, CFG.DRAW.TRAVEL_COLOR, "LOCK");
        console.log('⛔ '+creep.name+' skipping locked room '+creep.memory.targetRoom+' (Invader activity).');
        releaseAssignment(creep);
        return;
      }

      if (!validateExclusiveSource(creep)) return;
      if (travelToAssignedRoom(creep)) return;

      // Defensive: memory wipe mid-run
      if (!creep.memory.targetRoom || !creep.memory.sourceId){
        roleLuna.initializeAndAssign(creep);
        if (!creep.memory.targetRoom || !creep.memory.sourceId){
          if (Game.time % 25 === 0) console.log('🚫 Forager '+creep.name+' could not be assigned a room/source.');
          return;
        }
      }

      var targetRoomObj = Game.rooms[creep.memory.targetRoom];
      if (targetRoomObj && BeeToolbox && BeeToolbox.logSourcesInRoom){ try { BeeToolbox.logSourcesInRoom(targetRoomObj); } catch (e) {} }

      var tmem = _roomMem(creep.memory.targetRoom);
      if (tmem && tmem.hostile){
        console.log('⚠️ Forager '+creep.name+' avoiding hostile room '+creep.memory.targetRoom);
        debugSay(creep, '⚠️HOST');
        releaseAssignment(creep);
        return;
      }
      if (!tmem || !tmem.sources) return;

      var ctl = targetRoomObj && targetRoomObj.controller;
      if (ctl) { ensureControllerFlag(ctl); debugRing(targetRoomObj, ctl.pos, CFG.DRAW.TRAVEL_COLOR, "CTRL"); }

      roleLuna.harvestSource(creep);
    },

    // ---- Legacy fallback (no vision) — now radius-bounded ----
    getNearbyRoomsWithSources: function(creep){
      var homeName = getHomeName(creep);

      var inRadius = {};
      var ring = bfsNeighborRooms(homeName, REMOTE_RADIUS);
      for (var i=0; i<ring.length; i++) inRadius[ring[i]] = true;

      var all = Object.keys(Memory.rooms||{});
      var filtered = all.filter(function(roomName){
        var rm = Memory.rooms[roomName];
        if (!rm || !rm.sources) return false;
        if (!inRadius[roomName]) return false;
        if (rm.hostile) return false;
        if (isRoomLockedByInvaderCore(roomName)) return false;
        return roomName !== Memory.firstSpawnRoom;
      });

      return filtered.sort(function(a,b){
        return Game.map.getRoomLinearDistance(homeName, a) - Game.map.getRoomLinearDistance(homeName, b);
      });
    },

    findRoomWithLeastForagers: function(rooms, homeName){
      if (!rooms || !rooms.length) return null;

      var inRadius = {};
      var ring = bfsNeighborRooms(homeName, REMOTE_RADIUS);
      for (var i=0; i<ring.length; i++) inRadius[ring[i]] = true;

      var best=null, lowest=Infinity;
      for (var j=0;j<rooms.length;j++){
        var rn=rooms[j];
        if (!inRadius[rn]) continue;
        if (isRoomLockedByInvaderCore(rn)) continue;

        var rm=_roomMem(rn), sources = rm.sources?Object.keys(rm.sources):[]; if (!sources.length) continue;

        var count=0;
        for (var name in Game.creeps){
          var c=Game.creeps[name];
          if (c && c.memory && c.memory.task==='luna' && c.memory.targetRoom===rn) count++;
        }
        var avg = count / Math.max(1,sources.length);
        if (avg < lowest){ lowest=avg; best=rn; }
      }
      return best;
    },

    initializeAndAssign: function(creep){
      var targetRooms = roleLuna.getNearbyRoomsWithSources(creep);
      if (!creep.memory.targetRoom || !creep.memory.sourceId){
        var least = roleLuna.findRoomWithLeastForagers(targetRooms, getHomeName(creep));
        if (!least){ if (Game.time%25===0) console.log('🚫 Forager '+creep.name+' found no suitable room with unclaimed sources.'); return; }
        creep.memory.targetRoom = least;

        var roomMemory = _roomMem(creep.memory.targetRoom);
        var sid = roleLuna.assignSource(creep, roomMemory);
        if (sid){
          creep.memory.sourceId = sid;
          creep.memory.assigned = true;
          creep.memory._assignTick = Game.time;

          var memAssign = ensureAssignmentsMem();
          maInc(memAssign, sid, creep.memory.targetRoom);
          maSetOwner(memAssign, sid, creep.name, creep.memory.targetRoom);

          debugSay(creep, '🎯SRC');
          var srcObj = Game.getObjectById(sid);
          if (srcObj) { debugDraw(creep, srcObj, CFG.DRAW.PICK_COLOR, "ASSIGN"); debugRing(creep.room, srcObj.pos, CFG.DRAW.PICK_COLOR, shortSid(sid)); }
          else { var center = new RoomPosition(25,25,creep.memory.targetRoom); debugDraw(creep, center, CFG.DRAW.TRAVEL_COLOR, "ASSIGN"); }

          if (creep.memory._lastLogSid !== sid){
            console.log('🐝 '+creep.name+' assigned to source: '+sid+' in '+creep.memory.targetRoom);
            creep.memory._lastLogSid = sid;
          }
        }else{
          if (Game.time%25===0) console.log('No available sources for creep: '+creep.name);
          creep.memory.targetRoom=null; creep.memory.sourceId=null;
        }
      }
    },

    assignSource: function(creep, roomMemory){
      if (!roomMemory || !roomMemory.sources) return null;
      var sids = Object.keys(roomMemory.sources); if (!sids.length) return null;

      var memAssign = ensureAssignmentsMem();
      var free=[], sticky=[], rest=[];
      for (var i=0;i<sids.length;i++){
        var sid=sids[i];
        var owner = maOwner(memAssign, sid);
        var cnt   = maCount(memAssign, sid);
        if (owner && owner !== creep.name) continue;
        if (cnt >= MAX_LUNA_PER_SOURCE) continue;

        if (creep.memory.sourceId===sid) sticky.push(sid);
        else if (!owner) free.push(sid);
        else rest.push(sid);
      }

      var pick = free[0] || sticky[0] || rest[0] || null;
      if (!pick) return null;

      if (!tryClaimSourceForTick(creep, pick)) return null;
      return pick;
    },

    updateReturnState: function(creep){
      if (!creep.memory.returning && creep.store.getFreeCapacity(RESOURCE_ENERGY)===0) { creep.memory.returning=true; debugSay(creep, '⤴️RET'); }
      if (creep.memory.returning && creep.store.getUsedCapacity(RESOURCE_ENERGY)===0) { creep.memory.returning=false; debugSay(creep, '⤵️WK'); }
    },

    // UPDATED: includes build/upgrade fallback when all sinks are full
    returnToStorage: function(creep){
      var homeName = getHomeName(creep);

      // Go home first
      if (creep.room.name !== homeName) {
        var destHome = new RoomPosition(25, 25, homeName);
        debugSay(creep, '🏠');
        debugDraw(creep, destHome, CFG.DRAW.TRAVEL_COLOR, "HOME");
        go(creep, destHome, { range: 20, reusePath: 20 });
        return;
      }

      // Priority 1: Extensions/Spawns/Towers
      var pri = creep.room.find(FIND_STRUCTURES, {
        filter: function (s) {
          if (!s.store) return false;
          var t = s.structureType;
          if (t !== STRUCTURE_EXTENSION && t !== STRUCTURE_SPAWN && t !== STRUCTURE_TOWER) return false;
          return (s.store.getFreeCapacity(RESOURCE_ENERGY) | 0) > 0;
        }
      });
      if (pri.length) {
        var a = creep.pos.findClosestByPath(pri);
        if (a) {
          var lbl = (a.structureType===STRUCTURE_EXTENSION?'EXT': a.structureType===STRUCTURE_SPAWN?'SPN':'TWR');
          debugSay(creep, '→ '+lbl);
          debugDraw(creep, a, CFG.DRAW.DELIVER_COLOR, lbl);
          var rc = creep.transfer(a, RESOURCE_ENERGY);
          if (rc === ERR_NOT_IN_RANGE) go(creep, a);
          return;
        }
      }

      // Priority 2: Storage
      var stor = creep.room.storage;
      if (stor && stor.store && stor.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        debugSay(creep, '→ STO');
        debugDraw(creep, stor, CFG.DRAW.DELIVER_COLOR, "STO");
        var rc2 = creep.transfer(stor, RESOURCE_ENERGY);
        if (rc2 === ERR_NOT_IN_RANGE) go(creep, stor);
        return;
      }

      // Priority 3: Any container with room
      var conts = creep.room.find(FIND_STRUCTURES, {
        filter: function (s) {
          return s.structureType === STRUCTURE_CONTAINER &&
                 s.store && (s.store.getFreeCapacity(RESOURCE_ENERGY) | 0) > 0;
        }
      });
      if (conts.length) {
        var b = creep.pos.findClosestByPath(conts);
        if (b) {
          debugSay(creep, '→ CON');
          debugDraw(creep, b, CFG.DRAW.DELIVER_COLOR, "CON");
          var rc3 = creep.transfer(b, RESOURCE_ENERGY);
          if (rc3 === ERR_NOT_IN_RANGE) go(creep, b);
          return;
        }
      }

      // Everything is full → build/upgrade
      if (tryBuildOrUpgrade(creep)) return;

      // Idle near anchor
      var anchor = getAnchorPos(homeName);
      debugSay(creep, 'IDLE');
      debugDraw(creep, anchor, CFG.DRAW.IDLE_COLOR, "IDLE");
      go(creep, anchor, { range: 2 });
    },

    harvestSource: function(creep){
      if (!creep.memory.targetRoom || !creep.memory.sourceId){
        if (Game.time%25===0) console.log('Forager '+creep.name+' missing targetRoom/sourceId'); return;
      }

      if (creep.room.name !== creep.memory.targetRoom){
        var dest = new RoomPosition(25,25,creep.memory.targetRoom);
        debugSay(creep, '➡️'+creep.memory.targetRoom);
        debugDraw(creep, dest, CFG.DRAW.TRAVEL_COLOR, "ROOM");
        go(creep, dest, { range:20,reusePath:20 }); return;
      }

      if (isRoomLockedByInvaderCore(creep.room.name)){
        debugSay(creep, '⛔LOCK');
        console.log('⛔ '+creep.name+' bailing from locked room '+creep.room.name+'.');
        releaseAssignment(creep); return;
      }

      var sid = creep.memory.sourceId;
      var src = Game.getObjectById(sid);
      if (!src){ if (Game.time%25===0) console.log('Source not found for '+creep.name); releaseAssignment(creep); return; }

      ensureSourceFlag(src);
      var srec = _sourceMem(creep.room.name, sid); srec.x = src.pos.x; srec.y = src.pos.y;

      if (creep.room.controller) ensureControllerFlag(creep.room.controller);

      var rm = _roomMem(creep.memory.targetRoom);
      rm.sources = rm.sources || {};
      if (rm.sources[sid] && rm.sources[sid].entrySteps == null){
        var res = PathFinder.search(creep.pos, { pos: src.pos, range: 1 }, { plainCost: PLAIN_COST, swampCost: SWAMP_COST, maxOps: MAX_PF_OPS });
        if (!res.incomplete) rm.sources[sid].entrySteps = res.path.length;
      }

      if ((creep.memory._stuck|0) >= STUCK_WINDOW){ go(creep, src, { range:1, reusePath:3 }); debugSay(creep, '🚧'); }

      debugSay(creep, '⛏️SRC');
      debugDraw(creep, src, CFG.DRAW.SRC_COLOR, "SRC");
      var rc = creep.harvest(src);
      if (rc===ERR_NOT_IN_RANGE) go(creep, src, { range:1, reusePath:15 });
      else if (rc===OK){
        touchSourceActive(creep.room.name, sid);
      }
    }
  };

  roleLuna.MAX_LUNA_PER_SOURCE = MAX_LUNA_PER_SOURCE;

  module.exports = roleLuna;

  return module.exports;
})();

// -----------------------------------------------------------------------------
// Inline legacy role.Scout (auto-generated bundle)
// -----------------------------------------------------------------------------
roleBeeWorker.Scout = (function () {
  var module = { exports: {} };
  var exports = module.exports;
  /** =========================
   *  Tiny debug helpers
   *  ========================= */
  function debugSay(creep, msg) {
    if (CFG.DEBUG_SAY && creep && msg) creep.say(msg, true);
  }
  function _posOf(target) {
    if (!target) return null;
    if (target.pos) return target.pos;
    if (target.x != null && target.y != null && target.roomName) return target;
    return null;
  }
  function debugDrawLine(from, to, color, label) {
    if (!CFG.DEBUG_DRAW || !from || !to) return;
    var fpos = (from.pos || from);
    var tpos = _posOf(to);
    if (!fpos || !tpos) return;
    var room = Game.rooms[fpos.roomName];
    if (!room || !room.visual || tpos.roomName !== fpos.roomName) return;
    try {
      room.visual.line(fpos, tpos, { color: color, width: CFG.DRAW.WIDTH, opacity: CFG.DRAW.OPACITY });
      if (label) room.visual.text(label, (fpos.x + tpos.x)/2, (fpos.y + tpos.y)/2 - 0.3,
        { color: color, opacity: 0.9, font: CFG.DRAW.FONT, align: "center",
          backgroundColor: "#000000", backgroundOpacity: 0.25 });
    } catch (e) {}
  }
  function debugRing(room, pos, color, text) {
    if (!CFG.DEBUG_DRAW || !room || !room.visual || !pos) return;
    try {
      room.visual.circle(pos, { radius: 0.6, fill: "transparent", stroke: color, opacity: CFG.DRAW.OPACITY, width: CFG.DRAW.WIDTH });
      if (text) room.visual.text(text, pos.x, pos.y - 0.8, { color: color, font: CFG.DRAW.FONT, opacity: 0.9, align: "center" });
    } catch (e) {}
  }
  function debugLabel(room, pos, text, color) {
    if (!CFG.DEBUG_DRAW || !room || !room.visual || !pos || !text) return;
    try {
      room.visual.text(text, pos.x, pos.y - 1.2, {
        color: color || CFG.DRAW.TEXT, font: CFG.DRAW.FONT, opacity: 0.95, align: "center",
        backgroundColor: "#000000", backgroundOpacity: 0.25
      });
    } catch (e) {}
  }
  function drawExitMarker(room, exitDir, label, color) {
    if (!CFG.DEBUG_DRAW || !room || !room.visual) return;
    var x = 25, y = 25;
    if (exitDir === FIND_EXIT_TOP)    { y = 1;  x = 25; }
    if (exitDir === FIND_EXIT_BOTTOM) { y = 48; x = 25; }
    if (exitDir === FIND_EXIT_LEFT)   { x = 1;  y = 25; }
    if (exitDir === FIND_EXIT_RIGHT)  { x = 48; y = 25; }
    var pos = new RoomPosition(x, y, room.name);
    debugRing(room, pos, color, label);
  }

  /** =========================
   *  Tunables (original)
   *  ========================= */
  // ---------- Tunables ----------
  var EXPLORE_RADIUS     = 5;      // max linear distance (rooms) from home
  var REVISIT_DELAY      = 1000;   // re-visit cadence per room
  var BLOCK_CHECK_DELAY  = 10000;  // keep a room "blocked" this long
  var EXIT_BLOCK_TTL     = 600;    // cache exit-is-blocked checks
  var INTEL_INTERVAL     = 150;    // same-room deep intel cadence
  var PATH_REUSE         = 50;     // path reuse for inter-room moves
  var DIRS_CLOCKWISE     = [RIGHT, BOTTOM, LEFT, TOP]; // E,S,W,N

  // ---------- Global caches ----------
  if (!global.__SCOUT) {
    global.__SCOUT = {
      statusByRoom: Object.create(null),     // rn -> {status, ts}
      exitsOrdered: Object.create(null),     // rn -> [adjacent rn]
      exitBlock: Object.create(null),        // "rn|dir" -> {blocked, expire}
      rings: Object.create(null)             // "home|r" -> [rn...]
    };
  }

  // ---------- Name <-> coords ----------
  function parseRoomName(name) {
    var m = /([WE])(\d+)([NS])(\d+)/.exec(name);
    if (!m) return null;
    var hx = m[1], vx = m[3];
    var x = parseInt(m[2], 10), y = parseInt(m[4], 10);
    if (hx === 'W') x = -x;
    if (vx === 'N') y = -y;
    return { x: x, y: y };
  }
  function toRoomName(x, y) {
    var hx = x >= 0 ? 'E' : 'W';
    var vx = y >= 0 ? 'S' : 'N';
    var ax = Math.abs(x), ay = Math.abs(y);
    return hx + ax + vx + ay;
  }

  // Ring of rooms at manhattan radius r
  function coordinateRing(centerName, r) {
    var c = parseRoomName(centerName);
    if (!c || r < 1) return [];
    var out = [], x, y;

    x = c.x + r; y = c.y - (r - 1);
    for (; y <= c.y + r; y++) out.push(toRoomName(x, y));
    y = c.y + r - 1; x = c.x + r - 1;
    for (; x >= c.x - r; x--) out.push(toRoomName(x, y));
    x = c.x - r; y = c.y + r - 1;
    for (; y >= c.y - r; y--) out.push(toRoomName(x, y));
    y = c.y - r; x = c.x - r + 1;
    for (; x <= c.x + r; x++) out.push(toRoomName(x, y));

    // de-dup corners
    var seen = {}; var dedup = [];
    for (var i = 0; i < out.length; i++) if (!seen[out[i]]) { seen[out[i]] = true; dedup.push(out[i]); }
    return dedup;
  }

  // ---------- Cached helpers ----------
  function okRoomName(rn) {
    var cache = global.__SCOUT.statusByRoom;
    var st = cache[rn];
    if (!st || (Game.time - st.ts > 5000)) {
      var s = Game.map.getRoomStatus(rn);
      st = { status: (s && s.status) || 'normal', ts: Game.time };
      cache[rn] = st;
    }
    return !(st.status === 'novice' || st.status === 'respawn' || st.status === 'closed');
  }
  function exitsOrdered(roomName) {
    var cache = global.__SCOUT.exitsOrdered;
    var ex = cache[roomName];
    if (!ex) {
      var desc = Game.map.describeExits(roomName) || {};
      var out = [];
      for (var i = 0; i < DIRS_CLOCKWISE.length; i++) {
        var d = DIRS_CLOCKWISE[i];
        if (desc[d]) out.push(desc[d]);
      }
      cache[roomName] = out;
      return out;
    }
    return ex;
  }
  function getRingCached(homeName, radius) {
    var key = homeName + '|' + radius;
    var rings = global.__SCOUT.rings;
    var r = rings[key];
    if (r) return r;

    var raw = coordinateRing(homeName, radius);
    var ok = [];
    for (var i = 0; i < raw.length; i++) if (okRoomName(raw[i])) ok.push(raw[i]);
    rings[key] = ok;
    return ok;
  }
  function markBlocked(roomName) {
    if (!Memory.rooms) Memory.rooms = {};
    if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
    Memory.rooms[roomName].blocked = Game.time;

    // visual: center red ring if visible
    if (CFG.DEBUG_DRAW && Game.rooms[roomName]) {
      var R = Game.rooms[roomName];
      var center = new RoomPosition(25,25,roomName);
      debugRing(R, center, CFG.DRAW.BLOCK, "BLOCK");
    }
  }
  function isBlockedRecently(roomName) {
    if (!Memory.rooms) return false;
    var mr = Memory.rooms[roomName];
    var t = mr && mr.blocked;
    return !!(t && (Game.time - t < BLOCK_CHECK_DELAY));
  }

  // ---------- Visit + intel ----------
  function stampVisit(roomName) {
    if (!Memory.rooms) Memory.rooms = {};
    if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
    var rm = Memory.rooms[roomName];
    if (!rm.scout) rm.scout = {};
    rm.scout.lastVisited = Game.time;
  }
  function lastVisited(roomName) {
    if (!Memory.rooms) return -Infinity;
    var mr = Memory.rooms[roomName];
    var scout = mr && mr.scout;
    return (scout && typeof scout.lastVisited === 'number') ? scout.lastVisited : -Infinity;
  }
  function shouldLogIntel(room) {
    var r = (Memory.rooms && Memory.rooms[room.name]) ? Memory.rooms[room.name] : null;
    var lastScan = (r && r.intel && r.intel.lastScanAt) ? r.intel.lastScanAt : -Infinity;
    return (Game.time - lastScan) >= INTEL_INTERVAL;
  }
  function _getMyUsername(creep) {
    if (creep && creep.owner && creep.owner.username) return creep.owner.username;
    for (var name in Game.spawns) {
      var sp = Game.spawns[name];
      if (sp && sp.my && sp.owner && sp.owner.username) return sp.owner.username;
    }
    for (var r in Game.rooms) {
      var rm = Game.rooms[r];
      if (rm && rm.controller && rm.controller.my && rm.controller.owner && rm.controller.owner.username) {
        return rm.controller.owner.username;
      }
    }
    return null;
  }
  function _intelFor(roomName) {
    if (!Memory.rooms) return null;
    var mr = Memory.rooms[roomName];
    return (mr && mr.intel) ? mr.intel : null;
  }
  function _shouldSkipPlayerRoom(roomName, creep) {
    var intel = _intelFor(roomName);
    if (!intel) return false;
    var myName = _getMyUsername(creep);
    if (intel.owner && intel.owner !== 'Invader' && intel.owner !== myName) return true;
    if (intel.reservation && intel.reservation !== 'Invader' && intel.reservation !== myName) return true;
    return false;
  }
  // Acceptance: Scout queues skip rooms owned/reserved by non-Invader players
  function seedSourcesFromVision(room) {
    if (!room) return;
    Memory.rooms = Memory.rooms || {};
    var rm = Memory.rooms[room.name] = (Memory.rooms[room.name] || {});
    rm.sources = rm.sources || {};
    var arr = room.find(FIND_SOURCES);
    for (var i = 0; i < arr.length; i++) {
      var s = arr[i];
      var rec = rm.sources[s.id] = (rm.sources[s.id] || {});
      rec.roomName = room.name;
      rec.x = s.pos.x;
      rec.y = s.pos.y;
      rec.lastSeen = Game.time;
    }
  }
  function logRoomIntel(room) {
    if (!room) return;
    Memory.rooms = Memory.rooms || {};
    var rmem = Memory.rooms[room.name] = (Memory.rooms[room.name] || {});
    var intel = rmem.intel = (rmem.intel || {});
    intel.lastVisited = Game.time;
    intel.lastScanAt  = Game.time;

    intel.sources = room.find(FIND_SOURCES).length;

    var c = room.controller;
    if (c) {
      intel.owner       = (c.owner && c.owner.username) || null;
      intel.reservation = (c.reservation && c.reservation.username) || null;
      intel.rcl         = c.level || 0;
      intel.safeMode    = c.safeMode || 0;
    }

    var cores = room.find(FIND_STRUCTURES, { filter: function(s){ return s.structureType === STRUCTURE_INVADER_CORE; } });
    if (cores.length) {
      var core = cores[0];
      intel.invaderCore = {
        present: true,
        x: core.pos.x, y: core.pos.y,
        level: (typeof core.level === 'number' ? core.level : null),
        ticksToDeploy: (typeof core.ticksToDeploy === 'number' ? core.ticksToDeploy : null),
        t: Game.time
      };
    } else {
      intel.invaderCore = intel.invaderCore && intel.invaderCore.present ? intel.invaderCore : { present: false, t: Game.time };
    }

    var lairs = room.find(FIND_STRUCTURES, { filter: function(s){ return s.structureType === STRUCTURE_KEEPER_LAIR; } });
    intel.keeperLairs = lairs.length;

    var mins = room.find(FIND_MINERALS);
    if (mins.length) {
      var m0 = mins[0];
      intel.mineral = {
        type: m0.mineralType || null,
        x: m0.pos.x, y: m0.pos.y,
        amount: (typeof m0.mineralAmount === 'number' ? m0.mineralAmount : null),
        t: Game.time
      };
    }

    var deps = [];
    if (typeof FIND_DEPOSITS !== 'undefined') {
      var dlist = room.find(FIND_DEPOSITS) || [];
      for (var i = 0; i < dlist.length; i++) {
        var d = dlist[i];
        deps.push({ x: d.pos.x, y: d.pos.y, type: d.depositType || null, cooldown: d.cooldown || 0 });
      }
    }
    intel.deposits = deps;

    var pbs = room.find(FIND_STRUCTURES, { filter: function(s){ return s.structureType === STRUCTURE_POWER_BANK; } });
    if (pbs.length) {
      var pb = pbs[0];
      intel.powerBank = { x: pb.pos.x, y: pb.pos.y, hits: pb.hits, power: pb.power, ticksToDecay: pb.ticksToDecay };
    } else {
      intel.powerBank = null;
    }

    var portals = room.find(FIND_STRUCTURES, { filter:function(s){return s.structureType===STRUCTURE_PORTAL;} });
    var plist = [];
    for (var p = 0; p < portals.length; p++) {
      var pr = portals[p];
      plist.push({
        x: pr.pos.x, y: pr.pos.y,
        toRoom: (pr.destination && pr.destination.roomName) || null,
        toShard: (pr.destination && pr.destination.shard) || null,
        decay: (typeof pr.ticksToDecay !== 'undefined' ? pr.ticksToDecay : null)
      });
    }
    intel.portals = plist;

    var enemySpawns = room.find(FIND_HOSTILE_STRUCTURES, { filter: function(s){ return s.structureType === STRUCTURE_SPAWN; } });
    var enemyTowers = room.find(FIND_HOSTILE_STRUCTURES, { filter: function(s){ return s.structureType === STRUCTURE_TOWER; } });
    var spArr = []; var twArr = [];
    for (var si = 0; si < enemySpawns.length; si++) spArr.push({ x: enemySpawns[si].pos.x, y: enemySpawns[si].pos.y });
    for (var ti = 0; ti < enemyTowers.length; ti++) twArr.push({ x: enemyTowers[ti].pos.x, y: enemyTowers[ti].pos.y });
    intel.enemySpawns = spArr;
    intel.enemyTowers = twArr;

    intel.hostiles = room.find(FIND_HOSTILE_CREEPS).length;

    seedSourcesFromVision(room);

    // HUD: controller/owner/reservation + threats
    if (CFG.DEBUG_DRAW) {
      var tag = (intel.owner ? ('👑 ' + intel.owner) : (intel.reservation ? ('📌 ' + intel.reservation) : 'free'));
      var extras = [];
      if (intel.invaderCore && intel.invaderCore.present) extras.push('IC');
      if (intel.powerBank) extras.push('PB');
      if (intel.keeperLairs) extras.push('SK:' + intel.keeperLairs);
      var text = tag + ' • src:' + intel.sources + (extras.length ? ' • ' + extras.join(',') : '');
      var center = new RoomPosition(25,25,room.name);
      debugLabel(room, center, text, CFG.DRAW.INTEL);
    }
  }

  // ---------- Scout memory ----------
  function ensureScoutMem(creep) {
    if (!creep.memory.scout) creep.memory.scout = {};
    var m = creep.memory.scout;

    if (!m.home) {
      var spawns = [];
      for (var k in Game.spawns) if (Game.spawns.hasOwnProperty(k)) spawns.push(Game.spawns[k]);
      if (spawns.length) {
        var best = spawns[0];
        var bestD = Game.map.getRoomLinearDistance(creep.pos.roomName, best.pos.roomName);
        for (var i = 1; i < spawns.length; i++) {
          var s = spawns[i];
          var d = Game.map.getRoomLinearDistance(creep.pos.roomName, s.pos.roomName);
          if (d < bestD) { best = s; bestD = d; }
        }
        m.home = best.pos.roomName;
      } else if (Memory.firstSpawnRoom) {
        m.home = Memory.firstSpawnRoom;
      } else {
        m.home = creep.pos.roomName;
      }
    }
    if (!Array.isArray(m.queue)) m.queue = [];
    return m;
  }

  // ---------- Movement (Traveler wrapper + line) ----------
  function go(creep, dest, opts) {
    opts = opts || {};
    var desired = (opts.range != null) ? opts.range : 1;
    var reuse   = (opts.reusePath != null) ? opts.reusePath : PATH_REUSE;

    if (creep.pos.getRangeTo(dest) > desired) {
      // draw line within same room
      var dpos = (dest.pos || dest);
      debugDrawLine(creep, dpos, CFG.DRAW.TRAVEL, "GO");
    }

    if (creep.pos.getRangeTo(dest) <= desired) return OK;

    var retData = {};
    var tOpts = {
      range: desired,
      reusePath: reuse,
      ignoreCreeps: true,
      stuckValue: 2,
      repath: 0.05,
      maxOps: 6000,
      returnData: retData
    };
    if (BeeToolbox && BeeToolbox.roomCallback) tOpts.roomCallback = BeeToolbox.roomCallback;

    return creep.travelTo((dest.pos || dest), tOpts);
  }

  // ---------- Exit-block cache ----------
  function isExitBlockedCached(room, exitDir) {
    var key = room.name + '|' + exitDir;
    var cache = global.__SCOUT.exitBlock[key];
    if (cache && cache.expire > Game.time) {
      if (CFG.DEBUG_DRAW) drawExitMarker(room, exitDir, cache.blocked ? "X" : "→", cache.blocked ? CFG.DRAW.EXIT_BAD : CFG.DRAW.EXIT_OK);
      return cache.blocked;
    }

    var edge = room.find(exitDir);
    var blocked = true;
    if (edge && edge.length) {
      // If there are ANY walkable edge tiles without solid structures, it's not blocked
      var samples = edge.length > 6 ? [ edge[1], edge[(edge.length/3)|0], edge[(2*edge.length/3)|0], edge[edge.length-2] ] : edge;
      for (var i = 0; i < samples.length; i++) {
        var p = samples[i];
        var look = p.look();
        var pass = true;
        for (var j = 0; j < look.length; j++) {
          var o = look[j];
          if (o.type === LOOK_TERRAIN && o.terrain === 'wall') { pass = false; break; }
          if (o.type === LOOK_STRUCTURES) {
            var st = o.structure.structureType;
            if (st === STRUCTURE_WALL || (st === STRUCTURE_RAMPART && !o.structure.isPublic && !o.structure.my)) { pass = false; break; }
          }
        }
        if (pass) { blocked = false; break; }
      }
    }
    global.__SCOUT.exitBlock[key] = { blocked: blocked, expire: Game.time + EXIT_BLOCK_TTL };

    if (CFG.DEBUG_DRAW) drawExitMarker(room, exitDir, blocked ? "X" : "→", blocked ? CFG.DRAW.EXIT_BAD : CFG.DRAW.EXIT_OK);
    return blocked;
  }

  // ---------- Multi-scout helpers ----------
  function listScouts() {
    var out = [];
    for (var name in Game.creeps) {
      var c = Game.creeps[name];
      if (!c || !c.memory) continue;
      var tag = (c.memory.task || c.memory.role || '').toString().toLowerCase();
      if (tag === 'scout' || tag === 'task.scout' || tag.indexOf('scout') === 0) out.push(c);
    }
    out.sort(function(a,b){ return a.name < b.name ? -1 : 1; });
    return out;
  }
  function cohortIndex(creep) {
    var cohort = listScouts();
    for (var i = 0; i < cohort.length; i++) if (cohort[i].name === creep.name) return { idx: i, n: cohort.length };
    return { idx: (creep.name.charCodeAt(0) + creep.name.length) % 3, n: 3 };
  }
  function _scoutClaimTable() {
    var sc = Memory._scoutClaim;
    if (!sc || sc.t !== Game.time) Memory._scoutClaim = { t: Game.time, m: {} };
    return Memory._scoutClaim.m;
  }
  function tryClaimRoomThisTick(creep, roomName) {
    var m = _scoutClaimTable();
    var cur = m[roomName];
    if (!cur) { m[roomName] = creep.name; return true; }
    if (creep.name < cur) { m[roomName] = creep.name; return true; }
    return cur === creep.name;
  }

  // ---------- Queue building (ALL rings up to radius) ----------
  function rebuildQueueAllRings(mem, creep) {
    var home = mem.home;
    var ci = cohortIndex(creep);
    var strideIdx = ci.idx;
    var strideN   = Math.max(1, ci.n);

    var all = [];
    for (var r = 1; r <= EXPLORE_RADIUS; r++) {
      var layer = getRingCached(home, r);
      for (var i = 0; i < layer.length; i++) {
        var rn = layer[i];
        if (Game.map.getRoomLinearDistance(home, rn) <= EXPLORE_RADIUS && !isBlockedRecently(rn) && !_shouldSkipPlayerRoom(rn, creep)) {
          all.push(rn);
        }
      }
    }

    var never = [];
    var seenOld = [];
    var seenFresh = [];
    for (var k = 0; k < all.length; k++) {
      var name = all[k];
      var lv = lastVisited(name);
      if (lv === -Infinity) never.push(name);
      else if (Game.time - lv >= REVISIT_DELAY) seenOld.push({ rn: name, last: lv });
      else seenFresh.push({ rn: name, last: lv });
    }
    seenOld.sort(function(a,b){ return a.last - b.last; });
    seenFresh.sort(function(a,b){ return a.last - b.last; });

    function strideList(arr) {
      var out = [];
      var L = arr.length;
      if (!L) return out;
      // NOTE: stride per bucket (never/old/fresh) — avoids biasing exits
      for (var s = strideIdx; s < L; s += strideN) out.push(arr[s]);
      if (!out.length && L) out.push(arr[0]);
      return out;
    }
    function strideObjList(arr) {
      var just = []; for (var i = 0; i < arr.length; i++) just.push(arr[i].rn);
      return strideList(just);
    }

    var queue = [];
    var prev = mem.prevRoom || null;
    function pushSkippingPrev(list) {
      for (var t = 0; t < list.length; t++) {
        var nm = list[t];
        if (prev && nm === prev && list.length > 1) continue;
        queue.push(nm);
      }
    }

    pushSkippingPrev(strideList(never));
    pushSkippingPrev(strideObjList(seenOld));
    pushSkippingPrev(strideObjList(seenFresh));

    // fallback: immediate neighbors (radius-clamped)
    if (!queue.length) {
      var fb = exitsOrdered(creep.room.name);
      var filt = [];
      for (var i2 = 0; i2 < fb.length; i2++) {
        var rn2 = fb[i2];
        if (okRoomName(rn2) &&
            Game.map.getRoomLinearDistance(home, rn2) <= EXPLORE_RADIUS &&
            !isBlockedRecently(rn2) &&
            !_shouldSkipPlayerRoom(rn2, creep)) filt.push(rn2);
      }
      queue = filt;
    }

    mem.queue = queue;

    // Visual: show queue size at center of current room
    if (CFG.DEBUG_DRAW && Game.rooms[creep.room.name]) {
      var R = Game.rooms[creep.room.name];
      var center = new RoomPosition(25,25,creep.room.name);
      debugLabel(R, center, '🧭 queue:' + (queue.length|0), CFG.DRAW.TARGET);
    }
  }

  // pick an inward neighbor if we drift outside radius
  function inwardNeighborTowardHome(current, home) {
    var neigh = exitsOrdered(current);
    var best = null, bestD = 9999;
    for (var i = 0; i < neigh.length; i++) {
      var rn = neigh[i];
      var d = Game.map.getRoomLinearDistance(home, rn);
      if (d < bestD) { bestD = d; best = rn; }
    }
    return best;
  }

  // ---------- Gateway helpers ----------
  function homeNeighbors(home) { return exitsOrdered(home) || []; }
  function isAdjToHome(home, rn) {
    var n = homeNeighbors(home);
    for (var i=0;i<n.length;i++) if (n[i] === rn) return true;
    return false;
  }
  function isGatewayHome(home) { return (homeNeighbors(home).length <= 2); }

  // ---------- Next-hop routing ----------
  function computeNextHop(fromRoom, toRoom) {
    if (fromRoom === toRoom) return null;
    var route = Game.map.findRoute(fromRoom, toRoom, {
      routeCallback: function (roomName) {
        if (!okRoomName(roomName) || isBlockedRecently(roomName)) return Infinity;
        return 1;
      }
    });
    if (route === ERR_NO_PATH || !route || !route.length) return null;
    // first step tells us the next neighbor room name
    var dir = route[0].exit; // FIND_EXIT_*
    var desc = Game.map.describeExits(fromRoom) || {};
    return desc[dir] || null;
  }

  // ---------- Run helpers (teaching oriented) ----------
  function enforceScoutLeash(creep, mem) {
    var curDist = Game.map.getRoomLinearDistance(mem.home, creep.room.name);
    if (curDist <= EXPLORE_RADIUS) return;
    var back = inwardNeighborTowardHome(creep.room.name, mem.home);
    if (back) {
      creep.memory.targetRoom = back;
      creep.memory.nextHop = back;
      debugSay(creep, '↩');
    }
  }

  function handleRoomArrival(creep, mem) {
    if (!creep.memory.lastRoom) creep.memory.lastRoom = creep.room.name;
    if (creep.memory.lastRoom === creep.room.name) {
      stampVisit(creep.room.name);
      if (shouldLogIntel(creep.room)) logRoomIntel(creep.room);
      return false;
    }

    if (!creep.memory.prevRoom) creep.memory.prevRoom = null;
    creep.memory.prevRoom = creep.memory.lastRoom;
    creep.memory.lastRoom = creep.room.name;
    mem.prevRoom = creep.memory.prevRoom || null;

    stampVisit(creep.room.name);
    logRoomIntel(creep.room);

    if (CFG.DEBUG_DRAW) {
      debugRing(creep.room, creep.pos, CFG.DRAW.ROOM, "ARRIVE");
      debugLabel(creep.room, creep.pos, creep.room.name, CFG.DRAW.TEXT);
    }

    if (creep.memory.targetRoom === creep.room.name) {
      creep.memory.targetRoom = null;
      creep.memory.nextHop = null;
      return true;
    }
    return false;
  }

  function moveTowardTarget(creep) {
    var targetRoom = creep.memory.targetRoom;
    if (!targetRoom) return false;
    if (creep.room.name === targetRoom) {
      creep.memory.targetRoom = null;
      creep.memory.nextHop = null;
      return false;
    }

    var hop = creep.memory.nextHop;
    if (!hop || hop === creep.room.name) {
      hop = computeNextHop(creep.room.name, targetRoom);
      creep.memory.nextHop = hop;
    }
    if (!hop) {
      markBlocked(targetRoom);
      debugSay(creep, '⛔');
      creep.memory.targetRoom = null;
      creep.memory.nextHop = null;
      return true;
    }

    var dir = creep.room.findExitTo(hop);
    if (dir < 0) {
      markBlocked(hop);
      creep.memory.nextHop = null;
      return true;
    }
    if (isExitBlockedCached(creep.room, dir)) {
      markBlocked(hop);
      drawExitMarker(creep.room, dir, "X", CFG.DRAW.EXIT_BAD);
      creep.memory.nextHop = null;
      return true;
    }
    drawExitMarker(creep.room, dir, "→", CFG.DRAW.EXIT_OK);
    debugSay(creep, '➡');
    go(creep, new RoomPosition(25, 25, hop), { range: 20, reusePath: PATH_REUSE });
    return true;
  }

  function ensureQueueReady(mem, creep) {
    if (!mem.queue.length) rebuildQueueAllRings(mem, creep);
  }

  function chooseNextTarget(creep, mem) {
    var allowGatewayShare = isGatewayHome(mem.home);
    while (mem.queue.length) {
      var next = mem.queue.shift();
      if (!okRoomName(next) || isBlockedRecently(next)) continue;
      if (Game.map.getRoomLinearDistance(mem.home, next) > EXPLORE_RADIUS) continue;
      if (next === (mem.prevRoom || null) && mem.queue.length) continue;

      var claimOK = tryClaimRoomThisTick(creep, next);
      if (!claimOK && !(allowGatewayShare && isAdjToHome(mem.home, next))) continue;

      creep.memory.targetRoom = next;
      creep.memory.nextHop = computeNextHop(creep.room.name, next);
      if (CFG.DEBUG_DRAW && Game.rooms[creep.room.name]) {
        debugLabel(Game.rooms[creep.room.name], creep.pos, '🎯 ' + next, CFG.DRAW.TARGET);
      }
      return true;
    }
    return false;
  }

  function idleScout(creep) {
    debugSay(creep, '🕊');
    go(creep, new RoomPosition(25, 25, creep.room.name), { range: 10, reusePath: PATH_REUSE });
  }

  // ---------- API ----------
  var roleScout = {
    role: 'Scout',
    isExitBlocked: function (creep, exitDir) { return isExitBlockedCached(creep.room, exitDir); },

    run: function (creep) {
      var M = ensureScoutMem(creep); // {home, queue, prevRoom?}

      enforceScoutLeash(creep, M);
      if (handleRoomArrival(creep, M)) return; // arrival clears target + logs intel

      if (moveTowardTarget(creep)) return; // existing waypoint already active

      ensureQueueReady(M, creep);
      if (!chooseNextTarget(creep, M)) { idleScout(creep); return; }

      if (!moveTowardTarget(creep)) {
        // Could happen if we spawned inside the target room this tick.
        idleScout(creep);
      }
    }
  };

  module.exports = roleScout;

  return module.exports;
})();

// -----------------------------------------------------------------------------
// Inline legacy role.Trucker (auto-generated bundle)
// -----------------------------------------------------------------------------
roleBeeWorker.Trucker = (function () {
  var module = { exports: {} };
  var exports = module.exports;
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

    ensureRoleDefaults(creep);
    updateReturnState(creep);

    if (creep.memory.returning) {
      return _returnToStorage(creep);
    }
    return _collectFromFlagRoom(creep);
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

  // ============================
  // Teaching helpers (state)
  // ============================
  function ensureRoleDefaults(creep) {
    if (!creep.memory.pickupFlag) {
      creep.memory.pickupFlag = CFG.PICKUP_FLAG_DEFAULT;
    }
    if (!creep.memory.homeRoom) {
      creep.memory.homeRoom = _firstSpawnRoomFallback(creep);
    }
  }

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

// -----------------------------------------------------------------------------
// Inline legacy role.Claimer (auto-generated bundle)
// -----------------------------------------------------------------------------
roleBeeWorker.Claimer = (function () {
  var module = { exports: {} };
  var exports = module.exports;
  /** =========================
   *  Core config
   *  ========================= */
  var CONFIG = {
    defaultMode: 'reserve',
    placeSpawnOnClaim: false,
    reusePath: 15
  };

  // ---- Randomized signing pool ----
  var SIGN_TEXTS = [
    "🐝 Sushi Moto Logistics — roads, loads, righteous nodes.",
    "🐝 BenvolioDAT — energy up front, potholes out back.",
    "🏗️ Warning: CPU spikes ahead!",
    "👑 Reserve now, pay later.",
    "⚡ Free energy, limited lag!",
    "🐝 Buzz buzz, this room is ours.",
    "🎯 Perfect balance: one tick ahead, two ops behind.",
    "📡 If you can read this, my creep didn’t die on the way.",
    "💾 Out of memory, please insert more RAM.",
    "🐝 Built with honey, guarded with stings.",
    "🚧 Road work ahead… yeah, I sure hope it does.",
    "🪙 Free CPU, limited time offer! (not really).",
    "🔥 Invaders beware: our towers don’t miss.",
    "⚙️ Automate or evaporate.",
    "🐝 Bee-lieve in the swarm.",
    "🍯 Sweet as honey, sharp as fangs.",
    "🎵 Tick-tock goes the shard clock.",
    "🛰️ Signed live from shard3.",
    "📦 Logistics > tactics.",
    "🐝 All roads lead to spawn.",
    "⚔️ Pay your reservation fees here.",
    "📑 Error 404: Free source not found.",
    "🕹️ Player 2 has entered the game.",
    "🐝 One tick closer to world domination.",
    "💡 Power is temporary, memory is forever.",
    "🚀 Upgrade complete, new bugs unlocked.",
    "🐝 Buzzness is booming.",
    "🔋 Energy is love, energy is life.",
    "🪓 Trees feared us first, then walls followed.",
    "🐝 Pollination nation!",
    "🧭 Path not found. Try Traveler.js.",
    "🎃 Scary sign goes here 👻",
    "🐝 Keep calm and harvest on.",
    "🥷 Silent creep, deadly withdraw.",
    "📉 CPU at 90%… oh no oh no oh no.",
    "💤 AFK but still reserving.",
    "🐝 Nectar collectors at work.",
    "🏰 Your controller, our castle.",
    "📍 You are here: owned.",
    "🐝 Sting operation successful.",
    "🧪 Science creeps were here.",
    "📡 We came, we saw, we cached.",
    "🐝 Energy now, lag later.",
    "🎯 Aim for the sources, miss the roads.",
    "⚡ Reserved by Bee Logistics LLC.",
    "🐝 The swarm approves this message.",
    "⏳ Tick by tick, room by room.",
    "🛠️ Signed under protest of pathfinding costs.",
    "🐝 Buzzfeed Top 10 Rooms (this one’s #1).",
    "💣 Boom. Controller tagged."
  ];

  // ticks ~ “a day” before re-signing
  var SIGN_DAY_TICKS = 1500;

  // ---- Multi-room Reserve Helpers ----
  var RESERVE_CONFIG = {
    desired: 2500,
    rotateAt: 1000,
    scanRoleNames: ['luna', 'remoteMiner','remoteHarvest'],
    maxTargets: 8
  };

  // ---- Room Locking (prevents 2 claimers from dogpiling one room) ----
  var LOCK = { ttl: 10 };

  /** =========================
   *  Debug helpers
   *  ========================= */
  function debugSay(creep, msg) { if (CFG.DEBUG_SAY && creep && msg) creep.say(msg, true); }

  function _posOf(target) {
    if (!target) return null;
    if (target.pos) return target.pos;
    if (target.x != null && target.y != null && target.roomName) return target;
    return null;
  }
  function debugDrawLine(from, to, color, label) {
    if (!CFG.DEBUG_DRAW || !from || !to) return;
    var room = from.room || Game.rooms[from.roomName];
    var tpos = _posOf(to);
    if (!room || !room.visual || !tpos || (room.name !== tpos.roomName)) return;
    try {
      room.visual.line((from.pos||from), tpos, {
        color: color, width: CFG.DRAW.WIDTH, opacity: CFG.DRAW.OPACITY
      });
      if (label) {
        room.visual.text(label, tpos.x, tpos.y - 0.4, {
          color: color, opacity: CFG.DRAW.OPACITY, font: CFG.DRAW.FONT, align: "center"
        });
      }
    } catch (e) {}
  }
  function debugRing(room, pos, color, text) {
    if (!CFG.DEBUG_DRAW || !room || !room.visual || !pos) return;
    try {
      room.visual.circle(pos, { radius: 0.55, fill: "transparent", stroke: color, opacity: CFG.DRAW.OPACITY, width: CFG.DRAW.WIDTH });
      if (text) room.visual.text(text, pos.x, pos.y - 0.7, { color: color, font: CFG.DRAW.FONT, opacity: CFG.DRAW.OPACITY, align: "center" });
    } catch (e) {}
  }
  function debugLabel(room, pos, text, color) {
    if (!CFG.DEBUG_DRAW || !room || !room.visual || !pos || !text) return;
    try {
      room.visual.text(text, pos.x, pos.y - 1.1, {
        color: color || CFG.DRAW.TEXT, font: CFG.DRAW.FONT, opacity: 0.9, align: "center", backgroundColor: "#000000", backgroundOpacity: 0.25
      });
    } catch (e) {}
  }

  /** =========================
   *  Travel helper (BeeTravel → Traveler → moveTo)
   *  Draws a path hint.
   *  ========================= */
  function go(creep, dest, range, reuse) {
    range = (range != null) ? range : 1;
    reuse = (reuse != null) ? reuse : CONFIG.reusePath;
    var dpos = (dest && dest.pos) ? dest.pos : dest;
    if (dpos) debugDrawLine(creep, dpos, CFG.DRAW.TRAVEL, "GO");

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
    if (creep.pos.getRangeTo(dest) > range) creep.moveTo(dest, { reusePath: reuse, maxOps: 2000 });
  }

  /** =========================
   *  Lock memory
   *  ========================= */
  function ensureLockMem() { if (!Memory.reserveLocks) Memory.reserveLocks = {}; }
  function isRoomLocked(rn) {
    ensureLockMem();
    var L = Memory.reserveLocks[rn];
    if (!L) return false;
    if (L.until <= Game.time) { delete Memory.reserveLocks[rn]; return false; }
    if (L.creep && !Game.creeps[L.creep]) { delete Memory.reserveLocks[rn]; return false; }
    return true;
  }
  function acquireRoomLock(rn, creep) {
    ensureLockMem(); isRoomLocked(rn);
    if (Memory.reserveLocks[rn]) return false;
    Memory.reserveLocks[rn] = { creep: creep.name, until: Game.time + LOCK.ttl };
    return true;
  }
  function refreshRoomLock(rn, creep) {
    ensureLockMem();
    var L = Memory.reserveLocks[rn];
    if (!L) return false;
    if (L.creep !== creep.name) return false;
    L.until = Game.time + LOCK.ttl;
    return true;
  }
  function releaseRoomLock(rn, creep) {
    ensureLockMem();
    var L = Memory.reserveLocks[rn];
    if (!L) return;
    if (L.creep === creep.name) delete Memory.reserveLocks[rn];
  }

  /** =========================
   *  Target gathering / intel
   *  ========================= */
  function gatherReserveTargets() {
    var set = {};
    for (var fname in Game.flags) {
      if (fname === 'Reserve' || fname.indexOf('Reserve:') === 0) {
        var f = Game.flags[fname];
        if (f && f.pos && f.pos.roomName) set[f.pos.roomName] = true;
      }
    }
    for (var cname in Game.creeps) {
      var c = Game.creeps[cname];
      if (!c.memory || !c.memory.role) continue;
      if (RESERVE_CONFIG.scanRoleNames.indexOf(c.memory.role) !== -1) {
        var rn = c.memory.remoteRoom || c.memory.targetRoom || c.memory.targetRoomName;
        if (rn) set[rn] = true;
      }
    }
    var out = [];
    for (var rn in set) out.push(rn);
    if (out.length > RESERVE_CONFIG.maxTargets) out.length = RESERVE_CONFIG.maxTargets;
    return out;
  }

  function rememberReservationIntel(room) {
    if (!room || !room.controller) return;
    if (!Memory.reserveIntel) Memory.reserveIntel = {};
    var ctl = room.controller;
    var ticks = 0;
    var owner = null;
    if (ctl.reservation) {
      ticks = ctl.reservation.ticksToEnd || 0;
      owner = ctl.reservation.username || null;
    } else if (ctl.my) {
      ticks = 99999;
      owner = 'me';
    }
    Memory.reserveIntel[room.name] = { ticks: ticks, owner: owner, t: Game.time };

    // Draw little HUD over controller
    if (CFG.DEBUG_DRAW) {
      var tag = (owner ? owner : "free") + " • " + (ticks|0);
      debugRing(room, ctl.pos, CFG.DRAW.CTRL, "CTL");
      debugLabel(room, ctl.pos, tag, CFG.DRAW.TEXT);
    }
  }

  function pickNextReserveTarget(creep, candidates) {
    if (!candidates || !candidates.length) return null;

    // First: unseen intel & unlocked
    for (var i = 0; i < candidates.length; i++) {
      var rn = candidates[i];
      if (!Memory.reserveIntel || !Memory.reserveIntel[rn]) {
        if (!isRoomLocked(rn)) return rn;
      }
    }

    // Next: ours / free with lowest ticks
    var best = null, bestTicks = 999999;
    for (var j = 0; j < candidates.length; j++) {
      var rn2 = candidates[j];
      if (isRoomLocked(rn2)) continue;
      var intel = Memory.reserveIntel && Memory.reserveIntel[rn2];
      if (!intel) { best = rn2; break; }
      if (intel.owner && intel.owner !== creep.owner.username && intel.owner !== 'me') continue;
      if (intel.ticks < bestTicks) { bestTicks = intel.ticks; best = rn2; }
    }
    if (!best) {
      for (var k = 0; k < candidates.length; k++) {
        var rn3 = candidates[k];
        var intel2 = Memory.reserveIntel && Memory.reserveIntel[rn3];
        var ticks2 = intel2 ? intel2.ticks : 0;
        if (ticks2 < bestTicks) { bestTicks = ticks2; best = rn3; }
      }
    }
    return best || candidates[0];
  }

  function resolveTargetRoom(creep) {
    var mode = (creep.memory.claimerMode || CONFIG.defaultMode).toLowerCase();
    var exactName = mode === 'claim' ? 'Claim' : (mode === 'attack' ? 'Attack' : 'Reserve');

    var chosenFlag = Game.flags[exactName];
    if (!chosenFlag) {
      for (var fname in Game.flags) {
        if (fname.indexOf(exactName) === 0) { chosenFlag = Game.flags[fname]; break; }
      }
    }
    if (chosenFlag) {
      creep.memory.targetRoom = chosenFlag.pos.roomName;
      // draw flag if visible
      if (CFG.DEBUG_DRAW && chosenFlag.pos && Game.rooms[chosenFlag.pos.roomName]) {
        debugRing(Game.rooms[chosenFlag.pos.roomName], chosenFlag.pos, CFG.DRAW.FLAG, "FLAG");
      }
      return creep.memory.targetRoom;
    }
    if (creep.memory.targetRoom) return creep.memory.targetRoom;
    return null;
  }

  /** =========================
   *  Orchestration helpers so new contributors can follow the run() pipeline.
   *  ========================= */
  function claimerMode(creep) {
    return (creep.memory.claimerMode || CONFIG.defaultMode).toLowerCase();
  }

  function ensureReserveRoleScan() {
    if (RESERVE_CONFIG.scanRoleNames.indexOf('luna') === -1) {
      RESERVE_CONFIG.scanRoleNames.push('luna');
    }
  }

  function releaseLockIfPlanDropped(creep, plan) {
    if (creep.memory.targetRoom && plan.indexOf(creep.memory.targetRoom) === -1) {
      releaseRoomLock(creep.memory.targetRoom, creep);
      creep.memory.targetRoom = null;
    }
  }

  function claimReserveRoom(creep, plan) {
    var pick = pickNextReserveTarget(creep, plan);
    if (pick && acquireRoomLock(pick, creep)) {
      creep.memory.targetRoom = pick;
      debugSay(creep, '🎯');
      return true;
    }
    for (var i = 0; i < plan.length; i++) {
      var alt = plan[i];
      if (alt === pick) continue;
      if (acquireRoomLock(alt, creep)) {
        creep.memory.targetRoom = alt;
        return true;
      }
    }
    return false;
  }

  function ensureTargetRoom(creep, plan) {
    if (creep.memory.targetRoom) {
      refreshRoomLock(creep.memory.targetRoom, creep);
      return creep.memory.targetRoom;
    }

    var mode = claimerMode(creep);
    if (mode === 'reserve') {
      if (!claimReserveRoom(creep, plan)) {
        debugSay(creep, '🔒');
        return null;
      }
      return creep.memory.targetRoom;
    }

    creep.memory.targetRoom = resolveTargetRoom(creep);
    if (!creep.memory.targetRoom) debugSay(creep, '❌');
    return creep.memory.targetRoom;
  }

  function drawLockVisual(targetRoom) {
    if (!CFG.DEBUG_DRAW) return;
    if (!Game.rooms[targetRoom]) return;
    if (!isRoomLocked(targetRoom)) return;
    var center = new RoomPosition(25,25,targetRoom);
    debugRing(Game.rooms[targetRoom], center, CFG.DRAW.LOCK, "LOCK");
  }

  function runControllerMode(creep, ctl) {
    var mode = claimerMode(creep);
    if (mode === 'claim') { doClaim(creep, ctl); }
    else if (mode === 'attack') { doAttack(creep, ctl); }
    else { doReserve(creep, ctl); }
  }

  function rotateIfSatisfied(creep, ctl, targetRoom) {
    if (!ctl) return;
    if (ctl.reservation && ctl.reservation.username === creep.owner.username) {
      var ticks = ctl.reservation.ticksToEnd || 0;
      if (ticks >= RESERVE_CONFIG.rotateAt) {
        releaseRoomLock(targetRoom, creep);
        debugSay(creep, '➡');
        creep.memory.targetRoom = null;
      }
      return;
    }
    if (ctl.my) {
      releaseRoomLock(targetRoom, creep);
      debugSay(creep, '🏠');
      creep.memory.targetRoom = null;
    }
  }

  /** =========================
   *  Movement helpers
   *  ========================= */
  function moveToRoom(creep, roomName) {
    if (creep.pos.roomName !== roomName) {
      var dest = new RoomPosition(25, 25, roomName);
      debugSay(creep, '➡️' + roomName);
      go(creep, dest, 20, CONFIG.reusePath);
      return false;
    }
    return true;
  }

  /** =========================
   *  Controller actions
   *  ========================= */
  // Updated signing logic with random pool + visuals
  function signIfWanted(creep, controller) {
    if (!controller || controller.my) return;

    var needNew = false;
    if (!controller.sign) needNew = true;
    else if (controller.sign.username !== creep.owner.username) needNew = true;
    else {
      var age = Game.time - controller.sign.time;
      if (age >= SIGN_DAY_TICKS) needNew = true;
    }

    if (needNew) {
      if (!creep.memory.signText) {
        var pick = SIGN_TEXTS[Math.floor(Math.random() * SIGN_TEXTS.length)];
        creep.memory.signText = pick;
      }
      var res = creep.signController(controller, creep.memory.signText);
      if (res === ERR_NOT_IN_RANGE) {
        debugSay(creep, '✍️');
        debugDrawLine(creep, controller, CFG.DRAW.SIGN, "SIGN");
        go(creep, controller, 1, CONFIG.reusePath);
      } else if (res === OK) {
        debugSay(creep, '✅');
        debugRing(creep.room, controller.pos, CFG.DRAW.SIGN, "SIGNED");
        delete creep.memory.signText;
      }
    }
  }

  function placeSpawnIfWanted(creep, controller) {
    if (!CONFIG.placeSpawnOnClaim || !controller || !controller.my) return;
    var anySpawn = creep.room.find(FIND_MY_SPAWNS)[0];
    if (!anySpawn) {
      var offsets = [
        [3,0],[3,1],[2,2],[1,3],[0,3],[-1,3],[-2,2],[-3,1],[-3,0],
        [-3,-1],[-2,-2],[-1,-3],[0,-3],[1,-3],[2,-2],[3,-1]
      ];
      for (var i=0;i<offsets.length;i++) {
        var dx = offsets[i][0], dy = offsets[i][1];
        var x = Math.max(1, Math.min(48, controller.pos.x + dx));
        var y = Math.max(1, Math.min(48, controller.pos.y + dy));
        if (creep.room.createConstructionSite(x, y, STRUCTURE_SPAWN) === OK) {
          debugSay(creep, '🚧');
          debugRing(creep.room, new RoomPosition(x,y,controller.pos.roomName), CFG.DRAW.CTRL, "SPAWN");
          break;
        }
      }
    }
  }

  function doClaim(creep, controller) {
    if (!controller) { debugSay(creep, '❓ctl'); return; }
    debugRing(creep.room, controller.pos, CFG.DRAW.CTRL, "CTL");

    if (controller.my) {
      signIfWanted(creep, controller);
      placeSpawnIfWanted(creep, controller);
      debugSay(creep, '✅');
      return;
    }
    if (controller.owner && !controller.my) {
      var r = creep.attackController(controller);
      if (r === ERR_NOT_IN_RANGE) { debugSay(creep, '⚔'); debugDrawLine(creep, controller, CFG.DRAW.CTRL, "ATK"); go(creep, controller, 1, CONFIG.reusePath); return; }
      debugSay(creep, '⚔');
      return;
    }
    var res = creep.claimController(controller);
    if (res === ERR_NOT_IN_RANGE) {
      debugSay(creep, '👑');
      debugDrawLine(creep, controller, CFG.DRAW.CTRL, "CLAIM");
      go(creep, controller, 1, CONFIG.reusePath);
    } else if (res === OK) {
      debugSay(creep, '👑');
      signIfWanted(creep, controller);
      placeSpawnIfWanted(creep, controller);
    } else if (res === ERR_GCL_NOT_ENOUGH) {
      debugSay(creep, '➡R');
      doReserve(creep, controller);
    } else {
      debugSay(creep, '❌' + res);
    }
  }

  function doReserve(creep, controller) {
    if (!controller) { debugSay(creep, '❓ctl'); return; }
    debugRing(creep.room, controller.pos, CFG.DRAW.CTRL, "CTL");
    if (controller.reservation && controller.reservation.username !== creep.owner.username) {
      var r = creep.attackController(controller);
      if (r === ERR_NOT_IN_RANGE) { debugSay(creep, '🪓'); debugDrawLine(creep, controller, CFG.DRAW.CTRL, "DERES"); go(creep, controller, 1, CONFIG.reusePath); return; }
      debugSay(creep, '🪓');
      return;
    }
    var res = creep.reserveController(controller);
    if (res === ERR_NOT_IN_RANGE) {
      debugSay(creep, '📌');
      debugDrawLine(creep, controller, CFG.DRAW.CTRL, "+RES");
      go(creep, controller, 1, CONFIG.reusePath);
    } else if (res === OK) {
      debugSay(creep, '📌');
    } else {
      debugSay(creep, '❌' + res);
    }
    signIfWanted(creep, controller);
  }

  function doAttack(creep, controller) {
    if (!controller) { debugSay(creep, '❓ctl'); return; }
    var r = creep.attackController(controller);
    if (r === ERR_NOT_IN_RANGE) {
      debugSay(creep, '🪓');
      debugDrawLine(creep, controller, CFG.DRAW.CTRL, "ATK");
      go(creep, controller, 1, CONFIG.reusePath);
    } else if (r === OK) {
      debugSay(creep, '🪓');
    } else {
      debugSay(creep, '❌' + r);
    }
  }

  /** =========================
   *  Public API
   *  ========================= */
  var roleClaimer = {
    role: 'Claimer',
    run: function(creep) {
      rememberReservationIntel(creep.room);
      ensureReserveRoleScan();

      var plan = gatherReserveTargets();
      releaseLockIfPlanDropped(creep, plan);

      var targetRoom = ensureTargetRoom(creep, plan);
      if (!targetRoom) return;

      drawLockVisual(targetRoom);

      if (!moveToRoom(creep, targetRoom)) {
        refreshRoomLock(targetRoom, creep);
        return;
      }

      var ctl = creep.room.controller;
      if (!ctl) {
        releaseRoomLock(targetRoom, creep);
        debugSay(creep, '🚫');
        creep.memory.targetRoom = null;
        return;
      }

      runControllerMode(creep, ctl);

      rememberReservationIntel(creep.room);
      refreshRoomLock(targetRoom, creep);
      rotateIfSatisfied(creep, ctl, targetRoom);
    }
  };

  module.exports = roleClaimer;

  return module.exports;
})();
roleBeeWorker.handlers = {
  BaseHarvest: roleBeeWorker.BaseHarvest,
  Builder: roleBeeWorker.Builder,
  Courier: roleBeeWorker.Courier,
  Queen: roleBeeWorker.Queen,
  Upgrader: roleBeeWorker.Upgrader,
  Luna: roleBeeWorker.Luna,
  Scout: roleBeeWorker.Scout,
  Trucker: roleBeeWorker.Trucker,
  Claimer: roleBeeWorker.Claimer
};

roleBeeWorker.run = function run(creep, explicitRole) {
  if (!creep) return;
  var roleName = explicitRole;
  if (!roleName && creep.memory) {
    roleName = creep.memory.role || creep.memory.task;
  }
  if (!roleName) return;
  var handler = roleBeeWorker.handlers[roleName];
  if (!handler || typeof handler.run !== 'function') return;
  return handler.run(creep);
};

roleBeeWorker.runBaseHarvest = function(creep) { return roleBeeWorker.BaseHarvest.run(creep); };
roleBeeWorker.runBuilder = function(creep) { return roleBeeWorker.Builder.run(creep); };
roleBeeWorker.runCourier = function(creep) { return roleBeeWorker.Courier.run(creep); };
roleBeeWorker.runQueen = function(creep) { return roleBeeWorker.Queen.run(creep); };
roleBeeWorker.runUpgrader = function(creep) { return roleBeeWorker.Upgrader.run(creep); };
roleBeeWorker.runLuna = function(creep) {
  return roleBeeWorker.Luna && typeof roleBeeWorker.Luna.run === 'function'
    ? roleBeeWorker.Luna.run(creep)
    : undefined;
};
roleBeeWorker.runScout = function(creep) {
  return roleBeeWorker.Scout && typeof roleBeeWorker.Scout.run === 'function'
    ? roleBeeWorker.Scout.run(creep)
    : undefined;
};
roleBeeWorker.runTrucker = function(creep) {
  return roleBeeWorker.Trucker && typeof roleBeeWorker.Trucker.run === 'function'
    ? roleBeeWorker.Trucker.run(creep)
    : undefined;
};
roleBeeWorker.runClaimer = function(creep) {
  return roleBeeWorker.Claimer && typeof roleBeeWorker.Claimer.run === 'function'
    ? roleBeeWorker.Claimer.run(creep)
    : undefined;
};

if (roleBeeWorker.Builder && roleBeeWorker.Builder.structurePlacements) {
  roleBeeWorker.structurePlacements = roleBeeWorker.Builder.structurePlacements;
}

module.exports = roleBeeWorker;
