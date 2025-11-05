'use strict';

/**
 * What changed & why:
 * - Truckers now consume a shared one-tick haul bus for remote source containers instead of flag micro-management.
 * - Added self-discovery of remote containers, hostile safety checks, and Movement.Manager intents for all travel.
 * - Keeps persistent _task envelopes while publishing/claiming Memory.__BHM.haulRequests for other roles to share.
 */

var BeeSelectors = null;
var BeeActions = null;
var Movement = null;

try { BeeSelectors = require('BeeSelectors'); } catch (err) {}
try { BeeActions = require('BeeActions'); } catch (err2) {}
try { Movement = require('Movement.Manager'); } catch (err3) {}

var CFG = {
  MIN_WITHDRAW: 200,
  DISCOVER_THRESHOLD: 800,
  HOSTILE_RANGE: 5,
  HAUL_PRIORITIES: {
    pickup: 92,
    deliver: 88,
    travel: 70
  }
};

function ensureMemory() {
  if (!Memory.__BHM) Memory.__BHM = {};
  if (!Memory.__BHM.haulRequests) Memory.__BHM.haulRequests = {};
  if (!Memory.__BHM.remotesByHome) Memory.__BHM.remotesByHome = {};
  if (!Memory.__BHM.avoidSources) Memory.__BHM.avoidSources = {};
}

function cleanupHaulBus() {
  ensureMemory();
  if (Memory.__BHM._haulCleanupTick === Game.time) return Memory.__BHM.haulRequests;
  var bus = Memory.__BHM.haulRequests;
  for (var key in bus) {
    if (!Object.prototype.hasOwnProperty.call(bus, key)) continue;
    var entry = bus[key];
    if (!entry || entry.issuedAt !== Game.time) delete bus[key];
  }
  Memory.__BHM._haulCleanupTick = Game.time;
  return Memory.__BHM.haulRequests;
}

function queueMove(creep, pos, priority, range) {
  if (!creep || !pos) return;
  var opts = { range: (range != null) ? range : 1, intentType: 'harvest', reusePath: 15 };
  if (Movement && Movement.request) {
    Movement.request(creep, { x: pos.x, y: pos.y, roomName: pos.roomName }, priority || CFG.HAUL_PRIORITIES.travel, opts);
  } else if (typeof creep.travelTo === 'function') {
    creep.travelTo(new RoomPosition(pos.x, pos.y, pos.roomName), { range: opts.range });
  } else {
    creep.moveTo(pos.x, pos.y, { range: opts.range });
  }
}

function safeWithdraw(creep, target, amount) {
  if (BeeActions && BeeActions.safeWithdraw) {
    return BeeActions.safeWithdraw(creep, target, RESOURCE_ENERGY, amount, CFG.HAUL_PRIORITIES.pickup);
  }
  var res = creep.withdraw(target, RESOURCE_ENERGY, amount);
  if (res === ERR_NOT_IN_RANGE && target && target.pos) queueMove(creep, target.pos, CFG.HAUL_PRIORITIES.pickup, 1);
  return res;
}

function safeTransfer(creep, target) {
  if (BeeActions && BeeActions.safeTransfer) {
    return BeeActions.safeTransfer(creep, target, RESOURCE_ENERGY, null, CFG.HAUL_PRIORITIES.deliver);
  }
  var res = creep.transfer(target, RESOURCE_ENERGY);
  if (res === ERR_NOT_IN_RANGE && target && target.pos) queueMove(creep, target.pos, CFG.HAUL_PRIORITIES.deliver, 1);
  return res;
}

function inferHome(creep) {
  if (!creep) return null;
  if (creep.memory && creep.memory.homeRoom) return creep.memory.homeRoom;
  if (creep.memory && creep.memory.home) return creep.memory.home;
  if (creep.room && creep.room.controller && creep.room.controller.my) return creep.room.name;
  var spawns = Object.keys(Game.spawns || {});
  if (spawns.length) return Game.spawns[spawns[0]].room.name;
  return creep.room ? creep.room.name : null;
}

function ensureTask(creep) {
  if (!creep || !creep.memory) return null;
  if (!creep.memory._task || creep.memory._task.type !== 'trucker') {
    creep.memory._task = {
      type: 'trucker',
      homeRoom: inferHome(creep),
      fromRoom: null,
      toRoom: null,
      pickupId: null,
      deliverId: null,
      requestKey: null,
      since: Game.time,
      emptyTicks: 0
    };
  }
  return creep.memory._task;
}

function markRequestClaim(key, creepName) {
  ensureMemory();
  var bus = Memory.__BHM.haulRequests;
  if (!bus[key]) return;
  bus[key].claimedBy = creepName;
}

function dropRequest(key) {
  ensureMemory();
  if (!key) return;
  var bus = Memory.__BHM.haulRequests;
  if (bus[key]) delete bus[key];
}

function isThreatened(target) {
  if (!target || !target.pos) return false;
  var pos = target.pos;
  var hostiles = pos.findInRange(FIND_HOSTILE_CREEPS, CFG.HOSTILE_RANGE);
  if (hostiles && hostiles.length) return true;
  var cores = pos.findInRange(FIND_HOSTILE_STRUCTURES, CFG.HOSTILE_RANGE, {
    filter: function (s) { return s.structureType === STRUCTURE_INVADER_CORE; }
  });
  return cores && cores.length > 0;
}

function chooseDeliverTarget(homeRoom) {
  var room = Game.rooms[homeRoom];
  if (!room) return null;
  if (room.storage && room.storage.store) {
    var used = room.storage.store[RESOURCE_ENERGY] || 0;
    var cap = room.storage.store.getCapacity ? room.storage.store.getCapacity(RESOURCE_ENERGY) : room.storage.storeCapacity || 1;
    var ratio = used / Math.max(1, cap);
    if (ratio >= 0.95 && room.terminal && room.terminal.store) {
      return room.terminal;
    }
    if (used < cap) return room.storage;
  }
  if (room.terminal && room.terminal.store) {
    return room.terminal;
  }
  var needy = room.find(FIND_MY_STRUCTURES, {
    filter: function (s) {
      if (s.structureType !== STRUCTURE_SPAWN && s.structureType !== STRUCTURE_EXTENSION) return false;
      if (!s.store) return false;
      return (s.store.getFreeCapacity && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0);
    }
  });
  if (needy && needy.length) return needy[0];
  return room.storage || room.terminal || null;
}

function haulBusIsEmpty() {
  var bus = cleanupHaulBus();
  for (var key in bus) {
    if (!Object.prototype.hasOwnProperty.call(bus, key)) continue;
    return false;
  }
  return true;
}

function selfDiscover(homeRoom) {
  if (!BeeSelectors || typeof BeeSelectors.findRemoteSourceContainers !== 'function') return;
  if (!haulBusIsEmpty()) return;
  var containers = BeeSelectors.findRemoteSourceContainers(homeRoom) || [];
  for (var i = 0; i < containers.length; i++) {
    var info = containers[i];
    if (!info || !info.container || !info.container.id) continue;
    var amount = (info.container.store && info.container.store[RESOURCE_ENERGY]) || 0;
    if (amount < CFG.DISCOVER_THRESHOLD) continue;
    var key = info.roomName + ':' + info.container.id;
    ensureMemory();
    if (Memory.__BHM.haulRequests[key] && Memory.__BHM.haulRequests[key].issuedAt === Game.time) continue;
    Memory.__BHM.haulRequests[key] = {
      key: key,
      fromRoom: info.roomName,
      toRoom: homeRoom,
      targetId: info.container.id,
      resource: RESOURCE_ENERGY,
      amountHint: amount,
      issuedAt: Game.time,
      claimedBy: null
    };
  }
}

function pickHaulRequest(creep, task) {
  ensureMemory();
  var homeRoom = task.homeRoom || inferHome(creep);
  var bus = cleanupHaulBus();
  var bestKey = null;
  var bestScore = -999999;
  for (var key in bus) {
    if (!Object.prototype.hasOwnProperty.call(bus, key)) continue;
    var entry = bus[key];
    if (!entry || entry.issuedAt !== Game.time) continue;
    if (entry.resource && entry.resource !== RESOURCE_ENERGY) continue;
    if (entry.claimedBy && entry.claimedBy !== creep.name) continue;
    var score = (entry.amountHint || 0);
    if (entry.toRoom === homeRoom) score += 25;
    if (task.requestKey && task.requestKey === key) score += 10;
    if (score > bestScore) {
      bestScore = score;
      bestKey = key;
    }
  }
  if (!bestKey) return null;
  markRequestClaim(bestKey, creep.name);
  var chosen = Memory.__BHM.haulRequests[bestKey];
  if (!chosen.toRoom) chosen.toRoom = homeRoom;
  return chosen;
}

function ensureDeliveryTarget(task) {
  if (!task.toRoom) return null;
  var target = task.deliverId ? Game.getObjectById(task.deliverId) : null;
  if (target) return target;
  target = chooseDeliverTarget(task.toRoom);
  if (target) task.deliverId = target.id;
  return target;
}

function clearPickup(task) {
  if (!task) return;
  if (task.requestKey) dropRequest(task.requestKey);
  task.pickupId = null;
  task.requestKey = null;
  task.fromRoom = null;
}

var TaskTrucker = {
  run: function (creep) {
    if (!creep) return;
    var task = ensureTask(creep);
    if (!task) return;
    task.homeRoom = task.homeRoom || inferHome(creep);
    cleanupHaulBus();
    if (!task.pickupId && creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
      selfDiscover(task.homeRoom);
      var req = pickHaulRequest(creep, task);
      if (req) {
        task.pickupId = req.targetId;
        task.fromRoom = req.fromRoom;
        task.toRoom = req.toRoom || task.homeRoom;
        task.requestKey = req.key;
        task.since = Game.time;
      }
    }
    if (creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0 && task.pickupId) {
      if (task.fromRoom && creep.pos.roomName !== task.fromRoom) {
        queueMove(creep, { x: 25, y: 25, roomName: task.fromRoom }, CFG.HAUL_PRIORITIES.travel, 1);
        return;
      }
      var container = Game.getObjectById(task.pickupId);
      if (!container) {
        clearPickup(task);
        return;
      }
      if (isThreatened(container)) {
        dropRequest(task.requestKey);
        clearPickup(task);
        return;
      }
      var available = (container.store && container.store[RESOURCE_ENERGY]) || 0;
      if (available < CFG.MIN_WITHDRAW) {
        task.emptyTicks = (task.emptyTicks || 0) + 1;
        if (task.emptyTicks >= 2) {
          clearPickup(task);
          task.emptyTicks = 0;
        }
        queueMove(creep, container.pos, CFG.HAUL_PRIORITIES.pickup, 1);
        return;
      }
      task.emptyTicks = 0;
      var want = creep.store.getFreeCapacity(RESOURCE_ENERGY);
      var amount = Math.min(want, available);
      var res = safeWithdraw(creep, container, amount);
      if (res === ERR_NOT_IN_RANGE) return;
      if (res === OK && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
        task.deliverId = null;
      }
      if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
        if (task.requestKey) dropRequest(task.requestKey);
      }
    }
    if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
      task.toRoom = task.toRoom || task.homeRoom;
      if (task.toRoom && creep.pos.roomName !== task.toRoom) {
        queueMove(creep, { x: 25, y: 25, roomName: task.toRoom }, CFG.HAUL_PRIORITIES.travel, 1);
        return;
      }
      var target = ensureDeliveryTarget(task);
      if (!target) {
        queueMove(creep, { x: 25, y: 25, roomName: task.toRoom }, CFG.HAUL_PRIORITIES.travel, 1);
        return;
      }
      var res2 = safeTransfer(creep, target);
      if (res2 === ERR_NOT_IN_RANGE) return;
      if (res2 === OK && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
        clearPickup(task);
        task.deliverId = null;
      }
    } else {
      task.deliverId = null;
    }
  }
};

module.exports = TaskTrucker;
