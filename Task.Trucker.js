var CoreConfig = require('core.config');

// Task.Trucker.js
var Traveler = null;
try {
  Traveler = require('Traveler');
} catch (error) {
  Traveler = null;
}

var TaskCourier = null;
try {
  TaskCourier = require('Task.Courier');
} catch (error) {
  TaskCourier = null;
}

var TaskTruckerSettings = CoreConfig.settings['Task.Trucker'];

var PICKUP_FLAG_DEFAULT = TaskTruckerSettings.PICKUP_FLAG_DEFAULT;
var MIN_DROPPED = TaskTruckerSettings.MIN_DROPPED;
var LOCAL_SEARCH_RADIUS = TaskTruckerSettings.LOCAL_SEARCH_RADIUS;
var WIDE_SEARCH_RADIUS = TaskTruckerSettings.WIDE_SEARCH_RADIUS;
var WIDE_SEARCH_COOLDOWN = TaskTruckerSettings.WIDE_SEARCH_COOLDOWN;
var ALLOWED_RESOURCE_TYPES = (TaskTruckerSettings && TaskTruckerSettings.ALLOWED_RESOURCES) ? TaskTruckerSettings.ALLOWED_RESOURCES : [RESOURCE_ENERGY, RESOURCE_POWER];
var PARK_POS = new RoomPosition(25, 25, 'W0N0'); // only used if no flag & no home; harmless

var GLOBAL_TRUCKER_CACHE = global.__TRUCKER_CACHE || (global.__TRUCKER_CACHE = { rooms: {} });

function isAllowedResource(resourceType) {
  if (!ALLOWED_RESOURCE_TYPES || !ALLOWED_RESOURCE_TYPES.length) {
    return resourceType === RESOURCE_ENERGY || resourceType === RESOURCE_POWER;
  }
  for (var i = 0; i < ALLOWED_RESOURCE_TYPES.length; i++) {
    if (ALLOWED_RESOURCE_TYPES[i] === resourceType) {
      return true;
    }
  }
  return false;
}

function updateReturnState(creep) {
  if (!creep) return;
  var used = creep.store.getUsedCapacity();
  if (creep.memory.returning) {
    if (used === 0) {
      creep.memory.returning = false;
    }
  } else if (creep.store.getFreeCapacity() === 0) {
    creep.memory.returning = true;
  }
}

function travelTo(creep, target, range, reuse) {
  if (!creep || !target) {
    return ERR_INVALID_TARGET;
  }

  var destination = (target && target.pos) ? target.pos : target;
  var options = { range: (typeof range === 'number') ? range : 1 };

  if (Traveler && typeof Traveler.travelTo === 'function') {
    try {
      return Traveler.travelTo(creep, destination, options);
    } catch (error) {
      // fall through to vanilla move
    }
  }

  var pos = destination;
  if (!pos || pos.x == null || pos.y == null) {
    return ERR_INVALID_TARGET;
  }

  if (!(pos instanceof RoomPosition)) {
    pos = new RoomPosition(pos.x, pos.y, pos.roomName || creep.room.name);
  }

  var moveOpts = { reusePath: (typeof reuse === 'number') ? reuse : 10, maxOps: 2000 };
  return creep.moveTo(pos, moveOpts);
}

/* === FIX: Trucker wide scan throttling === */
function getWideScanCache(roomName) {
  if (!roomName) {
    return null;
  }
  var rooms = GLOBAL_TRUCKER_CACHE.rooms;
  if (!rooms[roomName]) {
    rooms[roomName] = { nextScan: 0, ids: [] };
  }
  return rooms[roomName];
}

function refreshWideScan(flagPos, cache) {
  if (!flagPos || !cache) {
    return;
  }
  var now = Game.time | 0;
  if (cache.nextScan > now) {
    return;
  }
  cache.nextScan = now + WIDE_SEARCH_COOLDOWN;
  var found = flagPos.findInRange(FIND_DROPPED_RESOURCES, WIDE_SEARCH_RADIUS, {
    filter: function (r) {
      return isAllowedResource(r.resourceType) && r.amount >= MIN_DROPPED;
    }
  }) || [];
  var ids = [];
  for (var i = 0; i < found.length; i++) {
    ids.push(found[i].id);
  }
  cache.ids = ids;
  cache.lastScan = now;
}

function collectCachedWideDrops(cache) {
  if (!cache || !cache.ids || !cache.ids.length) {
    return [];
  }
  var keep = [];
  var drops = [];
  for (var i = 0; i < cache.ids.length; i++) {
    var drop = Game.getObjectById(cache.ids[i]);
    if (!drop || !isAllowedResource(drop.resourceType) || drop.amount < MIN_DROPPED) {
      continue;
    }
    drops.push(drop);
    keep.push(cache.ids[i]);
  }
  cache.ids = keep;
  return drops;
}

var TaskTrucker = {
  run: function (creep) {
    if (creep.spawning) return;

    // choose flag once
    if (!creep.memory.pickupFlag) {
      creep.memory.pickupFlag = PICKUP_FLAG_DEFAULT;
    }

    // pick a home if none (use your first spawn room memory when available)
    if (!creep.memory.homeRoom) {
      creep.memory.homeRoom = Memory.firstSpawnRoom || creep.room.name;
    }

    // mode switch (fill → return)
    updateReturnState(creep);

    if (creep.memory.returning) {
      return this.returnToStorage(creep);
    } else {
      return this.collectFromFlagRoom(creep);
    }
  },

  collectFromFlagRoom: function (creep) {
    var flag = Game.flags[creep.memory.pickupFlag];
    if (!flag) {
      // fail-safe: no flag? just head home and idle
      creep.say('❓Flag');
      var fallbackRoom = creep.memory.homeRoom || PARK_POS.roomName;
      var fallback = new RoomPosition(25, 25, fallbackRoom);
      if (!creep.pos.inRangeTo(fallback, 1)) {
        travelTo(creep, fallback);
      }
      return;
    }

    // travel cross-room to the flag
    if (creep.room.name !== flag.pos.roomName) {
      travelTo(creep, flag.pos);
      creep.say('🚛➡️📍');
      return;
    }

    // we’re in the flag room; look for juicy piles near the flag
    var flagPos = flag.pos;

    var wideCache = getWideScanCache(flagPos.roomName);
    refreshWideScan(flagPos, wideCache);

    var droppedMap = Object.create(null);
    var candidates = [];
    var dropped = flagPos.findInRange(FIND_DROPPED_RESOURCES, LOCAL_SEARCH_RADIUS, {
      filter: function (r) {
        return isAllowedResource(r.resourceType) && r.amount >= MIN_DROPPED;
      }
    }) || [];

    for (var i = 0; i < dropped.length; i++) {
      var drop = dropped[i];
      if (!drop) {
        continue;
      }
      if (drop.id) {
        droppedMap[drop.id] = true;
      }
      candidates.push({ kind: 'drop', obj: drop, resourceType: drop.resourceType, amount: drop.amount });
    }

    var cachedWide = collectCachedWideDrops(wideCache);
    for (var j = 0; j < cachedWide.length; j++) {
      var wideDrop = cachedWide[j];
      if (!wideDrop || !wideDrop.id || droppedMap[wideDrop.id]) {
        continue;
      }
      candidates.push({ kind: 'drop', obj: wideDrop, resourceType: wideDrop.resourceType, amount: wideDrop.amount });
      droppedMap[wideDrop.id] = true;
    }

    var tombstones = flagPos.findInRange(FIND_TOMBSTONES, LOCAL_SEARCH_RADIUS) || [];
    for (var t = 0; t < tombstones.length; t++) {
      var tomb = tombstones[t];
      if (!tomb || !tomb.store) continue;
      for (var resType in tomb.store) {
        if (!tomb.store.hasOwnProperty(resType)) continue;
        if (!isAllowedResource(resType)) continue;
        var amount = tomb.store[resType];
        if (amount >= MIN_DROPPED) {
          candidates.push({ kind: 'tomb', obj: tomb, resourceType: resType, amount: amount });
        }
      }
    }

    var ruins = flagPos.findInRange(FIND_RUINS, LOCAL_SEARCH_RADIUS) || [];
    for (var r = 0; r < ruins.length; r++) {
      var ruin = ruins[r];
      if (!ruin || !ruin.store) continue;
      for (var ruinType in ruin.store) {
        if (!ruin.store.hasOwnProperty(ruinType)) continue;
        if (!isAllowedResource(ruinType)) continue;
        var ruinAmount = ruin.store[ruinType];
        if (ruinAmount >= MIN_DROPPED) {
          candidates.push({ kind: 'ruin', obj: ruin, resourceType: ruinType, amount: ruinAmount });
        }
      }
    }

    // opportunistic pickup: grab nearby drops first, then withdraw nearby tomb/ruin loot
    var underfoot = creep.pos.findInRange(FIND_DROPPED_RESOURCES, 1, {
      filter: function (r) {
        return isAllowedResource(r.resourceType) && r.amount > 0;
      }
    });
    if (underfoot.length) {
      creep.pickup(underfoot[0]);
      return;
    }

    var closeTombs = creep.pos.findInRange(FIND_TOMBSTONES, 1) || [];
    for (var ct = 0; ct < closeTombs.length; ct++) {
      var closeTomb = closeTombs[ct];
      if (!closeTomb || !closeTomb.store) continue;
      for (var closeType in closeTomb.store) {
        if (!closeTomb.store.hasOwnProperty(closeType)) continue;
        if (!isAllowedResource(closeType)) continue;
        if (closeTomb.store[closeType] > 0) {
          var tombWithdraw = creep.withdraw(closeTomb, closeType);
          if (tombWithdraw === OK) {
            return;
          }
        }
      }
    }

    var closeRuins = creep.pos.findInRange(FIND_RUINS, 1) || [];
    for (var cr = 0; cr < closeRuins.length; cr++) {
      var closeRuin = closeRuins[cr];
      if (!closeRuin || !closeRuin.store) continue;
      for (var closeRuinType in closeRuin.store) {
        if (!closeRuin.store.hasOwnProperty(closeRuinType)) continue;
        if (!isAllowedResource(closeRuinType)) continue;
        if (closeRuin.store[closeRuinType] > 0) {
          var ruinWithdraw = creep.withdraw(closeRuin, closeRuinType);
          if (ruinWithdraw === OK) {
            return;
          }
        }
      }
    }

    if (candidates.length === 0) {
      // Nothing visible—poke around the flag a bit
      if (!creep.pos.inRangeTo(flagPos, 2)) {
        travelTo(creep, flagPos, 1, 10);
      } else {
        creep.say('🧐 no loot');
      }
      return;
    }

    var objects = [];
    for (var c = 0; c < candidates.length; c++) {
      if (candidates[c] && candidates[c].obj) {
        objects.push(candidates[c].obj);
      }
    }

    var closestObj = null;
    if (objects.length) {
      closestObj = creep.pos.findClosestByPath(objects);
      if (!closestObj) {
        closestObj = objects[0];
      }
    }

    var selected = null;
    if (closestObj) {
      for (var sc = 0; sc < candidates.length; sc++) {
        var cand = candidates[sc];
        if (cand && cand.obj === closestObj) {
          if (!selected || cand.amount > selected.amount) {
            selected = cand;
          }
        }
      }
    }
    if (!selected && candidates.length) {
      selected = candidates[0];
    }
    if (!selected || !selected.obj) {
      return;
    }

    if (selected.kind === 'drop') {
      if (creep.pickup(selected.obj) === ERR_NOT_IN_RANGE) {
        travelTo(creep, selected.obj, 1, 10);
      }
    } else {
      var withdrawResult = creep.withdraw(selected.obj, selected.resourceType);
      if (withdrawResult === ERR_NOT_IN_RANGE) {
        travelTo(creep, selected.obj, 1, 10);
      }
    }
  },

  returnToStorage: function (creep) {
    // if not in home room, head there first
    var home = creep.memory.homeRoom || Memory.firstSpawnRoom || creep.room.name;
    if (creep.room.name !== home) {
      travelTo(creep, new RoomPosition(25, 25, home), 1, 10);
      creep.say('🏠↩️');
      return;
    }

    var carried = getCarriedResourceTypes(creep);
    if (!carried.length) {
      var idleAnchor = creep.room.storage || creep.room.terminal;
      if (!idleAnchor) {
        var idleSpawns = creep.room.find(FIND_MY_SPAWNS);
        idleAnchor = idleSpawns.length ? idleSpawns[0] : null;
      }
      if (idleAnchor) {
        travelTo(creep, idleAnchor.pos, 2, 10);
      }
      return;
    }

    var order = [];
    if (creep.store[RESOURCE_POWER] > 0) {
      order.push(RESOURCE_POWER);
    }
    if (creep.store[RESOURCE_ENERGY] > 0) {
      order.push(RESOURCE_ENERGY);
    }
    for (var idx = 0; idx < carried.length; idx++) {
      var carriedType = carried[idx];
      var already = false;
      for (var o = 0; o < order.length; o++) {
        if (order[o] === carriedType) {
          already = true;
          break;
        }
      }
      if (!already) {
        order.push(carriedType);
      }
    }

    for (var ord = 0; ord < order.length; ord++) {
      var resourceType = order[ord];
      var depositTargets = getDepositTargets(creep.room, resourceType);
      if (!depositTargets.length) {
        continue;
      }
      var depositTarget = creep.pos.findClosestByPath(depositTargets) || depositTargets[0];
      if (!depositTarget) {
        continue;
      }
      var transferResult = creep.transfer(depositTarget, resourceType);
      if (transferResult === ERR_NOT_IN_RANGE) {
        travelTo(creep, depositTarget, 1, 10);
        return;
      } else if (transferResult === OK) {
        creep.say('📦➡️🏦');
        return;
      } else if (transferResult === ERR_FULL || transferResult === ERR_INVALID_TARGET) {
        continue;
      } else if (transferResult === ERR_NOT_ENOUGH_RESOURCES) {
        continue;
      }
    }

    // nowhere to dump? park near storage/terminal/spawn and wait
    var storage = creep.room.storage || creep.room.terminal;
    if (!storage) {
      var spawns = creep.room.find(FIND_MY_SPAWNS);
      storage = spawns.length ? spawns[0] : null;
    }
    if (storage) {
      travelTo(creep, storage.pos, 2, 10);
    }
    creep.say('🤷 full');
  }
};

function getCarriedResourceTypes(creep) {
  var list = [];
  if (!creep || !creep.store) {
    return list;
  }
  for (var resourceType in creep.store) {
    if (!creep.store.hasOwnProperty(resourceType)) continue;
    if (creep.store[resourceType] > 0) {
      list.push(resourceType);
    }
  }
  return list;
}

function getDepositTargets(room, resourceType) {
  var result = [];
  if (!room || !resourceType) {
    return result;
  }

  var i;
  if (resourceType === RESOURCE_POWER) {
    var powerSpawns = room.find(FIND_MY_STRUCTURES, {
      filter: function (s) {
        return s.structureType === STRUCTURE_POWER_SPAWN && s.store && s.store.getFreeCapacity(resourceType) > 0;
      }
    });
    for (i = 0; i < powerSpawns.length; i++) {
      result.push(powerSpawns[i]);
    }
    if (room.storage && room.storage.store && room.storage.store.getFreeCapacity(resourceType) > 0) {
      result.push(room.storage);
    }
    if (room.terminal && room.terminal.store && room.terminal.store.getFreeCapacity(resourceType) > 0) {
      result.push(room.terminal);
    }
    return result;
  }

  if (resourceType === RESOURCE_ENERGY) {
    if (room.storage && room.storage.store && room.storage.store.getFreeCapacity(resourceType) > 0) {
      result.push(room.storage);
    }
    var energyTargets = room.find(FIND_MY_STRUCTURES, {
      filter: function (s) {
        return (
          s.structureType === STRUCTURE_SPAWN ||
          s.structureType === STRUCTURE_EXTENSION
        ) && s.store && s.store.getFreeCapacity(resourceType) > 0;
      }
    });
    for (i = 0; i < energyTargets.length; i++) {
      result.push(energyTargets[i]);
    }
    return result;
  }

  if (room.terminal && room.terminal.store && room.terminal.store.getFreeCapacity(resourceType) > 0) {
    result.push(room.terminal);
  }
  if (room.storage && room.storage.store && room.storage.store.getFreeCapacity(resourceType) > 0) {
    result.push(room.storage);
  }
  return result;
}

module.exports = TaskTrucker;
module.exports.getSpawnBody = function (energy) {
  if (TaskCourier && typeof TaskCourier.getSpawnBody === 'function') {
    return TaskCourier.getSpawnBody(energy);
  }
  return [];
};
module.exports.getSpawnSpec = function (room, ctx) {
  var available = (ctx && typeof ctx.availableEnergy === 'number') ? ctx.availableEnergy : ((room && room.energyAvailable) || 0);
  var body = module.exports.getSpawnBody(available, room, ctx);
  return {
    body: body,
    namePrefix: 'trucker',
    memory: {
      role: 'Worker_Bee',
      task: 'trucker',
      home: room && room.name
    }
  };
};
