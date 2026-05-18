'use strict';
// This file only contains body choices for this role.
// Bodies are ordered largest to smallest so spawn.logic.getBodyForRole()
// can pick the first body the room can afford.
// Do not reorder bodies unless you understand that spawn selection behavior.
// Logistics-hub body options, mostly CARRY + MOVE.

var BodyParts = require('Spawn.BodyParts');
module.exports = [
  BodyParts.WorkBody(1, 17, 9),
  BodyParts.WorkBody(1, 17, 18),
  BodyParts.WorkBody(1, 16, 17),
  BodyParts.WorkBody(1, 15, 16),
  BodyParts.WorkBody(1, 14, 15),
  BodyParts.WorkBody(1, 13, 14),
  BodyParts.WorkBody(1, 12, 13),
  BodyParts.WorkBody(1, 11, 12),
  BodyParts.WorkBody(1, 10, 11),
  BodyParts.WorkBody(1, 9, 10),
  BodyParts.WorkBody(1, 8, 9),
  BodyParts.WorkBody(1, 7, 8),
  BodyParts.WorkBody(1, 6, 7),
  BodyParts.WorkBody(1, 5, 6),
  BodyParts.WorkBody(1, 4, 5),
  BodyParts.WorkBody(1, 3, 4),
  BodyParts.WorkBody(1, 2, 3),
  BodyParts.WorkBody(1, 1, 2),
  BodyParts.WorkBody(1, 1, 1)
];
