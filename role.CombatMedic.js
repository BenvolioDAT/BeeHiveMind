'use strict';

var Traveler = require('Traveler');
var BeeCombatSquads = require('BeeCombatSquads');
var CombatAPI = BeeCombatSquads.CombatAPI;
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

function _buildMedicContext(creep) {
  var flagName = _resolveFlagName(creep);
  if (!flagName) return null;

  var squad = _squadBucket(flagName) || {};
  var members = squad.members || {};
  var leader = _resolveMember(members.leader);
  var buddy = _resolveMember(members.buddy);
  if (leader && leader.id === creep.id) leader = null;
  if (buddy && buddy.id === creep.id) buddy = null;

  return {
    flagName: flagName,
    leader: leader,
    buddy: buddy,
    rallyPos: squad.rally ? _deserializePos(squad.rally) : null,
    state: CombatAPI.getSquadState(flagName)
  };
}

function _selectHealTarget(creep, context) {
  // Teaching habit: encode the priority list once, then use it everywhere so
  // future tweaks (ex: heal buddy before leader) happen in a single function.
  if (!context) return null;
  if (creep.hits < creep.hitsMax) return creep;
  if (context.leader && context.leader.hits < context.leader.hitsMax) return context.leader;
  if (context.buddy && context.buddy.hits < context.buddy.hitsMax) return context.buddy;
  return _nearestWounded(creep, context.flagName);
}

function _applyHealing(creep, target) {
  if (!target) return;
  if (target.id === creep.id) {
    creep.heal(creep);
  } else if (creep.pos.inRangeTo(target, 1)) {
    creep.heal(target);
  } else if (creep.pos.inRangeTo(target, 3)) {
    creep.rangedHeal(target);
  }
}

function _pickMoveTarget(creep, context, healTarget) {
  if (!context) return null;

  if (context.leader && creep.pos.getRangeTo(context.leader) > 2) return context.leader;

  if (
    healTarget &&
    healTarget.id !== creep.id &&
    !creep.pos.inRangeTo(healTarget, 1)
  ) {
    return healTarget;
  }

  if (context.buddy && creep.pos.getRangeTo(context.buddy) > 2) return context.buddy;

  if (context.state === 'RETREAT' && context.rallyPos) return context.rallyPos;
  if (context.rallyPos) return context.rallyPos;
  return null;
}

var roleCombatMedic = {
  run: function (creep) {
    if (!creep) return;

    var context = _buildMedicContext(creep);
    if (!context) return;

    var healTarget = _selectHealTarget(creep, context);
    _applyHealing(creep, healTarget);

    var moveTarget = _pickMoveTarget(creep, context, healTarget);
    if (moveTarget) {
      Traveler.travelTo(creep, moveTarget, { range: 1, ignoreCreeps: false });
    }
  }
};

module.exports = roleCombatMedic;
