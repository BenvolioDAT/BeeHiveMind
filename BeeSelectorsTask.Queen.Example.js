'use strict';

var BeeSelectors = require('BeeSelectors');
var BeeActions = require('BeeActions');
var MovementManager = require('Movement.Manager');

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

function ensureTaskSlot(creep) {
  if (!creep || !creep.memory) return;
  if (!creep.memory._task) creep.memory._task = null;
}

function setTask(creep, task) {
  if (!creep || !creep.memory) return;
  creep.memory._task = task;
}

function clearTask(creep) {
  if (!creep || !creep.memory) return;
  creep.memory._task = null;
}

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
  if (target.energy != null) return target.energy | 0;
  return 0;
}

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
    // Always allow idle task to continue unless we have energy to move.
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

function pickWithdrawTask(creep) {
  var room = creep.room;
  if (!room) return null;
  var list = BeeSelectors.getEnergySourcePriority(room);
  for (var i = 0; i < list.length; i++) {
    var entry = list[i];
    if (!entry || !entry.target) continue;
    if (entry.kind === 'source') continue; // queens haul; harvesting wastes work body slots.
    if (entry.kind === 'drop') return createTask('pickup', entry.target.id, { source: 'drop' });
    if (entry.kind === 'tomb') return createTask('withdraw', entry.target.id, { source: 'tomb' });
    if (entry.kind === 'ruin') return createTask('withdraw', entry.target.id, { source: 'ruin' });
    return createTask('withdraw', entry.target.id, { source: entry.kind || 'energy' });
  }
  return null;
}

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

function executeTask(creep, task) {
  if (!task) return;
  var target = task.targetId ? Game.getObjectById(task.targetId) : null;
  var priority = CFG.MOVE_PRIORITIES[task.type] || 0;

  if (task.type === 'withdraw') {
    if (!target) { clearTask(creep); return; }
    drawLine(creep, target, CFG.DRAW.WITHDRAW, 'WD');
    debugSay(creep, '📥');
    var rc = BeeActions.safeWithdraw(creep, target, RESOURCE_ENERGY, { priority: priority, reusePath: 20 });
    if (rc === OK) {
      if (creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) clearTask(creep);
    } else if (rc === ERR_NOT_ENOUGH_RESOURCES || rc === ERR_INVALID_TARGET) {
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
    MovementManager.request(creep, anchor, priority, { range: task.data.range || 1, reusePath: 30 });
    return;
  }
}

var TaskQueen = {
  run: function (creep) {
    if (!creep || creep.spawning) return;
    ensureTaskSlot(creep);

    var task = creep.memory._task;
    if (needsNewTask(creep, task)) {
      task = chooseNextTask(creep);
      setTask(creep, task);
    }

    task = creep.memory._task;
    if (!task) {
      setTask(creep, createIdleTask(creep));
      task = creep.memory._task;
    }

    executeTask(creep, task);
  }
};

module.exports = TaskQueen;


///////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////


/**
 * TaskQueen — Energy Distributor (“Queen”)
 *
 * PURPOSE
 *   Moves energy from sources (storage/containers/drops) into needy structures
 *   (extensions, spawns, towers, link-near-spawn, terminal, storage) with:
 *     - Sticky targets (keep filling the same structure across ticks if possible)
 *     - Per-tick reservations to avoid double-filling the same structure
 *     - A simple Predictive Intent Buffer (PIB) to subtract “in-flight” energy
 *       other creeps are already carrying toward a target
 *     - Lightweight per-room caches recomputed once per tick
 *
 * WITHDRAWAL PRIORITY (updated)
 *   1) Dropped energy (closest)
 *   2) Storage (if it has energy)
 *   3) Side containers (NOT near sources)
 *   4) Source “seat” containers (adjacent to sources)  ← last resort
 *
 * MEMORY CONTRACT (creep)
 *   creep.memory.qTargetId        -> sticky fill target id (structure)
 *   creep.memory.qLastWithdrawId  -> last structure id we withdrew from
 *   creep.memory.qLastWithdrawAt  -> Game.time when we last withdrew
 *
 * MEMORY CONTRACT (global/tick-scoped)
 *   Memory._queenRes              -> { tick, map } same-tick “fill reservations”
 *   Memory._PIB                   -> { tick, rooms: { [roomName]: { fills: { [targetId]: { [creepName]: {res, amount, untilTick} } } } } }
 *   global.__QUEEN                -> { tick, byRoom } per-room derived caches for the tick
 *
 * STYLE
 *   ES5-safe (no const/let/arrow). Comments explain each step and intent.
 *   Movement prefers BeeToolbox.BeeTravel if present (often wraps Traveler).
 */

var BeeToolbox = require('BeeToolbox');

// ============================
// Tunables
// ============================
var CFG = Object.freeze({
  PATH_REUSE: 30,           // Reuse paths to reduce pathfinder CPU
  MAX_OPS: 2000,            // Upper bound for PathFinder ops (fallback moveTo)
  TOWER_REFILL_PCT: 0.80,   // Refill towers at or below 80% energy
  DEBUG_SAY: false,          // creep.say breadcrumbs
  DEBUG_DRAW: true,         // RoomVisual lines/labels
  DRAW: {
    WD_COLOR: "#6ec1ff",    // Withdraw lane color
    FILL_COLOR: "#6effa1",  // Fill lane color
    DROP_COLOR: "#ffe66e",  // Dropped resource pursuit color
    SRC_COLOR: "#ff9a6e",   // Source color (unused here but kept for consistency)
    IDLE_COLOR: "#bfbfbf",  // Idle anchor color
    STICK_COLOR: "#aaffaa", // Sticky target color
    WIDTH: 0.12,            // Line width
    OPACITY: 0.45,          // Visual opacity
    FONT: 0.6               // Label font size
  }
});

// ============================
// Movement / Utils
// ============================

/**
 * go(creep, dest, range?)
 *   Unified movement helper.
 *   - If BeeToolbox.BeeTravel exists, use it (supports reusePath)
 *   - Else fallback to moveTo with reusePath/MAX_OPS
 *   - Only moves when out of desired range
 */
function go(creep, dest, range) {
  range = (range != null) ? range : 1;

  // Prefer your custom traveler wrapper if available
  if (BeeToolbox && BeeToolbox.BeeTravel) {
    try {
      BeeToolbox.BeeTravel(creep, dest, { range: range, reusePath: CFG.PATH_REUSE });
      return;
    } catch (e) {}
  }

  // Fallback to vanilla moveTo with sane caps
  if (creep.pos.getRangeTo(dest) > range) {
    creep.moveTo(dest, { reusePath: CFG.PATH_REUSE, maxOps: CFG.MAX_OPS });
  }
}

/**
 * debugSay(creep, msg)
 *   Conditionally say text (quiet switchable via CFG.DEBUG_SAY)
 */
function debugSay(creep, msg) {
  if (CFG.DEBUG_SAY) creep.say(msg, true);
}

/**
 * debugDraw(creep, target, color, label)
 *   Draws a line from creep to target + optional label.
 *   - Only renders if both are in the same room (RoomVisual is per-room)
 *   - Safe-guards around missing room.visual
 */
function debugDraw(creep, target, color, label) {
  if (!CFG.DEBUG_DRAW || !creep || !target) return;
  var room = creep.room;
  if (!room || !room.visual) return;

  // Respect RoomVisual scoping: only draw if the target is in this room
  var tpos = target.pos || (target.position || null);
  if (!tpos || tpos.roomName !== room.name) return;

  try {
    room.visual.line(creep.pos, tpos, {
      color: color,
      width: CFG.DRAW.WIDTH,
      opacity: CFG.DRAW.OPACITY,
      lineStyle: "solid"
    });
    if (label) {
      room.visual.text(label, tpos.x, tpos.y - 0.3, {
        color: color,
        opacity: CFG.DRAW.OPACITY,
        font: CFG.DRAW.FONT,
        align: "center"
      });
    }
  } catch (e) {}
}

/**
 * firstSpawn(room)
 *   Convenience: pick the first owned spawn in the room (anchor for idling)
 */
function firstSpawn(room) {
  var ss = room.find(FIND_MY_SPAWNS);
  return ss.length ? ss[0] : null;
}

/**
 * isContainerNearSource(structure)
 *   A container within ≤1 tile of a source is treated as “source/seat container”.
 *   Queen prefers “side containers” (not near sources) for withdraws and only
 *   touches these seat containers as a last resort to avoid starving miners.
 */
function isContainerNearSource(structure) {
  // ≤1 tile counts as a “seat” container on the source
  return structure.pos.findInRange(FIND_SOURCES, 1).length > 0;
}

/**
 * nearestByRange(pos, arr)
 *   Manual nearest-by-range (no pathing) utility
 */
function nearestByRange(pos, arr) {
  var best = null, bestD = 1e9;
  for (var i = 0; i < arr.length; i++) {
    var o = arr[i]; if (!o) continue;
    var d = pos.getRangeTo(o);
    if (d < bestD) { bestD = d; best = o; }
  }
  return best;
}

/**
 * withdrawFrom(creep, target, res=RESOURCE_ENERGY)
 *   Wrapper for creep.withdraw with:
 *     - Range handling via go()
 *     - Memory bookkeeping (qLastWithdrawId/At) on success
 */
function withdrawFrom(creep, target, res) {
  res = res || RESOURCE_ENERGY;
  var rc = creep.withdraw(target, res);
  if (rc === ERR_NOT_IN_RANGE) { go(creep, target); return rc; }
  if (rc === OK) {
    creep.memory.qLastWithdrawId = target.id;
    creep.memory.qLastWithdrawAt = Game.time;
  }
  return rc;
}

// ============================
// Per-tick Queen fill reservations
//   These are *per tick* reservations (not persisted across ticks).
//   They ensure we don't over-commit the same structure in a single tick
//   when multiple Queens act concurrently.
// ============================

/**
 * _qrMap()
 *   Get-or-create the current tick reservation map:
 *   Memory._queenRes = { tick: Game.time, map: { [structId]: reservedAmount } }
 */
function _qrMap() {
  if (!Memory._queenRes || Memory._queenRes.tick !== Game.time) {
    Memory._queenRes = { tick: Game.time, map: {} };
  }
  return Memory._queenRes.map;
}

/**
 * _reservedFor(structId)
 *   Return how much energy is already reserved (this tick) for structId.
 */
function _reservedFor(structId) {
  var map = _qrMap();
  return map[structId] || 0;
}

// ============================
// Predictive Intent Buffer (PIB)
//   Short-lived “in-flight” reservations across creeps/rooms that subtract
//   from a structure’s effective free capacity *until* ETA expires.
//   This reduces "ping-pong" & “dog-pile the same target”.
// ============================

/**
 * _pibRoot()
 *   Initializes/reset PIB root per tick while preserving the per-room maps.
 *   Structure: Memory._PIB = { tick, rooms: { [roomName]: { fills: { targetId: { creepName: {res, amount, untilTick} } } } } }
 */
function _pibRoot() {
  var root = Memory._PIB;
  if (!root || root.tick !== Game.time) {
    Memory._PIB = { tick: Game.time, rooms: root && root.rooms ? root.rooms : {} };
  }
  return Memory._PIB;
}

/**
 * _pibRoom(roomName)
 *   Ensure a room bucket exists for PIB fills accounting.
 */
function _pibRoom(roomName) {
  var root = _pibRoot();
  var rooms = root.rooms;
  if (!rooms[roomName]) rooms[roomName] = { fills: {} };
  return rooms[roomName];
}

/**
 * _pibSumReserved(roomName, targetId, resourceType=ENERGY)
 *   Sum valid (not expired) in-flight reservations for a target.
 *   - Cleans up expired records as it goes
 *   - Deletes empty target maps to keep memory tidy
 */
function _pibSumReserved(roomName, targetId, resourceType) {
  resourceType = resourceType || RESOURCE_ENERGY;
  var R = _pibRoom(roomName);
  var byCreep = (R.fills[targetId] || {});
  var total = 0;
  for (var cname in byCreep) {
    if (!byCreep.hasOwnProperty(cname)) continue;
    var rec = byCreep[cname];
    if (!rec || rec.res !== resourceType) continue;
    if (rec.untilTick > Game.time) total += (rec.amount | 0);
    else delete byCreep[cname]; // expired
  }
  if (Object.keys(byCreep).length === 0) delete R.fills[targetId];
  return total;
}

/**
 * _pibReserveFill(creep, target, amount, resourceType=ENERGY)
 *   Record that this creep intends to deliver `amount` of `resourceType`
 *   to `target`, with a simple ETA (range-based TTL).
 *   Returns the integer amount stored (or 0 on failure).
 */
function _pibReserveFill(creep, target, amount, resourceType) {
  if (!creep || !target || !amount) return 0;
  resourceType = resourceType || RESOURCE_ENERGY;

  var roomName = (creep.room && creep.room.name) || (target.pos && target.pos.roomName);
  if (!roomName) return 0;

  var R = _pibRoom(roomName);
  if (!R.fills[target.id]) R.fills[target.id] = {};

  // ETA: rough “range + 1” guard, minimum 2 ticks (reduces flicker)
  var dist = 0;
  try { dist = creep.pos.getRangeTo(target); } catch (e) { dist = 5; }
  var eta = Math.max(2, (dist | 0) + 1);

  R.fills[target.id][creep.name] = {
    res: resourceType,
    amount: amount | 0,
    untilTick: Game.time + eta
  };
  return amount | 0;
}

/**
 * _pibReleaseFill(creep, target, resourceType=ENERGY)
 *   Remove this creep’s reservation for a target (on success/failure).
 */
function _pibReleaseFill(creep, target, resourceType) {
  if (!creep || !target) return;
  resourceType = resourceType || RESOURCE_ENERGY;

  var roomName = (creep.room && creep.room.name) || (target.pos && target.pos.roomName);
  if (!roomName) return;

  var R = _pibRoom(roomName);
  var map = R.fills[target.id];
  if (map && map[creep.name]) delete map[creep.name];
  if (map && Object.keys(map).length === 0) delete R.fills[target.id];
}

// ============================
// Capacity accounting with buffers
//   _effectiveFree subtracts both per-tick reservations and PIB “in-flight”.
// ============================

/**
 * _effectiveFree(struct, resourceType=ENERGY)
 *   Returns how much *usable* free capacity remains after subtracting:
 *     - freeNow (structure.store.getFreeCapacity)
 *     - same-tick Queen reservations
 *     - PIB “in-flight” reserved fills
 *   Floor at 0 to avoid negative values.
 */
function _effectiveFree(struct, resourceType) {
  resourceType = resourceType || RESOURCE_ENERGY;

  var freeNow = (struct.store && struct.store.getFreeCapacity(resourceType)) || 0;
  var sameTickReserved = _reservedFor(struct.id) | 0;

  var roomName = (struct.pos && struct.pos.roomName) || (struct.room && struct.room.name);
  var pibReserved = roomName ? (_pibSumReserved(roomName, struct.id, resourceType) | 0) : 0;

  return Math.max(0, freeNow - sameTickReserved - pibReserved);
}

/**
 * reserveFill(creep, target, amount, resourceType=ENERGY)
 *   Reserve up to `amount`, clamped by current _effectiveFree.
 *   - Writes same-tick reservation map
 *   - Sets creep.memory.qTargetId (sticky target)
 *   - Mirrors into PIB so other creeps see the reduced free capacity
 *   Returns the amount reserved (0 if none).
 */
function reserveFill(creep, target, amount, resourceType) {
  resourceType = resourceType || RESOURCE_ENERGY;

  var map = _qrMap();
  var free = _effectiveFree(target, resourceType);
  var want = Math.max(0, Math.min(amount, free));

  if (want > 0) {
    map[target.id] = (map[target.id] || 0) + want;
    creep.memory.qTargetId = target.id;
    _pibReserveFill(creep, target, want, resourceType);
  }
  return want;
}

/**
 * transferTo(creep, target, res=ENERGY)
 *   Wrapper for creep.transfer with:
 *     - Range handling via go()
 *     - PIB cleanup on success/full/error
 *     - Sticky target clearing when appropriate
 */
function transferTo(creep, target, res) {
  res = res || RESOURCE_ENERGY;
  var rc = creep.transfer(target, res);

  if (rc === ERR_NOT_IN_RANGE) { go(creep, target); return rc; }

  if (rc === OK) {
    _pibReleaseFill(creep, target, res);
  } else if (rc === ERR_FULL) {
    _pibReleaseFill(creep, target, res);
    creep.memory.qTargetId = null; // target can’t take more; drop stickiness
  } else if (rc !== OK && rc !== ERR_TIRED && rc !== ERR_BUSY) {
    _pibReleaseFill(creep, target, res); // fail-safe cleanup
    creep.memory.qTargetId = null;
  }
  return rc;
}

// ============================
// Per-room, once-per-tick cache
//   Builds a snapshot of “who needs energy” and “where to withdraw”
//   to avoid scanning the room repeatedly within the same tick.
// ============================
if (!global.__QUEEN) global.__QUEEN = { tick: -1, byRoom: {} };

/**
 * _qCache(room)
 *   Returns cached derived data for the room:
 *     - spawn: first owned spawn (idle anchor)
 *     - linkNearSpawn: nearest link to spawn (if any)
 *     - extSpawnNeedy: all spawn/extension with free capacity
 *     - towersNeedy: towers at/below TOWER_REFILL_PCT capacity
 *     - terminalNeed/storageNeed: terminal/storage that can accept more energy
 *     - storageHasEnergy: storage that currently *has* energy for withdraw
 *     - sideContainers: non-source containers with energy (preferred withdraw)
 *     - sourceContainers: “seat” containers adjacent (≤1) to sources (LAST RESORT)
 */
function _qCache(room) {
  var G = global.__QUEEN;
  if (G.tick !== Game.time) { G.tick = Game.time; G.byRoom = {}; } // wipe cache each tick
  var R = G.byRoom[room.name];
  if (R) return R;

  // Anchor spawn (useful for idling and link proximity)
  var sp = firstSpawn(room);

  // Optional: link near spawn (used as lower-priority fill target)
  var linkNearSpawn = null;
  if (sp) {
    linkNearSpawn = sp.pos.findClosestByRange(FIND_STRUCTURES, {
      filter: function (st) { return st.structureType === STRUCTURE_LINK; }
    });
  }

  // Extensions + Spawns that can accept energy
  var extSpawnNeedy = room.find(FIND_STRUCTURES, {
    filter: function (s) {
      if (!s.store) return false;
      if (s.structureType !== STRUCTURE_EXTENSION && s.structureType !== STRUCTURE_SPAWN) return false;
      return (s.store.getFreeCapacity(RESOURCE_ENERGY) | 0) > 0;
    }
  });

  // Towers under the refill threshold
  var towersNeedy = room.find(FIND_STRUCTURES, {
    filter: function (s) {
      if (s.structureType !== STRUCTURE_TOWER || !s.store) return false;
      var used = (s.store.getUsedCapacity(RESOURCE_ENERGY) | 0);
      var cap  = (s.store.getCapacity(RESOURCE_ENERGY) | 0);
      if (cap <= 0) return false;
      return (used / cap) <= CFG.TOWER_REFILL_PCT;
    }
  });

  // “Can accept more” targets for lower-priority filling
  var terminalNeed = (room.terminal && room.terminal.store &&
                      (room.terminal.store.getFreeCapacity(RESOURCE_ENERGY) | 0) > 0) ? room.terminal : null;

  var storageNeed  = (room.storage && room.storage.store &&
                      (room.storage.store.getFreeCapacity(RESOURCE_ENERGY) | 0) > 0) ? room.storage : null;

  // Storage as a top withdraw source, if it has energy
  var storageHasEnergy = (room.storage && (room.storage.store[RESOURCE_ENERGY] | 0) > 0) ? room.storage : null;

  // Non-source containers with energy (side buffers) preferred over source containers
  var sideContainers = room.find(FIND_STRUCTURES, {
    filter: function (s) {
      return s.structureType === STRUCTURE_CONTAINER &&
             !isContainerNearSource(s) &&
             s.store && (s.store.getUsedCapacity(RESOURCE_ENERGY) | 0) > 0;
    }
  });

  // “Seat” containers adjacent to sources (LAST RESORT to avoid starving miners)
  var sourceContainers = room.find(FIND_STRUCTURES, {
    filter: function (s) {
      return s.structureType === STRUCTURE_CONTAINER &&
             isContainerNearSource(s) &&
             s.store && (s.store.getUsedCapacity(RESOURCE_ENERGY) | 0) > 0;
    }
  });

  R = {
    spawn: sp,
    linkNearSpawn: linkNearSpawn,
    extSpawnNeedy: extSpawnNeedy,
    towersNeedy: towersNeedy,
    terminalNeed: terminalNeed,
    storageNeed: storageNeed,
    storageHasEnergy: storageHasEnergy,
    sideContainers: sideContainers,
    sourceContainers: sourceContainers
  };
  G.byRoom[room.name] = R;
  return R;
}

// ============================
// Target selection helpers
// ============================

/**
 * pickNearestNeedy(creep, candidates[])
 *   Filter to those with effective free capacity > 0,
 *   then pick the closest by range (no pathing cost).
 */
function pickNearestNeedy(creep, candidates) {
  var ok = [];
  for (var i = 0; i < candidates.length; i++) {
    var s = candidates[i];
    if (s && _effectiveFree(s, RESOURCE_ENERGY) > 0) ok.push(s);
  }
  return ok.length ? nearestByRange(creep.pos, ok) : null;
}

/**
 * chooseFillTarget(creep, cache)
 *   Priority order:
 *     1) Extensions/Spawns (closest needy)
 *     2) Towers (under configured threshold)
 *     3) Link near spawn
 *     4) Terminal (skip if it was the last withdrawal source to prevent “bounce”)
 *     5) Storage  (skip if it was the last withdrawal source to prevent “bounce”)
 *   Each candidate is also checked through _effectiveFree() to incorporate reservations.
 */
function chooseFillTarget(creep, cache) {
  var target =
    pickNearestNeedy(creep, cache.extSpawnNeedy) ||
    pickNearestNeedy(creep, cache.towersNeedy)   ||
    (cache.linkNearSpawn && _effectiveFree(cache.linkNearSpawn, RESOURCE_ENERGY) > 0 ? cache.linkNearSpawn : null) ||
    ((cache.terminalNeed && cache.terminalNeed.id !== creep.memory.qLastWithdrawId &&
      _effectiveFree(cache.terminalNeed, RESOURCE_ENERGY) > 0) ? cache.terminalNeed : null) ||
    ((cache.storageNeed  && cache.storageNeed.id  !== creep.memory.qLastWithdrawId &&
      _effectiveFree(cache.storageNeed,  RESOURCE_ENERGY) > 0) ? cache.storageNeed  : null);

  return target;
}

/**
 * chooseWithdrawTarget(creep, cache)
 *   Withdrawal priority (UPDATED):
 *     1) Nearest dropped energy on the ground
 *     2) Storage with energy (most stable / safe)
 *     3) Nearest “side container” (non-source container) with energy
 *     4) LAST: Nearest source “seat” container (adjacent to source)
 *   If none exist, the Queen falls through to “no action” (this file
 *   doesn’t contain harvest logic).
 */
function chooseWithdrawTarget(creep, cache) {
  // 1) Dropped energy first (fast cleanup & least path contention)
  var drop = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
    filter: function (r) { return r.resourceType === RESOURCE_ENERGY; }
  });
  if (drop) return drop;

  // 2) Storage (stable, safe)
  if (cache.storageHasEnergy) return cache.storageHasEnergy;

  // 3) Side container (not near sources)
  if (cache.sideContainers && cache.sideContainers.length) {
    var side = nearestByRange(creep.pos, cache.sideContainers);
    if (side) return side;
  }

  // 4) LAST: Source seat container (adjacent to a source; avoid starving miners)
  if (cache.sourceContainers && cache.sourceContainers.length) {
    var seat = nearestByRange(creep.pos, cache.sourceContainers);
    if (seat) return seat;
  }

  return null; // fall through to harvest (not implemented here)
}

// ============================
// Main
// ============================

/**
 * TaskQueen.run(creep)
 *   High-level behavior:
 *     A) If carrying energy:
 *        A1) Try sticky target first (fast path)
 *        A2) Else choose a new fill target (priority chain)
 *        A3) If none available, idle near spawn/controller
 *     B) If not carrying:
 *        B1) Choose best withdrawal option (drop -> storage -> side -> source-seat)
 *        B2) Move/pickup/withdraw accordingly (with clear debug crumbs)
 *
 *   Debug:
 *     - debugSay: short markers (“→ EXT”, “↘️Sto”, “↘️SrcBox”, “IDLE”)
 *     - debugDraw: line + small label to target of action
 */
var TaskQueen = {
  run: function (creep) {
    var room  = creep.room;
    var cache = _qCache(room); // per-tick snapshot of room state
    var carryAmt = creep.store.getUsedCapacity(RESOURCE_ENERGY) | 0;
    var carrying = carryAmt > 0;

    // ------------- A) We have energy: deliver it -------------
    if (carrying) {
      // A1) Try sticky target first: if previous target still can take energy,
      //     reserve and push to it (reduces re-target churn across ticks).
      if (creep.memory.qTargetId) {
        var sticky = Game.getObjectById(creep.memory.qTargetId);
        if (sticky && _effectiveFree(sticky, RESOURCE_ENERGY) > 0) {
          if (reserveFill(creep, sticky, carryAmt, RESOURCE_ENERGY) > 0) {
            debugSay(creep, '→ STICK');
            debugDraw(creep, sticky, CFG.DRAW.STICK_COLOR, "STICK");
            transferTo(creep, sticky);
            return;
          }
        } else {
          // Sticky target is full or gone; clear it
          creep.memory.qTargetId = null;
        }
      }

      // A2) Choose a fresh fill target via priority chain
      var target = chooseFillTarget(creep, cache);
      if (target) {
        // Reserve up to what we carry (clamped by effective free)
        if (reserveFill(creep, target, carryAmt, RESOURCE_ENERGY) > 0) {
          // Label + color by type for quick visual debugging
          var st = target.structureType;
          if (st === STRUCTURE_EXTENSION) { debugSay(creep, '→ EXT'); debugDraw(creep, target, CFG.DRAW.FILL_COLOR, "EXT"); }
          else if (st === STRUCTURE_SPAWN) { debugSay(creep, '→ SPN'); debugDraw(creep, target, CFG.DRAW.FILL_COLOR, "SPN"); }
          else if (st === STRUCTURE_TOWER) { debugSay(creep, '→ TWR'); debugDraw(creep, target, CFG.DRAW.FILL_COLOR, "TWR"); }
          else if (st === STRUCTURE_LINK)  { debugSay(creep, '→ LNK'); debugDraw(creep, target, CFG.DRAW.FILL_COLOR, "LNK"); }
          else if (st === STRUCTURE_TERMINAL) { debugSay(creep, '→ TERM'); debugDraw(creep, target, CFG.DRAW.FILL_COLOR, "TERM"); }
          else if (st === STRUCTURE_STORAGE)  { debugSay(creep, '→ STO'); debugDraw(creep, target, CFG.DRAW.FILL_COLOR, "STO"); }
          else { debugSay(creep, '→ FILL'); debugDraw(creep, target, CFG.DRAW.FILL_COLOR, "FILL"); }

          transferTo(creep, target);
          return;
        }
      }

      // A3) Nothing to fill right now: idle near an anchor (spawn > controller)
      var anchor = cache.spawn || room.controller || creep.pos;
      debugSay(creep, 'IDLE');
      debugDraw(creep, (anchor.pos || anchor), CFG.DRAW.IDLE_COLOR, "IDLE");
      go(creep, (anchor.pos || anchor), 2);
      return;
    }

    // ------------- B) We do NOT have energy: acquire it -------------
    var withdrawTarget = chooseWithdrawTarget(creep, cache);
    if (withdrawTarget) {
      if (withdrawTarget.resourceType === RESOURCE_ENERGY) {
        // B1) Dropped resource path: pickup
        debugSay(creep, '↘️Drop');
        debugDraw(creep, withdrawTarget, CFG.DRAW.DROP_COLOR, "DROP");
        if (creep.pickup(withdrawTarget) === ERR_NOT_IN_RANGE) go(creep, withdrawTarget);
      } else {
        // B2) Structure path: withdraw from storage/container/etc.
        if (withdrawTarget.structureType === STRUCTURE_STORAGE) {
          debugSay(creep, '↘️Sto');
          debugDraw(creep, withdrawTarget, CFG.DRAW.WD_COLOR, "WD");
          withdrawFrom(creep, withdrawTarget);
        } else if (withdrawTarget.structureType === STRUCTURE_CONTAINER) {
          // Differentiate side vs source seat container for visibility
          if (isContainerNearSource(withdrawTarget)) {
            debugSay(creep, '↘️SrcBox');
            debugDraw(creep, withdrawTarget, CFG.DRAW.WD_COLOR, "SRC-BOX");
          } else {
            debugSay(creep, '↘️Con');
            debugDraw(creep, withdrawTarget, CFG.DRAW.WD_COLOR, "WD");
          }
          withdrawFrom(creep, withdrawTarget);
        } else {
          // Fallback label for other withdraw-capable structures (if any)
          debugSay(creep, '↘️Wd');
          debugDraw(creep, withdrawTarget, CFG.DRAW.WD_COLOR, "WD");
          withdrawFrom(creep, withdrawTarget);
        }
      }
      return;
    }

    // No withdraw option (this role doesn’t harvest): do nothing this tick.
    // (Optional: step toward storage/spawn for faster future acquisition.)
  }
};

module.exports = TaskQueen;