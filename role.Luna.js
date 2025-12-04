'use strict';

const BeeToolbox = require('BeeToolbox');
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

// =========================
// Debug helpers
// =========================
function debugSay(creep, msg) {
  if (CFG.DEBUG_SAY && creep && msg) creep.say(msg, true);
}

// Returns a RoomPosition for any target (object, pos-like, or {x,y,roomName}).
function getTargetPosition(target) {
  if (!target) return null;
  if (target.pos) return target.pos;
  if (target.x != null && target.y != null && target.roomName) return target;
  return null;
}

function debugDrawLine(creep, target, color, label) {
  if (!CFG.DEBUG_DRAW || !creep || !target) return;
  var room = creep.room; if (!room || !room.visual) return;
  var tpos = getTargetPosition(target); if (!tpos || tpos.roomName !== room.name) return;
  try {
    room.visual.line(creep.pos, tpos, {
      color: color, width: CFG.DRAW.WIDTH, opacity: CFG.DRAW.OPACITY, lineStyle: "solid"
    });
    if (label) {
      room.visual.text(label, tpos.x, tpos.y - 0.3, {
        color: color, opacity: CFG.DRAW.OPACITY, font: CFG.DRAW.FONT, align: "center"
      });
    }
  } catch (e) {}
}

function debugRing(room, pos, color, text) {
  if (!CFG.DEBUG_DRAW || !room || !room.visual || !pos) return;
  try {
    room.visual.circle(pos, { radius: 0.45, fill: 'transparent', stroke: color || '#fff', opacity: CFG.DRAW.OPACITY });
    if (text) room.visual.text(text, pos.x, pos.y - 0.6, { color: color || '#fff', opacity: CFG.DRAW.OPACITY, font: CFG.DRAW.FONT });
  } catch (e) {}
}

// =========================
// Threat helpers (copied from role.BeeWorker)
// =========================
var REMOTE_DEFENSE_MAX_DISTANCE = 2;
var THREAT_DECAY_TICKS_COPY = 150;

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

  // ============================
  // Tunables (existing behaviour)
  // ============================
  // NOTE: REMOTE_RADIUS is measured in "room hops" from the home room.
  var REMOTE_RADIUS = 3;

  var MAX_PF_OPS    = 3000;
  var PLAIN_COST    = 2;
  var SWAMP_COST    = 10;
  var MAX_LUNA_PER_SOURCE = 1;

  var PF_CACHE_TTL = 150;
  var INVADER_LOCK_MEMO_TTL = 1500;

  var AVOID_TTL = 30;
  var RETARGET_COOLDOWN = 5;

  // Small bias to keep the current owner briefly (soft preference only)
  var ASSIGN_STICKY_TTL = 50;

  // Anti-stuck
  var STUCK_WINDOW = 4;

  // Flag pruning cadence & grace (sources only)
  var FLAG_PRUNE_PERIOD   = 25;   // how often to scan for source-flag deletions
  var FLAG_RETENTION_TTL  = 200;  // keep a source-flag this many ticks since last activity

  // ============================
  // Helpers: short id, flags
  // ============================
  function shortSid(id) {
    if (!id || typeof id !== 'string') return '??????';
    var n = id.length; return id.substr(n - 6);
  }

  // Returns the Memory.rooms[roomName] bucket, creating it if missing.
  function getRoomMemoryBucket(roomName){
    Memory.rooms = Memory.rooms || {};
    return (Memory.rooms[roomName] = (Memory.rooms[roomName] || {}));
  }
  // Returns the per-source memory bucket for a given room and source id.
  function getSourceMemory(roomName, sid) {
    var rm = getRoomMemoryBucket(roomName);
    rm.sources = rm.sources || {};
    return (rm.sources[sid] = (rm.sources[sid] || {}));
  }

  // mark activity each time we touch/own/harvest a source
  function touchSourceActive(roomName, sid) {
    if (!roomName || !sid) return;
    var srec = getSourceMemory(roomName, sid);
    srec.lastActive = Game.time;
  }

  /** Ensure exactly one flag exists on this source tile (idempotent) and touch lastActive. */
  function ensureSourceFlag(source) {
    if (!source || !source.pos || !source.room) return;

    var roomName = source.pos.roomName;
    var srec = getSourceMemory(roomName, source.id);

    // reuse previous flag if it still matches this tile
    if (srec.flagName) {
      var f = Game.flags[srec.flagName];
      if (f &&
          f.pos.x === source.pos.x &&
          f.pos.y === source.pos.y &&
          f.pos.roomName === roomName) {
        touchSourceActive(roomName, source.id);
        return;
      }
    }

    // does a properly-named flag already sit here? adopt it
    var flagsHere = source.pos.lookFor(LOOK_FLAGS) || [];
    var expectedPrefix = 'SRC-' + roomName + '-';
    var sidTail = shortSid(source.id);
    for (var i = 0; i < flagsHere.length; i++) {
      var fh = flagsHere[i];
      if (typeof fh.name === 'string' &&
          fh.name.indexOf(expectedPrefix) === 0 &&
          fh.name.indexOf(sidTail) !== -1) {
        srec.flagName = fh.name;
        touchSourceActive(roomName, source.id);
        return;
      }
    }

    // create a new one
    var base = expectedPrefix + sidTail;
    var name = base, tries = 1;
    while (Game.flags[name]) { tries++; name = base + '-' + tries; if (tries > 10) break; }
    var rc = source.room.createFlag(source.pos, name, COLOR_YELLOW, COLOR_YELLOW);
    if (typeof rc === 'string') {
      srec.flagName = rc;
      touchSourceActive(roomName, source.id);
    }
  }

  // ============================
  // NEW: Controller flag helpers (Reserve:roomName style)
  // ============================
  function ensureControllerFlag(ctrl){
    if (!ctrl) return;
    var roomName = ctrl.pos.roomName;
    var rm = getRoomMemoryBucket(roomName);

    var expect = 'Reserve:' + roomName;

    if (rm.controllerFlagName) {
      var f0 = Game.flags[rm.controllerFlagName];
      if (f0 &&
          f0.pos.x === ctrl.pos.x &&
          f0.pos.y === ctrl.pos.y &&
          f0.pos.roomName === roomName) {
        return;
      }
    }

    var flagsHere = ctrl.pos.lookFor(LOOK_FLAGS) || [];
    for (var i = 0; i < flagsHere.length; i++) {
      if (flagsHere[i].name === expect) {
        rm.controllerFlagName = expect;
        return;
      }
    }

    var rc = ctrl.room.createFlag(ctrl.pos, expect, COLOR_WHITE, COLOR_PURPLE);
    if (typeof rc === 'string') rm.controllerFlagName = rc;
  }

  function pruneControllerFlagIfNoForagers(roomName, roomCountMap){
    var rm = getRoomMemoryBucket(roomName);
    var fname = rm.controllerFlagName;
    if (!fname) return;

    var count = roomCountMap && roomCountMap[roomName] ? roomCountMap[roomName] : 0;
    if (count > 0) return;

    var f = Game.flags[fname];
    if (f) {
      try { f.remove(); } catch (e) {}
    }
    delete rm.controllerFlagName;
  }

  // ============================
  // Avoid-list (per creep)
  // ============================
  // Ensures we have a creep.memory._avoid bucket to track stuck tiles.
  function ensureAvoidanceMemory(creep){
    if (!creep.memory._avoid) creep.memory._avoid = {};
    return creep.memory._avoid;
  }
  function shouldAvoid(creep, sid){ var a=ensureAvoidanceMemory(creep); var t=a[sid]; return (typeof t==='number' && Game.time<t); }
  function markAvoid(creep, sid, ttl){ var a=ensureAvoidanceMemory(creep); a[sid] = Game.time + (ttl!=null?ttl:AVOID_TTL); }
  function avoidRemaining(creep, sid){ var a=ensureAvoidanceMemory(creep); var t=a[sid]; if (typeof t!=='number') return 0; var left=t-Game.time; return left>0?left:0; }

  // ============================
  // Per-tick *claim* (same-tick contention guard)
  // ============================
  // Shared reservation table for remote mining seat claims (cleared each tick).
  function getClaimTable(){
    var sc=Memory._sourceClaim;
    if(!sc||sc.t!==Game.time){ Memory._sourceClaim={t:Game.time,m:{}}; }
    return Memory._sourceClaim.m;
  }
  function tryClaimSourceForTick(creep, sid){
    var m=getClaimTable(), cur=m[sid];
    if (!cur){ m[sid]=creep.name; return true; }
    if (creep.name < cur){ m[sid]=creep.name; return true; }
    return cur===creep.name;
  }

  // ============================
  // remoteAssignments model
  // ============================
  function ensureAssignmentsMem(){ if(!Memory.remoteAssignments) Memory.remoteAssignments={}; return Memory.remoteAssignments; }
  // Normalises a mining assignment entry so later logic can rely on keys existing.
  function ensureMiningAssignment(entry, roomName){
    if (!entry || typeof entry !== 'object') entry = { count: 0, owner: null, roomName: roomName||null, since: null };
    if (typeof entry.count !== 'number') entry.count = 0;
    if (!('owner' in entry)) entry.owner = null;
    if (!('roomName' in entry)) entry.roomName = roomName||null;
    if (!('since' in entry)) entry.since = null;
    return entry;
  }
  function maCount(memAssign, sid){
    var e = memAssign[sid];
    if (!e) return 0;
    if (typeof e === 'number') return e; // backward compat
    return typeof e.count === 'number' ? e.count : 0;
  }
  function maOwner(memAssign, sid){
    var e = memAssign[sid];
    if (!e || typeof e === 'number') return null;
    return e.owner || null;
  }
  function maSetOwner(memAssign, sid, owner, roomName){
    var e = ensureMiningAssignment(memAssign[sid], roomName);
    e.owner = owner; e.roomName = roomName || e.roomName; e.since = Game.time;
    memAssign[sid] = e;
    if (e.roomName) touchSourceActive(e.roomName, sid);
  }
  function maClearOwner(memAssign, sid){
    var e = ensureMiningAssignment(memAssign[sid], null);
    e.owner = null; e.since = null;
    memAssign[sid] = e;
  }
  function maInc(memAssign, sid, roomName){
    var e = ensureMiningAssignment(memAssign[sid], roomName);
    var current = typeof e.count === 'number' ? e.count : 0;
    e.count = current + 1;
    memAssign[sid]=e;
  }
  function maDec(memAssign, sid){
    var e = ensureMiningAssignment(memAssign[sid], null);
    var current = typeof e.count === 'number' ? e.count : 0;
    e.count = Math.max(0, current - 1);
    memAssign[sid]=e;
  }

  // ============================
  // Ownership / duplicate resolver
  // ============================
  function resolveOwnershipForSid(sid){
    var memAssign = ensureAssignmentsMem();
    var e = ensureMiningAssignment(memAssign[sid], null);

    var contenders = [];
    for (var name in Game.creeps){
      var c = Game.creeps[name];
      if (!c || !c.memory) continue;
      if (c.memory.task === 'luna' && c.memory.sourceId === sid){
        contenders.push(c);
      }
    }

    if (!contenders.length){
      maClearOwner(memAssign, sid);
      return null;
    }

    contenders.sort(function(a,b){
      var at = (a && a.memory && typeof a.memory._assignTick === 'number') ? a.memory._assignTick : 0;
      var bt = (b && b.memory && typeof b.memory._assignTick === 'number') ? b.memory._assignTick : 0;
      if (at!==bt) return at-bt;
      return a.name<b.name?-1:1;
    });
    var winner = contenders[0];

    maSetOwner(memAssign, sid, winner.name, winner.memory.targetRoom||null);

    for (var i=1; i<contenders.length; i++){
      var loser = contenders[i];
      if (loser && loser.memory && loser.memory.sourceId === sid){
        loser.memory._forceYield = true;
      }
    }

    return winner.name;
  }

  // Audits all sids once per tick: recompute counts, scrub dead owners, and prune flags
  function auditRemoteAssignments(){
    var memAssign = ensureAssignmentsMem();

    for (var sid in memAssign){
      memAssign[sid] = ensureMiningAssignment(memAssign[sid], memAssign[sid].roomName||null);
      memAssign[sid].count = 0;
    }

    var roomCounts = {};
    for (var name in Game.creeps){
      var c = Game.creeps[name];
      if (!c || !c.memory) continue;
      if (c.memory.task === 'luna') {
        if (c.memory.sourceId){
          var sid2 = c.memory.sourceId;
          var e2 = ensureMiningAssignment(memAssign[sid2], c.memory.targetRoom||null);
          var currentCount = typeof e2.count === 'number' ? e2.count : 0;
          e2.count = currentCount + 1;
          memAssign[sid2] = e2;
        }
        if (c.memory.targetRoom){
          var rn = c.memory.targetRoom;
          var roomCurrent = roomCounts[rn] || 0;
          roomCounts[rn] = roomCurrent + 1;
        }
      }
    }

    for (var sid3 in memAssign){
      var owner = maOwner(memAssign, sid3);
      if (owner){
        var oc = Game.creeps[owner];
        if (!oc || !oc.memory || oc.memory.sourceId !== sid3){
          resolveOwnershipForSid(sid3);
        }else{
          if (memAssign[sid3].count > MAX_LUNA_PER_SOURCE){
            resolveOwnershipForSid(sid3);
          }
        }
      }else{
        if (memAssign[sid3].count > 0){
          resolveOwnershipForSid(sid3);
        }
      }
    }

    if ((Game.time % FLAG_PRUNE_PERIOD) === 0) pruneUnusedSourceFlags();

    var rooms = Memory.rooms || {};
    for (var roomName in rooms) {
      if (!rooms.hasOwnProperty(roomName)) continue;
      pruneControllerFlagIfNoForagers(roomName, roomCounts);
    }
  }

  function auditOncePerTick(){
    if (Memory._auditRemoteAssignmentsTick !== Game.time){
      auditRemoteAssignments();
      Memory._auditRemoteAssignmentsTick = Game.time;
    }
  }

  // ============================
  // Flag pruning (sources)
  // ============================
  function pruneUnusedSourceFlags(){
    var memAssign = ensureAssignmentsMem();
    var now = Game.time;

    var rooms = Memory.rooms || {};
    for (var roomName in rooms){
      if (!rooms.hasOwnProperty(roomName)) continue;
      var rm = rooms[roomName]; if (!rm || !rm.sources) continue;

      var roomLocked = isRoomLockedByInvaderCore(roomName);

      for (var sid in rm.sources){
        if (!rm.sources.hasOwnProperty(sid)) continue;
        var srec = rm.sources[sid] || {};
        var flagName = srec.flagName;
        if (!flagName) continue;

        var e = ensureMiningAssignment(memAssign[sid], rm.sources[sid].roomName || roomName);
        var count  = typeof e.count === 'number' ? e.count : 0;
        var owner  = e.owner || null;
        var last   = typeof srec.lastActive === 'number' ? srec.lastActive : 0;

        var inactiveLong = (now - last) > FLAG_RETENTION_TTL;
        var nobodyOwns   = (count === 0 && owner == null);

        if (roomLocked || (nobodyOwns && inactiveLong)) {
          var f = Game.flags[flagName];
          if (f) {
            var prefix = 'SRC-' + roomName + '-';
            var looksLikeOurs = (typeof flagName === 'string' && flagName.indexOf(prefix) === 0);
            var posMatches = (!srec.x || !srec.y) ? true : (f.pos.x === srec.x && f.pos.y === srec.y);
            var srcObj = Game.getObjectById(sid);
            var tileOk = srcObj ? (f.pos.x === srcObj.pos.x && f.pos.y === srcObj.pos.y && f.pos.roomName === srcObj.pos.roomName) : true;

            if (looksLikeOurs && (posMatches && tileOk)) {
              try { f.remove(); } catch (e1) {}
            }
          }
          delete srec.flagName;
          rm.sources[sid] = srec;
        }
      }
    }
  }

  // ============================
  // Pathing helpers (Traveler-first)
  // ============================
  if (!Memory._pfCost) Memory._pfCost = {};

  function pfCostCached(anchorPos, targetPos, sourceId) {
    var key = anchorPos.roomName + ':' + sourceId;
    var rec = Memory._pfCost[key];
    if (rec && (Game.time - rec.t) < PF_CACHE_TTL) return rec.c;
    var c = pfCost(anchorPos, targetPos);
    Memory._pfCost[key] = { c: c, t: Game.time };
    return c;
  }
  function pfCost(anchorPos, targetPos) {
    var ret = PathFinder.search(
      anchorPos,
      { pos: targetPos, range: 1 },
      {
        maxOps: MAX_PF_OPS,
        plainCost: PLAIN_COST,
        swampCost: SWAMP_COST,
        roomCallback: function(roomName) {
          var room = Game.rooms[roomName]; if (!room) return;
          var m = new PathFinder.CostMatrix();
          room.find(FIND_STRUCTURES).forEach(function(s){
            if (s.structureType===STRUCTURE_ROAD) m.set(s.pos.x,s.pos.y,1);
            else if (s.structureType!==STRUCTURE_CONTAINER && (s.structureType!==STRUCTURE_RAMPART || !s.my)) m.set(s.pos.x,s.pos.y,0xff);
          });
          room.find(FIND_CONSTRUCTION_SITES).forEach(function(cs){ if (cs.structureType!==STRUCTURE_ROAD) m.set(cs.pos.x,cs.pos.y,0xff); });
          return m;
        }
      }
    );
    return ret.incomplete ? Infinity : ret.cost;
  }
  // ============================
  // Room discovery & anchor
  // ============================
  function getHomeName(creep){
    if (creep.memory.home) return creep.memory.home;
    var spawns = Object.keys(Game.spawns).map(function(k){return Game.spawns[k];});
    if (spawns.length){
      var best = spawns[0], bestD = Game.map.getRoomLinearDistance(creep.pos.roomName, best.pos.roomName);
      for (var i=1;i<spawns.length;i++){
        var s=spawns[i], d=Game.map.getRoomLinearDistance(creep.pos.roomName, s.pos.roomName);
        if (d<bestD){ best=s; bestD=d; }
      }
      creep.memory.home = best.pos.roomName; return creep.memory.home;
    }
    creep.memory.home = creep.pos.roomName; return creep.memory.home;
  }
  function getAnchorPos(homeName){
    var r = Game.rooms[homeName];
    if (r){
      if (r.storage) return r.storage.pos;
      var spawns = r.find(FIND_MY_SPAWNS); if (spawns.length) return spawns[0].pos;
      if (r.controller && r.controller.my) return r.controller.pos;
    }
    return new RoomPosition(25,25,homeName);
  }
  function bfsNeighborRooms(startName, radius){
    radius = radius==null?1:radius;
    var seen={}; seen[startName]=true;
    var frontier=[startName];
    for (var depth=0; depth<radius; depth++){
      var next=[];
      for (var f=0; f<frontier.length; f++){
        var rn=frontier[f], exits=Game.map.describeExits(rn)||{};
        for (var dir in exits){ var n=exits[dir]; if(!seen[n]){ seen[n]=true; next.push(n);} }
      }
      frontier=next;
    }
    var out=[]; for (var k in seen) if (k!==startName) out.push(k);
    return out;
  }

  // ============================
  // Flagging helper (sources)
  // ============================
  function markValidRemoteSourcesForHome(homeName){
    var anchor=getAnchorPos(homeName);
    var memAssign=ensureAssignmentsMem();
    var rooms=bfsNeighborRooms(homeName, REMOTE_RADIUS);

    for (var i=0;i<rooms.length;i++){
      var rn=rooms[i], room=Game.rooms[rn]; if(!room) continue;
      var rm = getRoomMemoryBucket(rn);
      if (rm.hostile) continue;
      if (isRoomLockedByInvaderCore(rn)) continue;

      if (rm._lastValidFlagScan && (Game.time - rm._lastValidFlagScan) < 300) continue;
      rm._lastValidFlagScan = Game.time;

      var sources = room.find(FIND_SOURCES);
      for (var j=0;j<sources.length;j++){
        var s=sources[j];
        var e=ensureMiningAssignment(memAssign[s.id], rn);
        if (maCount(memAssign, s.id) >= MAX_LUNA_PER_SOURCE) continue;
        var cost = pfCostCached(anchor, s.pos, s.id); if (cost===Infinity) continue;
        ensureSourceFlag(s);
        var srec = getSourceMemory(rn, s.id); srec.x = s.pos.x; srec.y = s.pos.y;
        memAssign[s.id] = e;
      }
    }
  }

  // ============================
  // Invader lock detection
  // ============================
  function isRoomLockedByInvaderCore(roomName){
    if (!roomName) return false;
    var rm = getRoomMemoryBucket(roomName);
    var now = Game.time, room = Game.rooms[roomName];

    if (room){
      var locked=false;
      var cores = room.find(FIND_STRUCTURES, { filter:function(s){return s.structureType===STRUCTURE_INVADER_CORE;} });
      if (cores && cores.length>0) locked=true;
      if (!locked && room.controller && room.controller.reservation &&
          room.controller.reservation.username==='Invader'){ locked=true; }
      if (!locked && BeeToolbox && BeeToolbox.isRoomInvaderLocked){
        try{ if (BeeToolbox.isRoomInvaderLocked(room)) locked=true; }catch(e){}
      }
      rm._invaderLock = { locked: locked, t: now };
      return locked;
    }

    if (rm._invaderLock && typeof rm._invaderLock.locked==='boolean' && typeof rm._invaderLock.t==='number'){
      if ((now - rm._invaderLock.t) <= INVADER_LOCK_MEMO_TTL) return rm._invaderLock.locked;
    }
    return false;
  }

  // ============================
  // Picking & exclusivity
  // ============================
  function pickRemoteSource(creep){
    var memAssign = ensureAssignmentsMem();
    var homeName = getHomeName(creep);

    if ((Game.time + creep.name.charCodeAt(0)) % 50 === 0) markValidRemoteSourcesForHome(homeName);
    var anchor = getAnchorPos(homeName);

    var neighborRooms = bfsNeighborRooms(homeName, REMOTE_RADIUS);
    var candidates=[], avoided=[], i, rn;

    // 1) With vision
    for (i=0;i<neighborRooms.length;i++){
      rn=neighborRooms[i];
      if (isRoomLockedByInvaderCore(rn)) continue;
      var room=Game.rooms[rn]; if (!room) continue;

      var sources = room.find(FIND_SOURCES);
      for (var j=0;j<sources.length;j++){
        var s=sources[j];
        var cost = pfCostCached(anchor, s.pos, s.id); if (cost===Infinity) continue;
        var lin = Game.map.getRoomLinearDistance(homeName, rn);

        if (shouldAvoid(creep, s.id)){ avoided.push({id:s.id,roomName:rn,cost:cost,lin:lin,left:avoidRemaining(creep,s.id)}); continue; }
        var ownerNow = maOwner(memAssign, s.id);
        if (ownerNow && ownerNow !== creep.name) continue;
        if (maCount(memAssign, s.id) >= MAX_LUNA_PER_SOURCE) continue;

        var sticky = (creep.memory.sourceId===s.id) ? 1 : 0;
        candidates.push({ id:s.id, roomName:rn, cost:cost, lin:lin, sticky:sticky });
      }
    }

    // 2) No vision → use Memory.rooms.*.sources
    if (!candidates.length){
      for (i=0;i<neighborRooms.length;i++){
        rn=neighborRooms[i]; if (isRoomLockedByInvaderCore(rn)) continue;
        var rm = getRoomMemoryBucket(rn); if (!rm || !rm.sources) continue;
        for (var sid in rm.sources){
          if (shouldAvoid(creep, sid)){ avoided.push({id:sid,roomName:rn,cost:1e9,lin:99,left:avoidRemaining(creep,sid)}); continue; }
          var ownerNow2 = maOwner(memAssign, sid);
          if (ownerNow2 && ownerNow2 !== creep.name) continue;
          if (maCount(memAssign, sid) >= MAX_LUNA_PER_SOURCE) continue;

          var lin2 = Game.map.getRoomLinearDistance(homeName, rn);
          var synth = (lin2*200)+800;
          var sticky2 = (creep.memory.sourceId===sid) ? 1 : 0;
          candidates.push({ id:sid, roomName:rn, cost:synth, lin:lin2, sticky:sticky2 });
        }
      }
    }

    if (!candidates.length){
      if (!avoided.length) return null;
      avoided.sort(function(a,b){ return (a.left-b.left)||(a.cost-b.cost)||(a.lin-b.lin)||(a.id<b.id?-1:1); });
      var soonest = avoided[0];
      if (soonest.left <= 5) candidates.push(soonest); else return null;
    }

    candidates.sort(function(a,b){
      if (b.sticky !== a.sticky) return (b.sticky - a.sticky);
      return (a.cost-b.cost) || (a.lin-b.lin) || (a.id<b.id?-1:1);
    });

    // (Fixed loop condition)
    for (var k=0; k<candidates.length; k++){
      var best=candidates[k];
      if (!tryClaimSourceForTick(creep, best.id)) continue;

      // Reserve immediately
      maInc(memAssign, best.id, best.roomName);
      maSetOwner(memAssign, best.id, creep.name, best.roomName);

      // Visuals + say:
      var srcObj = Game.getObjectById(best.id);
      if (srcObj) {
        debugSay(creep, '🎯SRC');
        debugDrawLine(creep, srcObj, CFG.DRAW.PICK_COLOR, "PICK");
        debugRing(creep.room, srcObj.pos, CFG.DRAW.PICK_COLOR, shortSid(best.id));
      } else {
        var center = new RoomPosition(25,25,best.roomName);
        debugSay(creep, '🎯'+best.roomName);
        debugDrawLine(creep, center, CFG.DRAW.TRAVEL_COLOR, "PICK?");
      }

      if (creep.memory._lastLogSid !== best.id){
        console.log('🧭 '+creep.name+' pick src='+best.id.slice(-6)+' room='+best.roomName+' cost='+best.cost+(best.sticky?' (sticky)':''));
        creep.memory._lastLogSid = best.id;
      }
      return best;
    }

    return null;
  }

  function releaseAssignment(creep){
    var memAssign = ensureAssignmentsMem();
    var sid = creep.memory.sourceId;

    if (sid){
      maDec(memAssign, sid);
      var owner = maOwner(memAssign, sid);
      if (owner === creep.name) maClearOwner(memAssign, sid);
      markAvoid(creep, sid, AVOID_TTL);
    }

    creep.memory.sourceId   = null;
    creep.memory.targetRoom = null;
    creep.memory.assigned   = false;
    creep.memory._retargetAt = Game.time + RETARGET_COOLDOWN;

    debugSay(creep, '🌓YIELD');
  }

  function validateExclusiveSource(creep){
    if (!creep.memory || !creep.memory.sourceId) return true;

    var sid = creep.memory.sourceId;
    var memAssign = ensureAssignmentsMem();
    var owner = maOwner(memAssign, sid);

    if (owner && owner !== creep.name){
      releaseAssignment(creep);
      return false;
    }

    var winners=[];
    for (var name in Game.creeps){
      var c=Game.creeps[name];
      if (c && c.memory && c.memory.task==='luna' && c.memory.sourceId===sid){
        winners.push(c);
      }
    }
    if (winners.length <= MAX_LUNA_PER_SOURCE){
      if (!owner) maSetOwner(memAssign, sid, creep.name, creep.memory.targetRoom||null);
      return true;
    }

    winners.sort(function(a,b){
      var at = (a && a.memory && typeof a.memory._assignTick === 'number') ? a.memory._assignTick : 0;
      var bt = (b && b.memory && typeof b.memory._assignTick === 'number') ? b.memory._assignTick : 0;
      if (at!==bt) return at-bt;
      return a.name<b.name?-1:1;
    });
    var win = winners[0];
    maSetOwner(memAssign, sid, win.name, win.memory.targetRoom||null);

    if (win.name !== creep.name){
      console.log('🚦 '+creep.name+' yielding duplicate source '+sid.slice(-6)+' (backing off).');
      releaseAssignment(creep);
      return false;
    }
    return true;
  }

  // ============================
  // NEW: dump energy into build/upgrade when storage is full
  // ============================
  function tryBuildOrUpgrade(creep) {
    var hasWork = creep.getActiveBodyparts && creep.getActiveBodyparts(WORK) > 0;
    if (!hasWork) return false;

    var site = creep.pos.findClosestByRange(FIND_CONSTRUCTION_SITES);
    if (site) {
      debugSay(creep, '🔨');
      debugDrawLine(creep, site, CFG.DRAW.BUILD_COLOR, "BUILD");
      var br = creep.build(site);
      if (br === ERR_NOT_IN_RANGE) {
        creep.travelTo(site, { range: 3, reusePath: 15, });
      }
      return true;
    }

    var ctrl = creep.room.controller;
    if (ctrl && ctrl.my) {
      debugSay(creep, '⬆️');
      debugDrawLine(creep, ctrl, CFG.DRAW.UPG_COLOR, "UPG");
      var ur = creep.upgradeController(ctrl);
      if (ur === ERR_NOT_IN_RANGE) {
        creep.travelTo(ctrl, { range: 3, reusePath: 15, });
      }
      return true;
    }

    return false;
  }

  // ============================
  // Teaching helpers for the run loop
  // ============================
  function ensureLunaIdentity(creep) {
    if (!creep || !creep.memory) return;
    creep.memory.role = 'Luna';
    if (creep.memory.task === 'remoteharvest') {
      creep.memory.task = 'luna';
    } else if (!creep.memory.task) {
      creep.memory.task = 'luna';
    }
  }

  function trackMovementBreadcrumb(creep) {
    if (!creep || !creep.memory) return;
    var lastX = typeof creep.memory._lx === 'number' ? creep.memory._lx : 0;
    var lastY = typeof creep.memory._ly === 'number' ? creep.memory._ly : 0;
    var lastR = creep.memory._lr || '';
    var samePos = (lastX===creep.pos.x && lastY===creep.pos.y && lastR===creep.pos.roomName);
    var stuckTicks = typeof creep.memory._stuck === 'number' ? creep.memory._stuck : 0;
    creep.memory._stuck = samePos ? (stuckTicks + 1) : 0;
    creep.memory._lx = creep.pos.x; creep.memory._ly = creep.pos.y; creep.memory._lr = creep.pos.roomName;
  }

  function idleAtAnchor(creep, label) {
    var anchor = getAnchorPos(getHomeName(creep));
    debugSay(creep, label || 'IDLE');
    debugDrawLine(creep, anchor, CFG.DRAW.IDLE_COLOR, label || 'IDLE');
    creep.travelTo(anchor, { range: 2, reusePath: CFG.PATH_REUSE });
  }

  function shouldReleaseForEndOfLife(creep) {
    if (creep.ticksToLive!==undefined && creep.ticksToLive<5 && creep.memory.assigned){
      releaseAssignment(creep);
      return true;
    }
    return false;
  }

  function respectCooldown(creep) {
    if (creep.memory._retargetAt && Game.time < creep.memory._retargetAt){
      idleAtAnchor(creep, '…cd');
      return true;
    }
    return false;
  }

  function handleForcedYield(creep) {
    if (!creep.memory._forceYield) return false;
    delete creep.memory._forceYield;
    releaseAssignment(creep);
    return true;
  }

  function ensureActiveAssignment(creep) {
    if (creep.memory.sourceId) return true;

    var pick = pickRemoteSource(creep);
    if (pick){
      creep.memory.sourceId   = pick.id;
      creep.memory.targetRoom = pick.roomName;
      creep.memory.assigned   = true;
      creep.memory._assignTick = Game.time;
      return true;
    }

    roleLuna.initializeAndAssign(creep);
    if (!creep.memory.sourceId){
      idleAtAnchor(creep, 'IDLE');
      return false;
    }
    creep.memory._assignTick = creep.memory._assignTick || Game.time;
    return true;
  }

  function travelToAssignedRoom(creep) {
    if (!creep.memory.targetRoom || creep.pos.roomName === creep.memory.targetRoom) return false;

    var dest = new RoomPosition(25,25,creep.memory.targetRoom);
    debugSay(creep, '➡️'+creep.memory.targetRoom);
    debugDrawLine(creep, dest, CFG.DRAW.TRAVEL_COLOR, "ROOM");

    creep.travelTo(dest, {
       range: 20,
        reusePath: 20,
        });

    return true;
  }

  function prepareLuna(creep) {
    ensureLunaIdentity(creep);
    auditOncePerTick();
    if (!creep.memory.home) getHomeName(creep);
    trackMovementBreadcrumb(creep);
  }

  // Memory keys:
  // - sourceId: remote source assigned this tick
  // - targetRoom: room name for the assignment
  // - returning: boolean toggled when full to head home

  function determineLunaState(creep) {
    var state = 'HARVEST';
    if (creep.memory.returning) state = 'RETURN';
    else if (!creep.memory.targetRoom || !creep.memory.sourceId) state = 'UNASSIGNED';
    else if (creep.pos.roomName !== creep.memory.targetRoom) state = 'TRAVEL';
    creep.memory.state = state;
    return state;
  }

  // ============================
  // Main role
  // ============================
  var roleLuna = {
    role: 'Luna',
    run: function(creep){
      prepareLuna(creep);

      roleLuna.updateReturnState(creep);
      var state = determineLunaState(creep);
      if (state === 'RETURN') {
        roleLuna.returnToStorage(creep);
        return;
      }

      if (shouldReleaseForEndOfLife(creep)) return;
      if (respectCooldown(creep)) return;
      if (handleForcedYield(creep)) return;

      if (!ensureActiveAssignment(creep)) return;

      state = determineLunaState(creep);
      if (state === 'UNASSIGNED') {
        roleLuna.initializeAndAssign(creep);
        return;
      }

      if (creep.memory.targetRoom && isRoomLockedByInvaderCore(creep.memory.targetRoom)){
        debugSay(creep, '⛔LOCK');
        var center = new RoomPosition(25,25,creep.memory.targetRoom);
        debugDrawLine(creep, center, CFG.DRAW.TRAVEL_COLOR, "LOCK");
        console.log('⛔ '+creep.name+' skipping locked room '+creep.memory.targetRoom+' (Invader activity).');
        releaseAssignment(creep);
        return;
      }

      if (!validateExclusiveSource(creep)) return;

      if (state === 'TRAVEL') {
        if (travelToAssignedRoom(creep)) return;
        state = determineLunaState(creep);
      }

      if (state === 'UNASSIGNED') {
        roleLuna.initializeAndAssign(creep);
        if (!creep.memory.targetRoom || !creep.memory.sourceId){
          if (Game.time % 25 === 0) console.log('🚫 Forager '+creep.name+' could not be assigned a room/source.');
          return;
        }
      }

      var targetRoomObj = Game.rooms[creep.memory.targetRoom];
      if (targetRoomObj && BeeToolbox && BeeToolbox.logSourcesInRoom){ try { BeeToolbox.logSourcesInRoom(targetRoomObj); } catch (e) {} }

      if (targetRoomObj) {
        var lunaThreat = evaluateRoomThreat(targetRoomObj, 'Luna');
        if (lunaThreat && lunaThreat.threat && lunaThreat.threat.hasThreat && lunaThreat.canEscalate) {
          ensureRemoteDefensePlan(targetRoomObj, lunaThreat.threat, lunaThreat.distance);
        } else if (targetRoomObj && (!lunaThreat || !lunaThreat.canEscalate || !lunaThreat.threat || !lunaThreat.threat.hasThreat)) {
          softenRemoteDefensePlan(targetRoomObj.name);
        }
      }

      var tmem = getRoomMemoryBucket(creep.memory.targetRoom);
      if (tmem && tmem.hostile){
        console.log('⚠️ Forager '+creep.name+' avoiding hostile room '+creep.memory.targetRoom);
        debugSay(creep, '⚠️HOST');
        releaseAssignment(creep);
        return;
      }
      if (!tmem || !tmem.sources) return;

      var ctl = targetRoomObj && targetRoomObj.controller;
      if (ctl) { ensureControllerFlag(ctl); debugRing(targetRoomObj, ctl.pos, CFG.DRAW.TRAVEL_COLOR, "CTRL"); }

      state = determineLunaState(creep);
      if (state === 'HARVEST') {
        roleLuna.harvestSource(creep);
        return;
      }
      if (state === 'TRAVEL') {
        travelToAssignedRoom(creep);
        return;
      }
      idleAtAnchor(creep, 'IDLE');
    },

    // ---- Legacy fallback (no vision) — now radius-bounded ----
    getNearbyRoomsWithSources: function(creep){
      var homeName = getHomeName(creep);

      var inRadius = {};
      var ring = bfsNeighborRooms(homeName, REMOTE_RADIUS);
      for (var i=0; i<ring.length; i++) inRadius[ring[i]] = true;

      var all = Object.keys(Memory.rooms||{});
      var filtered = all.filter(function(roomName){
        var rm = Memory.rooms[roomName];
        if (!rm || !rm.sources) return false;
        if (!inRadius[roomName]) return false;
        if (rm.hostile) return false;
        if (isRoomLockedByInvaderCore(roomName)) return false;
        return roomName !== Memory.firstSpawnRoom;
      });

      return filtered.sort(function(a,b){
        return Game.map.getRoomLinearDistance(homeName, a) - Game.map.getRoomLinearDistance(homeName, b);
      });
    },

    findRoomWithLeastForagers: function(rooms, homeName){
      if (!rooms || !rooms.length) return null;

      var inRadius = {};
      var ring = bfsNeighborRooms(homeName, REMOTE_RADIUS);
      for (var i=0; i<ring.length; i++) inRadius[ring[i]] = true;

      var best=null, lowest=Infinity;
      for (var j=0;j<rooms.length;j++){
        var rn=rooms[j];
        if (!inRadius[rn]) continue;
        if (isRoomLockedByInvaderCore(rn)) continue;

        var rm=getRoomMemoryBucket(rn), sources = rm.sources?Object.keys(rm.sources):[]; if (!sources.length) continue;

        var count=0;
        for (var name in Game.creeps){
          var c=Game.creeps[name];
          if (c && c.memory && c.memory.task==='luna' && c.memory.targetRoom===rn) count++;
        }
        var avg = count / Math.max(1,sources.length);
        if (avg < lowest){ lowest=avg; best=rn; }
      }
      return best;
    },

    initializeAndAssign: function(creep){
      var targetRooms = roleLuna.getNearbyRoomsWithSources(creep);
      if (!creep.memory.targetRoom || !creep.memory.sourceId){
        var least = roleLuna.findRoomWithLeastForagers(targetRooms, getHomeName(creep));
        if (!least){ if (Game.time%25===0) console.log('🚫 Forager '+creep.name+' found no suitable room with unclaimed sources.'); return; }
        creep.memory.targetRoom = least;

        var roomMemory = getRoomMemoryBucket(creep.memory.targetRoom);
        var sid = roleLuna.assignSource(creep, roomMemory);
        if (sid){
          creep.memory.sourceId = sid;
          creep.memory.assigned = true;
          creep.memory._assignTick = Game.time;

          var memAssign = ensureAssignmentsMem();
          maInc(memAssign, sid, creep.memory.targetRoom);
          maSetOwner(memAssign, sid, creep.name, creep.memory.targetRoom);

          debugSay(creep, '🎯SRC');
          var srcObj = Game.getObjectById(sid);
          if (srcObj) { debugDrawLine(creep, srcObj, CFG.DRAW.PICK_COLOR, "ASSIGN"); debugRing(creep.room, srcObj.pos, CFG.DRAW.PICK_COLOR, shortSid(sid)); }
          else { var center = new RoomPosition(25,25,creep.memory.targetRoom); debugDrawLine(creep, center, CFG.DRAW.TRAVEL_COLOR, "ASSIGN"); }

          if (creep.memory._lastLogSid !== sid){
            console.log('🐝 '+creep.name+' assigned to source: '+sid+' in '+creep.memory.targetRoom);
            creep.memory._lastLogSid = sid;
          }
        }else{
          if (Game.time%25===0) console.log('No available sources for creep: '+creep.name);
          creep.memory.targetRoom=null; creep.memory.sourceId=null;
        }
      }
    },

    assignSource: function(creep, roomMemory){
      if (!roomMemory || !roomMemory.sources) return null;
      var sids = Object.keys(roomMemory.sources); if (!sids.length) return null;

      var memAssign = ensureAssignmentsMem();
      var free=[], sticky=[], rest=[];
      for (var i=0;i<sids.length;i++){
        var sid=sids[i];
        var owner = maOwner(memAssign, sid);
        var cnt   = maCount(memAssign, sid);
        if (owner && owner !== creep.name) continue;
        if (cnt >= MAX_LUNA_PER_SOURCE) continue;

        if (creep.memory.sourceId===sid) sticky.push(sid);
        else if (!owner) free.push(sid);
        else rest.push(sid);
      }

      var pick = free[0] || sticky[0] || rest[0] || null;
      if (!pick) return null;

      if (!tryClaimSourceForTick(creep, pick)) return null;
      return pick;
    },

    updateReturnState: function(creep){
      if (!creep.memory.returning && creep.store.getFreeCapacity(RESOURCE_ENERGY)===0) { creep.memory.returning=true; debugSay(creep, '⤴️RET'); }
      if (creep.memory.returning && creep.store.getUsedCapacity(RESOURCE_ENERGY)===0) { creep.memory.returning=false; debugSay(creep, '⤵️WK'); }
    },

    // UPDATED: includes build/upgrade fallback when all sinks are full
    returnToStorage: function(creep){
      var homeName = getHomeName(creep);

      // Go home first
      if (creep.room.name !== homeName) {
        var destHome = new RoomPosition(25, 25, homeName);
        debugSay(creep, '🏠');
        debugDrawLine(creep, destHome, CFG.DRAW.TRAVEL_COLOR, "HOME");
        creep.travelTo(destHome, { range: 20, reusePath: 20 });
        return;
      }

      // Priority 1: Extensions/Spawns/Towers
      var pri = creep.room.find(FIND_STRUCTURES, {
        filter: function (s) {
          if (!s.store) return false;
          var t = s.structureType;
          if (t !== STRUCTURE_EXTENSION && t !== STRUCTURE_SPAWN && t !== STRUCTURE_TOWER) return false;
          var freeEnergy = s.store.getFreeCapacity(RESOURCE_ENERGY);
          return typeof freeEnergy === 'number' && freeEnergy > 0;
        }
      });
      if (pri.length) {
        var a = creep.pos.findClosestByPath(pri);
        if (a) {
          var lbl = (a.structureType===STRUCTURE_EXTENSION?'EXT': a.structureType===STRUCTURE_SPAWN?'SPN':'TWR');
          debugSay(creep, '→ '+lbl);
          debugDrawLine(creep, a, CFG.DRAW.DELIVER_COLOR, lbl);
          var rc = creep.transfer(a, RESOURCE_ENERGY);
          if (rc === ERR_NOT_IN_RANGE) {
            creep.travelTo(a, { reusePath: CFG.PATH_REUSE });
          }
          return;
        }
      }

      // Priority 2: Storage
      var stor = creep.room.storage;
      if (stor && stor.store && stor.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
        debugSay(creep, '→ STO');
        debugDrawLine(creep, stor, CFG.DRAW.DELIVER_COLOR, "STO");
        var rc2 = creep.transfer(stor, RESOURCE_ENERGY);
        if (rc2 === ERR_NOT_IN_RANGE) {
          creep.travelTo(stor, { reusePath: CFG.PATH_REUSE });
        }
        return;
      }

      // Priority 3: Any container with room
      var conts = creep.room.find(FIND_STRUCTURES, {
        filter: function (s) {
          return s.structureType === STRUCTURE_CONTAINER &&
                 s.store && (s.store.getFreeCapacity(RESOURCE_ENERGY) || 0) > 0;
        }
      });
      if (conts.length) {
        var b = creep.pos.findClosestByPath(conts);
        if (b) {
          debugSay(creep, '→ CON');
          debugDrawLine(creep, b, CFG.DRAW.DELIVER_COLOR, "CON");
          var rc3 = creep.transfer(b, RESOURCE_ENERGY);
          if (rc3 === ERR_NOT_IN_RANGE) {
            creep.travelTo(b, { reusePath: CFG.PATH_REUSE });
          }
          return;
        }
      }

      // Everything is full → build/upgrade
      if (tryBuildOrUpgrade(creep)) return;

      // Idle near anchor
      var anchor = getAnchorPos(homeName);
      debugSay(creep, 'IDLE');
      debugDrawLine(creep, anchor, CFG.DRAW.IDLE_COLOR, "IDLE");
      creep.travelTo(anchor, { range: 2, reusePath: CFG.PATH_REUSE });
    },

    harvestSource: function(creep){
      if (!creep.memory.targetRoom || !creep.memory.sourceId){
        if (Game.time%25===0) console.log('Forager '+creep.name+' missing targetRoom/sourceId'); return;
      }

      if (creep.room.name !== creep.memory.targetRoom){
        var dest = new RoomPosition(25,25,creep.memory.targetRoom);
        debugSay(creep, '➡️'+creep.memory.targetRoom);
        debugDrawLine(creep, dest, CFG.DRAW.TRAVEL_COLOR, "ROOM");
        creep.travelTo(dest, { range: 20, reusePath: 20});
        return;
      }

      if (isRoomLockedByInvaderCore(creep.room.name)){
        debugSay(creep, '⛔LOCK');
        console.log('⛔ '+creep.name+' bailing from locked room '+creep.room.name+'.');
        releaseAssignment(creep); return;
      }

      var sid = creep.memory.sourceId;
      var src = Game.getObjectById(sid);
      if (!src){ if (Game.time%25===0) console.log('Source not found for '+creep.name); releaseAssignment(creep); return; }

      ensureSourceFlag(src);
      var srec = getSourceMemory(creep.room.name, sid); srec.x = src.pos.x; srec.y = src.pos.y;

      if (creep.room.controller) ensureControllerFlag(creep.room.controller);

      var rm = getRoomMemoryBucket(creep.memory.targetRoom);
      rm.sources = rm.sources || {};
      if (rm.sources[sid] && rm.sources[sid].entrySteps == null){
        var res = PathFinder.search(creep.pos, { pos: src.pos, range: 1 }, { plainCost: PLAIN_COST, swampCost: SWAMP_COST, maxOps: MAX_PF_OPS });
        if (!res.incomplete) rm.sources[sid].entrySteps = res.path.length;
      }

      var stuckTicks = typeof creep.memory._stuck === 'number' ? creep.memory._stuck : 0;
      if (stuckTicks >= STUCK_WINDOW){
        creep.travelTo(src, { range: 1, reusePath: 3,  });
        debugSay(creep, '🚧');
      }

      debugSay(creep, '⛏️SRC');
      debugDrawLine(creep, src, CFG.DRAW.SRC_COLOR, "SRC");
      var rc = creep.harvest(src);
      if (rc===ERR_NOT_IN_RANGE) {
        creep.travelTo(src, { range: 1, reusePath: 15, });
      }
      else if (rc===OK){
        touchSourceActive(creep.room.name, sid);
      }
    }
  };

roleLuna.MAX_LUNA_PER_SOURCE = MAX_LUNA_PER_SOURCE;

module.exports = roleLuna;
