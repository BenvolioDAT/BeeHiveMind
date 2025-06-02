const TaskManager = require('TaskManager');
const roleForager_Bee = {
    run: function (creep) {
        if (creep.spawning) {
            return;
        }     
        if (!creep.memory.task) {
            creep.memory.task = 'remoteharvest'; // Default fallback
        }
        TaskManager.run(creep);
    }
};
module.exports = roleForager_Bee;
