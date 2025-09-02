var BeeToolbox = require('BeeToolbox');
// ==== RemoteHarvester Assignment Helpers (local to this file) ====
//
// This role is a "forager": it both mines a remote source and hauls
// that energy home. The helpers below handle:
// - picking which remote source to work (closest-by-path),
// - remembering that assignment across trips,
// - knowing where "home" is and how to path there/back.


// ----------------------------
// Configs
// ----------------------------

// We'll only consider rooms within this many "hops" (room-to-room steps)
// from our home when auto-picking targets. Bump to 2+ to search farther.
const REMOTE_RADIUS = 1;   // Search only rooms 1 hop away. Set 2+ if you want farther.
// Upper bound on PathFinder work during *selection* (not normal movement).
// Higher = more accurate cost, but more CPU in the tick you assign a target.
const MAX_PF_OPS   = 4000; // PathFinder budget for picking targets
// ----------------------------
// go(creep, dest, opts)
// ----------------------------
// Unified "move" helper:
// - If you have BeeToolbox.BeeTravel, we use your smarter pathing.
// - Otherwise, fallback to creep.moveTo with reasonable defaults.
// `opts.range` is how close we want to get to the target (default 1).
function go(creep, dest, opts = {}) {
  if (typeof BeeToolbox !== 'undefined' && BeeToolbox.BeeTravel) {
    BeeToolbox.BeeTravel(creep, dest, opts);
  } else {
    const range = opts.range != null ? opts.range : 1;
    creep.moveTo(dest, { reusePath: 20, range });
  }
}
// ----------------------------
// ensureAssignmentsMem()
// ----------------------------
// Storage for "how many creeps are assigned to a source id".
// This avoids dog-piling many foragers onto the same remote source.
function ensureAssignmentsMem() {
  if (!Memory.remoteAssignments) Memory.remoteAssignments = {};
  return Memory.remoteAssignments;
}
// ----------------------------
// getHomeName(creep)
// ----------------------------
// Determine which room this creep considers "home":
// 1) If creep.memory.home exists, use it.
// 2) Else, pick the *nearest owned spawn's room* by room distance.
// 3) Else (no spawns/vision), default to the creep's current room.
// Saves result to creep.memory.home for next ticks.
function getHomeName(creep) {
  if (creep.memory.home) return creep.memory.home;
  const spawns = Object.values(Game.spawns);
  if (spawns.length) {
    // nearest owned spawn by linear room distance (cheap & stable)
    let best = spawns[0];
    let bestD = Game.map.getRoomLinearDistance(creep.pos.roomName, best.pos.roomName);
    for (let i = 1; i < spawns.length; i++) {
      const d = Game.map.getRoomLinearDistance(creep.pos.roomName, spawns[i].pos.roomName);
      if (d < bestD) { best = spawns[i]; bestD = d; }
    }
    creep.memory.home = best.pos.roomName;
    return creep.memory.home;
  }
  creep.memory.home = creep.pos.roomName;
  return creep.memory.home;
}
// ----------------------------
// getAnchorPos(homeName)
// ----------------------------
// Choose a *position* in home that's a good rally/supply anchor:
// - Prefer Storage (centralized energy), else a Spawn,
// - else Controller (owned), else just room center (25,25) if no vision.
// We use this when going home and when routing back out.
function getAnchorPos(homeName) {
  const r = Game.rooms[homeName];
  if (r) {
    if (r.storage) return r.storage.pos;
    const spawns = r.find(FIND_MY_SPAWNS);
    if (spawns.length) return spawns[0].pos;
    if (r.controller && r.controller.my) return r.controller.pos;
  }
  // No vision? Head for center; moveTo can cross room borders and path blind.
  return new RoomPosition(25, 25, homeName);
}
// ----------------------------
// bfsNeighborRooms(startName, radius)
// ----------------------------
// BFS of the room graph out to `radius` hops from `startName`.
// Returns the set of neighbors at distance <= radius (excluding start).
// This is used to *discover* candidate rooms for target picking.
// (Note: we still require vision to *count* sources in those rooms.)
function bfsNeighborRooms(startName, radius = 1) {
  const seen = new Set([startName]);
  let frontier = [startName];
  for (let depth = 0; depth < radius; depth++) {
    const next = [];
    for (const rn of frontier) {
      const exits = Game.map.describeExits(rn) || {};
      for (const dir of Object.keys(exits)) {
        const nn = exits[dir];
        if (!seen.has(nn)) {
          seen.add(nn);
          next.push(nn);
        }
      }
    }
    frontier = next;
  }
  // remove the start; caller wants only neighbors
  seen.delete(startName);
  return [...seen];
}
// ----------------------------
// pfCost(anchorPos, targetPos)
// ----------------------------
// Estimate the *true* path cost from anchor to a target position across
// rooms using PathFinder (with a small custom roomCallback):
// - roads are cheap (1),
// - buildings that block are basically walls (0xff),
// - if no vision of some room on the way, return default terrain costs.
// Returns Infinity if incomplete (e.g., totally blocked), else a number.
function pfCost(anchorPos, targetPos) {
  const ret = PathFinder.search(
    anchorPos,
    { pos: targetPos, range: 1 },
    {
      maxOps: MAX_PF_OPS,
      plainCost: 2,
      swampCost: 10,
      roomCallback: (roomName) => {
        const room = Game.rooms[roomName];
        if (!room) return; // default costs when no vision
        const costs = new PathFinder.CostMatrix();
        room.find(FIND_STRUCTURES).forEach(s => {
          if (s.structureType === STRUCTURE_ROAD) costs.set(s.pos.x, s.pos.y, 1);
          else if (
            s.structureType !== STRUCTURE_CONTAINER &&
            (s.structureType !== STRUCTURE_RAMPART || !s.my)
          ) costs.set(s.pos.x, s.pos.y, 0xff);
        });
        // discourage building sites that aren't roads as pass-throughs
        room.find(FIND_CONSTRUCTION_SITES).forEach(cs => {
          if (cs.structureType !== STRUCTURE_ROAD) costs.set(cs.pos.x, cs.pos.y, 0xff);
        });
        return costs;
      }
    }
  );
  return ret.incomplete ? Infinity : ret.cost;
}
// ----------------------------
// pickRemoteSource(creep)
// ----------------------------
// Choose the *best* remote source to harvest from among nearby rooms.
// Steps:
// 1) Find neighbor rooms within REMOTE_RADIUS (by exits graph).
// 2) For each visible neighbor room, consider each source:
//    - Skip sources already "occupied" via Memory.remoteAssignments.
//    - Score by *pfCost* from home anchor (true path cost).
//    - As a tie-breaker, use linear room distance and then source id.
// 3) Pick the best candidate, mark it as occupied, and return it.
//
// Returns an object: { id, roomName, cost, lin } or null if nothing seen.
function pickRemoteSource(creep) {
  const memAssign = ensureAssignmentsMem();
  const homeName = getHomeName(creep);
  const anchor = getAnchorPos(homeName);
  // limit search to nearby rooms (your “right/bottom first” expectation)
  const neighborRooms = bfsNeighborRooms(homeName, REMOTE_RADIUS);
  const candidates = [];
  for (const rn of neighborRooms) {
    const room = Game.rooms[rn];
    if (!room) continue; // need vision to see real sources
    const sources = room.find(FIND_SOURCES);
    for (const s of sources) {
      const occ = memAssign[s.id] || 0;
      if (occ > 0) continue; // already occupied by a remote miner
      const cost = pfCost(anchor, s.pos);
      if (cost === Infinity) continue;
      candidates.push({
        id: s.id,
        roomName: rn,
        cost,
        lin: Game.map.getRoomLinearDistance(homeName, rn)
      });
    }
  }
  if (!candidates.length) return null;
  // Sort by: path cost → linear distance → stable tiebreak (id)
  candidates.sort((a, b) =>
    (a.cost - b.cost) ||
    (a.lin - b.lin) ||
    (a.id < b.id ? -1 : 1)
  );
  const best = candidates[0];
  // Mark this source as "occupied" so other foragers don't dogpile.
  memAssign[best.id] = (memAssign[best.id] || 0) + 1;
  console.log(`🧭 ${creep.name} pick src=${best.id.slice(-6)} room=${best.roomName} cost=${best.cost}`);
  return best;
}
// ----------------------------
// releaseAssignment(creep)
// ----------------------------
// Decrement occupancy counter for the assigned source (if any)
// and wipe the creep's assignment fields.
// Call this when the creep dies soon, or when the source truly vanished
// *while the creep is in the target room with vision*.
function releaseAssignment(creep) {
  const memAssign = ensureAssignmentsMem();
  const sid = creep.memory.sourceId;
  if (sid && memAssign[sid]) {
    memAssign[sid] = Math.max(0, memAssign[sid] - 1);
  }
  creep.memory.sourceId = null;
  creep.memory.targetRoom = null;
  creep.memory.assigned = false;
}
// ============================
// Main Role: TaskRemoteHarvest
// ============================
const TaskRemoteHarvest = {
    run: function (creep) {
    // --- Assignment bootstrap ---
    // Ensure the creep has a "home" memo (one-time init).
    // === ensure assignment ===
    if (!creep.memory.home) getHomeName(creep); // set once
    // If we're about to expire, free our source assignment so a new
    // forager can take this slot ASAP.
    // release gracefully near end-of-life so a new creep can take over
    if (creep.ticksToLive !== undefined && creep.ticksToLive < 5 && creep.memory.assigned) {
    releaseAssignment(creep);
    }
    // If we don't yet have a source, try to pick a new one using the
    // PathFinder-cost-based picker above. If nothing is visible, idle at
    // the home anchor so scouts/vision can make candidates appear.
    if (!creep.memory.sourceId) {
        const pick = pickRemoteSource(creep);
            if (pick) {
                creep.memory.sourceId = pick.id;
                creep.memory.targetRoom = pick.roomName;
                creep.memory.assigned = true;
            } else {
                    // Nothing visible/available; idle at home anchor and try again next tick
                    const anchor = getAnchorPos(getHomeName(creep));
                    go(creep, anchor, { range: 2 });
                    return;
            }
        }
    // --- State machine: RETURNING vs HARVESTING ---
    // First, compute whether we should be going home (full) or harvesting (not full).
    TaskRemoteHarvest.updateReturnState(creep);
    // If we're full, prioritize returning immediately; don't "rally" back to target.
    // If we're full, head home NOW (do NOT rally to targetRoom)
    if (creep.memory.returning) {
    TaskRemoteHarvest.returnToStorage(creep);
    return;
    }
    // If we're not returning: if we're not in target room yet, rally to its center.
    // This avoids border wobble; (25,25,targetRoom) reliably crosses exits.
    // Only rally to targetRoom while harvesting
    if (creep.memory.targetRoom && creep.pos.roomName !== creep.memory.targetRoom) {
    go(creep, new RoomPosition(25, 25, creep.memory.targetRoom), { range: 20 });
    return;
    }
    // --- Redundant assignment fallback (legacy path) ---
    // If something wiped target/source in memory, try to assign again with
    // the legacy initialize method (uses Memory.rooms sources list).
    // Try to assign if memory is missing
    if (!creep.memory.targetRoom || !creep.memory.sourceId) {
    TaskRemoteHarvest.initializeAndAssign(creep);
    // If it still fails, return early to avoid crashy-crash
    if (!creep.memory.targetRoom || !creep.memory.sourceId) {
        console.log(`🚫 Forager ${creep.name} could not be assigned a room/source.`);
        return;
        }
    }
    // If we can see the target room, ensure BeeToolbox maintains its sources list.
    // Log sources only if we have vision
    const targetRoomObj = Game.rooms[creep.memory.targetRoom];
    if (targetRoomObj) {
    BeeToolbox.logSourcesInRoom(targetRoomObj);   
    }
    // Optional: skip rooms flagged hostile in Memory (external intel).
    // Note: this can strand the creep if intel is stale; consider adding a TTL.
    // Check if room is hostile
    if (
    Memory.rooms[creep.memory.targetRoom] &&
    Memory.rooms[creep.memory.targetRoom].hostile
    ) {
    console.log(`⚠️ Forager ${creep.name} avoiding hostile room ${creep.memory.targetRoom}`);
    creep.memory.targetRoom = null;
    creep.memory.sourceId = null;
    return;
    }
    // If we still don't have a known sources map for that room, bail this tick
    // (likely no vision yet). The earlier rally will carry us there soon.
    const roomMemory = Memory.rooms[creep.memory.targetRoom];
    if (!roomMemory || !roomMemory.sources) {
    console.log(`❌ Forager ${creep.name} still can't get source info for ${creep.memory.targetRoom}`);
    return;
    }
    // --- Do the work ---
    // We're in (or arriving at) the target room and not returning → harvest!
    TaskRemoteHarvest.harvestSource(creep);
    // IMPORTANT: don't "releaseAssignment" just because Game.getObjectById()
    // returns null while at home (no vision). Only check validity *in-room*:
    if (creep.memory.targetRoom && creep.pos.roomName === creep.memory.targetRoom) {
        const src = Game.getObjectById(creep.memory.sourceId); // now we have vision
        if (!src) {
            // The source truly doesn't exist (shouldn't happen) → free the slot.
            releaseAssignment(creep); // truly invalid source, free the slot
            return;
            }
        }
    },
    // ----------------------------
    // initializeAndAssign(creep)
    // ----------------------------
    // Legacy, Memory-based assignment: pick the nearest room (linear distance)
    // that has sources and the fewest foragers per source; pick a source in it.
    // This serves as fallback when pickRemoteSource() can't see candidates yet.
    initializeAndAssign: function (creep) {
        const targetRooms = TaskRemoteHarvest.getNearbyRoomsWithSources(creep.room.name);
       //Find least assigned room + assign a fresh source    
        if (!creep.memory.targetRoom || !creep.memory.sourceId) {
            const leastAssignedRoom = TaskRemoteHarvest.findRoomWithLeastForagers(targetRooms);
            if (!leastAssignedRoom) {
                console.log(`🚫 Forager ${creep.name} found no suitable room with unclaimed sources.`);
                return;
            }
            creep.memory.targetRoom = leastAssignedRoom;
            const roomMemory = Memory.rooms[creep.memory.targetRoom];
            const assignedSource = TaskRemoteHarvest.assignSource(creep, roomMemory);
            if (assignedSource) {
                creep.memory.sourceId = assignedSource;
                console.log(`Forager ${creep.name} assigned to source: ${assignedSource} in room: ${creep.memory.targetRoom}`);
            } else {
                console.log(`No available sources for creep: ${creep.name}`);
                creep.memory.targetRoom = null;
                creep.memory.sourceId = null;
            }
        }
    },
    // ----------------------------
    // getNearbyRoomsWithSources(origin)
    // ----------------------------
    // From Memory.rooms (populated by scouts/tools), pick rooms that:
    // - have a `sources` map,
    // - are not flagged hostile,
    // - are not the firstSpawnRoom (to avoid "home" unless you want it),
    // sorted by linear room distance from `origin`.
    getNearbyRoomsWithSources: function (origin) {
    const allRooms = Object.keys(Memory.rooms).filter(roomName => {
        const roomMem = Memory.rooms[roomName];
        return roomMem.sources && !roomMem.hostile && roomName !== Memory.firstSpawnRoom;
    });
        return allRooms.sort((a, b) =>
            Game.map.getRoomLinearDistance(origin, a) -
            Game.map.getRoomLinearDistance(origin, b)
        );
    },    
    // ----------------------------
    // findRoomWithLeastForagers(targetRooms)
    // ----------------------------
    // Among candidate rooms, choose the one with the *lowest average*
    // foragers per source. This spreads foragers out more evenly.
    findRoomWithLeastForagers: function (targetRooms) {
        let bestRoom = null;
        let lowestAvgForagers = Infinity;

        targetRooms.forEach(roomName => {
            const roomMemory = Memory.rooms[roomName] || {};
            const sources = roomMemory.sources ? Object.keys(roomMemory.sources) : [];
            if (sources.length === 0) return;

            const foragersInRoom = _.filter(Game.creeps, creep =>
                creep.memory.task === 'remoteharvest' &&
                creep.memory.targetRoom === roomName
            ).length;

            const avgForagers = foragersInRoom / sources.length;

            if (avgForagers < lowestAvgForagers) {
                lowestAvgForagers = avgForagers;
                bestRoom = roomName;
            }
        });

        return bestRoom;
    },
    // ----------------------------
    // assignSource(creep, roomMemory)
    // ----------------------------
    // Given a room's `sources` map in Memory, assign the creep to the
    // *least-occupied* source (tiered), breaking ties randomly to spread load.
    assignSource: function (creep, roomMemory) {
        const sources = Object.keys(roomMemory.sources);
        if (sources.length === 0) return null; // No sources found
        // Count how many foragers are currently assigned to each source
        // Step 1: Find how many Foragers are on each source
        const sourceCounts = {};
        let maxCount = 0;
        for (const sourceId of sources) {
            const count = _.filter(Game.creeps, c =>
                c.memory.task === 'remoteharvest' &&
                c.memory.targetRoom === creep.memory.targetRoom &&
                c.memory.sourceId === sourceId
            ).length;
            sourceCounts[sourceId] = count;
            if (count > maxCount) maxCount = count;
        }
        // Walk "tiers" from the least-occupied up; pick randomly within a tier.
        // Step 2: Try to assign to the least-occupied sources
        for (let tier = 0; tier <= maxCount + 1; tier++) { // Go up to max + 1 to allow new tiers
            const candidates = sources.filter(sourceId => sourceCounts[sourceId] === tier);
            if (candidates.length > 0) {
                const chosen = _.sample(candidates); // Pick a random one for balance
                console.log(`🐝 ${creep.name} assigned to source ${chosen} in room ${creep.memory.targetRoom} (tier ${tier})`);
                return chosen;
            }
        }
        // If no candidates found (shouldn't happen), return null
        return null;// Shouldn't happen
    },
    // ----------------------------
    // updateReturnState(creep)
    // ----------------------------
    // Two-state brain:
    // - returning = true  when energy store is full,
    // - returning = false when energy store is empty.
    // We flip *only* at 0% / 100% to avoid thrashing in mid-fill.
    updateReturnState: function (creep) {
        if (!creep.memory.returning && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
            creep.memory.returning = true;
        }
        if (creep.memory.returning && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
            creep.memory.returning = false;
        }
    },
    // ----------------------------
    // findUnclaimedSource(targetRooms)
    // ----------------------------
    // (Legacy helper) Scan rooms for a source whose assigned-creeps array is
    // empty in Memory.rooms[...] (if you're storing room->source->creeps lists).
    // Not used by the PathFinder-based picker, but kept for compatibility.    
    findUnclaimedSource: function (targetRooms) {
        for (const roomName of targetRooms) {
            const mem = Memory.rooms[roomName];
            if (!mem || !mem.sources) continue;

            for (const sourceId of Object.keys(mem.sources)) {
                const assignedCreeps = mem.sources[sourceId];
                if (!Array.isArray(assignedCreeps) || assignedCreeps.length === 0) {
                    return { roomName, sourceId };
                }
            }
        }
        return null;
    },    
    // ----------------------------
    // returnToStorage(creep)
    // ----------------------------
    // While returning=true, bring energy back to home.
    // - If not in home, head to the home anchor (storage/spawn/controller/center).
    // - Once in home, dump to the closest structure with free energy capacity.
    // If nothing can receive energy (rare), you might add a small idle rule.
    returnToStorage: function (creep) {
        const homeRoom = Memory.firstSpawnRoom; // (Consider switching to getHomeName(creep) for consistency.)
        if (creep.room.name !== homeRoom) {
            creep.moveTo(new RoomPosition(25, 25, homeRoom),
            {reusePath: 10, visualizePathStyle:{opacity: .8 ,stroke: '#87ceeb',lineStyle: 'dashed'}}
            );
            return;
        }
        // Prefer extensions/spawn/storage that can accept energy.
        const targets = creep.room.find(FIND_STRUCTURES, {
            filter: structure => (structure.structureType === STRUCTURE_EXTENSION ||
                                  structure.structureType === STRUCTURE_SPAWN ||
                                  structure.structureType === STRUCTURE_STORAGE) &&
                                  structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
        });
        if (targets.length > 0) {
            const closestTarget = creep.pos.findClosestByPath(targets);
            if (creep.transfer(closestTarget, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                //creep.moveTo(closestTarget);
                BeeToolbox.BeeTravel(creep, closestTarget);
            }
        } else {
            // Fallback to builder role or idle behavior
            //add a task for idle stuff?
            // TODO: Optional: add fallback behavior (e.g., wait near anchor)
            // or dump to container/link if your base uses them as sinks.
        }
    },
    // ----------------------------
    // harvestSource(creep)
    // ----------------------------
    // Main harvesting behavior:
    // - Verify we have a target room/source ID.
    // - If not in the target room yet, rally to its center (clean border-crossing).
    // - Once in-room, remember path length for "entrySteps" (optional room stats).
    // - Harvest the source; move towards it if not in range.
   harvestSource: function (creep) {
    if (!creep.memory.targetRoom || !creep.memory.sourceId) {
        console.log(`Forager ${creep.name} does not have a valid targetRoom or sourceId`);
        return;
    }
    // If we’re not in the correct room yet, step through borders reliably
    // by aiming at its center. BeeToolbox handles smart pathing visuals.
    if (creep.room.name !== creep.memory.targetRoom) {
        BeeToolbox.logSourceContainersInRoom(creep.room);
        creep.moveTo(new RoomPosition(25, 25, creep.memory.targetRoom), {reusePath: 10, visualizePathStyle:{opacity: .8 ,stroke: '#87ceeb',lineStyle: 'dashed'}});
        return;
    }
    // ----- Optional: record "entrySteps" (path cost inside the room) -----    
    const rm = Memory.rooms[creep.memory.targetRoom];
    rm.sources = rm.sources || {};
    const sid = creep.memory.sourceId;
    const src = Game.getObjectById(sid);
    // If we can see the source and haven't recorded entrySteps yet, do a quick PF search
    // from our current pos to range 1 of the source and store the path length.
    if (src && rm.sources[sid] && rm.sources[sid].entrySteps == null) {
    const res = PathFinder.search(
        creep.pos,
        { pos: src.pos, range: 1 },
        { plainCost: 2, swampCost: 10, maxOps: 4000 }
    );
    rm.sources[sid].entrySteps = res.path.length;
    }
    // --------------------------------------------------------------------
    const source = Game.getObjectById(creep.memory.sourceId);
    if (!source) {
        console.log(`Source not found for creep: ${creep.name}`);
        return;
    }
    // Core action: harvest the source; if out of range, move closer.
    // Just harvest the source, that's it!
    if (creep.harvest(source) === ERR_NOT_IN_RANGE) {
        BeeToolbox.BeeTravel(creep, source);
        // creep.moveTo(source); // fallback if you prefer vanilla movement
        //creep.moveTo(source);
    }
  }
};
module.exports = TaskRemoteHarvest;
