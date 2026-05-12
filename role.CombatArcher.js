'use strict';
var Traveler = require('Traveler');
var BeeCombatSquads = require('BeeCombatSquads');
var CombatAPI = BeeCombatSquads.CombatAPI;
var SquadFlagIntel = BeeCombatSquads.SquadFlagIntel || null;

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

function _resolveMember(id) {
  if (!id) return null;
  return Game.getObjectById(id);
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
  var plan = SquadFlagIntel && typeof SquadFlagIntel.resolvePlan === 'function'
    ? SquadFlagIntel.resolvePlan(flagName)
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

function _buildArcherContext(creep) {
  var base = _buildBaseContext(creep);
  if (!base) return null;
  var members = base.squad.members || {};
  var leader = _resolveMember(members.leader);
  if (leader && leader.id === creep.id) leader = null;
  return {
    flagName: base.flagName,
    squad: base.squad,
    plan: base.plan,
    rallyPos: base.rallyPos,
    attackPos: base.attackPos,
    state: base.state,
    leader: leader
  };
}

module.exports = {
  role: 'CombatArcher',
  run: function (creep) {
    if (!creep) return;

    var context = _buildArcherContext(creep);
    if (!context) return;

    try {
      var combatLog = require('core.logger').createLogger('BeeArmy', require('core.logger').LOG_LEVEL.DEBUG);
      combatLog.debug(
        'Archer', creep.name,
        'state=', context.state,
        'flag=', context.flagName,
        'room=', creep.room ? creep.room.name : '(no room)'
      );
    } catch (e) {}

    if (context.state === 'RETREAT') {
      if (context.leader) {
        creep.travelTo(context.leader, { range: 1, ignoreCreeps: false });
      } else if (context.rallyPos) {
        creep.travelTo(context.rallyPos, { range: 1, ignoreCreeps: false });
      }
      return;
    }

    if (context.state === 'ENGAGE') {
      var target = _resolveFocusTarget(context);
      if (!target) {
        try {
          var logNoTarget = require('core.logger').createLogger('BeeArmy', require('core.logger').LOG_LEVEL.DEBUG);
          logNoTarget.debug('Archer', creep.name, 'ENGAGE but no target', 'flag=', context.flagName);
        } catch (e) {}
      } else {
        try {
          var combatLogAttack = require('core.logger').createLogger('BeeArmy', require('core.logger').LOG_LEVEL.DEBUG);
          combatLogAttack.debug(
            'Archer', creep.name, 'attacking',
            'targetId=', target.id,
            'targetRoom=', target.pos.roomName
          );
        } catch (e) {}
      }

      if (target) {
        if (creep.pos.inRangeTo(target, 3)) {
          creep.rangedAttack(target);
          return;
        }
        creep.travelTo(target, { range: 3, ignoreCreeps: false });
        return;
      }

      if (context.attackPos) {
        creep.travelTo(
          context.attackPos,
          { range: 3, ignoreCreeps: false }
        );
        return;
      }
    }

    if (context.leader) {
      creep.travelTo(context.leader, { range: 1, ignoreCreeps: false });
    } else if (context.rallyPos) {
      creep.travelTo(context.rallyPos, { range: 1, ignoreCreeps: false });
    }
  }
};
