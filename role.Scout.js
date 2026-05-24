'use strict';

// Keep the public role import stable for BeeHiveMind.js while logic lives in a dedicated module.
var ScoutLogic = require('role.Scout.Logic');
var HarabiCreep = require('role.HarabiCreep');

module.exports = HarabiCreep.wrapRole('Scout', ScoutLogic.run);
