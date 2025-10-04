
"use strict";

const TaskSquad = require('./Task.Squad');

const Taskidle = {
  run: function (creep) {
    if (!creep || creep.spawning) return;

    if (this._isCombatRole(creep)) {
      this._parkCombatCreep(creep);
    } else {
      if (Game.time % 15 === 0) creep.say('😴 Idle');
    }
  },

  _isCombatRole: function (creep) {
    const tag = ((creep.memory && (creep.memory.task || creep.memory.role)) || '').toString();
    if (!tag) return false;
    if (tag.indexOf('Combat') === 0) return true;
    return tag === 'Dismantler';
  },

  _parkCombatCreep: function (creep) {
    const spot = this._combatIdleSpot(creep);
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
    const anchor = this._resolveCombatAnchor(creep);
    if (!anchor) return null;

    const offset = this._idleOffset(creep.name || '');
    const roomName = anchor.roomName || (anchor.pos && anchor.pos.roomName) || creep.pos.roomName;
    const basePos = anchor.pos || anchor;
    const x = Math.min(48, Math.max(1, basePos.x + offset.dx));
    const y = Math.min(48, Math.max(1, basePos.y + offset.dy));
    return new RoomPosition(x, y, roomName);
  },

  _resolveCombatAnchor: function (creep) {
    if (TaskSquad && typeof TaskSquad.getAnchor === 'function') {
      const anchor = TaskSquad.getAnchor(creep);
      if (anchor) return anchor;
    }

    const squadFlag = this._squadFlag(creep);
    if (squadFlag) return squadFlag.pos;

    if (Game.flags.MedicRally) return Game.flags.MedicRally.pos;
    if (Game.flags.Rally) return Game.flags.Rally.pos;

    const room = creep.room;
    if (room) {
      if (room.storage) return room.storage.pos;
      const spawn = room.find(FIND_MY_SPAWNS)[0];
      if (spawn) return spawn.pos;
    }

    return creep.pos;
  },

  _squadFlag: function (creep) {
    const sid = (creep.memory && creep.memory.squadId) || 'Alpha';
    return (
      Game.flags['Squad' + sid] ||
      Game.flags['Squad_' + sid] ||
      Game.flags[sid] ||
      null
    );
  },

  _idleOffset: function (name) {
    const offsets = [
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

    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = (hash * 31 + name.charCodeAt(i)) % 997;
    }
    const idx = hash % offsets.length;
    return offsets[idx];
  }
};

module.exports = Taskidle;
