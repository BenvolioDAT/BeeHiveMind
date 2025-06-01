var BeeToolbox = require('BeeToolbox');
const LOG_LEVEL = {NONE: 0,BASIC: 1,DEBUG: 2};
const currentLogLevel = LOG_LEVEL.NONE;  // Adjust to LOG_LEVEL.DEBUG for more detailed logs
const TaskBaseHarvest = {
    run: function(creep) { 
          // Handle harvesting logic
          if (!creep.memory.harvesting && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
            creep.memory.harvesting = true;
          }
          if (creep.memory.harvesting && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
            creep.memory.harvesting = false;
          }
          if (creep.memory.harvesting) {
            // If the Nurse_Bee is in harvesting state
            const assignedSourceId = assignSource(creep);
            const targetSource = Game.getObjectById(assignedSourceId);
            if (targetSource) {
              // Check if a container is adjacent to the source
              const container = getAdjacentContainer(targetSource);
              if (container) {
                // If a container exists, move onto it if not already on it
                if (!creep.pos.isEqualTo(container.pos)) {
                  BeeToolbox.BeeTravel(creep, container,0);
                  //creep.moveTo(container, { reusePath: 10 });
                } else {
                  // Harvest from the source while standing on the container
                  creep.harvest(targetSource);
                }
              } else {
                // If no container exists, attempt to build one
                BeeToolbox.ensureContainerNearSource(creep, targetSource);
                if (creep.harvest(targetSource) === ERR_NOT_IN_RANGE) {
                  BeeToolbox.BeeTravel(creep, targetSource);
                  //creep.moveTo(targetSource, { reusePath: 10 });
                }
              }          
            }          
          } else {
            // Check if the creep is near a container and transfer energy if possible
            if (hasAdjacentContainer(creep.pos) && creep.store.getFreeCapacity() === 0) {
              const adjacentContainer = creep.pos.findClosestByPath(FIND_STRUCTURES, {
                filter: (structure) =>
                  structure.structureType === STRUCTURE_CONTAINER &&
                  structure.pos.isNearTo(creep.pos),
              });
              if (adjacentContainer && creep.transfer(adjacentContainer, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                BeeToolbox.BeeTravel(creep, adjacentContainer);
                //creep.moveTo(adjacentContainer, { reusePath: 10 });
                return;
              }
            }
            // Drop energy if no Couriers are available
            const Courier_Bees = _.filter(Game.creeps, (creep) => creep.memory.role === 'Courier_Bee');
            if (Courier_Bees.length > 0) {
              creep.drop(RESOURCE_ENERGY);
              return;
            }
            // Find the closest structure to transfer energy to (spawn, extension, or storage)
            const targetStructure = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
              filter: (structure) =>
                (structure.structureType === STRUCTURE_SPAWN ||
                  structure.structureType === STRUCTURE_EXTENSION ||
                  structure.structureType === STRUCTURE_STORAGE) &&
                structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0,
            });
            if (!targetStructure) {
              return;
            }
            // Transfer energy to the target structure
            if (creep.transfer(targetStructure, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
              BeeToolbox.BeeTravel(creep, targetStructure);
              //creep.moveTo(targetStructure, { reusePath: 10 });
            }
          }
        }
    };

    
// Utility function to check if there's a container adjacent to the given position
const hasAdjacentContainer = function (pos) {
  const room = Game.rooms[pos.roomName];
  // Iterate over adjacent positions
  for (let xOffset = -1; xOffset <= 1; xOffset++) {
    for (let yOffset = -1; yOffset <= 1; yOffset++) {
      if (xOffset === 0 && yOffset === 0) continue; // Skip the current position
      const x = pos.x + xOffset;
      const y = pos.y + yOffset;
      // Check for a container structure at the adjacent position
      const structures = room.lookForAt(LOOK_STRUCTURES, x, y);
      for (const structure of structures) {
        if (structure.structureType === STRUCTURE_CONTAINER) {
          return true;
        }
      }
    }
  }
  return false;
};

function getAdjacentContainer(source) {  
    const containers = source.pos.findInRange(FIND_STRUCTURES, 1, {
      filter: (structure) => structure.structureType === STRUCTURE_CONTAINER,
    });
    return containers.length > 0 ? containers[0] : null;  
}
function assignSource(creep) {
    // Check if creep is spawning before proceeding
    if (creep.spawning) {
      return; // Exit the function if the creep is still spawning
    }
    // Access the memory object for the room the creep is in
    const roomMemory = creep.room.memory;
    // Check if the 'sources' object exists in roomMemory, if not, initialize it as an empty object
    if (!roomMemory.sources) {
      roomMemory.sources = {};
    }
    // If the creep already has an assigned source, return that source ID immediately
    if (creep.memory.assignedSource) {
      if (currentLogLevel >= LOG_LEVEL.DEBUG) {
      console.log(`Creep ${creep.name} already has assigned source: ${creep.memory.assignedSource}`);
      }
      return creep.memory.assignedSource; // Return the previously assigned source
    }
    // Find all energy sources in the room and store them in the 'sources' array
    const sources = creep.room.find(FIND_SOURCES);
    // Iterate over each source found in the room
    sources.forEach((source) => {
      // Initialize an empty array in roomMemory for the source if it doesn't already exist
      if (!roomMemory.sources[source.id]) {
        roomMemory.sources[source.id] = [];
      }
      // Log the current count of Nurse_Bees assigned to this source for debugging
      if (currentLogLevel >= LOG_LEVEL.DEBUG) {
      console.log(`Source ${source.id} has ${roomMemory.sources[source.id].length} assigned Nurse_Bee(s)`);
      }
    });
    // Sort the sources based on the number of assigned creeps, from the least to the most
    const sortedSources = sources.sort((a, b) => {  
      // Get the count of assigned creeps for source 'a' (default to 0 if undefined)
      const creepCountA = roomMemory.sources[a.id] ? roomMemory.sources[a.id].length : 0;
      // Get the count of assigned creeps for source 'b' (default to 0 if undefined)
      const creepCountB = roomMemory.sources[b.id] ? roomMemory.sources[b.id].length : 0;
      return creepCountA - creepCountB; // Sort in ascending order
    });
    // Assign the creep to the source with the fewest assigned creeps (the first element in sortedSources)
    const assignedSource = sortedSources[0];    
    // If no valid source is found (this should be rare), log an error and exit
    if (!assignedSource) {
      if (currentLogLevel >= LOG_LEVEL.DEBUG) {
      console.log(`No valid source found for creep ${creep.name}.`);
      }
      return; // Exit the function without assigning a source
    }
    // Set the assigned source's ID in the creep's memory
    creep.memory.assignedSource = assignedSource.id;
    // Check if the creep has a valid unique ID
    if (creep.id) {
      // Ensure the array for this source exists in roomMemory (should be initialized earlier but a double-check)
      if (!roomMemory.sources[assignedSource.id]) {
        roomMemory.sources[assignedSource.id] = []; // Create the array if it doesn't exist
      }
      // Add this creep's ID to the array of assigned creeps for this source
      roomMemory.sources[assignedSource.id].push(creep.id);
      if (currentLogLevel >= LOG_LEVEL.DEBUG) {
      console.log(`Nurse_Bee ${creep.name} assigned to source ${assignedSource.id}. Creep ID ${creep.id} added.`);
      }
    } else {
      // Log a message if the creep doesn't have a valid ID (which may indicate an issue)
      if (currentLogLevel >= LOG_LEVEL.DEBUG) {
      console.log(`Creep ${creep.name} has an invalid ID.`);
      }
    }
    // Log the updated memory structure for sources in this room, for debugging
    if (currentLogLevel >= LOG_LEVEL.DEBUG) {
    console.log(`Updated sources for room ${creep.room.name}:`, JSON.stringify(roomMemory.sources, null, 2));
    }
    return assignedSource.id; // Return the ID of the assigned source
}

module.exports = TaskBaseHarvest;