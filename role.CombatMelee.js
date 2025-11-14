'use strict';

var Traveler = require('Traveler');
var BeeCombatSquads = require('BeeCombatSquads');
var CombatAPI = BeeCombatSquads.CombatAPI;
var SquadFlagIntel = BeeCombatSquads.SquadFlagIntel || null;

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

function _deserializePos(posData) {
  if (!posData || posData.x == null || posData.y == null || !posData.roomName) return null;
  return new RoomPosition(posData.x, posData.y, posData.roomName);
}

function _buildMeleeContext(creep) {
  var flagName = _resolveFlagName(creep);
  if (!flagName) return null;

  var squad = _squadBucket(flagName) || {};
  var plan = SquadFlagIntel && typeof SquadFlagIntel.resolvePlan === 'function'
    ? SquadFlagIntel.resolvePlan(flagName)
    : null;
  var rallyPos = null;
  if (plan && plan.rally) {
    rallyPos = _deserializePos(plan.rally);
  } else if (squad.rally) {
    rallyPos = _deserializePos(squad.rally);
  }
  return {
    flagName: flagName,
    plan: plan,
    rallyPos: rallyPos,
    state: CombatAPI.getSquadState(flagName)
  };
}

function _resolveMeleeTarget(context) {
  if (!context) return null;
  var targetId = CombatAPI.focusFireTarget(context.flagName);
  if (context.state === 'RETREAT') targetId = null;
  return targetId ? Game.getObjectById(targetId) : null;
}

function _swingOrAdvance(creep, target) {
  if (!target) return false;
  if (creep.pos.inRangeTo(target, 1)) {
    // Teaching habit: gate active-part checks so we avoid pointless intents if the
    // unit was partially dismantled.
    if (creep.getActiveBodyparts(ATTACK) > 0) creep.attack(target);
    if (creep.getActiveBodyparts(RANGED_ATTACK) > 0) creep.rangedAttack(target);
  } else {
    Traveler.travelTo(creep, target, { range: 1, ignoreCreeps: false });
  }
  return true;
}

function _fallbackToRally(creep, context) {
  if (context && context.rallyPos) {
    Traveler.travelTo(creep, context.rallyPos, { range: 1, ignoreCreeps: false });
  }
}

var roleCombatMelee = {
  run: function (creep) {
    if (!creep) return;

    var context = _buildMeleeContext(creep);
    if (!context) return;

    var target = _resolveMeleeTarget(context);
    if (!_swingOrAdvance(creep, target)) {
      _fallbackToRally(creep, context);
    }

    if (creep.hits < creep.hitsMax && creep.getActiveBodyparts(HEAL) > 0) {
      creep.heal(creep);
    }
  }
};

module.exports = roleCombatMelee;
