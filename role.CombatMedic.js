'use strict';

// Keep the public role import stable for BeeHiveMind.js while logic lives in a dedicated module.
var CombatMedicLogic = require('role.CombatMedic.Logic');

module.exports = {
  role: 'CombatMedic',
  run: CombatMedicLogic.run
};
