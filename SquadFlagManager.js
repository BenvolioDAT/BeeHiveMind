'use strict';

var BeeCombatSquads = require('BeeCombatSquads');
var CombatAPI = BeeCombatSquads.CombatAPI;

var SquadFlagManager = (function () {
  var CFG = {
    DEBUG: false,
    SUPPORT_PREFIX: 'SQUAD_',
    TYPES: {
      RALLY: { color: COLOR_GREEN, secondary: COLOR_WHITE },
      ATTACK: { color: COLOR_RED, secondary: COLOR_WHITE },
      RETREAT: { color: COLOR_YELLOW, secondary: COLOR_WHITE },
      WAYPOINT: { color: COLOR_BLUE, secondary: COLOR_WHITE }
    }
  };

  function _logDebug() {
    if (!CFG.DEBUG || !console || !console.log) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift('[SquadFlagManager]');
    console.log.apply(console, args);
  }

  function _isSupportFlag(name) {
    if (!name) return false;
    return name.indexOf(CFG.SUPPORT_PREFIX) === 0;
  }

  function _isSquadFlag(name) {
    if (!name) return false;
    if (_isSupportFlag(name)) return false;
    return name.indexOf('Squad') === 0;
  }

  function _ensureMem() {
    if (!Memory.squadFlags) Memory.squadFlags = { rooms: {}, bindings: {} };
    if (!Memory.squadFlags.rooms) Memory.squadFlags.rooms = {};
    if (!Memory.squadFlags.bindings) Memory.squadFlags.bindings = {};
    return Memory.squadFlags;
  }

  function _updateRoomRecord(mem, flag, room, threatScore, sawThreat) {
    if (!flag || !flag.pos) return;
    var roomName = flag.pos.roomName;
    if (!mem.rooms[roomName]) {
      mem.rooms[roomName] = { lastSeen: 0, lastThreatAt: 0, lastPos: null, lastScore: 0 };
    }
    var rec = mem.rooms[roomName];
    rec.lastSeen = Game.time;
    rec.lastPos = { x: flag.pos.x, y: flag.pos.y, roomName: roomName };
    if (typeof threatScore === 'number') rec.lastScore = threatScore;
    if (sawThreat) rec.lastThreatAt = Game.time;
    mem.rooms[roomName] = rec;
  }

  function _countHostiles(room) {
    if (!room) return { score: 0, hasThreat: false };
    var hostiles = room.find(FIND_HOSTILE_CREEPS);
    var hostileStructs = room.find(FIND_HOSTILE_STRUCTURES);
    var score = hostiles.length * 5;
    if (hostileStructs.length) score += hostileStructs.length * 3;
    return { score: score, hasThreat: (hostiles.length + hostileStructs.length) > 0 };
  }

  function _resolvePlan(flagName) {
    if (!flagName || !Memory.squads) return null;
    var bucket = Memory.squads[flagName];
    if (!bucket) return null;
    var rally = bucket.rally || bucket.rallyPos || bucket.anchor || bucket.squadRally;
    var attack = bucket.target || bucket.targetPos || bucket.attack || bucket.focusTargetPos;
    if (!attack && bucket.focusTarget) {
      var obj = Game.getObjectById(bucket.focusTarget);
      if (obj && obj.pos) attack = obj.pos;
    }
    var retreat = bucket.retreat || bucket.retreatPos || bucket.fallback || bucket.fallbackPos;
    var waypoints = _normalizeWaypoints(bucket.waypoints || bucket.route || bucket.path || bucket.waypointList);
    var plan = {
      name: flagName,
      state: _extractState(flagName, bucket),
      rally: _posFrom(rally),
      attack: _posFrom(attack),
      retreat: _posFrom(retreat),
      waypoints: waypoints
    };
    return plan;
  }

  function _ensurePrimaryFlag(plan) {
    if (!plan || !plan.rally) return null;
    if (Game.flags[plan.name]) return Game.flags[plan.name];
    var colors = CFG.TYPES.RALLY;
    return FlagIO.ensureFlag(plan.name, plan.rally, colors.color, colors.secondary, false);
  }

  function _buildSupportName(plan, type, index) {
    var slug = _sanitizeSlug(plan.name);
    var suffix = type;
    if (index != null) suffix = suffix + '_' + index;
    return CFG.SUPPORT_PREFIX + slug + '_' + suffix;
  }

  function _registerFlag(flag, bucket) {
    if (!flag || !flag.name || !bucket) return;
    bucket[flag.name] = true;
  }

  function _ensureSupportFlag(plan, type, pos, expected, order) {
    if (!plan || !pos || !expected) return null;
    var colors = CFG.TYPES[type];
    if (!colors) {
      if (CFG.DEBUG) _logDebug('Missing color mapping for', type);
      return null;
    }
    var name = _buildSupportName(plan, type, order);
    var flag = FlagIO.ensureFlag(name, pos, colors.color, colors.secondary, true);
    _registerFlag(flag, expected);
    return flag;
  }

  function _ensureSupportFlags(plan, expected) {
    if (!plan) return;
    if (plan.rally) _ensureSupportFlag(plan, 'RALLY', plan.rally, expected, null);
    if (plan.attack) _ensureSupportFlag(plan, 'ATTACK', plan.attack, expected, null);
    if (plan.retreat) _ensureSupportFlag(plan, 'RETREAT', plan.retreat, expected, null);
    var waypoints = plan.waypoints || [];
    for (var i = 0; i < waypoints.length; i++) {
      _ensureSupportFlag(plan, 'WAYPOINT', waypoints[i], expected, i + 1);
    }
  }

  function _cleanupSupportFlags(expected) {
    for (var name in Game.flags) {
      if (!Game.flags.hasOwnProperty(name)) continue;
      if (!_isSupportFlag(name)) continue;
      if (expected && expected[name]) continue;
      var flag = Game.flags[name];
      if (flag && typeof flag.remove === 'function') {
        flag.remove();
      }
    }
  }

  function _syncPlannedFlags() {
    if (!Memory.squads) return;
    var expected = {};
    for (var flagName in Memory.squads) {
      if (!Object.prototype.hasOwnProperty.call(Memory.squads, flagName)) continue;
      var plan = _resolvePlan(flagName);
      if (!plan) continue;
      if (!plan.rally && CFG.DEBUG) _logDebug('No rally defined for', flagName);
      _ensurePrimaryFlag(plan);
      _ensureSupportFlags(plan, expected);
    }
    _cleanupSupportFlags(expected);
  }

  function _serializePos(pos) {
    if (!pos) return null;
    if (pos instanceof RoomPosition) {
      return { x: pos.x, y: pos.y, roomName: pos.roomName };
    }
    if (pos.pos) return _serializePos(pos.pos);
    if (pos.x != null && pos.y != null && pos.roomName) {
      return { x: pos.x, y: pos.y, roomName: pos.roomName };
    }
    if (typeof pos === 'string') {
      var flag = Game.flags[pos];
      if (flag && flag.pos) return _serializePos(flag.pos);
    }
    return null;
  }

  function _samePos(a, b) {
    if (!a || !b) return false;
    return a.x === b.x && a.y === b.y && a.roomName === b.roomName;
  }

  function _posFrom(data) {
    var raw = _serializePos(data);
    if (!raw || raw.x == null || raw.y == null || !raw.roomName) return null;
    return raw;
  }

  function _sanitizeSlug(flagName) {
    if (!flagName) return 'SQUAD';
    var slug = flagName;
    if (slug.indexOf('Squad') === 0) slug = slug.substring(5);
    slug = slug.replace(/[^0-9A-Za-z]/g, '');
    if (!slug) slug = flagName.replace(/[^0-9A-Za-z]/g, '');
    if (!slug) slug = 'SQUAD';
    return slug.toUpperCase();
  }

  function _extractState(flagName, mem) {
    if (mem && mem.state) return mem.state;
    if (CombatAPI && typeof CombatAPI.getSquadState === 'function') {
      return CombatAPI.getSquadState(flagName);
    }
    return 'INIT';
  }

  function _normalizeWaypoints(raw) {
    if (!raw) return [];
    var list = [];
    if (Array.isArray(raw)) {
      list = raw;
    } else if (raw.points && Array.isArray(raw.points)) {
      list = raw.points;
    } else {
      list = [raw];
    }
    var normalized = [];
    for (var i = 0; i < list.length; i++) {
      var pos = _posFrom(list[i]);
      if (!pos) continue;
      normalized.push(pos);
    }
    return normalized;
  }

  var FlagIO = {
    ensureFlag: function (name, pos, color, secondary, allowAlternate) {
      if (!name || !pos) return null;
      var desired = _posFrom(pos);
      if (!desired) {
        if (CFG.DEBUG) _logDebug('Invalid position for', name);
        return null;
      }
      var existing = Game.flags[name];
      if (existing && existing.pos && _samePos(existing.pos, desired)) {
        var needsColorUpdate = false;
        if (color != null && existing.color !== color) needsColorUpdate = true;
        if (secondary != null && existing.secondaryColor !== secondary) needsColorUpdate = true;
        if (needsColorUpdate && existing.setColor) {
          existing.setColor(color || existing.color, secondary || existing.secondaryColor);
        }
        return existing;
      }
      var roomName = desired.roomName;
      if (!roomName) {
        if (CFG.DEBUG) _logDebug('Missing room for', name);
        return null;
      }
      var room = Game.rooms[roomName];
      if (!room) {
        if (CFG.DEBUG) _logDebug('No vision in', roomName, 'to place flag', name);
        return null;
      }
      if (color == null || secondary == null) {
        if (CFG.DEBUG) _logDebug('Color undefined for', name);
        return null;
      }
      var result = room.createFlag(desired.x, desired.y, name, color, secondary);
      if (typeof result === 'string') {
        return Game.flags[result];
      }
      if (result === ERR_NAME_EXISTS && allowAlternate !== false) {
        var altName = name + '_1';
        if (!Game.flags[altName]) {
          var retry = room.createFlag(desired.x, desired.y, altName, color, secondary);
          if (typeof retry === 'string') {
            return Game.flags[retry];
          }
        } else {
          var altFlag = Game.flags[altName];
          if (altFlag && _samePos(altFlag.pos, desired)) return altFlag;
        }
      }
      if (result !== OK && CFG.DEBUG) {
        _logDebug('Failed to place', name, '->', result);
      }
      return existing || null;
    },
    getOrMake: function (name, roomName, x, y, color, secondary) {
      if (!roomName || x == null || y == null) return null;
      return this.ensureFlag(name, { x: x, y: y, roomName: roomName }, color, secondary);
    }
  };

  function ensureSquadFlags() {
    var mem = _ensureMem();
    var seen = {};

    for (var name in Game.flags) {
      if (!Game.flags.hasOwnProperty(name)) continue;
      if (!_isSquadFlag(name)) continue;
      var flag = Game.flags[name];
      seen[name] = true;
      mem.bindings[name] = flag.pos.roomName;

      // Ensure Memory.squads entry exists and rally is captured.
      CombatAPI.assignFormation(name, []);

      var room = flag.room || null;
      var threat = _countHostiles(room);
      var currentState = CombatAPI.getSquadState(name);
      var nextState = currentState;
      if (currentState !== 'RETREAT') {
        nextState = threat.hasThreat ? 'ENGAGE' : 'FORM';
        if (room) {
          var targetId = CombatAPI.getAttackTarget(room, {});
          if (!targetId && !threat.hasThreat) nextState = 'FORM';
          if (targetId) nextState = 'ENGAGE';
        }
      }
      CombatAPI.setSquadState(name, nextState);
      _updateRoomRecord(mem, flag, room, threat.score, threat.hasThreat);
    }

    for (var existing in mem.bindings) {
      if (!Object.prototype.hasOwnProperty.call(mem.bindings, existing)) continue;
      if (!seen[existing]) {
        delete mem.bindings[existing];
      }
    }

    for (var roomName in mem.rooms) {
      if (!mem.rooms.hasOwnProperty(roomName)) continue;
      var rec = mem.rooms[roomName];
      if (!rec) continue;
      if ((Game.time - (rec.lastSeen || 0)) > 20000) {
        delete mem.rooms[roomName];
      }
    }

    _syncPlannedFlags();
  }

  return {
    ensureSquadFlags: ensureSquadFlags
  };
})();

// Console test checklist:
// 1. Ensure squads in RALLY/ATTACK/RETREAT states emit exactly one flag per type.
// 2. Toggle CFG.DEBUG = true for a single tick to verify placement logs.
// 3. Confirm cleanup skips valid SQUAD_* flags and removes stale ones.

module.exports = SquadFlagManager;
