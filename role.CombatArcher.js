'use strict';

// Keep the public role import stable for BeeHiveMind.js while logic lives in a dedicated module.
var CombatArcherLogic = require('role.CombatArcher.Logic');

module.exports = {
  role: 'CombatArcher',
  run: CombatArcherLogic.run
};
