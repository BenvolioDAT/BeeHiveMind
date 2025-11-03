var BeeToolbox = require('BeeToolbox');

// ============================
// Tunables
// ============================
var CFG = Object.freeze({
  PATH_REUSE: 30,
  MAX_OPS: 2000,
  TOWER_REFILL_PCT: 0.80,
  DEBUG_SAY: false,  // turn off to mute creep.say
  DEBUG_DRAW: true, // turn off to disable RoomVisual lines/text
  DRAW: {
    WD_COLOR: "#6ec1ff",
    FILL_COLOR: "#6effa1",
    DROP_COLOR: "#ffe66e",
    SRC_COLOR: "#ff9a6e",
    IDLE_COLOR: "#bfbfbf",
    STICK_COLOR: "#aaffaa",
    WIDTH: 0.12,
    OPACITY: 0.45,
    FONT: 0.6
  }
});

// ============================
// Movement / Utils
// ============================
function go(creep, dest, range) {
  range = (range != null) ? range : 1;

  if (BeeToolbox && BeeToolbox.BeeTravel) {
    try {
      BeeToolbox.BeeTravel(creep, dest, { range: range, reusePath: CFG.PATH_REUSE });
      return;
    } catch (e) {}
  }

  if (creep.pos.getRangeTo(dest) > range) {
    creep.moveTo(dest, { reusePath: CFG.PATH_REUSE, maxOps: CFG.MAX_OPS });
  }
}

function debugSay(creep, msg) {
  if (CFG.DEBUG_SAY) creep.say(msg, true);
}

function debugDraw(creep, target, color, label) {
  if (!CFG.DEBUG_DRAW || !creep || !target) return;
  var room = creep.room;
  if (!room || !room.visual) return;

  var tpos = target.pos || (target.position || null);
  if (!tpos || tpos.roomName !== room.name) return;

  try {
    room.visual.line(creep.pos, tpos, {
      color: color,
      width: CFG.DRAW.WIDTH,
      opacity: CFG.DRAW.OPACITY,
      lineStyle: "solid"
    });
    if (label) {
      room.visual.text(label, tpos.x, tpos.y - 0.3, {
        color: color,
        opacity: CFG.DRAW.OPACITY,
        font: CFG.DRAW.FONT,
        align: "center"
      });
    }
  } catch (e) {}
}

function firstSpawn(room) {
  var ss = room.find(FIND_MY_SPAWNS);
  return ss.length ? ss[0] : null;
}

function isContainerNearSource(structure) {
  // <=2 tiles counts as "source container"
  return structure.pos.findInRange(FIND_SOURCES, 2).length > 0;
}

function nearestByRange(pos, arr) {
  var best = null, bestD = 1e9;
  for (var i = 0; i < arr.length; i++) {
    var o = arr[i]; if (!o) continue;
    var d = pos.getRangeTo(o);
    if (d < bestD) { bestD = d; best = o; }
  }
  return best;
}

function harvestFromClosest(creep) {
  var srcs = creep.room.find(FIND_SOURCES_ACTIVE);
  if (!srcs.length) return ERR_NOT_FOUND;
  var best = nearestByRange(creep.pos, srcs);
  debugSay(creep, '⛏️Src');
  debugDraw(creep, best, CFG.DRAW.SRC_COLOR, "SRC");
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

// ============================
// Per-tick Queen fill reservations
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
// Predictive Intent Buffer (PIB)
// ============================
function _pibRoot() {
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
    else delete byCreep[cname];
  }
  if (Object.keys(byCreep).length === 0) delete R.fills[targetId];
  return total;
}

// NEW: amount reserved by others (exclude this creep)
function _pibSumReservedExcept(roomName, targetId, resourceType, exceptName) {
  resourceType = resourceType || RESOURCE_ENERGY;
  var R = _pibRoom(roomName);
  var byCreep = (R.fills[targetId] || {});
  var total = 0;
  for (var cname in byCreep) {
    if (!byCreep.hasOwnProperty(cname)) continue;
    if (cname === exceptName) continue;
    var rec = byCreep[cname];
    if (!rec || rec.res !== resourceType) continue;
    if (rec.untilTick > Game.time) total += (rec.amount | 0);
    else delete byCreep[cname];
  }
  if (Object.keys(byCreep).length === 0) delete R.fills[targetId];
  return total;
}

// NEW: how much *this creep* has reserved (active)
function _pibMine(creep, target, resourceType) {
  resourceType = resourceType || RESOURCE_ENERGY;
  var roomName = (creep.room && creep.room.name) || (target.pos && target.pos.roomName);
  if (!roomName) return 0;
  var R = _pibRoom(roomName);
  var map = R.fills[target.id];
  if (!map) return 0;
  var rec = map[creep.name];
  if (!rec || rec.res !== resourceType) return 0;
  if (rec.untilTick > Game.time) return (rec.amount | 0);
  delete map[creep.name];
  if (Object.keys(map).length === 0) delete R.fills[target.id];
  return 0;
}

function _pibReserveFill(creep, target, amount, resourceType) {
  if (!creep || !target || !amount) return 0;
  resourceType = resourceType || RESOURCE_ENERGY;

  var roomName = (creep.room && creep.room.name) || (target.pos && target.pos.roomName);
  if (!roomName) return 0;

  var R = _pibRoom(roomName);
  if (!R.fills[target.id]) R.fills[target.id] = {};

  var dist = 0;
  try { dist = creep.pos.getRangeTo(target); } catch (e) { dist = 5; }
  var eta = Math.max(2, (dist | 0) + 1);

  R.fills[target.id][creep.name] = {
    res: resourceType,
    amount: amount | 0,
    untilTick: Game.time + eta
  };
  return amount | 0;
}

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
// Capacity accounting
// ============================
function _effectiveFree(struct, resourceType) {
  resourceType = resourceType || RESOURCE_ENERGY;

  var freeNow = (struct.store && struct.store.getFreeCapacity(resourceType)) || 0;
  var sameTickReserved = _reservedFor(struct.id) | 0;

  var roomName = (struct.pos && struct.pos.roomName) || (struct.room && struct.room.name);
  var pibReserved = roomName ? (_pibSumReserved(roomName, struct.id, resourceType) | 0) : 0;

  return Math.max(0, freeNow - sameTickReserved - pibReserved);
}

// NEW: free capacity for *this* creep (ignore my own PIB)
function _effectiveFreeFor(creep, struct, resourceType) {
  resourceType = resourceType || RESOURCE_ENERGY;

  var freeNow = (struct.store && struct.store.getFreeCapacity(resourceType)) || 0;
  var sameTickReserved = _reservedFor(struct.id) | 0;

  var roomName = (struct.pos && struct.pos.roomName) || (struct.room && struct.room.name);
  var pibOthers = roomName ? (_pibSumReservedExcept(roomName, struct.id, resourceType, creep.name) | 0) : 0;

  return Math.max(0, freeNow - sameTickReserved - pibOthers);
}

// Original API (kept for compatibility elsewhere)
function reserveFill(creep, target, amount, resourceType) {
  resourceType = resourceType || RESOURCE_ENERGY;

  var map = _qrMap();
  var free = _effectiveFree(target, resourceType);
  var want = Math.max(0, Math.min(amount, free));

  if (want > 0) {
    map[target.id] = (map[target.id] || 0) + want;
    creep.memory.qTargetId = target.id;
    _pibReserveFill(creep, target, want, resourceType);
  }
  return want;
}

// NEW: reserve capacity *for this creep* (ignores its own PIB when computing free)
// Also refreshes PIB every tick so sticky targets don't expire.
function reserveFillFor(creep, target, amount, resourceType) {
  resourceType = resourceType || RESOURCE_ENERGY;
  var map = _qrMap();

  var freeForMe = _effectiveFreeFor(creep, target, resourceType);
  var want = Math.max(0, Math.min(amount, freeForMe));

  // Even if want==0 (because others reserved), keep my existing PIB alive if I already have one.
  var mine = _pibMine(creep, target, resourceType);
  if (want === 0 && mine > 0) {
    // Refresh my reservation window using what I already had.
    _pibReserveFill(creep, target, mine, resourceType);
  } else if (want > 0) {
    map[target.id] = (map[target.id] || 0) + want;
    _pibReserveFill(creep, target, want, resourceType);
  }

  if (want > 0 || mine > 0) creep.memory.qTargetId = target.id;
  return (want > 0) ? want : mine;
}

function transferTo(creep, target, res) {
  res = res || RESOURCE_ENERGY;
  var rc = creep.transfer(target, res);

  if (rc === ERR_NOT_IN_RANGE) { go(creep, target); return rc; }

  if (rc === OK) {
    _pibReleaseFill(creep, target, res);
  } else if (rc === ERR_FULL) {
    _pibReleaseFill(creep, target, res);
    creep.memory.qTargetId = null;
  } else if (rc !== OK && rc !== ERR_TIRED && rc !== ERR_BUSY) {
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

  var extSpawnNeedy = room.find(FIND_STRUCTURES, {
    filter: function (s) {
      if (!s.store) return false;
      if (s.structureType !== STRUCTURE_EXTENSION && s.structureType !== STRUCTURE_SPAWN) return false;
      return (s.store.getFreeCapacity(RESOURCE_ENERGY) | 0) > 0;
    }
  });

  var towersNeedy = room.find(FIND_STRUCTURES, {
    filter: function (s) {
      if (s.structureType !== STRUCTURE_TOWER || !s.store) return false;
      var used = (s.store.getUsedCapacity(RESOURCE_ENERGY) | 0);
      var cap  = (s.store.getCapacity(RESOURCE_ENERGY) | 0);
      if (cap <= 0) return false;
      return (used / cap) <= CFG.TOWER_REFILL_PCT;
    }
  });

  var terminalNeed = (room.terminal && room.terminal.store &&
                      (room.terminal.store.getFreeCapacity(RESOURCE_ENERGY) | 0) > 0) ? room.terminal : null;

  var storageNeed  = (room.storage && room.storage.store &&
                      (room.storage.store.getFreeCapacity(RESOURCE_ENERGY) | 0) > 0) ? room.storage : null;

  var storageHasEnergy = (room.storage && (room.storage.store[RESOURCE_ENERGY] | 0) > 0) ? room.storage : null;

  var sideContainers = room.find(FIND_STRUCTURES, {
    filter: function (s) {
      return s.structureType === STRUCTURE_CONTAINER &&
             !isContainerNearSource(s) &&
             s.store && (s.store.getUsedCapacity(RESOURCE_ENERGY) | 0) > 0;
    }
  });

  R = {
    spawn: sp,
    linkNearSpawn: linkNearSpawn,
    extSpawnNeedy: extSpawnNeedy,
    towersNeedy: towersNeedy,
    terminalNeed: terminalNeed,
    storageNeed: storageNeed,
    storageHasEnergy: storageHasEnergy,
    sideContainers: sideContainers
  };
  G.byRoom[room.name] = R;
  return R;
}

// ============================
// Target selection helpers
// ============================
function pickNearestNeedy(creep, candidates) {
  var ok = [];
  for (var i = 0; i < candidates.length; i++) {
    var s = candidates[i];
    if (s && _effectiveFree(s, RESOURCE_ENERGY) > 0) ok.push(s);
  }
  return ok.length ? nearestByRange(creep.pos, ok) : null;
}

function chooseFillTarget(creep, cache) {
  var target =
    pickNearestNeedy(creep, cache.extSpawnNeedy) ||
    pickNearestNeedy(creep, cache.towersNeedy)   ||
    (cache.linkNearSpawn && _effectiveFree(cache.linkNearSpawn, RESOURCE_ENERGY) > 0 ? cache.linkNearSpawn : null) ||
    ((cache.terminalNeed && cache.terminalNeed.id !== creep.memory.qLastWithdrawId &&
      _effectiveFree(cache.terminalNeed, RESOURCE_ENERGY) > 0) ? cache.terminalNeed : null) ||
    ((cache.storageNeed  && cache.storageNeed.id  !== creep.memory.qLastWithdrawId &&
      _effectiveFree(cache.storageNeed,  RESOURCE_ENERGY) > 0) ? cache.storageNeed  : null);

  return target;
}

function chooseWithdrawTarget(creep, cache) {
  if (cache.storageHasEnergy) return cache.storageHasEnergy;

  if (cache.sideContainers.length) {
    var side = nearestByRange(creep.pos, cache.sideContainers);
    if (side) return side;
  }

  var drop = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
    filter: function (r) { return r.resourceType === RESOURCE_ENERGY; }
  });
  if (drop) return drop;

  return null; // fall through to harvest
}

// ============================
// Main
// ============================
var TaskQueen = {
  run: function (creep) {
    var room  = creep.room;
    var cache = _qCache(room);
    var carryAmt = creep.store.getUsedCapacity(RESOURCE_ENERGY) | 0;
    var carrying = carryAmt > 0;

    if (carrying) {
      // ---------- Sticky target logic (fixed) ----------
      if (creep.memory.qTargetId) {
        var sticky = Game.getObjectById(creep.memory.qTargetId);
        if (sticky) {
          // Raw physical free (ignores any PIB); plus check if I already have a reservation there
          var rawFree = (sticky.store && sticky.store.getFreeCapacity(RESOURCE_ENERGY)) || 0;
          var mineAmt = _pibMine(creep, sticky, RESOURCE_ENERGY);
          var freeForMe = _effectiveFreeFor(creep, sticky, RESOURCE_ENERGY);

          // If there's real space OR I have a live reservation, keep going and refresh my PIB
          if (rawFree > 0 || mineAmt > 0 || freeForMe > 0) {
            // Reserve for *me* (and refresh even if others make freeForMe==0)
            reserveFillFor(creep, sticky, carryAmt, RESOURCE_ENERGY);
            debugSay(creep, '→ STICK');
            debugDraw(creep, sticky, CFG.DRAW.STICK_COLOR, "STICK");
            transferTo(creep, sticky);
            return;
          } else {
            // Truly no space and no reservation left: drop the sticky
            creep.memory.qTargetId = null;
          }
        } else {
          creep.memory.qTargetId = null;
        }
      }

      // ---------- Pick a new fill target ----------
      var target = chooseFillTarget(creep, cache);
      if (target) {
        if (reserveFillFor(creep, target, carryAmt, RESOURCE_ENERGY) > 0) {
          var st = target.structureType;
          if (st === STRUCTURE_EXTENSION) { debugSay(creep, '→ EXT'); debugDraw(creep, target, CFG.DRAW.FILL_COLOR, "EXT"); }
          else if (st === STRUCTURE_SPAWN) { debugSay(creep, '→ SPN'); debugDraw(creep, target, CFG.DRAW.FILL_COLOR, "SPN"); }
          else if (st === STRUCTURE_TOWER) { debugSay(creep, '→ TWR'); debugDraw(creep, target, CFG.DRAW.FILL_COLOR, "TWR"); }
          else if (st === STRUCTURE_LINK)  { debugSay(creep, '→ LNK'); debugDraw(creep, target, CFG.DRAW.FILL_COLOR, "LNK"); }
          else if (st === STRUCTURE_TERMINAL) { debugSay(creep, '→ TERM'); debugDraw(creep, target, CFG.DRAW.FILL_COLOR, "TERM"); }
          else if (st === STRUCTURE_STORAGE)  { debugSay(creep, '→ STO'); debugDraw(creep, target, CFG.DRAW.FILL_COLOR, "STO"); }
          else { debugSay(creep, '→ FILL'); debugDraw(creep, target, CFG.DRAW.FILL_COLOR, "FILL"); }

          transferTo(creep, target);
          return;
        }
      }

      // ---------- Idle near anchor ----------
      var anchor = cache.spawn || room.controller || creep.pos;
      debugSay(creep, 'IDLE');
      debugDraw(creep, (anchor.pos || anchor), CFG.DRAW.IDLE_COLOR, "IDLE");
      go(creep, (anchor.pos || anchor), 2);
      return;
    }

    // ---------- Not carrying: acquire energy ----------
    var withdrawTarget = chooseWithdrawTarget(creep, cache);
    if (withdrawTarget) {
      if (withdrawTarget.resourceType === RESOURCE_ENERGY) {
        // Dropped resource
        debugSay(creep, '↘️Drop');
        debugDraw(creep, withdrawTarget, CFG.DRAW.DROP_COLOR, "DROP");
        if (creep.pickup(withdrawTarget) === ERR_NOT_IN_RANGE) go(creep, withdrawTarget);
      } else {
        // Structure (storage/container)
        if (withdrawTarget.structureType === STRUCTURE_STORAGE) { debugSay(creep, '↘️Sto'); }
        else if (withdrawTarget.structureType === STRUCTURE_CONTAINER) { debugSay(creep, '↘️Con'); }
        else { debugSay(creep, '↘️Wd'); }
        debugDraw(creep, withdrawTarget, CFG.DRAW.WD_COLOR, "WD");
        withdrawFrom(creep, withdrawTarget);
      }
      return;
    }

    // ---------- Last resort: harvest directly ----------
    harvestFromClosest(creep);
  }
};

module.exports = TaskQueen;
