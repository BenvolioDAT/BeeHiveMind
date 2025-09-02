// --- Bee Comedy Club ---
/*
var BeeToolbox = require('BeeToolbox');

const TaskScout = {
  // Function to check if the exit is blocked by novice walls
  isExitBlocked: function (creep, exitDir) {
    const exit = creep.pos.findClosestByRange(exitDir);
    if (!exit) return false;  
    // Ensure the coordinates are within the valid room range (0 to 49)
    const xMin = Math.max(exit.x - 1, 0);
    const xMax = Math.min(exit.x + 1, 49);
    const yMin = Math.max(exit.y - 1, 0);
    const yMax = Math.min(exit.y + 1, 49);  
    // Look for novice walls or impassable terrain in the valid exit area
    const structures = creep.room.lookForAtArea(LOOK_STRUCTURES, yMin, xMin, yMax, xMax, true);
    for (const structure of structures) {
      if (structure.structure.structureType === STRUCTURE_WALL) {
        // Assume walls in this area are novice zone walls
        return true;
      }
    }
    return false;
  },
  
  run: function (creep) {    
 
    const revisitDelay = 5000; // Delay in ticks before revisiting a room
    const blockCheckDelay = 10000; // Delay for checking a blocked room again

    if (!creep.memory.lastRoom) creep.memory.lastRoom = creep.room.name;
    if (creep.memory.lastRoom !== creep.room.name) {
      creep.memory.lastRoom = creep.room.name;
      creep.memory.hasAnnouncedRoomVisit = false; // keep your existing flag behavior
    }

    BeeToolbox.logSourcesInRoom(creep.room);
    BeeToolbox.logHostileStructures(creep.room);

    if (creep.memory.targetRoom && creep.room.name !== creep.memory.targetRoom) {
      const exitDir = creep.room.findExitTo(creep.memory.targetRoom);  

      // Check if the target exit is blocked by a novice wall
      if (TaskScout.isExitBlocked(creep, exitDir)) {
        if (currentLogLevel >= LOG_LEVEL.DEBUG) {
        console.log(`${creep.name} detected blocked exit to ${creep.memory.targetRoom}.`);
        }  
        // Mark the room as blocked and store it in memory
        if (!Memory.rooms[creep.memory.targetRoom]) {
          Memory.rooms[creep.memory.targetRoom] = {};
        }
        Memory.rooms[creep.memory.targetRoom].blocked = Game.time;  
        // Clear the current target and pick another room
        creep.memory.targetRoom = null;
        return; // Exit here to prevent further actions
      }  

      const exit = creep.pos.findClosestByRange(exitDir);
      if (exit) {
          creep.moveTo(exit, {reusePath: 10, visualizePathStyle: { stroke: '#ffaa00' }});
      }
      return; // Keep moving to the target room
    }

    // Get exits from the current room
    const exits = Game.map.describeExits(creep.room.name);
    // Filter out rooms that are blocked and should not be revisited
    // Filter out rooms that are blocked or revisited, and exclude the current room
    const unvisitedRooms = Object.values(exits).filter(roomName => {
      const roomMemory = Memory.rooms[roomName];
      const isBlocked = roomMemory && roomMemory.blocked && (Game.time - roomMemory.blocked < blockCheckDelay);
      const isCurrentRoom = roomName === creep.room.name;      
      // Skip if the room is blocked or is the current room
      if (isBlocked || isCurrentRoom) {
          if (currentLogLevel >= LOG_LEVEL.DEBUG) {
              console.log(`${creep.name} skipping blocked or current room: ${roomName}`);
          }
          return false;
      }      
      return !roomMemory || (Game.time - roomMemory.lastVisited > revisitDelay);
    });

    if (unvisitedRooms.length > 0) {
      const nextRoom = unvisitedRooms[Math.floor(Math.random() * unvisitedRooms.length)];
      creep.memory.targetRoom = nextRoom;
      // Reset the announcement flag for the new room
      creep.memory.hasAnnouncedRoomVisit = false;
      if (currentLogLevel >= LOG_LEVEL.DEBUG) {
      console.log(`${creep.name} moving to new room: ${nextRoom}`);
      }
    } else {
      // No unvisited or revisitable rooms, pick a random neighboring room
      const randomRoom = Object.values(exits)[Math.floor(Math.random() * Object.values(exits).length)];
      creep.memory.targetRoom = randomRoom;
      creep.memory.hasAnnouncedRoomVisit = false;
    }
  }
};
module.exports = TaskScout;
*/
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
  // BFS out to 'radius' using ordered exits so rings feel clockwise
  const seen = new Set([homeName]);
  let frontier = [homeName];
  for (let depth = 1; depth <= radius; depth++) {
    const next = [];
    const layer = new Set();
    for (const rn of frontier) {
      for (const nbr of exitsOrdered(rn)) {
        if (seen.has(nbr)) continue;
        seen.add(nbr);
        next.push(nbr);
        if (depth === radius) layer.add(nbr);
      }
    }
    if (depth === radius) {
      // layer → array in clockwise-ish order thanks to exitsOrdered expansion
      return [...layer].filter(okRoomName);
    }
    frontier = next;
  }
  return [];
}

function rebuildQueue(mem) {
  var home = mem.home;
  var ring = mem.ring;

  var layer = buildRing(home, ring);
  var candidates = layer.filter(function(rn){ return !isBlockedRecently(rn); });

  // Prefer rooms we haven’t seen recently; if none qualify, keep all so we still move
  var fresh = candidates.filter(function(rn){
    return (Game.time - lastVisited(rn)) >= REVISIT_DELAY;
  });
  if (fresh.length) candidates = fresh;

  var prev = mem.prevRoom; // use the true previous room for bounce-penalty
  var scored = candidates.map(function(rn){
    return { rn: rn, last: lastVisited(rn), pen: (prev && rn === prev) ? 1 : 0 };
  }).sort(function(a,b){
    return (a.last - b.last) || (a.pen - b.pen) || (a.rn < b.rn ? -1 : 1);
  });

  mem.queue = scored.map(function(x){ return x.rn; });
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
    M.prevRoom = creep.memory.prevRoom || null;
    if (!creep.memory.lastRoom) creep.memory.lastRoom = creep.room.name;

    // Room entry: stamp intel + lastVisited
    if (creep.memory.lastRoom !== creep.room.name) {
      // store where we came from, then update
      if (!creep.memory.prevRoom) creep.memory.prevRoom = null;
      creep.memory.prevRoom = creep.memory.lastRoom;
      creep.memory.lastRoom = creep.room.name;
      creep.memory.hasAnnouncedRoomVisit = false;

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
        if (!Memory.rooms) Memory.rooms = {};
        if (!Memory.rooms[creep.memory.targetRoom]) Memory.rooms[creep.memory.targetRoom] = {};
        Memory.rooms[creep.memory.targetRoom].blocked = Game.time;
        creep.memory.targetRoom = null;
      } else {
        if (TaskScout.isExitBlocked(creep, dir)) {
          if (!Memory.rooms) Memory.rooms = {};
          if (!Memory.rooms[creep.memory.targetRoom]) Memory.rooms[creep.memory.targetRoom] = {};
          Memory.rooms[creep.memory.targetRoom].blocked = Game.time;
          creep.memory.targetRoom = null;
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
      if (next === (creep.memory.prevRoom || null) && M.queue.length) continue; // skip bounce
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

