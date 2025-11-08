'use strict';

/**
 * Task.Luna — Remote container miner with self-assignment
 *
 * Implementation goals for the "Autonomous Luna Assignment" brief:
 *   • Every Luna determines its own remote mining assignment exactly once it spawns.
 *   • Assignments are sourced from scout intel (Memory.rooms[roomName].sources[sourceId]).
 *   • Only rooms within REMOTE_RADIUS hops from the creep's home are eligible.
 *   • Claims are tracked globally so that only one Luna mines a source at a time.
 *   • If two Lunas collide on the same source, the lexicographically smaller name wins.
 *   • The travel/seat/harvest loop from the previous implementation is preserved, but
 *     now the routing glue uses Traveler directly so we stay container-seated.
 *   • Everything is ES5 safe: no const/let, no arrow functions.
 */

var BeeSelectors = null;
var BeeActions = null;

try { BeeSelectors = require('BeeSelectors'); } catch (err) {}
try { BeeActions = require('BeeActions'); } catch (err2) {}

// ---------------------------
// Tunables & safety switches
// ---------------------------
var REMOTE_RADIUS = 1;                // remote rooms must be within this linear distance
var MAX_LUNA_PER_SOURCE = 1;          // enforce exactly one miner per source
var CLAIM_TTL = 150;                  // base lifetime for a claim before it must be refreshed
var CLAIM_REFRESH_INTERVAL = 50;      // refresh cadence while actively using the source
var CLAIM_SWEEP_INTERVAL = 50;        // cadence for clearing expired claims
var STUCK_WINDOW = 3;                 // if the creep does not move for this many ticks, reset
var COLLISION_CHECK_INTERVAL = 3;     // spacing for collision checks; low to react quickly

// Cached guard so we only attempt to require Traveler once per tick.
var _travelerGuardTick = null;

function ensureTraveler() {
  if (typeof Creep.prototype.travelTo === 'function') return;
  if (_travelerGuardTick === Game.time) return;
  _travelerGuardTick = Game.time;
  try { require('Traveler'); } catch (e) {}
}

// ---------------------------
// Memory helpers
// ---------------------------
function ensureLunaMemory() {
  if (!Memory.__BHM) Memory.__BHM = {};
  if (!Memory.__BHM.lunaClaims) Memory.__BHM.lunaClaims = {};
  if (!Memory.__BHM.seatReservations) Memory.__BHM.seatReservations = {};
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

function sweepExpiredClaims() {
  if (sweepExpiredClaims._lastSweepTick != null && Game.time - sweepExpiredClaims._lastSweepTick < CLAIM_SWEEP_INTERVAL) {
    return;
  }
  sweepExpiredClaims._lastSweepTick = Game.time;
  ensureLunaMemory();
  var claims = Memory.__BHM.lunaClaims;
  for (var sid in claims) {
    if (!Object.prototype.hasOwnProperty.call(claims, sid)) continue;
    var rec = claims[sid];
    if (!rec) { delete claims[sid]; continue; }
    if (rec.until != null && rec.until < Game.time) { delete claims[sid]; continue; }
    if (!rec.creep) { delete claims[sid]; continue; }
    if (!Game.creeps[rec.creep]) {
      delete claims[sid];
    }
  }
}

function activeClaimantsBySource() {
  ensureLunaMemory();
  var out = {};
  var claims = Memory.__BHM.lunaClaims;
  for (var sid in claims) {
    if (!Object.prototype.hasOwnProperty.call(claims, sid)) continue;
    var rec = claims[sid];
    if (!rec || !rec.creep) continue;
    var creep = Game.creeps[rec.creep];
    if (!creep) continue;
    if (!out[sid]) out[sid] = [];
    if (out[sid].indexOf(creep.name) === -1) out[sid].push(creep.name);
  }
  // Cross-check live creeps so that unclaimed miners are still considered during collision resolution.
  for (var cname in Game.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Game.creeps, cname)) continue;
    var c = Game.creeps[cname];
    if (!c || !c.memory || c.memory.role !== 'Luna') continue;
    if (!c.memory.sourceId) continue;
    var list = out[c.memory.sourceId];
    if (!list) list = out[c.memory.sourceId] = [];
    if (list.indexOf(c.name) === -1) list.push(c.name);
  }
  return out;
}

function pickCandidateSources(homeRoom, radius) {
  var result = { candidates: [], stats: { rooms: 0, sources: 0 } };
  if (!homeRoom) return result;
  if (!Memory.rooms) return result;
  var roomsMem = Memory.rooms;
  for (var roomName in roomsMem) {
    if (!Object.prototype.hasOwnProperty.call(roomsMem, roomName)) continue;
    var roomMem = roomsMem[roomName];
    if (!roomMem || !roomMem.sources) continue;
    if (Game.map && typeof Game.map.getRoomLinearDistance === 'function') {
      var dist = Game.map.getRoomLinearDistance(homeRoom, roomName, true);
      if (typeof dist === 'number' && dist > radius) continue;
    }
    // Skip PVP rooms if intel indicates an enemy owner/reserver.
    var intel = roomMem.intel || {};
    if (intel.owner && intel.owner !== 'Invader' && intel.owner !== null) continue;
    if (intel.reservation && intel.reservation !== 'Invader' && intel.reservation !== null) continue;
    result.stats.rooms++;
    for (var sid in roomMem.sources) {
      if (!Object.prototype.hasOwnProperty.call(roomMem.sources, sid)) continue;
      var sourceIntel = roomMem.sources[sid];
      if (!sourceIntel) continue;
      result.stats.sources++;
      var containerId = null;
      if (sourceIntel.container && sourceIntel.container.containerId) {
        containerId = sourceIntel.container.containerId;
      } else if (sourceIntel.containerId) {
        containerId = sourceIntel.containerId;
      }
      var seatPos = null;
      if (sourceIntel.seat) {
        seatPos = {
          x: sourceIntel.seat.x,
          y: sourceIntel.seat.y,
          roomName: sourceIntel.seat.roomName || roomName
        };
      }
      result.candidates.push({
        sourceId: sid,
        remoteRoom: roomName,
        intel: sourceIntel,
        seat: seatPos,
        containerId: containerId,
        hasContainer: !!containerId
      });
    }
  }
  return result;
}

function pickUnclaimedSource(homeRoom) {
  var bucket = pickCandidateSources(homeRoom, REMOTE_RADIUS);
  var candidates = bucket.candidates;
  var active = activeClaimantsBySource();
  var openCount = 0;
  var bestWithContainer = null;
  var bestAny = null;
  for (var i = 0; i < candidates.length; i++) {
    var entry = candidates[i];
    if (!entry) continue;
    var current = active[entry.sourceId];
    var activeCount = current ? current.length : 0;
    if (activeCount >= MAX_LUNA_PER_SOURCE) continue;
    openCount++;
    if (!bestWithContainer && entry.hasContainer) {
      bestWithContainer = entry;
    }
    if (!bestAny) {
      bestAny = entry;
    }
  }
  var selection = bestWithContainer || bestAny || null;
  return {
    selection: selection,
    stats: {
      rooms: bucket.stats.rooms,
      sources: bucket.stats.sources,
      open: openCount
    }
  };
}

function claim(sourceId, creep, remoteRoom) {
  if (!sourceId || !creep) return;
  ensureLunaMemory();
  Memory.__BHM.lunaClaims[sourceId] = {
    creep: creep.name,
    home: (creep.memory && creep.memory.homeRoom) ? creep.memory.homeRoom : inferHome(creep),
    remote: remoteRoom || (creep.memory ? creep.memory.remoteRoom : null),
    until: Game.time + CLAIM_TTL
  };
}

function release(sourceId, creepName) {
  if (!sourceId) return;
  ensureLunaMemory();
  var claims = Memory.__BHM.lunaClaims;
  var rec = claims[sourceId];
  if (!rec) return;
  if (creepName && rec.creep && rec.creep !== creepName) return;
  delete claims[sourceId];
}

// ---------------------------
// Seat + harvesting helpers
// ---------------------------
function seatKeyFromPos(pos) {
  if (!pos) return null;
  return pos.roomName + ':' + pos.x + ',' + pos.y;
}

function reserveSeat(mem, seatPos) {
  ensureLunaMemory();
  var key = seatKeyFromPos(seatPos);
  if (!key) return true;
  var reservations = Memory.__BHM.seatReservations;
  var existing = reservations[key];
  if (existing && existing === Game.time) return false;
  reservations[key] = Game.time;
  mem.seatKey = key;
  return true;
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
  rec.lastSeen = Game.time;
  if (seatPos) {
    rec.seat = { x: seatPos.x, y: seatPos.y, roomName: seatPos.roomName };
  }
  if (container) {
    rec.container = rec.container || {};
    rec.container.containerId = container.id;
  }
}

function locateContainerAtSeat(creep, mem, seatPos, source) {
  if (!seatPos) return null;
  if (mem.containerId) {
    var cached = Game.getObjectById(mem.containerId);
    if (cached) return cached;
    mem.containerId = null;
  }
  if (!creep.room || creep.room.name !== seatPos.roomName) return null;
  var structures = creep.room.lookForAt(LOOK_STRUCTURES, seatPos.x, seatPos.y) || [];
  for (var i = 0; i < structures.length; i++) {
    if (structures[i].structureType === STRUCTURE_CONTAINER) {
      mem.containerId = structures[i].id;
      return structures[i];
    }
  }
  // Fall back to the source tile if our seat equals the source position.
  if (source && seatPos.x === source.pos.x && seatPos.y === source.pos.y) {
    var stack = creep.room.lookForAt(LOOK_STRUCTURES, source.pos.x, source.pos.y) || [];
    for (var j = 0; j < stack.length; j++) {
      if (stack[j].structureType === STRUCTURE_CONTAINER) {
        mem.containerId = stack[j].id;
        return stack[j];
      }
    }
  }
  return null;
}

function updateSeatIntel(creep, mem, source) {
  if (!mem.remoteRoom || !mem.sourceId) return;
  var seatPos = mem.seatPos ? {
    x: mem.seatPos.x,
    y: mem.seatPos.y,
    roomName: mem.seatPos.roomName
  } : null;
  var containerId = mem.containerId || null;
  if (Memory.rooms && Memory.rooms[mem.remoteRoom]) {
    var rm = Memory.rooms[mem.remoteRoom];
    if (rm.sources && rm.sources[mem.sourceId]) {
      var rec = rm.sources[mem.sourceId];
      if (!seatPos && rec.seat) {
        seatPos = {
          x: rec.seat.x,
          y: rec.seat.y,
          roomName: rec.seat.roomName || mem.remoteRoom
        };
      }
      if (!containerId) {
        if (rec.container && rec.container.containerId) {
          containerId = rec.container.containerId;
        } else if (rec.containerId) {
          containerId = rec.containerId;
        }
      }
    }
  }
  if (source && source.pos && !seatPos) {
    seatPos = { x: source.pos.x, y: source.pos.y, roomName: source.pos.roomName };
  }
  if (containerId) mem.containerId = containerId;
  if (seatPos) mem.seatPos = seatPos;
  if (source && seatPos) rememberSourceMetadata(source, mem.containerId ? Game.getObjectById(mem.containerId) : null, seatPos);
}

function safeHarvest(creep, source) {
  if (BeeActions && BeeActions.safeHarvest) {
    return BeeActions.safeHarvest(creep, source, 100);
  }
  var res = creep.harvest(source);
  if (res === ERR_NOT_IN_RANGE && source && source.pos) {
    moveTo(creep, source.pos, 1);
  }
  return res;
}

function safeTransfer(creep, target) {
  if (BeeActions && BeeActions.safeTransfer) {
    return BeeActions.safeTransfer(creep, target, RESOURCE_ENERGY, null, 96);
  }
  var res = creep.transfer(target, RESOURCE_ENERGY);
  if (res === ERR_NOT_IN_RANGE && target && target.pos) {
    moveTo(creep, target.pos, 1);
  }
  return res;
}

function safeBuild(creep, site) {
  if (BeeActions && BeeActions.safeBuild) {
    return BeeActions.safeBuild(creep, site, 94);
  }
  var res = creep.build(site);
  if (res === ERR_NOT_IN_RANGE && site && site.pos) {
    moveTo(creep, site.pos, 1);
  }
  return res;
}

function buildContainerIfNeeded(creep, seatPos) {
  if (!creep.room || !seatPos || creep.room.name !== seatPos.roomName) return;
  var sites = creep.room.lookForAt(LOOK_CONSTRUCTION_SITES, seatPos.x, seatPos.y) || [];
  if (sites.length) return;
  var structs = creep.room.lookForAt(LOOK_STRUCTURES, seatPos.x, seatPos.y) || [];
  for (var i = 0; i < structs.length; i++) {
    if (structs[i].structureType === STRUCTURE_CONTAINER) return;
  }
  creep.room.createConstructionSite(seatPos.x, seatPos.y, STRUCTURE_CONTAINER);
}

function moveTo(creep, pos, range) {
  if (!pos) return;
  var target = pos.pos ? pos.pos : pos;
  var desiredRange = (range != null) ? range : 1;
  if (typeof creep.travelTo === 'function') {
    creep.travelTo(new RoomPosition(target.x, target.y, target.roomName), {
      range: desiredRange,
      preferHighway: true,
      maxOps: 4000,
      stuckValue: 2
    });
  } else {
    creep.moveTo(target.x, target.y, { range: desiredRange, reusePath: 10 });
  }
}

function detectThreat(source) {
  if (!source || !source.pos || !source.room) return false;
  var hostiles = source.pos.findInRange(FIND_HOSTILE_CREEPS, 5) || [];
  if (hostiles.length) return true;
  var cores = source.pos.findInRange(FIND_HOSTILE_STRUCTURES, 5, {
    filter: function (s) { return s.structureType === STRUCTURE_INVADER_CORE; }
  }) || [];
  return cores.length > 0;
}

function trackMovement(creep, mem) {
  if (!mem) return true;
  var last = mem._lastPos;
  if (!last || last.x !== creep.pos.x || last.y !== creep.pos.y || last.roomName !== creep.pos.roomName) {
    mem._lastPos = { x: creep.pos.x, y: creep.pos.y, roomName: creep.pos.roomName, tick: Game.time };
    mem.stuckSince = null;
    return true;
  }
  if (!mem.stuckSince) {
    mem.stuckSince = Game.time;
    return true;
  }
  if (Game.time - mem.stuckSince >= STUCK_WINDOW) {
    release(mem.sourceId, creep.name);
    mem.remoteRoom = null;
    mem.sourceId = null;
    mem.seatPos = null;
    mem.containerId = null;
    mem.state = 'init';
    creep.say('reset');
    return false;
  }
  return true;
}

function setState(creep, mem, newState, sayText) {
  if (!mem.state) mem.state = 'init';
  if (mem.state === newState) return;
  mem.state = newState;
  if (sayText) creep.say(sayText);
}

function handleHarvestLoop(creep, mem, source) {
  if (!source) return;
  var seatPos = null;
  if (mem.seatPos) {
    seatPos = new RoomPosition(mem.seatPos.x, mem.seatPos.y, mem.seatPos.roomName || source.pos.roomName);
  }
  if (!seatPos) seatPos = new RoomPosition(source.pos.x, source.pos.y, source.pos.roomName);
  if (!creep.pos.isEqualTo(seatPos)) {
    setState(creep, mem, 'seat', 'seat');
    if (reserveSeat(mem, seatPos)) moveTo(creep, seatPos, 0);
    return;
  }
  var container = locateContainerAtSeat(creep, mem, seatPos, source);
  var site = null;
  if (!container && creep.room) {
    var sites = creep.room.lookForAt(LOOK_CONSTRUCTION_SITES, seatPos.x, seatPos.y) || [];
    if (sites.length) site = sites[0];
  }
  if (!container && !site) {
    buildContainerIfNeeded(creep, seatPos);
  }
  if (container) {
    setState(creep, mem, 'harvest', 'harvest');
    safeHarvest(creep, source);
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
      safeTransfer(creep, container);
    }
  } else if (site) {
    setState(creep, mem, 'harvest', 'harvest');
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
      safeBuild(creep, site);
    } else {
      safeHarvest(creep, source);
    }
  } else {
    setState(creep, mem, 'harvest', 'harvest');
    var harvestRes = safeHarvest(creep, source);
    if (harvestRes === OK && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
      creep.drop(RESOURCE_ENERGY);
    }
  }
  mem.stuckSince = null;
}

function travelToRemote(creep, mem) {
  if (!mem.remoteRoom) return;
  setState(creep, mem, 'travel', 'travel');
  moveTo(creep, new RoomPosition(25, 25, mem.remoteRoom), 20);
}

function handleCollisions(creep, mem) {
  if (!mem.sourceId) return true;
  if (mem._lastCollisionCheck && Game.time - mem._lastCollisionCheck < COLLISION_CHECK_INTERVAL) return true;
  mem._lastCollisionCheck = Game.time;
  var map = activeClaimantsBySource();
  var names = map[mem.sourceId] || [];
  if (names.indexOf(creep.name) === -1) names.push(creep.name);
  if (names.length <= MAX_LUNA_PER_SOURCE) return true;
  names.sort();
  var winner = names[0];
  if (creep.name !== winner) {
    release(mem.sourceId, creep.name);
    mem.remoteRoom = null;
    mem.sourceId = null;
    mem.seatPos = null;
    mem.containerId = null;
    mem.state = 'init';
    creep.say('yield');
    return false;
  }
  claim(mem.sourceId, creep, mem.remoteRoom);
  return true;
}

function refreshClaim(creep, mem) {
  if (!mem.sourceId) return;
  if (mem.lastClaimRefresh && Game.time - mem.lastClaimRefresh < CLAIM_REFRESH_INTERVAL) return;
  claim(mem.sourceId, creep, mem.remoteRoom);
  mem.lastClaimRefresh = Game.time;
}

function attemptAssignment(creep, mem) {
  var home = mem.homeRoom || inferHome(creep) || (creep.room ? creep.room.name : null);
  if (!home) return false;
  mem.homeRoom = home;
  sweepExpiredClaims();
  var pick = pickUnclaimedSource(home);
  if (!pick || !pick.selection) {
    if (!mem._lastNoSourceLog || Game.time - mem._lastNoSourceLog >= 10) {
      if (typeof console !== 'undefined' && console.log) {
        console.log('Luna ' + creep.name + ' no-src home=' + home + ' radius=' + REMOTE_RADIUS + ' rooms=' + (pick && pick.stats ? pick.stats.rooms : 0) + ' sources=' + (pick && pick.stats ? pick.stats.sources : 0) + ' open=' + (pick && pick.stats ? pick.stats.open : 0));
      }
      mem._lastNoSourceLog = Game.time;
    }
    creep.say('no-src');
    return false;
  }
  var selection = pick.selection;
  mem.remoteRoom = selection.remoteRoom;
  mem.sourceId = selection.sourceId;
  mem.seatPos = selection.seat ? {
    x: selection.seat.x,
    y: selection.seat.y,
    roomName: selection.seat.roomName || selection.remoteRoom
  } : null;
  mem.containerId = selection.containerId || null;
  mem.lastClaimRefresh = Game.time;
  mem.lastAssigned = Game.time;
  claim(selection.sourceId, creep, selection.remoteRoom);
  if (typeof console !== 'undefined' && console.log) {
    console.log('Luna ' + creep.name + ' assigned source ' + selection.sourceId + ' in ' + selection.remoteRoom + ' (home ' + home + ')');
  }
  setState(creep, mem, 'travel', 'travel');
  return true;
}

// ---------------------------
// Main task runner
// ---------------------------
var TaskLuna = {
  run: function (creep) {
    if (!creep) return;
    ensureTraveler();
    var mem = creep.memory || (creep.memory = {});
    if (!mem.role) mem.role = 'Luna';
    if (!mem.state) {
      mem.state = 'init';
      creep.say('init');
    }
    if (!trackMovement(creep, mem)) return;
    ensureLunaMemory();
    sweepExpiredClaims();
    if (!mem.homeRoom) mem.homeRoom = inferHome(creep) || (creep.room ? creep.room.name : null);
    if (!mem.remoteRoom || !mem.sourceId || mem.state === 'init') {
      if (!attemptAssignment(creep, mem)) {
        return;
      }
    }
    if (!mem.remoteRoom || !mem.sourceId) {
      mem.state = 'init';
      creep.say('no-src');
      return;
    }
    if (!handleCollisions(creep, mem)) {
      return;
    }
    refreshClaim(creep, mem);
    if (creep.room && creep.room.name !== mem.remoteRoom) {
      travelToRemote(creep, mem);
      return;
    }
    var source = Game.getObjectById(mem.sourceId);
    if (!source) {
      release(mem.sourceId, creep.name);
      mem.remoteRoom = null;
      mem.sourceId = null;
      mem.state = 'init';
      creep.say('reset');
      return;
    }
    if (detectThreat(source)) {
      release(mem.sourceId, creep.name);
      mem.remoteRoom = null;
      mem.sourceId = null;
      mem.state = 'init';
      creep.say('threat');
      return;
    }
    updateSeatIntel(creep, mem, source);
    handleHarvestLoop(creep, mem, source);
  }
};

module.exports = TaskLuna;
