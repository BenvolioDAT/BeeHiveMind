'use strict';

var BeeRoleVisuals = require('BeeRoleVisuals');

function describeError(error) {
  return error && (error.stack || error.message || String(error));
}

function debugSay(enabled, creep, message) {
  BeeRoleVisuals.debugSay(enabled, creep, message);
}

function getTargetPosition(target) {
  return BeeRoleVisuals.getTargetPosition(target);
}

function debugDrawLine(options) {
  var cfg = options.cfg;
  var creep = options.creep;
  var target = options.target;
  var color = options.color;
  var label = options.label;
  if (!cfg || !cfg.DEBUG_DRAW || !creep || !target) return;

  var room = creep.room;
  if (!room || !room.visual) return;

  var targetPosition = getTargetPosition(target);
  if (!targetPosition || targetPosition.roomName !== room.name) return;

  room.visual.line(creep.pos, targetPosition, {
    color: color,
    width: cfg.DRAW.WIDTH,
    opacity: cfg.DRAW.OPACITY,
    lineStyle: 'solid'
  });

  if (!label) return;
  room.visual.text(label, targetPosition.x, targetPosition.y - 0.3, {
    color: color,
    opacity: cfg.DRAW.OPACITY,
    font: cfg.DRAW.FONT,
    align: 'center'
  });
}

function debugRing(options) {
  var cfg = options.cfg;
  var room = options.room;
  var pos = options.pos;
  var color = options.color;
  var text = options.text;
  if (!cfg || !cfg.DEBUG_DRAW || !room || !room.visual || !pos) return;

  room.visual.circle(pos, {
    radius: 0.5,
    fill: 'transparent',
    stroke: color,
    opacity: cfg.DRAW.OPACITY,
    width: cfg.DRAW.WIDTH
  });

  if (!text) return;
  room.visual.text(text, pos.x, pos.y - 0.6, {
    color: color,
    font: cfg.DRAW.FONT,
    opacity: cfg.DRAW.OPACITY,
    align: 'center'
  });
}

module.exports = {
  describeError: describeError,
  debugSay: debugSay,
  getTargetPosition: getTargetPosition,
  debugDrawLine: debugDrawLine,
  debugRing: debugRing
};
