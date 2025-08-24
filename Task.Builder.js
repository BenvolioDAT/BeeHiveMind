var BeeToolbox = require('BeeToolbox');
var TaskBuilder = {
  // Define limits for each structure type
  structureLimits: {
    STRUCTURE_TOWER: 6,
    STRUCTURE_EXTENSION: 60,
    STRUCTURE_CONTAINER: 1,
    STRUCTURE_RAMPART: 2,
    STRUCTURE_ROAD: 20,
  },
  // Define site weights for sorting construction sites
  siteWeights: {
    STRUCTURE_TOWER: 5,
    STRUCTURE_CONTAINER: 4,
    STRUCTURE_EXTENSION: 3,
    STRUCTURE_RAMPART: 2,
    STRUCTURE_ROAD: 1,
  },
  // Define positions and types for each structure to be built
  // Y being negative counts as a up while a postive number goes down and X negitvie go left and postive goes right.
  structurePlacements: [
    { type: STRUCTURE_STORAGE,   x:-5, y: 0 },//1

    //{ type: STRUCTURE_CONTAINER, x: 5, y: 0},

    { type: STRUCTURE_EXTENSION, x: 0, y: 2 },//1
    { type: STRUCTURE_EXTENSION, x: 0, y:-2 },//2
    { type: STRUCTURE_EXTENSION, x: 0, y: 3 },//3
    { type: STRUCTURE_EXTENSION, x: 0, y:-3 },//4
    { type: STRUCTURE_EXTENSION, x:-1, y: 3 },//5
    { type: STRUCTURE_EXTENSION, x:-1, y:-3 },//6
    { type: STRUCTURE_EXTENSION, x: 1, y:-3 },//7
    { type: STRUCTURE_EXTENSION, x: 1, y: 3 },//8
    { type: STRUCTURE_EXTENSION, x:-1, y: 2 },//9
    { type: STRUCTURE_EXTENSION, x:-1, y:-2 },//10
    { type: STRUCTURE_EXTENSION, x: 1, y: 2 },//11
    { type: STRUCTURE_EXTENSION, x: 1, y:-2 },//12 
    { type: STRUCTURE_EXTENSION, x:-2, y:-1 },//13
    { type: STRUCTURE_EXTENSION, x:-2, y: 1 },//14
    { type: STRUCTURE_EXTENSION, x: 2, y:-1 },//15
    { type: STRUCTURE_EXTENSION, x: 2, y: 1 },//16
    { type: STRUCTURE_EXTENSION, x:-3, y: 1 },//17
    { type: STRUCTURE_EXTENSION, x:-3, y:-1 },//18
    { type: STRUCTURE_EXTENSION, x: 3, y: 1 },//19
    { type: STRUCTURE_EXTENSION, x: 3, y:-1 },//20
    { type: STRUCTURE_EXTENSION, x:-3, y: 2 },//21
    { type: STRUCTURE_EXTENSION, x:-3, y:-2 },//22
    { type: STRUCTURE_EXTENSION, x: 3, y: 2 },//23
    { type: STRUCTURE_EXTENSION, x: 3, y:-2 },//24
    { type: STRUCTURE_EXTENSION, x:-4, y: 2 },//25
    { type: STRUCTURE_EXTENSION, x:-4, y:-2 },//26
    { type: STRUCTURE_EXTENSION, x: 4, y: 2 },//27
    { type: STRUCTURE_EXTENSION, x: 4, y:-2 },//28
    { type: STRUCTURE_EXTENSION, x: 4, y: 3 },//29
    { type: STRUCTURE_EXTENSION, x: 4, y:-3 },//30
    { type: STRUCTURE_EXTENSION, x:-4, y: 3 },//31
    { type: STRUCTURE_EXTENSION, x:-4, y:-3 },//32
    { type: STRUCTURE_EXTENSION, x:-4, y: 4 },//33
    { type: STRUCTURE_EXTENSION, x:-4, y:-4 },//34
    { type: STRUCTURE_EXTENSION, x: 4, y: 4 },//35
    { type: STRUCTURE_EXTENSION, x: 4, y:-4 },//36
    { type: STRUCTURE_EXTENSION, x: 3, y: 4 },//37
    { type: STRUCTURE_EXTENSION, x: 3, y:-4 },//38
    { type: STRUCTURE_EXTENSION, x:-3, y: 4 },//39
    { type: STRUCTURE_EXTENSION, x:-3, y:-4 },//40
    { type: STRUCTURE_EXTENSION, x:-2, y: 4 },//41
    { type: STRUCTURE_EXTENSION, x:-2, y:-4 },//42
    { type: STRUCTURE_EXTENSION, x: 2, y: 4 },//43
    { type: STRUCTURE_EXTENSION, x: 2, y:-4 },//44
    { type: STRUCTURE_EXTENSION, x: 2, y: 5 },//45
    { type: STRUCTURE_EXTENSION, x: 2, y:-5 },//46
    { type: STRUCTURE_EXTENSION, x:-2, y:-5 },//47
    { type: STRUCTURE_EXTENSION, x:-2, y: 5 },//48
    { type: STRUCTURE_EXTENSION, x:-1, y:-5 },//49
    { type: STRUCTURE_EXTENSION, x:-1, y: 5 },//50
    { type: STRUCTURE_EXTENSION, x: 1, y: 5 },//51
    { type: STRUCTURE_EXTENSION, x: 1, y:-5 },//52
    { type: STRUCTURE_EXTENSION, x: 0, y: 5 },//53
    { type: STRUCTURE_EXTENSION, x: 0, y:-5 },//54
    { type: STRUCTURE_EXTENSION, x:-4, y: 0 },//55
    { type: STRUCTURE_EXTENSION, x: 4, y: 0 },//56
    { type: STRUCTURE_EXTENSION, x:-5, y: 1 },//57
    { type: STRUCTURE_EXTENSION, x:-5, y:-1 },//58
    { type: STRUCTURE_EXTENSION, x: 5, y: 1 },//59
    { type: STRUCTURE_EXTENSION, x: 5, y:-1 },//60 
    // TOWER LOCATIONS
    //{ type: STRUCTURE_TOWER,     x:-5, y:-5 },//1
    //{ type: STRUCTURE_TOWER,     x: 5, y: 5 },//2
    //{ type: STRUCTURE_TOWER,     x:-5, y: 5 },//3
    //{ type: STRUCTURE_TOWER,     x: 5, y:-5 },//4
    //{ type: STRUCTURE_TOWER,     x:-1, y: 0 },//5
    //{ type: STRUCTURE_TOWER,     x: 1, y: 0 },//6
    { type: STRUCTURE_ROAD,      x: 1, y: 1 },
    { type: STRUCTURE_ROAD,      x: 0, y: 1 },
    { type: STRUCTURE_ROAD,      x:-1, y: 1 },
    { type: STRUCTURE_ROAD,      x:-1, y: 0 },
    { type: STRUCTURE_ROAD,      x:-1, y:-1 },
    { type: STRUCTURE_ROAD,      x: 0, y:-1 },
    { type: STRUCTURE_ROAD,      x: 1, y:-1 },
    { type: STRUCTURE_ROAD,      x: 1, y: 0 },
    { type: STRUCTURE_ROAD,      x: 2, y: 0 },
    { type: STRUCTURE_ROAD,      x: 3, y: 0 },
    { type: STRUCTURE_ROAD,      x:-2, y: 0 },
    { type: STRUCTURE_ROAD,      x:-3, y: 0 },
    { type: STRUCTURE_ROAD,      x:-4, y: 1 },
    { type: STRUCTURE_ROAD,      x:-4, y:-1 },
    { type: STRUCTURE_ROAD,      x: 4, y:-1 },
    { type: STRUCTURE_ROAD,      x: 4, y: 1 },
    { type: STRUCTURE_ROAD,      x: 2, y: 2 },
    { type: STRUCTURE_ROAD,      x: 2, y:-2 },
    { type: STRUCTURE_ROAD,      x: 3, y:-3 },
    { type: STRUCTURE_ROAD,      x: 3, y: 3 },
    { type: STRUCTURE_ROAD,      x:-2, y: 2 },
    { type: STRUCTURE_ROAD,      x:-2, y:-2 },
    { type: STRUCTURE_ROAD,      x:-3, y:-3 },
    { type: STRUCTURE_ROAD,      x:-3, y: 3 },
    // Add more structures with their positions
  ],
  // Main function to control the Builder_Bee creep
  run: function (creep) {

    

    // Check if the creep is currently building and has no energy left
    if (creep.memory.building && creep.store[RESOURCE_ENERGY] == 0) {
      creep.memory.building = false;
    }
    // Check if the creep is not building and has full energy capacity
    if (!creep.memory.building && creep.store.getFreeCapacity() == 0) {
      creep.memory.building = true;
    }
    // If the creep is building
    if (creep.memory.building) {
      var targets = creep.room.find(FIND_CONSTRUCTION_SITES);
      if (targets.length) {
        // Sort construction sites by weight in descending order
        targets.sort((a, b) => (TaskBuilder.siteWeights[b.structureType] || 0) - (TaskBuilder.siteWeights[a.structureType] || 0));
        if (creep.build(targets[0]) == ERR_NOT_IN_RANGE) {
          // If not in range, move towards the construction site with visualization
          BeeToolbox.BeeTravel(creep, targets[0]);
          //creep.moveTo(targets[0], {reusePath: 10,visualizePathStyle:{lineStyle: 'dashed'}});
        }
      } else {
        // If there are no construction sites, build predefined structures and act as an Nectar_Bee
        TaskBuilder.buildPredefinedStructures(creep);
        TaskBuilder.upgradeController(creep);
      }
    }
    // If the creep is not building
    else {
      // If no tombstones, prioritize storage for energy withdrawal
      var storageWithEnergy = creep.room.find(FIND_STRUCTURES, {
        filter: (structure) => structure.structureType == STRUCTURE_STORAGE && structure.store.getUsedCapacity(RESOURCE_ENERGY) > 0,
      });
      var closestStorage = creep.pos.findClosestByPath(storageWithEnergy);
      if (closestStorage && creep.withdraw(closestStorage, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) {
        BeeToolbox.BeeTravel(creep, closestStorage);
        //creep.moveTo(closestStorage, {reusePath: 10, visualizePathStyle:{lineStyle: 'dashed'}});
      } else {
        // Find containers in the room with available energy
        var containersWithEnergy = creep.room.find(FIND_STRUCTURES, {
          filter: (structure) => structure.structureType == STRUCTURE_CONTAINER && structure.store.getUsedCapacity(RESOURCE_ENERGY) > 0,
        });
        var closestContainer = creep.pos.findClosestByPath(containersWithEnergy);
        if (closestContainer && creep.withdraw(closestContainer, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) {
          BeeToolbox.BeeTravel(creep, closestContainer);
          //creep.moveTo(closestContainer, {reusePath: 10, visualizePathStyle:{lineStyle: 'dashed'}});
        } else {
          // If no containers with energy, find dropped energy
          var droppedEnergy = creep.room.find(FIND_DROPPED_RESOURCES, {
            filter: (resource) => resource.resourceType == RESOURCE_ENERGY && resource.amount >= 1,
          });
          if (droppedEnergy.length > 0) {
            var closestDroppedEnergy = creep.pos.findClosestByPath(droppedEnergy);
            if (creep.pickup(closestDroppedEnergy) == ERR_NOT_IN_RANGE) {
              BeeToolbox.BeeTravel(creep, closestDroppedEnergy);
              //creep.moveTo(closestDroppedEnergy, {reusePath: 10, visualizePathStyle:{lineStyle: 'dashed'}});
            }
          } else {
            // If no containers/extensions, find extensions
            var extensionsWithEnergy = creep.room.find(FIND_STRUCTURES, {
              filter: (structure) => structure.structureType == STRUCTURE_EXTENSION && structure.store.getUsedCapacity(RESOURCE_ENERGY) > 0,
            });
            var closestExtension = creep.pos.findClosestByPath(extensionsWithEnergy);
            if (closestExtension && creep.withdraw(closestExtension, RESOURCE_ENERGY) == ERR_NOT_IN_RANGE) {
              BeeToolbox.BeeTravel(creep, closestExtension);
              //creep.moveTo(closestExtension, {reusePath: 10, visualizePathStyle:{lineStyle: 'dashed'}});
            } else {
                TaskBuilder.upgradeController(creep);
              }
            }
          }
        }
      }    
  },
  // Function to upgrade the controller when there are no construction sites
  upgradeController: function (creep) {
    var controller = creep.room.controller;
            if (controller.level === 8 && controller.ticksToDowngrade > 180000) {
          // Skip upgrading to save energy when controller is stable
          return;
        }
    if (creep.upgradeController(controller) == ERR_NOT_IN_RANGE) {
      // If not in range, move towards the controller with visualization
      BeeToolbox.BeeTravel(creep, controller);
      //creep.moveTo(controller, {reusePath: 10, visualizePathStyle:{opacity: .8 ,stroke: '#32a852',lineStyle: 'dashed'}});
    }
  },
  // Function to build predefined structures at specified positions
  buildPredefinedStructures: function (creep) {
    for (var i = 0; i < TaskBuilder.structurePlacements.length; i++) {
      var placement = TaskBuilder.structurePlacements[i];
      var targetPosition = new RoomPosition(
        placement.x + creep.room.find(FIND_MY_SPAWNS)[0].pos.x,
        placement.y + creep.room.find(FIND_MY_SPAWNS)[0].pos.y,
        creep.room.find(FIND_MY_SPAWNS)[0].pos.roomName
      );
      // Check if a structure or construction site already exists at the specified spot
      if (
        targetPosition.lookFor(LOOK_STRUCTURES).length === 0 &&
        targetPosition.lookFor(LOOK_CONSTRUCTION_SITES).length === 0
      ) {
        // Build the structure at the specified spot
        TaskBuilder.buildStructures(creep, targetPosition, placement.type);
      }
    }
  },
  // Function to build structures at a specified position
  buildStructures: function (creep, targetPosition, structureType) {
    // Check if the structure limit has been reached for the specified type
    if (
      TaskBuilder.structureLimits[structureType] &&
      TaskBuilder.countStructures(creep.room, structureType) >= TaskBuilder.structureLimits[structureType]
    ) {
      return;
    }
    // Create a construction site for the structure at the specified position
    creep.room.createConstructionSite(targetPosition, structureType);
  },
  // Function to count structures of a specific type in the room
  countStructures: function (room, structureType) {
    return (
      room.find(FIND_STRUCTURES, { filter: { structureType: structureType } }).length +
      room.find(FIND_CONSTRUCTION_SITES, { filter: { structureType: structureType } }).length
    );
  },
};

module.exports = TaskBuilder;
