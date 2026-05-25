'use strict';

// -----------------------------------------------------------------------------
// core.body.js - pure Screeps body array helpers
// Owns:
// * Body cost/count/clone/signature/summary helpers shared by spawn diagnostics,
//   source planning, and compatibility exports from BeeToolbox.
// Memory paths:
// * None. This module is pure utility code.
// Usually called by:
// * spawn.logic.js, SourceEnergy.Manager.js, SourceWorker.Manager.js, and
//   BeeToolbox.js compatibility wrappers.
// Do not casually change:
// * getBodySignature() ordering or summarizeBody() field names; spawn memory and
//   diagnostics use those as stable readable shape summaries.
// -----------------------------------------------------------------------------

function calculateBodyCost(body) {
  if (!body || !body.length) return 0;
  var total = 0;
  for (var i = 0; i < body.length; i++) {
    total += BODYPART_COST[body[i]] || 0;
  }
  return total;
}

function countBodyParts(body, part) {
  if (!body || !body.length) return 0;
  var count = 0;
  for (var i = 0; i < body.length; i++) {
    if (body[i] === part) count++;
  }
  return count;
}

function cloneBody(body) {
  var out = [];
  if (!body || !body.length) return out;
  for (var i = 0; i < body.length; i++) out.push(body[i]);
  return out;
}

function getBodySignature(body) {
  if (!body || !body.length) return '';
  var parts = [];
  for (var i = 0; i < body.length; i++) parts.push(String(body[i]));
  return parts.join('|');
}

function summarizeBody(body) {
  var summary = {
    work: 0,
    carry: 0,
    move: 0,
    attack: 0,
    ranged_attack: 0,
    heal: 0,
    tough: 0,
    claim: 0,
    totalParts: 0,
    text: ''
  };
  if (!body || !body.length) return summary;

  for (var i = 0; i < body.length; i++) {
    var part = String(body[i]);
    if (Object.prototype.hasOwnProperty.call(summary, part)) summary[part]++;
    summary.totalParts++;
  }

  var chunks = [];
  if (summary.work) chunks.push(summary.work + ' WORK');
  if (summary.carry) chunks.push(summary.carry + ' CARRY');
  if (summary.move) chunks.push(summary.move + ' MOVE');
  if (summary.attack) chunks.push(summary.attack + ' ATTACK');
  if (summary.ranged_attack) chunks.push(summary.ranged_attack + ' RANGED_ATTACK');
  if (summary.heal) chunks.push(summary.heal + ' HEAL');
  if (summary.tough) chunks.push(summary.tough + ' TOUGH');
  if (summary.claim) chunks.push(summary.claim + ' CLAIM');
  summary.text = chunks.join(', ');
  return summary;
}

module.exports = {
  calculateBodyCost: calculateBodyCost,
  countBodyParts: countBodyParts,
  cloneBody: cloneBody,
  getBodySignature: getBodySignature,
  summarizeBody: summarizeBody
};
