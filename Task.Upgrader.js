// role.TaskUpgrader.PIB.es5.js
// ES5-safe Upgrader with Predictive Intent Buffer + Smart Energy Flow
// Learns from Queen logic: future-aware withdraw/upgrade, energy routing, and sign control
'use strict';

var BeeToolbox = require('BeeToolbox');

/* =========================
   Tunables
========================= */
var CONTROLLER_SIGN = "BeeNice Please.";
var CONTROLLER_REFILL_DELAY = 5; // ticks to wait after controller received energy before returning
var MIN_PICKUP_AMOUNT = 50;      // skip tiny dropped piles

/* =========================
   PIB helpers
========================= */
function pibSet(creep, type, targetId, nextTargetId) {
  creep.memory.pib = { t: type, id: targetId, next: nextTargetId, setAt: Game.time|0 };
}
function pibClear(creep) { creep.memory.pib = null; }
function _doAction(creep, type, target) {
  if (type === 'withdraw') return creep.withdraw(target, RESOURCE_ENERGY);
  if (type === 'pickup')   return creep.pickup(target);
  if (type === 'upgrade')  return creep.upgradeController(target);
  return ERR_INVALID_ARGS;
}
function pibTry(creep) {
  var pib = creep.memory.pib;
  if (!pib) return false;
  var tgt = Game.getObjectById(pib.id);
  if (!tgt) { pibClear(creep); return false; }
  if (creep.pos.getRangeTo(tgt) > 1) { pibClear(creep); return false; }
  var rc = _doAction(creep, pib.t, tgt);
  if (rc === OK && pib.next) {
    var nxt = Game.getObjectById(pib.next);
    if (nxt) BeeToolbox.BeeTravel(creep, nxt);
  }
  pibClear(creep);
  return rc === OK;
}

/* =========================
   Support pick sources
========================= */
function chooseEnergySource(creep, room) {
  var controller = room.controller;
  var i, best, bestAmt, r;

  // 1) Controller container within 5 tiles
  var cont = controller ? controller.pos.findClosestByRange(FIND_STRUCTURES, {
    filter: function(s){
      return s.structureType === STRUCTURE_CONTAINER &&
             s.store[RESOURCE_ENERGY] > 0 &&
             s.pos.getRangeTo(controller) <= 5;
    }
  }) : null;
  if (cont) return cont;

  // 2) Controller link
  var link = creep.pos.findClosestByRange(FIND_STRUCTURES, {
    filter: function(s){
      return s.structureType === STRUCTURE_LINK &&
             controller && s.pos.inRangeTo(controller, 3) &&
             s.store[RESOURCE_ENERGY] > 0;
    }
  });
  if (link) return link;

  // 3) Dropped energy (largest first)
  var drops = room.find(FIND_DROPPED_RESOURCES, {
    filter: function(r){ return r.resourceType===RESOURCE_ENERGY && (r.amount|0)>=MIN_PICKUP_AMOUNT; }
  });
  if (drops.length > 0) {
    best = drops[0];
    for (i=1; i<drops.length; i++) {
      r = drops[i];
      if (r.amount > best.amount) best = r;
    }
    return best;
  }

  // 4) Any container with energy
  var containers = room.find(FIND_STRUCTURES, {
    filter: function(s){ return s.structureType===STRUCTURE_CONTAINER && s.store[RESOURCE_ENERGY]>0; }
  });
  if (containers.length > 0) return creep.pos.findClosestByPath(containers);

  // 5) Storage fallback
  if (room.storage && room.storage.store[RESOURCE_ENERGY]>0) return room.storage;

  return null;
}

/* =========================
   Controller sign helper
========================= */
function checkAndUpdateControllerSign(creep, controller) {
  if (!controller) return;
  if (!controller.sign || controller.sign.text !== CONTROLLER_SIGN) {
    if (creep.pos.inRangeTo(controller.pos, 1)) {
      creep.signController(controller, CONTROLLER_SIGN);
    } else {
      BeeToolbox.BeeTravel(creep, controller);
    }
  }
}

/* =========================
   TaskUpgrader main
========================= */
var TaskUpgrader = {
  run: function(creep) {
    if (!creep) return;

    var store = creep.store;
    var room = creep.room;
    var controller = room.controller;
    var lastUpgrade = creep.memory.lastUpgradeTick || 0;

    // Try any planned PIB action first
    if (pibTry(creep)) return;

    // Switch states
    if (creep.memory.upgrading && store[RESOURCE_ENERGY] === 0) {
      creep.memory.upgrading = false;
      creep.memory.lastUpgradeTick = Game.time;
    } else if (!creep.memory.upgrading && store.getFreeCapacity() === 0) {
      creep.memory.upgrading = true;
    }

    // === STATE: UPGRADING ===
    if (creep.memory.upgrading) {
      if (controller) {
        if (controller.level === 8 && controller.ticksToDowngrade > 180000) return;
        var d = creep.pos.getRangeTo(controller);
        if (d >= 2) {
          if (d === 2) pibSet(creep, 'upgrade', controller.id, null);
          BeeToolbox.BeeTravel(creep, controller);
          return;
        }
        creep.upgradeController(controller);
        checkAndUpdateControllerSign(creep, controller);
      }
      return;
    }

    // === STATE: FETCHING ENERGY ===
    // Small pause if we *just* upgraded recently
    if (Game.time - lastUpgrade < CONTROLLER_REFILL_DELAY) {
      creep.say('⏳ recharge');
    }

    var src = chooseEnergySource(creep, room);
    if (!src) {
      // nothing found, idle near controller
      BeeToolbox.BeeTravel(creep, controller);
      return;
    }

    var dist = creep.pos.getRangeTo(src);
    var isDrop = (src.amount != null);
    var nextTarget = controller ? controller.id : null;

    if (dist >= 2) {
      if (dist === 2) pibSet(creep, isDrop ? 'pickup' : 'withdraw', src.id, nextTarget);
      BeeToolbox.BeeTravel(creep, src);
      return;
    }

    var rc = isDrop ? creep.pickup(src) : creep.withdraw(src, RESOURCE_ENERGY);
    if (rc === ERR_NOT_IN_RANGE) {
      BeeToolbox.BeeTravel(creep, src);
      return;
    }
    if (rc === OK && controller) BeeToolbox.BeeTravel(creep, controller);
  }
};

module.exports = TaskUpgrader;
