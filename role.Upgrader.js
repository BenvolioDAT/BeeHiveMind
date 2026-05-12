'use strict';

// Keep the public role import stable for BeeHiveMind.js while logic lives in a dedicated module.
var UpgraderLogic = require('role.Upgrader.Logic');

module.exports = {
  role: 'Upgrader',
  run: UpgraderLogic.run
};
