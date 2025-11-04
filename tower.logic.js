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
    // Find the first spawn (keeps your existing assumption)
    var spawnNames = Object.keys(Game.spawns);
    if (!spawnNames.length) return;
    var spawn = Game.spawns[spawnNames[0]];
    if (!spawn) return;

    var room = spawn.room;
    var roomName = room.name;

    // Ensure room memory
    if (!Memory.rooms) Memory.rooms = {};
    if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};

    var RMem = Memory.rooms[roomName];

    // Repair targets array expected from your maintenance pass
    if (!RMem.repairTargets) RMem.repairTargets = [];

    // Per-tower short locks so we don't thrash assignments
    // Structure: RMem._towerLocks[towerId] = { id: targetId, ttl: n }
    if (!RMem._towerLocks) RMem._towerLocks = {};

    // Collect towers
    var towers = room.find(FIND_MY_STRUCTURES, {
      filter: function (s) { return s.structureType === STRUCTURE_TOWER; }
    });
    if (!towers || !towers.length) return;

    // ------------------------------------
    // 1) Hostile handling (always first)
    // ------------------------------------
    var hostilePresent = false;
    var scanIdx;
    for (scanIdx = 0; scanIdx < towers.length; scanIdx++) {
      var tChk = towers[scanIdx];
      var nearestHostile = tChk.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
      if (nearestHostile) { hostilePresent = true; break; }
    }

    if (hostilePresent) {
      // Everyone shoots their nearest baddie (simple + effective)
      for (var a = 0; a < towers.length; a++) {
        var at = towers[a];
        var energyA = at.store.getUsedCapacity(RESOURCE_ENERGY) | 0;
        if (energyA < CFG.ATTACK_MIN) continue;

        var foe = at.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
        if (foe) {
          at.attack(foe);
          _tsay(at, "ATK");
          _line(at.room, at.pos, foe.pos, CFG.DRAW.ATK);
          _ring(at.room, foe.pos, CFG.DRAW.ATK);
          _label(at.room, foe.pos, "ATK", CFG.DRAW.ATK);
        }
      }
      return; // done this tick
    }

    // ------------------------------------
    // 2) (Optional) heal wounded allies
    // ------------------------------------
    // Heals come before repairs but after combat; keeps creeps alive mid-ops.
    var anyHealed = false;
    for (var h = 0; h < towers.length; h++) {
      var ht = towers[h];
      var energyH = ht.store.getUsedCapacity(RESOURCE_ENERGY) | 0;
      if (energyH < CFG.HEAL_MIN) continue;

      var patient = ht.pos.findClosestByRange(FIND_MY_CREEPS, {
        filter: function (c) { return c.hits < c.hitsMax; }
      });
      if (patient) {
        ht.heal(patient);
        _tsay(ht, "HEAL");
        _line(ht.room, ht.pos, patient.pos, CFG.DRAW.HEAL);
        _ring(ht.room, patient.pos, CFG.DRAW.HEAL);
        _label(ht.room, patient.pos, "HEAL", CFG.DRAW.HEAL);
        anyHealed = true;
      }
    }
    // (We do not early-return; multiple towers can heal different targets, then proceed to repairs.)

    // ------------------------------------
    // 3) Repair coordination
    // ------------------------------------

    // Validate/collect live repair targets (still damaged)
    var validTargets = [];
    var i;
    for (i = 0; i < RMem.repairTargets.length; i++) {
      var tdata = RMem.repairTargets[i];
      if (!tdata || !tdata.id) continue;
      var obj = Game.getObjectById(tdata.id);
      if (!obj) continue;
      if (obj.hits < obj.hitsMax) {
        validTargets.push({ id: obj.id, pos: obj.pos, hits: obj.hits, hitsMax: obj.hitsMax, type: obj.structureType });
      }
    }

    // If no valid targets, soft-trim the queue head(s) and bail
    if (!validTargets.length) {
      while (RMem.repairTargets.length) {
        var head = RMem.repairTargets[0];
        var headObj = head && head.id ? Game.getObjectById(head.id) : null;
        if (headObj && headObj.hits < headObj.hitsMax) break;
        RMem.repairTargets.shift();
      }
      return;
    }

    // Used targets THIS tick so we don't double-up
    var usedTargetIds = {};

    // Helper: claim next available target for a tower (no duplicates this tick)
    function pickTargetForTower(tw) {
      // 1) Respect lock if still valid and not already used this tick
      var lock = RMem._towerLocks[tw.id];
      if (lock && lock.id) {
        var o = Game.getObjectById(lock.id);
        if (o && o.hits < o.hitsMax && !usedTargetIds[o.id]) {
          // Keep lock (we'll decrement TTL later in cleanup)
          usedTargetIds[o.id] = true;
          return o;
        } else {
          // lock invalid/consumed
          delete RMem._towerLocks[tw.id];
        }
      }

      // 2) Find first valid (list order = priority) not yet used this tick
      for (var j = 0; j < validTargets.length; j++) {
        var cand = validTargets[j];
        if (usedTargetIds[cand.id]) continue;
        var obj2 = Game.getObjectById(cand.id);
        if (!obj2) continue;
        if (obj2.hits >= obj2.hitsMax) continue;

        usedTargetIds[cand.id] = true;
        RMem._towerLocks[tw.id] = { id: obj2.id, ttl: CFG.LOCK_TTL | 0 };
        return obj2;
      }

      // 3) Nothing left
      return null;
    }

    // Each tower decides independently; only one tower gets each target (via usedTargetIds)
    for (var k = 0; k < towers.length; k++) {
      var tower = towers[k];

      // Skip if low energy for repairs
      var energy = tower.store.getUsedCapacity(RESOURCE_ENERGY) | 0;
      if (energy < CFG.REPAIR_MIN) {
        _tsay(tower, "idle");
        continue;
      }

      var target = pickTargetForTower(tower);
      if (!target) {
        _tsay(tower, "idle");
        continue;
      }

      tower.repair(target);
      _tsay(tower, "REP");
      _line(tower.room, tower.pos, target.pos, CFG.DRAW.REP);
      _ring(tower.room, target.pos, CFG.DRAW.REP);
      _label(tower.room, target.pos, "REP", CFG.DRAW.REP);

      // Optional: draw lock line to remind assignment
      if (CFG.DEBUG_DRAW) {
        _line(tower.room, tower.pos, target.pos, CFG.DRAW.LOCK);
      }

      // If target is now done, trim head(s) of queue if they match
      while (RMem.repairTargets.length) {
        var head2 = RMem.repairTargets[0];
        if (!head2 || !head2.id) { RMem.repairTargets.shift(); continue; }
        var ho = Game.getObjectById(head2.id);
        if (!ho || ho.hits >= ho.hitsMax) RMem.repairTargets.shift();
        else break;
      }
    }

    // Clean up expired locks or finished targets
    for (var twid in RMem._towerLocks) {
      if (!RMem._towerLocks.hasOwnProperty(twid)) continue;
      var L = RMem._towerLocks[twid];
      if (!L || !L.id) { delete RMem._towerLocks[twid]; continue; }
      var lockedObj = Game.getObjectById(L.id);
      if (!lockedObj || lockedObj.hits >= lockedObj.hitsMax) { delete RMem._towerLocks[twid]; continue; }
      var ttl = (L.ttl | 0) - 1;
      if (ttl <= 0) delete RMem._towerLocks[twid];
      else RMem._towerLocks[twid].ttl = ttl;
    }
  }
};
