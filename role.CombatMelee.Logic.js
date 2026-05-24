'use strict';

// CombatMelee behavior implementation only. Public role wiring stays in role.CombatMelee.js.
var CFG = require('role.CombatMelee.Config');
var CombatStaging = require('Combat.Staging');
var HarabiCreep = require('role.HarabiCreep');

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

function run(creep) {
  if (!creep) return;
  var target = HarabiCreep.pickCombatTarget(creep);
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
