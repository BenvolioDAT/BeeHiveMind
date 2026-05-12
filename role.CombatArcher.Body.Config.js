'use strict';
// This file only contains body choices for this role.
// Bodies are ordered largest to smallest so spawn.logic.getBodyForRole()
// can pick the first body the room can afford.
// Do not reorder bodies unless you understand that spawn selection behavior.
// Ranged defender body options.

var BodyParts = require('Spawn.BodyParts');
module.exports = [
  BodyParts.CombatBody(0, 0, 1, 1, 0)
];
