'use strict';

/**
 * Task.Courier shuttles energy between harvest infrastructure and consumers.
 * The logic favors clarity over micro-optimizations and is written in ES5 syntax
 * (no const/let, arrow functions, or template strings) per project standards.
 * Movement relies on the local travelTo helper so that creeps consistently use
 * Traveler.js instead of raw moveTo calls.
 */

var Logger = require('core.logger');
var Traveler = require('Traveler');

var DEFAULT_TRAVEL_REUSE = 15;
var DEFAULT_TRAVEL_RANGE = 1;
var DEFAULT_TRAVEL_STUCK = 2;
var DEFAULT_TRAVEL_REPATH = 0.1;
var DEFAULT_TRAVEL_MAX_OPS = 4000;
var DEFAULT_TOWER_REFILL_THRESHOLD = 0.7;

var _roomEnergyCache = global.__beeEnergyRoomCache || (global.__beeEnergyRoomCache = {
  tick: 0,
  rooms: {}
});

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
  var selection = selectEnergyPickupTarget(creep, {
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
    travelTo(creep, target, { range: 1, reusePath: 20 });
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
  var target = selectEnergyDepositStructure(creep, {
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
    travelTo(creep, target, { range: 1, reusePath: 15 });
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

function travelTo(creep, destination, options) {
  if (!creep || !destination) {
    return ERR_INVALID_ARGS;
  }
  var targetPos = destination.pos || destination;
  if (!targetPos || typeof targetPos.x !== 'number' || typeof targetPos.y !== 'number') {
    return ERR_INVALID_ARGS;
  }
  var config = options || {};
  var travelOptions = {
    range: config.range != null ? config.range : DEFAULT_TRAVEL_RANGE,
    reusePath: config.reusePath != null ? config.reusePath : DEFAULT_TRAVEL_REUSE,
    ignoreCreeps: config.ignoreCreeps === true,
    stuckValue: config.stuckValue != null ? config.stuckValue : DEFAULT_TRAVEL_STUCK,
    repath: config.repath != null ? config.repath : DEFAULT_TRAVEL_REPATH,
    maxOps: config.maxOps != null ? config.maxOps : DEFAULT_TRAVEL_MAX_OPS
  };
  if (!travelOptions.roomCallback) {
    if (config.roomCallback) {
      travelOptions.roomCallback = config.roomCallback;
    } else if (typeof global !== 'undefined' && typeof global.__beeRoomCallback === 'function') {
      travelOptions.roomCallback = global.__beeRoomCallback;
    }
  }
  if (typeof creep.travelTo === 'function') {
    return creep.travelTo(targetPos, travelOptions);
  }
  if (Traveler && typeof Traveler.travelTo === 'function') {
    return Traveler.travelTo(creep, targetPos, travelOptions);
  }
  if (typeof creep.moveTo === 'function') {
    return creep.moveTo(targetPos, travelOptions);
  }
  return ERR_INVALID_ARGS;
}

function selectEnergyPickupTarget(creep, options) {
  if (!creep || !creep.room) {
    return null;
  }
  var config = options || {};
  var minAmount = config.minAmount != null ? config.minAmount : 50;
  var profile = ensureRoomEnergyProfile(creep.room);
  if (profile.tombstones.length > 0) {
    sortByStoredEnergyDescending(profile.tombstones);
    return { target: profile.tombstones[0], action: 'withdraw' };
  }
  if (profile.ruins.length > 0) {
    sortByStoredEnergyDescending(profile.ruins);
    return { target: profile.ruins[0], action: 'withdraw' };
  }
  if (config.allowDropped !== false) {
    if (profile.droppedLarge.length > 0) {
      sortDroppedDescending(profile.droppedLarge);
      return { target: profile.droppedLarge[0], action: 'pickup' };
    }
    if (profile.dropped.length > 0 && minAmount <= 0) {
      sortDroppedDescending(profile.dropped);
      return { target: profile.dropped[0], action: 'pickup' };
    }
  }
  if (profile.sourceContainers.length > 0) {
    sortByStoredEnergyDescending(profile.sourceContainers);
    if ((profile.sourceContainers[0].store[RESOURCE_ENERGY] | 0) >= minAmount) {
      return { target: profile.sourceContainers[0], action: 'withdraw' };
    }
  }
  if (profile.sideContainers.length > 0) {
    sortByStoredEnergyDescending(profile.sideContainers);
    if ((profile.sideContainers[0].store[RESOURCE_ENERGY] | 0) >= minAmount) {
      return { target: profile.sideContainers[0], action: 'withdraw' };
    }
  }
  if (config.allowStorage !== false) {
    if (profile.storage && (profile.storage.store[RESOURCE_ENERGY] | 0) >= minAmount) {
      return { target: profile.storage, action: 'withdraw' };
    }
    if (profile.terminal && (profile.terminal.store[RESOURCE_ENERGY] | 0) >= minAmount) {
      return { target: profile.terminal, action: 'withdraw' };
    }
  }
  if (profile.dropped.length > 0) {
    sortDroppedDescending(profile.dropped);
    return { target: profile.dropped[0], action: 'pickup' };
  }
  return null;
}

function selectEnergyDepositStructure(creep, options) {
  if (!creep || !creep.room) {
    return null;
  }
  var config = options || {};
  var profile = ensureRoomEnergyProfile(creep.room);
  var includeTowers = config.includeTowers !== false;
  var includeLinks = config.includeLinks === true;
  var includeStorage = config.includeStorage !== false;
  var includeTerminal = config.includeTerminal === true;

  function nearest(list) {
    var best = null;
    var bestRange = Infinity;
    for (var i = 0; i < list.length; i++) {
      var structure = list[i];
      if (!structure) {
        continue;
      }
      var free = structure.store ? (structure.store.getFreeCapacity(RESOURCE_ENERGY) | 0) : 0;
      if (free <= 0) {
        continue;
      }
      var range = creep.pos.getRangeTo(structure);
      if (range < bestRange) {
        bestRange = range;
        best = structure;
      }
    }
    return best;
  }

  var spawnTargets = [];
  var i;
  for (i = 0; i < profile.spawnsNeeding.length; i++) {
    spawnTargets.push(profile.spawnsNeeding[i]);
  }
  for (i = 0; i < profile.extensionsNeeding.length; i++) {
    spawnTargets.push(profile.extensionsNeeding[i]);
  }
  var closestPriority = nearest(spawnTargets);
  if (closestPriority) {
    return closestPriority;
  }

  if (includeTowers && profile.towersNeeding.length > 0) {
    var tower = nearest(profile.towersNeeding);
    if (tower) {
      return tower;
    }
  }

  if (includeLinks && profile.linksNeeding.length > 0) {
    var link = nearest(profile.linksNeeding);
    if (link) {
      return link;
    }
  }

  if (includeStorage && profile.storage) {
    if ((profile.storage.store.getFreeCapacity(RESOURCE_ENERGY) | 0) > 0) {
      return profile.storage;
    }
  }

  if (includeTerminal && profile.terminal) {
    if ((profile.terminal.store.getFreeCapacity(RESOURCE_ENERGY) | 0) > 0) {
      return profile.terminal;
    }
  }

  if (profile.sideContainersAvailable.length > 0) {
    var container = nearest(profile.sideContainersAvailable);
    if (container) {
      return container;
    }
  }

  return null;
}

function ensureRoomEnergyProfile(room) {
  if (!room) {
    return buildEnergyProfile(null);
  }
  if (_roomEnergyCache.tick !== Game.time) {
    _roomEnergyCache.tick = Game.time;
    _roomEnergyCache.rooms = {};
  }
  var cached = _roomEnergyCache.rooms[room.name];
  if (cached && cached.scannedAt === Game.time) {
    return cached.profile;
  }
  var profile = buildEnergyProfile(room);
  _roomEnergyCache.rooms[room.name] = {
    scannedAt: Game.time,
    profile: profile
  };
  return profile;
}

function buildEnergyProfile(room) {
  var profile = {
    room: room,
    dropped: [],
    droppedLarge: [],
    tombstones: [],
    ruins: [],
    sourceContainers: [],
    sideContainers: [],
    sideContainersAvailable: [],
    spawnsNeeding: [],
    extensionsNeeding: [],
    towersNeeding: [],
    linksNeeding: [],
    storage: room ? room.storage : null,
    terminal: room ? room.terminal : null
  };
  if (!room) {
    return profile;
  }
  var dropped = room.find(FIND_DROPPED_RESOURCES, {
    filter: function (resource) {
      return resource.resourceType === RESOURCE_ENERGY && resource.amount > 0;
    }
  });
  var i;
  for (i = 0; i < dropped.length; i++) {
    var drop = dropped[i];
    profile.dropped.push(drop);
    if (drop.amount >= 150) {
      profile.droppedLarge.push(drop);
    }
  }
  profile.tombstones = room.find(FIND_TOMBSTONES, {
    filter: function (stone) {
      return stone.store && (stone.store[RESOURCE_ENERGY] | 0) > 0;
    }
  });
  profile.ruins = room.find(FIND_RUINS, {
    filter: function (ruin) {
      return ruin.store && (ruin.store[RESOURCE_ENERGY] | 0) > 0;
    }
  });
  var containers = room.find(FIND_STRUCTURES, {
    filter: function (structure) {
      return structure.structureType === STRUCTURE_CONTAINER;
    }
  });
  for (i = 0; i < containers.length; i++) {
    var container = containers[i];
    var energy = container.store ? (container.store[RESOURCE_ENERGY] | 0) : 0;
    if (container.pos.findInRange(FIND_SOURCES, 1).length > 0) {
      if (energy > 0) {
        profile.sourceContainers.push(container);
      }
    } else {
      if (energy > 0) {
        profile.sideContainers.push(container);
      }
      if (container.store && (container.store.getFreeCapacity(RESOURCE_ENERGY) | 0) > 0) {
        profile.sideContainersAvailable.push(container);
      }
    }
  }
  var structures = room.find(FIND_MY_STRUCTURES);
  for (i = 0; i < structures.length; i++) {
    var structure = structures[i];
    if (structure.structureType === STRUCTURE_SPAWN) {
      if ((structure.store.getFreeCapacity(RESOURCE_ENERGY) | 0) > 0) {
        profile.spawnsNeeding.push(structure);
      }
    } else if (structure.structureType === STRUCTURE_EXTENSION) {
      if ((structure.store.getFreeCapacity(RESOURCE_ENERGY) | 0) > 0) {
        profile.extensionsNeeding.push(structure);
      }
    } else if (structure.structureType === STRUCTURE_TOWER) {
      var used = (structure.store.getUsedCapacity(RESOURCE_ENERGY) | 0);
      var capacity = (structure.store.getCapacity(RESOURCE_ENERGY) | 0);
      if (capacity > 0 && used <= capacity * DEFAULT_TOWER_REFILL_THRESHOLD) {
        profile.towersNeeding.push(structure);
      }
    } else if (structure.structureType === STRUCTURE_LINK) {
      if ((structure.store.getFreeCapacity(RESOURCE_ENERGY) | 0) > 0) {
        profile.linksNeeding.push(structure);
      }
    }
  }
  return profile;
}

function sortByStoredEnergyDescending(list) {
  list.sort(function (a, b) {
    var aEnergy = a.store ? (a.store[RESOURCE_ENERGY] | 0) : 0;
    var bEnergy = b.store ? (b.store[RESOURCE_ENERGY] | 0) : 0;
    return bEnergy - aEnergy;
  });
}

function sortDroppedDescending(list) {
  list.sort(function (a, b) {
    return b.amount - a.amount;
  });
}
