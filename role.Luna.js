'use strict';

// Keep the public role import stable for BeeHiveMind.js while logic lives in a dedicated module.
var LunaLogic = require('role.Luna.Logic');

module.exports = {
  role: 'Luna',
  run: LunaLogic.run
};
