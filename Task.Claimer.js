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
    var targetRoom = resolveTargetRoom(creep);

    if (!targetRoom) {
      creep.say('❌ no target');
      return; // do nothing until a proper target is provided
    }

    // Move first. Only act once we are IN the target room.
    if (!moveToRoom(creep, targetRoom)) return;

    var ctl = creep.room.controller;
    if (!ctl) { creep.say('🚫no ctl'); return; }

    var mode = (creep.memory.claimerMode || CONFIG.defaultMode).toLowerCase();
    if (mode === 'claim') return doClaim(creep, ctl);
    if (mode === 'attack') return doAttack(creep, ctl);
    return doReserve(creep, ctl);
  }
};

module.exports = TaskClaimer;
