// role.TaskQueen.js (refactor, API-compatible, ES5-safe)
// - Same export + entry: TaskQueen.run(creep)
// - Priorities:
//   1) BOOTSTRAP: build first EXT/CONTAINER or micro-haul
//   2) When carrying: EXT/SPAWN → TOWER → LINK(spawn) → TERMINAL → STORAGE
//   3) When empty: STORAGE → non-source CONTAINERS → DROPS → harvest fallback
//
// - Per-tick fill reservations prevent two Queens from selecting the same target
// - Sticky target: if still needy, keep filling it to reduce indecision
// - Uses BeeToolbox.BeeTravel if available

var BeeToolbox = require('BeeToolbox');

// ============================
// Movement / Utils
// ============================
function go(creep, dest, range) {
  range = (range != null) ? range : 1;
  if (BeeToolbox && BeeToolbox.BeeTravel) {
    BeeToolbox.BeeTravel(creep, dest, { range: range, reusePath: 15 });
  } else if (creep.pos.getRangeTo(dest) > range) {
    creep.moveTo(dest, { reusePath: 15 });
  }
}

function firstSpawn(room) {
  var spawns = room.find(FIND_MY_SPAWNS);
  return spawns.length ? spawns[0] : null;
}

function isContainerNearSource(structure) {
  return structure.pos.findInRange(FIND_SOURCES, 2).length > 0;
}

function findClosestByPath(creep, type, filterFn) {
  return creep.pos.findClosestByPath(type, { filter: filterFn });
}

function withdrawFrom(creep, target, res) {
  res = res || RESOURCE_ENERGY;
  var rc = creep.withdraw(target, res);
  if (rc === ERR_NOT_IN_RANGE) { go(creep, target); return rc; }
  if (rc === OK) {
    creep.memory.qLastWithdrawId = target.id;
    creep.memory.qLastWithdrawAt = Game.time;
  }
  return rc;
}


function transferTo(creep, target, res) {
  res = res || RESOURCE_ENERGY;
  var rc = creep.transfer(target, res);
  if (rc === ERR_NOT_IN_RANGE) go(creep, target);
  return rc;
}

function harvestFromClosest(creep) {
  var src = findClosestByPath(creep, FIND_SOURCES_ACTIVE);
  if (!src) return ERR_NOT_FOUND;
  var rc = creep.harvest(src);
  if (rc === ERR_NOT_IN_RANGE) go(creep, src);
  return rc;
}

function linkNearSpawn(room) {
  var s = firstSpawn(room);
  if (!s) return null;
  return s.pos.findClosestByRange(FIND_STRUCTURES, {
    filter: function (st) { return st.structureType === STRUCTURE_LINK; }
  });
}

// ============================
// Per-tick Queen fill reservations (ES5-safe)
// structureId -> reserved energy amount (auto-reset each tick)
// ============================
function _qrMap() {
  if (!Memory._queenRes || Memory._queenRes.tick !== Game.time) {
    Memory._queenRes = { tick: Game.time, map: {} };
  }
  return Memory._queenRes.map;
}

function _reservedFor(structId) {
  var map = _qrMap();
  return map[structId] || 0;
}

function _effectiveFree(struct, resourceType) {
  resourceType = resourceType || RESOURCE_ENERGY;
  var free = (struct.store && struct.store.getFreeCapacity(resourceType)) || 0;
  return Math.max(0, free - _reservedFor(struct.id));
}

// Reserve up to `amount` for this creep; returns amount actually reserved
function reserveFill(creep, target, amount, resourceType) {
  resourceType = resourceType || RESOURCE_ENERGY;
  var map = _qrMap();
  var free = _effectiveFree(target, resourceType);
  var want = Math.max(0, Math.min(amount, free));
  if (want > 0) {
    map[target.id] = (map[target.id] || 0) + want;
    creep.memory.qTargetId = target.id; // soft sticky target
  }
  return want;
}

// ============================
// Main
// ============================
var TaskQueen = {
  run: function (creep) {
    // ---------------------------------------------------------
    // 0) BOOTSTRAP: before first source-containers exist
    // ---------------------------------------------------------
    var hasSourceContainers = creep.room.find(FIND_STRUCTURES, {
      filter: function (s) {
        return s.structureType === STRUCTURE_CONTAINER &&
               s.pos.findInRange(FIND_SOURCES, 1).length > 0;
      }
    }).length > 0;

    if (!hasSourceContainers) {
      // Build first EXT/CONTAINER if any site exists
      var site = creep.pos.findClosestByPath(FIND_CONSTRUCTION_SITES, {
        filter: function (s) {
          return s.structureType === STRUCTURE_EXTENSION ||
                 s.structureType === STRUCTURE_CONTAINER;
        }
      });

      if (site) {
        if (creep.store[RESOURCE_ENERGY] === 0) {
          // Withdraw from spawn only when room energy is topped up
          var sp = creep.pos.findClosestByPath(FIND_MY_SPAWNS);
          if (sp &&
              sp.store && sp.store[RESOURCE_ENERGY] >= 50 &&
              creep.room.energyAvailable === creep.room.energyCapacityAvailable) {
            withdrawFrom(creep, sp);
          } else {
            harvestFromClosest(creep);
          }
        } else {
          if (creep.build(site) === ERR_NOT_IN_RANGE) go(creep, site);
        }
        return;
      }

      // No relevant site? micro-courier to kickstart economy
      var drop = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
        filter: function (r) { return r.resourceType === RESOURCE_ENERGY; }
      });
      if (drop && creep.store.getFreeCapacity() > 0) {
        if (creep.pickup(drop) === ERR_NOT_IN_RANGE) go(creep, drop);
        return;
      }

      var needyEarly = creep.pos.findClosestByPath(FIND_MY_STRUCTURES, {
        filter: function (s) {
          return (s.structureType === STRUCTURE_SPAWN ||
                  s.structureType === STRUCTURE_EXTENSION) &&
                 s.store && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
        }
      });
      if (needyEarly && creep.store[RESOURCE_ENERGY] > 0) {
        transferTo(creep, needyEarly);
        return;
      }
      // Fall through to normal logic if nothing else to do.
    }

    // ---------------------------------------------------------
    // 1) NORMAL PHASE: decide by carry state
    // ---------------------------------------------------------
    var carrying = creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0;

    if (carrying) {
      var carryAmt = creep.store.getUsedCapacity(RESOURCE_ENERGY);

      // Sticky target first (if still has effective free)
      if (creep.memory.qTargetId) {
        var sticky = Game.getObjectById(creep.memory.qTargetId);
        if (sticky && _effectiveFree(sticky, RESOURCE_ENERGY) > 0) {
          if (reserveFill(creep, sticky, carryAmt, RESOURCE_ENERGY) > 0) {
            transferTo(creep, sticky);
            return;
          }
        } else {
          // Clear stale sticky if it’s full/gone
          creep.memory.qTargetId = null;
        }
      }

      function firstNeedyTarget(filterFn) {
        var t = creep.pos.findClosestByPath(FIND_STRUCTURES, {
          filter: function(s) {
            if (!filterFn(s)) return false;
            return _effectiveFree(s, RESOURCE_ENERGY) > 0;
          }
        });
        return t || null;
      }

      // Priority: EXT/SPAWN -> TOWER -> LINK(spawn) -> TERMINAL -> STORAGE
      var target =
        firstNeedyTarget(function (s) {
          return (s.structureType === STRUCTURE_EXTENSION ||
                  s.structureType === STRUCTURE_SPAWN) && s.store;
        }) ||
        firstNeedyTarget(function (s) {
          return s.structureType === STRUCTURE_TOWER && s.store;
        });

      if (!target) {
        var link = linkNearSpawn(creep.room);
        if (link && _effectiveFree(link, RESOURCE_ENERGY) > 0) target = link;
      }

      if (!target) {
        target = firstNeedyTarget(function (s) {
          return s.structureType === STRUCTURE_TERMINAL && s.store &&
                 s.id !== creep.memory.qLastWithdrawId;
        });
      }

      if (!target) {
        target = firstNeedyTarget(function (s) {
          return s.structureType === STRUCTURE_STORAGE && s.store &&
                 s.id !== creep.memory.qLastWithdrawId;
        });
      }

      if (target) {
        if (reserveFill(creep, target, carryAmt, RESOURCE_ENERGY) > 0) {
          transferTo(creep, target);
          return;
        }
        // Reservation lost to a race? Re-pick next tick.
      }

      // Nothing needs energy? soft idle near spawn
      var anchor = firstSpawn(creep.room) || creep.room.controller || creep.pos;
      go(creep, (anchor.pos || anchor), 2);
      return;
    } else {
      // Refill: STORAGE → non-source CONTAINERS → DROPS → harvest
      var storage = findClosestByPath(creep, FIND_STRUCTURES, function (s) {
        return s.structureType === STRUCTURE_STORAGE &&
               s.store && s.store.getUsedCapacity(RESOURCE_ENERGY) > 0;
      });
      if (storage) { withdrawFrom(creep, storage); return; }

      var sideContainer = findClosestByPath(creep, FIND_STRUCTURES, function (s) {
        return s.structureType === STRUCTURE_CONTAINER &&
               s.store && s.store.getUsedCapacity(RESOURCE_ENERGY) > 0 &&
               !isContainerNearSource(s);
      });
      if (sideContainer) { withdrawFrom(creep, sideContainer); return; }

      var drop2 = creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
        filter: function (r) { return r.resourceType === RESOURCE_ENERGY; }
      });
      if (drop2) {
        if (creep.pickup(drop2) === ERR_NOT_IN_RANGE) go(creep, drop2);
        return;
      }

      // Last resort: harvest a little
      harvestFromClosest(creep);
      return;
    }
  }
};

module.exports = TaskQueen;
