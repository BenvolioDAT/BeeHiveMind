var BeeToolbox = require('BeeToolbox');
// ==== RemoteHarvester Assignment Helpers (local to this file) ====

// Configs
const REMOTE_RADIUS = 1;   // Search only rooms 1 hop away. Set 2+ if you want farther.
const MAX_PF_OPS   = 4000; // PathFinder budget for picking targets

function go(creep, dest, opts = {}) {
  if (typeof BeeToolbox !== 'undefined' && BeeToolbox.BeeTravel) {
    BeeToolbox.BeeTravel(creep, dest, opts);
  } else {
    const range = opts.range != null ? opts.range : 1;
    creep.moveTo(dest, { reusePath: 20, range });
  }
}

function ensureAssignmentsMem() {
  if (!Memory.remoteAssignments) Memory.remoteAssignments = {};
  return Memory.remoteAssignments;
}

function getHomeName(creep) {
  if (creep.memory.home) return creep.memory.home;
  const spawns = Object.values(Game.spawns);
  if (spawns.length) {
    // nearest owned spawn by room distance
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

function getAnchorPos(homeName) {
  const r = Game.rooms[homeName];
  if (r) {
    if (r.storage) return r.storage.pos;
    const spawns = r.find(FIND_MY_SPAWNS);
    if (spawns.length) return spawns[0].pos;
    if (r.controller && r.controller.my) return r.controller.pos;
  }
  // No vision? Head for center; moveTo will path cross-room.
  return new RoomPosition(25, 25, homeName);
}

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
  seen.delete(startName);
  return [...seen];
}

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
        room.find(FIND_CONSTRUCTION_SITES).forEach(cs => {
          if (cs.structureType !== STRUCTURE_ROAD) costs.set(cs.pos.x, cs.pos.y, 0xff);
        });
        return costs;
      }
    }
  );
  return ret.incomplete ? Infinity : ret.cost;
}

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
  // Mark occupancy
  memAssign[best.id] = (memAssign[best.id] || 0) + 1;

  console.log(`🧭 ${creep.name} pick src=${best.id.slice(-6)} room=${best.roomName} cost=${best.cost}`);
  return best;
}

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



const TaskRemoteHarvest = {
    run: function (creep) {
        // === ensure assignment ===
        if (!creep.memory.home) getHomeName(creep); // set once

        // release gracefully near end-of-life so a new creep can take over
        if (creep.ticksToLive !== undefined && creep.ticksToLive < 5 && creep.memory.assigned) {
        releaseAssignment(creep);
        }

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

        // Navigate toward the assigned room if not there yet (simple rally)
        /*if (creep.memory.targetRoom && creep.pos.roomName !== creep.memory.targetRoom) {
        go(creep, new RoomPosition(25, 25, creep.memory.targetRoom), { range: 20 });
        return;
        }*/
       // Check full/empty first
        TaskRemoteHarvest.updateReturnState(creep);

        // If we're full, head home NOW (do NOT rally to targetRoom)
        if (creep.memory.returning) {
        TaskRemoteHarvest.returnToStorage(creep);
        return;
        }

        // Only rally to targetRoom while harvesting
        if (creep.memory.targetRoom && creep.pos.roomName !== creep.memory.targetRoom) {
        go(creep, new RoomPosition(25, 25, creep.memory.targetRoom), { range: 20 });
        return;
        }   

        // Try to assign if memory is missing
        if (!creep.memory.targetRoom || !creep.memory.sourceId) {
        TaskRemoteHarvest.initializeAndAssign(creep);
        // If it still fails, return early to avoid crashy-crash
        if (!creep.memory.targetRoom || !creep.memory.sourceId) {
            console.log(`🚫 Forager ${creep.name} could not be assigned a room/source.`);
            return;
            }
        }
        // Log sources only if we have vision
        const targetRoomObj = Game.rooms[creep.memory.targetRoom];
        if (targetRoomObj) {
        BeeToolbox.logSourcesInRoom(targetRoomObj);   
        }
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
        const roomMemory = Memory.rooms[creep.memory.targetRoom];
        if (!roomMemory || !roomMemory.sources) {
        console.log(`❌ Forager ${creep.name} still can't get source info for ${creep.memory.targetRoom}`);
        return;
        }
        
        // All good, now go on with your bee business
        /*TaskRemoteHarvest.updateReturnState(creep);
        if (!creep.memory.returning) {
        TaskRemoteHarvest.harvestSource(creep);
        } else {
        TaskRemoteHarvest.returnToStorage(creep);
        }*/
       TaskRemoteHarvest.harvestSource(creep);



        const src = Game.getObjectById(creep.memory.sourceId);
        if (!src) {
        releaseAssignment(creep);
        return; // we’ll pick a new one next tick
        }
    },
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

    assignSource: function (creep, roomMemory) {
        const sources = Object.keys(roomMemory.sources);
        if (sources.length === 0) return null; // No sources found

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
        return null;
    },

    updateReturnState: function (creep) {
        if (!creep.memory.returning && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
            creep.memory.returning = true;
        }
        if (creep.memory.returning && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
            creep.memory.returning = false;
        }
    },
    
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

    returnToStorage: function (creep) {
        const homeRoom = Memory.firstSpawnRoom;
        if (creep.room.name !== homeRoom) {
            creep.moveTo(new RoomPosition(25, 25, homeRoom),{reusePath: 10, visualizePathStyle:{opacity: .8 ,stroke: '#87ceeb',lineStyle: 'dashed'}});
            return;
        }
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
        }
    },

   harvestSource: function (creep) {
    if (!creep.memory.targetRoom || !creep.memory.sourceId) {
        console.log(`Forager ${creep.name} does not have a valid targetRoom or sourceId`);
        return;
    }

    if (creep.room.name !== creep.memory.targetRoom) {
        BeeToolbox.logSourceContainersInRoom(creep.room);
        creep.moveTo(new RoomPosition(25, 25, creep.memory.targetRoom), {reusePath: 10, visualizePathStyle:{opacity: .8 ,stroke: '#87ceeb',lineStyle: 'dashed'}});
        return;
    }

    
//////////////////////////////////////////////
    const rm = Memory.rooms[creep.memory.targetRoom];
    rm.sources = rm.sources || {};
    const sid = creep.memory.sourceId;
    const src = Game.getObjectById(sid);

    if (src && rm.sources[sid] && rm.sources[sid].entrySteps == null) {
    const res = PathFinder.search(
        creep.pos,
        { pos: src.pos, range: 1 },
        { plainCost: 2, swampCost: 10, maxOps: 4000 }
    );
    rm.sources[sid].entrySteps = res.path.length;
    }
///////////////////////////////////////////////////////

    const source = Game.getObjectById(creep.memory.sourceId);
    if (!source) {
        console.log(`Source not found for creep: ${creep.name}`);
        return;
    }

    // Just harvest the source, that's it!
    if (creep.harvest(source) === ERR_NOT_IN_RANGE) {
        BeeToolbox.BeeTravel(creep, source);
        //creep.moveTo(source);
    }
}

};
module.exports = TaskRemoteHarvest;
