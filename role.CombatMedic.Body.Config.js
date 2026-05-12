'use strict';
// This file only contains body choices for this role.
// Bodies are ordered largest to smallest so spawn.logic.getBodyForRole()
// can pick the first body the room can afford.
// Do not reorder bodies unless you understand that spawn selection behavior.
// Healer/support defender body options.

var BodyParts = require('Spawn.BodyParts');
module.exports = [
  BodyParts.CombatBody(0, 0, 4, 0, 4),
  BodyParts.CombatBody(0, 0, 3, 0, 3),
  BodyParts.CombatBody(0, 0, 2, 0, 2),
  BodyParts.CombatBody(0, 0, 1, 0, 1)
];
