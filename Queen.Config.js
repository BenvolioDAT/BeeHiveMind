'use strict';

// Queen.Config.js
// Owns: Queen state names and small role-specific tuning values.
// Does not own: task selection, terminal-job logic, or action execution.
// Called by: role.Queen.js and Queen.* helper modules.

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
    // These names match the state/action names used by Queen.Actions.js.
    WITHDRAW: '#6ec1ff',
    PICKUP: '#ffe66e',
    DELIVER: '#6effa1',
    IDLE: '#bfbfbf',

    // Backward-compatible aliases kept for older helper calls/comments.
    TRAVEL: '#8ab6ff',
    WD_COLOR: '#6ec1ff',
    FILL_COLOR: '#6effa1',

    WIDTH: 0.12,
    OPACITY: 0.45,
    FONT: 0.6
  },
  STUCK_TICKS: 6,
  MOVE_PRIORITIES: {
    withdraw: 60,
    pickup: 70,
    deliver: 55,
    idle: 5
  }
});

module.exports = {
  QUEEN_STATE: QUEEN_STATE,
  CFG: CFG
};
