'use strict';
// This file only contains body choices for this role.
// Bodies are ordered largest to smallest so spawn.logic.getBodyForRole()
// can pick the first body the room can afford.
// Do not reorder bodies unless you understand that spawn selection behavior.
// Repair body options for fixing damaged structures.

var BodyParts = require('Spawn.BodyParts');
module.exports = [
  BodyParts.WorkBody(4, 6, 10),
  BodyParts.WorkBody(4, 6, 9),
  BodyParts.WorkBody(4, 5, 9),
  BodyParts.WorkBody(4, 5, 8),
  BodyParts.WorkBody(4, 4, 8),
  BodyParts.WorkBody(4, 4, 7),
  BodyParts.WorkBody(4, 3, 7),
  BodyParts.WorkBody(4, 3, 6),
  BodyParts.WorkBody(3, 3, 6),
  BodyParts.WorkBody(3, 3, 5),
  BodyParts.WorkBody(3, 2, 5),
  BodyParts.WorkBody(3, 2, 4),
  BodyParts.WorkBody(2, 2, 4),
  BodyParts.WorkBody(2, 2, 3,
  BodyParts.WorkBody(2, 1, 3),
  BodyParts.WorkBody(2, 1, 2),
  BodyParts.WorkBody(1, 1, 2),
  BodyParts.WorkBody(1, 1, 1)
];
