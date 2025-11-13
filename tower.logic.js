// Tower.Manager.debugged.js — coordinated attack/heal/repair with Debug_say & Debug_draw (ES5-safe)

/**
 * Behavior summary (per tick, per room):
 * 1) If any hostiles: all towers ATTACK nearest (PvE neutral; no username checks here).
 * 2) Else if any wounded allies and energy >= HEAL_MIN: HEAL nearest wounded.
 * 3) Else REPAIR using Memory.rooms[room].repairTargets (priority = list order),
 *    with short per-tower locks to avoid thrash and same-tick de-duplication.
 *
 * Visuals:
 *  - ATTACK: red line tower→foe, red ring on foe, label "ATK"
 *  - HEAL:   aqua line tower→ally, aqua ring on ally, label "HEAL"
 *  - REPAIR: green line tower→target, green ring on target, label "REP"
 *  - Tower "say": drawn text above the tower (since structures can’t creep.say)
 */

var CFG = Object.freeze({
  DEBUG_SAY: true,          // draw tiny labels above towers
  DEBUG_DRAW: true,         // RoomVisual lines/circles/labels

  // Energy thresholds (tune to taste)
  ATTACK_MIN: 10,           // min energy to allow attack (towers are cheap to fire)
  HEAL_MIN:   200,          // min energy to allow heal
  REPAIR_MIN: 400,          // min energy to allow repair (keeps buffer for defense)

  // Tower repair stickiness
  LOCK_TTL: 3,              // ticks a tower tries to stick to its locked repair target

  // Draw palette
  DRAW: {
    ATK:   "#ff6e6e",
    HEAL:  "#6ee7ff",
    REP:   "#6effa1",
    LOCK:  "#ffe66e",
    IDLE:  "#bfbfbf"
  }
});

// -----------------------------
// Tiny debug helpers
// -----------------------------
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

// -----------------------------
// Module
// -----------------------------
module.exports = {
  run: function () {
    var spawn = findAnchorSpawn();
    if (!spawn) return;

    var room = spawn.room;
    var RMem = ensureRoomMemory(room);
    var towers = collectRoomTowers(room);
    if (!towers.length) return;

    // We keep the control flow flat: each phase returns early when it owns the
    // tick. This makes it obvious to new contributors that "fight beats heal",
    // "heal beats repair", etc.
    if (handleHostilePhase(towers)) return;
    runHealPhase(towers);

    var validTargets = buildValidRepairList(RMem);
    if (!validTargets.length) {
      pruneRepairQueue(RMem);
      return;
    }

    runRepairPhase(towers, RMem, validTargets);
    cleanupTowerLocks(RMem);
  }
};

// -----------------------------
// New helper functions (novice friendly)
// -----------------------------

// We keep the "first spawn" heuristic but isolate it so swapping to a better
// anchor later is a one-line change instead of spelunking through run().
function findAnchorSpawn() {
  var spawnNames = Object.keys(Game.spawns);
  if (!spawnNames.length) return null;
  return Game.spawns[spawnNames[0]] || null;
}

function ensureRoomMemory(room) {
  var roomName = room.name;
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
  var RMem = Memory.rooms[roomName];
  if (!RMem.repairTargets) RMem.repairTargets = [];
  if (!RMem._towerLocks) RMem._towerLocks = {};
  return RMem;
}

function collectRoomTowers(room) {
  // Simple filter helper; centralizing it makes "how do towers get picked up?"
  // a single place to edit, which is handy once you have multiple rooms.
  var towers = room.find(FIND_MY_STRUCTURES, {
    filter: function (s) { return s.structureType === STRUCTURE_TOWER; }
  }) || [];
  return towers;
}

function handleHostilePhase(towers) {
  // Habit: split the detection from the action. We do a cheap scan pass once,
  // then reuse the same list so each helper stays single-purpose.
  for (var scanIdx = 0; scanIdx < towers.length; scanIdx++) {
    if (towers[scanIdx].pos.findClosestByRange(FIND_HOSTILE_CREEPS)) {
      fireAllTowers(towers);
      return true;
    }
  }
  return false;
}

function fireAllTowers(towers) {
  // Every tower fires independently, but the helper keeps the drawing and
  // validation logic consistent so adding new debug visuals is painless.
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
  // Same pattern: do the boring guard work once so adding new heal rules later
  // is an easy edit.
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
  // We materialize a clean "view" of the repair queue so every tower sees the
  // same filtered data. That way the repair pass never mutates the source list
  // mid-iteration and new contributors can log the list directly if debugging.
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
  // Habit tip: trimming the queue in one helper prevents subtle bugs where
  // multiple code paths forget to drop finished targets.
  while (RMem.repairTargets.length) {
    var head = RMem.repairTargets[0];
    var headObj = head && head.id ? Game.getObjectById(head.id) : null;
    if (headObj && headObj.hits < headObj.hitsMax) break;
    RMem.repairTargets.shift();
  }
}

function runRepairPhase(towers, RMem, validTargets) {
  // This loop is intentionally boring: each tower fetches a target, repairs it,
  // and we immediately log/draw the result. Novices can set breakpoints here
  // without wading through nested callbacks.
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
  // Teaching note: respecting locks first keeps towers from thrashing back and
  // forth. Once the lock is gone we fall through to the shared validTargets
  // list which preserves the priority order set by maintenance.
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
