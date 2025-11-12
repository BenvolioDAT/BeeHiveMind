
var LOG_LEVEL = Object.freeze({
  NONE: 0,
  BASIC: 1,
  DEBUG: 2,
});

var ALLY_USERNAMES = Object.freeze([]);

var settings = Object.freeze({
  logging: Object.freeze({
    /** Default log level applied on boot. */
    defaultLevel: LOG_LEVEL.BASIC,
  }),
  combat: Object.freeze({
    /** Allow combat creeps to engage non-ally players. */
    ALLOW_PVP: true,
    /** Engage Invader NPCs even inside foreign player rooms. */
    ALLOW_INVADERS_IN_FOREIGN_ROOMS: true,
    /** Treat Source Keeper NPCs as PvE targets. */
    TREAT_SOURCE_KEEPERS_AS_PVE: true,
  }),
  pixels: Object.freeze({
    /** Toggle CPU bucket based pixel generation. */
    enabled: true,
    /** Minimum bucket value before attempting pixel generation. */
    bucketThreshold: 9950,
    /** Optional modulus so pixels are generated every N ticks. */
    tickModulo: 5,
  }),
  maintenance: Object.freeze({
    /** How often to rescan repair targets inside BeeMaintenance. */
    repairScanInterval: 5,
    /** How long before the stale room sweep runs. */
    roomSweepInterval: 50,
  }),
});

module.exports = {
  LOG_LEVEL: LOG_LEVEL,
  settings: settings,
  ALLY_USERNAMES: ALLY_USERNAMES,
  ALLOW_PVP: settings.combat.ALLOW_PVP,
  ALLOW_INVADERS_IN_FOREIGN_ROOMS: settings.combat.ALLOW_INVADERS_IN_FOREIGN_ROOMS,
  TREAT_SOURCE_KEEPERS_AS_PVE: settings.combat.TREAT_SOURCE_KEEPERS_AS_PVE,
};
