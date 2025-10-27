var CoreConfig = require('core.config');
var CoreSpawn = require('core.spawn');

var Logger = require('core.logger');
var TaskCourier = require('Task.Courier');

var LOG_LEVEL = Logger.LOG_LEVEL;
var queenLog = Logger.createLogger('Task.Queen', LOG_LEVEL.DEBUG);

var QueenSettings = CoreConfig.settings['Task.Queen'];

var MODE_COLLECT = 'collect';
var MODE_FEED = 'feed';
var ENABLE_COURIER_FALLBACK = QueenSettings.ENABLE_COURIER_FALLBACK;

var Traveler = null;
try {
  Traveler = require('Traveler');
} catch (travelerError) {
  Traveler = null;
}

var DEFAULT_TRAVEL_RANGE = QueenSettings.DEFAULT_TRAVEL_RANGE;
var DEFAULT_TRAVEL_REUSE = QueenSettings.DEFAULT_TRAVEL_REUSE;
var DEFAULT_TRAVEL_STUCK = QueenSettings.DEFAULT_TRAVEL_STUCK;
var DEFAULT_TRAVEL_REPATH = QueenSettings.DEFAULT_TRAVEL_REPATH;
var DEFAULT_TRAVEL_MAX_OPS = QueenSettings.DEFAULT_TRAVEL_MAX_OPS;
var DEFAULT_TOWER_REFILL_THRESHOLD = QueenSettings.DEFAULT_TOWER_REFILL_THRESHOLD;

var ROOM_CACHE_KEY = '__queenRoomEnergy';
var THROTTLE_CACHE_KEY = '__queenLogThrottle';

function getGlobalCache(key, fallback) {
  if (!global[key]) {
    global[key] = fallback;
  }
  return global[key];
}

function shouldLogThrottled(store, key, interval) {
  if (!store || !key) {
    return true;
  }
  var now = Game.time | 0;
  var last = store[key] || 0;
  if (interval > 0 && now - last < interval) {
    return false;
  }
  store[key] = now;
  return true;
}

function isValidRoomName(name) {
  if (typeof name !== 'string') {
    return false;
  }
  return /^[WE]\d+[NS]\d+$/.test(name);
}

function resolveRoomName(room) {
  if (!room) {
    return null;
  }
  if (typeof room === 'string') {
    return isValidRoomName(room) ? room : null;
  }
  if (room.name && isValidRoomName(room.name)) {
    return room.name;
  }
  return null;
}

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
    var stored = container.store ? (container.store[RESOURCE_ENERGY] | 0) : 0;
    if (container.pos.findInRange(FIND_SOURCES, 1).length > 0) {
      if (stored > 0) {
        profile.sourceContainers.push(container);
      }
    } else {
      if (stored > 0) {
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

function getRoomEnergyProfile(room) {
  var cache = getGlobalCache(ROOM_CACHE_KEY, { tick: -1, rooms: {} });
  if (!room) {
    return buildEnergyProfile(null);
  }
  if (cache.tick !== Game.time) {
    cache.tick = Game.time;
    cache.rooms = {};
  }
  var cached = cache.rooms[room.name];
  if (cached && cached.scannedAt === Game.time) {
    return cached.profile;
  }
  var profile = buildEnergyProfile(room);
  cache.rooms[room.name] = { scannedAt: Game.time, profile: profile };
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

function nearestNeedingEnergy(creep, list) {
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

function selectEnergyPickupTarget(creep, options) {
  if (!creep || !creep.room) {
    return null;
  }
  var config = options || {};
  var minAmount = config.minAmount != null ? config.minAmount : 50;
  var profile = getRoomEnergyProfile(creep.room);

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
  var profile = getRoomEnergyProfile(creep.room);
  var includeTowers = config.includeTowers !== false;
  var includeLinks = config.includeLinks === true;
  var includeStorage = config.includeStorage !== false;
  var includeTerminal = config.includeTerminal === true;

  var spawnTargets = [];
  var i;
  for (i = 0; i < profile.spawnsNeeding.length; i++) {
    spawnTargets.push(profile.spawnsNeeding[i]);
  }
  for (i = 0; i < profile.extensionsNeeding.length; i++) {
    spawnTargets.push(profile.extensionsNeeding[i]);
  }
  var closestPriority = nearestNeedingEnergy(creep, spawnTargets);
  if (closestPriority) {
    return closestPriority;
  }

  if (includeTowers && profile.towersNeeding.length > 0) {
    var tower = nearestNeedingEnergy(creep, profile.towersNeeding);
    if (tower) {
      return tower;
    }
  }

  if (includeLinks && profile.linksNeeding.length > 0) {
    var link = nearestNeedingEnergy(creep, profile.linksNeeding);
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
    var container = nearestNeedingEnergy(creep, profile.sideContainersAvailable);
    if (container) {
      return container;
    }
  }

  return null;
}

function getQueenSettings(room) {
  var base = global.__beeEconomyConfig || null;
  if (!base) {
    base = {
      queen: {
        allowCourierFallback: true
      }
    };
    global.__beeEconomyConfig = base;
  }
  var queenCfg = base.queen || {};
  var allowFallback = (typeof queenCfg.allowCourierFallback === 'boolean') ? queenCfg.allowCourierFallback : true;

  var roomName = resolveRoomName(room);
  var override = null;
  if (room && room.memory && room.memory.econ && room.memory.econ.queen) {
    override = room.memory.econ.queen;
  } else if (roomName && Memory && Memory.rooms && Memory.rooms[roomName] && Memory.rooms[roomName].econ && Memory.rooms[roomName].econ.queen) {
    override = Memory.rooms[roomName].econ.queen;
  }
  if (override && typeof override.allowCourierFallback === 'boolean') {
    allowFallback = override.allowCourierFallback;
  }

  return { allowCourierFallback: allowFallback };
}

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
  var selection = selectEnergyPickupTarget(creep, {
    minAmount: 100,
    allowStorage: true,
    allowDropped: true
  });
  if (!selection) {
    if (creep.memory) {
      creep.memory.pickupId = null;
      creep.memory.pickupAction = null;
    }
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
      return false;
    }
    target = selection.target;
    action = selection.action;
  }

  var range = creep.pos.getRangeTo(target);
  if (range > 1) {
    travelTo(creep, target, { range: 1, reusePath: 15 });
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
  var target = selectEnergyDepositStructure(creep, {
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
 * feedStructures deposits energy and, when no direct targets exist, optionally
 * falls back to courier-style helper actions.
 * Input: creep (Creep).
 * Output: boolean indicating whether an action occurred.
 * Side-effects: transfers energy or performs courier helper actions.
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
      travelTo(creep, target, { range: 1, reusePath: 10 });
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

  var econSettings = getQueenSettings(creep && creep.room);
  var allowFallback = ENABLE_COURIER_FALLBACK;
  if (econSettings && typeof econSettings.allowCourierFallback === 'boolean') {
    allowFallback = econSettings.allowCourierFallback;
  }
  if (allowFallback && TaskCourier && typeof TaskCourier.runAsHelpers === 'function') {
    var courierResult = TaskCourier.runAsHelpers(creep, { preferDeliverFirst: true });
    if (courierResult) {
      return true;
    }
  }

  if (creep.room && creep.room.storage) {
    travelTo(creep, creep.room.storage, { range: 2, maxRooms: 1, reusePath: 20 });
    return true;
  }

  return false;
}

/**
 * run executes the queen behaviour each tick.
 * Input: creep (Creep).
 * Output: none.
 * Side-effects: movement, withdraw, transfer, and optional courier helper intents.
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
    if (!collectEnergy(creep)) {
      var throttleCache = getGlobalCache(THROTTLE_CACHE_KEY, Object.create(null));
      if (Logger.shouldLog(LOG_LEVEL.DEBUG) && shouldLogThrottled(throttleCache, creep.id || creep.name, 5)) {
        queenLog.debug('Queen', creep.name, 'found no energy source in', creep.room && creep.room.name);
      }
    }
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

function queenBody(carryCount, moveCount) {
  var body = [];
  var i;
  for (i = 0; i < carryCount; i++) {
    body.push(CARRY);
  }
  for (i = 0; i < moveCount; i++) {
    body.push(MOVE);
  }
  return body;
}

var QUEEN_BODY_TIERS = [
  queenBody(22, 22),
  queenBody(21, 21),
  queenBody(20, 20),
  queenBody(19, 19),
  queenBody(18, 18),
  queenBody(17, 17),
  queenBody(16, 16),
  queenBody(15, 15),
  queenBody(14, 14),
  queenBody(13, 13),
  queenBody(12, 12),
  queenBody(11, 11),
  queenBody(10, 10),
  queenBody(9, 9),
  queenBody(8, 8),
  queenBody(7, 7),
  queenBody(6, 6),
  queenBody(5, 5),
  queenBody(4, 4),
  queenBody(3, 3),
  queenBody(2, 2),
  queenBody(1, 1)
];

module.exports.BODY_TIERS = QUEEN_BODY_TIERS.map(function (tier) { return tier.slice(); });
module.exports.getSpawnBody = function (energy) {
  return CoreSpawn.pickLargestAffordable(QUEEN_BODY_TIERS, energy);
};
module.exports.getSpawnSpec = function (room, ctx) {
  var context = ctx || {};
  var energy = context && typeof context.availableEnergy === 'number' ? context.availableEnergy : 0;
  var body = module.exports.getSpawnBody(energy, room, context);
  return {
    body: body,
    namePrefix: 'queen',
    memory: {
      role: 'Worker_Bee',
      task: 'queen',
      home: room && room.name
    }
  };
};
