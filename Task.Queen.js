var BeeToolbox = require('BeeToolbox');

// ============================
// Movement / Utils
// ============================
function go(creep, dest, range) {
  range = (range != null) ? range : 1;
  var reuse = 30; // higher reuse to cut pathing CPU
  if (BeeToolbox && BeeToolbox.BeeTravel) {
    try { BeeToolbox.BeeTravel(creep, dest, { range: range, reusePath: reuse }); return; } catch (e) {}
  }
  if (creep.pos.getRangeTo(dest) > range) creep.moveTo(dest, { reusePath: reuse, maxOps: 2000 });
}
function firstSpawn(room) {
  var ss = room.find(FIND_MY_SPAWNS);
  return ss.length ? ss[0] : null;
}
function isContainerNearSource(structure) {
  return structure.pos.findInRange(FIND_SOURCES, 2).length > 0;
}
function harvestFromClosest(creep) {
  var srcs = creep.room.find(FIND_SOURCES_ACTIVE);
  if (!srcs.length) return ERR_NOT_FOUND;
  var best = _nearest(creep.pos, srcs);
  var rc = creep.harvest(best);
  if (rc === ERR_NOT_IN_RANGE) go(creep, best);
  return rc;
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
// NOTE: transferTo is overridden below after PIB helpers are defined.
function _nearest(pos, arr) {
  var best = null, bestD = 1e9;
  for (var i = 0; i < arr.length; i++) {
    var o = arr[i]; if (!o) continue;
    var d = pos.getRangeTo(o);
    if (d < bestD) { bestD = d; best = o; }
  }
  return best;
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

// ============================
// Predictive Intent Buffer (PIB) – multi-tick "I'm headed there" holds
// rooms -> fills[targetId][creepName] = { res, amount, untilTick }
// ============================
function _pibRoot() {
  // Reset the root once per tick but keep prior room maps
  var root = Memory._PIB;
  if (!root || root.tick !== Game.time) {
    Memory._PIB = { tick: Game.time, rooms: root && root.rooms ? root.rooms : {} };
  }
  return Memory._PIB;
}

function _pibRoom(roomName) {
  var root = _pibRoot();
  var rooms = root.rooms;
  if (!rooms[roomName]) rooms[roomName] = { fills: {} };
  return rooms[roomName];
}

// Sum active (unexpired) reservations for a target+resource
function _pibSumReserved(roomName, targetId, resourceType) {
  resourceType = resourceType || RESOURCE_ENERGY;
  var R = _pibRoom(roomName);
  var byCreep = (R.fills[targetId] || {});
  var total = 0;
  for (var cname in byCreep) {
    if (!byCreep.hasOwnProperty(cname)) continue;
    var rec = byCreep[cname];
    if (!rec || rec.res !== resourceType) continue;
    if (rec.untilTick > Game.time) total += (rec.amount | 0);
    else {
      // prune expired
      delete byCreep[cname];
    }
  }
  if (Object.keys(byCreep).length === 0) delete R.fills[targetId];
  return total;
}

// Upsert a fill intent for (creep -> target) with ETA-based expiry
function _pibReserveFill(creep, target, amount, resourceType) {
  if (!creep || !target || !amount) return 0;
  resourceType = resourceType || RESOURCE_ENERGY;

  var roomName = (creep.room && creep.room.name) || (target.pos && target.pos.roomName);
  if (!roomName) return 0;

  var R = _pibRoom(roomName);
  if (!R.fills[target.id]) R.fills[target.id] = {};

  var dist = 0;
  try { dist = creep.pos.getRangeTo(target); } catch (e) { dist = 5; }
  // ETA fudge: distance + 1 (handoff) + min floor
  var eta = Math.max(2, (dist | 0) + 1);

  R.fills[target.id][creep.name] = {
    res: resourceType,
    amount: amount | 0,
    untilTick: Game.time + eta
  };
  return amount | 0;
}

// Clear the creep's intent for a specific target (after transfer or if invalid)
function _pibReleaseFill(creep, target, resourceType) {
  if (!creep || !target) return;
  resourceType = resourceType || RESOURCE_ENERGY;

  var roomName = (creep.room && creep.room.name) || (target.pos && target.pos.roomName);
  if (!roomName) return;

  var R = _pibRoom(roomName);
  var map = R.fills[target.id];
  if (map && map[creep.name]) delete map[creep.name];
  if (map && Object.keys(map).length === 0) delete R.fills[target.id];
}

// ============================
// PIB-aware free capacity check
// ============================
function _effectiveFree(struct, resourceType) {
  resourceType = resourceType || RESOURCE_ENERGY;

  // What the structure *physically* can take right now
  var freeNow = (struct.store && struct.store.getFreeCapacity(resourceType)) || 0;

  // Subtract same-tick queen reservations (your existing buffer)
  var sameTickReserved = _reservedFor(struct.id) | 0;

  // Subtract multi-tick predictive reservations (others already en route)
  var roomName = (struct.pos && struct.pos.roomName) || (struct.room && struct.room.name);
  var pibReserved = 0;
  if (roomName) pibReserved = _pibSumReserved(roomName, struct.id, resourceType) | 0;

  return Math.max(0, freeNow - sameTickReserved - pibReserved);
}

// ============================
// Reserve up to `amount` for this creep; returns amount actually reserved
// (Records both same-tick queen reservation AND multi-tick PIB intent.)
// ============================
function reserveFill(creep, target, amount, resourceType) {
  resourceType = resourceType || RESOURCE_ENERGY;

  var map = _qrMap();
  var free = _effectiveFree(target, resourceType);
  var want = Math.max(0, Math.min(amount, free));

  if (want > 0) {
    // Per-tick map (existing behavior)
    map[target.id] = (map[target.id] || 0) + want;

    // Sticky assignment (existing)
    creep.memory.qTargetId = target.id;

    // NEW: multi-tick predictive reservation so others avoid retargeting it
    _pibReserveFill(creep, target, want, resourceType);
  }
  return want;
}

// ============================
// transferTo override – release PIB on success/full/most errors
// ============================
function transferTo(creep, target, res) {
  res = res || RESOURCE_ENERGY;
  var rc = creep.transfer(target, res);

  if (rc === ERR_NOT_IN_RANGE) {
    go(creep, target);
    return rc;
  }

  if (rc === OK) {
    // We delivered: clear our predictive reservation for this target
    _pibReleaseFill(creep, target, res);
  } else if (rc === ERR_FULL) {
    // Target filled before we arrived; release our intent so we can retarget
    _pibReleaseFill(creep, target, res);
    creep.memory.qTargetId = null;
  } else if (rc !== OK && rc !== ERR_TIRED && rc !== ERR_BUSY) {
    // On hard errors (invalid/ownership/etc.), release so we don't stick
    _pibReleaseFill(creep, target, res);
    creep.memory.qTargetId = null;
  }
  return rc;
}

// ============================
// Per-room, once-per-tick cache
// ============================
if (!global.__QUEEN) global.__QUEEN = { tick: -1, byRoom: {} };

function _qCache(room) {
  var G = global.__QUEEN;
  if (G.tick !== Game.time) { G.tick = Game.time; G.byRoom = {}; }
  var R = G.byRoom[room.name];
  if (R) return R;

  var sp = firstSpawn(room);
  var linkNearSpawn = null;
  if (sp) {
    linkNearSpawn = sp.pos.findClosestByRange(FIND_STRUCTURES, {
      filter: function (st) { return st.structureType === STRUCTURE_LINK; }
    });
  }

  // Spawns + extensions needing energy
  var extSpawnNeed = room.find(FIND_STRUCTURES, {
    filter: function (s) {
      if (!s.store) return false;
      if (s.structureType !== STRUCTURE_EXTENSION && s.structureType !== STRUCTURE_SPAWN) return false;
      return (s.store.getFreeCapacity(RESOURCE_ENERGY) | 0) > 0;
    }
  });
  var REFILL_AT_OR_BELOW = 0.70;

  // Towers needing energy
  var towersNeed = room.find(FIND_STRUCTURES, {
    filter: function (s) {
      if (s.structureType !== STRUCTURE_TOWER || !s.store) return false;

      var used = (s.store.getUsedCapacity(RESOURCE_ENERGY) | 0);
      var cap = (s.store.getCapacity(RESOURCE_ENERGY) | 0);
      if (cap <= 0) return false;

      var fillPct = used / cap; // 0.0 .. 1.0
      return fillPct <= REFILL_AT_OR_BELOW; // true = needs refill
      //return (s.store.getFreeCapacity(RESOURCE_ENERGY) | 0) > 0;
    }
  });

  // Terminal/storage needing energy (rare, but keep)
  var terminalNeed = (room.terminal && room.terminal.store &&
                      (room.terminal.store.getFreeCapacity(RESOURCE_ENERGY) | 0) > 0) ? room.terminal : null;
  var storageNeed  = (room.storage && room.storage.store &&
                      (room.storage.store.getFreeCapacity(RESOURCE_ENERGY) | 0) > 0) ? room.storage : null;

  // Storage with energy (for withdraw)
  var storageHasEnergy = (room.storage && (room.storage.store[RESOURCE_ENERGY] | 0) > 0) ? room.storage : null;

  // Side containers (non-source) with energy for withdraw
  var sideContainers = room.find(FIND_STRUCTURES, {
    filter: function (s) {
      return s.structureType === STRUCTURE_CONTAINER &&
             !isContainerNearSource(s) &&
             s.store && (s.store.getUsedCapacity(RESOURCE_ENERGY) | 0) > 0;
    }
  });

  // Source containers exist?
  var hasSourceContainers = room.find(FIND_STRUCTURES, {
    filter: function (s) {
      return s.structureType === STRUCTURE_CONTAINER &&
             s.pos.findInRange(FIND_SOURCES, 1).length > 0;
    }
  }).length > 0;

  R = {
    spawn: sp,
    linkNearSpawn: linkNearSpawn,
    extSpawnNeed: extSpawnNeed,
    towersNeed: towersNeed,
    terminalNeed: terminalNeed,
    storageNeed: storageNeed,
    storageHasEnergy: storageHasEnergy,
    sideContainers: sideContainers,
    hasSourceContainers: hasSourceContainers
  };
  G.byRoom[room.name] = R;
  return R;
}

// ============================
// Main
// ============================
var TaskQueen = {
  run: function (creep) {
    var room = creep.room;
    var cache = _qCache(room);

    // BOOTSTRAP (before first source-containers exist)
    if (!cache.hasSourceContainers) {
      // Build first EXT/CONTAINER if present
      var site = creep.pos.findClosestByRange(FIND_CONSTRUCTION_SITES, {
        filter: function (s) {
          return s.structureType === STRUCTURE_EXTENSION ||
                 s.structureType === STRUCTURE_CONTAINER;
        }
      });
      if (site) {
        if ((creep.store[RESOURCE_ENERGY] | 0) === 0) {
          // Withdraw from spawn if room is topped up, else harvest
          var sp = _nearest(creep.pos, room.find(FIND_MY_SPAWNS));
          if (sp && sp.store && (sp.store[RESOURCE_ENERGY] | 0) >= 50 &&
              room.energyAvailable === room.energyCapacityAvailable) {
            withdrawFrom(creep, sp);
          } else {
            harvestFromClosest(creep);
          }
        } else {
          var b = creep.build(site);
          if (b === ERR_NOT_IN_RANGE) go(creep, site);
        }
        return;
      }
      // Micro-courier: scoop close drops & feed spawn/extension
      var drop = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
        filter: function (r) { return r.resourceType === RESOURCE_ENERGY; }
      });
      if (drop && creep.store.getFreeCapacity() > 0) {
        if (creep.pickup(drop) === ERR_NOT_IN_RANGE) go(creep, drop);
        return;
      }
      var needyEarly = creep.pos.findClosestByRange(FIND_MY_STRUCTURES, {
        filter: function (s) {
          return (s.structureType === STRUCTURE_SPAWN ||
                  s.structureType === STRUCTURE_EXTENSION) &&
                 s.store && (s.store.getFreeCapacity(RESOURCE_ENERGY) | 0) > 0;
        }
      });
      if (needyEarly && (creep.store[RESOURCE_ENERGY] | 0) > 0) {
        transferTo(creep, needyEarly); return;
      }
      // Fall through to normal
    }

    // NORMAL PHASE
    var carrying = (creep.store.getUsedCapacity(RESOURCE_ENERGY) | 0) > 0;

    if (carrying) {
      var carryAmt = creep.store.getUsedCapacity(RESOURCE_ENERGY) | 0;

      // Try sticky target first
      if (creep.memory.qTargetId) {
        var sticky = Game.getObjectById(creep.memory.qTargetId);
        if (sticky && _effectiveFree(sticky, RESOURCE_ENERGY) > 0) {
          if (reserveFill(creep, sticky, carryAmt, RESOURCE_ENERGY) > 0) {
            transferTo(creep, sticky); return;
          }
        } else {
          creep.memory.qTargetId = null;
        }
      }

      // Helper: pick nearest among candidates that still have effective free
      function pickNeedy(cands) {
        var ok = [];
        for (var i = 0; i < cands.length; i++) {
          var s = cands[i];
          if (s && _effectiveFree(s, RESOURCE_ENERGY) > 0) ok.push(s);
        }
        return ok.length ? _nearest(creep.pos, ok) : null;
      }

      // Order: EXT/SPAWN -> TOWER -> LINK(spawn) -> TERMINAL -> STORAGE
      var target =
        pickNeedy(cache.extSpawnNeed) ||
        pickNeedy(cache.towersNeed)   ||
        (cache.linkNearSpawn && _effectiveFree(cache.linkNearSpawn, RESOURCE_ENERGY) > 0 ? cache.linkNearSpawn : null) ||
        ((cache.terminalNeed && cache.terminalNeed.id !== creep.memory.qLastWithdrawId &&
          _effectiveFree(cache.terminalNeed, RESOURCE_ENERGY) > 0) ? cache.terminalNeed : null) ||
        ((cache.storageNeed  && cache.storageNeed.id  !== creep.memory.qLastWithdrawId &&
          _effectiveFree(cache.storageNeed,  RESOURCE_ENERGY) > 0) ? cache.storageNeed  : null);

      if (target) {
        if (reserveFill(creep, target, carryAmt, RESOURCE_ENERGY) > 0) {
          transferTo(creep, target); return;
        }
        // reservation lost? we'll re-pick next tick
      }

      // Soft idle near spawn/controller
      var anchor = cache.spawn || room.controller || creep.pos;
      go(creep, (anchor.pos || anchor), 2);
      return;
    }

    // Refill: STORAGE -> side CONTAINERS -> DROPS -> harvest
    if (cache.storageHasEnergy) { withdrawFrom(creep, cache.storageHasEnergy); return; }

    if (cache.sideContainers.length) {
      var side = _nearest(creep.pos, cache.sideContainers);
      if (side) { withdrawFrom(creep, side); return; }
    }

    var drop2 = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
      filter: function (r) { return r.resourceType === RESOURCE_ENERGY; }
    });
    if (drop2) { if (creep.pickup(drop2) === ERR_NOT_IN_RANGE) go(creep, drop2); return; }

    harvestFromClosest(creep);
  }
};

module.exports = TaskQueen;
