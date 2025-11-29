'use strict';

// Shared debug + tuning config (copied from role.BeeWorker for consistency)
var CFG = Object.freeze({
  // --- Debug toggles (shared) ---
  DEBUG_SAY: false,
  DEBUG_DRAW: true,

  // --- Visual styles (shared) ---
  DRAW: {
    // BaseHarvest-style visuals
    TRAVEL:   "#8ab6ff",
    SOURCE:   "#ffd16e",
    SEAT:     "#6effa1",
    QUEUE:    "#ffe66e",
    YIELD:    "#ff6e6e",
    OFFLOAD:  "#6ee7ff",
    IDLE:     "#bfbfbf",
    // Courier-style visuals
    WD_COLOR:    "#6ec1ff",  // withdraw lines
    FILL_COLOR:  "#6effa1",  // delivery lines
    DROP_COLOR:  "#ffe66e",  // dropped energy
    GRAVE_COLOR: "#ffb0e0",  // tombstones/ruins
    IDLE_COLOR:  "#bfbfbf",
    // Shared
    WIDTH:   0.12,
    OPACITY: 0.45,
    FONT:    0.6
  },

  // --- Towers (Courier) ---
  TOWER_REFILL_AT_OR_BELOW: 0.70,

  //Upgrader role Behavior
  SIGN_TEXT: "BeeNice Please.",
  //Trucker role Behavior
  PICKUP_FLAG_DEFAULT: "E-Pickup", // default flag name to route to
  MIN_DROPPED: 50,                 // ignore tiny crumbs (energy or other)
  SEARCH_RADIUS: 50,               // how far from flag to look
  PATH_REUSE: 20,                  // reusePath hint
  // Optional: allow non-energy resource pickups (POWER, minerals, etc.)
  ALLOW_NON_ENERGY: true,
  // Fallback park if no flag & no home (harmless; rarely used)
  PARK_POS: { x:25, y:25, roomName:"W0N0" },

  //--- Pathing (used by Queen)----
  STUCK_TICKS: 6,
  MOVE_PRIORITIES: { withdraw: 60, pickup: 70, deliver: 55, idle: 5 },

  // --- Pathing (used by Courier & any others that want it) ---
  PATH_REUSE: 40,
  MAX_OPS_MOVE: 2000,
  TRAVEL_MAX_OPS: 4000,
  // --- Targeting cadences (Courier) ---
  RETARGET_COOLDOWN: 10,
  GRAVE_SCAN_COOLDOWN: 20,
  BETTER_CONTAINER_DELTA: 150,
  // --- Thresholds / radii (Courier) ---
  CONTAINER_MIN: 50,
  DROPPED_BIG_MIN: 150,
  DROPPED_NEAR_CONTAINER_R: 2,
  DROPPED_ALONG_ROUTE_R: 2,
});

// Claimer role implementation
  // =========================
  // Debug helpers
  // =========================
  function debugSay(creep, msg) {
    if (CFG.DEBUG_SAY && creep && msg) creep.say(msg, true);
  }

  // Returns a RoomPosition for any target (object, pos-like, or {x,y,roomName}).
  function getTargetPosition(target) {
    if (!target) return null;
    if (target.pos) return target.pos;
    if (target.x != null && target.y != null && target.roomName) return target;
    return null;
  }

  function debugDrawLine(creep, target, color, label) {
    if (!CFG.DEBUG_DRAW || !creep || !target) return;
    var room = creep.room; if (!room || !room.visual) return;
    var tpos = getTargetPosition(target); if (!tpos || tpos.roomName !== room.name) return;
    try {
      room.visual.line(creep.pos, tpos, {
        color: color, width: CFG.DRAW.WIDTH, opacity: CFG.DRAW.OPACITY, lineStyle: "solid"
      });
      if (label) {
        room.visual.text(label, tpos.x, tpos.y - 0.3, {
          color: color, opacity: CFG.DRAW.OPACITY, font: CFG.DRAW.FONT, align: "center"
        });
      }
    } catch (e) {}
  }

  function debugRing(room, pos, color, text) {
    if (!CFG.DEBUG_DRAW || !room || !room.visual || !pos) return;
    try {
      room.visual.circle(pos, { radius: 0.5, fill: "transparent", stroke: color, opacity: CFG.DRAW.OPACITY, width: CFG.DRAW.WIDTH });
      if (text) room.visual.text(text, pos.x, pos.y - 0.6, { color: color, font: CFG.DRAW.FONT, opacity: CFG.DRAW.OPACITY, align: "center" });
    } catch (e) {}
  }

  function debugLabel(room, pos, text, color) {
    if (!CFG.DEBUG_DRAW || !room || !room.visual || !pos || !text) return;
    try {
      room.visual.text(text, pos.x, pos.y - 1.2, {
        color: color || CFG.DRAW.TEXT, font: CFG.DRAW.FONT, opacity: 0.95, align: "center",
        backgroundColor: "#000000", backgroundOpacity: 0.25
      });
    } catch (e) {}
  }

  // =========================
  // Core config
  // =========================
  var CONFIG = {
    defaultMode: 'reserve',
    placeSpawnOnClaim: false,
    reusePath: 15
  };

  function ensureClaimerIdentity(creep) {
    if (!creep || !creep.memory) return;
    creep.memory.role = 'Claimer';
    if (!creep.memory.task) creep.memory.task = 'claimer';
  }

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

  // ticks ~ “a day” before re-signing
  var SIGN_DAY_TICKS = 1500;

  // ---- Multi-room Reserve Helpers ----
  var RESERVE_CONFIG = {
    desired: 2500,
    rotateAt: 1000,
    scanRoleNames: ['luna'],
    maxTargets: 8
  };

  // ---- Room Locking (prevents 2 claimers from dogpiling one room) ----
  var LOCK = { ttl: 10 };

  // =========================
  // Lock memory
  // =========================
  function ensureLockMem() { if (!Memory.reserveLocks) Memory.reserveLocks = {}; }
  function isRoomLocked(rn) {
    ensureLockMem();
    var L = Memory.reserveLocks[rn];
    if (!L) return false;
    if (L.until <= Game.time) { delete Memory.reserveLocks[rn]; return false; }
    if (L.creep && !Game.creeps[L.creep]) { delete Memory.reserveLocks[rn]; return false; }
    return true;
  }
  function acquireRoomLock(rn, creep) {
    ensureLockMem(); isRoomLocked(rn);
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

  // =========================
  // Target gathering / intel
  // =========================
  function gatherReserveTargets() {
    var set = {};
    for (var fname in Game.flags) {
      if (fname === 'Reserve' || fname.indexOf('Reserve:') === 0) {
        var f = Game.flags[fname];
        if (f && f.pos && f.pos.roomName) set[f.pos.roomName] = true;
      }
    }
    for (var cname in Game.creeps) {
      var c = Game.creeps[cname];
      if (!c.memory || !c.memory.role) continue;
      if (RESERVE_CONFIG.scanRoleNames.indexOf(c.memory.role) !== -1) {
        var rn = c.memory.remoteRoom || c.memory.targetRoom || c.memory.targetRoomName;
        if (rn) set[rn] = true;
      }
    }
    var out = [];
    for (var rn in set) out.push(rn);
    if (out.length > RESERVE_CONFIG.maxTargets) out.length = RESERVE_CONFIG.maxTargets;
    return out;
  }

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

    // Draw little HUD over controller
    if (CFG.DEBUG_DRAW) {
      var tag = (owner ? owner : "free") + " • " + ticks;
      debugRing(room, ctl.pos, CFG.DRAW.CTRL, "CTL");
      debugLabel(room, ctl.pos, tag, CFG.DRAW.TEXT);
    }
  }

  function pickNextReserveTarget(creep, candidates) {
    if (!candidates || !candidates.length) return null;

    // First: unseen intel & unlocked
    for (var i = 0; i < candidates.length; i++) {
      var rn = candidates[i];
      if (!Memory.reserveIntel || !Memory.reserveIntel[rn]) {
        if (!isRoomLocked(rn)) return rn;
      }
    }

    // Next: ours / free with lowest ticks
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
        if (fname.indexOf(exactName) === 0) { chosenFlag = Game.flags[fname]; break; }
      }
    }
    if (chosenFlag) {
      creep.memory.targetRoom = chosenFlag.pos.roomName;
      // draw flag if visible
      if (CFG.DEBUG_DRAW && chosenFlag.pos && Game.rooms[chosenFlag.pos.roomName]) {
        debugRing(Game.rooms[chosenFlag.pos.roomName], chosenFlag.pos, CFG.DRAW.FLAG, "FLAG");
      }
      return creep.memory.targetRoom;
    }
    if (creep.memory.targetRoom) return creep.memory.targetRoom;
    return null;
  }

  // =========================
  // Orchestration helpers
  // =========================
  // Memory keys:
  // - claimerMode: desired action ('claim', 'reserve', 'attack')
  // - targetRoom: controller room currently assigned

  function claimerMode(creep) {
    return (creep.memory.claimerMode || CONFIG.defaultMode).toLowerCase();
  }

  function ensureReserveRoleScan() {
    if (RESERVE_CONFIG.scanRoleNames.indexOf('luna') === -1) {
      RESERVE_CONFIG.scanRoleNames.push('luna');
    }
  }

  function drawLockVisual(targetRoom) {
    if (!CFG.DEBUG_DRAW) return;
    if (!Game.rooms[targetRoom]) return;
    if (!isRoomLocked(targetRoom)) return;
    var center = new RoomPosition(25,25,targetRoom);
    debugRing(Game.rooms[targetRoom], center, CFG.DRAW.LOCK, "LOCK");
  }

  function runControllerMode(creep, ctl) {
    var mode = claimerMode(creep);
    if (mode === 'claim') { doClaim(creep, ctl); }
    else if (mode === 'attack') { doAttack(creep, ctl); }
    else { doReserve(creep, ctl); }
  }

  function rotateIfSatisfied(creep, ctl, targetRoom) {
    if (!ctl) return;
    if (ctl.reservation && ctl.reservation.username === creep.owner.username) {
      var ticks = ctl.reservation.ticksToEnd || 0;
      if (ticks >= RESERVE_CONFIG.rotateAt) {
        releaseRoomLock(targetRoom, creep);
        debugSay(creep, '➡');
        creep.memory.targetRoom = null;
      }
      return;
    }
    if (ctl.my) {
      releaseRoomLock(targetRoom, creep);
      debugSay(creep, '🏠');
      creep.memory.targetRoom = null;
    }
  }

  // =========================
  // Movement helpers
  // =========================
  function moveToRoom(creep, roomName) {
    if (creep.pos.roomName !== roomName) {
      var dest = new RoomPosition(25, 25, roomName);
      debugSay(creep, '➡️' + roomName);
      creep.travelTo(dest, { range: 20, reusePath: CONFIG.reusePath });
      return false;
    }
    return true;
  }

  function determineClaimerState(creep, targetRoom) {
    var state = 'IDLE';
    if (targetRoom) {
      state = creep.pos.roomName === targetRoom ? 'WORK' : 'TRAVEL';
    }
    creep.memory.state = state;
    return state;
  }

  // =========================
  // Controller actions
  // =========================
  function signIfWanted(creep, controller) {
    if (!controller || controller.my) return;

    var needNew = false;
    if (!controller.sign) needNew = true;
    else if (controller.sign.username !== creep.owner.username) needNew = true;
    else {
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
        debugSay(creep, '✍️');
        debugDrawLine(creep, controller, CFG.DRAW.SIGN, "SIGN");
        creep.travelTo(controller, { range: 1, reusePath: CONFIG.reusePath });
      } else if (res === OK) {
        debugSay(creep, '✅');
        debugRing(creep.room, controller.pos, CFG.DRAW.SIGN, "SIGNED");
        delete creep.memory.signText;
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
          debugSay(creep, '🚧');
          debugRing(creep.room, new RoomPosition(x,y,controller.pos.roomName), CFG.DRAW.CTRL, "SPAWN");
          break;
        }
      }
    }
  }

  function doClaim(creep, controller) {
    if (!controller) { debugSay(creep, '❓ctl'); return; }
    debugRing(creep.room, controller.pos, CFG.DRAW.CTRL, "CTL");

    if (controller.my) {
      signIfWanted(creep, controller);
      placeSpawnIfWanted(creep, controller);
      debugSay(creep, '✅');
      return;
    }
    if (controller.owner && !controller.my) {
      var r = creep.attackController(controller);
      if (r === ERR_NOT_IN_RANGE) {
        debugSay(creep, '⚔');
        debugDrawLine(creep, controller, CFG.DRAW.CTRL, "ATK");
        creep.travelTo(controller, { range: 1, reusePath: CONFIG.reusePath });
        return;
      }
      debugSay(creep, '⚔');
      return;
    }
    var res = creep.claimController(controller);
    if (res === ERR_NOT_IN_RANGE) {
      debugSay(creep, '👑');
      debugDrawLine(creep, controller, CFG.DRAW.CTRL, "CLAIM");
      creep.travelTo(controller, { range: 1, reusePath: CONFIG.reusePath });
    } else if (res === OK) {
      debugSay(creep, '👑');
      signIfWanted(creep, controller);
      placeSpawnIfWanted(creep, controller);
    } else if (res === ERR_GCL_NOT_ENOUGH) {
      debugSay(creep, '➡R');
      doReserve(creep, controller);
    } else {
      debugSay(creep, '❌' + res);
    }
  }

  function doReserve(creep, controller) {
    if (!controller) { debugSay(creep, '❓ctl'); return; }
    debugRing(creep.room, controller.pos, CFG.DRAW.CTRL, "CTL");
    if (controller.reservation && controller.reservation.username !== creep.owner.username) {
      var r = creep.attackController(controller);
      if (r === ERR_NOT_IN_RANGE) {
        debugSay(creep, '🪓');
        debugDrawLine(creep, controller, CFG.DRAW.CTRL, "DERES");
        creep.travelTo(controller, { range: 1, reusePath: CONFIG.reusePath });
        return;
      }
      debugSay(creep, '🪓');
      return;
    }
    var res = creep.reserveController(controller);
    if (res === ERR_NOT_IN_RANGE) {
      debugSay(creep, '📌');
      debugDrawLine(creep, controller, CFG.DRAW.CTRL, "+RES");
      creep.travelTo(controller, { range: 1, reusePath: CONFIG.reusePath });
    } else if (res === OK) {
      debugSay(creep, '📌');
    } else {
      debugSay(creep, '❌' + res);
    }
    signIfWanted(creep, controller);
  }

  function doAttack(creep, controller) {
    if (!controller) { debugSay(creep, '❓ctl'); return; }
    var r = creep.attackController(controller);
    if (r === ERR_NOT_IN_RANGE) {
      debugSay(creep, '🪓');
      debugDrawLine(creep, controller, CFG.DRAW.CTRL, "ATK");
      creep.travelTo(controller, { range: 1, reusePath: CONFIG.reusePath });
    } else if (r === OK) {
      debugSay(creep, '🪓');
    } else {
      debugSay(creep, '❌' + r);
    }
  }

  // =========================
  // Public API
  // =========================
  var roleClaimer = {
    role: 'Claimer',
    run: function(creep) {
      ensureClaimerIdentity(creep);
      rememberReservationIntel(creep.room);
      ensureReserveRoleScan();

      // Build the current reserve plan and drop stale locks/targets that fell out of view
      var plan = gatherReserveTargets();
      var targetRoom = creep.memory.targetRoom;
      if (targetRoom && plan.indexOf(targetRoom) === -1) {
        releaseRoomLock(targetRoom, creep);
        targetRoom = creep.memory.targetRoom = null;
      }

      var mode = claimerMode(creep);
      if (!targetRoom && mode === 'reserve') {
        // Try to lock the best reserve candidate, then fall through the list until one is free
        var pick = pickNextReserveTarget(creep, plan);
        if (pick && acquireRoomLock(pick, creep)) {
          targetRoom = creep.memory.targetRoom = pick;
          debugSay(creep, '🎯');
        } else {
          for (var i = 0; i < plan.length && !targetRoom; i++) {
            var alt = plan[i];
            if (alt === pick) continue;
            if (acquireRoomLock(alt, creep)) {
              targetRoom = creep.memory.targetRoom = alt;
            }
          }
        }
        if (!targetRoom) {
          debugSay(creep, '🔒');
          return;
        }
      }

      if (!targetRoom && mode !== 'reserve') {
        targetRoom = creep.memory.targetRoom = resolveTargetRoom(creep);
        if (!targetRoom) {
          debugSay(creep, '❌');
          return;
        }
      }

      if (targetRoom && mode === 'reserve') {
        refreshRoomLock(targetRoom, creep);
      }

      drawLockVisual(targetRoom);

      var state = determineClaimerState(creep, targetRoom);
      if (state === 'TRAVEL') {
        if (!moveToRoom(creep, targetRoom)) {
          refreshRoomLock(targetRoom, creep);
        }
        return;
      }

      var ctl = creep.room.controller;
      if (!ctl) {
        releaseRoomLock(targetRoom, creep);
        debugSay(creep, '🚫');
        creep.memory.targetRoom = null;
        return;
      }

      runControllerMode(creep, ctl);

      rememberReservationIntel(creep.room);
      refreshRoomLock(targetRoom, creep);
      rotateIfSatisfied(creep, ctl, targetRoom);
    }
  };

module.exports = roleClaimer;
