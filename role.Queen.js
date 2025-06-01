const TaskManager = require('TaskManager');
var BeeToolbox = require('BeeToolbox');
const roleQueen = {
  run: function (creep) {
    // Skip execution if the creep is still spawning
    if (creep.spawning) {
      return;
    }     
    if (!creep.memory.task) {
    creep.memory.task = 'queen'; // Default fallback
      }
    TaskManager.run(creep);
  }
};
module.exports = roleQueen;