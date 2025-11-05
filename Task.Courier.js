'use strict';

/**
 * What changed & why:
 * - Tightened courier haul integration by consuming Logistics.Manager TTL-backed requests with per-tick claims.
 * - Swapped ad-hoc priorities for Movement.Manager intent types so traffic ordering stays consistent across roles.
 * - Keeps persistent _task envelopes while leaning on BeeSelectors/BeeActions for cached targets and safe actions.
 */

var BeeSelectors = require('BeeSelectors');
var BeeActions = require('BeeActions');

var CFG = Object.freeze({
  DEBUG_SAY: false,
  DEBUG_DRAW: true,
  DRAW: {
    WITHDRAW: '#6ec1ff',
    DELIVER: '#6effa1',
    PICKUP: '#ffe66e',
    IDLE: '#bfbfbf',
    WIDTH: 0.12,
    OPACITY: 0.45,
    FONT: 0.6
  },
  STUCK_TICKS: 6,
  HAUL_GRACE: 2
});

function debugSay(creep, msg) {
  if (CFG.DEBUG_SAY && creep && msg) creep.say(msg, true);
}

function drawLine(creep, target, color, label) {
  if (!CFG.DEBUG_DRAW || !creep || !target) return;
  var room = creep.room;
  if (!room || !room.visual) return;
  var pos = target.pos || target;
  if (!pos || pos.roomName !== room.name) return;
  try {
    room.visual.line(creep.pos, pos, {
      color: color,
      width: CFG.DRAW.WIDTH,
      opacity: CFG.DRAW.OPACITY,
      lineStyle: 'solid'
    });
    if (label) {
      room.visual.text(label, pos.x, pos.y - 0.3, {
        color: color,
        opacity: CFG.DRAW.OPACITY,
        font: CFG.DRAW.FONT,
        align: 'center'
      });
    }
  } catch (e) {}
}

function ensureTask(creep) {
  if (!creep.memory) return;
  if (!creep.memory._task) creep.memory._task = null;
}

function releaseHaulKey(key) {
  if (!key) return;
  if (!Memory.__BHM || !Memory.__BHM.haul || !Memory.__BHM.haul.entries) return;
  delete Memory.__BHM.haul.entries[key];
  var entries = Memory.__BHM.haul.entries;
  var remaining = false;
  for (var k in entries) {
    if (Object.prototype.hasOwnProperty.call(entries, k)) { remaining = true; break; }
  }
  if (!remaining) delete Memory.__BHM.haul;
}

function clearTask(creep) {
  if (!creep || !creep.memory) return;
  var existing = creep.memory._task;
  if (existing && existing.data && existing.data.request && existing.data.request.key) {
    releaseHaulKey(existing.data.request.key);
  }
  creep.memory._task = null;
}

function haulMemoryValid(entry) {
  if (!entry) return false;
  if (entry.expires != null && Game.time > entry.expires) return false;
  if (entry.issued != null && entry.issued < Game.time - 1) return false;
  return true;
}

function getHaulRequests() {
  if (!Memory.__BHM || !Memory.__BHM.haul) return null;
  var haul = Memory.__BHM.haul;
  if (!haul || !haul.entries) return null;
  if (haul.expires != null && Game.time > haul.expires) return null;
  return haul;
}

function initHaulClaims() {
  if (!global.__BHM) global.__BHM = { caches: {} };
  if (global.__BHM.haulClaimsTick !== Game.time) {
    global.__BHM.haulClaimsTick = Game.time;
    global.__BHM.haulClaims = {};
  }
}

function claimHaulRequest(creep) {
  var haul = getHaulRequests();
  if (!haul) return null;
  initHaulClaims();
  var claims = global.__BHM.haulClaims;
  var entries = haul.entries;
  for (var key in entries) {
    if (!Object.prototype.hasOwnProperty.call(entries, key)) continue;
    var req = entries[key];
    if (!req || req.room !== creep.room.name) continue;
    if (req.resource !== RESOURCE_ENERGY) continue;
    if (!haulMemoryValid(req)) {
      releaseHaulKey(key);
      continue;
    }
    if (claims[key]) continue;
    claims[key] = creep.name;
    return {
      room: req.room,
      type: req.type,
      resource: req.resource,
      amount: req.amount,
      reason: req.reason,
      expires: (req.expires != null) ? req.expires : (Game.time + CFG.HAUL_GRACE),
      targetId: req.targetId,
      key: key
    };
  }
  return null;
}

function pickWithdrawTask(creep) {
  var room = creep.room;
  var sources = BeeSelectors.getEnergySourcePriority(room);
  for (var i = 0; i < sources.length; i++) {
    var entry = sources[i];
    if (!entry || !entry.target) continue;
    if (entry.kind === 'source') continue; // couriers lack WORK parts normally; skip harvest fallback.
    if (entry.kind === 'drop') {
      return { type: 'pickup', targetId: entry.target.id, since: Game.time, data: { source: 'drop' } };
    }
    if (entry.kind === 'tomb') {
      return { type: 'withdraw', targetId: entry.target.id, since: Game.time, data: { source: 'tomb' } };
    }
    if (entry.kind === 'ruin') {
      return { type: 'withdraw', targetId: entry.target.id, since: Game.time, data: { source: 'ruin' } };
    }
    return { type: 'withdraw', targetId: entry.target.id, since: Game.time, data: { source: entry.kind || 'energy' } };
  }
  return null;
}

function targetFromHaul(room, haul) {
  if (!haul || !haul.targetId) return null;
  var obj = Game.getObjectById(haul.targetId);
  if (obj) return obj;
  if (haul.type === 'pull') return room.storage || room.terminal || null;
  if (haul.type === 'push') return room.terminal || room.storage || null;
  return null;
}

function pickDeliverTask(creep) {
  var room = creep.room;
  var targets = BeeSelectors.findSpawnLikeNeedingEnergy(room);
  var chosen = BeeSelectors.selectClosestByRange(creep.pos, targets);
  if (chosen) {
    return { type: 'deliver', targetId: chosen.id, since: Game.time, data: { sink: 'spawnLike' } };
  }
  var towers = BeeSelectors.findTowersNeedingEnergy(room);
  chosen = BeeSelectors.selectClosestByRange(creep.pos, towers);
  if (chosen) {
    return { type: 'deliver', targetId: chosen.id, since: Game.time, data: { sink: 'tower' } };
  }
  var haul = claimHaulRequest(creep);
  if (haul) {
    var haulTarget = targetFromHaul(room, haul);
    if (haulTarget) {
      return { type: 'deliver', targetId: haulTarget.id, since: Game.time, data: { sink: 'haul', request: haul } };
    }
  }
  var storage = BeeSelectors.findStorageNeedingEnergy(room);
  if (storage) {
    return { type: 'deliver', targetId: storage.id, since: Game.time, data: { sink: 'storage' } };
  }
  if (room.terminal) {
    return { type: 'deliver', targetId: room.terminal.id, since: Game.time, data: { sink: 'terminal' } };
  }
  return null;
}

function needsNewDueToHaul(task) {
  if (!task || !task.data || !task.data.request) return false;
  var haul = task.data.request;
  if (!haulMemoryValid(haul)) return true;
  var mem = getHaulRequests();
  if (!mem || !mem.entries) return true;
  if (!haul.key) return true;
  if (!mem.entries[haul.key]) return true;
  return false;
}

function needNewTask(creep, task) {
  if (!task) return true;
  var target = Game.getObjectById(task.targetId);
  if (!target) return true;
  if (task.type === 'withdraw' || task.type === 'pickup') {
    if (creep.store.getFreeCapacity() === 0) return true;
    if (task.type === 'withdraw' && target.store && (target.store[RESOURCE_ENERGY] | 0) === 0) return true;
    if (task.type === 'pickup' && target.amount <= 0) return true;
  }
  if (task.type === 'deliver') {
    if (creep.store[RESOURCE_ENERGY] === 0) return true;
    if (needsNewDueToHaul(task)) return true;
    if (target.store && target.store.getFreeCapacity(RESOURCE_ENERGY) === 0) return true;
    if (target.energyCapacity != null && (target.energy | 0) >= (target.energyCapacity | 0)) return true;
  }
  if (!task.data) task.data = {};
  if (task.data.lastPosX === creep.pos.x && task.data.lastPosY === creep.pos.y) {
    task.data.stuck = (task.data.stuck | 0) + 1;
    if (task.data.stuck >= CFG.STUCK_TICKS) return true;
  } else {
    task.data.stuck = 0;
    task.data.lastPosX = creep.pos.x;
    task.data.lastPosY = creep.pos.y;
  }
  return false;
}

function executeTask(creep, task) {
  if (!task) return;
  var target = Game.getObjectById(task.targetId);
  if (!target) {
    clearTask(creep);
    return;
  }
  if (task.type === 'withdraw') {
    drawLine(creep, target, CFG.DRAW.WITHDRAW, 'WD');
    debugSay(creep, '📦');
    var withdrawOpts = { reusePath: 20 };
    var rc = BeeActions.safeWithdraw(creep, target, RESOURCE_ENERGY, withdrawOpts);
    if (rc === OK && creep.store.getFreeCapacity() === 0) clearTask(creep);
    return;
  }
  if (task.type === 'pickup') {
    drawLine(creep, target, CFG.DRAW.PICKUP, 'DROP');
    debugSay(creep, '🍪');
    var pickupOpts = { reusePath: 10 };
    var pc = BeeActions.safePickup(creep, target, pickupOpts);
    if (pc === OK && creep.store.getFreeCapacity() === 0) clearTask(creep);
    return;
  }
  if (task.type === 'deliver') {
    drawLine(creep, target, CFG.DRAW.DELIVER, 'DEL');
    debugSay(creep, '🚚');
    var transferOpts = { reusePath: 20 };
    var tr = BeeActions.safeTransfer(creep, target, RESOURCE_ENERGY, null, transferOpts);
    if (tr === OK && creep.store[RESOURCE_ENERGY] === 0) clearTask(creep);
    return;
  }
}

var TaskCourier = {
  run: function (creep) {
    if (!creep || creep.spawning) return;
    ensureTask(creep);
    var task = creep.memory._task;
    if (needNewTask(creep, task)) {
      clearTask(creep);
      var newTask = null;
      if (creep.store[RESOURCE_ENERGY] > 0) {
        newTask = pickDeliverTask(creep);
      }
      if (!newTask) {
        newTask = pickWithdrawTask(creep);
      }
      if (!newTask && creep.store[RESOURCE_ENERGY] > 0) {
        var storage = creep.room.storage || creep.room.terminal;
        if (storage) newTask = { type: 'deliver', targetId: storage.id, since: Game.time, data: { sink: 'fallback' } };
      }
      if (!newTask) {
        debugSay(creep, '🧘');
        if (CFG.DEBUG_DRAW) drawLine(creep, creep.pos, CFG.DRAW.IDLE, 'IDLE');
        clearTask(creep);
        return;
      }
      creep.memory._task = newTask;
      task = newTask;
    }
    executeTask(creep, task);
  }
};

module.exports = TaskCourier;
