'use strict';

var CoreConfig = require('core.config');

var colors = {
  cyan: '#4deeea',
  gray: '#555555',
  light: '#aaaaaa',
  dark: '#181818',
  energy: '#FFE87B',
  green: '#74ee15',
  yellow: '#ffe700',
  red: '#fe0000'
};

var textOptions = { align: 'left', color: colors.cyan, font: 0.45, opacity: 0.95 };

function shortId(id) {
  if (!id || typeof id !== 'string') return '????';
  return id.slice(-4);
}

function drawText(v, label, x, y, opts) {
  var merged = {};
  var key;
  for (key in textOptions) merged[key] = textOptions[key];
  if (opts) for (key in opts) merged[key] = opts[key];
  v.text(String(label), x, y, merged);
}

function drawPanelFrame(v, x, y, width, height) {
  v.rect(x, y - 1, width, height, {
    fill: colors.dark,
    opacity: 0.72,
    stroke: colors.gray,
    strokeWidth: 0.05
  });
  v.line(x, y + 0.75, x + width, y + 0.75, {
    lineStyle: 'dashed',
    opacity: 0.5,
    color: colors.gray,
    width: 0.04
  });
}

function drawSourceMarkers(room, econ) {
  var ids = econ.activeSourceIds || [];
  for (var i = 0; i < ids.length; i++) {
    var rec = econ.sources && econ.sources[ids[i]];
    if (!rec) continue;
    var source = Game.getObjectById(rec.sourceId);
    if (!source || !source.pos || source.pos.roomName !== room.name) continue;

    var markerColor = rec.needsPickup ? colors.yellow : colors.energy;
    room.visual.circle(source.pos, {
      radius: 0.45,
      fill: 'transparent',
      stroke: markerColor,
      opacity: 0.75,
      strokeWidth: 0.08
    });
    drawText(room.visual, shortId(rec.sourceId), source.pos.x + 0.55, source.pos.y - 0.35, {
      color: markerColor,
      font: 0.35
    });

    if (rec.containerId) {
      var container = Game.getObjectById(rec.containerId);
      if (container && container.pos && container.pos.roomName === room.name) {
        room.visual.rect(container.pos.x - 0.42, container.pos.y - 0.42, 0.84, 0.84, {
          fill: 'transparent',
          stroke: rec.pendingEnergy >= 50 ? colors.green : colors.gray,
          opacity: 0.65,
          strokeWidth: 0.07
        });
      }
    }
  }
}

function drawRows(v, econ, x, y, maxRows) {
  var ids = (econ.activeSourceIds || []).slice();
  ids.sort(function (a, b) {
    var ar = econ.sources && econ.sources[a] ? econ.sources[a] : {};
    var br = econ.sources && econ.sources[b] ? econ.sources[b] : {};
    return (br.expectedPickupEnergy || br.pendingEnergy || 0) - (ar.expectedPickupEnergy || ar.pendingEnergy || 0);
  });

  drawText(v, 'src    pend  exp   dist  miners', x, y, { color: colors.light, font: 0.38 });
  for (var i = 0; i < ids.length && i < maxRows; i++) {
    var rec = econ.sources && econ.sources[ids[i]];
    if (!rec) continue;
    var rowY = y + 0.55 + i * 0.52;
    var pending = Math.floor(rec.pendingEnergy || 0);
    var expected = Math.floor(rec.expectedPickupEnergy || pending);
    var distance = Math.floor(rec.distance || 0);
    var miners = rec.minerCount || 0;
    var color = rec.danger ? colors.red : (pending >= 50 ? colors.green : colors.cyan);
    drawText(v, shortId(rec.sourceId) + '   ' + pending + '   ' + expected + '   ' + distance + '     ' + miners, x, rowY, {
      color: color,
      font: 0.38
    });
  }
  if (ids.length > maxRows) {
    drawText(v, '+' + (ids.length - maxRows) + ' more', x, y + 0.55 + maxRows * 0.52, {
      color: colors.light,
      font: 0.36
    });
  }
}

function draw(roomName) {
  if (!Memory.rooms || !Memory.rooms[roomName]) return;
  var econ = Memory.rooms[roomName].sourceEconomy;
  var room = Game.rooms[roomName];
  if (!econ || !room || !room.visual) return;

  var ids = econ.activeSourceIds || [];
  var maxRows = 6;
  var shownRows = Math.min(ids.length, maxRows);
  var x = 2.5;
  var y = 3;
  var width = 18.2;
  var height = 5.0 + shownRows * 0.52 + (ids.length > maxRows ? 0.45 : 0);
  var v = room.visual;

  drawPanelFrame(v, x, y, width, height);
  drawText(v, roomName, x + 6.6, y, { align: 'center', font: 0.58, color: colors.cyan });

  drawText(v, 'active sources: ' + (econ.sourceCount || ids.length), x + 0.45, y + 1.55);
  drawText(v, 'hauler capacity: ' + (econ.truckerCarry || 0) + '/' + Math.ceil(econ.truckerCarryTotal || 0), x + 7.1, y + 1.55);

  drawText(v, 'income: ' + Number(econ.income || 0).toFixed(2), x + 0.45, y + 2.1);
  drawText(v, 'maxIncome: ' + Number(econ.maxIncome || 0).toFixed(2), x + 7.1, y + 2.1);
  drawText(v, 'pending: ' + Math.floor(econ.pendingEnergy || 0), x + 0.45, y + 2.65, { color: colors.energy });
  drawText(v, 'carried: ' + Math.floor(econ.truckerStoredEnergy || 0), x + 7.1, y + 2.65, { color: colors.energy });

  drawRows(v, econ, x + 0.45, y + 3.25, maxRows);
  drawSourceMarkers(room, econ);
}

module.exports = {
  draw: draw,
  enabled: function () {
    return !CoreConfig || !CoreConfig.settings || !CoreConfig.settings.visuals || CoreConfig.settings.visuals.SHOW_SOURCE_ECONOMY_PANEL !== false;
  }
};
