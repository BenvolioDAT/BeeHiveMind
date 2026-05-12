'use strict';

const BeeSelectors = require('BeeSelectors');
const BeeActions = require('BeeActions');
const MovementManager = require('Movement.Manager');
const BeeRoleVisuals = require('BeeRoleVisuals');
var CoreLogger = require('core.logger');
var queenLog = CoreLogger.createLogger('Queen', CoreLogger.LOG_LEVEL.BASIC);

function describeError(e) {
  return e && (e.stack || e.message || String(e));
}

// Queen-only debug and movement tuning.
var CFG = Object.freeze({
  DEBUG_SAY: false,
  DEBUG_DRAW: true,
  DRAW: {
    TRAVEL:   "#8ab6ff",
    WD_COLOR:    "#6ec1ff",  // withdraw lines
    FILL_COLOR:  "#6effa1",  // delivery lines
    WIDTH:   0.12,
    OPACITY: 0.45,
    FONT:    0.6
  },
  STUCK_TICKS: 6,
  MOVE_PRIORITIES: { withdraw: 60, pickup: 70, deliver: 55, idle: 5 },
});

// -------------------------
// Debug helpers (copied for self-containment)
// -------------------------
function debugSay(creep, msg) {
  if (CFG.DEBUG_SAY && creep && msg) creep.say(msg, true);
}

function drawLine(creep, target, color, label) {
  try {
    BeeRoleVisuals.drawLine(CFG.DEBUG_DRAW, creep, target, color, label, CFG.DRAW);
  } catch (e) {
    queenLog.warnEvery('queen.drawLine.visual', 250, 'drawLine failed for', creep && creep.name, describeError(e));
  }
}

  // -----------------------------
  // A) Identity + task/state helpers
  // -----------------------------
  function ensureQueenIdentity(creep) {
    if (!creep || !creep.memory) return;
    creep.memory.role = 'Queen';
    if (!creep.memory.task) creep.memory.task = 'queen';
  }

  // Memory keys:
  // - _task: current action envelope (type/targetId/data)
  function ensureTaskSlot(creep) {
    if (!creep || !creep.memory) return;
    if (!creep.memory._task) creep.memory._task = null;
  }

  function setTask(creep, task) {
    if (!creep || !creep.memory) return;
    creep.memory._task = task;
  }

  function clearTask(creep) {
    releaseTerminalJobClaimIfHeld(creep);
    if (!creep || !creep.memory) return;
    creep.memory._task = null;
  }

  function determineQueenState(creep) {
    ensureQueenIdentity(creep);
    var task = ensureActiveTask(creep);
    var type = (task && task.type) ? String(task.type).toUpperCase() : 'IDLE';
    creep.memory.state = type;
    return type;
  }

  // -----------------------------
  // PIB + reservations
  // -----------------------------
  function getReservationBucket() {
    if (!global.__BHM) global.__BHM = {};
    if (!global.__BHM.queenReservations || global.__BHM.queenReservations.tick !== Game.time) {
      global.__BHM.queenReservations = { tick: Game.time, map: {} };
    }
    return global.__BHM.queenReservations.map;
  }

  function reserveFill(targetId, amount) {
    if (!targetId || amount <= 0) return;
    var map = getReservationBucket();
    var cur = map[targetId] || 0;
    map[targetId] = cur + amount;
  }

  function getReserved(targetId) {
    if (!targetId) return 0;
    var map = getReservationBucket();
    return map[targetId] || 0;
  }

  function getEnergyStored(target) {
    if (!target) return 0;
    if (target.store) return target.store[RESOURCE_ENERGY] || 0;
    if (target.energy != null) return Number(target.energy) || 0;
    return 0;
  }

  function getFreeEnergyCapacity(target) {
    if (!target) return 0;
    if (target.store && target.store.getFreeCapacity) {
      return target.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
    }
    if (target.energyCapacity != null) {
      var energyCap = Number(target.energyCapacity) || 0;
      var energy    = Number(target.energy) || 0;
      return Math.max(0, energyCap - energy);
    }
    return 0;
  }

  function createTask(type, targetId, data) {
    return {
      type: type,
      targetId: targetId || null,
      since: Game.time,
      data: data || {}
    };
  }

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
    var data = {
      pos: { x: pos.x, y: pos.y, roomName: pos.roomName },
      range: 2
    };
    return createTask('idle', anchor.id || null, data);
  }

  function logTerminalJob(room, msg) {
    if (!room || !msg) return;
    console.log('[Queen][' + room.name + '][terminalEnergyJob] ' + msg);
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
    // Multi-Queen safety: only one updater mutates threshold/job state per tick.
    // Other Queens read the same shared state without double-counting.
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

    if (!job.active && job.thresholdTicks === 50) {
      logTerminalJob(room, 'storage surplus threshold reached (50 ticks above 75%)');
    }

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
      if (!job.paused || job.pauseReason !== pauseReason) {
        logTerminalJob(room, 'job paused (' + pauseReason + ')');
      }
      job.paused = true;
      job.pauseReason = pauseReason;
      return job;
    }

    if (job.paused) {
      logTerminalJob(room, 'job resumed');
    }
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
    if (job.claimBy === creep.name) {
      job.claimBy = null;
      job.claimTick = null;
    }
  }

  function needsNewTask(creep, task) {
    if (!task) return true;
    var target = task.targetId ? Game.getObjectById(task.targetId) : null;
    if (!task.data) task.data = {};

    if (task.type === 'withdraw') {
      if (!target) return true;
      if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) return true;
      if (getEnergyStored(target) <= 0) return true;
    } else if (task.type === 'pickup') {
      if (!target) return true;
      if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) return true;
      if (target.amount != null && target.amount <= 0) return true;
    } else if (task.type === 'deliver') {
      if (!target) return true;
      if ((creep.store[RESOURCE_ENERGY] || 0) === 0) return true;
      if (getFreeEnergyCapacity(target) === 0) return true;
    } else if (task.type === 'idle') {
      // Idle continues until a better option arrives.
    }

    var data = task.data;
    if (data.lastPosX === creep.pos.x && data.lastPosY === creep.pos.y) {
      data.stuck = (data.stuck || 0) + 1;
      if (data.stuck >= CFG.STUCK_TICKS) return true;
    } else {
      data.stuck = 0;
      data.lastPosX = creep.pos.x;
      data.lastPosY = creep.pos.y;
    }

    return false;
  }

  // -----------------------------
  // Target selection
  // -----------------------------
  function pickWithdrawTask(creep) {
    var room = creep.room;
    if (!room) return null;
    var pref = (creep.memory && creep.memory.energyPref && creep.memory.energyPref.length)
      ? creep.memory.energyPref
      : ['tomb','ruin','storage','drop','container','terminal','link'];
    var list = BeeSelectors.getEnergySourcePriority(room);
    if (!list || !list.length) return null;

    var buckets = {};
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e || !e.target) continue;
      var k = e.kind || 'unknown';
      if (!buckets[k]) buckets[k] = [];
      buckets[k].push(e.target);
    }

    for (var p = 0; p < pref.length; p++) {
      var kind = pref[p];
      if (kind === 'source') continue;
      var arr = buckets[kind];
      if (!arr || !arr.length) continue;
      var best = BeeSelectors.selectClosestByRange
        ? BeeSelectors.selectClosestByRange(creep.pos, arr)
        : (function (){
            var win = null, bestD = 9999;
            for (var j = 0; j < arr.length; j++) {
              var t = arr[j];
              var d = creep.pos.getRangeTo(t);
              if (d < bestD) { bestD = d; win = t; }
            }
            return win;
          })();
      if (!best) continue;
      if (kind === 'drop')      return createTask('pickup',   best.id, { source: 'drop' });
      if (kind === 'tomb')      return createTask('withdraw', best.id, { source: 'tomb' });
      if (kind === 'ruin')      return createTask('withdraw', best.id, { source: 'ruin' });
      if (kind === 'storage')   return createTask('withdraw', best.id, { source: 'storage' });
      if (kind === 'terminal')  return createTask('withdraw', best.id, { source: 'terminal' });
      if (kind === 'container') return createTask('withdraw', best.id, { source: 'container' });
      if (kind === 'link')      return createTask('withdraw', best.id, { source: 'link' });
      return createTask('withdraw', best.id, { source: kind || 'energy' });
    }
    return null;
  }

  function pickDeliverTask(creep) {
    var room = creep.room;
    if (!room) return null;

    var amount = creep.store[RESOURCE_ENERGY] || 0;
    if (amount <= 0) return null;
    var terminalJob = getRoomTerminalEnergyJob(room);

    var spawnLike = BeeSelectors.findSpawnLikeNeedingEnergy(room);
    var bestSpawn = BeeSelectors.selectClosestByRange(creep.pos, spawnLike);
    if (bestSpawn) {
      if (terminalJob && terminalJob.active && (!terminalJob.lastSkipTick || Game.time - terminalJob.lastSkipTick >= 10)) {
        logTerminalJob(room, 'queen skipped terminal stocking because spawn/extension fill exists');
        terminalJob.lastSkipTick = Game.time;
      }
      var freeSpawn = getFreeEnergyCapacity(bestSpawn);
      if (freeSpawn > getReserved(bestSpawn.id)) {
        var planAmount = Math.min(freeSpawn, amount);
        reserveFill(bestSpawn.id, planAmount);
        return createTask('deliver', bestSpawn.id, { sink: 'spawn' });
      }
    }

    var towers = BeeSelectors.findTowersNeedingEnergy(room);
    var bestTower = BeeSelectors.selectClosestByRange(creep.pos, towers);
    if (bestTower) {
      if (terminalJob && terminalJob.active && (!terminalJob.lastSkipTick || Game.time - terminalJob.lastSkipTick >= 10)) {
        logTerminalJob(room, 'queen skipped terminal stocking because tower fill exists');
        terminalJob.lastSkipTick = Game.time;
      }
      var freeTower = getFreeEnergyCapacity(bestTower);
      if (freeTower > getReserved(bestTower.id)) {
        var planTower = Math.min(freeTower, amount);
        reserveFill(bestTower.id, planTower);
        return createTask('deliver', bestTower.id, { sink: 'tower' });
      }
    }

    if (room.storage) {
      var storagePos = room.storage.pos;
      var nearbyLinks = storagePos.findInRange(FIND_MY_STRUCTURES, 2, {
        filter: function (s) {
          return s.structureType === STRUCTURE_LINK;
        }
      });

      if (!nearbyLinks || nearbyLinks.length === 0) {
        var allLinks = room.find(FIND_MY_STRUCTURES, {
          filter: function (s) {
            return s.structureType === STRUCTURE_LINK;
          }
        });
        if (allLinks && allLinks.length) {
          nearbyLinks = [BeeSelectors.selectClosestByRange(storagePos, allLinks)];
        }
      }

      var hubLink = BeeSelectors.selectClosestByRange(creep.pos, nearbyLinks);

      if (hubLink && hubLink.store) {
        var cap  = hubLink.store.getCapacity(RESOURCE_ENERGY) || 0;
        var used = hubLink.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        var fillPct = cap > 0 ? (used / cap) : 1;
        var free = cap - used;

        if (cap > 0 && fillPct < 0.80 && free > 0) {
          var reserved = getReserved(hubLink.id) || 0;
          var availForPlan = free - reserved;

          if (availForPlan > 0) {
            var planAmount = Math.min(amount, availForPlan);
            reserveFill(hubLink.id, planAmount);
            return createTask('deliver', hubLink.id, { sink: 'link_storage' });
          }
        }
      }
    }

    if (terminalJob && terminalJob.active && !terminalJob.paused && room.terminal && room.storage) {
      var claimOpen = !terminalJob.claimBy || terminalJob.claimBy === creep.name || (Game.time - (terminalJob.claimTick || 0) > 2);
      if (claimOpen) {
        var termFree = room.terminal.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
        var termEnergy = room.terminal.store[RESOURCE_ENERGY] || 0;
        var needed = Math.max(0, terminalJob.targetEnergy - termEnergy);
        if (termFree > 0 && needed > 0) {
          terminalJob.claimBy = creep.name;
          terminalJob.claimTick = Game.time;
          var termPlan = Math.min(amount, termFree, needed);
          reserveFill(room.terminal.id, termPlan);
          return createTask('deliver', room.terminal.id, { sink: 'terminal_job', amount: termPlan });
        }
      }
    }


    if (room.storage) {
      var storeFree = room.storage.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
      if (storeFree > 0) {
        return createTask('deliver', room.storage.id, { sink: 'storage' });
      }
    }

    if (room.terminal) {
      var termFree = room.terminal.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
      if (termFree > 0) {
        return createTask('deliver', room.terminal.id, { sink: 'terminal' });
      }
    }

    return null;
  }

  function chooseNextTask(creep) {
    if ((creep.store[RESOURCE_ENERGY] || 0) === 0) {
      var withdrawTask = pickWithdrawTask(creep);
      if (withdrawTask) return withdrawTask;
    } else {
      var deliverTask = pickDeliverTask(creep);
      if (deliverTask) return deliverTask;
    }
    return createIdleTask(creep);
  }

  function ensureActiveTask(creep) {
    ensureTaskSlot(creep);
    var task = creep.memory._task;
    if (needsNewTask(creep, task)) {
      releaseTerminalJobClaimIfHeld(creep);
      task = chooseNextTask(creep);
      setTask(creep, task);
    }
    task = creep.memory._task;
    if (!task) {
      task = createIdleTask(creep);
      setTask(creep, task);
    }
    return creep.memory._task;
  }

  function getQueenTaskPriority(task) {
    if (!task) return 0;
    return CFG.MOVE_PRIORITIES[task.type] || 0;
  }

  function getQueenTaskTarget(task) {
    if (!task || !task.targetId) return null;
    return Game.getObjectById(task.targetId);
  }

  function runQueenWithdrawState(creep) {
    var task = creep.memory._task;
    var target = getQueenTaskTarget(task);
    var priority = getQueenTaskPriority(task);
    if (!task || !target) { clearTask(creep); return; }
    drawLine(creep, target, CFG.DRAW.WITHDRAW, 'WD');
    debugSay(creep, '📥');
    var rc = BeeActions.safeWithdraw(creep, target, RESOURCE_ENERGY, { priority: priority, reusePath: 20 });
    if (rc === OK) {
      if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) clearTask(creep);
    } else if (rc === ERR_NOT_ENOUGH_RESOURCES || rc === ERR_INVALID_TARGET) {
      clearTask(creep);
    }
  }

  function runQueenPickupState(creep) {
    var task = creep.memory._task;
    var target = getQueenTaskTarget(task);
    var priority = getQueenTaskPriority(task);
    if (!task || !target) { clearTask(creep); return; }
    drawLine(creep, target, CFG.DRAW.PICKUP, 'P');
    debugSay(creep, '🍪');
    var pc = BeeActions.safePickup(creep, target, { priority: priority, reusePath: 10 });
    if (pc === OK) {
      if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) clearTask(creep);
    } else if (pc === ERR_INVALID_TARGET) {
      clearTask(creep);
    }
  }

  function runQueenDeliverState(creep) {
    var task = creep.memory._task;
    var target = getQueenTaskTarget(task);
    var priority = getQueenTaskPriority(task);
    if (!task || !target) { clearTask(creep); return; }
    drawLine(creep, target, CFG.DRAW.DELIVER, 'DL');
    debugSay(creep, '🚚');
    var transferAmount = null;
    if (task.data && task.data.sink === 'terminal_job' && typeof task.data.amount === 'number') {
      var targetFree = getFreeEnergyCapacity(target);
      var carryNow = creep.store[RESOURCE_ENERGY] || 0;
      transferAmount = Math.min(task.data.amount, targetFree, carryNow);
      if (transferAmount <= 0) {
        clearTask(creep);
        return;
      }
    }
    var tr = BeeActions.safeTransfer(creep, target, RESOURCE_ENERGY, transferAmount, { priority: priority, reusePath: 20 });
    if (tr === OK) {
      if (transferAmount != null && task.data && task.data.sink === 'terminal_job') {
        task.data.amount = Math.max(0, (task.data.amount || 0) - transferAmount);
      }
      if (task.data && task.data.sink === 'terminal_job' && (task.data.amount || 0) <= 0) {
        clearTask(creep);
        return;
      }
      if ((creep.store[RESOURCE_ENERGY] || 0) === 0) clearTask(creep);
    } else if (tr === ERR_FULL || tr === ERR_INVALID_TARGET) {
      releaseTerminalJobClaimIfHeld(creep);
      clearTask(creep);
    }
  }

  function runQueenIdleState(creep) {
    var task = creep.memory._task;
    if (!task || task.type !== 'idle') return;
    var pos = task.data && task.data.pos;
    if (!pos) return;
    var anchor = new RoomPosition(pos.x, pos.y, pos.roomName);
    var priority = getQueenTaskPriority(task);
    drawLine(creep, anchor, CFG.DRAW.IDLE, 'ID');
    MovementManager.request(creep, anchor, priority, { range: task.data.range || 1, reusePath: 30 });
  }

  var roleQueen = {
    role: 'Queen',
    run: function (creep) {
      if (!creep || creep.spawning) return;
      // Keep room-level terminal job state fresh every tick, even if this Queen
      // is currently withdrawing or idling. updateTerminalEnergyJob itself is
      // guarded so multiple Queens do not double-update.
      updateTerminalEnergyJob(creep.room);
      var state = determineQueenState(creep);

      if (state === 'WITHDRAW') { runQueenWithdrawState(creep); return; }
      if (state === 'PICKUP')   { runQueenPickupState(creep);   return; }
      if (state === 'DELIVER')  { runQueenDeliverState(creep);  return; }
      runQueenIdleState(creep);
    }
  };

module.exports = roleQueen;
