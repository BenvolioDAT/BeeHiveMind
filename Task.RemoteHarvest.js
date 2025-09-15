// TaskRemoteHarvest.clean.js
// Remote-harvester ("forager"): mines a remote source and hauls energy home.
// Same behavior as your original, but simplified for readability and with
// small fixes (noted below). No lodash required.

const BeeToolbox = require('BeeToolbox');

// ============================
// Tunables
// ============================
const REMOTE_RADIUS = 3;         // How many room hops from home to scan for targets
const MAX_PF_OPS = 4000;         // PathFinder ops budget for selection-time cost checks
const PLAIN_COST = 2;            // Base PF cost on plains
const SWAMP_COST = 10;           // Base PF cost on swamps

// ============================
// Small helpers
// ============================
function go(creep, dest, opts={}) {
  if (typeof BeeToolbox !== 'undefined' && BeeToolbox.BeeTravel) {
    BeeToolbox.BeeTravel(creep, dest, opts);
    return;
  }
  const desired = opts.range != null ? opts.range : 1;
  if (creep.pos.getRangeTo(dest) > desired) {
    creep.moveTo(dest, { reusePath: 15 });
  }
}

function ensureAssignmentsMem() {
  // Memory.remoteAssignments: { [sourceId]: numberAssigned }
  if (!Memory.remoteAssignments) Memory.remoteAssignments = {};
  return Memory.remoteAssignments;
}

function getHomeName(creep) {
  // 1) use memo if present
  if (creep.memory.home) return creep.memory.home;

  // 2) choose nearest owned spawn's room by linear distance
  const spawns = Object.values(Game.spawns);
  if (spawns.length) {
    let best = spawns[0];
    let bestD = Game.map.getRoomLinearDistance(creep.pos.roomName, best.pos.roomName);
    for (let i = 1; i < spawns.length; i++) {
      const s = spawns[i];
      const d = Game.map.getRoomLinearDistance(creep.pos.roomName, s.pos.roomName);
      if (d < bestD) { best = s; bestD = d; }
    }
    creep.memory.home = best.pos.roomName;
    return creep.memory.home;
  }

  // 3) fallback: current room
  creep.memory.home = creep.pos.roomName;
  return creep.memory.home;
}

function getAnchorPos(homeName) {
  // Prefer Storage → Spawn → Controller → center of room if no vision.
  const r = Game.rooms[homeName];
  if (r) {
    if (r.storage) return r.storage.pos;
    const spawns = r.find(FIND_MY_SPAWNS);
    if (spawns.length) return spawns[0].pos;
    if (r.controller && r.controller.my) return r.controller.pos;
  }
  return new RoomPosition(25, 25, homeName);
}

function bfsNeighborRooms(startName, radius = 1) {
  // Breadth-first search over the exits graph up to `radius` hops away.
  const seen = new Set([startName]);
  let frontier = [startName];

  for (let depth = 0; depth < radius; depth++) {
    const next = [];
    for (const rn of frontier) {
      const exits = Game.map.describeExits(rn) || {};
      for (const dir of Object.keys(exits)) {
        const n = exits[dir];
        if (!seen.has(n)) { seen.add(n); next.push(n); }
      }
    }
    frontier = next;
  }

  seen.delete(startName);
  return [...seen];
}

function pfCost(anchorPos, targetPos) {
  // Estimate true cross-room cost from anchor to target using PF.
  const ret = PathFinder.search(
    anchorPos,
    { pos: targetPos, range: 1 },
    {
      maxOps: MAX_PF_OPS,
      plainCost: PLAIN_COST,
      swampCost: SWAMP_COST,
      roomCallback: (roomName) => {
        const room = Game.rooms[roomName];
        if (!room) return; // default costs when no vision
        const matrix = new PathFinder.CostMatrix();

        room.find(FIND_STRUCTURES).forEach(s => {
          if (s.structureType === STRUCTURE_ROAD) {
            matrix.set(s.pos.x, s.pos.y, 1);
          } else if (
            s.structureType !== STRUCTURE_CONTAINER &&
            (s.structureType !== STRUCTURE_RAMPART || !s.my)
          ) {
            matrix.set(s.pos.x, s.pos.y, 0xff); // impassable
          }
        });

        room.find(FIND_CONSTRUCTION_SITES).forEach(cs => {
          if (cs.structureType !== STRUCTURE_ROAD) matrix.set(cs.pos.x, cs.pos.y, 0xff);
        });

        return matrix;
      }
    }
  );

  return ret.incomplete ? Infinity : ret.cost;
}

function pickRemoteSource(creep) {
  // Choose best remote source among visible neighbors within REMOTE_RADIUS.
  const memAssign = ensureAssignmentsMem();
  const homeName = getHomeName(creep);
  const anchor = getAnchorPos(homeName);

  const neighborRooms = bfsNeighborRooms(homeName, REMOTE_RADIUS);
  const candidates = [];

  for (const rn of neighborRooms) {
    const room = Game.rooms[rn];
    if (!room) continue; // need vision to see real sources

    const sources = room.find(FIND_SOURCES);
    for (const s of sources) {
      const occ = memAssign[s.id] || 0;
      if (occ > 0) continue; // don't dogpile

      const cost = pfCost(anchor, s.pos);
      if (cost === Infinity) continue;

      candidates.push({ id: s.id, roomName: rn, cost, lin: Game.map.getRoomLinearDistance(homeName, rn) });
    }
  }

  if (candidates.length === 0) return null;

  // Sort by PF cost → linear distance → stable tiebreak on id
  candidates.sort((a, b) => (a.cost - b.cost) || (a.lin - b.lin) || (a.id < b.id ? -1 : 1));

  const best = candidates[0];
  // Mark this source as occupied so another forager won't pick it.
  memAssign[best.id] = (memAssign[best.id] || 0) + 1; // FIX: increment on claim

  console.log(`🧭 ${creep.name} pick src=${best.id.slice(-6)} room=${best.roomName} cost=${best.cost}`);
  return best;
}

function releaseAssignment(creep) {
  // Free the assignment counter for this creep's source (if any).
  const memAssign = ensureAssignmentsMem();
  const sid = creep.memory.sourceId;
  if (sid && memAssign[sid]) memAssign[sid] = Math.max(0, memAssign[sid] - 1);
  creep.memory.sourceId = null;
  creep.memory.targetRoom = null;
  creep.memory.assigned = false;
}

// ============================
// Main role
// ============================
const TaskRemoteHarvest = {
  run(creep) {
    // Ensure home memo exists
    if (!creep.memory.home) getHomeName(creep);

    // Gracefully free slot near end-of-life
    if (creep.ticksToLive !== undefined && creep.ticksToLive < 5 && creep.memory.assigned) {
      releaseAssignment(creep);
    }

    // If no assignment yet, try the PF-based picker; else fallback to legacy
    if (!creep.memory.sourceId) {
      const pick = pickRemoteSource(creep);
      if (pick) {
        creep.memory.sourceId = pick.id;
        creep.memory.targetRoom = pick.roomName;
        creep.memory.assigned = true;
      } else {
        this.initializeAndAssign(creep);
        if (!creep.memory.sourceId) {
          // Nothing visible yet — idle at home anchor until scouts give vision
          const anchor = getAnchorPos(getHomeName(creep));
          go(creep, anchor, { range: 2 });
          return;
        }
      }
    }

    // State machine: returning (full) vs harvesting (not full)
    this.updateReturnState(creep);

    if (creep.memory.returning) {
      this.returnToStorage(creep);
      return;
    }

    // While harvesting: if outside target room, rally to (25,25,targetRoom) to cross borders cleanly
    if (creep.memory.targetRoom && creep.pos.roomName !== creep.memory.targetRoom) {
      go(creep, new RoomPosition(25, 25, creep.memory.targetRoom), { range: 20 });
      return;
    }

    // Fallback re-initialization if memory was wiped by something
    if (!creep.memory.targetRoom || !creep.memory.sourceId) {
      this.initializeAndAssign(creep);
      if (!creep.memory.targetRoom || !creep.memory.sourceId) {
        console.log(`🚫 Forager ${creep.name} could not be assigned a room/source.`);
        return;
      }
    }

    // If we can see target room, keep its sources data fresh
    const targetRoomObj = Game.rooms[creep.memory.targetRoom];
    if (targetRoomObj && BeeToolbox && BeeToolbox.logSourcesInRoom) {
      BeeToolbox.logSourcesInRoom(targetRoomObj);
    }

    // Optional: avoid rooms flagged hostile in Memory
    const tmem = Memory.rooms[creep.memory.targetRoom];
    if (tmem && tmem.hostile) {
      console.log(`⚠️ Forager ${creep.name} avoiding hostile room ${creep.memory.targetRoom}`);
      creep.memory.targetRoom = null;
      creep.memory.sourceId = null;
      return;
    }

    // If no sources map yet (likely no vision earlier), bail; rally above will carry us there
    if (!tmem || !tmem.sources) return;

    // Do the actual harvesting
    this.harvestSource(creep);

    // Only check source validity when *in-room* (vision available)
    if (creep.memory.targetRoom && creep.pos.roomName === creep.memory.targetRoom) {
      const srcObj = Game.getObjectById(creep.memory.sourceId);
      if (!srcObj) {
        releaseAssignment(creep);
        return;
      }
    }
  },

  // ------ Legacy / fallback assignment (Memory-based) ------
  initializeAndAssign(creep) {
    const targetRooms = this.getNearbyRoomsWithSources(creep.room.name);

    if (!creep.memory.targetRoom || !creep.memory.sourceId) {
      const leastAssignedRoom = this.findRoomWithLeastForagers(targetRooms);
      if (!leastAssignedRoom) {
        console.log(`🚫 Forager ${creep.name} found no suitable room with unclaimed sources.`);
        return;
      }

      creep.memory.targetRoom = leastAssignedRoom;
      const roomMemory = Memory.rooms[creep.memory.targetRoom];
      const assignedSource = this.assignSource(creep, roomMemory);

      if (assignedSource) {
        creep.memory.sourceId = assignedSource;
        creep.memory.assigned = true;
        // FIX: increment occupancy when we claim via legacy path as well
        const memAssign = ensureAssignmentsMem();
        memAssign[assignedSource] = (memAssign[assignedSource] || 0) + 1;
        console.log(`🐝 ${creep.name} assigned to source: ${assignedSource} in ${creep.memory.targetRoom}`);
      } else {
        console.log(`No available sources for creep: ${creep.name}`);
        creep.memory.targetRoom = null;
        creep.memory.sourceId = null;
      }
    }
  },

  getNearbyRoomsWithSources(origin) {
    // From Memory.rooms (populated by scouts/tools), pick rooms that:
    // - have a `sources` map,
    // - are not flagged hostile,
    // - are not Memory.firstSpawnRoom (keeps remotes truly remote),
    // sorted by linear distance from origin.
    const all = Object.keys(Memory.rooms || {});
    const filtered = all.filter(roomName => {
      const rm = Memory.rooms[roomName];
      return rm && rm.sources && !rm.hostile && roomName !== Memory.firstSpawnRoom;
    });

    return filtered.sort((a, b) =>
      Game.map.getRoomLinearDistance(origin, a) - Game.map.getRoomLinearDistance(origin, b)
    );
  },

  findRoomWithLeastForagers(targetRooms) {
    // Choose room with lowest average foragers per source.
    let bestRoom = null;
    let lowestAvg = Infinity;

    for (const roomName of targetRooms) {
      const rm = Memory.rooms[roomName] || {};
      const sources = rm.sources ? Object.keys(rm.sources) : [];
      if (sources.length === 0) continue;

      let foragersInRoom = 0;
      for (const name in Game.creeps) {
        const c = Game.creeps[name];
        if (c && c.memory && c.memory.task === 'remoteharvest' && c.memory.targetRoom === roomName) {
          foragersInRoom++;
        }
      }

      const avg = foragersInRoom / sources.length;
      if (avg < lowestAvg) { lowestAvg = avg; bestRoom = roomName; }
    }

    return bestRoom;
  },

  assignSource(creep, roomMemory) {
    // Pick least-occupied source (tiers); break ties randomly.
    if (!roomMemory || !roomMemory.sources) return null;
    const sources = Object.keys(roomMemory.sources);
    if (sources.length === 0) return null;

    // Count current foragers per source in this room
    const counts = {};
    let maxCount = 0;

    for (const sid of sources) {
      let cnt = 0;
      for (const name in Game.creeps) {
        const c = Game.creeps[name];
        if (
          c && c.memory && c.memory.task === 'remoteharvest' &&
          c.memory.targetRoom === creep.memory.targetRoom &&
          c.memory.sourceId === sid
        ) { cnt++; }
      }
      counts[sid] = cnt;
      if (cnt > maxCount) maxCount = cnt;
    }

    for (let tier = 0; tier <= maxCount + 1; tier++) {
      const candidates = sources.filter(sid => counts[sid] === tier);
      if (candidates.length) {
        const idx = Math.floor(Math.random() * candidates.length);
        return candidates[idx];
      }
    }

    return null;
  },

  updateReturnState(creep) {
    // Flip only at 0%/100% to avoid thrashing mid-fill.
    if (!creep.memory.returning && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
      creep.memory.returning = true;
    }
    if (creep.memory.returning && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
      creep.memory.returning = false;
    }
  },

  findUnclaimedSource(targetRooms) {
    // Legacy helper; scans Memory.rooms[...] for empty assigned lists (if you store them).
    for (const roomName of targetRooms) {
      const mem = Memory.rooms[roomName];
      if (!mem || !mem.sources) continue;
      for (const sid of Object.keys(mem.sources)) {
        const assigned = mem.sources[sid];
        if (!Array.isArray(assigned) || assigned.length === 0) return { roomName, sourceId: sid };
      }
    }
    return null;
  },

  returnToStorage(creep) {
    // While returning, bring energy back to home.
    const homeName = getHomeName(creep); // FIX: use same home logic for consistency

    if (creep.room.name !== homeName) {
      go(creep, new RoomPosition(25, 25, homeName), { range: 20 });
      return;
    }

    // Prefer extensions/spawn/storage with free capacity
    const targets = creep.room.find(FIND_STRUCTURES, {
      filter: s => (
        (s.structureType === STRUCTURE_EXTENSION ||
         s.structureType === STRUCTURE_SPAWN ||
         s.structureType === STRUCTURE_STORAGE) &&
        s.store && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
      )
    });

    if (targets.length) {
      const closest = creep.pos.findClosestByPath(targets);
      if (closest) {
        const rc = creep.transfer(closest, RESOURCE_ENERGY);
        if (rc === ERR_NOT_IN_RANGE) go(creep, closest);
      }
    } else {
      // Optional: idle near anchor or hand off to a different role/task
      const anchor = getAnchorPos(homeName);
      go(creep, anchor, { range: 2 });
    }
  },

  harvestSource(creep) {
    // Validate assignment
    if (!creep.memory.targetRoom || !creep.memory.sourceId) {
      console.log(`Forager ${creep.name} missing targetRoom/sourceId`);
      return;
    }

    // If not in the right room yet, rally through the center for clean border crossing
    if (creep.room.name !== creep.memory.targetRoom) {
      if (BeeToolbox && BeeToolbox.logSourceContainersInRoom) {
        BeeToolbox.logSourceContainersInRoom(creep.room);
      }
      go(creep, new RoomPosition(25, 25, creep.memory.targetRoom), { range: 20 });
      return;
    }

    // Optional: record entrySteps inside the room (one-time per source)
    const rm = Memory.rooms[creep.memory.targetRoom] = Memory.rooms[creep.memory.targetRoom] || {};
    rm.sources = rm.sources || {};
    const sid = creep.memory.sourceId;
    const src = Game.getObjectById(sid);

    if (src && rm.sources[sid] && rm.sources[sid].entrySteps == null) {
      const res = PathFinder.search(creep.pos, { pos: src.pos, range: 1 }, { plainCost: PLAIN_COST, swampCost: SWAMP_COST, maxOps: MAX_PF_OPS });
      rm.sources[sid].entrySteps = res.path.length;
    }

    if (!src) { console.log(`Source not found for ${creep.name}`); return; }

    // Harvest (move if needed)
    if (creep.harvest(src) === ERR_NOT_IN_RANGE) go(creep, src);
  }
};

module.exports = TaskRemoteHarvest;
