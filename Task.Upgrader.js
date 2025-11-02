// Task.Upgrader.js — adds Debug_say & Debug_draw visibility
var BeeToolbox = require('BeeToolbox');
try { require('Traveler'); } catch (e) {} // optional

/** =========================
 *  Debug toggles & styling
 *  ========================= */
var CFG = Object.freeze({
  DEBUG_SAY: true,
  DEBUG_DRAW: true,

  // Behavior knobs
  SKIP_RCL8_IF_SAFE: true,
  RCL8_SAFE_TTL: 180000, // ticksToDowngrade threshold to pause at RCL8
  TRAVEL_REUSE: 16,

  // Visual palette
  DRAW: {
    PATH:   "#8ab6ff",
    CTRL:   "#ffd16e",
    LINK:   "#9cff9c",
    STORE:  "#b0a7ff",
    CONT:   "#8ef",
    DROP:   "#ffb27a",
    TEXT:   "#e0e0e0",
    WIDTH:  0.12,
    OPAC:   0.45,
    FONT:   0.7
  },

  SIGN_TEXT: "BeeNice Please."
});

/** =========================
 *  Tiny debug helpers
 *  ========================= */
function debugSay(creep, msg) {
  if (CFG.DEBUG_SAY && creep && typeof creep.say === 'function') creep.say(msg, true);
}
function _posOf(t) { return t && t.pos ? t.pos : t; }
function _roomOf(pos) { return pos && Game.rooms[pos.roomName]; }

function debugLine(from, to, color, label) {
  if (!CFG.DEBUG_DRAW || !from || !to) return;
  var f = _posOf(from), t = _posOf(to);
  if (!f || !t || f.roomName !== t.roomName) return;
  var R = _roomOf(f); if (!R || !R.visual) return;
  R.visual.line(f, t, { color: color, width: CFG.DRAW.WIDTH, opacity: CFG.DRAW.OPAC });
  if (label) {
    var mx = (f.x + t.x) / 2, my = (f.y + t.y) / 2;
    R.visual.text(label, mx, my - 0.3,
      { color: color, opacity: 0.95, font: CFG.DRAW.FONT, align: "center",
        backgroundColor: "#000000", backgroundOpacity: 0.25 });
  }
}
function debugRing(target, color, text) {
  if (!CFG.DEBUG_DRAW || !target) return;
  var p = _posOf(target); if (!p) return;
  var R = _roomOf(p); if (!R || !R.visual) return;
  R.visual.circle(p, { radius: 0.6, fill: "transparent", stroke: color, opacity: CFG.DRAW.OPAC, width: CFG.DRAW.WIDTH });
  if (text) R.visual.text(text, p.x, p.y - 0.8, { color: color, font: CFG.DRAW.FONT, opacity: 0.95, align: "center" });
}
function hud(creep, text) {
  if (!CFG.DEBUG_DRAW) return;
  var R = creep.room; if (!R || !R.visual) return;
  R.visual.text(text, creep.pos.x, creep.pos.y - 1.2, {
    color: CFG.DRAW.TEXT, font: CFG.DRAW.FONT, opacity: 0.95, align: "center",
    backgroundColor: "#000", backgroundOpacity: 0.25
  });
}

/** =========================
 *  Travel wrapper (with path line)
 *  ========================= */
function go(creep, dest, range) {
  var R = (range != null) ? range : 1;
  var dpos = _posOf(dest) || dest;
  if (creep.pos.roomName === dpos.roomName && creep.pos.getRangeTo(dpos) > R) {
    debugLine(creep.pos, dpos, CFG.DRAW.PATH, "→");
  }
  if (creep.pos.getRangeTo(dpos) <= R) return OK;

  try {
    if (BeeToolbox && typeof BeeToolbox.BeeTravel === 'function') {
      return BeeToolbox.BeeTravel(creep, dpos, { range: R, reusePath: CFG.TRAVEL_REUSE });
    }
  } catch (e) {}
  if (typeof creep.travelTo === 'function') {
    return creep.travelTo(dpos, { range: R, reusePath: CFG.TRAVEL_REUSE, ignoreCreeps: false, maxOps: 4000 });
  }
  return creep.moveTo(dpos, { reusePath: CFG.TRAVEL_REUSE, maxOps: 1500 });
}

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
      debugRing(controller, CFG.DRAW.CTRL, "signed");
      console.log("Upgrader " + creep.name + " updated the controller sign.");
    } else {
      console.log("Upgrader " + creep.name + " failed to update the controller sign. Error: " + res);
    }
  } else {
    debugSay(creep, "📝");
    debugLine(creep, controller, CFG.DRAW.CTRL, "sign");
    go(creep, controller, 1);
  }
}

/** =========================
 *  Main role
 *  ========================= */
var TaskUpgrader = {
  run: function (creep) {
    // State flip
    if (creep.memory.upgrading && creep.store[RESOURCE_ENERGY] === 0) {
      creep.memory.upgrading = false;
      creep.memory.targetDroppedEnergyId = null;
      debugSay(creep, "🔄 refuel");
    } else if (!creep.memory.upgrading && creep.store.getFreeCapacity() === 0) {
      creep.memory.upgrading = true;
      debugSay(creep, "⚡ upgrade");
    }

    // HUD
    var e = creep.store[RESOURCE_ENERGY] | 0;
    hud(creep, (creep.memory.upgrading ? "⚡" : "⛽") + " " + e + "/" + creep.store.getCapacity(RESOURCE_ENERGY));

    if (creep.memory.upgrading) {
      var controller = creep.room.controller;
      if (controller) {
        // optional pause at safe RCL8
        if (CFG.SKIP_RCL8_IF_SAFE &&
            controller.level === 8 &&
            (controller.ticksToDowngrade | 0) > CFG.RCL8_SAFE_TTL) {
          // still keep the sign fresh
          checkAndUpdateControllerSign(creep, controller);
          debugSay(creep, "⏸");
          debugRing(controller, CFG.DRAW.CTRL, "safe");
          return;
        }

        var ur = creep.upgradeController(controller);
        if (ur === ERR_NOT_IN_RANGE) {
          debugLine(creep, controller, CFG.DRAW.CTRL, "ctrl");
          go(creep, controller, 3);
        } else if (ur === OK) {
          debugRing(controller, CFG.DRAW.CTRL, "UP");
        }
        // Even if skipping or working, maintain sign
        checkAndUpdateControllerSign(creep, controller);
      }
      return;
    }

    // =========================
    // Refuel phase (priority order)
    // 1) Link near controller (fastest loop)
    // =========================
    var ctrl = creep.room.controller;
    var linkNearController = ctrl && creep.pos.findClosestByRange(FIND_STRUCTURES, {
      filter: function (s) {
        return s.structureType === STRUCTURE_LINK &&
               s.store && (s.store[RESOURCE_ENERGY] | 0) > 0 &&
               s.pos.inRangeTo(ctrl, 3);
      }
    });

    if (linkNearController) {
      var lr = creep.withdraw(linkNearController, RESOURCE_ENERGY);
      debugRing(linkNearController, CFG.DRAW.LINK, "LINK");
      debugLine(creep, linkNearController, CFG.DRAW.LINK, "withdraw");
      if (lr === ERR_NOT_IN_RANGE) go(creep, linkNearController, 1);
      return; // early exit if valid link path found
    }

    // 2) Toolbox opportunistic sweep (dropped/tombs/ruins/etc. depending on your impl)
    try { if (BeeToolbox && typeof BeeToolbox.collectEnergy === 'function') BeeToolbox.collectEnergy(creep); } catch (e2) {}

    // 3) Storage (cheap travel)
    var stor = creep.room.storage;
    if (stor && stor.store && (stor.store[RESOURCE_ENERGY] | 0) > 0) {
      debugRing(stor, CFG.DRAW.STORE, "STO");
      debugLine(creep, stor, CFG.DRAW.STORE, "withdraw");
      var sr = creep.withdraw(stor, RESOURCE_ENERGY);
      if (sr === ERR_NOT_IN_RANGE) go(creep, stor, 1);
      return;
    }

    // 4) Containers
    var containerWithEnergy = creep.pos.findClosestByPath(FIND_STRUCTURES, {
      filter: function (s) {
        return s.structureType === STRUCTURE_CONTAINER &&
               s.store && (s.store[RESOURCE_ENERGY] | 0) > 0;
      }
    });
    if (containerWithEnergy) {
      debugRing(containerWithEnergy, CFG.DRAW.CONT, "CONT");
      debugLine(creep, containerWithEnergy, CFG.DRAW.CONT, "withdraw");
      var cr = creep.withdraw(containerWithEnergy, RESOURCE_ENERGY);
      if (cr === ERR_NOT_IN_RANGE) go(creep, containerWithEnergy, 1);
      return;
    }

    // 5) Dropped energy (sticky by memory)
    var targetDroppedEnergyId = creep.memory.targetDroppedEnergyId;
    var droppedResource = targetDroppedEnergyId ? Game.getObjectById(targetDroppedEnergyId) : null;

    if (!droppedResource || (droppedResource.amount | 0) === 0) {
      var dropped = creep.room.find(FIND_DROPPED_RESOURCES, {
        filter: function (r) { return r.resourceType === RESOURCE_ENERGY; }
      }) || [];
      if (dropped.length) {
        dropped.sort(function (a, b) { return (b.amount|0) - (a.amount|0); });
        droppedResource = dropped[0];
        creep.memory.targetDroppedEnergyId = droppedResource.id;
      }
    }

    if (droppedResource) {
      debugRing(droppedResource, CFG.DRAW.DROP, "💧" + (droppedResource.amount|0));
      debugLine(creep, droppedResource, CFG.DRAW.DROP, "pickup");
      var pr = creep.pickup(droppedResource);
      if (pr === ERR_NOT_IN_RANGE) go(creep, droppedResource, 1);
      return;
    }

    // Idle: drift toward controller so next upgrade is quick
    if (ctrl) go(creep, ctrl, 3);
  }
};

module.exports = TaskUpgrader;
