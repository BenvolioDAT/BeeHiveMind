'use strict';

var DEFAULT_DRAW = Object.freeze({
  WIDTH: 0.12,
  OPACITY: 0.45,
  FONT: 0.6
});

function getTargetPosition(target) {
  if (!target) return null;
  if (target.pos) return target.pos;
  if (target.x != null && target.y != null && target.roomName) return target;
  return null;
}

function debugSay(enabled, creep, message) {
  if (enabled && creep && message) creep.say(message, true);
}

function drawLine(enabled, creep, target, color, label, drawOptions) {
  if (!enabled || !creep || !target) return;
  var room = creep.room;
  if (!room || !room.visual) return;
  var targetPosition = getTargetPosition(target);
  if (!targetPosition || targetPosition.roomName !== room.name) return;

  var options = drawOptions || DEFAULT_DRAW;
  room.visual.line(creep.pos, targetPosition, {
    color: color,
    width: options.WIDTH,
    opacity: options.OPACITY,
    lineStyle: 'solid'
  });

  if (label) {
    room.visual.text(label, targetPosition.x, targetPosition.y - 0.3, {
      color: color,
      opacity: options.OPACITY,
      font: options.FONT,
      align: 'center'
    });
  }
}

function drawRing(enabled, room, position, color, text, drawOptions) {
  if (!enabled || !room || !room.visual || !position) return;
  var options = drawOptions || DEFAULT_DRAW;
  room.visual.circle(position, {
    radius: 0.5,
    fill: 'transparent',
    stroke: color,
    opacity: options.OPACITY,
    width: options.WIDTH
  });

  if (text) {
    room.visual.text(text, position.x, position.y - 0.6, {
      color: color,
      font: options.FONT,
      opacity: options.OPACITY,
      align: 'center'
    });
  }
}

module.exports = {
  DEFAULT_DRAW: DEFAULT_DRAW,
  getTargetPosition: getTargetPosition,
  debugSay: debugSay,
  drawLine: drawLine,
  drawRing: drawRing
};
