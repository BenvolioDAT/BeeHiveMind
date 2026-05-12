'use strict';

var QUEEN_STATE = Object.freeze({
  WITHDRAW: 'WITHDRAW',
  PICKUP: 'PICKUP',
  DELIVER: 'DELIVER',
  IDLE: 'IDLE'
});

var CFG = Object.freeze({
  DEBUG_SAY: false,
  DEBUG_DRAW: true,
  DRAW: {
    TRAVEL: '#8ab6ff',
    WD_COLOR: '#6ec1ff',
    FILL_COLOR: '#6effa1',
    WIDTH: 0.12,
    OPACITY: 0.45,
    FONT: 0.6
  },
  STUCK_TICKS: 6,
  MOVE_PRIORITIES: { withdraw: 60, pickup: 70, deliver: 55, idle: 5 }
});

module.exports = { QUEEN_STATE: QUEEN_STATE, CFG: CFG };
