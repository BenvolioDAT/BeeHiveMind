// -----------------------------------------------------------------------------
// BeeActions.js – safe wrappers around Screeps creep actions
// Responsibilities:
// * Provide consistent range/movement behaviour by funneling ERR_NOT_IN_RANGE
//   responses into Movement.Manager.request, using standard intent priorities.
// * Guard against invalid targets and resource shortages before issuing intents,
//   so calling tasks can respond immediately without extra checks.
// * Centralise priorities via Movement.Manager.PRIORITIES to keep action →
//   movement mapping declarative.
// Consumers: Task.Queen, Task.Builder, combat tasks, BeeHiveMind role loops.
// -----------------------------------------------------------------------------
'use strict';

/**
 * What changed & why:
 * - Expanded the shared action helpers so every economic/combat behavior routes through uniform wrappers.
 * - Added missing combat/controller helpers and documented how movement intents are generated when out of range.
 * - Keeps MOVE centralized by queuing intents with standardized priorities from Movement.Manager.
 */

// Movement manager handles queued moves; safe actions only request movement via
// this module (see Movement.Manager.js for stuck handling).
var MovementManager = require('Movement.Manager');
var MOVE_PRIORITIES = (MovementManager && MovementManager.PRIORITIES) ? MovementManager.PRIORITIES : {};

// Function header: normalizePriority(kind, fallback)
// Inputs: intent kind string, fallback priority number
// Output: numeric priority for movement intents (defaults to fallback if kind
//         not in MovementManager.PRIORITIES).
// Side-effects: none.
function normalizePriority(kind, fallback) {
  if (!MOVE_PRIORITIES) return fallback;
  if (MOVE_PRIORITIES[kind] != null) return MOVE_PRIORITIES[kind];
  return fallback;
}

// Function header: queueMove(creep, target, range, priority, opts)
// Inputs: creep, target (object or RoomPosition), desired range, explicit
//         priority, movement options (reusePath, flee, etc.).
// Output: none.
// Side-effects: pushes intent into MovementManager.request (which dedups per
//               creep). Range defaults to 1 when omitted.
function queueMove(creep, target, range, priority, opts) {
  if (!creep || !target) return;
  var moveOpts = opts || {};
  moveOpts.range = (range != null) ? range : 1;
  var prio = (priority != null) ? priority : normalizePriority(moveOpts.intentType || 'default', 0);
  MovementManager.request(creep, target, prio, moveOpts);
}

// Function header: handleResult(creep, code, target, range, intentKey, opts)
// Inputs: creep, return code from Screeps action, target object/pos, range to
//         aim for, intentKey (string used to look up priority), movement opts.
// Output: original return code.
// Side-effects: when code === ERR_NOT_IN_RANGE, enqueues movement intent using
//               queueMove(). No other codes cause movement.
function handleResult(creep, code, target, range, intentKey, opts) {
  // All wrappers funnel through here so ERR_NOT_IN_RANGE automatically emits a movement intent.
  if (code === ERR_NOT_IN_RANGE) {
    var pr = normalizePriority(intentKey, 0);
    var moveOpts = opts || {};
    moveOpts.intentType = intentKey;
    queueMove(creep, target, range, pr, moveOpts);
  }
  return code;
}

var BeeActions = {
  // Function header: safeWithdraw(creep, target, resource, opts)
  // Inputs: creep, target structure with store, resource type (default energy),
  //         optional movement opts ({priority, reusePath, intentType}).
  // Output: Screeps error code (OK, ERR_NOT_IN_RANGE, ERR_NOT_ENOUGH_RESOURCES,
  //         ERR_FULL, ERR_INVALID_TARGET).
  // Side-effects: may queue movement; does not mutate Memory.
  // Preconditions: caller should ensure creep has CARRY parts.
  safeWithdraw: function (creep, target, resource, opts) {
    if (!creep || !target) return ERR_INVALID_TARGET;
    var resType = resource || RESOURCE_ENERGY;
    if (!target.store || typeof target.store[resType] === 'undefined') return ERR_INVALID_TARGET;
    if ((target.store[resType] | 0) <= 0) return ERR_NOT_ENOUGH_RESOURCES;
    if (creep.store.getFreeCapacity(resType) <= 0) return ERR_FULL;
    var rc = creep.withdraw(target, resType);
    return handleResult(creep, rc, target, 1, 'withdraw', opts);
  },

  // Function header: safeTransfer(creep, target, resource, amount, opts)
  // Inputs: creep, target structure, resource type (default energy), optional
  //         amount (null uses all cargo), movement opts.
  // Output: Screeps return code (OK, ERR_NOT_ENOUGH_RESOURCES, ERR_NOT_IN_RANGE,
  //         ERR_FULL, ERR_INVALID_TARGET).
  // Side-effects: none besides optional move intent.
  // Caller expectation: OK => energy transferred; ERR_NOT_IN_RANGE => move
  // queued and caller should retry next tick.
  safeTransfer: function (creep, target, resource, amount, opts) {
    if (!creep || !target) return ERR_INVALID_TARGET;
    var resType = resource || RESOURCE_ENERGY;
    var carried = creep.store[resType] | 0;
    if (carried <= 0) return ERR_NOT_ENOUGH_RESOURCES;
    var sendAmount = (amount == null) ? carried : Math.min(amount, carried);
    if (sendAmount <= 0) return ERR_NOT_ENOUGH_RESOURCES;
    var rc = (amount == null)
      ? creep.transfer(target, resType)
      : creep.transfer(target, resType, sendAmount);
    return handleResult(creep, rc, target, 1, 'deliver', opts);
  },

  // Function header: safePickup(creep, resource, opts)
  // Inputs: creep, Resource object from ground, movement opts.
  // Output: Screeps return code (OK, ERR_NOT_IN_RANGE, ERR_INVALID_TARGET,
  //         ERR_NOT_ENOUGH_RESOURCES when amount <= 0).
  // Side-effects: may request movement; does not handle logistics beyond pickup.
  safePickup: function (creep, resource, opts) {
    if (!creep || !resource) return ERR_INVALID_TARGET;
    if (resource.resourceType == null || resource.amount == null) return ERR_INVALID_TARGET;
    if (resource.amount <= 0) return ERR_NOT_ENOUGH_RESOURCES;
    var rc = creep.pickup(resource);
    return handleResult(creep, rc, resource, 1, 'pickup', opts);
  },

  // Function header: safeBuild(creep, site, opts)
  // Inputs: creep, ConstructionSite, movement opts.
  // Output: Screeps return code; ERR_NOT_ENOUGH_RESOURCES bubbles through.
  // Side-effects: queues move when out of range (range 3 standard for build).
  safeBuild: function (creep, site, opts) {
    if (!creep || !site) return ERR_INVALID_TARGET;
    var rc = creep.build(site);
    return handleResult(creep, rc, site, 3, 'build', opts);
  },

  // Function header: safeRepair(creep, structure, opts)
  // Inputs: creep, structure needing repair, movement opts.
  // Output: Screeps return code (OK, ERR_NOT_IN_RANGE, ERR_NOT_ENOUGH_RESOURCES,
  //         ERR_INVALID_TARGET).
  safeRepair: function (creep, structure, opts) {
    if (!creep || !structure) return ERR_INVALID_TARGET;
    var rc = creep.repair(structure);
    return handleResult(creep, rc, structure, 3, 'repair', opts);
  },

  // Function header: safeUpgrade(creep, controller, opts)
  // Inputs: creep, room controller, movement opts.
  // Output: Screeps return code (OK, ERR_NOT_ENOUGH_RESOURCES, ERR_NOT_IN_RANGE,
  //         ERR_INVALID_TARGET).
  // Note: Range 3 to match upgrade distance; ensures MovementManager keeps
  // creeps outside RCL3+ upgrades safe zone.
  safeUpgrade: function (creep, controller, opts) {
    if (!creep || !controller) return ERR_INVALID_TARGET;
    var rc = creep.upgradeController(controller);
    return handleResult(creep, rc, controller, 3, 'upgrade', opts);
  },

  // Function header: safeHarvest(creep, source, opts)
  // Inputs: creep, Source/Mineral, movement opts.
  // Output: Screeps return code (OK, ERR_NOT_ENOUGH_RESOURCES when depleted,
  //         ERR_NOT_IN_RANGE, ERR_INVALID_TARGET).
  // Assumes creep has WORK parts; caller must manage seat reservations.
  safeHarvest: function (creep, source, opts) {
    if (!creep || !source) return ERR_INVALID_TARGET;
    var rc = creep.harvest(source);
    return handleResult(creep, rc, source, 1, 'harvest', opts);
  },

  // Function header: safeAttack(creep, target, opts)
  // Inputs: melee creep, hostile target, movement opts (intentType 'attack').
  // Output: Screeps return code; on ERR_NOT_IN_RANGE we queue move with range 1.
  safeAttack: function (creep, target, opts) {
    if (!creep || !target) return ERR_INVALID_TARGET;
    var rc = creep.attack(target);
    return handleResult(creep, rc, target, 1, 'attack', opts);
  },

  // Function header: safeRangedAttack(creep, target, opts)
  // Inputs: creep with RANGED_ATTACK, hostile target, movement opts.
  // Output: Screeps return code; uses range 3 to maintain kite distance.
  safeRangedAttack: function (creep, target, opts) {
    if (!creep || !target) return ERR_INVALID_TARGET;
    var rc = creep.rangedAttack(target);
    return handleResult(creep, rc, target, 3, 'rangedAttack', opts);
  },

  // Function header: safeHeal(creep, target, opts)
  // Inputs: healer creep, injured target, movement opts.
  // Output: Screeps return code; range 1 required for heal.
  safeHeal: function (creep, target, opts) {
    if (!creep || !target) return ERR_INVALID_TARGET;
    var rc = creep.heal(target);
    return handleResult(creep, rc, target, 1, 'heal', opts);
  },

  // Function header: safeRangedHeal(creep, target, opts)
  // Inputs: healer creep, injured target, movement opts.
  // Output: Screeps return code; range 3 for ranged heal.
  safeRangedHeal: function (creep, target, opts) {
    if (!creep || !target) return ERR_INVALID_TARGET;
    var rc = creep.rangedHeal(target);
    return handleResult(creep, rc, target, 3, 'rangedHeal', opts);
  },

  // Function header: safeReserveController(creep, controller, opts)
  // Inputs: claim creep, controller, movement opts.
  // Output: Screeps return code; range 1 for reserve.
  safeReserveController: function (creep, controller, opts) {
    if (!creep || !controller) return ERR_INVALID_TARGET;
    var rc = creep.reserveController(controller);
    return handleResult(creep, rc, controller, 1, 'reserve', opts);
  },

  // Function header: safeClaimController(creep, controller, opts)
  // Inputs: claim creep, controller, movement opts.
  // Output: Screeps return code; includes claim failure codes if controller
  //         owned/reserved.
  safeClaimController: function (creep, controller, opts) {
    if (!creep || !controller) return ERR_INVALID_TARGET;
    var rc = creep.claimController(controller);
    return handleResult(creep, rc, controller, 1, 'claim', opts);
  }
};

module.exports = BeeActions;
