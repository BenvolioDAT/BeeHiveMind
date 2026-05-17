'use strict';
// This file only contains body choices for this role.
// Bodies are ordered largest to smallest so spawn.logic.getBodyForRole()
// can pick the first body the room can afford.
// Do not reorder bodies unless you understand that spawn selection behavior.
// Remote source worker body options.

var BodyParts = require('Spawn.BodyParts');
module.exports = [
  BodyParts.WorkBody(0, 10, 10),
  BodyParts.WorkBody(0, 10, 9),
  BodyParts.WorkBody(0, 9, 9),
  BodyParts.WorkBody(0, 9, 8),
  BodyParts.WorkBody(0, 8, 8),
  BodyParts.WorkBody(0, 8, 7),
  BodyParts.WorkBody(0, 7, 7),
  BodyParts.WorkBody(0, 7, 6),
  BodyParts.WorkBody(0, 6, 6),
  BodyParts.WorkBody(0, 6, 5),
  BodyParts.WorkBody(0, 5, 5),
  BodyParts.WorkBody(0, 5, 4),
  BodyParts.WorkBody(0, 4, 4),
  BodyParts.WorkBody(0, 3, 3),
  BodyParts.WorkBody(0, 3, 2),
  BodyParts.WorkBody(0, 2, 2),
  BodyParts.WorkBody(0, 2, 1),
  BodyParts.WorkBody(0, 1, 1)
];
