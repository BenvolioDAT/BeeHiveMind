'use strict';

var BeeToolbox = require('BeeToolbox');

var TaskUpgrader = {
  run: function (creep) {
    if (!creep) return;

    var store = creep.store;
    var room = creep.room;
    var controller = room ? room.controller : null;

    if (creep.memory.upgrading && store[RESOURCE_ENERGY] === 0) {
      creep.memory.upgrading = false;
      creep.memory.targetDroppedEnergyId = null; // Clear the target when switching tasks
    } else if (!creep.memory.upgrading && store.getFreeCapacity() === 0) {
      creep.memory.upgrading = true;
    }
    // If the creep is upgrading
    if (creep.memory.upgrading) {
      if (controller) {
        if (controller.level === 8 && controller.ticksToDowngrade > 180000) {
          // Skip upgrading to save energy when controller is stable
          return;
        }
        if (creep.upgradeController(controller) === ERR_NOT_IN_RANGE) {
          BeeToolbox.BeeTravel(creep, controller);
          //creep.moveTo(controller, { reusePath: 10 });
        }
      }
      // Check and update the controller sign
      checkAndUpdateControllerSign(creep, controller);
    } else {
      // First, check for a link near the controller
      var linkNearController = creep.pos.findClosestByRange(FIND_STRUCTURES, {
        filter: function (structure) {
          return (
            structure.structureType === STRUCTURE_LINK &&
            controller && structure.pos.inRangeTo(controller, 3) && // within range of the controller
            structure.store[RESOURCE_ENERGY] > 0 // link has energy
          );
        }
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
      var storageWithEnergy = room ? room.storage : null;
      if (storageWithEnergy && storageWithEnergy.store[RESOURCE_ENERGY] > 0) {
        if (creep.withdraw(storageWithEnergy, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
          BeeToolbox.BeeTravel(creep, storageWithEnergy);
          //creep.moveTo(storageWithEnergy, { reusePath: 10 });
        }
      } else {
        // If no energy in storage, look for energy in containers
        var containerWithEnergy = creep.pos.findClosestByPath(FIND_STRUCTURES, {
          filter: function (structure) {
            return (
              structure.structureType === STRUCTURE_CONTAINER &&
              structure.store[RESOURCE_ENERGY] > 0
            );
          }
        });
        if (containerWithEnergy) {
          if (creep.withdraw(containerWithEnergy, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
            BeeToolbox.BeeTravel(creep, containerWithEnergy);
            //creep.moveTo(containerWithEnergy, { reusePath: 10 });
          }
        } else {
          // If no energy in containers, look for dropped energy
          var targetDroppedEnergyId = creep.memory.targetDroppedEnergyId;
          var droppedResource;
          if (targetDroppedEnergyId) {
            droppedResource = Game.getObjectById(targetDroppedEnergyId);
          }
          // If the target dropped resource is not valid, find a new one
          if (!droppedResource || droppedResource.amount === 0) {
            var droppedResources = room ? room.find(FIND_DROPPED_RESOURCES, {
              filter: function (resource) {
                return resource.resourceType === RESOURCE_ENERGY;
              }
            }) : [];
            if (droppedResources.length > 0) {
              droppedResources.sort(function (a, b) {
                return b.amount - a.amount;
              });
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
  }
};
function checkAndUpdateControllerSign(creep, controller) {
  var newSignMessage = "BeeNice Please.";
  if (!controller) return;
  // Check if there is no sign or the existing sign is different
  if (!controller.sign || controller.sign.text !== newSignMessage) {
    // Check if the creep is in range to sign the controller
    if (creep.pos.inRangeTo(controller.pos, 1)) {
      // If the sign is not there or is different, update the sign
      var result = creep.signController(controller, newSignMessage);
      if (result === OK) {
        console.log('Upgrader ' + creep.name + ' updated the controller sign.');
      } else {
        console.log('Upgrader ' + creep.name + ' failed to update the controller sign. Error: ' + result);
      }
    } else {
      // If not in range, move towards the controller
      BeeToolbox.BeeTravel(creep, controller);
      //creep.moveTo(controller, { reusePath: 10 });
    }
  }
}
module.exports = TaskUpgrader;
