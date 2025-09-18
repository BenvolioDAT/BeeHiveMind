// TaskRemoteHarvest.clean.js
// Remote-harvester ("forager"): mines a remote source and hauls energy home.
// Refactor goals:
// - Preserve external API: same export name, same public helpers inside object.
// - ES5-compatible (no optional chaining / nullish coalescing).
// - Safer occupancy accounting (no leaks), capped concurrency per source.
// - PF-cost caching + once-per-tick auditing to avoid CPU spikes.
// - Clear, beginner-friendly comments.
//
// NOTE: This file still relies on BeeToolbox if present, but gracefully degrades.
//
// ============================
// Dependencies
// ============================
var BeeToolbox = require('BeeToolbox');

// ============================
// Tunables
// ============================
var REMOTE_RADIUS = 3;             // Room hops from home to scan
var MAX_PF_OPS    = 4000;          // PathFinder ops budget during selection
var PLAIN_COST    = 2;             // PF cost on plains
var SWAMP_COST    = 10;            // PF cost on swamps
var MAX_FORAGERS_PER_SOURCE = 1;   // Raise to 2+ if you plan miner/hauler split

// ============================
// Global, safe, ES5 utilities
// ============================

// --- Occupancy audit ---
// Rebuilds Memory.remoteAssignments from live creeps to prevent leaks.
// We run this ONCE per tick (guarded) so calling from each creep is safe.
function auditRemoteAssignments() {
  var live = {};
  for (var name in Game.creeps) {
    var c = Game.creeps[name];
    if (c && c.memory && c.memory.task === 'remoteharvest') {
      var sid = c.memory.sourceId;
      if (sid) live[sid] = (live[sid] || 0) + 1;
    }
  }
  var memAssign = Memory.remoteAssignments || (Memory.remoteAssignments = {});
  for (var sid in memAssign) {
    memAssign[sid] = live[sid] || 0;
  }
  // Also add any new sids observed this tick (covers first-claim cases)
  for (var sid2 in live) memAssign[sid2] = live[sid2];
}

// Ensure the audit runs once per tick regardless of how many creeps call run().
function auditOncePerTick() {
  if (Memory._auditRemoteAssignmentsTick !== Game.time) {
    auditRemoteAssignments();
    Memory._auditRemoteAssignmentsTick = Game.time;
  }
}

// --- PF cost cache ---
// Light cache to avoid re-solving PF for the same (homeRoom:sourceId) too often.
var PF_CACHE_TTL = 150; // ~ few minutes; adjust to your taste
if (!Memory._pfCost) Memory._pfCost = {};

function pfCostCached(anchorPos, targetPos, sourceId) {
  var key = anchorPos.roomName + ':' + sourceId;
  var rec = Memory._pfCost[key];
  if (rec && (Game.time - rec.t) < PF_CACHE_TTL) return rec.c;

  var c = pfCost(anchorPos, targetPos);
  Memory._pfCost[key] = { c: c, t: Game.time };
  return c;
}

// --- Simple movement helper ---
// Uses BeeToolbox.BeeTravel if available; otherwise defaults to moveTo().
function go(creep, dest, opts) {
  opts = opts || {};
  if (typeof BeeToolbox !== 'undefined' && BeeToolbox && BeeToolbox.BeeTravel) {
    BeeToolbox.BeeTravel(creep, dest, opts);
    return;
  }
  var desired = (opts.range != null) ? opts.range : 1;
  if (creep.pos.getRangeTo(dest) > desired) {
    creep.moveTo(dest, { reusePath: (opts.reusePath != null ? opts.reusePath : 15) });
  }
}

function ensureAssignmentsMem() {
  // Memory.remoteAssignments: { [sourceId]: numberAssigned }
  if (!Memory.remoteAssignments) Memory.remoteAssignments = {};
  return Memory.remoteAssignments;
}

// Choose a "home" room name for the creep and memoize it.
function getHomeName(creep) {
  if (creep.memory.home) return creep.memory.home;

  // Find nearest owned spawn by linear distance
  var spawns = Object.keys(Game.spawns).map(function(k){ return Game.spawns[k]; });
  if (spawns.length) {
    var best = spawns[0];
    var bestD = Game.map.getRoomLinearDistance(creep.pos.roomName, best.pos.roomName);
    for (var i = 1; i < spawns.length; i++) {
      var s = spawns[i];
      var d = Game.map.getRoomLinearDistance(creep.pos.roomName, s.pos.roomName);
      if (d < bestD) { best = s; bestD = d; }
    }
    creep.memory.home = best.pos.roomName;
    return creep.memory.home;
  }

  // Fallback: current room
  creep.memory.home = creep.pos.roomName;
  return creep.memory.home;
}

// Anchor = Storage → Spawn → Controller → room center (if no vision)
function getAnchorPos(homeName) {
  var r = Game.rooms[homeName];
  if (r) {
    if (r.storage) return r.storage.pos;
    var spawns = r.find(FIND_MY_SPAWNS);
    if (spawns.length) return spawns[0].pos;
    if (r.controller && r.controller.my) return r.controller.pos;
  }
  return new RoomPosition(25, 25, homeName);
}

// BFS the exits graph out to `radius` hops, returns array of room names (no start).
function bfsNeighborRooms(startName, radius) {
  radius = radius == null ? 1 : radius;
  var seen = {};
  seen[startName] = true;
  var frontier = [startName];

  for (var depth = 0; depth < radius; depth++) {
    var next = [];
    for (var f = 0; f < frontier.length; f++) {
      var rn = frontier[f];
      var exits = Game.map.describeExits(rn) || {};
      for (var dir in exits) {
        var n = exits[dir];
        if (!seen[n]) { seen[n] = true; next.push(n); }
      }
    }
    frontier = next;
  }

  // Return all seen except the start
  var out = [];
  for (var k in seen) if (k !== startName) out.push(k);
  return out;
}

// Estimate real cross-room cost with PathFinder (blocks non-road structures, except own ramparts/containers).
function pfCost(anchorPos, targetPos) {
  var ret = PathFinder.search(
    anchorPos,
    { pos: targetPos, range: 1 },
    {
      maxOps: MAX_PF_OPS,
      plainCost: PLAIN_COST,
      swampCost: SWAMP_COST,
      roomCallback: function(roomName) {
        var room = Game.rooms[roomName];
        if (!room) return; // default costs if no vision
        var matrix = new PathFinder.CostMatrix();

        room.find(FIND_STRUCTURES).forEach(function(s) {
          if (s.structureType === STRUCTURE_ROAD) {
            matrix.set(s.pos.x, s.pos.y, 1);
          } else if (
            s.structureType !== STRUCTURE_CONTAINER &&
            (s.structureType !== STRUCTURE_RAMPART || !s.my)
          ) {
            matrix.set(s.pos.x, s.pos.y, 0xff); // impassable
          }
        });

        room.find(FIND_CONSTRUCTION_SITES).forEach(function(cs) {
          if (cs.structureType !== STRUCTURE_ROAD) {
            matrix.set(cs.pos.x, cs.pos.y, 0xff);
          }
        });

        return matrix;
      }
    }
  );

  return ret.incomplete ? Infinity : ret.cost;
}

// Pick the "best" remote source among visible neighbors within REMOTE_RADIUS.
// Heuristic: lowest PF cost → lowest linear-distance → stable id tiebreak.
// Respects MAX_FORAGERS_PER_SOURCE via Memory.remoteAssignments.
function pickRemoteSource(creep) {
  var memAssign = ensureAssignmentsMem();
  var homeName = getHomeName(creep);
  var anchor = getAnchorPos(homeName);

  var neighborRooms = bfsNeighborRooms(homeName, REMOTE_RADIUS);
  var candidates = [];

  for (var i = 0; i < neighborRooms.length; i++) {
    var rn = neighborRooms[i];
    var room = Game.rooms[rn];
    if (!room) continue; // need vision to see actual sources

    var sources = room.find(FIND_SOURCES);
    for (var j = 0; j < sources.length; j++) {
      var s = sources[j];
      var occ = memAssign[s.id] || 0;
      if (occ >= MAX_FORAGERS_PER_SOURCE) continue; // true cap

      var cost = pfCostCached(anchor, s.pos, s.id);
      if (cost === Infinity) continue;

      candidates.push({
        id: s.id,
        roomName: rn,
        cost: cost,
        lin: Game.map.getRoomLinearDistance(homeName, rn)
      });
    }
  }

  if (!candidates.length) return null;

  candidates.sort(function(a, b) {
    return (a.cost - b.cost) || (a.lin - b.lin) || (a.id < b.id ? -1 : (a.id > b.id ? 1 : 0));
  });

  var best = candidates[0];
  // Reserve a slot immediately so another picker won’t grab it this tick.
  memAssign[best.id] = (memAssign[best.id] || 0) + 1;

  console.log('🧭 ' + creep.name + ' pick src=' + best.id.slice(-6) + ' room=' + best.roomName + ' cost=' + best.cost);
  return best;
}

// Release this creep's claimed source slot (idempotent; safe to call multiple times).
function releaseAssignment(creep) {
  var memAssign = ensureAssignmentsMem();
  var sid = creep.memory.sourceId;
  if (sid && memAssign[sid]) memAssign[sid] = Math.max(0, memAssign[sid] - 1);
  creep.memory.sourceId   = null;
  creep.memory.targetRoom = null;
  creep.memory.assigned   = false;
}

// ============================
// Main role
// ============================
var TaskRemoteHarvest = {
  run: function(creep) {
    // Keep occupancy truthful but cheap: audit only once per tick globally.
    auditOncePerTick();

    // Ensure home memo exists for consistent anchor usage.
    if (!creep.memory.home) getHomeName(creep);

    // Near end-of-life? Free your slot gracefully so a fresh bee can claim it.
    if (creep.ticksToLive !== undefined && creep.ticksToLive < 5 && creep.memory.assigned) {
      releaseAssignment(creep);
    }

    // Assignment phase: try PF-based picker, else legacy Memory-based spread.
    if (!creep.memory.sourceId) {
      var pick = pickRemoteSource(creep);
      if (pick) {
        creep.memory.sourceId   = pick.id;
        creep.memory.targetRoom = pick.roomName;
        creep.memory.assigned   = true;
      } else {
        this.initializeAndAssign(creep);
        if (!creep.memory.sourceId) {
          // No visible candidates yet—idle at home anchor until scouts provide vision.
          var anchor = getAnchorPos(getHomeName(creep));
          go(creep, anchor, { range: 2 });
          return;
        }
      }
    }

    // Simple state machine: return when full, harvest when not.
    this.updateReturnState(creep);

    if (creep.memory.returning) {
      this.returnToStorage(creep);
      return;
    }

    // Not returning: head to target room if we're not there yet (center rally helps border crossing).
    if (creep.memory.targetRoom && creep.pos.roomName !== creep.memory.targetRoom) {
      go(creep, new RoomPosition(25, 25, creep.memory.targetRoom), { range: 20 });
      return;
    }

    // Defensive: if memory got wiped mid-run, re-initialize.
    if (!creep.memory.targetRoom || !creep.memory.sourceId) {
      this.initializeAndAssign(creep);
      if (!creep.memory.targetRoom || !creep.memory.sourceId) {
        console.log('🚫 Forager ' + creep.name + ' could not be assigned a room/source.');
        return;
      }
    }

    // Keep room source metadata fresh if you have vision + toolbox hook.
    var targetRoomObj = Game.rooms[creep.memory.targetRoom];
    if (targetRoomObj && BeeToolbox && BeeToolbox.logSourcesInRoom) {
      BeeToolbox.logSourcesInRoom(targetRoomObj);
    }

    // Optional policy gate: skip hostile rooms if flagged in Memory.
    var tmem = Memory.rooms[creep.memory.targetRoom];
    if (tmem && tmem.hostile) {
      console.log('⚠️ Forager ' + creep.name + ' avoiding hostile room ' + creep.memory.targetRoom);
      // Release our slot so others can re-target immediately.
      releaseAssignment(creep);
      return;
    }

    // If we don’t have a sources map yet (likely no prior vision), we wait—movement above will acquire it.
    if (!tmem || !tmem.sources) return;

    // Work the source.
    this.harvestSource(creep);

    // Validate assignment only when in target room (vision guaranteed).
    if (creep.memory.targetRoom && creep.pos.roomName === creep.memory.targetRoom) {
      var srcObj = Game.getObjectById(creep.memory.sourceId);
      if (!srcObj) {
        releaseAssignment(creep);
        return;
      }
    }
  },

  // ------ Legacy / fallback assignment (Memory-based) ------
  initializeAndAssign: function(creep) {
    var targetRooms = this.getNearbyRoomsWithSources(creep.room.name);

    if (!creep.memory.targetRoom || !creep.memory.sourceId) {
      var leastAssignedRoom = this.findRoomWithLeastForagers(targetRooms);
      if (!leastAssignedRoom) {
        console.log('🚫 Forager ' + creep.name + ' found no suitable room with unclaimed sources.');
        return;
      }

      creep.memory.targetRoom = leastAssignedRoom;
      var roomMemory = Memory.rooms[creep.memory.targetRoom];
      var assignedSource = this.assignSource(creep, roomMemory);

      if (assignedSource) {
        creep.memory.sourceId = assignedSource;
        creep.memory.assigned = true;
        // Increment occupancy for legacy path as well.
        var memAssign = ensureAssignmentsMem();
        memAssign[assignedSource] = (memAssign[assignedSource] || 0) + 1;
        console.log('🐝 ' + creep.name + ' assigned to source: ' + assignedSource + ' in ' + creep.memory.targetRoom);
      } else {
        console.log('No available sources for creep: ' + creep.name);
        creep.memory.targetRoom = null;
        creep.memory.sourceId   = null;
      }
    }
  },

  getNearbyRoomsWithSources: function(origin) {
    // Pull rooms from Memory.rooms (populated by scouts/tools) that:
    // - have a sources map, are not hostile, and are not your firstSpawnRoom.
    // Sort by linear distance from origin for predictable spread.
    var all = Object.keys(Memory.rooms || {});
    var filtered = all.filter(function(roomName) {
      var rm = Memory.rooms[roomName];
      return rm && rm.sources && !rm.hostile && roomName !== Memory.firstSpawnRoom;
    });

    return filtered.sort(function(a, b) {
      return Game.map.getRoomLinearDistance(origin, a) - Game.map.getRoomLinearDistance(origin, b);
    });
  },

  findRoomWithLeastForagers: function(targetRooms) {
    // Choose room with lowest average foragers per source.
    var bestRoom = null;
    var lowestAvg = Infinity;

    for (var i = 0; i < targetRooms.length; i++) {
      var roomName = targetRooms[i];
      var rm = Memory.rooms[roomName] || {};
      var sources = rm.sources ? Object.keys(rm.sources) : [];
      if (!sources.length) continue;

      var foragersInRoom = 0;
      for (var name in Game.creeps) {
        var c = Game.creeps[name];
        if (c && c.memory && c.memory.task === 'remoteharvest' && c.memory.targetRoom === roomName) {
          foragersInRoom++;
        }
      }

      var avg = foragersInRoom / sources.length;
      if (avg < lowestAvg) { lowestAvg = avg; bestRoom = roomName; }
    }

    return bestRoom;
  },

  assignSource: function(creep, roomMemory) {
    // Pick least-occupied source (tiers); break ties randomly.
    if (!roomMemory || !roomMemory.sources) return null;
    var sources = Object.keys(roomMemory.sources);
    if (!sources.length) return null;

    // Count current foragers per source in this room
    var counts = {};
    var maxCount = 0;

    for (var si = 0; si < sources.length; si++) {
      var sid = sources[si];
      var cnt = 0;
      for (var name in Game.creeps) {
        var c = Game.creeps[name];
        if (
          c && c.memory && c.memory.task === 'remoteharvest' &&
          c.memory.targetRoom === creep.memory.targetRoom &&
          c.memory.sourceId === sid
        ) { cnt++; }
      }
      counts[sid] = cnt;
      if (cnt > maxCount) maxCount = cnt;
    }

    for (var tier = 0; tier <= maxCount + 1; tier++) {
      var candidates = [];
      for (var sid2 in counts) if (counts[sid2] === tier) candidates.push(sid2);
      if (candidates.length) {
        var idx = Math.floor(Math.random() * candidates.length);
        return candidates[idx];
      }
    }

    return null;
  },

  updateReturnState: function(creep) {
    // Flip only at 0%/100% to avoid mid-fill thrashing.
    if (!creep.memory.returning && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
      creep.memory.returning = true;
    }
    if (creep.memory.returning && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
      creep.memory.returning = false;
    }
  },

  findUnclaimedSource: function(targetRooms) {
    // Legacy helper; scans Memory.rooms[...] for empty assigned lists (if you store them).
    for (var i = 0; i < targetRooms.length; i++) {
      var roomName = targetRooms[i];
      var mem = Memory.rooms[roomName];
      if (!mem || !mem.sources) continue;
      for (var sid in mem.sources) {
        var assigned = mem.sources[sid];
        if (!Array.isArray(assigned) || assigned.length === 0) return { roomName: roomName, sourceId: sid };
      }
    }
    return null;
  },

  returnToStorage: function(creep) {
    // Bring energy back to home.
    var homeName = getHomeName(creep);

    if (creep.room.name !== homeName) {
      go(creep, new RoomPosition(25, 25, homeName), { range: 20 });
      return;
    }

    // Prefer extensions/spawn/storage with free capacity (unchanged to avoid surprising other systems).
    var targets = creep.room.find(FIND_STRUCTURES, {
      filter: function(s) {
        return (
          (s.structureType === STRUCTURE_EXTENSION ||
           s.structureType === STRUCTURE_SPAWN ||
           s.structureType === STRUCTURE_STORAGE) &&
          s.store && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
        );
      }
    });

    if (targets.length) {
      var closest = creep.pos.findClosestByPath(targets);
      if (closest) {
        var rc = creep.transfer(closest, RESOURCE_ENERGY);
        if (rc === ERR_NOT_IN_RANGE) go(creep, closest);
      }
    } else {
      // Idle near anchor (or hand off to another role if you implement that).
      var anchor = getAnchorPos(homeName);
      go(creep, anchor, { range: 2 });
    }
  },

  harvestSource: function(creep) {
    // Validate assignment
    if (!creep.memory.targetRoom || !creep.memory.sourceId) {
      console.log('Forager ' + creep.name + ' missing targetRoom/sourceId');
      return;
    }

    // If not in the right room yet, rally through the center for clean border crossing.
    if (creep.room.name !== creep.memory.targetRoom) {
      if (BeeToolbox && BeeToolbox.logSourceContainersInRoom) {
        BeeToolbox.logSourceContainersInRoom(creep.room);
      }
      go(creep, new RoomPosition(25, 25, creep.memory.targetRoom), { range: 20 });
      return;
    }

    // Optional: record entrySteps inside the room (one-time per source).
    var rm = Memory.rooms[creep.memory.targetRoom] = (Memory.rooms[creep.memory.targetRoom] || {});
    rm.sources = rm.sources || {};
    var sid = creep.memory.sourceId;
    var src = Game.getObjectById(sid);

    if (src && rm.sources[sid] && rm.sources[sid].entrySteps == null) {
      var res = PathFinder.search(creep.pos, { pos: src.pos, range: 1 }, {
        plainCost: PLAIN_COST, swampCost: SWAMP_COST, maxOps: MAX_PF_OPS
      });
      if (!res.incomplete) rm.sources[sid].entrySteps = res.path.length;
    }

    if (!src) { console.log('Source not found for ' + creep.name); return; }

    // Harvest (move if needed)
    if (creep.harvest(src) === ERR_NOT_IN_RANGE) go(creep, src);
  }
};

module.exports = TaskRemoteHarvest;
