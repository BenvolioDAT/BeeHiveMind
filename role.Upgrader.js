'use strict';

// Keep the public role import stable for BeeHiveMind.js while logic lives in a dedicated module.
var UpgraderLogic = require('role.Upgrader.Logic');
var HarabiCreep = require('role.HarabiCreep');

module.exports = HarabiCreep.wrapRole('Upgrader', UpgraderLogic.run, { task: 'upgrader' });
