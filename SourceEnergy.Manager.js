'use strict';

// SourceEnergy.Manager is the source-first planner for both home and remote
// mining. It owns the per-home source plan that BeeSpawnManager turns into
// source-bound Veinseeker queue items.

var VeinseekerConfig = require('role.Veinseeker.Config');
var RoadPlanner = require('Planner.Road');
var BeeToolbox = require('BeeToolbox');
var MemoryUtils = require('core.memory');
var SourceWorkerManager = require('SourceWorker.Manager');

var RESERVE_TTL = 75;
var REMOTE_INTEL_TTL = (VeinseekerConfig && VeinseekerConfig.VEINSEEKER_REMOTE_INTEL_TTL) || 500;
var REMOTE_RADIUS = (VeinseekerConfig && VeinseekerConfig.REMOTE_RADIUS) || 3;
var MAX_PF_OPS = (VeinseekerConfig && VeinseekerConfig.MAX_PF_OPS) || 1000;
var PLAIN_COST = (VeinseekerConfig && VeinseekerConfig.PLAIN_COST) || 2;
var SWAMP_COST = (VeinseekerConfig && VeinseekerConfig.SWAMP_COST) || 10;
var SOURCE_REGEN_TICKS = (typeof ENERGY_REGEN_TIME !== 'undefined') ? ENERGY_REGEN_TIME : 300;
var SOURCE_CAPACITY = (typeof SOURCE_ENERGY_CAPACITY !== 'undefined') ? SOURCE_ENERGY_CAPACITY : 3000;
var HARVEST_RATE = (typeof HARVEST_POWER !== 'undefined') ? HARVEST_POWER : 2;
var CARRY_SIZE = (typeof CARRY_CAPACITY !== 'undefined') ? CARRY_CAPACITY : 50;
var CREEP_LIFETIME = (typeof CREEP_LIFE_TIME !== 'undefined') ? CREEP_LIFE_TIME : 1500;
var CLAIM_LIFETIME = (typeof CREEP_CLAIM_LIFE_TIME !== 'undefined') ? CREEP_CLAIM_LIFE_TIME : 600;
var SPAWN_TICKS_PER_PART = (typeof CREEP_SPAWN_TIME !== 'undefined') ? CREEP_SPAWN_TIME : 3;
var PART_COST = (typeof BODYPART_COST !== 'undefined') ? BODYPART_COST : {
  work: 100,
  carry: 50,
  move: 50,
  claim: 600
};
var WORK_PART = (typeof WORK !== 'undefined') ? WORK : 'work';
var CARRY_PART = (typeof CARRY !== 'undefined') ? CARRY : 'carry';
var MOVE_PART = (typeof MOVE !== 'undefined') ? MOVE : 'move';
var CLAIM_PART = (typeof CLAIM !== 'undefined') ? CLAIM : 'claim';

function ensureMemory() {
  var root = MemoryUtils.ensureBhmRoot('sourceEnergy', function () {
    return { tick: Game.time, homes: {} };
  });
  if (!root.homes) root.homes = {};
  root.tick = Game.time;
  return root;
}

function createHomePlan(homeRoom) {
  return {
    tick: Game.time,
    homeRoom: homeRoom,
    sources: {},
    sourceOrder: [],
    activeSourceIds: [],
    inactiveSourceIds: [],
    skippedSources: [],
    spawnDecisions: [],
    candidateRemoteRooms: [],
    acceptedRemoteRooms: [],
    rejectedRemoteRooms: [],
    activeSources: 0,
    inactiveSources: 0,
    homeSources: 0,
    remoteSources: 0,
    activeRemoteSources: 0,
    inactiveRemoteSources: 0,
    remoteSpawnBudget: 0,
    remoteSpawnUsed: 0,
    estimatedEnergyPerTick: 0,
    estimatedNetIncome: 0,
    estimatedSpawnUsage: 0,
    remoteSelection: null,
    desiredHomeVeinseekers: 0,
    desiredRemoteVeinseekers: 0,
    liveAssignedHomeVeinseekers: 0,
    liveAssignedRemoteVeinseekers: 0,
    liveIdleRemoteVeinseekers: 0,
    queuedHomeVeinseekers: 0,
    queuedRemoteVeinseekers: 0,
    lastAudit: 0
  };
}

function ensureHomeMemory(homeRoom) {
  var root = ensureMemory();
  if (!root.homes[homeRoom]) root.homes[homeRoom] = createHomePlan(homeRoom);
  var plan = root.homes[homeRoom];
  if (!plan.sources) plan.sources = {};
  if (!plan.sourceOrder) plan.sourceOrder = Object.keys(plan.sources);
  if (!plan.activeSourceIds) plan.activeSourceIds = [];
  if (!plan.inactiveSourceIds) plan.inactiveSourceIds = [];
  if (!plan.skippedSources) plan.skippedSources = [];
  if (!plan.spawnDecisions) plan.spawnDecisions = [];
  return plan;
}

function getRoomMemoryBucket(roomName) {
  return BeeToolbox.getRoomMemoryBucket(roomName);
}

function getMyUsername() {
  return BeeToolbox.myUsername();
}

function getRemoteIntelTick(roomName) {
  return BeeToolbox.getBestRemoteIntelTick(roomName);
}

function isRemoteUnsafe(roomName) {
  return BeeToolbox.isRemoteRoomUnsafe(roomName, {
    invaderLockTtl: (VeinseekerConfig && VeinseekerConfig.INVADER_LOCK_MEMO_TTL) || 1500,
    ignoreIntelOwnership: true
  });
}

function refreshVisibleRemoteSafety(room) {
  return BeeToolbox.refreshVisibleRemoteSafety(room);
}

function finiteOrNull(value) {
  return (typeof value === 'number' && isFinite(value)) ? value : null;
}

function cfgNumber(name, fallback) {
  var value = VeinseekerConfig && VeinseekerConfig[name];
  return (typeof value === 'number' && isFinite(value)) ? value : fallback;
}

function cfgBool(name, fallback) {
  if (!VeinseekerConfig || VeinseekerConfig[name] === undefined) return fallback;
  return VeinseekerConfig[name] !== false;
}

function bodyPartCost(part) {
  return PART_COST && typeof PART_COST[part] === 'number' ? PART_COST[part] : 0;
}

function roundMetric(value, digits) {
  if (typeof value !== 'number' || !isFinite(value)) return null;
  var factor = Math.pow(10, typeof digits === 'number' ? digits : 2);
  return Math.round(value * factor) / factor;
}

function isFiniteDistance(value) {
  return typeof value === 'number' && isFinite(value);
}

function addUnique(list, seen, value) {
  if (!value || seen[value]) return;
  seen[value] = true;
  list.push(value);
}

function getHomeName(homeRoom) {
  if (!homeRoom) return null;
  if (typeof homeRoom === 'string') return homeRoom;
  return homeRoom.name || null;
}

function getRouteDistanceBetweenRooms(homeName, remoteName) {
  return BeeToolbox.getRouteDistanceBetweenRooms(homeName, remoteName);
}

function getHomeAnchorPos(homeRoom) {
  var room = Game.rooms && Game.rooms[homeRoom];
  if (room) {
    if (room.storage) return room.storage.pos;
    var spawns = room.find(FIND_MY_SPAWNS) || [];
    if (spawns.length) return spawns[0].pos;
    if (room.controller) return room.controller.pos;
  }
  return new RoomPosition(25, 25, homeRoom);
}

function hasRemoteSpawnCapacity(homeRoom) {
  var room = Game.rooms && Game.rooms[homeRoom];
  if (!room) return false;
  return (room.energyCapacityAvailable || room.energyAvailable || 0) >= 200;
}

function serializePos(pos) {
  if (!pos) return null;
  return { x: pos.x, y: pos.y, roomName: pos.roomName };
}

function makeRoomPosition(posLike, fallbackRoom) {
  if (!posLike) return null;
  var roomName = posLike.roomName || fallbackRoom || null;
  if (!roomName) return null;
  if (typeof posLike.x !== 'number' || typeof posLike.y !== 'number') return null;
  return new RoomPosition(posLike.x, posLike.y, roomName);
}

function getSourcePosFromMemory(sourceMem, roomName) {
  if (!sourceMem) return null;
  if (sourceMem.pos) return makeRoomPosition(sourceMem.pos, roomName);
  return makeRoomPosition(sourceMem, roomName);
}

function isLocalOwnedRoomForVeinseeker(homeRoom, roomName) {
  if (!roomName) return { blocked: true, reason: 'missing-room' };
  var homeName = getHomeName(homeRoom);
  if (homeName && roomName === homeName) return { blocked: true, reason: 'home-room' };

  var room = Game.rooms[roomName];
  if (room && room.controller && room.controller.my) return { blocked: true, reason: 'local-owned-room' };
  if (room) {
    var visibleSpawns = room.find(FIND_MY_SPAWNS) || [];
    if (visibleSpawns.length > 0) return { blocked: true, reason: 'owned-spawn-room' };
  }

  for (var name in Game.spawns) {
    if (!Object.prototype.hasOwnProperty.call(Game.spawns, name)) continue;
    var spawn = Game.spawns[name];
    if (spawn && spawn.pos && spawn.pos.roomName === roomName) return { blocked: true, reason: 'owned-spawn-room' };
  }

  var myName = getMyUsername();
  var mem = (Memory.rooms && Memory.rooms[roomName]) || {};
  var intel = mem.intel || {};
  if (intel.owner && myName && intel.owner === myName) return { blocked: true, reason: 'local-owned-room' };
  return { blocked: false, reason: null };
}

function getScoutHome(homeRoom) {
  return Memory.__BHM &&
    Memory.__BHM.scoutIntel &&
    Memory.__BHM.scoutIntel.homes &&
    Memory.__BHM.scoutIntel.homes[homeRoom]
    ? Memory.__BHM.scoutIntel.homes[homeRoom]
    : null;
}

function getScoutRoomRecord(homeRoom, remoteRoom) {
  var home = getScoutHome(homeRoom);
  return home && home.rooms && home.rooms[remoteRoom] ? home.rooms[remoteRoom] : null;
}

function getScoutSourceRecord(homeRoom, remoteRoom, sourceId) {
  var roomRec = getScoutRoomRecord(homeRoom, remoteRoom);
  var sources = roomRec && roomRec.sources ? roomRec.sources : [];
  for (var i = 0; i < sources.length; i++) {
    if (sources[i] && sources[i].id === sourceId) return sources[i];
  }
  return null;
}

function getControllerBlockReason(homeRoom, remoteRoom) {
  var myName = getMyUsername();
  var room = Game.rooms[remoteRoom];
  var mem = (Memory.rooms && Memory.rooms[remoteRoom]) || {};
  var intel = mem.intel || {};
  var scout = getScoutRoomRecord(homeRoom, remoteRoom);
  var scoutController = scout && scout.controller ? scout.controller : null;
  var owner = null;
  var reservation = null;

  if (room && room.controller) {
    owner = room.controller.owner && room.controller.owner.username || null;
    reservation = room.controller.reservation && room.controller.reservation.username || null;
  } else if (scoutController) {
    owner = scoutController.owner || null;
    reservation = scoutController.reservation || null;
  } else {
    owner = intel.owner || null;
    reservation = intel.reservation || null;
  }

  if (owner && (!myName || owner !== myName)) return 'owned-by-other';
  if (reservation && (!myName || reservation !== myName)) return 'reserved-by-other';
  return null;
}

function getFreshIntelTick(homeRoom, remoteRoom) {
  var best = getRemoteIntelTick(remoteRoom);
  var scout = getScoutRoomRecord(homeRoom, remoteRoom);
  if (scout && typeof scout.lastSeen === 'number') best = Math.max(best || 0, scout.lastSeen);
  if (Game.rooms[remoteRoom]) best = Game.time;
  return best;
}

function getRemoteContainerStatusBySource(sourceId) {
  var status = Memory.__BHM && Memory.__BHM.remoteContainerStatus ? Memory.__BHM.remoteContainerStatus : {};
  for (var key in status) {
    if (!Object.prototype.hasOwnProperty.call(status, key)) continue;
    if (status[key] && status[key].sourceId === sourceId) return status[key];
  }
  return null;
}

function getContainerSummary(sourceId, roomName, sourceObj, sourceMem) {
  var container = sourceObj ? SourceWorkerManager.findSourceContainer(sourceObj) : null;
  if (container && container.structureType === STRUCTURE_CONTAINER) {
    return {
      status: 'built',
      containerId: container.id,
      x: container.pos.x,
      y: container.pos.y,
      roomName: container.pos.roomName,
      amount: container.store ? (container.store[RESOURCE_ENERGY] || 0) : 0,
      capacity: container.store ? (container.store.getCapacity(RESOURCE_ENERGY) || 2000) : 2000,
      updated: Game.time
    };
  }

  var builds = Memory.__BHM && Memory.__BHM.remoteContainerBuilds ? Memory.__BHM.remoteContainerBuilds : {};
  var build = builds[sourceId] || null;
  if (build) {
    return {
      status: build.status || 'unknown',
      containerId: build.containerId || null,
      siteId: build.siteId || null,
      x: typeof build.x === 'number' ? build.x : null,
      y: typeof build.y === 'number' ? build.y : null,
      roomName: build.roomName || build.remoteRoom || roomName,
      progress: build.progress || 0,
      progressTotal: build.progressTotal || 0,
      progressPct: build.progressPct || 0,
      updated: build.updated || build.lastSeen || 0
    };
  }

  var status = getRemoteContainerStatusBySource(sourceId);
  if (status) {
    return {
      status: status.status || 'built',
      containerId: status.containerId || status.id || null,
      x: typeof status.x === 'number' ? status.x : null,
      y: typeof status.y === 'number' ? status.y : null,
      roomName: status.roomName || status.remoteRoom || roomName,
      amount: status.amount || 0,
      capacity: status.capacity || 2000,
      updated: status.updated || status.lastSeen || 0
    };
  }

  var sourceContainer = sourceMem && sourceMem.container ? sourceMem.container : null;
  if (sourceContainer) {
    return {
      status: sourceContainer.status || 'unknown',
      containerId: sourceContainer.containerId || sourceMem.containerId || null,
      siteId: sourceContainer.siteId || null,
      x: typeof sourceContainer.x === 'number' ? sourceContainer.x : null,
      y: typeof sourceContainer.y === 'number' ? sourceContainer.y : null,
      roomName: sourceContainer.roomName || roomName,
      progress: sourceContainer.progress || 0,
      progressTotal: sourceContainer.progressTotal || 0,
      progressPct: sourceContainer.progressPct || 0,
      updated: sourceContainer.updated || 0
    };
  }

  if (sourceMem && sourceMem.containerId) {
    return {
      status: 'known-id',
      containerId: sourceMem.containerId,
      x: null,
      y: null,
      roomName: roomName,
      updated: sourceMem.lastSeen || 0
    };
  }

  return { status: 'unknown', containerId: null, x: null, y: null, roomName: roomName, updated: 0 };
}

function getVisiblePathCost(homeRoom, targetPos) {
  if (!targetPos || !Game.rooms[homeRoom] || !Game.rooms[targetPos.roomName]) return null;
  try {
    var result = PathFinder.search(getHomeAnchorPos(homeRoom), { pos: targetPos, range: 1 }, {
      maxOps: MAX_PF_OPS,
      plainCost: PLAIN_COST,
      swampCost: SWAMP_COST
    });
    if (result && !result.incomplete && result.path) return result.path.length;
  } catch (e) {
    var root = ensureMemory();
    root.lastPathFinderError = {
      tick: Game.time,
      homeRoom: homeRoom,
      targetRoom: targetPos.roomName,
      reason: e && e.message ? e.message : String(e)
    };
  }
  return null;
}

function estimatePathCost(homeRoom, remoteRoom, sourceId, sourceObj, sourceMem, scoutSource, routeDistance, pos) {
  var visible = sourceObj && sourceObj.pos ? getVisiblePathCost(homeRoom, sourceObj.pos) : null;
  if (visible !== null) return visible;
  if (scoutSource && typeof scoutSource.pathCost === 'number') return scoutSource.pathCost;
  if (sourceMem && typeof sourceMem.pathCost === 'number') return sourceMem.pathCost;
  if (sourceMem && typeof sourceMem.pathDistance === 'number') return sourceMem.pathDistance;
  if (sourceMem && typeof sourceMem.remotePathDistance === 'number') return sourceMem.remotePathDistance;
  if (sourceMem && typeof sourceMem.entrySteps === 'number' && isFiniteDistance(routeDistance)) {
    return (routeDistance * 50) + sourceMem.entrySteps;
  }
  if (isFiniteDistance(routeDistance)) return Math.max(1, routeDistance) * 50;
  return null;
}

function countKnownOpenTiles(sourceObj, sourceMem, scoutSource) {
  if (sourceObj && sourceObj.pos && sourceObj.room) {
    return SourceWorkerManager.countOpenHarvestTiles(sourceObj);
  }
  if (scoutSource && typeof scoutSource.openTiles === 'number') return scoutSource.openTiles;
  if (sourceMem && typeof sourceMem.openTiles === 'number') return sourceMem.openTiles;
  if (sourceMem && typeof sourceMem.seats === 'number') return sourceMem.seats;
  return null;
}

function sourceAccessReason(sourceObj, sourceMem, scoutSource) {
  var openTiles = countKnownOpenTiles(sourceObj, sourceMem, scoutSource);
  if (sourceObj && sourceObj.pos && openTiles > 0) return null;
  if (scoutSource && scoutSource.accessible === false) return scoutSource.blockedReason || 'source-inaccessible';
  if (sourceMem && sourceMem.accessible === false) return sourceMem.blockedReason || 'source-inaccessible';
  if (openTiles === 0) return 'no-harvest-tile';
  if (!sourceObj && openTiles === null) return 'unknown-access';
  return null;
}

function getHomeSpawnCount(homeRoom) {
  var count = 0;
  var room = Game.rooms && Game.rooms[homeRoom];
  if (room && room.find) {
    var roomSpawns = room.find(FIND_MY_SPAWNS) || [];
    count += roomSpawns.length;
  }
  for (var name in Game.spawns) {
    if (!Object.prototype.hasOwnProperty.call(Game.spawns, name)) continue;
    var spawn = Game.spawns[name];
    if (!spawn || !spawn.pos || spawn.pos.roomName !== homeRoom) continue;
    if (room && room.find) continue;
    count++;
  }
  return Math.max(1, count);
}

function getRemoteSpawnBudget(homeRoom) {
  var perSpawn = Math.max(0, cfgNumber('REMOTE_MAX_SPAWN_USAGE_PER_HOME', 0.45));
  return getHomeSpawnCount(homeRoom) * perSpawn;
}

function getRemoteRoadSummary(homeRoom, remoteRoom, sourceId, pathCost) {
  var key = remoteRoom && sourceId ? (remoteRoom + ':' + sourceId) : null;
  var rec = null;
  var mem = null;
  var homeObj = Game.rooms && Game.rooms[homeRoom];
  if (RoadPlanner && typeof RoadPlanner._memory === 'function' && homeObj) mem = RoadPlanner._memory(homeObj);
  else if (Memory.rooms && Memory.rooms[homeRoom] && Memory.rooms[homeRoom].roadPlanner) mem = Memory.rooms[homeRoom].roadPlanner;
  if (mem && mem.paths && key && mem.paths[key]) rec = mem.paths[key];
  var pathLength = rec && Array.isArray(rec.path) ? rec.path.length : finiteOrNull(pathCost);
  var placedIndex = rec && typeof rec.i === 'number' ? rec.i : null;
  return {
    key: key,
    status: rec ? (rec.done ? 'complete' : 'planned') : 'unknown',
    done: !!(rec && rec.done),
    pathLength: finiteOrNull(pathLength),
    placedIndex: placedIndex,
    roadCoveragePct: (rec && pathLength > 0 && typeof placedIndex === 'number') ? roundMetric(Math.min(1, placedIndex / pathLength), 3) : null
  };
}

function getReservationStatus(homeRoom, remoteRoom) {
  var myName = getMyUsername();
  var room = Game.rooms && Game.rooms[remoteRoom];
  var username = null;
  var ticksToEnd = null;
  if (room && room.controller && room.controller.reservation) {
    username = room.controller.reservation.username || null;
    ticksToEnd = room.controller.reservation.ticksToEnd || null;
  } else {
    var mem = (Memory.rooms && Memory.rooms[remoteRoom]) || {};
    var intel = mem.intel || {};
    var scout = getScoutRoomRecord(homeRoom, remoteRoom);
    var scoutController = scout && scout.controller ? scout.controller : null;
    var reservation = scoutController && scoutController.reservation !== undefined ? scoutController.reservation : intel.reservation;
    if (reservation && typeof reservation === 'object') {
      username = reservation.username || reservation.owner || reservation.name || null;
      ticksToEnd = reservation.ticksToEnd || reservation.ticks || null;
    } else if (typeof reservation === 'string') {
      username = reservation;
    }
  }
  if (username && myName && username === myName) {
    return { reserved: true, planned: false, username: username, ticksToEnd: ticksToEnd, reason: 'own-reservation' };
  }
  if (cfgBool('REMOTE_ASSUME_RESERVED', false)) {
    return { reserved: false, planned: true, username: myName || null, ticksToEnd: null, reason: 'config-assume-reserved' };
  }
  return { reserved: false, planned: false, username: username, ticksToEnd: ticksToEnd, reason: username ? 'reserved-by-other' : 'unreserved' };
}

function estimateRemoteSourceEconomics(homeRoom, remoteRoom, sourceId, routeDistance, pathCost, container, sourceObj, sourceMem, scoutSource, openTiles) {
  var oneWay = finiteOrNull(pathCost);
  if (oneWay === null && isFiniteDistance(routeDistance)) oneWay = Math.max(1, routeDistance) * 50;
  if (oneWay === null) oneWay = 100;

  var sourceCapacity = SOURCE_CAPACITY;
  if (sourceObj && typeof sourceObj.energyCapacity === 'number') sourceCapacity = sourceObj.energyCapacity;
  else if (scoutSource && typeof scoutSource.energyCapacity === 'number') sourceCapacity = scoutSource.energyCapacity;
  else if (sourceMem && typeof sourceMem.energyCapacity === 'number') sourceCapacity = sourceMem.energyCapacity;

  var fullEnergyPerTick = sourceCapacity / SOURCE_REGEN_TICKS;
  var reservation = getReservationStatus(homeRoom, remoteRoom);
  var arrivalMultiplier = cfgNumber('REMOTE_HAUL_EXPECTED_ARRIVAL_MULTIPLIER', 1.15);
  var roundTripTicks = Math.max(1, oneWay * 2 * arrivalMultiplier);
  var road = getRemoteRoadSummary(homeRoom, remoteRoom, sourceId, pathCost);
  var containerBuilt = container && container.status === 'built';
  var containerRepairLoss = containerBuilt ? cfgNumber('REMOTE_CONTAINER_REPAIR_LOSS', 0.10) : cfgNumber('REMOTE_UNBUILT_CONTAINER_PENALTY', 0.25);
  var roadUnits = Math.max(1, (finiteOrNull(road.pathLength) || oneWay) / 50);
  var roadMaintenanceLoss = roadUnits * cfgNumber('REMOTE_ROAD_MAINTENANCE_LOSS', 0.03);
  var maintenanceLoss = containerRepairLoss + roadMaintenanceLoss;
  var unreservedEnergyMultiplier = Math.max(0, cfgNumber('REMOTE_UNRESERVED_ENERGY_MULTIPLIER', 0.5));
  var currentReservedRate = reservation.reserved || reservation.planned;

  function estimateForReservationState(reservedLike) {
    var energyMultiplier = reservedLike ? 1 : unreservedEnergyMultiplier;
    var energyPerTick = fullEnergyPerTick * energyMultiplier;
    var harvestTiles = Math.max(1, openTiles || 1);
    var desiredWork = Math.max(1, Math.ceil(energyPerTick / HARVEST_RATE));
    if (harvestTiles <= 0) desiredWork = 0;
    var minerCarry = 1;
    var minerMove = Math.max(1, Math.ceil((desiredWork + minerCarry) / 2));
    var minerParts = desiredWork + minerCarry + minerMove;
    var minerBodyCost = desiredWork * bodyPartCost(WORK_PART) + minerCarry * bodyPartCost(CARRY_PART) + minerMove * bodyPartCost(MOVE_PART);
    var minerLifetime = Math.max(300, CREEP_LIFETIME - oneWay);
    var minerCostPerTick = minerBodyCost / minerLifetime;
    var minerSpawnUsage = (minerParts * SPAWN_TICKS_PER_PART) / minerLifetime;

    var carryParts = Math.max(1, Math.ceil((energyPerTick * roundTripTicks) / CARRY_SIZE));
    var roadComplete = containerBuilt && road.done;
    var haulerMove = roadComplete ? Math.max(1, Math.ceil(carryParts / 2)) : carryParts;
    var haulerParts = carryParts + haulerMove;
    var haulerBodyCost = carryParts * bodyPartCost(CARRY_PART) + haulerMove * bodyPartCost(MOVE_PART);
    var haulerCostPerTick = haulerBodyCost / CREEP_LIFETIME;
    var haulerSpawnUsage = (haulerParts * SPAWN_TICKS_PER_PART) / CREEP_LIFETIME;

    var reservationCostPerTick = 0;
    var reservationSpawnUsage = 0;
    if (reservedLike) {
      var reserverLifetime = Math.max(100, CLAIM_LIFETIME - oneWay);
      var reserverParts = 2;
      reservationCostPerTick = (bodyPartCost(CLAIM_PART) + bodyPartCost(MOVE_PART)) / reserverLifetime;
      reservationSpawnUsage = (reserverParts * SPAWN_TICKS_PER_PART) / reserverLifetime;
    }

    var netIncome = energyPerTick - minerCostPerTick - haulerCostPerTick - reservationCostPerTick - maintenanceLoss;
    var spawnUsage = minerSpawnUsage + haulerSpawnUsage + reservationSpawnUsage;
    var value = spawnUsage > 0 ? (netIncome / spawnUsage) : netIncome;
    return {
      energyMultiplier: energyMultiplier,
      energyPerTick: energyPerTick,
      desiredWork: desiredWork,
      minerBodyCost: minerBodyCost,
      minerCostPerTick: minerCostPerTick,
      minerSpawnUsage: minerSpawnUsage,
      haulerCarryParts: carryParts,
      haulerMoveParts: haulerMove,
      haulerBodyCost: haulerBodyCost,
      haulerCostPerTick: haulerCostPerTick,
      haulerSpawnUsage: haulerSpawnUsage,
      reservationCostPerTick: reservationCostPerTick,
      reservationSpawnUsage: reservationSpawnUsage,
      netIncome: netIncome,
      spawnUsage: spawnUsage,
      value: value
    };
  }

  var current = estimateForReservationState(currentReservedRate);
  var reservedPotential = estimateForReservationState(true);
  var remoteMinNetIncome = cfgNumber('REMOTE_MIN_NET_INCOME', 0.25);
  var currentNetIncome = current.netIncome;
  var reservedNetIncome = reservedPotential.netIncome;
  var reservationWouldHelp = !currentReservedRate && currentNetIncome < remoteMinNetIncome && reservedNetIncome >= remoteMinNetIncome;
  var reservationPotentialReason = reservation.reserved
    ? 'already-reserved'
    : (reservation.planned
      ? 'reservation-assumed'
      : (reservationWouldHelp
        ? 'reserved-potential-profitable'
        : (reservedNetIncome > currentNetIncome ? 'reserved-improves-but-still-low' : 'reserved-not-helpful')));

  return {
    sourceId: sourceId,
    roomName: remoteRoom,
    pathCost: finiteOrNull(pathCost),
    routeDistance: finiteOrNull(routeDistance),
    oneWayTicks: roundMetric(oneWay, 1),
    roundTripTicks: roundMetric(roundTripTicks, 1),
    reservation: reservation,
    sourceCapacity: sourceCapacity,
    fullEnergyPerTick: roundMetric(fullEnergyPerTick, 3),
    energyMultiplier: roundMetric(current.energyMultiplier, 3),
    energyPerTick: roundMetric(current.energyPerTick, 3),
    desiredWork: current.desiredWork,
    minerBodyCost: roundMetric(current.minerBodyCost, 1),
    minerCostPerTick: roundMetric(current.minerCostPerTick, 3),
    minerSpawnUsage: roundMetric(current.minerSpawnUsage, 4),
    haulerCarryParts: current.haulerCarryParts,
    haulerMoveParts: current.haulerMoveParts,
    haulerBodyCost: roundMetric(current.haulerBodyCost, 1),
    haulerCostPerTick: roundMetric(current.haulerCostPerTick, 3),
    haulerSpawnUsage: roundMetric(current.haulerSpawnUsage, 4),
    reservationCostPerTick: roundMetric(current.reservationCostPerTick, 3),
    reservationSpawnUsage: roundMetric(current.reservationSpawnUsage, 4),
    containerRepairLoss: roundMetric(containerRepairLoss, 3),
    roadMaintenanceLoss: roundMetric(roadMaintenanceLoss, 3),
    maintenanceLoss: roundMetric(maintenanceLoss, 3),
    currentNetIncome: roundMetric(currentNetIncome, 3),
    reservedNetIncome: roundMetric(reservedNetIncome, 3),
    reservationWouldHelp: reservationWouldHelp,
    reservationPotentialReason: reservationPotentialReason,
    reservedPotential: {
      energyMultiplier: roundMetric(reservedPotential.energyMultiplier, 3),
      energyPerTick: roundMetric(reservedPotential.energyPerTick, 3),
      desiredWork: reservedPotential.desiredWork,
      haulerCarryParts: reservedPotential.haulerCarryParts,
      haulerMoveParts: reservedPotential.haulerMoveParts,
      reservationCostPerTick: roundMetric(reservedPotential.reservationCostPerTick, 3),
      reservationSpawnUsage: roundMetric(reservedPotential.reservationSpawnUsage, 4),
      netIncome: roundMetric(reservedPotential.netIncome, 3),
      spawnUsage: roundMetric(reservedPotential.spawnUsage, 4),
      value: roundMetric(reservedPotential.value, 3)
    },
    reason: reservationPotentialReason,
    netIncome: roundMetric(current.netIncome, 3),
    spawnUsage: roundMetric(current.spawnUsage, 4),
    spawnWeight: roundMetric(current.spawnUsage, 4),
    value: roundMetric(current.value, 3)
  };
}

function makeSourceRecord(fields) {
  var container = fields.container || {};
  return {
    sourceId: fields.sourceId,
    homeRoom: fields.homeRoom,
    roomName: fields.roomName || fields.targetRoom,
    targetRoom: fields.targetRoom || fields.roomName,
    mode: fields.mode,
    x: typeof fields.x === 'number' ? fields.x : null,
    y: typeof fields.y === 'number' ? fields.y : null,
    distance: finiteOrNull(fields.distance),
    routeDistance: finiteOrNull(fields.routeDistance),
    pathCost: finiteOrNull(fields.pathCost),
    containerId: fields.containerId || container.containerId || null,
    container: container,
    containerStatus: container.status || null,
    road: fields.road || null,
    economics: fields.economics || null,
    reservationCandidate: !!(fields.reservationCandidate || (fields.economics && fields.economics.reservationWouldHelp)),
    energyPerTick: fields.energyPerTick !== undefined ? finiteOrNull(fields.energyPerTick) : (fields.economics ? finiteOrNull(fields.economics.energyPerTick) : null),
    netIncome: fields.netIncome !== undefined ? finiteOrNull(fields.netIncome) : (fields.economics ? finiteOrNull(fields.economics.netIncome) : null),
    spawnUsage: fields.spawnUsage !== undefined ? finiteOrNull(fields.spawnUsage) : (fields.economics ? finiteOrNull(fields.economics.spawnUsage) : null),
    spawnWeight: fields.spawnWeight !== undefined ? finiteOrNull(fields.spawnWeight) : (fields.economics ? finiteOrNull(fields.economics.spawnWeight) : null),
    activationReason: fields.activationReason || null,
    rejectionReason: fields.rejectionReason || null,
    activeHaulPressure: fields.activeHaulPressure || null,
    status: fields.status || 'open',
    reason: fields.reason || 'planned',
    assignedVeinseeker: fields.assignedVeinseeker || null,
    queuedVeinseeker: fields.queuedVeinseeker || null,
    queuedUntil: fields.queuedUntil || 0,
    lastSeen: fields.lastSeen || 0,
    lastValidated: fields.lastValidated || Game.time,
    active: !!fields.active,
    desiredWork: fields.desiredWork || 0,
    liveWork: fields.liveWork || 0,
    queuedWork: fields.queuedWork || 0,
    seats: fields.seats || 0,
    openSeats: fields.openSeats || 0,
    live: fields.live || 0,
    queued: fields.queued || 0,
    activeLive: fields.activeLive || 0
  };
}

function addRecord(plan, record) {
  if (!record || !record.sourceId) return;
  plan.sources[record.sourceId] = record;
  plan.sourceOrder.push(record.sourceId);
  if (record.active) {
    plan.activeSourceIds.push(record.sourceId);
    plan.activeSources++;
    if (record.mode === 'home') plan.homeSources++;
    if (record.mode === 'remote') plan.remoteSources++;
  } else {
    plan.inactiveSourceIds.push(record.sourceId);
    plan.inactiveSources++;
    plan.skippedSources.push({
      sourceId: record.sourceId,
      roomName: record.roomName,
      mode: record.mode,
      status: record.status,
      reason: record.reason
    });
  }
}

function buildHomeSources(plan, oldSources) {
  var homeRoom = plan.homeRoom;
  var room = Game.rooms[homeRoom];
  if (!room) {
    plan.skippedSources.push({ roomName: homeRoom, mode: 'home', status: 'stale', reason: 'home-room-not-visible' });
    return;
  }

  var sources = room.find(FIND_SOURCES) || [];
  for (var i = 0; i < sources.length; i++) {
    var source = sources[i];
    var prev = oldSources[source.id] || {};
    var seats = SourceWorkerManager.getSourceSeatCount(source);
    var status = SourceWorkerManager.getSourceMiningStatus(room.name, source, null, {});
    var container = getContainerSummary(source.id, room.name, source, (Memory.rooms[room.name] && Memory.rooms[room.name].sources && Memory.rooms[room.name].sources[source.id]) || {});
    var active = seats > 0;
    addRecord(plan, makeSourceRecord({
      sourceId: source.id,
      homeRoom: homeRoom,
      roomName: room.name,
      targetRoom: room.name,
      mode: 'home',
      x: source.pos.x,
      y: source.pos.y,
      distance: getHomeAnchorPos(homeRoom).getRangeTo(source.pos),
      routeDistance: 0,
      pathCost: null,
      container: container,
      active: active,
      status: active ? 'open' : 'blocked',
      reason: active ? 'planned-home-source' : 'no-harvest-tile',
      lastSeen: Game.time,
      lastValidated: Game.time,
      assignedVeinseeker: prev.assignedVeinseeker || null,
      queuedVeinseeker: prev.queuedVeinseeker || null,
      queuedUntil: prev.queuedUntil || 0,
      desiredWork: status.desiredWork || SourceWorkerManager.getDesiredWorkForSource(source),
      liveWork: status.liveWork || 0,
      queuedWork: status.queuedWork || 0,
      seats: seats,
      openSeats: Math.max(0, seats - ((status.live || 0) + (status.queued || 0))),
      live: status.live || 0,
      queued: status.queued || 0,
      activeLive: status.activeLive || 0
    }));
  }
}

function listRemoteSourceCandidates(homeRoom, remoteRoom) {
  var out = [];
  var room = Game.rooms[remoteRoom];
  var roomMem = (Memory.rooms && Memory.rooms[remoteRoom]) || {};
  var sourceMemMap = roomMem.sources || {};
  var scout = getScoutRoomRecord(homeRoom, remoteRoom);
  var seen = {};

  if (room) {
    var liveSources = room.find(FIND_SOURCES) || [];
    for (var i = 0; i < liveSources.length; i++) {
      var source = liveSources[i];
      seen[source.id] = true;
      out.push({
        sourceId: source.id,
        sourceObj: source,
        sourceMem: sourceMemMap[source.id] || {},
        scoutSource: getScoutSourceRecord(homeRoom, remoteRoom, source.id),
        pos: source.pos
      });
    }
  }

  if (scout && scout.sources) {
    for (var s = 0; s < scout.sources.length; s++) {
      var scoutSource = scout.sources[s];
      if (!scoutSource || !scoutSource.id || seen[scoutSource.id]) continue;
      seen[scoutSource.id] = true;
      out.push({
        sourceId: scoutSource.id,
        sourceObj: null,
        sourceMem: sourceMemMap[scoutSource.id] || {},
        scoutSource: scoutSource,
        pos: makeRoomPosition(scoutSource, remoteRoom)
      });
    }
  }

  for (var sid in sourceMemMap) {
    if (!Object.prototype.hasOwnProperty.call(sourceMemMap, sid)) continue;
    if (seen[sid]) continue;
    var mem = sourceMemMap[sid] || {};
    seen[sid] = true;
    out.push({
      sourceId: sid,
      sourceObj: null,
      sourceMem: mem,
      scoutSource: getScoutSourceRecord(homeRoom, remoteRoom, sid),
      pos: getSourcePosFromMemory(mem, remoteRoom)
    });
  }

  return out;
}

function makeInactiveRemoteRecord(plan, remoteRoom, sourceId, pos, reason, oldRecord, sourceMem, scoutSource) {
  var container = getContainerSummary(sourceId, remoteRoom, null, sourceMem || {});
  addRecord(plan, makeSourceRecord({
    sourceId: sourceId || (remoteRoom + ':unknown:' + plan.skippedSources.length),
    homeRoom: plan.homeRoom,
    roomName: remoteRoom,
    targetRoom: remoteRoom,
    mode: 'remote',
    x: pos && typeof pos.x === 'number' ? pos.x : null,
    y: pos && typeof pos.y === 'number' ? pos.y : null,
    routeDistance: getRouteDistanceBetweenRooms(plan.homeRoom, remoteRoom),
    pathCost: null,
    container: container,
    active: false,
    status: reason === 'unsafe' ? 'unsafe' : (reason === 'stale-intel' ? 'stale' : 'blocked'),
    reason: reason,
    rejectionReason: reason,
    lastSeen: (sourceMem && sourceMem.lastSeen) || (scoutSource && scoutSource.lastSeen) || 0,
    lastValidated: Game.time,
    assignedVeinseeker: oldRecord && oldRecord.assignedVeinseeker || null,
    queuedVeinseeker: oldRecord && oldRecord.queuedVeinseeker || null,
    queuedUntil: oldRecord && oldRecord.queuedUntil || 0
  }));
}

function buildRemoteSources(plan, remoteRooms, oldSources) {
  var homeRoom = plan.homeRoom;
  for (var i = 0; i < remoteRooms.length; i++) {
    var remoteRoom = remoteRooms[i];
    if (!remoteRoom) continue;

    var roomLevelReason = null;
    var localOwned = isLocalOwnedRoomForVeinseeker(homeRoom, remoteRoom);
    var routeDistance = getRouteDistanceBetweenRooms(homeRoom, remoteRoom);
    var intelTick = getFreshIntelTick(homeRoom, remoteRoom);
    var controllerReason = getControllerBlockReason(homeRoom, remoteRoom);
    if (localOwned.blocked) roomLevelReason = localOwned.reason;
    else if (!hasRemoteSpawnCapacity(homeRoom)) roomLevelReason = 'insufficient-spawn-capacity';
    else if (!isFiniteDistance(routeDistance)) roomLevelReason = 'no-route';
    else if (isRemoteUnsafe(remoteRoom)) roomLevelReason = 'unsafe';
    else if (controllerReason) roomLevelReason = controllerReason;
    else if (!Game.rooms[remoteRoom] && (intelTick === null || (Game.time - intelTick) > REMOTE_INTEL_TTL)) roomLevelReason = 'stale-intel';

    var candidates = listRemoteSourceCandidates(homeRoom, remoteRoom);
    if (!candidates.length) {
      plan.skippedSources.push({
        roomName: remoteRoom,
        mode: 'remote',
        status: roomLevelReason ? 'blocked' : 'stale',
        reason: roomLevelReason || 'no-known-sources'
      });
      continue;
    }

    for (var c = 0; c < candidates.length; c++) {
      var item = candidates[c];
      var sourceId = item.sourceId;
      var sourceMem = item.sourceMem || {};
      var scoutSource = item.scoutSource || null;
      var sourceObj = item.sourceObj || null;
      var pos = sourceObj && sourceObj.pos ? sourceObj.pos : item.pos;
      var old = oldSources[sourceId] || {};

      if (roomLevelReason) {
        makeInactiveRemoteRecord(plan, remoteRoom, sourceId, pos, roomLevelReason, old, sourceMem, scoutSource);
        continue;
      }
      if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') {
        makeInactiveRemoteRecord(plan, remoteRoom, sourceId, pos, 'missing-source-position', old, sourceMem, scoutSource);
        continue;
      }
      if (sourceMem.disabled === true) {
        makeInactiveRemoteRecord(plan, remoteRoom, sourceId, pos, sourceMem.disabledReason || 'disabled', old, sourceMem, scoutSource);
        continue;
      }
      if (sourceMem.sourceWorkerBlockedUntil && sourceMem.sourceWorkerBlockedUntil > Game.time) {
        makeInactiveRemoteRecord(plan, remoteRoom, sourceId, pos, sourceMem.sourceWorkerBlockedReason || 'source-blocked', old, sourceMem, scoutSource);
        continue;
      }

      var accessReason = sourceAccessReason(sourceObj, sourceMem, scoutSource);
      if (accessReason) {
        makeInactiveRemoteRecord(plan, remoteRoom, sourceId, pos, accessReason, old, sourceMem, scoutSource);
        continue;
      }

      var pathCost = estimatePathCost(homeRoom, remoteRoom, sourceId, sourceObj, sourceMem, scoutSource, routeDistance, pos);
      if (pathCost === null && sourceObj && Game.rooms[homeRoom] && Game.rooms[remoteRoom]) {
        makeInactiveRemoteRecord(plan, remoteRoom, sourceId, pos, 'no-path', old, sourceMem, scoutSource);
        continue;
      }

      var container = getContainerSummary(sourceId, remoteRoom, sourceObj, sourceMem);
      var openTiles = countKnownOpenTiles(sourceObj, sourceMem, scoutSource);
      var road = getRemoteRoadSummary(homeRoom, remoteRoom, sourceId, pathCost);
      var economics = estimateRemoteSourceEconomics(homeRoom, remoteRoom, sourceId, routeDistance, pathCost, container, sourceObj, sourceMem, scoutSource, openTiles);
      addRecord(plan, makeSourceRecord({
        sourceId: sourceId,
        homeRoom: homeRoom,
        roomName: remoteRoom,
        targetRoom: remoteRoom,
        mode: 'remote',
        x: pos.x,
        y: pos.y,
        distance: pathCost,
        routeDistance: routeDistance,
        pathCost: pathCost,
        container: container,
        road: road,
        economics: economics,
        energyPerTick: economics && economics.energyPerTick,
        netIncome: economics && economics.netIncome,
        spawnUsage: economics && economics.spawnUsage,
        spawnWeight: economics && economics.spawnWeight,
        active: true,
        status: 'open',
        reason: 'remote-source-candidate',
        assignedVeinseeker: old.assignedVeinseeker || null,
        queuedVeinseeker: old.queuedVeinseeker || null,
        queuedUntil: old.queuedUntil || 0,
        lastSeen: sourceObj ? Game.time : (sourceMem.lastSeen || (scoutSource && scoutSource.lastSeen) || intelTick || 0),
        lastValidated: Game.time,
        desiredWork: 1,
        seats: Math.max(1, openTiles || 1),
        openSeats: Math.max(1, openTiles || 1)
      }));
    }
  }
}

function rebuildPlanIndexes(plan, keepSkipped) {
  keepSkipped = keepSkipped || [];
  plan.activeSourceIds = [];
  plan.inactiveSourceIds = [];
  plan.skippedSources = keepSkipped.slice(0);
  plan.activeSources = 0;
  plan.inactiveSources = 0;
  plan.homeSources = 0;
  plan.remoteSources = 0;
  plan.activeRemoteSources = 0;
  plan.inactiveRemoteSources = 0;
  var seen = {};
  var ordered = [];
  for (var i = 0; i < plan.sourceOrder.length; i++) {
    var sourceId = plan.sourceOrder[i];
    if (!sourceId || seen[sourceId]) continue;
    var rec = plan.sources[sourceId];
    if (!rec) continue;
    seen[sourceId] = true;
    ordered.push(sourceId);
    if (rec.active) {
      plan.activeSourceIds.push(sourceId);
      plan.activeSources++;
      if (rec.mode === 'home') plan.homeSources++;
      if (rec.mode === 'remote') {
        plan.remoteSources++;
        plan.activeRemoteSources++;
      }
    } else {
      plan.inactiveSourceIds.push(sourceId);
      plan.inactiveSources++;
      if (rec.mode === 'remote') plan.inactiveRemoteSources++;
      plan.skippedSources.push({
        sourceId: rec.sourceId,
        roomName: rec.roomName,
        mode: rec.mode,
        status: rec.status,
        reason: rec.rejectionReason || rec.reason
      });
    }
  }
  plan.sourceOrder = ordered;
}

function selectProfitableRemoteSources(homeRoom, plan) {
  var keepSkipped = [];
  for (var s = 0; s < plan.skippedSources.length; s++) {
    var skip = plan.skippedSources[s];
    if (!skip || !skip.sourceId || !plan.sources[skip.sourceId]) keepSkipped.push(skip);
  }

  var enabled = cfgBool('REMOTE_PROFITABILITY_ENABLED', true);
  var allowUnprofitable = cfgBool('REMOTE_ALLOW_UNPROFITABLE', false);
  var minNetIncome = cfgNumber('REMOTE_MIN_NET_INCOME', 0.25);
  var maxActive = Math.max(0, Math.floor(cfgNumber('REMOTE_MAX_ACTIVE_SOURCES_PER_HOME', 4)));
  var spawnBudget = getRemoteSpawnBudget(homeRoom);
  var used = 0;
  var candidates = [];
  var selected = [];
  var rejected = [];

  function makeRemoteSelectionDiagnostic(rec, reason) {
    var economics = rec && rec.economics ? rec.economics : {};
    return {
      sourceId: rec && rec.sourceId,
      roomName: rec && rec.roomName,
      reason: reason,
      netIncome: rec && rec.netIncome,
      spawnUsage: rec && rec.spawnUsage,
      value: economics.value,
      currentNetIncome: economics.currentNetIncome,
      reservedNetIncome: economics.reservedNetIncome,
      reservationWouldHelp: !!economics.reservationWouldHelp,
      reservationPotentialReason: economics.reservationPotentialReason || economics.reason || null
    };
  }

  for (var i = 0; i < plan.sourceOrder.length; i++) {
    var rec = plan.sources[plan.sourceOrder[i]];
    if (!rec || rec.mode !== 'remote') continue;
    if (!rec.active) {
      rec.rejectionReason = rec.rejectionReason || rec.reason || 'inactive-before-selection';
      rejected.push(makeRemoteSelectionDiagnostic(rec, rec.rejectionReason));
      continue;
    }
    candidates.push(rec);
  }

  candidates.sort(function (a, b) {
    var av = a.economics && typeof a.economics.value === 'number' ? a.economics.value : -99999;
    var bv = b.economics && typeof b.economics.value === 'number' ? b.economics.value : -99999;
    if (bv !== av) return bv - av;
    var an = typeof a.netIncome === 'number' ? a.netIncome : -99999;
    var bn = typeof b.netIncome === 'number' ? b.netIncome : -99999;
    if (bn !== an) return bn - an;
    var ap = typeof a.pathCost === 'number' ? a.pathCost : 99999;
    var bp = typeof b.pathCost === 'number' ? b.pathCost : 99999;
    if (ap !== bp) return ap - bp;
    return a.sourceId < b.sourceId ? -1 : (a.sourceId > b.sourceId ? 1 : 0);
  });

  for (var c = 0; c < candidates.length; c++) {
    var candidate = candidates[c];
    var economics = candidate.economics || null;
    var spawnUsage = economics && typeof economics.spawnUsage === 'number' ? economics.spawnUsage : null;
    var netIncome = economics && typeof economics.netIncome === 'number' ? economics.netIncome : null;
    var reason = null;
    if (!enabled) reason = null;
    else if (!economics) reason = 'missing-economics';
    else if (!allowUnprofitable && netIncome !== null && netIncome < minNetIncome) reason = 'low-net-income';
    else if (selected.length >= maxActive) reason = 'max-active-sources';
    else if (spawnUsage !== null && used + spawnUsage > spawnBudget) reason = 'spawn-budget-exhausted';

    if (reason) {
      candidate.active = false;
      candidate.status = 'inactive';
      candidate.reason = reason;
      candidate.rejectionReason = reason;
      candidate.activationReason = null;
      rejected.push(makeRemoteSelectionDiagnostic(candidate, reason));
      continue;
    }

    candidate.active = true;
    candidate.status = candidate.status === 'assigned' || candidate.status === 'queued' ? candidate.status : 'open';
    candidate.reason = enabled ? 'active-profitable-remote-source' : 'profitability-disabled';
    candidate.activationReason = enabled ? 'selected-net-income-spawn-budget' : 'profitability-disabled';
    candidate.rejectionReason = null;
    used += spawnUsage || 0;
    selected.push(makeRemoteSelectionDiagnostic(candidate, candidate.activationReason));
  }

  plan.remoteSpawnBudget = roundMetric(spawnBudget, 4) || 0;
  plan.remoteSpawnUsed = roundMetric(used, 4) || 0;
  plan.estimatedEnergyPerTick = 0;
  plan.estimatedNetIncome = 0;
  plan.estimatedSpawnUsage = 0;
  for (var o = 0; o < plan.sourceOrder.length; o++) {
    var src = plan.sources[plan.sourceOrder[o]];
    if (!src || src.mode !== 'remote' || !src.active || !src.economics) continue;
    plan.estimatedEnergyPerTick += src.economics.energyPerTick || 0;
    plan.estimatedNetIncome += src.economics.netIncome || 0;
    plan.estimatedSpawnUsage += src.economics.spawnUsage || 0;
  }
  plan.estimatedEnergyPerTick = roundMetric(plan.estimatedEnergyPerTick, 3) || 0;
  plan.estimatedNetIncome = roundMetric(plan.estimatedNetIncome, 3) || 0;
  plan.estimatedSpawnUsage = roundMetric(plan.estimatedSpawnUsage, 4) || 0;
  plan.remoteSelection = {
    tick: Game.time,
    enabled: enabled,
    allowUnprofitable: allowUnprofitable,
    minNetIncome: minNetIncome,
    spawnBudget: plan.remoteSpawnBudget,
    spawnUsed: plan.remoteSpawnUsed,
    maxActiveSources: maxActive,
    candidates: candidates.length,
    selected: selected,
    rejected: rejected
  };
  rebuildPlanIndexes(plan, keepSkipped);
  return plan.remoteSelection;
}

function gatherCandidateRemoteRoomsForHome(homeRoom) {
  var homeName = getHomeName(homeRoom);
  var homeObj = typeof homeRoom === 'string' ? Game.rooms[homeRoom] : homeRoom;
  var out = { candidateRemoteRooms: [], acceptedRemoteRooms: [], rejectedRemoteRooms: [] };
  if (!homeName) return out;

  var discovered = [];
  var seen = {};
  var sourceTags = {};

  if (RoadPlanner && typeof RoadPlanner.getActiveRemoteRooms === 'function' && homeObj) {
    var active = RoadPlanner.getActiveRemoteRooms(homeObj) || [];
    for (var i = 0; i < active.length; i++) {
      addUnique(discovered, seen, active[i]);
      sourceTags[active[i]] = 'roadPlanner';
    }
  }

  var scoutHome = getScoutHome(homeName);
  if (scoutHome && scoutHome.rooms) {
    for (var scoutRoom in scoutHome.rooms) {
      if (!Object.prototype.hasOwnProperty.call(scoutHome.rooms, scoutRoom)) continue;
      addUnique(discovered, seen, scoutRoom);
      if (!sourceTags[scoutRoom]) sourceTags[scoutRoom] = 'scout';
    }
  }

  var memRooms = Memory.rooms || {};
  for (var rn in memRooms) {
    if (!Object.prototype.hasOwnProperty.call(memRooms, rn)) continue;
    if (rn === homeName) continue;
    var mem = memRooms[rn] || {};
    var hasSources = !!(mem.sources && Object.keys(mem.sources).length > 0);
    if (!hasSources && !(mem.intel && mem.intel.sources > 0)) continue;
    if (Game.map.getRoomLinearDistance(homeName, rn) > REMOTE_RADIUS) continue;
    addUnique(discovered, seen, rn);
    if (!sourceTags[rn]) sourceTags[rn] = 'memory';
  }

  for (var visibleName in Game.rooms) {
    if (!Object.prototype.hasOwnProperty.call(Game.rooms, visibleName)) continue;
    if (visibleName === homeName) continue;
    if (Game.map.getRoomLinearDistance(homeName, visibleName) > REMOTE_RADIUS) continue;
    var visible = Game.rooms[visibleName];
    if (!visible || !visible.find || !(visible.find(FIND_SOURCES) || []).length) continue;
    addUnique(discovered, seen, visibleName);
    if (!sourceTags[visibleName]) sourceTags[visibleName] = 'visible';
  }

  out.candidateRemoteRooms = discovered.slice(0);
  for (var d = 0; d < discovered.length; d++) {
    var remoteName = discovered[d];
    var reason = null;
    var localOwned = isLocalOwnedRoomForVeinseeker(homeName, remoteName);
    var routeDistance = getRouteDistanceBetweenRooms(homeName, remoteName);
    var intelTick = getFreshIntelTick(homeName, remoteName);
    var controllerReason = getControllerBlockReason(homeName, remoteName);

    if (localOwned.blocked) reason = localOwned.reason;
    else if (!hasRemoteSpawnCapacity(homeName)) reason = 'insufficient-spawn-capacity';
    else if (Game.map.getRoomLinearDistance(homeName, remoteName) > REMOTE_RADIUS) reason = 'beyond-radius';
    else if (!isFiniteDistance(routeDistance)) reason = 'no-route';
    else if (isRemoteUnsafe(remoteName)) reason = 'unsafe';
    else if (controllerReason) reason = controllerReason;
    else if (!Game.rooms[remoteName] && (intelTick === null || (Game.time - intelTick) > REMOTE_INTEL_TTL)) reason = 'stale-intel';

    if (reason) out.rejectedRemoteRooms.push({ room: remoteName, reason: reason, source: sourceTags[remoteName] || 'unknown' });
    else out.acceptedRemoteRooms.push(remoteName);
  }

  out.acceptedRemoteRooms.sort(function (a, b) {
    var routeA = getRouteDistanceBetweenRooms(homeName, a);
    var routeB = getRouteDistanceBetweenRooms(homeName, b);
    if (routeA !== routeB) return routeA - routeB;
    var linearA = Game.map.getRoomLinearDistance(homeName, a);
    var linearB = Game.map.getRoomLinearDistance(homeName, b);
    if (linearA !== linearB) return linearA - linearB;
    return a < b ? -1 : (a > b ? 1 : 0);
  });

  return out;
}

function normalizeRemoteDiscovery(homeRoom, remoteDiscovery) {
  if (Array.isArray(remoteDiscovery)) {
    return {
      candidateRemoteRooms: remoteDiscovery.slice(0),
      acceptedRemoteRooms: remoteDiscovery.slice(0),
      rejectedRemoteRooms: []
    };
  }
  if (remoteDiscovery && remoteDiscovery.acceptedRemoteRooms) return remoteDiscovery;
  return gatherCandidateRemoteRoomsForHome(homeRoom);
}

function buildSourcePlanForHome(homeRoom, remoteDiscovery) {
  var homeName = getHomeName(homeRoom);
  if (!homeName) return null;
  var old = ensureHomeMemory(homeName);
  var oldSources = old.sources || {};
  var discovery = normalizeRemoteDiscovery(homeName, remoteDiscovery);
  var plan = createHomePlan(homeName);
  plan.truckerRemoteHaulDecisions = old.truckerRemoteHaulDecisions || (Memory.rooms && Memory.rooms[homeName] && Memory.rooms[homeName].lastRemoteHaulRequestAudit) || null;
  plan.candidateRemoteRooms = discovery.candidateRemoteRooms || [];
  plan.acceptedRemoteRooms = discovery.acceptedRemoteRooms || [];
  plan.rejectedRemoteRooms = discovery.rejectedRemoteRooms || [];

  buildHomeSources(plan, oldSources);
  buildRemoteSources(plan, plan.acceptedRemoteRooms, oldSources);
  selectProfitableRemoteSources(homeName, plan);

  ensureMemory().homes[homeName] = plan;
  writePlanDiagnostics(homeName);
  return plan;
}

function isVeinseekerMemory(mem) {
  return SourceWorkerManager.isVeinseekerMemory(mem);
}

function isVeinseekerQueueItem(item) {
  return item && item.role === 'Veinseeker';
}

function queueItemSourceId(item) {
  return SourceWorkerManager.getQueueSourceId(item);
}

function creepSourceId(creep) {
  return SourceWorkerManager.getSourceIdFromMemory(creep && creep.memory);
}

function getCreepHome(creep) {
  return SourceWorkerManager.getCreepHomeRoomName(creep);
}

function removeQueuedVeinseekerForSource(homeRoom, sourceId, mode) {
  var roomMem = getRoomMemoryBucket(homeRoom);
  var q = roomMem.spawnQueue || [];
  var kept = [];
  var removed = 0;
  for (var i = 0; i < q.length; i++) {
    var item = q[i];
    if (isVeinseekerQueueItem(item) &&
        queueItemSourceId(item) === sourceId &&
        (!mode || item.mode === mode)) {
      removed++;
      continue;
    }
    kept.push(item);
  }
  roomMem.spawnQueue = kept;
  return removed;
}

function assignCreepToRemoteSource(creep, rec, reason) {
  if (!creep || !creep.memory || !rec || !rec.sourceId || rec.mode !== 'remote' || !rec.active) return false;
  creep.memory.role = 'Veinseeker';
  creep.memory.task = 'veinseeker';
  creep.memory.mode = 'remote';
  creep.memory.home = rec.homeRoom;
  creep.memory.sourceId = rec.sourceId;
  creep.memory.assignedSource = rec.sourceId;
  creep.memory.targetRoom = rec.targetRoom || rec.roomName;
  creep.memory.roomName = rec.targetRoom || rec.roomName;
  creep.memory._assignTick = Game.time;
  creep.memory._sourcePlanAssignReason = reason || 'source-plan';
  rec.assignedVeinseeker = creep.name;
  rec.queuedVeinseeker = null;
  rec.queuedUntil = 0;
  rec.status = 'assigned';
  rec.reason = 'live-idle-veinseeker-assigned';
  removeQueuedVeinseekerForSource(rec.homeRoom, rec.sourceId, 'remote');
  return true;
}

function assignIdleRemoteVeinseeker(creep) {
  if (!creep || !creep.memory) return null;
  var homeRoom = creep.memory.home || creep.memory._home || (creep.room && creep.room.name);
  if (!homeRoom) return null;
  var plan = ensureHomeMemory(homeRoom);
  var liveBySource = countLiveAssignments(plan).bySource;
  var ordered = [];
  for (var i = 0; i < plan.sourceOrder.length; i++) {
    var rec = plan.sources[plan.sourceOrder[i]];
    if (rec && rec.active && rec.mode === 'remote' && !liveBySource[rec.sourceId]) ordered.push(rec);
  }
  ordered.sort(function (a, b) {
    var da = typeof a.routeDistance === 'number' ? a.routeDistance : 9999;
    var db = typeof b.routeDistance === 'number' ? b.routeDistance : 9999;
    if (da !== db) return da - db;
    var pa = typeof a.pathCost === 'number' ? a.pathCost : 9999;
    var pb = typeof b.pathCost === 'number' ? b.pathCost : 9999;
    if (pa !== pb) return pa - pb;
    return a.sourceId < b.sourceId ? -1 : (a.sourceId > b.sourceId ? 1 : 0);
  });
  for (var j = 0; j < ordered.length; j++) {
    var rec = ordered[j];
    if (!rec || liveBySource[rec.sourceId]) continue;
    if (assignCreepToRemoteSource(creep, rec, 'idle-remote-reused')) {
      recordSpawnDecision(homeRoom, {
        sourceId: rec.sourceId,
        roomName: rec.roomName,
        mode: 'remote',
        action: 'assign-live-idle',
        creepName: creep.name,
        reason: 'live-unassigned-before-queue'
      });
      writePlanDiagnostics(homeRoom);
      return rec;
    }
  }
  return null;
}

function countLiveAssignments(plan) {
  var bySource = {};
  var homeAssigned = 0;
  var remoteAssigned = 0;
  var idleRemote = [];
  for (var name in Game.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Game.creeps, name)) continue;
    var creep = Game.creeps[name];
    if (!creep || !creep.my || !creep.memory || !isVeinseekerMemory(creep.memory)) continue;
    if (getCreepHome(creep) !== plan.homeRoom) continue;
    if (creep.spawning) continue;
    var mode = creep.memory.mode === 'remote' ? 'remote' : 'home';
    var sid = creepSourceId(creep);
    if (mode === 'remote' && !sid) {
      idleRemote.push(creep);
      continue;
    }
    if (!sid) continue;
    if (!bySource[sid]) bySource[sid] = [];
    bySource[sid].push(creep);
    if (mode === 'remote') remoteAssigned++;
    else homeAssigned++;
  }
  return {
    bySource: bySource,
    homeAssigned: homeAssigned,
    remoteAssigned: remoteAssigned,
    idleRemote: idleRemote
  };
}

function countQueuedAssignments(plan) {
  var bySource = {};
  var homeQueued = 0;
  var remoteQueued = 0;
  var invalid = [];
  var q = (Memory.rooms && Memory.rooms[plan.homeRoom] && Memory.rooms[plan.homeRoom].spawnQueue) || [];
  for (var i = 0; i < q.length; i++) {
    var item = q[i];
    if (!isVeinseekerQueueItem(item)) continue;
    var sid = queueItemSourceId(item);
    if (!sid) {
      invalid.push({ index: i, role: item.role, mode: item.mode || null, reason: 'missing-source-id' });
      continue;
    }
    if (item.mode === 'remote' && !item.targetRoom) {
      invalid.push({ index: i, role: item.role, mode: item.mode, sourceId: sid, reason: 'missing-target-room' });
      continue;
    }
    if (!bySource[sid]) bySource[sid] = [];
    bySource[sid].push(item);
    if (item.mode === 'remote') remoteQueued++;
    else homeQueued++;
  }
  return {
    bySource: bySource,
    homeQueued: homeQueued,
    remoteQueued: remoteQueued,
    invalid: invalid
  };
}

function auditAssignmentsForHome(homeRoom) {
  var plan = ensureHomeMemory(homeRoom);
  var live = countLiveAssignments(plan);

  for (var idle = 0; idle < live.idleRemote.length; idle++) {
    var idleCreep = live.idleRemote[idle];
    assignIdleRemoteVeinseeker(idleCreep);
  }

  live = countLiveAssignments(plan);
  var queued = countQueuedAssignments(plan);
  plan.liveAssignedHomeVeinseekers = live.homeAssigned;
  plan.liveAssignedRemoteVeinseekers = live.remoteAssigned;
  plan.liveIdleRemoteVeinseekers = live.idleRemote.length;
  plan.queuedHomeVeinseekers = queued.homeQueued;
  plan.queuedRemoteVeinseekers = queued.remoteQueued;
  plan.desiredHomeVeinseekers = 0;
  plan.desiredRemoteVeinseekers = 0;

  var duplicateSources = [];
  for (var i = 0; i < plan.sourceOrder.length; i++) {
    var sid = plan.sourceOrder[i];
    var rec = plan.sources[sid];
    if (!rec) continue;

    if (rec.queuedUntil && rec.queuedUntil <= Game.time) {
      rec.queuedUntil = 0;
      rec.queuedVeinseeker = null;
    }

    rec.live = 0;
    rec.queued = 0;
    rec.assignedVeinseeker = null;
    if (!rec.queuedUntil) rec.queuedVeinseeker = null;

    var liveList = live.bySource[sid] || [];
    if (liveList.length > 1) {
      duplicateSources.push(sid);
      liveList.sort(function (a, b) {
        var at = a.memory && typeof a.memory._assignTick === 'number' ? a.memory._assignTick : 99999999;
        var bt = b.memory && typeof b.memory._assignTick === 'number' ? b.memory._assignTick : 99999999;
        if (at !== bt) return at - bt;
        return a.name < b.name ? -1 : 1;
      });
      for (var d = 1; d < liveList.length; d++) liveList[d].memory._forceYield = true;
    }

    var queueList = queued.bySource[sid] || [];
    rec.live = liveList.length;
    rec.queued = queueList.length;

    if (rec.active) {
      if (rec.mode === 'home') plan.desiredHomeVeinseekers++;
      if (rec.mode === 'remote') plan.desiredRemoteVeinseekers++;
    }

    if (!rec.active) {
      rec.assignedVeinseeker = liveList[0] ? liveList[0].name : null;
      rec.queuedVeinseeker = queueList[0] ? 'spawnQueue' : null;
      continue;
    }

    if (liveList.length > 0) {
      rec.assignedVeinseeker = liveList[0].name;
      rec.queuedVeinseeker = null;
      rec.queuedUntil = 0;
      rec.status = 'assigned';
      rec.reason = 'live-veinseeker';
    } else if (queueList.length > 0 || (rec.queuedVeinseeker && rec.queuedUntil > Game.time)) {
      rec.queuedVeinseeker = queueList[0] && queueList[0].name ? queueList[0].name : (rec.queuedVeinseeker || 'spawnQueue');
      rec.queuedUntil = Math.max(rec.queuedUntil || 0, Game.time + RESERVE_TTL);
      rec.status = 'queued';
      rec.reason = 'queued-veinseeker';
    } else {
      rec.status = 'open';
      rec.reason = rec.mode === 'remote' ? 'missing-remote-veinseeker' : 'home-source-open';
    }
  }

  plan.duplicateSources = duplicateSources;
  plan.invalidQueueItems = queued.invalid;
  plan.lastAudit = Game.time;
  writePlanDiagnostics(homeRoom);
  return plan;
}

function summarizeSourceRecord(rec) {
  return {
    sourceId: rec.sourceId,
    roomName: rec.roomName,
    targetRoom: rec.targetRoom,
    mode: rec.mode,
    active: !!rec.active,
    status: rec.status,
    reason: rec.reason,
    assignedVeinseeker: rec.assignedVeinseeker || null,
    queuedVeinseeker: rec.queuedVeinseeker || null,
    pathCost: finiteOrNull(rec.pathCost),
    distance: finiteOrNull(rec.distance),
    routeDistance: finiteOrNull(rec.routeDistance),
    energyPerTick: finiteOrNull(rec.energyPerTick),
    netIncome: finiteOrNull(rec.netIncome),
    spawnUsage: finiteOrNull(rec.spawnUsage),
    spawnWeight: finiteOrNull(rec.spawnWeight),
    activationReason: rec.activationReason || null,
    rejectionReason: rec.rejectionReason || null,
    road: rec.road || null,
    economics: rec.economics || null,
    activeHaulPressure: rec.activeHaulPressure || null,
    container: rec.container ? {
      status: rec.container.status || null,
      containerId: rec.container.containerId || null,
      siteId: rec.container.siteId || null,
      x: typeof rec.container.x === 'number' ? rec.container.x : null,
      y: typeof rec.container.y === 'number' ? rec.container.y : null,
      amount: typeof rec.container.amount === 'number' ? rec.container.amount : null,
      updated: rec.container.updated || null
    } : null
  };
}

function writePlanDiagnostics(homeRoom) {
  var plan = ensureHomeMemory(homeRoom);
  var roomMem = getRoomMemoryBucket(homeRoom);
  var summaries = [];
  for (var i = 0; i < plan.sourceOrder.length; i++) {
    var rec = plan.sources[plan.sourceOrder[i]];
    if (rec) summaries.push(summarizeSourceRecord(rec));
  }
  roomMem.lastSourceEnergyPlan = {
    tick: Game.time,
    activeSources: plan.activeSources || 0,
    inactiveSources: plan.inactiveSources || 0,
    homeSources: plan.homeSources || 0,
    remoteSources: plan.remoteSources || 0,
    activeRemoteSources: plan.activeRemoteSources || 0,
    inactiveRemoteSources: plan.inactiveRemoteSources || 0,
    remoteSpawnBudget: plan.remoteSpawnBudget || 0,
    remoteSpawnUsed: plan.remoteSpawnUsed || 0,
    estimatedEnergyPerTick: plan.estimatedEnergyPerTick || 0,
    estimatedNetIncome: plan.estimatedNetIncome || 0,
    estimatedSpawnUsage: plan.estimatedSpawnUsage || 0,
    remoteSelection: plan.remoteSelection || null,
    desiredHomeVeinseekers: plan.desiredHomeVeinseekers || 0,
    desiredRemoteVeinseekers: plan.desiredRemoteVeinseekers || 0,
    liveAssignedHomeVeinseekers: plan.liveAssignedHomeVeinseekers || 0,
    liveAssignedRemoteVeinseekers: plan.liveAssignedRemoteVeinseekers || 0,
    liveIdleRemoteVeinseekers: plan.liveIdleRemoteVeinseekers || 0,
    queuedHomeVeinseekers: plan.queuedHomeVeinseekers || 0,
    queuedRemoteVeinseekers: plan.queuedRemoteVeinseekers || 0,
    candidateRemoteRooms: plan.candidateRemoteRooms || [],
    acceptedRemoteRooms: plan.acceptedRemoteRooms || [],
    rejectedRemoteRooms: plan.rejectedRemoteRooms || [],
    skippedSources: plan.skippedSources || [],
    invalidQueueItems: plan.invalidQueueItems || [],
    duplicateSources: plan.duplicateSources || [],
    sourceRecords: summaries,
    spawnDecisions: plan.spawnDecisions || [],
    truckerRemoteHaulDecisions: plan.truckerRemoteHaulDecisions || null
  };
  return roomMem.lastSourceEnergyPlan;
}

function getPlanForHome(homeRoom) {
  return ensureHomeMemory(homeRoom);
}

function getSourceRecord(homeRoom, sourceId) {
  var plan = ensureHomeMemory(homeRoom);
  return plan.sources && plan.sources[sourceId] ? plan.sources[sourceId] : null;
}

function getSourcesNeedingVeinseeker(homeRoom, mode) {
  var plan = ensureHomeMemory(homeRoom);
  var out = [];
  for (var i = 0; i < plan.sourceOrder.length; i++) {
    var rec = plan.sources[plan.sourceOrder[i]];
    if (!rec || !rec.active) continue;
    if (mode && rec.mode !== mode) continue;
    if (rec.mode === 'remote') {
      if (rec.status === 'open' && !rec.assignedVeinseeker && !(rec.queuedVeinseeker && rec.queuedUntil > Game.time)) out.push(rec);
      continue;
    }
    if (rec.mode === 'home') {
      var hasNoCoverage = rec.live <= 0 && rec.queued <= 0;
      var hasWorkDeficit = (rec.desiredWork || 0) > ((rec.liveWork || 0) + (rec.queuedWork || 0));
      if (hasNoCoverage || hasWorkDeficit) out.push(rec);
    }
  }
  out.sort(function (a, b) {
    if (a.mode !== b.mode) return a.mode === 'home' ? -1 : 1;
    if (a.mode === 'remote' && b.mode === 'remote') {
      var av = a.economics && typeof a.economics.value === 'number' ? a.economics.value : -99999;
      var bv = b.economics && typeof b.economics.value === 'number' ? b.economics.value : -99999;
      if (bv !== av) return bv - av;
      var an = typeof a.netIncome === 'number' ? a.netIncome : -99999;
      var bn = typeof b.netIncome === 'number' ? b.netIncome : -99999;
      if (bn !== an) return bn - an;
    }
    var da = typeof a.routeDistance === 'number' ? a.routeDistance : 9999;
    var db = typeof b.routeDistance === 'number' ? b.routeDistance : 9999;
    if (da !== db) return da - db;
    var pa = typeof a.pathCost === 'number' ? a.pathCost : 9999;
    var pb = typeof b.pathCost === 'number' ? b.pathCost : 9999;
    if (pa !== pb) return pa - pb;
    return a.sourceId < b.sourceId ? -1 : (a.sourceId > b.sourceId ? 1 : 0);
  });
  return out;
}

function reserveSourceForQueue(homeRoom, sourceId) {
  var plan = ensureHomeMemory(homeRoom);
  var rec = sourceId ? plan.sources[sourceId] : null;
  if (!rec) {
    var needs = getSourcesNeedingVeinseeker(homeRoom, 'remote');
    rec = needs.length ? needs[0] : null;
  }
  if (!rec || !rec.active || rec.assignedVeinseeker) return null;
  if (rec.mode === 'remote' && (!rec.targetRoom || rec.targetRoom === rec.homeRoom)) return null;
  if (rec.queuedVeinseeker && rec.queuedUntil > Game.time) return null;
  rec.queuedVeinseeker = 'queue:' + Game.time + ':' + rec.sourceId;
  rec.queuedUntil = Game.time + RESERVE_TTL;
  rec.status = 'queued';
  rec.reason = 'reserved-for-spawn';
  writePlanDiagnostics(homeRoom);
  return {
    sourceId: rec.sourceId,
    targetRoom: rec.targetRoom,
    roomName: rec.roomName,
    mode: rec.mode,
    pathCost: rec.pathCost,
    routeDistance: rec.routeDistance,
    netIncome: rec.netIncome,
    spawnUsage: rec.spawnUsage,
    activationReason: rec.activationReason,
    economics: rec.economics || null
  };
}

function unreserveSourceForQueue(homeRoom, sourceId) {
  var rec = getSourceRecord(homeRoom, sourceId);
  if (!rec || rec.assignedVeinseeker) return false;
  rec.queuedVeinseeker = null;
  rec.queuedUntil = 0;
  if (rec.active) {
    rec.status = 'open';
    rec.reason = 'queue-reservation-cleared';
  }
  writePlanDiagnostics(homeRoom);
  return true;
}

function claimSource(creep, sourceId, targetRoom) {
  if (!creep || !creep.memory || !sourceId) return false;
  var homeRoom = creep.memory.home || creep.memory._home || (creep.room && creep.room.name);
  if (!homeRoom) return false;
  var rec = getSourceRecord(homeRoom, sourceId);
  if (!rec || !rec.active) return false;
  if (rec.mode === 'remote' && targetRoom && rec.targetRoom !== targetRoom) return false;
  rec.assignedVeinseeker = creep.name;
  rec.queuedVeinseeker = null;
  rec.queuedUntil = 0;
  rec.status = 'assigned';
  rec.reason = 'claimed';
  removeQueuedVeinseekerForSource(homeRoom, sourceId, rec.mode);
  writePlanDiagnostics(homeRoom);
  return true;
}

function releaseSource(creep, reason) {
  if (!creep || !creep.memory) return false;
  var sourceId = creepSourceId(creep);
  var homeRoom = creep.memory.home || creep.memory._home || (creep.room && creep.room.name);
  if (!homeRoom || !sourceId) return false;
  var rec = getSourceRecord(homeRoom, sourceId);
  if (!rec) return false;
  if (rec.assignedVeinseeker === creep.name) rec.assignedVeinseeker = null;
  rec.status = rec.active ? 'open' : rec.status;
  rec.reason = reason || 'released';
  writePlanDiagnostics(homeRoom);
  return true;
}

function validateQueueItem(homeRoom, item) {
  if (!item || item.role !== 'Veinseeker') return 'not-veinseeker';
  var sourceId = queueItemSourceId(item);
  if (!sourceId) return 'missing-source-id';
  if (item.mode === 'remote' && !item.targetRoom) return 'missing-target-room';
  var rec = getSourceRecord(homeRoom, sourceId);
  if (!rec) return 'source-not-in-plan';
  if (!rec.active) return rec.reason || 'source-inactive';
  if (item.mode === 'remote') {
    if (rec.mode !== 'remote') return 'mode-mismatch';
    if (rec.targetRoom !== item.targetRoom) return 'source-target-mismatch';
    if (isRemoteUnsafe(item.targetRoom)) return 'room-unsafe';
    if (rec.assignedVeinseeker && Game.creeps[rec.assignedVeinseeker]) return 'source-already-assigned';
  }
  return null;
}

function isSourceActiveForCreep(creep) {
  if (!creep || !creep.memory) return false;
  var sourceId = creepSourceId(creep);
  var homeRoom = creep.memory.home || creep.memory._home || (creep.room && creep.room.name);
  if (!homeRoom || !sourceId) return false;
  var rec = getSourceRecord(homeRoom, sourceId);
  if (!rec || !rec.active) return false;
  if (creep.memory.mode === 'remote' && rec.targetRoom !== creep.memory.targetRoom) return false;
  return true;
}

function recordSpawnDecision(homeRoom, decision) {
  if (!homeRoom || !decision) return;
  var plan = ensureHomeMemory(homeRoom);
  if (!plan.spawnDecisions) plan.spawnDecisions = [];
  var entry = {
    tick: Game.time,
    sourceId: decision.sourceId || null,
    roomName: decision.roomName || decision.targetRoom || null,
    mode: decision.mode || null,
    action: decision.action || null,
    reason: decision.reason || null
  };
  for (var key in decision) {
    if (!Object.prototype.hasOwnProperty.call(decision, key)) continue;
    if (entry[key] === undefined) entry[key] = decision[key];
  }
  plan.spawnDecisions.push(entry);
  if (plan.spawnDecisions.length > 40) plan.spawnDecisions = plan.spawnDecisions.slice(plan.spawnDecisions.length - 40);
  writePlanDiagnostics(homeRoom);
}

function attachTruckerRemoteHaulDecision(homeRoom, audit) {
  if (!homeRoom) return;
  var plan = ensureHomeMemory(homeRoom);
  plan.truckerRemoteHaulDecisions = audit || null;
  writePlanDiagnostics(homeRoom);
}

function getActiveRemoteSourceRecords(homeRoom) {
  var plan = ensureHomeMemory(homeRoom);
  var out = [];
  for (var i = 0; i < plan.sourceOrder.length; i++) {
    var rec = plan.sources[plan.sourceOrder[i]];
    if (!rec || rec.mode !== 'remote' || !rec.active) continue;
    out.push(rec);
  }
  return out;
}

function getRemoteControllerReservationSnapshot(homeRoom, targetRoom) {
  var myName = getMyUsername();
  var room = Game.rooms && Game.rooms[targetRoom];
  var snapshot = {
    hasController: false,
    visible: !!room,
    owner: null,
    reservationOwner: null,
    reservationTicks: 0,
    blocked: false,
    reason: 'controller-unknown'
  };

  if (room && room.controller) {
    snapshot.hasController = true;
    snapshot.owner = room.controller.owner && room.controller.owner.username || null;
    snapshot.reservationOwner = room.controller.reservation && room.controller.reservation.username || null;
    snapshot.reservationTicks = room.controller.reservation && room.controller.reservation.ticksToEnd || 0;
  } else {
    var mem = (Memory.rooms && Memory.rooms[targetRoom]) || {};
    var intel = mem.intel || {};
    var scout = getScoutRoomRecord(homeRoom, targetRoom);
    var scoutController = scout && scout.controller ? scout.controller : null;
    var reserveIntel = Memory.reserveIntel && Memory.reserveIntel[targetRoom] ? Memory.reserveIntel[targetRoom] : null;

    if (scoutController || intel.controller || reserveIntel || intel.reservation !== undefined || intel.owner !== undefined) {
      snapshot.hasController = true;
    }
    snapshot.owner = (scoutController && scoutController.owner) || intel.owner || null;
    var reservation = scoutController && scoutController.reservation !== undefined ? scoutController.reservation : intel.reservation;
    if (reservation && typeof reservation === 'object') {
      snapshot.reservationOwner = reservation.username || reservation.owner || null;
      snapshot.reservationTicks = reservation.ticksToEnd || reservation.ticks || 0;
    } else if (typeof reservation === 'string') {
      snapshot.reservationOwner = reservation;
    }
    if (reserveIntel) {
      snapshot.reservationOwner = reserveIntel.owner === 'me' ? myName : (reserveIntel.owner || snapshot.reservationOwner);
      snapshot.reservationTicks = reserveIntel.ticks || snapshot.reservationTicks || 0;
      snapshot.hasController = true;
    }
  }

  if (!snapshot.hasController) {
    snapshot.blocked = true;
    snapshot.reason = snapshot.visible ? 'no-controller' : 'controller-unknown';
  } else if (snapshot.owner && (!myName || snapshot.owner !== myName)) {
    snapshot.blocked = true;
    snapshot.reason = 'owned-by-other';
  } else if (snapshot.reservationOwner && (!myName || snapshot.reservationOwner !== myName)) {
    snapshot.blocked = true;
    snapshot.reason = 'reserved-by-other';
  } else {
    snapshot.blocked = false;
    snapshot.reason = snapshot.reservationOwner ? 'own-reservation' : 'neutral-controller';
  }
  return snapshot;
}

function getRemoteReservationPlan(homeRoom) {
  var homeName = getHomeName(homeRoom);
  var enabled = cfgBool('REMOTE_RESERVATION_ENABLED', true);
  var targetTicks = Math.max(1, cfgNumber('REMOTE_RESERVATION_TICKS_TARGET', 4000));
  var refreshAt = Math.max(0, Math.min(targetTicks, cfgNumber('REMOTE_RESERVATION_TICKS_REFRESH_AT', 2500)));
  var minNetIncome = cfgNumber('REMOTE_RESERVER_MIN_NET_INCOME', 0.5);
  var maxPerHome = Math.max(0, Math.floor(cfgNumber('REMOTE_RESERVER_MAX_PER_HOME', 1)));
  var plan = {
    tick: Game.time,
    homeRoom: homeName,
    enabled: enabled,
    desiredReservationTicks: targetTicks,
    reserveAt: refreshAt,
    maxPerHome: maxPerHome,
    minNetIncome: minNetIncome,
    targets: [],
    needed: [],
    skipped: []
  };
  if (!homeName || !enabled || maxPerHome <= 0) {
    plan.reason = !enabled ? 'disabled' : 'no-capacity';
    if (homeName) getRoomMemoryBucket(homeName).lastRemoteReservationPlan = plan;
    return plan;
  }

  var byRoom = {};
  var sourcePlan = ensureHomeMemory(homeName);
  for (var i = 0; i < sourcePlan.sourceOrder.length; i++) {
    var rec = sourcePlan.sources[sourcePlan.sourceOrder[i]];
    if (!rec || rec.mode !== 'remote') continue;
    var economics = rec.economics || {};
    var reservationCandidate = !!(rec.reservationCandidate || economics.reservationWouldHelp);
    if (!rec.active && !reservationCandidate) continue;
    var targetRoom = rec.targetRoom || rec.roomName;
    if (!targetRoom || targetRoom === homeName) continue;
    if (!byRoom[targetRoom]) {
      byRoom[targetRoom] = {
        targetRoom: targetRoom,
        sourceIds: [],
        activeSourceIds: [],
        reservationCandidateSourceIds: [],
        routeDistance: rec.routeDistance,
        pathCost: rec.pathCost,
        currentNetIncome: 0,
        reservedNetIncome: 0,
        reservationWouldHelp: false,
        sourceDiagnostics: []
      };
    }
    byRoom[targetRoom].sourceIds.push(rec.sourceId);
    if (rec.active) byRoom[targetRoom].activeSourceIds.push(rec.sourceId);
    if (reservationCandidate) byRoom[targetRoom].reservationCandidateSourceIds.push(rec.sourceId);
    if (typeof rec.pathCost === 'number') byRoom[targetRoom].pathCost = Math.max(byRoom[targetRoom].pathCost || 0, rec.pathCost);
    if (typeof rec.routeDistance === 'number') byRoom[targetRoom].routeDistance = Math.max(byRoom[targetRoom].routeDistance || 0, rec.routeDistance);
    var currentNetIncome = typeof economics.currentNetIncome === 'number'
      ? economics.currentNetIncome
      : (typeof rec.netIncome === 'number' ? rec.netIncome : 0);
    var reservedNetIncome = typeof economics.reservedNetIncome === 'number' ? economics.reservedNetIncome : currentNetIncome;
    byRoom[targetRoom].currentNetIncome += currentNetIncome;
    byRoom[targetRoom].reservedNetIncome += reservedNetIncome;
    byRoom[targetRoom].reservationWouldHelp = byRoom[targetRoom].reservationWouldHelp || reservationCandidate;
    byRoom[targetRoom].sourceDiagnostics.push({
      sourceId: rec.sourceId,
      active: !!rec.active,
      reason: rec.rejectionReason || rec.reason || null,
      currentNetIncome: roundMetric(currentNetIncome, 3) || 0,
      reservedNetIncome: roundMetric(reservedNetIncome, 3) || 0,
      reservationWouldHelp: reservationCandidate,
      reservationPotentialReason: economics.reservationPotentialReason || economics.reason || null
    });
  }

  for (var roomName in byRoom) {
    if (!Object.prototype.hasOwnProperty.call(byRoom, roomName)) continue;
    var item = byRoom[roomName];
    var controller = getRemoteControllerReservationSnapshot(homeName, roomName);
    var unsafe = isRemoteUnsafe(roomName);
    var needsReservation = false;
    var reason = 'reservation-current';
    item.netIncomeProtected = Math.max(0, item.currentNetIncome || 0, item.reservedNetIncome || 0);
    if (unsafe) reason = 'unsafe';
    else if (controller.blocked && controller.reason !== 'controller-unknown') reason = controller.reason;
    else if (item.netIncomeProtected < minNetIncome) reason = 'net-income-too-low';
    else if (controller.reservationTicks >= refreshAt) reason = 'reservation-above-refresh';
    else {
      needsReservation = true;
      reason = controller.reason === 'controller-unknown'
        ? 'reserve-controller-unknown'
        : (controller.reservationTicks > 0 ? 'refresh-low-reservation' : 'reserve-neutral-controller');
    }
    var entry = {
      homeRoom: homeName,
      targetRoom: roomName,
      sourceIds: item.sourceIds,
      activeSourceIds: item.activeSourceIds,
      reservationCandidateSourceIds: item.reservationCandidateSourceIds,
      routeDistance: finiteOrNull(item.routeDistance),
      pathCost: finiteOrNull(item.pathCost),
      currentReservationOwner: controller.reservationOwner,
      currentReservationTicks: controller.reservationTicks || 0,
      desiredReservationTicks: targetTicks,
      reserveAt: refreshAt,
      reason: reason,
      needsReservation: needsReservation,
      currentNetIncome: roundMetric(item.currentNetIncome, 3) || 0,
      reservedNetIncome: roundMetric(item.reservedNetIncome, 3) || 0,
      reservationWouldHelp: !!item.reservationWouldHelp,
      netIncomeProtected: roundMetric(item.netIncomeProtected, 3) || 0,
      sourceDiagnostics: item.sourceDiagnostics,
      spawnPriority: needsReservation ? Math.max(55, 85 - Math.floor((controller.reservationTicks || 0) / 100)) : 0,
      controllerVisible: controller.visible,
      controllerKnown: controller.hasController
    };
    plan.targets.push(entry);
    if (needsReservation) plan.needed.push(entry);
    else plan.skipped.push(entry);
  }

  plan.needed.sort(function (a, b) {
    if ((a.currentReservationTicks || 0) !== (b.currentReservationTicks || 0)) return (a.currentReservationTicks || 0) - (b.currentReservationTicks || 0);
    if ((b.netIncomeProtected || 0) !== (a.netIncomeProtected || 0)) return (b.netIncomeProtected || 0) - (a.netIncomeProtected || 0);
    return a.targetRoom < b.targetRoom ? -1 : (a.targetRoom > b.targetRoom ? 1 : 0);
  });
  if (plan.needed.length > maxPerHome) plan.needed = plan.needed.slice(0, maxPerHome);
  getRoomMemoryBucket(homeName).lastRemoteReservationPlan = plan;
  return plan;
}

function getRemoteRoomsNeedingReservation(homeRoom) {
  var plan = getRemoteReservationPlan(homeRoom);
  var out = [];
  for (var i = 0; i < plan.needed.length; i++) out.push(plan.needed[i].targetRoom);
  return out;
}

function buildRemoteSourceEconomicsReport(homeRoom) {
  var plan = ensureHomeMemory(homeRoom);
  var sources = [];
  for (var i = 0; i < plan.sourceOrder.length; i++) {
    var rec = plan.sources[plan.sourceOrder[i]];
    if (!rec || rec.mode !== 'remote') continue;
    sources.push({
      sourceId: rec.sourceId,
      roomName: rec.roomName,
      active: !!rec.active,
      status: rec.status,
      reason: rec.reason,
      activationReason: rec.activationReason || null,
      rejectionReason: rec.rejectionReason || null,
      routeDistance: finiteOrNull(rec.routeDistance),
      pathCost: finiteOrNull(rec.pathCost),
      containerStatus: rec.containerStatus || null,
      road: rec.road || null,
      economics: rec.economics || null,
      reservationCandidate: !!rec.reservationCandidate,
      energyPerTick: finiteOrNull(rec.energyPerTick),
      netIncome: finiteOrNull(rec.netIncome),
      spawnUsage: finiteOrNull(rec.spawnUsage),
      spawnWeight: finiteOrNull(rec.spawnWeight)
    });
  }
  var report = {
    tick: Game.time,
    recalculated: true,
    activeRemoteSources: plan.activeRemoteSources || plan.remoteSources || 0,
    inactiveRemoteSources: plan.inactiveRemoteSources || (sources.length - (plan.remoteSources || 0)),
    remoteSpawnBudget: plan.remoteSpawnBudget || 0,
    remoteSpawnUsed: plan.remoteSpawnUsed || 0,
    estimatedEnergyPerTick: plan.estimatedEnergyPerTick || 0,
    estimatedNetIncome: plan.estimatedNetIncome || 0,
    estimatedSpawnUsage: plan.estimatedSpawnUsage || 0,
    remoteSelection: plan.remoteSelection || null,
    sources: sources,
    notes: 'SourceEnergy owns source-level remote activation; Trucker quota reads active source records for haul prediction'
  };
  getRoomMemoryBucket(homeRoom).lastRemoteSourceEconomics = report;
  return report;
}

function getApprovedRemotesFromScout(homeRoom) {
  var out = { approvedRooms: [], approvedSources: [], rejected: [] };
  var scoutHome = getScoutHome(homeRoom);
  if (!scoutHome || !scoutHome.rooms) return out;
  for (var roomName in scoutHome.rooms) {
    if (!Object.prototype.hasOwnProperty.call(scoutHome.rooms, roomName)) continue;
    var rec = scoutHome.rooms[roomName];
    var reason = null;
    if (!rec) reason = 'missing-record';
    else if (roomName === homeRoom) reason = 'home-room';
    else if (!isFiniteDistance(rec.routeDistance)) reason = 'no-route';
    else if (!rec.lastSeen || (Game.time - rec.lastSeen) > REMOTE_INTEL_TTL) reason = 'stale-scout-intel';
    else if (!rec.sources || !rec.sources.length) reason = 'no-sources';
    else if (rec.remoteEligible === false) reason = rec.remoteBlockedReason || 'blocked';
    else if (isRemoteUnsafe(roomName)) reason = 'unsafe';
    if (reason) {
      out.rejected.push({ room: roomName, reason: reason });
      continue;
    }
    out.approvedRooms.push(roomName);
    for (var i = 0; i < rec.sources.length; i++) {
      var source = rec.sources[i];
      if (!source || !source.id || source.accessible === false) continue;
      out.approvedSources.push({
        sourceId: source.id,
        targetRoom: roomName,
        roomName: roomName,
        routeDistance: rec.routeDistance,
        pathCost: source.pathCost || null
      });
    }
  }
  return out;
}

function resetLegacyMemory(opts) {
  opts = opts || {};
  var report = {
    tick: Game.time,
    killedRemoteVeinseekers: 0,
    removedQueueItems: 0,
    clearedRoomBlocks: 0,
    clearedSourceBlocks: 0,
    clearedPaths: 0,
    clearedBuckets: []
  };

  if (opts.killRemoteVeinseekers) {
    for (var name in Game.creeps) {
      if (!Object.prototype.hasOwnProperty.call(Game.creeps, name)) continue;
      var creep = Game.creeps[name];
      if (!creep || !creep.memory || !isVeinseekerMemory(creep.memory)) continue;
      if (creep.memory.mode === 'remote') {
        creep.suicide();
        report.killedRemoteVeinseekers++;
      }
    }
  }

  if (Memory.remoteAssignments) {
    delete Memory.remoteAssignments;
    report.clearedBuckets.push('Memory.remoteAssignments');
  }

  if (Memory.__BHM) {
    if (Memory.__BHM.sourceEnergy) {
      delete Memory.__BHM.sourceEnergy;
      report.clearedBuckets.push('Memory.__BHM.sourceEnergy');
    }
    if (Memory.__BHM.remoteHaulRequests) {
      delete Memory.__BHM.remoteHaulRequests;
      report.clearedBuckets.push('Memory.__BHM.remoteHaulRequests');
    }
    if (Memory.__BHM.remoteContainerStatus) {
      delete Memory.__BHM.remoteContainerStatus;
      report.clearedBuckets.push('Memory.__BHM.remoteContainerStatus');
    }
    if (Memory.__BHM.remoteContainerBuilds) {
      delete Memory.__BHM.remoteContainerBuilds;
      report.clearedBuckets.push('Memory.__BHM.remoteContainerBuilds');
    }
    if (Memory.__BHM.remoteEconomicsPathCache) {
      delete Memory.__BHM.remoteEconomicsPathCache;
      report.clearedPaths++;
    }
  }

  var rooms = Memory.rooms || {};
  for (var roomName in rooms) {
    if (!Object.prototype.hasOwnProperty.call(rooms, roomName)) continue;
    var roomMem = rooms[roomName] || {};
    var roomBlockFields = [
      'sourceWorkerBlocked',
      'sourceWorkerUnsafe',
      'sourceWorkerBlockedUntil',
      'sourceWorkerBlockedReason',
      'sourceWorkerBlockedAt',
      'sourceWorkerInvaderLockUntil',
      'sourceWorkerInvaderLockReason',
      'lastVeinseekerSelection',
      'lastVeinseekerPathFailure'
    ];
    for (var f = 0; f < roomBlockFields.length; f++) {
      if (roomMem[roomBlockFields[f]] !== undefined) {
        delete roomMem[roomBlockFields[f]];
        report.clearedRoomBlocks++;
      }
    }

    if (Array.isArray(roomMem.spawnQueue)) {
      var kept = [];
      for (var q = 0; q < roomMem.spawnQueue.length; q++) {
        var item = roomMem.spawnQueue[q];
        var remove = false;
        if (isVeinseekerQueueItem(item)) {
          var sid = queueItemSourceId(item);
          if (!sid) remove = true;
          if (item.mode === 'remote' && !item.targetRoom) remove = true;
        }
        if (remove) report.removedQueueItems++;
        else kept.push(item);
      }
      roomMem.spawnQueue = kept;
    }

    if (roomMem.sources) {
      for (var sourceId in roomMem.sources) {
        if (!Object.prototype.hasOwnProperty.call(roomMem.sources, sourceId)) continue;
        var src = roomMem.sources[sourceId] || {};
        var sourceBlockFields = [
          'sourceWorkerBlocked',
          'sourceWorkerBlockedUntil',
          'sourceWorkerBlockedReason',
          'sourceWorkerBlockedAt',
          'reservedBy',
          'reservedUntil',
          'assignedVeinseeker',
          'queuedVeinseeker',
          'queuedUntil',
          'pathCache',
          'pathCostCache'
        ];
        for (var sf = 0; sf < sourceBlockFields.length; sf++) {
          if (src[sourceBlockFields[sf]] !== undefined) {
            delete src[sourceBlockFields[sf]];
            report.clearedSourceBlocks++;
          }
        }
      }
    }
  }

  Memory.lastSourceEnergyReset = report;
  return report;
}

module.exports = {
  ensureMemory: ensureMemory,
  ensureHomeMemory: ensureHomeMemory,
  getPlanForHome: getPlanForHome,
  getSourceRecord: getSourceRecord,
  getSourcesNeedingVeinseeker: getSourcesNeedingVeinseeker,
  gatherCandidateRemoteRoomsForHome: gatherCandidateRemoteRoomsForHome,
  getApprovedRemotesFromScout: getApprovedRemotesFromScout,
  buildSourcePlanForHome: buildSourcePlanForHome,
  auditAssignmentsForHome: auditAssignmentsForHome,
  buildRemoteSourceEconomicsReport: buildRemoteSourceEconomicsReport,
  selectProfitableRemoteSources: selectProfitableRemoteSources,
  getActiveRemoteSourceRecords: getActiveRemoteSourceRecords,
  getRemoteReservationPlan: getRemoteReservationPlan,
  getRemoteRoomsNeedingReservation: getRemoteRoomsNeedingReservation,
  reserveSourceForQueue: reserveSourceForQueue,
  unreserveSourceForQueue: unreserveSourceForQueue,
  claimSource: claimSource,
  releaseSource: releaseSource,
  assignIdleRemoteVeinseeker: assignIdleRemoteVeinseeker,
  validateQueueItem: validateQueueItem,
  isSourceActiveForCreep: isSourceActiveForCreep,
  recordSpawnDecision: recordSpawnDecision,
  attachTruckerRemoteHaulDecision: attachTruckerRemoteHaulDecision,
  resetLegacyMemory: resetLegacyMemory,
  isRemoteUnsafe: isRemoteUnsafe,
  refreshVisibleRemoteSafety: refreshVisibleRemoteSafety,
  isLocalOwnedRoomForVeinseeker: isLocalOwnedRoomForVeinseeker
};
