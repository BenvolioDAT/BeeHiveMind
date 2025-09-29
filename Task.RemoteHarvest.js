// TaskRemoteHarvest.clean.js
// Remote-harvester ("forager"): mines a remote source and hauls energy home.
// Upgrades:
// - Skip locked rooms (Invader Core or Invader reservation).
// - Enforce unique source ownership (1 per source) with backoff + "soonest-free" fallback.
// - NEW: per-tick source-claim lock (atomic, deterministic) to prevent same-tick double-picks.
// - PF-cost caching + once-per-tick occupancy audit.
// - Return-to-storage takes priority over cooldown so full creeps always deposit.
// - ES5-safe (no const/let/arrow/optional-chaining).

'use strict';

// ============================
// Dependencies
// ============================
var BeeToolbox = require('BeeToolbox');

// ============================
// Tunables
// ============================
var REMOTE_RADIUS = 6;             // Room hops from home to scan
var MAX_PF_OPS    = 3000;          // PathFinder ops budget during selection
var PLAIN_COST    = 2;             // PF cost on plains
var SWAMP_COST    = 10;            // PF cost on swamps
var MAX_FORAGERS_PER_SOURCE = 1;   // Strict unique ownership

var PF_CACHE_TTL = 150;            // ticks
var INVADER_LOCK_MEMO_TTL = 1500;  // ticks to trust lock memo without vision

// Anti-flap / avoid list
var AVOID_TTL = 30;                // ticks to avoid a source after losing it (shorter so retries happen)
var RETARGET_COOLDOWN = 5;         // ticks to wait before repicking

// ============================
// Global, safe, ES5 utilities
// ============================

function shortSid(id) {
  if (!id || typeof id !== 'string') return '??????';
  var n = id.length;
  return id.substr(n - 6);
}

/** Ensure exactly one flag exists on this source tile (idempotent). */
function ensureSourceFlag(source) {
  if (!source || !source.pos || !source.room) return;

  var rm = Memory.rooms[source.pos.roomName] = (Memory.rooms[source.pos.roomName] || {});
  rm.sources = rm.sources || {};
  var srec = rm.sources[source.id] = (rm.sources[source.id] || {});

  if (srec.flagName) {
    var f = Game.flags[srec.flagName];
    if (f &&
        f.pos.x === source.pos.x &&
        f.pos.y === source.pos.y &&
        f.pos.roomName === source.pos.roomName) {
      return;
    }
  }

  var flagsHere = source.pos.lookFor(LOOK_FLAGS) || [];
  var expectedPrefix = 'SRC-' + source.pos.roomName + '-';
  var sidTail = shortSid(source.id);
  for (var i = 0; i < flagsHere.length; i++) {
    var fh = flagsHere[i];
    if (typeof fh.name === 'string' &&
        fh.name.indexOf(expectedPrefix) === 0 &&
        fh.name.indexOf(sidTail) !== -1) {
      srec.flagName = fh.name;
      return;
    }
  }

  var base = expectedPrefix + sidTail; // e.g., "SRC-E12S34-abc123"
  var name = base;
  var tries = 1;
  while (Game.flags[name]) {
    tries++;
    name = base + '-' + tries;
    if (tries > 10) break;
  }

  var rc = source.room.createFlag(source.pos, name, COLOR_YELLOW, COLOR_YELLOW);
  if (typeof rc === 'string') {
    srec.flagName = rc;
  }
}

// -------- Avoid-list helpers (per-creep) --------
function _ensureAvoid(creep) {
  if (!creep.memory._avoid) creep.memory._avoid = {}; // { sourceId: untilTick }
  return creep.memory._avoid;
}

function shouldAvoid(creep, sourceId) {
  if (!sourceId) return false;
  var avoid = _ensureAvoid(creep);
  var until = avoid[sourceId];
  return (typeof until === 'number' && Game.time < until);
}

function markAvoid(creep, sourceId, ttl) {
  if (!sourceId) return;
  var avoid = _ensureAvoid(creep);
  avoid[sourceId] = Game.time + (ttl != null ? ttl : AVOID_TTL);
}

function avoidRemaining(creep, sourceId) {
  var avoid = _ensureAvoid(creep);
  var until = avoid[sourceId];
  if (typeof until !== 'number') return 0;
  var left = until - Game.time;
  return left > 0 ? left : 0;
}

// ============================
// Per-tick source claim lock (atomic-ish)
// ============================
// Only one creep can "win" a source in a given tick.
// Winner = lexicographically smallest creep.name among claimants.
function _claimTable() {
  var sc = Memory._sourceClaim;
  if (!sc || sc.t !== Game.time) {
    Memory._sourceClaim = { t: Game.time, m: {} };
  }
  return Memory._sourceClaim.m;
}

/**
 * Try to claim sourceId for this tick.
 * Returns true if this creep is the elected winner for that source this tick.
 */
function tryClaimSourceForTick(creep, sourceId) {
  var m = _claimTable();
  var cur = m[sourceId];
  if (!cur) {
    m[sourceId] = creep.name;
    return true; // first claimant wins (tentatively)
  }
  // Elect the lexicographically smallest name as the single winner
  if (creep.name < cur) {
    m[sourceId] = creep.name;
    return true;
  }
  return cur === creep.name;
}

// ============================
// Invader Core / lock detection
// ============================
function isRoomLockedByInvaderCore(roomName) {
  if (!roomName) return false;

  var rm = Memory.rooms[roomName] = (Memory.rooms[roomName] || {});
  var now = Game.time;

  var room = Game.rooms[roomName];
  if (room) {
    var locked = false;

    // Invader Core present?
    var cores = room.find(FIND_STRUCTURES, {
      filter: function(s){ return s.structureType === STRUCTURE_INVADER_CORE; }
    });
    if (cores && cores.length > 0) locked = true;

    // Controller reserved by 'Invader'?
    if (!locked && room.controller && room.controller.reservation &&
        room.controller.reservation.username === 'Invader') {
      locked = true;
    }

    // Optional: toolbox signal
    if (!locked && BeeToolbox && BeeToolbox.isRoomInvaderLocked) {
      try { if (BeeToolbox.isRoomInvaderLocked(room)) locked = true; } catch (e) {}
    }

    rm._invaderLock = { locked: locked, t: now };
    return locked;
  }

  // No vision → use memo if fresh
  if (rm._invaderLock && typeof rm._invaderLock.locked === 'boolean' && typeof rm._invaderLock.t === 'number') {
    if ((now - rm._invaderLock.t) <= INVADER_LOCK_MEMO_TTL) {
      return rm._invaderLock.locked;
    }
  }

  return false;
}

// ============================
// Occupancy audit (once per tick)
// ============================
function ensureAssignmentsMem() {
  if (!Memory.remoteAssignments) Memory.remoteAssignments = {};
  return Memory.remoteAssignments;
}

function auditRemoteAssignments() {
  var live = {};
  for (var name in Game.creeps) {
    var c = Game.creeps[name];
    if (c && c.memory && c.memory.task === 'remoteharvest') {
      var sid = c.memory.sourceId;
      if (sid) live[sid] = (live[sid] || 0) + 1;
    }
  }
  var memAssign = Memory.remoteAssignments || (Memory.remoteAssignments = {});
  for (var sid2 in memAssign) {
    memAssign[sid2] = live[sid2] || 0;
  }
  for (var sid3 in live) memAssign[sid3] = live[sid3];
}

function auditOncePerTick() {
  if (Memory._auditRemoteAssignmentsTick !== Game.time) {
    auditRemoteAssignments();
    Memory._auditRemoteAssignmentsTick = Game.time;
  }
}

// ============================
// Pathing helpers
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
        var room = Game.rooms[roomName];
        if (!room) return; // default costs if no vision
        var matrix = new PathFinder.CostMatrix();

        room.find(FIND_STRUCTURES).forEach(function(s) {
          if (s.structureType === STRUCTURE_ROAD) {
            matrix.set(s.pos.x, s.pos.y, 1);
          } else if (
            s.structureType !== STRUCTURE_CONTAINER &&
            (s.structureType !== STRUCTURE_RAMPART || !s.my)
          ) {
            matrix.set(s.pos.x, s.pos.y, 0xff);
          }
        });

        room.find(FIND_CONSTRUCTION_SITES).forEach(function(cs) {
          if (cs.structureType !== STRUCTURE_ROAD) {
            matrix.set(cs.pos.x, cs.pos.y, 0xff);
          }
        });

        return matrix;
      }
    }
  );

  return ret.incomplete ? Infinity : ret.cost;
}

function go(creep, dest, opts) {
  opts = opts || {};
  if (typeof BeeToolbox !== 'undefined' && BeeToolbox && BeeToolbox.BeeTravel) {
    BeeToolbox.BeeTravel(creep, dest, opts);
    return;
  }
  var desired = (opts.range != null) ? opts.range : 1;
  if (creep.pos.getRangeTo(dest) > desired) {
    creep.moveTo(dest, { reusePath: (opts.reusePath != null ? opts.reusePath : 15) });
  }
}

// ============================
// Room discovery & anchor
// ============================
function getHomeName(creep) {
  if (creep.memory.home) return creep.memory.home;

  var spawns = Object.keys(Game.spawns).map(function(k){ return Game.spawns[k]; });
  if (spawns.length) {
    var best = spawns[0];
    var bestD = Game.map.getRoomLinearDistance(creep.pos.roomName, best.pos.roomName);
    for (var i = 1; i < spawns.length; i++) {
      var s = spawns[i];
      var d = Game.map.getRoomLinearDistance(creep.pos.roomName, s.pos.roomName);
      if (d < bestD) { best = s; bestD = d; }
    }
    creep.memory.home = best.pos.roomName;
    return creep.memory.home;
  }

  creep.memory.home = creep.pos.roomName;
  return creep.memory.home;
}

function getAnchorPos(homeName) {
  var r = Game.rooms[homeName];
  if (r) {
    if (r.storage) return r.storage.pos;
    var spawns = r.find(FIND_MY_SPAWNS);
    if (spawns.length) return spawns[0].pos;
    if (r.controller && r.controller.my) return r.controller.pos;
  }
  return new RoomPosition(25, 25, homeName);
}

function bfsNeighborRooms(startName, radius) {
  radius = radius == null ? 1 : radius;
  var seen = {};
  seen[startName] = true;
  var frontier = [startName];

  for (var depth = 0; depth < radius; depth++) {
    var next = [];
    for (var f = 0; f < frontier.length; f++) {
      var rn = frontier[f];
      var exits = Game.map.describeExits(rn) || {};
      for (var dir in exits) {
        var n = exits[dir];
        if (!seen[n]) { seen[n] = true; next.push(n); }
      }
    }
    frontier = next;
  }

  var out = [];
  for (var k in seen) if (k !== startName) out.push(k);
  return out;
}

// ============================
// Flagging helper (optional)
// ============================
function markValidRemoteSourcesForHome(homeName) {
  var anchor = getAnchorPos(homeName);
  var memAssign = ensureAssignmentsMem();
  var neighborRooms = bfsNeighborRooms(homeName, REMOTE_RADIUS);

  for (var i = 0; i < neighborRooms.length; i++) {
    var rn = neighborRooms[i];
    var room = Game.rooms[rn];
    if (!room) continue;

    var rm = Memory.rooms[rn] = (Memory.rooms[rn] || {});
    if (rm.hostile) continue;
    if (isRoomLockedByInvaderCore(rn)) continue;

    if (rm._lastValidFlagScan && (Game.time - rm._lastValidFlagScan) < 300) continue;
    rm._lastValidFlagScan = Game.time;

    var sources = room.find(FIND_SOURCES);
    for (var j = 0; j < sources.length; j++) {
      var s = sources[j];

      if (memAssign[s.id] >= MAX_FORAGERS_PER_SOURCE) continue;

      var cost = pfCostCached(anchor, s.pos, s.id);
      if (cost === Infinity) continue;

      ensureSourceFlag(s);
    }
  }
}

// ============================
// Picking & exclusivity
// ============================
function pickRemoteSource(creep) {
  var memAssign = ensureAssignmentsMem();
  var homeName = getHomeName(creep);

  if ((Game.time + creep.name.charCodeAt(0)) % 50 === 0) {
    markValidRemoteSourcesForHome(homeName);
  }
  var anchor = getAnchorPos(homeName);

  var neighborRooms = bfsNeighborRooms(homeName, REMOTE_RADIUS);
  var candidates = [];
  var avoided = []; // collect avoided options to allow "soonest-free" fallback

  for (var i = 0; i < neighborRooms.length; i++) {
    var rn = neighborRooms[i];
    if (isRoomLockedByInvaderCore(rn)) continue;

    var room = Game.rooms[rn];
    if (!room) continue; // need vision

    var sources = room.find(FIND_SOURCES);
    for (var j = 0; j < sources.length; j++) {
      var s = sources[j];

      var cost = pfCostCached(anchor, s.pos, s.id);
      if (cost === Infinity) continue;

      var lin = Game.map.getRoomLinearDistance(homeName, rn);

      if (shouldAvoid(creep, s.id)) {
        avoided.push({
          id: s.id,
          roomName: rn,
          cost: cost,
          lin: lin,
          left: avoidRemaining(creep, s.id)
        });
        continue;
      }

      var occ = memAssign[s.id] || 0;
      if (occ >= MAX_FORAGERS_PER_SOURCE) continue;

      candidates.push({
        id: s.id,
        roomName: rn,
        cost: cost,
        lin: lin
      });
    }
  }

  if (!candidates.length) {
    // No clean candidates. Fall back to the avoided one that frees up soonest,
    // but only if it's about to open (prevents flapping).
    if (!avoided.length) return null;
    avoided.sort(function(a, b) {
      return (a.left - b.left) || (a.cost - b.cost) || (a.lin - b.lin) ||
             (a.id < b.id ? -1 : (a.id > b.id ? 1 : 0));
    });
    var soonest = avoided[0];
    if (soonest.left <= 5) {
      candidates.push(soonest);
    } else {
      return null;
    }
  }

  candidates.sort(function(a, b) {
    return (a.cost - b.cost) || (a.lin - b.lin) || (a.id < b.id ? -1 : (a.id > b.id ? 1 : 0));
  });

  // NEW: atomically claim a source for this tick; if we don't win the claim for top candidate, try next.
  for (var k = 0; k < candidates.length; k++) {
    var best = candidates[k];
    if (!tryClaimSourceForTick(creep, best.id)) continue; // lost the election for this source this tick

    // Reserve slot immediately
    memAssign[best.id] = (memAssign[best.id] || 0) + 1;
    creep.memory._assignTick = Game.time;

    // Throttle log to only when changed
    if (creep.memory._lastLogSid !== best.id) {
      console.log('🧭 ' + creep.name + ' pick src=' + best.id.slice(-6) + ' room=' + best.roomName + ' cost=' + best.cost);
      creep.memory._lastLogSid = best.id;
    }

    return best;
  }

  // Could not win any claim this tick
  return null;
}

function releaseAssignment(creep) {
  var memAssign = ensureAssignmentsMem();
  var sid = creep.memory.sourceId;
  if (sid && memAssign[sid]) memAssign[sid] = Math.max(0, memAssign[sid] - 1);

  // Avoid this source for a bit so we don't re-pick it instantly
  if (sid) markAvoid(creep, sid, AVOID_TTL);

  creep.memory.sourceId   = null;
  creep.memory.targetRoom = null;
  creep.memory.assigned   = false;

  // Short cooldown before repicking (prevents console flap)
  creep.memory._retargetAt = Game.time + RETARGET_COOLDOWN;
}

function validateExclusiveSource(creep) {
  if (!creep.memory || !creep.memory.sourceId) return true;

  var sid = creep.memory.sourceId;
  var winners = [];
  for (var name in Game.creeps) {
    var c = Game.creeps[name];
    if (!c || !c.memory) continue;
    if (c.memory.task === 'remoteharvest' && c.memory.sourceId === sid) {
      winners.push(c);
    }
  }

  if (winners.length <= MAX_FORAGERS_PER_SOURCE) return true;

  // Deterministic: oldest assignment wins; then name
  winners.sort(function(a, b) {
    var at = a.memory._assignTick || 0;
    var bt = b.memory._assignTick || 0;
    if (at !== bt) return at - bt;
    return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0);
  });

  for (var i = MAX_FORAGERS_PER_SOURCE; i < winners.length; i++) {
    var loser = winners[i];
    if (loser.name === creep.name) {
      markAvoid(creep, sid, AVOID_TTL);
      console.log('🚦 ' + creep.name + ' yielding duplicate source ' + sid.slice(-6) + ' (backing off).');
      releaseAssignment(creep);
      return false;
    }
  }
  return true;
}

// ============================
// Main role
// ============================
var TaskRemoteHarvest = {
  run: function(creep) {
    auditOncePerTick();

    if (!creep.memory.home) getHomeName(creep);

    // Always update carry state FIRST so returning takes priority
    this.updateReturnState(creep);

    // If full, deposit immediately — do NOT let cooldown block this
    if (creep.memory.returning) {
      this.returnToStorage(creep);
      return;
    }

    // Graceful slot free near EOL
    if (creep.ticksToLive !== undefined && creep.ticksToLive < 5 && creep.memory.assigned) {
      releaseAssignment(creep);
    }

    // Retarget cooldown only applies when we're *not* returning
    if (creep.memory._retargetAt && Game.time < creep.memory._retargetAt && !creep.memory.returning) {
      var _anchor = getAnchorPos(getHomeName(creep));
      go(creep, _anchor, { range: 2, reusePath: 10 });
      return;
    }

    // Assignment phase
    if (!creep.memory.sourceId) {
      var pick = pickRemoteSource(creep);
      if (pick) {
        creep.memory.sourceId   = pick.id;
        creep.memory.targetRoom = pick.roomName;
        creep.memory.assigned   = true;
        creep.memory._assignTick = Game.time;
      } else {
        this.initializeAndAssign(creep);
        if (!creep.memory.sourceId) {
          var anchor = getAnchorPos(getHomeName(creep));
          go(creep, anchor, { range: 2 });
          return;
        } else {
          creep.memory._assignTick = Game.time;
        }
      }
    }

    // If the target room became locked, drop and repick.
    if (creep.memory.targetRoom && isRoomLockedByInvaderCore(creep.memory.targetRoom)) {
      console.log('⛔ ' + creep.name + ' skipping locked room ' + creep.memory.targetRoom + ' (Invader activity).');
      releaseAssignment(creep);
      var retry = pickRemoteSource(creep);
      if (retry) {
        creep.memory.sourceId   = retry.id;
        creep.memory.targetRoom = retry.roomName;
        creep.memory.assigned   = true;
        creep.memory._assignTick = Game.time;
      } else {
        var anchor2 = getAnchorPos(getHomeName(creep));
        go(creep, anchor2, { range: 2 });
        return;
      }
    }

    // Ensure exclusivity at runtime (handles rare races)
    if (!validateExclusiveSource(creep)) {
      var again = pickRemoteSource(creep);
      if (again) {
        creep.memory.sourceId   = again.id;
        creep.memory.targetRoom = again.roomName;
        creep.memory.assigned   = true;
        creep.memory._assignTick = Game.time;
      } else {
        var anchor3 = getAnchorPos(getHomeName(creep));
        go(creep, anchor3, { range: 2 });
        return;
      }
    }

    // Travel toward target room if needed
    if (creep.memory.targetRoom && creep.pos.roomName !== creep.memory.targetRoom) {
      go(creep, new RoomPosition(25, 25, creep.memory.targetRoom), { range: 20 });
      return;
    }

    // Defensive: if memory wiped mid-run, re-init
    if (!creep.memory.targetRoom || !creep.memory.sourceId) {
      this.initializeAndAssign(creep);
      if (!creep.memory.targetRoom || !creep.memory.sourceId) {
        if (Game.time % 25 === 0) console.log('🚫 Forager ' + creep.name + ' could not be assigned a room/source.');
        return;
      }
    }

    // Toolbox metadata (optional)
    var targetRoomObj = Game.rooms[creep.memory.targetRoom];
    if (targetRoomObj && BeeToolbox && BeeToolbox.logSourcesInRoom) {
      BeeToolbox.logSourcesInRoom(targetRoomObj);
    }

    // Also bail if Memory flagged hostile
    var tmem = Memory.rooms[creep.memory.targetRoom];
    if (tmem && tmem.hostile) {
      console.log('⚠️ Forager ' + creep.name + ' avoiding hostile room ' + creep.memory.targetRoom);
      releaseAssignment(creep);
      return;
    }

    if (!tmem || !tmem.sources) return;

    // Work the source
    this.harvestSource(creep);

    // Validate assignment only when in target room (vision guaranteed)
    if (creep.memory.targetRoom && creep.pos.roomName === creep.memory.targetRoom) {
      var srcObj = Game.getObjectById(creep.memory.sourceId);
      if (!srcObj) {
        releaseAssignment(creep);
        return;
      }
    }
  },

  // ------ Legacy / fallback assignment (Memory-based) ------
  initializeAndAssign: function(creep) {
    var targetRooms = this.getNearbyRoomsWithSources(creep.room.name);

    if (!creep.memory.targetRoom || !creep.memory.sourceId) {
      var leastAssignedRoom = this.findRoomWithLeastForagers(targetRooms);
      if (!leastAssignedRoom) {
        if (Game.time % 25 === 0) console.log('🚫 Forager ' + creep.name + ' found no suitable room with unclaimed sources.');
        return;
      }

      creep.memory.targetRoom = leastAssignedRoom;
      var roomMemory = Memory.rooms[creep.memory.targetRoom];
      var assignedSource = this.assignSource(creep, roomMemory);

      if (assignedSource) {
        creep.memory.sourceId = assignedSource;
        creep.memory.assigned = true;
        creep.memory._assignTick = Game.time;
        var memAssign = ensureAssignmentsMem();
        memAssign[assignedSource] = (memAssign[assignedSource] || 0) + 1;

        if (creep.memory._lastLogSid !== assignedSource) {
          console.log('🐝 ' + creep.name + ' assigned to source: ' + assignedSource + ' in ' + creep.memory.targetRoom);
          creep.memory._lastLogSid = assignedSource;
        }
      } else {
        if (Game.time % 25 === 0) console.log('No available sources for creep: ' + creep.name);
        creep.memory.targetRoom = null;
        creep.memory.sourceId   = null;
      }
    }
  },

  getNearbyRoomsWithSources: function(origin) {
    var all = Object.keys(Memory.rooms || {});
    var filtered = all.filter(function(roomName) {
      var rm = Memory.rooms[roomName];
      if (!rm || !rm.sources) return false;
      if (rm.hostile) return false;
      if (isRoomLockedByInvaderCore(roomName)) return false;
      return roomName !== Memory.firstSpawnRoom;
    });

    return filtered.sort(function(a, b) {
      return Game.map.getRoomLinearDistance(origin, a) - Game.map.getRoomLinearDistance(origin, b);
    });
  },

  findRoomWithLeastForagers: function(targetRooms) {
    var bestRoom = null;
    var lowestAvg = Infinity;

    for (var i = 0; i < targetRooms.length; i++) {
      var roomName = targetRooms[i];
      if (isRoomLockedByInvaderCore(roomName)) continue;

      var rm = Memory.rooms[roomName] || {};
      var sources = rm.sources ? Object.keys(rm.sources) : [];
      if (!sources.length) continue;

      var foragersInRoom = 0;
      for (var name in Game.creeps) {
        var c = Game.creeps[name];
        if (c && c.memory && c.memory.task === 'remoteharvest' && c.memory.targetRoom === roomName) {
          foragersInRoom++;
        }
      }

      var avg = foragersInRoom / sources.length;
      if (avg < lowestAvg) { lowestAvg = avg; bestRoom = roomName; }
    }

    return bestRoom;
  },

  assignSource: function(creep, roomMemory) {
    if (!roomMemory || !roomMemory.sources) return null;
    var sources = Object.keys(roomMemory.sources);
    if (!sources.length) return null;

    var counts = {};
    var maxCount = 0;
    var avoided = []; // track avoided in case we can grace-pick soon

    // Build occupancy table and avoided list
    for (var si = 0; si < sources.length; si++) {
      var sid = sources[si];

      // Count current foragers on this source in this room
      var capCnt = 0;
      for (var name in Game.creeps) {
        var c = Game.creeps[name];
        if (c && c.memory && c.memory.task === 'remoteharvest' &&
            c.memory.targetRoom === creep.memory.targetRoom &&
            c.memory.sourceId === sid) {
          capCnt++;
        }
      }

      // Respect cap
      if (capCnt >= MAX_FORAGERS_PER_SOURCE) {
        counts[sid] = capCnt;
        if (capCnt > maxCount) maxCount = capCnt;
        continue;
      }

      if (shouldAvoid(creep, sid)) {
        avoided.push({ sid: sid, left: avoidRemaining(creep, sid) });
        continue;
      }

      counts[sid] = capCnt;
      if (capCnt > maxCount) maxCount = capCnt;
    }

    // Prefer truly free first (lowest count). Use per-tick claim to avoid races.
    for (var tier = 0; tier <= maxCount; tier++) {
      var candidates = [];
      for (var sid2 in counts) if (counts[sid2] === tier) candidates.push(sid2);
      if (candidates.length) {
        // Try each candidate until we win a claim
        for (var i = 0; i < candidates.length; i++) {
          var trySid = candidates[i];
          if (tryClaimSourceForTick(creep, trySid)) return trySid;
        }
      }
    }

    // Fallback: pick avoided source whose backoff ends soonest (also respect claim)
    if (avoided.length) {
      avoided.sort(function(a, b){ return a.left - b.left; });
      if (avoided[0].left <= 5 && tryClaimSourceForTick(creep, avoided[0].sid)) return avoided[0].sid;
    }

    return null;
  },

  updateReturnState: function(creep) {
    if (!creep.memory.returning && creep.store.getFreeCapacity(RESOURCE_ENERGY) === 0) {
      creep.memory.returning = true;
    }
    if (creep.memory.returning && creep.store.getUsedCapacity(RESOURCE_ENERGY) === 0) {
      creep.memory.returning = false;
    }
  },

  findUnclaimedSource: function(targetRooms) {
    // Legacy helper (kept for compatibility)
    for (var i = 0; i < targetRooms.length; i++) {
      var roomName = targetRooms[i];
      var mem = Memory.rooms[roomName];
      if (!mem || !mem.sources) continue;
      for (var sid in mem.sources) {
        var assigned = mem.sources[sid];
        if (!Array.isArray(assigned) || assigned.length === 0) return { roomName: roomName, sourceId: sid };
      }
    }
    return null;
  },

  returnToStorage: function(creep) {
    var homeName = getHomeName(creep);

    if (creep.room.name !== homeName) {
      go(creep, new RoomPosition(25, 25, homeName), { range: 20 });
      return;
    }

    // Prefer core sinks first (spawn/ext/storage)
    var targets = creep.room.find(FIND_STRUCTURES, {
      filter: function(s) {
        var canFill =
          (s.structureType === STRUCTURE_EXTENSION ||
           s.structureType === STRUCTURE_SPAWN ||
           s.structureType === STRUCTURE_STORAGE);
        return canFill && s.store && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
      }
    });

    if (!targets.length) {
      // Fallback: containers if core sinks are full
      targets = creep.room.find(FIND_STRUCTURES, {
        filter: function(s) {
          return s.structureType === STRUCTURE_CONTAINER &&
                 s.store && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
        }
      });
    }

    if (targets.length) {
      var closest = creep.pos.findClosestByPath(targets);
      if (closest) {
        var rc = creep.transfer(closest, RESOURCE_ENERGY);
        if (rc === ERR_NOT_IN_RANGE) go(creep, closest);
      }
    } else {
      var anchor = getAnchorPos(homeName);
      go(creep, anchor, { range: 2 });
    }
  },

  harvestSource: function(creep) {
    if (!creep.memory.targetRoom || !creep.memory.sourceId) {
      if (Game.time % 25 === 0) console.log('Forager ' + creep.name + ' missing targetRoom/sourceId');
      return;
    }

    if (creep.room.name !== creep.memory.targetRoom) {
      if (BeeToolbox && BeeToolbox.logSourceContainersInRoom) {
        BeeToolbox.logSourceContainersInRoom(creep.room);
      }
      go(creep, new RoomPosition(25, 25, creep.memory.targetRoom), { range: 20 });
      return;
    }

    // If target room becomes locked while we're inside, bail & repick.
    if (isRoomLockedByInvaderCore(creep.room.name)) {
      console.log('⛔ ' + creep.name + ' bailing from locked room ' + creep.room.name + '.');
      releaseAssignment(creep);
      return;
    }

    var rm = Memory.rooms[creep.memory.targetRoom] = (Memory.rooms[creep.memory.targetRoom] || {});
    rm.sources = rm.sources || {};
    var sid = creep.memory.sourceId;
    var src = Game.getObjectById(sid);

    if (src) {
      ensureSourceFlag(src);
    }

    if (src && rm.sources[sid] && rm.sources[sid].entrySteps == null) {
      var res = PathFinder.search(creep.pos, { pos: src.pos, range: 1 }, {
        plainCost: PLAIN_COST, swampCost: SWAMP_COST, maxOps: MAX_PF_OPS
      });
      if (!res.incomplete) rm.sources[sid].entrySteps = res.path.length;
    }

    if (!src) { if (Game.time % 25 === 0) console.log('Source not found for ' + creep.name); return; }

    if (creep.harvest(src) === ERR_NOT_IN_RANGE) go(creep, src);
  }
};

module.exports = TaskRemoteHarvest;
