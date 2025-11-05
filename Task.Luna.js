'use strict';

/**
 * Task.Luna.js — Remote Container Miner (ES5 only)
 *
 * Key behaviors
 *  - Unique source assignment (no two Lunas on the same source) via Memory.__BHM.lunaClaims (TTL) + sanity checks.
 *  - Travels to the remote source, sits on the container tile; builds container if missing.
 *  - HARVEST every tick; TRANSFER into the container; never delivers home unless "emergency evac" triggers.
 *  - Writes per-room container state under Memory.rooms[roomName].sources[sourceId].container:
 *      { status, healthPct, capacityPct, requestPickup, pickUpStatus, lastTick }
 *  - Emits TTL=1 haulRequests in Memory.__BHM.haulRequests when container >= 60% and >= 80% (de-duped per tick).
 *  - Movement is queued via Movement.Manager (or Traveler fallback) — MOVE executes in the MOVE phase.
 *
 * ES5 constraints: no const/let, arrow functions, template strings, or optional chaining.
 */

// ----------------------------- Dependencies -----------------------------
var BeeSelectors = null;
var BeeActions   = null;
var Movement     = null;

try { BeeSelectors = require('BeeSelectors'); } catch (e) { BeeSelectors = null; }
try { BeeActions   = require('BeeActions');   } catch (e) { BeeActions   = null; }
try { Movement     = require('Movement.Manager'); } catch (e) { Movement = null; }

// ----------------------------- Tunables ---------------------------------
var CFG = Object.freeze({
  DEBUG_SAY: false,
  DEBUG_DRAW: true,

  // Assignment & safety
  CLAIM_TTL: 150,                 // ticks a source claim is considered fresh
  AVOID_TTL: 30,                  // avoid a hostile/core room for this many ticks
  RETARGET_COOLDOWN: 15,          // wait before reassign attempts after failure

  // Mining
  MIN_CARRY_REQUIRED: 1,          // ensure 1 CARRY to transfer every tick
  GIVE_UP_STUCK_TICKS: 6,         // abandon seat attempt if stuck too long

  // Hauling thresholds & emergency evac
  PICKUP_WARN_PCT: 0.60,          // mark requestPickup=true at 60%
  PICKUP_URGENT_PCT: 0.80,        // reinforce request at 80%
  EMERGENCY_EVAC_ENABLED: false,  // optionally let miner carry a load home if container stays near-full
  EMERGENCY_EVAC_PCT: 0.95,       // trigger evac if >= 95% and no 'Enroute' for a bit
  EMERGENCY_EVAC_GRACE: 50,       // ticks to wait after first urgent warn before evacing

  // Movement priorities
  PRIORS: {
    SEAT:     95,
    HARVEST:  90,
    TRANSFER: 85,
    BUILD:    80,
    TRAVEL:   70
  }
});

// -------------------------- Memory Utilities ----------------------------
function _ensureGlobal() {
  if (!Memory.__BHM) Memory.__BHM = {};
  if (!Memory.__BHM.seatReservations) Memory.__BHM.seatReservations = {};
  if (!Memory.__BHM.avoidRooms) Memory.__BHM.avoidRooms = {};
  if (!Memory.__BHM.haulRequests) Memory.__BHM.haulRequests = {};
  if (!Memory.__BHM.lunaClaims) Memory.__BHM.lunaClaims = {};
  if (!Memory.__BHM.remotesByHome) Memory.__BHM.remotesByHome = {};
}

function _ensureRoomSourceMem(roomName, sourceId) {
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
  if (!Memory.rooms[roomName].sources) Memory.rooms[roomName].sources = {};
  if (!Memory.rooms[roomName].sources[sourceId]) Memory.rooms[roomName].sources[sourceId] = {};
  var entry = Memory.rooms[roomName].sources[sourceId];
  if (!entry.container) entry.container = {};
  if (!entry.container.pickUpStatus) entry.container.pickUpStatus = "None";
  if (typeof entry.container.requestPickup !== 'boolean') entry.container.requestPickup = false;
  return entry;
}

function _seatKey(pos) { return pos.roomName + ':' + pos.x + ':' + pos.y; }
function _reserveSeat(pos) {
  _ensureGlobal();
  Memory.__BHM.seatReservations[_seatKey(pos)] = Game.time; // TTL = 1
}
function _seatReserved(pos) {
  _ensureGlobal();
  return Memory.__BHM.seatReservations[_seatKey(pos)] === Game.time;
}

function _avoidUntil(roomName, untilTick) {
  _ensureGlobal();
  Memory.__BHM.avoidRooms[roomName] = untilTick;
}
function _isAvoided(roomName) {
  _ensureGlobal();
  var t = Memory.__BHM.avoidRooms[roomName];
  return t && t > Game.time;
}

function _claimSource(sourceId, creepName) {
  _ensureGlobal();
  Memory.__BHM.lunaClaims[sourceId] = { by: creepName, tick: Game.time };
}
function _claimIsFresh(sourceId) {
  _ensureGlobal();
  var c = Memory.__BHM.lunaClaims[sourceId];
  return c && (Game.time - c.tick) <= CFG.CLAIM_TTL && Game.creeps[c.by];
}
function _claimantName(sourceId) {
  _ensureGlobal();
  var c = Memory.__BHM.lunaClaims[sourceId];
  if (c && (Game.time - c.tick) <= CFG.CLAIM_TTL) return c.by || null;
  return null;
}

function _publishHaulRequest(fromRoom, toRoom, containerId, amountHint) {
  _ensureGlobal();
  if (!fromRoom || !containerId) return;
  var key = fromRoom + ':' + containerId;
  Memory.__BHM.haulRequests[key] = {
    key: key,
    fromRoom: fromRoom,
    toRoom: toRoom || null,
    targetId: containerId,
    resource: RESOURCE_ENERGY,
    amountHint: amountHint || 0,
    issuedAt: Game.time
  };
}

function _inferHomeRoom(creep) {
  if (creep.memory.homeRoom) return creep.memory.homeRoom;
  if (creep.room && creep.room.controller && creep.room.controller.my) return creep.room.name;
  var names = Object.keys(Game.spawns || {});
  if (names.length) return Game.spawns[names[0]].room.name;
  return creep.room ? creep.room.name : null;
}

// -------------------------- Remote Discovery ----------------------------
function _chooseRemoteRoom(homeRoom) {
  _ensureGlobal();
  var remotes = Memory.__BHM.remotesByHome[homeRoom];
  if (remotes && remotes.length) {
    var i;
    for (i = 0; i < remotes.length; i++) {
      if (!_isAvoided(remotes[i])) return remotes[i];
    }
    return remotes[0];
  }
  // Legacy flags fallback: "SRC*" indicates remote source hints
  var flags = Game.flags || {};
  var f;
  for (f in flags) {
    if (f.indexOf('SRC') === 0) {
      var rn = flags[f].pos.roomName;
      if (!_isAvoided(rn)) return rn;
    }
  }
  return null;
}

function _hostilesOrCoreNearSource(room, src) {
  if (!room || !src) return false;
  var nearHostiles = src.pos.findInRange(FIND_HOSTILE_CREEPS, 5);
  if (nearHostiles && nearHostiles.length) return true;
  var cores = room.find(FIND_STRUCTURES, {
    filter: function(s) { return s.structureType === STRUCTURE_INVADER_CORE; }
  });
  if (cores && cores.length) return true;
  // If room is owned by a player, do not mine (no PvP)
  if (room.controller && room.controller.owner && !room.controller.my) return true;
  return false;
}

// Find container or csite adjacent to a source
function _findContainerOrSiteNearSource(room, source) {
  if (!room || !source) return { container: null, csite: null };
  var container = source.pos.findInRange(FIND_STRUCTURES, 1, {
    filter: function(s){ return s.structureType === STRUCTURE_CONTAINER; }
  })[0];

  var csite = source.pos.findInRange(FIND_CONSTRUCTION_SITES, 1, {
    filter: function(s){ return s.structureType === STRUCTURE_CONTAINER; }
  })[0];

  return { container: container || null, csite: csite || null };
}

// Prefer plains tile around source for the seat
function _pickSeatPosNearSource(source) {
  var roomName = source.pos.roomName;
  var terrain = Game.map.getRoomTerrain(roomName);
  var best = null;
  var bestScore = -9999;
  var dx, dy;
  for (dx = -1; dx <= 1; dx++) {
    for (dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      var x = source.pos.x + dx;
      var y = source.pos.y + dy;
      if (x < 1 || x > 48 || y < 1 || y > 48) continue;
      var t = terrain.get(x, y);
      if (t & TERRAIN_MASK_WALL) continue;
      var swamp = (t & TERRAIN_MASK_SWAMP) ? 1 : 0;
      var score = 10 - (swamp ? 5 : 0) - (Math.abs(25 - x) + Math.abs(25 - y)) * 0.01;
      if (score > bestScore) { bestScore = score; best = new RoomPosition(x, y, roomName); }
    }
  }
  return best;
}

// Choose an unclaimed source (or reclaim stale), honoring unique per-source miners
function _chooseSourceUnique(room, creepName) {
  var sources = room.find(FIND_SOURCES);
  if (!sources || !sources.length) return null;

  // 1) Build list with claim freshness
  var i;
  var candidates = [];
  for (i = 0; i < sources.length; i++) {
    var s = sources[i];
    var fresh = _claimIsFresh(s.id);
    var claimant = _claimantName(s.id);
    candidates.push({ src: s, fresh: fresh, claimant: claimant });
  }

  // 2) Prefer unclaimed; else claimed-by-me; else stale claim
  for (i = 0; i < candidates.length; i++) {
    if (!candidates[i].fresh) return candidates[i].src;
  }
  for (i = 0; i < candidates.length; i++) {
    if (candidates[i].claimant === creepName) return candidates[i].src;
  }

  // 3) Otherwise choose the source with the oldest claim tick (closest to expiring)
  var best = null;
  var bestTick = 9999999;
  for (i = 0; i < sources.length; i++) {
    var c = Memory.__BHM.lunaClaims[sources[i].id];
    var t = c ? c.tick : -9999999;
    if (t < bestTick) { bestTick = t; best = sources[i]; }
  }
  return best || sources[0];
}

// ------------------------------ Core Logic ------------------------------
var TaskLuna = {

  run: function(creep) {
    if (!creep) return;

    // Ensure task envelope
    if (!creep.memory._task || creep.memory._task.type !== 'luna') {
      creep.memory._task = {
        type: 'luna',
        homeRoom: _inferHomeRoom(creep),
        remoteRoom: null,
        sourceId: null,
        containerId: null,
        seatPos: null,     // {x,y,roomName}
        since: Game.time,
        stuckSince: null,
        assignCooldown: 0,
        urgentSince: null   // when we first crossed URGENT_PCT
      };
    }

    var task = creep.memory._task;
    var homeRoom = task.homeRoom || _inferHomeRoom(creep);

    // Safety: ensure at least one CARRY
    if (!creep.memory.__warnedNoCarry) {
      var carryParts = 0, i;
      for (i = 0; i < creep.body.length; i++) if (creep.body[i].type === CARRY) carryParts++;
      if (carryParts < CFG.MIN_CARRY_REQUIRED) {
        console.log('[Luna] ' + creep.name + ' has no CARRY; add at least 1 to transfer each tick.');
        creep.memory.__warnedNoCarry = true;
      }
    }

    // Drop assignment if remote now avoided
    if (task.remoteRoom && _isAvoided(task.remoteRoom)) {
      task.remoteRoom = null;
      task.sourceId = null;
      task.containerId = null;
      task.seatPos = null;
      task.urgentSince = null;
    }

    // Assign remote room if missing
    if (!task.remoteRoom && task.assignCooldown <= Game.time) {
      task.remoteRoom = _chooseRemoteRoom(homeRoom);
      if (!task.remoteRoom) {
        if (CFG.DEBUG_SAY) creep.say('no remote');
        return;
      }
    }

    // Travel to remote to gain vision if needed
    if (task.remoteRoom && creep.pos.roomName !== task.remoteRoom && !task.sourceId) {
      _queueMove(creep, new RoomPosition(25, 25, task.remoteRoom), CFG.PRIORS.TRAVEL);
      if (CFG.DEBUG_SAY) creep.say('🧭');
      return;
    }

    // Source selection / reselection
    var source = task.sourceId ? Game.getObjectById(task.sourceId) : null;
    if (!source && creep.room && creep.room.name === task.remoteRoom) {
      // Choose unique source here
      var picked = _chooseSourceUnique(creep.room, creep.name);
      if (!picked) {
        task.assignCooldown = Game.time + CFG.RETARGET_COOLDOWN;
        return;
      }
      if (_hostilesOrCoreNearSource(creep.room, picked)) {
        _avoidUntil(creep.room.name, Game.time + CFG.AVOID_TTL);
        task.remoteRoom = null;
        task.assignCooldown = Game.time + CFG.RETARGET_COOLDOWN;
        return;
      }
      task.sourceId = picked.id;
      _claimSource(task.sourceId, creep.name);
      // Discover seat/container
      var seatInfo = _findContainerOrSiteNearSource(creep.room, picked);
      if (seatInfo.container) {
        task.containerId = seatInfo.container.id;
        task.seatPos = {
          x: seatInfo.container.pos.x, y: seatInfo.container.pos.y, roomName: seatInfo.container.pos.roomName
        };
      } else if (seatInfo.csite) {
        task.seatPos = { x: seatInfo.csite.pos.x, y: seatInfo.csite.pos.y, roomName: seatInfo.csite.pos.roomName };
      } else {
        var seat = _pickSeatPosNearSource(picked);
        if (seat) {
          task.seatPos = { x: seat.x, y: seat.y, roomName: seat.roomName };
          var sitesCount = Object.keys(Game.constructionSites || {}).length;
          if (sitesCount < 90) seat.createConstructionSite(STRUCTURE_CONTAINER);
        }
      }
    }

    // Refresh handles
    source = task.sourceId ? Game.getObjectById(task.sourceId) : null;
    var container = task.containerId ? Game.getObjectById(task.containerId) : null;

    // If we are in the source room but container id not set, re-scan
    if (!container && source && creep.room && creep.room.name === source.pos.roomName) {
      var ci = _findContainerOrSiteNearSource(creep.room, source);
      if (ci.container) { container = ci.container; task.containerId = container.id; }
    }

    // Seat memory entry
    if (source) _updateContainerMemory(source, container, homeRoom);

    // Head to seat if known (even before source vision, we may have seatPos)
    if (task.seatPos && (creep.pos.x !== task.seatPos.x || creep.pos.y !== task.seatPos.y || creep.pos.roomName !== task.seatPos.roomName)) {
      if (task.stuckSince == null) task.stuckSince = Game.time;
      else if (Game.time - task.stuckSince > CFG.GIVE_UP_STUCK_TICKS) task.stuckSince = null;
      _reserveSeat(task.seatPos);
      _queueMove(creep, new RoomPosition(task.seatPos.x, task.seatPos.y, task.seatPos.roomName), CFG.PRIORS.SEAT);
      if (CFG.DEBUG_SAY) creep.say('⛳');
      return;
    } else {
      task.stuckSince = null;
    }

    // On seat: build container if needed, else harvest & transfer
    if (task.seatPos && creep.pos.x === task.seatPos.x && creep.pos.y === task.seatPos.y && creep.pos.roomName === task.seatPos.roomName) {
      if (!container) {
        var cs = creep.pos.lookFor(LOOK_CONSTRUCTION_SITES)[0];
        if (cs && cs.structureType === STRUCTURE_CONTAINER) {
          if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) _safeBuild(creep, cs, CFG.PRIORS.BUILD);
          else if (source) _safeHarvest(creep, source, CFG.PRIORS.HARVEST);
          return;
        } else {
          var sitesCount2 = Object.keys(Game.constructionSites || {}).length;
          if (sitesCount2 < 90) creep.pos.createConstructionSite(STRUCTURE_CONTAINER);
          if (source) _safeHarvest(creep, source, CFG.PRIORS.HARVEST);
          return;
        }
      }

      // Container exists: main loop
      if (container && source) {
        // First, dump any carried energy
        if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
          _safeTransfer(creep, container, RESOURCE_ENERGY, null, CFG.PRIORS.TRANSFER);
        }

        // Then harvest (each tick)
        _safeHarvest(creep, source, CFG.PRIORS.HARVEST);

        // Evaluate container state & publish haul requests if needed
        _maybeSignalPickup(source, container, homeRoom, task);

        // Optional emergency evac if container stays full too long (off by default)
        if (CFG.EMERGENCY_EVAC_ENABLED) _maybeEmergencyEvac(creep, container, homeRoom, task);
      }
      return;
    }

    // If we lost vision or lack seat, go toward remote center
    if (task.remoteRoom && creep.pos.roomName !== task.remoteRoom) {
      _queueMove(creep, new RoomPosition(25, 25, task.remoteRoom), CFG.PRIORS.TRAVEL);
    }
  }
};

// ------------------------ Container State & Signals ----------------------
function _updateContainerMemory(source, container, homeRoom) {
  var entry = _ensureRoomSourceMem(source.pos.roomName, source.id).container;
  entry.lastTick = Game.time;

  if (!container) {
    entry.status = "Building";
    entry.healthPct = 0;
    entry.capacityPct = 0;
    return;
  }

  var hits = container.hits || 0;
  var hitsMax = container.hitsMax || 1;
  entry.healthPct = Math.min(1, hits / hitsMax);

  var store = container.store || {};
  var used = (store[RESOURCE_ENERGY] || 0);
  var cap  = container.store.getCapacity ? container.store.getCapacity(RESOURCE_ENERGY) : 2000; // default container cap
  var pct = cap > 0 ? (used / cap) : 0;
  entry.capacityPct = pct;

  if (entry.healthPct < 0.80) entry.status = "NeedsRepair";
  else entry.status = "Good";

  // Keep request flags conservative here; _maybeSignalPickup toggles them precisely
  if (pct < CFG.PICKUP_WARN_PCT) {
    entry.requestPickup = false;
    if (entry.pickUpStatus !== "Enroute") entry.pickUpStatus = "None";
  }
}

function _maybeSignalPickup(source, container, homeRoom, task) {
  var entry = _ensureRoomSourceMem(source.pos.roomName, source.id).container;
  var pct = entry.capacityPct || 0;
  var store = container.store || {};
  var have = (store[RESOURCE_ENERGY] || 0);

  // 60%: set requestPickup=true, status=Queued
  if (pct >= CFG.PICKUP_WARN_PCT) {
    entry.requestPickup = true;
    if (entry.pickUpStatus !== "Enroute") entry.pickUpStatus = "Queued";
    _publishHaulRequest(container.pos.roomName, homeRoom, container.id, have);
  }

  // 80%: reinforce the request (idempotent per tick)
  if (pct >= CFG.PICKUP_URGENT_PCT) {
    _publishHaulRequest(container.pos.roomName, homeRoom, container.id, have);
    if (task.urgentSince == null) task.urgentSince = Game.time;
  } else {
    task.urgentSince = null;
  }
}

function _maybeEmergencyEvac(creep, container, homeRoom, task) {
  var cap = container.store.getCapacity ? container.store.getCapacity(RESOURCE_ENERGY) : 2000;
  var used = (container.store[RESOURCE_ENERGY] || 0);
  var pct  = cap > 0 ? (used / cap) : 0;

  if (pct >= CFG.EMERGENCY_EVAC_PCT && task.urgentSince != null && (Game.time - task.urgentSince) > CFG.EMERGENCY_EVAC_GRACE) {
    // Take a full load home (one trip), then return
    if (creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
      // withdraw from container (rare for miners, but allowed in evac)
      if (BeeActions && BeeActions.safeWithdraw) BeeActions.safeWithdraw(creep, container, RESOURCE_ENERGY, null, CFG.PRIORS.TRANSFER);
      else {
        var r = creep.withdraw(container, RESOURCE_ENERGY);
        if (r === ERR_NOT_IN_RANGE) _queueMove(creep, container.pos, CFG.PRIORS.TRANSFER);
      }
      return;
    }
    // deliver to home storage (Traveler will handle cross-room)
    var home = Game.rooms[homeRoom];
    if (home && home.storage) {
      if (BeeActions && BeeActions.safeTransfer) BeeActions.safeTransfer(creep, home.storage, RESOURCE_ENERGY, null, CFG.PRIORS.TRAVEL);
      else {
        var r2 = creep.transfer(home.storage, RESOURCE_ENERGY);
        if (r2 === ERR_NOT_IN_RANGE) _queueMove(creep, home.storage.pos, CFG.PRIORS.TRAVEL);
      }
    } else {
      // fallback: head to home center
      var pos = new RoomPosition(25, 25, homeRoom);
      _queueMove(creep, pos, CFG.PRIORS.TRAVEL);
    }
  }
}

// ---------------------------- Action Shims ------------------------------
function _queueMove(creep, pos, priority) {
  if (Movement && Movement.request) {
    Movement.request(creep, { x: pos.x, y: pos.y, roomName: pos.roomName }, priority || CFG.PRIORS.TRAVEL);
  } else if (creep.travelTo) {
    creep.travelTo(pos);
  } else {
    creep.moveTo(pos);
  }
}

function _safeHarvest(creep, source, priority) {
  if (BeeActions && BeeActions.safeHarvest) return BeeActions.safeHarvest(creep, source, priority || CFG.PRIORS.HARVEST);
  var r = creep.harvest(source);
  if (r === ERR_NOT_IN_RANGE) _queueMove(creep, source.pos, priority || CFG.PRIORS.HARVEST);
  return r;
}

function _safeTransfer(creep, target, res, amount, priority) {
  if (BeeActions && BeeActions.safeTransfer) return BeeActions.safeTransfer(creep, target, res || RESOURCE_ENERGY, amount, priority || CFG.PRIORS.TRANSFER);
  var r = creep.transfer(target, res || RESOURCE_ENERGY, amount);
  if (r === ERR_NOT_IN_RANGE) _queueMove(creep, target.pos, priority || CFG.PRIORS.TRANSFER);
  return r;
}

function _safeBuild(creep, site, priority) {
  if (BeeActions && BeeActions.safeBuild) return BeeActions.safeBuild(creep, site, priority || CFG.PRIORS.BUILD);
  var r = creep.build(site);
  if (r === ERR_NOT_IN_RANGE) _queueMove(creep, site.pos, priority || CFG.PRIORS.BUILD);
  return r;
}

module.exports = TaskLuna;
