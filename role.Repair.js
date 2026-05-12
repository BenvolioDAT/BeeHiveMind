'use strict';

// Keep the public role import stable for BeeHiveMind.js while logic lives in a dedicated module.
var RepairLogic = require('role.Repair.Logic');

module.exports = {
  role: 'Repair',
  run: RepairLogic.run
};
