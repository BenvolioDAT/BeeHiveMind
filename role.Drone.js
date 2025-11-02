const TaskManager = require('TaskManager');
const roleDrone = {
  run: function(creep) {
    if (creep.spawning) 
      return;
    // If the bee has no task, assign default (idle, or 'harvest' for max usefulness)
    if (!creep.memory.task) {
      creep.memory.task = TaskManager.getHighestPriorityTask(creep);
    }
    // Run whatever task is assigned
    TaskManager.run(creep);
  }
};
module.exports = roleDrone;
