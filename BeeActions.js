'use strict';

/**
 * What changed & why:
 * - Wrapped common creep actions with result checking and movement intent emission so MOVE resolves centrally.
 * - Ensures each wrapper documents preconditions and handles ERR_NOT_IN_RANGE consistently.
 */

var MovementManager = require('Movement.Manager');

function queueMove(creep, target, range, priority, opts) {
  if (!creep || !target) return;
  var moveOpts = opts || {};
  moveOpts.range = (range != null) ? range : 1;
  MovementManager.request(creep, target, priority || 0, moveOpts);
}

function handleResult(creep, code, target, range, priority, opts) {
  if (code === ERR_NOT_IN_RANGE) {
    queueMove(creep, target, range, priority, opts);
  }
  return code;
}

var BeeActions = {
  safeWithdraw: function (creep, target, resource, opts) {
    if (!creep || !target) return ERR_INVALID_TARGET;
    var resType = resource || RESOURCE_ENERGY;
    var rc = creep.withdraw(target, resType);
    return handleResult(creep, rc, target, 1, (opts && opts.priority) || 10, opts);
  },

  safeTransfer: function (creep, target, resource, amount, opts) {
    if (!creep || !target) return ERR_INVALID_TARGET;
    var resType = resource || RESOURCE_ENERGY;
    var rc = (amount == null)
      ? creep.transfer(target, resType)
      : creep.transfer(target, resType, amount);
    return handleResult(creep, rc, target, 1, (opts && opts.priority) || 5, opts);
  },

  safePickup: function (creep, resource, opts) {
    if (!creep || !resource) return ERR_INVALID_TARGET;
    var rc = creep.pickup(resource);
    return handleResult(creep, rc, resource, 1, (opts && opts.priority) || 15, opts);
  },

  safeBuild: function (creep, site, opts) {
    if (!creep || !site) return ERR_INVALID_TARGET;
    var rc = creep.build(site);
    return handleResult(creep, rc, site, 3, (opts && opts.priority) || 0, opts);
  },

  safeRepair: function (creep, structure, opts) {
    if (!creep || !structure) return ERR_INVALID_TARGET;
    var rc = creep.repair(structure);
    return handleResult(creep, rc, structure, 3, (opts && opts.priority) || 0, opts);
  },

  safeUpgrade: function (creep, controller, opts) {
    if (!creep || !controller) return ERR_INVALID_TARGET;
    var rc = creep.upgradeController(controller);
    return handleResult(creep, rc, controller, 3, (opts && opts.priority) || 0, opts);
  },

  safeHarvest: function (creep, source, opts) {
    if (!creep || !source) return ERR_INVALID_TARGET;
    var rc = creep.harvest(source);
    return handleResult(creep, rc, source, 1, (opts && opts.priority) || 20, opts);
  }
};

module.exports = BeeActions;
