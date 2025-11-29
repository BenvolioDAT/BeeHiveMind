'use strict';

const BeeCombatSquads = require('BeeCombatSquads');

// Shared debug + tuning config (copied from role.BeeWorker for consistency)
var CFG = Object.freeze({
  // --- Debug toggles (shared) ---
  DEBUG_SAY: false,
  DEBUG_DRAW: true,

  // --- Visual styles (shared) ---
  DRAW: {
    // BaseHarvest-style visuals
    TRAVEL:   "#8ab6ff",
    SOURCE:   "#ffd16e",
    SEAT:     "#6effa1",
    QUEUE:    "#ffe66e",
    YIELD:    "#ff6e6e",
    OFFLOAD:  "#6ee7ff",
    IDLE:     "#bfbfbf",
    // Courier-style visuals
    WD_COLOR:    "#6ec1ff",  // withdraw lines
    FILL_COLOR:  "#6effa1",  // delivery lines
    DROP_COLOR:  "#ffe66e",  // dropped energy
    GRAVE_COLOR: "#ffb0e0",  // tombstones/ruins
    IDLE_COLOR:  "#bfbfbf",
    // Shared
    WIDTH:   0.12,
    OPACITY: 0.45,
    FONT:    0.6
  },

  // --- Towers (Courier) ---
  TOWER_REFILL_AT_OR_BELOW: 0.70,

  //Upgrader role Behavior
  SIGN_TEXT: "BeeNice Please.",
  //Trucker role Behavior
  PICKUP_FLAG_DEFAULT: "E-Pickup", // default flag name to route to
  MIN_DROPPED: 50,                 // ignore tiny crumbs (energy or other)
  SEARCH_RADIUS: 50,               // how far from flag to look
  PATH_REUSE: 20,                  // reusePath hint
  // Optional: allow non-energy resource pickups (POWER, minerals, etc.)
  ALLOW_NON_ENERGY: true,
  // Fallback park if no flag & no home (harmless; rarely used)
  PARK_POS: { x:25, y:25, roomName:"W0N0" },

  //--- Pathing (used by Queen)----
  STUCK_TICKS: 6,
  MOVE_PRIORITIES: { withdraw: 60, pickup: 70, deliver: 55, idle: 5 },

  // --- Pathing (used by Courier & any others that want it) ---
  PATH_REUSE: 40,
  MAX_OPS_MOVE: 2000,
  TRAVEL_MAX_OPS: 4000,
  // --- Targeting cadences (Courier) ---
  RETARGET_COOLDOWN: 10,
  GRAVE_SCAN_COOLDOWN: 20,
  BETTER_CONTAINER_DELTA: 150,
  // --- Thresholds / radii (Courier) ---
  CONTAINER_MIN: 50,
  DROPPED_BIG_MIN: 150,
  DROPPED_NEAR_CONTAINER_R: 2,
  DROPPED_ALONG_ROUTE_R: 2,
});

var REMOTE_DEFENSE_MAX_DISTANCE = 2;
var THREAT_DECAY_TICKS_COPY = 150;

//=========================
//      Debug helpers
//=========================
function debugLabel(room, pos, text, color) {
  if (!CFG.DEBUG_DRAW || !room || !room.visual || !pos || !text) return;
  try {
    room.visual.text(text, pos.x, pos.y - 1.2, {
      color: color || CFG.DRAW.TEXT, font: CFG.DRAW.FONT, opacity: 0.95, align: "center",
      backgroundColor: "#000000", backgroundOpacity: 0.25
    });
  } catch (e) {}
}

//=========================
//      Threat helpers
//=========================
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
      if (since > THREAT_DECAY_TICKS_COPY) rec.lastScore = 0;
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
    // Respect manual squads that already claimed this flag name.
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
    intel.bindings[flagName] = { flagName: flagName, target: serialized, targetId: bucket.targetId, source: 'Scout' };
  }
}

// -----------------------------------------------------------------------------
// Role: Scout
// Purpose: Explore rooms around home and gather intel
// States: TRAVEL, SCOUT, RETURN, IDLE
// -----------------------------------------------------------------------------
var STATE_IDLE = 'IDLE';
var STATE_TRAVEL = 'TRAVEL';
var STATE_SCOUT = 'SCOUT';
var STATE_RETURN = 'RETURN';
var ROOM_STAY_TICKS = 75;
var REVISIT_TICKS = 750;
var INTEL_INTERVAL = 150;
var PATH_REUSE = 30;

function stampVisit(roomName) {
  if (!roomName) return;
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
  var rm = Memory.rooms[roomName];
  if (!rm.scout) rm.scout = {};
  rm.scout.lastVisited = Game.time;
}

function lastVisited(roomName) {
  if (!Memory.rooms) return -Infinity;
  var mr = Memory.rooms[roomName];
  var scout = mr && mr.scout;
  return (scout && typeof scout.lastVisited === 'number') ? scout.lastVisited : -Infinity;
}

function shouldLogIntel(room) {
  var r = (Memory.rooms && Memory.rooms[room.name]) ? Memory.rooms[room.name] : null;
  var lastScan = (r && r.intel && r.intel.lastScanAt) ? r.intel.lastScanAt : -Infinity;
  return (Game.time - lastScan) >= INTEL_INTERVAL;
}

function getMyUsername(creep) {
  if (creep && creep.owner && creep.owner.username) return creep.owner.username;
  for (var name in Game.spawns) {
    var sp = Game.spawns[name];
    if (sp && sp.my && sp.owner && sp.owner.username) return sp.owner.username;
  }
  for (var r in Game.rooms) {
    var rm = Game.rooms[r];
    if (rm && rm.controller && rm.controller.my && rm.controller.owner && rm.controller.owner.username) {
      return rm.controller.owner.username;
    }
  }
  return null;
}

function getRoomIntel(roomName) {
  if (!Memory.rooms) return null;
  var mr = Memory.rooms[roomName];
  return (mr && mr.intel) ? mr.intel : null;
}

function shouldScoutSkipPlayerRoom(roomName, creep) {
  var intel = getRoomIntel(roomName);
  if (!intel) return false;
  var myName = getMyUsername(creep);
  if (intel.owner && intel.owner !== 'Invader' && intel.owner !== myName) return true;
  if (intel.reservation && intel.reservation !== 'Invader' && intel.reservation !== myName) return true;
  return false;
}

function seedSourcesFromVision(room) {
  if (!room) return;
  Memory.rooms = Memory.rooms || {};
  var rm = Memory.rooms[room.name] = (Memory.rooms[room.name] || {});
  rm.sources = rm.sources || {};
  var arr = room.find(FIND_SOURCES);
  for (var i = 0; i < arr.length; i++) {
    var s = arr[i];
    var rec = rm.sources[s.id] = (rm.sources[s.id] || {});
    rec.roomName = room.name;
    rec.x = s.pos.x;
    rec.y = s.pos.y;
    rec.lastSeen = Game.time;
  }
}

function logRoomIntel(room) {
  if (!room) return;
  Memory.rooms = Memory.rooms || {};
  var rmem = Memory.rooms[room.name] = (Memory.rooms[room.name] || {});
  var intel = rmem.intel = (rmem.intel || {});
  intel.lastVisited = Game.time;
  intel.lastScanAt  = Game.time;

  intel.sources = room.find(FIND_SOURCES).length;

  var c = room.controller;
  if (c) {
    intel.owner       = (c.owner && c.owner.username) || null;
    intel.reservation = (c.reservation && c.reservation.username) || null;
    intel.rcl         = c.level || 0;
    intel.safeMode    = c.safeMode || 0;
  }

  var cores = room.find(FIND_STRUCTURES, { filter: function(s){ return s.structureType === STRUCTURE_INVADER_CORE; } });
  if (cores.length) {
    var core = cores[0];
    intel.invaderCore = {
      present: true,
      x: core.pos.x, y: core.pos.y,
      level: (typeof core.level === 'number' ? core.level : null),
      ticksToDeploy: (typeof core.ticksToDeploy === 'number' ? core.ticksToDeploy : null),
      t: Game.time
    };
  } else {
    intel.invaderCore = intel.invaderCore && intel.invaderCore.present ? intel.invaderCore : { present: false, t: Game.time };
  }

  var lairs = room.find(FIND_STRUCTURES, { filter: function(s){ return s.structureType === STRUCTURE_KEEPER_LAIR; } });
  intel.keeperLairs = lairs.length;

  var mins = room.find(FIND_MINERALS);
  if (mins.length) {
    var m0 = mins[0];
    intel.mineral = {
      type: m0.mineralType || null,
      x: m0.pos.x, y: m0.pos.y,
      amount: (typeof m0.mineralAmount === 'number' ? m0.mineralAmount : null),
      t: Game.time
    };
  }

  var deps = [];
  if (typeof FIND_DEPOSITS !== 'undefined') {
    var dlist = room.find(FIND_DEPOSITS) || [];
    for (var i = 0; i < dlist.length; i++) {
      var d = dlist[i];
      deps.push({ x: d.pos.x, y: d.pos.y, type: d.depositType || null, cooldown: d.cooldown || 0 });
    }
  }
  intel.deposits = deps;

  var pbs = room.find(FIND_STRUCTURES, { filter: function(s){ return s.structureType === STRUCTURE_POWER_BANK; } });
  if (pbs.length) {
    var pb = pbs[0];
    intel.powerBank = { x: pb.pos.x, y: pb.pos.y, hits: pb.hits, power: pb.power, ticksToDecay: pb.ticksToDecay };
  } else {
    intel.powerBank = null;
  }

  var portals = room.find(FIND_STRUCTURES, { filter:function(s){return s.structureType===STRUCTURE_PORTAL;} });
  var plist = [];
  for (var p = 0; p < portals.length; p++) {
    var pr = portals[p];
    plist.push({
      x: pr.pos.x, y: pr.pos.y,
      toRoom: (pr.destination && pr.destination.roomName) || null,
      toShard: (pr.destination && pr.destination.shard) || null,
      decay: (typeof pr.ticksToDecay !== 'undefined' ? pr.ticksToDecay : null)
    });
  }
  intel.portals = plist;

  var enemySpawns = room.find(FIND_HOSTILE_STRUCTURES, { filter: function(s){ return s.structureType === STRUCTURE_SPAWN; } });
  var enemyTowers = room.find(FIND_HOSTILE_STRUCTURES, { filter: function(s){ return s.structureType === STRUCTURE_TOWER; } });
  var spArr = []; var twArr = [];
  for (var si = 0; si < enemySpawns.length; si++) spArr.push({ x: enemySpawns[si].pos.x, y: enemySpawns[si].pos.y });
  for (var ti = 0; ti < enemyTowers.length; ti++) twArr.push({ x: enemyTowers[ti].pos.x, y: enemyTowers[ti].pos.y });
  intel.enemySpawns = spArr;
  intel.enemyTowers = twArr;

  intel.hostiles = room.find(FIND_HOSTILE_CREEPS).length;

  seedSourcesFromVision(room);

  evaluateRoomThreat(room, 'Scout');

  if (CFG.DEBUG_DRAW) {
    var tag = (intel.owner ? ('👑 ' + intel.owner) : (intel.reservation ? ('📌 ' + intel.reservation) : 'free'));
    var extras = [];
    if (intel.invaderCore && intel.invaderCore.present) extras.push('IC');
    if (intel.powerBank) extras.push('PB');
    if (intel.keeperLairs) extras.push('SK:' + intel.keeperLairs);
    var text = tag + ' • src:' + intel.sources + (extras.length ? ' • ' + extras.join(',') : '');
    var center = new RoomPosition(25,25,room.name);
    debugLabel(room, center, text, CFG.DRAW.INTEL);
  }
}

function ensureScoutIdentity(creep) {
  if (!creep || !creep.memory) return;
  creep.memory.role = 'Scout';
  if (!creep.memory.task) creep.memory.task = 'scout';
}

function ensureScoutMem(creep) {
  ensureScoutIdentity(creep);
  if (!creep.memory.scout) creep.memory.scout = {};
  var m = creep.memory.scout;

  if (!m.home) {
    var spawns = [];
    for (var k in Game.spawns) if (Game.spawns.hasOwnProperty(k)) spawns.push(Game.spawns[k]);
    if (spawns.length) {
      var best = spawns[0];
      var bestD = Game.map.getRoomLinearDistance(creep.pos.roomName, best.pos.roomName);
      for (var i = 1; i < spawns.length; i++) {
        var s = spawns[i];
        var d = Game.map.getRoomLinearDistance(creep.pos.roomName, s.pos.roomName);
        if (d < bestD) { best = s; bestD = d; }
      }
      m.home = best.pos.roomName;
    } else if (Memory.firstSpawnRoom) {
      m.home = Memory.firstSpawnRoom;
    } else {
      m.home = creep.pos.roomName;
    }
  }

  if (m.targetRoom == null && creep.memory.targetRoom) m.targetRoom = creep.memory.targetRoom;
  if (!m.state) m.state = STATE_IDLE;
  if (typeof m.exitIndex !== 'number') m.exitIndex = 0;
  return m;
}

function getIntelAge(roomName) {
  var age = Infinity;
  var intel = ensureCombatIntelMemory();
  if (intel && intel.rooms && intel.rooms[roomName] && intel.rooms[roomName].lastSeen) {
    age = Game.time - intel.rooms[roomName].lastSeen;
  }
  var last = lastVisited(roomName);
  if (last !== -Infinity) {
    var alt = Game.time - last;
    if (age === Infinity || alt > age) age = alt;
  }
  return age;
}

function chooseTargetRoom(creep, mem) {
  var desc = Game.map.describeExits(creep.pos.roomName) || {};
  var exits = [];
  for (var dir in desc) {
    if (!desc.hasOwnProperty(dir)) continue;
    if (!desc[dir]) continue;
    exits.push(desc[dir]);
  }

  var best = null;
  var bestScore = -Infinity;
  for (var i = 0; i < exits.length; i++) {
    var rn = exits[i];
    if (rn === mem.home) continue;
    if (shouldScoutSkipPlayerRoom(rn, creep)) continue;
    var age = getIntelAge(rn);
    var score = age;
    if (age === Infinity) score = 999999;
    if (age < REVISIT_TICKS) score = score / 10;
    if (score > bestScore) {
      bestScore = score;
      best = rn;
    }
  }

  if (!best && exits.length) {
    var idx = mem.exitIndex || 0;
    best = exits[idx % exits.length];
  }

  mem.exitIndex = (mem.exitIndex + 1) % (exits.length || 1);
  mem.targetRoom = best || null;
  mem.arrivedAt = null;
  mem.state = mem.targetRoom ? STATE_TRAVEL : STATE_IDLE;
  creep.memory.targetRoom = mem.targetRoom;
  return mem.targetRoom;
}

function refreshState(creep, mem) {
  if (mem.state === STATE_RETURN) {
    creep.memory.state = mem.state;
    return mem.state;
  }
  if (mem.targetRoom && creep.pos.roomName === mem.targetRoom) mem.state = STATE_SCOUT;
  else if (mem.targetRoom) mem.state = STATE_TRAVEL;
  else mem.state = STATE_IDLE;
  creep.memory.state = mem.state;
  return mem.state;
}

function updateIntel(creep) {
  var room = creep.room;
  if (!room) return null;
  stampVisit(room.name);
  if (shouldLogIntel(room)) logRoomIntel(room);
  seedSourcesFromVision(room);
  var threatInfo = evaluateRoomThreat(room, 'Scout');
  if (threatInfo && threatInfo.threat && threatInfo.threat.hasThreat && threatInfo.canEscalate) {
    ensureRemoteDefensePlan(room, threatInfo.threat, threatInfo.distance);
  }
  return threatInfo;
}

function shouldRetreat(creep, threatInfo) {
  if (threatInfo && threatInfo.threat && threatInfo.threat.hasThreat && threatInfo.threat.score > 0) return true;
  var hostiles = (creep.room && creep.room.find) ? creep.room.find(FIND_HOSTILE_CREEPS) : [];
  return hostiles.length > 0 && creep.hits < creep.hitsMax;
}

function wanderRoom(creep) {
  if (creep.room && creep.room.controller) {
    creep.travelTo(creep.room.controller, { range: 3, reusePath: 10 });
    return;
  }
  var center = new RoomPosition(25, 25, creep.pos.roomName);
  creep.travelTo(center, { range: 10, reusePath: 10 });
}

function returnHome(creep, mem) {
  var homeRoom = mem.home || creep.pos.roomName;
  var anchor = new RoomPosition(25, 25, homeRoom);
  creep.travelTo(anchor, { range: 20, reusePath: PATH_REUSE });
  if (creep.pos.roomName === homeRoom) {
    mem.state = STATE_IDLE;
    mem.targetRoom = null;
    mem.arrivedAt = null;
    creep.memory.targetRoom = null;
  }
  creep.memory.state = mem.state;
}

var roleScout = {
  role: 'Scout',
  run: function (creep) {
    var mem = ensureScoutMem(creep);

    if (!mem.targetRoom) chooseTargetRoom(creep, mem);
    var state = refreshState(creep, mem);

    if (state === STATE_RETURN) {
      returnHome(creep, mem);
      return;
    }

    if (state === STATE_TRAVEL) {
      if (!mem.targetRoom) {
        mem.state = STATE_IDLE;
        creep.memory.state = mem.state;
        return;
      }
      creep.travelTo(new RoomPosition(25, 25, mem.targetRoom), { range: 20, reusePath: PATH_REUSE });
      return;
    }

    if (state === STATE_SCOUT) {
      if (!mem.arrivedAt) mem.arrivedAt = Game.time;
      var threatInfo = updateIntel(creep);
      if (shouldRetreat(creep, threatInfo)) {
        mem.state = STATE_RETURN;
        creep.memory.state = mem.state;
        returnHome(creep, mem);
        return;
      }

      wanderRoom(creep);

      if (Game.time - mem.arrivedAt > ROOM_STAY_TICKS) {
        mem.targetRoom = null;
        mem.arrivedAt = null;
        mem.state = STATE_IDLE;
        creep.memory.targetRoom = null;
      }

      creep.memory.state = mem.state;
      return;
    }

    mem.state = STATE_IDLE;
    creep.memory.state = mem.state;
    if (!mem.targetRoom) {
      chooseTargetRoom(creep, mem);
    }
    if (!mem.targetRoom) {
      wanderRoom(creep);
    }
  }
};

module.exports = roleScout;
