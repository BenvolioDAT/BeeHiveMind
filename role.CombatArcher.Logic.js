'use strict';

// CombatArcher behavior implementation only. Public role wiring stays in role.CombatArcher.js.
var CFG = require('role.CombatArcher.Config');
var Traveler = require('Traveler');
var CombatStaging = require('Combat.Staging');

function findClosestHostile(creep) {
  if (!creep || !creep.room) return null;
  var hostiles = creep.room.find(FIND_HOSTILE_CREEPS);
  if (!hostiles || !hostiles.length) return null;
  return creep.pos.findClosestByRange(hostiles);
}

function setEngagingMemory(creep, target) {
  if (!creep || !creep.memory) return;
  creep.memory.combatStatus = 'engaging';
  creep.memory.combatTargetId = target ? target.id : null;
  creep.memory.combatTargetRoom = creep.room ? creep.room.name : null;
  creep.memory.combatLastSeen = Game.time;
}

function setIdleMemory(creep) {
  if (!creep || !creep.memory) return;
  creep.memory.combatStatus = 'idle';
  delete creep.memory.combatTargetId;
  creep.memory.combatTargetRoom = creep.room ? creep.room.name : null;
}

function getAssignedTargetRoom(creep) {
  if (!creep || !creep.memory) return null;
  if (creep.memory.targetRoom) return creep.memory.targetRoom;
  if (creep.memory.squadFlag && Memory.squads && Memory.squads[creep.memory.squadFlag]) {
    return Memory.squads[creep.memory.squadFlag].targetRoom || null;
  }
  return null;
}

function run(creep) {
  if (!creep) return;
  var target = findClosestHostile(creep);
  if (!target) {
    var remoteRoom = getAssignedTargetRoom(creep);
    // Beginner note: ranged defenders should also travel to their assigned
    // remote room before giving up and returning to idle staging.
    if (remoteRoom && creep.room && creep.room.name !== remoteRoom) {
      creep.memory.combatStatus = 'traveling';
      creep.memory.combatTargetRoom = remoteRoom;
      creep.travelTo(new RoomPosition(25, 25, remoteRoom), {
        range: 20,
        ignoreCreeps: CFG.IGNORE_CREEPS
      });
      return;
    }
    setIdleMemory(creep);
    CombatStaging.moveToStaging(creep);
    return;
  }
  setEngagingMemory(creep, target);
  if (creep.pos.inRangeTo(target, CFG.RANGED_ATTACK_RANGE)) {
    creep.rangedAttack(target);
    return;
  }
  creep.travelTo(target, { range: CFG.TRAVEL_RANGE, ignoreCreeps: CFG.IGNORE_CREEPS });
}

module.exports = { run: run };
