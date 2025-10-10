'use strict';

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
