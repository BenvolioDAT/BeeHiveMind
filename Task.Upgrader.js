'use strict';

var BeeToolbox = require('BeeToolbox');

var TaskUpgrader = {
  run: function (creep) {
    if (!creep) return;

    var store = creep.store;
    var room = creep.room;
    var controller = room ? room.controller : null;
    var capabilities = BeeToolbox.getRoomCapabilities(room);
    var tier = capabilities ? capabilities.tier : 'early';

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
      var linkNearController = null;
      if (capabilities && capabilities.controllerLinkId) {
        linkNearController = Game.getObjectById(capabilities.controllerLinkId);
      }
      if (!linkNearController && controller) {
        linkNearController = creep.pos.findClosestByRange(FIND_STRUCTURES, {
          filter: function (structure) {
            return (
              structure.structureType === STRUCTURE_LINK &&
              structure.store[RESOURCE_ENERGY] > 0 &&
              structure.pos.inRangeTo(controller, 3)
            );
          }
        });
      }
      // RCL5+ rooms expect a controller-side link to keep the upgrader topped up.
      if (linkNearController && linkNearController.store[RESOURCE_ENERGY] > 0) {
        if (creep.withdraw(linkNearController, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
          BeeToolbox.BeeTravel(creep, linkNearController);
        }
        return;
      }

      var controllerContainer = null;
      if (capabilities && capabilities.controllerContainerId) {
        controllerContainer = Game.getObjectById(capabilities.controllerContainerId);
      }
      if (controllerContainer && controllerContainer.store[RESOURCE_ENERGY] > 0) {
        if (creep.withdraw(controllerContainer, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
          BeeToolbox.BeeTravel(creep, controllerContainer);
        }
        return;
      }

      var storageWithEnergy = null;
      if (capabilities && capabilities.hasStorage && capabilities.storageId) {
        storageWithEnergy = Game.getObjectById(capabilities.storageId);
      }
      // Storage withdraw thresholds scale with controller tier to avoid draining bootstrap reserves.
      var storageThreshold = (tier === 'early') ? 300 : (tier === 'developing' ? 800 : 1200);
      if (storageWithEnergy && storageWithEnergy.store && storageWithEnergy.store[RESOURCE_ENERGY] > storageThreshold) {
        if (creep.withdraw(storageWithEnergy, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
          BeeToolbox.BeeTravel(creep, storageWithEnergy);
        }
        return;
      }

      if (capabilities && capabilities.hasTerminal && capabilities.tier === 'late') {
        var terminal = Game.getObjectById(capabilities.terminalId);
        if (terminal && terminal.store && terminal.store[RESOURCE_ENERGY] > 0) {
          if (creep.withdraw(terminal, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
            BeeToolbox.BeeTravel(creep, terminal);
          }
          return;
        }
      }

      // Early RCL rooms recycle energy directly from spawn/extension buffers until storage exists.
      if (tier === 'early') {
        var spawnOrExtension = creep.pos.findClosestByRange(FIND_STRUCTURES, {
          filter: function (structure) {
            if (!structure.store) return false;
            if (structure.structureType !== STRUCTURE_SPAWN && structure.structureType !== STRUCTURE_EXTENSION) return false;
            return structure.store[RESOURCE_ENERGY] > 0;
          }
        });
        if (spawnOrExtension) {
          if (creep.withdraw(spawnOrExtension, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
            BeeToolbox.BeeTravel(creep, spawnOrExtension);
          }
          return;
        }
      }

      BeeToolbox.collectEnergy(creep);
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
