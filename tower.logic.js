var CoreConfig = require('core.config');
var TaskSquad = null;
try {
  TaskSquad = require('Task.Squad');
} catch (error) {
  TaskSquad = null;
}

var towerSettings = (CoreConfig && CoreConfig.settings && CoreConfig.settings.Tower) || {};
var REPAIR_ENERGY_MIN_DEFAULT = (typeof towerSettings.REPAIR_ENERGY_MIN === 'number')
  ? towerSettings.REPAIR_ENERGY_MIN
  : 400;

function isAllyUsername(username) {
  if (!username) return false;
  if (TaskSquad && typeof TaskSquad.isAlly === 'function') {
    return TaskSquad.isAlly(username);
  }
  return false;
}

function isEnemyUsername(username, myUsername) {
  if (!username) return false;
  if (isAllyUsername(username)) return false;
  if (myUsername && username === myUsername) return false;
  return true;
}

function isEnemyCreep(creep, myUsername) {
  if (!creep || !creep.owner) return false;
  return isEnemyUsername(creep.owner.username, myUsername);
}

module.exports = {
  run: function () {
    // Find the first spawn (keeps your existing assumption)
    var spawnNames = Object.keys(Game.spawns);
    if (!spawnNames.length) return;
    var spawn = Game.spawns[spawnNames[0]];
    if (!spawn) return;

    var room = spawn.room;
    var roomName = room.name;
    var myUsername = (spawn.owner && spawn.owner.username) || null;

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

    // ========== 1) Hostile handling (always first) ==========
    var hostiles = room.find(FIND_HOSTILE_CREEPS, {
      filter: function (creep) { return isEnemyCreep(creep, myUsername); }
    });

    if (hostiles.length) {
      // Everyone shoots their nearest baddie
      for (var a = 0; a < towers.length; a++) {
        var at = towers[a];
        var foe = at.pos.findClosestByRange(hostiles);
        if (foe) at.attack(foe);
      }
      return; // done this tick
    }

    // ========== 2) Repair coordination ==========

    // Filter + validate target list (live objects that still need repairs)
    // Note: we trust your priority already baked into repairTargets order.
    var validTargets = [];
    for (var i = 0; i < RMem.repairTargets.length; i++) {
      var tdata = RMem.repairTargets[i];
      if (!tdata || !tdata.id) continue;
      var obj = Game.getObjectById(tdata.id);
      if (!obj) continue;
      // Needs repair?
      if (obj.hits < obj.hitsMax) {
        validTargets.push({ id: obj.id, hits: obj.hits, hitsMax: obj.hitsMax, pos: obj.pos, type: obj.structureType });
      }
    }

    // If no valid targets, we can trim memory a bit
    if (!validTargets.length) {
      // Soft clean: drop head items that are finished/invalid
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

    // Energy threshold per tower to allow repairs (tune as you like)
    var REPAIR_ENERGY_MIN = REPAIR_ENERGY_MIN_DEFAULT;

    // Helper: claim next available target for a tower (no duplicates this tick)
    function pickTargetForTower(tw) {
      // 1) Respect lock if still valid and not already used this tick
      var lock = RMem._towerLocks[tw.id];
      if (lock && lock.id) {
        var o = Game.getObjectById(lock.id);
        if (o && o.hits < o.hitsMax && !usedTargetIds[o.id]) {
          // renew the lock a bit
          lock.ttl = Math.max(1, (lock.ttl | 0) - 1);
          usedTargetIds[o.id] = true;
          return o;
        } else {
          // lock invalid/consumed
          delete RMem._towerLocks[tw.id];
        }
      }

      // 2) Find the first valid target not yet used this tick
      // You can do nearest-first if you like; here we honor list order (priority)
      for (var j = 0; j < validTargets.length; j++) {
        var cand = validTargets[j];
        if (usedTargetIds[cand.id]) continue;
        var obj2 = Game.getObjectById(cand.id);
        if (!obj2) continue;
        if (obj2.hits >= obj2.hitsMax) continue;
        usedTargetIds[cand.id] = true;

        // set/refresh a short lock so we stay on it a few ticks
        RMem._towerLocks[tw.id] = { id: obj2.id, ttl: 3 }; // ~3 ticks stickiness
        return obj2;
      }

      // 3) Nothing left
      return null;
    }

    // Each tower decides independently; only one tower gets each target (via usedTargetIds)
    for (var k = 0; k < towers.length; k++) {
      var tower = towers[k];

      // Skip if low energy
      var energy = tower.store.getUsedCapacity(RESOURCE_ENERGY) | 0;
      if (energy < REPAIR_ENERGY_MIN) continue;

      // If there's only one target, only let the FIRST tower act on it
      // (This is naturally enforced by usedTargetIds once the first tower picks it.)
      var target = pickTargetForTower(tower);
      if (target) {
        tower.repair(target);

        // Optional: visualize
        tower.room.visual.circle(target.pos, { radius: 0.45, fill: 'transparent', stroke: '#66ff66' });
        tower.room.visual.line(tower.pos, target.pos, { opacity: 0.3 });

        // If target is now done, trim head(s) of queue if they match
        // (Keeps Memory.repairTargets tidy when you focus the first items most)
        while (RMem.repairTargets.length) {
          var head2 = RMem.repairTargets[0];
          if (!head2 || !head2.id) { RMem.repairTargets.shift(); continue; }
          var ho = Game.getObjectById(head2.id);
          if (!ho || ho.hits >= ho.hitsMax) RMem.repairTargets.shift();
          else break;
        }
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
