'use strict';

// Keep the public role import stable for BeeHiveMind.js while logic lives in a dedicated module.
var ScoutLogic = require('role.Scout.Logic');

module.exports = {
  role: 'Scout',
  run: ScoutLogic.run
};
