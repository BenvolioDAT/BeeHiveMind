var BeeToolbox = require('BeeToolbox'); // Import utility functions

const roleHoneyGuard = {
  // Main function executed each tick
  run: function (creep) {
    if (creep.spawning) return; // Skip logic if creep is still spawning
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
      const rallyFlag = Game.flags['Rally'];
      if (rallyFlag) {
        creep.moveTo(rallyFlag); // Move to rally point
      }
    }
  }
};

module.exports = roleHoneyGuard; // Export the module for HiveMind use
