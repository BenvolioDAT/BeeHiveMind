'use strict';

var Traveler = null;
try {
  Traveler = require('Traveler');
} catch (error) {
  Traveler = null;
}

var TaskSquad = require('./Task.Squad');

function _ensureThrottleStore(creep) {
  if (!creep || !creep.memory) return null;
  var cache = creep.memory._idleThrottle;
  if (!cache) {
    cache = {};
    creep.memory._idleThrottle = cache;
  }
  return cache;
}

function throttled(creep, key, interval, fn) {
  if (!creep || typeof fn !== 'function') return;
  var store = _ensureThrottleStore(creep);
  if (!store) return;
  var safeKey = key;
  if (safeKey == null) {
    safeKey = 'default';
  } else if (typeof safeKey !== 'string') {
    safeKey = safeKey.toString ? safeKey.toString() : String(safeKey);
  }
  var now = Game.time;
  var last = store[safeKey] || 0;
  var wait = (typeof interval === 'number' && interval > 0) ? interval : 0;
  if (now - last < wait) return;
  store[safeKey] = now;
  fn();
}

function sayThrottled(creep, message, interval, key) {
  if (!creep || typeof creep.say !== 'function') return;
  var throttleKey = key || message;
  var wait = (typeof interval === 'number' && interval > 0) ? interval : 10;
  throttled(creep, throttleKey, wait, function () {
    creep.say(message);
  });
}

function travel(creep, destination, options) {
  if (!creep || !destination) return ERR_INVALID_TARGET;
  var opts = options || {};
  if (Traveler && typeof Traveler.travelTo === 'function') {
    return Traveler.travelTo(creep, destination, opts);
  }

  var pos = destination;
  if (destination.pos && destination.pos instanceof RoomPosition) {
    pos = destination.pos;
  } else if (!(destination instanceof RoomPosition) && destination.x != null && destination.y != null) {
    var roomName = destination.roomName || (creep.room ? creep.room.name : undefined);
    pos = new RoomPosition(destination.x, destination.y, roomName);
  }

  if (pos instanceof RoomPosition) {
    return creep.moveTo(pos, opts);
  }

  return creep.moveTo(destination, opts);
}

var Taskidle = {
  run: function (creep) {
    if (!creep || creep.spawning) return;

    if (this._isCombatRole(creep)) {
      this._parkCombatCreep(creep);
      sayThrottled(creep, '🛡️ Hold', 15, 'combatHold');
    } else {
      sayThrottled(creep, '😴 Idle', 15, 'idle');
    }
  },

  _isCombatRole: function (creep) {
    var tag = ((creep.memory && (creep.memory.task || creep.memory.role)) || '').toString();
    if (!tag) return false;
    if (tag.indexOf('Combat') === 0) return true;
    return tag === 'Dismantler';
  },

  _parkCombatCreep: function (creep) {
    var spot = this._combatIdleSpot(creep);
    if (!spot) return;

    if (!creep.pos.isEqualTo(spot)) {
      if (TaskSquad && typeof TaskSquad.stepToward === 'function') {
        TaskSquad.stepToward(creep, spot, 0);
      } else {
        travel(creep, spot, { range: 0, reusePath: 5 });
      }
    }
  },

  _combatIdleSpot: function (creep) {
    var anchor = this._resolveCombatAnchor(creep);
    if (!anchor) return null;

    var offset = this._idleOffset(creep.name || '');
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

    var squadFlag = this._squadFlag(creep);
    if (squadFlag) return squadFlag.pos;

    if (Game.flags.MedicRally) return Game.flags.MedicRally.pos;
    if (Game.flags.Rally) return Game.flags.Rally.pos;

    var room = creep.room;
    if (room) {
      if (room.storage) return room.storage.pos;
      var spawns = room.find(FIND_MY_SPAWNS);
      if (spawns.length) return spawns[0].pos;
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

module.exports = Taskidle;
