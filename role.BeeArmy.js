'use strict';

var Traveler = require('Traveler');
var BeeCombatSquads = require('BeeCombatSquads');
var CombatAPI = BeeCombatSquads.CombatAPI;
var SquadFlagIntel = BeeCombatSquads.SquadFlagIntel || null;
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

  return {
    flagName: flagName,
    squad: squad,
    plan: plan,
    rallyPos: rallyPos,
    state: CombatAPI.getSquadState(flagName)
  };
}

function _resolveFocusTarget(context) {
  if (!context) return null;
  var targetId = CombatAPI.focusFireTarget(context.flagName);
  if (context.state === 'RETREAT') targetId = null;
  return targetId ? Game.getObjectById(targetId) : null;
}

// ---------------------------- Archer helpers -----------------------------

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
    state: base.state,
    leader: leader
  };
}

function _kiteOrClose(creep, target) {
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

// ----------------------------- Melee helpers -----------------------------

function _buildMeleeContext(creep) {
  return _buildBaseContext(creep);
}

function _swingOrAdvance(creep, target) {
  if (!target) return false;
  if (creep.pos.inRangeTo(target, 1)) {
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

    if (context.state === 'RETREAT') {
      _followLeaderOrRally(creep, context);
      return;
    }

    if (context.state === 'ENGAGE') {
      var target = _resolveFocusTarget(context);
      if (_kiteOrClose(creep, target)) return;
    }

    _followLeaderOrRally(creep, context);
  },

  runMelee: function (creep) {
    if (!creep) return;

    var context = _buildMeleeContext(creep);
    if (!context) return;

    if (context.state === 'RETREAT') {
      _fallbackToRally(creep, context);
    } else if (context.state === 'ENGAGE') {
      var target = _resolveFocusTarget(context);
      if (!_swingOrAdvance(creep, target)) {
        _fallbackToRally(creep, context);
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

    var moveTarget = _pickMoveTarget(creep, context, healTarget);
    if (moveTarget) {
      Traveler.travelTo(creep, moveTarget, { range: 1, ignoreCreeps: false });
    }
  },

  run: function (creep) {
    if (!creep || !creep.memory) return;
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
