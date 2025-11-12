'use strict';

var BeeCombatSquads = require('BeeCombatSquads');
var CombatAPI = BeeCombatSquads.CombatAPI;

var SquadFlagManager = (function () {
  function _isSquadFlag(name) {
    if (!name) return false;
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
  }

  return {
    ensureSquadFlags: ensureSquadFlags
  };
})();

module.exports = SquadFlagManager;
