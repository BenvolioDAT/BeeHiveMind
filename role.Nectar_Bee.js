const TaskManager = require('TaskManager');
const roleNectar_Bee = {
  run: function (creep) {
    // Skip execution if the creep is still spawning
    if (creep.spawning) {
      return;
    }     
    if (!creep.memory.task) {
    creep.memory.task = 'nectar'; // Default fallback
      }
    TaskManager.run(creep);
  }
}
module.exports = roleNectar_Bee;