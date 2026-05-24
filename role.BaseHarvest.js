'use strict';

// Keep the public role import stable for BeeHiveMind.js while logic lives in a dedicated module.
var BaseHarvestLogic = require('role.BaseHarvest.Logic');
var HarabiCreep = require('role.HarabiCreep');

module.exports = HarabiCreep.wrapRole('BaseHarvest', BaseHarvestLogic.run, { task: 'baseharvest' });
