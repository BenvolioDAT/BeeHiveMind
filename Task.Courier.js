'use strict';

/**
 * Task.Courier shuttles energy between harvest infrastructure and consumers.
 * The logic favors clarity over micro-optimizations and is written in ES5 syntax
 * (no const/let, arrow functions, or template strings) per project standards.
 * Movement relies on BeeToolbox.travelTo so that creeps consistently use
 * Traveler.js instead of raw moveTo calls.
 */

var Logger = require('core.logger');
var BeeToolbox = require('BeeToolbox');

var LOG_LEVEL = Logger.LOG_LEVEL;
var courierLog = Logger.createLogger('Task.Courier', LOG_LEVEL.DEBUG);

var MODE_GATHER = 'gather';
var MODE_DELIVER = 'deliver';
var MIN_WITHDRAW_AMOUNT = 50;

/**
 * ensureMode updates creep.memory.mode based on current energy state.
 * Input: creep (Creep).
 * Output: string describing the active mode.
 * Side-effects: writes creep.memory.mode.
 * Reasoning: centralizes the gather/deliver state machine.
 */
function ensureMode(creep) {
  if (!creep.memory) {
    return MODE_GATHER;
  }
  var stored = creep.store ? (creep.store[RESOURCE_ENERGY] | 0) : 0;
  var capacity = creep.store ? (creep.store.getCapacity(RESOURCE_ENERGY) | 0) : 0;
  if (stored <= 0) {
    creep.memory.mode = MODE_GATHER;
  } else if (stored >= capacity) {
    creep.memory.mode = MODE_DELIVER;
  } else if (!creep.memory.mode) {
    creep.memory.mode = MODE_GATHER;
  }
  return creep.memory.mode;
}

/**
 * resolvePickupTarget chooses a new energy source for gather mode.
 * Input: creep (Creep).
 * Output: object containing target (RoomObject) and action string.
 * Side-effects: stores creep.memory.pickupId and pickupAction for reuse.
 */
function resolvePickupTarget(creep) {
  var selection = BeeToolbox.selectEnergyPickupTarget(creep, {
    minAmount: MIN_WITHDRAW_AMOUNT,
    allowStorage: true,
    allowDropped: true
  });
  if (!selection) {
    creep.memory.pickupId = null;
    creep.memory.pickupAction = null;
    return null;
  }
  if (creep.memory) {
    creep.memory.pickupId = selection.target.id;
    creep.memory.pickupAction = selection.action;
  }
  return selection;
}

/**
 * gatherEnergy executes the gather phase behaviour.
 * Input: creep (Creep).
 * Output: boolean indicating whether work was performed this tick.
 * Side-effects: withdraws or picks up energy (https://docs.screeps.com/api/#Creep.withdraw / pickup).
 */
function gatherEnergy(creep) {
  var targetId = creep.memory && creep.memory.pickupId;
  var action = creep.memory && creep.memory.pickupAction;
  var target = targetId ? Game.getObjectById(targetId) : null;

  if (!target) {
    var selection = resolvePickupTarget(creep);
    if (!selection) {
      if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
        courierLog.debug('Courier', creep.name, 'found no pickup target in room', creep.room && creep.room.name);
      }
      return false;
    }
    target = selection.target;
    action = selection.action;
  }

  var range = creep.pos.getRangeTo(target);
  if (range > 1) {
    BeeToolbox.travelTo(creep, target, { range: 1, reusePath: 20 });
    return true;
  }

  var result = ERR_INVALID_ARGS;
  if (action === 'withdraw') {
    result = creep.withdraw(target, RESOURCE_ENERGY);
  } else if (action === 'pickup') {
    result = creep.pickup(target);
  }

  if (result === OK && creep.memory) {
    creep.memory.mode = MODE_DELIVER;
    creep.memory.pickupId = null;
    creep.memory.pickupAction = null;
  } else if (result === ERR_INVALID_TARGET || result === ERR_NOT_ENOUGH_RESOURCES) {
    creep.memory.pickupId = null;
    creep.memory.pickupAction = null;
  }

  return true;
}

/**
 * resolveDropoffTarget chooses where to deliver energy.
 * Input: creep (Creep).
 * Output: structure or null.
 * Side-effects: records creep.memory.dropoffId for reuse.
 */
function resolveDropoffTarget(creep) {
  var target = BeeToolbox.selectEnergyDepositStructure(creep, {
    includeStorage: true,
    includeTowers: true,
    includeLinks: false,
    includeTerminal: false
  });
  if (!target) {
    if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
      courierLog.debug('Courier', creep.name, 'found no drop target in room', creep.room && creep.room.name);
    }
    if (creep.room && creep.room.storage) {
      target = creep.room.storage;
    }
  }
  if (creep.memory) {
    creep.memory.dropoffId = target ? target.id : null;
  }
  return target;
}

/**
 * deliverEnergy executes the delivery phase behaviour.
 * Input: creep (Creep).
 * Output: boolean indicating whether an action was attempted.
 * Side-effects: transfers energy to structures (https://docs.screeps.com/api/#Creep.transfer).
 */
function deliverEnergy(creep) {
  var targetId = creep.memory && creep.memory.dropoffId;
  var target = targetId ? Game.getObjectById(targetId) : null;
  if (!target) {
    target = resolveDropoffTarget(creep);
  }
  if (!target) {
    return false;
  }

  var range = creep.pos.getRangeTo(target);
  if (range > 1) {
    BeeToolbox.travelTo(creep, target, { range: 1, reusePath: 15 });
    return true;
  }

  var result = creep.transfer(target, RESOURCE_ENERGY);
  if (result === OK && creep.memory) {
    creep.memory.dropoffId = null;
  } else if (result === ERR_FULL || result === ERR_INVALID_TARGET) {
    creep.memory.dropoffId = null;
  }
  return true;
}

/**
 * run orchestrates courier behaviour each tick.
 * Input: creep (Creep).
 * Output: none.
 * Side-effects: updates memory, moves, withdraws, and transfers energy.
 */
function runCourier(creep) {
  if (!creep) {
    return;
  }
  if (creep.memory && creep.memory.task !== 'courier') {
    creep.memory.task = 'courier';
  }

  var mode = ensureMode(creep);
  if (mode === MODE_GATHER) {
    gatherEnergy(creep);
  } else {
    deliverEnergy(creep);
  }

  if (creep.memory && (creep.store[RESOURCE_ENERGY] | 0) === 0 && creep.memory.mode === MODE_DELIVER) {
    creep.memory.mode = MODE_GATHER;
  }
}

function runAsHelpers(creep, options) {
  if (!creep) {
    return false;
  }

  var preferDeliverFirst = true;
  if (options && typeof options.preferDeliverFirst !== 'undefined') {
    preferDeliverFirst = options.preferDeliverFirst ? true : false;
  }

  var hadMode = false;
  var originalMode;
  if (creep.memory) {
    hadMode = Object.prototype.hasOwnProperty.call(creep.memory, 'mode');
    originalMode = creep.memory.mode;
  }

  var actionResult = false;

  if (preferDeliverFirst) {
    actionResult = deliverEnergy(creep);
    if (!actionResult) {
      actionResult = gatherEnergy(creep);
    }
  } else {
    actionResult = gatherEnergy(creep);
    if (!actionResult) {
      actionResult = deliverEnergy(creep);
    }
  }

  if (creep.memory) {
    if (hadMode) {
      creep.memory.mode = originalMode;
    } else if (Object.prototype.hasOwnProperty.call(creep.memory, 'mode')) {
      delete creep.memory.mode;
    }
  }

  return actionResult ? true : false;
}

module.exports = {
  run: runCourier,
  runAsHelpers: runAsHelpers,
  resolvePickupTarget: resolvePickupTarget,
  resolveDropoffTarget: resolveDropoffTarget,
  gatherEnergy: gatherEnergy,
  deliverEnergy: deliverEnergy
};
