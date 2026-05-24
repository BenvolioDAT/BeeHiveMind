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
  TRAVEL_REUSE: 12,

  // Body upgrade safety switches. Turn these off from Memory or code only when
  // you want the older "spawn whatever is currently affordable" behavior.
  BASEHARVEST_ENABLE_BODY_UPGRADES: true,
  BASEHARVEST_WAIT_FOR_BEST_BODY: true,
  BASEHARVEST_UPGRADE_REPLACEMENTS_ENABLED: false,

  // Queue safety timers. The manager may wait for a better body only while the
  // old miner can safely keep the source covered. When these limits are hit it
  // downgrades, defers, or falls back to emergency behavior instead of freezing.
  BASEHARVEST_MAX_UPGRADE_WAIT_TICKS: 150,
  BASEHARVEST_REPLACEMENT_SAFE_TTL: 120,
  BASEHARVEST_CRITICAL_TTL: 60,
  BASEHARVEST_HANDOFF_RANGE: 1
});
