'use strict';

/**
 * What changed & why:
 * - Collapsed all per-room FIND calls into a single snapshot builder invoked once per tick via global.__BHM caches.
 * - Added shared repair target reservation helpers so creeps and towers coordinate off the same queue.
 * - Preserved existing selector APIs while wiring them to the snapshot (containers, drops, towers, build, anchor).
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

function resetReservationsIfNeeded() {
  if (!global.__BHM) return;
  if (!global.__BHM.repairReservationsTick || global.__BHM.repairReservationsTick !== Game.time) {
    global.__BHM.repairReservationsTick = Game.time;
    global.__BHM.repairReservations = {};
  }
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

function buildSnapshot(room) {
  var key = 'selectors:snapshot:' + room.name;
  return global.__BHM.getCached(key, 0, function () {
    var snapshot = {
      room: room,
      energyContainers: [],
      spawnLikeNeedy: [],
      towerNeedy: [],
      dropped: [],
      tombstones: [],
      ruins: [],
      storage: room.storage || null,
      terminal: room.terminal || null,
      sites: [],
      repairs: [],
      anchor: null,
      controllerLink: null
    };
    var controller = room.controller || null;
    var structures = room.find(FIND_STRUCTURES);
    for (var i = 0; i < structures.length; i++) {
      var s = structures[i];
      if (!s || !s.structureType) continue;
      if (s.structureType === STRUCTURE_CONTAINER && s.store && (s.store[RESOURCE_ENERGY] | 0) > 0) {
        snapshot.energyContainers.push(s);
      }
      if (s.structureType === STRUCTURE_EXTENSION || s.structureType === STRUCTURE_SPAWN) {
        if ((s.energy | 0) < (s.energyCapacity | 0)) snapshot.spawnLikeNeedy.push(s);
      }
      if (s.structureType === STRUCTURE_TOWER) {
        var used = (s.store[RESOURCE_ENERGY] | 0);
        var cap = s.store.getCapacity(RESOURCE_ENERGY) || 1;
        if ((used / cap) <= TOWER_REFILL_AT) snapshot.towerNeedy.push(s);
      if (s.structureType === STRUCTURE_LINK && controller && controller.pos && s.pos.inRangeTo(controller.pos, 3)) {
        snapshot.controllerLink = s;
      }
      }
      var goal = computeRepairGoal(s);
      if (goal && s.hits < goal) {
        snapshot.repairs.push({ target: s, goalHits: goal });
      }
    }
    var drops = room.find(FIND_DROPPED_RESOURCES, {
      filter: function (r) { return r.resourceType === RESOURCE_ENERGY && r.amount > 0; }
    });
    for (var d = 0; d < drops.length; d++) snapshot.dropped.push(drops[d]);
    var tombs = room.find(FIND_TOMBSTONES, {
      filter: function (t) { return t.store && (t.store[RESOURCE_ENERGY] | 0) > 0; }
    });
    for (var t = 0; t < tombs.length; t++) snapshot.tombstones.push(tombs[t]);
    var ruins = room.find(FIND_RUINS, {
      filter: function (r) { return r.store && (r.store[RESOURCE_ENERGY] | 0) > 0; }
    });
    for (var r = 0; r < ruins.length; r++) snapshot.ruins.push(ruins[r]);
    var sites = room.find(FIND_CONSTRUCTION_SITES);
    for (var sIdx = 0; sIdx < sites.length; sIdx++) snapshot.sites.push(sites[sIdx]);
    if (room.storage) snapshot.anchor = room.storage;
    else if (room.terminal) snapshot.anchor = room.terminal;
    else {
      var spawns = room.find(FIND_MY_SPAWNS);
      if (spawns && spawns.length) snapshot.anchor = spawns[0];
    }
    snapshot.energyContainers.sort(byEnergyDesc);
    snapshot.dropped.sort(byEnergyDesc);
    snapshot.tombstones.sort(byEnergyDesc);
    snapshot.ruins.sort(byEnergyDesc);
    snapshot.sites.sort(byBuildPriority);
    snapshot.repairs.sort(byRepairUrgency);
    return snapshot;
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
  prepareRoomSnapshot: function (room) {
    if (!room) return null;
    return buildSnapshot(room);
  },

  getRoomEnergyData: function (room) {
    if (!room) return null;
    return buildSnapshot(room);
  },

  findBestEnergyContainer: function (room) {
    var snap = buildSnapshot(room);
    if (!snap || !snap.energyContainers.length) return null;
    return snap.energyContainers[0];
  },

  findBestEnergyDrop: function (room) {
    var snap = buildSnapshot(room);
    if (!snap || !snap.dropped.length) return null;
    return snap.dropped[0];
  },

  findTombstoneWithEnergy: function (room) {
    var snap = buildSnapshot(room);
    if (!snap || !snap.tombstones.length) return null;
    return snap.tombstones[0];
  },

  findRuinWithEnergy: function (room) {
    var snap = buildSnapshot(room);
    if (!snap || !snap.ruins.length) return null;
    return snap.ruins[0];
  },

  findTowersNeedingEnergy: function (room) {
    var snap = buildSnapshot(room);
    return snap ? snap.towerNeedy.slice() : [];
  },

  findSpawnLikeNeedingEnergy: function (room) {
    var snap = buildSnapshot(room);
    return snap ? snap.spawnLikeNeedy.slice() : [];
  },

  findStorageNeedingEnergy: function (room) {
    var snap = buildSnapshot(room);
    if (!snap || !snap.storage) return null;
    if (snap.storage.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) return null;
    return snap.storage;
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
    var snap = buildSnapshot(room);
    if (!snap || !snap.sites.length) return null;
    return snap.sites[0];
  },

  findBestRepairTarget: function (room) {
    var snap = buildSnapshot(room);
    if (!snap || !snap.repairs.length) return null;
    return snap.repairs[0];
  },

  reserveRepairTarget: function (room, reserverId) {
    if (!room) return null;
    resetReservationsIfNeeded();
    var snap = buildSnapshot(room);
    if (!snap || !snap.repairs.length) return null;
    var roomName = room.name;
    if (!global.__BHM.repairReservations[roomName]) global.__BHM.repairReservations[roomName] = {};
    var reservations = global.__BHM.repairReservations[roomName];
    for (var i = 0; i < snap.repairs.length; i++) {
      var entry = snap.repairs[i];
      if (!entry || !entry.target) continue;
      if (reservations[entry.target.id]) continue;
      reservations[entry.target.id] = reserverId || 'anon';
      return entry;
    }
    return null;
  },

  releaseRepairTarget: function (roomName, targetId) {
    if (!roomName || !targetId) return;
    resetReservationsIfNeeded();
    var resByRoom = global.__BHM.repairReservations[roomName];
    if (resByRoom && resByRoom[targetId]) delete resByRoom[targetId];
  },

  findRoomAnchor: function (room) {
    var snap = buildSnapshot(room);
    return snap ? snap.anchor : null;
  },

  findControllerLink: function (room) {
    var snap = buildSnapshot(room);
    return snap ? snap.controllerLink : null;
  }
};

module.exports = BeeSelectors;
