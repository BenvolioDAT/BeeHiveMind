// BeeMaintenance.js
// Handles memory cleanup and repair target tracking for your bee empire
const BeeMaintenance = {

    // Cleans up memory of rooms that have been inactive (not visible) for a long time
    cleanStaleRooms: function () {
        const activeRooms = Object.keys(Game.rooms); // Get all active rooms from Game object
        Memory.recentlyCleanedRooms = []; // Temporary list to track cleaned rooms for reporting

        for (const room in Memory.rooms) { // Loop through all rooms in memory
            const mem = Memory.rooms[room]; // Get memory for this room
            if (!activeRooms.includes(room) && // If room is not currently active (no vision)
                mem.lastVisited && // ...and has a lastVisited timestamp
                Game.time - mem.lastVisited > 1000) { // ...and it's been over 1000 ticks since last visit (~17 mins)
                
                delete Memory.rooms[room]; // Remove the room memory entirely
                Memory.recentlyCleanedRooms.push(room); // Add to cleaned list
                console.log(`🧼 Cleaned up stale memory for room: ${room}`); // Log the cleanup
            }
        }
    },

    // Cleans up creep memory, resource assignments, and container memory
    cleanUpMemory: function () {
        // Remove memory of dead creeps
        for (const name in Memory.creeps) {
            if (!Game.creeps[name]) { // If creep is no longer in game
                delete Memory.creeps[name]; // Remove from memory
                console.log(`🧼 Removed memory for non-existent creep: ${name}`);
            }
        }

        // Loop through each room's memory
        for (const roomName in Memory.rooms) {
            const roomMemory = Memory.rooms[roomName];

            // 🧹 Clean up Nurse_Bee source claims
            if (roomMemory.sources) {
                for (const sourceId in roomMemory.sources) {
                    const assignedCreeps = roomMemory.sources[sourceId]; // List of creep IDs assigned to the source
                    if (!Array.isArray(assignedCreeps)) continue; // Skip if not an array

                    // Filter out dead or invalid creeps
                    roomMemory.sources[sourceId] = assignedCreeps.filter(creepId => {
                        const creep = Game.getObjectById(creepId);
                        return creep && (creep.memory.role === 'Forager_Bee' || 
                                        creep.memory.role === 'Nurse_Bee'); // assignments
                    });
                }
            }

            // 🧹 Clean up Courier_Bee container assignments
            if (roomMemory.sourceContainers) {
                for (const containerId in roomMemory.sourceContainers) {
                    const assigned = roomMemory.sourceContainers[containerId];
                    if (assigned && !Game.creeps[assigned]) { // If assigned creep is gone
                        delete roomMemory.sourceContainers[containerId]; // Remove assignment
                        console.log(`🧹 Unassigned container ${containerId} from Courier_Bee (creep gone)`);
                    }
                }
            }

            // 🧼 Clean up dead containers (containers that no longer exist in game)
            const containers = roomMemory.sourceContainers;
            if (containers) {
                for (const containerId in containers) {
                    if (!Game.getObjectById(containerId)) { // If the container no longer exists
                        delete containers[containerId]; // Remove from memory
                        console.log(`🧼 Removed memory of non-existent container ${containerId} from ${roomName}`);
                    }
                }
            }
        }
    },

    findStructuresNeedingRepair: function (room) {
    if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {}; // Ensure room memory exists

    const repairTargets = Memory.rooms[room.name].repairTargets || [];
    const MAX_RAMPART_HEALTH = 30000;
    const MAX_WALL_HEALTH = 30000;

    // Define repair priority (lower number = higher priority)
    const priorityOrder = {
        [STRUCTURE_CONTAINER]: 1,
        [STRUCTURE_ROAD]: 2,
        [STRUCTURE_RAMPART]: 3,
        [STRUCTURE_WALL]: 4,
        [STRUCTURE_STORAGE]: 5,
        [STRUCTURE_SPAWN]: 6,
        [STRUCTURE_EXTENSION]: 7,
        [STRUCTURE_TOWER]: 8,
        [STRUCTURE_LINK]: 9,
        [STRUCTURE_TERMINAL]: 10,
        [STRUCTURE_LAB]: 11,
        [STRUCTURE_OBSERVER]: 12
        // Add more if you like!
    };

    // Find structures that need repair
    const structuresToRepair = room.find(FIND_STRUCTURES, {
        filter: (structure) => {
            if (structure.structureType === STRUCTURE_RAMPART)
                return structure.hits < Math.min(structure.hitsMax, MAX_RAMPART_HEALTH);
            if (structure.structureType === STRUCTURE_WALL)
                return structure.hits < Math.min(structure.hitsMax, MAX_WALL_HEALTH);
            return structure.hits < structure.hitsMax;
        }
    });

    // Update or add targets to the memory list
    structuresToRepair.forEach(structure => {
        const existing = repairTargets.find(t => t.id === structure.id);
        if (existing) {
            existing.hits = structure.hits;
        } else {
            repairTargets.push({
                id: structure.id,
                hits: structure.hits,
                hitsMax: structure.hitsMax,
                type: structure.structureType
            });
        }
    });

    // Filter out structures that no longer need repairs
    Memory.rooms[room.name].repairTargets = repairTargets.filter(t => {
        const structure = Game.getObjectById(t.id);
        if (!structure) return false;
        if ([STRUCTURE_WALL, STRUCTURE_RAMPART].includes(structure.structureType)) {
            const max = structure.structureType === STRUCTURE_WALL ? MAX_WALL_HEALTH : MAX_RAMPART_HEALTH;
            return structure.hits < Math.min(structure.hitsMax, max);
        }
        return structure.hits < structure.hitsMax;
    });

    // Sort the memory targets by priority and damage
    Memory.rooms[room.name].repairTargets.sort((a, b) => {
        const aPriority = priorityOrder[a.type] || 99; // Unknown types go last
        const bPriority = priorityOrder[b.type] || 99;
        if (aPriority !== bPriority) {
            return aPriority - bPriority;
        }
        return a.hits - b.hits; // Within same type, repair most damaged first
    });

    return Memory.rooms[room.name].repairTargets;
}

};

module.exports = BeeMaintenance; // Export the module for use in main.js
