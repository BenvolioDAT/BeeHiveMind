'use strict';

var Traveler = require('Traveler');
var CombatAPI = require('Combat.API');

function _resolveFlagName(creep) {
  if (!creep || !creep.memory) return null;
  if (creep.memory.squadFlag) return creep.memory.squadFlag;
  if (creep.memory.squadId != null && creep.memory.squadId !== undefined) {
    return 'Squad' + creep.memory.squadId;
  }
  return null;
}

function _squadBucket(flagName) {
  if (!flagName) return null;
  if (!Memory.squads) return null;
  return Memory.squads[flagName] || null;
}

function _resolveMember(id) {
  if (!id) return null;
  return Game.getObjectById(id);
}

function _deserializePos(posData) {
  if (!posData || posData.x == null || posData.y == null || !posData.roomName) return null;
  return new RoomPosition(posData.x, posData.y, posData.roomName);
}

var roleCombatArcher = {
  run: function (creep) {
    if (!creep) return;
    var flagName = _resolveFlagName(creep);
    if (!flagName) return;

    var squad = _squadBucket(flagName) || {};
    var members = squad.members || {};
    var leader = _resolveMember(members.leader);

    if (leader && leader.id === creep.id) {
      leader = null;
    }

    var rallyPos = squad.rally ? _deserializePos(squad.rally) : null;
    var state = CombatAPI.getSquadState(flagName);

    var targetId = CombatAPI.focusFireTarget(flagName);
    if (state === 'RETREAT') targetId = null;
    var target = targetId ? Game.getObjectById(targetId) : null;
    if (target) {
      if (creep.pos.inRangeTo(target, 3)) {
        creep.rangedAttack(target);
      } else {
        Traveler.travelTo(creep, target, { range: 3, ignoreCreeps: false });
      }
      return;
    }

    if (leader) {
      Traveler.travelTo(creep, leader, { range: 1, ignoreCreeps: false });
      return;
    }

    if (rallyPos) {
      Traveler.travelTo(creep, rallyPos, { range: 1, ignoreCreeps: false });
    }
  }
};

module.exports = roleCombatArcher;
