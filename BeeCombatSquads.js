'use strict';

/**
 * BeeCombatSquads owns the combat squad state machine and exports a CombatAPI
 * helper bundle (INIT → FORM → ENGAGE → RETREAT). Roles consume
 * BeeCombatSquads.CombatAPI to resolve shared formation, targets, and state
 * while this module continues to surface convenience lookups for legacy
 * callers.
 */

var CoreConfig = require('core.config');

var CombatAPI = (function () {
  var VALID_STATES = { INIT: true, FORM: true, ENGAGE: true, RETREAT: true };

  function _lower(str) {
    if (!str) return '';
    return String(str).toLowerCase();
  }

  function _ensureMem(flagName) {
    if (!flagName) return null;
    if (!Memory.squads) Memory.squads = {};
    var bucket = Memory.squads[flagName];
    if (!bucket) {
      bucket = {
        state: 'INIT',
        targetId: null,
        members: { leader: null, buddy: null, medic: null },
        rally: null,
        lastSeenTick: 0
      };
      Memory.squads[flagName] = bucket;
    } else {
      if (!bucket.members) bucket.members = { leader: null, buddy: null, medic: null };
      if (!bucket.state) bucket.state = 'INIT';
    }
    return bucket;
  }

  function _serializePos(pos) {
    if (!pos) return null;
    return { x: pos.x, y: pos.y, roomName: pos.roomName };
  }

  function _deserializePos(data) {
    if (!data || data.x == null || data.y == null || !data.roomName) return null;
    return new RoomPosition(data.x, data.y, data.roomName);
  }

  function _buildAvoidMap(extra) {
    var avoid = {};
    var allies = CoreConfig.ALLY_USERNAMES || [];
    for (var i = 0; i < allies.length; i++) {
      avoid[_lower(allies[i])] = true;
    }
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) {
          avoid[_lower(k)] = true;
        }
      }
    }
    return avoid;
  }

  function _currentCache() {
    if (!global.__combatApiCache || global.__combatApiCache.tick !== Game.time) {
      global.__combatApiCache = { tick: Game.time, focus: {} };
    }
    return global.__combatApiCache;
  }

  function _isAlly(owner, avoidMap) {
    if (!owner || !owner.username) return false;
    return avoidMap[_lower(owner.username)] === true;
  }

  function getSquadState(flagName) {
    var bucket = _ensureMem(flagName);
    return bucket ? bucket.state : 'INIT';
  }

  function setSquadState(flagName, state) {
    if (!VALID_STATES[state]) return;
    var bucket = _ensureMem(flagName);
    if (!bucket) return;
    bucket.state = state;
  }

  function _pickByRole(creeps, roleName, excludeId) {
    for (var i = 0; i < creeps.length; i++) {
      var c = creeps[i];
      if (!c || !c.memory) continue;
      if (excludeId && c.id === excludeId) continue;
      if (!roleName) return c;
      if (c.memory.role === roleName) return c;
    }
    return null;
  }

  function assignFormation(flagName, creepIdsArray) {
    var bucket = _ensureMem(flagName);
    var rallyPos = null;
    var flag = Game.flags && Game.flags[flagName] ? Game.flags[flagName] : null;
    if (flag && flag.pos) {
      bucket.rally = _serializePos(flag.pos);
      rallyPos = flag.pos;
      bucket.lastSeenTick = Game.time;
    } else if (bucket.rally) {
      rallyPos = _deserializePos(bucket.rally);
    }

    var creeps = [];
    var ids = [];
    if (creepIdsArray && creepIdsArray.length) {
      for (var i = 0; i < creepIdsArray.length; i++) {
        var id = creepIdsArray[i];
        var c = Game.getObjectById(id);
        if (!c) continue;
        creeps.push(c);
        ids.push(id);
      }
    }

    var leader = _pickByRole(creeps, 'CombatMelee', null) || creeps[0] || null;
    var leaderId = leader ? leader.id : null;
    var medic = _pickByRole(creeps, 'CombatMedic', leaderId);
    var buddy = _pickByRole(creeps, 'CombatArcher', leaderId);
    if (!buddy) {
      buddy = _pickByRole(creeps, null, leaderId);
      if (!buddy && creeps.length > 1) {
        buddy = (creeps[0] && creeps[0].id !== leaderId) ? creeps[0] : creeps[1];
      }
    }

    var medicId = medic ? medic.id : null;
    var buddyId = buddy ? buddy.id : null;

    bucket.members = {
      leader: leaderId,
      buddy: buddyId,
      medic: medicId
    };

    var result = {
      leaderId: leaderId,
      buddyId: buddyId,
      medicId: medicId,
      rallyPos: rallyPos || _deserializePos(bucket.rally)
    };

    return result;
  }

  function _scoreCreep(target, anchorPos) {
    if (!target) return -1000000;
    var score = 0;
    var heal = target.getActiveBodyparts ? target.getActiveBodyparts(HEAL) : 0;
    var ranged = target.getActiveBodyparts ? target.getActiveBodyparts(RANGED_ATTACK) : 0;
    var melee = target.getActiveBodyparts ? target.getActiveBodyparts(ATTACK) : 0;
    var tough = target.getActiveBodyparts ? target.getActiveBodyparts(TOUGH) : 0;
    score += heal * 600;
    score += ranged * 300;
    score += melee * 150;
    score -= tough * 25;
    score += (target.hitsMax || 0) - (target.hits || 0);
    if (anchorPos) score -= anchorPos.getRangeTo(target) * 5;
    return score;
  }

  function _scoreStructure(structure, anchorPos) {
    if (!structure) return -1000000;
    var score = 0;
    var type = structure.structureType || '';
    if (type === STRUCTURE_INVADER_CORE) score += 1200;
    if (type === STRUCTURE_TOWER) score += 800;
    if (type === STRUCTURE_SPAWN) score += 500;
    if (structure.hitsMax && structure.hits != null) {
      score += (structure.hitsMax - structure.hits);
    }
    if (anchorPos) score -= anchorPos.getRangeTo(structure) * 5;
    return score;
  }

  function getAttackTarget(room, avoidAlliesSet) {
    if (!room) return null;
    var avoid = _buildAvoidMap(avoidAlliesSet);
    var anchorPos = null;
    var myCreeps = room.find(FIND_MY_CREEPS);
    if (myCreeps && myCreeps.length) anchorPos = myCreeps[0].pos;
    if (!anchorPos && room.controller) anchorPos = room.controller.pos;
    if (!anchorPos) anchorPos = new RoomPosition(25, 25, room.name);

    var best = null;
    var bestScore = -1000000;

    var hostiles = room.find(FIND_HOSTILE_CREEPS, {
      filter: function (creep) {
        if (!creep || !creep.owner) return false;
        return !_isAlly(creep.owner, avoid);
      }
    });

    for (var i = 0; i < hostiles.length; i++) {
      var c = hostiles[i];
      var score = _scoreCreep(c, anchorPos);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }

    var hostileStructs = room.find(FIND_HOSTILE_STRUCTURES, {
      filter: function (s) {
        if (!s) return false;
        if (!s.owner || !s.owner.username) return true;
        return !_isAlly(s.owner, avoid);
      }
    });

    for (var j = 0; j < hostileStructs.length; j++) {
      var s = hostileStructs[j];
      var score2 = _scoreStructure(s, anchorPos);
      if (score2 > bestScore) {
        bestScore = score2;
        best = s;
      }
    }

    return best ? best.id : null;
  }

  function focusFireTarget(flagName) {
    if (!flagName) return null;
    var cache = _currentCache();
    if (cache.focus.hasOwnProperty(flagName)) {
      return cache.focus[flagName];
    }

    var bucket = _ensureMem(flagName);
    var currentId = bucket && bucket.targetId ? bucket.targetId : null;
    var currentObj = currentId ? Game.getObjectById(currentId) : null;

    var avoid = {};
    var formation = bucket && bucket.members ? bucket.members : null;
    var leader = formation && formation.leader ? Game.getObjectById(formation.leader) : null;
    var buddy = formation && formation.buddy ? Game.getObjectById(formation.buddy) : null;
    var medic = formation && formation.medic ? Game.getObjectById(formation.medic) : null;

    var room = null;
    var flag = Game.flags && Game.flags[flagName] ? Game.flags[flagName] : null;
    if (flag && flag.room) room = flag.room;
    if (!room && leader && leader.room) room = leader.room;
    if (!room && buddy && buddy.room) room = buddy.room;
    if (!room && medic && medic.room) room = medic.room;
    if (!room && currentObj && currentObj.room) room = currentObj.room;

    if (leader && leader.owner && leader.owner.username) avoid[leader.owner.username] = true;
    if (buddy && buddy.owner && buddy.owner.username) avoid[buddy.owner.username] = true;
    if (medic && medic.owner && medic.owner.username) avoid[medic.owner.username] = true;

    var nextId = null;
    if (room) {
      var pick = getAttackTarget(room, avoid);
      if (pick) {
        nextId = pick;
      }
      bucket.lastSeenTick = Game.time;
    }

    if (!nextId && currentObj) {
      nextId = currentObj.id;
    }

    bucket.targetId = nextId || null;
    cache.focus[flagName] = nextId || null;
    return nextId || null;
  }

  return {
    getSquadState: getSquadState,
    setSquadState: setSquadState,
    assignFormation: assignFormation,
    focusFireTarget: focusFireTarget,
    getAttackTarget: getAttackTarget
  };
})();

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
module.exports.CombatAPI = CombatAPI;
