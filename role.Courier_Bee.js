const TaskManager = require('TaskManager');
const roleCourier_Bee = {
  // Main logic loop for the Courier_Bee role
  run: function (creep) {
      // Skip execution if the creep is still spawning
      if (creep.spawning) {
        return;
      }     
      if (!creep.memory.task) {
      creep.memory.task = 'courier'; // Default fallback
        }
      TaskManager.run(creep);
  }    
};
module.exports = roleCourier_Bee; // Export the role for use in the HiveMind
