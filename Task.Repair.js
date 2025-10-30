// Logging Levels
const LOG_LEVEL = {NONE: 0,BASIC: 1,DEBUG: 2};
//if (currentLogLevel >= LOG_LEVEL.DEBUG) {}  
const currentLogLevel = LOG_LEVEL.NONE;  // Adjust to LOG_LEVEL.DEBUG for more detailed logs
  
var TaskRepair = {
  run: function (creep) {    
    // Check if the creep has energy
    if (creep.store[RESOURCE_ENERGY] > 0) {
      // Check if there are structures to repair
      if (Memory.rooms[creep.room.name].repairTargets.length > 0) {
        // Get the first structure to repair
        var targetData = Memory.rooms[creep.room.name].repairTargets[0];
        var target = Game.getObjectById(targetData.id);
        // Check if the target is still valid
        if (target) {
          // Log information about the structure to be repaired
          if (currentLogLevel >= LOG_LEVEL.DEBUG) {
          console.log(`Creep ${creep.name} is repairing ${target.structureType} at (${target.pos.x}, ${target.pos.y})`);
          //creep.say('🔧 R');
          }
          // Display repair information on the screeps screen
          creep.room.visual.text(
            `Repairing ${target.structureType}`,
            target.pos.x,
            target.pos.y - 1,
            { align: 'center', color: 'white' }
          );
          // Draw a teal circle around the repair target
          creep.room.visual.circle(target.pos, { radius: 0.5, fill: 'transparent', stroke: 'teal' });
          // Repair the structure
          var repairResult = creep.repair(target);
          // Check if the repair is complete or out of energy
          if (repairResult === OK) {
            // If fully repaired, remove the target from memory
            if (target.hits === target.hitsMax) {
              Memory.rooms[creep.room.name].repairTargets.shift();
            }
          } else if (repairResult === ERR_NOT_IN_RANGE) {
            // If out of range, move to the target
            //creep.moveTo(target, { reusePath: 10 });
            creep.moveTo(target);
          } else {
            if (currentLogLevel >= LOG_LEVEL.DEBUG) {
            // Handle other repair errors
            console.log(`Repair error: ${repairResult}`);
            }
          }
        } else {
          // Remove the target from memory if it's not valid
          Memory.rooms[creep.room.name].repairTargets.shift();
        }
      } else {
        creep.memory.task = undefined;
        // No repair targets, log a message
      }
    } else {
      // Find energy on the ground
      var energyOnGround = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
        filter: (resource) => resource.resourceType === RESOURCE_ENERGY,
      });
      // Pickup energy on the ground if available
      if (energyOnGround && creep.pickup(energyOnGround) === ERR_NOT_IN_RANGE) {
        //creep.moveTo(energyOnGround, { reusePath: 10 });
        creep.moveTo(energyOnGround);
        return; // Exit the function to avoid other logic
      }
      // Find the nearest container, extension, or spawn with energy
      var energySource = creep.pos.findClosestByPath(FIND_STRUCTURES, {
        filter: (structure) =>
          [STRUCTURE_CONTAINER, STRUCTURE_EXTENSION, STRUCTURE_SPAWN].includes(structure.structureType) &&
          structure.store[RESOURCE_ENERGY] > 0,
      });
      // Check if there's an energy source
      if (energySource) {
        // Move to the energy source and withdraw energy with visualization
        if (creep.withdraw(energySource, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
          //creep.moveTo(energySource, { reusePath: 10 });
          creep.moveTo(energySource);
          return; // Exit the function to avoid other logic
        }
      } else {
        if (currentLogLevel >= LOG_LEVEL.DEBUG) {
        // No available energy source, log a message
        console.log('No available energy source');
        }
      }
    }
  },
};

module.exports = TaskRepair;
