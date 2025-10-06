'use strict';

var TaskManager = require('TaskManager');
var roleWorker_Bee = {
  run: function (creep) {
    if (!creep || creep.spawning) {
      return;
    }

    if (!creep.memory.task) {
      creep.memory.task = TaskManager.getHighestPriorityTask(creep);
    }

    TaskManager.run(creep);
  }
};
module.exports = roleWorker_Bee;
