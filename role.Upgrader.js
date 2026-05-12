'use strict';
var BeeRoleVisuals = require('BeeRoleVisuals');
var BeeRoles = require('BeeRoles');


// Role-specific debug and visual settings.
var CFG = Object.freeze({
  DEBUG_SAY: false,
  DEBUG_DRAW: true,
  DRAW: {
    CTRL:     "#8ab6ff",
    LINK:     "#6ec1ff",
    STORE:    "#6effa1",
    CONT:     "#ffe66e",
    DROP:     "#ffb0e0",
    WIDTH:   0.12,
    OPACITY: 0.45,
    FONT:    0.6
  },
  SIGN_TEXT: "BeeNice Please.",
  SKIP_RCL8_IF_SAFE: false,
  RCL8_SAFE_TTL: 150000,
  PATH_REUSE: 40
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
    upgraderLog.warnEvery('upgrader.debugDrawLine.visual', 250, 'debugDrawLine failed for', creep && creep.name, describeError(e));
  }
}

function debugRing(room, pos, color, text) {
  try {
    BeeRoleVisuals.drawRing(CFG.DEBUG_DRAW, room, pos, color, text, CFG.DRAW);
  } catch (e) {
    upgraderLog.warnEvery('upgrader.debugRing.visual', 250, 'debugRing failed for room', room && room.name, describeError(e));
  }
}

// Dependencies used by the upgrader role
const BeeToolbox = require('BeeToolbox');
var MovementManager = require('Movement.Manager');
const CoreLogger = require('core.logger');
const upgraderLog = CoreLogger.createLogger('Upgrader', CoreLogger.LOG_LEVEL.BASIC);

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

function requestUpgraderMove(creep, target, range, opts, reason) {
  // Use MovementManager.request for Upgrader movement arbitration.
  // OK = accepted/replaced.
  // numeric > OK = existing higher/equal intent kept.
  // ERR_INVALID_ARGS or manager unavailable = no direct fallback in this phase.
  if (!creep || !target) return ERR_INVALID_ARGS;
  if (!hasUsableTravelTarget(target)) return ERR_INVALID_ARGS;
  if (!MovementManager || typeof MovementManager.request !== 'function') return ERR_INVALID_ARGS;

  var requestOpts = opts ? Object.assign({}, opts) : {};
  requestOpts.range = range;
  if (!requestOpts.intentType) requestOpts.intentType = 'upgrader';

  var requestResult = MovementManager.request(creep, target, null, requestOpts);
  if (isManagerRequestHandled(requestResult)) return requestResult;
  if (requestResult === ERR_INVALID_ARGS) return ERR_INVALID_ARGS;
  return requestResult;
}

// Upgrader role implementation
  // -----------------------------
  // A) Tiny helpers (room lookups, signing)
  // -----------------------------
  // Returns the room object for a given position if visible.
  function getRoomOfPos(pos) { return pos && Game.rooms[pos.roomName]; }

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
      requestUpgraderMove(creep, controller, 1, { reusePath: CFG.PATH_REUSE }, 'upgrader.sign.approach');
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
        requestUpgraderMove(creep, droppedResource, 1, { reusePath: CFG.PATH_REUSE }, 'upgrader.pickup.drop');
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
  var roleUpgrader = {
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
    creep.memory.role = BeeRoles.ROLE_NAMES.UPGRADER;
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
      requestUpgraderMove(creep, controller, 3, { reusePath: CFG.PATH_REUSE }, 'upgrader.upgrade.approach');
    } else if (ur === OK) {
      debugRing(getRoomOfPos(controller.pos), controller.pos, CFG.DRAW.CTRL, "UP");
    }
    checkAndUpdateControllerSign(creep, controller);
  }

  function shouldPauseAtSafeRCL8(controller) {
    if (!CFG.SKIP_RCL8_IF_SAFE) return false;
    if (controller.level !== 8) return false;
    var ticksToDowngrade = controller.ticksToDowngrade || 0;
    return ticksToDowngrade > CFG.RCL8_SAFE_TTL;
  }

  // -----------------------------
  // C) Refuel phase
  // -----------------------------
  function runRefuelPhase(creep) {
    if (tryLinkPull(creep)) return;
    if (tryToolboxSweep(creep)) return;
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
          s.store && (s.store[RESOURCE_ENERGY] || 0) > 0 &&
          s.pos.inRangeTo(ctrl, 3);
      }
    });
    if (!linkNearController) return false;
    var lr = creep.withdraw(linkNearController, RESOURCE_ENERGY);
    var linkRoom = getRoomOfPos(linkNearController.pos);
    debugRing(linkRoom, linkNearController.pos, CFG.DRAW.LINK, "LINK");
    debugDrawLine(creep, linkNearController, CFG.DRAW.LINK, "LINK");
    if (lr === ERR_NOT_IN_RANGE) {
      requestUpgraderMove(creep, linkNearController, 1, { reusePath: CFG.PATH_REUSE }, 'upgrader.link.pull');
    }
    return true;
  }

  function tryToolboxSweep(creep) {
    if (!creep) return false;
    try {
      if (BeeToolbox && typeof BeeToolbox.collectEnergy === 'function') {
        return BeeToolbox.collectEnergy(creep) === true;
      }
    } catch (e) {
      upgraderLog.warnEvery('upgrader.tryToolboxSweep.collectEnergy', 250, 'collectEnergy threw for', creep && creep.name, describeError(e));
    }
    return false;
  }

  function tryWithdrawStorage(creep) {
    var stor = creep.room.storage;
    if (!stor || !stor.store || (stor.store[RESOURCE_ENERGY] || 0) <= 0) return false;
    debugRing(getRoomOfPos(stor.pos), stor.pos, CFG.DRAW.STORE, "STO");
    debugDrawLine(creep, stor, CFG.DRAW.STORE, "STO");
    var sr = creep.withdraw(stor, RESOURCE_ENERGY);
    if (sr === ERR_NOT_IN_RANGE) {
      requestUpgraderMove(creep, stor, 1, { reusePath: CFG.PATH_REUSE }, 'upgrader.storage.pull');
    }
    return true;
  }

  function tryWithdrawContainer(creep) {
    var containerWithEnergy = creep.pos.findClosestByPath(FIND_STRUCTURES, {
      filter: function (s) {
        return s.structureType === STRUCTURE_CONTAINER &&
          s.store && (s.store[RESOURCE_ENERGY] || 0) > 0;
      }
    });
    if (!containerWithEnergy) return false;
    debugRing(getRoomOfPos(containerWithEnergy.pos), containerWithEnergy.pos, CFG.DRAW.CONT, "CONT");
    debugDrawLine(creep, containerWithEnergy, CFG.DRAW.CONT, "CONT");
    var cr = creep.withdraw(containerWithEnergy, RESOURCE_ENERGY);
    if (cr === ERR_NOT_IN_RANGE) {
      requestUpgraderMove(creep, containerWithEnergy, 1, { reusePath: CFG.PATH_REUSE }, 'upgrader.container.pull');
    }
    return true;
  }
module.exports = roleUpgrader;
