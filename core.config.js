
var LOG_LEVEL = Object.freeze({
  NONE: 0,
  BASIC: 1,
  DEBUG: 2,
});

var CoreConfig = {
  LOG_LEVEL: LOG_LEVEL,
  ALLY_USERNAMES: [
    'walter_bell',
    'sleek',
    'haha233jpg',
    'Court_of_Silver',
    'chris1',
    'MoonArtyre',
    'HerrKai',
    
  ],
  ALLOW_PVP: true,
  ALLOW_INVADERS_IN_FOREIGN_ROOMS: true,
  TREAT_SOURCE_KEEPERS_AS_PVE: true,
};

CoreConfig.settings = Object.freeze({
  logging: Object.freeze({
    /** Default log level applied on boot. */
    defaultLevel: LOG_LEVEL.NONE,
  }),
  combat: Object.freeze({
    /** Allow combat creeps to engage non-ally players. */
    ALLOW_PVP: CoreConfig.ALLOW_PVP,
    /** Engage Invader NPCs even inside foreign player rooms. */
    ALLOW_INVADERS_IN_FOREIGN_ROOMS: CoreConfig.ALLOW_INVADERS_IN_FOREIGN_ROOMS,
    /** Treat Source Keeper NPCs as PvE targets. */
    TREAT_SOURCE_KEEPERS_AS_PVE: CoreConfig.TREAT_SOURCE_KEEPERS_AS_PVE,
    /** Toggle verbose combat logging across BeeCombatSquads + spawning. */
    DEBUG_LOGS: false,
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

module.exports = CoreConfig;
