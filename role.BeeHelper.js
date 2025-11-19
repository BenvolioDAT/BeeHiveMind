'use strict';

var CoreConfig = require('core.config');
var BeeCombatSquads = require('BeeCombatSquads');

var WorkerConfig = CoreConfig.workerConfig || {};
var REMOTE_DEFENSE_MAX_DISTANCE = WorkerConfig.REMOTE_DEFENSE_MAX_DISTANCE || 2;
var THREAT_DECAY_TICKS = WorkerConfig.THREAT_DECAY_TICKS || 150;

function debugSay(creep, msg) {
  if (WorkerConfig.DEBUG_SAY && creep && msg) creep.say(msg, true);
}

function getTargetPosition(target) {
  if (!target) return null;
  if (target.pos) return target.pos;
  if (target.x != null && target.y != null && target.roomName) return target;
  return null;
}

function debugDrawLine(creep, target, color, label) {
  if (!WorkerConfig.DEBUG_DRAW || !creep || !target) return;
  var room = creep.room;
  if (!room || !room.visual) return;
  var tpos = getTargetPosition(target);
  if (!tpos || tpos.roomName !== room.name) return;
  try {
    room.visual.line(creep.pos, tpos, {
      color: color,
      width: (WorkerConfig.DRAW && WorkerConfig.DRAW.WIDTH) || 0.12,
      opacity: (WorkerConfig.DRAW && WorkerConfig.DRAW.OPACITY) || 0.45,
      lineStyle: 'solid'
    });
    if (label) {
      room.visual.text(label, tpos.x, tpos.y - 0.3, {
        color: color,
        opacity: (WorkerConfig.DRAW && WorkerConfig.DRAW.OPACITY) || 0.45,
        font: (WorkerConfig.DRAW && WorkerConfig.DRAW.FONT) || 0.6,
        align: 'center'
      });
    }
  } catch (e) {}
}

function debugRing(room, pos, color, text) {
  if (!WorkerConfig.DEBUG_DRAW || !room || !room.visual || !pos) return;
  try {
    room.visual.circle(pos, {
      radius: 0.5,
      fill: 'transparent',
      stroke: color,
      opacity: (WorkerConfig.DRAW && WorkerConfig.DRAW.OPACITY) || 0.45,
      width: (WorkerConfig.DRAW && WorkerConfig.DRAW.WIDTH) || 0.12
    });
    if (text) {
      room.visual.text(text, pos.x, pos.y - 0.6, {
        color: color,
        font: (WorkerConfig.DRAW && WorkerConfig.DRAW.FONT) || 0.6,
        opacity: (WorkerConfig.DRAW && WorkerConfig.DRAW.OPACITY) || 0.45,
        align: 'center'
      });
    }
  } catch (e) {}
}

function debugLabel(room, pos, text, color) {
  if (!WorkerConfig.DEBUG_DRAW || !room || !room.visual || !pos || !text) return;
  try {
    room.visual.text(text, pos.x, pos.y - 1.2, {
      color: color || (WorkerConfig.DRAW && WorkerConfig.DRAW.TEXT),
      font: (WorkerConfig.DRAW && WorkerConfig.DRAW.FONT) || 0.6,
      opacity: 0.95,
      align: 'center',
      backgroundColor: '#000000',
      backgroundOpacity: 0.25
    });
  } catch (e) {}
}

function drawExitMarker(room, exitDir, label, color) {
  if (!WorkerConfig.DEBUG_DRAW || !room || !room.visual) return;
  var x = 25;
  var y = 25;
  if (exitDir === FIND_EXIT_TOP)    { y = 1;  x = 25; }
  if (exitDir === FIND_EXIT_BOTTOM) { y = 48; x = 25; }
  if (exitDir === FIND_EXIT_LEFT)   { x = 1;  y = 25; }
  if (exitDir === FIND_EXIT_RIGHT)  { x = 48; y = 25; }
  var pos = new RoomPosition(x, y, room.name);
  debugRing(room, pos, color, label);
}

function ensureCombatIntelMemory() {
  if (BeeCombatSquads && BeeCombatSquads.SquadFlagIntel && typeof BeeCombatSquads.SquadFlagIntel.ensureMemory === 'function') {
    return BeeCombatSquads.SquadFlagIntel.ensureMemory();
  }
  if (!Memory.squadFlags) Memory.squadFlags = { rooms: {}, bindings: {} };
  if (!Memory.squadFlags.rooms) Memory.squadFlags.rooms = {};
  if (!Memory.squadFlags.bindings) Memory.squadFlags.bindings = {};
  return Memory.squadFlags;
}

function ensureRemoteSquadMemory(flagName) {
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

function ensureThreatCache() {
  if (!global.__beeThreatIntelCache || global.__beeThreatIntelCache.tick !== Game.time) {
    global.__beeThreatIntelCache = { tick: Game.time, spawnRooms: null, distance: {} };
  }
  if (!global.__beeThreatIntelCache.distance) global.__beeThreatIntelCache.distance = {};
  return global.__beeThreatIntelCache;
}

function listOwnedSpawnRooms() {
  var cache = ensureThreatCache();
  if (cache.spawnRooms) return cache.spawnRooms;
  var seen = {};
  var list = [];
  for (var name in Game.spawns) {
    if (!Game.spawns.hasOwnProperty(name)) continue;
    var spawn = Game.spawns[name];
    if (!spawn || !spawn.my) continue;
    var roomName = (spawn.room && spawn.room.name) || (spawn.pos && spawn.pos.roomName);
    if (!roomName || seen[roomName]) continue;
    seen[roomName] = true;
    list.push(roomName);
  }
  cache.spawnRooms = list;
  return list;
}

function roomDistanceFromOwnedSpawn(roomName) {
  if (!roomName) return Infinity;
  var cache = ensureThreatCache();
  if (cache.distance[roomName] != null) return cache.distance[roomName];
  var spawnRooms = listOwnedSpawnRooms();
  var best = Infinity;
  for (var i = 0; i < spawnRooms.length; i++) {
    var owned = spawnRooms[i];
    if (owned === roomName) { best = 0; break; }
    var route = null;
    try {
      route = Game.map.findRoute(roomName, owned);
    } catch (e) {
      route = ERR_NO_PATH;
    }
    if (route === ERR_NO_PATH || route == null) continue;
    var dist = Array.isArray(route) ? route.length : (typeof route.length === 'number' ? route.length : Infinity);
    if (dist < best) best = dist;
  }
  cache.distance[roomName] = best;
  return best;
}

function computeThreatBundle(room) {
  if (!room) return { score: 0, hasThreat: false, bestId: null };
  if (BeeCombatSquads && typeof BeeCombatSquads.getLiveThreatForRoom === 'function') {
    try {
      var data = BeeCombatSquads.getLiveThreatForRoom(room);
      if (data) return data;
    } catch (e) {}
  }
  var hostiles = [];
  try {
    hostiles = room.find(FIND_HOSTILE_CREEPS) || [];
  } catch (err) {}
  var bestId = hostiles.length ? hostiles[0].id : null;
  return { score: hostiles.length * 5, hasThreat: hostiles.length > 0, bestId: bestId };
}

function recordThreatIntel(room, threatBundle, shouldEscalate, sourceTag, distance) {
  if (!room) return;
  var roomName = room.name || (room.pos ? room.pos.roomName : null);
  if (!roomName) return;
  var intel = ensureCombatIntelMemory();
  if (!intel) return;
  if (!intel.rooms) intel.rooms = {};
  var rec = intel.rooms[roomName];
  if (!rec) {
    rec = { lastSeen: 0, lastThreatAt: 0, lastPos: null, lastScore: 0 };
  }
  rec.lastSeen = Game.time;
  var anchor = null;
  if (room.controller && room.controller.pos) anchor = room.controller.pos;
  else if (room.storage && room.storage.pos) anchor = room.storage.pos;
  else if (room.pos) anchor = room.pos;
  else anchor = new RoomPosition(25, 25, roomName);
  rec.lastPos = { x: anchor.x, y: anchor.y, roomName: roomName };
  if (distance != null) rec.lastDistanceFromSpawn = distance;
  if (sourceTag) rec.lastIntelSource = sourceTag;
  var score = (threatBundle && typeof threatBundle.score === 'number') ? threatBundle.score : 0;
  var sawThreat = Boolean(threatBundle && threatBundle.hasThreat);
  if (shouldEscalate) {
    rec.lastScore = score;
    if (sawThreat) {
      rec.lastThreatAt = Game.time;
    } else if (rec.lastScore > 0) {
      var since = Game.time - (rec.lastThreatAt || rec.lastSeen || 0);
      if (since > THREAT_DECAY_TICKS) rec.lastScore = 0;
    }
    if (rec.deferredThreat) delete rec.deferredThreat;
  } else {
    rec.lastScore = 0;
    if (sawThreat && score > 0) {
      rec.deferredThreat = { score: score, lastSeen: Game.time, distance: distance, source: sourceTag || 'Scout' };
      rec.lastThreatAt = Game.time;
    } else if (rec.deferredThreat) {
      delete rec.deferredThreat;
    }
  }
  intel.rooms[roomName] = rec;
}

function evaluateRoomThreat(room, sourceTag) {
  if (!room) return null;
  var threatBundle = computeThreatBundle(room);
  var distance = roomDistanceFromOwnedSpawn(room.name);
  var canEscalate = (distance <= REMOTE_DEFENSE_MAX_DISTANCE);
  var allowScore = (!threatBundle || !threatBundle.hasThreat) ? true : canEscalate;
  recordThreatIntel(room, threatBundle, allowScore, sourceTag, distance);
  return { threat: threatBundle, distance: distance, canEscalate: canEscalate };
}

function ensureRemoteDefensePlan(room, threatBundle, distance) {
  if (!room || !threatBundle || !threatBundle.hasThreat || !(threatBundle.score > 0)) return;
  var flagName = 'Squad' + room.name;
  var bucket = Memory.squads && Memory.squads[flagName] ? Memory.squads[flagName] : null;
  if (bucket && !bucket.remoteDefense && !bucket.autoDefense) {
    return;
  }
  bucket = ensureRemoteSquadMemory(flagName);
  if (!bucket) return;
  bucket.remoteDefense = true;
  if (!bucket.planType) bucket.planType = 'REMOTE_DEFENSE';
  bucket.targetRoom = room.name;
  bucket.lastKnownScore = threatBundle.score;
  bucket.lastDefenseTick = Game.time;
  bucket.lastSeenTick = Game.time;
  bucket.lastDistance = distance;
  var rallyPos = (room.controller && room.controller.pos) || (room.storage && room.storage.pos) || new RoomPosition(25, 25, room.name);
  bucket.rally = { x: rallyPos.x, y: rallyPos.y, roomName: rallyPos.roomName };
  var attackPos = null;
  if (threatBundle.bestId) {
    var obj = Game.getObjectById(threatBundle.bestId);
    if (obj && obj.pos) attackPos = obj.pos;
  }
  if (!attackPos) attackPos = rallyPos;
  var serialized = { x: attackPos.x, y: attackPos.y, roomName: attackPos.roomName };
  bucket.targetPos = serialized;
  bucket.focusTargetPos = serialized;
  bucket.target = serialized;
  bucket.targetId = threatBundle.bestId || null;
  bucket.focusTarget = threatBundle.bestId || null;
  bucket.requestedAt = Game.time;
  var intel = ensureCombatIntelMemory();
  if (intel && intel.bindings) {
    intel.bindings[flagName] = room.name;
  }
  Memory.squads[flagName] = bucket;
}

function softenRemoteDefensePlan(roomName) {
  if (!roomName || !Memory.squads) return;
  var flagName = 'Squad' + roomName;
  var bucket = Memory.squads[flagName];
  if (!bucket || !bucket.remoteDefense) return;
  bucket.lastKnownScore = 0;
}

var BeeHelper = {
  config: WorkerConfig,
  debugSay: debugSay,
  debugDrawLine: debugDrawLine,
  debugRing: debugRing,
  debugLabel: debugLabel,
  drawExitMarker: drawExitMarker,
  evaluateRoomThreat: evaluateRoomThreat,
  ensureRemoteDefensePlan: ensureRemoteDefensePlan,
  softenRemoteDefensePlan: softenRemoteDefensePlan
};

module.exports = BeeHelper;
