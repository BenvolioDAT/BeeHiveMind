'use strict';
// This file only contains body choices for this role.
// Bodies are ordered largest to smallest so spawn.logic.getBodyForRole()
// can pick the first body the room can afford.
// Do not reorder bodies unless you understand that spawn selection behavior.
// Repair body options for fixing damaged structures.

var BodyParts = require('Spawn.BodyParts');
module.exports = [
  BodyParts.WorkBody(5, 2, 7),
  BodyParts.WorkBody(4, 1, 5),
  BodyParts.WorkBody(2, 1, 3)
];
