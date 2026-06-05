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

function countBodyPartsFromBody(body) {
  var summary = summarizeBody(body);
  return {
    work: summary.work,
    carry: summary.carry,
    move: summary.move,
    claim: summary.claim,
    attack: summary.attack,
    ranged_attack: summary.ranged_attack,
    heal: summary.heal,
    tough: summary.tough,
    totalParts: summary.totalParts
  };
}

function estimateCarryPartsNeeded(energyPerTick, roundTripTicks) {
  var ept = Math.max(0, Number(energyPerTick) || 0);
  var ticks = Math.max(1, Number(roundTripTicks) || 1);
  return Math.max(1, Math.ceil((ept * ticks) / CARRY_CAPACITY));
}

function estimateMovePartsNeeded(carryParts, roadCoveragePct) {
  var carry = Math.max(1, Math.ceil(Number(carryParts) || 1));
  var coverage = Math.max(0, Math.min(1, Number(roadCoveragePct) || 0));
  return coverage >= 0.75 ? Math.max(1, Math.ceil(carry / 2)) : carry;
}

function buildCarryMoveBody(carryParts, moveParts) {
  var body = [];
  var carry = Math.max(1, Math.ceil(Number(carryParts) || 1));
  var move = Math.max(1, Math.ceil(Number(moveParts) || 1));
  while (carry + move > 50) {
    if (carry >= move && carry > 1) carry--;
    else if (move > 1) move--;
    else break;
  }
  for (var c = 0; c < carry; c++) body.push(CARRY);
  for (var m = 0; m < move; m++) body.push(MOVE);
  return body;
}

function estimateHaulerThroughput(body, pathCost, roadCoveragePct) {
  var parts = countBodyPartsFromBody(body);
  var coverage = Math.max(0, Math.min(1, Number(roadCoveragePct) || 0));
  var oneWay = Math.max(1, Number(pathCost) || 50);
  var fatigueMultiplier = coverage >= 0.75 ? 1 : 1.5;
  var roundTrip = Math.max(1, oneWay * 2 * fatigueMultiplier);
  return {
    carryCapacity: parts.carry * CARRY_CAPACITY,
    roundTripTicks: roundTrip,
    energyPerTick: (parts.carry * CARRY_CAPACITY) / roundTrip
  };
}

function getBestTruckerBodyPlan(energy, context) {
  context = context || {};
  var budget = Math.max(0, Number(context.maxCost || energy) || 0);
  var available = Math.max(0, Number(energy) || 0);
  budget = Math.min(budget || available, available);
  if (budget <= 0) return null;

  var desiredCarry = Math.max(1, Math.ceil(Number(context.desiredCarryParts) || (context.mode === 'remote' ? 6 : 2)));
  var roadCoverage = context.roaded ? 1 : Math.max(0, Math.min(1, Number(context.roadCoveragePct) || 0));
  var desiredMove = Math.max(1, Math.ceil(Number(context.desiredMoveParts) || estimateMovePartsNeeded(desiredCarry, roadCoverage)));

  while (desiredCarry >= 1) {
    var body = buildCarryMoveBody(desiredCarry, desiredMove);
    var cost = calculateBodyCost(body);
    if (cost <= budget) {
      return {
        body: body,
        cost: cost,
        carryParts: countBodyParts(body, CARRY),
        moveParts: countBodyParts(body, MOVE),
        reason: context.bodyPatternReason || (roadCoverage >= 0.75 ? 'roaded-carry-carry-move' : 'offroad-carry-move')
      };
    }
    desiredCarry--;
    desiredMove = Math.max(1, Math.ceil(Number(context.desiredMoveParts) || estimateMovePartsNeeded(desiredCarry, roadCoverage)));
  }
  return null;
}

function getBestUpgraderBodyPlan(energy, targetWork, context) {
  context = context || {};
  var budget = Math.min(Math.max(0, Number(energy) || 0), Math.max(0, Number(context.maxCost || energy) || 0));
  var desiredWork = Math.max(1, Math.ceil(Number(targetWork) || 1));
  while (desiredWork >= 1) {
    var carry = Math.max(1, Math.ceil(desiredWork / 3));
    var move = Math.max(1, Math.ceil((desiredWork + carry) / 2));
    var body = [];
    for (var w = 0; w < desiredWork; w++) body.push(WORK);
    for (var c = 0; c < carry; c++) body.push(CARRY);
    for (var m = 0; m < move; m++) body.push(MOVE);
    while (body.length > 50) body.pop();
    var cost = calculateBodyCost(body);
    if (cost <= budget) {
      return {
        body: body,
        cost: cost,
        workParts: countBodyParts(body, WORK),
        carryParts: countBodyParts(body, CARRY),
        moveParts: countBodyParts(body, MOVE),
        reason: context.bodyPatternReason || 'target-upgrade-work'
      };
    }
    desiredWork--;
  }
  return null;
}

function buildWorkCarryMoveBody(workParts, carryParts, moveParts) {
  var body = [];
  var work = Math.max(1, Math.ceil(Number(workParts) || 1));
  var carry = Math.max(1, Math.ceil(Number(carryParts) || 1));
  var move = Math.max(1, Math.ceil(Number(moveParts) || 1));

  while (work + carry + move > 50) {
    if (move > 1) move--;
    else if (work > 1) work--;
    else if (carry > 1) carry--;
    else break;
  }

  for (var w = 0; w < work; w++) body.push(WORK);
  for (var c = 0; c < carry; c++) body.push(CARRY);
  for (var m = 0; m < move; m++) body.push(MOVE);
  return body;
}

function getBestVeinseekerBodyPlan(energy, targetWork, context) {
  // Veinseekers are source-bound miners. When a source is short by 2 WORK,
  // this builder tries to make a 2-WORK miner instead of always waiting for
  // one oversized creep. That lets several smaller miners cover one source.
  context = context || {};
  var available = Math.max(0, Number(energy) || 0);
  var maxCost = Math.max(0, Number(context.maxCost || available) || 0);
  var budget = Math.min(available, maxCost || available);
  var desiredWork = Math.max(1, Math.ceil(Number(targetWork) || 1));
  var minimumWork = Math.max(1, Math.ceil(Number(context.minimumWorkPartsPerCreep) || 1));
  var carryParts = Math.max(1, Math.ceil(Number(context.carryParts) || 1));
  var remote = context.mode === 'remote';
  var maxWork = Math.min(48, desiredWork);
  var fallback = null;

  for (var work = maxWork; work >= 1; work--) {
    var moveParts = remote
      ? Math.max(1, work + carryParts)
      : Math.max(1, Math.ceil((work + carryParts) / 2));
    var body = buildWorkCarryMoveBody(work, carryParts, moveParts);
    var cost = calculateBodyCost(body);
    if (cost > budget) continue;

    var plan = {
      body: body,
      cost: cost,
      workParts: countBodyParts(body, WORK),
      carryParts: countBodyParts(body, CARRY),
      moveParts: countBodyParts(body, MOVE),
      reason: context.bodyPatternReason || (remote ? 'remote-source-work-deficit' : 'home-source-work-deficit')
    };

    if (plan.workParts >= minimumWork) return plan;
    if (!fallback) fallback = plan;
  }

  return fallback;
}

module.exports = {
  calculateBodyCost: calculateBodyCost,
  countBodyParts: countBodyParts,
  cloneBody: cloneBody,
  getBodySignature: getBodySignature,
  summarizeBody: summarizeBody,
  countBodyPartsFromBody: countBodyPartsFromBody,
  estimateCarryPartsNeeded: estimateCarryPartsNeeded,
  estimateMovePartsNeeded: estimateMovePartsNeeded,
  estimateHaulerThroughput: estimateHaulerThroughput,
  getBestTruckerBodyPlan: getBestTruckerBodyPlan,
  getBestUpgraderBodyPlan: getBestUpgraderBodyPlan,
  getBestVeinseekerBodyPlan: getBestVeinseekerBodyPlan
};
