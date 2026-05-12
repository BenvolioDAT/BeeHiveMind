'use strict';
// This file only contains body choices for this role.
// Bodies are ordered largest to smallest so spawn.logic.getBodyForRole()
// can pick the first body the room can afford.
// Do not reorder bodies unless you understand that spawn selection behavior.
// Builder body options for constructing sites.

var BodyParts = require('Spawn.BodyParts');
module.exports = [
  BodyParts.WorkBody(3, 6, 9),
  BodyParts.WorkBody(2, 4, 6),
  BodyParts.WorkBody(2, 2, 4),
  BodyParts.WorkBody(1, 1, 2),
  BodyParts.WorkBody(1, 1, 1)
];
