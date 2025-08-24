var BeeToolbox = require('BeeToolbox');
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
          // If the baseharvest is in harvesting state
          const assignedSourceId = assignSource(creep);
          const targetSource = Game.getObjectById(assignedSourceId);
          if (targetSource) {
            // Check if a container is adjacent to the source
            const container = getAdjacentContainer(targetSource);
            if (container) {
              // If a container exists, move onto it if not already on it
              if (!creep.pos.isEqualTo(container.pos)) {
                BeeToolbox.BeeTravel(creep, container,0);
              } else {
                // Harvest from the source while standing on the container
                creep.harvest(targetSource);
              }
            } else {
              // If no container exists, attempt to build one
              BeeToolbox.ensureContainerNearSource(creep, targetSource);
              if (creep.harvest(targetSource) === ERR_NOT_IN_RANGE) {
                BeeToolbox.BeeTravel(creep, targetSource);
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
              return;
            }
          }
          // Drop energy if no Couriers are available
          const Courier = _.filter(Game.creeps, (creep) => creep.memory.task === 'courier');
          if (Courier.length > 0) {
            creep.drop(RESOURCE_ENERGY);
            return;
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
    if (creep.spawning) return;
    // Already assigned? Just return it.
    if (creep.memory.assignedSource) {
        return creep.memory.assignedSource;
      }
    // Count living harvesters per source (using ONLY Game.creeps)
    const sources = creep.room.find(FIND_SOURCES);
    const counts = {};
    for (const source of sources) {
        counts[source.id] = _.filter(Game.creeps, c =>
            c.memory.task === 'baseharvest' &&
            c.memory.assignedSource === source.id &&
            c.room.name === creep.room.name // Only this room
        ).length;
      }
    // Pick the least-occupied source
    let min = Infinity, chosen = null;
    for (const source of sources) {
        if (counts[source.id] < min) {
            min = counts[source.id];
            chosen = source;
        }
      }
    if (chosen) {
        creep.memory.assignedSource = chosen.id;
        return chosen.id;
      }
    return null;
  }

module.exports = TaskBaseHarvest;