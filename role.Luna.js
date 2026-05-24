'use strict';

// Keep the public role import stable for BeeHiveMind.js while logic lives in a dedicated module.
var LunaLogic = require('role.Luna.Logic');
var HarabiCreep = require('role.HarabiCreep');

module.exports = HarabiCreep.wrapRole('Luna', LunaLogic.run, { task: 'luna' });
