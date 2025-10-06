'use strict';

/**
 * Central configuration + constants for the BeeHiveMind Screeps AI.
 *
 * Keeping these definitions in one module ensures that every subsystem
 * references the same values and allows quick tweaking from a single place.
 *
 * Notes for Screeps:
 *  - Screeps' module cache is persistent between ticks. Exporting frozen
 *    objects protects the constants from accidental mutation during gameplay.
 *  - Avoid storing dynamic state in here; use Memory or global caches instead.
 */

var LOG_LEVEL = Object.freeze({
  NONE: 0,
  BASIC: 1,
  DEBUG: 2
});

var settings = Object.freeze({
  logging: Object.freeze({
    /** Default log level applied on boot. */
    defaultLevel: LOG_LEVEL.NONE
  }),
  pixels: Object.freeze({
    /** Toggle CPU bucket based pixel generation. */
    enabled: true,
    /** Minimum bucket value before attempting pixel generation. */
    bucketThreshold: 9900,
    /** Optional modulus so pixels are generated every N ticks. */
    tickModulo: 5
  }),
  maintenance: Object.freeze({
    /** How often to rescan repair targets inside BeeMaintenance. */
    repairScanInterval: 5,
    /** How long before the stale room sweep runs. */
    roomSweepInterval: 50
  })
});

module.exports = {
  LOG_LEVEL: LOG_LEVEL,
  settings: settings
};
