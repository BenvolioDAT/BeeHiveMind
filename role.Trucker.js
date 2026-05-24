'use strict';

var TruckerLogic = require('role.Trucker.Logic');
var HarabiCreep = require('role.HarabiCreep');

module.exports = HarabiCreep.wrapRole('Trucker', TruckerLogic.run, { task: 'haulUnified' });
