// TaskManager.js

// -------------------------------------------
// Importing task logic from other files
// Each file exports an object with a `.run(creep)` method
// These files contain the specific code for handling that task's behavior
// For example, harvest.js might have code for harvesting sources
// These files should be in the same folder or adjust the path accordingly
// Example folder structure:
//  /tasks/harvest.js
//  /tasks/build.js
//  /tasks/repair.js
// -------------------------------------------
const TaskBaseHarvest = require('./Task.BaseHarvest');
const TaskRemoteHarvest = require ('./Task.RemoteHarvest');
const TaskBuilder = require ('./Task.Builder');
const TaskCourier = require ('./Task.Courier');
const TaskQueen = require ('./Task.Queen');
const TaskScout = require ('./Task.Scout');
// -------------------------------------------
// The task registry: A central lookup table
// Maps task names (as strings) to their corresponding task modules
// The keys in this object must match the task names stored in `creep.memory.task`
// For example, if you set `creep.memory.task = 'harvest'`, this will call the harvest module
// -------------------------------------------
const tasks = {
  'baseharvest': TaskBaseHarvest,
  'remoteharvest': TaskRemoteHarvest,
  'builder': TaskBuilder,
  'courier': TaskCourier,
  'queen': TaskQueen,
  'scout': TaskScout,
  // You can add more tasks here as you create new modules
  // For example: 'upgrade': upgradeModule,
};

// -------------------------------------------
// Export the TaskManager object as a module
// The TaskManager has a single method: `run(creep)`
// This is the entry point for all task execution
// -------------------------------------------
module.exports = {
  // The `run` method is called from a creep's role (e.g., Nurse_Bee, Forager_Bee)
  // It determines what task the creep should perform based on `creep.memory.task`
  run(creep) {
    // Get the task name from the creep's memory
    // For example, if `creep.memory.task` is 'harvest', this will be 'harvest'
    const taskName = creep.memory.task;

    // Check if the task name matches a registered task in the tasks object
    // If the task exists, call its `.run(creep)` method
    if (tasks[taskName]) {
      tasks[taskName].run(creep);
    } else {
      // If the task is not found in the registry, alert via the creep's `.say()` method
      // This is useful for debugging: you know the creep's task was not recognized
      creep.say('No task!');
    }
  }
};
