'use strict';

// Keep the public role import stable for BeeHiveMind.js while logic lives in a dedicated module.
var CombatMeleeLogic = require('role.CombatMelee.Logic');
var HarabiCreep = require('role.HarabiCreep');

module.exports = HarabiCreep.wrapRole('CombatMelee', CombatMeleeLogic.run);
