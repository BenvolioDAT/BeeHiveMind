'use strict';

var Traveler = require('Traveler');
var BeeCombatSquads = require('BeeCombatSquads');
var CombatAPI = BeeCombatSquads.CombatAPI;
var CoreLogger = require('core.logger');

var LOG_LEVEL = CoreLogger.LOG_LEVEL;
var combatLog = CoreLogger.createLogger('CombatMelee', LOG_LEVEL.DEBUG);

function _resolveFlagName(creep) {
  if (!creep || !creep.memory) return null;
  if (creep.memory.squadFlag) return creep.memory.squadFlag;
  if (creep.memory.squadId != null && creep.memory.squadId !== undefined) {
    var sid = creep.memory.squadId;
    if (typeof sid === 'string' && sid.indexOf('Squad') === 0) {
      return sid;
    }
    return 'Squad' + sid;
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

function _resolveAttackPos(plan, squad) {
  if (plan && plan.attack) {
    var attackFromPlan = _deserializePos(plan.attack);
    if (attackFromPlan) return attackFromPlan;
  }
  if (squad) {
    var attackKeys = ['targetPos', 'focusTargetPos', 'attack', 'target'];
    for (var i = 0; i < attackKeys.length; i++) {
      if (!squad[attackKeys[i]]) continue;
      var attackFromMem = _deserializePos(squad[attackKeys[i]]);
      if (attackFromMem) return attackFromMem;
    }
  }
  return null;
}

function _buildBaseContext(creep) {
  var flagName = _resolveFlagName(creep);
  if (!flagName) return null;

  var squad = _squadBucket(flagName) || {};
  var plan = BeeCombatSquads.SquadFlagIntel && typeof BeeCombatSquads.SquadFlagIntel.resolvePlan === 'function'
    ? BeeCombatSquads.SquadFlagIntel.resolvePlan(flagName)
    : null;
  var rallyPos = null;
  if (plan && plan.rally) {
    rallyPos = _deserializePos(plan.rally);
  } else if (squad.rally) {
    rallyPos = _deserializePos(squad.rally);
  }
  var attackPos = _resolveAttackPos(plan, squad);

  return {
    flagName: flagName,
    squad: squad,
    plan: plan,
    rallyPos: rallyPos,
    attackPos: attackPos,
    state: CombatAPI.getSquadState(flagName)
  };
}

function _resolveFocusTarget(context) {
  if (!context) return null;
  var targetId = CombatAPI.focusFireTarget(context.flagName);
  if (context.state === 'RETREAT') targetId = null;
  return targetId ? Game.getObjectById(targetId) : null;
}

module.exports = {
  role: 'CombatMelee',

  run: function (creep) {
    if (!creep) return;

    var context = _buildBaseContext(creep);
    if (!context) return;

    try {
      combatLog.debug(
        'Melee', creep.name,
        'state=', context.state,
        'flag=', context.flagName,
        'room=', creep.room ? creep.room.name : '(no room)'
      );
    } catch (e) {}

    // Melee rally until ENGAGE, then advance + attack the shared focus target.
    if (context.state === 'RETREAT') {
      if (context.rallyPos) {
        creep.travelTo(context.rallyPos, { range: 1, ignoreCreeps: false });
      }
    } else if (context.state === 'ENGAGE') {
      var target = _resolveFocusTarget(context);
      if (!target) {
        try {
          combatLog.debug('Melee', creep.name, 'ENGAGE but no target', 'flag=', context.flagName);
        } catch (e) {}
      } else {
        try {
          combatLog.debug(
            'Melee', creep.name, 'attacking',
            'targetId=', target.id,
            'targetRoom=', target.pos.roomName
          );
        } catch (e) {}
      }
      if (target) {
        if (creep.pos.inRangeTo(target, 1)) {
          if (creep.getActiveBodyparts(ATTACK) > 0) creep.attack(target);
          if (creep.getActiveBodyparts(RANGED_ATTACK) > 0) creep.rangedAttack(target);
        } else {
          creep.travelTo(target, { range: 1, ignoreCreeps: false });
        }
      } else if (context.attackPos) {
        // melee creeps advance on the stored attack position so they keep pressure on the hostile area
        creep.travelTo(
          context.attackPos,
          { range: 1, ignoreCreeps: false }
        );
      } else if (context.rallyPos) {
        creep.travelTo(context.rallyPos, { range: 1, ignoreCreeps: false });
      }
    } else {
      if (context.rallyPos) {
        creep.travelTo(context.rallyPos, { range: 1, ignoreCreeps: false });
      }
    }

    if (creep.hits < creep.hitsMax && creep.getActiveBodyparts(HEAL) > 0) {
      creep.heal(creep);
    }
  }
};
