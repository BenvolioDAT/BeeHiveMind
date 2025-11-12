'use strict';

var Traveler = require('Traveler');
var CombatAPI = require('Combat.API');
var BeeSelectors = require('BeeSelectors');

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

function _nearestWounded(creep, flagName) {
  if (!flagName) return null;
  var wounded = [];
  for (var name in Game.creeps) {
    if (!Game.creeps.hasOwnProperty(name)) continue;
    var ally = Game.creeps[name];
    if (!ally || !ally.my || ally.id === creep.id) continue;
    if (!ally.memory) continue;
    var allyFlag = ally.memory.squadFlag;
    if (!allyFlag && ally.memory.squadId != null && ally.memory.squadId !== undefined) {
      allyFlag = 'Squad' + ally.memory.squadId;
    }
    if (allyFlag !== flagName) continue;
    if (ally.hits >= ally.hitsMax) continue;
    wounded.push(ally);
  }
  if (!wounded.length) return null;
  return BeeSelectors.findClosestByRange(creep.pos, wounded);
}

var roleCombatMedic = {
  run: function (creep) {
    if (!creep) return;
    var flagName = _resolveFlagName(creep);
    if (!flagName) return;

    var squad = _squadBucket(flagName) || {};
    var members = squad.members || {};
    var leader = _resolveMember(members.leader);
    var buddy = _resolveMember(members.buddy);
    if (leader && leader.id === creep.id) leader = null;
    if (buddy && buddy.id === creep.id) buddy = null;
    var rallyPos = squad.rally ? _deserializePos(squad.rally) : null;
    var state = CombatAPI.getSquadState(flagName);

    var healTarget = null;

    if (creep.hits < creep.hitsMax) healTarget = creep;
    else if (leader && leader.hits < leader.hitsMax) healTarget = leader;
    else if (buddy && buddy.hits < buddy.hitsMax) healTarget = buddy;
    else healTarget = _nearestWounded(creep, flagName);

    if (healTarget) {
      if (healTarget.id === creep.id) {
        creep.heal(creep);
      } else if (creep.pos.inRangeTo(healTarget, 1)) {
        creep.heal(healTarget);
      } else if (creep.pos.inRangeTo(healTarget, 3)) {
        creep.rangedHeal(healTarget);
      }
    }

    var moveTarget = null;
    if (leader) {
      if (creep.pos.getRangeTo(leader) > 2) moveTarget = leader;
    }
    if (!moveTarget && healTarget && healTarget.id !== creep.id && !creep.pos.inRangeTo(healTarget, 1)) {
      moveTarget = healTarget;
    }
    if (!moveTarget && buddy) {
      if (creep.pos.getRangeTo(buddy) > 2) moveTarget = buddy;
    }
    if (state === 'RETREAT' && rallyPos) {
      moveTarget = rallyPos;
    } else if (!moveTarget && rallyPos) {
      moveTarget = rallyPos;
    }

    if (moveTarget) {
      Traveler.travelTo(creep, moveTarget, { range: 1, ignoreCreeps: false });
    }
  }
};

module.exports = roleCombatMedic;
