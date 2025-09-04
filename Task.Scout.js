var BeeToolbox = require('BeeToolbox');

// ---- SCOUT RING HELPERS ----
const RING_MAX = 5;            // how far out to go before resetting
const REVISIT_DELAY = 5000;    // ticks before revisiting a room is okay
const BLOCK_CHECK_DELAY = 10000;

const DIRS_CLOCKWISE = [RIGHT, BOTTOM, LEFT, TOP]; // E, S, W, N

function okRoomName(rn) {
  const st = Game.map.getRoomStatus(rn);
  return !(st && (st.status === 'novice' || st.status === 'respawn' || st.status === 'closed'));
}

function exitsOrdered(roomName) {
  const ex = Game.map.describeExits(roomName) || {};
  const out = [];
  for (const d of DIRS_CLOCKWISE) if (ex[d]) out.push(ex[d]);
  return out;
}

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


function isBlockedRecently(roomName) {
  if (!Memory.rooms) return false;
  var mr = Memory.rooms[roomName];
  var t = mr && mr.blocked;
  return !!(t && (Game.time - t < BLOCK_CHECK_DELAY));
}


function buildRing(homeName, radius) {
  // 1) generate all rooms at radius r, clockwise, deterministically
  var ring = coordinateRing(homeName, radius);

  // 2) filter out novice/respawn/closed
  var ok = [];
  for (var i=0; i<ring.length; i++) {
    var rn = ring[i];
    var st = Game.map.getRoomStatus(rn);
    if (st && (st.status === 'novice' || st.status === 'respawn' || st.status === 'closed')) continue;
    ok.push(rn);
  }
  return ok;
}


function rebuildQueue(mem) {
  var home = mem.home;
  var ring = mem.ring;

  var layer = buildRing(home, ring);
  var candidates = layer.filter(function(rn){ return !isBlockedRecently(rn); });

  // Keep never-seen rooms in insertion order (clockwise), score only the seen ones
  var never = [];
  var seen  = [];
  for (var i=0; i<candidates.length; i++) {
    var rn = candidates[i];
    var lv = lastVisited(rn);
    if (lv === -Infinity) never.push(rn); else seen.push({ rn: rn, last: lv });
  }
  // Oldest seen first
  seen.sort(function(a,b){ return a.last - b.last; });

  // Build queue: prefer never-seen first, then seen
  var queue = [];
  var prev = mem.prevRoom || null;

  // Avoid immediate backtrack to prev when we have choice
  for (var i=0; i<never.length; i++) {
    if (prev && never[i] === prev && never.length > 1) continue;
    queue.push(never[i]);
  }
  for (var j=0; j<seen.length; j++) {
    if (prev && seen[j].rn === prev && (seen.length - j) > 1) continue;
    queue.push(seen[j].rn);
  }

  mem.queue = queue;
}

function ensureScoutMem(creep) {
  if (!creep.memory.scout) creep.memory.scout = {};
  var m = creep.memory.scout;

  if (!m.home) {
    var spawns = Object.keys(Game.spawns).map(function(k){ return Game.spawns[k]; });
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

function go(creep, dest, opts={}) {
  if (typeof BeeToolbox !== 'undefined' && BeeToolbox.BeeTravel) {
    BeeToolbox.BeeTravel(creep, dest, opts);
  } else {
    const range = opts.range != null ? opts.range : 1;
    creep.moveTo(dest, { reusePath: 15, range });
  }
}

function logRoomIntel(room) {
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};
  var rmem = Memory.rooms[room.name];
  if (!rmem.intel) rmem.intel = {};
  var intel = rmem.intel;

  intel.lastVisited = Game.time;
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
    intel.owner = (c.owner && c.owner.username) || null;
    intel.reservation = (c.reservation && c.reservation.username) || null;
    intel.rcl = c.level || 0;
    intel.safeMode = c.safeMode || 0;
  }
}

// ---- Room name <-> coordinate helpers (ES5) ----
function parseRoomName(name) {
  // e.g. "W39S47"
  var m = /([WE])(\d+)([NS])(\d+)/.exec(name);
  if (!m) return null;
  var hx = m[1], vx = m[3];
  var x = parseInt(m[2], 10);
  var y = parseInt(m[4], 10);
  // east is +, west is -, south is +, north is -
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

  // Start at EAST edge (c.x + r, c.y), then walk clockwise around the rectangle perimeter
  // Segment 1: East -> South along y increasing
  x = c.x + r; y = c.y - (r - 1);
  for (; y <= c.y + r; y++) out.push(toRoomName(x, y));
  // Segment 2: South -> West along x decreasing
  y = c.y + r - 1; x = c.x + r - 1;
  for (; x >= c.x - r; x--) out.push(toRoomName(x, y));
  // Segment 3: West -> North along y decreasing
  x = c.x - r; y = c.y + r - 1;
  for (; y >= c.y - r; y--) out.push(toRoomName(x, y));
  // Segment 4: North -> East along x increasing
  y = c.y - r; x = c.x - r + 1;
  for (; x <= c.x + r; x++) out.push(toRoomName(x, y));

  // Dedup (corners can double-push if r==1 logic changes)
  var seen = {};
  var dedup = [];
  for (var i = 0; i < out.length; i++) {
    if (!seen[out[i]]) { seen[out[i]] = true; dedup.push(out[i]); }
  }
  return dedup;
}


const TaskScout = {
  isExitBlocked: function (creep, exitDir) {
    // keep your quick probe (cheap), but we also track roomStatus elsewhere
    const exit = creep.pos.findClosestByRange(exitDir);
    if (!exit) return false;
    const xMin = Math.max(exit.x - 1, 0), xMax = Math.min(exit.x + 1, 49);
    const yMin = Math.max(exit.y - 1, 0), yMax = Math.min(exit.y + 1, 49);
    const structures = creep.room.lookForAtArea(LOOK_STRUCTURES, yMin, xMin, yMax, xMax, true);
    for (const structure of structures) {
      if (structure.structure.structureType === STRUCTURE_WALL) return true;
    }
    return false;
  },

  run: function (creep) {
    const M = ensureScoutMem(creep);      // { home, ring, queue, lastRoom? }
    if (!creep.memory.lastRoom) creep.memory.lastRoom = creep.room.name;

    // Room entry: stamp intel + lastVisited
    if (creep.memory.lastRoom !== creep.room.name) {
      // store where we came from, then update
      if (!creep.memory.prevRoom) creep.memory.prevRoom = null;
      creep.memory.prevRoom = creep.memory.lastRoom;
      creep.memory.lastRoom = creep.room.name;
      creep.memory.hasAnnouncedRoomVisit = false;
      M.prevRoom = creep.memory.prevRoom || null;

      // log intel + visit stamp
      stampVisit(creep.room.name);
      logRoomIntel(creep.room);

      // Only clear target if we actually arrived at it.
      // If we're transiting through another room (e.g., via home), keep the target.
      if (creep.memory.targetRoom === creep.room.name) {
        creep.memory.targetRoom = null;
        return; // pause 1 tick on arrival to avoid immediate bounce
      }
      // else: keep the target and continue to the rally block
    } else {
      stampVisit(creep.room.name);
      logRoomIntel(creep.room);
    }

    // If we have a target and we're not there yet, go there
    if (creep.memory.targetRoom && creep.room.name !== creep.memory.targetRoom) {
      const dir = creep.room.findExitTo(creep.memory.targetRoom);
      if (dir < 0) { // no path (novice border / map edge)
      // mark it blocked
      if (!Memory.rooms) Memory.rooms = {};
      if (!Memory.rooms[creep.memory.targetRoom]) Memory.rooms[creep.memory.targetRoom] = {};
      Memory.rooms[creep.memory.targetRoom].blocked = Game.time;

      // unconditionally drop this target and pick another next tick
      creep.memory.targetRoom = null;
      return;

      } else {
        if (TaskScout.isExitBlocked(creep, dir)) {
        // mark it blocked
        if (!Memory.rooms) Memory.rooms = {};
        if (!Memory.rooms[creep.memory.targetRoom]) Memory.rooms[creep.memory.targetRoom] = {};
        Memory.rooms[creep.memory.targetRoom].blocked = Game.time;

        // unconditionally drop this target and pick another next tick
        creep.memory.targetRoom = null;
        return;

        } else {
          if (creep.pos.x === 0 && dir === FIND_EXIT_LEFT)   { creep.move(LEFT);  return; }
          if (creep.pos.x === 49 && dir === FIND_EXIT_RIGHT) { creep.move(RIGHT); return; }
          if (creep.pos.y === 0 && dir === FIND_EXIT_TOP)    { creep.move(TOP);   return; }
          if (creep.pos.y === 49 && dir === FIND_EXIT_BOTTOM){ creep.move(BOTTOM);return; }

          // otherwise, path *through* the border by aiming at the center of the target room
          go(creep, new RoomPosition(25, 25, creep.memory.targetRoom), { range: 20 });
          return;
        }
      }
    }

    // We’re in targetRoom or have none — pick next from ring queue
    if (!M.queue.length) {
      rebuildQueue(M); // fill for current ring
      if (!M.queue.length) {
        M.ring = (M.ring && M.ring < RING_MAX) ? M.ring + 1 : 1; // wrap to 1
        rebuildQueue(M);
        if (!M.queue.length) {
          const fallback = exitsOrdered(creep.room.name).filter(okRoomName);
          M.queue = fallback;
        }
      }
    }

    // Pop next target (avoid immediate backtrack to lastRoom if possible)
    // Pop next target (avoid immediate backtrack to the room we just left)
    while (M.queue.length) {
      const next = M.queue.shift();
      if (!okRoomName(next) || isBlockedRecently(next)) continue;
      if (next === (M.prevRoom || null) && M.queue.length) continue; // skip bounce
      creep.memory.targetRoom = next;
      creep.memory.hasAnnouncedRoomVisit = false;
      break;
    }

    // If we still don’t have a target, idle near center and try again next tick
    if (!creep.memory.targetRoom) {
      go(creep, new RoomPosition(25, 25, creep.room.name), { range: 10 });
      return;
    }

    // If already in the target (edge case), clear and pick the next one
    if (creep.room.name === creep.memory.targetRoom) {
      creep.memory.targetRoom = null;
      return;
    }

    // Move toward center of target room (simple rally)
    go(creep, new RoomPosition(25, 25, creep.memory.targetRoom), { range: 20 });
  }
};

module.exports = TaskScout;