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

function run(creep) {
  if (!creep) return;
  var target = findClosestHostile(creep);
  if (!target) {
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
