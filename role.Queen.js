'use strict';

// -----------------------------------------------------------------------------
// role.Queen.js - home-room energy logistics and emergency backup harvest
// Owns:
// * Queen creep identity and task state in creep.memory.role/task/state/_task.
// * Per-room terminal stocking state in room.memory.terminalEnergyJob.
// * Same-tick Queen fill reservations in global.__BHM.queenReservations.
// * Emergency source assignment diagnostics in
//   Memory.rooms[roomName].lastQueenBackupHarvest and
//   Memory.rooms[roomName].queenSourceAssignments.
// Usually called by:
// * BeeHiveMind.runCreeps() directly as the Queen role module.
// Systems that depend on it:
// * BeeSpawnManager determines Queen quota from role.Queen.Config and room
//   bootstrap state; Movement.Manager executes Queen idle/harvest moves.
// Do not casually change:
// * _task schema, terminalEnergyJob fields, or reservation semantics. Truckers
//   and Queens both try to avoid overfilling the same structures.
// -----------------------------------------------------------------------------

const BeeSelectors = require('BeeSelectors');
const BeeActions = require('BeeActions');
const BeeToolbox = require('BeeToolbox');
const MovementManager = require('Movement.Manager');
const QueenConfig = require('role.Queen.Config');
const HarabiCreep = require('role.HarabiCreep');

// Shared debug + tuning config.
var CFG = Object.freeze({
  // --- Debug toggles (shared) ---
  DEBUG_SAY: false,
  DEBUG_DRAW: true,

  // --- Visual styles (shared) ---
  DRAW: {
    // Veinseeker-style visuals
    TRAVEL:   "#8ab6ff",
    SOURCE:   "#ffd16e",
    SEAT:     "#6effa1",
    QUEUE:    "#ffe66e",
    YIELD:    "#ff6e6e",
    OFFLOAD:  "#6ee7ff",
    IDLE:     "#bfbfbf",
    // Courier-style visuals
    WD_COLOR:    "#6ec1ff",  // withdraw lines
    FILL_COLOR:  "#6effa1",  // delivery lines
    DROP_COLOR:  "#ffe66e",  // dropped energy
    GRAVE_COLOR: "#ffb0e0",  // tombstones/ruins
    IDLE_COLOR:  "#bfbfbf",
    // Shared
    WIDTH:   0.12,
    OPACITY: 0.45,
    FONT:    0.6
  },

  // --- Towers (Courier) ---
  TOWER_REFILL_AT_OR_BELOW: 0.70,

  //Upgrader role Behavior
  SIGN_TEXT: "BeeNice Please.",
  //Trucker role Behavior
  PICKUP_FLAG_DEFAULT: "E-Pickup", // default flag name to route to
  MIN_DROPPED: 50,                 // ignore tiny crumbs (energy or other)
  SEARCH_RADIUS: 50,               // how far from flag to look
  PATH_REUSE: 20,                  // reusePath hint
  // Optional: allow non-energy resource pickups (POWER, minerals, etc.)
  ALLOW_NON_ENERGY: true,
  // Fallback park if no flag & no home (harmless; rarely used)
  PARK_POS: { x:25, y:25, roomName:"W0N0" },

  //--- Pathing (used by Queen)----
  STUCK_TICKS: 6,
  MOVE_PRIORITIES: { withdraw: 60, pickup: 70, deliver: 55, harvest: 55, build: 50, idle: 5 },

  // --- Pathing (used by Courier & any others that want it) ---
  PATH_REUSE: 40,
  MAX_OPS_MOVE: 2000,
  TRAVEL_MAX_OPS: 4000,
  // --- Targeting cadences (Courier) ---
  RETARGET_COOLDOWN: 10,
  GRAVE_SCAN_COOLDOWN: 20,
  BETTER_CONTAINER_DELTA: 150,
  // --- Thresholds / radii (Courier) ---
  CONTAINER_MIN: 50,
  DROPPED_BIG_MIN: 150,
  DROPPED_NEAR_CONTAINER_R: 2,
  DROPPED_ALONG_ROUTE_R: 2,
});

// -------------------------
// Debug helpers
// -------------------------
// Shared BeeToolbox debug helpers keep repeated RoomVisual guard and position
// normalization code out of role files while each role preserves its own flags,
// colors, widths, and labels.
function debugOptions() {
  return {
    enabled: CFG.DEBUG_DRAW,
    width: CFG.DRAW.WIDTH,
    opacity: CFG.DRAW.OPACITY,
    font: CFG.DRAW.FONT
  };
}

function debugSay(creep, msg) {
  BeeToolbox.sayIfDebugEnabled(creep, msg, CFG.DEBUG_SAY);
}

function drawLine(creep, target, color, label) {
  BeeToolbox.drawDebugLine(creep, target, color, label, debugOptions());
}

  // -----------------------------
  // A) Identity + task/state helpers
  // -----------------------------
  function ensureQueenIdentity(creep) {
    // Queens are logistics creeps. Normalize identity here so old spawned
    // creeps and queue-spawned creeps follow the same state machine.
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
    // Tick-local reservation map for Queen delivery targets. This prevents
    // multiple Queens from planning the same free capacity.
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
    // Persistent room-level state for optional terminal stocking. Multiple
    // Queens read this same object, but updateTerminalEnergyJob rate-limits
    // mutation to once per tick.
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
    // Terminal stocking is a background logistics job: start only after storage
    // surplus is stable, pause for critical fills, and finish when terminal
    // reaches targetEnergy.
    var job = getRoomTerminalEnergyJob(room);
    if (!job) return null;
    // Multi-Queen safety: only one updater mutates threshold/job state per tick.
    // Other Queens read the same shared state without double-counting.
    if (job.lastUpdate === Game.time) return job;
    job.lastUpdate = Game.time;

    if (!room.storage || !room.terminal) {
      if (job.active || job.paused); //logTerminalJob(room, 'paused: missing storage or terminal');
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
    // Task invalidation is where the Queen decides whether to keep working or
    // pick fresh work. It checks target existence, resource state, capacity, and
    // basic stuck detection.
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
    } else if (task.type === 'harvest') {
      if (!target) return true;
      if (creep.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) return true;
      if ((target.energy || 0) < Math.max(0, QueenConfig.BACKUP_HARVEST_MIN_SOURCE_ENERGY || 0)) return true;
    } else if (task.type === 'build') {
      if (!target) return true;
      if (!hasWorkPart(creep)) return true;
      if ((creep.store[RESOURCE_ENERGY] || 0) === 0) return true;
      if (creep.room && creep.room.storage) return true;
      if (roomHasCriticalEnergyNeeds(creep.room)) return true;
      if (target.structureType === STRUCTURE_STORAGE) {
        if (!task.data || task.data.site !== 'storage') return true;
      } else if (target.structureType === STRUCTURE_CONTAINER) {
        if (!task.data || task.data.site !== 'hub_container') return true;
        if (!BeeSelectors.isSpawnHubContainerSite(creep.room, target, {
          rangeFromSpawn: QueenConfig.HUB_CONTAINER_RANGE_FROM_SPAWN
        })) return true;
      } else {
        // Queen bootstrap building is deliberately narrow: storage site first,
        // then the one spawn hub container site. Builder owns all other sites.
        return true;
      }
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
    // Withdrawal source picker. BeeSelectors owns the room scan; Queen applies
    // its preferred source kind order and wraps the chosen target in _task.
    // This order is gameplay behavior, so keep it role-local until any cleanup
    // has explicit per-role priority notes and tests.
    var room = creep.room;
    if (!room) return null;
    var pref = (creep.memory && creep.memory.energyPref && creep.memory.energyPref.length)
      ? creep.memory.energyPref
      : ['tomb','ruin','storage','drop','hub_container','container','terminal','link'];
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
      if (kind === 'hub_container') return createTask('withdraw', best.id, { source: 'hub_container' });
      if (kind === 'container') return createTask('withdraw', best.id, { source: 'container' });
      if (kind === 'link')      return createTask('withdraw', best.id, { source: 'link' });
      return createTask('withdraw', best.id, { source: kind || 'energy' });
    }
    return null;
  }

  function pickBootstrapBuildTask(creep) {
    // Queen has one WORK part in the bootstrap body, so this is helper-only
    // construction. Builder remains the general construction role; Queen only
    // spends safe spare energy on storage and the spawn hub container before
    // storage is built.
    if (!QueenConfig.QUEEN_BOOTSTRAP_BUILD_ENABLED) return null;
    if (!creep || !creep.room) return null;
    if (!hasWorkPart(creep)) return null;
    if ((creep.store[RESOURCE_ENERGY] || 0) <= 0) return null;
    var room = creep.room;
    if (room.storage) return null;
    if (roomHasCriticalEnergyNeeds(room)) return null;

    if (QueenConfig.QUEEN_BUILD_STORAGE_SITE_ENABLED !== false) {
      var storageSite = BeeSelectors.findStorageConstructionSite(room);
      if (storageSite) return createTask('build', storageSite.id, { site: 'storage' });
    }

    if (QueenConfig.QUEEN_BUILD_HUB_CONTAINER_SITE_ENABLED !== false) {
      var hubSite = BeeSelectors.findSpawnHubContainerConstructionSite(room, {
        rangeFromSpawn: QueenConfig.HUB_CONTAINER_RANGE_FROM_SPAWN
      });
      if (hubSite) return createTask('build', hubSite.id, { site: 'hub_container' });
    }

    return null;
  }

  function pickDeliverTask(creep) {
    // Delivery picker. Critical fills beat terminal stocking; storage/link/
    // terminal fallbacks only happen after spawn/extension/tower needs are safe.
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

    var bootstrapBuild = pickBootstrapBuildTask(creep);
    if (bootstrapBuild) return bootstrapBuild;

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


function roomNeedsCriticalFill(room) {
  if (!room) return false;
  var spawnLike = BeeSelectors.findSpawnLikeNeedingEnergy(room);
  if (spawnLike && spawnLike.length) return true;
  var towers = BeeSelectors.findTowersNeedingEnergy(room);
  if (towers && towers.length) return true;
  return false;
}

function hasWorkPart(creep) {
  return creep && creep.getActiveBodyparts && creep.getActiveBodyparts(WORK) > 0;
}

function ensureRoomQueenAssignmentMemory(room) {
  if (!room || !room.name) return null;
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};
  var mem = Memory.rooms[room.name];
  if (!mem.queenSourceAssignments) mem.queenSourceAssignments = {};
  return mem;
}

function cleanupQueenSourceAssignments(room) {
  var mem = ensureRoomQueenAssignmentMemory(room);
  if (!mem) return {};
  var out = mem.queenSourceAssignments || {};
  for (var sourceId in out) {
    if (!Object.prototype.hasOwnProperty.call(out, sourceId)) continue;
    var rec = out[sourceId];
    var dead = !rec || !rec.creepName || !Game.creeps[rec.creepName];
    var expired = !rec || typeof rec.until !== 'number' || rec.until < Game.time;
    if (dead || expired) delete out[sourceId];
  }
  mem.queenSourceAssignments = out;
  return out;
}


function getWalkableHarvestSeats(source) {
  if (!source || !source.pos) return [];
  var terrain = new Room.Terrain(source.pos.roomName);
  var seats = [];
  for (var dx = -1; dx <= 1; dx++) {
    for (var dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      var x = source.pos.x + dx;
      var y = source.pos.y + dy;
      if (x <= 0 || x >= 49 || y <= 0 || y >= 49) continue;
      if (terrain.get(x, y) !== TERRAIN_MASK_WALL) seats.push(new RoomPosition(x, y, source.pos.roomName));
    }
  }
  return seats;
}

function isSeatOccupiedByOtherCreep(pos, myName) {
  if (!pos) return false;
  var creeps = pos.lookFor(LOOK_CREEPS);
  if (!creeps || !creeps.length) return false;
  for (var i = 0; i < creeps.length; i++) {
    if (creeps[i] && creeps[i].name !== myName) return true;
  }
  return false;
}

function countAssignedVeinseekers(roomName, sourceId) {
  if (!roomName || !sourceId) return 0;
  var total = 0;
  for (var creepName in Game.creeps) {
    if (!Object.prototype.hasOwnProperty.call(Game.creeps, creepName)) continue;
    var c = Game.creeps[creepName];
    if (!c || !c.my || !c.memory) continue;
    var role = c.memory.role;
    var task = c.memory.task;
    var isVeinseekerRole = role && String(role).toLowerCase() === 'veinseeker';
    var isVeinseekerTask = task && String(task).toLowerCase() === 'veinseeker';
    if (!isVeinseekerRole && !isVeinseekerTask) continue;
    if (c.memory.mode === 'remote') continue;
    if (c.memory.assignedSource !== sourceId) continue;
    if (!c.room || c.room.name !== roomName) continue;
    total++;
  }
  return total;
}

function evaluateBackupHarvestSource(creep, source, assignments) {
  if (!creep || !source) return { eligible: false, reason: 'invalid_source' };
  var seats = getWalkableHarvestSeats(source);
  if (!seats.length) return { eligible: false, reason: 'no_free_harvest_seat', freeSeats: 0, totalSeats: 0 };

  var freeSeats = 0;
  for (var i = 0; i < seats.length; i++) {
    if (!isSeatOccupiedByOtherCreep(seats[i], creep.name)) freeSeats++;
  }
  if (freeSeats <= 0) return { eligible: false, reason: 'no_free_harvest_seat', freeSeats: 0, totalSeats: seats.length };

  var sourceWorkerAssigned = countAssignedVeinseekers(creep.room.name, source.id);
  var rec = assignments && assignments[source.id];
  var hasOtherQueenAssignment = !!(rec && rec.creepName !== creep.name);
  var effectiveTakenSeats = sourceWorkerAssigned + (hasOtherQueenAssignment ? 1 : 0);

  // Queen backup harvesting is emergency-only. If Veinseeker already occupies all
  // reachable source seats, Queen must not path into that blocked source and stall.
  if (sourceWorkerAssigned >= seats.length) {
    return { eligible: false, reason: 'source_blocked_by_veinseeker', freeSeats: freeSeats, totalSeats: seats.length };
  }

  if (effectiveTakenSeats >= seats.length) {
    return { eligible: false, reason: 'no_free_harvest_seat', freeSeats: Math.max(0, seats.length - effectiveTakenSeats), totalSeats: seats.length };
  }

  return { eligible: true, reason: 'eligible', freeSeats: Math.min(freeSeats, Math.max(0, seats.length - effectiveTakenSeats)), totalSeats: seats.length };
}

function writeQueenBackupHarvestDiag(creep, diag) {
  if (!creep || !creep.room || !diag) return;
  var mem = ensureRoomQueenAssignmentMemory(creep.room);
  if (!mem) return;
  mem.lastQueenBackupHarvest = diag;
}

function getBackupHarvestTask(creep) {
  // Emergency-only source harvesting for Queens. It records detailed refusal
  // reasons in lastQueenBackupHarvest so bootstrap failures are explainable.
  var room = creep && creep.room;
  var diag = {
    tick: Game.time,
    enabled: !!QueenConfig.BACKUP_HARVEST_ENABLED,
    allowed: false,
    reason: 'unknown',
    assignedSourceId: null,
    assignedCreep: creep ? creep.name : null,
    activeAssignments: 0,
    roomHasStorage: !!(room && room.storage),
    criticalFillExists: roomNeedsCriticalFill(room)
  };

  if (!QueenConfig.BACKUP_HARVEST_ENABLED) { diag.reason = 'disabled'; writeQueenBackupHarvestDiag(creep, diag); return null; }
  if (!hasWorkPart(creep)) { diag.reason = 'no_work_part'; writeQueenBackupHarvestDiag(creep, diag); return null; }
  if (QueenConfig.BACKUP_HARVEST_ONLY_WITHOUT_STORAGE && room && room.storage) { diag.reason = 'storage_present'; writeQueenBackupHarvestDiag(creep, diag); return null; }
  if (QueenConfig.BACKUP_HARVEST_ONLY_WHEN_CRITICAL_FILL_EXISTS && !diag.criticalFillExists) { diag.reason = 'no_critical_fill'; writeQueenBackupHarvestDiag(creep, diag); return null; }
  if (!creep || creep.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) { diag.reason = 'no_free_capacity'; writeQueenBackupHarvestDiag(creep, diag); return null; }

  var assignments = cleanupQueenSourceAssignments(room);
  var activeAssignments = 0;
  for (var k in assignments) if (Object.prototype.hasOwnProperty.call(assignments, k)) activeAssignments++;
  diag.activeAssignments = activeAssignments;

  var sources = room ? room.find(FIND_SOURCES) : [];
  if (!sources || !sources.length) { diag.reason = 'no_sources'; writeQueenBackupHarvestDiag(creep, diag); return null; }

  var minEnergy = Math.max(0, QueenConfig.BACKUP_HARVEST_MIN_SOURCE_ENERGY || 0);
  var assignedSource = null;
  var unclaimedEligible = [];
  var fallbackEligible = [];
  var blockedByVeinseeker = 0;
  var noFreeSeatCount = 0;

  for (var i = 0; i < sources.length; i++) {
    var src = sources[i];
    if (!src || (src.energy || 0) < minEnergy) continue;

    var seatEval = evaluateBackupHarvestSource(creep, src, assignments);
    if (!seatEval.eligible) {
      if (seatEval.reason === 'source_blocked_by_veinseeker') blockedByVeinseeker++;
      else if (seatEval.reason === 'no_free_harvest_seat') noFreeSeatCount++;
      continue;
    }

    var rec = assignments[src.id];
    if (rec && rec.creepName === creep.name) assignedSource = src;
    if (!rec) unclaimedEligible.push(src);
    fallbackEligible.push(src);
  }

  var chosen = assignedSource;
  if (!chosen && unclaimedEligible.length) chosen = BeeSelectors.selectClosestByRange(creep.pos, unclaimedEligible);
  if (!chosen && fallbackEligible.length) chosen = BeeSelectors.selectClosestByRange(creep.pos, fallbackEligible);

  if (!chosen) {
    diag.reason = blockedByVeinseeker > 0 ? 'source_blocked_by_veinseeker' : (noFreeSeatCount > 0 ? 'no_free_harvest_seat' : 'no_eligible_source');
    writeQueenBackupHarvestDiag(creep, diag);
    return null;
  }

  assignments[chosen.id] = {
    creepName: creep.name,
    until: Game.time + Math.max(1, QueenConfig.BACKUP_HARVEST_ASSIGN_TTL || 15)
  };

  diag.allowed = true;
  diag.reason = 'assigned';
  diag.assignedSourceId = chosen.id;
  writeQueenBackupHarvestDiag(creep, diag);

  return createTask('harvest', chosen.id, { source: 'backup_harvest', sourceId: chosen.id });
}

  function chooseNextTask(creep) {
    if ((creep.store[RESOURCE_ENERGY] || 0) === 0) {
      var withdrawTask = pickWithdrawTask(creep);
      if (withdrawTask) return withdrawTask;
      var harvestTask = getBackupHarvestTask(creep);
      if (harvestTask) return harvestTask;
    } else {
      var deliverTask = pickDeliverTask(creep);
      if (deliverTask) return deliverTask;
    }
    return createIdleTask(creep);
  }

  function ensureActiveTask(creep) {
    // The Queen task slot is sticky until needsNewTask says it is invalid. This
    // reduces target thrashing and keeps delivery reservations understandable.
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

  function runQueenBuildState(creep) {
    var task = creep.memory._task;
    var target = getQueenTaskTarget(task);
    var priority = getQueenTaskPriority(task);
    if (!task || !target) { clearTask(creep); return; }
    if (roomHasCriticalEnergyNeeds(creep.room) || creep.room.storage) { clearTask(creep); return; }
    drawLine(creep, target, CFG.DRAW.SOURCE, 'BLD');
    debugSay(creep, 'B');
    var rc = BeeActions.safeBuild(creep, target, { priority: priority, reusePath: 20 });
    if (rc === OK) {
      if ((creep.store[RESOURCE_ENERGY] || 0) === 0) clearTask(creep);
      return;
    }
    if (rc === ERR_NOT_ENOUGH_RESOURCES || rc === ERR_INVALID_TARGET || rc === ERR_NO_BODYPART) {
      clearTask(creep);
    }
  }

  function runQueenHarvestState(creep) {
    var task = creep.memory._task;
    var source = getQueenTaskTarget(task);
    if (!task || !source) { clearTask(creep); return; }
    if (creep.store.getFreeCapacity(RESOURCE_ENERGY) <= 0) { clearTask(creep); return; }
    var rc = creep.harvest(source);
    if (rc === ERR_NOT_IN_RANGE) {
      var priority = getQueenTaskPriority(task);
      MovementManager.request(creep, source, priority, { range: 1, reusePath: 10, intentType: 'harvest' });
      return;
    }
    if (rc === OK) {
      var carryNow = creep.store[RESOURCE_ENERGY] || 0;
      var deliverAt = Math.max(1, QueenConfig.BACKUP_HARVEST_DELIVER_AT_ENERGY || 50);
      if (carryNow >= deliverAt || creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) clearTask(creep);
      return;
    }
    if (rc === ERR_NOT_ENOUGH_RESOURCES || rc === ERR_INVALID_TARGET || rc === ERR_NO_BODYPART) {
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
      // Public Queen role entry. Keep terminal job state fresh, derive state
      // from _task, then execute exactly one state handler.
      if (!creep || creep.spawning) return;
      // Keep room-level terminal job state fresh every tick, even if this Queen
      // is currently withdrawing or idling. updateTerminalEnergyJob itself is
      // guarded so multiple Queens do not double-update.
      updateTerminalEnergyJob(creep.room);
      var state = determineQueenState(creep);

      if (state === 'WITHDRAW') { runQueenWithdrawState(creep); return; }
      if (state === 'PICKUP')   { runQueenPickupState(creep);   return; }
      if (state === 'DELIVER')  { runQueenDeliverState(creep);  return; }
      if (state === 'BUILD')    { runQueenBuildState(creep);    return; }
      if (state === 'HARVEST')  { runQueenHarvestState(creep);  return; }
      runQueenIdleState(creep);
    }
  };

module.exports = HarabiCreep.wrapModule(roleQueen, { task: 'queen' });
