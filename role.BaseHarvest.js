'use strict';

// Keep the public role import stable for BeeHiveMind.js while logic lives in a dedicated module.
var BaseHarvestLogic = require('role.BaseHarvest.Logic');

module.exports = {
  role: 'BaseHarvest',
  run: BaseHarvestLogic.run
};
