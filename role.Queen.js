'use strict';

var BeeHelper = require('role.BeeHelper');
var BeeSelectors = require('BeeSelectors');
var BeeActions = require('BeeActions');
var MovementManager = require('Movement.Manager');
var CFG = BeeHelper.config;

var roleQueen = (function () {
  // -----------------------------------------------------------------------------
  // role.Queen.js – economy hauler role
  // Responsibilities:
  // * Keeps a single "Queen" creep ferrying energy between sources (drops, links,
  //   tombstones, storage) and sinks (spawns/extensions/towers/storage terminals).
  // * Interacts with BeeSelectors.js for prioritised lists of energy sources and
  //   delivery targets, BeeActions.js for wrapped actions with movement, and
  //   Movement.Manager.js for centralised pathing priorities.
  // * Stores its finite-state machine in creep.memory._task (shape:
  //   {type, targetId, since, data}) and clears/refreshes it when targets change
  //   or run out of capacity.
  //   States: 'withdraw', 'pickup', 'deliver', 'idle'
  // * Uses global.__BHM.queenReservations to avoid multiple Queens double-booking
  //   the same sink in the same tick.
  // Called from: BeeHiveMind.runCreeps dispatcher -> roleQueen.run.
  // -----------------------------------------------------------------------------  
  // External selectors module; see BeeSelectors.js for source/sink scans.
  //var BeeSelectors = require('BeeSelectors');
  // Shared action wrappers with movement intents.
  //var BeeActions = require('BeeActions');
  // Central movement queue; roleQueen enqueues idles here.
  //var MovementManager = require('Movement.Manager');
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

  function determineQueenState(creep) {
    ensureQueenIdentity(creep);
    var task = ensureActiveTask(creep);
    var type = (task && task.type) ? String(task.type).toUpperCase() : 'IDLE';
    creep.memory.state = type;
    return type;
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
    // -----------------------------
    // Queen-only preference order
    // Edit this array to change what Queens try first.
    // (If you set creep.memory.energyPref, that will override this list for THAT Queen only.)
    // Common sensible Queen order: battlefield cleanup first, then structured stores.
    var pref = (creep.memory && creep.memory.energyPref && creep.memory.energyPref.length)
    ? creep.memory.energyPref
    :['tomb','ruin','storage','drop','container','terminal','link'];
    // Build a room snapshot once
    var list = BeeSelectors.getEnergySourcePriority(room);
    if (!list || !list.length) return null;

    // Bucket snapshot entries by kind for quick access: { kind -> [targets] }
    var buckets = {};
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e || !e.target) continue;
      var k = e.kind || 'unknown';
      if (!buckets[k]) buckets[k] = [];
      buckets[k].push(e.target);
    }
    //walk the Queen's preference order; pick the closest target in the first non-empty bucket
    for (var p = 0; p < pref.length; p++) {
      var kind = pref[p];
      if (kind === 'source') continue; // Queens don't harvest
      var arr = buckets[kind];
      if (!arr || !arr.length) continue;
      // Prefer closest-by-range to reduce walking
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

module.exports = roleQueen;
