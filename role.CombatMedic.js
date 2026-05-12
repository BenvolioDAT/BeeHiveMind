'use strict';

var Traveler = require('Traveler');

function isCombatRole(creep, roleName) {
  return creep && creep.memory && creep.memory.role === roleName;
}

function wasRecentlyEngaging(creep) {
  if (!creep || !creep.memory) return false;
  if (creep.memory.combatStatus === 'engaging') return true;
  var lastSeen = creep.memory.combatLastSeen;
  return typeof lastSeen === 'number' && (Game.time - lastSeen) <= 5;
}

function getSupportCandidates(medic) {
  var allies = medic.room.find(FIND_MY_CREEPS);
  var injuredMeleeEngaging = [];
  var injuredMeleeRecent = [];
  var injuredArcherEngaging = [];
  var injuredArcherRecent = [];
  var healthyMeleeActive = [];
  var healthyArcherActive = [];

  for (var i = 0; i < allies.length; i++) {
    var ally = allies[i];
    if (!ally || ally.id === medic.id) continue;

    var isMelee = isCombatRole(ally, 'CombatMelee');
    var isArcher = isCombatRole(ally, 'CombatArcher');
    if (!isMelee && !isArcher) continue;

    var engaging = ally.memory && ally.memory.combatStatus === 'engaging';
    var recent = wasRecentlyEngaging(ally);
    var injured = ally.hits < ally.hitsMax;

    if (isMelee && injured && engaging) injuredMeleeEngaging.push(ally);
    else if (isMelee && injured && recent) injuredMeleeRecent.push(ally);
    else if (isArcher && injured && engaging) injuredArcherEngaging.push(ally);
    else if (isArcher && injured && recent) injuredArcherRecent.push(ally);
    else if (isMelee && !injured && recent) healthyMeleeActive.push(ally);
    else if (isArcher && !injured && recent) healthyArcherActive.push(ally);
  }

  return [
    injuredMeleeEngaging,
    injuredMeleeRecent,
    injuredArcherEngaging,
    injuredArcherRecent,
    healthyMeleeActive,
    healthyArcherActive
  ];
}

function pickClosestFromGroups(medic, groups) {
  for (var g = 0; g < groups.length; g++) {
    var group = groups[g];
    if (!group || !group.length) continue;
    return medic.pos.findClosestByRange(group);
  }
  return null;
}

function setHealingMemory(creep, target) {
  creep.memory.combatStatus = 'healing';
  creep.memory.combatTargetId = target ? target.id : null;
  creep.memory.combatTargetRoom = creep.room ? creep.room.name : null;
  creep.memory.combatLastSeen = Game.time;
}

function setIdleMemory(creep) {
  creep.memory.combatStatus = 'idle';
  delete creep.memory.combatTargetId;
  creep.memory.combatTargetRoom = creep.room ? creep.room.name : null;
}

module.exports = {
  role: 'CombatMedic',

  run: function (creep) {
    if (!creep) return;

    if (creep.hits < creep.hitsMax) {
      creep.heal(creep);
    }

    var groups = getSupportCandidates(creep);
    var target = pickClosestFromGroups(creep, groups);

    if (!target) {
      setIdleMemory(creep);
      return;
    }

    setHealingMemory(creep, target);

    if (creep.pos.inRangeTo(target, 1)) {
      creep.heal(target);
      return;
    }

    if (creep.pos.inRangeTo(target, 3)) {
      creep.rangedHeal(target);
    }

    creep.travelTo(target, { range: 1, ignoreCreeps: false });
  }
};
