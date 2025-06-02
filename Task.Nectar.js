var BeeToolbox = require('BeeToolbox');
const TaskNectar = {
  run: function (creep) {
    // Check if the creep is upgrading and has no energy left
    if (creep.memory.upgrading && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.upgrading = false;
      creep.memory.targetDroppedEnergyId = null; // Clear the target when switching tasks
    } else if (!creep.memory.upgrading && creep.store.getFreeCapacity() === 0) {
      creep.memory.upgrading = true;
    }
    // If the creep is upgrading
    if (creep.memory.upgrading) {
      const controller = creep.room.controller;
      if (controller) {
        if (controller.level === 8 && controller.ticksToDowngrade > 180000) {
          // Skip upgrading to save energy when controller is stable
          return;
        }
        if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
          BeeToolbox.BeeTravel(creep, controller);
          //creep.moveTo(controller, { reusePath: 10 });
        }
      // Still check the sign even if skipping upgrade
      checkAndUpdateControllerSign(creep, controller);
      } 
      // Check and update the controller sign
      checkAndUpdateControllerSign(creep, controller);
    } else {
      // First, check for a link near the controller
      const linkNearController = creep.pos.findClosestByRange(FIND_STRUCTURES, {
        filter: (structure) =>
          structure.structureType === STRUCTURE_LINK &&
          structure.pos.inRangeTo(creep.room.controller, 3) && // within range of the controller
          structure.store[RESOURCE_ENERGY] > 0, // link has energy
      });
      if (linkNearController) {
        if (creep.withdraw(linkNearController, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
          BeeToolbox.BeeTravel(creep, linkNearController);
          //creep.moveTo(linkNearController, { reusePath: 10 });
        }
        return; // Early return to avoid checking other sources if the link is valid
      }
      BeeToolbox.collectEnergy(creep);
      // Check if there is energy in storage
      const storageWithEnergy = creep.room.storage;
      if (storageWithEnergy && storageWithEnergy.store[RESOURCE_ENERGY] > 0) {
        if (creep.withdraw(storageWithEnergy, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
          BeeToolbox.BeeTravel(creep, storageWithEnergy);
          //creep.moveTo(storageWithEnergy, { reusePath: 10 });
        }
      } else {
        // If no energy in storage, look for energy in containers
        const containerWithEnergy = creep.pos.findClosestByPath(FIND_STRUCTURES, {
          filter: (structure) =>
            structure.structureType === STRUCTURE_CONTAINER &&
            structure.store[RESOURCE_ENERGY] > 0,
        });
        if (containerWithEnergy) {
          if (creep.withdraw(containerWithEnergy, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
            BeeToolbox.BeeTravel(creep, containerWithEnergy);
            //creep.moveTo(containerWithEnergy, { reusePath: 10 });
          }
        } else {
          // If no energy in containers, look for dropped energy
          const targetDroppedEnergyId = creep.memory.targetDroppedEnergyId;
          let droppedResource;
          if (targetDroppedEnergyId) {
            droppedResource = Game.getObjectById(targetDroppedEnergyId);
          }
          // If the target dropped resource is not valid, find a new one
          if (!droppedResource || droppedResource.amount === 0) {
            const droppedResources = creep.room.find(FIND_DROPPED_RESOURCES, {
              filter: (resource) => resource.resourceType === RESOURCE_ENERGY,
            });
            if (droppedResources.length > 0) {
              droppedResources.sort((a, b) => b.amount - a.amount);
              droppedResource = droppedResources[0];
              creep.memory.targetDroppedEnergyId = droppedResource.id;
            }
          }
          if (droppedResource && creep.pickup(droppedResource) === ERR_NOT_IN_RANGE) {
            BeeToolbox.BeeTravel(creep, droppedResource);
            //creep.moveTo(droppedResource, { reusePath: 10 });
          }
        }
      }
    }
  },
};
function checkAndUpdateControllerSign(creep, controller) {
  const newSignMessage = "BeeNice Please.";
  // Check if there is no sign or the existing sign is different
  if (!controller.sign || controller.sign.text !== newSignMessage) {
    // Check if the creep is in range to sign the controller
    if (creep.pos.inRangeTo(controller.pos, 1)) {
      // If the sign is not there or is different, update the sign
      const result = creep.signController(controller, newSignMessage);
      if (result === OK) {
        console.log(`Nectar_Bee ${creep.name} updated the controller sign.`);
      } else {
        console.log(`Nectar_Bee ${creep.name} failed to update the controller sign. Error: ${result}`);
      }
    } else {
      // If not in range, move towards the controller
      BeeToolbox.BeeTravel(creep, controller);
      //creep.moveTo(controller, { reusePath: 10 });
    }
  }
}
module.exports = TaskNectar;