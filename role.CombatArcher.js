'use strict';

var Traveler = require('Traveler');
var BeeCombatSquads = require('BeeCombatSquads');
var CombatAPI = BeeCombatSquads.CombatAPI;

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

function _buildSquadContext(creep) {
  // Novice tip: collapsing all of the bookkeeping into a single helper keeps the
  // main run loop focused on the tactical decisions instead of guard clauses.
  var flagName = _resolveFlagName(creep);
  if (!flagName) return null;

  var squad = _squadBucket(flagName) || {};
  var members = squad.members || {};
  var leader = _resolveMember(members.leader);
  if (leader && leader.id === creep.id) leader = null; // Don't chase ourselves.

  return {
    flagName: flagName,
    squad: squad,
    leader: leader,
    rallyPos: squad.rally ? _deserializePos(squad.rally) : null,
    state: CombatAPI.getSquadState(flagName)
  };
}

function _resolveFocusTarget(context) {
  // When squads retreat we intentionally clear the shared focus target so no
  // one tunnels on a fight while falling back.
  if (!context) return null;
  var targetId = CombatAPI.focusFireTarget(context.flagName);
  if (context.state === 'RETREAT') targetId = null;
  return targetId ? Game.getObjectById(targetId) : null;
}

function _kiteOrClose(creep, target) {
  // Archers excel at ranged damage, so we hover at range 3 whenever possible
  // and only close the distance when pathing requires it.
  if (!target) return false;
  if (creep.pos.inRangeTo(target, 3)) {
    creep.rangedAttack(target);
  } else {
    Traveler.travelTo(creep, target, { range: 3, ignoreCreeps: false });
  }
  return true;
}

function _followLeaderOrRally(creep, context) {
  if (!context) return;
  if (context.leader) {
    Traveler.travelTo(creep, context.leader, { range: 1, ignoreCreeps: false });
    return;
  }
  if (context.rallyPos) {
    Traveler.travelTo(creep, context.rallyPos, { range: 1, ignoreCreeps: false });
  }
}

var roleCombatArcher = {
  run: function (creep) {
    if (!creep) return;

    var context = _buildSquadContext(creep);
    if (!context) return; // Missing flag/squad info means we patiently idle.

    var target = _resolveFocusTarget(context);
    if (_kiteOrClose(creep, target)) return;

    // No priority target? Default to disciplined formation play.
    _followLeaderOrRally(creep, context);
  }
};

module.exports = roleCombatArcher;
