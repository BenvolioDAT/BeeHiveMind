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
    /**
     * When false, BeeSpawnManager will not spawn combat units through the old
     * squad/flag system. This does not delete BeeCombatSquads.js and is
     * temporary while local autonomous defense is being built.
     */
    ENABLE_SQUAD_SPAWNING: false,
    IDLE_STAGING_ENABLED: true,
    DEBUG_STAGING_VISUALS: false,
    STAGING_MIN_RANGE_FROM_SPAWN: 5,
    STAGING_MAX_RANGE_FROM_SPAWN: 9,
    STAGING_SLOT_RADIUS: 3,
    STAGING_REPLAN_TICKS: 1500,
    STAGING_FAILED_REPLAN_TICKS: 250,
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
  cpuProfiler: Object.freeze({
    enabled: false,
    reportEvery: 100,
    minSectionCpuToReport: 0.05,
    includeRoleBreakdown: true
  }),
  movement: Object.freeze({
    DEBUG_NO_ROUTE: false,
    NO_ROUTE_LOG_INTERVAL: 250,
    NO_ROUTE_CACHE_TTL: 150,
  }),
  visuals: Object.freeze({
    enabled: true,
    lowCpuMode: true,
    maxCpuUsedBeforeVisuals: 14,
    minBucketForFullVisuals: 5000,
    minBucketForAnyVisuals: 1000,
    persistentHud: true,
    spawnPanelModulo: 1,
    workerTableModulo: 1,
    energyBarModulo: 1,
    cpuStatsModulo: 1,
    remoteHaulTableEnabled: true,
    remoteHaulTableModulo: 1,
    maxRemoteHaulTableRows: 8,
    remoteHaulTableShowStale: false,
    remoteHaulTableStaleTicks: 150,
    remoteHaulMapEnabled: false,
    remoteHaulRoomOverlayEnabled: false,
    remoteHaulVisualModulo: 10,
    remoteHaulMapModulo: 25,
    plannedRoadDebugModulo: 10,
    plannerStampPreviewEnabled: false,
    plannerStampPreviewRoom: null,
    plannerStampPreviewShowFutureRcl: true,
    plannerStampPreviewStampId: 'core_v1',
    plannerStampCandidatePreviewEnabled: false,
    plannerStampCandidateDebugRoom: null,
    plannerStampCandidateScanStep: 2,
    plannerStampCandidateMaxChecks: 250,
    plannerStampCandidateReplanTicks: 1500,
    plannerStampCandidateFailedReplanTicks: 250,
    plannerStampCandidateShowScores: false,
    plannerStampCandidateMaxVisuals: 25,
    plannerStampBuildEnabled: false,
    plannerStampBuildRoom: null,
    plannerStampBuildRclMax: 3,
    plannerStampBuildMaxSitesPerTick: 2,
    plannerStampBuildSkipLegacyBaseLayout: false,
    maxRemoteHaulRequestsDrawn: 10,
    maxWorkerRowsDrawn: 15,
    maxPlannedRoadTilesDrawn: 75,
    remoteContainerBuildOverlayEnabled: true,
    remoteContainerBuildOverlayShowBuilt: false,
    remoteContainerBuildVisualModulo: 1,
    remoteContainerBuildTableEnabled: true,
    remoteContainerBuildTableShowBuilt: false,
    remoteContainerBuildTableModulo: 1,
    maxRemoteContainerBuildTableRows: 8,
    remoteContainerBuildTableStaleTicks: 150,
    remoteContainerBuildStaleTicks: 150,
    maxRemoteContainerBuildsDrawn: 12,
    remoteMiningMapEnabled: true,
    remoteMiningMapModulo: 1,
    remoteMiningMapShowHeartbeat: true,
    remoteMiningMapShowHomeBeacon: true,
    remoteMiningMapShowRemoteRoomBeacon: true,
    remoteMiningMapHomeBeaconRadius: 20,
    remoteMiningMapRemoteBeaconRadius: 14,
    remoteMiningMapTestRoom: null,
    remoteMiningMapDebugStats: true,
    remoteMiningMapShowSourceLabels: true,
    maxRemoteMiningMapSourcesDrawn: 80,
    maxRemoteMiningMapCreepsDrawn: 40,
    remoteMiningMapShowCreeps: true,
    remoteMiningMapShowSources: true,
    remoteMiningMapShowContainers: true,
  }),
});

module.exports = CoreConfig;
