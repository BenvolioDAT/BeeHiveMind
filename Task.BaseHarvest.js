'use strict';

/**
 * Task.BaseHarvest assigns miners to fixed seats and maintains source containers.
 * All logic is ES5-compatible to match team conventions (no const/let, arrow
 * functions, or template literals). Movement always relies on Traveler
 * (creep.travelTo/Traveler.travelTo) so that path reuse stays unified.
 */

var Logger = require('core.logger');
var Traveler = require('Traveler');

var LOG_LEVEL = Logger.LOG_LEVEL;
var harvestLog = Logger.createLogger('Task.BaseHarvest', LOG_LEVEL.DEBUG);

var HARVEST_RANGE = 1;
var REASSIGN_INTERVAL = 50;
var CONTAINER_REPAIR_THRESHOLD = 0.5;
var REPAIR_POWER_PER_WORK = 100;

/**
 * ensureAssignment resolves or acquires a source seat for the creep.
 * Input: creep (Creep).
 * Output: assignment info (object) or null when no source is available.
 * Side-effects: may update creep memory when a new source is selected.
 * Reasoning: centralizes seat acquisition and reuse across ticks.
 */
function ensureAssignment(creep) {
  var assignment = getHarvestAssignmentInfo(creep);
  if (assignment && assignment.source) {
    return assignment;
  }
  assignment = assignHarvestSource(creep);
  if (!assignment || !assignment.source) {
    if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
      harvestLog.debug('No source assignment found for', creep.name);
    }
    return null;
  }
  return assignment;
}

/**
 * shouldReassign decides whether the creep should attempt to find a new source.
 * Input: creep (Creep), assignment (object from ensureAssignment).
 * Output: boolean.
 * Side-effects: none.
 * Reasoning: prevents miners from standing idle if their source disappears.
 */
function shouldReassign(creep, assignment) {
  if (!assignment || !assignment.source) {
    return true;
  }
  if (Game.time % REASSIGN_INTERVAL !== 0) {
    return false;
  }
  if (!assignment.source.room) {
    return false;
  }
  if (assignment.source.energy > 0) {
    return false;
  }
  if (assignment.source.ticksToRegeneration && assignment.source.ticksToRegeneration > 30) {
    return true;
  }
  return false;
}

/**
 * moveToSeat positions the creep on the reserved seat position.
 * Input: creep (Creep), assignment (object).
 * Output: true when movement was issued.
 * Side-effects: issues movement intent via Traveler (https://docs.screeps.com/api/#Creep.move).
 * Reasoning: keeps miners seated on optimal tiles, enabling container usage.
 */
function moveToSeat(creep, assignment) {
  if (!assignment || !assignment.seatPos) {
    return false;
  }
  if (creep.pos.isEqualTo(assignment.seatPos)) {
    return false;
  }
  rememberSeatPosition(creep, assignment.seatPos);
  travelTo(creep, assignment.seatPos, { range: 0, reusePath: 25 });
  return true;
}

/**
 * maintainContainer builds or repairs the container below the harvester.
 * Input: creep (Creep), assignment (object).
 * Output: none.
 * Side-effects: may build or repair using Creep APIs (https://docs.screeps.com/api/#Creep.build / repair).
 * Reasoning: ensures the economic pipeline keeps working without manual babysitting.
 */
function maintainContainer(creep, assignment) {
  if (!assignment || !assignment.seatPos) {
    return;
  }
  ensureSourceContainer(creep, assignment);
  if (!assignment.container) {
    return;
  }
  if (!creep.pos.isEqualTo(assignment.seatPos)) {
    return;
  }
  if (!assignment.container.hits || !assignment.container.hitsMax) {
    return;
  }
  var hitsRatio = assignment.container.hits / assignment.container.hitsMax;
  if (hitsRatio >= CONTAINER_REPAIR_THRESHOLD) {
    return;
  }
  if (!creep.store || (creep.store[RESOURCE_ENERGY] | 0) < REPAIR_POWER_PER_WORK) {
    return;
  }
  creep.repair(assignment.container);
}

/**
 * handleEnergyOverflow deposits or drops energy when the creep cannot harvest more.
 * Input: creep (Creep), assignment (object).
 * Output: none.
 * Side-effects: may transfer to container or drop energy on ground (https://docs.screeps.com/api/#Creep.transfer).
 * Reasoning: avoids wasted work parts when the container is full.
 */
function handleEnergyOverflow(creep, assignment) {
  if (!creep.store) {
    return;
  }
  var carried = creep.store[RESOURCE_ENERGY] | 0;
  if (carried <= 0) {
    return;
  }
  if (assignment && assignment.container && assignment.container.store) {
    var free = assignment.container.store.getFreeCapacity(RESOURCE_ENERGY) | 0;
    if (free > 0) {
      creep.transfer(assignment.container, RESOURCE_ENERGY);
      return;
    }
  }
  if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
    creep.drop(RESOURCE_ENERGY);
  }
}

/**
 * run executes the harvester behaviour each tick.
 * Input: creep (Creep).
 * Output: none.
 * Side-effects: harvests energy, builds/repairs containers, issues movement intents.
 */
function runBaseHarvest(creep) {
  if (!creep) {
    return;
  }
  if (creep.memory && creep.memory.task !== 'baseharvest') {
    creep.memory.task = 'baseharvest';
  }

  var assignment = ensureAssignment(creep);
  if (!assignment) {
    releaseHarvestAssignment(creep);
    creep.say('NoSrc');
    return;
  }

  if (shouldReassign(creep, assignment)) {
    releaseHarvestAssignment(creep);
    assignment = ensureAssignment(creep);
    if (!assignment) {
      creep.say('NoSrc');
      return;
    }
  }

  if (moveToSeat(creep, assignment)) {
    return;
  }

  maintainContainer(creep, assignment);

  var source = assignment.source;
  if (!source) {
    releaseHarvestAssignment(creep);
    return;
  }

  var result = creep.harvest(source);
  if (result === ERR_NOT_IN_RANGE) {
    travelTo(creep, source.pos, { range: HARVEST_RANGE, reusePath: 15 });
    return;
  }

  handleEnergyOverflow(creep, assignment);
}

// ---------------------------------------------------------------------------
// 🔁 Traveler helper logic
// ---------------------------------------------------------------------------

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
    range: config.range != null ? config.range : 1,
    reusePath: config.reusePath != null ? config.reusePath : 15,
    ignoreCreeps: config.ignoreCreeps === true,
    stuckValue: config.stuckValue != null ? config.stuckValue : 2,
    repath: config.repath != null ? config.repath : 0.1,
    maxOps: config.maxOps != null ? config.maxOps : 4000
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

// ---------------------------------------------------------------------------
// 🪑 Seat memory helpers
// ---------------------------------------------------------------------------

var SEAT_MEMORY_KEY = 'seat';
var SEAT_ASSIGNMENT_LIMIT = 1;
var SOURCE_CONTAINER_SCAN_INTERVAL = 50;

var _harvestSeatCache = global.__beeHarvestSeatCache || (global.__beeHarvestSeatCache = {
  tick: -1,
  rooms: {}
});

function rememberSeatPosition(creep, seatPosition) {
  _writeSeatMemoryInternal(creep, seatPosition);
}

function releaseHarvestAssignment(creep) {
  if (!creep || !creep.memory) {
    return;
  }
  delete creep.memory.assignedSource;
  delete creep.memory.assignedContainer;
  _clearSeatMemoryInternal(creep);
}

function assignHarvestSource(creep) {
  if (!creep) {
    return null;
  }
  var targetRoomName = null;
  var seat = _readSeatMemoryInternal(creep);
  if (seat) {
    targetRoomName = seat.roomName;
  } else if (creep.memory && creep.memory.targetRoom) {
    targetRoomName = creep.memory.targetRoom;
  } else if (creep.memory && creep.memory.homeRoom) {
    targetRoomName = creep.memory.homeRoom;
  } else if (creep.room) {
    targetRoomName = creep.room.name;
  }
  if (!targetRoomName) {
    return null;
  }
  var room = Game.rooms[targetRoomName] || creep.room;
  if (!room) {
    return null;
  }
  var bucket = _ensureHarvestRoomBucket(room.name);
  var bestInfo = null;
  var bestLoad = Infinity;
  var sourceId;
  for (sourceId in bucket.sourceInfo) {
    if (!Object.prototype.hasOwnProperty.call(bucket.sourceInfo, sourceId)) {
      continue;
    }
    var info = bucket.sourceInfo[sourceId];
    if (!info || !info.source) {
      continue;
    }
    var assigned = bucket.assignmentCounts[sourceId] || 0;
    if (assigned >= info.seatCount) {
      continue;
    }
    if (!bestInfo || assigned < bestLoad) {
      bestInfo = info;
      bestLoad = assigned;
    }
  }
  if (!bestInfo) {
    return null;
  }
  _recordHarvestAssignment(room.name, bestInfo.source.id);
  _writeSeatMemoryInternal(creep, bestInfo.seatPos);
  if (creep.memory) {
    creep.memory.assignedSource = bestInfo.source.id;
    if (bestInfo.container) {
      creep.memory.assignedContainer = bestInfo.container.id;
    } else {
      delete creep.memory.assignedContainer;
    }
  }
  return bestInfo;
}

function getHarvestAssignmentInfo(creep) {
  if (!creep || !creep.memory || !creep.memory.assignedSource) {
    return null;
  }
  var seatPos = _readSeatMemoryInternal(creep);
  var source = Game.getObjectById(creep.memory.assignedSource);
  var roomName = null;
  if (seatPos) {
    roomName = seatPos.roomName;
  } else if (source && source.pos && source.pos.roomName) {
    roomName = source.pos.roomName;
  } else if (creep.memory.homeRoom) {
    roomName = creep.memory.homeRoom;
  }
  var info = null;
  if (roomName) {
    var bucket = _ensureHarvestRoomBucket(roomName);
    info = bucket.sourceInfo[creep.memory.assignedSource] || null;
  }
  var container = null;
  if (info && info.container) {
    container = info.container;
  } else if (creep.memory.assignedContainer) {
    container = Game.getObjectById(creep.memory.assignedContainer);
  }
  var seatPosition = seatPos;
  if (!seatPosition && info && info.seatPos) {
    seatPosition = info.seatPos;
  }
  return {
    source: source,
    container: container,
    seatPos: seatPosition,
    roomName: roomName,
    seatCount: info ? info.seatCount : SEAT_ASSIGNMENT_LIMIT
  };
}

function ensureSourceContainer(creep, assignmentInfo) {
  if (!creep || !assignmentInfo || !assignmentInfo.seatPos) {
    return;
  }
  var seatPos = assignmentInfo.seatPos;
  var structures = seatPos.lookFor(LOOK_STRUCTURES);
  var i;
  for (i = 0; i < structures.length; i++) {
    if (structures[i].structureType === STRUCTURE_CONTAINER) {
      assignmentInfo.container = structures[i];
      return;
    }
  }
  var sites = seatPos.lookFor(LOOK_CONSTRUCTION_SITES);
  var containerSite = null;
  for (i = 0; i < sites.length; i++) {
    if (sites[i].structureType === STRUCTURE_CONTAINER) {
      containerSite = sites[i];
      break;
    }
  }
  if (containerSite) {
    if (creep.pos.isEqualTo(seatPos) && creep.store && (creep.store[RESOURCE_ENERGY] | 0) > 0) {
      creep.build(containerSite);
    }
    return;
  }
  if (assignmentInfo.container) {
    return;
  }
  if (Game.time % SOURCE_CONTAINER_SCAN_INTERVAL !== 0) {
    return;
  }
  if (!creep.room || creep.room.name !== seatPos.roomName) {
    return;
  }
  creep.room.createConstructionSite(seatPos, STRUCTURE_CONTAINER);
}

function _writeSeatMemoryInternal(creep, pos) {
  if (!creep || !creep.memory) {
    return;
  }
  var value = _serializeSeatPosition(pos);
  if (value) {
    creep.memory[SEAT_MEMORY_KEY] = value;
  } else {
    delete creep.memory[SEAT_MEMORY_KEY];
  }
}

function _clearSeatMemoryInternal(creep) {
  if (!creep || !creep.memory) {
    return;
  }
  delete creep.memory[SEAT_MEMORY_KEY];
}

function _readSeatMemoryInternal(creep) {
  if (!creep || !creep.memory) {
    return null;
  }
  return _deserializeSeatPosition(creep.memory[SEAT_MEMORY_KEY]);
}

function _serializeSeatPosition(pos) {
  if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number' || !pos.roomName) {
    return null;
  }
  return pos.roomName + ':' + pos.x + ':' + pos.y;
}

function _deserializeSeatPosition(serialized) {
  if (!serialized || typeof serialized !== 'string') {
    return null;
  }
  var parts = serialized.split(':');
  if (parts.length !== 3) {
    return null;
  }
  var x = parseInt(parts[1], 10);
  var y = parseInt(parts[2], 10);
  if (isNaN(x) || isNaN(y)) {
    return null;
  }
  return new RoomPosition(x, y, parts[0]);
}

function _ensureHarvestRoomBucket(roomName) {
  _refreshHarvestAssignments();
  var bucket = _harvestSeatCache.rooms[roomName];
  if (!bucket) {
    bucket = {
      sourceInfo: {},
      assignmentCounts: {},
      seats: {},
      scannedSourcesAt: -1
    };
    _harvestSeatCache.rooms[roomName] = bucket;
  }
  if (bucket.scannedSourcesAt === Game.time) {
    return bucket;
  }
  var room = Game.rooms[roomName];
  if (!room) {
    return bucket;
  }
  var sources = room.find(FIND_SOURCES);
  var i;
  for (i = 0; i < sources.length; i++) {
    var source = sources[i];
    var container = _findAdjacentContainer(source);
    var seatPos = _findSeatPosition(source);
    var seatCount = container ? 1 : _countWalkableSeats(source.pos);
    if (seatCount > SEAT_ASSIGNMENT_LIMIT) {
      seatCount = SEAT_ASSIGNMENT_LIMIT;
    }
    if (seatCount <= 0) {
      seatCount = 1;
    }
    bucket.sourceInfo[source.id] = {
      source: source,
      container: container,
      seatPos: seatPos,
      seatCount: seatCount
    };
    if (!bucket.assignmentCounts[source.id]) {
      bucket.assignmentCounts[source.id] = 0;
    }
    if (seatPos) {
      bucket.seats[source.id] = seatPos;
    }
  }
  bucket.scannedSourcesAt = Game.time;
  return bucket;
}

function _recordHarvestAssignment(roomName, sourceId) {
  if (!roomName || !sourceId) {
    return;
  }
  var bucket = _ensureHarvestRoomBucket(roomName);
  if (!bucket.assignmentCounts[sourceId]) {
    bucket.assignmentCounts[sourceId] = 0;
  }
  bucket.assignmentCounts[sourceId]++;
}

function _refreshHarvestAssignments() {
  if (_harvestSeatCache.tick === Game.time) {
    return;
  }
  _harvestSeatCache.tick = Game.time;
  _harvestSeatCache.rooms = {};
  var name;
  for (name in Game.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Game.creeps, name)) {
      continue;
    }
    var creep = Game.creeps[name];
    if (!creep || !creep.memory || creep.memory.task !== 'baseharvest') {
      continue;
    }
    var sourceId = creep.memory.assignedSource;
    if (!sourceId) {
      continue;
    }
    var seatPos = _readSeatMemoryInternal(creep);
    var roomName = null;
    if (seatPos) {
      roomName = seatPos.roomName;
    } else if (creep.room && creep.room.name) {
      roomName = creep.room.name;
    } else if (creep.memory && creep.memory.homeRoom) {
      roomName = creep.memory.homeRoom;
    }
    if (!roomName) {
      continue;
    }
    var bucket = _harvestSeatCache.rooms[roomName];
    if (!bucket) {
      bucket = {
        sourceInfo: {},
        assignmentCounts: {},
        seats: {},
        scannedSourcesAt: -1
      };
      _harvestSeatCache.rooms[roomName] = bucket;
    }
    if (!bucket.assignmentCounts[sourceId]) {
      bucket.assignmentCounts[sourceId] = 0;
    }
    bucket.assignmentCounts[sourceId]++;
  }
}

function _countWalkableSeats(pos) {
  if (!pos || !pos.roomName) {
    return 0;
  }
  var terrain = new Room.Terrain(pos.roomName);
  var total = 0;
  var dx;
  var dy;
  for (dx = -1; dx <= 1; dx++) {
    for (dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) {
        continue;
      }
      var x = pos.x + dx;
      var y = pos.y + dy;
      if (x <= 0 || x >= 49 || y <= 0 || y >= 49) {
        continue;
      }
      if (terrain.get(x, y) !== TERRAIN_MASK_WALL) {
        total++;
      }
    }
  }
  return total;
}

function _findAdjacentContainer(source) {
  if (!source || !source.pos) {
    return null;
  }
  var nearby = source.pos.findInRange(FIND_STRUCTURES, 1, {
    filter: function (structure) {
      return structure.structureType === STRUCTURE_CONTAINER;
    }
  });
  if (!nearby || nearby.length === 0) {
    return null;
  }
  return nearby[0];
}

function _findSeatPosition(source) {
  if (!source || !source.pos) {
    return null;
  }
  var container = _findAdjacentContainer(source);
  if (container) {
    return container.pos;
  }
  var terrain = new Room.Terrain(source.pos.roomName);
  var best = null;
  var dx;
  var dy;
  for (dx = -1; dx <= 1; dx++) {
    for (dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) {
        continue;
      }
      var x = source.pos.x + dx;
      var y = source.pos.y + dy;
      if (x <= 0 || x >= 49 || y <= 0 || y >= 49) {
        continue;
      }
      if (terrain.get(x, y) === TERRAIN_MASK_WALL) {
        continue;
      }
      var candidate = new RoomPosition(x, y, source.pos.roomName);
      if (!best) {
        best = candidate;
        continue;
      }
      if (candidate.y < best.y || (candidate.y === best.y && candidate.x < best.x)) {
        best = candidate;
      }
    }
  }
  return best;
}

module.exports = {
  run: runBaseHarvest
};
