'use strict';

/**
 * Combat.API.js centralizes squad state, formation assignment, and shared target
 * selection for Bee combat roles. The lightweight state machine is intentionally
 * documented here (INIT → FORM → ENGAGE → RETREAT) so future maintainers know
 * how SquadFlagManager seeds rally intents, BeeCombatSquads persists membership,
 * and each role consumes the resolved focus target every tick.
 *
 *  - INIT: squad has no active members; roles idle at rally until formation.
 *  - FORM: members are assembling at the rally point with no hostile target.
 *  - ENGAGE: a shared hostile exists; damage roles close while medics support.
 *  - RETREAT: any member is critically injured; all roles fall back to rally.
 *
 * These helpers are ES5-only so they can run inside the Screeps runtime without
 * transpilation.
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

module.exports = CombatAPI;
