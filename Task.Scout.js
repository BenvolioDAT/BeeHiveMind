// Task.Scout.spread.es5.js
// ES5-safe, CPU-lean scout that fans out within EXPLORE_RADIUS, coordinates
// across multiple scouts, and logs rich intel without orbiting home.

'use strict';

var BeeToolbox = require('BeeToolbox');

// ---------- Tunables ----------
var EXPLORE_RADIUS     = 5;     // max linear distance (rooms) from home
var REVISIT_DELAY      = 1000;   // re-visit cadence per room
var BLOCK_CHECK_DELAY  = 10000;  // keep a room "blocked" this long
var EXIT_BLOCK_TTL     = 600;    // cache exit-is-blocked checks
var INTEL_INTERVAL     = 150;    // same-room deep intel cadence
var PATH_REUSE         = 50;     // path reuse for inter-room moves
var DIRS_CLOCKWISE     = [RIGHT, BOTTOM, LEFT, TOP]; // E,S,W,N

// ---------- Global caches ----------
if (!global.__SCOUT) {
  global.__SCOUT = {
    statusByRoom: Object.create(null),     // rn -> {status, ts}
    exitsOrdered: Object.create(null),     // rn -> [adjacent rn]
    exitBlock: Object.create(null),        // "rn|dir" -> {blocked, expire}
    rings: Object.create(null)             // "home|r" -> [rn...]
  };
}

// ---------- Name <-> coords ----------
function parseRoomName(name) {
  var m = /([WE])(\d+)([NS])(\d+)/.exec(name);
  if (!m) return null;
  var hx = m[1], vx = m[3];
  var x = parseInt(m[2], 10), y = parseInt(m[4], 10);
  if (hx === 'W') x = -x;
  if (vx === 'N') y = -y;
  return { x: x, y: y };
}
function toRoomName(x, y) {
  var hx = x >= 0 ? 'E' : 'W';
  var vx = y >= 0 ? 'S' : 'N';
  var ax = Math.abs(x), ay = Math.abs(y);
  return hx + ax + vx + ay;
}

// Ring of rooms at manhattan radius r around centerName
function coordinateRing(centerName, r) {
  var c = parseRoomName(centerName);
  if (!c || r < 1) return [];
  var out = [], x, y;

  x = c.x + r; y = c.y - (r - 1);
  for (; y <= c.y + r; y++) out.push(toRoomName(x, y));
  y = c.y + r - 1; x = c.x + r - 1;
  for (; x >= c.x - r; x--) out.push(toRoomName(x, y));
  x = c.x - r; y = c.y + r - 1;
  for (; y >= c.y - r; y--) out.push(toRoomName(x, y));
  y = c.y - r; x = c.x - r + 1;
  for (; x <= c.x + r; x++) out.push(toRoomName(x, y));

  // de-dup corners
  var seen = {}; var dedup = [];
  for (var i = 0; i < out.length; i++) if (!seen[out[i]]) { seen[out[i]] = true; dedup.push(out[i]); }
  return dedup;
}

// ---------- Cached helpers ----------
function okRoomName(rn) {
  var cache = global.__SCOUT.statusByRoom;
  var st = cache[rn];
  if (!st || (Game.time - st.ts > 5000)) {
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

  var raw = coordinateRing(homeName, radius);
  var ok = [];
  for (var i = 0; i < raw.length; i++) if (okRoomName(raw[i])) ok.push(raw[i]);
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

// ---------- Visit + intel ----------
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
function shouldLogIntel(room) {
  var r = (Memory.rooms && Memory.rooms[room.name]) ? Memory.rooms[room.name] : null;
  var lastScan = (r && r.intel && r.intel.lastScanAt) ? r.intel.lastScanAt : -Infinity;
  return (Game.time - lastScan) >= INTEL_INTERVAL;
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
}

// ---------- Scout memory ----------
function ensureScoutMem(creep) {
  if (!creep.memory.scout) creep.memory.scout = {};
  var m = creep.memory.scout;

  if (!m.home) {
    // prefer closest spawn; fall back to Memory.firstSpawnRoom or current room
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
  if (!Array.isArray(m.queue)) m.queue = [];
  return m;
}

// ---------- Movement ----------
function go(creep, dest, opts) {
  opts = opts || {};
  var desired = (opts.range != null) ? opts.range : 1;
  var reuse   = (opts.reusePath != null) ? opts.reusePath : PATH_REUSE;

  if (BeeToolbox && BeeToolbox.BeeTravel) {
    try { BeeToolbox.BeeTravel(creep, dest, { range: desired, reusePath: reuse }); return; } catch (e) {}
  }
  if (creep.pos.getRangeTo(dest) > desired) creep.moveTo(dest, { reusePath: reuse, maxOps: 2000 });
}

// ---------- Exit-block cache ----------
function isExitBlockedCached(room, exitDir) {
  var key = room.name + '|' + exitDir;
  var cache = global.__SCOUT.exitBlock[key];
  if (cache && cache.expire > Game.time) return cache.blocked;

  var edge = room.find(exitDir);
  var blocked = true;
  if (edge && edge.length) {
    var samples = edge.length > 6 ? [ edge[1], edge[(edge.length/3)|0], edge[(2*edge.length/3)|0], edge[edge.length-2] ] : edge;
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

// ---------- Multi-scout helpers ----------
function listScouts() {
  var out = [];
  for (var name in Game.creeps) {
    var c = Game.creeps[name];
    if (!c || !c.memory) continue;
    var tag = (c.memory.task || c.memory.role || '').toString().toLowerCase();
    if (tag === 'scout' || tag === 'task.scout' || tag.indexOf('scout') === 0) out.push(c);
  }
  out.sort(function(a,b){ return a.name < b.name ? -1 : 1; });
  return out;
}
function cohortIndex(creep) {
  var cohort = listScouts();
  for (var i = 0; i < cohort.length; i++) if (cohort[i].name === creep.name) return { idx: i, n: cohort.length };
  return { idx: (creep.name.charCodeAt(0) + creep.name.length) % 3, n: 3 };
}
function _scoutClaimTable() {
  var sc = Memory._scoutClaim;
  if (!sc || sc.t !== Game.time) Memory._scoutClaim = { t: Game.time, m: {} };
  return Memory._scoutClaim.m;
}
function tryClaimRoomThisTick(creep, roomName) {
  var m = _scoutClaimTable();
  var cur = m[roomName];
  if (!cur) { m[roomName] = creep.name; return true; }
  if (creep.name < cur) { m[roomName] = creep.name; return true; }
  return cur === creep.name;
}

// ---------- Queue building (ALL rings up to radius) ----------
function rebuildQueueAllRings(mem, creep) {
  var home = mem.home;
  var ci = cohortIndex(creep);
  var strideIdx = ci.idx;
  var strideN   = Math.max(1, ci.n);

  // gather candidates from rings 1..EXPLORE_RADIUS
  var all = [];
  for (var r = 1; r <= EXPLORE_RADIUS; r++) {
    var layer = getRingCached(home, r);
    for (var i = 0; i < layer.length; i++) {
      var rn = layer[i];
      if (Game.map.getRoomLinearDistance(home, rn) <= EXPLORE_RADIUS && !isBlockedRecently(rn)) {
        all.push(rn);
      }
    }
  }

  // freshness buckets
  var never = [];
  var seenOld = [];
  var seenFresh = [];
  for (var k = 0; k < all.length; k++) {
    var name = all[k];
    var lv = lastVisited(name);
    if (lv === -Infinity) never.push(name);
    else if (Game.time - lv >= REVISIT_DELAY) seenOld.push({ rn: name, last: lv });
    else seenFresh.push({ rn: name, last: lv });
  }
  seenOld.sort(function(a,b){ return a.last - b.last; });
  seenFresh.sort(function(a,b){ return a.last - b.last; });

  function strideList(arr) {
    var out = [];
    var L = arr.length;
    if (!L) return out;
    for (var s = strideIdx; s < L; s += strideN) out.push(arr[s]);
    if (!out.length && L) out.push(arr[0]);
    return out;
  }
  function strideObjList(arr) {
    var just = []; for (var i = 0; i < arr.length; i++) just.push(arr[i].rn);
    return strideList(just);
  }

  var queue = [];
  var prev = mem.prevRoom || null;
  function pushSkippingPrev(list) {
    for (var t = 0; t < list.length; t++) {
      var nm = list[t];
      if (prev && nm === prev && list.length > 1) continue;
      queue.push(nm);
    }
  }

  pushSkippingPrev(strideList(never));
  pushSkippingPrev(strideObjList(seenOld));
  pushSkippingPrev(strideObjList(seenFresh));

  // worst-case fallback: immediate neighbors (still radius-clamped)
  if (!queue.length) {
    var fb = exitsOrdered(creep.room.name);
    var filt = [];
    for (var i2 = 0; i2 < fb.length; i2++) {
      var rn2 = fb[i2];
      if (okRoomName(rn2) &&
          Game.map.getRoomLinearDistance(home, rn2) <= EXPLORE_RADIUS &&
          !isBlockedRecently(rn2)) filt.push(rn2);
    }
    queue = filt;
  }

  mem.queue = queue;
}

// pick an inward neighbor if we somehow drift outside radius
function inwardNeighborTowardHome(current, home) {
  var neigh = exitsOrdered(current);
  var best = null, bestD = 9999;
  for (var i = 0; i < neigh.length; i++) {
    var rn = neigh[i];
    var d = Game.map.getRoomLinearDistance(home, rn);
    if (d < bestD) { bestD = d; best = rn; }
  }
  return best;
}

// ---------- API ----------
var TaskScout = {
  isExitBlocked: function (creep, exitDir) { return isExitBlockedCached(creep.room, exitDir); },

  run: function (creep) {
    var M = ensureScoutMem(creep); // {home, queue, prevRoom?}
    if (!creep.memory.lastRoom) creep.memory.lastRoom = creep.room.name;

    // leash: if we're outside radius, step one room inward first
    var curDist = Game.map.getRoomLinearDistance(M.home, creep.room.name);
    if (curDist > EXPLORE_RADIUS) {
      var back = inwardNeighborTowardHome(creep.room.name, M.home);
      if (back) {
        creep.memory.targetRoom = back;
      }
    }

    // Entered a new room: stamp & rich intel
    if (creep.memory.lastRoom !== creep.room.name) {
      if (!creep.memory.prevRoom) creep.memory.prevRoom = null;
      creep.memory.prevRoom = creep.memory.lastRoom;
      creep.memory.lastRoom = creep.room.name;
      M.prevRoom = creep.memory.prevRoom || null;

      stampVisit(creep.room.name);
      logRoomIntel(creep.room);

      if (creep.memory.targetRoom === creep.room.name) {
        creep.memory.targetRoom = null;
        return;
      }
    } else {
      stampVisit(creep.room.name);
      if (shouldLogIntel(creep.room)) logRoomIntel(creep.room);
    }

    // If we have a target and we're not there yet, proceed
    if (creep.memory.targetRoom && creep.room.name !== creep.memory.targetRoom) {
      var dir = creep.room.findExitTo(creep.memory.targetRoom);
      if (dir < 0) {
        markBlocked(creep.memory.targetRoom);
        creep.memory.targetRoom = null;
        return;
      }
      if (TaskScout.isExitBlocked(creep, dir)) {
        markBlocked(creep.memory.targetRoom);
        creep.memory.targetRoom = null;
        return;
      }
      if (creep.pos.x === 0 && dir === FIND_EXIT_LEFT)   { creep.move(LEFT);  return; }
      if (creep.pos.x === 49 && dir === FIND_EXIT_RIGHT) { creep.move(RIGHT); return; }
      if (creep.pos.y === 0 && dir === FIND_EXIT_TOP)    { creep.move(TOP);   return; }
      if (creep.pos.y === 49 && dir === FIND_EXIT_BOTTOM){ creep.move(BOTTOM);return; }

      go(creep, new RoomPosition(25, 25, creep.memory.targetRoom), { range: 20, reusePath: PATH_REUSE });
      return;
    }

    // No target (or we just arrived) — ensure a queue spanning all rings
    if (!M.queue.length) {
      rebuildQueueAllRings(M, creep);
    }

    // Pick next target; use same-tick claim to avoid duplicates
    while (M.queue.length) {
      var next = M.queue.shift();
      if (!okRoomName(next) || isBlockedRecently(next)) continue;
      if (Game.map.getRoomLinearDistance(M.home, next) > EXPLORE_RADIUS) continue;
      if (next === (M.prevRoom || null) && M.queue.length) continue;
      if (!tryClaimRoomThisTick(creep, next)) continue;
      creep.memory.targetRoom = next;
      break;
    }

    // If nothing to do, idle slightly off-center
    if (!creep.memory.targetRoom) {
      go(creep, new RoomPosition(25, 25, creep.room.name), { range: 10, reusePath: PATH_REUSE });
      return;
    }

    // Move toward target room
    if (creep.room.name !== creep.memory.targetRoom) {
      go(creep, new RoomPosition(25, 25, creep.memory.targetRoom), { range: 20, reusePath: PATH_REUSE });
    } else {
      creep.memory.targetRoom = null; // arrived
    }
  }
};

module.exports = TaskScout;
