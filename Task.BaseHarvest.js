// TaskBaseHarvest.js — queued handoff + conflict-safe miner + container autoplacer/builder
'use strict';

var BeeToolbox = require('BeeToolbox');

var HARVESTER_CFG = BeeToolbox && BeeToolbox.HARVESTER_CFG
  ? BeeToolbox.HARVESTER_CFG
  : { MAX_WORK: 6, RENEWAL_TTL: 150, EMERGENCY_TTL: 50 };

/** =========================
 *  Config knobs
 *  ========================= */
var CONFIG = {
  maxHarvestersPerSource: 1,   // 1 = strict single-seat miners (best w/ container)
  avoidTicksAfterYield: 20,    // loser avoids yielded source for this many ticks
  handoffTtl: HARVESTER_CFG.RENEWAL_TTL,             // if incumbent's TTL <= this, allow queueing
  queueRange: 1,               // park within this range when queueing (1 = adjacent)
  travelReuse: 12              // reusePath hint for travel helper (if used internally)
};

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
 *  NEW: Container ensure/build helper
 *  ========================= */
// ES5-safe helper: ensure there's a container next to a source.
// Returns true if it took a build/place/move/harvest action this tick (so caller can `return`).
function ensureContainerNearSource(creep, source) {
  if (!creep || !source || !source.pos || !source.pos.roomName) return false;

  var pos = source.pos;

  // 1) Existing container adjacent?
  var containers = pos.findInRange(FIND_STRUCTURES, 1, {
    filter: function (s) { return s.structureType === STRUCTURE_CONTAINER; }
  });
  if (containers && containers.length) {
    // Container exists; nothing to build/place.
    return false;
  }

  // 2) Container construction site adjacent?
  var sites = pos.findInRange(FIND_CONSTRUCTION_SITES, 1, {
    filter: function (s) { return s.structureType === STRUCTURE_CONTAINER && s.my; }
  });

  if (sites && sites.length) {
    var site = sites[0];

    // Only units with CARRY + energy can build.
    var canBuild = (creep.getActiveBodyparts(WORK) > 0) &&
                   (creep.store && creep.store[RESOURCE_ENERGY] > 0);

    if (canBuild) {
      if (creep.pos.inRangeTo(site, 3)) {
        creep.build(site);
      } else if (BeeToolbox && typeof BeeToolbox.BeeTravel === 'function') {
        BeeToolbox.BeeTravel(creep, site.pos || site, 3);
      } else if (typeof creep.travelTo === 'function') {
        creep.travelTo(site, { range: 3 });
      } else {
        creep.moveTo(site, { reusePath: 10 });
      }
      return true; // handled an action
    } else {
      // If we have CARRY but no energy yet, harvest a bit then come back.
      var hasCarry = creep.getActiveBodyparts(CARRY) > 0;
      if (hasCarry && creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        if (creep.pos.inRangeTo(source, 1)) {
          creep.harvest(source);
        } else if (BeeToolbox && typeof BeeToolbox.BeeTravel === 'function') {
          BeeToolbox.BeeTravel(creep, source.pos || source, 1);
        } else if (typeof creep.travelTo === 'function') {
          creep.travelTo(source, { range: 1 });
        } else {
          creep.moveTo(source, { reusePath: 10 });
        }
        return true;
      }
      // Miners with no CARRY can’t help build; fall through.
    }
  }

  // 3) No site? Place one on the best adjacent walkable tile.
  var terrain = new Room.Terrain(pos.roomName);
  var best = null;
  var dx, dy;
  for (dx = -1; dx <= 1; dx++) {
    for (dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      var x = pos.x + dx, y = pos.y + dy;
      if (x <= 0 || x >= 49 || y <= 0 || y >= 49) continue;

      var t = terrain.get(x, y);
      if (t === TERRAIN_MASK_WALL) continue;

      // Avoid placing on top of non-road structures.
      var structs = pos.room.lookForAt(LOOK_STRUCTURES, x, y);
      var blocked = false;
      var i;
      for (i = 0; i < structs.length; i++) {
        if (structs[i].structureType !== STRUCTURE_ROAD) { blocked = true; break; }
      }
      if (blocked) continue;

      // Prefer plains over swamp (lower score is better).
      var score = (t === TERRAIN_MASK_SWAMP) ? 2 : 1;
      if (!best || score < best.score) {
        best = { x: x, y: y, score: score };
      }
    }
  }

  if (best) {
    var res = pos.room.createConstructionSite(best.x, best.y, STRUCTURE_CONTAINER);
    if (res === OK) {
      // If we can build right away, step toward it.
      var nearSiteArr = pos.room.lookForAt(LOOK_CONSTRUCTION_SITES, best.x, best.y);
      var nearSite = (nearSiteArr && nearSiteArr.length) ? nearSiteArr[0] : null;
      if (nearSite && creep.getActiveBodyparts(WORK) > 0 && creep.getActiveBodyparts(CARRY) > 0) {
        if (creep.pos.inRangeTo(nearSite, 3)) creep.build(nearSite);
        else if (BeeToolbox && typeof BeeToolbox.BeeTravel === 'function') BeeToolbox.BeeTravel(creep, nearSite.pos || nearSite, 3);
        else if (typeof creep.travelTo === 'function') creep.travelTo(nearSite, { range: 3 });
        else creep.moveTo(nearSite, { reusePath: 10 });
      }
      return true;
    }
  }

  return false;
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
    creep.say('yield 🐝');
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
    // ticksToLive can be undefined briefly; treat as not expiring
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
      // Prefer currently unoccupied tiles
      var occupied = isTileOccupiedByAlly(p, myName);
      var score = occupied ? -10 : 0;
      // Slight bias for lower y/x for determinism
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

  // Respect short cooldown to avoid thrash after we yielded
  if (creep.memory._reassignCooldown && Game.time < creep.memory._reassignCooldown) {
    return creep.memory.assignedSource || null;
  }

  // Keep current assignment if any
  if (creep.memory.assignedSource) return creep.memory.assignedSource;

  var sources = creep.room.find(FIND_SOURCES);
  if (!sources || !sources.length) return null;

  var best = null;
  var bestScore = -Infinity;
  var bestWillQueue = false;

  for (var i = 0; i < sources.length; i++) {
    var s = sources[i];

    // Avoid the source we just yielded from for a short window
    if (creep.memory._avoidSourceId === s.id &&
        creep.memory._avoidUntil &&
        Game.time < creep.memory._avoidUntil) {
      continue;
    }

    var seatPos = getPreferredSeatPos(s);
    if (!seatPos) continue; // no usable seat

    // Effective capacity: container implies 1 seat (strict miner seat)
    var seats = getAdjacentContainerForSource(s) ? 1 : countWalkableSeatsAround(s.pos);
    if (CONFIG.maxHarvestersPerSource > 0) {
      seats = Math.min(seats, CONFIG.maxHarvestersPerSource);
    }

    var used = countAssignedHarvesters(creep.room.name, s.id);
    var free = seats - used;
    var willQueue = false;

    // If full, consider queueing only if an incumbent is expiring soon
    if (free <= 0) {
      if (!shouldQueueForSource(creep, s, seats, used)) continue;
      willQueue = true;
    }

    // Score: prefer free seats strongly; then proximity to the seat
    var range = creep.pos.getRangeTo(seatPos);
    var score = (free > 0 ? 1000 : 0) - range;

    if (score > bestScore) {
      bestScore = score;
      best = { source: s, seatPos: seatPos };
      bestWillQueue = willQueue;
    }
  }

  if (!best) return null;

  // Lock assignment and remember if we're starting as queued
  creep.memory.assignedSource = best.source.id;
  creep.memory.seatX = best.seatPos.x;
  creep.memory.seatY = best.seatPos.y;
  creep.memory.seatRoom = best.seatPos.roomName;
  creep.memory.waitingForSeat = !!bestWillQueue;

  return best.source.id;
}

/** =========================
 *  Offload helper (when full)
 *  ========================= */

function getContainerAtOrAdjacent(pos) {
  // Same tile first
  var here = pos.lookFor(LOOK_STRUCTURES);
  for (var i = 0; i < here.length; i++) {
    if (here[i].structureType === STRUCTURE_CONTAINER) return here[i];
  }
  // Adjacent
  var around = pos.findInRange(FIND_STRUCTURES, 1, {
    filter: function(s) { return s.structureType === STRUCTURE_CONTAINER; }
  });
  return (around && around.length) ? around[0] : null;
}

/** =========================
 *  Main role
 *  ========================= */

var TaskBaseHarvest = {
  run: function(creep) {
    // (0) Simple state flip based on store
    if (!creep.memory.harvesting && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
      creep.memory.harvesting = true;
    }
    if (creep.memory.harvesting && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
      creep.memory.harvesting = false;
    }

    // (1) Harvesting phase
    if (creep.memory.harvesting) {
      var sid = assignSource(creep);
      if (!sid) return;

      var source = Game.getObjectById(sid);
      if (!source) { creep.memory.assignedSource = null; creep.memory.waitingForSeat = false; return; }

      // Resolve local conflicts if we are in the scrum
      if (resolveSourceConflict(creep, source)) return;

      // NEW: If there is no container yet, place/build one (handles move/harvest/build). Bail if it acted.
      if (ensureContainerNearSource(creep, source)) return;

      // Preferred seat position (rebuild if memory room mismatch)
      var seatPos = (creep.memory.seatRoom === creep.room.name)
        ? new RoomPosition(creep.memory.seatX, creep.memory.seatY, creep.memory.seatRoom)
        : getPreferredSeatPos(source);

      // Capacity math
      var seats = getAdjacentContainerForSource(source) ? 1 : countWalkableSeatsAround(source.pos);
      if (CONFIG.maxHarvestersPerSource > 0) seats = Math.min(seats, CONFIG.maxHarvestersPerSource);
      var used  = countAssignedHarvesters(creep.room.name, source.id);

      // Promote out of queue ASAP if capacity exists now
      if (used < seats) {
        creep.memory.waitingForSeat = false;
      }

      // Seat occupancy: any creep (ally or not) blocks the exact tile unless it's me
      var seatBlocked = isTileOccupiedByAnyCreep(seatPos, creep.name) && !creep.pos.isEqualTo(seatPos);

      // Decide whether to queue this tick
      var shouldQueue = (seatBlocked || creep.memory.waitingForSeat) && used >= seats && shouldQueueForSource(creep, source, seats, used);

      if (shouldQueue) {
        // Park near seat (not on it)
        var queueSpot = findQueueSpotNearSeat(seatPos, creep.name) || seatPos;
        creep.memory.waitingForSeat = true;

        if (!creep.pos.isEqualTo(queueSpot)) {
          // Use numeric range for your BeeTravel variant
          BeeToolbox.BeeTravel(creep, queueSpot, 0);
          return;
        }

        // If we can reach the source from here (range 1), go ahead and harvest while waiting
        if (creep.pos.getRangeTo(source) <= 1) creep.harvest(source);

        // If the seat frees up OR capacity opens, take it now
        if (!isTileOccupiedByAnyCreep(seatPos, creep.name) || countAssignedHarvesters(creep.room.name, source.id) < seats) {
          BeeToolbox.BeeTravel(creep, seatPos, 0);
          creep.memory.waitingForSeat = false;
        }
        return;
      }

      // NO QUEUE: seat free or capacity available → go sit or harvest
      if (!creep.pos.isEqualTo(seatPos)) {
        BeeToolbox.BeeTravel(creep, seatPos, 0);
        return;
      }
      creep.memory.waitingForSeat = false;
      creep.harvest(source);
      return;
    }

    // (2) Not harvesting (carrying energy): Offload until empty
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
      var cont = getContainerAtOrAdjacent(creep.pos);
      if (cont) {
        var free = 0;
        if (cont.store && typeof cont.store.getFreeCapacity === 'function') {
          free = cont.store.getFreeCapacity(RESOURCE_ENERGY);
        } else if (cont.store && typeof cont.store.getCapacity === 'function') {
          free = cont.store.getCapacity(RESOURCE_ENERGY);
          if (typeof cont.store[RESOURCE_ENERGY] === 'number') {
            free -= cont.store[RESOURCE_ENERGY];
          }
        }

        if (free === 0) {
          creep.drop(RESOURCE_ENERGY);
          return;
        }

        var tr = creep.transfer(cont, RESOURCE_ENERGY);
        if (tr === ERR_NOT_IN_RANGE) {
          BeeToolbox.BeeTravel(creep, cont.pos || cont, 1);
        } else if (tr === ERR_FULL) {
          creep.drop(RESOURCE_ENERGY);
        }
        return;
      }
    }

    // (3) If no couriers exist, dump to ground as last resort
    var courierCount = 0;
    for (var name in Game.creeps) {
      var c = Game.creeps[name];
      if (c && c.my && c.memory && c.memory.task === 'courier') courierCount++;
    }
    if (courierCount === 0 && creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
      creep.drop(RESOURCE_ENERGY);
      return;
    }
  }
};

module.exports = TaskBaseHarvest;
