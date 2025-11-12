'use strict';

var CombatAPI = require('Combat.API');

var BeeCombatSquads = (function () {
  function _cacheRoot() {
    if (!global.__beeSquadCache || global.__beeSquadCache.tick !== Game.time) {
      global.__beeSquadCache = { tick: Game.time, byFlag: {} };
      _rebuildCache(global.__beeSquadCache.byFlag);
    }
    return global.__beeSquadCache;
  }

  function _resolveFlagName(creep) {
    if (!creep || !creep.memory) return null;
    if (creep.memory.squadFlag) return creep.memory.squadFlag;
    var sid = creep.memory.squadId;
    if (!sid) return null;
    return 'Squad' + sid;
  }

  function _collectCreeps() {
    var byFlag = {};
    for (var name in Game.creeps) {
      if (!Game.creeps.hasOwnProperty(name)) continue;
      var creep = Game.creeps[name];
      if (!creep || !creep.my) continue;
      var flagName = _resolveFlagName(creep);
      if (!flagName) continue;
      creep.memory.squadFlag = flagName;
      if (!byFlag[flagName]) byFlag[flagName] = [];
      byFlag[flagName].push(creep.id);
    }
    return byFlag;
  }

  function _decideState(flagName, creepIds, targetId) {
    if (!creepIds || !creepIds.length) return 'INIT';
    for (var i = 0; i < creepIds.length; i++) {
      var c = Game.getObjectById(creepIds[i]);
      if (!c) continue;
      if (c.hits < (c.hitsMax || 1) * 0.35) return 'RETREAT';
    }
    if (targetId) return 'ENGAGE';
    return 'FORM';
  }

  function _assignRecord(flagName, creepIds) {
    var ids = creepIds || [];
    var formation = CombatAPI.assignFormation(flagName, ids);
    var targetId = CombatAPI.focusFireTarget(flagName);
    var state = _decideState(flagName, ids, targetId);
    CombatAPI.setSquadState(flagName, state);

    var rally = null;
    if (formation && formation.rallyPos) rally = formation.rallyPos;
    var leader = formation && formation.leaderId ? Game.getObjectById(formation.leaderId) : null;
    var buddy = formation && formation.buddyId ? Game.getObjectById(formation.buddyId) : null;
    var medic = formation && formation.medicId ? Game.getObjectById(formation.medicId) : null;

    var mem = Memory.squads ? Memory.squads[flagName] : null;
    if (mem) {
      mem.lastSeenTick = Game.time;
      mem.members = mem.members || { leader: null, buddy: null, medic: null };
      mem.members.leader = formation.leaderId || null;
      mem.members.buddy = formation.buddyId || null;
      mem.members.medic = formation.medicId || null;
      if (rally) {
        mem.rally = { x: rally.x, y: rally.y, roomName: rally.roomName };
      }
      mem.targetId = targetId || null;
      mem.state = state;
    }

    return {
      flagName: flagName,
      state: state,
      leaderId: formation.leaderId || null,
      buddyId: formation.buddyId || null,
      medicId: formation.medicId || null,
      leader: leader,
      buddy: buddy,
      medic: medic,
      rallyPos: rally,
      targetId: targetId || null,
      creepIds: ids.slice()
    };
  }

  function _rebuildCache(store) {
    var creepsByFlag = _collectCreeps();
    for (var flagName in creepsByFlag) {
      if (!creepsByFlag.hasOwnProperty(flagName)) continue;
      store[flagName] = _assignRecord(flagName, creepsByFlag[flagName]);
    }

    for (var fname in Game.flags) {
      if (!Game.flags.hasOwnProperty(fname)) continue;
      if (store[fname]) continue;
      if (fname.indexOf('Squad') !== 0) continue;
      store[fname] = _assignRecord(fname, []);
    }
  }

  function _getRecord(flagName) {
    if (!flagName) return null;
    var cache = _cacheRoot();
    return cache.byFlag[flagName] || null;
  }

  function resolveCreep(creep) {
    var flagName = _resolveFlagName(creep);
    if (!flagName) return null;
    var record = _getRecord(flagName);
    if (!record) {
      record = _assignRecord(flagName, []);
      var cache = _cacheRoot();
      cache.byFlag[flagName] = record;
    }
    return {
      flagName: flagName,
      info: record
    };
  }

  function getSquadInfo(flagName) {
    return _getRecord(flagName);
  }

  function sharedTarget(creep) {
    var ctx = resolveCreep(creep);
    if (!ctx || !ctx.info || !ctx.info.targetId) return null;
    return Game.getObjectById(ctx.info.targetId);
  }

  function getAnchor(creep) {
    var ctx = resolveCreep(creep);
    if (!ctx || !ctx.info) return null;
    return ctx.info.rallyPos || null;
  }

  return {
    resolveCreep: resolveCreep,
    getSquadInfo: getSquadInfo,
    sharedTarget: sharedTarget,
    getAnchor: getAnchor,
    getSquadState: function (flagName) { return CombatAPI.getSquadState(flagName); }
  };
})();

module.exports = BeeCombatSquads;
