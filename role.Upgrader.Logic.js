'use strict';

// Upgrader behavior implementation only. Public role wiring stays in role.Upgrader.js.
var CFG = require('role.Upgrader.Config');
var CoreSelectors = require('core.selectors');
var BeeToolbox = require('BeeToolbox');
var Handoff = require('role.EnergyHandoff');

// The Upgrader keeps these short wrappers so the role reads naturally, while
// BeeToolbox owns the repeated RoomVisual guard/position normalization code.
function debugOptions() { return { enabled: CFG.DEBUG_DRAW, width: CFG.DRAW.WIDTH, opacity: CFG.DRAW.OPACITY, font: CFG.DRAW.FONT }; }
function debugSay(creep, msg) { BeeToolbox.sayIfDebugEnabled(creep, msg, CFG.DEBUG_SAY); }
function debugDrawLine(creep, target, color, label) { BeeToolbox.drawDebugLine(creep, target, color, label, debugOptions()); }
function debugRing(room, pos, color, text) { BeeToolbox.drawDebugRing(room, pos, color, text, debugOptions()); }

function getRoomOfPos(pos) { return BeeToolbox.getRoomForPosition(pos); }

function writeUpgraderRefuelDiag(creep, reason, extra) {
  if (!creep || !creep.room) return;
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[creep.room.name]) Memory.rooms[creep.room.name] = {};
  var diag = {
    tick: Game.time,
    creepName: creep.name,
    reason: reason,
    carried: creep.store ? (creep.store[RESOURCE_ENERGY] || 0) : 0
  };
  if (extra) {
    for (var key in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, key)) diag[key] = extra[key];
    }
  }
  Memory.rooms[creep.room.name].lastUpgraderRefuel = diag;
}

function checkAndUpdateControllerSign(creep, controller) {
  if (!controller) return;
  var msg = CFG.SIGN_TEXT;
  var needs = (!controller.sign) || (controller.sign.text !== msg);
  if (!needs) return;
  if (creep.pos.inRangeTo(controller.pos, 1)) {
    var res = creep.signController(controller, msg);
    if (res === OK) { debugSay(creep, "🖊️"); debugRing(getRoomOfPos(controller.pos), controller.pos, CFG.DRAW.CTRL, "signed"); console.log("Upgrader " + creep.name + " updated the controller sign."); }
    else { console.log("Upgrader " + creep.name + " failed to update the controller sign. Error: " + res); }
  } else {
    debugSay(creep, "📝"); debugDrawLine(creep, controller, CFG.DRAW.CTRL, "CTRL"); creep.travelTo(controller, { range: 1, reusePath: CFG.PATH_REUSE });
  }
}

function pickDroppedEnergy(creep) {
  var targetDroppedEnergyId = creep.memory.targetDroppedEnergyId;
  var droppedResource = targetDroppedEnergyId ? Game.getObjectById(targetDroppedEnergyId) : null;
  if (!droppedResource) {
    droppedResource = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, { filter: function (r) { return r.resourceType === RESOURCE_ENERGY && r.amount > 0; } });
    if (droppedResource) creep.memory.targetDroppedEnergyId = droppedResource.id;
  }
  if (droppedResource) {
    var dropRoom = getRoomOfPos(droppedResource.pos);
    debugRing(dropRoom, droppedResource.pos, CFG.DRAW.DROP, 'drop');
    debugDrawLine(creep, droppedResource, CFG.DRAW.DROP, 'DROP');
    var pr = creep.pickup(droppedResource);
    if (pr === ERR_NOT_IN_RANGE) creep.travelTo(droppedResource, { range: 1, reusePath: CFG.PATH_REUSE });
    else if (pr === OK) { debugSay(creep, "📦"); creep.memory.targetDroppedEnergyId = null; }
    return true;
  }
  creep.memory.targetDroppedEnergyId = null;
  return false;
}

function ensureUpgraderIdentity(creep) { if (!creep || !creep.memory) return; creep.memory.role = 'Upgrader'; if (!creep.memory.task) creep.memory.task = 'upgrader'; }
function determineUpgraderState(creep) { if (creep.memory.upgrading && creep.store[RESOURCE_ENERGY] === 0) { creep.memory.upgrading = false; creep.memory.targetDroppedEnergyId = null; debugSay(creep, "🔄 refuel"); } else if (!creep.memory.upgrading && creep.store.getFreeCapacity() === 0) { creep.memory.upgrading = true; debugSay(creep, "⚡ upgrade"); } creep.memory.state = creep.memory.upgrading ? 'UPGRADE' : 'REFUEL'; return creep.memory.state; }

function runUpgradePhase(creep) {
  var controller = creep.room.controller;
  if (!controller) return;
  if (shouldPauseAtSafeRCL8(controller)) { checkAndUpdateControllerSign(creep, controller); debugSay(creep, "⏸"); debugRing(getRoomOfPos(controller.pos), controller.pos, CFG.DRAW.CTRL, "safe"); return; }
  var ur = creep.upgradeController(controller);
  if (ur === ERR_NOT_IN_RANGE) { debugDrawLine(creep, controller, CFG.DRAW.CTRL, "CTRL"); creep.travelTo(controller, { range: 3, reusePath: CFG.PATH_REUSE }); }
  else if (ur === OK) debugRing(getRoomOfPos(controller.pos), controller.pos, CFG.DRAW.CTRL, "UP");
  checkAndUpdateControllerSign(creep, controller);
}

function shouldPauseAtSafeRCL8(controller) { if (!CFG.SKIP_RCL8_IF_SAFE) return false; if (controller.level !== 8) return false; var ticksToDowngrade = controller.ticksToDowngrade || 0; return ticksToDowngrade > CFG.RCL8_SAFE_TTL; }

function runRefuelPhase(creep) {
  if (maybePublishUpgraderRequest(creep)) { writeUpgraderRefuelDiag(creep, 'waiting-for-handoff'); debugSay(creep, "\u23f3"); return; }
  if (tryLinkPull(creep)) { writeUpgraderRefuelDiag(creep, 'controller-link'); return; }
  if (tryCleanupEnergy(creep)) { writeUpgraderRefuelDiag(creep, 'cleanup-energy'); return; }
  if (tryWithdrawHomeWorkerEnergy(creep)) { writeUpgraderRefuelDiag(creep, 'home-worker-energy'); return; }
  if (tryWithdrawContainer(creep)) { writeUpgraderRefuelDiag(creep, 'general-container'); return; }
  writeUpgraderRefuelDiag(creep, 'no-energy-source');
  if (CFG.DEBUG_DRAW) debugSay(creep, "\u2753");
}
function tryLinkPull(creep) { var ctrl = creep.room.controller; if (!ctrl) return false; var linkNearController = creep.pos.findClosestByRange(FIND_STRUCTURES, { filter: function (s) { return s.structureType === STRUCTURE_LINK && s.store && (s.store[RESOURCE_ENERGY] || 0) > 0 && s.pos.inRangeTo(ctrl, 3); } }); if (!linkNearController) return false; var lr = creep.withdraw(linkNearController, RESOURCE_ENERGY); var linkRoom = getRoomOfPos(linkNearController.pos); debugRing(linkRoom, linkNearController.pos, CFG.DRAW.LINK, "LINK"); debugDrawLine(creep, linkNearController, CFG.DRAW.LINK, "LINK"); if (lr === ERR_NOT_IN_RANGE) creep.travelTo(linkNearController, { range: 1, reusePath: CFG.PATH_REUSE }); return true; }
function tryCleanupEnergy(creep) { if (tryWithdrawTombstone(creep)) return true; if (tryWithdrawRuin(creep)) return true; if (pickDroppedEnergy(creep)) return true; return false; }
function tryWithdrawTombstone(creep) { var tomb = creep.pos.findClosestByPath(FIND_TOMBSTONES, { filter: function (t) { return t.store && (t.store[RESOURCE_ENERGY] || 0) > 0; } }); if (!tomb) return false; debugRing(getRoomOfPos(tomb.pos), tomb.pos, CFG.DRAW.DROP, "TOMB"); debugDrawLine(creep, tomb, CFG.DRAW.DROP, "TOMB"); var tr = creep.withdraw(tomb, RESOURCE_ENERGY); if (tr === ERR_NOT_IN_RANGE) creep.travelTo(tomb, { range: 1, reusePath: CFG.PATH_REUSE }); return true; }
function tryWithdrawRuin(creep) { var ruin = creep.pos.findClosestByPath(FIND_RUINS, { filter: function (r) { return r.store && (r.store[RESOURCE_ENERGY] || 0) > 0; } }); if (!ruin) return false; debugRing(getRoomOfPos(ruin.pos), ruin.pos, CFG.DRAW.DROP, "RUIN"); debugDrawLine(creep, ruin, CFG.DRAW.DROP, "RUIN"); var rr = creep.withdraw(ruin, RESOURCE_ENERGY); if (rr === ERR_NOT_IN_RANGE) creep.travelTo(ruin, { range: 1, reusePath: CFG.PATH_REUSE }); return true; }
function getHomeWorkerEnergyDraw(kind) { if (kind === 'storage') return { color: CFG.DRAW.STORE, label: "STO" }; if (kind === 'spawn_hub_container') return { color: CFG.DRAW.CONT, label: "HUB" }; if (kind === 'source_container') return { color: CFG.DRAW.CONT, label: "SRC" }; return { color: CFG.DRAW.CONT, label: "CONT" }; }
function tryWithdrawHomeWorkerEnergy(creep) { var info = CoreSelectors.findBestHomeWorkerEnergySource(creep.room, { includeTerminal: false }); if (!info || !info.target) return false; var draw = getHomeWorkerEnergyDraw(info.kind); debugRing(getRoomOfPos(info.target.pos), info.target.pos, draw.color, draw.label); debugDrawLine(creep, info.target, draw.color, draw.label); var wr = creep.withdraw(info.target, RESOURCE_ENERGY); if (wr === ERR_NOT_IN_RANGE) creep.travelTo(info.target, { range: 1, reusePath: CFG.PATH_REUSE }); return true; }
function tryWithdrawContainer(creep) {
  var room = creep.room;
  // This is the last refuel fallback. It skips source containers (mining
  // output) and spawn hub containers (early-room buffer) so Upgraders do not
  // quietly drain energy reserved for harvest/logistics flow.
  var containerWithEnergy = CoreSelectors.findClosestGeneralEnergyContainer(room, creep.pos);
  if (!containerWithEnergy) return false;

  debugRing(getRoomOfPos(containerWithEnergy.pos), containerWithEnergy.pos, CFG.DRAW.CONT, "CONT");
  debugDrawLine(creep, containerWithEnergy, CFG.DRAW.CONT, "CONT");

  // withdraw is for structures/tombstones/ruins with a Store. Dropped Resource
  // piles use pickup in pickDroppedEnergy(). ERR_NOT_IN_RANGE means the target
  // is valid, but the creep must move adjacent before the action can run.
  var cr = creep.withdraw(containerWithEnergy, RESOURCE_ENERGY);
  if (cr === ERR_NOT_IN_RANGE) creep.travelTo(containerWithEnergy, { range: 1, reusePath: CFG.PATH_REUSE });
  return true;
}

function shouldUpgraderRequestEnergy(creep) {
  if (!CFG.HANDOFF_ENABLED) return false;
  var ctrl = creep.room.controller;
  if (!ctrl || !ctrl.my) return false;
  var free = creep.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
  return free >= CFG.HANDOFF_MIN_RECEIVER_FREE && creep.pos.getRangeTo(ctrl) <= 6;
}

function maybePublishUpgraderRequest(creep) {
  if (!shouldUpgraderRequestEnergy(creep)) { Handoff.clearEnergyHandoffRequest(creep); return false; }
  var req = Handoff.publishEnergyHandoffRequest(creep, 'Upgrader', creep.room.controller, creep.store.getFreeCapacity(RESOURCE_ENERGY) || 0);
  if (!req) return false;
  if (req.assignedHaulerName && req.waitUntil && Game.time <= req.waitUntil) { creep.memory.energyHandoffHauler = req.assignedHaulerName; return true; }
  return false;
}

function run(creep) { if (!creep) return; ensureUpgraderIdentity(creep); var state = determineUpgraderState(creep); if (state === 'UPGRADE') { Handoff.clearEnergyHandoffRequest(creep); runUpgradePhase(creep); return; } runRefuelPhase(creep); }

module.exports = { run: run };
