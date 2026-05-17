var PlannerStamps = require('Planner.Stamps');
var PlannerReservations = require('Planner.Reservations');

var BLOCKED_RESERVATION_REASONS = Object.freeze({
  'source-work': true,
  'controller-work': true,
  'road': true,
  'road-site': true,
  'road-planner': true,
  'logistics-access': true,
  'combat-staging': true
});

function plannerMemory(room) {
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};
  if (!Memory.rooms[room.name].planner) Memory.rooms[room.name].planner = {};
  return Memory.rooms[room.name].planner;
}

function getRampartMemory(room) {
  var mem = plannerMemory(room);
  if (!mem.rampartPreview) mem.rampartPreview = {};
  return mem.rampartPreview;
}

function keyFor(x, y) { return x + ':' + y; }
function inBounds(x, y) { return x >= 1 && x <= 48 && y >= 1 && y <= 48; }

function getStampFootprint(stamp, anchor, rcl) {
  if (!stamp || !anchor) return [];
  return PlannerStamps.getAbsoluteStampTiles(stamp, anchor, rcl);
}

function getPerimeterTiles(room, footprint, opts) {
  var out = [];
  var seen = Object.create(null);
  var inside = Object.create(null);
  var range = Math.max(1, Number((opts && opts.range) || 1));

  for (var i = 0; i < footprint.length; i++) {
    inside[keyFor(footprint[i].x, footprint[i].y)] = true;
  }

  for (var fi = 0; fi < footprint.length; fi++) {
    var src = footprint[fi];
    for (var dx = -range; dx <= range; dx++) {
      for (var dy = -range; dy <= range; dy++) {
        if (dx === 0 && dy === 0) continue;
        var x = src.x + dx;
        var y = src.y + dy;
        var k = keyFor(x, y);
        if (!inBounds(x, y) || inside[k] || seen[k]) continue;
        seen[k] = true;
        out.push({ x: x, y: y, roomName: room.name });
      }
    }
  }

  return out;
}

function isRampartPreviewTileAllowed(room, x, y, reservations, opts) {
  if (!inBounds(x, y)) return { ok: false, reason: 'exit' };
  if (x <= 1 || x >= 48 || y <= 1 || y >= 48) return { ok: false, reason: 'exit' };

  var terrain = room.getTerrain();
  if (terrain.get(x, y) === TERRAIN_MASK_WALL) return { ok: false, reason: 'wall' };

  if (opts && opts.useReservations) {
    var reason = PlannerReservations.getReservedReason(reservations, x, y);
    if (reason && BLOCKED_RESERVATION_REASONS[reason]) return { ok: false, reason: 'reserved' };
  }

  return { ok: true };
}

function summarizeRampartPreview(plan) {
  return {
    tileCount: (plan && plan.tiles && plan.tiles.length) || 0,
    skippedReserved: (plan && plan.skippedReserved) || 0,
    skippedWall: (plan && plan.skippedWall) || 0,
    skippedExit: (plan && plan.skippedExit) || 0
  };
}

function drawRampartPreview(room, plan, opts) {
  if (!room || !plan || !Array.isArray(plan.tiles) || typeof RoomVisual === 'undefined') return;
  var o = opts || {};
  var showLabels = o.showLabels === true;
  var v = new RoomVisual(room.name);

  for (var i = 0; i < plan.tiles.length; i++) {
    var t = plan.tiles[i];
    v.circle(t.x, t.y, {
      radius: 0.22,
      fill: '#5dade2',
      opacity: 0.25,
      stroke: '#2e86c1',
      strokeWidth: 0.05
    });
    if (showLabels) {
      v.text('RA', t.x, t.y + 0.1, {
        color: '#d6eaf8',
        font: '0.35 monospace',
        opacity: 0.8,
        align: 'center'
      });
    }
  }
}

function clearRampartPreview(room) {
  if (!room) return;
  var mem = plannerMemory(room);
  delete mem.rampartPreview;
}

function buildRampartPreview(room, stamp, anchor, reservations, opts) {
  var o = opts || {};
  var rcl = Number(o.rcl != null ? o.rcl : 8);
  var maxTiles = Math.max(0, Number(o.maxTiles || 120));
  var footprint = getStampFootprint(stamp, anchor, rcl);
  var perimeter = getPerimeterTiles(room, footprint, o);
  var plan = { tiles: [], skippedReserved: 0, skippedWall: 0, skippedExit: 0 };

  for (var i = 0; i < perimeter.length; i++) {
    if (plan.tiles.length >= maxTiles) break;
    var p = perimeter[i];
    var allowed = isRampartPreviewTileAllowed(room, p.x, p.y, reservations, o);
    if (!allowed.ok) {
      if (allowed.reason === 'reserved') plan.skippedReserved++;
      else if (allowed.reason === 'wall') plan.skippedWall++;
      else if (allowed.reason === 'exit') plan.skippedExit++;
      continue;
    }
    plan.tiles.push(p);
  }

  var summary = summarizeRampartPreview(plan);
  var mem = getRampartMemory(room);
  mem.t = Game.time;
  mem.stampId = stamp && stamp.id;
  mem.anchor = anchor ? { x: anchor.x, y: anchor.y, roomName: anchor.roomName } : null;
  mem.rcl = (room.controller && room.controller.level) || 0;
  mem.tileCount = summary.tileCount;
  mem.skippedReserved = summary.skippedReserved;
  mem.skippedWall = summary.skippedWall;
  mem.skippedExit = summary.skippedExit;
  mem.version = 1;

  return plan;
}

module.exports = {
  getRampartMemory: getRampartMemory,
  buildRampartPreview: buildRampartPreview,
  getStampFootprint: getStampFootprint,
  getPerimeterTiles: getPerimeterTiles,
  isRampartPreviewTileAllowed: isRampartPreviewTileAllowed,
  summarizeRampartPreview: summarizeRampartPreview,
  drawRampartPreview: drawRampartPreview,
  clearRampartPreview: clearRampartPreview
};
