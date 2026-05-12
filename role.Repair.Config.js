'use strict';

// Safe tuning knobs for Repair behavior and visuals.
module.exports = Object.freeze({
  DEBUG_SAY: false,
  DEBUG_DRAW: true,
  TRAVEL_REUSE: 16,
  LOG_LEVEL: Object.freeze({ NONE: 0, BASIC: 1, DEBUG: 2 }),
  CURRENT_LOG_LEVEL: 0,
  COLORS: Object.freeze({
    PATH: "#7ac7ff",
    REPAIR: "#2ad1c9",
    ENERGY: "#ffd480",
    TEXT: "#e6e6e6"
  }),
  WIDTH: 0.12,
  OPACITY: 0.45,
  FONT: 0.7
});
