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

try { require('Traveler'); } catch (e) {}

var REFILL_MIN_AMOUNT = 150;
var REFILL_COOLDOWN_TICKS = 10;

function ensureExpansionSticky(creep) {
  if (!creep || !creep.memory) return false;

  var tgt = null;
  if (creep.memory.expand && creep.memory.expand.target) tgt = creep.memory.expand.target;
  if (!tgt && creep.memory.task === 'expand' && creep.memory.target) tgt = creep.memory.target;
  if (!tgt && creep.memory.task === 'expand' && creep.memory.targetRoom) tgt = creep.memory.targetRoom;

  if (!tgt) return false;

  if (!creep.memory._expand) {
    creep.memory._expand = { room: tgt, csiteId: null, lock: true, since: Game.time };
  } else {
    if (creep.memory._expand.room !== tgt) {
      creep.memory._expand.room = tgt;
    }
  }
  return true;
}

function isExpansionAssignment(creep) {
  if (!creep || !creep.memory) return false;
  if (creep.memory.expand && creep.memory.expand.target) return true;
  if (creep.memory.task === 'expand' && creep.memory.target) return true;
  if (creep.memory.task === 'expand' && creep.memory.targetRoom) return true;
  if (creep.memory._expand && creep.memory._expand.room) return true;
  return false;
}

function forbidGatherOutsideTarget(creep) {
  if (!isExpansionAssignment(creep)) return false;
  var roomName = null;
  if (creep.memory._expand && creep.memory._expand.room) roomName = creep.memory._expand.room;
  else if (creep.memory.target) roomName = creep.memory.target;
  else if (creep.memory.targetRoom) roomName = creep.memory.targetRoom;
  else if (creep.memory.expand && creep.memory.expand.target) roomName = creep.memory.expand.target;
  if (!roomName || !creep.room) return false;
  return creep.room.name !== roomName;
}

// Travel convenience; keep ES5 and your Traveler usage if available
function travelToRoomCenter(creep, roomName) {
  if (!creep || !roomName) return;
  var pos = new RoomPosition(25, 25, roomName);
  if (creep.moveTo) {
    if (creep.travelTo) creep.travelTo(pos, { reusePath: 15 });
    else creep.moveTo(pos, { reusePath: 15 });
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

function isInExpansionTargetRoom(creep) {
  if (!isExpansionAssignment(creep)) return false;
  var roomName = null;
  if (creep.memory._expand && creep.memory._expand.room) roomName = creep.memory._expand.room;
  else if (creep.memory.task === 'expand' && creep.memory.target) roomName = creep.memory.target;
  else if (creep.memory.task === 'expand' && creep.memory.targetRoom) roomName = creep.memory.targetRoom;
  else if (creep.memory.expand && creep.memory.expand.target) roomName = creep.memory.expand.target;
  if (!roomName) return false;
  return creep.room && creep.room.name === roomName;
}

function isSourceContainer(structure) {
  if (!structure || !structure.pos) return false;
  var sources = structure.pos.findInRange(FIND_SOURCES, 1);
  return sources && sources.length > 0;
}

function pickExpansionGatherTask(creep) {
  var room = creep.room;
  if (!room) return null;
  var list = BeeSelectors.getEnergySourcePriority(room);
  var i;
  for (i = 0; i < list.length; i++) {
    var entry = list[i];
    if (!entry || !entry.target) continue;
    if (entry.kind === 'drop') {
      return { type: 'pickup', targetId: entry.target.id, since: Game.time, data: { source: 'drop' } };
    }
  }
  var containerTarget = null;
  for (i = 0; i < list.length; i++) {
    var entry2 = list[i];
    if (!entry2 || !entry2.target) continue;
    if (entry2.kind === 'container' && entry2.target.structureType === STRUCTURE_CONTAINER && isSourceContainer(entry2.target)) {
      containerTarget = entry2.target;
      break;
    }
  }
  if (containerTarget) {
    return { type: 'withdraw', targetId: containerTarget.id, since: Game.time, data: { source: 'container' } };
  }
  for (i = 0; i < list.length; i++) {
    var entry3 = list[i];
    if (!entry3 || !entry3.target) continue;
    if (entry3.kind === 'ruin') {
      return { type: 'withdraw', targetId: entry3.target.id, since: Game.time, data: { source: 'ruin' } };
    }
  }
  for (i = 0; i < list.length; i++) {
    var entry4 = list[i];
    if (!entry4 || !entry4.target) continue;
    if (entry4.kind === 'tomb') {
      return { type: 'withdraw', targetId: entry4.target.id, since: Game.time, data: { source: 'tomb' } };
    }
  }
  for (i = 0; i < list.length; i++) {
    var entry5 = list[i];
    if (!entry5 || !entry5.target) continue;
    if (entry5.kind === 'source') {
      return { type: 'harvest', targetId: entry5.target.id, since: Game.time, data: { source: 'source' } };
    }
  }
  return null;
}

// Expansion-specific behavior: travel, drop a spawn site, and focus build orders when flagged.
function handleExpansionBuilder(creep) {
  if (!isExpansionAssignment(creep)) return 'noop';

  ensureExpansionSticky(creep);
  var targetRoom = creep.memory._expand ? creep.memory._expand.room : (creep.memory.target || creep.memory.targetRoom || null);
  if (!targetRoom) return 'noop';

  if (creep.room.name !== targetRoom) {
    clearTask(creep);
    debugSay(creep, '➡️ ' + targetRoom);
    travelToRoomCenter(creep, targetRoom);
    return 'traveling';
  }

  var remembered = null;
  if (creep.memory._expand && creep.memory._expand.csiteId) {
    remembered = Game.getObjectById(creep.memory._expand.csiteId);
    if (!remembered) {
      creep.memory._expand.csiteId = null;
      remembered = null;
    }
  }

  var spawnTarget = remembered || ensureExpansionSpawnSite(creep.room);
  if (!spawnTarget) return 'setup';

  if (spawnTarget.structureType === STRUCTURE_SPAWN && spawnTarget.progressTotal == null) {
    return 'target';
  }

  if (creep.memory._expand) creep.memory._expand.csiteId = spawnTarget.id;

  drawLine(creep, spawnTarget, CFG.DRAW.BUILD, 'EXPAND');

  if (!creep.memory._task || creep.memory._task.targetId !== spawnTarget.id || creep.memory._task.type !== 'build') {
    creep.memory._task = {
      type: 'build',
      targetId: spawnTarget.id,
      since: Game.time,
      data: { structureType: STRUCTURE_SPAWN }
    };
    debugSay(creep, '🏗️ spawn');
  }

  return 'setup';
}

var CFG = Object.freeze({
  DEBUG_SAY: true,
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
  var isExpansion = isExpansionAssignment(creep);
  var inTargetRoom = isInExpansionTargetRoom(creep);
  var energyCarried = 0;
  if (creep.store && creep.store[RESOURCE_ENERGY] != null) energyCarried = creep.store[RESOURCE_ENERGY] | 0;
  else if (creep.carry && creep.carry[RESOURCE_ENERGY] != null) energyCarried = creep.carry[RESOURCE_ENERGY] | 0;

  if (isExpansion && !inTargetRoom && energyCarried === 0) {
    var onCooldown = false;
    if (creep.memory && creep.memory._expandRefillTs != null) {
      onCooldown = (Game.time - creep.memory._expandRefillTs) < REFILL_COOLDOWN_TICKS;
    }
    if (!onCooldown) {
      var roomHasEnergy = BeeSelectors.roomHasAnyEnergy(creep.room, REFILL_MIN_AMOUNT);
      if (!roomHasEnergy) {
        var homeStorage = BeeSelectors.findHomeStorageWithEnergy(creep, REFILL_MIN_AMOUNT);
        if (homeStorage) {
          if (creep.memory) creep.memory._expandRefillTs = Game.time;
          debugSay(creep, '🏠🔋');
          drawLine(creep, homeStorage, CFG.DRAW.GATHER, 'REFILL');
          return {
            type: 'withdraw',
            targetId: homeStorage.id,
            since: Game.time,
            data: { source: 'homeStorage', room: homeStorage.pos ? homeStorage.pos.roomName : null }
          };
        }
      }
    }
  }

  if (forbidGatherOutsideTarget(creep)) {
    return null;
  }
  var room = creep.room;
  if (inTargetRoom) {
    var expansionTask = pickExpansionGatherTask(creep);
    if (expansionTask) return expansionTask;
  }
  var list = BeeSelectors.getEnergySourcePriority(room);

  for (var i = 0; i < list.length; i++) {
    var entry = list[i];
    if (!entry || !entry.target) continue;
    if (isExpansionAssignment(creep)) {
      if (entry.kind === 'storage' || entry.kind === 'terminal') continue;
    }
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
  if (isExpansionAssignment(creep)) {
    var targetRoom = null;
    if (creep.memory._expand && creep.memory._expand.room) targetRoom = creep.memory._expand.room;
    else if (creep.memory.task === 'expand' && creep.memory.target) targetRoom = creep.memory.target;
    else if (creep.memory.task === 'expand' && creep.memory.targetRoom) targetRoom = creep.memory.targetRoom;
    else if (creep.memory.expand && creep.memory.expand.target) targetRoom = creep.memory.expand.target;
    if (targetRoom && creep.room.name !== targetRoom) {
      return null;
    }
  }
  var room = creep.room;
  var site = BeeSelectors.findBestConstructionSite(room);
  if (site) {
    return { type: 'build', targetId: site.id, since: Game.time, data: { structureType: site.structureType } };
  }
  if (room && creep && creep.memory) {
    var remoteRoomName = BeeSelectors.findAdjacentRoomWithConstruction(room.name);
    if (remoteRoomName && !isExpansionAssignment(creep)) {
      if (!creep.memory.expand) creep.memory.expand = {};
      creep.memory.expand.target = remoteRoomName;
      return null;
    }
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

  //var target = task.targetId ? Game.getObjectById(task.targetId) : null;

  var target;
    if (task.targetId) {
      target = Game.getObjectById(task.targetId);
    } else {
      target = null;
    }

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
    var expansionState = handleExpansionBuilder(creep);
    if (expansionState === 'traveling') return;
    ensureTask(creep);
    var task = creep.memory._task;
    if (isExpansionAssignment(creep)) {
      var expandRoom = null;
      if (creep.memory._expand && creep.memory._expand.room) expandRoom = creep.memory._expand.room;
      else if (creep.memory.task === 'expand' && creep.memory.target) expandRoom = creep.memory.target;
      else if (creep.memory.task === 'expand' && creep.memory.targetRoom) expandRoom = creep.memory.targetRoom;
      else if (creep.memory.expand && creep.memory.expand.target) expandRoom = creep.memory.expand.target;
      if (expandRoom && creep.room.name !== expandRoom) {
        clearTask(creep);
        return;
      }
    }
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
