'use strict';

// Shared debug + tuning config (copied from role.BeeWorker for consistency)
var CFG = Object.freeze({
  // --- Debug toggles (shared) ---
  DEBUG_SAY: false,
  DEBUG_DRAW: true,

  // --- Visual styles (shared) ---
  DRAW: {
    // BaseHarvest-style visuals
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
  MOVE_PRIORITIES: { withdraw: 60, pickup: 70, deliver: 55, idle: 5 },

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
// Shared tiny helpers (copied for role self-containment)
// -------------------------
function debugSay(creep, msg) {
  if (CFG.DEBUG_SAY && creep && msg) creep.say(msg, true);
}

// Returns a RoomPosition for any target (object, pos-like, or {x,y,roomName}).
function getTargetPosition(target) {
  if (!target) return null;
  if (target.pos) return target.pos;
  if (target.x != null && target.y != null && target.roomName) return target;
  return null;
}

function debugDrawLine(creep, target, color, label) {
  if (!CFG.DEBUG_DRAW || !creep || !target) return;
  var room = creep.room; if (!room || !room.visual) return;
  var tpos = getTargetPosition(target); if (!tpos || tpos.roomName !== room.name) return;
  try {
    room.visual.line(creep.pos, tpos, {
      color: color, width: CFG.DRAW.WIDTH, opacity: CFG.DRAW.OPACITY, lineStyle: "solid"
    });
    if (label) {
      room.visual.text(label, tpos.x, tpos.y - 0.3, {
        color: color, opacity: CFG.DRAW.OPACITY, font: CFG.DRAW.FONT, align: "center"
      });
    }
  } catch (e) {}
}

function debugRing(room, pos, color, text) {
  if (!CFG.DEBUG_DRAW || !room || !room.visual || !pos) return;
  try {
    room.visual.circle(pos, { radius: 0.5, fill: "transparent", stroke: color, opacity: CFG.DRAW.OPACITY, width: CFG.DRAW.WIDTH });
    if (text) room.visual.text(text, pos.x, pos.y - 0.6, { color: color, font: CFG.DRAW.FONT, opacity: CFG.DRAW.OPACITY, align: "center" });
  } catch (e) {}
}

// Dependencies used by the upgrader role
const BeeToolbox = require('BeeToolbox');

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
    var ticksToDowngrade = controller.ticksToDowngrade || 0;
    return ticksToDowngrade > CFG.RCL8_SAFE_TTL;
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
    if (!stor || !stor.store || (stor.store[RESOURCE_ENERGY] || 0) <= 0) return false;
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
          s.store && (s.store[RESOURCE_ENERGY] || 0) > 0;
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
module.exports = roleUpgrader;
