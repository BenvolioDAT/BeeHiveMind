var BeeToolbox = require('BeeToolbox');
const TaskRemoteHarvest = {
    run: function (creep) {
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
        TaskRemoteHarvest.updateReturnState(creep);
        if (!creep.memory.returning) {
        TaskRemoteHarvest.harvestSource(creep);
        } else {
        TaskRemoteHarvest.returnToStorage(creep);
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
