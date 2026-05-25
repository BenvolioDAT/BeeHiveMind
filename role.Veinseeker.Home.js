'use strict';

// Home-room Veinseeker harvesting/offload behavior. Remote mining lives in
// role.Veinseeker.Remote.js; shared source/container mechanics live in
// SourceWorker.Manager.js.
var CFG = require('role.Veinseeker.Config');
var BeeToolbox = require('BeeToolbox');
var SourceWorkerManager = require('SourceWorker.Manager');

function debugOptions() {
  return {
    enabled: CFG.DEBUG_DRAW,
    width: CFG.DRAW.WIDTH,
    opacity: CFG.DRAW.OPACITY,
    font: CFG.DRAW.FONT
  };
}

function debugSay(creep, msg) {
  BeeToolbox.sayIfDebugEnabled(creep, msg, CFG.DEBUG_SAY);
}

function debugDrawLine(creep, target, color, label) {
  BeeToolbox.drawDebugLine(creep, target, color, label, debugOptions());
}

function debugRing(room, pos, color, text) {
  BeeToolbox.drawDebugRing(room, pos, color, text, debugOptions());
}

function roleNameMatches(value, expected) {
  if (!value || !expected) return false;
  return String(value).toLowerCase() === String(expected).toLowerCase();
}

function matchesRole(creep, roleName, legacyTask) {
  if (!creep || !creep.memory) return false;
  if (roleNameMatches(creep.memory.role, roleName)) return true;
  if (roleNameMatches(creep.memory.task, legacyTask || roleName)) return true;
  return roleNameMatches(creep.memory.task, roleName);
}

function getAssignedSourceId(creep) {
  return SourceWorkerManager.getSourceIdFromMemory(creep && creep.memory);
}

function isAvoidingSource(creep, sourceId) {
  return !!(
    creep &&
    creep.memory &&
    sourceId &&
    creep.memory._avoidSourceId === sourceId &&
    creep.memory._avoidUntil &&
    Game.time < creep.memory._avoidUntil
  );
}

function clearCurrentSourceAssignment(creep) {
  if (!creep || !creep.memory) return;
  delete creep.memory.assignedSource;
  delete creep.memory.sourceId;
  delete creep.memory.seatX;
  delete creep.memory.seatY;
  delete creep.memory.seatRoom;
  creep.memory.waitingForSeat = false;
}

function pinAssignedSource(creep, sourceId) {
  creep.memory.assignedSource = sourceId;
  creep.memory.sourceId = sourceId;
  return sourceId;
}

function getSeatPosFromMemory(creep) {
  if (!creep || !creep.memory) return null;
  if (typeof creep.memory.seatX !== 'number' ||
      typeof creep.memory.seatY !== 'number' ||
      !creep.memory.seatRoom) {
    return null;
  }
  return new RoomPosition(creep.memory.seatX, creep.memory.seatY, creep.memory.seatRoom);
}

function rememberSeat(creep, pos) {
  if (!creep || !creep.memory || !pos) return;
  creep.memory.seatX = pos.x;
  creep.memory.seatY = pos.y;
  creep.memory.seatRoom = pos.roomName;
}

function countCreepWorkParts(creep) {
  if (!creep || !creep.body) return 0;
  var workPart = typeof WORK === 'undefined' ? 'work' : WORK;
  var count = 0;
  for (var i = 0; i < creep.body.length; i++) {
    if (creep.body[i] && creep.body[i].type === workPart) count++;
  }
  return count;
}

function seatBelongsToSource(pos, source) {
  if (!pos || !source) return false;
  var seats = SourceWorkerManager.buildHarvestSeatList(source);
  var key = SourceWorkerManager.getHarvestSeatKey(pos);
  for (var i = 0; i < seats.length; i++) {
    if (SourceWorkerManager.getHarvestSeatKey(seats[i]) === key) return true;
  }
  return false;
}

function collectReservedSeats(roomName, excludeName) {
  var reserved = {};
  if (!roomName) return reserved;
  for (var name in Game.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Game.creeps, name)) continue;
    if (excludeName && name === excludeName) continue;
    var other = Game.creeps[name];
    if (!other || !other.my || !other.memory) continue;
    if (other.memory.mode === 'remote') continue;
    if (!matchesRole(other, 'Veinseeker', 'veinseeker')) continue;
    if (SourceWorkerManager.getCreepHomeRoomName(other) !== roomName) continue;
    if (!getAssignedSourceId(other)) continue;
    var seat = getSeatPosFromMemory(other);
    if (!seat || seat.roomName !== roomName) continue;
    reserved[SourceWorkerManager.getHarvestSeatKey(seat)] = other.name;
  }
  return reserved;
}

function ensureSeatForSource(creep, source, reservedSeats) {
  var current = getSeatPosFromMemory(creep);
  if (current && seatBelongsToSource(current, source)) {
    var reservedBy = reservedSeats ? reservedSeats[SourceWorkerManager.getHarvestSeatKey(current)] : null;
    if ((!reservedBy || reservedBy === creep.name) &&
        !SourceWorkerManager.isTileOccupiedByAnyCreep(current, creep.name)) {
      return current;
    }
  }

  var seat = SourceWorkerManager.chooseOpenHarvestSeat(source, creep.name, reservedSeats);
  if (!seat) return null;
  rememberSeat(creep, seat);
  return seat;
}

function getIncumbents(roomName, sourceId, excludeName) {
  var out = [];
  if (!roomName || !sourceId) return out;

  for (var name in Game.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Game.creeps, name)) continue;
    var creep = Game.creeps[name];
    if (!creep || !creep.my) continue;
    if (excludeName && name === excludeName) continue;
    if (!matchesRole(creep, 'Veinseeker', 'veinseeker')) continue;
    if (getAssignedSourceId(creep) !== sourceId) continue;
    if (!creep.room || creep.room.name !== roomName) continue;
    out.push(creep);
  }

  return out;
}

function countAssignedHarvesters(roomName, sourceId) {
  return getIncumbents(roomName, sourceId, null).length;
}

function shouldYieldPinnedSource(creep, source, rec) {
  if (!creep || !source || !rec) return false;
  if (rec.seats <= 0) return true;
  if (!rec.saturatedBySeats && !rec.saturatedByWork) return false;

  var incumbents = getIncumbents(creep.room.name, source.id, null);
  incumbents.sort(function (a, b) {
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  });

  var usedSeats = 0;
  var usedWork = 0;
  for (var i = 0; i < incumbents.length; i++) {
    if (incumbents[i].name === creep.name) {
      if (usedSeats >= rec.seats) return true;
      if (rec.desiredWork > 0 && usedWork >= rec.desiredWork) return true;
      return false;
    }
    usedSeats++;
    usedWork += countCreepWorkParts(incumbents[i]);
  }
  return false;
}

function writeHandoffDiag(roomName, sourceId, oldName, replacementName, ready, action, reason) {
  if (!roomName) return;
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
  Memory.rooms[roomName].lastVeinseekerHandoff = {
    tick: Game.time,
    sourceId: sourceId || null,
    oldCreep: oldName || null,
    replacement: replacementName || null,
    replacementReady: !!ready,
    action: action,
    reason: reason
  };
}

function isReplacementForSource(creep, sourceId) {
  if (!creep || !creep.memory || !sourceId) return false;
  if (creep.memory.sourceWorkerSpawnMode !== 'upgradeReplacement') return false;
  return (
    creep.memory.replaceSourceId ||
    creep.memory.assignedSource ||
    creep.memory.sourceId
  ) === sourceId;
}

function isHandoffPair(a, b, sourceId) {
  if (!a || !b || !sourceId || !a.memory || !b.memory) return false;
  if (a.memory.replacingCreepName === b.name && a.memory.replacementSourceId === sourceId) return true;
  if (b.memory.replacingCreepName === a.name && b.memory.replacementSourceId === sourceId) return true;
  if (a.memory.replacementFor === b.name && isReplacementForSource(a, sourceId)) return true;
  if (b.memory.replacementFor === a.name && isReplacementForSource(b, sourceId)) return true;
  return false;
}

function hasActiveWork(creep) {
  return creep && typeof creep.getActiveBodyparts === 'function' && creep.getActiveBodyparts(WORK) > 0;
}

function replacementReadyForHandoff(oldCreep, replacement, source) {
  if (!oldCreep || !replacement || !source || !replacement.memory) return false;
  if (replacement.spawning) return false;
  if (!matchesRole(replacement, 'Veinseeker', 'veinseeker')) return false;
  if (replacement.memory.replacementFor !== oldCreep.name) return false;
  if (getAssignedSourceId(replacement) !== source.id) return false;
  if (!hasActiveWork(replacement)) return false;
  if (!replacement.pos || replacement.pos.roomName !== source.pos.roomName) return false;
  if (replacement.pos.getRangeTo(source) <= (CFG.VEINSEEKER_HANDOFF_RANGE || 1)) return true;

  var seatPos = SourceWorkerManager.getPreferredSeatPos(source);
  if (seatPos && replacement.pos.isEqualTo(seatPos)) return true;

  var container = SourceWorkerManager.findSourceContainer(source);
  return !!(container && replacement.pos.isEqualTo(container.pos));
}

function handleRetirementHandoff(creep, source) {
  if (!creep || !creep.memory || !source) return false;
  if (!creep.memory.retireAfterReplacementReady) return false;
  if (creep.memory.replacementSourceId && creep.memory.replacementSourceId !== source.id) return false;

  var replacementName = creep.memory.replacingCreepName || null;
  var replacement = replacementName ? Game.creeps[replacementName] : null;
  var ready = replacementReadyForHandoff(creep, replacement, source);
  if (ready) {
    writeHandoffDiag(creep.room.name, source.id, creep.name, replacementName, true, 'retireOld', 'replacement-ready-at-source');
    creep.suicide();
    return true;
  }

  writeHandoffDiag(
    creep.room.name,
    source.id,
    creep.name,
    replacementName,
    false,
    'continueHarvesting',
    replacement ? 'replacement-not-ready-yet' : 'replacement-missing'
  );
  return false;
}

function scoreQueueCandidate(pos, occupied, seatPos) {
  var score = occupied ? -10 : 0;
  if (seatPos) score -= pos.getRangeTo(seatPos);
  score += (-pos.y * 0.01) + (-pos.x * 0.001);
  return score;
}

function findBestOpenAdjacentPos(anchorPos, myName, scoreFn) {
  var best = null;
  var bestScore = -Infinity;
  if (!anchorPos) return null;

  for (var dx = -1; dx <= 1; dx++) {
    for (var dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      var pos = new RoomPosition(anchorPos.x + dx, anchorPos.y + dy, anchorPos.roomName);
      if (!SourceWorkerManager.isWalkable(pos)) continue;
      var occupied = SourceWorkerManager.isTileOccupiedByAlly(pos, myName);
      var score = scoreFn(pos, occupied);
      if (score > bestScore) {
        bestScore = score;
        best = pos;
      }
    }
  }

  return best;
}

function findHandoffQueueSpot(source, seatPos, myName) {
  if (!source || !source.pos) return null;
  return findBestOpenAdjacentPos(source.pos, myName, function (pos, occupied) {
    if (seatPos && pos.isEqualTo(seatPos)) return -Infinity;
    return occupied ? -100 : -pos.getRangeTo(seatPos || source.pos);
  });
}

function findQueueSpotNearSeat(seatPos, myName) {
  return findBestOpenAdjacentPos(seatPos, myName, function (pos, occupied) {
    return scoreQueueCandidate(pos, occupied, seatPos);
  });
}

function resolveSourceConflict(creep, source) {
  var neighbors = source.pos.findInRange(FIND_MY_CREEPS, 1, {
    filter: function (other) {
      return other.name !== creep.name &&
        matchesRole(other, 'Veinseeker', 'veinseeker') &&
        getAssignedSourceId(other) === source.id;
    }
  }) || [];

  if (!neighbors.length) return false;
  for (var i = 0; i < neighbors.length; i++) {
    if (isHandoffPair(creep, neighbors[i], source.id)) return false;
  }

  var seats = SourceWorkerManager.buildHarvestSeatList(source).length;
  var mySeat = getSeatPosFromMemory(creep);
  var mySeatKey = mySeat ? SourceWorkerManager.getHarvestSeatKey(mySeat) : null;
  var sameSeatConflict = !mySeatKey;
  for (var si = 0; si < neighbors.length; si++) {
    var otherSeat = getSeatPosFromMemory(neighbors[si]);
    var otherSeatKey = otherSeat ? SourceWorkerManager.getHarvestSeatKey(otherSeat) : null;
    if (!otherSeatKey || otherSeatKey === mySeatKey) {
      sameSeatConflict = true;
      break;
    }
  }
  if (!sameSeatConflict && countAssignedHarvesters(creep.room.name, source.id) <= seats) return false;
  if (countAssignedHarvesters(creep.room.name, source.id) <= 1) return false;

  var all = neighbors.concat([creep]);
  var winner = all[0];
  for (var j = 1; j < all.length; j++) {
    if (all[j].name < winner.name) winner = all[j];
  }
  if (winner.name === creep.name) return false;

  creep.memory._avoidSourceId = source.id;
  creep.memory._avoidUntil = Game.time + CFG.AVOID_TICKS_AFTER_YIELD;
  creep.memory._reassignCooldown = Game.time + 5;
  clearCurrentSourceAssignment(creep);
  debugSay(creep, 'yield 🐝');
  debugRing(creep.room, source.pos, CFG.DRAW.YIELD, 'YIELD');
  return true;
}

function shouldQueueForSource(creep, source, seats, used) {
  if (used < seats) return false;
  var incumbents = getIncumbents(creep.room.name, source.id, creep.name);
  for (var i = 0; i < incumbents.length; i++) {
    if (isHandoffPair(creep, incumbents[i], source.id)) return true;
    var ttl = incumbents[i].ticksToLive;
    if (typeof ttl === 'number' && ttl <= CFG.HANDOFF_TTL) return true;
  }
  return false;
}

function writeVeinseekerSlotDiag(roomName, sourceId, rec) {
  if (!roomName) return;
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
  Memory.rooms[roomName].lastVeinseekerSourceSlots = {
    tick: Game.time,
    sourceId: sourceId || null,
    seats: rec ? (rec.seats || 0) : 0,
    assigned: rec ? ((rec.live || 0) + (rec.queued || 0)) : 0,
    live: rec ? (rec.live || 0) : 0,
    queued: rec ? (rec.queued || 0) : 0,
    liveWork: rec ? (rec.liveWork || 0) : 0,
    queuedWork: rec ? (rec.queuedWork || 0) : 0,
    desiredWork: rec ? (rec.desiredWork || 0) : 0,
    freeWork: rec ? (rec.freeWork || 0) : 0,
    reason: rec ? (rec.reason || null) : null
  };
}

function assignSource(creep) {
  if (!creep || creep.spawning) return null;
  if (creep.memory._reassignCooldown && Game.time < creep.memory._reassignCooldown) {
    return creep.memory.assignedSource || null;
  }

  var pinnedSource = getAssignedSourceId(creep);
  if (pinnedSource && !isAvoidingSource(creep, pinnedSource)) {
    var pinned = Game.getObjectById(pinnedSource);
    if (pinned) {
      var pinnedReport = SourceWorkerManager.buildHomeCoverageReport(creep.room, { writeDiag: false });
      var pinnedRec = pinnedReport && pinnedReport.diag && pinnedReport.diag.sources
        ? pinnedReport.diag.sources[pinnedSource]
        : null;
      var pinnedReserved = collectReservedSeats(creep.room.name, creep.name);
      if (!shouldYieldPinnedSource(creep, pinned, pinnedRec)) {
        var pinnedSeat = ensureSeatForSource(creep, pinned, pinnedReserved);
        if (pinnedSeat) {
          creep.memory.waitingForSeat = false;
          return pinAssignedSource(creep, pinnedSource);
        }
      }
    }
    clearCurrentSourceAssignment(creep);
  }

  var sources = creep.room.find(FIND_SOURCES) || [];
  var report = SourceWorkerManager.buildHomeCoverageReport(creep.room, { writeDiag: false });
  var reservedSeats = collectReservedSeats(creep.room.name, creep.name);
  var best = null;
  var bestScore = -Infinity;

  for (var i = 0; i < sources.length; i++) {
    var source = sources[i];
    if (isAvoidingSource(creep, source.id)) continue;

    var rec = report && report.diag && report.diag.sources ? report.diag.sources[source.id] : null;
    if (!rec) continue;
    writeVeinseekerSlotDiag(creep.room.name, source.id, rec);
    if (rec.desiredWork <= 0) continue;
    if (rec.freeWork <= 0 || rec.saturatedByWork) continue;
    if (rec.seats <= 0 || rec.saturatedBySeats) continue;

    var seatPos = SourceWorkerManager.chooseOpenHarvestSeat(source, creep.name, reservedSeats);
    if (!seatPos) continue;

    var assigned = (rec.live || 0) + (rec.queued || 0);
    var openSeats = Math.max(0, (rec.seats || 0) - assigned);
    var score = (rec.freeWork * 10000) +
      (openSeats * 1000) -
      (assigned * 250) -
      creep.pos.getRangeTo(seatPos);
    if (score > bestScore) {
      bestScore = score;
      best = { source: source, seatPos: seatPos };
    }
  }

  if (!best) return null;
  creep.memory.assignedSource = best.source.id;
  creep.memory.sourceId = best.source.id;
  rememberSeat(creep, best.seatPos);
  creep.memory.waitingForSeat = false;

  debugSay(creep, '🎯');
  debugRing(creep.room, best.source.pos, CFG.DRAW.SOURCE, 'SRC');
  debugRing(creep.room, best.seatPos, CFG.DRAW.SEAT, 'SEAT');
  return best.source.id;
}

function getContainerAtOrAdjacent(pos) {
  if (!pos) return null;
  var here = pos.lookFor(LOOK_STRUCTURES) || [];
  for (var i = 0; i < here.length; i++) {
    if (here[i].structureType === STRUCTURE_CONTAINER) return here[i];
  }

  var around = pos.findInRange(FIND_STRUCTURES, 1, {
    filter: function (structure) {
      return structure.structureType === STRUCTURE_CONTAINER;
    }
  }) || [];
  return around.length ? around[0] : null;
}

function getSourceLink(source) {
  if (!source || !source.room || !source.room.controller || !source.room.controller.my) return null;
  if ((source.room.controller.level || 0) < 6) return null;
  var links = source.pos.findInRange(FIND_MY_STRUCTURES, 2, {
    filter: function (structure) {
      return structure.structureType === STRUCTURE_LINK &&
        structure.store &&
        structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
    }
  }) || [];
  return links.length ? links[0] : null;
}

function transferToSourceLink(creep, source) {
  if (!creep || !source || creep.store.getUsedCapacity(RESOURCE_ENERGY) <= 0) return false;
  var link = getSourceLink(source);
  if (!link) return false;
  var rc = creep.transfer(link, RESOURCE_ENERGY);
  if (rc === OK) return true;
  if (rc === ERR_NOT_IN_RANGE && creep.pos.getRangeTo(link) <= 2) {
    creep.travelTo(link, { range: 1, reusePath: CFG.TRAVEL_REUSE });
    return true;
  }
  return false;
}

function countCreepsWithRole(roleName, legacyTask) {
  var count = 0;
  for (var name in Game.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Game.creeps, name)) continue;
    if (matchesRole(Game.creeps[name], roleName, legacyTask)) count++;
  }
  return count;
}

function hasEnergyCollector() {
  return countCreepsWithRole('Trucker', 'haulUnified') > 0 ||
    countCreepsWithRole('Queen', 'queen') > 0;
}

function ensureVeinseekerIdentity(creep) {
  if (!creep || !creep.memory) return;
  if (!creep.memory.role || String(creep.memory.role).toLowerCase() === 'veinseeker') {
    creep.memory.role = 'Veinseeker';
  }
  if (!creep.memory.task) creep.memory.task = 'veinseeker';
}

function determineVeinseekerState(creep) {
  if (!creep) return 'IDLE';
  ensureVeinseekerIdentity(creep);

  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
    creep.memory.harvesting = true;
    debugSay(creep, '⤵️MINE');
  } else if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
    creep.memory.harvesting = false;
    debugSay(creep, '⤴️DROP');
  }

  var nextState = 'IDLE';
  if (creep.memory.harvesting) nextState = 'HARVEST';
  else if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) nextState = 'OFFLOAD_HOME';

  creep.memory.state = nextState;
  return nextState;
}

function moveToExact(creep, pos, say, color, label) {
  if (say) debugSay(creep, say);
  if (color && label) debugRing(creep.room, pos, color, label);
  creep.travelTo(pos, { range: 0, reusePath: CFG.TRAVEL_REUSE });
}

function harvestWhileWaiting(creep, source, seatPos) {
  if (creep.pos.getRangeTo(source) <= 1) {
    debugDrawLine(creep, source, CFG.DRAW.SOURCE, 'HARV');
    creep.harvest(source);
  }

  if (seatPos && (!SourceWorkerManager.isTileOccupiedByAnyCreep(seatPos, creep.name) ||
      countAssignedHarvesters(creep.room.name, source.id) < SourceWorkerManager.buildHarvestSeatList(source).length)) {
    creep.travelTo(seatPos, { range: 0, reusePath: CFG.TRAVEL_REUSE });
    creep.memory.waitingForSeat = false;
  }
}

function runHarvestPhase(creep) {
  var sourceId = assignSource(creep);
  if (!sourceId) {
    debugSay(creep, '❓');
    return;
  }

  var source = Game.getObjectById(sourceId);
  if (!source) {
    clearCurrentSourceAssignment(creep);
    return;
  }

  if (handleRetirementHandoff(creep, source)) return;
  if (resolveSourceConflict(creep, source)) return;

  var reservedSeats = collectReservedSeats(creep.room.name, creep.name);
  var seatPos = getSeatPosFromMemory(creep);
  if (!seatPos || !seatBelongsToSource(seatPos, source) ||
      SourceWorkerManager.isTileOccupiedByAnyCreep(seatPos, creep.name)) {
    seatPos = ensureSeatForSource(creep, source, reservedSeats);
  }
  if (!seatPos) {
    clearCurrentSourceAssignment(creep);
    return;
  }
  if (seatPos) debugRing(creep.room, seatPos, CFG.DRAW.SEAT, 'SEAT');

  var seats = SourceWorkerManager.buildHarvestSeatList(source).length;
  var used = countAssignedHarvesters(creep.room.name, source.id);
  if (used < seats) creep.memory.waitingForSeat = false;

  var seatBlocked = seatPos
    ? SourceWorkerManager.isTileOccupiedByAnyCreep(seatPos, creep.name) && !creep.pos.isEqualTo(seatPos)
    : false;
  var shouldWaitNearSeat = (seatBlocked || creep.memory.waitingForSeat) &&
    used >= seats &&
    shouldQueueForSource(creep, source, seats, used);

  if (shouldWaitNearSeat) {
    var queueSpot = isReplacementForSource(creep, source.id)
      ? (findHandoffQueueSpot(source, seatPos, creep.name) || findQueueSpotNearSeat(seatPos, creep.name) || seatPos)
      : (findQueueSpotNearSeat(seatPos, creep.name) || seatPos);

    creep.memory.waitingForSeat = true;
    debugSay(creep, '⏳');
    debugRing(creep.room, queueSpot, CFG.DRAW.QUEUE, 'QUEUE');
    if (!creep.pos.isEqualTo(queueSpot)) {
      creep.travelTo(queueSpot, { range: 0, reusePath: CFG.TRAVEL_REUSE });
      return;
    }
    harvestWhileWaiting(creep, source, seatPos);
    return;
  }

  if (seatPos && !creep.pos.isEqualTo(seatPos)) {
    moveToExact(creep, seatPos, '🪑', CFG.DRAW.SEAT, 'SEAT');
    return;
  }

  creep.memory.waitingForSeat = false;
  var container = getContainerAtOrAdjacent(creep.pos);
  if (transferToSourceLink(creep, source)) return;

  if (hasEnergyCollector() && container && creep.pos.isEqualTo(container.pos)) {
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
      var transferResult = creep.transfer(container, RESOURCE_ENERGY);
      if (transferResult === ERR_FULL) {
        debugSay(creep, '⬇️');
        creep.drop(RESOURCE_ENERGY);
      } else if (transferResult === ERR_NOT_IN_RANGE) {
        creep.travelTo(container.pos, { range: 0, reusePath: CFG.TRAVEL_REUSE });
        return;
      }
    }
  }

  debugSay(creep, '⛏️');
  debugDrawLine(creep, source, CFG.DRAW.SOURCE, 'HARV');
  creep.harvest(source);
}

function findClosestEnergyDropoff(creep, structureType) {
  return creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
    filter: function (structure) {
      return structure.structureType === structureType &&
        structure.store &&
        structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
    }
  });
}

function tryTransferToDropoff(creep, target) {
  if (!target) return false;
  debugSay(creep, '🏠');
  debugDrawLine(creep, target, CFG.DRAW.OFFLOAD, 'RETURN');
  var result = creep.transfer(target, RESOURCE_ENERGY);
  if (result === OK) return true;
  if (result === ERR_NOT_IN_RANGE) {
    creep.travelTo(target, { range: 1, reusePath: CFG.TRAVEL_REUSE });
    return true;
  }
  return false;
}

function runFallbackOffload(creep) {
  if (tryTransferToDropoff(creep, findClosestEnergyDropoff(creep, STRUCTURE_SPAWN))) return;
  if (tryTransferToDropoff(creep, findClosestEnergyDropoff(creep, STRUCTURE_EXTENSION))) return;
  if (creep.room.storage && creep.room.storage.store && creep.room.storage.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
    if (tryTransferToDropoff(creep, creep.room.storage)) return;
  }

  var container = creep.pos.findClosestByPath(FIND_STRUCTURES, {
    filter: function (structure) {
      return structure.structureType === STRUCTURE_CONTAINER &&
        structure.store &&
        structure.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
    }
  });
  if (tryTransferToDropoff(creep, container)) return;

  debugSay(creep, '⬇️');
  creep.drop(RESOURCE_ENERGY);
}

function runCollectorOffload(creep) {
  var container = getContainerAtOrAdjacent(creep.pos);
  if (!container) {
    debugSay(creep, '⬇️');
    debugRing(creep.room, creep.pos, CFG.DRAW.OFFLOAD, 'DROP');
    creep.drop(RESOURCE_ENERGY);
    return;
  }

  if (!creep.pos.isEqualTo(container.pos)) {
    debugSay(creep, '📦→');
    debugDrawLine(creep, container, CFG.DRAW.OFFLOAD, 'SEAT');
    creep.travelTo(container.pos, { range: 0, reusePath: CFG.TRAVEL_REUSE });
    return;
  }

  debugSay(creep, '📦');
  var transferResult = creep.transfer(container, RESOURCE_ENERGY);
  if (transferResult === OK) return;
  if (transferResult === ERR_NOT_IN_RANGE) {
    creep.travelTo(container.pos, { range: 0, reusePath: CFG.TRAVEL_REUSE });
    return;
  }

  debugSay(creep, '⬇️');
  creep.drop(RESOURCE_ENERGY);
}

function runOffloadPhase(creep) {
  if (!hasEnergyCollector()) {
    runFallbackOffload(creep);
    return;
  }
  runCollectorOffload(creep);
}

function idleWhenEmpty(creep) {
  if (!creep || creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) return;
  debugSay(creep, '🧘');
  debugRing(creep.room, creep.pos, CFG.DRAW.IDLE, 'IDLE');
}

function run(creep) {
  var state = determineVeinseekerState(creep);
  if (state === 'HARVEST') {
    runHarvestPhase(creep);
    return;
  }
  if (state === 'OFFLOAD_HOME') {
    runOffloadPhase(creep);
    return;
  }
  idleWhenEmpty(creep);
}

module.exports = { run: run };
