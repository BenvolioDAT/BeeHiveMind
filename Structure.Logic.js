"use strict";

// -----------------------------------------------------------------------------
// Structure.Logic.js - owned-room tower and link automation
// Owns:
// * Tower action selection for defense, healing, and repair.
// * Link sender/receiver selection and transfer attempts.
// Memory paths read/written:
// * Memory.rooms[roomName].repairTargets, written by main/core.maintenance and
//   consumed by tower repair logic.
// * Memory.rooms[roomName]._towerLocks, a short-lived map that keeps towers
//   from all repairing the same target every tick.
// * Memory.rooms[roomName].linkMgr senderId/receiverId/nextScan.
// Usually called by:
// * main.js after BeeHiveMind.run().
// Systems that depend on it:
// * role.Repair.Logic.js and core.maintenance share the repair target queue with
//   towers, so field names and queue pruning assumptions matter.
// Do not casually change:
// * Repair target queue shape or linkMgr keys; they are the persistence layer
//   for these structure managers.
// -----------------------------------------------------------------------------

// --------------------------------------------------
// Tower Logic (merged from tower.logic.js)
// --------------------------------------------------
var CoreSelectors = require('core.selectors');

var CFG = Object.freeze({
  DEBUG_SAY: true,
  DEBUG_DRAW: true,
  ATTACK_MIN: 10,
  HEAL_MIN: 200,
  REPAIR_MIN: 400,
  LOCK_TTL: 3,
  DRAW: {
    ATK: "#ff6e6e",
    HEAL: "#6ee7ff",
    REP: "#6effa1",
    LOCK: "#ffe66e",
    IDLE: "#bfbfbf"
  }
});

// --------------------------------------------------
// Link Manager (merged from role.LinkManager.js)
// --------------------------------------------------
var RESCAN_INTERVAL = 500;
var MIN_SEND = 100;

var StructureLogic = {
  runTowerLogic: function () {
    // Tower priority is defense -> heal -> repair. Repair reads the shared
    // Memory.rooms[room].repairTargets queue but uses _towerLocks so towers do
    // not all pick the same target.
    if (!Memory.rooms) Memory.rooms = {};

    for (var roomName in Game.rooms) {
      if (!Game.rooms.hasOwnProperty(roomName)) continue;
      var room = Game.rooms[roomName];
      if (!room.controller || !room.controller.my) continue;

      // Handle defenses per owned room instead of just the first spawn so every colony stays protected.

      if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
      var RMem = Memory.rooms[roomName];
      if (!RMem.repairTargets) RMem.repairTargets = [];
      if (!RMem._towerLocks) RMem._towerLocks = {};

      var snap = CoreSelectors && typeof CoreSelectors.prepareRoomSnapshot === 'function'
        ? CoreSelectors.prepareRoomSnapshot(room)
        : null;
      var towers = snap && snap.towers ? snap.towers : room.find(FIND_MY_STRUCTURES, {
        filter: function (s) { return s.structureType === STRUCTURE_TOWER; }
      }) || [];
      if (!towers.length) continue;

      // Defend first: scan once for hostiles so the attack branch is obvious.
      var hostiles = room.find(FIND_HOSTILE_CREEPS) || [];
      if (hostiles.length) {
        fireAllTowers(towers, hostiles);
        cleanupTowerLocks(RMem);
        continue;
      }

      // Then patch up wounded creeps so they survive the next volley.
      var wounded = room.find(FIND_MY_CREEPS, {
        filter: function (c) { return c.hits < c.hitsMax; }
      }) || [];
      runHealPhase(towers, wounded);

      // Convert the stored queue into live objects once so towers avoid repeated lookups.
      var validTargets = [];
      var targetById = {};
      for (var i = 0; i < RMem.repairTargets.length; i++) {
        var entry = RMem.repairTargets[i];
        if (!entry || !entry.id) continue;
        var targetObj = Game.getObjectById(entry.id);
        if (!targetObj || targetObj.hits >= targetObj.hitsMax) continue;
        validTargets.push(targetObj);
        targetById[targetObj.id] = targetObj;
      }
      if (!validTargets.length) {
        pruneRepairQueue(RMem);
        cleanupTowerLocks(RMem, targetById);
        continue;
      }

      runRepairPhase(towers, RMem, validTargets, targetById);
      pruneRepairQueue(RMem);
      cleanupTowerLocks(RMem, targetById);
    }
  },

  runLinkManager: function () {
    // Link manager periodically scans for a sender near storage/spawn and a
    // receiver near controller, then transfers energy when both are valid.
    if (!Memory.rooms) Memory.rooms = {};

    for (var rn in Game.rooms) {
      if (!Game.rooms.hasOwnProperty(rn)) continue;
      var room = Game.rooms[rn];
      if (!room.controller || !room.controller.my) continue;

      // Create the per-room bucket once so later fields never throw on undefined.
      var roomMem = Memory.rooms[rn];
      if (!roomMem) roomMem = Memory.rooms[rn] = {};
      if (!roomMem.linkMgr) roomMem.linkMgr = { senderId: null, receiverId: null, nextScan: 0 };
      var linkMgr = roomMem.linkMgr;

      var sender = linkMgr.senderId ? Game.getObjectById(linkMgr.senderId) : null;
      var receiver = linkMgr.receiverId ? Game.getObjectById(linkMgr.receiverId) : null;

      var rescanAt = linkMgr.nextScan || 0;
      var missingLink = (!sender || !receiver);
      var rescanNeeded = missingLink || Game.time >= rescanAt;

      if (rescanNeeded) {
        // Refresh link intel so we always have a pair near storage/spawn and controller.
        var scan = scanRoomForLinks(room);
        linkMgr.senderId = scan.sender ? scan.sender.id : null;
        linkMgr.receiverId = scan.receiver ? scan.receiver.id : null;
        linkMgr.nextScan = scan.nextScan;
        sender = scan.sender;
        receiver = scan.receiver;
      }

      if (!sender || !receiver) continue;
      if (sender.id === receiver.id) continue;

      trySendEnergy(sender, receiver);
    }
  }
};

module.exports = StructureLogic;

// Tower helper functions
function fireAllTowers(towers, hostiles) {
  for (var i = 0; i < towers.length; i++) {
    var tower = towers[i];
    var energy = tower.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    if (energy < CFG.ATTACK_MIN) continue;
    var foe = tower.pos.findClosestByRange(hostiles);
    if (!foe) continue;
    tower.attack(foe);
    _tsay(tower, "ATK");
    _line(tower.room, tower.pos, foe.pos, CFG.DRAW.ATK);
    _ring(tower.room, foe.pos, CFG.DRAW.ATK);
    _label(tower.room, foe.pos, "ATK", CFG.DRAW.ATK);
  }
}

function runHealPhase(towers, wounded) {
  if (!wounded || !wounded.length) return;
  for (var i = 0; i < towers.length; i++) {
    var tower = towers[i];
    var energy = tower.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    if (energy < CFG.HEAL_MIN) continue;
    var patient = tower.pos.findClosestByRange(wounded);
    if (!patient) continue;
    tower.heal(patient);
    _tsay(tower, "HEAL");
    _line(tower.room, tower.pos, patient.pos, CFG.DRAW.HEAL);
    _ring(tower.room, patient.pos, CFG.DRAW.HEAL);
    _label(tower.room, patient.pos, "HEAL", CFG.DRAW.HEAL);
  }
}

function pruneRepairQueue(RMem) {
  // Drop completed or missing entries only from the front of the queue. This
  // preserves core.maintenance's sorted repair order for remaining targets.
  while (RMem.repairTargets.length) {
    var head = RMem.repairTargets[0];
    var headObj = head && head.id ? Game.getObjectById(head.id) : null;
    if (headObj && headObj.hits < headObj.hitsMax) break;
    RMem.repairTargets.shift();
  }
}

function runRepairPhase(towers, RMem, validTargets, targetById) {
  var usedTargetIds = {};
  for (var i = 0; i < towers.length; i++) {
    var tower = towers[i];
    var energy = tower.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    if (energy < CFG.REPAIR_MIN) {
      _tsay(tower, "idle");
      continue;
    }
    var target = pickRepairTargetForTower(tower, RMem, validTargets, usedTargetIds, targetById);
    if (!target) {
      _tsay(tower, "idle");
      continue;
    }
    tower.repair(target);
    _tsay(tower, "REP");
    _line(tower.room, tower.pos, target.pos, CFG.DRAW.REP);
    _ring(tower.room, target.pos, CFG.DRAW.REP);
    _label(tower.room, target.pos, "REP", CFG.DRAW.REP);
    if (CFG.DEBUG_DRAW) {
      _line(tower.room, tower.pos, target.pos, CFG.DRAW.LOCK);
    }
  }
}

function pickRepairTargetForTower(tower, RMem, validTargets, usedTargetIds, targetById) {
  var lock = RMem._towerLocks[tower.id];
  if (lock && lock.id) {
    var lockedObj = targetById && targetById[lock.id] ? targetById[lock.id] : Game.getObjectById(lock.id);
    if (lockedObj && lockedObj.hits < lockedObj.hitsMax && !usedTargetIds[lock.id]) {
      usedTargetIds[lock.id] = true;
      return lockedObj;
    }
    delete RMem._towerLocks[tower.id];
  }
  for (var i = 0; i < validTargets.length; i++) {
    var candidate = validTargets[i];
    if (usedTargetIds[candidate.id]) continue;
    if (!candidate || candidate.hits >= candidate.hitsMax) continue;
    usedTargetIds[candidate.id] = true;
    RMem._towerLocks[tower.id] = { id: candidate.id, ttl: CFG.LOCK_TTL };
    return candidate;
  }
  return null;
}

function cleanupTowerLocks(RMem, targetById) {
  for (var towerId in RMem._towerLocks) {
    if (!RMem._towerLocks.hasOwnProperty(towerId)) continue;
    var lock = RMem._towerLocks[towerId];
    if (!lock || !lock.id) {
      delete RMem._towerLocks[towerId];
      continue;
    }
    var obj = targetById && targetById[lock.id] ? targetById[lock.id] : Game.getObjectById(lock.id);
    if (!obj || obj.hits >= obj.hitsMax) {
      delete RMem._towerLocks[towerId];
      continue;
    }
    var ttl = (lock.ttl || 0) - 1;
    if (ttl <= 0) delete RMem._towerLocks[towerId];
    else RMem._towerLocks[towerId].ttl = ttl;
  }
}

function _tsay(tower, msg) {
  if (!CFG.DEBUG_SAY || !tower) return;
  var pos = tower.pos;
  tower.room.visual.text(
    msg,
    pos.x, pos.y - 0.9,
    { color: "#ddd", font: 0.8, align: "center" }
  );
}

function _line(room, a, b, color) {
  if (!CFG.DEBUG_DRAW || !room || !a || !b) return;
  room.visual.line((a.pos || a), (b.pos || b), { color: color || "#fff", opacity: 0.6, width: 0.08 });
}

function _ring(room, p, color) {
  if (!CFG.DEBUG_DRAW || !room || !p) return;
  room.visual.circle((p.pos || p), { radius: 0.5, stroke: color || "#fff", fill: "transparent", opacity: 0.5 });
}

function _label(room, p, text, color) {
  if (!CFG.DEBUG_DRAW || !room || !p) return;
  room.visual.text(text, (p.pos || p).x, (p.pos || p).y - 0.6, { color: color || "#ddd", font: 0.8, align: "center" });
}

// --------------------------------------------------
// Link Manager helper functions
// --------------------------------------------------
function scanRoomForLinks(room) {
  // Rescan link topology on a cadence. IDs are persisted so normal ticks avoid
  // room-wide link selection work.
  var links = room.find(FIND_STRUCTURES, { filter: { structureType: STRUCTURE_LINK } });
  if (!links.length) {
    return { sender: null, receiver: null, nextScan: Game.time + RESCAN_INTERVAL };
  }

  var spawns = room.find(FIND_MY_SPAWNS);
  var anchorSend = room.storage || (spawns[0] || null);
  var anchorRecv = room.controller || null;

  var sender = pickClosestLink(anchorSend, links);
  var receiverData = pickControllerLinks(anchorRecv, links);
  var receiver = receiverData.primary;
  if (sender && receiver && sender.id === receiver.id && receiverData.secondary) {
    receiver = receiverData.secondary;
  }

  return {
    sender: sender,
    receiver: receiver,
    nextScan: Game.time + RESCAN_INTERVAL
  };
}

function pickClosestLink(anchor, links) {
  if (!anchor) return null;
  var best = null;
  var bestRange = Infinity;
  for (var i = 0; i < links.length; i++) {
    var link = links[i];
    var range = anchor.pos.getRangeTo(link.pos);
    if (range < bestRange) {
      bestRange = range;
      best = link;
    }
  }
  return best;
}

function pickControllerLinks(anchor, links) {
  if (!anchor) return { primary: null, secondary: null };
  var primary = null;
  var secondary = null;
  var best = Infinity;
  var second = Infinity;
  for (var i = 0; i < links.length; i++) {
    var link = links[i];
    var range = anchor.pos.getRangeTo(link.pos);
    if (range < best) {
      second = best;
      secondary = primary;
      best = range;
      primary = link;
    } else if (range < second) {
      second = range;
      secondary = link;
    }
  }
  return { primary: primary, secondary: secondary };
}

function trySendEnergy(sender, receiver) {
  if (sender.cooldown !== 0) return;
  if (!sender.store || !receiver.store || !receiver.store.getFreeCapacity) return;

  var storedEnergy = sender.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
  if (storedEnergy < MIN_SEND) return;

  var free = receiver.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
  if (free <= 0) return;

  sender.transferEnergy(receiver);
}
