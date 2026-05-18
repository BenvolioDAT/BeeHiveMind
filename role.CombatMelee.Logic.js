'use strict';

// CombatMelee behavior implementation only. Public role wiring stays in role.CombatMelee.js.
var CFG = require('role.CombatMelee.Config');
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
    // Beginner note: if this creep has a remote assignment and has not reached
    // that room yet, keep marching toward the room center so it can scout/engage.
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
  if (creep.pos.inRangeTo(target, CFG.ATTACK_RANGE)) {
    creep.attack(target);
    return;
  }
  creep.travelTo(target, { range: CFG.TRAVEL_RANGE, ignoreCreeps: CFG.IGNORE_CREEPS });
}

module.exports = { run: run };
