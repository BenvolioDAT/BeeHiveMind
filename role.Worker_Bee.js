const TaskManager = require('TaskManager');
const roleWorker_Bee = {
  run: function(creep) {
    if (creep.spawning) 
      return;
    // If the bee has no task, assign default (idle, or 'harvest' for max usefulness)
    if (!creep.memory.task) {
      creep.memory.task = 'harvest'; // or 'idle' if you prefer
    }
    // Run whatever task is assigned
    TaskManager.run(creep);
  }
};
module.exports = roleWorker_Bee;
