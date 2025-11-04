// TaskBaseHarvest.js — queued handoff + conflict-safe miner (with Debug_say & Debug_draw)
var BeeToolbox = require('BeeToolbox');

/** =========================
 *  Debug UI toggles & styling
 *  ========================= */
var CFG = Object.freeze({
  DEBUG_SAY: false,    // creep.say breadcrumbs
  DEBUG_DRAW: true,   // RoomVisual lines/labels/rings
  DRAW: {
    TRAVEL:   "#8ab6ff",
    SOURCE:   "#ffd16e",
    SEAT:     "#6effa1",
    QUEUE:    "#ffe66e",
    YIELD:    "#ff6e6e",
    OFFLOAD:  "#6ee7ff",
    IDLE:     "#bfbfbf",
    WIDTH: 0.12,
    OPACITY: 0.45,
    FONT: 0.6
  }
});

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

// Any friendly harvesters currently assigned to this source (live only)
function getIncumbents(roomName, sourceId, excludeName) {
  var out = [];
  for (var name in Game.creeps) {
    var c = Game.creeps[name];
    if (!c || !c.my) continue;
    if (excludeName && name === excludeName) continue;
    if (c.memory && c.memory.task === 'baseharvest' &&
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
             c.memory.task === 'baseharvest' &&
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

function countCreepsWithTask(taskName) {
  var n = 0;
  for (var name in Game.creeps) {
    var c = Game.creeps[name];
    if (c && c.memory && c.memory.task === taskName) n++;
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

var TaskBaseHarvest = {
  run: function(creep) {
    // (0) Simple state flip based on store
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
      if (!creep.memory.harvesting) { creep.memory.harvesting = true; debugSay(creep, '⤵️MINE'); }
    } else if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
      if (creep.memory.harvesting) { creep.memory.harvesting = false; debugSay(creep, '⤴️DROP'); }
    }

    // (1) Harvesting phase
    if (creep.memory.harvesting) {
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
      var courierCount = countCreepsWithTask('courier');
      var queenCount   = countCreepsWithTask('queen');
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
      return;
    }

    // (2) Offload phase: keep going until empty
    if (!creep.memory.harvesting && creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
      var courierCount2 = countCreepsWithTask('courier');
      var queenCount2   = countCreepsWithTask('queen');
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
      return;
    }

    // Otherwise idle only when empty (waiting on regen/seat)
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
      debugSay(creep, '🧘');
      debugRing(creep.room, creep.pos, CFG.DRAW.IDLE, "IDLE");
    }
  }
};

module.exports = TaskBaseHarvest;
