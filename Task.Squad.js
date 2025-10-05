// Task.Squad.js — Squad brain shared utilities (Traveler + intents + threat awareness)
'use strict';

var BeeToolbox; try { BeeToolbox = require('BeeToolbox'); } catch (err) { BeeToolbox = null; }
try { require('Traveler'); } catch (err2) { /* ensure Traveler is loaded */ }

var ThreatAnalyzer = require('Combat.ThreatAnalyzer.es5');
var SquadIntents   = require('Squad.Intents.es5');

var TARGET_STICKY_TICKS = 12;     // hold the same target for a short burst
var ANCHOR_STICKY_TICKS = 20;     // how long to remember last anchor
var INTENT_STICKY_TICKS = 5;      // minimal refresh cadence for intent lookup
var MAX_TARGET_RANGE    = 30;
var RALLY_FLAG_PREFIX   = 'Squad';

var TRAVELER_DEFAULTS = {
  ignoreCreeps: false,
  stuckValue: 2,
  repath: 0.05,
  maxOps: 5000,
  range: 1,
};

var ROLE_PRIORITY = {
  CombatMelee: 90,
  Dismantler:  80,
  CombatArcher:70,
  CombatMedic: 60,
};

if (!global.__MOVE_RES__) {
  global.__MOVE_RES__ = { tick: -1, rooms: {} };
}

function _resetReservations() {
  if (global.__MOVE_RES__.tick !== Game.time) {
    global.__MOVE_RES__.tick = Game.time;
    global.__MOVE_RES__.rooms = {};
  }
}

function _resKey(x, y) { return x + '_' + y; }

function _reserveTile(creep, pos, priority) {
  if (!creep || !pos) return true;
  _resetReservations();
  var roomName = pos.roomName || (pos.pos && pos.pos.roomName);
  if (!roomName) return true;
  var rooms = global.__MOVE_RES__.rooms;
  var map = rooms[roomName];
  if (!map) map = (rooms[roomName] = {});
  var x = pos.x || (pos.pos && pos.pos.x);
  var y = pos.y || (pos.pos && pos.pos.y);
  var key = _resKey(x, y);
  var cur = map[key];
  if (!cur) {
    map[key] = { name: creep.name, pri: priority | 0 };
    return true;
  }
  if (cur.name === creep.name) return true;
  if ((priority | 0) > (cur.pri | 0)) {
    map[key] = { name: creep.name, pri: priority | 0 };
    return true;
  }
  return false;
}

function _roleOf(creep) {
  if (!creep || !creep.memory) return '';
  return creep.memory.task || creep.memory.role || '';
}

function _rolePriority(creep) {
  var pri = ROLE_PRIORITY[_roleOf(creep)];
  return pri != null ? pri : 10;
}

function getSquadId(creep) {
  if (!creep || !creep.memory) return 'Alpha';
  return creep.memory.squadId || creep.memory.SquadId || 'Alpha';
}

function _squadMem(id) {
  if (!Memory.squads) Memory.squads = {};
  var bucket = Memory.squads[id];
  if (!bucket) {
    bucket = {
      targetId: null,
      targetAt: 0,
      targetPos: null,
      anchor: null,
      anchorAt: 0,
      intent: SquadIntents.DEFAULT_INTENT,
      intentAt: 0,
      flagName: null,
      recall: false,
      homeRoom: null,
      lastTowerMargin: null,
    };
    Memory.squads[id] = bucket;
  }
  return bucket;
}

function _findSquadFlag(id, mem) {
  if (!mem) mem = _squadMem(id);
  var flag = null;
  if (mem.flagName && Game.flags[mem.flagName]) {
    flag = Game.flags[mem.flagName];
  }
  if (!flag) {
    var names = [
      RALLY_FLAG_PREFIX + id,
      RALLY_FLAG_PREFIX + '_' + id,
      id,
      'Rally' + id,
      'Assault' + id,
      'Breach' + id
    ];
    for (var i = 0; i < names.length; i++) {
      var guess = Game.flags[names[i]];
      if (guess) { flag = guess; break; }
    }
  }
  if (flag) mem.flagName = flag.name;
  return flag;
}

function _currentIntent(id) {
  var mem = _squadMem(id);
  if (Game.time - (mem.intentAt || 0) <= INTENT_STICKY_TICKS && mem.intent) {
    return mem.intent;
  }
  var flag = _findSquadFlag(id, mem);
  var resolved = null;
  if (flag) {
    if (BeeToolbox && BeeToolbox.decodeSquadFlag) {
      resolved = BeeToolbox.decodeSquadFlag(flag);
    } else {
      resolved = SquadIntents.resolve(flag);
    }
  }
  if (resolved && resolved.intent) {
    mem.intent = resolved.intent;
    mem.intentAt = Game.time;
    return resolved.intent;
  }
  mem.intent = SquadIntents.DEFAULT_INTENT;
  mem.intentAt = Game.time;
  return mem.intent;
}

function getIntent(creep) {
  var id = getSquadId(creep);
  return _currentIntent(id);
}

function _packPos(pos) {
  if (!pos) return null;
  return { x: pos.x, y: pos.y, room: pos.roomName };
}

function _unpackPos(data) {
  if (!data) return null;
  return new RoomPosition(data.x, data.y, data.room);
}

function _leaderPos(id) {
  var names = Object.keys(Game.creeps);
  var i;
  for (i = 0; i < names.length; i++) {
    var c = Game.creeps[names[i]];
    if (!c || !c.my) continue;
    if (getSquadId(c) !== id) continue;
    if (_roleOf(c) === 'CombatMelee') return c.pos;
  }
  for (i = 0; i < names.length; i++) {
    var c2 = Game.creeps[names[i]];
    if (!c2 || !c2.my) continue;
    if (getSquadId(c2) !== id) continue;
    if (c2.pos) return c2.pos;
  }
  return null;
}

function getAnchor(creep) {
  if (!creep) return null;
  var id = getSquadId(creep);
  var mem = _squadMem(id);
  var flag = _findSquadFlag(id, mem);
  if (flag) {
    mem.anchor = _packPos(flag.pos);
    mem.anchorAt = Game.time;
    return flag.pos;
  }
  if (mem.anchor && Game.time - (mem.anchorAt || 0) <= ANCHOR_STICKY_TICKS) {
    return _unpackPos(mem.anchor);
  }
  var leader = _leaderPos(id);
  if (leader) {
    mem.anchor = _packPos(leader);
    mem.anchorAt = Game.time;
    return leader;
  }
  return null;
}

function _validTarget(target, creep) {
  if (!target) return false;
  if (target.hits != null && target.hits <= 0) return false;
  if (!target.pos) return false;
  if (creep && creep.pos && creep.pos.roomName && target.pos.roomName && creep.pos.roomName !== target.pos.roomName) {
    if (creep.pos.getRangeTo(target) > MAX_TARGET_RANGE) return false;
  }
  return true;
}

function _targetFromIntel(roomName, options) {
  var intel = ThreatAnalyzer.getIntel(roomName);
  if (!intel) return null;
  var anchor = options && options.anchorPos ? options.anchorPos : null;
  var target = ThreatAnalyzer.selectPrimaryTarget(roomName, { anchorPos: anchor });
  return target;
}

function sharedTarget(creep) {
  if (!creep) return null;
  var id = getSquadId(creep);
  var mem = _squadMem(id);
  var current = mem.targetId ? Game.getObjectById(mem.targetId) : null;
  if (_validTarget(current, creep) && Game.time - (mem.targetAt || 0) <= TARGET_STICKY_TICKS) {
    return current;
  }

  ThreatAnalyzer.registerHostiles(creep.room);
  var anchor = getAnchor(creep);
  var roomName = creep.pos.roomName;
  var intelTarget = _targetFromIntel(roomName, { anchorPos: anchor });

  if (intelTarget && intelTarget.id) {
    mem.targetId = intelTarget.id;
    mem.targetAt = Game.time;
    mem.targetPos = _packPos(intelTarget.pos);
    return intelTarget;
  }

  if (intelTarget && intelTarget.pos) {
    mem.targetId = null;
    mem.targetAt = Game.time;
    mem.targetPos = _packPos(intelTarget.pos);
    return null; // position only; wait until we have vision of object
  }

  mem.targetId = null;
  mem.targetPos = null;
  mem.targetAt = Game.time;
  return null;
}

function _resolveHomeRoom(creep, mem) {
  if (creep && creep.memory && creep.memory.homeRoom) return creep.memory.homeRoom;
  if (mem && mem.homeRoom) return mem.homeRoom;
  if (creep && creep.room && creep.room.controller && creep.room.controller.my) return creep.room.name;
  var spawnNames = Object.keys(Game.spawns);
  if (spawnNames.length) {
    var first = Game.spawns[spawnNames[0]];
    if (first && first.room) return first.room.name;
  }
  return null;
}

function _pickRecycleSpawn(creep, mem) {
  var home = _resolveHomeRoom(creep, mem);
  var spawn = null;
  if (home) {
    for (var name in Game.spawns) {
      if (!Game.spawns.hasOwnProperty(name)) continue;
      var sp = Game.spawns[name];
      if (!sp || !sp.my || !sp.room) continue;
      if (sp.room.name === home) { spawn = sp; break; }
    }
  }
  if (!spawn && creep && creep.pos && creep.pos.findClosestByPath) {
    spawn = creep.pos.findClosestByPath(FIND_MY_SPAWNS);
  }
  if (!spawn && creep && creep.pos) {
    spawn = creep.pos.findClosestByRange(FIND_MY_SPAWNS);
  }
  if (!spawn) {
    for (var s in Game.spawns) {
      if (Game.spawns.hasOwnProperty(s)) { spawn = Game.spawns[s]; if (spawn) break; }
    }
  }
  return spawn;
}

function shouldRecycle(creep) {
  var id = getSquadId(creep);
  var mem = _squadMem(id);
  return !!mem.recall;
}

function recycle(creep) {
  if (!creep) return false;
  var id = getSquadId(creep);
  var mem = _squadMem(id);
  var spawn = _pickRecycleSpawn(creep, mem);
  if (!spawn) return false;
  if (!creep.pos.isNearTo(spawn)) {
    stepToward(creep, spawn.pos, 1);
    return true;
  }
  if (spawn.recycleCreep) {
    spawn.recycleCreep(creep); // Screeps docs: StructureSpawn.recycleCreep(creep)
    return true;
  }
  return false;
}

function stepToward(creep, pos, range) {
  if (!creep || !pos) return ERR_INVALID_TARGET;
  var goal = pos.pos || pos;
  var needRange = typeof range === 'number' ? range : 0;
  if (creep.pos.getRangeTo(goal) <= needRange) return OK;

  var retData = {};
  var opts = {
    range: needRange,
    ignoreCreeps: TRAVELER_DEFAULTS.ignoreCreeps,
    stuckValue: TRAVELER_DEFAULTS.stuckValue,
    repath: TRAVELER_DEFAULTS.repath,
    maxOps: TRAVELER_DEFAULTS.maxOps,
    returnData: retData,
    roomCallback: (BeeToolbox && BeeToolbox.roomCallback) ? BeeToolbox.roomCallback : undefined,
  };

  var moveCode = creep.travelTo(goal, opts);
  creep.memory = creep.memory || {};
  creep.memory._movedAt = Game.time;

  if (retData && retData.nextPos) {
    var pri = _rolePriority(creep);
    var nextPos = retData.nextPos;
    var occupant = nextPos.lookFor(LOOK_CREEPS);
    if (occupant && occupant.length && BeeToolbox && BeeToolbox.friendlySwap) {
      BeeToolbox.friendlySwap(creep, nextPos);
    }
    if (!_reserveTile(creep, nextPos, pri)) {
      return ERR_BUSY;
    }
  }
  return moveCode;
}

var TaskSquad = {
  getSquadId: getSquadId,
  getIntent: getIntent,
  getAnchor: getAnchor,
  sharedTarget: sharedTarget,
  stepToward: stepToward,
  shouldRecycle: shouldRecycle,
  recycle: recycle,
};

module.exports = TaskSquad;
