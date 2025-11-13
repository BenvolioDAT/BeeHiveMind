'use strict';

/**
 * BeeVisuals.SpawnPanel – novice-friendly spawn HUD renderer.
 * The helpers below flatten the data gathering steps so you can read top-to-bottom:
 *  1. Decide if we should draw.
 *  2. Group spawns per room.
 *  3. For each spawn, read queue + spawning info.
 *  4. Paint stacked panels from the bottom-left corner upward.
 */

var BeeVisualsSpawnPanel = {};

// ------------------------------- Settings ---------------------------------
var CFG = {
  modulo: 1,
  maxQueueLines: 6,
  barWidth: 6.0,
  barHeight: 0.55,
  anchorX: 1.2,
  anchorY: 48.6,
  panelGap: 0.6
};

// ------------------------------ Tick helpers -------------------------------

/** Cheap cadence gate so the HUD can be throttled by simply raising CFG.modulo. */
function shouldDrawSpawnPanels() {
  var mod = CFG.modulo | 0;
  return mod <= 1 || (Game.time % mod) === 0;
}

/** Snapshot all spawns by room name so we can draw once per room. */
function groupSpawnsByRoom() {
  var byRoom = {};
  for (var sName in Game.spawns) {
    if (!Object.prototype.hasOwnProperty.call(Game.spawns, sName)) continue;
    var spawn = Game.spawns[sName];
    if (!spawn || !spawn.room) continue;
    var rn = spawn.room.name;
    if (!byRoom[rn]) byRoom[rn] = [];
    byRoom[rn].push(spawn);
  }

  for (var rn in byRoom) {
    if (!Object.prototype.hasOwnProperty.call(byRoom, rn)) continue;
    byRoom[rn].sort(function (a, b) { return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); });
  }
  return byRoom;
}

// ----------------------------- Data helpers --------------------------------

/** Defensive reader around Memory.creeps[name] for the spawn progress label. */
function readRoleFor(name) {
  try {
    var mm = (Memory.creeps && Memory.creeps[name]) || null;
    if (!mm) return '?';
    return mm.task || mm.role || '?';
  } catch (e) {
    return '?';
  }
}

/** Spawn queue comparator: higher priority first, then older entries. */
function queueComparator(a, b) {
  var pd = (b.priority | 0) - (a.priority | 0);
  if (pd !== 0) return pd;
  return (a.created | 0) - (b.created | 0);
}

/** Pull the queue for a room, clone it, and return it sorted. */
function readSpawnQueue(roomName) {
  var roomMem = (Memory.rooms && Memory.rooms[roomName]) ? Memory.rooms[roomName] : null;
  var queue = (roomMem && Array.isArray(roomMem.spawnQueue)) ? roomMem.spawnQueue.slice() : [];
  return queue.sort(queueComparator);
}

/** Convert the queue into the subset we can fit plus a height hint. */
function prepareQueueForPanel(queue) {
  var limit = CFG.maxQueueLines;
  var shown = queue.slice(0, limit);
  var lines = Math.min(limit, shown.length);
  return { shown: shown, lines: lines, total: queue.length };
}

/** Each panel grows upward: header + spawning section + queue block. */
function computePanelHeight(queueLineCount) {
  return 2.1 + (queueLineCount * 0.6);
}

/**
 * Normalize spawn progress into a simple descriptor so the draw code stays flat.
 * Returns null if idle, else { text, pct } for the bar + % label.
 */
function describeSpawnProgress(spawn) {
  if (!spawn || !spawn.spawning) return null;
  var s = spawn.spawning;
  var total = (typeof s.needTime === 'number') ? s.needTime : (s.totalTime || 1);
  var remaining = s.remainingTime | 0;
  var pct = 1 - (remaining / Math.max(1, total));
  var hatchName = s.name;
  var hatchRole = readRoleFor(hatchName);
  return {
    text: 'Spawning: ' + hatchRole + ' (' + hatchName + ')',
    pct: pct,
    percentLabel: Math.round(pct * 100) + '%'
  };
}

// ------------------------------ Draw helpers -------------------------------

/** Small teaching helper so every progress bar shares the same styling. */
function drawProgressBar(v, x, y, pct) {
  v.rect(x, y, CFG.barWidth, CFG.barHeight, { fill: '#202020', opacity: 0.35, stroke: '#000000' });
  var clamped = Math.max(0, Math.min(1, pct));
  v.rect(x, y, clamped * CFG.barWidth, CFG.barHeight, { fill: '#66ff66', opacity: 0.6, stroke: '#000000' });
}

/** Draw the queue listing rows under the spawning info block. */
function drawQueueListing(v, baseX, startY, queueInfo) {
  v.text('Queue (' + queueInfo.total + '):', baseX, startY, {
    color: '#ffffff', font: 0.55, align: 'left', opacity: 1, stroke: '#000000'
  });

  for (var j = 0; j < queueInfo.shown.length; j++) {
    var entry = queueInfo.shown[j];
    var tag = (j + 1) + '. ' + (entry.role || '?') + '  p' + (entry.priority | 0);
    v.text(tag, baseX, startY + (j + 1) * 0.6, {
      color: '#dddddd', font: 0.48, align: 'left', opacity: 0.95, stroke: '#000000'
    });
  }
}

/** Paint one spawn panel and return the new bottom Y cursor for stacking. */
function drawSpawnPanel(v, spawn, currentBottomY) {
  var queue = readSpawnQueue(spawn.room.name);
  var queueInfo = prepareQueueForPanel(queue);
  var panelH = computePanelHeight(queueInfo.lines);
  var topY = currentBottomY - panelH;
  if (topY < 0.4) return null; // guard so we do not draw off-screen

  var baseX = CFG.anchorX;

  v.rect(baseX - 0.25, topY - 0.5, CFG.barWidth + 1.2, panelH + 0.7, {
    fill: '#000000', opacity: 0.18, stroke: '#333333'
  });

  var headerY = topY + 0.4;
  v.text('🛠 ' + spawn.name, baseX, headerY, {
    color: '#ffffff', font: 0.7, align: 'left', opacity: 1, stroke: '#000000'
  });

  var eAvail = spawn.room.energyAvailable | 0;
  var eCap   = spawn.room.energyCapacityAvailable | 0;
  v.text('🔋 ' + eAvail + '/' + eCap, baseX + (CFG.barWidth - 1.6), headerY, {
    color: '#ffffff', font: 0.5, align: 'right', opacity: 0.9, stroke: '#000000'
  });

  var y = headerY + 0.6;
  var progress = describeSpawnProgress(spawn);
  if (progress) {
    v.text(progress.text, baseX, y, {
      color: '#ffffff', font: 0.5, align: 'left', opacity: 0.95, stroke: '#000000'
    });
    drawProgressBar(v, baseX, y + 0.2, progress.pct);
    v.text(progress.percentLabel, baseX + CFG.barWidth + 0.2, y + 0.55, {
      color: '#ffffff', font: 0.5, align: 'left', opacity: 0.9, stroke: '#000000'
    });
  } else {
    v.text('Idle', baseX, y, {
      color: '#cfcfcf', font: 0.5, align: 'left', opacity: 0.9, stroke: '#000000'
    });
  }

  drawQueueListing(v, baseX, y + 1.1, queueInfo);
  return topY - CFG.panelGap;
}

// ------------------------------- Entrypoint --------------------------------

BeeVisualsSpawnPanel.drawSpawnPanels = function () {
  if (!shouldDrawSpawnPanels()) return;

  var groups = groupSpawnsByRoom();
  for (var rn in groups) {
    if (!Object.prototype.hasOwnProperty.call(groups, rn)) continue;
    var visual = new RoomVisual(rn);
    var cursor = CFG.anchorY;

    for (var i = 0; i < groups[rn].length; i++) {
      var spawn = groups[rn][i];
      var newCursor = drawSpawnPanel(visual, spawn, cursor);
      if (newCursor === null) break; // stop stacking if we ran out of room
      cursor = newCursor;
    }
  }
};

BeeVisualsSpawnPanel.drawVisuals = function () {
  BeeVisualsSpawnPanel.drawSpawnPanels();
};

module.exports = BeeVisualsSpawnPanel;
