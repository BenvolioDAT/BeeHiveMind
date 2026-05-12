'use strict';

// Keep the public role import stable for BeeHiveMind.js while logic lives in a dedicated module.
var BuilderLogic = require('role.Builder.Logic');

module.exports = {
  role: 'Builder',
  run: BuilderLogic.run
};
