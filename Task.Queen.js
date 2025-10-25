'use strict';

/**
 * Task.Queen distributes energy to spawns, extensions, and towers while keeping
 * the controller upgraded when surplus exists. The behaviour mirrors a classic
 * "queen" role: gather energy when empty, then deliver it in priority order.
 * ES5 syntax is used throughout and movement leverages BeeToolbox.travelTo to
 * stay consistent with Traveler.js across the codebase.
 */

var Logger = require('core.logger');
var BeeToolbox = require('BeeToolbox');

var LOG_LEVEL = Logger.LOG_LEVEL;
var queenLog = Logger.createLogger('Task.Queen', LOG_LEVEL.DEBUG);

var MODE_COLLECT = 'collect';
var MODE_FEED = 'feed';
var CONTROLLER_UPGRADE_BUFFER = 100;

/**
 * ensureMode maintains the collect/feed state machine for the queen.
 * Input: creep (Creep).
 * Output: active mode string.
 * Side-effects: writes creep.memory.mode.
 */
function ensureMode(creep) {
  if (!creep.memory) {
    return MODE_COLLECT;
  }
  var stored = creep.store ? (creep.store[RESOURCE_ENERGY] | 0) : 0;
  var capacity = creep.store ? (creep.store.getCapacity(RESOURCE_ENERGY) | 0) : 0;
  if (stored === 0) {
    creep.memory.mode = MODE_COLLECT;
  } else if (stored >= capacity) {
    creep.memory.mode = MODE_FEED;
  } else if (!creep.memory.mode) {
    creep.memory.mode = MODE_COLLECT;
  }
  return creep.memory.mode;
}

/**
 * pickCollectionTarget chooses where the queen should gather energy.
 * Input: creep (Creep).
 * Output: { target, action } or null when no source exists.
 * Side-effects: stores pickup metadata on memory for reuse.
 */
function pickCollectionTarget(creep) {
  var selection = BeeToolbox.selectEnergyPickupTarget(creep, {
    minAmount: 100,
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
 * collectEnergy handles the gathering behaviour for the queen.
 * Input: creep (Creep).
 * Output: boolean, true when an action was attempted.
 * Side-effects: withdraws or picks up energy.
 */
function collectEnergy(creep) {
  var targetId = creep.memory && creep.memory.pickupId;
  var action = creep.memory && creep.memory.pickupAction;
  var target = targetId ? Game.getObjectById(targetId) : null;

  if (!target) {
    var selection = pickCollectionTarget(creep);
    if (!selection) {
      if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
        queenLog.debug('Queen', creep.name, 'found no energy source in', creep.room && creep.room.name);
      }
      return false;
    }
    target = selection.target;
    action = selection.action;
  }

  var range = creep.pos.getRangeTo(target);
  if (range > 1) {
    BeeToolbox.travelTo(creep, target, { range: 1, reusePath: 15 });
    return true;
  }

  var result = ERR_INVALID_ARGS;
  if (action === 'withdraw') {
    result = creep.withdraw(target, RESOURCE_ENERGY);
  } else if (action === 'pickup') {
    result = creep.pickup(target);
  }

  if (result === OK && creep.memory) {
    creep.memory.mode = MODE_FEED;
    creep.memory.pickupId = null;
    creep.memory.pickupAction = null;
  } else if (result === ERR_INVALID_TARGET || result === ERR_NOT_ENOUGH_RESOURCES) {
    creep.memory.pickupId = null;
    creep.memory.pickupAction = null;
  }
  return true;
}

/**
 * pickFeedTarget chooses the best destination for delivery mode.
 * Input: creep (Creep).
 * Output: structure or null.
 * Side-effects: updates creep.memory.dropoffId.
 */
function pickFeedTarget(creep) {
  var target = BeeToolbox.selectEnergyDepositStructure(creep, {
    includeStorage: true,
    includeTowers: true,
    includeLinks: true,
    includeTerminal: false
  });
  if (!target && creep.room && creep.room.storage) {
    target = creep.room.storage;
  }
  if (creep.memory) {
    creep.memory.dropoffId = target ? target.id : null;
  }
  return target;
}

/**
 * feedStructures deposits energy and upgrades the controller when nothing else needs energy.
 * Input: creep (Creep).
 * Output: boolean indicating whether an action occurred.
 * Side-effects: transfers energy or upgrades controller (https://docs.screeps.com/api/#Creep.upgradeController).
 */
function feedStructures(creep) {
  var targetId = creep.memory && creep.memory.dropoffId;
  var target = targetId ? Game.getObjectById(targetId) : null;
  if (!target) {
    target = pickFeedTarget(creep);
  }

  if (target) {
    var range = creep.pos.getRangeTo(target);
    if (range > 1) {
      BeeToolbox.travelTo(creep, target, { range: 1, reusePath: 10 });
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

  if (creep.room && creep.room.controller && creep.room.controller.my) {
    if (creep.pos.getRangeTo(creep.room.controller) > 3) {
      BeeToolbox.travelTo(creep, creep.room.controller.pos, { range: 3, reusePath: 15 });
      return true;
    }
    if ((creep.store[RESOURCE_ENERGY] | 0) > CONTROLLER_UPGRADE_BUFFER) {
      creep.upgradeController(creep.room.controller);
      return true;
    }
  }

  return false;
}

/**
 * run executes the queen behaviour each tick.
 * Input: creep (Creep).
 * Output: none.
 * Side-effects: movement, withdraw, transfer, and controller upgrade intents.
 */
function runQueen(creep) {
  if (!creep) {
    return;
  }
  if (creep.memory && creep.memory.task !== 'queen') {
    creep.memory.task = 'queen';
  }

  var mode = ensureMode(creep);
  if (mode === MODE_COLLECT) {
    collectEnergy(creep);
  } else {
    feedStructures(creep);
  }

  if (creep.memory && (creep.store[RESOURCE_ENERGY] | 0) === 0 && creep.memory.mode === MODE_FEED) {
    creep.memory.mode = MODE_COLLECT;
  }
}

module.exports = {
  run: runQueen
};
