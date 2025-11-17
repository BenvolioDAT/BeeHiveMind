'use strict';
var Traveler = require('Traveler');
var BeeCombatSquads = require('BeeCombatSquads');
var CombatAPI = BeeCombatSquads.CombatAPI;
var SquadFlagIntel = BeeCombatSquads.SquadFlagIntel || null;
var BeeSelectors = require('BeeSelectors');
var CoreLogger = require('core.logger');
var LOG_LEVEL = CoreLogger.LOG_LEVEL;

var combatLog = CoreLogger.createLogger('BeeArmy', LOG_LEVEL.DEBUG);

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

/**
 * _buildBaseContext stitches BeeCombatSquads + SquadFlagIntel together so
 * every combat creep sees a shared view of (flag, plan, rally/attack points,
 * squad memory, and FSM state).
 */
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

/**
 * _resolveFocusTarget defers to CombatAPI.focusFireTarget so all three combat
 * roles pursue the same hostile id. When the squad is retreating we ignore
 * that id so creeps focus on survival movement instead of re-engaging.
 */
function _resolveFocusTarget(context) {
  if (!context) return null;
  var targetId = CombatAPI.focusFireTarget(context.flagName);
  if (context.state === 'RETREAT') targetId = null;
  return targetId ? Game.getObjectById(targetId) : null;
}

// ---------------------------- Archer helpers -----------------------------

/**
 * _buildArcherContext extends the base bundle with a reference to the squad
 * leader (usually melee) so archers can kite around their escort/rally point.
 */
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

function _kiteOrClose(creep, target) {
  if (!target) return false;
  if (creep.pos.inRangeTo(target, 3)) {
    creep.rangedAttack(target);
  } else {
    creep.travelTo(target, { range: 3, ignoreCreeps: false });
  }
  return true;
}

function _followLeaderOrRally(creep, context) {
  if (!context) return;
  if (context.leader) {
    creep.travelTo(context.leader, { range: 1, ignoreCreeps: false });
    return;
  }
  if (context.rallyPos) {
    creep.travelTo(context.rallyPos, { range: 1, ignoreCreeps: false });
  }
}

// ----------------------------- Melee helpers -----------------------------

/**
 * _buildMeleeContext is identical to _buildBaseContext but split out to
 * mirror the archer/medic builders for symmetry + readability.
 */
function _buildMeleeContext(creep) {
  return _buildBaseContext(creep);
}

function _swingOrAdvance(creep, target) {
  if (!target) return false;
  if (creep.pos.inRangeTo(target, 1)) {
    if (creep.getActiveBodyparts(ATTACK) > 0) creep.attack(target);
    if (creep.getActiveBodyparts(RANGED_ATTACK) > 0) creep.rangedAttack(target);
  } else {
    creep.travelTo(target, { range: 1, ignoreCreeps: false });
  }
  return true;
}

function _fallbackToRally(creep, context) {
  if (context && context.rallyPos) {
    creep.travelTo(context.rallyPos, { range: 1, ignoreCreeps: false });
  }
}

// ----------------------------- Medic helpers -----------------------------

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

/**
 * _buildMedicContext gives medics the same shared state plus direct pointers
 * to the leader + buddy so heal movement stays glued to the front line.
 */
function _buildMedicContext(creep) {
  var base = _buildBaseContext(creep);
  if (!base) return null;
  var members = base.squad.members || {};
  var leader = _resolveMember(members.leader);
  var buddy = _resolveMember(members.buddy);
  if (leader && leader.id === creep.id) leader = null;
  if (buddy && buddy.id === creep.id) buddy = null;
  return {
    flagName: base.flagName,
    plan: base.plan,
    rallyPos: base.rallyPos,
    attackPos: base.attackPos,
    state: base.state,
    leader: leader,
    buddy: buddy
  };
}

function _selectHealTarget(creep, context) {
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

  if (context.state === 'RETREAT' && context.rallyPos) return context.rallyPos;
  if (context.state !== 'ENGAGE' && context.rallyPos) return context.rallyPos;

  if (context.state === 'ENGAGE' && context.attackPos) return context.attackPos;

  if (context.leader && creep.pos.getRangeTo(context.leader) > 2) return context.leader;

  if (
    healTarget &&
    healTarget.id !== creep.id &&
    !creep.pos.inRangeTo(healTarget, 1)
  ) {
    return healTarget;
  }

  if (context.buddy && creep.pos.getRangeTo(context.buddy) > 2) return context.buddy;

  if (context.rallyPos) return context.rallyPos;
  return null;
}

var roleBeeArmy = {
  runArcher: function (creep) {
    if (!creep) return;

    var context = _buildArcherContext(creep);
    if (!context) return;

    try {
      combatLog.debug(
        'Archer', creep.name,
        'state=', context.state,
        'flag=', context.flagName,
        'room=', creep.room ? creep.room.name : '(no room)'
      );
    } catch (e) {}

    // FORM → follow the leader/rally. ENGAGE → focusFire target via CombatAPI.
    if (context.state === 'RETREAT') {
      _followLeaderOrRally(creep, context);
      return;
    }

    if (context.state === 'ENGAGE') {
      var target = _resolveFocusTarget(context);
      if (!target) {
        try {
          combatLog.debug('Archer', creep.name, 'ENGAGE but no target', 'flag=', context.flagName);
        } catch (e) {}
      } else {
        try {
          combatLog.debug(
            'Archer', creep.name, 'attacking',
            'targetId=', target.id,
            'targetRoom=', target.pos.roomName
          );
        } catch (e) {}
      }
      if (_kiteOrClose(creep, target)) return;
      if (context.attackPos) {
        // march archers toward the squad's attack position even if no target is visible
        creep.travelTo(
          context.attackPos,
          { range: 3, ignoreCreeps: false }
        );
        return;
      }
    }

    _followLeaderOrRally(creep, context);
  },

  runMelee: function (creep) {
    if (!creep) return;

    var context = _buildMeleeContext(creep);
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
      _fallbackToRally(creep, context);
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
      if (!_swingOrAdvance(creep, target)) {
        if (context.attackPos) {
          // melee creeps advance on the stored attack position so they keep pressure on the hostile area
          creep.travelTo(
            context.attackPos,
            { range: 1, ignoreCreeps: false }
          );
        } else {
          _fallbackToRally(creep, context);
        }
      }
    } else {
      _fallbackToRally(creep, context);
    }

    if (creep.hits < creep.hitsMax && creep.getActiveBodyparts(HEAL) > 0) {
      creep.heal(creep);
    }
  },

  runMedic: function (creep) {
    if (!creep) return;

    var context = _buildMedicContext(creep);
    if (!context) return;

    var healTarget = _selectHealTarget(creep, context);
    _applyHealing(creep, healTarget);

    // Medics choose between rally/escort/attack positions based on squad state.
    var moveTarget = _pickMoveTarget(creep, context, healTarget);
    if (moveTarget) {
      creep.travelTo(moveTarget, { range: 1, ignoreCreeps: false });
    }
  },

  run: function (creep) {
    if (!creep || !creep.memory) return;

    try {
      combatLog.debug(
        '[tick', Game.time, '] BeeArmy.run',
        'creep=', creep.name,
        'role=', creep.memory.role,
        'room=', creep.room ? creep.room.name : '(no room)',
        'squadId=', creep.memory.squadId,
        'squadFlag=', _resolveFlagName ? _resolveFlagName(creep) : '(no resolver)'
      );
    } catch (e) {}
    switch (creep.memory.role) {
      case 'CombatArcher':
        return roleBeeArmy.runArcher(creep);
      case 'CombatMelee':
        return roleBeeArmy.runMelee(creep);
      case 'CombatMedic':
        return roleBeeArmy.runMedic(creep);
    }
  }
};

module.exports = roleBeeArmy;
