'use strict';

/**
 * What changed & why:
 * - Expanded the shared action helpers so every economic/combat behavior routes through uniform wrappers.
 * - Added missing combat/controller helpers and documented how movement intents are generated when out of range.
 * - Keeps MOVE centralized by queuing intents with standardized priorities from Movement.Manager.
 */

var MovementManager = require('Movement.Manager');
var MOVE_PRIORITIES = (MovementManager && MovementManager.PRIORITIES) ? MovementManager.PRIORITIES : {};

function normalizePriority(kind, fallback) {
  if (!MOVE_PRIORITIES) return fallback;
  if (MOVE_PRIORITIES[kind] != null) return MOVE_PRIORITIES[kind];
  return fallback;
}

function queueMove(creep, target, range, priority, opts) {
  if (!creep || !target) return;
  var moveOpts = opts || {};
  moveOpts.range = (range != null) ? range : 1;
  var prio = (priority != null) ? priority : normalizePriority(moveOpts.intentType || 'default', 0);
  MovementManager.request(creep, target, prio, moveOpts);
}

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
  safeWithdraw: function (creep, target, resource, opts) {
    if (!creep || !target) return ERR_INVALID_TARGET;
    var resType = resource || RESOURCE_ENERGY;
    var rc = creep.withdraw(target, resType);
    return handleResult(creep, rc, target, 1, 'withdraw', opts);
  },

  safeTransfer: function (creep, target, resource, amount, opts) {
    if (!creep || !target) return ERR_INVALID_TARGET;
    var resType = resource || RESOURCE_ENERGY;
    var rc = (amount == null)
      ? creep.transfer(target, resType)
      : creep.transfer(target, resType, amount);
    return handleResult(creep, rc, target, 1, 'deliver', opts);
  },

  safePickup: function (creep, resource, opts) {
    if (!creep || !resource) return ERR_INVALID_TARGET;
    var rc = creep.pickup(resource);
    return handleResult(creep, rc, resource, 1, 'pickup', opts);
  },

  safeBuild: function (creep, site, opts) {
    if (!creep || !site) return ERR_INVALID_TARGET;
    var rc = creep.build(site);
    return handleResult(creep, rc, site, 3, 'build', opts);
  },

  safeRepair: function (creep, structure, opts) {
    if (!creep || !structure) return ERR_INVALID_TARGET;
    var rc = creep.repair(structure);
    return handleResult(creep, rc, structure, 3, 'repair', opts);
  },

  safeUpgrade: function (creep, controller, opts) {
    if (!creep || !controller) return ERR_INVALID_TARGET;
    var rc = creep.upgradeController(controller);
    return handleResult(creep, rc, controller, 3, 'upgrade', opts);
  },

  safeHarvest: function (creep, source, opts) {
    if (!creep || !source) return ERR_INVALID_TARGET;
    var rc = creep.harvest(source);
    return handleResult(creep, rc, source, 1, 'harvest', opts);
  },

  safeAttack: function (creep, target, opts) {
    if (!creep || !target) return ERR_INVALID_TARGET;
    var rc = creep.attack(target);
    return handleResult(creep, rc, target, 1, 'attack', opts);
  },

  safeRangedAttack: function (creep, target, opts) {
    if (!creep || !target) return ERR_INVALID_TARGET;
    var rc = creep.rangedAttack(target);
    return handleResult(creep, rc, target, 3, 'rangedAttack', opts);
  },

  safeHeal: function (creep, target, opts) {
    if (!creep || !target) return ERR_INVALID_TARGET;
    var rc = creep.heal(target);
    return handleResult(creep, rc, target, 1, 'heal', opts);
  },

  safeRangedHeal: function (creep, target, opts) {
    if (!creep || !target) return ERR_INVALID_TARGET;
    var rc = creep.rangedHeal(target);
    return handleResult(creep, rc, target, 3, 'rangedHeal', opts);
  },

  safeReserveController: function (creep, controller, opts) {
    if (!creep || !controller) return ERR_INVALID_TARGET;
    var rc = creep.reserveController(controller);
    return handleResult(creep, rc, controller, 1, 'reserve', opts);
  },

  safeClaimController: function (creep, controller, opts) {
    if (!creep || !controller) return ERR_INVALID_TARGET;
    var rc = creep.claimController(controller);
    return handleResult(creep, rc, controller, 1, 'claim', opts);
  }
};

module.exports = BeeActions;
