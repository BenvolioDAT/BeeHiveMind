// Intel.Room.js — lightweight room intel helpers for scouting & planning (ES5 compliant)

/**
 * Small helper to normalise room arguments (Room|string|Structure|Creep) into a room name.
 */
function roomNameOf(target) {
  if (!target) return null;
  if (typeof target === 'string') return target;
  if (target.name) return target.name;
  if (target.room && target.room.name) return target.room.name;
  if (target.pos && target.pos.roomName) return target.pos.roomName;
  return null;
}

/**
 * Collects visible intel for the given room and persists it under Memory.rooms[room.name].
 * Keeps the payload tiny so we can call it frequently without extra CPU cost.
 */
function collectRoomIntel(room) {
  if (!room || !room.name || typeof Memory === 'undefined') return null;

  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};

  var mem = Memory.rooms[room.name];

  var sources = room.find ? room.find(FIND_SOURCES) : [];
  var hostiles = room.find ? room.find(FIND_HOSTILE_CREEPS) : [];
  var structures = room.find ? room.find(FIND_STRUCTURES) : [];

  var hasKeeper = false;
  var hasRoad = false;
  var i;
  for (i = 0; i < structures.length; i++) {
    var s = structures[i];
    if (!s || !s.structureType) continue;
    if (s.structureType === STRUCTURE_KEEPER_LAIR) hasKeeper = true;
    if (s.structureType === STRUCTURE_ROAD) hasRoad = true;
    if (hasKeeper && hasRoad) break;
  }

  for (i = 0; i < hostiles.length; i++) {
    var hostile = hostiles[i];
    if (hostile && hostile.owner && hostile.owner.username === 'Source Keeper') {
      hasKeeper = true;
      break;
    }
  }

  var controller = room.controller || null;

  // Timestamp to know when intel was captured
  mem.ts = (typeof Game !== 'undefined' && typeof Game.time === 'number') ? Game.time : 0;

  // Minimal source intel: expose just the ids we can currently see
  var sourceIds = [];
  for (i = 0; i < sources.length; i++) {
    if (sources[i] && sources[i].id) sourceIds.push(sources[i].id);
  }
  mem.sources = sourceIds;

  // Ownership and reservation snapshot (only what we can currently see)
  mem.owner = (controller && controller.owner && controller.owner.username) ? controller.owner.username : null;
  mem.reserved = (controller && controller.reservation && controller.reservation.username) ? {
    username: controller.reservation.username,
    ticksToEnd: controller.reservation.ticksToEnd || 0
  } : null;

  // Controller level: 0 when no controller / unclaimed
  mem.controllerLevel = (controller && controller.level) ? controller.level : 0;

  // Quick hostile presence check for threat assessments
  mem.hostiles = hostiles.length;

  // Source keeper detection for remote mining risk
  mem.hasKeeper = !!hasKeeper;

  // Road presence hints at infrastructure already in place
  mem.roads = !!hasRoad;

  // Derive a tiny string hint for planner logic (safe/hostile/etc.)
  var safeHint = 'unknown';
  if (mem.hostiles > 0) safeHint = 'hostiles';
  else if (mem.hasKeeper) safeHint = 'keeper';
  else if (!controller) safeHint = 'neutral';
  else if (controller.my) safeHint = 'owned';
  else if (isRoomNeutral(room)) safeHint = 'neutral';
  else safeHint = 'occupied';
  mem.safeHint = safeHint;

  return mem;
}

/**
 * Returns true if the room has no owner and is not reserved by other players.
 */
function isRoomNeutral(room) {
  if (!room) return true;
  var controller = room.controller || null;
  if (!controller) return true;
  if (controller.owner) return false;
  if (controller.reservation) return false;
  return true;
}

/**
 * Computes the inter-room hop distance using Screeps routing (Game.map.findRoute).
 * Returns Infinity when routing fails (e.g. for private/unknown rooms).
 */
function getHopDistance(fromRoom, toRoom) {
  if (typeof Game === 'undefined' || !Game.map || !Game.map.findRoute) return Infinity;
  var fromName = roomNameOf(fromRoom);
  var toName = roomNameOf(toRoom);
  if (!fromName || !toName) return Infinity;
  try {
    var route = Game.map.findRoute(fromName, toName);
    if (!route || route === ERR_NO_PATH) return Infinity;
    return route.length || 0;
  } catch (err) {
    return Infinity;
  }
}

module.exports = {
  collectRoomIntel: collectRoomIntel,
  isRoomNeutral: isRoomNeutral,
  getHopDistance: getHopDistance
};
