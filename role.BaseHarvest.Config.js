'use strict';

// Safe tuning knobs for BaseHarvest behavior and role-specific debug visuals.
module.exports = Object.freeze({
  DEBUG_SAY: false,
  DEBUG_DRAW: true,

  DRAW: Object.freeze({
    TRAVEL: "#8ab6ff",
    SOURCE: "#ffd16e",
    SEAT: "#6effa1",
    QUEUE: "#ffe66e",
    YIELD: "#ff6e6e",
    OFFLOAD: "#6ee7ff",
    IDLE: "#bfbfbf",
    WIDTH: 0.12,
    OPACITY: 0.45,
    FONT: 0.6
  }),

  MAX_HARVESTERS_PER_SOURCE: 1,
  AVOID_TICKS_AFTER_YIELD: 20,
  HANDOFF_TTL: 120,
  QUEUE_RANGE: 2,
  TRAVEL_REUSE: 12
});
