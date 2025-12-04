'use strict';

var BeeToolbox = require('BeeToolbox');
var CoreConfig = require('core.config');
var CFG = CoreConfig.ROLE_CFG;

// Phase 2 refactor note: visuals + debug flags now live in core.config and
// BeeToolbox so every role shares the same behaviour and new readers have one
// place to tweak draw settings.
function debugSay(creep, msg) { BeeToolbox.debugSay(creep, msg, CFG.DEBUG_SAY); }
function debugDrawLine(creep, target, color, label) { BeeToolbox.debugDrawLine(creep, target, color, label, CFG); }
function debugRing(room, pos, color, text) { BeeToolbox.debugRing(room, pos, color, text, CFG); }

  // -----------------------------
  // A) Identity + state helpers
  // -----------------------------
  function ensureCourierIdentity(creep) {
    if (!creep || !creep.memory) return;
    creep.memory.role = 'Courier';
    if (!creep.memory.task) creep.memory.task = 'courier';
  }

  // Memory keys:
  // - pickupContainerId: current source container we are using
  // - dropoffId: structure id we plan to fill next
  // - transferring: boolean flipped by determineCourierState

  function determineCourierState(creep) {
    ensureCourierIdentity(creep);
    // Newer coders sometimes forget to guard both edges of the state machine.
    // We check the "cargo empty" and "cargo full" edges separately to keep it obvious
    // which condition flips us into delivery mode.
    if (creep.memory.transferring && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.transferring = false;
    }
    if (!creep.memory.transferring && creep.store.getFreeCapacity() === 0) {
      creep.memory.transferring = true;
    }

    // Stickies default to "null" so JSON.stringify stays light and our guards stay simple.
    if (creep.memory.pickupContainerId === undefined) creep.memory.pickupContainerId = null;
    if (creep.memory.retargetAt === undefined) creep.memory.retargetAt = 0;
    if (creep.memory.dropoffId === undefined) creep.memory.dropoffId = null;
    creep.memory.state = creep.memory.transferring ? 'DELIVER' : 'COLLECT';
    return creep.memory.state;
  }

  // Break collection targets into small helpers so novice contributors can trace the flow
  // without scrolling through a mega-function.
  function pickBestSourceContainer(creep, cache, now) {
    var current = Game.getObjectById(creep.memory.pickupContainerId);
    var soon = creep.memory.retargetAt || 0;

    // Maintain current target when (a) it's still good and (b) retarget cooldown is active.
    if (current && isGoodContainer(current) && now < soon) return current;

    // Start with the best-energy container for fast refuels.
    var best = Game.getObjectById(cache.bestSrcId);

    // Fallback: look through source containers and pick the closest full-ish one.
    if (!best) {
      var sourceContainers = getCourierObjectsFromIds(cache.srcIds);
      var candidates = sourceContainers.filter(isGoodContainer);
      best = candidates.length ? findClosestByRange(creep.pos, candidates) : null;
    }

    // Only switch when the new candidate is clearly better so we do not thrash between seats.
    if (!current || (best && current.id !== best.id && isContainerClearlyBetter(best, current))) {
      creep.memory.pickupContainerId = best ? best.id : null;
      creep.memory.retargetAt = now + CFG.RETARGET_COOLDOWN;
      return best;
    }
    return current;
  }

  function tryPickupEnRoute(creep) {
    var nearby = creep.pos.findInRange(FIND_DROPPED_RESOURCES, CFG.DROPPED_ALONG_ROUTE_R, {
      filter: function (r) {
        var amount = Number(r.amount) || 0;
        return r.resourceType === RESOURCE_ENERGY && amount >= CFG.DROPPED_BIG_MIN;
      }
    });
    if (!nearby || !nearby.length) return false;

    var pile = findClosestByRange(creep.pos, nearby);
    debugSay(creep, '↘️Drop');
    debugDrawLine(creep, pile, CFG.DRAW.DROP_COLOR, "DROP*");
    if (creep.pickup(pile) === ERR_NOT_IN_RANGE) {
      creep.travelTo(pile, { range: 1, reusePath: 20 });
    }
    return true;
  }

  function tryContainerWorkflow(creep, container) {
    if (!isGoodContainer(container)) return false;

    // Drops near the container are low-effort fuel, so we scoop them before withdrawing.
    var drops = container.pos.findInRange(FIND_DROPPED_RESOURCES, CFG.DROPPED_NEAR_CONTAINER_R, {
      filter: function (r) {
        var amount = Number(r.amount) || 0;
        return r.resourceType === RESOURCE_ENERGY && amount > 0;
      }
    });
    if (drops.length) {
      var bestDrop = findClosestByRange(creep.pos, drops);
      debugSay(creep, '↘️Drop');
      debugDrawLine(creep, bestDrop, CFG.DRAW.DROP_COLOR, "DROP");
      var pr = creep.pickup(bestDrop);
      if (pr === ERR_NOT_IN_RANGE) {
        creep.travelTo(bestDrop, { range: 1, reusePath: 20 });
        return true;
      }
      if (pr === OK && creep.store.getFreeCapacity() === 0) { creep.memory.transferring = true; return true; }
    }

    const energyIn = (container.store && container.store[RESOURCE_ENERGY]) || 0;
    if (energyIn <= 0) {
      // Container emptied; try a new target next tick.
      creep.memory.retargetAt = Game.time;
      return false;
    }

    debugSay(creep, '↘️Con');
    debugDrawLine(creep, container, CFG.DRAW.WD_COLOR, "CON");
    var wr = creep.withdraw(container, RESOURCE_ENERGY);
    if (wr === ERR_NOT_IN_RANGE) {
      creep.travelTo(container, { range: 1, reusePath: CFG.PATH_REUSE });
      return true;
    }
    if (wr === OK) {
      if (creep.store.getFreeCapacity() === 0) creep.memory.transferring = true;
      return true;
    }
    if (wr === ERR_NOT_ENOUGH_RESOURCES) creep.memory.retargetAt = Game.time;
    return true;
  }

  function rescanGraves(roomCache, room) {
    const nextScan = roomCache.nextGraveScanAt || 0;
    if (nextScan > Game.time) return;

    roomCache.nextGraveScanAt = Game.time + CFG.GRAVE_SCAN_COOLDOWN;
    var graves = room.find(FIND_TOMBSTONES, {
      filter: function (t) { return (t.store[RESOURCE_ENERGY] || 0) > 0; }
    });
    var ruins = room.find(FIND_RUINS, {
      filter: function (r) { return (r.store[RESOURCE_ENERGY] || 0) > 0; }
    });
    roomCache.graves = graves.concat(ruins);
  }

  function tryGraves(creep, roomCache) {
    if (!roomCache.graves || !roomCache.graves.length) return false;
    var grave = findClosestByRange(creep.pos, roomCache.graves);
    if (!grave) return false;

    debugSay(creep, '↘️Grv');
    debugDrawLine(creep, grave, CFG.DRAW.GRAVE_COLOR, "GRAVE");
    var gw = creep.withdraw(grave, RESOURCE_ENERGY);
    if (gw === ERR_NOT_IN_RANGE) {
      creep.travelTo(grave, { range: 1, reusePath: 20 });
    }
    return true;
  }

  function tryGenericDrops(creep) {
    var dropped = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
      filter: function (r) { return r.resourceType === RESOURCE_ENERGY && (r.amount || 0) >= 50; }
    });
    if (!dropped) return false;
    debugSay(creep, '↘️Drop');
    debugDrawLine(creep, dropped, CFG.DRAW.DROP_COLOR, "DROP");
    if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) {
      creep.travelTo(dropped, { range: 1, reusePath: 20 });
    }
    return true;
  }

  function tryStorageWithdraw(creep) {
    var room = creep.room;
    var storeLike = (room.storage && (room.storage.store[RESOURCE_ENERGY] || 0) > 0) ? room.storage
                  : (room.terminal && (room.terminal.store[RESOURCE_ENERGY] || 0) > 0) ? room.terminal
                  : null;
    if (!storeLike) return false;
    debugSay(creep, storeLike.structureType === STRUCTURE_STORAGE ? '↘️Sto' : '↘️Term');
    debugDrawLine(creep, storeLike, CFG.DRAW.WD_COLOR, storeLike.structureType === STRUCTURE_STORAGE ? "STO" : "TERM");
    var sr = creep.withdraw(storeLike, RESOURCE_ENERGY);
    if (sr === ERR_NOT_IN_RANGE) {
      creep.travelTo(storeLike, { range: 1, reusePath: CFG.PATH_REUSE });
    }
    return true;
  }

  function idleNearAnchor(creep) {
    var anchor = creep.room.storage || creep.pos.findClosestByRange(FIND_MY_SPAWNS) || creep.pos;
    debugSay(creep, 'IDLE');
    debugDrawLine(creep, (anchor.pos || anchor), CFG.DRAW.IDLE_COLOR, "IDLE");
    if (!creep.pos.inRangeTo(anchor, 3)) {
      creep.travelTo(anchor, { range: 3, reusePath: CFG.PATH_REUSE });
    }
  }

  function ensureDropoffTarget(creep) {
    var target = Game.getObjectById(creep.memory.dropoffId);
    if (target && getEffectiveFreeCapacity(target, RESOURCE_ENERGY) > 0) return target;

    target = pickSpawnOrExtension(creep);
    if (!target) target = pickLowTower(creep);
    if (!target) target = pickStorageSink(creep);

    if (!target) return null;
    creep.memory.dropoffId = target.id;
    return target;
  }

  function drawDeliveryIntent(creep, target) {
    var st = target.structureType;
    if (st === STRUCTURE_EXTENSION) { debugSay(creep, '→ EXT'); debugDrawLine(creep, target, CFG.DRAW.FILL_COLOR, "EXT"); }
    else if (st === STRUCTURE_SPAWN) { debugSay(creep, '→ SPN'); debugDrawLine(creep, target, CFG.DRAW.FILL_COLOR, "SPN"); }
    else if (st === STRUCTURE_TOWER) { debugSay(creep, '→ TWR'); debugDrawLine(creep, target, CFG.DRAW.FILL_COLOR, "TWR"); }
    else if (st === STRUCTURE_STORAGE) { debugSay(creep, '→ STO'); debugDrawLine(creep, target, CFG.DRAW.FILL_COLOR, "STO"); }
    else { debugSay(creep, '→ FILL'); debugDrawLine(creep, target, CFG.DRAW.FILL_COLOR, "FILL"); }
  }

  // ============================
  // Main role
  // ============================
  var roleCourier = {
    role: 'Courier',
    run: function (creep) {
      var state = determineCourierState(creep);

      if (state === 'DELIVER') {
        roleCourier.deliverEnergy(creep);
        return;
      }

      roleCourier.collectEnergy(creep);
    },

    // -----------------------------
    // Energy collection
    // -----------------------------
    collectEnergy: function (creep) {
      var now = Game.time;
      var rc = getCourierRoomCache(creep.room);
      var container = pickBestSourceContainer(creep, rc, now);

      if (tryPickupEnRoute(creep)) return;
      if (container && tryContainerWorkflow(creep, container)) return;

      rescanGraves(rc, creep.room);
      if (tryGraves(creep, rc)) return;
      if (tryGenericDrops(creep)) return;
      if (tryStorageWithdraw(creep)) return;
      idleNearAnchor(creep);
    },

    // -----------------------------
    // Delivery (PIB-aware, avoids Queen conflicts)
    // -----------------------------
    deliverEnergy: function (creep) {
      var carryAmt = creep.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
      if (carryAmt <= 0) { creep.memory.transferring = false; creep.memory.dropoffId = null; return; }

      var target = ensureDropoffTarget(creep);
      if (!target) { idleNearAnchor(creep); return; }

      var reserved = reserveFill(creep, target, carryAmt, RESOURCE_ENERGY);
      if (reserved <= 0) { creep.memory.dropoffId = null; return; }

      drawDeliveryIntent(creep, target);
      var tr = transferTo(creep, target, RESOURCE_ENERGY);
      if (tr === OK && (creep.store[RESOURCE_ENERGY] || 0) === 0) {
        creep.memory.transferring = false;
        creep.memory.dropoffId = null;
      }
    }
  };

module.exports = roleCourier;
