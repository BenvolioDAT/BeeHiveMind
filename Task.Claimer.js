// Task.Claimer.js
// One task that can: claim a room, reserve a room, or attack (dereserve) a controller.
// Config via creep.memory:
//   - claimerMode: 'claim' | 'reserve' | 'attack'  (default: 'reserve')
//   - targetRoom: 'W0N0' (preferred), or use flags named 'Claim' / 'Reserve' / 'Attack'
// Optional niceties:
//   - signText: string to sign controllers you touch
//   - placeSpawnOnClaim: true|false (only used in 'claim' mode)

const BeeToolbox = require('BeeToolbox');

const CONFIG = {
  defaultMode: 'reserve',
  placeSpawnOnClaim: false,   // set false if you don’t want auto-spawn site
  signText: '🐝 Sushi Moto Logistics — roads, loads, and righteous nodes.',
  // Pathing:
  reusePath: 15
};

function resolveTargetRoom(creep) {
  if (creep.memory.targetRoom) return creep.memory.targetRoom;

  // Fallback to flags if player drops them
  const mode = (creep.memory.claimerMode || CONFIG.defaultMode).toLowerCase();
  const flagName = mode === 'claim' ? 'Claim' : mode === 'attack' ? 'Attack' : 'Reserve';
  const flag = Game.flags[flagName];
  if (flag) {
    creep.memory.targetRoom = flag.pos.roomName;
    return creep.memory.targetRoom;
  }

  // Last resort: current room
  creep.memory.targetRoom = creep.pos.roomName;
  return creep.memory.targetRoom;
}

function moveToRoom(creep, roomName) {
  if (creep.pos.roomName !== roomName) {
    const dest = new RoomPosition(25, 25, roomName);
    // Prefer your traveler wrapper if present:
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
  if (!controller || controller.owner?.username === creep.owner?.username) return;
  if (CONFIG.signText && (!controller.sign || controller.sign.text !== CONFIG.signText)) {
    if (creep.signController(controller, CONFIG.signText) === ERR_NOT_IN_RANGE) {
      BeeToolbox.BeeTravel(creep, controller);
    }
  }
}

function placeSpawnIfWanted(creep, controller) {
  if (!CONFIG.placeSpawnOnClaim || !controller || !controller.my) return;
  // If no spawns in room, drop a site roughly center-ish
  const anySpawn = creep.room.find(FIND_MY_SPAWNS)[0];
  if (!anySpawn) {
    // Try a nice place near the controller (but not on it!)
    const spot = controller.pos.findClosestByPath(FIND_MY_CONSTRUCTION_SITES) ||
                 controller.pos; // fallback to near controller
    // Try a ring around controller until one works
    const offsets = [
      [3,0],[3,1],[2,2],[1,3],[0,3],[-1,3],[-2,2],[-3,1],[-3,0],
      [-3,-1],[-2,-2],[-1,-3],[0,-3],[1,-3],[2,-2],[3,-1]
    ];
    for (const [dx,dy] of offsets) {
      const x = Math.max(1, Math.min(48, controller.pos.x + dx));
      const y = Math.max(1, Math.min(48, controller.pos.y + dy));
      if (creep.room.createConstructionSite(x, y, STRUCTURE_SPAWN) === OK) {
        creep.say('🚧 spawn');
        break;
      }
    }
  }
}

function doClaim(creep, controller) {
  if (!controller) { creep.say('❓no ctl'); return; }
  if (controller.my) { // already ours
    signIfWanted(creep, controller);
    placeSpawnIfWanted(creep, controller);
    creep.say('✅ claimed');
    return;
  }
  // If owned by someone else: you can’t claim directly; you must attackController
  if (controller.owner && !controller.my) {
    creep.say('⚔ atkCtl');
    const r = creep.attackController(controller);
    if (r === ERR_NOT_IN_RANGE) return BeeToolbox.BeeTravel(creep, controller);
    return;
  }
  // Neutral: try to claim (requires free GCL)
  const res = creep.claimController(controller);
  if (res === ERR_NOT_IN_RANGE) {
    return BeeToolbox.BeeTravel(creep, controller);
  } else if (res === OK) {
    creep.say('👑 mine');
    signIfWanted(creep, controller);
    placeSpawnIfWanted(creep, controller);
  } else {
    // e.g. ERR_GCL_NOT_ENOUGH — fall back to reserve so your remote benefits
    if (res === ERR_GCL_NOT_ENOUGH) {
      creep.say('➡ reserve');
      doReserve(creep, controller);
    } else {
      creep.say(`❌${res}`);
    }
  }
}

function doReserve(creep, controller) {
  if (!controller) { creep.say('❓no ctl'); return; }
  // If enemy or Invader reserved, nip it first
  if (controller.reservation && controller.reservation.username !== creep.owner.username) {
    const r = creep.attackController(controller); // reduces reservation ticks
    if (r === ERR_NOT_IN_RANGE) return BeeToolbox.BeeTravel(creep, controller);
    creep.say('🪓 deres');
    return;
  }
  const r = creep.reserveController(controller);
  if (r === ERR_NOT_IN_RANGE) {
    BeeToolbox.BeeTravel(creep, controller);
  } else if (r === OK) {
    creep.say('📌 +res');
  } else {
    creep.say(`❌${r}`);
  }
  signIfWanted(creep, controller);
}

function doAttack(creep, controller) {
  if (!controller) { creep.say('❓no ctl'); return; }
  const r = creep.attackController(controller);
  if (r === ERR_NOT_IN_RANGE) {
    BeeToolbox.BeeTravel(creep, controller);
  } else if (r === OK) {
    creep.say('🪓 atkCtl');
  } else {
    creep.say(`❌${r}`);
  }
}

const TaskClaimer = {
  run: function(creep) {
    const targetRoom = resolveTargetRoom(creep);
    if (!moveToRoom(creep, targetRoom)) return;

    const ctl = creep.room.controller;
    if (!ctl) { creep.say('🚫no ctl'); return; }

    // Optional: avoid smashing your own claimers into strongholds blindly
    // If you detect an Invader Core/Stronghold, you may want to bail unless escorted.
    // (You can still contest reservation with attack/reserve; the core itself needs fighters.)

    const mode = (creep.memory.claimerMode || CONFIG.defaultMode).toLowerCase();
    if (mode === 'claim') return doClaim(creep, ctl);
    if (mode === 'attack') return doAttack(creep, ctl);
    return doReserve(creep, ctl);
  }
};

module.exports = TaskClaimer;
