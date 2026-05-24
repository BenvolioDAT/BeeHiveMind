'use strict';

var VeinseekerLogic = require('role.Veinseeker.Logic');
var HarabiCreep = require('role.HarabiCreep');

module.exports = HarabiCreep.wrapRole('Veinseeker', VeinseekerLogic.run);
