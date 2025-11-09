'use strict';

// -----------------------------------------------------------------------------
// role.Drone.js – legacy compatibility wrapper for pre-role worker creeps.
// Converts Drone/Worker_Bee task assignments into the Idle role so the
// dispatcher can execute the modern role modules without TaskManager.
// -----------------------------------------------------------------------------

var roleIdle = require('role.Idle');

var roleDrone = {
  role: 'Drone',
  run: function (creep) {
    if (!creep) return;
    if (creep.spawning) return;

    var mem = creep.memory || (creep.memory = {});
    if (!mem.role || mem.role === 'Worker_Bee' || mem.role === 'worker_bee' || mem.role === 'Drone') {
      mem.role = 'Idle';
    }

    if (typeof roleIdle.run === 'function') {
      roleIdle.run(creep);
    }
  }
};

module.exports = roleDrone;
