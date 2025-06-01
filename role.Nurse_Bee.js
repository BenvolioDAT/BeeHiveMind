const TaskManager = require('TaskManager');
const roleNurse_Bee = {
  run: function(creep) {
        // Skip execution if the creep is still spawning
      if (creep.spawning) {
        return;
      }     
      if (!creep.memory.task) {
      creep.memory.task = 'baseharvest'; // Default fallback
        }
      TaskManager.run(creep);
    }
  };
module.exports = roleNurse_Bee;