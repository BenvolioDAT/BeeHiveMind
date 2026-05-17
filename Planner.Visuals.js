// Stamp preview visuals (Phase 2B): draw only, never place sites.

function shortLabel(type) {
  if (type === STRUCTURE_SPAWN) return 'S';
  if (type === STRUCTURE_EXTENSION) return 'E';
  if (type === STRUCTURE_TOWER) return 'T';
  if (type === STRUCTURE_STORAGE) return 'ST';
  if (type === STRUCTURE_LINK) return 'L';
  if (type === STRUCTURE_ROAD) return 'R';
  if (type === STRUCTURE_RAMPART) return 'RA';
  return '?';
}

function typeColor(type) {
  if (type === STRUCTURE_SPAWN) return '#f4d03f';
  if (type === STRUCTURE_EXTENSION) return '#58d68d';
  if (type === STRUCTURE_TOWER) return '#5dade2';
  if (type === STRUCTURE_STORAGE) return '#af7ac5';
  if (type === STRUCTURE_LINK) return '#48c9b0';
  if (type === STRUCTURE_ROAD) return '#95a5a6';
  if (type === STRUCTURE_RAMPART) return '#27ae60';
  return '#ecf0f1';
}

function drawStampTile(room, tile, opts) {
  if (!room || !tile || typeof RoomVisual === 'undefined') return;
  if (tile.x < 0 || tile.x > 49 || tile.y < 0 || tile.y > 49) return;

  var o = opts || {};
  var v = o.visual || new RoomVisual(room.name);
  var color = typeColor(tile.type);
  var opacity = (o.dimmed === true) ? 0.18 : 0.35;
  var textOpacity = (o.dimmed === true) ? 0.45 : 0.95;

  v.circle(tile.x, tile.y, {
    radius: 0.38,
    fill: color,
    opacity: opacity,
    stroke: '#111111',
    strokeWidth: 0.05
  });

  v.text(shortLabel(tile.type), tile.x, tile.y + 0.12, {
    color: '#111111',
    font: '0.45 monospace',
    opacity: textOpacity,
    align: 'center'
  });
}

function drawStampBounds(room, stamp, anchorPos, opts) {
  if (!room || !stamp || !stamp.bounds || !anchorPos || typeof RoomVisual === 'undefined') return;
  var o = opts || {};
  var v = o.visual || new RoomVisual(room.name);

  var left = anchorPos.x + stamp.bounds.minX;
  var right = anchorPos.x + stamp.bounds.maxX;
  var top = anchorPos.y + stamp.bounds.minY;
  var bottom = anchorPos.y + stamp.bounds.maxY;

  v.rect(left - 0.5, top - 0.5, (right - left) + 1, (bottom - top) + 1, {
    fill: 'transparent',
    stroke: '#f8f9f9',
    strokeWidth: 0.07,
    opacity: 0.25
  });
}

function drawStampPreview(room, stamp, anchorPos, opts) {
  if (!room || !stamp || !anchorPos || typeof RoomVisual === 'undefined') return;
  if (!stamp.tiles || !stamp.tiles.length) return;

  var o = opts || {};
  var v = new RoomVisual(room.name);
  var rcl = Number(o.rcl != null ? o.rcl : (room.controller && room.controller.level) || 0);
  var showFuture = (o.showFutureRcl !== false);
  var maxTiles = Number(o.maxTiles || 120);

  drawStampBounds(room, stamp, anchorPos, { visual: v });

  // Anchor marker.
  v.circle(anchorPos.x, anchorPos.y, {
    radius: 0.45,
    fill: 'transparent',
    stroke: '#f5b041',
    strokeWidth: 0.12,
    opacity: 0.9
  });
  v.text('A', anchorPos.x, anchorPos.y - 0.55, {
    color: '#f5b041',
    font: '0.5 monospace',
    opacity: 0.9,
    align: 'center'
  });

  var drawn = 0;
  for (var i = 0; i < stamp.tiles.length; i++) {
    if (drawn >= maxTiles) break;
    var t = stamp.tiles[i];
    var abs = {
      type: t.type,
      x: anchorPos.x + t.x,
      y: anchorPos.y + t.y
    };
    if (abs.x < 1 || abs.x > 48 || abs.y < 1 || abs.y > 48) continue;

    var future = (t.rcl || 0) > rcl;
    if (future && !showFuture) continue;
    drawStampTile(room, abs, { visual: v, dimmed: future });
    drawn++;
  }

  v.text((stamp.name || stamp.id || 'stamp') + ' rcl<=' + rcl, anchorPos.x, anchorPos.y + 0.8, {
    color: '#f8f9f9',
    font: '0.5 monospace',
    opacity: 0.7,
    align: 'center'
  });
}

module.exports = {
  drawStampPreview: drawStampPreview,
  drawStampTile: drawStampTile,
  drawStampBounds: drawStampBounds
};
