'use strict';
// This file only contains body choices for this role.
// Bodies are ordered largest to smallest so spawn.logic.getBodyForRole()
// can pick the first body the room can afford.
// Do not reorder bodies unless you understand that spawn selection behavior.
// Cheap vision creep body options.

var BodyParts = require('Spawn.BodyParts');
module.exports = [
  BodyParts.WorkBody(0, 0, 1)
];
