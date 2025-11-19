'use strict';

var BeeHelper = require('role.BeeHelper');
var CFG = BeeHelper.config;
var debugSay = BeeHelper.debugSay;
var debugDrawLine = BeeHelper.debugDrawLine;
var debugRing = BeeHelper.debugRing;

var roleBaseHarvest = (function () {
  // -----------------------------
  // A) Config + seat helpers
  // -----------------------------
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
   *  Travel helper (BeeTravel → Traveler → moveTo)
   *  Draws a path hint to the target.
   *  ========================= */
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

  // -----------------------------
  // B) Identity + state helpers
  // -----------------------------
  function ensureBaseHarvestIdentity(creep) {
    if (!creep || !creep.memory) return;
    if (!creep.memory.role || String(creep.memory.role).toLowerCase() === 'baseharvest') {
      creep.memory.role = 'BaseHarvest';
    }
    if (!creep.memory.task) creep.memory.task = 'baseharvest';
  }

  // Memory keys:
  // - assignedSource: source id we are mining
  // - seatX/seatY/seatRoom: coordinates of the reserved mining seat
  // - waitingForSeat: true when queued because seat is occupied

  function determineBaseHarvestState(creep) {
    ensureBaseHarvestIdentity(creep);
    if (!creep) return 'IDLE';
    var empty = creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0;
    var full  = creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0;
    if (empty) {
      creep.memory.harvesting = true;
      debugSay(creep, '⤵️MINE');
    } else if (full) {
      creep.memory.harvesting = false;
      debugSay(creep, '⤴️DROP');
    }
    var nextState = 'IDLE';
    if (creep.memory.harvesting) nextState = 'HARVEST';
    else if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) nextState = 'OFFLOAD';
    creep.memory.state = nextState;
    return nextState;
  }

  // -----------------------------
  // C) Harvest phase
  // -----------------------------
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
      if (!creep.pos.isEqualTo(queueSpot)) {
        creep.travelTo(queueSpot, { range: 0, reusePath: CONFIG.travelReuse });
        return;
      }

      if (creep.pos.getRangeTo(source) <= 1) {
        debugDrawLine(creep, source, CFG.DRAW.SOURCE, "HARV");
        creep.harvest(source);
      }

      if (!isTileOccupiedByAnyCreep(seatPos, creep.name) || countAssignedHarvesters(creep.room.name, source.id) < seats) {
        creep.travelTo(seatPos, { range: 0, reusePath: CONFIG.travelReuse });
        creep.memory.waitingForSeat = false;
      }
      return;
    }

    // NO QUEUE: seat free or capacity available → go sit or harvest
    if (seatPos && !creep.pos.isEqualTo(seatPos)) {
      debugSay(creep, '🪑');
      creep.travelTo(seatPos, { range: 0, reusePath: CONFIG.travelReuse });
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
        else if (tr === ERR_NOT_IN_RANGE) {
          creep.travelTo(contHere.pos, { range: 0, reusePath: CONFIG.travelReuse });
          return;
        }
      }
    }

    // Always swing the pick this tick
    debugSay(creep, '⛏️');
    debugDrawLine(creep, source, CFG.DRAW.SOURCE, "HARV");
    creep.harvest(source);
  }

  // -----------------------------
  // D) Offload phase
  // -----------------------------
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
        if (rs === ERR_NOT_IN_RANGE) {
          creep.travelTo(sink, { range: 1, reusePath: CONFIG.travelReuse });
          return;
        }
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
        creep.travelTo(cont.pos, { range: 0, reusePath: CONFIG.travelReuse });
        return;
      }

      debugSay(creep, '📦');
      var tr2 = creep.transfer(cont, RESOURCE_ENERGY);
      if (tr2 === OK) return;
      if (tr2 === ERR_NOT_IN_RANGE) {
        creep.travelTo(cont.pos, { range: 0, reusePath: CONFIG.travelReuse });
        return;
      }

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

  // -----------------------------
  // E) Idle handling
  // -----------------------------
  function idleWhenEmpty(creep) {
    if (!creep || creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) return;
    debugSay(creep, '🧘');
    debugRing(creep.room, creep.pos, CFG.DRAW.IDLE, "IDLE");
  }

  var roleBaseHarvest = {
    role: 'BaseHarvest',
    run: function(creep) {
      var state = determineBaseHarvestState(creep);

      if (state === 'HARVEST') {
        runHarvestPhase(creep);
        return;
      }

      if (state === 'OFFLOAD') {
        runOffloadPhase(creep);
        return;
      }

      idleWhenEmpty(creep);
    }
  };

  return roleBaseHarvest;
})();

module.exports = roleBaseHarvest;
