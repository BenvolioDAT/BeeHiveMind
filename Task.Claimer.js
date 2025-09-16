// Task.Claimer.js
// Handles: claim | reserve | attack controllers.
// creep.memory:
//   claimerMode: 'claim' | 'reserve' | 'attack' (default: 'reserve')
//   targetRoom: 'E12S34' (preferred) or use flags named 'Claim'/'Reserve'/'Attack'

const BeeToolbox = require('BeeToolbox');

const CONFIG = {
  defaultMode: 'reserve',
  placeSpawnOnClaim: false,
  signText: '🐝 Sushi Moto Logistics — roads, loads, and righteous nodes.',
  reusePath: 15
};
// ---- Multi-room Reserve Helpers ----
var RESERVE_CONFIG = {
  desired: 4500,      // aim to keep rooms near this; max is 5000
  rotateAt: 4000,     // once >= this, head to next target
  scanRoleNames: ['remoteharvest', 'remoteMiner','remoteHarvest'], // tweak to your codebase
  maxTargets: 12      // safety cap
};

// ---- Room Locking (prevents 2 claimers from dogpiling one room) ----
var LOCK = {
  ttl: 150  // how long a lock lasts after acquisition; tweak to your travel time
};

function ensureLockMem() {
  if (!Memory.reserveLocks) Memory.reserveLocks = {};
}

function isRoomLocked(rn) {
  ensureLockMem();
  var L = Memory.reserveLocks[rn];
  if (!L) return false;
  if (L.until <= Game.time) { delete Memory.reserveLocks[rn]; return false; }
  // if the creep that held it is gone, free it
  if (L.creep && !Game.creeps[L.creep]) { delete Memory.reserveLocks[rn]; return false; }
  return true;
}

function acquireRoomLock(rn, creep) {
  ensureLockMem();
  // pre-clean
  isRoomLocked(rn);
  if (Memory.reserveLocks[rn]) return false;
  Memory.reserveLocks[rn] = { creep: creep.name, until: Game.time + LOCK.ttl };
  return true;
}

function refreshRoomLock(rn, creep) {
  ensureLockMem();
  var L = Memory.reserveLocks[rn];
  if (!L) return false;
  if (L.creep !== creep.name) return false;
  L.until = Game.time + LOCK.ttl; // keep alive while we’re working/traveling
  return true;
}

function releaseRoomLock(rn, creep) {
  ensureLockMem();
  var L = Memory.reserveLocks[rn];
  if (!L) return;
  if (L.creep === creep.name) delete Memory.reserveLocks[rn];
}

function gatherReserveTargets() {
  var set = {};
  // 1) Flags: "Reserve" or "Reserve:*"
  for (var fname in Game.flags) {
    if (fname === 'Reserve' || fname.indexOf('Reserve:') === 0) {
      var f = Game.flags[fname];
      if (f && f.pos && f.pos.roomName) set[f.pos.roomName] = true;
    }
  }
  // 2) Remote-miner creeps advertise rooms
  for (var cname in Game.creeps) {
    var c = Game.creeps[cname];
    if (!c.memory || !c.memory.role) continue;
    if (RESERVE_CONFIG.scanRoleNames.indexOf(c.memory.role) !== -1) {
      // common patterns you might have in memory; add more if needed
      var rn = c.memory.remoteRoom || c.memory.targetRoom || c.memory.targetRoomName;
      if (rn) set[rn] = true;
    }
  }
  // to array
  var out = [];
  for (var rn in set) out.push(rn);
  // limit so one claimer doesn't try to world-tour
  if (out.length > RESERVE_CONFIG.maxTargets) out.length = RESERVE_CONFIG.maxTargets;
  return out;
}

// Cache reservation intel we see, so we can pick "lowest first"
function rememberReservationIntel(room) {
  if (!room || !room.controller) return;
  if (!Memory.reserveIntel) Memory.reserveIntel = {};
  var ctl = room.controller;
  var key = room.name;
  var ticks = 0;
  var owner = null;
  if (ctl.reservation) {
    ticks = ctl.reservation.ticksToEnd || 0;
    owner = ctl.reservation.username || null;
  } else if (ctl.my) {
    // owned rooms don't need reserve; mark very high to de-prioritize
    ticks = 99999;
    owner = 'me';
  }
  Memory.reserveIntel[key] = { ticks: ticks, owner: owner, t: Game.time };
}

// Pick next room: prefer lowest ticks or unknown intel
function pickNextReserveTarget(creep, candidates) {
  if (!candidates || !candidates.length) return null;

  // First pass: unknown intel & unlocked
  for (var i = 0; i < candidates.length; i++) {
    var rn = candidates[i];
    if (!Memory.reserveIntel || !Memory.reserveIntel[rn]) {
      if (!isRoomLocked(rn)) return rn;
    }
  }

  // Second pass: lowest ticks, unlocked
  var best = null, bestTicks = 999999;
  for (var j = 0; j < candidates.length; j++) {
    var rn2 = candidates[j];
    if (isRoomLocked(rn2)) continue;
    var intel = Memory.reserveIntel && Memory.reserveIntel[rn2];
    if (!intel) { best = rn2; break; } // still unknown but survived first pass
    if (intel.owner && intel.owner !== creep.owner.username && intel.owner !== 'me') continue;
    if (intel.ticks < bestTicks) { bestTicks = intel.ticks; best = rn2; }
  }
  // If all are locked, just pick the global lowest (someone will finish soon)
  if (!best) {
    for (var k = 0; k < candidates.length; k++) {
      var rn3 = candidates[k];
      var intel2 = Memory.reserveIntel && Memory.reserveIntel[rn3];
      var ticks2 = intel2 ? intel2.ticks : 0;
      if (ticks2 < bestTicks) { bestTicks = ticks2; best = rn3; }
    }
  }
  return best || candidates[0];
}


function resolveTargetRoom(creep) {
  // 1) Explicit memory wins, but we still allow a flag to override if present.
  var mode = (creep.memory.claimerMode || CONFIG.defaultMode).toLowerCase();

  // 2) Find a matching flag by exact name OR prefix:
  //    - Exact:  "Reserve" / "Claim" / "Attack"
  //    - Prefix: "Reserve:*", "Reserve-...", etc.
  var exactName = mode === 'claim' ? 'Claim' : (mode === 'attack' ? 'Attack' : 'Reserve');

  var chosenFlag = Game.flags[exactName];
  if (!chosenFlag) {
    // scan for prefix match (cheap scan over flags)
    for (var fname in Game.flags) {
      if (fname.indexOf(exactName) === 0) { // starts with
        chosenFlag = Game.flags[fname];
        break;
      }
    }
  }

  // 3) If we found a flag, refresh memory.targetRoom from it every tick.
  if (chosenFlag) {
    creep.memory.targetRoom = chosenFlag.pos.roomName;
    return creep.memory.targetRoom;
  }

  // 4) If memory has a targetRoom already, keep using it.
  if (creep.memory.targetRoom) return creep.memory.targetRoom;

  // 5) No flag and no memory? -> No target. DO NOT fall back to current room.
  return null;
}

function moveToRoom(creep, roomName) {
  if (creep.pos.roomName !== roomName) {
    var dest = new RoomPosition(25, 25, roomName);
    if (BeeToolbox && BeeToolbox.BeeTravel) {
      BeeToolbox.BeeTravel(creep, dest);
    } else {
      creep.moveTo(dest, { reusePath: CONFIG.reusePath, range: 20 });
    }
    return false;
  }
  return true;
}

function signIfWanted(creep, controller) {
  if (!controller) return;
  if (controller.my) return;
  if (CONFIG.signText && (!controller.sign || controller.sign.text !== CONFIG.signText)) {
    if (creep.signController(controller, CONFIG.signText) === ERR_NOT_IN_RANGE) {
      BeeToolbox.BeeTravel(creep, controller);
    }
  }
}

function placeSpawnIfWanted(creep, controller) {
  if (!CONFIG.placeSpawnOnClaim || !controller || !controller.my) return;

  var anySpawn = creep.room.find(FIND_MY_SPAWNS)[0];
  if (!anySpawn) {
    var offsets = [
      [3,0],[3,1],[2,2],[1,3],[0,3],[-1,3],[-2,2],[-3,1],[-3,0],
      [-3,-1],[-2,-2],[-1,-3],[0,-3],[1,-3],[2,-2],[3,-1]
    ];
    for (var i=0;i<offsets.length;i++) {
      var dx = offsets[i][0], dy = offsets[i][1];
      var x = Math.max(1, Math.min(48, controller.pos.x + dx));
      var y = Math.max(1, Math.min(48, controller.pos.y + dy));
      if (creep.room.createConstructionSite(x, y, STRUCTURE_SPAWN) === OK) {
        creep.say('🚧 spawn');
        break;
      }
    }
  }
}

function doClaim(creep, controller) {
  if (!controller) { creep.say('❓no ctl'); return; }
  if (controller.my) {
    signIfWanted(creep, controller);
    placeSpawnIfWanted(creep, controller);
    creep.say('✅ claimed');
    return;
  }
  if (controller.owner && !controller.my) {
    var r = creep.attackController(controller);
    if (r === ERR_NOT_IN_RANGE) return BeeToolbox.BeeTravel(creep, controller);
    creep.say('⚔ atkCtl');
    return;
  }
  var res = creep.claimController(controller);
  if (res === ERR_NOT_IN_RANGE) {
    BeeToolbox.BeeTravel(creep, controller);
  } else if (res === OK) {
    creep.say('👑 mine');
    signIfWanted(creep, controller);
    placeSpawnIfWanted(creep, controller);
  } else if (res === ERR_GCL_NOT_ENOUGH) {
    creep.say('➡ reserve');
    doReserve(creep, controller);
  } else {
    creep.say('❌' + res);
  }
}

function doReserve(creep, controller) {
  if (!controller) { creep.say('❓no ctl'); return; }
  if (controller.reservation && controller.reservation.username !== creep.owner.username) {
    var r = creep.attackController(controller);
    if (r === ERR_NOT_IN_RANGE) return BeeToolbox.BeeTravel(creep, controller);
    creep.say('🪓 deres');
    return;
  }
  var res = creep.reserveController(controller);
  if (res === ERR_NOT_IN_RANGE) {
    BeeToolbox.BeeTravel(creep, controller);
  } else if (res === OK) {
    creep.say('📌 +res');
  } else {
    creep.say('❌' + res);
  }
  signIfWanted(creep, controller);
}

function doAttack(creep, controller) {
  if (!controller) { creep.say('❓no ctl'); return; }
  var r = creep.attackController(controller);
  if (r === ERR_NOT_IN_RANGE) {
    BeeToolbox.BeeTravel(creep, controller);
  } else if (r === OK) {
    creep.say('🪓 atkCtl');
  } else {
    creep.say('❌' + r);
  }
}

const TaskClaimer = {
  run: function(creep) {
    // keep intel fresh
    rememberReservationIntel(creep.room);

    // assemble a plan
    var plan = gatherReserveTargets();

    // normalize roles list (catch both spellings)
    if (RESERVE_CONFIG.scanRoleNames.indexOf('remoteHarvester') === -1)
      RESERVE_CONFIG.scanRoleNames.push('remoteHarvester');

    // drop target if no longer in plan
    if (creep.memory.targetRoom && plan.indexOf(creep.memory.targetRoom) === -1) {
      releaseRoomLock(creep.memory.targetRoom, creep);   // <<< release old lock
      creep.memory.targetRoom = null;
    }

    // choose a target (reserve mode auto-rotates)
    if (!creep.memory.targetRoom) {
      var modeTmp = (creep.memory.claimerMode || CONFIG.defaultMode).toLowerCase();
      if (modeTmp === 'reserve') {
        var pick = pickNextReserveTarget(creep, plan);
        if (pick && acquireRoomLock(pick, creep)) {      // <<< acquire lock
          creep.memory.targetRoom = pick;
        } else {
          // failed to lock (another claimer won the race); try another
          for (var i = 0; i < plan.length && !creep.memory.targetRoom; i++) {
            var alt = plan[i];
            if (alt !== pick && acquireRoomLock(alt, creep)) creep.memory.targetRoom = alt;
          }
          if (!creep.memory.targetRoom) { creep.say('🔒 all'); return; }
        }
      } else {
        creep.memory.targetRoom = resolveTargetRoom(creep);
      }
    } else {
      // keep our lock alive while traveling/working
      refreshRoomLock(creep.memory.targetRoom, creep);    // <<< refresh lock
    }

    var targetRoom = creep.memory.targetRoom;
    if (!targetRoom) { creep.say('❌ no target'); return; }

    // travel
    if (!moveToRoom(creep, targetRoom)) { refreshRoomLock(targetRoom, creep); return; }

    var ctl = creep.room.controller;
    if (!ctl) { releaseRoomLock(targetRoom, creep); creep.say('🚫no ctl'); return; }

    var mode = (creep.memory.claimerMode || CONFIG.defaultMode).toLowerCase();
    if (mode === 'claim') return doClaim(creep, ctl);
    if (mode === 'attack') return doAttack(creep, ctl);

    // reserve mode
    doReserve(creep, ctl);
    rememberReservationIntel(creep.room);
    refreshRoomLock(targetRoom, creep);

    // rotate away when topped or owned
    if (ctl.reservation && ctl.reservation.username === creep.owner.username) {
      var ticks = ctl.reservation.ticksToEnd || 0;
      if (ticks >= RESERVE_CONFIG.rotateAt) {
        releaseRoomLock(targetRoom, creep);               // <<< release on rotate
        creep.say('➡ next');
        creep.memory.targetRoom = null;
      }
    } else if (ctl.my) {
      releaseRoomLock(targetRoom, creep);
      creep.say('🏠 mine');
      creep.memory.targetRoom = null;
    }
  }
};

module.exports = TaskClaimer;
