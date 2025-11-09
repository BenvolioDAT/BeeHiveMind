var TaskSquad = require('Task.Squad');

var roleIdle = {
  role: 'Idle',

  run: function (creep) {
    if (!creep || creep.spawning) return;

    if (creep.memory && !creep.memory.role) creep.memory.role = 'Idle';

    if (roleIdle._isCombatRole(creep)) {
      roleIdle._parkCombatCreep(creep);
    } else {
      if (Game.time % 15 === 0) creep.say('😴 Idle');
    }
  },

  _isCombatRole: function (creep) {
    var tag = ((creep.memory && (creep.memory.role || creep.memory.task)) || '').toString();
    if (!tag) return false;
    if (tag.indexOf('Combat') === 0) return true;
    return tag === 'Dismantler';
  },

  _parkCombatCreep: function (creep) {
    var spot = roleIdle._combatIdleSpot(creep);
    if (!spot) return;

    if (!creep.pos.isEqualTo(spot)) {
      if (TaskSquad && typeof TaskSquad.stepToward === 'function') {
        TaskSquad.stepToward(creep, spot, 0);
      } else {
        creep.moveTo(spot, { range: 0, reusePath: 5 });
      }
    }

    if (Game.time % 15 === 0) creep.say('🛡️ Hold');
  },

  _combatIdleSpot: function (creep) {
    var anchor = roleIdle._resolveCombatAnchor(creep);
    if (!anchor) return null;

    var offset = roleIdle._idleOffset(creep.name || '');
    var roomName = anchor.roomName || (anchor.pos && anchor.pos.roomName) || creep.pos.roomName;
    var basePos = anchor.pos || anchor;
    var x = Math.min(48, Math.max(1, basePos.x + offset.dx));
    var y = Math.min(48, Math.max(1, basePos.y + offset.dy));
    return new RoomPosition(x, y, roomName);
  },

  _resolveCombatAnchor: function (creep) {
    if (TaskSquad && typeof TaskSquad.getAnchor === 'function') {
      var anchor = TaskSquad.getAnchor(creep);
      if (anchor) return anchor;
    }

    var squadFlag = roleIdle._squadFlag(creep);
    if (squadFlag) return squadFlag.pos;

    if (Game.flags.MedicRally) return Game.flags.MedicRally.pos;
    if (Game.flags.Rally) return Game.flags.Rally.pos;

    var room = creep.room;
    if (room) {
      if (room.storage) return room.storage.pos;
      var spawn = room.find(FIND_MY_SPAWNS)[0];
      if (spawn) return spawn.pos;
    }

    return creep.pos;
  },

  _squadFlag: function (creep) {
    var sid = (creep.memory && creep.memory.squadId) || 'Alpha';
    return (
      Game.flags['Squad' + sid] ||
      Game.flags['Squad_' + sid] ||
      Game.flags[sid] ||
      null
    );
  },

  _idleOffset: function (name) {
    var offsets = [
      { dx: 0, dy: 0 },
      { dx: 1, dy: 0 },
      { dx: -1, dy: 0 },
      { dx: 0, dy: 1 },
      { dx: 0, dy: -1 },
      { dx: 1, dy: 1 },
      { dx: -1, dy: -1 },
      { dx: 1, dy: -1 },
      { dx: -1, dy: 1 }
    ];

    var hash = 0;
    for (var i = 0; i < name.length; i++) {
      hash = (hash * 31 + name.charCodeAt(i)) % 997;
    }
    var idx = hash % offsets.length;
    return offsets[idx];
  }
};

module.exports = roleIdle;
