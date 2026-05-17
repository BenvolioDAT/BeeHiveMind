'use strict';
// This file only contains body choices for this role.
// Bodies are ordered largest to smallest so spawn.logic.getBodyForRole()
// can pick the first body the room can afford.
// Do not reorder bodies unless you understand that spawn selection behavior.
// Remote source worker body options.

var BodyParts = require('Spawn.BodyParts');
module.exports = [
  BodyParts.WorkBody(3, 1, 4),
  BodyParts.WorkBody(3, 1, 3),
  BodyParts.WorkBody(2, 1, 3),
  BodyParts.WorkBody(2, 1, 2),
  BodyParts.WorkBody(1, 1, 2),
  BodyParts.WorkBody(1, 1, 1)
];
