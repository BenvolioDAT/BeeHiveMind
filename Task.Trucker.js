'use strict';

/**
 * Task.Trucker.js — Remote Energy Hauler (ES5 only)
 *
 * What this role does:
 *  - Pulls energy from remote source-containers (made by Luna miners)
 *  - Delivers to the home room (storage preferred, terminal fallback)
 *  - Consumes TTL=1 haul jobs published at Memory.__BHM.haulRequests
 *  - If no jobs exist, can self-discover juicy remote containers (visible rooms only)
 *  - Uses persistent _task envelope to avoid retarget thrash
 *  - Queues movement via Movement.Manager (or Traveler) — never moves inline during ACT
 *
 * ES5 constraints: no const/let, arrows, template strings, or optional chaining.
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

  // Discovery & thresholds
  MIN_WITHDRAW_THRESHOLD: 400,    // ignore tiny scraps
  SELF_DISCOVER_THRESHOLD: 800,   // when self-scanning, only consider containers ≥ this amount
  GIVE_UP_EMPTY_TICKS: 4,         // abandon pickup if it's empty for this many consecutive ticks

  // Delivery policy
  DELIVER_TO_TERMINAL_IF_STORAGE_FULL: true,
  STORAGE_NEAR_FULL_PCT: 0.92,

  // Movement priorities (higher wins)
  PRIORS: {
    PICKUP: 90,
    DELIVER: 85,
    TRAVEL: 70
  }
});

// ----------------------------- Memory Utils -----------------------------
function _ensureGlobal() {
  if (!Memory.__BHM) Memory.__BHM = {};
  if (!Memory.__BHM.haulRequests) Memory.__BHM.haulRequests = {};
  if (!Memory.__BHM.remotesByHome) Memory.__BHM.remotesByHome = {};
}

function _inferHomeRoom(creep) {
  if (creep.memory.homeRoom) return creep.memory.homeRoom;
  if (creep.room && creep.room.controller && creep.room.controller.my) return creep.room.name;
  var names = Object.keys(Game.spawns || {});
  if (names.length) return Game.spawns[names[0]].room.name;
  return creep.room ? creep.room.name : null;
}

// Set pickUpStatus for a container via room memory (if we can map container->source)
function _setContainerPickupStatus(fromRoom, containerId, status) {
  if (!Memory.rooms || !Memory.rooms[fromRoom] || !Memory.rooms[fromRoom].sources) return;
  var sources = Memory.rooms[fromRoom].sources;
  var sid;
  for (sid in sources) {
    var c = sources[sid] && sources[sid].container;
    // We only reliably know capacity/health; try to store containerId when known
    if (c && c.containerId === containerId) {
      c.pickUpStatus = status;
      return;
    }
  }
  // Fallback: best-effort search if containerId not stored; do nothing if unknown
}

// Helper: update the containerId field in room memory if we know the source
function _recordContainerId(fromRoom, containerObj) {
  if (!containerObj) return;
  if (!Memory.rooms || !Memory.rooms[fromRoom] || !Memory.rooms[fromRoom].sources) return;
  var sources = Memory.rooms[fromRoom].sources;
  var sid;
  for (sid in sources) {
    var c = sources[sid] && sources[sid].container;
    if (c && containerObj.pos && containerObj.pos.roomName === fromRoom) {
      // If the sourceId in memory matches the actual geometry (range 1), bind id once
      var srcObj = Game.getObjectById(sid);
      if (srcObj && srcObj.pos && srcObj.pos.inRangeTo(containerObj.pos, 1)) {
        c.containerId = containerObj.id;
      }
    }
  }
}

// ----------------------------- Haul Bus ---------------------------------
// Choose a haul request for this creep (prefers same home toRoom or sets it)
function _pickHaulRequest(creep, homeRoom) {
  _ensureGlobal();
  var reqs = Memory.__BHM.haulRequests;
  var bestKey = null;
  var bestScore = -999999;

  var k;
  for (k in reqs) {
    var r = reqs[k];
    // TTL = 1 tick by design; accept current tick only
    if (!r || r.issuedAt !== Game.time) continue;

    // Avoid double-claim by reading/setting claimedBy
    if (r.claimedBy && r.claimedBy !== creep.name) continue;

    // Set default toRoom if not provided
    if (!r.toRoom) r.toRoom = homeRoom;

    // Score: larger amountHint first; if same, prefer closer (cheap heuristic)
    var score = (r.amountHint || 0);
    if (creep.pos.roomName === r.fromRoom) score += 50; // vision bonus
    if (r.toRoom === homeRoom) score += 20;

    if (score > bestScore) {
      bestScore = score;
      bestKey = k;
    }
  }

  if (!bestKey) return null;
  // Claim it
  reqs[bestKey].claimedBy = creep.name;
  return reqs[bestKey];
}

// If no bus jobs, try self-discover visible remote containers with energy
function _selfDiscoverPickup(homeRoom) {
  _ensureGlobal();
  var remotes = Memory.__BHM.remotesByHome[homeRoom] || [];
  var i, room, containers, j, c, srcAdj;

  for (i = 0; i < remotes.length; i++) {
    room = Game.rooms[ remotes[i] ];
    if (!room) continue; // no vision
    containers = room.find(FIND_STRUCTURES, {
      filter: function(s) {
        if (s.structureType !== STRUCTURE_CONTAINER) return false;
        if (!s.store || (s.store[RESOURCE_ENERGY] || 0) < CFG.SELF_DISCOVER_THRESHOLD) return false;
        // Must be adjacent to a source (source-container)
        var ns = s.pos.findInRange(FIND_SOURCES, 1);
        return ns && ns.length > 0;
      }
    });
    if (containers && containers.length) {
      // Pick the fullest
      containers.sort(function(a, b) {
        var ae = (a.store && a.store[RESOURCE_ENERGY]) || 0;
        var be = (b.store && b.store[RESOURCE_ENERGY]) || 0;
        return be - ae;
      });
      c = containers[0];
      return {
        key: room.name + ':' + c.id,
        fromRoom: room.name,
        toRoom: homeRoom,
        targetId: c.id,
        resource: RESOURCE_ENERGY,
        amountHint: (c.store && c.store[RESOURCE_ENERGY]) || 0,
        issuedAt: Game.time,   // mimic a bus request for current tick
        claimedBy: null
      };
    }
  }
  return null;
}

// ----------------------------- Movement ---------------------------------
function _queueMove(creep, pos, priority) {
  if (Movement && Movement.request) {
    Movement.request(creep, { x: pos.x, y: pos.y, roomName: pos.roomName }, priority || CFG.PRIORS.TRAVEL);
  } else if (creep.travelTo) {
    creep.travelTo(pos);
  } else {
    creep.moveTo(pos);
  }
}

// ----------------------------- Actions ----------------------------------
function _safeWithdraw(creep, target, amount, priority) {
  if (BeeActions && BeeActions.safeWithdraw) return BeeActions.safeWithdraw(creep, target, RESOURCE_ENERGY, amount, priority || CFG.PRIORS.PICKUP);
  var r = creep.withdraw(target, RESOURCE_ENERGY, amount);
  if (r === ERR_NOT_IN_RANGE) _queueMove(creep, target.pos, priority || CFG.PRIORS.PICKUP);
  return r;
}

function _safeTransfer(creep, target, amount, priority) {
  if (BeeActions && BeeActions.safeTransfer) return BeeActions.safeTransfer(creep, target, RESOURCE_ENERGY, amount, priority || CFG.PRIORS.DELIVER);
  var r = creep.transfer(target, RESOURCE_ENERGY, amount);
  if (r === ERR_NOT_IN_RANGE) _queueMove(creep, target.pos, priority || CFG.PRIORS.DELIVER);
  return r;
}

// ----------------------------- Delivery Targets -------------------------
function _chooseDeliverTarget(homeRoom) {
  var room = Game.rooms[homeRoom];
  if (!room) return null;

  // Prefer storage if it exists and isn't nearly full
  if (room.storage && room.storage.store) {
    var cap = room.storage.store.getCapacity ? room.storage.store.getCapacity(RESOURCE_ENERGY) : 1000000;
    var used = room.storage.store[RESOURCE_ENERGY] || 0;
    if ((used / Math.max(1, cap)) < CFG.STORAGE_NEAR_FULL_PCT) return room.storage;
  }

  // Fallback to terminal if allowed
  if (CFG.DELIVER_TO_TERMINAL_IF_STORAGE_FULL && room.terminal && room.terminal.store) {
    return room.terminal;
  }

  // Last resort: any spawn/extension needing energy (visible)
  var needy = room.find(FIND_MY_STRUCTURES, {
    filter: function(s) {
      if (s.structureType !== STRUCTURE_SPAWN && s.structureType !== STRUCTURE_EXTENSION) return false;
      if (!s.store) return false;
      return (s.store.getFreeCapacity && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
    }
  });
  if (needy && needy.length) return needy[0];

  return room.storage || room.terminal || null;
}

// ------------------------------- Main -----------------------------------
var TaskTrucker = {

  run: function(creep) {
    if (!creep) return;

    // Ensure task envelope
    if (!creep.memory._task || creep.memory._task.type !== 'trucker') {
      creep.memory._task = {
        type: 'trucker',
        homeRoom: _inferHomeRoom(creep),
        fromRoom: null,
        toRoom: null,
        pickupId: null,
        deliverId: null,
        since: Game.time,
        emptyStreak: 0
      };
    }

    var task = creep.memory._task;
    var homeRoom = task.homeRoom || _inferHomeRoom(creep);

    // === If we are empty or not full, ensure/continue PICKUP ===
    if (creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {

      // 1) Acquire/confirm a job
      if (!task.pickupId) {
        var req = _pickHaulRequest(creep, homeRoom);
        if (!req) req = _selfDiscoverPickup(homeRoom);

        if (req) {
          task.fromRoom = req.fromRoom;
          task.toRoom   = req.toRoom || homeRoom;
          task.pickupId = req.targetId;
          // Mark "Enroute" if we can map container->source
          _setContainerPickupStatus(task.fromRoom, task.pickupId, "Enroute");
          if (CFG.DEBUG_SAY) creep.say('🚚↗');
        } else {
          // No work advertised; idle towards home
          if (creep.pos.roomName !== homeRoom) {
            _queueMove(creep, new RoomPosition(25, 25, homeRoom), CFG.PRIORS.TRAVEL);
          }
          return;
        }
      }

      // 2) Move to container room (if needed)
      if (task.fromRoom && creep.pos.roomName !== task.fromRoom) {
        _queueMove(creep, new RoomPosition(25, 25, task.fromRoom), CFG.PRIORS.TRAVEL);
        return;
      }

      // 3) Withdraw from the container
      var container = Game.getObjectById(task.pickupId);
      if (!container) {
        // No vision or container gone — try to head to room center and retry next tick
        _queueMove(creep, new RoomPosition(25, 25, task.fromRoom || creep.pos.roomName), CFG.PRIORS.TRAVEL);
        task.emptyStreak = 0;
        return;
      }

      // Record containerId into room memory if possible (binds future Enroute updates)
      _recordContainerId(container.pos.roomName, container);

      var available = (container.store && container.store[RESOURCE_ENERGY]) || 0;
      if (available < CFG.MIN_WITHDRAW_THRESHOLD) {
        task.emptyStreak = (task.emptyStreak || 0) + 1;
        if (task.emptyStreak >= CFG.GIVE_UP_EMPTY_TICKS) {
          // Abandon this pickup; clear and try another next tick
          _setContainerPickupStatus(task.fromRoom, task.pickupId, "None");
          task.pickupId = null;
          task.emptyStreak = 0;
        }
        // Loiter near the container to be first in line
        _queueMove(creep, container.pos, CFG.PRIORS.PICKUP);
        return;
      }

      task.emptyStreak = 0;
      var want = creep.store.getFreeCapacity(RESOURCE_ENERGY);
      var amount = Math.min(want, available);
      var res = _safeWithdraw(creep, container, amount, CFG.PRIORS.PICKUP);
      if (res === OK || res === ERR_NOT_IN_RANGE) return; // movement queued or success

      // If withdraw succeeded and we are now full (or container is empty), flip to delivery
      if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0 || ((container.store[RESOURCE_ENERGY] || 0) < CFG.MIN_WITHDRAW_THRESHOLD)) {
        task.deliverId = null; // we'll pick a deliver target below
      }
    }

    // === DELIVERY ===
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
      if (!task.toRoom) task.toRoom = homeRoom;
      if (!task.deliverId) {
        var t = _chooseDeliverTarget(task.toRoom);
        if (t) task.deliverId = t.id;
      }

      // Go to delivery room if needed
      if (creep.pos.roomName !== task.toRoom) {
        _queueMove(creep, new RoomPosition(25, 25, task.toRoom), CFG.PRIORS.TRAVEL);
        return;
      }

      // Transfer to target
      var deliverTarget = task.deliverId ? Game.getObjectById(task.deliverId) : _chooseDeliverTarget(task.toRoom);
      if (!deliverTarget) {
        // No storage/terminal? head to room center and wait
        _queueMove(creep, new RoomPosition(25, 25, task.toRoom), CFG.PRIORS.TRAVEL);
        return;
      }

      var give = creep.store.getUsedCapacity(RESOURCE_ENERGY);
      var res2 = _safeTransfer(creep, deliverTarget, give, CFG.PRIORS.DELIVER);
      if (res2 === OK || res2 === ERR_NOT_IN_RANGE) return;

      // After successful unload (or if empty), clear job + status
      if (creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
        if (task.fromRoom && task.pickupId) _setContainerPickupStatus(task.fromRoom, task.pickupId, "None");
        task.pickupId = null;
        task.deliverId = null;
        task.fromRoom = null;
        // stay bound to homeRoom/toRoom
        if (CFG.DEBUG_SAY) creep.say('✅');
      }
    }
  }
};

module.exports = TaskTrucker;
