'use strict';

var BeeSelectors = require('BeeSelectors');
var QueenConfig = require('Queen.Config');
var QueenMemory = require('Queen.Memory');
var QueenReservations = require('Queen.Reservations');

function getEnergyStored(target) {
  if (!target) return 0;
  if (target.store) return target.store[RESOURCE_ENERGY] || 0;
  if (target.energy != null) return Number(target.energy) || 0;
  return 0;
}
function getFreeEnergyCapacity(target) {
  if (!target) return 0;
  if (target.store && target.store.getFreeCapacity) return target.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
  if (target.energyCapacity != null) {
    var energyCap = Number(target.energyCapacity) || 0;
    var energy = Number(target.energy) || 0;
    return Math.max(0, energyCap - energy);
  }
  return 0;
}
function createTask(type, targetId, data) { return { type: type, targetId: targetId || null, since: Game.time, data: data || {} }; }
function getIdleAnchor(creep) {
  if (!creep || !creep.room) return null;
  if (creep.room.storage) return creep.room.storage;
  var spawns = creep.room.find(FIND_MY_SPAWNS);
  if (spawns && spawns.length) return spawns[0];
  if (creep.room.controller) return creep.room.controller;
  return null;
}
function createIdleTask(creep) {
  var anchor = getIdleAnchor(creep);
  if (!anchor) return createTask('idle', null, null);
  var pos = anchor.pos || anchor;
  return createTask('idle', anchor.id || null, { pos: { x: pos.x, y: pos.y, roomName: pos.roomName }, range: 2 });
}

function needsNewTask(creep, task) {
  if (!task) return true;
  var target = task.targetId ? Game.getObjectById(task.targetId) : null;
  if (!task.data) task.data = {};
  if (task.type === 'withdraw') {
    if (!target || creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0 || getEnergyStored(target) <= 0) return true;
  } else if (task.type === 'pickup') {
    if (!target || creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0 || (target.amount != null && target.amount <= 0)) return true;
  } else if (task.type === 'deliver') {
    if (!target || (creep.store[RESOURCE_ENERGY] || 0) === 0 || getFreeEnergyCapacity(target) === 0) return true;
  }

  var data = task.data;
  if (data.lastPosX === creep.pos.x && data.lastPosY === creep.pos.y) {
    data.stuck = (data.stuck || 0) + 1;
    if (data.stuck >= QueenConfig.CFG.STUCK_TICKS) return true;
  } else {
    data.stuck = 0;
    data.lastPosX = creep.pos.x;
    data.lastPosY = creep.pos.y;
  }
  return false;
}

function pickWithdrawTask(creep) {
  var room = creep.room;
  if (!room) return null;
  var pref = (creep.memory && creep.memory.energyPref && creep.memory.energyPref.length) ? creep.memory.energyPref : ['tomb', 'ruin', 'storage', 'drop', 'container', 'terminal', 'link'];
  var list = BeeSelectors.getEnergySourcePriority(room);
  if (!list || !list.length) return null;

  var buckets = {};
  for (var i = 0; i < list.length; i++) {
    var entry = list[i];
    if (!entry || !entry.target) continue;
    var kind = entry.kind || 'unknown';
    if (!buckets[kind]) buckets[kind] = [];
    buckets[kind].push(entry.target);
  }

  for (var priorityIndex = 0; priorityIndex < pref.length; priorityIndex++) {
    var kindName = pref[priorityIndex];
    if (kindName === 'source') continue;
    var candidates = buckets[kindName];
    if (!candidates || !candidates.length) continue;

    var best = BeeSelectors.selectClosestByRange ? BeeSelectors.selectClosestByRange(creep.pos, candidates) : null;
    if (!best) {
      var bestDistance = 9999;
      for (var j = 0; j < candidates.length; j++) {
        var target = candidates[j];
        var distance = creep.pos.getRangeTo(target);
        if (distance < bestDistance) { bestDistance = distance; best = target; }
      }
    }
    if (!best) continue;

    if (kindName === 'drop') return createTask('pickup', best.id, { source: 'drop' });
    if (kindName === 'tomb') return createTask('withdraw', best.id, { source: 'tomb' });
    if (kindName === 'ruin') return createTask('withdraw', best.id, { source: 'ruin' });
    if (kindName === 'storage') return createTask('withdraw', best.id, { source: 'storage' });
    if (kindName === 'terminal') return createTask('withdraw', best.id, { source: 'terminal' });
    if (kindName === 'container') return createTask('withdraw', best.id, { source: 'container' });
    if (kindName === 'link') return createTask('withdraw', best.id, { source: 'link' });
    return createTask('withdraw', best.id, { source: kindName || 'energy' });
  }
  return null;
}

function pickDeliverTask(creep, terminalJob, logTerminalJob) {
  var room = creep.room;
  if (!room) return null;
  var amount = creep.store[RESOURCE_ENERGY] || 0;
  if (amount <= 0) return null;

  var spawnLike = BeeSelectors.findSpawnLikeNeedingEnergy(room);
  var bestSpawn = BeeSelectors.selectClosestByRange(creep.pos, spawnLike);
  if (bestSpawn) {
    if (terminalJob && terminalJob.active && (!terminalJob.lastSkipTick || Game.time - terminalJob.lastSkipTick >= 10)) { logTerminalJob(room, 'queen skipped terminal stocking because spawn/extension fill exists'); terminalJob.lastSkipTick = Game.time; }
    var freeSpawn = getFreeEnergyCapacity(bestSpawn);
    if (freeSpawn > QueenReservations.getReserved(bestSpawn.id)) { QueenReservations.reserveFill(bestSpawn.id, Math.min(freeSpawn, amount)); return createTask('deliver', bestSpawn.id, { sink: 'spawn' }); }
  }

  var towers = BeeSelectors.findTowersNeedingEnergy(room);
  var bestTower = BeeSelectors.selectClosestByRange(creep.pos, towers);
  if (bestTower) {
    if (terminalJob && terminalJob.active && (!terminalJob.lastSkipTick || Game.time - terminalJob.lastSkipTick >= 10)) { logTerminalJob(room, 'queen skipped terminal stocking because tower fill exists'); terminalJob.lastSkipTick = Game.time; }
    var freeTower = getFreeEnergyCapacity(bestTower);
    if (freeTower > QueenReservations.getReserved(bestTower.id)) { QueenReservations.reserveFill(bestTower.id, Math.min(freeTower, amount)); return createTask('deliver', bestTower.id, { sink: 'tower' }); }
  }

  if (room.storage) {
    var nearbyLinks = room.storage.pos.findInRange(FIND_MY_STRUCTURES, 2, { filter: function (structure) { return structure.structureType === STRUCTURE_LINK; } });
    if (!nearbyLinks || nearbyLinks.length === 0) {
      var allLinks = room.find(FIND_MY_STRUCTURES, { filter: function (structure) { return structure.structureType === STRUCTURE_LINK; } });
      if (allLinks && allLinks.length) nearbyLinks = [BeeSelectors.selectClosestByRange(room.storage.pos, allLinks)];
    }
    var hubLink = BeeSelectors.selectClosestByRange(creep.pos, nearbyLinks);
    if (hubLink && hubLink.store) {
      var cap = hubLink.store.getCapacity(RESOURCE_ENERGY) || 0;
      var used = hubLink.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
      var fillPct = cap > 0 ? (used / cap) : 1;
      var free = cap - used;
      if (cap > 0 && fillPct < 0.80 && free > 0) {
        var availForPlan = free - (QueenReservations.getReserved(hubLink.id) || 0);
        if (availForPlan > 0) { QueenReservations.reserveFill(hubLink.id, Math.min(amount, availForPlan)); return createTask('deliver', hubLink.id, { sink: 'link_storage' }); }
      }
    }
  }

  if (terminalJob && terminalJob.active && !terminalJob.paused && room.terminal && room.storage) {
    var claimOpen = !terminalJob.claimBy || terminalJob.claimBy === creep.name || (Game.time - (terminalJob.claimTick || 0) > 2);
    if (claimOpen) {
      var terminalFree = room.terminal.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
      var terminalEnergy = room.terminal.store[RESOURCE_ENERGY] || 0;
      var needed = Math.max(0, terminalJob.targetEnergy - terminalEnergy);
      if (terminalFree > 0 && needed > 0) {
        terminalJob.claimBy = creep.name;
        terminalJob.claimTick = Game.time;
        var planAmount = Math.min(amount, terminalFree, needed);
        QueenReservations.reserveFill(room.terminal.id, planAmount);
        return createTask('deliver', room.terminal.id, { sink: 'terminal_job', amount: planAmount });
      }
    }
  }

  if (room.storage) { if ((room.storage.store.getFreeCapacity(RESOURCE_ENERGY) || 0) > 0) return createTask('deliver', room.storage.id, { sink: 'storage' }); }
  if (room.terminal) { if ((room.terminal.store.getFreeCapacity(RESOURCE_ENERGY) || 0) > 0) return createTask('deliver', room.terminal.id, { sink: 'terminal' }); }
  return null;
}

function chooseNextTask(creep, terminalJob, logTerminalJob) {
  if ((creep.store[RESOURCE_ENERGY] || 0) === 0) {
    var withdrawTask = pickWithdrawTask(creep);
    if (withdrawTask) return withdrawTask;
  } else {
    var deliverTask = pickDeliverTask(creep, terminalJob, logTerminalJob);
    if (deliverTask) return deliverTask;
  }
  return createIdleTask(creep);
}

function ensureActiveTask(creep, terminalJob, logTerminalJob, releaseTerminalJobClaimIfHeld) {
  QueenMemory.ensureTaskSlot(creep);
  var task = creep.memory._task;
  if (needsNewTask(creep, task)) {
    if (typeof releaseTerminalJobClaimIfHeld === 'function') releaseTerminalJobClaimIfHeld(creep);
    task = chooseNextTask(creep, terminalJob, logTerminalJob);
    QueenMemory.setTask(creep, task);
  }
  task = creep.memory._task;
  if (!task) {
    task = createIdleTask(creep);
    QueenMemory.setTask(creep, task);
  }
  return creep.memory._task;
}

module.exports = { createTask: createTask, createIdleTask: createIdleTask, needsNewTask: needsNewTask, pickWithdrawTask: pickWithdrawTask, pickDeliverTask: pickDeliverTask, chooseNextTask: chooseNextTask, ensureActiveTask: ensureActiveTask, getFreeEnergyCapacity: getFreeEnergyCapacity };
