'use strict';

// Safe tuning knobs for Builder behavior and visuals.
module.exports = Object.freeze({
  DEBUG_SAY: false,
  DEBUG_DRAW: true,
  HOME_RICH_ENERGY: 5000,
  HOME_LOW_ENERGY: 1000,
  ALLOW_HARVEST_FALLBACK: true,
  PICKUP_MIN: 50,
  SRC_CONTAINER_MIN: 100,

  BUILDER_STATES: Object.freeze({
    HARVEST: 'HARVEST',
    TRAVEL: 'TRAVEL',
    BUILD: 'BUILD',
    IDLE: 'IDLE'
  }),

  DRAW: Object.freeze({
    TRAVEL: "#8ab6ff",
    SOURCE: "#ffd16e",
    DROP_COLOR: "#ffe66e",
    GRAVE_COLOR: "#ffb0e0",
    FILL_COLOR: "#6effa1",
    IDLE_COLOR: "#bfbfbf",
    BUILD_COLOR: "#2ad1c9",
    SINK_COLOR: "#6ee7ff",
    WIDTH: 0.12,
    OPACITY: 0.45,
    FONT: 0.6
  })
});
