'use strict';

var Traveler = require('Traveler');

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

module.exports = {
  role: 'CombatArcher',

  run: function (creep) {
    if (!creep) return;

    var target = findClosestHostile(creep);
    if (!target) {
      setIdleMemory(creep);
      return;
    }

    setEngagingMemory(creep, target);

    if (creep.pos.inRangeTo(target, 3)) {
      creep.rangedAttack(target);
      return;
    }

    creep.travelTo(target, { range: 3, ignoreCreeps: false });
  }
};
