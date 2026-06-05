'use strict';

// CombatMelee behavior implementation only. Public role wiring stays in role.CombatMelee.js.
var CFG = require('role.CombatMelee.Config');
var CombatStaging = require('Combat.Staging');
var HarabiCreep = require('role.HarabiCreep');
var BeeCombatIntel = require('BeeCombatIntel');

function setIdleMemory(creep) {
  if (!creep || !creep.memory) return;
  HarabiCreep.recordCombatMemory(creep, 'idle', null);
}

function getAssignedTargetRoom(creep) {
  if (!creep || !creep.memory) return null;
  if (creep.memory.targetRoom) return creep.memory.targetRoom;
  if (creep.memory.squadFlag && Memory.squads && Memory.squads[creep.memory.squadFlag]) {
    return Memory.squads[creep.memory.squadFlag].targetRoom || null;
  }
  return null;
}

function isProtectedCombatRole(creep) {
  if (!creep || !creep.memory) return false;
  return creep.memory.role === 'CombatMedic' || creep.memory.role === 'CombatArcher';
}

function pickProtectorTarget(creep) {
  if (!creep || !creep.room) return null;
  var protectedAllies = creep.room.find(FIND_MY_CREEPS, {
    filter: function (ally) {
      return ally && ally.id !== creep.id && isProtectedCombatRole(ally) &&
        ally.pos && creep.pos.getRangeTo(ally) <= 3;
    }
  });
  if (!protectedAllies.length) return null;

  var targets = BeeCombatIntel.collectHostileTargets(creep.room, {
    includeStructures: false,
    anchorPos: creep.pos
  });
  var best = null;
  var bestScore = -1000000;
  for (var i = 0; i < targets.length; i++) {
    var hostile = targets[i];
    if (!hostile || !hostile.pos) continue;
    var nearProtected = false;
    for (var j = 0; j < protectedAllies.length; j++) {
      if (hostile.pos.getRangeTo(protectedAllies[j].pos) <= 2) {
        nearProtected = true;
        break;
      }
    }
    if (!nearProtected) continue;
    var score = BeeCombatIntel.getCombatTargetScore(creep, hostile, { anchorPos: creep.pos }) + 5000;
    if (score > bestScore) {
      bestScore = score;
      best = hostile;
    }
  }
  return best ? BeeCombatIntel.getAttackableTargetForCreep(creep, best) : null;
}

function run(creep) {
  if (!creep) return;
  var target = pickProtectorTarget(creep) || HarabiCreep.pickCombatTarget(creep);
  if (!target) {
    var remoteRoom = getAssignedTargetRoom(creep);
    // Beginner note: if this creep has a remote assignment and has not reached
    // that room yet, keep marching toward the room center so it can scout/engage.
    if (remoteRoom && creep.room && creep.room.name !== remoteRoom) {
      HarabiCreep.recordCombatMemory(creep, 'traveling', { pos: new RoomPosition(25, 25, remoteRoom) });
      HarabiCreep.moveCreep(creep, { pos: new RoomPosition(25, 25, remoteRoom), range: 20 }, {
        intentType: 'combat',
        range: 20,
        ignoreCreeps: CFG.IGNORE_CREEPS
      });
      return;
    }
    setIdleMemory(creep);
    CombatStaging.moveToStaging(creep);
    return;
  }
  HarabiCreep.recordCombatMemory(creep, 'engaging', target);
  if (creep.pos.inRangeTo(target, CFG.ATTACK_RANGE)) {
    creep.attack(target);
    return;
  }
  HarabiCreep.moveCreep(creep, { pos: target.pos, range: CFG.TRAVEL_RANGE }, {
    intentType: 'combat',
    ignoreCreeps: CFG.IGNORE_CREEPS
  });
}

module.exports = { run: run };
