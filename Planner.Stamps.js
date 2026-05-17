// Beginner-friendly stamp catalog for future dynamic layout planning.
// Phase 2B: definitions + helpers only (no construction behavior here).

var STAMPS = [
  {
    id: 'core_v1',
    name: 'Core Stamp v1',
    bounds: { minX: -6, maxX: 6, minY: -6, maxY: 6 },
    tiles: [
      { type: STRUCTURE_SPAWN, x: 0, y: 0, rcl: 1, p: 10, tag: 'core', rampart: true, allowFallback: false },
      { type: STRUCTURE_EXTENSION, x: 1, y: 0, rcl: 2, p: 20, tag: 'energy', rampart: false, allowFallback: true },
      { type: STRUCTURE_EXTENSION, x: -1, y: 0, rcl: 2, p: 20, tag: 'energy', rampart: false, allowFallback: true },
      { type: STRUCTURE_EXTENSION, x: 0, y: 1, rcl: 2, p: 20, tag: 'energy', rampart: false, allowFallback: true },
      { type: STRUCTURE_EXTENSION, x: 0, y: -1, rcl: 2, p: 20, tag: 'energy', rampart: false, allowFallback: true },
      { type: STRUCTURE_TOWER, x: 2, y: 0, rcl: 3, p: 15, tag: 'defense', rampart: true, allowFallback: false },
      { type: STRUCTURE_STORAGE, x: 0, y: 2, rcl: 4, p: 12, tag: 'logistics', rampart: true, allowFallback: false },
      { type: STRUCTURE_LINK, x: 1, y: 2, rcl: 5, p: 12, tag: 'logistics', rampart: true, allowFallback: false }
    ]
  }
];

function getStampById(id) {
  if (!id) return null;
  for (var i = 0; i < STAMPS.length; i++) {
    if (STAMPS[i].id === id) return STAMPS[i];
  }
  return null;
}

function getDefaultCoreStamp() {
  return getStampById('core_v1') || (STAMPS.length ? STAMPS[0] : null);
}

function getStampTilesForRcl(stamp, rcl) {
  if (!stamp || !stamp.tiles || !stamp.tiles.length) return [];
  var lvl = Number(rcl) || 0;
  var out = [];
  for (var i = 0; i < stamp.tiles.length; i++) {
    var t = stamp.tiles[i];
    if ((t.rcl || 0) <= lvl) out.push(t);
  }
  return out;
}

function getAbsoluteStampTiles(stamp, anchorPos, rcl) {
  if (!stamp || !anchorPos) return [];
  var src = (rcl == null) ? (stamp.tiles || []) : getStampTilesForRcl(stamp, rcl);
  var out = [];
  for (var i = 0; i < src.length; i++) {
    var t = src[i];
    out.push({
      type: t.type,
      x: anchorPos.x + t.x,
      y: anchorPos.y + t.y,
      roomName: anchorPos.roomName,
      rcl: t.rcl,
      p: t.p,
      tag: t.tag,
      rampart: t.rampart,
      allowFallback: t.allowFallback
    });
  }
  return out;
}

module.exports = {
  STAMPS: STAMPS,
  getStampById: getStampById,
  getDefaultCoreStamp: getDefaultCoreStamp,
  getStampTilesForRcl: getStampTilesForRcl,
  getAbsoluteStampTiles: getAbsoluteStampTiles
};
