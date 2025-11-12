// -----------------------------------------------------------------------------
// BeeSelectors.js – shared room/remote scanning helpers
// Responsibilities:
// * Builds cached per-room snapshots (structures, drops, repair targets) so
//   role modules (role.Queen, role.Builder, role.Repair, etc.) query once/tick.
// * Manages repair target reservations via global.__BHM to prevent double work
//   between creeps and towers.
// * Exposes selectors for remote mining (seat positions, container state) used
//   by role.Luna and couriers.
// Data touched:
// * global.__BHM.caches – per-key TTL caches (reset at shard reset).
// * Memory.__BHM.* – remote room metadata (remotesByHome, reservations).
// Callers: role.* modules, BeeHiveMind.prepareTickCaches, Movement planners.
// -----------------------------------------------------------------------------
'use strict';

/**
 * What changed & why:
 * - Collapsed all per-room FIND calls into a single snapshot builder invoked once per tick via global.__BHM caches.
 * - Added shared repair target reservation helpers so creeps and towers coordinate off the same queue.
 * - Preserved existing selector APIs while wiring them to the snapshot (containers, drops, towers, build, anchor).
 */

// Ensure global namespace for caches exists; BeeHiveMind sets global.__BHM in
// its orchestrator but we guard in case selectors are used standalone.
if (!global.__BHM) global.__BHM = { caches: {} };
if (!global.__BHM.caches) global.__BHM.caches = {};
if (typeof global.__BHM.getCached !== 'function') {
  // Function header: global.__BHM.getCached(key, ttl, compute)
  // Inputs: key (string), ttl (ticks before recompute; 0 = this tick only),
  //         compute() returning value when cache stale.
  // Output: cached value.
  // Side-effects: stores value & expiry in global.__BHM.caches[key].
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

// Function header: resetReservationsIfNeeded()
// Inputs: none
// Output: none; lazily resets global.__BHM.repairReservations every tick.
// Side-effects: ensures reservation map empty at tick boundary.
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

// Function header: computeRepairGoal(structure)
// Inputs: structure needing repairs
// Output: desired hit points to aim for (caps vary by structure type)
// Side-effects: none.
// Notes: ramps/walls have special caps; prevents wasting energy topping to
//        hitsMax when not necessary.
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

// Function header: buildSnapshot(room)
// Inputs: visible Room object (owned or observed)
// Output: snapshot object cached for this tick (lists of structures, drops,
//         etc.)
// Side-effects: runs multiple room.find calls (expensive) but cached via
//               global.__BHM.getCached with ttl 0 (per tick).
// Consumers: BeeSelectors.* selectors and BeeHiveMind.prepareTickCaches.
function buildSnapshot(room) {
  var key = 'selectors:snapshot:' + room.name;
  return global.__BHM.getCached(key, 0, function () {
    var snapshot = {
      room: room,
      energyContainers: [],
      sourceContainers: [],
      otherContainers: [],
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
      controllerLink: null,
      linksWithEnergy: [],
      sources: []
    };
    var controller = room.controller || null;
    // Harvestable sources; remote modules rely on this for fallback.
    var sources = room.find(FIND_SOURCES);
    for (var si = 0; si < sources.length; si++) snapshot.sources.push(sources[si]);
    // FIND_STRUCTURES is the heaviest call here; runs once per tick per room.
    var structures = room.find(FIND_STRUCTURES);
    for (var i = 0; i < structures.length; i++) {
      var s = structures[i];
      if (!s || !s.structureType) continue;
      if (s.structureType === STRUCTURE_CONTAINER && s.store) {
        var stored = s.store[RESOURCE_ENERGY] | 0;
        if (stored > 0) {
          var nearSource = false;
          for (var sc = 0; sc < sources.length; sc++) {
            if (s.pos.inRangeTo(sources[sc].pos, 1)) { nearSource = true; break; }
          }
          if (nearSource) snapshot.sourceContainers.push(s);
          else snapshot.otherContainers.push(s);
        }
      }
      if (s.structureType === STRUCTURE_EXTENSION || s.structureType === STRUCTURE_SPAWN) {
        if ((s.energy | 0) < (s.energyCapacity | 0)) snapshot.spawnLikeNeedy.push(s);
      }
      if (s.structureType === STRUCTURE_TOWER) {
        var used = (s.store[RESOURCE_ENERGY] | 0);
        var cap = s.store.getCapacity(RESOURCE_ENERGY) || 1;
        if ((used / cap) <= TOWER_REFILL_AT) snapshot.towerNeedy.push(s);
      }
      if (s.structureType === STRUCTURE_LINK) {
        if (controller && controller.pos && s.pos.inRangeTo(controller.pos, 3)) {
          snapshot.controllerLink = s;
        }
        if ((s.store && (s.store[RESOURCE_ENERGY] | 0) > 0) || s.energy > 0) {
          snapshot.linksWithEnergy.push(s);
        }
      }
      var goal = computeRepairGoal(s);
      if (goal && s.hits < goal) {
        snapshot.repairs.push({ target: s, goalHits: goal });
      }
    }
    // Dropped energy piles (role.Queen/role.Courier read this list).
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
    snapshot.sourceContainers.sort(byEnergyDesc);
    snapshot.otherContainers.sort(byEnergyDesc);
    snapshot.energyContainers = snapshot.sourceContainers.concat(snapshot.otherContainers);
    snapshot.dropped.sort(byEnergyDesc);
    snapshot.tombstones.sort(byEnergyDesc);
    snapshot.ruins.sort(byEnergyDesc);
    snapshot.sites.sort(byBuildPriority);
    snapshot.repairs.sort(byRepairUrgency);
    snapshot.linksWithEnergy.sort(byEnergyDesc);
    return snapshot;
  });
}

// Function header: byEnergyDesc(a, b)
// Inputs: resource/structure entries with energy payload
// Output: comparator for descending sort (more energy first).
function byEnergyDesc(a, b) {
  var ae = (a.store && a.store[RESOURCE_ENERGY]) || (a.amount || 0);
  var be = (b.store && b.store[RESOURCE_ENERGY]) || (b.amount || 0);
  return be - ae;
}

// Function header: byBuildPriority(a, b)
// Inputs: construction sites
// Output: comparator favouring higher BUILD_PRIORITY then lower progress.
function byBuildPriority(a, b) {
  var pa = BUILD_PRIORITY[a.structureType] || 0;
  var pb = BUILD_PRIORITY[b.structureType] || 0;
  if (pb !== pa) return pb - pa;
  return a.progress - b.progress;
}

// Function header: byRepairUrgency(a, b)
// Inputs: {target, goalHits} entries
// Output: comparator (lowest ratio hits/goal first -> most urgent).
function byRepairUrgency(a, b) {
  var ar = a.target ? (a.target.hits / Math.max(1, a.goalHits)) : 1;
  var br = b.target ? (b.target.hits / Math.max(1, b.goalHits)) : 1;
  if (ar !== br) return ar - br;
  if (!a.target || !b.target) return 0;
  return a.target.hits - b.target.hits;
}

// Function header: ensureRemoteMemory()
// Inputs: none
// Output: none; creates Memory.__BHM containers for remote operations.
// Side-effects: allocates Memory.__BHM.remotesByHome, .remoteSourceClaims,
//               .seatReservations, .avoidSources, .haulRequests.
function ensureRemoteMemory() {
  if (!Memory.__BHM) Memory.__BHM = {};
  if (!Memory.__BHM.remotesByHome) Memory.__BHM.remotesByHome = {};
  if (!Memory.__BHM.remoteSourceClaims) Memory.__BHM.remoteSourceClaims = {};
  if (!Memory.__BHM.seatReservations) Memory.__BHM.seatReservations = {};
  if (!Memory.__BHM.avoidSources) Memory.__BHM.avoidSources = {};
  if (!Memory.__BHM.haulRequests) Memory.__BHM.haulRequests = {};
}

// Function header: posToSeat(pos)
// Inputs: RoomPosition
// Output: plain object {x,y,roomName} safe for Memory serialization.
function posToSeat(pos) {
  if (!pos) return null;
  return { x: pos.x, y: pos.y, roomName: pos.roomName };
}

// Function header: chooseBestSeatForSource(pos)
// Inputs: RoomPosition of a source
// Output: seat position (plain object) representing best adjacent tile for
//         miners; uses terrain to prefer plains over swamps.
// Side-effects: instantiates Room.Terrain (cheap) and scans 8 tiles.
function chooseBestSeatForSource(pos) {
  if (!pos) return null;
  var terrain = new Room.Terrain(pos.roomName);
  var best = null;
  var bestScore = -999;
  for (var dx = -1; dx <= 1; dx++) {
    for (var dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      var x = pos.x + dx;
      var y = pos.y + dy;
      if (x < 0 || x > 49 || y < 0 || y > 49) continue;
      var terrainType = terrain.get(x, y);
      if (terrainType === TERRAIN_MASK_WALL) continue;
      var score = 0;
      if (terrainType === TERRAIN_MASK_SWAMP) score = 1;
      else score = 2; // plain preferred
      if (!best || score > bestScore) {
        bestScore = score;
        best = new RoomPosition(x, y, pos.roomName);
      }
    }
  }
  return best ? posToSeat(best) : null;
}

// Function header: getSourceContainerOrSiteImpl(source)
// Inputs: Source object
// Output: {container, site, seatPos, containerEnergy, source}
// Side-effects: checks immediate surroundings for containers/sites; used by
//               role.BaseHarvest/role.Luna and BeeSelectors API wrappers.
function getSourceContainerOrSiteImpl(source) {
  if (!source || !source.pos) return { container: null, site: null, seatPos: null, containerEnergy: 0, source: source };
  var pos = source.pos;
  var room = source.room;
  var container = null;
  var site = null;
  var seat = null;
  var energy = 0;
  if (room) {
    var structures = pos.findInRange(FIND_STRUCTURES, 1, {
      filter: function (s) { return s.structureType === STRUCTURE_CONTAINER; }
    });
    if (structures && structures.length) {
      container = structures[0];
      seat = posToSeat(container.pos);
      if (container.store) energy = container.store[RESOURCE_ENERGY] || 0;
    }
    if (!container) {
      var sites = pos.findInRange(FIND_CONSTRUCTION_SITES, 1, {
        filter: function (c) { return c.structureType === STRUCTURE_CONTAINER; }
      });
      if (sites && sites.length) {
        site = sites[0];
        seat = posToSeat(site.pos);
      }
    }
  }
  if (!seat) seat = chooseBestSeatForSource(pos);
  return { container: container, site: site, seatPos: seat, containerEnergy: energy, source: source };
}

// Function header: collectSourceFlags()
// Inputs: none
// Output: map key "room:x:y" -> Flag object for flags starting with "SRC-".
// Side-effects: none; read-only iteration over Game.flags.
function collectSourceFlags() {
  var map = {};
  for (var name in Game.flags) {
    if (!Object.prototype.hasOwnProperty.call(Game.flags, name)) continue;
    var flag = Game.flags[name];
    if (!flag || typeof flag.name !== 'string') continue;
    if (flag.name.indexOf('SRC-') !== 0) continue;
    var key = flag.pos.roomName + ':' + flag.pos.x + ':' + flag.pos.y;
    map[key] = flag;
  }
  return map;
}

// Function header: buildRemoteSourcesSnapshot(homeRoomName)
// Inputs: homeRoomName string (owned room key)
// Output: array of remote source entries {sourceId, roomName, container, ...}
// Side-effects: reads Memory.__BHM.remotesByHome[home], scans visible remote
//               rooms, merges intel from Memory.rooms when fogged.
// Consumers: role.Luna (remote miners), role.Courier/Trucker.
function buildRemoteSourcesSnapshot(homeRoomName) {
  ensureRemoteMemory();
  var remotes = Memory.__BHM.remotesByHome[homeRoomName] || [];
  var flagsByPos = collectSourceFlags();
  var byId = {};
  var list = [];

  function pushEntry(data) {
    // Merge duplicates encountered when both Memory and live room provide data.
    if (!data || !data.sourceId) return;
    var existing = byId[data.sourceId];
    if (existing) {
      if (data.flag && !existing.flag) existing.flag = data.flag;
      if (data.container && !existing.container) {
        existing.container = data.container;
        existing.containerEnergy = data.containerEnergy;
      }
      if (!existing.seatPos && data.seatPos) existing.seatPos = data.seatPos;
      if (!existing.source && data.source) existing.source = data.source;
      return;
    }
    byId[data.sourceId] = data;
    list.push(data);
  }

  for (var i = 0; i < remotes.length; i++) {
    var roomName = remotes[i];
    var room = Game.rooms[roomName];
    if (room) {
      // Visible remote: gather live source/seat/container info.
      var sources = room.find(FIND_SOURCES);
      for (var j = 0; j < sources.length; j++) {
        var src = sources[j];
        var seatInfo = getSourceContainerOrSiteImpl(src);
        var key = roomName + ':' + src.pos.x + ':' + src.pos.y;
        pushEntry({
          sourceId: src.id,
          roomName: roomName,
          source: src,
          container: seatInfo.container,
          containerEnergy: seatInfo.containerEnergy,
          site: seatInfo.site,
          seatPos: seatInfo.seatPos,
          flag: flagsByPos[key] || null
        });
      }
    } else {
      // Fogged remote: rely on Memory.rooms intel; seat positions approximated
      // via stored seat or fallback chooseBestSeatForSource.
      var mem = (Memory.rooms && Memory.rooms[roomName] && Memory.rooms[roomName].sources) || null;
      if (!mem) continue;
      for (var sid in mem) {
        if (!Object.prototype.hasOwnProperty.call(mem, sid)) continue;
        var entry = mem[sid] || {};
        var seatPos = null;
        if (entry.seat) {
          seatPos = { x: entry.seat.x, y: entry.seat.y, roomName: entry.seat.roomName || roomName };
        } else if (entry.x != null && entry.y != null) {
          seatPos = chooseBestSeatForSource(new RoomPosition(entry.x, entry.y, roomName));
        }
        var keyMem = roomName + ':' + (entry.x != null ? entry.x : (entry.seat ? entry.seat.x : '')) + ':' + (entry.y != null ? entry.y : (entry.seat ? entry.seat.y : ''));
        pushEntry({
          sourceId: sid,
          roomName: roomName,
          source: null,
          container: null,
          containerEnergy: 0,
          site: null,
          seatPos: seatPos,
          flag: flagsByPos[keyMem] || null
        });
      }
    }
  }

  // Flags may indicate additional rooms not listed yet
  for (var key in flagsByPos) {
    if (!Object.prototype.hasOwnProperty.call(flagsByPos, key)) continue;
    var parts = key.split(':');
    if (parts.length !== 3) continue;
    var fRoom = parts[0];
    if (remotes.indexOf(fRoom) === -1) continue;
    var fx = parseInt(parts[1], 10);
    var fy = parseInt(parts[2], 10);
    var roomObj = Game.rooms[fRoom];
    if (!roomObj) continue;
    var look = roomObj.lookForAt(LOOK_SOURCES, fx, fy);
    if (!look || !look.length) continue;
    var srcObj = look[0];
    if (!srcObj || !srcObj.id) continue;
    if (byId[srcObj.id]) continue;
    var seatInfo2 = getSourceContainerOrSiteImpl(srcObj);
    pushEntry({
      sourceId: srcObj.id,
      roomName: fRoom,
      source: srcObj,
      container: seatInfo2.container,
      containerEnergy: seatInfo2.containerEnergy,
      site: seatInfo2.site,
      seatPos: seatInfo2.seatPos,
      flag: flagsByPos[key]
    });
  }

  return list;
}

var BeeSelectors = {
  prepareRoomSnapshot: function (room) {
    // Function header: prepareRoomSnapshot(room)
    // Inputs: Room object
    // Output: snapshot; caches within this module.
    // Side-effects: ensures buildSnapshot called; repeated invocations same tick
    //               are cheap (cache hit).
    if (!room) return null;
    return buildSnapshot(room);
  },

  getRoomEnergyData: function (room) {
    // Function header: getRoomEnergyData(room)
    // Alias returning same snapshot; older callers expect this name.
    if (!room) return null;
    return buildSnapshot(room);
  },

  findBestEnergyContainer: function (room) {
    // Returns highest energy container (source first) for haulers.
    var snap = buildSnapshot(room);
    if (!snap) return null;
    if (snap.sourceContainers.length) return snap.sourceContainers[0];
    if (snap.otherContainers.length) return snap.otherContainers[0];
    return null;
  },

  findBestEnergyDrop: function (room) {
    // Returns biggest dropped energy pile; used by role.Queen pickup path.
    var snap = buildSnapshot(room);
    if (!snap || !snap.dropped.length) return null;
    return snap.dropped[0];
  },

  getSourceContainerOrSite: function (source) {
    // Public wrapper exposing seat/container info for a source.
    return getSourceContainerOrSiteImpl(source);
  },

  getRemoteSourcesSnapshot: function (homeRoomName) {
    // Remote mining summary for BeeHiveMind & role.Luna planning.
    return buildRemoteSourcesSnapshot(homeRoomName);
  },

  findRemoteSourceContainers: function (homeRoomName) {
    // Enumerate remote containers to prioritise courier pickups.
    var list = buildRemoteSourcesSnapshot(homeRoomName);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var entry = list[i];
      if (!entry || !entry.container) continue;
      out.push({
        container: entry.container,
        source: entry.source || null,
        roomName: entry.roomName,
        energy: entry.containerEnergy,
        seatPos: entry.seatPos
      });
    }
    return out;
  },

  pickBestHaulTarget: function (containers, homeRoomName) {
    // Choose container entry by energy minus distance penalty (linear distance).
    // Used by role.Courier/role.Trucker to pick next haul job.
    if (!containers || !containers.length) return null;
    var best = null;
    var bestScore = -999999;
    for (var i = 0; i < containers.length; i++) {
      var entry = containers[i];
      if (!entry || !entry.container) continue;
      var energy = entry.energy;
      if (energy == null) {
        energy = (entry.container.store && entry.container.store[RESOURCE_ENERGY]) || 0;
      }
      var score = energy;
      if (homeRoomName && entry.roomName) {
        var dist = Game.map.getRoomLinearDistance(homeRoomName, entry.roomName, true);
        if (typeof dist === 'number' && dist > 0) {
          score -= dist * 25;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        best = entry;
      }
    }
    return best;
  },

  findTombstoneWithEnergy: function (room) {
    // Returns richest tombstone (energy only) for Queens/Couriers.
    var snap = buildSnapshot(room);
    if (!snap || !snap.tombstones.length) return null;
    return snap.tombstones[0];
  },

  findRuinWithEnergy: function (room) {
    // Similar to tombstones but for ruins.
    var snap = buildSnapshot(room);
    if (!snap || !snap.ruins.length) return null;
    return snap.ruins[0];
  },

  findTowersNeedingEnergy: function (room) {
    // Returns array of towers below TOWER_REFILL_AT; caller should copy.
    var snap = buildSnapshot(room);
    return snap ? snap.towerNeedy.slice() : [];
  },

  findSpawnLikeNeedingEnergy: function (room) {
    // Returns array of spawns/extensions needing energy; role.Queen selects
    // nearest using selectClosestByRange.
    var snap = buildSnapshot(room);
    return snap ? snap.spawnLikeNeedy.slice() : [];
  },

  findStorageNeedingEnergy: function (room) {
    // Single storage with free capacity; role.Queen fallback.
    var snap = buildSnapshot(room);
    if (!snap || !snap.storage) return null;
    if (snap.storage.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) return null;
    return snap.storage;
  },

  getEnergySourcePriority: function (room) {
    // Ordered list of energy sources for haulers; sinks read .kind to choose
    // correct action (withdraw vs pickup vs harvest).
    var snap = buildSnapshot(room);
    if (!snap) return [];
    var list = [];
    var i;
    for (i = 0; i < snap.tombstones.length; i++) list.push({ kind: 'tomb', target: snap.tombstones[i] });
    for (i = 0; i < snap.ruins.length; i++) list.push({ kind: 'ruin', target: snap.ruins[i] });
    for (i = 0; i < snap.dropped.length; i++) list.push({ kind: 'drop', target: snap.dropped[i] });
    for (i = 0; i < snap.sourceContainers.length; i++) list.push({ kind: 'container', target: snap.sourceContainers[i] });
    if (snap.storage && (snap.storage.store[RESOURCE_ENERGY] | 0) > 0) list.push({ kind: 'storage', target: snap.storage });
    if (snap.terminal && (snap.terminal.store[RESOURCE_ENERGY] | 0) > 0) list.push({ kind: 'terminal', target: snap.terminal });
    for (i = 0; i < snap.otherContainers.length; i++) list.push({ kind: 'container', target: snap.otherContainers[i] });
    for (i = 0; i < snap.linksWithEnergy.length; i++) list.push({ kind: 'link', target: snap.linksWithEnergy[i] });
    for (i = 0; i < snap.sources.length; i++) list.push({ kind: 'source', target: snap.sources[i] });
    return list;
  },

  selectClosestByRange: function (pos, list) {
    // Utility to pick nearest target based on range; expects RoomPosition.
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
    // Returns highest priority construction site; used by role.Builder.
    var snap = buildSnapshot(room);
    if (!snap || !snap.sites.length) return null;
    return snap.sites[0];
  },

  findBestRepairTarget: function (room) {
    // Returns most urgent repair entry ({target, goalHits}) for role.Repair.
    var snap = buildSnapshot(room);
    if (!snap || !snap.repairs.length) return null;
    return snap.repairs[0];
  },

  reserveRepairTarget: function (room, reserverId) {
    // Claim a repair target for this tick (reserverId usually creep name).
    // Prevents multiple creeps hitting same structure; release via
    // releaseRepairTarget when done.
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
    // Drop reservation (called when creep finishes or switches room).
    if (!roomName || !targetId) return;
    resetReservationsIfNeeded();
    var resByRoom = global.__BHM.repairReservations[roomName];
    if (resByRoom && resByRoom[targetId]) delete resByRoom[targetId];
  },

  findRoomAnchor: function (room) {
    // Returns storage/terminal/spawn used as hub; BeeHiveMind uses for visuals.
    var snap = buildSnapshot(room);
    return snap ? snap.anchor : null;
  },

  findControllerLink: function (room) {
    // Returns link within 3 tiles of controller (for link manager role).
    var snap = buildSnapshot(room);
    return snap ? snap.controllerLink : null;
  },

  // Generic combat helpers shared by roles/BeeCombatSquads CombatAPI (ES5-friendly).
  findClosestByRange: function (origin, objects) {
    if (!origin || !objects || !objects.length) return null;
    var pos = origin.pos ? origin.pos : origin;
    if (!pos || pos.x == null) return null;
    var closest = null;
    var best = 9999;
    for (var i = 0; i < objects.length; i++) {
      var obj = objects[i];
      if (!obj) continue;
      var targetPos = obj.pos ? obj.pos : obj;
      if (!targetPos || targetPos.x == null) continue;
      var range = pos.getRangeTo(targetPos);
      if (range < best) {
        best = range;
        closest = obj;
      }
    }
    return closest;
  },

  findWithinRange: function (origin, objects, maxRange) {
    if (!origin || !objects || !objects.length) return [];
    var pos = origin.pos ? origin.pos : origin;
    if (!pos || pos.x == null) return [];
    var range = (typeof maxRange === 'number') ? maxRange : 1;
    var matches = [];
    for (var i = 0; i < objects.length; i++) {
      var obj = objects[i];
      if (!obj) continue;
      var targetPos = obj.pos ? obj.pos : obj;
      if (!targetPos || targetPos.x == null) continue;
      if (pos.getRangeTo(targetPos) <= range) {
        matches.push(obj);
      }
    }
    return matches;
  }
};

module.exports = BeeSelectors;
