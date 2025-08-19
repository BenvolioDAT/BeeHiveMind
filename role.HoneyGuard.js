var BeeToolbox = require('BeeToolbox'); // Import utility functions

const roleHoneyGuard = {
  // Main function executed each tick
  run: function (creep) {
    if (creep.spawning) return; // Skip logic if creep is still spawning
    // Prioritize self-healing if injured
    /*if (creep.hits < creep.hitsMax) {
      creep.heal(creep);
      creep.say('⚕️'); // Visual indicator for self-heal
    }

    // Scan for nearby injured allies and heal them
    const nearbyAlly = creep.pos.findClosestByRange(FIND_MY_CREEPS, {
      filter: (c) => c.hits < c.hitsMax && c.name !== creep.name
    });

    if (nearbyAlly) {
      if (creep.pos.isNearTo(nearbyAlly)) {
        creep.heal(nearbyAlly); // Direct heal if adjacent
      } else if (creep.pos.inRangeTo(nearbyAlly, 3)) {
        creep.rangedHeal(nearbyAlly); // Ranged heal if within 3 tiles
      }
    }*/

    // If not healing, focus on attack logic
    const attackTarget = BeeToolbox.findAttackTarget(creep);
    if (attackTarget) {
      if (creep.pos.isNearTo(attackTarget)) {
        creep.attack(attackTarget); // Melee attack when adjacent
      } else {
        creep.moveTo(attackTarget); // Move towards target
      }
    } else {
      // No valid attack target, return to flag for regroup
      const rallyFlag = Game.flags.Attack || Game.flags.Rally;
      if (rallyFlag) {
        creep.moveTo(rallyFlag); // Move to rally point
      }
    }
  }
};

module.exports = roleHoneyGuard; // Export the module for HiveMind use
