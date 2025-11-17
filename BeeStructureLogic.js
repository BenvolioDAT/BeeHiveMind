"use strict";

// --------------------------------------------------
// Tower Logic (merged from tower.logic.js)
// --------------------------------------------------
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

var BeeStructureLogic = {
  runTowerLogic: function () {
    var spawn = findAnchorSpawn();
    if (!spawn) return;

    var room = spawn.room;
    var RMem = ensureTowerRoomMemory(room);
    var towers = collectRoomTowers(room);
    if (!towers.length) return;

    if (handleHostilePhase(towers)) return;
    runHealPhase(towers);

    var validTargets = buildValidRepairList(RMem);
    if (!validTargets.length) {
      pruneRepairQueue(RMem);
      return;
    }

    runRepairPhase(towers, RMem, validTargets);
    cleanupTowerLocks(RMem);
  },

  runLinkManager: function () {
    ensureGlobalRoomMemory();
    for (var rn in Game.rooms) {
      if (!Game.rooms.hasOwnProperty(rn)) continue;
      var room = Game.rooms[rn];
      if (!room.controller || !room.controller.my) continue;

      var rmem = ensureLinkMemory(rn);
      var pair = resolveLinkPair(room, rmem);
      if (!pair.sender || !pair.receiver) continue;
      if (pair.sender.id === pair.receiver.id) continue;

      trySendEnergy(pair.sender, pair.receiver);
    }
  }
};

module.exports = BeeStructureLogic;

// --------------------------------------------------
// Tower helper functions
// --------------------------------------------------
function findAnchorSpawn() {
  var spawnNames = Object.keys(Game.spawns);
  if (!spawnNames.length) return null;
  return Game.spawns[spawnNames[0]] || null;
}

function ensureTowerRoomMemory(room) {
  var roomName = room.name;
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
  var RMem = Memory.rooms[roomName];
  if (!RMem.repairTargets) RMem.repairTargets = [];
  if (!RMem._towerLocks) RMem._towerLocks = {};
  return RMem;
}

function collectRoomTowers(room) {
  var towers = room.find(FIND_MY_STRUCTURES, {
    filter: function (s) { return s.structureType === STRUCTURE_TOWER; }
  }) || [];
  return towers;
}

function handleHostilePhase(towers) {
  for (var scanIdx = 0; scanIdx < towers.length; scanIdx++) {
    if (towers[scanIdx].pos.findClosestByRange(FIND_HOSTILE_CREEPS)) {
      fireAllTowers(towers);
      return true;
    }
  }
  return false;
}

function fireAllTowers(towers) {
  for (var i = 0; i < towers.length; i++) {
    var tower = towers[i];
    var energy = tower.store.getUsedCapacity(RESOURCE_ENERGY) | 0;
    if (energy < CFG.ATTACK_MIN) continue;
    var foe = tower.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
    if (!foe) continue;
    tower.attack(foe);
    _tsay(tower, "ATK");
    _line(tower.room, tower.pos, foe.pos, CFG.DRAW.ATK);
    _ring(tower.room, foe.pos, CFG.DRAW.ATK);
    _label(tower.room, foe.pos, "ATK", CFG.DRAW.ATK);
  }
}

function runHealPhase(towers) {
  for (var i = 0; i < towers.length; i++) {
    var tower = towers[i];
    var energy = tower.store.getUsedCapacity(RESOURCE_ENERGY) | 0;
    if (energy < CFG.HEAL_MIN) continue;
    var patient = tower.pos.findClosestByRange(FIND_MY_CREEPS, {
      filter: function (c) { return c.hits < c.hitsMax; }
    });
    if (!patient) continue;
    tower.heal(patient);
    _tsay(tower, "HEAL");
    _line(tower.room, tower.pos, patient.pos, CFG.DRAW.HEAL);
    _ring(tower.room, patient.pos, CFG.DRAW.HEAL);
    _label(tower.room, patient.pos, "HEAL", CFG.DRAW.HEAL);
  }
}

function buildValidRepairList(RMem) {
  var validTargets = [];
  for (var i = 0; i < RMem.repairTargets.length; i++) {
    var entry = RMem.repairTargets[i];
    if (!entry || !entry.id) continue;
    var obj = Game.getObjectById(entry.id);
    if (!obj || obj.hits >= obj.hitsMax) continue;
    validTargets.push({ id: obj.id, pos: obj.pos, hits: obj.hits, hitsMax: obj.hitsMax, type: obj.structureType });
  }
  return validTargets;
}

function pruneRepairQueue(RMem) {
  while (RMem.repairTargets.length) {
    var head = RMem.repairTargets[0];
    var headObj = head && head.id ? Game.getObjectById(head.id) : null;
    if (headObj && headObj.hits < headObj.hitsMax) break;
    RMem.repairTargets.shift();
  }
}

function runRepairPhase(towers, RMem, validTargets) {
  var usedTargetIds = {};
  for (var i = 0; i < towers.length; i++) {
    var tower = towers[i];
    var energy = tower.store.getUsedCapacity(RESOURCE_ENERGY) | 0;
    if (energy < CFG.REPAIR_MIN) {
      _tsay(tower, "idle");
      continue;
    }
    var target = pickRepairTargetForTower(tower, RMem, validTargets, usedTargetIds);
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
    pruneRepairQueue(RMem);
  }
}

function pickRepairTargetForTower(tower, RMem, validTargets, usedTargetIds) {
  var lock = RMem._towerLocks[tower.id];
  if (lock && lock.id) {
    var lockedObj = Game.getObjectById(lock.id);
    if (lockedObj && lockedObj.hits < lockedObj.hitsMax && !usedTargetIds[lock.id]) {
      usedTargetIds[lock.id] = true;
      return lockedObj;
    }
    delete RMem._towerLocks[tower.id];
  }
  for (var i = 0; i < validTargets.length; i++) {
    var candidate = validTargets[i];
    if (usedTargetIds[candidate.id]) continue;
    var obj = Game.getObjectById(candidate.id);
    if (!obj || obj.hits >= obj.hitsMax) continue;
    usedTargetIds[candidate.id] = true;
    RMem._towerLocks[tower.id] = { id: obj.id, ttl: CFG.LOCK_TTL | 0 };
    return obj;
  }
  return null;
}

function cleanupTowerLocks(RMem) {
  for (var towerId in RMem._towerLocks) {
    if (!RMem._towerLocks.hasOwnProperty(towerId)) continue;
    var lock = RMem._towerLocks[towerId];
    if (!lock || !lock.id) {
      delete RMem._towerLocks[towerId];
      continue;
    }
    var obj = Game.getObjectById(lock.id);
    if (!obj || obj.hits >= obj.hitsMax) {
      delete RMem._towerLocks[towerId];
      continue;
    }
    var ttl = (lock.ttl | 0) - 1;
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
function ensureGlobalRoomMemory() {
  if (!Memory.rooms) Memory.rooms = {};
}

function ensureLinkMemory(roomName) {
  if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
  if (!Memory.rooms[roomName].linkMgr) {
    Memory.rooms[roomName].linkMgr = { senderId: null, receiverId: null, nextScan: 0 };
  }
  return Memory.rooms[roomName];
}

function resolveLinkPair(room, rmem) {
  var cache = rmem.linkMgr;
  var sender = cache.senderId ? Game.getObjectById(cache.senderId) : null;
  var receiver = cache.receiverId ? Game.getObjectById(cache.receiverId) : null;

  if (needsRescan(cache, sender, receiver)) {
    var result = scanRoomForLinks(room);
    cache.senderId = result.sender ? result.sender.id : null;
    cache.receiverId = result.receiver ? result.receiver.id : null;
    cache.nextScan = result.nextScan;
    sender = result.sender;
    receiver = result.receiver;
  }

  return { sender: sender, receiver: receiver };
}

function needsRescan(cache, sender, receiver) {
  if (!sender || !receiver) return true;
  return Game.time >= (cache.nextScan | 0);
}

function scanRoomForLinks(room) {
  var links = room.find(FIND_STRUCTURES, { filter: { structureType: STRUCTURE_LINK } });
  if (!links.length) {
    return { sender: null, receiver: null, nextScan: Game.time + RESCAN_INTERVAL };
  }

  var anchorSend = room.storage || (room.find(FIND_MY_SPAWNS)[0] || null);
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
  var used = (sender.store && sender.store[RESOURCE_ENERGY]) | 0;
  var free = (receiver.store && receiver.store.getFreeCapacity)
    ? receiver.store.getFreeCapacity(RESOURCE_ENERGY)
    : 0;
  if (sender.cooldown !== 0) return;
  if (used < MIN_SEND) return;
  if (free <= 0) return;
  sender.transferEnergy(receiver);
}
