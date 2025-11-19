'use strict';

var BeeHelper = require('role.BeeHelper');
var CFG = BeeHelper.config;
var debugSay = BeeHelper.debugSay;
var debugRing = BeeHelper.debugRing;
var debugLabel = BeeHelper.debugLabel;
var drawExitMarker = BeeHelper.drawExitMarker;
var evaluateRoomThreat = BeeHelper.evaluateRoomThreat;

var roleScout = (function () {
  var module = { exports: {} };
  var exports = module.exports;
  /** =========================
   *  Tunables (original)
   *  ========================= */
  // ---------- Tunables ----------
  var EXPLORE_RADIUS     = 5;      // max linear distance (rooms) from home
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

  // Ring of rooms at manhattan radius r
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

    // visual: center red ring if visible
    if (CFG.DEBUG_DRAW && Game.rooms[roomName]) {
      var R = Game.rooms[roomName];
      var center = new RoomPosition(25,25,roomName);
      debugRing(R, center, CFG.DRAW.BLOCK, "BLOCK");
    }
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
  // Determines our username via owner fields on creeps/spawns/rooms.
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
  // Fetches cached intel for a room if it exists in Memory.
  function getRoomIntel(roomName) {
    if (!Memory.rooms) return null;
    var mr = Memory.rooms[roomName];
    return (mr && mr.intel) ? mr.intel : null;
  }
  // True if the room is owned/reserved by another non-Invader player.
  function shouldScoutSkipPlayerRoom(roomName, creep) {
    var intel = getRoomIntel(roomName);
    if (!intel) return false;
    var myName = getMyUsername(creep);
    if (intel.owner && intel.owner !== 'Invader' && intel.owner !== myName) return true;
    if (intel.reservation && intel.reservation !== 'Invader' && intel.reservation !== myName) return true;
    return false;
  }
  // Acceptance: Scout queues skip rooms owned/reserved by non-Invader players
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

    // HUD: controller/owner/reservation + threats
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

  // ---------- Scout memory ----------
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
    if (!Array.isArray(m.queue)) m.queue = [];
    return m;
  }

  // ---------- Movement (Traveler wrapper + line) ----------
  // ---------- Exit-block cache ----------
  function isExitBlockedCached(room, exitDir) {
    var key = room.name + '|' + exitDir;
    var cache = global.__SCOUT.exitBlock[key];
    if (cache && cache.expire > Game.time) {
      if (CFG.DEBUG_DRAW) drawExitMarker(room, exitDir, cache.blocked ? "X" : "→", cache.blocked ? CFG.DRAW.EXIT_BAD : CFG.DRAW.EXIT_OK);
      return cache.blocked;
    }

    var edge = room.find(exitDir) || [];
    var blocked = true;
    if (edge.length) {
      for (var i = 0; i < edge.length; i++) {
        var p = edge[i];
        var look = p.look();
        var passable = true;
        for (var j = 0; j < look.length; j++) {
          var o = look[j];
          if (o.type === LOOK_TERRAIN && o.terrain === 'wall') { passable = false; break; }
          if (o.type === LOOK_STRUCTURES) {
            var st = o.structure.structureType;
            if (st === STRUCTURE_WALL) { passable = false; break; }
            if (st === STRUCTURE_RAMPART && !o.structure.my && !o.structure.isPublic) { passable = false; break; }
          }
        }
        if (passable) { blocked = false; break; }
      }
    } else {
      blocked = false;
    }

    global.__SCOUT.exitBlock[key] = { blocked: blocked, expire: Game.time + EXIT_BLOCK_TTL };

    if (CFG.DEBUG_DRAW) drawExitMarker(room, exitDir, blocked ? "X" : "→", blocked ? CFG.DRAW.EXIT_BAD : CFG.DRAW.EXIT_OK);
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
  // Shared tick-local map to avoid multiple scouts targeting same room.
  function getScoutClaimTable() {
    var sc = Memory._scoutClaim;
    if (!sc || sc.t !== Game.time) Memory._scoutClaim = { t: Game.time, m: {} };
    return Memory._scoutClaim.m;
  }
  function tryClaimRoomThisTick(creep, roomName) {
    var m = getScoutClaimTable();
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

    var all = [];
    for (var r = 1; r <= EXPLORE_RADIUS; r++) {
      var layer = getRingCached(home, r);
      for (var i = 0; i < layer.length; i++) {
        var rn = layer[i];
        if (Game.map.getRoomLinearDistance(home, rn) <= EXPLORE_RADIUS && !isBlockedRecently(rn) && !shouldScoutSkipPlayerRoom(rn, creep)) {
          all.push(rn);
        }
      }
    }

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
      // NOTE: stride per bucket (never/old/fresh) — avoids biasing exits
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

    // fallback: immediate neighbors (radius-clamped)
    if (!queue.length) {
      var fb = exitsOrdered(creep.room.name);
      var filt = [];
      for (var i2 = 0; i2 < fb.length; i2++) {
        var rn2 = fb[i2];
        if (okRoomName(rn2) &&
            Game.map.getRoomLinearDistance(home, rn2) <= EXPLORE_RADIUS &&
            !isBlockedRecently(rn2) &&
            !shouldScoutSkipPlayerRoom(rn2, creep)) filt.push(rn2);
      }
      queue = filt;
    }

    mem.queue = queue;

    // Visual: show queue size at center of current room
    if (CFG.DEBUG_DRAW && Game.rooms[creep.room.name]) {
      var R = Game.rooms[creep.room.name];
      var center = new RoomPosition(25,25,creep.room.name);
      debugLabel(R, center, '🧭 queue:' + (queue.length|0), CFG.DRAW.TARGET);
    }
  }

  // pick an inward neighbor if we drift outside radius
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

  // ---------- Gateway helpers ----------
  function homeNeighbors(home) { return exitsOrdered(home) || []; }
  function isAdjToHome(home, rn) {
    var n = homeNeighbors(home);
    for (var i=0;i<n.length;i++) if (n[i] === rn) return true;
    return false;
  }
  function isGatewayHome(home) { return (homeNeighbors(home).length <= 2); }

  // ---------- Next-hop routing ----------
  function computeNextHop(fromRoom, toRoom) {
    if (!fromRoom || !toRoom || fromRoom === toRoom) return null;
    var route = Game.map.findRoute(fromRoom, toRoom, {
      routeCallback: function (roomName) {
        if (!okRoomName(roomName) || isBlockedRecently(roomName)) return Infinity;
        return 1;
      }
    });
    if (route === ERR_NO_PATH || !route || !route.length) return null;
    var step = route[0];
    if (step && step.room) return step.room;
    var desc = Game.map.describeExits(fromRoom) || {};
    return step && desc[step.exit] ? desc[step.exit] : null;
  }

  // ---------- Run helpers (teaching oriented) ----------
  function enforceScoutLeash(creep, mem) {
    var curDist = Game.map.getRoomLinearDistance(mem.home, creep.room.name);
    if (curDist <= EXPLORE_RADIUS) return;
    var back = inwardNeighborTowardHome(creep.room.name, mem.home);
    if (back) {
      creep.memory.targetRoom = back;
      creep.memory.nextHop = back;
      debugSay(creep, '↩');
    }
  }

  function handleRoomArrival(creep, mem) {
    if (!creep.memory.lastRoom) creep.memory.lastRoom = creep.room.name;
    if (creep.memory.lastRoom === creep.room.name) {
      stampVisit(creep.room.name);
      if (shouldLogIntel(creep.room)) logRoomIntel(creep.room);
      return false;
    }

    if (!creep.memory.prevRoom) creep.memory.prevRoom = null;
    creep.memory.prevRoom = creep.memory.lastRoom;
    creep.memory.lastRoom = creep.room.name;
    mem.prevRoom = creep.memory.prevRoom || null;

    stampVisit(creep.room.name);
    logRoomIntel(creep.room);

    if (CFG.DEBUG_DRAW) {
      debugRing(creep.room, creep.pos, CFG.DRAW.ROOM, "ARRIVE");
      debugLabel(creep.room, creep.pos, creep.room.name, CFG.DRAW.TEXT);
    }

    if (creep.memory.targetRoom === creep.room.name) {
      creep.memory.targetRoom = null;
      creep.memory.nextHop = null;
      return true;
    }
    return false;
  }

  function moveTowardTarget(creep) {
    var targetRoom = creep.memory.targetRoom;
    if (!targetRoom) return false;
    if (creep.room.name === targetRoom) {
      creep.memory.targetRoom = null;
      creep.memory.nextHop = null;
      return false;
    }

    var hop = creep.memory.nextHop;
    if (!hop || hop === creep.room.name) {
      hop = computeNextHop(creep.room.name, targetRoom);
      creep.memory.nextHop = hop;
    }
    if (!hop) {
      markBlocked(targetRoom);
      debugSay(creep, '⛔');
      creep.memory.targetRoom = null;
      creep.memory.nextHop = null;
      return true;
    }

    var dir = creep.room.findExitTo(hop);
    if (dir === ERR_NO_PATH || dir === ERR_INVALID_ARGS) {
      markBlocked(hop);
      creep.memory.nextHop = null;
      return true;
    }
    if (typeof dir === 'number' && dir >= 0 && isExitBlockedCached(creep.room, dir)) {
      markBlocked(hop);
      creep.memory.nextHop = null;
      return true;
    }
    if (CFG.DEBUG_DRAW && typeof dir === 'number' && dir >= 0) {
      drawExitMarker(creep.room, dir, "→", CFG.DRAW.EXIT_OK);
    }
    debugSay(creep, '➡');
    creep.travelTo(new RoomPosition(25, 25, hop), { range: 20, reusePath: PATH_REUSE, ignoreCreeps: true });
    return true;
  }

  function ensureQueueReady(mem, creep) {
    if (!mem.queue.length) rebuildQueueAllRings(mem, creep);
  }

  function chooseNextTarget(creep, mem) {
    var allowGatewayShare = isGatewayHome(mem.home);
    while (mem.queue.length) {
      var next = mem.queue.shift();
      if (!okRoomName(next) || isBlockedRecently(next)) continue;
      if (Game.map.getRoomLinearDistance(mem.home, next) > EXPLORE_RADIUS) continue;
      if (next === (mem.prevRoom || null) && mem.queue.length) continue;

      var claimOK = tryClaimRoomThisTick(creep, next);
      if (!claimOK && !(allowGatewayShare && isAdjToHome(mem.home, next))) continue;

      creep.memory.targetRoom = next;
      creep.memory.nextHop = computeNextHop(creep.room.name, next);
      if (CFG.DEBUG_DRAW && Game.rooms[creep.room.name]) {
        debugLabel(Game.rooms[creep.room.name], creep.pos, '🎯 ' + next, CFG.DRAW.TARGET);
      }
      return true;
    }
    return false;
  }

  function idleScout(creep) {
    debugSay(creep, '🕊');
    creep.travelTo(new RoomPosition(25, 25, creep.room.name), { range: 10, reusePath: PATH_REUSE, ignoreCreeps: true });
  }

  // Memory keys:
  // - scout.home: room we expand around
  // - targetRoom: current destination
  // - nextHop: cached hop toward target

  function determineScoutState(creep, mem) {
    var state = 'IDLE';
    if (creep.memory.targetRoom && creep.room && creep.room.name === creep.memory.targetRoom) state = 'ARRIVAL';
    else if (creep.memory.targetRoom) state = 'TRAVEL';
    else if (mem.queue && mem.queue.length) state = 'ASSIGN';
    creep.memory.state = state;
    return state;
  }

  // ---------- API ----------
  var roleScout = {
    role: 'Scout',
    isExitBlocked: function (creep, exitDir) { return isExitBlockedCached(creep.room, exitDir); },

    run: function (creep) {
      var M = ensureScoutMem(creep); // {home, queue, prevRoom?}

      enforceScoutLeash(creep, M);
      var state = determineScoutState(creep, M);

      if (state === 'ARRIVAL') {
        handleRoomArrival(creep, M);
        return;
      }

      if (state === 'TRAVEL' && moveTowardTarget(creep)) return;

      if (state === 'ASSIGN') {
        ensureQueueReady(M, creep);
        if (!chooseNextTarget(creep, M)) { idleScout(creep); return; }
        if (moveTowardTarget(creep)) return;
      }

      idleScout(creep);
    }
  };

  module.exports = roleScout;

  return module.exports;
})();

module.exports = roleScout;
