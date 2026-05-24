'use strict';

// CombatArcher behavior implementation only. Public role wiring stays in role.CombatArcher.js.
var CFG = require('role.CombatArcher.Config');
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
  if (creep.hits < creep.hitsMax && creep.getActiveBodyparts(HEAL) > 0) {
    creep.heal(creep);
  }
  var target = HarabiCreep.pickCombatTarget(creep);
  if (!target) {
    var remoteRoom = getAssignedTargetRoom(creep);
    // Beginner note: ranged defenders should also travel to their assigned
    // remote room before giving up and returning to idle staging.
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
  var range = creep.pos.getRangeTo(target);
  if (range <= CFG.RANGED_ATTACK_RANGE) {
    creep.rangedAttack(target);
  }
  if (range < CFG.RANGED_ATTACK_RANGE) {
    HarabiCreep.moveCreep(creep, { pos: target.pos, range: CFG.RANGED_ATTACK_RANGE + 1 }, {
      flee: true,
      intentType: 'combat',
      ignoreCreeps: CFG.IGNORE_CREEPS
    });
    return;
  }
  if (range > CFG.RANGED_ATTACK_RANGE) {
    HarabiCreep.moveCreep(creep, { pos: target.pos, range: CFG.TRAVEL_RANGE }, {
      intentType: 'combat',
      ignoreCreeps: CFG.IGNORE_CREEPS
    });
  }
}

module.exports = { run: run };
