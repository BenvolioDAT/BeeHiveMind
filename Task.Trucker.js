// Task.Trucker.js
var BeeToolbox = require('BeeToolbox');

const PICKUP_FLAG_DEFAULT = 'E-Pickup';     // rename if you like
const MIN_DROPPED = 50;                     // ignore tiny crumbs
const SEARCH_RADIUS = 50;                   // how far from flag to look
const PARK_POS = new RoomPosition(25, 25, 'W0N0'); // only used if no flag & no home; harmless

const TaskTrucker = {
  run(creep) {
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

  collectFromFlagRoom(creep) {
    const flag = Game.flags[creep.memory.pickupFlag];
    if (!flag) {
      // fail-safe: no flag? just head home and idle
      creep.say('❓Flag');
      const fallback = new RoomPosition(25,25, creep.memory.homeRoom || PARK_POS.roomName);
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
    const dropped = flag.pos.findInRange(FIND_DROPPED_RESOURCES, SEARCH_RADIUS, {
      filter: r => r.resourceType === RESOURCE_ENERGY && r.amount >= MIN_DROPPED
    });

    // opportunistic pickup: if standing on/adjacent to any dropped energy, grab it first
    const underfoot = creep.pos.findInRange(FIND_DROPPED_RESOURCES, 1, {
      filter: r => r.resourceType === RESOURCE_ENERGY && r.amount > 0
    });
    if (underfoot.length) {
      creep.pickup(underfoot[0]);
      return;
    }

    if (dropped.length === 0) {
      // Nothing visible—poke around the flag a bit
      if (!creep.pos.inRangeTo(flag.pos, 2)) {
        BeeToolbox.BeeTravel(creep, flag.pos, 1, 10);
      } else {
        creep.say('🧐 no loot');
      }
      return;
    }

    // go to closest pile
    const target = creep.pos.findClosestByPath(dropped) || dropped[0];
    if (!target) return;

    if (creep.pickup(target) === ERR_NOT_IN_RANGE) {
      BeeToolbox.BeeTravel(creep, target, 1, 10);
    }
  },

  returnToStorage(creep) {
    // if not in home room, head there first
    const home = creep.memory.homeRoom || Memory.firstSpawnRoom || creep.room.name;
    if (creep.room.name !== home) {
      BeeToolbox.BeeTravel(creep, new RoomPosition(25,25, home), 1, 10);
      creep.say('🏠↩️');
      return;
    }

    // pick best deposit target: storage > spawn/ext
    const targets = creep.room.find(FIND_STRUCTURES, {
      filter: s =>
        (s.structureType === STRUCTURE_STORAGE ||
         s.structureType === STRUCTURE_SPAWN ||
         s.structureType === STRUCTURE_EXTENSION) &&
        s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
    });

    if (targets.length) {
      const t = creep.pos.findClosestByPath(targets);
      if (creep.transfer(t, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
        BeeToolbox.BeeTravel(creep, t, 1, 10);
      } else {
        creep.say('📦➡️🏦');
      }
    } else {
      // nowhere to dump? park near storage/spawn
      const storage = creep.room.storage || _.first(creep.room.find(FIND_MY_SPAWNS));
      if (storage) BeeToolbox.BeeTravel(creep, storage.pos, 2, 10);
      creep.say('🤷 full');
    }
  }
};

module.exports = TaskTrucker;
