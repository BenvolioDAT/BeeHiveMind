'use strict';

var Traveler = require('Traveler');
var BeeCombatSquads = require('BeeCombatSquads');
var BeeSelectors = require('BeeSelectors');
var CombatAPI = BeeCombatSquads.CombatAPI;
var SquadFlagIntel = BeeCombatSquads.SquadFlagIntel || null;
var MovementManager = require('Movement.Manager');
var CoreConfig = require('core.config');

function _combatDebugSettings() {
  var cfg = (CoreConfig.settings && CoreConfig.settings.combat) || {};
  return { state: cfg.DEBUG_COMBAT_STATE === true, say: cfg.DEBUG_COMBAT_SAY === true };
}

function _debugSay(creep, token) {
  if (!creep || !token) return;
  var dbg = _combatDebugSettings();
  if (!dbg.say) return;
  if (!creep.memory) creep.memory = {};
  if (creep.memory._combatSayTick === Game.time) return;
  if (creep.memory._combatSay === token) return;
  creep.memory._combatSay = token;
  creep.memory._combatSayTick = Game.time;
  creep.say(token, true);
}

function _debugLog(creep, branch, extra, interval) {
  if (!_combatDebugSettings().state) return;
  if (!creep || !creep.memory) return;
  var every = typeof interval === 'number' ? interval : 5;
  var sig = String(branch || 'NA') + '|' + String(extra || '');
  if (creep.memory._combatLogSig !== sig) {
    creep.memory._combatLogSig = sig;
    creep.memory._combatLogTick = Game.time;
  } else if ((Game.time - (creep.memory._combatLogTick || 0)) < every) {
    return;
  } else {
    creep.memory._combatLogTick = Game.time;
  }
  try {
    console.log('[CombatRole][Medic]', '[tick ' + Game.time + ']', creep.name, 'branch=' + branch, extra || '');
  } catch (e) {}
}

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
  if (!leader) leader = buddy;
  if (!buddy) buddy = _resolveMember(members.medic);
  var memberIds = base.squad.memberIds || [];
  for (var i = 0; !leader && i < memberIds.length; i++) {
    var fallbackLeader = _resolveMember(memberIds[i]);
    if (!fallbackLeader || fallbackLeader.id === creep.id) continue;
    leader = fallbackLeader;
  }
  for (i = 0; !buddy && i < memberIds.length; i++) {
    var fallbackBuddy = _resolveMember(memberIds[i]);
    if (!fallbackBuddy || fallbackBuddy.id === creep.id) continue;
    buddy = fallbackBuddy;
  }
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

function _requestMove(creep, target, range, intentType) {
  if (!creep || !target) return;
  var opts = { range: range, ignoreCreeps: false, reusePath: 10, intentType: intentType || 'combat' };
  if (MovementManager && typeof MovementManager.request === 'function') {
    var rc = MovementManager.request(creep, target, null, opts);
    if (rc === OK || (typeof rc === 'number' && rc > OK)) return;
  }
  creep.travelTo(target, { range: range, ignoreCreeps: false });
}

function _selectHealTarget(creep, context) {
  if (!context) return null;
  if (creep.hits < creep.hitsMax) return creep;
  if (context.leader && context.leader.hits < context.leader.hitsMax) return context.leader;
  if (context.buddy && context.buddy.hits < context.buddy.hitsMax) return context.buddy;
  return _nearestWounded(creep, context.flagName);
}

function _applyHealing(creep, target) {
  if (!target) return false;
  if (target.id === creep.id) {
    creep.heal(creep);
    return true;
  } else if (creep.pos.inRangeTo(target, 1)) {
    creep.heal(target);
    return true;
  } else if (creep.pos.inRangeTo(target, 3)) {
    creep.rangedHeal(target);
    return true;
  }
  return false;
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

  if (context.state === 'ENGAGE' && context.attackPos) return context.attackPos;

  if (context.rallyPos) return context.rallyPos;
  return null;
}

module.exports = {
  role: 'CombatMedic',

  run: function (creep) {
    if (!creep) return;

    var context = _buildMedicContext(creep);
    if (!context) return;
    context.readiness = CombatAPI.getSquadReadiness ? CombatAPI.getSquadReadiness(context.flagName) : null;

    var healTarget = _selectHealTarget(creep, context);
    var didHeal = _applyHealing(creep, healTarget);
    if (didHeal) {
      _debugSay(creep, 'HEAL');
      _debugLog(creep, 'HEAL', 'target=' + (healTarget ? healTarget.id : 'null'));
    }

    if (context.readiness && context.readiness.needsRegroup && context.leader) {
      _debugSay(creep, 'REGROUP');
      _debugLog(creep, 'REGROUP', 'flag=' + context.flagName + ' leader=' + context.leader.id);
      _requestMove(creep, context.leader, 1, 'combat');
      return;
    }

    var holdToken = 'HOLD';
    if (context.state === 'RETREAT') holdToken = 'RETREAT';
    else if (context.readiness && !context.readiness.waitElapsed) holdToken = 'WAIT_TIME';
    else if (context.readiness && !context.readiness.hasCoreRoles) holdToken = 'WAIT_MED';
    else if (context.readiness && !context.readiness.gatheredEnough) holdToken = 'WAIT_FORM';
    _debugSay(creep, holdToken);
    _debugLog(creep, holdToken, 'flag=' + context.flagName + ' state=' + context.state);

    var moveTarget = _pickMoveTarget(creep, context, healTarget);
    if (moveTarget) {
      _debugSay(creep, 'PATH');
      _debugLog(creep, 'PATH', 'toward=' + (moveTarget.id || (moveTarget.roomName + ':' + moveTarget.x + ',' + moveTarget.y)));
      _requestMove(creep, moveTarget, 1, 'combat');
    }
  }
};
