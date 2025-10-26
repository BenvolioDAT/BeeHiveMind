// role.TaskUpgrader.PIB.es5.js
// ES5-safe Upgrader with Predictive Intent Buffer + Smart Energy Flow + Sign Management
// Optimized for low CPU and clear intent tracking (Traveler-compatible)

'use strict';

var Traveler = null;
try {
  Traveler = require('Traveler');
} catch (error) {
  Traveler = null;
}

function beeExtend(target, source) {
  if (!target || !source) return target;
  for (var key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      target[key] = source[key];
    }
  }
  return target;
}

function beeTravel(creep, target, a3, a4, a5) {
  if (!creep || !target) return ERR_INVALID_TARGET;

  var destination = (target && target.pos) ? target.pos : target;
  var opts = {};

  if (a3 && typeof a3 === 'object') {
    opts = a3;
  } else {
    if (typeof a3 === 'number') opts.range = a3;
    if (a5 && typeof a5 === 'object') beeExtend(opts, a5);
  }

  var options = {
    range: (opts.range != null) ? opts.range : 1,
    ignoreCreeps: (opts.ignoreCreeps != null) ? opts.ignoreCreeps : true,
    useFindRoute: (opts.useFindRoute != null) ? opts.useFindRoute : true,
    stuckValue: (opts.stuckValue != null) ? opts.stuckValue : 2,
    repath: (opts.repath != null) ? opts.repath : 0.05,
    returnData: {}
  };

  beeExtend(options, opts);

  if (Traveler && typeof Traveler.travelTo === 'function') {
    try {
      return Traveler.travelTo(creep, destination, options);
    } catch (err) {
      // fall back to moveTo below
    }
  }

  var destPos = destination;
  if (destPos && destPos.pos) destPos = destPos.pos;
  if (!destPos || destPos.x == null || destPos.y == null || !destPos.roomName) {
    return ERR_INVALID_TARGET;
  }
  return creep.moveTo(destPos, { reusePath: 20, maxOps: 2000 });
}

/* =========================
   Tunables
========================= */
var UPGRADER_SIGN_TEXT = "BeeNice Please.";
var UPGRADER_REFILL_DELAY = 5;    // ticks to wait after upgrading before fetching energy
var MIN_PICKUP_AMOUNT = 50;       // skip tiny dropped piles
var MAX_CONTAINER_RANGE = 5;
var MAX_LINK_RANGE = 3;
var MAX_UPGRADE_RANGE = 3;        // <-- can upgrade up to range 3

/* =========================
   PIB (Predictive Intent Buffer)
========================= */
function pibSet(creep, type, targetId, nextTargetId) {
  creep.memory.pib = { t: type, id: targetId, next: nextTargetId, setAt: Game.time | 0 };
}

function pibClear(creep) {
  creep.memory.pib = null;
}

/**
 * Executes stored PIB intent if still valid.
 * Returns true if an action was performed.
 */
function pibAct(creep) {
  var pib = creep.memory.pib;
  if (!pib) return false;

  var tgt = Game.getObjectById(pib.id);
  if (!tgt) {
    pibClear(creep);
    return false;
  }

  if (creep.pos.getRangeTo(tgt) > 3) {
    beeTravel(creep, tgt);
    return false;
  }

  var rc;
  if (pib.t === 'withdraw') rc = creep.withdraw(tgt, RESOURCE_ENERGY);
  else if (pib.t === 'pickup') rc = creep.pickup(tgt);
  else if (pib.t === 'upgrade') rc = creep.upgradeController(tgt);
  else rc = ERR_INVALID_ARGS;

  if (rc === OK && pib.next) {
    var nxt = Game.getObjectById(pib.next);
    if (nxt) beeTravel(creep, nxt);
  }

  pibClear(creep);
  return rc === OK;
}

/* =========================
   Energy Source Selection
========================= */
function chooseEnergySource(creep, room) {
  var sources = [];
  var controller = room.controller;

  // Containers and links near controller
  var structs = room.find(FIND_STRUCTURES, {
    filter: function(s) {
      if (s.store && s.store[RESOURCE_ENERGY] > 0) {
        if (s.structureType === STRUCTURE_CONTAINER && controller &&
            s.pos.getRangeTo(controller) <= MAX_CONTAINER_RANGE)
          return true;
        if (s.structureType === STRUCTURE_LINK && controller &&
            s.pos.inRangeTo(controller, MAX_LINK_RANGE))
          return true;
      }
      return false;
    }
  });
  Array.prototype.push.apply(sources, structs);

  // Dropped energy piles
  var drops = room.find(FIND_DROPPED_RESOURCES, {
    filter: function(r) {
      return r.resourceType === RESOURCE_ENERGY && r.amount >= MIN_PICKUP_AMOUNT;
    }
  });
  Array.prototype.push.apply(sources, drops);

  // Generic containers with energy
  var containers = room.find(FIND_STRUCTURES, {
    filter: function(s) {
      return s.structureType === STRUCTURE_CONTAINER && s.store[RESOURCE_ENERGY] > 0;
    }
  });
  Array.prototype.push.apply(sources, containers);

  // Storage fallback
  if (room.storage && room.storage.store[RESOURCE_ENERGY] > 0)
    sources.push(room.storage);

  if (sources.length === 0) return null;

  // Choose best by weighted score: high energy, short distance
  var best = null;
  var bestScore = -99999;
  for (var i = 0; i < sources.length; i++) {
    var s = sources[i];
    var amt = s.amount || (s.store ? s.store[RESOURCE_ENERGY] : 0) || 0;
    var range = creep.pos.getRangeTo(s);
    var score = amt - range * 10; // weight energy more, distance less
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  }
  return best;
}

/* =========================
   Controller Sign Helper
========================= */
function updateControllerSign(creep, controller) {
  if (!controller) return;
  if (!controller.sign || controller.sign.text !== UPGRADER_SIGN_TEXT) {
    if (creep.pos.inRangeTo(controller, 1))
      creep.signController(controller, UPGRADER_SIGN_TEXT);
    else
      beeTravel(creep, controller);
  }
}

/* =========================
   TaskUpgrader Main Logic
========================= */
var TaskUpgrader = {

  run: function(creep) {
    if (!creep) return;

    var room = creep.room;
    var controller = room.controller;
    var store = creep.store;
    var lastUpgrade = creep.memory.lastUpgradeTick || 0;

    // Try any pending PIB action first
    if (pibAct(creep)) return;

    /* === STATE SWITCH === */
    if (creep.memory.upgrading && store[RESOURCE_ENERGY] === 0) {
      creep.memory.upgrading = false;
      creep.memory.lastUpgradeTick = Game.time;
    } else if (!creep.memory.upgrading && store.getFreeCapacity() === 0) {
      creep.memory.upgrading = true;
    }

    /* === STATE: UPGRADING === */
    if (creep.memory.upgrading) {
      if (controller) {
        // Skip wasteful upgrading when RCL8 and safe
        if (controller.level === 8 && controller.ticksToDowngrade > 180000)
          return;

        var d = creep.pos.getRangeTo(controller);

        // If too far, move in until within range 3
        if (d > MAX_UPGRADE_RANGE) {
          beeTravel(creep, controller);
          return;
        }

        // Within upgrade range, attempt action
        var rc = creep.upgradeController(controller);
        if (rc === ERR_NOT_IN_RANGE) {
          beeTravel(creep, controller);
          return;
        }

        // Cache predictive intent if at edge of range
        if (d === MAX_UPGRADE_RANGE)
          pibSet(creep, 'upgrade', controller.id, null);

        updateControllerSign(creep, controller);
      }
      return;
    }

    /* === STATE: FETCHING ENERGY === */
    if (Game.time - lastUpgrade < UPGRADER_REFILL_DELAY) {
      creep.say('⏳ recharge');
      return;
    }

    var src = chooseEnergySource(creep, room);
    if (!src) {
      // Nothing found, idle near controller
      if (controller) beeTravel(creep, controller);
      return;
    }

    var dist = creep.pos.getRangeTo(src);
    var isDrop = (src.amount != null);
    var nextTarget = controller ? controller.id : null;

    if (dist > 1) {
      if (dist === 2)
        pibSet(creep, isDrop ? 'pickup' : 'withdraw', src.id, nextTarget);
      beeTravel(creep, src);
      return;
    }

    var rc2 = isDrop ? creep.pickup(src) : creep.withdraw(src, RESOURCE_ENERGY);
    if (rc2 === ERR_NOT_IN_RANGE) {
      beeTravel(creep, src);
      return;
    }
    if (rc2 === OK && controller)
      beeTravel(creep, controller);
  }

};

module.exports = TaskUpgrader;
