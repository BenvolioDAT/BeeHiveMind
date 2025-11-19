'use strict';

var BeeHelper = require('role.BeeHelper');
var BeeToolbox = require('BeeToolbox');
var CFG = BeeHelper.config;
var debugSay = BeeHelper.debugSay;
var debugDrawLine = BeeHelper.debugDrawLine;
var debugRing = BeeHelper.debugRing;

var roleUpgrader = (function () {
  // -----------------------------
  // A) Tiny helpers (room lookups, signing)
  // -----------------------------
  /** =========================
   *  Tiny debug helpers
   *  ========================= */
  // Returns the room object for a given position if visible.
  function getRoomOfPos(pos) { return pos && Game.rooms[pos.roomName]; }

  /** =========================
   *  Travel wrapper (with path line)
   *  ========================= */
  /** =========================
   *  Sign helper (unchanged logic, plus visuals)
   *  ========================= */
  function checkAndUpdateControllerSign(creep, controller) {
    if (!controller) return;
    var msg = CFG.SIGN_TEXT;

    var needs = (!controller.sign) || (controller.sign.text !== msg);
    if (!needs) return;

    if (creep.pos.inRangeTo(controller.pos, 1)) {
      var res = creep.signController(controller, msg);
      if (res === OK) {
        debugSay(creep, "🖊️");
        debugRing(getRoomOfPos(controller.pos), controller.pos, CFG.DRAW.CTRL, "signed");
        console.log("Upgrader " + creep.name + " updated the controller sign.");
      } else {
        console.log("Upgrader " + creep.name + " failed to update the controller sign. Error: " + res);
      }
    } else {
      debugSay(creep, "📝");
      debugDrawLine(creep, controller, CFG.DRAW.CTRL, "CTRL");
      creep.travelTo(controller, { range: 1, reusePath: CFG.PATH_REUSE });
    }
  }

  function pickDroppedEnergy(creep) {
    var targetDroppedEnergyId = creep.memory.targetDroppedEnergyId;
    var droppedResource = targetDroppedEnergyId ? Game.getObjectById(targetDroppedEnergyId) : null;
    if (!droppedResource) {
      droppedResource = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
        filter: function (r) {
          return r.resourceType === RESOURCE_ENERGY && r.amount > 0;
        }
      });
      if (droppedResource) {
        creep.memory.targetDroppedEnergyId = droppedResource.id;
      }
    }
    if (droppedResource) {
      var dropRoom = getRoomOfPos(droppedResource.pos);
      debugRing(dropRoom, droppedResource.pos, CFG.DRAW.DROP, 'drop');
      debugDrawLine(creep, droppedResource, CFG.DRAW.DROP, 'DROP');
      var pr = creep.pickup(droppedResource);
      if (pr === ERR_NOT_IN_RANGE) {
        creep.travelTo(droppedResource, { range: 1, reusePath: CFG.PATH_REUSE });
      } else if (pr === OK) {
        debugSay(creep, "📦");
        creep.memory.targetDroppedEnergyId = null;
      }
      return true;
    }
    creep.memory.targetDroppedEnergyId = null;
    return false;
  }

  // =========================
  // Main role
  // =========================
  return {
    role: 'Upgrader',

    run: function (creep) {
      if (!creep) return;
      ensureUpgraderIdentity(creep);
      var state = determineUpgraderState(creep);

      if (state === 'UPGRADE') {
        runUpgradePhase(creep);
        return;
      }
      runRefuelPhase(creep);
    }
  };

  function ensureUpgraderIdentity(creep) {
    if (!creep || !creep.memory) return;
    creep.memory.role = 'Upgrader';
    if (!creep.memory.task) creep.memory.task = 'upgrader';
  }

  // Memory keys:
  // - targetDroppedEnergyId: id of dropped energy we are heading toward
  // - upgrading: boolean indicating REFUEL vs UPGRADE mode

  function determineUpgraderState(creep) {
    if (creep.memory.upgrading && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.upgrading = false;
      creep.memory.targetDroppedEnergyId = null;
      debugSay(creep, "🔄 refuel");
    } else if (!creep.memory.upgrading && creep.store.getFreeCapacity() === 0) {
      creep.memory.upgrading = true;
      debugSay(creep, "⚡ upgrade");
    }
    creep.memory.state = creep.memory.upgrading ? 'UPGRADE' : 'REFUEL';
    return creep.memory.state;
  }

  // -----------------------------
  // B) Upgrade phase
  // -----------------------------
  function runUpgradePhase(creep) {
    var controller = creep.room.controller;
    if (!controller) return;

    if (shouldPauseAtSafeRCL8(controller)) {
      checkAndUpdateControllerSign(creep, controller);
      debugSay(creep, "⏸");
      debugRing(getRoomOfPos(controller.pos), controller.pos, CFG.DRAW.CTRL, "safe");
      return;
    }

    var ur = creep.upgradeController(controller);
    if (ur === ERR_NOT_IN_RANGE) {
      debugDrawLine(creep, controller, CFG.DRAW.CTRL, "CTRL");
      creep.travelTo(controller, { range: 3, reusePath: CFG.PATH_REUSE });
    } else if (ur === OK) {
      debugRing(getRoomOfPos(controller.pos), controller.pos, CFG.DRAW.CTRL, "UP");
    }
    checkAndUpdateControllerSign(creep, controller);
  }

  function shouldPauseAtSafeRCL8(controller) {
    if (!CFG.SKIP_RCL8_IF_SAFE) return false;
    if (controller.level !== 8) return false;
    return (controller.ticksToDowngrade | 0) > CFG.RCL8_SAFE_TTL;
  }

  // -----------------------------
  // C) Refuel phase
  // -----------------------------
  function runRefuelPhase(creep) {
    if (tryLinkPull(creep)) return;
    tryToolboxSweep(creep);
    if (tryWithdrawStorage(creep)) return;
    if (tryWithdrawContainer(creep)) return;
    if (pickDroppedEnergy(creep)) return;
    if (CFG.DEBUG_DRAW) debugSay(creep, "❓");
  }

  function tryLinkPull(creep) {
    var ctrl = creep.room.controller;
    if (!ctrl) return false;
    var linkNearController = creep.pos.findClosestByRange(FIND_STRUCTURES, {
      filter: function (s) {
        return s.structureType === STRUCTURE_LINK &&
          s.store && (s.store[RESOURCE_ENERGY] | 0) > 0 &&
          s.pos.inRangeTo(ctrl, 3);
      }
    });
    if (!linkNearController) return false;
    var lr = creep.withdraw(linkNearController, RESOURCE_ENERGY);
    var linkRoom = getRoomOfPos(linkNearController.pos);
    debugRing(linkRoom, linkNearController.pos, CFG.DRAW.LINK, "LINK");
    debugDrawLine(creep, linkNearController, CFG.DRAW.LINK, "LINK");
    if (lr === ERR_NOT_IN_RANGE) {
      creep.travelTo(linkNearController, { range: 1, reusePath: CFG.PATH_REUSE });
    }
    return true;
  }

  function tryToolboxSweep(creep) {
    try {
      if (BeeToolbox && typeof BeeToolbox.collectEnergy === 'function') {
        BeeToolbox.collectEnergy(creep);
      }
    } catch (e) {}
  }

  function tryWithdrawStorage(creep) {
    var stor = creep.room.storage;
    if (!stor || !stor.store || (stor.store[RESOURCE_ENERGY] | 0) <= 0) return false;
    debugRing(getRoomOfPos(stor.pos), stor.pos, CFG.DRAW.STORE, "STO");
    debugDrawLine(creep, stor, CFG.DRAW.STORE, "STO");
    var sr = creep.withdraw(stor, RESOURCE_ENERGY);
    if (sr === ERR_NOT_IN_RANGE) {
      creep.travelTo(stor, { range: 1, reusePath: CFG.PATH_REUSE });
    }
    return true;
  }

  function tryWithdrawContainer(creep) {
    var containerWithEnergy = creep.pos.findClosestByPath(FIND_STRUCTURES, {
      filter: function (s) {
        return s.structureType === STRUCTURE_CONTAINER &&
          s.store && (s.store[RESOURCE_ENERGY] | 0) > 0;
      }
    });
    if (!containerWithEnergy) return false;
    debugRing(getRoomOfPos(containerWithEnergy.pos), containerWithEnergy.pos, CFG.DRAW.CONT, "CONT");
    debugDrawLine(creep, containerWithEnergy, CFG.DRAW.CONT, "CONT");
    var cr = creep.withdraw(containerWithEnergy, RESOURCE_ENERGY);
    if (cr === ERR_NOT_IN_RANGE) {
      creep.travelTo(containerWithEnergy, { range: 1, reusePath: CFG.PATH_REUSE });
    }
    return true;
  }
})();

module.exports = roleUpgrader;
