// -----------------------------------------------------------------------------
// Task.Queen.js – economy hauler role
// Responsibilities:
// * Keeps a single "Queen" creep ferrying energy between sources (drops, links,
//   tombstones, storage) and sinks (spawns/extensions/towers/storage terminals).
// * Interacts with BeeSelectors.js for prioritised lists of energy sources and
//   delivery targets, BeeActions.js for wrapped actions with movement, and
//   Movement.Manager.js for centralised pathing priorities.
// * Stores its finite-state machine in creep.memory._task (shape:
//   {type, targetId, since, data}) and clears/refreshes it when targets change
//   or run out of capacity.
// * Uses global.__BHM.queenReservations to avoid multiple Queens double-booking
//   the same sink in the same tick.
// Called from: TaskManager -> role dispatch -> BeeHiveMind.runCreeps -> TaskQueen.run.
// -----------------------------------------------------------------------------
'use strict';

// External selectors module; see BeeSelectors.js for source/sink scans.
var BeeSelectors = require('BeeSelectors');
// Shared action wrappers with movement intents.
var BeeActions = require('BeeActions');
// Central movement queue; TaskQueen enqueues idles here.
var MovementManager = require('Movement.Manager');

// Static configuration covering debug outputs, stuck detection, and movement
// priorities (higher numbers win when Movement.Manager resolves intents).
var CFG = Object.freeze({
  DEBUG_SAY: false,
  DEBUG_DRAW: true,
  DRAW: {
    WITHDRAW: '#69c3ff',
    DELIVER: '#7dff85',
    PICKUP: '#ffe66e',
    IDLE: '#bfbfbf',
    WIDTH: 0.12,
    OPACITY: 0.45,
    FONT: 0.6
  },
  STUCK_TICKS: 6,
  MOVE_PRIORITIES: {
    withdraw: 60,
    pickup: 70,
    deliver: 55,
    idle: 5
  }
});

// Function header: debugSay(creep, msg)
// Inputs: creep (Creep), msg (string emoji/text)
// Output: none
// Side-effects: optionally calls creep.say if CFG.DEBUG_SAY is true.
// Preconditions: creep must be live in same tick, msg must be printable.
// Failure modes: silently returns if debugging disabled or creep missing.
function debugSay(creep, msg) {
  if (CFG.DEBUG_SAY && creep && msg) creep.say(msg, true);
}

// Function header: drawLine(creep, target, color, label)
// Inputs: creep performing work, target (object with pos or RoomPosition),
//         color hex string, optional label string.
// Output: none
// Side-effects: uses RoomVisual to draw intent lines (visible in client when
//               CFG.DEBUG_DRAW is true).
// Preconditions: creep.room.visual must exist; target must be visible.
// Failure modes: try/catch absorbs RoomVisual errors (remote rooms).
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

// Function header: ensureTaskSlot(creep)
// Inputs: creep whose memory we initialise.
// Output: none
// Side-effects: ensures creep.memory._task exists (null placeholder) so later
//               code can read/write without guard checks.
// Preconditions: creep.memory defined (Screeps always provides an object).
function ensureTaskSlot(creep) {
  if (!creep || !creep.memory) return;
  if (!creep.memory._task) creep.memory._task = null;
}

// Function header: setTask(creep, task)
// Inputs: creep, task envelope {type,targetId,since,data}
// Output: none
// Side-effects: overwrites creep.memory._task; this is persisted in Memory and
//               survives restarts.
// Preconditions: ensureTaskSlot should have been called first.
function setTask(creep, task) {
  if (!creep || !creep.memory) return;
  creep.memory._task = task;
}

// Function header: clearTask(creep)
// Inputs: creep
// Output: none
// Side-effects: resets creep.memory._task to null; next tick needsNewTask will
//               select a new job.
function clearTask(creep) {
  if (!creep || !creep.memory) return;
  creep.memory._task = null;
}

// Function header: getReservationBucket()
// Inputs: none
// Output: object map targetId -> reserved energy (per tick)
// Side-effects: initialises global.__BHM.queenReservations for this tick; this
//               cache is reset every tick to prevent long-term drift.
// Preconditions: global.__BHM may already exist (BeeHiveMind initialises it).
function getReservationBucket() {
  if (!global.__BHM) global.__BHM = {};
  if (!global.__BHM.queenReservations || global.__BHM.queenReservations.tick !== Game.time) {
    global.__BHM.queenReservations = { tick: Game.time, map: {} };
  }
  return global.__BHM.queenReservations.map;
}

// Function header: reserveFill(targetId, amount)
// Inputs: targetId string, amount number (energy units planned to deliver)
// Output: none
// Side-effects: increments same-tick reservation counter so multiple Queens do
//               not overfill one structure.
function reserveFill(targetId, amount) {
  if (!targetId || amount <= 0) return;
  var map = getReservationBucket();
  var cur = map[targetId] || 0;
  map[targetId] = cur + amount;
}

// Function header: getReserved(targetId)
// Inputs: targetId string
// Output: number of energy units previously reserved this tick.
// Side-effects: none.
function getReserved(targetId) {
  if (!targetId) return 0;
  var map = getReservationBucket();
  return map[targetId] || 0;
}

// Function header: getEnergyStored(target)
// Inputs: structure/resource with store or energy property.
// Output: integer energy stored; handles structures with store or legacy energy.
// Side-effects: none.
function getEnergyStored(target) {
  if (!target) return 0;
  if (target.store) return target.store[RESOURCE_ENERGY] || 0;
  if (target.energy != null) return target.energy | 0;
  return 0;
}

// Function header: getFreeEnergyCapacity(target)
// Inputs: structure with energyCapacity/store.
// Output: how much additional energy target can accept.
// Side-effects: none.
function getFreeEnergyCapacity(target) {
  if (!target) return 0;
  if (target.store && target.store.getFreeCapacity) {
    return target.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
  }
  if (target.energyCapacity != null) {
    return (target.energyCapacity | 0) - (target.energy | 0);
  }
  return 0;
}

// Function header: createTask(type, targetId, data)
// Inputs: type string, targetId (may be null), extra data payload (object)
// Output: task envelope stored in creep.memory._task. since=Game.time for
//         debugging and stale-task detection.
// Side-effects: none (pure factory).
function createTask(type, targetId, data) {
  return {
    type: type,
    targetId: targetId || null,
    since: Game.time,
    data: data || {}
  };
}

// Function header: getIdleAnchor(creep)
// Inputs: creep
// Output: structure used as idle anchor (storage > spawn > controller).
// Side-effects: none; new RoomPosition created later if needed.
// Notes: ensures idling near "base" to clear traffic lanes.
function getIdleAnchor(creep) {
  if (!creep || !creep.room) return null;
  if (creep.room.storage) return creep.room.storage;
  var spawns = creep.room.find(FIND_MY_SPAWNS);
  if (spawns && spawns.length) return spawns[0];
  if (creep.room.controller) return creep.room.controller;
  return null;
}

// Function header: createIdleTask(creep)
// Inputs: creep
// Output: idle task envelope; task.data.pos stores static location and range.
// Side-effects: none.
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

// Function header: needsNewTask(creep, task)
// Inputs: creep, current task envelope (may be null)
// Output: boolean true when we must pick a fresh task (target gone, capacity
//         mismatch, stuck for too long).
// Side-effects: updates task.data.stuck and last position markers in-memory.
// Preconditions: task.data is an object (initialised if missing).
function needsNewTask(creep, task) {
  if (!task) return true;
  var target = task.targetId ? Game.getObjectById(task.targetId) : null;
  if (!task.data) task.data = {};

  if (task.type === 'withdraw') {
    // Withdraw task is invalid if target missing, creep already full, or
    // container depleted; this lets us switch to delivery/idle next tick.
    if (!target) return true;
    if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) return true;
    if (getEnergyStored(target) <= 0) return true;
  } else if (task.type === 'pickup') {
    // Dropped/tombstone tasks expire when energy is gone or creep is full.
    if (!target) return true;
    if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) return true;
    if (target.amount != null && target.amount <= 0) return true;
  } else if (task.type === 'deliver') {
    // Delivery tasks drop once the structure fills or we run out of cargo.
    if (!target) return true;
    if ((creep.store[RESOURCE_ENERGY] || 0) === 0) return true;
    if (getFreeEnergyCapacity(target) === 0) return true;
  } else if (task.type === 'idle') {
    // Always allow idle task to continue unless we have energy to move.
  }

  var data = task.data;
  if (data.lastPosX === creep.pos.x && data.lastPosY === creep.pos.y) {
    // Stuck detection: track consecutive ticks with no movement. Movement
    // priority conflicts (e.g., path blocked) cause us to repick a task, which
    // usually repaths to a new target or idles elsewhere.
    data.stuck = (data.stuck || 0) + 1;
    if (data.stuck >= CFG.STUCK_TICKS) return true;
  } else {
    // Movement happened; reset counter so task continues.
    data.stuck = 0;
    data.lastPosX = creep.pos.x;
    data.lastPosY = creep.pos.y;
  }

  return false;
}

// Function header: pickWithdrawTask(creep)
// Inputs: creep (Queen)
// Output: task envelope for withdrawing/picking up energy, prioritising drop
//         loot -> tombstones -> ruins -> containers -> other sources.
// Side-effects: none (no memory writes besides returned task).
// Dependencies: BeeSelectors.getEnergySourcePriority (see BeeSelectors.js).
function pickWithdrawTask(creep) {
  var room = creep.room;
  if (!room) return null;
  var list = BeeSelectors.getEnergySourcePriority(room);
  for (var i = 0; i < list.length; i++) {
    var entry = list[i];
    if (!entry || !entry.target) continue;
    if (entry.kind === 'source') continue; // Queens haul; harvesting wastes work body slots reserved for carry.
    if (entry.kind === 'drop') return createTask('pickup', entry.target.id, { source: 'drop' });
    if (entry.kind === 'tomb') return createTask('withdraw', entry.target.id, { source: 'tomb' });
    if (entry.kind === 'ruin') return createTask('withdraw', entry.target.id, { source: 'ruin' });
    return createTask('withdraw', entry.target.id, { source: entry.kind || 'energy' });
  }
  return null;
}

// Function header: pickDeliverTask(creep)
// Inputs: creep with energy cargo
// Output: task envelope targeting highest priority sink (spawn/extension,
//         then tower, then storage/terminal)
// Side-effects: reserves energy in global.__BHM.queenReservations to avoid
//               over-assigning same sink; writes to reservation map only.
// Dependencies: BeeSelectors.findSpawnLikeNeedingEnergy etc.
function pickDeliverTask(creep) {
  var room = creep.room;
  if (!room) return null;

  var amount = creep.store[RESOURCE_ENERGY] || 0;
  if (amount <= 0) return null;

  var spawnLike = BeeSelectors.findSpawnLikeNeedingEnergy(room);
  var bestSpawn = BeeSelectors.selectClosestByRange(creep.pos, spawnLike);
  if (bestSpawn) {
    var freeSpawn = getFreeEnergyCapacity(bestSpawn);
    if (freeSpawn > getReserved(bestSpawn.id)) {
      // Reserve just enough capacity so later Queens see reduced space.
      var planAmount = Math.min(freeSpawn, amount);
      reserveFill(bestSpawn.id, planAmount);
      return createTask('deliver', bestSpawn.id, { sink: 'spawn' });
    }
  }

  var towers = BeeSelectors.findTowersNeedingEnergy(room);
  var bestTower = BeeSelectors.selectClosestByRange(creep.pos, towers);
  if (bestTower) {
    var freeTower = getFreeEnergyCapacity(bestTower);
    if (freeTower > getReserved(bestTower.id)) {
      var planTower = Math.min(freeTower, amount);
      reserveFill(bestTower.id, planTower);
      return createTask('deliver', bestTower.id, { sink: 'tower' });
    }
  }

  if (room.storage) {
    var storeFree = room.storage.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
    if (storeFree > 0) {
      // Storage fallback ensures excess energy is banked instead of idling.
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

// Function header: chooseNextTask(creep)
// Inputs: creep (Queen)
// Output: new task envelope (withdraw/pickup/deliver/idle)
// Side-effects: none; pure decision based on current cargo and room state.
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

// Function header: executeTask(creep, task)
// Inputs: creep, task envelope currently stored in memory
// Output: none; issues actions via BeeActions.* wrappers and MovementManager.
// Side-effects: may clearTask (memory mutation), may reserve move intents, may
//               draw visuals. Branch per task.type ensures accurate action.
// Failure modes: handles missing targets by clearing and returning.
function executeTask(creep, task) {
  if (!task) return;
  var target = task.targetId ? Game.getObjectById(task.targetId) : null;
  var priority = CFG.MOVE_PRIORITIES[task.type] || 0;

  if (task.type === 'withdraw') {
    if (!target) { clearTask(creep); return; }
    drawLine(creep, target, CFG.DRAW.WITHDRAW, 'WD');
    debugSay(creep, '📥');
    // Calls BeeActions.safeWithdraw (BeeActions.js) which queues move intents
    // via Movement.Manager if not in range.
    var rc = BeeActions.safeWithdraw(creep, target, RESOURCE_ENERGY, { priority: priority, reusePath: 20 });
    if (rc === OK) {
      // When cargo full, release the task to select a delivery target next tick.
      if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) clearTask(creep);
    } else if (rc === ERR_NOT_ENOUGH_RESOURCES || rc === ERR_INVALID_TARGET) {
      // Source dried up or object vanished: clear so we re-scan.
      clearTask(creep);
    }
    return;
  }

  if (task.type === 'pickup') {
    if (!target) { clearTask(creep); return; }
    drawLine(creep, target, CFG.DRAW.PICKUP, 'P');
    debugSay(creep, '🍪');
    var pc = BeeActions.safePickup(creep, target, { priority: priority, reusePath: 10 });
    if (pc === OK) {
      if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) clearTask(creep);
    } else if (pc === ERR_INVALID_TARGET) {
      clearTask(creep);
    }
    return;
  }

  if (task.type === 'deliver') {
    if (!target) { clearTask(creep); return; }
    drawLine(creep, target, CFG.DRAW.DELIVER, 'DL');
    debugSay(creep, '🚚');
    // safeTransfer returns OK when energy actually transferred; ERR_FULL when
    // sink already filled by another hauler.
    var tr = BeeActions.safeTransfer(creep, target, RESOURCE_ENERGY, null, { priority: priority, reusePath: 20 });
    if (tr === OK) {
      if ((creep.store[RESOURCE_ENERGY] || 0) === 0) clearTask(creep);
    } else if (tr === ERR_FULL || tr === ERR_INVALID_TARGET) {
      clearTask(creep);
    }
    return;
  }

  if (task.type === 'idle') {
    var pos = task.data && task.data.pos;
    if (!pos) return;
    var anchor = new RoomPosition(pos.x, pos.y, pos.roomName);
    drawLine(creep, anchor, CFG.DRAW.IDLE, 'ID');
    // Idle behaviour simply holds position near anchor, giving way when
    // movement manager reuses path = 30 for stable parking.
    MovementManager.request(creep, anchor, priority, { range: task.data.range || 1, reusePath: 30 });
    return;
  }
}

var TaskQueen = {
  // Function header: run(creep)
  // Inputs: Queen creep dispatched from BeeHiveMind role loop.
  // Output: none; drives task selection/execution and updates memory.
  // Side-effects: may call MovementManager.request, BeeActions wrappers, and
  //               mutate creep.memory._task. No return value used by caller.
  // Preconditions: creep.role/task set elsewhere (BeeHiveMind.assignTask).
  // Failure modes: gracefully exits if creep is spawning or invalid.
  run: function (creep) {
    if (!creep || creep.spawning) return;
    ensureTaskSlot(creep);

    var task = creep.memory._task;
    if (needsNewTask(creep, task)) {
      // When stale/invalid, choose a fresh job. chooseNextTask encodes gather →
      // deliver → idle lifecycle.
      task = chooseNextTask(creep);
      setTask(creep, task);
    }

    task = creep.memory._task;
    if (!task) {
      // Last-resort idle ensures memory slot never empty (prevents null checks).
      setTask(creep, createIdleTask(creep));
      task = creep.memory._task;
    }

    executeTask(creep, task);
  }
};

module.exports = TaskQueen;