// Task.Claimer.js
// Handles: claim | reserve | attack controllers.
// creep.memory:
//   claimerMode: 'claim' | 'reserve' | 'attack' (default: 'reserve')
//   targetRoom: 'E12S34' (preferred) or use flags named 'Claim'/'Reserve'/'Attack'

'use strict';

var BeeToolbox = require('BeeToolbox');

var CONFIG = {
  defaultMode: 'reserve',
  placeSpawnOnClaim: false,
  reusePath: 15
};

// ---- Randomized signing pool ----
var SIGN_TEXTS = [
  "🐝 Sushi Moto Logistics — roads, loads, righteous nodes.",
  "🐝 BenvolioDAT — energy up front, potholes out back.",
  "🏗️ Warning: CPU spikes ahead!",
  "👑 Reserve now, pay later.",
  "⚡ Free energy, limited lag!",
  "🐝 Buzz buzz, this room is ours.",
  "🎯 Perfect balance: one tick ahead, two ops behind.",
  "📡 If you can read this, my creep didn’t die on the way.",
  "💾 Out of memory, please insert more RAM.",
  "🐝 Built with honey, guarded with stings.",
  "🚧 Road work ahead… yeah, I sure hope it does.",
  "🪙 Free CPU, limited time offer! (not really).",
  "🔥 Invaders beware: our towers don’t miss.",
  "⚙️ Automate or evaporate.",
  "🐝 Bee-lieve in the swarm.",
  "🍯 Sweet as honey, sharp as fangs.",
  "🎵 Tick-tock goes the shard clock.",
  "🛰️ Signed live from shard3.",
  "📦 Logistics > tactics.",
  "🐝 All roads lead to spawn.",
  "⚔️ Pay your reservation fees here.",
  "📑 Error 404: Free source not found.",
  "🕹️ Player 2 has entered the game.",
  "🐝 One tick closer to world domination.",
  "💡 Power is temporary, memory is forever.",
  "🚀 Upgrade complete, new bugs unlocked.",
  "🐝 Buzzness is booming.",
  "🔋 Energy is love, energy is life.",
  "🪓 Trees feared us first, then walls followed.",
  "🐝 Pollination nation!",
  "🧭 Path not found. Try Traveler.js.",
  "🎃 Scary sign goes here 👻",
  "🐝 Keep calm and harvest on.",
  "🥷 Silent creep, deadly withdraw.",
  "📉 CPU at 90%… oh no oh no oh no.",
  "💤 AFK but still reserving.",
  "🐝 Nectar collectors at work.",
  "🏰 Your controller, our castle.",
  "📍 You are here: owned.",
  "🐝 Sting operation successful.",
  "🧪 Science creeps were here.",
  "📡 We came, we saw, we cached.",
  "🐝 Energy now, lag later.",
  "🎯 Aim for the sources, miss the roads.",
  "⚡ Reserved by Bee Logistics LLC.",
  "🐝 The swarm approves this message.",
  "⏳ Tick by tick, room by room.",
  "🛠️ Signed under protest of pathfinding costs.",
  "🐝 Buzzfeed Top 10 Rooms (this one’s #1).",
  "💣 Boom. Controller tagged."
];


// how many ticks to treat as "1 day" before refreshing sign
var SIGN_DAY_TICKS = 1500;

// ---- Multi-room Reserve Helpers ----
var RESERVE_CONFIG = {
  desired: 2500,      // aim to keep rooms near this; max is 5000
  rotateAt: 1000,     // once >= this, head to next target
  scanRoleNames: ['luna', 'remoteMiner','remoteHarvest'], // tweak to your codebase
  maxTargets: 8       // safety cap
};

// ---- Room Locking (prevents 2 claimers from dogpiling one room) ----
var LOCK = { ttl: 10 };

function ensureLockMem() {
  if (!Memory.reserveLocks) Memory.reserveLocks = {};
}
function isRoomLocked(rn) {
  ensureLockMem();
  var L = Memory.reserveLocks[rn];
  if (!L) return false;
  if (L.until <= Game.time) { delete Memory.reserveLocks[rn]; return false; }
  if (L.creep && !Game.creeps[L.creep]) { delete Memory.reserveLocks[rn]; return false; }
  return true;
}
function acquireRoomLock(rn, creep) {
  ensureLockMem();
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
  L.until = Game.time + LOCK.ttl;
  return true;
}
function releaseRoomLock(rn, creep) {
  ensureLockMem();
  var L = Memory.reserveLocks[rn];
  if (!L) return;
  if (L.creep === creep.name) delete Memory.reserveLocks[rn];
}

// Cache reserve target list per tick so every claimer reuses the same scan work.
if (!global.__CLAIMER_CACHE) {
  global.__CLAIMER_CACHE = { tick: -1, reserveTargets: [] };
}

function gatherReserveTargets() {
  var cache = global.__CLAIMER_CACHE;
  if (cache.tick === Game.time) {
    // Return a shallow copy so callers cannot mutate the shared cache.
    return cache.reserveTargets.slice();
  }

  var set = {};
  for (var fname in Game.flags) {
    if (fname === 'Reserve' || fname.indexOf('Reserve:') === 0) {
      var f = Game.flags[fname];
      if (f && f.pos && f.pos.roomName) set[f.pos.roomName] = true;
    }
  }
  for (var cname in Game.creeps) {
    var c = Game.creeps[cname];
    var mem = c && c.memory;
    if (!mem) continue;

    // FIX: Remote reservers spawned by Luna tag their specialty in task/remoteRole, so check all fields instead of just role.
    var isReserveSpecialist = false;
    if (mem.role && RESERVE_CONFIG.scanRoleNames.indexOf(mem.role) !== -1) {
      isReserveSpecialist = true;
    }
    if (!isReserveSpecialist && mem.task && RESERVE_CONFIG.scanRoleNames.indexOf(mem.task) !== -1) {
      isReserveSpecialist = true;
    }
    if (!isReserveSpecialist && mem.remoteRole) {
      var remoteRole = String(mem.remoteRole).toLowerCase();
      for (var idx = 0; idx < RESERVE_CONFIG.scanRoleNames.length; idx++) {
        var entry = String(RESERVE_CONFIG.scanRoleNames[idx]).toLowerCase();
        if (entry === remoteRole) { isReserveSpecialist = true; break; }
      }
    }
    if (!isReserveSpecialist) continue;

    var rn = mem.remoteRoom || mem.targetRoom || mem.targetRoomName || mem.remote;
    if (rn) set[rn] = true;
  }
  var out = [];
  for (var rn in set) out.push(rn);
  if (out.length > RESERVE_CONFIG.maxTargets) out.length = RESERVE_CONFIG.maxTargets;
  cache.tick = Game.time;
  cache.reserveTargets = out.slice();
  return cache.reserveTargets.slice();
}

// Cache reservation intel we see
function rememberReservationIntel(room) {
  if (!room || !room.controller) return;
  if (!Memory.reserveIntel) Memory.reserveIntel = {};
  var ctl = room.controller;
  var ticks = 0;
  var owner = null;
  if (ctl.reservation) {
    ticks = ctl.reservation.ticksToEnd || 0;
    owner = ctl.reservation.username || null;
  } else if (ctl.my) {
    ticks = 99999;
    owner = 'me';
  }
  Memory.reserveIntel[room.name] = { ticks: ticks, owner: owner, t: Game.time };
}

function pickNextReserveTarget(creep, candidates) {
  if (!candidates || !candidates.length) return null;

  for (var i = 0; i < candidates.length; i++) {
    var rn = candidates[i];
    if (!Memory.reserveIntel || !Memory.reserveIntel[rn]) {
      if (!isRoomLocked(rn)) return rn;
    }
  }

  var best = null, bestTicks = 999999;
  for (var j = 0; j < candidates.length; j++) {
    var rn2 = candidates[j];
    if (isRoomLocked(rn2)) continue;
    var intel = Memory.reserveIntel && Memory.reserveIntel[rn2];
    if (!intel) { best = rn2; break; }
    if (intel.owner && intel.owner !== creep.owner.username && intel.owner !== 'me') continue;
    if (intel.ticks < bestTicks) { bestTicks = intel.ticks; best = rn2; }
  }
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
  var mode = (creep.memory.claimerMode || CONFIG.defaultMode).toLowerCase();
  var exactName = mode === 'claim' ? 'Claim' : (mode === 'attack' ? 'Attack' : 'Reserve');

  var chosenFlag = Game.flags[exactName];
  if (!chosenFlag) {
    for (var fname in Game.flags) {
      if (fname.indexOf(exactName) === 0) {
        chosenFlag = Game.flags[fname];
        break;
      }
    }
  }
  if (chosenFlag) {
    creep.memory.targetRoom = chosenFlag.pos.roomName;
    return creep.memory.targetRoom;
  }
  if (creep.memory.targetRoom) return creep.memory.targetRoom;
  return null;
}

function moveToRoom(creep, roomName) {
  if (creep.pos.roomName !== roomName) {
    var dest = new RoomPosition(25, 25, roomName);
    if (BeeToolbox && BeeToolbox.BeeTravel) {
      BeeToolbox.BeeTravel(creep, dest, { range: 20, reusePath: CONFIG.reusePath });
    } else {
      creep.moveTo(dest, { reusePath: CONFIG.reusePath, range: 20 });
    }
    return false;
  }
  return true;
}

// ---- Updated signing logic with random pool ----
function signIfWanted(creep, controller) {
  if (!controller || controller.my) return;

  var needNew = false;
  if (!controller.sign) {
    needNew = true;
  } else if (controller.sign.username !== creep.owner.username) {
    needNew = true;
  } else {
    var age = Game.time - controller.sign.time;
    if (age >= SIGN_DAY_TICKS) needNew = true;
  }

  if (needNew) {
    if (!creep.memory.signText) {
      var pick = SIGN_TEXTS[Math.floor(Math.random() * SIGN_TEXTS.length)];
      creep.memory.signText = pick;
    }
    var res = creep.signController(controller, creep.memory.signText);
    if (res === ERR_NOT_IN_RANGE) {
      if (BeeToolbox && BeeToolbox.BeeTravel) BeeToolbox.BeeTravel(creep, controller);
      else creep.moveTo(controller);
    } else if (res === OK) {
      delete creep.memory.signText; // clear so next time it picks fresh
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

var TaskClaimer = {
  run: function(creep) {
    rememberReservationIntel(creep.room);

    var plan = gatherReserveTargets();
    if (RESERVE_CONFIG.scanRoleNames.indexOf('luna') === -1)
      RESERVE_CONFIG.scanRoleNames.push('luna');

    if (creep.memory.targetRoom && plan.indexOf(creep.memory.targetRoom) === -1) {
      releaseRoomLock(creep.memory.targetRoom, creep);
      creep.memory.targetRoom = null;
    }

    if (!creep.memory.targetRoom) {
      var modeTmp = (creep.memory.claimerMode || CONFIG.defaultMode).toLowerCase();
      if (modeTmp === 'reserve') {
        var pick = pickNextReserveTarget(creep, plan);
        if (pick && acquireRoomLock(pick, creep)) {
          creep.memory.targetRoom = pick;
        } else {
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
      refreshRoomLock(creep.memory.targetRoom, creep);
    }

    var targetRoom = creep.memory.targetRoom;
    if (!targetRoom) { creep.say('❌ no target'); return; }

    if (!moveToRoom(creep, targetRoom)) { refreshRoomLock(targetRoom, creep); return; }

    var ctl = creep.room.controller;
    if (!ctl) { releaseRoomLock(targetRoom, creep); creep.say('🚫no ctl'); return; }

    var mode = (creep.memory.claimerMode || CONFIG.defaultMode).toLowerCase();
    if (mode === 'claim') return doClaim(creep, ctl);
    if (mode === 'attack') return doAttack(creep, ctl);

    doReserve(creep, ctl);
    rememberReservationIntel(creep.room);
    refreshRoomLock(targetRoom, creep);

    if (ctl.reservation && ctl.reservation.username === creep.owner.username) {
      var ticks = ctl.reservation.ticksToEnd || 0;
      if (ticks >= RESERVE_CONFIG.rotateAt) {
        releaseRoomLock(targetRoom, creep);
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
