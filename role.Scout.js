const TaskManager = require('TaskManager');
const roleScout = {
  run: function (creep) {
    // Skip execution if the creep is still spawning
    if (creep.spawning) {
      return;
    }     
    if (!creep.memory.task) {
    creep.memory.task = 'scout'; // Default fallback
      }
    TaskManager.run(creep);  
  }
};
module.exports = roleScout;