'use strict';

// Beginner note: this file only builds reusable body arrays.
// It does NOT decide when to spawn creeps, and it does NOT pick which body is affordable.
// WorkBody, CombatBody, and ClaimerBody each return arrays of Screeps body-part constants.
// The helper code uses simple loops so newer players can read it without spread/arrow syntax.

// Build an array with the same body part repeated `count` times.
function buildParts(part, count) {
  var out = [];
  for (var i = 0; i < count; i++) {
    out.push(part);
  }
  return out;
}

// Build a CLAIM/MOVE body for claiming or reserving controllers.
function ClaimerBody(claim, move) {
  return [].concat(buildParts(CLAIM, claim), buildParts(MOVE, move));
}

// Build a WORK/CARRY/MOVE body for worker-style roles.
function WorkBody(work, carry, move) {
  return [].concat(buildParts(WORK, work), buildParts(CARRY, carry), buildParts(MOVE, move));
}

// Build a combat body in a fixed order so role config files can tune unit size.
function CombatBody(tough, attack, move, rangedAttack, heal) {
  return [].concat(
    buildParts(TOUGH, tough),
    buildParts(ATTACK, attack),
    buildParts(MOVE, move),
    buildParts(RANGED_ATTACK, rangedAttack),
    buildParts(HEAL, heal)
  );
}

module.exports = {
  ClaimerBody: ClaimerBody,
  WorkBody: WorkBody,
  CombatBody: CombatBody
};
