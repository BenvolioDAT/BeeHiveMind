'use strict';

/**
 * What changed & why:
 * - Centralized per-room scans (containers, drops, needy structures) so roles reuse cached data instead of re-running room.find.
 * - Provides reusable selectors for common economic intents (best container, towers needing energy, etc.).
 * - Added construction/repair helpers and idle anchors so builder-style roles share a single cached view of work targets.
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
var BUILD_PRIORITY = {
  spawn: 6,
  extension: 5,
  tower: 4,
  storage: 3,
  terminal: 3,
  container: 2,
  link: 2,
  road: 1
};

function computeRepairGoal(structure) {
  if (!structure || structure.hits == null || structure.hitsMax == null) return null;
  var type = structure.structureType;
  if (type === STRUCTURE_WALL) return null;
  if (type === STRUCTURE_RAMPART) {
    if (structure.hits >= 50000) return null;
    return Math.min(structure.hitsMax, 50000);
  }
  if (type === STRUCTURE_ROAD) {
    return Math.min(structure.hitsMax, Math.floor(structure.hitsMax * 0.75));
  }
  if (type === STRUCTURE_CONTAINER) {
    return Math.min(structure.hitsMax, Math.floor(structure.hitsMax * 0.9));
  }
  return Math.min(structure.hitsMax, Math.floor(structure.hitsMax * 0.9));
}

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

function computeRoomWorkData(room) {
  return global.__BHM.getCached('selectors:work:' + room.name, 0, function () {
    var data = {
      sites: [],
      repairs: []
    };
    var sites = room.find(FIND_CONSTRUCTION_SITES);
    for (var i = 0; i < sites.length; i++) {
      data.sites.push(sites[i]);
    }
    var structures = room.find(FIND_STRUCTURES);
    for (var s = 0; s < structures.length; s++) {
      var structure = structures[s];
      if (!structure) continue;
      if (structure.hits == null || structure.hitsMax == null) continue;
      if (structure.hits >= structure.hitsMax) continue;
      var goal = computeRepairGoal(structure);
      if (goal && structure.hits < goal) {
        data.repairs.push({ target: structure, goalHits: goal });
      }
    }
    return data;
  });
}

function byEnergyDesc(a, b) {
  var ae = (a.store && a.store[RESOURCE_ENERGY]) || (a.amount || 0);
  var be = (b.store && b.store[RESOURCE_ENERGY]) || (b.amount || 0);
  return be - ae;
}

function byBuildPriority(a, b) {
  var pa = BUILD_PRIORITY[a.structureType] || 0;
  var pb = BUILD_PRIORITY[b.structureType] || 0;
  if (pb !== pa) return pb - pa;
  return a.progress - b.progress;
}

function byRepairUrgency(a, b) {
  var ar = a.target ? (a.target.hits / Math.max(1, a.goalHits)) : 1;
  var br = b.target ? (b.target.hits / Math.max(1, b.goalHits)) : 1;
  if (ar !== br) return ar - br;
  if (!a.target || !b.target) return 0;
  return a.target.hits - b.target.hits;
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
  },

  findBestConstructionSite: function (room) {
    if (!room) return null;
    var data = computeRoomWorkData(room);
    if (!data || !data.sites.length) return null;
    data.sites.sort(byBuildPriority);
    return data.sites[0];
  },

  findBestRepairTarget: function (room) {
    if (!room) return null;
    var data = computeRoomWorkData(room);
    if (!data || !data.repairs.length) return null;
    data.repairs.sort(byRepairUrgency);
    return data.repairs[0];
  },

  findRoomAnchor: function (room) {
    if (!room) return null;
    return global.__BHM.getCached('selectors:anchor:' + room.name, 0, function () {
      if (room.storage) return room.storage;
      if (room.terminal) return room.terminal;
      var spawns = room.find(FIND_MY_SPAWNS);
      if (spawns && spawns.length) return spawns[0];
      return null;
    });
  }
};

module.exports = BeeSelectors;
