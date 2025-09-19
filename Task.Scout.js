// Task.Scout.cpu.es5.js
// ES5-safe, CPU-lean scout with persistent caches and throttled intel.

'use strict';

var BeeToolbox = require('BeeToolbox');

// ---- Tunables ----
var RING_MAX           = 20;     // how far out before resetting
var REVISIT_DELAY      = 1000;   // re-visit cadence per room
var BLOCK_CHECK_DELAY  = 10000;  // how long we consider a room "blocked"
var EXIT_BLOCK_TTL     = 600;    // cache "exit blocked" checks (ticks)
var INTEL_INTERVAL     = 150;    // re-scan intel in the same room at most this often

var DIRS_CLOCKWISE = [RIGHT, BOTTOM, LEFT, TOP]; // E, S, W, N

// ---- Global caches (persist across ticks) ----
if (!global.__SCOUT) {
  global.__SCOUT = {
    statusByRoom: Object.create(null),     // rn -> {status: string, ts: Game.time}
    exitsOrdered: Object.create(null),     // rn -> [adjacent room names]
    exitBlock: Object.create(null),        // key "rn|dir" -> {blocked: bool, expire: time}
    rings: Object.create(null)             // key "home|r" -> [room names in ring]
  };
}

// ---- Room name <-> coordinate helpers (ES5) ----
function parseRoomName(name) {
  var m = /([WE])(\d+)([NS])(\d+)/.exec(name);
  if (!m) return null;
  var hx = m[1], vx = m[3];
  var x = parseInt(m[2], 10);
  var y = parseInt(m[4], 10);
  if (hx === 'W') x = -x;
  if (vx === 'N') y = -y;
  return { x: x, y: y };
}
function toRoomName(x, y) {
  var hx = x >= 0 ? 'E' : 'W';
  var vx = y >= 0 ? 'S' : 'N';
  var ax = Math.abs(x);
  var ay = Math.abs(y);
  return hx + ax + vx + ay;
}
// Generate a clockwise ring of rooms exactly at manhattan radius r around centerName
function coordinateRing(centerName, r) {
  var c = parseRoomName(centerName);
  if (!c || r < 1) return [];
  var out = [];
  var x, y;

  x = c.x + r; y = c.y - (r - 1);
  for (; y <= c.y + r; y++) out.push(toRoomName(x, y));
  y = c.y + r - 1; x = c.x + r - 1;
  for (; x >= c.x - r; x--) out.push(toRoomName(x, y));
  x = c.x - r; y = c.y + r - 1;
  for (; y >= c.y - r; y--) out.push(toRoomName(x, y));
  y = c.y - r; x = c.x - r + 1;
  for (; x <= c.x + r; x++) out.push(toRoomName(x, y));

  var seen = {};
  var dedup = [];
  for (var i = 0; i < out.length; i++) {
    if (!seen[out[i]]) { seen[out[i]] = true; dedup.push(out[i]); }
  }
  return dedup;
}

// ---- Cached map helpers ----
function okRoomName(rn) {
  var cache = global.__SCOUT.statusByRoom;
  var st = cache[rn];
  if (!st || (Game.time - st.ts > 5000)) { // refresh rarely; statuses barely change
    var s = Game.map.getRoomStatus(rn);
    st = { status: (s && s.status) || 'normal', ts: Game.time };
    cache[rn] = st;
  }
  return !(st.status === 'novice' || st.status === 'respawn' || st.status === 'closed');
}
function exitsOrdered(roomName) {
  var cache = global.__SCOUT.exitsOrdered;
  var ex = cache[roomName];
  if (!ex) {
    var desc = Game.map.describeExits(roomName) || {};
    var out = [];
    for (var i = 0; i < DIRS_CLOCKWISE.length; i++) {
      var d = DIRS_CLOCKWISE[i];
      if (desc[d]) out.push(desc[d]);
    }
    cache[roomName] = out;
    return out;
  }
  return ex;
}
function getRingCached(homeName, radius) {
  var key = homeName + '|' + radius;
  var rings = global.__SCOUT.rings;
  var r = rings[key];
  if (r) return r;

  // compute and filter forbidden statuses once
  var raw = coordinateRing(homeName, radius);
  var ok = [];
  for (var i = 0; i < raw.length; i++) {
    var rn = raw[i];
    if (okRoomName(rn)) ok.push(rn);
  }
  rings[key] = ok;
  return ok;
}
function markBlocked(roomName) {
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
  Memory.rooms[roomName].blocked = Game.time;
}
function isBlockedRecently(roomName) {
  if (!Memory.rooms) return false;
  var mr = Memory.rooms[roomName];
  var t = mr && mr.blocked;
  return !!(t && (Game.time - t < BLOCK_CHECK_DELAY));
}

// ---- Visit stamps & intel (throttled) ----
function stampVisit(roomName) {
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
function logRoomIntel(room) {
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};
  var rmem = Memory.rooms[room.name];
  if (!rmem.intel) rmem.intel = {};
  var intel = rmem.intel;

  intel.lastVisited = Game.time;
  intel.lastScanAt  = Game.time;

  intel.sources = room.find(FIND_SOURCES).length;

  var hostiles = room.find(FIND_HOSTILE_CREEPS).length;
  var invader = room.find(FIND_HOSTILE_STRUCTURES, {filter:function(s){return s.structureType===STRUCTURE_INVADER_CORE;}}).length;
  intel.hostiles = hostiles;
  intel.invaderCore = invader > 0 ? Game.time : 0;

  var portals = room.find(FIND_STRUCTURES, {filter:function(s){return s.structureType===STRUCTURE_PORTAL;}})
    .map(function(p){
      return {
        x: p.pos.x,
        y: p.pos.y,
        toRoom: (p.destination && p.destination.roomName) || null,
        toShard: (p.destination && p.destination.shard) || null,
        decay: (typeof p.ticksToDecay !== 'undefined' ? p.ticksToDecay : null)
      };
    });
  intel.portals = portals;

  var c = room.controller;
  if (c) {
    intel.owner     = (c.owner && c.owner.username) || null;
    intel.reservation = (c.reservation && c.reservation.username) || null;
    intel.rcl       = c.level || 0;
    intel.safeMode  = c.safeMode || 0;
  }
}
function shouldLogIntel(room) {
  var r = (Memory.rooms && Memory.rooms[room.name]) ? Memory.rooms[room.name] : null;
  var lastScan = (r && r.intel && r.intel.lastScanAt) ? r.intel.lastScanAt : -Infinity;
  return (Game.time - lastScan) >= INTEL_INTERVAL;
}

// ---- Scout memory helpers ----
function ensureScoutMem(creep) {
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
    } else {
      m.home = creep.pos.roomName;
    }
  }
  if (!m.ring) m.ring = 1;
  if (!Array.isArray(m.queue)) m.queue = [];
  return m;
}

// ---- Movement wrapper ----
function go(creep, dest, opts) {
  opts = opts || {};
  var desired = (opts.range != null) ? opts.range : 1;
  var reuse   = (opts.reusePath != null) ? opts.reusePath : 30;

  if (typeof BeeToolbox !== 'undefined' && BeeToolbox && BeeToolbox.BeeTravel) {
    try { BeeToolbox.BeeTravel(creep, dest, { range: desired, reusePath: reuse }); return; } catch (e) {}
  }
  if (creep.pos.getRangeTo(dest) > desired) creep.moveTo(dest, { reusePath: reuse, maxOps: 2000 });
}

// ---- Exit blocked (cached) ----
function isExitBlockedCached(room, exitDir) {
  var key = room.name + '|' + exitDir;
  var cache = global.__SCOUT.exitBlock[key];
  if (cache && cache.expire > Game.time) return cache.blocked;

  var edge = room.find(exitDir);
  var blocked = true;
  if (edge && edge.length) {
    var samples;
    if (edge.length > 6) {
      samples = [ edge[1], edge[(edge.length/3)|0], edge[(2*edge.length/3)|0], edge[edge.length-2] ];
    } else {
      samples = edge;
    }
    for (var i = 0; i < samples.length; i++) {
      var p = samples[i];
      var structs = p.lookFor(LOOK_STRUCTURES);
      var pass = true;
      for (var j = 0; j < structs.length; j++) {
        var s = structs[j];
        if (s.structureType === STRUCTURE_WALL ||
            (s.structureType === STRUCTURE_RAMPART && !s.isPublic && (!s.my))) { pass = false; break; }
      }
      if (pass) { blocked = false; break; }
    }
  }
  global.__SCOUT.exitBlock[key] = { blocked: blocked, expire: Game.time + EXIT_BLOCK_TTL };
  return blocked;
}

// ---- Queue building ----
function rebuildQueue(mem) {
  var home = mem.home;
  var ring = mem.ring;

  var layer = getRingCached(home, ring); // cached ring
  var candidates = [];
  for (var i = 0; i < layer.length; i++) {
    var rn = layer[i];
    if (!isBlockedRecently(rn)) candidates.push(rn);
  }

  var never = [];
  var seenOld = [];
  var seenFresh = [];
  for (var k = 0; k < candidates.length; k++) {
    var name = candidates[k];
    var lv = lastVisited(name);
    if (lv === -Infinity) never.push(name);
    else if (Game.time - lv >= REVISIT_DELAY) seenOld.push({ rn: name, last: lv });
    else seenFresh.push({ rn: name, last: lv });
  }

  seenOld.sort(function(a,b){ return a.last - b.last; });
  seenFresh.sort(function(a,b){ return a.last - b.last; });

  var queue = [];
  var prev = mem.prevRoom || null;

  function pushSkippingPrev(list, pick) {
    for (var t = 0; t < list.length; t++) {
      var nm = pick ? pick(list[t]) : list[t];
      if (prev && nm === prev && list.length > 1) continue;
      queue.push(nm);
    }
  }

  pushSkippingPrev(never);
  pushSkippingPrev(seenOld, function(x){ return x.rn; });
  pushSkippingPrev(seenFresh, function(x){ return x.rn; });

  mem.queue = queue;
}

// ---- API ----
var TaskScout = {
  isExitBlocked: function (creep, exitDir) {
    return isExitBlockedCached(creep.room, exitDir);
  },

  run: function (creep) {
    var M = ensureScoutMem(creep);      // { home, ring, queue, prevRoom? }
    if (!creep.memory.lastRoom) creep.memory.lastRoom = creep.room.name;

    // On room entry: stamp & (throttled) intel
    if (creep.memory.lastRoom !== creep.room.name) {
      if (!creep.memory.prevRoom) creep.memory.prevRoom = null;
      creep.memory.prevRoom = creep.memory.lastRoom;
      creep.memory.lastRoom = creep.room.name;
      creep.memory.hasAnnouncedRoomVisit = false;
      M.prevRoom = creep.memory.prevRoom || null;

      stampVisit(creep.room.name);
      logRoomIntel(creep.room); // full scan on entry

      // Clear target if we arrived at it; pause 1 tick
      if (creep.memory.targetRoom === creep.room.name) {
        creep.memory.targetRoom = null;
        return;
      }
    } else {
      // Same room: cheap stamp; only deep intel occasionally
      stampVisit(creep.room.name);
      if (shouldLogIntel(creep.room)) logRoomIntel(creep.room);
    }

    // If we have a target and not there yet, go there
    if (creep.memory.targetRoom && creep.room.name !== creep.memory.targetRoom) {
      var dir = creep.room.findExitTo(creep.memory.targetRoom);
      if (dir < 0) {
        markBlocked(creep.memory.targetRoom);
        creep.memory.targetRoom = null;
        return;
      } else {
        if (TaskScout.isExitBlocked(creep, dir)) {
          markBlocked(creep.memory.targetRoom);
          creep.memory.targetRoom = null;
          return;
        } else {
          if (creep.pos.x === 0 && dir === FIND_EXIT_LEFT)   { creep.move(LEFT);  return; }
          if (creep.pos.x === 49 && dir === FIND_EXIT_RIGHT) { creep.move(RIGHT); return; }
          if (creep.pos.y === 0 && dir === FIND_EXIT_TOP)    { creep.move(TOP);   return; }
          if (creep.pos.y === 49 && dir === FIND_EXIT_BOTTOM){ creep.move(BOTTOM);return; }
          go(creep, new RoomPosition(25, 25, creep.memory.targetRoom), { range: 20, reusePath: 50 });
          return;
        }
      }
    }

    // No target or we’re in target — build queue if needed
    if (!M.queue.length) {
      rebuildQueue(M);
      if (!M.queue.length) {
        M.ring = (M.ring && M.ring < RING_MAX) ? (M.ring + 1) : 1;
        rebuildQueue(M);
        if (!M.queue.length) {
          var fb = exitsOrdered(creep.room.name);
          var filt = [];
          for (var i = 0; i < fb.length; i++) if (okRoomName(fb[i])) filt.push(fb[i]);
          M.queue = filt;
        }
      }
    }

    // Pick next target (avoid immediate bounce)
    while (M.queue.length) {
      var next = M.queue.shift();
      if (!okRoomName(next) || isBlockedRecently(next)) continue;
      if (next === (M.prevRoom || null) && M.queue.length) continue;
      creep.memory.targetRoom = next;
      creep.memory.hasAnnouncedRoomVisit = false;
      break;
    }

    if (!creep.memory.targetRoom) {
      go(creep, new RoomPosition(25, 25, creep.room.name), { range: 10, reusePath: 50 });
      return;
    }

    if (creep.room.name === creep.memory.targetRoom) {
      creep.memory.targetRoom = null;
      return;
    }

    go(creep, new RoomPosition(25, 25, creep.memory.targetRoom), { range: 20, reusePath: 50 });
  }
};

module.exports = TaskScout;
