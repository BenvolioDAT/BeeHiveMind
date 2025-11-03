'use strict';

/**
 * BeeVisuals.SpawnPanel (bottom-left anchored)
 * - Draws a HUD in each room starting from the bottom-left corner.
 * - Each spawn gets a stacked panel; the stack grows upward as needed.
 * - Shows: room energy, current spawning with % bar, and the spawn queue (top N).
 */

var BeeVisualsSpawnPanel = (function () {
  // -------- Config --------
  var CFG = {
    modulo: 1,            // draw every tick; set to 2/3 to throttle
    maxQueueLines: 6,     // queue lines per spawn panel
    barWidth: 6.0,        // progress bar width (tiles)
    barHeight: 0.55,      // progress bar height (tiles)

    // Anchor for each room: bottom-left corner
    anchorX: 1.2,         // x from left edge
    anchorY: 48.6,        // y near bottom edge (49 is the bottom tile center)

    // Spacing
    panelGap: 0.6         // gap between stacked spawn panels
  };

  // -------- Helpers --------
  function _drawBar(v, x, y, w, h, pct, fg, bg) {
    v.rect(x, y, w, h, { fill: bg || '#000000', opacity: 0.35, stroke: '#000000' });
    var clamped = Math.max(0, Math.min(1, pct));
    v.rect(x, y, clamped * w, h, { fill: fg || '#00ff7b', opacity: 0.6, stroke: '#000000' });
  }

  function _formatRoleFor(name) {
    try {
      var mm = (Memory.creeps && Memory.creeps[name]) || null;
      if (!mm) return '?';
      return mm.task || mm.role || '?';
    } catch (e) {
      return '?';
    }
  }

  // -------- Main Drawer --------
  function drawSpawnPanels() {
    if (CFG.modulo > 1 && (Game.time % CFG.modulo) !== 0) return;

    // Group spawns by room
    var byRoom = {};
    for (var sName in Game.spawns) {
      if (!Object.prototype.hasOwnProperty.call(Game.spawns, sName)) continue;
      var sp = Game.spawns[sName];
      if (!sp || !sp.room) continue;
      var rn = sp.room.name;
      if (!byRoom[rn]) byRoom[rn] = [];
      byRoom[rn].push(sp);
    }

    for (var rn in byRoom) {
      if (!Object.prototype.hasOwnProperty.call(byRoom, rn)) continue;

      var v = new RoomVisual(rn);
      var spawns = byRoom[rn].sort(function (a, b) { return a.name < b.name ? -1 : (a.name > b.name ? 1 : 0); });

      // Start at bottom-left and stack upward
      var currentBottomY = CFG.anchorY;
      var baseX = CFG.anchorX;

      for (var i = 0; i < spawns.length; i++) {
        var spawn = spawns[i];

        // Pull and sort queue for this room
        var roomMem = (Memory.rooms && Memory.rooms[rn]) ? Memory.rooms[rn] : null;
        var queue = (roomMem && Array.isArray(roomMem.spawnQueue)) ? roomMem.spawnQueue.slice() : [];
        queue.sort(function (a, b) {
          var pd = (b.priority | 0) - (a.priority | 0);
          return (pd !== 0) ? pd : ((a.created | 0) - (b.created | 0)); // stable by age within same priority
        });

        var limit = CFG.maxQueueLines;
        var shown = queue.slice(0, limit);
        var panelH = 2.1 + (Math.min(limit, shown.length) * 0.6); // dynamic height based on queue lines

        // Compute panel top-left from bottom anchor (panel grows up)
        var topY = currentBottomY - panelH;

        // Prevent drawing off-screen (optional soft-guard)
        if (topY < 0.4) break;

        // Panel backdrop first (so text overlays remain crisp)
        v.rect(baseX - 0.25, topY - 0.5, CFG.barWidth + 1.2, panelH + 0.7, {
          fill: '#000000', opacity: 0.18, stroke: '#333333'
        });

        // Header line
        var headerY = topY + 0.4;
        v.text('🛠 ' + spawn.name, baseX, headerY, {
          color: '#ffffff', font: 0.7, align: 'left', opacity: 1, stroke: '#000000'
        });

        // Room energy readout
        var eAvail = spawn.room.energyAvailable | 0;
        var eCap   = spawn.room.energyCapacityAvailable | 0;
        v.text('🔋 ' + eAvail + '/' + eCap, baseX + (CFG.barWidth - 1.6), headerY, {
          color: '#ffffff', font: 0.5, align: 'right', opacity: 0.9, stroke: '#000000'
        });

        // Spawning section
        var y = headerY + 0.6;
        if (spawn.spawning) {
          var s = spawn.spawning;
          var total = (typeof s.needTime === 'number') ? s.needTime : (s.totalTime || 1);
          var remaining = s.remainingTime | 0;
          var pct = 1 - (remaining / Math.max(1, total));
          var hatchName = s.name;
          var hatchRole = _formatRoleFor(hatchName);

          v.text('Spawning: ' + hatchRole + ' (' + hatchName + ')', baseX, y, {
            color: '#ffffff', font: 0.5, align: 'left', opacity: 0.95, stroke: '#000000'
          });
          _drawBar(v, baseX, y + 0.2, CFG.barWidth, CFG.barHeight, pct, '#66ff66', '#202020');
          v.text(Math.round(pct * 100) + '%', baseX + CFG.barWidth + 0.2, y + 0.55, {
            color: '#ffffff', font: 0.5, align: 'left', opacity: 0.9, stroke: '#000000'
          });
        } else {
          v.text('Idle', baseX, y, {
            color: '#cfcfcf', font: 0.5, align: 'left', opacity: 0.9, stroke: '#000000'
          });
        }

        // Queue block (grows the panel upward implicitly because we computed panelH first)
        var qHeaderY = y + 1.1;
        v.text('Queue (' + queue.length + '):', baseX, qHeaderY, {
          color: '#ffffff', font: 0.55, align: 'left', opacity: 1, stroke: '#000000'
        });

        for (var j = 0; j < shown.length; j++) {
          var it = shown[j];
          var tag = (j + 1) + '. ' + (it.role || '?') + '  p' + (it.priority | 0);
          v.text(tag, baseX, qHeaderY + (j + 1) * 0.6, {
            color: '#dddddd', font: 0.48, align: 'left', opacity: 0.95, stroke: '#000000'
          });
        }

        // Move the stacking cursor upward for the next spawn
        currentBottomY = topY - CFG.panelGap;
      }
    }
  }

  function drawVisuals() {
    drawSpawnPanels();
  }

  return {
    drawSpawnPanels: drawSpawnPanels,
    drawVisuals: drawVisuals
  };
})();

module.exports = BeeVisualsSpawnPanel;
