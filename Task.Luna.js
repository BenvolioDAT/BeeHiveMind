// Task.Luna – Remote harvester with SAY + DRAW breadcrumbs (ES5-safe)
// Visual intent lines help you see: travel, pick, harvest, return, and fallbacks.

var BeeToolbox = require('BeeToolbox');
try { require('Traveler'); } catch (e) {} // ensure creep.travelTo exists

// ============================
// Debug UI (toggle here)
// ============================
var CFG = Object.freeze({
  DEBUG_SAY: false,     // creep.say breadcrumbs
  DEBUG_DRAW: true,    // RoomVisual lines + labels
  DRAW: {
    TRAVEL_COLOR:  "#8ab6ff",  // room travel (to target/home)
    PICK_COLOR:    "#ffe66e",  // choosing a source / assignment
    SRC_COLOR:     "#ff9a6e",  // harvesting source
    DROP_COLOR:    "#ffe66e",  // dropped energy / dump
    DELIVER_COLOR: "#6effa1",  // delivery to sink
    STICK_COLOR:   "#aaffaa",  // stickiness/seat
    AVOID_COLOR:   "#ff6e6e",  // avoided/locked rooms
    BUILD_COLOR:   "#e6c16e",  // building
    UPG_COLOR:     "#c1a6ff",  // upgrading
    IDLE_COLOR:    "#bfbfbf",  // idling / anchor
    WIDTH: 0.12,
    OPACITY: 0.45,
    FONT: 0.6
  }
});

// ============================
// Tunables (existing behaviour)
// ============================
// NOTE: REMOTE_RADIUS is measured in "room hops" from the home room.
var REMOTE_RADIUS = 1;

var MAX_PF_OPS    = 3000;
var PLAIN_COST    = 2;
var SWAMP_COST    = 10;
var MAX_LUNA_PER_SOURCE = 1;

// --- Container mining & haul signalling ---
var PICKUP_WARN_PCT   = 0.60;  // requestPickup at 60%
var PICKUP_URGENT_PCT = 0.80;  // reinforce at 80%

// Optional miner emergency haul-home if jammed
var EMERGENCY_EVAC_ENABLED = false;
var EMERGENCY_EVAC_PCT     = 0.95;
var EMERGENCY_EVAC_GRACE   = 50;

var PF_CACHE_TTL = 150;
var INVADER_LOCK_MEMO_TTL = 1500;

var AVOID_TTL = 30;
var RETARGET_COOLDOWN = 5;

// Small bias to keep the current owner briefly (soft preference only)
var ASSIGN_STICKY_TTL = 50;

// Anti-stuck
var STUCK_WINDOW = 4;

// Flag pruning cadence & grace (sources only)
var FLAG_PRUNE_PERIOD = 200;
var FLAG_GRACE_TICKS = 2000;

// ============================
// Tiny console helpers
// ============================
function debugSay(creep, msg) {
  if (!CFG.DEBUG_SAY || !creep) return;
  try { creep.say(msg, true); } catch (e) {}
}
function _posOf(target) {
  if (!target) return null;
  if (target.pos) return target.pos;
  if (target.x!=null && target.y!=null && target.roomName) return target;
  return null;
}
function debugDraw(creep, target, color, label) {
  if (!CFG.DEBUG_DRAW || !creep || !target) return;
  var room = creep.room; if (!room || !room.visual) return;

  var tpos = _posOf(target); if (!tpos || tpos.roomName !== room.name) return;

  try {
    room.visual.line(creep.pos, tpos, {
      color: color,
      width: CFG.DRAW.WIDTH,
      opacity: CFG.DRAW.OPACITY,
      lineStyle: "solid"
    });
    if (label) {
      room.visual.text(label, tpos.x, tpos.y - 0.2, {
        color: color, font: CFG.DRAW.FONT, opacity: 1
      });
    }
  } catch (e){}
}

// ============================
// Pathing (Traveler) wrapper
// ============================
function go(creep, dest, opts) {
  if (!creep || !dest) return;
  opts = opts || {};
  var desired = (opts.range!=null?opts.range:1);
  if (creep.pos.inRangeTo((dest.pos||dest), desired)) return;

  if (!creep.travelTo) {
    creep.moveTo((dest.pos||dest), { reusePath: (opts.reusePath!=null?opts.reusePath:15) });
    debugDraw(creep, dest, CFG.DRAW.TRAVEL_COLOR, "GO");
    return;
  }

  var tOpts = {
    range: desired,
    reusePath: (opts.reusePath!=null?opts.reusePath:15),
    ignoreCreeps: true,
    stuckValue: 2,
    repath: 0.05,
    maxOps: 6000
  };
  if (BeeToolbox && BeeToolbox.roomCallback) tOpts.roomCallback = BeeToolbox.roomCallback;
  debugDraw(creep, dest, CFG.DRAW.TRAVEL_COLOR, "GO");
  creep.travelTo((dest.pos||dest), tOpts);
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
  if (r && r.storage) return r.storage.pos;
  var spawns = r? r.find(FIND_MY_SPAWNS) : null;
  if (spawns && spawns.length) return spawns[0].pos;
  return new RoomPosition(25,25,homeName);
}

// ============================
// Memory helpers
// ============================
function _roomMem(roomName){
  var r=Memory.rooms||(Memory.rooms={}); return (r[roomName]||(r[roomName]={}));
}
function _sourceMem(roomName, sid) {
  var rm = _roomMem(roomName);
  rm.sources = rm.sources || {};
  return (rm.sources[sid] = (rm.sources[sid] || {}));
}

// mark activity each time we touch/own/harvest a source
function touchSourceActive(roomName, sid) {
  if (!roomName || !sid) return;
  var srec = _sourceMem(roomName, sid);
  srec.lastActive = Game.time;
}

// -------------------- Container + Haul Bus helpers --------------------
function _ensureBHM(){
  Memory.__BHM = Memory.__BHM || {};
  Memory.__BHM.haulRequests = Memory.__BHM.haulRequests || {};
  return Memory.__BHM;
}

function _publishHaulRequest(fromRoom, toRoom, containerId, amountHint){
  if (!fromRoom || !containerId) return;
  _ensureBHM();
  var key = fromRoom + ':' + containerId;
  Memory.__BHM.haulRequests[key] = {
    key: key,
    fromRoom: fromRoom,
    toRoom: toRoom || null,
    targetId: containerId,
    resource: RESOURCE_ENERGY,
    amountHint: amountHint || 0,
    issuedAt: Game.time
  };
}

// Container/csite within 1 tile of a source
function _findContainerOrSiteNearSource(room, source) {
  if (!room || !source) return { container: null, csite: null };
  var container = source.pos.findInRange(FIND_STRUCTURES, 1, {
    filter: function(s){ return s.structureType === STRUCTURE_CONTAINER; }
  })[0];
  var csite = source.pos.findInRange(FIND_CONSTRUCTION_SITES, 1, {
    filter: function(s){ return s.structureType === STRUCTURE_CONTAINER; }
  })[0];
  return { container: container||null, csite: csite||null };
}

// Prefer a non-wall, non-swamp seat around the source
function _pickSeatPosNearSource(source) {
  var roomName = source.pos.roomName;
  var terrain = Game.map.getRoomTerrain(roomName);
  var best = null, bestScore = -9999, dx, dy;
  for (dx=-1; dx<=1; dx++){
    for (dy=-1; dy<=1; dy++){
      if (!dx && !dy) continue;
      var x = source.pos.x + dx, y = source.pos.y + dy;
      if (x<1||x>48||y<1||y>48) continue;
      var t = terrain.get(x,y);
      if (t & TERRAIN_MASK_WALL) continue;
      var swamp = (t & TERRAIN_MASK_SWAMP) ? 1 : 0;
      var score = 10 - (swamp ? 5 : 0);
      if (score > bestScore){ bestScore = score; best = new RoomPosition(x,y,roomName); }
    }
  }
  return best || source.pos;
}

// Update room memory container state for a source
function _updateContainerMemory(source, container, homeRoomName) {
  var srec = _sourceMem(source.pos.roomName, source.id);
  srec.container = srec.container || {};
  srec.container.lastTick = Game.time;

  if (!container) {
    srec.container.status = "Building";
    srec.container.healthPct = 0;
    srec.container.capacityPct = 0;
    return;
  }

  srec.container.containerId = container.id;

  var hits = container.hits|0, hitsMax = container.hitsMax||1;
  srec.container.healthPct = Math.min(1, hits / hitsMax);

  var used = (container.store && container.store[RESOURCE_ENERGY]) || 0;
  var cap  = container.store && container.store.getCapacity ? container.store.getCapacity(RESOURCE_ENERGY) : 2000;
  var pct  = cap>0 ? (used / cap) : 0;
  srec.container.capacityPct = pct;

  srec.container.status = (srec.container.healthPct < 0.80) ? "NeedsRepair" : "Good";

  if (pct < PICKUP_WARN_PCT) {
    srec.container.requestPickup = false;
    if (srec.container.pickUpStatus !== "Enroute") srec.container.pickUpStatus = "None";
  }
}

// Flip requestPickup at 60% / 80% and emit haul requests
function _maybeSignalPickup(source, container, homeName, creepTask){
  var srec = _sourceMem(source.pos.roomName, source.id);
  srec.container = srec.container || {};
  var pct = srec.container.capacityPct || 0;
  var have = (container.store && container.store[RESOURCE_ENERGY]) || 0;

  if (pct >= PICKUP_WARN_PCT) {
    srec.container.requestPickup = true;
    if (srec.container.pickUpStatus !== "Enroute") srec.container.pickUpStatus = "Queued";
    _publishHaulRequest(container.pos.roomName, homeName, container.id, have);
  }
  if (pct >= PICKUP_URGENT_PCT) {
    _publishHaulRequest(container.pos.roomName, homeName, container.id, have);
    if (creepTask) creepTask._urgentSince = (creepTask._urgentSince==null)?Game.time:creepTask._urgentSince;
  } else if (creepTask) {
    creepTask._urgentSince = null;
  }
}

// Optional: allow miner to haul home if container stays jammed
function _maybeEmergencyEvac(creep, container, homeName, creepTask){
  if (!EMERGENCY_EVAC_ENABLED) return;

  var cap = container.store && container.store.getCapacity ? container.store.getCapacity(RESOURCE_ENERGY) : 2000;
  var used = (container.store && container.store[RESOURCE_ENERGY]) || 0;
  var pct  = cap>0 ? (used/cap) : 0;

  if (pct >= EMERGENCY_EVAC_PCT && creepTask && creepTask._urgentSince!=null && (Game.time - creepTask._urgentSince) > EMERGENCY_EVAC_GRACE) {
    // withdraw one load
    if (creep.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
      var r = creep.withdraw(container, RESOURCE_ENERGY);
      if (r === ERR_NOT_IN_RANGE) go(creep, container.pos, { range:1 });
      return;
    }
    // deliver to home storage
    if (creep.room.name !== homeName){
      go(creep, new RoomPosition(25,25,homeName), { range:20 });
      return;
    }
    if (creep.room.storage){
      var rc = creep.transfer(creep.room.storage, RESOURCE_ENERGY);
      if (rc === ERR_NOT_IN_RANGE) go(creep, creep.room.storage, { range:1 });
    }
  }
}

// ============================
// Source flag/anchors (existing)
// ============================
// ensure exactly one flag exists on this source tile (idempotent) and touch lastActive.
function ensureSourceFlag(source) {
  if (!source || !source.pos || !source.room) return;

  var roomName = source.pos.roomName;
  var srec = _sourceMem(roomName, source.id);

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

  // find any flag on that tile; if none, create one
  var flags = source.pos.lookFor(LOOK_FLAGS);
  if (flags && flags.length) {
    var f2 = flags[0];
    srec.flagName = f2.name;
    touchSourceActive(roomName, source.id);
    return;
  }

  // create a unique flag name
  var base = "SRC_" + roomName + "_" + source.pos.x + "x" + source.pos.y;
  var idx = 0; var flagName = base;
  while (Game.flags[flagName]) { idx++; flagName = base + "_" + idx; }

  var ok = source.pos.createFlag(flagName);
  if (ok === OK) {
    srec.flagName = flagName;
    touchSourceActive(roomName, source.id);
  }
}

function pruneUnusedSourceFlags(){
  for (var name in Game.flags){
    var f = Game.flags[name];
    if (!f) continue;
    if (f.name.indexOf("SRC_") !== 0) continue;

    var room = f.pos.roomName;
    var rm = _roomMem(room);
    var found = false;
    if (rm && rm.sources){
      for (var sid in rm.sources){
        var sr = rm.sources[sid];
        if (sr && sr.flagName === name){ found=true; break; }
      }
    }
    if (!found){
      var look = f.pos.lookFor(LOOK_SOURCES);
      if (!look || !look.length){
        f.remove();
      }
    }
  }
}

function ensureControllerFlag(ctrl){
  if (!ctrl || !ctrl.pos) return;
  var name = "CTRL_" + ctrl.pos.roomName;
  var f = Game.flags[name];
  if (!f){
    ctrl.pos.createFlag(name);
  }
}

// ============================
// Per-tick *claim* (same-tick contention guard)
// ============================
function _claimTable(){ var sc=Memory._sourceClaim; if(!sc||sc.t!==Game.time){ Memory._sourceClaim={t:Game.time,m:{}}; } return Memory._sourceClaim.m; }
function tryClaimSourceForTick(creep, sid){
  var m=_claimTable(), cur=m[sid];
  if (!cur){ m[sid]=creep.name; return true; }
  if (creep.name < cur){ m[sid]=creep.name; return true; }
  return cur===creep.name;
}

// ============================
// remoteAssignments model
// ============================
function ensureAssignmentsMem(){ if(!Memory.remoteAssignments) Memory.remoteAssignments={}; return Memory.remoteAssignments; }
function _maEnsure(entry, roomName){
  if (!entry || typeof entry !== 'object') entry = { count: 0, owner: null, roomName: roomName||null, since: null };
  if (typeof entry.count !== 'number') entry.count = (entry.count|0);
  if (!('owner' in entry)) entry.owner = null;
  if (!('roomName' in entry)) entry.roomName = roomName||null;
  if (!('since' in entry)) entry.since = null;
  return entry;
}
function maCount(memAssign, sid){
  var e = memAssign[sid];
  if (!e) return 0;
  if (typeof e === 'number') return e; // backward compat
  return e.count|0;
}
function maOwner(memAssign, sid){
  var e = memAssign[sid]; if (!e) return null;
  if (typeof e === 'number') return null;
  return e.owner || null;
}
function maRoom(memAssign, sid){
  var e = memAssign[sid]; if (!e) return null;
  if (typeof e === 'number') return null;
  return e.roomName || null;
}
function maInc(memAssign, sid, roomName){
  var e = _maEnsure(memAssign[sid], roomName); e.count=(e.count|0)+1; memAssign[sid]=e;
}
function maDec(memAssign, sid){
  var e = _maEnsure(memAssign[sid]); e.count=Math.max(0,(e.count|0)-1); memAssign[sid]=e;
}
function maSetOwner(memAssign, sid, name, roomName){
  var e = _maEnsure(memAssign[sid], roomName); e.owner=name; e.since=Game.time; memAssign[sid]=e;
}
function maClearOwner(memAssign, sid){
  var e = _maEnsure(memAssign[sid]); e.owner=null; memAssign[sid]=e;
}

function markAvoid(creep, sid, ttl){
  var rm = Memory._avoid||(Memory._avoid={});
  rm[sid] = Game.time + (ttl|0);
}
function isAvoided(sid){
  var rm = Memory._avoid; if (!rm) return false;
  var t = rm[sid]; if (!t) return false;
  return t > Game.time;
}

// recompute the set of valid remote source sids for a home (cached in Memory.rooms[homeName].remotes)
function markValidRemoteSourcesForHome(homeName){
  var neighborRooms = bfsNeighborRooms(homeName, REMOTE_RADIUS);
  var valid = {};
  for (var i=0;i<neighborRooms.length;i++){
    var rn = neighborRooms[i];
    var room = Game.rooms[rn];
    if (!room) continue;

    // respect invader core lock
    if (isRoomLockedByInvaderCore(rn)) continue;

    var sources = room.find(FIND_SOURCES);
    for (var j=0;j<sources.length;j++){
      var s = sources[j];
      valid[s.id] = rn;
    }
  }
  var rm = _roomMem(homeName);
  rm._validRemoteSources = valid;
}

// Path cost cache (source->target room anchor)
function _pfCacheMem(){
  if (!Memory._pfCache) Memory._pfCache = { t:0, m:{} };
  return Memory._pfCache;
}
function pfCostCached(fromPos, toPos, key){
  if (!fromPos || !toPos) return Infinity;
  var mem = _pfCacheMem();
  var rec = mem.m[key];
  if (rec && (Game.time - mem.t) < PF_CACHE_TTL){
    return rec.cost;
  }
  var ret = PathFinder.search(fromPos, { pos: toPos, range: 1 }, {
    maxOps: MAX_PF_OPS,
    plainCost: PLAIN_COST,
    swampCost: SWAMP_COST,
    maxRooms: 16
  });
  var cost = ret.incomplete ? Infinity : (ret.cost|0);
  mem.m[key] = { cost: cost };
  mem.t = Game.time;
  return cost;
}

// BFS neighbor rooms up to radius (coarse)
function bfsNeighborRooms(homeName, radius){
  var visited = {}; visited[homeName] = true;
  var q = [homeName], out=[homeName], depth=0;
  while (q.length && depth<radius){
    var next = [];
    for (var i=0;i<q.length;i++){
      var r=q[i], exits = Game.map.describeExits(r) || {};
      for (var dir in exits){
        var nr = exits[dir];
        if (!visited[nr]){ visited[nr]=true; out.push(nr); next.push(nr); }
      }
    }
    q = next; depth++;
  }
  return out.filter(function(r){ return r!==homeName; });
}

// Lock via invader core presence (memoized)
function isRoomLockedByInvaderCore(roomName){
  var rm = _roomMem(roomName), now=Game.time;
  if (!rm._invaderLock || typeof rm._invaderLock.locked!=='boolean' || typeof rm._invaderLock.t!=='number'){
    var room = Game.rooms[roomName];
    var locked=false;
    if (room){
      var cores = room.find(FIND_STRUCTURES, { filter: function(s){ return s.structureType===STRUCTURE_INVADER_CORE; } });
      locked = !!(cores && cores.length);
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

      var sid=s.id;
      var owner = maOwner(memAssign, sid);
      var count = maCount(memAssign, sid);
      var capLeft = Math.max(0, (MAX_LUNA_PER_SOURCE|0) - (count|0));

      if (owner && owner !== creep.name){
        // allow soft stickiness to currently assigned owner
        if ((Game.time - (_sourceMem(rn, sid).lastActive||0)) <= ASSIGN_STICKY_TTL) {
          avoided.push({ sid:sid, roomName:rn, cost:cost, lin:lin, reason:"sticky" });
          continue;
        }
      }

      if (capLeft <= 0){
        avoided.push({ sid:sid, roomName:rn, cost:cost, lin:lin, reason:"full" });
        continue;
      }

      candidates.push({ sid:sid, roomName:rn, cost:cost, lin:lin });
    }
  }

  // 2) No-vision (fallback by memory table)
  if (!candidates.length){
    var rm = _roomMem(homeName);
    var valid = rm._validRemoteSources||{};
    for (var sid2 in valid){
      if (isAvoided(sid2)) continue;
      var rn2 = valid[sid2];
      var lin2 = Game.map.getRoomLinearDistance(homeName, rn2);
      var cost2 = lin2*100 + 500;
      var owner2 = maOwner(memAssign, sid2);
      var count2 = maCount(memAssign, sid2);
      var capLeft2 = Math.max(0,(MAX_LUNA_PER_SOURCE|0)-(count2|0));
      if (capLeft2 <= 0) continue;
      candidates.push({ sid:sid2, roomName:rn2, cost:cost2, lin:lin2 });
    }
  }

  if (!candidates.length){
    return null;
  }

  // sort by cost then lin
  candidates.sort(function(a,b){
    if (a.cost!==b.cost) return a.cost-b.cost;
    return a.lin-b.lin;
  });

  // try top few, claim same tick to avoid race
  for (var k=0;k<Math.min(4,candidates.length);k++){
    var pick=candidates[k];
    if (tryClaimSourceForTick(creep, pick.sid)) return new RoomObjectSourceRef(pick.sid, pick.roomName);
  }
  // fallback to best if we own the claim by tie-break
  var pick2 = candidates[0];
  if (tryClaimSourceForTick(creep, pick2.sid)) return new RoomObjectSourceRef(pick2.sid, pick2.roomName);
  return null;
}

function RoomObjectSourceRef(id, roomName){ this.id=id; this.roomName=roomName; }

function releaseAssignment(creep){
  var memAssign = ensureAssignmentsMem();
  var sid = creep.memory.sourceId;
  if (!sid) return;

  var owner = maOwner(memAssign, sid);
  if (owner === creep.name) maClearOwner(memAssign, sid);
  maDec(memAssign, sid);

  var rn = creep.memory.targetRoom;
  if (rn && isRoomLockedByInvaderCore(rn)){
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

  // resolve tie by lexicographic name (stable)
  winners.sort(function(a,b){ return (a.name<b.name?-1:(a.name>b.name?1:0)); });
  if (winners.length){
    var win = winners[0];
    if (win.name !== creep.name){
      creep.memory._forceYield = true;
      return false;
    } else {
      var e = ensureAssignmentsMem();
      maSetOwner(e, sid, creep.name, creep.memory.targetRoom);
      return true;
    }
  }
  return true;
}

// ============================
// Controller flag pruning by room activity
// ============================
function pruneControllerFlagIfNoForagers(roomName, roomCounts){
  var name = "CTRL_"+roomName, f=Game.flags[name];
  if (!f) return;

  var count = roomCounts[roomName]||0;
  if (count>0) return;

  // nobody targeting this room, okay to remove
  f.remove();
}

// ============================
// Remote assignment audit (periodic)
// ============================
function auditRemoteAssignments(){
  var memAssign = ensureAssignmentsMem();

  var roomCounts = {};

  for (var name in Game.creeps){
    var c=Game.creeps[name];
    if (c && c.memory && c.memory.task==='luna' && c.memory.targetRoom){
      var rn = c.memory.targetRoom;
      roomCounts[rn] = (roomCounts[rn]|0)+1;
    }
  }

  // clamp counts per source and strip owners if creep gone
  for (var sid3 in memAssign){
    if (!memAssign.hasOwnProperty(sid3)) continue;
    var owner = maOwner(memAssign, sid3);
    if (owner && !Game.creeps[owner]){
      maClearOwner(memAssign, sid3);
    }
    if (MAX_LUNA_PER_SOURCE > 0){
      if (memAssign[sid3].count > MAX_LUNA_PER_SOURCE){
        resolveOwnershipForSid(sid3);
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
function resolveOwnershipForSid(sid){
  // collect all creeps on sid and pick lexicographically
  var arr=[];
  for (var name in Game.creeps){
    var c=Game.creeps[name];
    if (c && c.memory && c.memory.task==='luna' && c.memory.sourceId===sid){
      arr.push(c);
    }
  }
  arr.sort(function(a,b){ return (a.name<b.name?-1:(a.name>b.name?1:0)); });

  var memAssign = ensureAssignmentsMem();
  var keep = arr.shift();
  if (keep){
    maSetOwner(memAssign, sid, keep.name, keep.memory.targetRoom);
    memAssign[sid].count = 1;
  } else {
    maClearOwner(memAssign, sid);
    memAssign[sid].count = 0;
  }

  // others release
  for (var i=0;i<arr.length;i++){
    var loser = arr[i];
    if (loser && loser.memory && loser.memory.task==='luna'){
      releaseAssignment(loser);
    }
  }
}

// ============================
// Task.Luna
// ============================
var TaskLuna = {
  /** pick rooms within REMOTE_RADIUS that have at least one source */
  getNearbyRoomsWithSources: function(creep){
    var homeName = getHomeName(creep);
    var neighbors = bfsNeighborRooms(homeName, REMOTE_RADIUS);
    var out=[];
    for (var i=0;i<neighbors.length;i++){
      var rn=neighbors[i];
      var room=Game.rooms[rn];
      if (!room) { out.push(rn); continue; } // allow memory/fallback
      if (room.find(FIND_SOURCES).length) out.push(rn);
    }
    return out;
  },

  findRoomWithLeastForagers: function(rns, homeName){
    var best = null, lowest = Infinity;
    for (var i=0;i<rns.length;i++){
      var rn = rns[i];
      var rm=_roomMem(rn), sources = rm.sources?Object.keys(rm.sources):[]; if (!sources.length) continue;

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
    var targetRooms = this.getNearbyRoomsWithSources(creep);
    if (!creep.memory.targetRoom || !creep.memory.sourceId){
      var least = this.findRoomWithLeastForagers(targetRooms, getHomeName(creep));
      if (!least){ if (Game.time%25===0) console.log('🚫 Forager '+creep.name+' found no suitable room with unclaimed sources.'); return; }
      creep.memory.targetRoom = least;

      var roomMemory = _roomMem(creep.memory.targetRoom);
      var sid = this.assignSource(creep, roomMemory);
      if (sid){
        creep.memory.sourceId = sid;
        creep.memory.assigned = true;
        creep.memory._assignTick = Game.time;

        var memAssign = ensureAssignmentsMem();
        maInc(memAssign, sid, creep.memory.targetRoom);
        maSetOwner(memAssign, sid, creep.name, creep.memory.targetRoom);
      }
    }
  },

  assignSource: function(creep, roomMemory){
    // if roomMemory has known sources, pick from them; otherwise pick via picker
    var pick = pickRemoteSource(creep);
    if (!pick) return null;

    if (isAvoided(pick.id)) return null;
    if (!tryClaimSourceForTick(creep, pick.id)) return null;
    if (isRoomLockedByInvaderCore(pick.roomName)){ return null; }

    // success
    return pick.id;
  },

  updateReturnState: function(creep){
    // If we are container-mining on seat, we never "return" — we dump to the container.
    if (creep.memory._containerMode) { creep.memory.returning = false; return; }
    if (!creep.memory.returning && creep.store.getFreeCapacity(RESOURCE_ENERGY)===0) { creep.memory.returning=true; debugSay(creep, '⤴️RET'); }
    if (creep.memory.returning && creep.store.getUsedCapacity(RESOURCE_ENERGY)===0) { creep.memory.returning=false; debugSay(creep, '⤵️WK'); }
  },

  // UPDATED: includes build/upgrade fallback when all sinks are full
  returnToStorage: function(creep){
    var homeName = getHomeName(creep);

    // Go home first
    if (creep.room.name !== homeName) {
      var destHome = new RoomPosition(25, 25, homeName);
      debugSay(creep, '↩️HOME');
      debugDraw(creep, destHome, CFG.DRAW.TRAVEL_COLOR, "HOME");
      go(creep, destHome, { range: 10, reusePath: 20 });
      return;
    }

    // Priority 1: Spawns/extensions/towers
    var pri = creep.room.find(FIND_MY_STRUCTURES, {
      filter: function (s) {
        if (!s.store) return false;
        var t = s.structureType;
        if (t !== STRUCTURE_EXTENSION && t !== STRUCTURE_SPAWN && t !== STRUCTURE_TOWER) return false;
        return (s.store.getFreeCapacity(RESOURCE_ENERGY) | 0) > 0;
      }
    });
    if (pri.length) {
      var a = creep.pos.findClosestByPath(pri);
      if (a) {
        var lbl = (a.structureType===STRUCTURE_EXTENSION?'EXT': a.structureType===STRUCTURE_SPAWN?'SPN':'TWR');
        debugSay(creep, '→ '+lbl);
        debugDraw(creep, a, CFG.DRAW.DELIVER_COLOR, lbl);
        var rc = creep.transfer(a, RESOURCE_ENERGY);
        if (rc === ERR_NOT_IN_RANGE) go(creep, a);
        return;
      }
    }

    // Priority 2: Storage
    var stor = creep.room.storage;
    if (stor && stor.store && stor.store.getFreeCapacity(RESOURCE_ENERGY) > 0) {
      debugSay(creep, '→ STO');
      debugDraw(creep, stor, CFG.DRAW.DELIVER_COLOR, "STO");
      var rc2 = creep.transfer(stor, RESOURCE_ENERGY);
      if (rc2 === ERR_NOT_IN_RANGE) go(creep, stor);
      return;
    }

    // Priority 3: Any container with room
    var containers = creep.room.find(FIND_STRUCTURES, {
      filter: function (s) { return s.structureType === STRUCTURE_CONTAINER && s.store && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0; }
    });
    if (containers && containers.length) {
      var c = creep.pos.findClosestByPath(containers);
      if (c) {
        debugSay(creep, '→ CON');
        debugDraw(creep, c, CFG.DRAW.DELIVER_COLOR, "CONT");
        var rc3 = creep.transfer(c, RESOURCE_ENERGY);
        if (rc3 === ERR_NOT_IN_RANGE) go(creep, c);
        return;
      }
    }

    // Priority 4: build any site to burn energy
    var site = creep.pos.findClosestByPath(FIND_CONSTRUCTION_SITES);
    if (site) {
      debugSay(creep, '🔨');
      debugDraw(creep, site, CFG.DRAW.BUILD_COLOR, "BUILD");
      var br = creep.build(site);
      if (br === ERR_NOT_IN_RANGE) go(creep, site, { range: 3 });
      return;
    }

    // Fallback: upgrade
    var ctrl = creep.room.controller;
    if (ctrl) {
      debugSay(creep, '⚡UPG');
      debugDraw(creep, ctrl, CFG.DRAW.UPG_COLOR, "UPG");
      var ur = creep.upgradeController(ctrl);
      if (ur === ERR_NOT_IN_RANGE) go(creep, ctrl, { range: 3 });
      return;
    }

    // Last resort: idle at anchor
    var anchor = getAnchorPos(getHomeName(creep));
    debugSay(creep, 'IDLE');
    debugDraw(creep, anchor, CFG.DRAW.IDLE_COLOR, "IDLE");
    go(creep, anchor, { range: 2 });
  },

  harvestSource: function(creep){
    if (!creep.memory.targetRoom || !creep.memory.sourceId){
      if (Game.time%25===0) console.log('Forager '+creep.name+' missing targetRoom/sourceId'); return;
    }

    // Travel into target room first
    if (creep.room.name !== creep.memory.targetRoom){
      var dest = new RoomPosition(25,25,creep.memory.targetRoom);
      debugSay(creep, '➡️'+creep.memory.targetRoom);
      debugDraw(creep, dest, CFG.DRAW.TRAVEL_COLOR, "ROOM");
      go(creep, dest, { range:20, reusePath:20 }); return;
    }

    // Respect invader lock
    if (isRoomLockedByInvaderCore(creep.room.name)){
      debugSay(creep, '⛔LOCK');
      console.log('⛔ '+creep.name+' bailing from locked room '+creep.room.name+'.');
      releaseAssignment(creep);
      return;
    }

    var sid = creep.memory.sourceId;
    var src = Game.getObjectById(sid);
    if (!src){
      if (Game.time%25===0) console.log('Source not found for '+creep.name);
      releaseAssignment(creep);
      return;
    }

    // Controller & source flags (your existing visuals)
    ensureSourceFlag(src);
    touchSourceActive(creep.room.name, sid);
    if (creep.room.controller) ensureControllerFlag(creep.room.controller);

    // Container discovery near the source
    var seatInfo = _findContainerOrSiteNearSource(creep.room, src);
    var container = seatInfo.container;
    var csite     = seatInfo.csite;

    // Record container state in room memory
    _updateContainerMemory(src, container, getHomeName(creep));

    // We are now operating in container mode if container or site exists
    creep.memory._containerMode = !!(container || csite);

    // If container exists: move onto it, dump, harvest, signal Truckers
    if (container) {
      // store container id into source memory (for haulers)
      var srec = _sourceMem(creep.room.name, sid); srec.container = srec.container || {}; srec.container.containerId = container.id;

      if (!creep.pos.isEqualTo(container.pos)) {
        debugSay(creep, '⛳SEAT');
        debugDraw(creep, container, CFG.DRAW.TRAVEL_COLOR, "SEAT");
        go(creep, container.pos, { range:0, reusePath:10 });
        return;
      }

      // Dump any carried energy first (keeps container topped)
      if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
        debugDraw(creep, container, CFG.DRAW.DROP_COLOR, "DUMP");
        var tr = creep.transfer(container, RESOURCE_ENERGY);
        if (tr === ERR_NOT_IN_RANGE) { go(creep, container.pos, { range:0 }); return; }
      }

      // Harvest each tick
      debugSay(creep, '⛏️SRC');
      debugDraw(creep, src, CFG.DRAW.SRC_COLOR, "SRC");
      var hr = creep.harvest(src);
      if (hr === ERR_NOT_IN_RANGE) { go(creep, src, { range:1, reusePath: 5 }); return; }

      // Signal haul requests when container fills up
      _maybeSignalPickup(src, container, getHomeName(creep), creep.memory);

      // Optional emergency evac if jammed
      _maybeEmergencyEvac(creep, container, getHomeName(creep), creep.memory);

      return;
    }

    // No container yet: if a container site exists, build it (harvest to fuel if empty)
    if (csite && csite.structureType === STRUCTURE_CONTAINER) {
      if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
        debugSay(creep, '🔨CON');
        debugDraw(creep, csite, CFG.DRAW.BUILD_COLOR, "BUILD");
        var br = creep.build(csite);
        if (br === ERR_NOT_IN_RANGE) go(creep, csite, { range:3, reusePath:10 });
      } else {
        debugSay(creep, '⛏️SRC');
        debugDraw(creep, src, CFG.DRAW.SRC_COLOR, "SRC");
        var hr2 = creep.harvest(src);
        if (hr2 === ERR_NOT_IN_RANGE) go(creep, src, { range:1, reusePath:10 });
      }
      return;
    }

    // No container & no site: pick a good seat and place a container site
    var seat = _pickSeatPosNearSource(src);
    if (!creep.pos.isEqualTo(seat)) {
      debugSay(creep, '⛳SEAT');
      debugDraw(creep, seat, CFG.DRAW.TRAVEL_COLOR, "SEAT?");
      go(creep, seat, { range:0, reusePath: 15 });
      return;
    }

    // Try to place the site (respect site limit)
    var totalSites = Object.keys(Game.constructionSites || {}).length|0;
    if (totalSites < 95) {
      var mk = creep.pos.createConstructionSite(STRUCTURE_CONTAINER);
      if (mk === OK) { debugSay(creep, '📍CON'); }
    }

    // While waiting, harvest to pocket to fuel building
    debugSay(creep, '⛏️SRC');
    debugDraw(creep, src, CFG.DRAW.SRC_COLOR, "SRC");
    var hr3 = creep.harvest(src);
    if (hr3 === ERR_NOT_IN_RANGE) go(creep, src, { range:1, reusePath:10 });
  }
};

TaskLuna.MAX_LUNA_PER_SOURCE = MAX_LUNA_PER_SOURCE;

module.exports = TaskLuna;
