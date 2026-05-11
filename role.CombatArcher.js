'use strict';
var Traveler = require('Traveler');
var BeeCombatSquads = require('BeeCombatSquads');
var CombatAPI = BeeCombatSquads.CombatAPI;
var SquadFlagIntel = BeeCombatSquads.SquadFlagIntel || null;
var MovementManager = require('Movement.Manager');
var CoreConfig = require('core.config');
var CoreLogger = require('core.logger');
var combatArcherLog = CoreLogger.createLogger('CombatArcher', CoreLogger.LOG_LEVEL.DEBUG);

function describeError(e) {
  return e && (e.stack || e.message || String(e));
}

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
    console.log('[CombatRole][Archer]', '[tick ' + Game.time + ']', creep.name, 'branch=' + branch, extra || '');
  } catch (e) {
    combatArcherLog.warnEvery('combatArcher.debugLog.console', 250, 'debug combat log failed for', creep && creep.name, describeError(e));
  }
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

function _resolveFocusTarget(context) {
  if (!context) return null;
  var targetId = CombatAPI.focusFireTarget(context.flagName);
  if (!targetId && context.state === 'ENGAGE' && CombatAPI.localFallbackTarget) {
    targetId = CombatAPI.localFallbackTarget(context.flagName, context.creep);
  }
  if (context.state === 'RETREAT') targetId = null;
  return targetId ? Game.getObjectById(targetId) : null;
}

function hasUsableTravelTarget(target) {
  var pos = target && (target.pos || target);
  return !!(pos && typeof pos.x === 'number' && typeof pos.y === 'number' && pos.roomName);
}

function isManagerRequestHandled(result) {
  return result === OK || (typeof result === 'number' && result > OK);
}

function _requestMove(creep, target, range, intentType) {
  if (!creep || !target) return;
  var opts = { range: range, ignoreCreeps: false, reusePath: 10, intentType: intentType || 'combat' };
  if (MovementManager && typeof MovementManager.request === 'function') {
    var requestResult = MovementManager.request(creep, target, null, opts);

    // Request contract:
    // - OK: manager accepted/replaced intent; no direct fallback.
    // - numeric > OK: manager kept existing higher/equal-priority intent; no fallback.
    // - ERR_INVALID_ARGS: malformed request; guarded fail-open fallback only for usable target.
    // - any other value: no fallback.
    if (isManagerRequestHandled(requestResult)) return requestResult;

    if (requestResult === ERR_INVALID_ARGS) {
      if (creep && typeof creep.travelTo === 'function' && hasUsableTravelTarget(target)) {
        return creep.travelTo(target, { range: range, ignoreCreeps: false });
      }
    }
    return requestResult;
  }
  // Manager unavailable: do not direct-fallback here; preserve manager arbitration discipline.
  return ERR_INVALID_ARGS;
}

function _hostileNearby(creep, range) {
  if (!creep || !creep.room || !creep.room.find) return false;
  var near = creep.pos.findInRange(FIND_HOSTILE_CREEPS, typeof range === 'number' ? range : 6);
  return near && near.length > 0;
}

function _buildArcherContext(creep) {
  var base = _buildBaseContext(creep);
  if (!base) return null;
  var members = base.squad.members || {};
  var leader = _resolveMember(members.leader);
  if (!leader) leader = _resolveMember(members.buddy);
  if (!leader) leader = _resolveMember(members.medic);
  var memberIds = base.squad.memberIds || [];
  for (var i = 0; !leader && i < memberIds.length; i++) {
    var fallback = _resolveMember(memberIds[i]);
    if (!fallback || fallback.id === creep.id) continue;
    leader = fallback;
  }
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
    context.creep = creep;
    context.readiness = CombatAPI.getSquadReadiness ? CombatAPI.getSquadReadiness(context.flagName) : null;

    try {
      var combatLog = require('core.logger').createLogger('BeeArmy', require('core.logger').LOG_LEVEL.DEBUG);
      combatLog.debug(
        'Archer', creep.name,
        'state=', context.state,
        'flag=', context.flagName,
        'room=', creep.room ? creep.room.name : '(no room)'
      );
    } catch (e) {
      combatArcherLog.warnEvery('combatArcher.run.stateSnapshot', 250, 'state snapshot log failed for', creep && creep.name, describeError(e));
    }

    if (context.state === 'RETREAT') {
      _debugSay(creep, 'RETREAT');
      _debugLog(creep, 'RETREAT', 'flag=' + context.flagName);
      if (context.leader) {
        _requestMove(creep, context.leader, 1, 'combat');
      } else if (context.rallyPos) {
        _requestMove(creep, context.rallyPos, 1, 'combat');
      }
      return;
    }

    if (context.state === 'ENGAGE') {
      if (context.readiness && !context.readiness.hasEngagedOnce && !context.readiness.initialPushReady) {
        _debugSay(creep, 'WAIT_SYNC');
        _debugLog(creep, 'WAIT_SYNC', 'flag=' + context.flagName);
        if (context.leader) _requestMove(creep, context.leader, 1, 'combat');
        else if (context.rallyPos) _requestMove(creep, context.rallyPos, 1, 'combat');
        return;
      }
      if (context.readiness && context.readiness.needsRegroup) {
        _debugSay(creep, 'REGROUP');
        _debugLog(creep, 'REGROUP', 'flag=' + context.flagName + ' gathered=' + context.readiness.gathered + '/' + context.readiness.requiredGathered);
        if (context.leader) _requestMove(creep, context.leader, 1, 'combat');
        else if (context.rallyPos) _requestMove(creep, context.rallyPos, 1, 'combat');
        return;
      }
      var target = _resolveFocusTarget(context);
      if (!target) {
        var roomHostiles = creep.room && creep.room.find ? (creep.room.find(FIND_HOSTILE_CREEPS) || []) : [];
        var sawSK = false;
        for (var si = 0; si < roomHostiles.length; si++) {
          var hc = roomHostiles[si];
          if (hc && hc.owner && hc.owner.username && String(hc.owner.username).toLowerCase() === 'source keeper') {
            sawSK = true;
            break;
          }
        }
        if (sawSK) _debugSay(creep, 'SEES_SK');
        else if (roomHostiles.length > 0) _debugSay(creep, 'SKIP');
        else _debugSay(creep, 'NO_TGT');
        _debugLog(creep, 'NO_TGT', 'hostiles=' + roomHostiles.length + ' seesSK=' + (sawSK ? 1 : 0));
        try {
          var logNoTarget = require('core.logger').createLogger('BeeArmy', require('core.logger').LOG_LEVEL.DEBUG);
          logNoTarget.debug('Archer', creep.name, 'ENGAGE but no target', 'flag=', context.flagName);
        } catch (e) {
          combatArcherLog.warnEvery('combatArcher.run.noTargetLog', 250, 'no-target debug log failed for', creep && creep.name, describeError(e));
        }
      } else {
        try {
          var combatLogAttack = require('core.logger').createLogger('BeeArmy', require('core.logger').LOG_LEVEL.DEBUG);
          combatLogAttack.debug(
            'Archer', creep.name, 'attacking',
            'targetId=', target.id,
            'targetRoom=', target.pos.roomName
          );
        } catch (e) {
          combatArcherLog.warnEvery('combatArcher.run.attackLog', 250, 'attack debug log failed for', creep && creep.name, describeError(e));
        }
      }

      if (target) {
        if (creep.pos.inRangeTo(target, 3)) {
          _debugSay(creep, 'ATTACK');
          _debugLog(creep, 'ATTACK', 'target=' + target.id);
          creep.rangedAttack(target);
          return;
        }
        _debugSay(creep, 'PUSH');
        _debugLog(creep, 'PUSH', 'target=' + target.id);
        _requestMove(creep, target, 3, 'combat');
        return;
      }

      if (context.attackPos) {
        _debugSay(creep, 'PATH');
        _debugLog(creep, 'PATH', 'attackPos=' + context.attackPos.roomName + ':' + context.attackPos.x + ',' + context.attackPos.y);
        _requestMove(creep, context.attackPos, 3, 'combat');
        return;
      }
    }

    var holdToken = 'HOLD';
    if (context.readiness && !context.readiness.hasEngagedOnce && !context.readiness.initialPushReady) holdToken = 'WAIT_SYNC';
    else if (context.readiness && !context.readiness.waitElapsed) holdToken = 'WAIT_TIME';
    else if (context.readiness && !context.readiness.hasCoreRoles) holdToken = 'WAIT_MED';
    else if (context.readiness && !context.readiness.gatheredEnough) holdToken = 'WAIT_FORM';
    _debugSay(creep, holdToken);
    _debugLog(creep, holdToken, 'flag=' + context.flagName);
    if (context.leader) {
      if (_hostileNearby(creep, 6)) {
        _debugSay(creep, 'REGROUP');
        _debugLog(creep, 'REGROUP', 'survival=1');
      }
      _requestMove(creep, context.leader, 1, 'combat');
    } else if (context.rallyPos) {
      _requestMove(creep, context.rallyPos, 1, 'combat');
    } else if (context.attackPos && context.state === 'ENGAGE') {
      _debugSay(creep, 'PATH');
      _requestMove(creep, context.attackPos, 3, 'combat');
    }
  }
};
