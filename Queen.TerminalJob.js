'use strict';

var BeeSelectors = require('BeeSelectors');

function logTerminalJob(room, message) {
  if (!room || !message) return;
  console.log('[Queen][' + room.name + '][terminalEnergyJob] ' + message);
}

function getRoomTerminalEnergyJob(room) {
  if (!room || !room.memory) return null;
  if (!room.memory.terminalEnergyJob) {
    room.memory.terminalEnergyJob = {
      active: false,
      thresholdTicks: 0,
      startedAt: null,
      targetEnergy: 300000,
      paused: false,
      pauseReason: null,
      lastUpdate: Game.time,
      claimBy: null,
      claimTick: null
    };
  }
  var job = room.memory.terminalEnergyJob;
  if (typeof job.targetEnergy !== 'number' || job.targetEnergy <= 0) job.targetEnergy = 300000;
  if (typeof job.thresholdTicks !== 'number') job.thresholdTicks = 0;
  if (typeof job.active !== 'boolean') job.active = false;
  if (typeof job.paused !== 'boolean') job.paused = false;
  return job;
}

function roomHasCriticalEnergyNeeds(room) {
  if (!room) return false;
  var spawnLike = BeeSelectors.findSpawnLikeNeedingEnergy(room);
  if (spawnLike && spawnLike.length) return true;
  var towers = BeeSelectors.findTowersNeedingEnergy(room);
  if (towers && towers.length) return true;
  return false;
}

function updateTerminalEnergyJob(room) {
  var job = getRoomTerminalEnergyJob(room);
  if (!job) return null;

  // Lifecycle:
  // - inactive: waiting for sustained storage surplus
  // - active: filling terminal toward targetEnergy
  // - paused: temporarily blocked by urgent room energy needs
  // - completed: terminal reached target, job resets
  if (job.lastUpdate === Game.time) return job;
  job.lastUpdate = Game.time;

  if (!room.storage || !room.terminal) {
    if (job.active || job.paused) logTerminalJob(room, 'paused: missing storage or terminal');
    job.active = false;
    job.paused = true;
    job.pauseReason = 'missing_structures';
    job.thresholdTicks = 0;
    job.claimBy = null;
    job.claimTick = null;
    return job;
  }

  var storageCap = room.storage.store.getCapacity(RESOURCE_ENERGY) || 0;
  var storageEnergy = room.storage.store[RESOURCE_ENERGY] || 0;
  var threshold = Math.floor(storageCap * 0.75);
  var aboveThreshold = storageCap > 0 && storageEnergy >= threshold;
  if (aboveThreshold) job.thresholdTicks = (job.thresholdTicks || 0) + 1;
  else job.thresholdTicks = 0;

  if (!job.active && job.thresholdTicks === 50) logTerminalJob(room, 'storage surplus threshold reached (50 ticks above 75%)');

  var terminalEnergyNow = room.terminal.store[RESOURCE_ENERGY] || 0;
  if (!job.active && job.thresholdTicks >= 50 && terminalEnergyNow < job.targetEnergy) {
    job.active = true;
    job.paused = false;
    job.pauseReason = null;
    if (!job.startedAt) job.startedAt = Game.time;
    logTerminalJob(room, 'job started (target=' + job.targetEnergy + ')');
  }

  if (!job.active) return job;
  if ((room.terminal.store[RESOURCE_ENERGY] || 0) >= job.targetEnergy) {
    job.active = false;
    job.paused = false;
    job.pauseReason = null;
    job.claimBy = null;
    job.claimTick = null;
    job.startedAt = null;
    job.lastSkipTick = null;
    logTerminalJob(room, 'job completed (terminal reached target energy)');
    return job;
  }

  var pauseReason = null;
  if (!aboveThreshold) pauseReason = 'storage_below_threshold';
  else if (roomHasCriticalEnergyNeeds(room)) pauseReason = 'critical_fill_needs';

  if (pauseReason) {
    if (!job.paused || job.pauseReason !== pauseReason) logTerminalJob(room, 'job paused (' + pauseReason + ')');
    job.paused = true;
    job.pauseReason = pauseReason;
    return job;
  }

  if (job.paused) logTerminalJob(room, 'job resumed');
  job.paused = false;
  job.pauseReason = null;
  return job;
}

function releaseTerminalJobClaimIfHeld(creep) {
  if (!creep || !creep.room || !creep.memory || !creep.memory._task) return;
  var task = creep.memory._task;
  if (!task || task.type !== 'deliver' || !task.data || task.data.sink !== 'terminal_job') return;
  var job = getRoomTerminalEnergyJob(creep.room);
  if (!job) return;
  // claimBy prevents multiple Queens from stocking the terminal-job target in the same short window.
  if (job.claimBy === creep.name) {
    job.claimBy = null;
    job.claimTick = null;
  }
}

module.exports = { logTerminalJob: logTerminalJob, getRoomTerminalEnergyJob: getRoomTerminalEnergyJob, updateTerminalEnergyJob: updateTerminalEnergyJob, releaseTerminalJobClaimIfHeld: releaseTerminalJobClaimIfHeld, roomHasCriticalEnergyNeeds: roomHasCriticalEnergyNeeds };
