var CoreConfig = require('core.config');

function getVisualCfg() {
  return (CoreConfig && CoreConfig.settings && CoreConfig.settings.visuals) || {};
}

function makeReservations() {
  return { tiles: Object.create(null), count: 0, byReason: Object.create(null) };
}

function keyFor(x, y) {
  return x + ':' + y;
}

function inBounds(x, y) {
  return x >= 1 && x <= 48 && y >= 1 && y <= 48;
}

function isWalkableTile(room, x, y, terrain) {
  if (!inBounds(x, y)) return false;
  if (terrain.get(x, y) === TERRAIN_MASK_WALL) return false;
  var structures = room.lookForAt(LOOK_STRUCTURES, x, y);
  for (var i = 0; i < structures.length; i++) {
    var st = structures[i].structureType;
    if (st !== STRUCTURE_ROAD && st !== STRUCTURE_CONTAINER && st !== STRUCTURE_RAMPART) return false;
  }
  return true;
}

function rememberReserved(reservations, x, y, reason) {
  if (!reservations || !reservations.tiles || !inBounds(x, y)) return false;
  var k = keyFor(x, y);
  if (reservations.tiles[k]) return false;
  reservations.tiles[k] = reason || 'reserved';
  reservations.count += 1;
  var r = reservations.tiles[k];
  reservations.byReason[r] = (reservations.byReason[r] || 0) + 1;
  return true;
}

function isReserved(reservations, x, y) {
  if (!reservations || !reservations.tiles) return false;
  return !!reservations.tiles[keyFor(x, y)];
}

function getReservedReason(reservations, x, y) {
  if (!reservations || !reservations.tiles) return null;
  return reservations.tiles[keyFor(x, y)] || null;
}

function reserveRing(room, reservations, center, range, reason, walkableOnly, terrain) {
  if (!center) return;
  for (var dx = -range; dx <= range; dx++) {
    for (var dy = -range; dy <= range; dy++) {
      if (dx === 0 && dy === 0) continue;
      var x = center.x + dx;
      var y = center.y + dy;
      if (!inBounds(x, y)) continue;
      if (walkableOnly && !isWalkableTile(room, x, y, terrain)) continue;
      rememberReserved(reservations, x, y, reason);
    }
  }
}

function getPathSteps(pathRecord) {
  if (Array.isArray(pathRecord)) return pathRecord;
  if (pathRecord && Array.isArray(pathRecord.path)) return pathRecord.path;
  return null;
}

function buildReservations(room, opts) {
  var reservations = makeReservations();
  if (!room) return reservations;

  var cfg = opts || getVisualCfg();
  var terrain = room.getTerrain();

  var structures = room.find(FIND_STRUCTURES);
  for (var i = 0; i < structures.length; i++) {
    if (structures[i].structureType === STRUCTURE_ROAD) {
      rememberReserved(reservations, structures[i].pos.x, structures[i].pos.y, 'road');
    }
  }

  var sites = room.find(FIND_CONSTRUCTION_SITES);
  for (var j = 0; j < sites.length; j++) {
    if (sites[j].structureType === STRUCTURE_ROAD) {
      rememberReserved(reservations, sites[j].pos.x, sites[j].pos.y, 'road-site');
    }
  }

  var roomMem = (Memory.rooms && Memory.rooms[room.name]) || {};
  var plannerMem = roomMem.roadPlanner;
  var paths = plannerMem && plannerMem.paths;
  if (paths && typeof paths === 'object') {
    var pathKeys = Object.keys(paths);
    for (var pk = 0; pk < pathKeys.length; pk++) {
      var steps = getPathSteps(paths[pathKeys[pk]]);
      if (!steps) continue;
      for (var si = 0; si < steps.length; si++) {
        var step = steps[si];
        if (!step || step.x == null || step.y == null) continue;
        if (step.roomName && step.roomName !== room.name) continue;
        rememberReserved(reservations, step.x, step.y, 'road-planner');
      }
    }
  }

  var spawns = room.find(FIND_MY_SPAWNS);
  for (var s = 0; s < spawns.length; s++) {
    reserveRing(room, reservations, spawns[s].pos, 1, 'spawn-ring', true, terrain);
  }

  var sources = room.find(FIND_SOURCES);
  for (var src = 0; src < sources.length; src++) {
    reserveRing(room, reservations, sources[src].pos, 1, 'source-work', true, terrain);
  }

  var ctrlRange = Math.max(1, Number(cfg.plannerReservationControllerRange || 2));
  if (room.controller) reserveRing(room, reservations, room.controller.pos, ctrlRange, 'controller-work', true, terrain);

  if (room.storage) reserveRing(room, reservations, room.storage.pos, 1, 'logistics-access', true, terrain);
  if (room.terminal) reserveRing(room, reservations, room.terminal.pos, 1, 'logistics-access', true, terrain);

  var combat = roomMem.combat || {};
  var stagingAnchor = combat.stagingAnchor;
  if (stagingAnchor && stagingAnchor.x != null && stagingAnchor.y != null && (!stagingAnchor.roomName || stagingAnchor.roomName === room.name)) {
    rememberReserved(reservations, stagingAnchor.x, stagingAnchor.y, 'combat-staging');
  }
  if (Array.isArray(combat.stagingSlots)) {
    for (var st = 0; st < combat.stagingSlots.length; st++) {
      var slot = combat.stagingSlots[st];
      if (!slot || slot.x == null || slot.y == null) continue;
      if (slot.roomName && slot.roomName !== room.name) continue;
      rememberReserved(reservations, slot.x, slot.y, 'combat-staging');
    }
  } else if (combat.stagingSlots && Array.isArray(combat.stagingSlots.slots)) {
    for (var cs = 0; cs < combat.stagingSlots.slots.length; cs++) {
      var mslot = combat.stagingSlots.slots[cs];
      if (!mslot || mslot.x == null || mslot.y == null) continue;
      if (mslot.roomName && mslot.roomName !== room.name) continue;
      rememberReserved(reservations, mslot.x, mslot.y, 'combat-staging');
    }
  }

  return reservations;
}

function summarizeReservations(reservations) {
  if (!reservations) return { count: 0, byReason: {} };
  return { count: reservations.count || 0, byReason: reservations.byReason || {} };
}

function drawReservations(room, reservations, opts) {
  if (!room || !reservations || !reservations.tiles) return;
  if (typeof RoomVisual === 'undefined') return;
  var cfg = opts || getVisualCfg();
  var maxTiles = Math.max(0, Number(cfg.plannerReservationMaxVisualTiles || 120));
  var keys = Object.keys(reservations.tiles);
  var limit = Math.min(keys.length, maxTiles);
  var vis = new RoomVisual(room.name);
  for (var i = 0; i < limit; i++) {
    var parts = keys[i].split(':');
    var x = Number(parts[0]);
    var y = Number(parts[1]);
    if (!inBounds(x, y)) continue;
    vis.circle(x, y, { radius: 0.12, fill: '#e67e22', opacity: 0.35, stroke: 'transparent' });
  }
}

module.exports = {
  buildReservations: buildReservations,
  isReserved: isReserved,
  getReservedReason: getReservedReason,
  rememberReserved: rememberReserved,
  summarizeReservations: summarizeReservations,
  drawReservations: drawReservations
};
