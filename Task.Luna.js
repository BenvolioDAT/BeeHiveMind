'use strict';

// Task.Luna.js — autonomous remote miner assignment & seat management
// ------------------------------------------------------------------
// This rewrite makes every Luna creep self-assign to a remote source that
// scouts have mapped into Memory.rooms[room].sources. The spawn only wires
// role + homeRoom; Lunas claim sources dynamically, defend that claim with
// TTL heartbeats, and gracefully yield if another miner contests the same
// node. Movement, seating, container upkeep, and harvesting loops remain
// aligned with the previous behavior, but the remote routing is now fully
// creep-driven and resilient to race conditions.

var BeeSelectors = null;
var BeeActions = null;

try { BeeSelectors = require('BeeSelectors'); } catch (err) {}
try { BeeActions = require('BeeActions'); } catch (err2) {}

var REMOTE_RADIUS = 1;              // maximum room linear distance from home
var MAX_LUNA_PER_SOURCE = 1;        // enforced quota per source
var CLAIM_TTL = 150;                // claim expiry in ticks unless refreshed
var CLAIM_REFRESH_INTERVAL = 50;    // refresh cadence while alive
var COLLISION_CHECK_INTERVAL = 5;   // spacing between collision checks

// --------------------------------------------------------------------------
// Traveler guard — load once per tick if travelTo has not yet been injected.
// --------------------------------------------------------------------------
function ensureTraveler() {
  if (typeof Creep.prototype.travelTo === 'function') return;
  try { require('Traveler'); } catch (err) {}
}

// --------------------------------------------------------
// Memory helpers for autonomous source claim bookkeeping.
// --------------------------------------------------------
function ensureClaimMemory() {
  if (!Memory.__BHM) Memory.__BHM = {};
  if (!Memory.__BHM.lunaClaims) Memory.__BHM.lunaClaims = {};
}

// Attempts to rebuild a Luna's critical remote metadata if it was lost between spawn and the first tick.
// Uses pending source claims first, then falls back to inspecting the assigned source object.
function tryRestoreLunaMemory(creep, mem) {
  if (!creep || !mem) return false;
  var restored = false;
  ensureRemoteMemory();
  var claims = Memory.__BHM.remoteSourceClaims || {};
  for (var sid in claims) {
    if (!Object.prototype.hasOwnProperty.call(claims, sid)) continue;
    var claim = claims[sid];
    if (!claim || claim.creepName !== creep.name) continue;
    if (!mem.sourceId) mem.sourceId = sid;
    if (!mem.remoteRoom && claim.remoteRoom) mem.remoteRoom = claim.remoteRoom;
    if (!mem.homeRoom && claim.homeRoom) mem.homeRoom = claim.homeRoom;
    restored = true;
    break;
  }
  if ((!mem.remoteRoom || !mem.sourceId) && mem.sourceId) {
    var fallbackSource = Game.getObjectById(mem.sourceId);
    if (fallbackSource && fallbackSource.pos) {
      if (!mem.remoteRoom) mem.remoteRoom = fallbackSource.pos.roomName;
      restored = true;
    }
  }
  if (!mem.homeRoom) {
    var inferredHome = inferHome(creep);
    if (inferredHome) {
      mem.homeRoom = inferredHome;
      restored = true;
    }
  }
  return restored || (!!mem.remoteRoom && !!mem.sourceId);
}

function inferHome(creep) {
  if (!creep) return null;
  if (creep.memory && creep.memory.homeRoom) return creep.memory.homeRoom;
  if (creep.memory && creep.memory.home) return creep.memory.home;
  if (creep.room && creep.room.controller && creep.room.controller.my) return creep.room.name;
  var names = Object.keys(Game.spawns || {});
  if (names.length) return Game.spawns[names[0]].room.name;
  return null;
}

function activeClaimantsBySource() {
  ensureClaimMemory();
  var claims = Memory.__BHM.lunaClaims;
  var out = {};
  for (var sid in claims) {
    if (!Object.prototype.hasOwnProperty.call(claims, sid)) continue;
    var claim = claims[sid];
    if (!claim) continue;
    if (typeof claim.until !== 'number' || claim.until < Game.time) continue;
    if (!claim.creep || !Game.creeps[claim.creep]) continue;
    out[sid] = claim.creep;
  }
  return out;
}

function claimSource(sourceId, creep, remoteRoom, homeRoom) {
  if (!sourceId || !creep) return;
  ensureClaimMemory();
  var claims = Memory.__BHM.lunaClaims;
  claims[sourceId] = {
    creep: creep.name,
    home: homeRoom || (creep.memory && creep.memory.homeRoom) || null,
    remote: remoteRoom || null,
    until: Game.time + CLAIM_TTL
  };
}

function releaseClaim(sourceId, creepName) {
  if (!sourceId || !creepName) return;
  ensureClaimMemory();
  var claim = Memory.__BHM.lunaClaims[sourceId];
  if (claim && claim.creep === creepName) {
    delete Memory.__BHM.lunaClaims[sourceId];
  }
}

function clearAssignment(creep, mem) {
  if (!mem) return;
  if (mem.sourceId) releaseClaim(mem.sourceId, creep ? creep.name : null);
  mem.sourceId = null;
  mem.remoteRoom = null;
  mem.containerId = null;
  mem.lastClaimRefresh = null;
  refreshSeatMemo(mem, null);
}

// ------------------------------------------------------------------
// Room/source discovery based on scout-populated Memory.rooms intel.
// ------------------------------------------------------------------
function candidateFromSourceRecord(roomName, sourceId, record) {
  if (!roomName || !sourceId) return null;
  var seat = null;
  if (record && record.seat && record.seat.x != null && record.seat.y != null && record.seat.roomName) {
    seat = { x: record.seat.x, y: record.seat.y, roomName: record.seat.roomName };
  }
  var containerId = null;
  if (record && record.container && record.container.containerId) {
    containerId = record.container.containerId;
  }
  return {
    roomName: roomName,
    sourceId: sourceId,
    seat: seat,
    containerId: containerId
  };
}

function pickCandidateSources(homeRoom, radius) {
  var out = [];
  if (!homeRoom || !Memory.rooms) return out;
  for (var rn in Memory.rooms) {
    if (!Object.prototype.hasOwnProperty.call(Memory.rooms, rn)) continue;
    var data = Memory.rooms[rn];
    if (!data || !data.sources) continue;
    var distance = null;
    try {
      distance = Game.map.getRoomLinearDistance(homeRoom, rn, true);
    } catch (err) {
      distance = null;
    }
    if (distance == null || distance > radius) continue;
    var intel = data.intel;
    if (intel) {
      if (intel.owner && intel.owner !== 'Invader') continue;
      if (intel.reservation && intel.reservation !== 'Invader') continue;
    }
    for (var sid in data.sources) {
      if (!Object.prototype.hasOwnProperty.call(data.sources, sid)) continue;
      var record = data.sources[sid];
      var candidate = candidateFromSourceRecord(rn, sid, record);
      if (candidate) out.push(candidate);
    }
  }
  return out;
}

function pickUnclaimedSource(homeRoom) {
  sweepExpiredClaims();
  var candidates = pickCandidateSources(homeRoom, REMOTE_RADIUS);
  if (!candidates.length) return null;
  var active = activeClaimantsBySource();
  var best = null;
  var bestScore = -9999;
  for (var i = 0; i < candidates.length; i++) {
    var cand = candidates[i];
    if (!cand) continue;
    var claimedCount = active[cand.sourceId] ? 1 : 0;
    if (claimedCount >= MAX_LUNA_PER_SOURCE) continue;
    var score = 0;
    if (cand.containerId) score += 2;
    if (cand.seat) score += 1;
    if (!best || score > bestScore) {
      best = cand;
      bestScore = score;
    }
  }
  return best;
}

// ----------------------------------------------------
// Utility helpers reused by the seat/harvest workflow.
// ----------------------------------------------------
function inferHomeRoom(creep) {
  if (!creep) return null;
  if (creep.memory && creep.memory.homeRoom) return creep.memory.homeRoom;
  if (creep.room && creep.room.controller && creep.room.controller.my) return creep.room.name;
  var names = Object.keys(Game.spawns || {});
  if (names.length) {
    var spawnObj = Game.spawns[names[0]];
    if (spawnObj && spawnObj.room) return spawnObj.room.name;
  }
  return null;
}

function transitionState(creep, mem, next, utterance) {
  if (!mem) return;
  if (mem.state === next) return;
  mem.state = next;
  if (creep && utterance) creep.say(utterance);
}

function moveToTarget(creep, pos, range) {
  if (!creep || !pos) return;
  ensureTraveler();
  var rp = pos.pos ? pos.pos : new RoomPosition(pos.x, pos.y, pos.roomName);
  var desiredRange = (range == null) ? 1 : range;
  if (typeof creep.travelTo === 'function') {
    creep.travelTo(rp, {
      range: desiredRange,
      preferHighway: true,
      maxOps: 4000,
      stuckValue: 2,
      reusePath: 10
    });
  } else {
    creep.moveTo(rp, { range: desiredRange, reusePath: 10 });
  }
}

function safeHarvest(creep, source) {
  if (!creep || !source) return;
  if (BeeActions && BeeActions.safeHarvest) {
    BeeActions.safeHarvest(creep, source, 100);
    return;
  }
  var result = creep.harvest(source);
  if (result === ERR_NOT_IN_RANGE) moveToTarget(creep, source.pos, 1);
}

function safeTransfer(creep, target) {
  if (!creep || !target) return;
  if (BeeActions && BeeActions.safeTransfer) {
    BeeActions.safeTransfer(creep, target, RESOURCE_ENERGY, null, 96);
    return;
  }
  var result = creep.transfer(target, RESOURCE_ENERGY);
  if (result === ERR_NOT_IN_RANGE) moveToTarget(creep, target.pos, 1);
}

function safeBuild(creep, site) {
  if (!creep || !site) return;
  if (BeeActions && BeeActions.safeBuild) {
    BeeActions.safeBuild(creep, site, 94);
    return;
  }
  var result = creep.build(site);
  if (result === ERR_NOT_IN_RANGE) moveToTarget(creep, site.pos, 1);
}

function rememberSourceMetadata(source, container, seatPos) {
  if (!source || !source.pos) return;
  Memory.rooms = Memory.rooms || {};
  var rm = Memory.rooms[source.pos.roomName] = Memory.rooms[source.pos.roomName] || {};
  rm.sources = rm.sources || {};
  var rec = rm.sources[source.id] = rm.sources[source.id] || {};
  rec.x = source.pos.x;
  rec.y = source.pos.y;
  rec.roomName = source.pos.roomName;
  if (seatPos) {
    rec.seat = { x: seatPos.x, y: seatPos.y, roomName: seatPos.roomName };
  }
  if (container) {
    rec.container = rec.container || {};
    rec.container.containerId = container.id;
  }
}

function locateContainer(source) {
  if (!source || !source.pos || !source.room) return null;
  var structs = source.room.find(FIND_STRUCTURES, {
    filter: function (s) {
      return s.structureType === STRUCTURE_CONTAINER && s.pos.getRangeTo(source.pos) <= 1;
    }
  });
  if (structs && structs.length) return structs[0];
  return null;
}

function locateContainerSite(source) {
  if (!source || !source.pos || !source.room) return null;
  var sites = source.room.find(FIND_CONSTRUCTION_SITES, {
    filter: function (s) {
      return s.structureType === STRUCTURE_CONTAINER && s.pos.getRangeTo(source.pos) <= 1;
    }
  });
  if (sites && sites.length) return sites[0];
  return null;
}

function seatPositionFor(source, memo) {
  if (!source || !source.pos) return null;
  if (memo && memo.seat && memo.seat.x != null && memo.seat.y != null) {
    return new RoomPosition(memo.seat.x, memo.seat.y, memo.seat.roomName);
  }
  var container = locateContainer(source);
  if (container) {
    rememberSourceMetadata(source, container, container.pos);
    return container.pos;
  }
  if (BeeSelectors && typeof BeeSelectors.getSourceContainerOrSite === 'function') {
    var info = BeeSelectors.getSourceContainerOrSite(source);
    if (info) {
      if (info.container) {
        rememberSourceMetadata(source, info.container, info.container.pos);
        return info.container.pos;
      }
      if (info.seatPos) {
        rememberSourceMetadata(source, info.container || null, info.seatPos);
        return new RoomPosition(info.seatPos.x, info.seatPos.y, info.seatPos.roomName);
      }
    }
  }
  if (Memory.rooms && Memory.rooms[source.pos.roomName]) {
    var rec = Memory.rooms[source.pos.roomName].sources;
    if (rec && rec[source.id] && rec[source.id].seat) {
      var seatMem = rec[source.id].seat;
      if (seatMem.x != null && seatMem.y != null && seatMem.roomName) {
        return new RoomPosition(seatMem.x, seatMem.y, seatMem.roomName);
      }
    }
  }
  return source.pos;
}

function refreshSeatMemo(mem, seatPos) {
  if (!mem) return;
  if (!seatPos) {
    delete mem.seat;
    return;
  }
  mem.seat = { x: seatPos.x, y: seatPos.y, roomName: seatPos.roomName };
}

function resolveCollision(creep, mem) {
  if (!creep || !mem || !mem.sourceId) return false;
  if (Game.time % COLLISION_CHECK_INTERVAL !== 0) return false;
  var rivals = [];
  for (var name in Game.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Game.creeps, name)) continue;
    if (name === creep.name) continue;
    var c = Game.creeps[name];
    if (!c || !c.memory) continue;
    if (c.memory.role !== 'Luna') continue;
    if (c.memory.sourceId !== mem.sourceId) continue;
    rivals.push(name);
  }
  if (!rivals.length) return false;
  rivals.push(creep.name);
  rivals.sort();
  var winner = rivals[0];
  if (creep.name === winner) {
    // Ensure the claim reflects the winner; refresh immediately so losers notice.
    claimSource(mem.sourceId, creep, mem.remoteRoom, mem.homeRoom);
    mem.lastClaimRefresh = Game.time;
    return false;
  }
  clearAssignment(creep, mem);
  transitionState(creep, mem, 'init', 'yield');
  return true;
}

function refreshClaimHeartbeat(creep, mem) {
  if (!mem || !mem.sourceId) return;
  if (!mem.lastClaimRefresh || (Game.time - mem.lastClaimRefresh >= CLAIM_REFRESH_INTERVAL)) {
    claimSource(mem.sourceId, creep, mem.remoteRoom, mem.homeRoom);
    mem.lastClaimRefresh = Game.time;
  }
}

function logAssignment(creep, homeRoom, assignment) {
  if (!assignment) return;
  console.log('[Luna] assigned', creep.name, 'home=', homeRoom || 'n/a', 'remote=', assignment.roomName || 'n/a', 'source=', assignment.sourceId);
}

function logNoSource(creep, homeRoom) {
  var candidates = pickCandidateSources(homeRoom, REMOTE_RADIUS);
  var rooms = {};
  for (var i = 0; i < candidates.length; i++) {
    var cand = candidates[i];
    if (cand && cand.roomName) rooms[cand.roomName] = true;
  }
  var roomCount = 0;
  for (var rn in rooms) if (Object.prototype.hasOwnProperty.call(rooms, rn)) roomCount++;
  console.log('[Luna] no-src', creep.name, 'home=', homeRoom || 'n/a', 'rooms=', roomCount, 'sources=', candidates.length);
}

function acquireAssignment(creep, mem) {
  var home = mem.homeRoom || inferHomeRoom(creep);
  if (!home) home = creep.room ? creep.room.name : null;
  mem.homeRoom = home;
  var assignment = pickUnclaimedSource(home);
  if (!assignment) {
    logNoSource(creep, home);
    creep.say('no-src');
    return false;
  }
  refreshSeatMemo(mem, null);
  mem.containerId = null;
  mem.remoteRoom = assignment.roomName;
  mem.sourceId = assignment.sourceId;
  mem.state = 'travel';
  mem.lastClaimRefresh = Game.time;
  claimSource(assignment.sourceId, creep, assignment.roomName, home);
  logAssignment(creep, home, assignment);
  creep.say('travel');
  return true;
}

function ensureHome(mem, creep) {
  if (mem.homeRoom) return;
  var inferred = inferHomeRoom(creep);
  if (inferred) mem.homeRoom = inferred;
}

function ensureState(mem) {
  if (!mem.state) mem.state = 'init';
}

function runTravel(creep, mem) {
  if (!mem.remoteRoom || !mem.sourceId) {
    clearAssignment(creep, mem);
    transitionState(creep, mem, 'init', 'init');
    return;
  }
  if (creep.room && creep.room.name === mem.remoteRoom) {
    transitionState(creep, mem, 'seat', 'seat');
    return;
  }
  var center = new RoomPosition(25, 25, mem.remoteRoom);
  moveToTarget(creep, center, 20);
}

function runSeat(creep, mem) {
  var source = Game.getObjectById(mem.sourceId);
  if (!source) {
    clearAssignment(creep, mem);
    transitionState(creep, mem, 'init', 'init');
    return;
  }
  if (!creep.room || creep.room.name !== mem.remoteRoom) {
    transitionState(creep, mem, 'travel', 'travel');
    return;
  }
  var seatPos = seatPositionFor(source, mem);
  refreshSeatMemo(mem, seatPos);
  var container = null;
  if (seatPos && seatPos.roomName === creep.room.name) {
    container = locateContainer(source);
    if (!container && mem.containerId) {
      container = Game.getObjectById(mem.containerId);
    }
    if (container) {
      mem.containerId = container.id;
      rememberSourceMetadata(source, container, container.pos);
    }
  }
  if (seatPos) {
    var atSeat = creep.pos.isEqualTo(seatPos.x, seatPos.y);
    if (!atSeat) {
      moveToTarget(creep, seatPos, 0);
      return;
    }
    transitionState(creep, mem, 'harvest', 'harvest');
    return;
  }
  moveToTarget(creep, source.pos, 1);
}

function handleHarvestLoop(creep, task) {
  var source = Game.getObjectById(task.sourceId);
  if (!source) return;
  var seatPos = seatPosFromTask(task);
  if (!seatPos) {
    if (creep.memory) creep.memory.state = 'seat';
    if (task.state !== 'seat') creep.say('seat');
    task.state = 'seat';
    queueMove(creep, source.pos, MOVE_PRIORITY, 1);
    return;
  }
  var seatReserved = tryReserveSeat(task, seatPos);
  if (!seatReserved && !creep.pos.isEqualTo(seatPos)) {
    if (creep.memory) creep.memory.state = 'seat';
    if (task.state !== 'seat') creep.say('seat');
    task.state = 'seat';
    queueMove(creep, seatPos, MOVE_PRIORITY, 1);
    return;
  }
  if (!creep.pos.isEqualTo(seatPos)) {
    if (creep.memory) creep.memory.state = 'seat';
    if (task.state !== 'seat') creep.say('seat');
    task.state = 'seat';
    queueMove(creep, seatPos, MOVE_PRIORITY, 0);
    return;
  }
  var container = locateContainer(source);
  if (!container && mem.containerId) container = Game.getObjectById(mem.containerId);
  if (container) {
    if (creep.memory) creep.memory.state = 'harvest';
    if (task.state !== 'harvest') creep.say('harvest');
    task.state = 'harvest';
    safeHarvest(creep, seatInfoSource);
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
      safeTransfer(creep, container);
    }
  } else {
    var site = null;
    if (creep.room && creep.room.name === seatPos.roomName) {
      var sites = creep.room.lookForAt(LOOK_CONSTRUCTION_SITES, seatPos.x, seatPos.y);
      if (sites && sites.length) site = sites[0];
    }
    if (site) {
      if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
        if (creep.memory) creep.memory.state = 'build';
        if (task.state !== 'build') creep.say('build');
        task.state = 'build';
        safeBuild(creep, site);
      } else {
        if (creep.memory) creep.memory.state = 'harvest';
        task.state = 'harvest';
        creep.say('harvest');
        safeHarvest(creep, seatInfoSource);
      }
    } else {
      if (creep.memory) creep.memory.state = 'harvest';
      task.state = 'harvest';
      creep.say('harvest');
      safeHarvest(creep, seatInfoSource);
    }
  }
  var site = locateContainerSite(source);
  if (!container && site) {
    safeBuild(creep, site);
  }
  safeHarvest(creep, source);
  if (container && creep.store && creep.store[RESOURCE_ENERGY] > 0) {
    safeTransfer(creep, container);
  } else if (!container && creep.store && creep.store.getFreeCapacity && creep.store.getFreeCapacity() === 0) {
    creep.drop(RESOURCE_ENERGY);
  }
}

function run(creep) {
  if (!creep) return;
  var mem = creep.memory = creep.memory || {};
  sweepExpiredClaims();
  ensureState(mem);
  ensureHome(mem, creep);
  if (mem.targetRoom && !mem.remoteRoom) {
    mem.remoteRoom = mem.targetRoom;
    delete mem.targetRoom;
  }
  var retiring = creep.ticksToLive != null && creep.ticksToLive < 5;
  if (retiring && mem.sourceId) {
    releaseClaim(mem.sourceId, creep.name);
  } else if (mem.sourceId && mem.remoteRoom) {
    refreshClaimHeartbeat(creep, mem);
  }
  if (resolveCollision(creep, mem)) {
    return;
  }
  if (!mem.sourceId || !mem.remoteRoom) {
    if (!acquireAssignment(creep, mem)) return;
  }
}

var TaskLuna = {
  run: function (creep) {
    if (!creep) return;
    try { require('Traveler'); } catch (travErr) {}
    // Normalize the creep's memory up-front so Task logic and spawn-time wiring share the same schema.
    var mem = creep.memory;
    if (!mem) {
      mem = {};
      creep.memory = mem;
    }
    // Canonical Lunas track state using `state`; default to 'init' until the task advances.
    if (!mem.state) mem.state = 'init';
    // Migrate legacy `targetRoom` assignments into the canonical `remoteRoom` key once.
    if (!mem.remoteRoom && mem.targetRoom) {
      mem.remoteRoom = mem.targetRoom;
      delete mem.targetRoom;
    }
    // If the remote metadata is missing, attempt to self-heal using spawn claims and cached source intel.
    if ((!mem.remoteRoom || !mem.sourceId) && tryRestoreLunaMemory(creep, mem)) {
      // restored from claims or source object
    }
    // Without a remote room or source id we cannot safely continue; surface the problem and bail early.
    if (!mem.remoteRoom || !mem.sourceId) {
      mem.state = 'no-remote';
      creep.say('no-remote');
      return;
    }
    var task = ensureTask(creep);
    if (!task) return;
    task.creepName = creep.name;
    if (!bodyHasCarry(creep) && !task.warnedNoCarry) {
      console.log('⚠️ Luna ' + creep.name + ' lacks CARRY parts; add at least one to avoid idle harvesting.');
      task.warnedNoCarry = true;
    }
    maintainAssignment(creep, task);
    var remoteRoom = task.remoteRoom || (creep.memory ? creep.memory.remoteRoom : null) || null;
    if (!remoteRoom && task.sourceId) {
      var guessSource = Game.getObjectById(task.sourceId);
      if (guessSource && guessSource.pos) remoteRoom = guessSource.pos.roomName;
    }
    if (remoteRoom) {
      task.remoteRoom = remoteRoom;
      if (creep.memory) creep.memory.remoteRoom = remoteRoom;
    }
    if (!remoteRoom) {
      if (creep.memory) creep.memory.state = 'no-remote';
      task.state = 'no-remote';
      creep.say('no-remote');
      return;
    }
    if (creep.pos.roomName !== remoteRoom) {
      if (creep.memory) creep.memory.state = 'travel';
      task.state = 'travel';
      creep.say('travel:' + remoteRoom);
      var travelTarget = new RoomPosition(25, 25, remoteRoom);
      var travelOpts = {
        range: 20,
        preferHighway: true,
        maxOps: 4000,
        stuckValue: 2,
        routeCallback: buildRouteCallback()
      };
      if (typeof creep.travelTo === 'function') {
        creep.travelTo(travelTarget, travelOpts);
      } else {
        queueMove(creep, { x: travelTarget.x, y: travelTarget.y, roomName: remoteRoom }, MOVE_PRIORITY, 20);
      }
      transitionState(creep, mem, 'travel', 'travel');
      break;
    case 'travel':
      runTravel(creep, mem);
      break;
    case 'seat':
      runSeat(creep, mem);
      break;
    case 'harvest':
      runHarvest(creep, mem);
      break;
    default:
      transitionState(creep, mem, 'init', 'init');
      break;
  }
}

module.exports = {
  run: run,
};
