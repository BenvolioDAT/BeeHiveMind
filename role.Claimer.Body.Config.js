'use strict';
// This file only contains body choices for this role.
// Bodies are ordered largest to smallest so spawn.logic.getBodyForRole()
// can pick the first body the room can afford.
// Do not reorder bodies unless you understand that spawn selection behavior.
// CLAIM/MOVE body options for claiming or reserving.

var BodyParts = require('Spawn.BodyParts');
module.exports = [
  BodyParts.ClaimerBody(2, 2),
  BodyParts.ClaimerBody(1, 1)
];
