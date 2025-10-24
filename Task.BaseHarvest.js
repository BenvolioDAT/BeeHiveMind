// TaskBaseHarvest.js — queued handoff + conflict-safe miner + container autoplacer/builder
'use strict';

var CONFIG_VIS = {
  enabled: true,
  drawBudgetRemote: 120,
  drawBudgetBase: 60,
  showPathsRemote: true,
  showPathsBase: false
};

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

var BASE_UI = {
  enabled: CONFIG_VIS.enabled,
  drawBudget: CONFIG_VIS.drawBudgetBase,
  showPaths: CONFIG_VIS.showPathsBase
};

var _seatVisualCache = global.__baseSeatVisualCache || (global.__baseSeatVisualCache = { tick: -1, rooms: {} });

// FIX: Build a per-tick cache of harvester assignments and courier totals so we stop re-scanning Game.creeps in hot paths.
var _harvesterRoomCache = global.__baseHarvesterRoomCache || (global.__baseHarvesterRoomCache = { tick: -1, rooms: {}, globalCourierCount: 0 });

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
// FIX: Cache harvester incumbents per room so repeated role lookups do not sweep Game.creeps every tick.
function ensureHarvesterRoomCacheTick() {
  if (!_harvesterRoomCache || _harvesterRoomCache.tick !== Game.time) {
    _harvesterRoomCache = global.__baseHarvesterRoomCache = { tick: Game.time, rooms: {}, globalCourierCount: 0 };

    for (var name in Game.creeps) {
      if (!Object.prototype.hasOwnProperty.call(Game.creeps, name)) continue;
      var creep = Game.creeps[name];
      if (!creep || !creep.my || !creep.memory) continue;

      if (creep.memory.task === 'courier') {
        _harvesterRoomCache.globalCourierCount++;
        continue;
      }

      if (creep.memory.task !== 'baseharvest') continue;
      if (!creep.memory.assignedSource) continue;

      var roomName = null;
      if (creep.room && creep.room.name) {
        roomName = creep.room.name;
      } else if (creep.memory.seatRoom) {
        roomName = creep.memory.seatRoom;
      } else if (creep.memory.homeRoom) {
        roomName = creep.memory.homeRoom;
      }
      if (!roomName) continue;

      var roomBucket = _harvesterRoomCache.rooms[roomName];
      if (!roomBucket) {
        roomBucket = { sourceCounts: {}, sourceIncumbents: {} };
        _harvesterRoomCache.rooms[roomName] = roomBucket;
      }

      var sid = creep.memory.assignedSource;
      if (!roomBucket.sourceCounts[sid]) roomBucket.sourceCounts[sid] = 0;
      roomBucket.sourceCounts[sid]++;
      if (!roomBucket.sourceIncumbents[sid]) roomBucket.sourceIncumbents[sid] = [];
      roomBucket.sourceIncumbents[sid].push(creep);
    }
  }
  return _harvesterRoomCache;
}

function getIncumbents(roomName, sourceId, excludeName) {
  if (!roomName || !sourceId) return [];
  var cache = ensureHarvesterRoomCacheTick();
  var roomBucket = cache.rooms[roomName];
  if (!roomBucket || !roomBucket.sourceIncumbents[sourceId]) return [];
  var incumbents = roomBucket.sourceIncumbents[sourceId];
  var out = [];
  for (var i = 0; i < incumbents.length; i++) {
    var creep = incumbents[i];
    if (!creep) continue;
    if (excludeName && creep.name === excludeName) continue;
    out.push(creep);
  }
  return out;
}

// Count assigned harvesters (live)
function countAssignedHarvesters(roomName, sourceId) {
  if (!roomName || !sourceId) return 0;
  var cache = ensureHarvesterRoomCacheTick();
  var roomBucket = cache.rooms[roomName];
  if (!roomBucket || !roomBucket.sourceCounts[sourceId]) return 0;
  return roomBucket.sourceCounts[sourceId];
}

// FIX: When we assign a source mid-tick, immediately reflect it inside the cache so follow-on creeps see the occupied seat.
function trackHarvesterAssignment(creep) {
  if (!creep || !creep.memory || !creep.memory.assignedSource) return;
  var roomName = null;
  if (creep.room && creep.room.name) {
    roomName = creep.room.name;
  } else if (creep.memory.seatRoom) {
    roomName = creep.memory.seatRoom;
  } else if (creep.memory.homeRoom) {
    roomName = creep.memory.homeRoom;
  }
  if (!roomName) return;

  var cache = ensureHarvesterRoomCacheTick();
  var roomBucket = cache.rooms[roomName];
  if (!roomBucket) {
    roomBucket = { sourceCounts: {}, sourceIncumbents: {} };
    cache.rooms[roomName] = roomBucket;
  }

  var sid = creep.memory.assignedSource;
  if (!roomBucket.sourceIncumbents[sid]) roomBucket.sourceIncumbents[sid] = [];

  var already = false;
  for (var i = 0; i < roomBucket.sourceIncumbents[sid].length; i++) {
    var seen = roomBucket.sourceIncumbents[sid][i];
    if (seen && seen.name === creep.name) {
      already = true;
      break;
    }
  }
  if (already) return;

  if (!roomBucket.sourceCounts[sid]) roomBucket.sourceCounts[sid] = 0;
  roomBucket.sourceCounts[sid]++;
  roomBucket.sourceIncumbents[sid].push(creep);
}

// FIX: Share the courier total via the same cache to remove the per-tick full creep scan.
function getGlobalCourierCount() {
  var cache = ensureHarvesterRoomCacheTick();
  return cache.globalCourierCount || 0;
}

function ensureSeatVisualCacheTick() {
  if (_seatVisualCache.tick !== Game.time) {
    _seatVisualCache.tick = Game.time;
    _seatVisualCache.rooms = {};
  }
  return _seatVisualCache;
}

function getBaseSeatsForVisual(roomName) {
  if (!roomName) return [];
  var cache = ensureSeatVisualCacheTick();
  if (cache.rooms[roomName]) return cache.rooms[roomName];
  var result = [];
  var room = Game.rooms[roomName];
  if (!room) {
    cache.rooms[roomName] = result;
    return result;
  }
  var assigned = Object.create(null);
  var name;
  for (name in Game.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Game.creeps, name)) continue;
    var creep = Game.creeps[name];
    if (!creep || !creep.my || !creep.memory || creep.memory.task !== 'baseharvest') continue;
    if (!creep.memory.assignedSource) continue;
    var sid = creep.memory.assignedSource;
    if (!assigned[sid]) assigned[sid] = { creeps: [], queued: false };
    assigned[sid].creeps.push(creep);
    if (creep.memory.waitingForSeat) assigned[sid].queued = true;
  }
  if (Memory.creeps) {
    for (name in Memory.creeps) {
      if (!Object.prototype.hasOwnProperty.call(Memory.creeps, name)) continue;
      if (Game.creeps[name]) continue;
      var mem = Memory.creeps[name];
      if (!mem || mem.task !== 'baseharvest') continue;
      if (!mem.assignedSource) continue;
      if (!assigned[mem.assignedSource]) assigned[mem.assignedSource] = { creeps: [], queued: false };
      if (mem.waitingForSeat || mem.queueing || mem.queued) assigned[mem.assignedSource].queued = true;
    }
  }
  var sources = room.find(FIND_SOURCES) || [];
  for (var i = 0; i < sources.length; i++) {
    var source = sources[i];
    if (!source) continue;
    var bucket = assigned[source.id] || { creeps: [], queued: false };
    var occupantTtl = null;
    for (var c = 0; c < bucket.creeps.length; c++) {
      var worker = bucket.creeps[c];
      if (!worker) continue;
      if (worker.memory && worker.memory.waitingForSeat) bucket.queued = true;
      var ttl = worker.ticksToLive;
      if (ttl != null && (occupantTtl === null || ttl > occupantTtl)) occupantTtl = ttl;
    }
    var seatState = 'FREE';
    if (occupantTtl != null) seatState = 'OCCUPIED';
    var ttlValue = occupantTtl != null ? occupantTtl : 0;
    if (ttlValue < 0) ttlValue = 0;
    var queued = bucket.queued || bucket.creeps.length > 1 || (occupantTtl != null && occupantTtl <= CONFIG.handoffTtl);
    if (queued) seatState = 'QUEUED';
    var container = getAdjacentContainerForSource(source);
    var fill = null;
    if (container && container.store) {
      if (typeof container.store.getCapacity === 'function') {
        var cap = container.store.getCapacity(RESOURCE_ENERGY);
        if (cap > 0) {
          fill = (container.store[RESOURCE_ENERGY] || 0) / cap;
        }
      } else if (container.storeCapacity != null && container.storeCapacity > 0) {
        fill = (container.store[RESOURCE_ENERGY] || 0) / container.storeCapacity;
      }
    }
    if (fill != null) {
      if (fill < 0) fill = 0;
      if (fill > 1) fill = 1;
    }
    var roomMem = Memory.rooms && Memory.rooms[roomName];
    var sourceMem = roomMem && roomMem.sources && roomMem.sources[source.id];
    var contestedUntil = sourceMem && sourceMem.contestedUntilTick != null ? sourceMem.contestedUntilTick : null;
    var lastYieldTick = sourceMem && sourceMem.lastYieldTick != null ? sourceMem.lastYieldTick : null;
    var record = {
      sourceId: source.id,
      pos: { x: source.pos.x, y: source.pos.y, roomName: roomName },
      seatState: seatState,
      minerTtl: ttlValue,
      containerFill: fill,
      queuedMiner: !!queued,
      lastYieldTick: lastYieldTick,
      contestedUntilTick: contestedUntil
    };
    result.push(record);
  }
  cache.rooms[roomName] = result;
  return result;
}

function ensureContainerNearSource(creep, source) {
  if (!creep || !source || !source.pos || !source.pos.roomName) return false;

  // Resolve the visible room (RoomPosition lacks .room for remotes)
  var pos  = source.pos;
  var room = Game.rooms && Game.rooms[pos.roomName];
  if (!room) return false; // no vision → do nothing

  // 1) Existing container adjacent? Nothing to place.
  var containers = pos.findInRange(FIND_STRUCTURES, 1, {
    filter: function (s) { return s.structureType === STRUCTURE_CONTAINER; }
  });
  if (containers && containers.length) {
    return false;
  }

  // 2) Container construction site adjacent? We will NOT build it—leave it for builders.
  var sites = pos.findInRange(FIND_CONSTRUCTION_SITES, 1, {
    // If you want to respect only your own, keep s.my; or drop it to accept allied planners
    filter: function (s) { return s.structureType === STRUCTURE_CONTAINER; }
  });
  if (sites && sites.length) {
    return false; // site already exists, nothing to do
  }

  // 3) No site? Choose best adjacent walkable tile (prefer plains over swamp, avoid non-road structures)
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

      // Avoid placing on top of non-road structures
      var structs = room.lookForAt(LOOK_STRUCTURES, x, y);
      var blocked = false;
      var i;
      for (i = 0; i < structs.length; i++) {
        if (structs[i].structureType !== STRUCTURE_ROAD) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;

      // Lower score is better: plains (1) preferred over swamp (2)
      var score = (t === TERRAIN_MASK_SWAMP) ? 2 : 1;
      if (!best || score < best.score) {
        best = { x: x, y: y, score: score };
      }
    }
  }

  // 4) Place the construction site (no building)
  if (best) {
    var res = room.createConstructionSite(best.x, best.y, STRUCTURE_CONTAINER);
    if (res === OK) {
      // Optional: Draw a quick room visual ping for debug
      if (room.visual) {
        room.visual.text(
          '📦',
          best.x,
          best.y - 0.3,
          { color: '#ffaa00', font: 0.8, opacity: 0.9 }
        );
      }
      // We deliberately do NOT build or move for building here.
      // Let dedicated builders / build waves handle it.
      return true; // we acted this tick (created a site)
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

  // FIX: Push the new assignment into the per-tick cache so other miners respect the occupied seat immediately.
  trackHarvesterAssignment(creep);

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
    // (0) State logic — always true for miners (they’re harvesters by default)
    if (!creep.memory.harvesting) creep.memory.harvesting = true;

    // (1) Harvesting phase
    if (creep.memory.harvesting) {
      var sid = assignSource(creep);
      if (!sid) return;

      var source = Game.getObjectById(sid);
      if (!source) {
        creep.memory.assignedSource = null;
        creep.memory.waitingForSeat = false;
        return;
      }

      // Resolve conflicts
      if (resolveSourceConflict(creep, source)) return;

      // Place container if missing
      if (ensureContainerNearSource(creep, source)) return;

      // Seat position
      var seatPos = (creep.memory.seatRoom === creep.room.name)
        ? new RoomPosition(creep.memory.seatX, creep.memory.seatY, creep.memory.seatRoom)
        : getPreferredSeatPos(source);

      if (!seatPos) return;

      // Move to seat if needed
      if (!creep.pos.isEqualTo(seatPos)) {
        BeeToolbox.BeeTravel(creep, seatPos, 0);
        return;
      }

      // Harvest normally
      var harvestResult = creep.harvest(source);

      // 🟡 FIX: If miner is full but no container nearby → drop energy immediately
      if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
        var nearbyContainer = getContainerAtOrAdjacent(creep.pos);
        if (!nearbyContainer) {
          creep.drop(RESOURCE_ENERGY);
        } else {
          creep.transfer(nearbyContainer, RESOURCE_ENERGY);
        }
      }

      return;
    }

    // (2) Offload phase (for creeps with CARRY)
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
      var cont = getContainerAtOrAdjacent(creep.pos);
      if (cont) {
        var tr = creep.transfer(cont, RESOURCE_ENERGY);
        if (tr === ERR_NOT_IN_RANGE) {
          BeeToolbox.BeeTravel(creep, cont.pos || cont, 1);
        } else if (tr === ERR_FULL) {
          creep.drop(RESOURCE_ENERGY);
        }
        return;
      }

      // No container → drop on ground
      creep.drop(RESOURCE_ENERGY);
      return;
    }

    // (3) If no couriers exist, dump to ground as last resort
    var courierCount = getGlobalCourierCount();
    if (courierCount === 0 && creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
      creep.drop(RESOURCE_ENERGY);
      return;
    }
  }
};


TaskBaseHarvest.getBaseSeatsForVisual = getBaseSeatsForVisual;
TaskBaseHarvest.BASE_UI = BASE_UI;
TaskBaseHarvest.CONFIG_VIS = CONFIG_VIS;

module.exports = TaskBaseHarvest;
