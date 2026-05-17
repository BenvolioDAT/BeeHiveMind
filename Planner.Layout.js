var CoreConfig = require('core.config');
var PlannerStamps = require('Planner.Stamps');

var LAYOUT_VERSION = 1;
var INVALID_SCORE = -1000;
var DEFAULTS = Object.freeze({
  scanStep: 2,
  maxChecks: 250,
  replanTicks: 1500,
  maxVisuals: 25,
  showScores: false,
  scoreCandidateVisuals: false,
  minExitRange: 3,
  pathMaxOps: 1200,
  failedReplanTicks: 250
});

function plannerMemory(room) {
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};
  if (!Memory.rooms[room.name].planner) Memory.rooms[room.name].planner = {};
  return Memory.rooms[room.name].planner;
}

function getLayoutMemory(room) {
  var mem = plannerMemory(room);
  if (!mem.layout) mem.layout = null;
  return mem.layout;
}

function clearLayoutPlan(room) {
  var mem = plannerMemory(room);
  mem.layout = null;
  delete mem.layoutFailedAt;
  delete mem.nextLayoutPlanTick;
  delete mem.layoutFailureReason;
}

function getConfig(opts) {
  var visualCfg = (CoreConfig && CoreConfig.settings && CoreConfig.settings.visuals) || {};
  var o = opts || {};
  return {
    scanStep: Number(o.scanStep || visualCfg.plannerStampCandidateScanStep || DEFAULTS.scanStep),
    maxChecks: Number(o.maxChecks || visualCfg.plannerStampCandidateMaxChecks || DEFAULTS.maxChecks),
    replanTicks: Number(o.replanTicks || visualCfg.plannerStampCandidateReplanTicks || DEFAULTS.replanTicks),
    maxVisuals: Number(o.maxVisuals || visualCfg.plannerStampCandidateMaxVisuals || DEFAULTS.maxVisuals),
    showScores: o.showScores === true || visualCfg.plannerStampCandidateShowScores === true,
    minExitRange: Number(o.minExitRange || DEFAULTS.minExitRange),
    pathMaxOps: Number(o.pathMaxOps || DEFAULTS.pathMaxOps),
    failedReplanTicks: Number(o.failedReplanTicks || visualCfg.plannerStampCandidateFailedReplanTicks || DEFAULTS.failedReplanTicks)
  };
}

function getCandidateAnchors(room, stamp, opts) {
  if (!room || !stamp || !stamp.bounds) return [];
  var cfg = getConfig(opts);
  var step = Math.max(1, cfg.scanStep | 0);
  var maxChecks = Math.max(1, cfg.maxChecks | 0);
  var b = stamp.bounds;
  var minX = Math.max(1 - b.minX, 4);
  var maxX = Math.min(48 - b.maxX, 45);
  var minY = Math.max(1 - b.minY, 4);
  var maxY = Math.min(48 - b.maxY, 45);
  var all = [];
  for (var y = minY; y <= maxY; y += step) {
    for (var x = minX; x <= maxX; x += step) {
      all.push(new RoomPosition(x, y, room.name));
    }
  }

  if (all.length <= maxChecks) return all;

  // Evenly sample from the full stepped grid to avoid top-left bias when
  // maxChecks truncates the candidate set.
  var out = [];
  var stride = all.length / maxChecks;
  for (var i = 0; i < maxChecks; i++) {
    var idx = Math.floor(i * stride);
    if (idx >= all.length) idx = all.length - 1;
    out.push(all[idx]);
  }
  return out;
}

function isExitClose(x, y, minRange) {
  return x <= minRange || x >= (49 - minRange) || y <= minRange || y >= (49 - minRange);
}

function stampFitsAt(room, stamp, anchorPos, opts) {
  if (!room || !stamp || !anchorPos) return false;
  var cfg = getConfig(opts);
  var terrain = room.getTerrain();
  var tiles = stamp.tiles || [];
  var controller = room.controller;
  var sources = room.find(FIND_SOURCES);
  var minerals = room.find(FIND_MINERALS);

  for (var i = 0; i < tiles.length; i++) {
    var t = tiles[i];
    var x = anchorPos.x + t.x;
    var y = anchorPos.y + t.y;

    if (x < 1 || x > 48 || y < 1 || y > 48) return false;
    if (isExitClose(x, y, cfg.minExitRange)) return false;
    if (terrain.get(x, y) === TERRAIN_MASK_WALL) return false;

    if (controller && controller.pos.x === x && controller.pos.y === y) return false;
    for (var s = 0; s < sources.length; s++) if (sources[s].pos.x === x && sources[s].pos.y === y) return false;
    for (var m = 0; m < minerals.length; m++) if (minerals[m].pos.x === x && minerals[m].pos.y === y) return false;

    var look = room.lookAt(x, y);
    for (var j = 0; j < look.length; j++) {
      var it = look[j];
      if (it.type === 'structure') {
        var st = it.structure;
        if (st.structureType === STRUCTURE_ROAD && t.type !== STRUCTURE_ROAD && t.type !== STRUCTURE_RAMPART) return false;
        if (st.structureType === STRUCTURE_RAMPART) continue;
        if (st.structureType === t.type) {
          if (t.type === STRUCTURE_SPAWN && st.my) continue;
          continue;
        }
        return false;
      }
      if (it.type === 'constructionSite') {
        var cst = it.constructionSite;
        if (cst.structureType === STRUCTURE_ROAD && t.type !== STRUCTURE_ROAD && t.type !== STRUCTURE_RAMPART) return false;
        if (cst.structureType !== t.type) return false;
      }
    }
  }
  return true;
}

function pathLen(room, fromPos, toPos, maxOps) {
  if (!fromPos || !toPos || typeof PathFinder === 'undefined') return 25;
  var ret = PathFinder.search(fromPos, { pos: toPos, range: 1 }, {
    maxRooms: 1,
    maxOps: maxOps
  });
  var len = (ret.path && ret.path.length) || 25;
  if (ret.incomplete) len += 20;
  return len;
}

function scoreAnchorCandidate(room, stamp, anchorPos, opts) {
  var cfg = getConfig(opts);
  var fits = stampFitsAt(room, stamp, anchorPos, cfg);
  if (!fits) return INVALID_SCORE;

  var score = 200;
  var terrain = room.getTerrain();
  var tiles = stamp.tiles || [];
  var used = Object.create(null);
  for (var i = 0; i < tiles.length; i++) {
    var tx = anchorPos.x + tiles[i].x;
    var ty = anchorPos.y + tiles[i].y;
    used[tx + ':' + ty] = true;
    if (terrain.get(tx, ty) === TERRAIN_MASK_SWAMP) score -= 2;
  }

  var b = stamp.bounds;
  for (var y = anchorPos.y + b.minY - 1; y <= anchorPos.y + b.maxY + 1; y++) {
    for (var x = anchorPos.x + b.minX - 1; x <= anchorPos.x + b.maxX + 1; x++) {
      if (x < 1 || x > 48 || y < 1 || y > 48) continue;
      if (used[x + ':' + y]) continue;
      if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
      score += 1;
    }
  }

  if (room.controller) score -= 1.5 * pathLen(room, anchorPos, room.controller.pos, cfg.pathMaxOps);
  var srcs = room.find(FIND_SOURCES);
  for (var s = 0; s < srcs.length; s++) score -= pathLen(room, anchorPos, srcs[s].pos, cfg.pathMaxOps);
  var mins = room.find(FIND_MINERALS);
  if (mins.length) score -= 0.5 * pathLen(room, anchorPos, mins[0].pos, cfg.pathMaxOps);

  var spawns = room.find(FIND_MY_SPAWNS);
  if (spawns.length) {
    var r = anchorPos.getRangeTo(spawns[0].pos);
    if (r >= 3 && r <= 12) score += 20;
    else if (r > 20) score -= 40;
  }
  if (isExitClose(anchorPos.x, anchorPos.y, cfg.minExitRange + 1)) score -= 80;
  return score;
}

function planBestAnchor(room, stamp, opts) {
  if (!room || !stamp) return null;
  var candidates = getCandidateAnchors(room, stamp, opts);
  var best = null;
  for (var i = 0; i < candidates.length; i++) {
    var p = candidates[i];
    var score = scoreAnchorCandidate(room, stamp, p, opts);
    if (score <= INVALID_SCORE) continue;
    if (!best || score > best.score) best = { pos: p, score: score };
  }
  return best;
}

function getChosenAnchor(room, stamp, opts) {
  if (!room || !stamp) return null;
  var cfg = getConfig(opts);
  var mem = plannerMemory(room);
  var layout = getLayoutMemory(room);
  var force = mem.forceLayoutReplan === true;
  var now = Game.time || 0;

  var shouldReplan = force || !layout || layout.stampId !== stamp.id || layout.version !== LAYOUT_VERSION;
  if (!shouldReplan && layout.anchor) {
    var anchorPos = new RoomPosition(layout.anchor.x, layout.anchor.y, layout.anchor.roomName || room.name);
    if ((now - (layout.plannedAt || 0)) >= cfg.replanTicks) shouldReplan = true;
    else if (!stampFitsAt(room, stamp, anchorPos, opts)) shouldReplan = true;
    else return { pos: anchorPos, score: layout.score || 0 };
  }

  if (!force && !layout && mem.nextLayoutPlanTick && now < mem.nextLayoutPlanTick) {
    return null;
  }

  var best = planBestAnchor(room, stamp, opts);
  if (best && best.pos) {
    mem.layout = {
      stampId: stamp.id,
      anchor: { x: best.pos.x, y: best.pos.y, roomName: best.pos.roomName },
      score: best.score,
      plannedAt: now,
      rcl: (room.controller && room.controller.level) || 0,
      version: LAYOUT_VERSION
    };
    delete mem.nextLayoutPlanTick;
    delete mem.layoutFailureReason;
    delete mem.layoutFailedAt;
  } else {
    mem.layout = null;
    mem.layoutFailedAt = now;
    mem.nextLayoutPlanTick = now + Math.max(1, cfg.failedReplanTicks | 0);
    mem.layoutFailureReason = 'no-valid-candidate';
  }
  mem.forceLayoutReplan = false;
  return best;
}

module.exports = {
  getLayoutMemory: getLayoutMemory,
  getChosenAnchor: getChosenAnchor,
  planBestAnchor: planBestAnchor,
  scoreAnchorCandidate: scoreAnchorCandidate,
  stampFitsAt: stampFitsAt,
  getCandidateAnchors: getCandidateAnchors,
  clearLayoutPlan: clearLayoutPlan
};
