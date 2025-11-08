'use strict';

/**
 * What changed & why:
 * - Reworked builder logic around persistent _task envelopes to prevent per-tick target churn.
 * - Adopted BeeSelectors/BeeActions plus centralized movement intents so refuel/build/repair phases reuse caches.
 * - Added guarded debug breadcrumbs and idle anchoring that respects the MOVE phase resolver.
 */

var BeeSelectors = require('BeeSelectors');
var BeeActions = require('BeeActions');
var MovementManager = require('Movement.Manager');
var SpawnPlacement = require('Planner.SpawnPlacement');

// Expansion helper: detect builders earmarked for forward operating base work.
function isExpansionAssignment(creep) {
  if (!creep || !creep.memory) return false;
  if (creep.memory.task === 'expand' && creep.memory.target) return true;
  if (creep.memory.expand && creep.memory.expand.target) {
    if (!creep.memory.target) creep.memory.target = creep.memory.expand.target;
    creep.memory.task = 'expand';
    return true;
  }
  return false;
}

// Expansion helper: use Traveler routing toward a room's approximate center.
function travelToRoomCenter(creep, roomName) {
  if (!creep || !roomName) return;
  var targetPos = new RoomPosition(25, 25, roomName);
  if (creep.travelTo) {
    creep.travelTo(targetPos, { range: 20, reusePath: 40 });
  } else {
    creep.moveTo(targetPos, { reusePath: 40 });
  }
}

// Expansion helper: reuse an existing spawn (structure/site) if one is already present.
function findExpansionSpawnTarget(room) {
  if (!room) return null;
  var built = room.find(FIND_MY_STRUCTURES, {
    filter: function (s) { return s.structureType === STRUCTURE_SPAWN; }
  });
  if (built && built.length > 0) return built[0];
  var sites = room.find(FIND_MY_CONSTRUCTION_SITES, {
    filter: function (s) { return s.structureType === STRUCTURE_SPAWN; }
  });
  if (sites && sites.length > 0) return sites[0];
  return null;
}

// Expansion helper: delegate spawn placement to Planner.SpawnPlacement for idempotent placement.
function ensureExpansionSpawnSite(room) {
  if (!room) return null;
  var existing = findExpansionSpawnTarget(room);
  if (existing) return existing;
  if (!SpawnPlacement.placeInitialSpawnSite(room)) return null;
  return findExpansionSpawnTarget(room);
}

// Expansion-specific behavior: travel, drop a spawn site, and focus build orders when flagged.
function handleExpansionBuilder(creep) {
  if (!isExpansionAssignment(creep)) return false;
  var targetRoom = creep.memory.target;
  if (!targetRoom) return false;
  if (creep.room.name !== targetRoom) {
    travelToRoomCenter(creep, targetRoom);
    return true;
  }
  var room = creep.room;
  var spawnTarget = ensureExpansionSpawnSite(room);
  if (!spawnTarget) return false;
  if (spawnTarget.structureType === STRUCTURE_SPAWN) {
    return false;
  }
  if (!creep.memory._task || creep.memory._task.targetId !== spawnTarget.id || creep.memory._task.type !== 'build') {
    creep.memory._task = {
      type: 'build',
      targetId: spawnTarget.id,
      since: Game.time,
      data: { structureType: STRUCTURE_SPAWN }
    };
  }
  return false;
}

var CFG = Object.freeze({
  DEBUG_SAY: false,
  DEBUG_DRAW: true,
  DRAW: {
    GATHER: '#6ec1ff',
    BUILD: '#e6c16e',
    REPAIR: '#ffa36e',
    DELIVER: '#6effa1',
    IDLE: '#bfbfbf',
    WIDTH: 0.12,
    OPACITY: 0.45,
    FONT: 0.6
  },
  STUCK_TICKS: 6,
  MOVE_PRIORITIES: {
    gather: 55,
    build: 35,
    repair: 30,
    deliver: 20,
    idle: 5
  }
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

function clearTask(creep) {
  if (!creep.memory) return;
  creep.memory._task = null;
}

function updateStuckTracker(task, creep) {
  if (!task.data) task.data = {};
  if (task.data.lastX === creep.pos.x && task.data.lastY === creep.pos.y) {
    task.data.stuckFor = (task.data.stuckFor | 0) + 1;
  } else {
    task.data.stuckFor = 0;
    task.data.lastX = creep.pos.x;
    task.data.lastY = creep.pos.y;
  }
  return task.data.stuckFor >= CFG.STUCK_TICKS;
}

function needNewTask(creep, task) {
  if (!task) return true;
  var target = task.targetId ? Game.getObjectById(task.targetId) : null;
  if (task.type === 'idle') return false;
  if (!target && task.type !== 'deliver') return true;
  switch (task.type) {
    case 'withdraw':
      if (!target || !target.store || (target.store[RESOURCE_ENERGY] | 0) === 0) return true;
      if (creep.store.getFreeCapacity() === 0) return true;
      break;
    case 'pickup':
      if (!target || target.amount <= 0) return true;
      if (creep.store.getFreeCapacity() === 0) return true;
      break;
    case 'harvest':
      if (!target) return true;
      if (creep.store.getFreeCapacity() === 0) return true;
      if (target.energy != null && target.energy === 0 && target.ticksToRegeneration > 1) return true;
      break;
    case 'build':
      if (!target) return true;
      if (creep.store[RESOURCE_ENERGY] === 0) return true;
      break;
    case 'repair':
      if (!target) return true;
      if (creep.store[RESOURCE_ENERGY] === 0) return true;
      if (task.data && task.data.goalHits && target.hits >= task.data.goalHits) return true;
      if (target.hits >= target.hitsMax) return true;
      break;
    case 'deliver':
      if (creep.store[RESOURCE_ENERGY] === 0) return true;
      if (!target) return true;
      if (!target.store) {
        if (target.energyCapacity != null && (target.energy | 0) >= (target.energyCapacity | 0)) return true;
      } else if (target.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
        return true;
      }
      break;
  }
  if (updateStuckTracker(task, creep)) return true;
  return false;
}

function pickGatherTask(creep) {
  var room = creep.room;
  var list = BeeSelectors.getEnergySourcePriority(room);
  for (var i = 0; i < list.length; i++) {
    var entry = list[i];
    if (!entry || !entry.target) continue;
    if (entry.kind === 'drop') {
      return { type: 'pickup', targetId: entry.target.id, since: Game.time, data: { source: 'drop' } };
    }
    if (entry.kind === 'tomb') {
      return { type: 'withdraw', targetId: entry.target.id, since: Game.time, data: { source: 'tomb' } };
    }
    if (entry.kind === 'ruin') {
      return { type: 'withdraw', targetId: entry.target.id, since: Game.time, data: { source: 'ruin' } };
    }
    if (entry.kind === 'source') {
      return { type: 'harvest', targetId: entry.target.id, since: Game.time, data: { source: 'source' } };
    }
    return { type: 'withdraw', targetId: entry.target.id, since: Game.time, data: { source: entry.kind || 'energy' } };
  }
  return null;
}

function pickWorkTask(creep) {
  var room = creep.room;
  var site = BeeSelectors.findBestConstructionSite(room);
  if (site) {
    return { type: 'build', targetId: site.id, since: Game.time, data: { structureType: site.structureType } };
  }
  var repair = BeeSelectors.findBestRepairTarget(room);
  if (repair && repair.target) {
    return {
      type: 'repair',
      targetId: repair.target.id,
      since: Game.time,
      data: { goalHits: repair.goalHits, structureType: repair.target.structureType }
    };
  }
  var sinks = BeeSelectors.findSpawnLikeNeedingEnergy(room);
  var deliverTarget = BeeSelectors.selectClosestByRange(creep.pos, sinks);
  if (deliverTarget) {
    return { type: 'deliver', targetId: deliverTarget.id, since: Game.time, data: { sink: 'spawnLike' } };
  }
  var towers = BeeSelectors.findTowersNeedingEnergy(room);
  var towerTarget = BeeSelectors.selectClosestByRange(creep.pos, towers);
  if (towerTarget) {
    return { type: 'deliver', targetId: towerTarget.id, since: Game.time, data: { sink: 'tower' } };
  }
  var storage = BeeSelectors.findStorageNeedingEnergy(room);
  if (storage) {
    return { type: 'deliver', targetId: storage.id, since: Game.time, data: { sink: 'storage' } };
  }
  return null;
}

function describeTask(task) {
  if (!task) return 'idle';
  if (task.type === 'build') return 'build';
  if (task.type === 'repair') return 'repair';
  if (task.type === 'deliver') return 'deliver';
  if (task.type === 'withdraw') return 'refuel';
  if (task.type === 'pickup') return 'refuel';
  return task.type;
}

function executeTask(creep, task) {
  if (!task) return;
  var target = task.targetId ? Game.getObjectById(task.targetId) : null;
  if (!target && task.type !== 'deliver') {
    clearTask(creep);
    return;
  }
  switch (task.type) {
    case 'withdraw':
      if (!target) { clearTask(creep); return; }
      drawLine(creep, target, CFG.DRAW.GATHER, 'WD');
      debugSay(creep, '📦');
      var wOpts = { priority: CFG.MOVE_PRIORITIES.gather, reusePath: 20 };
      var wrc = BeeActions.safeWithdraw(creep, target, RESOURCE_ENERGY, wOpts);
      if (wrc === OK && creep.store.getFreeCapacity() === 0) clearTask(creep);
      if (wrc === ERR_NOT_ENOUGH_RESOURCES || wrc === ERR_INVALID_TARGET) clearTask(creep);
      return;
    case 'pickup':
      if (!target) { clearTask(creep); return; }
      drawLine(creep, target, CFG.DRAW.GATHER, 'PICK');
      debugSay(creep, '🍪');
      var pOpts = { priority: CFG.MOVE_PRIORITIES.gather, reusePath: 10 };
      var prc = BeeActions.safePickup(creep, target, pOpts);
      if (prc === OK && creep.store.getFreeCapacity() === 0) clearTask(creep);
      if (prc === ERR_INVALID_TARGET) clearTask(creep);
      return;
    case 'build':
      if (!target) { clearTask(creep); return; }
      drawLine(creep, target, CFG.DRAW.BUILD, 'BUILD');
      debugSay(creep, '🔨');
      var bOpts = { priority: CFG.MOVE_PRIORITIES.build, reusePath: 15 };
      var brc = BeeActions.safeBuild(creep, target, bOpts);
      if (brc === ERR_NOT_ENOUGH_RESOURCES) clearTask(creep);
      if (brc === ERR_INVALID_TARGET) clearTask(creep);
      if (brc === OK && target.progress >= target.progressTotal) clearTask(creep);
      return;
    case 'repair':
      if (!target) { clearTask(creep); return; }
      drawLine(creep, target, CFG.DRAW.REPAIR, 'FIX');
      debugSay(creep, '🛠️');
      var rOpts = { priority: CFG.MOVE_PRIORITIES.repair, reusePath: 15 };
      var rrc = BeeActions.safeRepair(creep, target, rOpts);
      if (rrc === ERR_NOT_ENOUGH_RESOURCES) clearTask(creep);
      if (rrc === ERR_INVALID_TARGET) clearTask(creep);
      if (rrc === OK) {
        var goal = (task.data && task.data.goalHits) || target.hitsMax;
        if (target.hits >= goal) clearTask(creep);
      }
      return;
    case 'deliver':
      if (!target) { clearTask(creep); return; }
      drawLine(creep, target, CFG.DRAW.DELIVER, 'DEL');
      debugSay(creep, '📤');
      var dOpts = { priority: CFG.MOVE_PRIORITIES.deliver, reusePath: 20 };
      var drc = BeeActions.safeTransfer(creep, target, RESOURCE_ENERGY, null, dOpts);
      if (drc === ERR_NOT_ENOUGH_RESOURCES) clearTask(creep);
      if (drc === ERR_INVALID_TARGET) clearTask(creep);
      if (drc === OK && creep.store[RESOURCE_ENERGY] === 0) clearTask(creep);
      return;
    case 'harvest':
      if (!target) { clearTask(creep); return; }
      drawLine(creep, target, CFG.DRAW.GATHER, 'HAR');
      debugSay(creep, '⛏️');
      var hOpts = { priority: CFG.MOVE_PRIORITIES.gather, reusePath: 5 };
      var hrc = BeeActions.safeHarvest(creep, target, hOpts);
      if (hrc === OK && creep.store.getFreeCapacity() === 0) clearTask(creep);
      if (hrc === ERR_INVALID_TARGET) clearTask(creep);
      return;
  }
  clearTask(creep);
}

function idle(creep) {
  var anchor = BeeSelectors.findRoomAnchor(creep.room);
  if (anchor && anchor.pos) {
    drawLine(creep, anchor, CFG.DRAW.IDLE, 'IDLE');
    MovementManager.request(creep, anchor, CFG.MOVE_PRIORITIES.idle, { range: 2, reusePath: 30 });
  }
  debugSay(creep, '🧘');
}

var TaskBuilder = {
  run: function (creep) {
    if (!creep || creep.spawning) return;
    if (handleExpansionBuilder(creep)) return;
    ensureTask(creep);
    var task = creep.memory._task;
    if (needNewTask(creep, task)) {
      clearTask(creep);
      task = (creep.store[RESOURCE_ENERGY] === 0)
        ? pickGatherTask(creep)
        : pickWorkTask(creep);
      if (task) {
        task.since = Game.time;
        creep.memory._task = task;
        debugSay(creep, describeTask(task));
      }
    }
    task = creep.memory._task;
    if (task) {
      executeTask(creep, task);
      return;
    }
    idle(creep);
  }
};

module.exports = TaskBuilder;
