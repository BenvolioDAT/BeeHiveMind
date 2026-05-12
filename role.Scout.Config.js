'use strict';

// Safe tuning knobs for Scout behavior and Scout-specific debug visuals.
module.exports = Object.freeze({
  DEBUG_SAY: false,
  DEBUG_DRAW: true,

  REMOTE_DEFENSE_MAX_DISTANCE: 2,
  THREAT_DECAY_TICKS_COPY: 150,
  ROOM_STAY_TICKS: 75,
  REVISIT_TICKS: 750,
  INTEL_INTERVAL: 150,
  PATH_REUSE: 30,

  DRAW: Object.freeze({
    INTEL: "#8ab6ff",
    TEXT: "#bfbfbf",
    FONT: 0.6,
    OPACITY: 0.95
  })
});
