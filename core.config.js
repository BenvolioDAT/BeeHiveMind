
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
    enabled: false,
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

CoreConfig.workerConfig = Object.freeze({
  DEBUG_SAY: false,
  DEBUG_DRAW: true,
  DRAW: Object.freeze({
    TRAVEL:   '#8ab6ff',
    SOURCE:   '#ffd16e',
    SEAT:     '#6effa1',
    QUEUE:    '#ffe66e',
    YIELD:    '#ff6e6e',
    OFFLOAD:  '#6ee7ff',
    IDLE:     '#bfbfbf',
    WD_COLOR:    '#6ec1ff',
    FILL_COLOR:  '#6effa1',
    DROP_COLOR:  '#ffe66e',
    GRAVE_COLOR: '#ffb0e0',
    IDLE_COLOR:  '#bfbfbf',
    WIDTH:   0.12,
    OPACITY: 0.45,
    FONT:    0.6
  }),
  TOWER_REFILL_AT_OR_BELOW: 0.70,
  SIGN_TEXT: 'BeeNice Please.',
  PICKUP_FLAG_DEFAULT: 'E-Pickup',
  MIN_DROPPED: 50,
  SEARCH_RADIUS: 50,
  ALLOW_NON_ENERGY: true,
  PARK_POS: Object.freeze({ x: 25, y: 25, roomName: 'W0N0' }),
  STUCK_TICKS: 6,
  MOVE_PRIORITIES: Object.freeze({ withdraw: 60, pickup: 70, deliver: 55, idle: 5 }),
  PATH_REUSE: 40,
  MAX_OPS_MOVE: 2000,
  TRAVEL_MAX_OPS: 4000,
  RETARGET_COOLDOWN: 10,
  GRAVE_SCAN_COOLDOWN: 20,
  BETTER_CONTAINER_DELTA: 150,
  CONTAINER_MIN: 50,
  DROPPED_BIG_MIN: 150,
  DROPPED_NEAR_CONTAINER_R: 2,
  DROPPED_ALONG_ROUTE_R: 2,
  REMOTE_DEFENSE_MAX_DISTANCE: 2,
  THREAT_DECAY_TICKS: 150,
  MAX_LUNA_PER_SOURCE: 1
});

module.exports = CoreConfig;
