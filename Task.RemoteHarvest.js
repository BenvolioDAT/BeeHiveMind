// TaskRemoteHarvest.clean.js
// Remote-harvester ("forager"): mines a remote source and hauls energy home.
//
// This revision:
// - Stores count + owner per source in Memory.remoteAssignments[sourceId] = {count, owner, roomName, since}
// - Creep memory always carries {sourceId, targetRoom}
// - Duplicate resolver elects 1 winner (oldest _assignTick, then name), losers yield
// - Removes stale owners when creeps die or retarget
// - SOURCE FLAGS: create on source tile and prune when unused/locked (with grace TTL)
// - NEW: CONTROLLER FLAGS: create a flag on the remote room's controller while the room is being worked;
//        automatically remove it when there are no remote-harvest creeps assigned/in that room.
// - Legacy fallback hard-caps to REMOTE_RADIUS; ES5-safe; Traveler/BeeTravel for movement.

'use strict';

// ============================
// Dependencies
// ============================
var BeeToolbox = require('BeeToolbox');
try { require('Traveler'); } catch (e) {} // ensure creep.travelTo exists

// ============================
// Tunables
// ============================
// NOTE: REMOTE_RADIUS is measured in "room hops" from the home room.
var REMOTE_RADIUS = 5;

var MAX_PF_OPS    = 3000;
var PLAIN_COST    = 2;
var SWAMP_COST    = 10;
var MAX_FORAGERS_PER_SOURCE = 1;

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
var FLAG_RETENTION_TTL  = 500;  // keep a source-flag this many ticks since last activity

// ============================
// Helpers: short id, flags
// ============================
function shortSid(id) {
  if (!id || typeof id !== 'string') return '??????';
  var n = id.length; return id.substr(n - 6);
}

function _roomMem(roomName){
  Memory.rooms = Memory.rooms || {};
  return (Memory.rooms[roomName] = (Memory.rooms[roomName] || {}));
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

/** Ensure exactly one flag exists on this source tile (idempotent) and touch lastActive. */
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
  var rm = _roomMem(roomName);

  // Expected flag name for this room’s controller
  var expect = 'Reserve:' + roomName;

  // If we already know a flag name and it’s still valid, reuse
  if (rm.controllerFlagName) {
    var f0 = Game.flags[rm.controllerFlagName];
    if (f0 &&
        f0.pos.x === ctrl.pos.x &&
        f0.pos.y === ctrl.pos.y &&
        f0.pos.roomName === roomName) {
      return; // still good
    }
  }

  // Adopt any Reserve:roomName flag already sitting on this controller
  var flagsHere = ctrl.pos.lookFor(LOOK_FLAGS) || [];
  for (var i = 0; i < flagsHere.length; i++) {
    if (flagsHere[i].name === expect) {
      rm.controllerFlagName = expect;
      return;
    }
  }

  // Otherwise create a new one (idempotent: if it fails, we’ll adopt next tick)
  var rc = ctrl.room.createFlag(ctrl.pos, expect, COLOR_WHITE, COLOR_PURPLE);
  if (typeof rc === 'string') rm.controllerFlagName = rc;
}

function pruneControllerFlagIfNoForagers(roomName, roomCountMap){
  var rm = _roomMem(roomName);
  var fname = rm.controllerFlagName;
  if (!fname) return;

  // Only prune if no active foragers are assigned/in this room
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
function _ensureAvoid(creep){ if (!creep.memory._avoid) creep.memory._avoid = {}; return creep.memory._avoid; }
function shouldAvoid(creep, sid){ var a=_ensureAvoid(creep); var t=a[sid]; return (typeof t==='number' && Game.time<t); }
function markAvoid(creep, sid, ttl){ var a=_ensureAvoid(creep); a[sid] = Game.time + (ttl!=null?ttl:AVOID_TTL); }
function avoidRemaining(creep, sid){ var a=_ensureAvoid(creep); var t=a[sid]; if (typeof t!=='number') return 0; var left=t-Game.time; return left>0?left:0; }

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
  var e = memAssign[sid];
  if (!e || typeof e === 'number') return null;
  return e.owner || null;
}
function maSetOwner(memAssign, sid, owner, roomName){
  var e = _maEnsure(memAssign[sid], roomName);
  e.owner = owner; e.roomName = roomName || e.roomName; e.since = Game.time;
  memAssign[sid] = e;
  // PRUNE / lastActive: any time we set owner, bump activity so source-flag isn't pruned
  if (e.roomName) touchSourceActive(e.roomName, sid);
}
function maClearOwner(memAssign, sid){
  var e = _maEnsure(memAssign[sid], null);
  e.owner = null; e.since = null;
  memAssign[sid] = e;
}
function maInc(memAssign, sid, roomName){
  var e = _maEnsure(memAssign[sid], roomName); e.count = (e.count|0) + 1; memAssign[sid]=e;
}
function maDec(memAssign, sid){
  var e = _maEnsure(memAssign[sid], null); e.count = Math.max(0,(e.count|0)-1); memAssign[sid]=e;
}

// ============================
// Ownership / duplicate resolver
// ============================
function resolveOwnershipForSid(sid){
  var memAssign = ensureAssignmentsMem();
  var e = _maEnsure(memAssign[sid], null);

  // Collect live contenders
  var contenders = [];
  for (var name in Game.creeps){
    var c = Game.creeps[name];
    if (!c || !c.memory) continue;
    if (c.memory.task === 'remoteharvest' && c.memory.sourceId === sid){
      contenders.push(c);
    }
  }

  // If no contenders, clear owner; counts refresh in audit
  if (!contenders.length){
    maClearOwner(memAssign, sid);
    return null;
  }

  // Elect one: oldest _assignTick wins; tie-break by name
  contenders.sort(function(a,b){
    var at = a.memory._assignTick||0, bt=b.memory._assignTick||0;
    if (at!==bt) return at-bt;
    return a.name<b.name?-1:1;
  });
  var winner = contenders[0];

  // Bless the winner
  maSetOwner(memAssign, sid, winner.name, winner.memory.targetRoom||null);

  // Force losers to yield
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

  // Reset counts to 0
  for (var sid in memAssign){
    memAssign[sid] = _maEnsure(memAssign[sid], memAssign[sid].roomName||null);
    memAssign[sid].count = 0;
  }

  // Count live assignments + per-room counts (for controller flags)
  var roomCounts = {}; // roomName -> number of remoteharvesters assigned/in that room
  for (var name in Game.creeps){
    var c = Game.creeps[name];
    if (!c || !c.memory) continue;
    if (c.memory.task === 'remoteharvest') {
      if (c.memory.sourceId){
        var sid2 = c.memory.sourceId;
        var e2 = _maEnsure(memAssign[sid2], c.memory.targetRoom||null);
        e2.count = (e2.count|0) + 1;
        memAssign[sid2] = e2;
      }
      if (c.memory.targetRoom){
        var rn = c.memory.targetRoom;
        roomCounts[rn] = (roomCounts[rn]|0) + 1;
      }
    }
  }

  // Scrub owners / resolve duplicates
  for (var sid3 in memAssign){
    var owner = maOwner(memAssign, sid3);
    if (owner){
      var oc = Game.creeps[owner];
      if (!oc || !oc.memory || oc.memory.sourceId !== sid3){
        resolveOwnershipForSid(sid3);
      }else{
        if (memAssign[sid3].count > MAX_FORAGERS_PER_SOURCE){
          resolveOwnershipForSid(sid3);
        }
      }
    }else{
      if (memAssign[sid3].count > 0){
        resolveOwnershipForSid(sid3);
      }
    }
  }

  // PRUNE: source flags on cadence
  if ((Game.time % FLAG_PRUNE_PERIOD) === 0) pruneUnusedSourceFlags();

  // NEW: Controller flag prune — remove the controller flag in rooms with zero foragers
  // We do this every audit so it's snappy (no TTL needed).
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

  // Walk all known rooms/sources in memory
  var rooms = Memory.rooms || {};
  for (var roomName in rooms){
    if (!rooms.hasOwnProperty(roomName)) continue;
    var rm = rooms[roomName]; if (!rm || !rm.sources) continue;

    var roomLocked = isRoomLockedByInvaderCore(roomName);

    for (var sid in rm.sources){
      if (!rm.sources.hasOwnProperty(sid)) continue;
      var srec = rm.sources[sid] || {};
      var flagName = srec.flagName;
      if (!flagName) continue; // nothing to remove

      // Decide if the flag is removable:
      var e = _maEnsure(memAssign[sid], rm.sources[sid].roomName || roomName);
      var count  = e.count|0;
      var owner  = e.owner || null;
      var last   = srec.lastActive|0;

      var inactiveLong = (now - last) > FLAG_RETENTION_TTL;
      var nobodyOwns   = (count === 0 && owner == null);

      if (roomLocked || (nobodyOwns && inactiveLong)) {
        var f = Game.flags[flagName];
        // Only remove if the flag still sits on the source tile; otherwise just clean memory.
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
        // Always clear the memory pointer so we can recreate later if needed
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
function go(creep, dest, opts){
  opts = opts || {};
  var desired = (opts.range!=null) ? opts.range : 1;
  if (creep.pos.getRangeTo(dest) <= desired) return;
  var tOpts = {
    range: desired,
    reusePath: (opts.reusePath!=null?opts.reusePath:15),
    ignoreCreeps: true,
    stuckValue: 2,
    repath: 0.05,
    maxOps: 6000
  };
  if (BeeToolbox && BeeToolbox.roomCallback) tOpts.roomCallback = BeeToolbox.roomCallback;
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
    var rm = _roomMem(rn);
    if (rm.hostile) continue;
    if (isRoomLockedByInvaderCore(rn)) continue;

    if (rm._lastValidFlagScan && (Game.time - rm._lastValidFlagScan) < 300) continue;
    rm._lastValidFlagScan = Game.time;

    var sources = room.find(FIND_SOURCES);
    for (var j=0;j<sources.length;j++){
      var s=sources[j];
      var e=_maEnsure(memAssign[s.id], rn);
      if (maCount(memAssign, s.id) >= MAX_FORAGERS_PER_SOURCE) continue;
      var cost = pfCostCached(anchor, s.pos, s.id); if (cost===Infinity) continue;
      ensureSourceFlag(s);
      // record tile for safer prune compares
      var srec = _sourceMem(rn, s.id); srec.x = s.pos.x; srec.y = s.pos.y;
      memAssign[s.id] = e; // persist shape
    }
  }
}

// ============================
// Invader lock detection
// ============================
function isRoomLockedByInvaderCore(roomName){
  if (!roomName) return false;
  var rm = _roomMem(roomName);
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
      // Skip if another owner is active
      var ownerNow = maOwner(memAssign, s.id);
      if (ownerNow && ownerNow !== creep.name) continue;
      if (maCount(memAssign, s.id) >= MAX_FORAGERS_PER_SOURCE) continue;

      var sticky = (creep.memory.sourceId===s.id) ? 1 : 0;
      candidates.push({ id:s.id, roomName:rn, cost:cost, lin:lin, sticky:sticky });
    }
  }

  // 2) No vision → use Memory.rooms.*.sources
  if (!candidates.length){
    for (i=0;i<neighborRooms.length;i++){
      rn=neighborRooms[i]; if (isRoomLockedByInvaderCore(rn)) continue;
      var rm = _roomMem(rn); if (!rm || !rm.sources) continue;
      for (var sid in rm.sources){
        if (shouldAvoid(creep, sid)){ avoided.push({id:sid,roomName:rn,cost:1e9,lin:99,left:avoidRemaining(creep,sid)}); continue; }
        var ownerNow2 = maOwner(memAssign, sid);
        if (ownerNow2 && ownerNow2 !== creep.name) continue;
        if (maCount(memAssign, sid) >= MAX_FORAGERS_PER_SOURCE) continue;

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

  for (var k=0;k+candidates.length>k;k++){
    var best=candidates[k];
    if (!tryClaimSourceForTick(creep, best.id)) continue;

    // Reserve immediately
    maInc(memAssign, best.id, best.roomName);
    maSetOwner(memAssign, best.id, creep.name, best.roomName);

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
}

// If duplicates exist, loser yields this tick (no repick same tick)
function validateExclusiveSource(creep){
  if (!creep.memory || !creep.memory.sourceId) return true;

  var sid = creep.memory.sourceId;
  var memAssign = ensureAssignmentsMem();
  var owner = maOwner(memAssign, sid);

  // If someone else is the recorded owner, we yield
  if (owner && owner !== creep.name){
    releaseAssignment(creep);
    return false;
  }

  // Hard scan in case of races
  var winners=[];
  for (var name in Game.creeps){
    var c=Game.creeps[name];
    if (c && c.memory && c.memory.task==='remoteharvest' && c.memory.sourceId===sid){
      winners.push(c);
    }
  }
  if (winners.length <= MAX_FORAGERS_PER_SOURCE){
    // become/keep owner if none set
    if (!owner) maSetOwner(memAssign, sid, creep.name, creep.memory.targetRoom||null);
    return true;
  }

  winners.sort(function(a,b){
    var at=a.memory._assignTick||0, bt=b.memory._assignTick||0;
    if (at!==bt) return at-bt;
    return a.name<b.name?-1:1;
  });
  var win = winners[0];
  maSetOwner(memAssign, sid, win.name, win.memory.targetRoom||null);

  // If we're not the winner, yield
  if (win.name !== creep.name){
    console.log('🚦 '+creep.name+' yielding duplicate source '+sid.slice(-6)+' (backing off).');
    releaseAssignment(creep);
    return false;
  }
  return true;
}

// ============================
// Main role
// ============================
var TaskRemoteHarvest = {
  run: function(creep){
    auditOncePerTick();
    if (!creep.memory.home) getHomeName(creep);

    // Anti-stuck tracking
    var lastX=creep.memory._lx|0, lastY=creep.memory._ly|0, lastR=creep.memory._lr||'';
    var samePos = (lastX===creep.pos.x && lastY===creep.pos.y && lastR===creep.pos.roomName);
    creep.memory._stuck = samePos ? ((creep.memory._stuck|0)+1) : 0;
    creep.memory._lx = creep.pos.x; creep.memory._ly = creep.pos.y; creep.memory._lr = creep.pos.roomName;

    // Carry state
    this.updateReturnState(creep);
    if (creep.memory.returning){ this.returnToStorage(creep); return; }

    // Gentle EOL slot free
    if (creep.ticksToLive!==undefined && creep.ticksToLive<5 && creep.memory.assigned){ releaseAssignment(creep); }

    // Cooldown after yield
    if (creep.memory._retargetAt && Game.time < creep.memory._retargetAt){
      var _anchor = getAnchorPos(getHomeName(creep)); go(creep,_anchor,{range:2,reusePath:10}); return;
    }

    // If we were flagged to yield by resolver, obey & stop
    if (creep.memory._forceYield){
      delete creep.memory._forceYield;
      releaseAssignment(creep);
      return;
    }

    // Assignment phase
    if (!creep.memory.sourceId){
      var pick = pickRemoteSource(creep);
      if (pick){
        creep.memory.sourceId   = pick.id;
        creep.memory.targetRoom = pick.roomName;
        creep.memory.assigned   = true;
        creep.memory._assignTick = Game.time;
      }else{
        this.initializeAndAssign(creep);
        if (!creep.memory.sourceId){ var anchor=getAnchorPos(getHomeName(creep)); go(creep,anchor,{range:2}); return; }
        else creep.memory._assignTick = Game.time;
      }
    }

    // If room got locked by invader activity, drop and repick
    if (creep.memory.targetRoom && isRoomLockedByInvaderCore(creep.memory.targetRoom)){
      console.log('⛔ '+creep.name+' skipping locked room '+creep.memory.targetRoom+' (Invader activity).');
      releaseAssignment(creep);
      return;
    }

    // Ensure exclusivity or yield
    if (!validateExclusiveSource(creep)) return;

    // Travel to target room
    if (creep.memory.targetRoom && creep.pos.roomName !== creep.memory.targetRoom){
      go(creep, new RoomPosition(25,25,creep.memory.targetRoom), { range:20, reusePath:20 });
      return;
    }

    // Defensive: memory wipe mid-run
    if (!creep.memory.targetRoom || !creep.memory.sourceId){
      this.initializeAndAssign(creep);
      if (!creep.memory.targetRoom || !creep.memory.sourceId){
        if (Game.time % 25 === 0) console.log('🚫 Forager '+creep.name+' could not be assigned a room/source.');
        return;
      }
    }

    // Optional metadata
    var targetRoomObj = Game.rooms[creep.memory.targetRoom];
    if (targetRoomObj && BeeToolbox && BeeToolbox.logSourcesInRoom){ BeeToolbox.logSourcesInRoom(targetRoomObj); }

    // Avoid rooms you marked hostile in Memory
    var tmem = _roomMem(creep.memory.targetRoom);
    if (tmem && tmem.hostile){
      console.log('⚠️ Forager '+creep.name+' avoiding hostile room '+creep.memory.targetRoom);
      releaseAssignment(creep);
      return;
    }
    if (!tmem || !tmem.sources) return;

    // NEW: while we’re actively working this room, ensure a controller flag exists
    var ctl = targetRoomObj && targetRoomObj.controller;
    if (ctl) ensureControllerFlag(ctl);

    // Work the source
    this.harvestSource(creep);
  },

  // ---- Legacy fallback (no vision) — now radius-bounded ----
  getNearbyRoomsWithSources: function(creep){
    var homeName = getHomeName(creep);

    // Build an allowlist with BFS radius (room hops from home)
    var inRadius = {};
    var ring = bfsNeighborRooms(homeName, REMOTE_RADIUS);
    for (var i=0; i<ring.length; i++) inRadius[ring[i]] = true;

    var all = Object.keys(Memory.rooms||{});
    var filtered = all.filter(function(roomName){
      var rm = Memory.rooms[roomName];
      if (!rm || !rm.sources) return false;
      if (!inRadius[roomName]) return false;                 // ★ enforce radius here
      if (rm.hostile) return false;
      if (isRoomLockedByInvaderCore(roomName)) return false;
      return roomName !== Memory.firstSpawnRoom;
    });

    // Sort by linear distance from home (cheap tiebreaker)
    return filtered.sort(function(a,b){
      return Game.map.getRoomLinearDistance(homeName, a) - Game.map.getRoomLinearDistance(homeName, b);
    });
  },

  findRoomWithLeastForagers: function(rooms, homeName){
    if (!rooms || !rooms.length) return null;

    // Guard: enforce radius again (cheap insurance if caller changes later)
    var inRadius = {};
    var ring = bfsNeighborRooms(homeName, REMOTE_RADIUS);
    for (var i=0; i<ring.length; i++) inRadius[ring[i]] = true;

    var best=null, lowest=Infinity;
    for (var j=0;j<rooms.length;j++){
      var rn=rooms[j];
      if (!inRadius[rn]) continue;                 // ★ radius fence
      if (isRoomLockedByInvaderCore(rn)) continue;

      var rm=_roomMem(rn), sources = rm.sources?Object.keys(rm.sources):[]; if (!sources.length) continue;

      var count=0;
      for (var name in Game.creeps){
        var c=Game.creeps[name];
        if (c && c.memory && c.memory.task==='remoteharvest' && c.memory.targetRoom===rn) count++;
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
    // Prefer free → then sticky (self) → finally any
    var free=[], sticky=[], rest=[];
    for (var i=0;i<sids.length;i++){
      var sid=sids[i];
      var owner = maOwner(memAssign, sid);
      var cnt   = maCount(memAssign, sid);
      if (owner && owner !== creep.name) continue;           // taken
      if (cnt >= MAX_FORAGERS_PER_SOURCE) continue;          // full

      if (creep.memory.sourceId===sid) sticky.push(sid);
      else if (!owner) free.push(sid);
      else rest.push(sid);
    }

    var pick = free[0] || sticky[0] || rest[0] || null;
    if (!pick) return null;

    if (!tryClaimSourceForTick(creep, pick)) return null; // rare
    return pick;
  },

  updateReturnState: function(creep){
    if (!creep.memory.returning && creep.store.getFreeCapacity(RESOURCE_ENERGY)===0) creep.memory.returning=true;
    if (creep.memory.returning && creep.store.getUsedCapacity(RESOURCE_ENERGY)===0) creep.memory.returning=false;
  },

  returnToStorage: function(creep){
    var homeName=getHomeName(creep);
    if (creep.room.name !== homeName){ go(creep,new RoomPosition(25,25,homeName),{range:20,reusePath:20}); return; }

    var pri=creep.room.find(FIND_STRUCTURES,{filter:function(s){
      return (s.structureType===STRUCTURE_EXTENSION || s.structureType===STRUCTURE_SPAWN) &&
             s.store && s.store.getFreeCapacity(RESOURCE_ENERGY)>0; }});
    if (pri.length){ var a=creep.pos.findClosestByPath(pri); if (a){ var rc=creep.transfer(a,RESOURCE_ENERGY); if (rc===ERR_NOT_IN_RANGE) go(creep,a); return; } }

    var stor=creep.room.storage;
    if (stor && stor.store && stor.store.getFreeCapacity(RESOURCE_ENERGY)>0){ var rc2=creep.transfer(stor,RESOURCE_ENERGY); if (rc2===ERR_NOT_IN_RANGE) go(creep,stor); return; }

    var conts=creep.room.find(FIND_STRUCTURES,{filter:function(s){ return s.structureType===STRUCTURE_CONTAINER && s.store && s.store.getFreeCapacity(RESOURCE_ENERGY)>0; }});
    if (conts.length){ var b=creep.pos.findClosestByPath(conts); if (b){ var rc3=creep.transfer(b,RESOURCE_ENERGY); if (rc3===ERR_NOT_IN_RANGE) go(creep,b); return; } }

    var anchor=getAnchorPos(homeName); go(creep,anchor,{range:2});
  },

  harvestSource: function(creep){
    if (!creep.memory.targetRoom || !creep.memory.sourceId){
      if (Game.time%25===0) console.log('Forager '+creep.name+' missing targetRoom/sourceId'); return;
    }

    if (creep.room.name !== creep.memory.targetRoom){
      go(creep,new RoomPosition(25,25,creep.memory.targetRoom),{range:20,reusePath:20}); return;
    }

    if (isRoomLockedByInvaderCore(creep.room.name)){
      console.log('⛔ '+creep.name+' bailing from locked room '+creep.room.name+'.');
      releaseAssignment(creep); return;
    }

    var sid = creep.memory.sourceId;
    var src = Game.getObjectById(sid);
    if (!src){ if (Game.time%25===0) console.log('Source not found for '+creep.name); releaseAssignment(creep); return; }

    ensureSourceFlag(src); // will touch lastActive
    // also remember tile for safer prune compare
    var srec = _sourceMem(creep.room.name, sid); srec.x = src.pos.x; srec.y = src.pos.y;

    // NEW: keep controller flag fresh while active in the room
    if (creep.room.controller) ensureControllerFlag(creep.room.controller);

    var rm = _roomMem(creep.memory.targetRoom);
    rm.sources = rm.sources || {};
    if (rm.sources[sid] && rm.sources[sid].entrySteps == null){
      var res = PathFinder.search(creep.pos, { pos: src.pos, range: 1 }, { plainCost: PLAIN_COST, swampCost: SWAMP_COST, maxOps: MAX_PF_OPS });
      if (!res.incomplete) rm.sources[sid].entrySteps = res.path.length;
    }

    if ((creep.memory._stuck|0) >= STUCK_WINDOW){ go(creep, src, { range:1, reusePath:3 }); creep.say('🚧'); }

    var rc = creep.harvest(src);
    if (rc===ERR_NOT_IN_RANGE) go(creep, src, { range:1, reusePath:15 });
    else if (rc===OK){
      // harvesting is also activity
      touchSourceActive(creep.room.name, sid);
    }
  }
};

module.exports = TaskRemoteHarvest;
