'use strict';

// Keep the public role import stable for BeeHiveMind.js while logic lives in a dedicated module.
var CombatArcherLogic = require('role.CombatArcher.Logic');
var HarabiCreep = require('role.HarabiCreep');

module.exports = HarabiCreep.wrapRole('CombatArcher', CombatArcherLogic.run, { task: 'combat' });
