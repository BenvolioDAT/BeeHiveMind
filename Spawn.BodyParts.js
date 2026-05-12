'use strict';

function buildParts(part, count) {
  var out = [];
  for (var i = 0; i < count; i++) {
    out.push(part);
  }
  return out;
}

function ClaimerBody(claim, move) {
  return [].concat(buildParts(CLAIM, claim), buildParts(MOVE, move));
}

function WorkBody(work, carry, move) {
  return [].concat(buildParts(WORK, work), buildParts(CARRY, carry), buildParts(MOVE, move));
}

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
