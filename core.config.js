// Central configuration flags for the bot. Adjust these to tune global behavior.
const LOG_LEVEL = Object.freeze({
  NONE: 0,
  BASIC: 1,
  DEBUG: 2,
});

// Top-level toggles and shared lists referenced by multiple systems.
const CoreConfig = {
  LOG_LEVEL,
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

// Secondary settings split by system to make intent clear for new players.
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
    /** Stage-1 instrumentation: state/reason logging for combat squads + roles. */
    DEBUG_COMBAT_STATE: false,
    /** Stage-1 instrumentation: creep.say reason tokens for combat creeps. */
    DEBUG_COMBAT_SAY: false,
    /** Manual war-target usernames. Names are case-insensitive. */
    MANUAL_TARGETS: [],
    /** How long (ticks) to keep an observed nearby player on watch list. */
    WATCH_TTL: 1500,
    /** Maximum route distance from owned rooms for watch relevance. */
    WATCH_ROUTE_DISTANCE: 2,
    /** How long (ticks) retaliation status lasts without renewed aggression. */
    RETALIATION_TTL: 2000,
    /** How long (ticks) incident history entries are retained. */
    INCIDENT_TTL: 3000,
    /** Border distance (route rooms) treated as defensive-interest territory. */
    BORDER_ROUTE_DISTANCE: 1,
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
