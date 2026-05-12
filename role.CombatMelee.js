'use strict';

// Keep the public role import stable for BeeHiveMind.js while logic lives in a dedicated module.
var CombatMeleeLogic = require('role.CombatMelee.Logic');

module.exports = {
  role: 'CombatMelee',
  run: CombatMeleeLogic.run
};
