// role.Repair.js — with Debug_say & Debug_draw
var BeeToolbox = require('BeeToolbox');
var MovementOwnership = require('Movement.Ownership');

// =============== Config ===============
var CFG = Object.freeze({
  DEBUG_SAY: false,
  DEBUG_DRAW: true,

  TRAVEL_REUSE: 16,
  IDLE_GRACE_TICKS: 60,
  SUICIDE_AFTER_IDLE_TICKS: 450,
  RECYCLE_RETRY_INTERVAL: 10,

  COLORS: {
    PATH:  "#7ac7ff",
    REPAIR:"#2ad1c9",
    ENERGY:"#ffd480",
    TEXT:  "#e6e6e6"
  },
  WIDTH: 0.12,
  OPAC:  0.45,
  FONT:  0.7
});

// Optional log levels (kept from original)
var LOG_LEVEL = { NONE: 0, BASIC: 1, DEBUG: 2 };
var currentLogLevel = LOG_LEVEL.NONE;

// =============== Tiny Debug Helpers ===============
function _posOf(t){ return t && t.pos ? t.pos : t; }
function _roomOf(p){ return p && Game.rooms[p.roomName]; }

function debugSay(creep, msg){
  if (CFG.DEBUG_SAY && creep && typeof creep.say === 'function') creep.say(msg, true);
}
function debugLine(from, to, color, label){
  if (!CFG.DEBUG_DRAW || !from || !to) return;
  var f=_posOf(from), t=_posOf(to); if(!f||!t||f.roomName!==t.roomName) return;
  var R=_roomOf(f); if(!R||!R.visual) return;
  R.visual.line(f, t, { color: color, width: CFG.WIDTH, opacity: CFG.OPAC });
  if (label){
    var mx=(f.x+t.x)/2, my=(f.y+t.y)/2;
    R.visual.text(label, mx, my-0.25,
      { color: color, opacity: 0.95, font: CFG.FONT, align:"center",
        backgroundColor:"#000", backgroundOpacity:0.25 });
  }
}
function debugRing(target, color, text){
  if (!CFG.DEBUG_DRAW || !target) return;
  var p=_posOf(target); if(!p) return;
  var R=_roomOf(p); if(!R||!R.visual) return;
  R.visual.circle(p, { radius: 0.6, fill:"transparent", stroke: color, opacity: CFG.OPAC, width: CFG.WIDTH });
  if (text) R.visual.text(text, p.x, p.y-0.8, { color: color, font: CFG.FONT, opacity: 0.95, align:"center" });
}
function hud(creep, text){
  if (!CFG.DEBUG_DRAW) return;
  var R=creep.room; if(!R||!R.visual) return;
  R.visual.text(text, creep.pos.x, creep.pos.y-1.2, {
    color: CFG.COLORS.TEXT, font: CFG.FONT, opacity: 0.95, align: "center",
    backgroundColor:"#000", backgroundOpacity:0.25
  });
}

// =============== Travel Wrapper ===============
function go(creep, dest, range){
  var R = (range != null) ? range : 1;
  var dpos = _posOf(dest) || dest;
  if (creep.pos.roomName === dpos.roomName && creep.pos.getRangeTo(dpos) > R){
    debugLine(creep.pos, dpos, CFG.COLORS.PATH, "→");
  }
  if (creep.pos.getRangeTo(dpos) <= R) return OK;
  try {
    if (BeeToolbox && typeof BeeToolbox.BeeTravel === 'function'){
      return BeeToolbox.BeeTravel(creep, dpos, { range: R, reusePath: CFG.TRAVEL_REUSE });
    }
  } catch(e){}
  if (typeof creep.travelTo === 'function'){
    return creep.travelTo(dpos, { range: R, reusePath: CFG.TRAVEL_REUSE, ignoreCreeps: false, maxOps: 4000 });
  }
  return MovementOwnership.moveTo(creep, dpos, { reusePath: CFG.TRAVEL_REUSE, maxOps: 1500 }, "role.Repair/goFallback", "Repair");
}

// =============== Safe Memory Accessors ===============
function getRepairQueue(room){
  Memory.rooms = Memory.rooms || {};
  Memory.rooms[room.name] = Memory.rooms[room.name] || {};
  var rm = Memory.rooms[room.name];
  rm.repairTargets = Array.isArray(rm.repairTargets) ? rm.repairTargets : [];
  return rm.repairTargets;
}

function getRepairQueueByRoomName(roomName){
  if (!roomName) return [];
  Memory.rooms = Memory.rooms || {};
  Memory.rooms[roomName] = Memory.rooms[roomName] || {};
  var rm = Memory.rooms[roomName];
  rm.repairTargets = Array.isArray(rm.repairTargets) ? rm.repairTargets : [];
  return rm.repairTargets;
}

// Pulls the next valid repair target while cleaning stale entries from the queue.
function getNextRepairTarget(queue){
  while (queue.length){
    var head = queue[0];
    if (!head || !head.id){
      queue.shift();
      continue;
    }

    var obj = Game.getObjectById(head.id);
    if (!obj || !obj.hits || obj.hits >= obj.hitsMax){
      queue.shift();
      continue;
    }

    return obj;
  }

  return null;
}

function getHomeName(creep){
  if (!creep || !creep.memory) return null;
  if (creep.memory.home) return creep.memory.home;
  if (creep.memory._home) return creep.memory._home;
  if (creep.room && creep.room.name) return creep.room.name;
  return null;
}

function getHomeLinkedRemoteRooms(homeName){
  if (!homeName) return [];
  var cache = global.__BHM && global.__BHM.remotesByHome;
  if (!cache || !Array.isArray(cache[homeName])) return [];
  return cache[homeName];
}

function isRoomLikelyHostile(roomName){
  if (!roomName || !Memory.rooms || !Memory.rooms[roomName]) return false;
  var rm = Memory.rooms[roomName];
  if (rm.hostile) return true;
  if (rm._invaderLock && rm._invaderLock.locked) return true;
  return false;
}

function buildRepairRoomCandidates(creep){
  var out = [];
  var seen = {};
  function add(roomName, mode, reason){
    if (!roomName || seen[roomName]) return;
    seen[roomName] = true;
    out.push({ roomName: roomName, mode: mode, reason: reason });
  }

  var current = creep && creep.room ? creep.room.name : null;
  var home = getHomeName(creep);
  add(current, 'local', 'CURRENT_ROOM_FIRST');
  add(home, 'home', 'HOME_ROOM_SECOND');

  var remotes = getHomeLinkedRemoteRooms(home);
  for (var i = 0; i < remotes.length; i++) {
    var rn = remotes[i];
    if (!rn) continue;
    if (isRoomLikelyHostile(rn)) continue;
    add(rn, 'remote', 'HOME_LINKED_REMOTE');
  }
  return out;
}

function selectRoomHeadTarget(roomName){
  var queue = getRepairQueueByRoomName(roomName);
  if (!queue.length) return null;

  // If the room is visible, fully validate and clean stale heads.
  if (Game.rooms[roomName]) {
    var target = getNextRepairTarget(queue);
    if (!target) return null;
    return {
      roomName: roomName,
      queue: queue,
      target: target,
      visible: true,
      targetId: target.id,
      targetType: target.structureType || null
    };
  }

  // No visibility: keep room selection bounded to the curated queue pipeline.
  while (queue.length) {
    var head = queue[0];
    if (!head || !head.id) { queue.shift(); continue; }
    return {
      roomName: roomName,
      queue: queue,
      target: null,
      visible: false,
      targetId: head.id,
      targetType: head.type || null
    };
  }
  return null;
}

function clearRepairTargetMemory(creep){
  if (!creep || !creep.memory) return;
  delete creep.memory.repairTargetId;
  delete creep.memory.repairTargetRoom;
  delete creep.memory.repairTargetType;
  delete creep.memory.repairScope;
  delete creep.memory.repairSelectionReason;
  delete creep.memory.repairFallbackReason;
}

function clearRetirementState(creep){
  if (!creep || !creep.memory) return;
  delete creep.memory.repairIdleSince;
  delete creep.memory.repairRetirePending;
  delete creep.memory.repairRetireReason;
  delete creep.memory.repairRetireCanceledReason;
  delete creep.memory.repairRecycleSpawnId;
  delete creep.memory.repairLastRecycleAttempt;
  delete creep.memory.repairRetireFallbackReason;
}

function markRetirementCanceled(creep, reason){
  if (!creep || !creep.memory) return;
  if (creep.memory.repairRetirePending) {
    creep.memory.repairRetireCanceledReason = reason || 'WORK_REAPPEARED';
  }
  clearRetirementState(creep);
}

function nearestHomeSpawn(creep, homeName){
  if (!homeName || !Game.rooms || !Game.rooms[homeName]) return null;
  var room = Game.rooms[homeName];
  if (!room || typeof room.find !== 'function') return null;
  var spawns = room.find(FIND_MY_SPAWNS) || [];
  if (!spawns.length) return null;
  var best = null;
  var bestRange = 9999;
  for (var i = 0; i < spawns.length; i++) {
    var s = spawns[i];
    var r = creep.pos.getRangeTo(s);
    if (!best || r < bestRange) {
      best = s;
      bestRange = r;
    }
  }
  return best;
}

function handleRetirementFlow(creep, reason){
  if (!creep || !creep.memory) return true;
  var mem = creep.memory;
  if (mem.repairIdleSince == null) {
    mem.repairIdleSince = Game.time;
    mem.repairRetireReason = reason || 'NO_MEANINGFUL_REPAIR_WORK';
  }
  mem.repairRetirePending = true;
  var idleFor = Game.time - mem.repairIdleSince;

  // Grace window: keep the creep parked/available in case backlog quickly returns.
  if (idleFor < CFG.IDLE_GRACE_TICKS) {
    var anchor = creep.room.storage || creep.pos.findClosestByRange(FIND_MY_SPAWNS) || creep.pos;
    debugSay(creep, '🕒');
    hud(creep, "🔧 idle " + idleFor + "/" + CFG.IDLE_GRACE_TICKS);
    if (anchor && anchor.pos && !creep.pos.inRangeTo(anchor, 3)) {
      go(creep, anchor, 3);
    }
    return true;
  }

  // Recycle-first retirement: return home and ask a spawn to recycle us.
  var home = getHomeName(creep);
  if (home && creep.room.name !== home) {
    var homeCenter = new RoomPosition(25, 25, home);
    mem.repairRetireFallbackReason = 'RETURN_HOME_FOR_RECYCLE';
    hud(creep, "🔧 retire→" + home);
    go(creep, homeCenter, 20);
    return true;
  }

  var spawn = nearestHomeSpawn(creep, home || creep.room.name);
  if (spawn) {
    mem.repairRecycleSpawnId = spawn.id;
    var lastTry = mem.repairLastRecycleAttempt || 0;
    if ((Game.time - lastTry) >= CFG.RECYCLE_RETRY_INTERVAL || creep.pos.isNearTo(spawn)) {
      mem.repairLastRecycleAttempt = Game.time;
      var rc = spawn.recycleCreep(creep);
      if (rc === ERR_NOT_IN_RANGE) {
        mem.repairRetireFallbackReason = 'RECYCLE_MOVE_IN_RANGE';
        go(creep, spawn, 1);
        return true;
      }
      if (rc === OK) {
        mem.repairRetireFallbackReason = 'RECYCLE_OK';
        return true;
      }
      mem.repairRetireFallbackReason = 'RECYCLE_ERR_' + rc;
    }
  } else {
    mem.repairRetireFallbackReason = 'NO_HOME_SPAWN_FOR_RECYCLE';
  }

  // Last-resort fallback only after a long sustained idle period.
  if (idleFor >= CFG.SUICIDE_AFTER_IDLE_TICKS) {
    mem.repairRetireFallbackReason = 'SUICIDE_AFTER_IDLE_TIMEOUT';
    creep.suicide();
    return true;
  }

  var park = creep.room.storage || creep.pos.findClosestByRange(FIND_MY_SPAWNS) || creep.pos;
  debugSay(creep, '♻️');
  hud(creep, "🔧 retire " + idleFor);
  if (park && park.pos && !creep.pos.inRangeTo(park, 3)) {
    go(creep, park, 3);
  }
  return true;
}

function chooseRepairAssignment(creep){
  if (!creep || !creep.memory) return null;

  var lockedRoom = creep.memory.repairTargetRoom;
  var lockUntil = creep.memory.repairLockUntil || 0;
  if (lockedRoom && Game.time <= lockUntil) {
    var lockedPick = selectRoomHeadTarget(lockedRoom);
    if (lockedPick) {
      lockedPick.reason = 'LOCKED_ROOM_STICKY';
      lockedPick.mode = (lockedRoom === creep.room.name) ? 'local' : (lockedRoom === getHomeName(creep) ? 'home' : 'remote');
      return lockedPick;
    }
  }

  var candidates = buildRepairRoomCandidates(creep);
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    var pick = selectRoomHeadTarget(c.roomName);
    if (!pick) continue;
    pick.mode = c.mode;
    pick.reason = c.reason;
    return pick;
  }

  return null;
}
// =============== Energy Sourcing ===============
function findDroppedEnergy(creep){
  return creep.pos.findClosestByPath(FIND_DROPPED_RESOURCES, {
    filter: function(r){ return r.resourceType === RESOURCE_ENERGY && (r.amount || 0) > 0; }
  });
}
function findWithdrawSource(creep){
  return creep.pos.findClosestByPath(FIND_STRUCTURES, {
    filter: function(s){
      if (!s.store) return false;
      var t = s.structureType;
      if (t !== STRUCTURE_CONTAINER && t !== STRUCTURE_EXTENSION && t !== STRUCTURE_SPAWN) return false;
      return (s.store[RESOURCE_ENERGY] || 0) > 0;
    }
  });
}

// =============== Main Role ===============
module.exports = {
  role: 'Repair',

  run: function(creep){
    if (!creep) return;

    if (creep.memory && !creep.memory.role) {
      creep.memory.role = 'Repair';
    }

    // Status HUD shows current energy to help see why a creep might idle.
    var e = creep.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    hud(creep, "🔧 " + e + "/" + creep.store.getCapacity(RESOURCE_ENERGY));

    // Always check for meaningful work first (bounded to curated queues in
    // current/home/home-linked remote rooms). This allows clean retirement
    // handling even when the creep is empty on energy.
    var assignment = chooseRepairAssignment(creep);
    if (!assignment) {
      if (creep.memory) creep.memory.task = undefined;
      clearRepairTargetMemory(creep);
      creep.memory.repairFallbackReason = 'NO_ELIGIBLE_REPAIR_QUEUE';
      handleRetirementFlow(creep, 'NO_MEANINGFUL_REPAIR_WORK');
      return;
    }
    markRetirementCanceled(creep, 'WORK_REAPPEARED');

    // No energy? Grab some before looking for work so the rest of the logic can
    // assume a ready-to-build creep.
    if (e <= 0) {
      var pile = findDroppedEnergy(creep);
      if (pile){
        debugRing(pile, CFG.COLORS.ENERGY, "💧"+(pile.amount || 0));
        debugLine(creep, pile, CFG.COLORS.ENERGY, "pickup");
        var pr = creep.pickup(pile);
        if (pr === ERR_NOT_IN_RANGE) go(creep, pile, 1);
        else if (pr === OK) debugSay(creep, "💼");
        return;
      }

      var source = findWithdrawSource(creep);
      if (source){
        debugRing(source, CFG.COLORS.ENERGY, "ENERGY");
        debugLine(creep, source, CFG.COLORS.ENERGY, "withdraw");
        var wr = creep.withdraw(source, RESOURCE_ENERGY);
        if (wr === ERR_NOT_IN_RANGE) go(creep, source, 1);
        else if (wr === OK) debugSay(creep, "⛽");
        return;
      }

      if (currentLogLevel >= LOG_LEVEL.DEBUG){
        console.log("No available energy source for "+creep.name);
      }
      debugSay(creep, "‍💨");
      return;
    }

    creep.memory.repairTargetRoom = assignment.roomName;
    creep.memory.repairTargetId = assignment.targetId;
    creep.memory.repairTargetType = assignment.targetType || null;
    creep.memory.repairScope = assignment.mode || 'local';
    creep.memory.repairSelectionReason = assignment.reason || 'UNKNOWN';
    creep.memory.repairFallbackReason = null;
    creep.memory.repairLockUntil = Game.time + 15;

    // If we selected remote/home room work without visibility, travel there and
    // re-resolve from that room's queue once vision is available.
    if (!assignment.visible || !assignment.target) {
      var dest = new RoomPosition(25, 25, assignment.roomName);
      hud(creep, "🔧 " + e + "/" + creep.store.getCapacity(RESOURCE_ENERGY) + " " + creep.memory.repairScope + "→" + assignment.roomName);
      debugLine(creep, dest, CFG.COLORS.REPAIR, "remote");
      go(creep, dest, 20);
      return;
    }

    var queue = assignment.queue;
    var target = assignment.target;

    // Visuals for the target
    creep.room.visual.text(
      "Repair " + target.structureType + " " + target.hits + "/" + target.hitsMax,
      target.pos.x, target.pos.y - 1,
      { align: 'center', color: '#ffffff', opacity: 0.9 }
    );
    hud(creep, "🔧 " + e + "/" + creep.store.getCapacity(RESOURCE_ENERGY) + " " + creep.memory.repairScope + ":" + (creep.memory.repairTargetRoom || creep.room.name));
    debugRing(target, CFG.COLORS.REPAIR, "fix");

    // Attempt repair
    var rr = creep.repair(target);
    if (rr === OK){
      if (currentLogLevel >= LOG_LEVEL.DEBUG){
        console.log("Creep "+creep.name+" repairing "+target.structureType+" @("+target.pos.x+","+target.pos.y+")");
      }
      debugSay(creep, "🔧");
      // Done? pop and move on
      if (target.hits >= target.hitsMax){
        queue.shift();
        debugSay(creep, "✔");
      }
      return;
    }
    if (rr === ERR_NOT_IN_RANGE){
      debugLine(creep, target, CFG.COLORS.REPAIR, "to repair");
      go(creep, target, 3);
      return;
    }

    // Other errors → log & skip this target
    if (currentLogLevel >= LOG_LEVEL.DEBUG){
      console.log("Repair error for "+creep.name+": "+rr);
    }
    queue.shift();
  }
};
