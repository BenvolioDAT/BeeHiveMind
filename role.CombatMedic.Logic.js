'use strict';

// CombatMedic behavior implementation only. Public role wiring stays in role.CombatMedic.js.
var CFG = require('role.CombatMedic.Config');
var Traveler = require('Traveler');
var CombatStaging = require('Combat.Staging');

function isCombatRole(creep, roleName) { return creep && creep.memory && creep.memory.role === roleName; }
function wasRecentlyEngaging(creep) {
  if (!creep || !creep.memory) return false;
  if (creep.memory.combatStatus === 'engaging') return true;
  var lastSeen = creep.memory.combatLastSeen;
  return typeof lastSeen === 'number' && (Game.time - lastSeen) <= CFG.RECENT_ENGAGE_TICKS;
}
function getSupportCandidates(medic) {
  var allies = medic.room.find(FIND_MY_CREEPS);
  var injuredMeleeEngaging = []; var injuredMeleeRecent = []; var injuredArcherEngaging = []; var injuredArcherRecent = []; var healthyMeleeActive = []; var healthyArcherActive = [];
  for (var i = 0; i < allies.length; i++) {
    var ally = allies[i];
    if (!ally || ally.id === medic.id) continue;
    var isMelee = isCombatRole(ally, 'CombatMelee'); var isArcher = isCombatRole(ally, 'CombatArcher'); if (!isMelee && !isArcher) continue;
    var engaging = ally.memory && ally.memory.combatStatus === 'engaging'; var recent = wasRecentlyEngaging(ally); var injured = ally.hits < ally.hitsMax;
    if (isMelee && injured && engaging) injuredMeleeEngaging.push(ally);
    else if (isMelee && injured && recent) injuredMeleeRecent.push(ally);
    else if (isArcher && injured && engaging) injuredArcherEngaging.push(ally);
    else if (isArcher && injured && recent) injuredArcherRecent.push(ally);
    else if (isMelee && !injured && recent) healthyMeleeActive.push(ally);
    else if (isArcher && !injured && recent) healthyArcherActive.push(ally);
  }
  return [injuredMeleeEngaging, injuredMeleeRecent, injuredArcherEngaging, injuredArcherRecent, healthyMeleeActive, healthyArcherActive];
}
function pickClosestFromGroups(medic, groups) { for (var g = 0; g < groups.length; g++) { var group = groups[g]; if (!group || !group.length) continue; return medic.pos.findClosestByRange(group); } return null; }
function setHealingMemory(creep, target) { creep.memory.combatStatus = 'healing'; creep.memory.combatTargetId = target ? target.id : null; creep.memory.combatTargetRoom = creep.room ? creep.room.name : null; creep.memory.combatLastSeen = Game.time; }
function setIdleMemory(creep) { creep.memory.combatStatus = 'idle'; delete creep.memory.combatTargetId; creep.memory.combatTargetRoom = creep.room ? creep.room.name : null; }
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
  if (creep.hits < creep.hitsMax) creep.heal(creep);
  var groups = getSupportCandidates(creep);
  var target = pickClosestFromGroups(creep, groups);
  if (!target) {
    var remoteRoom = getAssignedTargetRoom(creep);
    // If no ally needs help in this room yet, move with the assigned squad so
    // heals are available as soon as frontline creeps enter combat.
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
  setHealingMemory(creep, target);
  if (creep.pos.inRangeTo(target, CFG.HEAL_RANGE)) { creep.heal(target); return; }
  if (creep.pos.inRangeTo(target, CFG.RANGED_HEAL_RANGE)) creep.rangedHeal(target);
  creep.travelTo(target, { range: CFG.TRAVEL_RANGE, ignoreCreeps: CFG.IGNORE_CREEPS });
}

module.exports = { run: run };
