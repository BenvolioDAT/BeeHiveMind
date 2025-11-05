'use strict';

/**
 * What changed & why:
 * - Centralized per-room scans (containers, drops, needy structures) so roles reuse cached data instead of re-running room.find.
 * - Provides reusable selectors for common economic intents (best container, towers needing energy, etc.).
 */

if (!global.__BHM) global.__BHM = { caches: {} };
if (!global.__BHM.caches) global.__BHM.caches = {};
if (typeof global.__BHM.getCached !== 'function') {
  global.__BHM.getCached = function (key, ttl, compute) {
    var caches = global.__BHM.caches;
    var entry = caches[key];
    var now = Game.time;
    if (entry && entry.expireTick >= now) return entry.value;
    var value = compute();
    caches[key] = { value: value, expireTick: (ttl > 0) ? (now + ttl) : now };
    return value;
  };
}

var TOWER_REFILL_AT = 0.8;

function computeRoomEnergyData(room) {
  return global.__BHM.getCached('selectors:energy:' + room.name, 0, function () {
    var data = {
      containers: [],
      spawnLikeNeedy: [],
      towerNeedy: [],
      storage: room.storage || null,
      terminal: room.terminal || null,
      dropped: [],
      tombstones: [],
      ruins: []
    };
    var structures = room.find(FIND_STRUCTURES);
    for (var i = 0; i < structures.length; i++) {
      var s = structures[i];
      if (!s || !s.structureType) continue;
      if (s.store && s.store[RESOURCE_ENERGY] > 0 && s.structureType === STRUCTURE_CONTAINER) {
        data.containers.push(s);
      }
      if (s.structureType === STRUCTURE_EXTENSION || s.structureType === STRUCTURE_SPAWN) {
        if ((s.energy | 0) < (s.energyCapacity | 0)) data.spawnLikeNeedy.push(s);
      }
      if (s.structureType === STRUCTURE_TOWER) {
        var pct = (s.store[RESOURCE_ENERGY] | 0) / ((s.store.getCapacity(RESOURCE_ENERGY)) || 1);
        if (pct <= TOWER_REFILL_AT) data.towerNeedy.push(s);
      }
    }
    var drops = room.find(FIND_DROPPED_RESOURCES, {
      filter: function (r) { return r.resourceType === RESOURCE_ENERGY && r.amount > 0; }
    });
    for (var d = 0; d < drops.length; d++) data.dropped.push(drops[d]);
    var tombs = room.find(FIND_TOMBSTONES, {
      filter: function (t) { return t.store && (t.store[RESOURCE_ENERGY] | 0) > 0; }
    });
    for (var t = 0; t < tombs.length; t++) data.tombstones.push(tombs[t]);
    var ruins = room.find(FIND_RUINS, {
      filter: function (r) { return r.store && (r.store[RESOURCE_ENERGY] | 0) > 0; }
    });
    for (var r = 0; r < ruins.length; r++) data.ruins.push(ruins[r]);
    return data;
  });
}

function byEnergyDesc(a, b) {
  var ae = (a.store && a.store[RESOURCE_ENERGY]) || (a.amount || 0);
  var be = (b.store && b.store[RESOURCE_ENERGY]) || (b.amount || 0);
  return be - ae;
}

var BeeSelectors = {
  getRoomEnergyData: function (room) {
    if (!room) return null;
    return computeRoomEnergyData(room);
  },

  findBestEnergyContainer: function (room) {
    var data = computeRoomEnergyData(room);
    if (!data || !data.containers.length) return null;
    data.containers.sort(byEnergyDesc);
    return data.containers[0];
  },

  findBestEnergyDrop: function (room) {
    var data = computeRoomEnergyData(room);
    if (!data || !data.dropped.length) return null;
    data.dropped.sort(byEnergyDesc);
    return data.dropped[0];
  },

  findTombstoneWithEnergy: function (room) {
    var data = computeRoomEnergyData(room);
    if (!data || !data.tombstones.length) return null;
    data.tombstones.sort(byEnergyDesc);
    return data.tombstones[0];
  },

  findRuinWithEnergy: function (room) {
    var data = computeRoomEnergyData(room);
    if (!data || !data.ruins.length) return null;
    data.ruins.sort(byEnergyDesc);
    return data.ruins[0];
  },

  findTowersNeedingEnergy: function (room) {
    var data = computeRoomEnergyData(room);
    return data ? data.towerNeedy.slice() : [];
  },

  findSpawnLikeNeedingEnergy: function (room) {
    var data = computeRoomEnergyData(room);
    return data ? data.spawnLikeNeedy.slice() : [];
  },

  findStorageNeedingEnergy: function (room) {
    var store = room.storage;
    if (!store || !store.store) return null;
    if (store.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) return null;
    return store;
  },

  selectClosestByRange: function (pos, list) {
    if (!pos || !list || !list.length) return null;
    var best = null;
    var bestRange = Infinity;
    for (var i = 0; i < list.length; i++) {
      var target = list[i];
      if (!target) continue;
      var dist = pos.getRangeTo(target);
      if (dist < bestRange) {
        bestRange = dist;
        best = target;
      }
    }
    return best;
  }
};

module.exports = BeeSelectors;
