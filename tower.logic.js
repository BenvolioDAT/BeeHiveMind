module.exports = {
  run: function () {
    // Get the first spawn in the room (assumes there is at least one spawn)
    var spawn = Game.spawns[Object.keys(Game.spawns)[0]];
    if (spawn) {
      // Ensure room memory is initialized
      if (!Memory.rooms[spawn.room.name]) {
        Memory.rooms[spawn.room.name] = {};
      }
      // Initialize repairTargets array in memory if not present
      if (!Memory.rooms[spawn.room.name].repairTargets) {
        Memory.rooms[spawn.room.name].repairTargets = [];
      }
      // Find all towers in the room owned by you
      var towers = spawn.room.find(FIND_MY_STRUCTURES, {
        filter: { structureType: STRUCTURE_TOWER }
      });
      // Check if hostile creeps are present in the room
      var hostileCreepPresent = towers.some(tower => tower.pos.findClosestByRange(FIND_HOSTILE_CREEPS));
      // If hostile creeps are present, attack them using towers
      if (hostileCreepPresent) {
        towers.forEach(tower => {
          var closestHostile = tower.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
          if (closestHostile) {
            tower.attack(closestHostile);
          }
        });
      } else if (Memory.rooms[spawn.room.name].repairTargets.length > 0) {
        // Check if any tower has 300 or less energy in its storage
        var lowEnergyTower = towers.find(tower => tower.store.getUsedCapacity(RESOURCE_ENERGY) <= 300);
        if (!lowEnergyTower) {
          // Get the first target from repairTargets array
          var targetData = Memory.rooms[spawn.room.name].repairTargets[0];
          // Check if the target is still valid (exists in the room)
          var target = Game.getObjectById(targetData.id);
          // Check if the target is valid
          if (target) {
            towers.forEach(tower => {
              tower.repair(target);
              // Visualize the repair target by drawing a circle around it
              tower.room.visual.circle(target.pos, { radius: 0.5, fill: 'transparent', stroke: 'green' });
            });
            // Check if the target is fully repaired
            if (target.hits === target.hitsMax) {
              // Remove the fully repaired target from memory
              Memory.rooms[spawn.room.name].repairTargets.shift();
            }
          } else {
            // Remove invalid target from memory
            Memory.rooms[spawn.room.name].repairTargets.shift();
          }
        }
      }
    }
  }
};
