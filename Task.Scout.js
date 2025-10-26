// Task.Scout.spread.es5.js
// ES5-safe, Traveler-powered scout that fans out within EXPLORE_RADIUS,
// coordinates across multiple scouts, and avoids exit deadlocks in low-exit rooms.

'use strict';

var AllianceManager = require('AllianceManager');
try { require('Traveler'); } catch (e) {} // ensure creep.travelTo exists

// ---------- Tunables ----------
var EXPLORE_RADIUS     = 5;      // max linear distance (rooms) from home
var REVISIT_DELAY      = 1000;   // re-visit cadence per room
var BLOCK_CHECK_DELAY  = 10000;  // keep a room "blocked" this long
var EXIT_BLOCK_TTL     = 600;    // cache exit-is-blocked checks
var INTEL_INTERVAL     = 150;    // same-room deep intel cadence
var PATH_REUSE         = 50;     // path reuse for inter-room moves
var DIRS_CLOCKWISE     = [RIGHT, BOTTOM, LEFT, TOP]; // E,S,W,N

var DEFAULT_FOREIGN_AVOID_TTL = 500;
var IMPORTANT_FOREIGN_STRUCTURES = {};
IMPORTANT_FOREIGN_STRUCTURES[STRUCTURE_TOWER] = true;
IMPORTANT_FOREIGN_STRUCTURES[STRUCTURE_SPAWN] = true;
IMPORTANT_FOREIGN_STRUCTURES[STRUCTURE_EXTENSION] = true;
IMPORTANT_FOREIGN_STRUCTURES[STRUCTURE_STORAGE] = true;
IMPORTANT_FOREIGN_STRUCTURES[STRUCTURE_TERMINAL] = true;
IMPORTANT_FOREIGN_STRUCTURES[STRUCTURE_NUKER] = true;
IMPORTANT_FOREIGN_STRUCTURES[STRUCTURE_POWER_SPAWN] = true;
IMPORTANT_FOREIGN_STRUCTURES[STRUCTURE_OBSERVER] = true;
IMPORTANT_FOREIGN_STRUCTURES[STRUCTURE_FACTORY] = true;
IMPORTANT_FOREIGN_STRUCTURES[STRUCTURE_LAB] = true;
IMPORTANT_FOREIGN_STRUCTURES[STRUCTURE_LINK] = true;

var _cachedUsername = null;

function isValidRoomName(name) {
  if (typeof name !== 'string') return false;
  return /^[WE]\d+[NS]\d+$/.test(name);
}

function safeLinearDistance(a, b, allowInexact) {
  if (!isValidRoomName(a) || !isValidRoomName(b)) return 9999;
  if (!Game || !Game.map || typeof Game.map.getRoomLinearDistance !== 'function') return 9999;
  return Game.map.getRoomLinearDistance(a, b, allowInexact);
}

function getRoomMemory(roomName) {
  if (!isValidRoomName(roomName)) return null;
  Memory.rooms = Memory.rooms || {};
  if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
  return Memory.rooms[roomName];
}

function getMyUsername() {
  if (_cachedUsername) return _cachedUsername;
  var name = null;
  var key;
  for (key in Game.spawns) {
    if (!Game.spawns.hasOwnProperty(key)) continue;
    var sp = Game.spawns[key];
    if (sp && sp.owner && sp.owner.username) { name = sp.owner.username; break; }
  }
  if (!name) {
    for (key in Game.creeps) {
      if (!Game.creeps.hasOwnProperty(key)) continue;
      var c = Game.creeps[key];
      if (c && c.owner && c.owner.username) { name = c.owner.username; break; }
    }
  }
  _cachedUsername = name || 'me';
  return _cachedUsername;
}

function cleanupRoomForeignAvoid(roomMem) {
  if (!roomMem) return;
  if (typeof roomMem._avoidOtherOwnerUntil === 'number' && roomMem._avoidOtherOwnerUntil <= Game.time) {
    delete roomMem._avoidOtherOwnerUntil;
    delete roomMem._avoidOtherOwnerBy;
    delete roomMem._avoidOtherOwnerReason;
  }
}

function markRoomForeignAvoid(roomMem, owner, reason, ttl) {
  if (!roomMem) return;
  var expire = Game.time + (typeof ttl === 'number' ? ttl : DEFAULT_FOREIGN_AVOID_TTL);
  roomMem._avoidOtherOwnerUntil = expire;
  roomMem._avoidOtherOwnerBy = owner || null;
  roomMem._avoidOtherOwnerReason = reason || null;
}

function isAllyUsername(username) {
  if (!username) return false;
  if (AllianceManager && typeof AllianceManager.isAlly === 'function') {
    return AllianceManager.isAlly(username);
  }
  return false;
}

function detectForeignPresence(roomName, roomObj, roomMem) {
  var mem = roomMem;
  if (!mem) mem = getRoomMemory(roomName);
  if (mem) cleanupRoomForeignAvoid(mem);

  if (mem && typeof mem._avoidOtherOwnerUntil === 'number' && mem._avoidOtherOwnerUntil > Game.time) {
    return {
      avoid: true,
      owner: mem._avoidOtherOwnerBy || null,
      reason: mem._avoidOtherOwnerReason || 'recentForeign',
      memo: true
    };
  }

  var myName = getMyUsername();

  if (roomObj) {
    var ctrl = roomObj.controller;
    if (ctrl) {
      if (ctrl.my === false && ctrl.owner && ctrl.owner.username && ctrl.owner.username !== myName) {
        return { avoid: true, owner: ctrl.owner.username, reason: 'controllerOwned' };
      }
      if (ctrl.reservation && ctrl.reservation.username && ctrl.reservation.username !== myName) {
        return { avoid: true, owner: ctrl.reservation.username, reason: 'reserved' };
      }
    }

    var hostiles = roomObj.find(FIND_HOSTILE_CREEPS, {
      filter: function (h) {
        if (!h || !h.owner) return false;
        var uname = h.owner.username;
        if (uname === 'Invader' || uname === 'Source Keeper') return false;
        if (isAllyUsername(uname)) return false;
        return uname !== myName;
      }
    }) || [];
    if (hostiles.length) {
      return { avoid: true, owner: (hostiles[0].owner && hostiles[0].owner.username) || null, reason: 'hostileCreeps' };
    }

    var hostileStructs = roomObj.find(FIND_HOSTILE_STRUCTURES, {
      filter: function (s) {
        if (!s || !s.owner) return false;
        if (s.owner.username === myName) return false;
        if (isAllyUsername(s.owner.username)) return false;
        return IMPORTANT_FOREIGN_STRUCTURES[s.structureType] === true;
      }
    }) || [];
    if (hostileStructs.length) {
      return { avoid: true, owner: (hostileStructs[0].owner && hostileStructs[0].owner.username) || null, reason: 'hostileStructures' };
    }
  }

  if (mem && mem.intel) {
    var intel = mem.intel;
    if (intel.owner && intel.owner !== myName && !isAllyUsername(intel.owner)) {
      return { avoid: true, owner: intel.owner, reason: 'intelOwner' };
    }
    if (intel.reservation && intel.reservation !== myName && !isAllyUsername(intel.reservation)) {
      return { avoid: true, owner: intel.reservation, reason: 'intelReservation' };
    }
  }

  return { avoid: false };
}

function getTravelRoomCallback() {
  if (typeof global !== 'undefined') {
    if (global.BeeToolbox && typeof global.BeeToolbox.roomCallback === 'function') {
      return global.BeeToolbox.roomCallback;
    }
    if (typeof global.__beeRoomCallback === 'function') {
      return global.__beeRoomCallback;
    }
  }
  return null;
}

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

  var rm = getRoomMemory(room.name);
  var foreign = detectForeignPresence(room.name, room, rm);
  if (foreign.avoid && !foreign.memo) {
    markRoomForeignAvoid(rm, foreign.owner, foreign.reason);
  }

  updateAttackOrders(room);
}

function isEnemyPlayer(username) {
  if (!username) return false;
  if (username === 'Invader' || username === 'Source Keeper') return false;
  if (AllianceManager && typeof AllianceManager.isAlly === 'function' && AllianceManager.isAlly(username)) return false;
  var mine = getMyUsername();
  if (mine && username === mine) return false;
  return true;
}

function analyzeRoomThreat(room) {
  if (!room) return null;
  var info = null;
  var hostileCreeps = room.find(FIND_HOSTILE_CREEPS, {
    filter: function (c) {
      var owner = c.owner && c.owner.username;
      return isEnemyPlayer(owner);
    }
  });
  if (hostileCreeps.length) {
    var ownerName = hostileCreeps[0].owner && hostileCreeps[0].owner.username;
    info = {
      owner: ownerName,
      type: 'creep',
      count: hostileCreeps.length,
      threat: 'creeps'
    };
    return info;
  }

  var hostileStructures = room.find(FIND_HOSTILE_STRUCTURES, {
    filter: function (s) {
      var owner = s.owner && s.owner.username;
      return isEnemyPlayer(owner);
    }
  });
  if (hostileStructures.length) {
    var priorities = [STRUCTURE_TOWER, STRUCTURE_SPAWN, STRUCTURE_STORAGE, STRUCTURE_TERMINAL];
    var selected = hostileStructures[0];
    for (var i = 0; i < priorities.length; i++) {
      for (var j = 0; j < hostileStructures.length; j++) {
        if (hostileStructures[j].structureType === priorities[i]) {
          selected = hostileStructures[j];
          break;
        }
      }
      if (selected && selected.structureType === priorities[i]) break;
    }
    info = {
      owner: selected.owner && selected.owner.username,
      type: selected.structureType || 'structure',
      count: hostileStructures.length,
      threat: 'structures'
    };
    return info;
  }

  if (room.controller) {
    var ctrlOwner = room.controller.owner && room.controller.owner.username;
    if (isEnemyPlayer(ctrlOwner)) {
      return {
        owner: ctrlOwner,
        type: 'controller',
        count: 1,
        threat: 'controller'
      };
    }
    var reservation = room.controller.reservation && room.controller.reservation.username;
    if (isEnemyPlayer(reservation)) {
      return {
        owner: reservation,
        type: 'reservation',
        count: 1,
        threat: 'reservation'
      };
    }
  }

  return null;
}

function updateAttackOrders(room) {
  if (!room) return;
  var intel = analyzeRoomThreat(room);
  Memory.attackTargets = Memory.attackTargets || {};
  var record = Memory.attackTargets[room.name];

  if (intel) {
    var changed = !record || record.owner !== intel.owner || record.type !== intel.type || record.count !== intel.count;
    Memory.attackTargets[room.name] = {
      roomName: room.name,
      owner: intel.owner,
      type: intel.type,
      count: intel.count,
      threat: intel.threat,
      updatedAt: Game.time,
      source: 'scout'
    };
    if (changed) {
      var verb = record ? 'updated' : 'created';
      var ownerName = intel.owner || 'unknown';
      console.log('[SCOUT] Attack order ' + verb + ' room=' + room.name + ' owner=' + ownerName + ' threat=' + intel.threat + ' count=' + intel.count);
    }
  } else if (record && record.source === 'scout') {
    delete Memory.attackTargets[room.name];
    console.log('[SCOUT] Attack order cleared room=' + room.name);
  }
}

// ---------- Scout memory ----------
function ensureScoutMem(creep) {
  if (!creep.memory.scout) creep.memory.scout = {};
  var m = creep.memory.scout;

  if (!m.home) {
    var spawns = [];
    for (var k in Game.spawns) if (Game.spawns.hasOwnProperty(k)) spawns.push(Game.spawns[k]);
    if (spawns.length) {
      var best = spawns[0];
      var bestD = safeLinearDistance(creep.pos.roomName, best.pos.roomName);
      for (var i = 1; i < spawns.length; i++) {
        var s = spawns[i];
        var d = safeLinearDistance(creep.pos.roomName, s.pos.roomName);
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

// ---------- Movement (Traveler wrapper) ----------
function go(creep, dest, opts) {
  opts = opts || {};
  var desired = (opts.range != null) ? opts.range : 1;
  var reuse   = (opts.reusePath != null) ? opts.reusePath : PATH_REUSE;

  if (creep.pos.getRangeTo(dest) <= desired) return OK;

  var retData = {};
  var tOpts = {
    range: desired,
    reusePath: reuse,
    ignoreCreeps: true,
    stuckValue: 2,
    repath: 0.05,
    maxOps: 6000,
    returnData: retData
  };
  var travelCallback = getTravelRoomCallback();
  if (travelCallback) tOpts.roomCallback = travelCallback;

  return creep.travelTo((dest.pos || dest), tOpts);
}

// ---------- Exit-block cache ----------
function isExitBlockedCached(room, exitDir) {
  var key = room.name + '|' + exitDir;
  var cache = global.__SCOUT.exitBlock[key];
  if (cache && cache.expire > Game.time) return cache.blocked;

  var edge = room.find(exitDir);
  var blocked = true;
  if (edge && edge.length) {
    // If there are ANY walkable edge tiles without solid structures, it's not blocked
    var samples = edge.length > 6 ? [ edge[1], edge[(edge.length/3)|0], edge[(2*edge.length/3)|0], edge[edge.length-2] ] : edge;
    for (var i = 0; i < samples.length; i++) {
      var p = samples[i];
      var look = p.look();
      var pass = true;
      for (var j = 0; j < look.length; j++) {
        var o = look[j];
        if (o.type === LOOK_TERRAIN && o.terrain === 'wall') { pass = false; break; }
        if (o.type === LOOK_STRUCTURES) {
          var st = o.structure.structureType;
          if (st === STRUCTURE_WALL || (st === STRUCTURE_RAMPART && !o.structure.isPublic && !o.structure.my)) { pass = false; break; }
        }
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

  var all = [];
  for (var r = 1; r <= EXPLORE_RADIUS; r++) {
    var layer = getRingCached(home, r);
    for (var i = 0; i < layer.length; i++) {
      var rn = layer[i];
      if (safeLinearDistance(home, rn) <= EXPLORE_RADIUS && !isBlockedRecently(rn)) {
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
          safeLinearDistance(home, rn2) <= EXPLORE_RADIUS &&
          !isBlockedRecently(rn2)) filt.push(rn2);
    }
    queue = filt;
  }

  mem.queue = queue;
}

// pick an inward neighbor if we drift outside radius
function inwardNeighborTowardHome(current, home) {
  var neigh = exitsOrdered(current);
  var best = null, bestD = 9999;
  for (var i = 0; i < neigh.length; i++) {
    var rn = neigh[i];
    var d = safeLinearDistance(home, rn);
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
  if (fromRoom === toRoom) return null;
  var route = Game.map.findRoute(fromRoom, toRoom, {
    routeCallback: function (roomName) {
      if (!okRoomName(roomName) || isBlockedRecently(roomName)) return Infinity;
      return 1;
    }
  });
  if (route === ERR_NO_PATH || !route || !route.length) return null;
  // first step tells us the next neighbor room name
  var dir = route[0].exit; // FIND_EXIT_*
  var desc = Game.map.describeExits(fromRoom) || {};
  return desc[dir] || null;
}

// ---------- API ----------
var TaskScout = {
  isExitBlocked: function (creep, exitDir) { return isExitBlockedCached(creep.room, exitDir); },

  run: function (creep) {
    var M = ensureScoutMem(creep); // {home, queue, prevRoom?}
    if (!creep.memory.lastRoom) creep.memory.lastRoom = creep.room.name;

    // leash: if we're outside radius, step one room inward first
    var curDist = safeLinearDistance(M.home, creep.room.name);
    if (curDist > EXPLORE_RADIUS) {
      var back = inwardNeighborTowardHome(creep.room.name, M.home);
      if (back) {
        creep.memory.targetRoom = back;
        creep.memory.nextHop = back;
      }
    }

    // Entered a new room: stamp & intel
    if (creep.memory.lastRoom !== creep.room.name) {
      if (!creep.memory.prevRoom) creep.memory.prevRoom = null;
      creep.memory.prevRoom = creep.memory.lastRoom;
      creep.memory.lastRoom = creep.room.name;
      M.prevRoom = creep.memory.prevRoom || null;

      stampVisit(creep.room.name);
      logRoomIntel(creep.room);

      // clear per-room waypoint on arrival
      if (creep.memory.targetRoom === creep.room.name) {
        creep.memory.targetRoom = null;
        creep.memory.nextHop = null;
        return;
      }
    } else {
      stampVisit(creep.room.name);
      if (shouldLogIntel(creep.room)) logRoomIntel(creep.room);
    }

    // If we have a target, ensure nextHop is set and go via waypoint
    if (creep.memory.targetRoom && creep.room.name !== creep.memory.targetRoom) {
      // ensure we have a nextHop
      var hop = creep.memory.nextHop;
      if (!hop || hop === creep.room.name) {
        hop = computeNextHop(creep.room.name, creep.memory.targetRoom);
        creep.memory.nextHop = hop;
      }
      if (!hop) {
        // route no longer valid; mark and drop
        markBlocked(creep.memory.targetRoom);
        creep.memory.targetRoom = null;
        creep.memory.nextHop = null;
        return;
      }

      var dir = creep.room.findExitTo(hop);
      if (dir < 0) {
        markBlocked(hop);
        creep.memory.nextHop = null;
        return;
      }
      if (TaskScout.isExitBlocked(creep, dir)) {
        markBlocked(hop);
        creep.memory.nextHop = null;
        return;
      }

      // step toward the center of hop (waypoint)
      go(creep, new RoomPosition(25, 25, hop), { range: 20, reusePath: PATH_REUSE });
      return;
    }

    // No target (or we just arrived) — ensure a queue spanning all rings
    if (!M.queue.length) {
      rebuildQueueAllRings(M, creep);
    }

    // Choose next target with same-tick claim — but allow shared gateways if home has ≤2 exits
    var allowGatewayShare = isGatewayHome(M.home);
    while (M.queue.length) {
      var next = M.queue.shift();
      if (!okRoomName(next) || isBlockedRecently(next)) continue;
      if (safeLinearDistance(M.home, next) > EXPLORE_RADIUS) continue;
      if (next === (M.prevRoom || null) && M.queue.length) continue;

      var claimOK = tryClaimRoomThisTick(creep, next);
      if (!claimOK) {
        // If this is an adjacent gateway off a low-exit home, allow sharing
        if (!(allowGatewayShare && isAdjToHome(M.home, next))) continue; // still skip if not a gateway
      }

      creep.memory.targetRoom = next;
      creep.memory.nextHop = computeNextHop(creep.room.name, next);
      break;
    }

    // If still nothing to do, idle slightly off-center
    if (!creep.memory.targetRoom) {
      go(creep, new RoomPosition(25, 25, creep.room.name), { range: 10, reusePath: PATH_REUSE });
      return;
    }

    // Start moving toward first hop of the route
    if (creep.room.name !== creep.memory.targetRoom) {
      var nh = creep.memory.nextHop || computeNextHop(creep.room.name, creep.memory.targetRoom);
      if (!nh) {
        markBlocked(creep.memory.targetRoom);
        creep.memory.targetRoom = null;
        creep.memory.nextHop = null;
        return;
      }
      creep.memory.nextHop = nh;

      var dir2 = creep.room.findExitTo(nh);
      if (dir2 < 0 || TaskScout.isExitBlocked(creep, dir2)) {
        markBlocked(nh);
        creep.memory.nextHop = null;
        return;
      }
      go(creep, new RoomPosition(25, 25, nh), { range: 20, reusePath: PATH_REUSE });
    } else {
      creep.memory.targetRoom = null; // arrived
      creep.memory.nextHop = null;
    }
  }
};

module.exports = TaskScout;
