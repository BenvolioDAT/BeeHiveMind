'use strict';
var CoreLogger = require('core.logger');
var BeeRoleVisuals = require('BeeRoleVisuals');
var BeeRoles = require('BeeRoles');
var MovementManager = require('Movement.Manager');
var courierLog = CoreLogger.createLogger('Courier', CoreLogger.LOG_LEVEL.BASIC);

var COURIER_STATE = Object.freeze({
  COLLECT: 'COLLECT',
  DELIVER: 'DELIVER'
});

function describeError(e) {
  return e && (e.stack || e.message || String(e));
}


function hasUsableTravelTarget(target) {
  var pos = target && (target.pos || target);
  return !!(pos && typeof pos.x === 'number' && typeof pos.y === 'number' && pos.roomName);
}

function isManagerRequestHandled(result) {
  return result === OK || (typeof result === 'number' && result > OK);
}

function requestCourierMove(creep, target, range, opts, reason) {
  // Use MovementManager.request for Courier movement arbitration.
  // OK = accepted/replaced.
  // numeric > OK = existing higher/equal intent kept.
  // ERR_INVALID_ARGS or manager unavailable = no direct fallback in this phase.
  if (!creep || !target) return ERR_INVALID_ARGS;
  if (!hasUsableTravelTarget(target)) return ERR_INVALID_ARGS;
  if (!MovementManager || typeof MovementManager.request !== 'function') return ERR_INVALID_ARGS;

  var requestOpts = opts ? Object.assign({}, opts) : {};
  requestOpts.range = range;
  requestOpts.intentType = requestOpts.intentType || 'courier_deliver';

  var requestResult = MovementManager.request(creep, target, null, requestOpts);
  if (isManagerRequestHandled(requestResult)) return requestResult;
  if (requestResult === ERR_INVALID_ARGS) return ERR_INVALID_ARGS;
  return requestResult;
}

// Role-specific debug and visual settings.
var CFG = Object.freeze({
  DEBUG_SAY: false,
  DEBUG_DRAW: true,
  DRAW: {
    WD_COLOR:    "#6ec1ff",  // withdraw lines
    FILL_COLOR:  "#6effa1",  // delivery lines
    DROP_COLOR:  "#ffe66e",  // dropped energy
    GRAVE_COLOR: "#ffb0e0",  // tombstones/ruins
    IDLE_COLOR:  "#bfbfbf",
    WIDTH:   0.12,
    OPACITY: 0.45,
    FONT:    0.6
  },
  TOWER_REFILL_AT_OR_BELOW: 0.70,
  PATH_REUSE: 40,
  RETARGET_COOLDOWN: 10,
  GRAVE_SCAN_COOLDOWN: 20,
  BETTER_CONTAINER_DELTA: 150,
  CONTAINER_MIN: 50,
  DROPPED_BIG_MIN: 150,
  DROPPED_NEAR_CONTAINER_R: 2,
  DROPPED_ALONG_ROUTE_R: 2,
});

// -------------------------
// Shared tiny helpers (copied for role self-containment)
// -------------------------
function debugSay(creep, msg) {
  BeeRoleVisuals.debugSay(CFG.DEBUG_SAY, creep, msg);
}

function debugDrawLine(creep, target, color, label) {
  try {
    BeeRoleVisuals.drawLine(CFG.DEBUG_DRAW, creep, target, color, label, CFG.DRAW);
  } catch (e) {
    courierLog.warnEvery('courier.debugDrawLine.visual', 250, 'debugDrawLine failed for', creep && creep.name, describeError(e));
  }
}

  // Shares PIB + same-tick reservation scheme with Queen to avoid target dogpiles.

  // ============================
  // Per-tick room cache
  // ============================
  if (!global.__COURIER) global.__COURIER = { tick: -1, rooms: {} };

  // Returns the per-tick cache of source containers and graves for this room.
  function getCourierRoomCache(room) {
    var G = global.__COURIER;
    if (G.tick !== Game.time) {
      G.tick = Game.time;
      G.rooms = {};
    }
    var R = G.rooms[room.name];
    if (R) return R;

    var containers = room.find(FIND_STRUCTURES, {
      filter: function (s) { return s.structureType === STRUCTURE_CONTAINER; }
    });

    var srcIds = [];
    var otherIds = [];
    var bestId = null;
    var bestEnergy = -1;

    for (var i = 0; i < containers.length; i++) {
      var c = containers[i];
      var isSrc = c.pos.findInRange(FIND_SOURCES, 1).length > 0;
      var energy = (c.store && c.store[RESOURCE_ENERGY]) || 0;

      if (isSrc) {
        srcIds.push(c.id);
        if (energy > bestEnergy) {
          bestEnergy = energy;
          bestId = c.id;
        }
      } else {
        otherIds.push(c.id);
      }
    }

    R = {
      srcIds: srcIds,                 // ids of source-adjacent containers
      otherIds: otherIds,             // ids of non-source containers (rarely used here)
      bestSrcId: bestId,
      bestSrcEnergy: bestEnergy,
      nextGraveScanAt: (Game.time + 1),
      graves: []                      // tombstones/ruins with energy
    };
    G.rooms[room.name] = R;
    return R;
  }

  // Resolves an array of ids into live game objects, skipping null entries.
  function getCourierObjectsFromIds(ids) {
    var out = [];
    for (var i = 0; i < ids.length; i++) {
      var o = Game.getObjectById(ids[i]);
      if (o) out.push(o);
    }
    return out;
  }

  // ============================
  // Movement + tiny utils (ES5-safe)
  // ============================
  function isGoodContainer(c) {
    if (!c || c.structureType !== STRUCTURE_CONTAINER || !c.store) return false;
    var stored = c.store[RESOURCE_ENERGY] || 0;
    return stored >= CFG.CONTAINER_MIN;
  }

  // Basic distance helper that picks the closest object in arr to a position.
  function findClosestByRange(pos, arr) {
    var best = null, bestD = 1e9;
    for (var i = 0; i < arr.length; i++) {
      var o = arr[i];
      var d = pos.getRangeTo(o);
      if (d < bestD) { bestD = d; best = o; }
    }
    return best;
  }

  // Returns the stored energy for a given structure or 0 if unknown.
  function getStructureEnergy(c) {
    if (!c || !c.store) return 0;
    return c.store[RESOURCE_ENERGY] || 0;
  }

  // Checks if container A holds significantly more energy than container B.
  function isContainerClearlyBetter(a, b) {
    var ae = getStructureEnergy(a);
    var be = getStructureEnergy(b);
    return ae > (be + CFG.BETTER_CONTAINER_DELTA);
  }

  // ============================
  // PIB + same-tick reservations (shared with Queen)
  // ============================
  // Returns the per-tick reservation map used to avoid double-filling sinks.
  function getQueenReservationMap() {
    if (!Memory._queenRes || Memory._queenRes.tick !== Game.time) {
      Memory._queenRes = { tick: Game.time, map: {} };
    }
    return Memory._queenRes.map;
  }

  // Reads how much energy has been reserved for the given structure this tick.
  function getReservedEnergyForStructure(structId) {
    var map = getQueenReservationMap();
    return map[structId] || 0;
  }

  // Totals up PIB reservations for a target so we respect in-flight deliveries.
  function sumPibReservedEnergy(roomName, targetId, resourceType) {
    resourceType = resourceType || RESOURCE_ENERGY;
    var root = Memory._PIB;
    if (!root || root.tick !== Game.time || !root.rooms) return 0;
    var R = root.rooms[roomName];
    if (!R || !R.fills) return 0;
    var map = R.fills[targetId];
    if (!map) return 0;
    var sum = 0;
    var keys = Object.keys(map);
    for (var i = 0; i < keys.length; i++) {
      var v = map[keys[i]];
      if (!v || v.res !== resourceType) continue;
      sum += (v.amount || 0);
    }
    return sum;
  }

  // Books a PIB fill so other haulers respect our in-flight intent.
  function reservePibFill(creep, target, amount, resourceType) {
    resourceType = resourceType || RESOURCE_ENERGY;
    if (!Memory._PIB) Memory._PIB = { tick: Game.time, rooms: {} };
    if (Memory._PIB.tick !== Game.time) {
      Memory._PIB = { tick: Game.time, rooms: {} };
    }
    var roomName = (target.pos && target.pos.roomName) || (creep.room && creep.room.name);
    if (!roomName) return 0;

    var root = Memory._PIB;
    if (!root.rooms[roomName]) root.rooms[roomName] = { fills: {}, withdrawals: {} };
    var R = root.rooms[roomName];
    if (!R.fills[target.id]) R.fills[target.id] = {};
    var eta = creep.pos.getRangeTo(target);
    var booked = Math.max(0, Math.min(Math.floor(amount || 0), getEffectiveFreeCapacity(target, resourceType)));

    R.fills[target.id][creep.name] = {
      res: resourceType,
      amount: booked,
      untilTick: Game.time + eta
    };
    return booked;
  }

  // Removes a previously registered PIB fill reservation when done or failed.
  function releasePibFill(creep, target, resourceType) {
    if (!creep || !target) return;
    resourceType = resourceType || RESOURCE_ENERGY;
    var roomName = (target.pos && target.pos.roomName) || (creep.room && creep.room.name);
    if (!roomName) return;

    var root = Memory._PIB;
    if (!root || !root.rooms) return;
    var R = root.rooms[roomName];
    if (!R || !R.fills) return;
    var map = R.fills[target.id];
    if (map && map[creep.name]) delete map[creep.name];
    if (map && Object.keys(map).length === 0) delete R.fills[target.id];
  }

  // Effective free capacity that respects reservations
  // Returns a structure's free capacity minus reservations (same tick + PIB).
  function getEffectiveFreeCapacity(struct, resourceType) {
    resourceType = resourceType || RESOURCE_ENERGY;
    var freeNow = (struct.store && struct.store.getFreeCapacity(resourceType)) || 0;
    var sameTick = getReservedEnergyForStructure(struct.id) || 0;
    var roomName = (struct.pos && struct.pos.roomName) || (struct.room && struct.room.name);
    var pib = roomName ? sumPibReservedEnergy(roomName, struct.id, resourceType) : 0;
    return Math.max(0, freeNow - sameTick - pib);
  }

  // Reserve up to `amount` for this creep (same-tick + PIB)
  function reserveFill(creep, target, amount, resourceType) {
    resourceType = resourceType || RESOURCE_ENERGY;
    var map = getQueenReservationMap();
    var free = getEffectiveFreeCapacity(target, resourceType);
    var requested = Math.max(0, Math.floor(Number(amount) || 0));
    var want = Math.max(0, Math.min(requested, free));
    if (want > 0) {
      map[target.id] = (map[target.id] || 0) + want;
      creep.memory.dropoffId = target.id;
      reservePibFill(creep, target, want, resourceType);
    }
    return want;
  }

  // Transfer wrapper that releases PIB intent properly
  function transferTo(creep, target, res) {
    res = res || RESOURCE_ENERGY;
    var rc = creep.transfer(target, res);

    if (rc === ERR_NOT_IN_RANGE) {
      // Delivery movement is routed through MovementManager first with no direct fallback in this phase.
      // Collect and idle movement remain direct for staged migration in later phases.
      requestCourierMove(creep, target, 1, { reusePath: CFG.PATH_REUSE }, 'courier.deliver.transfer');
      return rc;
    }

    if (rc === OK) {
      releasePibFill(creep, target, res);
    } else if (rc === ERR_FULL) {
      releasePibFill(creep, target, res);
      creep.memory.dropoffId = null;
    } else if (rc !== OK && rc !== ERR_TIRED && rc !== ERR_BUSY) {
      releasePibFill(creep, target, res);
      creep.memory.dropoffId = null;
    }
    return rc;
  }

  // ============================
  // Targeting helpers for DELIVERY
  // ============================
  // Finds the closest spawn/extension that still needs energy.
  function pickSpawnOrExtension(creep) {
    var list = creep.room.find(FIND_STRUCTURES, {
      filter: function (s) {
        if (!s.store) return false;
        var t = s.structureType;
        if (t !== STRUCTURE_SPAWN && t !== STRUCTURE_EXTENSION) return false;
        return getEffectiveFreeCapacity(s, RESOURCE_ENERGY) > 0;
      }
    });
    return list.length ? findClosestByRange(creep.pos, list) : null;
  }

  // Chooses a tower below the refill threshold with remaining free capacity.
  function pickLowTower(creep) {
    var list = creep.room.find(FIND_STRUCTURES, {
      filter: function (s) {
        if (s.structureType !== STRUCTURE_TOWER || !s.store) return false;
        var used = s.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
        var cap  = s.store.getCapacity(RESOURCE_ENERGY) || 0;
        if (cap <= 0) return false;
        var pct = used / cap;
        if (pct > CFG.TOWER_REFILL_AT_OR_BELOW) return false; // only if low enough
        return getEffectiveFreeCapacity(s, RESOURCE_ENERGY) > 0;
      }
    });
    return list.length ? findClosestByRange(creep.pos, list) : null;
  }

  // Returns storage if it can still accept energy.
  function pickStorageSink(creep) {
    var st = creep.room.storage;
    if (!st || !st.store) return null;
    if (getEffectiveFreeCapacity(st, RESOURCE_ENERGY) <= 0) return null;
    return st;
  }

  // -----------------------------
  // A) Identity + state helpers
  // -----------------------------
  function ensureCourierIdentity(creep) {
    if (!creep || !creep.memory) return;
    creep.memory.role = BeeRoles.ROLE_NAMES.COURIER;
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
    creep.memory.state = creep.memory.transferring ? COURIER_STATE.DELIVER : COURIER_STATE.COLLECT;
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
      requestCourierMove(creep, pile, 1, { reusePath: 20, intentType: 'courier_collect' }, 'courier.collect.pickupEnRoute');
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
        requestCourierMove(creep, bestDrop, 1, { reusePath: 20, intentType: 'courier_collect' }, 'courier.collect.containerDropPickup');
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
      requestCourierMove(creep, container, 1, { reusePath: CFG.PATH_REUSE, intentType: 'courier_collect' }, 'courier.collect.containerWithdraw');
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
      requestCourierMove(creep, grave, 1, { reusePath: 20, intentType: 'courier_collect' }, 'courier.collect.graveWithdraw');
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
      requestCourierMove(creep, dropped, 1, { reusePath: 20, intentType: 'courier_collect' }, 'courier.collect.genericDrop');
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
      requestCourierMove(creep, storeLike, 1, { reusePath: CFG.PATH_REUSE, intentType: 'courier_collect' }, 'courier.collect.storageWithdraw');
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

      // Story step 1-2: prepare memory and decide state.
      if (state === COURIER_STATE.DELIVER) {
        // Story step 3-5 (deliver): pick target, act, request movement if needed.
        roleCourier.deliverEnergy(creep);
        return;
      }

      // Story step 3-5 (collect): pick target, act, request movement if needed.
      roleCourier.collectEnergy(creep);
    },

    // -----------------------------
    // Energy collection
    // -----------------------------
    collectEnergy: function (creep) {
      var now = Game.time;
      var rc = getCourierRoomCache(creep.room);
      var container = pickBestSourceContainer(creep, rc, now);

      // Decision order for beginners (behavior preserved):
      // 1) en-route dropped energy
      // 2) source container workflow (including nearby drops)
      // 3) graves/ruins
      // 4) generic dropped energy
      // 5) storage/terminal withdraw
      // 6) idle near anchor
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
      // Delivery order for beginners (behavior preserved):
      // spawn/extension -> tower -> storage (selected in ensureDropoffTarget)
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
