'use strict';
// This file only contains body choices for this role.
// Bodies are ordered largest to smallest so spawn.logic.getBodyForRole()
// can pick the first body the room can afford.
// Do not reorder bodies unless you understand that spawn selection behavior.
// Local melee defender body options.

var BodyParts = require('Spawn.BodyParts');
module.exports = [
  BodyParts.CombatBody(0, 2, 2, 0, 0)
];
