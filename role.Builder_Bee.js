const TaskManager = require('TaskManager');
var roleBuilder_Bee = {
  // Main function to control the Builder_Bee creep
  run: function (creep) {
            // Skip execution if the creep is still spawning
          if (creep.spawning) {
            return;
          }     
          if (!creep.memory.task) {
          creep.memory.task = 'builder'; // Default fallback
            }
          TaskManager.run(creep);
  }
};

module.exports = roleBuilder_Bee;
