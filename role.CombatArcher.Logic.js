'use strict';

// CombatArcher behavior implementation only. Public role wiring stays in role.CombatArcher.js.
var CFG = require('role.CombatArcher.Config');
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

function shouldUseMassAttack(creep) {
  if (!creep || !creep.room || creep.getActiveBodyparts(RANGED_ATTACK) <= 0) return false;
  var targets = BeeCombatIntel.collectHostileTargets(creep.room, {
    includeStructures: false,
    anchorPos: creep.pos
  });
  var inRange = 0;
  var adjacent = 0;
  for (var i = 0; i < targets.length; i++) {
    if (!targets[i] || !targets[i].pos) continue;
    var range = creep.pos.getRangeTo(targets[i]);
    if (range <= 3) inRange++;
    if (range <= 1) adjacent++;
  }
  return adjacent >= 2 || inRange >= 3;
}

function findNearestMeleeThreat(creep) {
  if (!creep || !creep.room) return null;
  var targets = BeeCombatIntel.collectHostileTargets(creep.room, {
    includeStructures: false,
    anchorPos: creep.pos
  });
  var nearest = null;
  var nearestRange = 999;
  for (var i = 0; i < targets.length; i++) {
    var hostile = targets[i];
    if (!hostile || !hostile.pos || typeof hostile.getActiveBodyparts !== 'function') continue;
    if (hostile.getActiveBodyparts(ATTACK) <= 0) continue;
    var range = creep.pos.getRangeTo(hostile);
    if (range < nearestRange) {
      nearestRange = range;
      nearest = hostile;
    }
  }
  return nearest && nearestRange <= 2 ? nearest : null;
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
  var meleeThreat = findNearestMeleeThreat(creep);
  if (meleeThreat && creep.pos.getRangeTo(meleeThreat) <= 2) {
    if (creep.pos.getRangeTo(meleeThreat) <= CFG.RANGED_ATTACK_RANGE) {
      if (shouldUseMassAttack(creep)) creep.rangedMassAttack();
      else creep.rangedAttack(meleeThreat);
    }
    HarabiCreep.moveCreep(creep, { pos: meleeThreat.pos, range: CFG.RANGED_ATTACK_RANGE }, {
      flee: true,
      intentType: 'combat',
      ignoreCreeps: CFG.IGNORE_CREEPS
    });
    return;
  }
  var range = creep.pos.getRangeTo(target);
  if (range <= CFG.RANGED_ATTACK_RANGE) {
    if (shouldUseMassAttack(creep)) creep.rangedMassAttack();
    else creep.rangedAttack(target);
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
