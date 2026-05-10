// Central configuration flags for the bot. Adjust these to tune global behavior.
const LOG_LEVEL = Object.freeze({
  NONE: 0,
  BASIC: 1,
  DEBUG: 2,
});

// Top-level toggles and shared lists referenced by multiple systems.
const CoreConfig = {
  LOG_LEVEL,
  DEBUG_MOVEMENT_BOUNCE: false,
  DEBUG_TRAVELER_BOUNCE: false,
  DEBUG_MOVEMENT_BOUNCE_HISTORY: false,
  DEBUG_EXIT_STABILIZE: false,
  DEBUG_EXIT_STABILIZE_ROLES: [],
  DEBUG_EXIT_STABILIZE_INTERVAL: 1,
  DEBUG_EXIT_STABILIZE_BORDERS_ONLY: true,
  DEBUG_MOVE_OWNERSHIP: false,
  DEBUG_MOVE_OWNERSHIP_INTERVAL: 1,
  DEBUG_MOVE_OWNERSHIP_ROLES: [],
  MOVEMENT_BOUNCE_HISTORY_ENABLED: true,
  MOVEMENT_BOUNCE_HISTORY_WINDOW: 6,
  MOVEMENT_BOUNCE_RECOVERY_TICKS: 5,
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
    DEBUG_COMBAT_SAY: true,
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
    /** Planner decision logs for squad sizing + body tier caps. */
    DEBUG_PLANNER: false,
    /** Emit planner logs every N ticks per squad key when unchanged. */
    DEBUG_PLANNER_EVERY: 15,
    /**
     * Stage 1+2 combat planner tuning:
     * - economy bands are intentionally simple and easy to tune.
     * - maturity bands blend RCL + room energy capacity.
     */
    planner: Object.freeze({
      economy: Object.freeze({
        CRITICAL_STORAGE: 20000,
        STRAINED_STORAGE: 80000,
        HEALTHY_STORAGE: 180000,
        CRITICAL_TERMINAL: 10000,
        STRAINED_TERMINAL: 40000,
        HEALTHY_TERMINAL: 100000,
        EARLY_CAPACITY: 550,
        MID_CAPACITY: 1300,
        LATE_CAPACITY: 2300
      }),
      threatTiers: Object.freeze({
        LOW_MAX: 7,
        MEDIUM_MAX: 15,
        HIGH_MAX: 24
      })
    }),
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
  movement: Object.freeze({
    /** Traveler/Movement border-bounce diagnostics. */
    DEBUG_MOVEMENT_BOUNCE: CoreConfig.DEBUG_MOVEMENT_BOUNCE,
    /** Traveler border-bounce diagnostics (same toggle alias). */
    DEBUG_TRAVELER_BOUNCE: CoreConfig.DEBUG_TRAVELER_BOUNCE,
    /** Per-creep minimum tick interval between bounce debug log lines. */
    BOUNCE_DEBUG_LOG_INTERVAL: 5,
    /** Toggle repeated room-border bounce detection and recovery. */
    MOVEMENT_BOUNCE_HISTORY_ENABLED: CoreConfig.MOVEMENT_BOUNCE_HISTORY_ENABLED,
    /** Window (ticks) used to detect repeated room alternation. */
    MOVEMENT_BOUNCE_HISTORY_WINDOW: CoreConfig.MOVEMENT_BOUNCE_HISTORY_WINDOW,
    /** Duration (ticks) of temporary recovery mode once bounce is detected. */
    MOVEMENT_BOUNCE_RECOVERY_TICKS: CoreConfig.MOVEMENT_BOUNCE_RECOVERY_TICKS,
    /** Toggle repeated-bounce recovery debug logs. */
    DEBUG_MOVEMENT_BOUNCE_HISTORY: CoreConfig.DEBUG_MOVEMENT_BOUNCE_HISTORY,
    /** Per-creep minimum tick interval between repeated-bounce logs. */
    MOVEMENT_BOUNCE_LOG_INTERVAL: 5,
    /** Exit stabilization debug logging. */
    DEBUG_EXIT_STABILIZE: CoreConfig.DEBUG_EXIT_STABILIZE,
    /** If non-empty, only listed roles emit exit stabilization logs. */
    DEBUG_EXIT_STABILIZE_ROLES: CoreConfig.DEBUG_EXIT_STABILIZE_ROLES,
    /** Minimum ticks between exit stabilization logs per creep. */
    DEBUG_EXIT_STABILIZE_INTERVAL: CoreConfig.DEBUG_EXIT_STABILIZE_INTERVAL,
    /** Restrict exit stabilization logs to border positions. */
    DEBUG_EXIT_STABILIZE_BORDERS_ONLY: CoreConfig.DEBUG_EXIT_STABILIZE_BORDERS_ONLY,
    /** Shared movement ownership debug logs. */
    DEBUG_MOVE_OWNERSHIP: CoreConfig.DEBUG_MOVE_OWNERSHIP,
    /** Per-creep minimum ticks between ownership logs. */
    DEBUG_MOVE_OWNERSHIP_INTERVAL: CoreConfig.DEBUG_MOVE_OWNERSHIP_INTERVAL,
    /** Optional role filter for ownership logs. */
    DEBUG_MOVE_OWNERSHIP_ROLES: CoreConfig.DEBUG_MOVE_OWNERSHIP_ROLES,
  }),
});

module.exports = CoreConfig;
