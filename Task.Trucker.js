'use strict';

// Task.Trucker.js
var BeeToolbox = require('BeeToolbox');

var PICKUP_FLAG_DEFAULT = 'E-Pickup';     // rename if you like
var MIN_DROPPED = 50;                     // ignore tiny crumbs
var LOCAL_SEARCH_RADIUS = 12;
var WIDE_SEARCH_RADIUS = 50;
var WIDE_SEARCH_COOLDOWN = 25;
var PARK_POS = new RoomPosition(25, 25, 'W0N0'); // only used if no flag & no home; harmless

var GLOBAL_TRUCKER_CACHE = global.__TRUCKER_CACHE || (global.__TRUCKER_CACHE = { rooms: {} });

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
      return r.resourceType === RESOURCE_ENERGY && r.amount >= MIN_DROPPED;
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
    if (!drop || drop.resourceType !== RESOURCE_ENERGY || drop.amount < MIN_DROPPED) {
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
    BeeToolbox.updateReturnState(creep);

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
        BeeToolbox.BeeTravel(creep, fallback);
      }
      return;
    }

    // travel cross-room to the flag
    if (creep.room.name !== flag.pos.roomName) {
      BeeToolbox.BeeTravel(creep, flag.pos);
      creep.say('🚛➡️📍');
      return;
    }

    // we’re in the flag room; look for juicy piles near the flag
    var flagPos = flag.pos;

    var wideCache = getWideScanCache(flagPos.roomName);
    refreshWideScan(flagPos, wideCache);

    var droppedMap = Object.create(null);
    var dropped = flagPos.findInRange(FIND_DROPPED_RESOURCES, LOCAL_SEARCH_RADIUS, {
      filter: function (r) {
        return r.resourceType === RESOURCE_ENERGY && r.amount >= MIN_DROPPED;
      }
    }) || [];

    for (var i = 0; i < dropped.length; i++) {
      if (dropped[i] && dropped[i].id) {
        droppedMap[dropped[i].id] = true;
      }
    }

    var cachedWide = collectCachedWideDrops(wideCache);
    for (var j = 0; j < cachedWide.length; j++) {
      var wideDrop = cachedWide[j];
      if (!wideDrop || !wideDrop.id || droppedMap[wideDrop.id]) {
        continue;
      }
      dropped.push(wideDrop);
      droppedMap[wideDrop.id] = true;
    }

    // opportunistic pickup: if standing on/adjacent to any dropped energy, grab it first
    var underfoot = creep.pos.findInRange(FIND_DROPPED_RESOURCES, 1, {
      filter: function (r) {
        return r.resourceType === RESOURCE_ENERGY && r.amount > 0;
      }
    });
    if (underfoot.length) {
      creep.pickup(underfoot[0]);
      return;
    }

    if (dropped.length === 0) {
      // Nothing visible—poke around the flag a bit
      if (!creep.pos.inRangeTo(flagPos, 2)) {
        BeeToolbox.BeeTravel(creep, flagPos, 1, 10);
      } else {
        creep.say('🧐 no loot');
      }
      return;
    }

    // go to closest pile
    var target = creep.pos.findClosestByPath(dropped) || dropped[0];
    if (!target) return;

    if (creep.pickup(target) === ERR_NOT_IN_RANGE) {
      BeeToolbox.BeeTravel(creep, target, 1, 10);
    }
  },

  returnToStorage: function (creep) {
    // if not in home room, head there first
    var home = creep.memory.homeRoom || Memory.firstSpawnRoom || creep.room.name;
    if (creep.room.name !== home) {
      BeeToolbox.BeeTravel(creep, new RoomPosition(25, 25, home), 1, 10);
      creep.say('🏠↩️');
      return;
    }

    // pick best deposit target: storage > spawn/ext
    var targets = creep.room.find(FIND_STRUCTURES, {
      filter: function (s) {
        return (
          s.structureType === STRUCTURE_STORAGE ||
          s.structureType === STRUCTURE_SPAWN ||
          s.structureType === STRUCTURE_EXTENSION
        ) && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
      }
    });

    if (targets.length) {
      var depositTarget = creep.pos.findClosestByPath(targets) || targets[0];
      if (creep.transfer(depositTarget, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        BeeToolbox.BeeTravel(creep, depositTarget, 1, 10);
      } else {
        creep.say('📦➡️🏦');
      }
    } else {
      // nowhere to dump? park near storage/spawn
      var storage = creep.room.storage;
      if (!storage) {
        var spawns = creep.room.find(FIND_MY_SPAWNS);
        storage = spawns.length ? spawns[0] : null;
      }
      if (storage) {
        BeeToolbox.BeeTravel(creep, storage.pos, 2, 10);
      }
      creep.say('🤷 full');
    }
  }
};

module.exports = TaskTrucker;
