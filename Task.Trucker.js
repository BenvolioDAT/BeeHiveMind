'use strict';

// Task.Trucker.js
var BeeToolbox = require('BeeToolbox');

var PICKUP_FLAG_DEFAULT = 'E-Pickup';     // rename if you like
var MIN_DROPPED = 50;                     // ignore tiny crumbs
var SEARCH_RADIUS = 50;                   // how far from flag to look
var PARK_POS = new RoomPosition(25, 25, 'W0N0'); // only used if no flag & no home; harmless

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
    var dropped = flagPos.findInRange(FIND_DROPPED_RESOURCES, SEARCH_RADIUS, {
      filter: function (r) {
        return r.resourceType === RESOURCE_ENERGY && r.amount >= MIN_DROPPED;
      }
    });

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
