var BeeToolbox = require('BeeToolbox');
const TaskQueen = {
  run: function (creep) {
    const hasSourceContainers = creep.room.find(FIND_STRUCTURES, {
      filter: s => s.structureType === STRUCTURE_CONTAINER && s.pos.findInRange(FIND_SOURCES,1).length
    }).length > 0;

    // BOOTSTRAP: before source containers exist, help build first extensions/containers or do micro-hauls
    if (!hasSourceContainers) {
      const site = creep.pos.findClosestByPath(FIND_CONSTRUCTION_SITES, {
        filter: s => s.structureType === STRUCTURE_EXTENSION || s.structureType === STRUCTURE_CONTAINER
      });
      if (site) {
        if (creep.store[RESOURCE_ENERGY] === 0) {
          // try spawn->withdraw; else harvest a little
          const spawn = creep.pos.findClosestByPath(FIND_MY_SPAWNS);
          if (spawn && spawn.store[RESOURCE_ENERGY] >= 50 && creep.room.energyAvailable === creep.room.energyCapacityAvailable) {
            if (creep.withdraw(spawn, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) BeeToolbox.BeeTravel(creep, spawn);
          } else {
            const src = creep.pos.findClosestByPath(FIND_SOURCES_ACTIVE);
            if (creep.harvest(src) === ERR_NOT_IN_RANGE) BeeToolbox.BeeTravel(creep, src);
          }
        } else {
          if (creep.build(site) === ERR_NOT_IN_RANGE) BeeToolbox.BeeTravel(creep, site);
        }
        return; // bootstrap work done this tick
      }

      // No site? act as mini-courier: pick up and top off spawn/extensions
      const drop = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {filter:r=>r.resourceType===RESOURCE_ENERGY});
      if (drop && creep.store.getFreeCapacity() > 0) {
        if (creep.pickup(drop) === ERR_NOT_IN_RANGE) BeeToolbox.BeeTravel(creep, drop);
        return;
      }
      const needy = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
        filter: s => (s.structureType === STRUCTURE_SPAWN || s.structureType === STRUCTURE_EXTENSION) &&
                    s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
      });
      if (needy && creep.store[RESOURCE_ENERGY] > 0) {
        if (creep.transfer(needy, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) BeeToolbox.BeeTravel(creep, needy);
        return;
      }
      // (falls through to your existing hauling logic once containers exist)
    }


    // Function to check if a container is near a source
    const isContainerNearSource = (container) => {
      return container.pos.findInRange(FIND_SOURCES, 2).length > 0;
    };
    const findNearestContainerWithEnergy = () => {
      const containers = creep.room.find(FIND_STRUCTURES, {
        filter: (structure) =>
          structure.structureType === STRUCTURE_CONTAINER &&
          structure.store.getUsedCapacity(RESOURCE_ENERGY) > 0 &&
          !isContainerNearSource(structure),
      });
      containers.sort((a, b) => a.pos.getRangeTo(creep) - b.pos.getRangeTo(creep));
      return containers[0];
    };
    const findNearestTarget = (structureType, resourceType) => {
      const targets = creep.room.find(FIND_STRUCTURES, {
        filter: (structure) =>
          structure.structureType === structureType &&
          structure.store.getFreeCapacity(resourceType) > 0,
      });
      targets.sort((a, b) => a.pos.getRangeTo(creep) - b.pos.getRangeTo(creep));
      return targets[0];
    };
    const findStorageWithEnergy = () => {
      const storage = creep.room.find(FIND_STRUCTURES, {
        filter: (structure) =>
          structure.structureType === STRUCTURE_STORAGE &&
          structure.store.getUsedCapacity(RESOURCE_ENERGY) > 0,
      });
      return storage[0];
    };
    const withdrawFromContainer = (container) => {
      if (creep.withdraw(container, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        BeeToolbox.BeeTravel(creep, container);
        //creep.moveTo(container);
      }
    };
    const transferToTarget = (target, resourceType) => {
      if (creep.transfer(target, resourceType) === ERR_NOT_IN_RANGE) {
        BeeToolbox.BeeTravel(creep, target);
        //creep.moveTo(target);
      }
    };
    const findLinkNearSpawn = () => {
      const spawn = creep.room.find(FIND_MY_SPAWNS)[0];
      if (!spawn) return null;
      return spawn.pos.findClosestByRange(FIND_STRUCTURES, {
        filter: (structure) => structure.structureType === STRUCTURE_LINK,
      });
    };
    // Check if the creep has energy to distribute
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
      // Prioritize filling extensions, spawns, and towers
      const targetExtension = findNearestTarget(STRUCTURE_EXTENSION, RESOURCE_ENERGY);
      if (targetExtension) {
        transferToTarget(targetExtension, RESOURCE_ENERGY);
        return;
      }
      const targetSpawn = findNearestTarget(STRUCTURE_SPAWN, RESOURCE_ENERGY);
      if (targetSpawn) {
        transferToTarget(targetSpawn, RESOURCE_ENERGY);
        return;
      }
      const targetTower = findNearestTarget(STRUCTURE_TOWER, RESOURCE_ENERGY);
      if (targetTower) {
        transferToTarget(targetTower, RESOURCE_ENERGY);
        return;
      }
      // If no other targets, fill the link near spawn
      const linkNearSpawn = findLinkNearSpawn();
      if (linkNearSpawn && linkNearSpawn.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        transferToTarget(linkNearSpawn, RESOURCE_ENERGY);
        return;
      }
      const targetTerminal = findNearestTarget(STRUCTURE_TERMINAL, RESOURCE_ENERGY);
      if (targetTerminal) {
          transferToTarget(targetTerminal, RESOURCE_ENERGY);
          return;
      }
      // If no targets found, check storage
      const storage = findStorageWithEnergy();
      if (storage) {
        transferToTarget(storage, RESOURCE_ENERGY);
        return;
      }
    } else {
      // If the creep does not have energy, check if storage has energy
      const storage = findStorageWithEnergy();
      if (storage) {
        withdrawFromContainer(storage);
        return;
      }
    }
    // Check for the nearest container with energy
    const containerStorage = findNearestContainerWithEnergy();
    if (containerStorage) {
      withdrawFromContainer(containerStorage);
      return;
    }
  }
};
module.exports = TaskQueen;