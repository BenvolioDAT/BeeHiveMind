var BeeToolbox = require('BeeToolbox'); // Import utility functions for bees

const TaskCourier = {
  // Main logic loop for the TaskCourier
  run: function (creep) {
     // Skip logic if creep is still spawning
    BeeToolbox.assignContainerFromMemory(creep); // Assign a nearby container to the courier if none assigned
    // Update transfer state based on energy storage
    if (creep.memory.transferring && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.transferring = false; // Switch to collecting if out of energy
    }                                            
    if (!creep.memory.transferring && creep.store[RESOURCE_ENERGY] > 0) {
      creep.memory.transferring = true; // Switch to transferring when full
    }
    // Run collect or deliver logic based on state
    if (creep.memory.transferring) {
      TaskCourier.deliverEnergy(creep);
    } else {
      TaskCourier.collectEnergy(creep);
    }
  },

  // 🐝 Energy collection logic: from containers, dropped energy, or fallback
  collectEnergy: function (creep) {
    // If no container assigned, attempt to assign one
    if (!creep.memory.assignedContainer) {
      const containers = creep.room.find(FIND_STRUCTURES, {filter: (s) => s.structureType === STRUCTURE_CONTAINER && s.pos.findInRange(FIND_SOURCES, 1).length > 0});

      if (containers.length > 0) {
        // Count how many Couriers are already assigned to each container
        const containerUsage = _.countBy(
          _.filter(Game.creeps, c => c.memory.task === 'courier' && c.memory.assignedContainer),
          c => c.memory.assignedContainer
        );
        // Sort containers by fewest Couriers assigned (balance load)
        containers.sort((a, b) =>
          (containerUsage[a.id] || 0) - (containerUsage[b.id] || 0)
        );

        // Assign the least-used container to this Courier
        creep.memory.assignedContainer = containers[0].id;
        console.log(`🐝 Courier ${creep.name} assigned to container ${containers[0].id}`);
      }
    }
    // If a container is assigned, interact with it
    if (creep.memory.assignedContainer) {
      const container = Game.getObjectById(creep.memory.assignedContainer);
      if (container) {
        // Look for dropped energy near the container (within 1 tile)
        const dropped = container.pos.findInRange(FIND_DROPPED_RESOURCES, 1, {
          filter: r => r.resourceType === RESOURCE_ENERGY
        });
        if (dropped.length > 0) {
          // Pick up the largest dropped energy pile
          const target = _.max(dropped, r => r.amount);
          if (creep.pickup(target) === ERR_NOT_IN_RANGE) {
            BeeToolbox.BeeTravel(creep, target);
            //creep.moveTo(target, {reusePath: 10, visualizePathStyle:{opacity: .8 ,stroke: '#00d4f5',lineStyle: 'dashed'}});
          }
          return; // Skip to next tick
        }
        // If no dropped energy, try withdrawing from the container itself
        if (container.store[RESOURCE_ENERGY] > 0) {
          if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
            BeeToolbox.BeeTravel(creep, container)
            //creep.moveTo(container, {reusePath: 10, visualizePathStyle:{opacity: .8 ,stroke: '#00d4f5',lineStyle: 'dashed'}});
          }
          return; // Done for this tick
        }
      }
    }
    // If no container/dropped energy, fallback to general energy collection
    //BeeToolbox.collectEnergy(creep);
    //pickupDroppedEnergy(creep);
    const droppedEnergy = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
    filter: r => r.resourceType === RESOURCE_ENERGY
      });

      if (droppedEnergy) {
          if (creep.pickup(droppedEnergy) === ERR_NOT_IN_RANGE) {
              BeeToolbox.BeeTravel(creep,droppedEnergy)
          }
      }
  },
  
  // Smarter energy pickup logic
pickupDroppedEnergy: function (creep) {
    // Find nearest dropped energy (at least 50 energy to avoid wasting time)
    const droppedEnergy = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
        filter: r => r.resourceType === RESOURCE_ENERGY && r.amount >= 50
    });

    if (droppedEnergy) {
        // If not in range, move towards it
        if (creep.pickup(droppedEnergy) === ERR_NOT_IN_RANGE) {
            BeeToolbox.BeeTravel(creep,droppedEnergy);
        }
        return true; // Found and targeted energy
    }

    return false; // No dropped energy nearby
},

/////WIP collectEnergy new format not yet change added 2 as placeholder
  collectEnergy2: function (creep) {
    if (!creep.memory.state) {
        creep.memory.state = 'pickup';
    }

    if (creep.memory.state === 'pickup') {
        // If no container assigned, find one
        if (!creep.memory.assignedContainer) {
            // [Insert your balanced container assignment code here]
        }

        // Go to assigned container and withdraw/pickup
        const container = Game.getObjectById(creep.memory.assignedContainer);
        if (container) {
            // (Optional) Draw current container energy
            creep.room.visual.text(
                `${container.store[RESOURCE_ENERGY]}/${container.store.getCapacity(RESOURCE_ENERGY)}`,
                container.pos.x, container.pos.y - 0.7,
                {align: 'center', color: '#ffaa00'}
            );

            if (creep.store.getFreeCapacity() === 0 || container.store[RESOURCE_ENERGY] === 0) {
                // Switch to delivery when full or nothing left
                creep.memory.state = 'deliver';
                creep.memory.assignedContainer = undefined; // Release for others
            } else if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                BeeToolbox.BeeTravel(creep, container);
            }
            return;
        } else {
            // Lost the container? Reset to try again
            creep.memory.assignedContainer = undefined;
        }
    }

    if (creep.memory.state === 'deliver') {
        // Find storage or target (e.g., Spawn, Storage, etc.)
        let target = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
            filter: s =>
                (s.structureType === STRUCTURE_SPAWN ||
                 s.structureType === STRUCTURE_EXTENSION ||
                 s.structureType === STRUCTURE_STORAGE) &&
                s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
        });
        if (target) {
            if (creep.transfer(target, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                BeeToolbox.BeeTravel(creep, target);
            }
            if (creep.store[RESOURCE_ENERGY] === 0) {
                creep.memory.state = 'pickup'; // Go get more!
            }
        } else {
            // Nowhere to deliver? Idle
            creep.memory.state = 'idle';
        }
    }
},
/////WIP
    deliverEnergy2: function(creep) {
        if (creep.memory.state === 'deliver') {
        BeeToolbox.deliverEnergy(creep, [
            STRUCTURE_STORAGE,
            STRUCTURE_EXTENSION,
            STRUCTURE_SPAWN,
            STRUCTURE_TOWER,
            STRUCTURE_CONTAINER
        ]);
        if (creep.store[RESOURCE_ENERGY] === 0) {
            creep.memory.state = 'pickup'; // Ready for more!
        }
    }
    },
  // 📦 Deliver energy to structures based on priority
  deliverEnergy: function (creep) {
    BeeToolbox.deliverEnergy(creep, [
      STRUCTURE_STORAGE,
      STRUCTURE_EXTENSION,
      STRUCTURE_SPAWN,
      STRUCTURE_TOWER,
      STRUCTURE_CONTAINER
    ]);
  }
};

module.exports = TaskCourier;
