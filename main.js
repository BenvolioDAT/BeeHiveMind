// -----------------------------------------------------------------------------
// main.js - Screeps loop entrypoint
// Owns:
// * The order in which housekeeping, AI orchestration, structures, combat flags,
//   visuals, stale-room cleanup, pixels, and CPU profiling run each tick.
// Memory paths read/written:
// * Memory.firstSpawnRoom and GameTickCounter/GameTickRepairCounter.
// * Memory.rooms[roomName].repairTargets via maintainRepairTargets().
// Usually called by:
// * Screeps runtime as module.exports.loop.
// Systems that depend on it:
// * BeeHiveMind expects Traveler to be required before role movement.
// * Repair/towers depend on repairTargets being refreshed before they run.
// Do not casually change:
// * The top-level ordering without checking whether a downstream module expects
//   cleanup/intel to have already run this tick.
// -----------------------------------------------------------------------------

// Core utilities and shared config
const CoreConfig = require('core.config');
const Logger = require('core.logger');
const MemoryUtils = require('core.memory');

// Core game logic modules
const Maintenance = require('core.maintenance');
const BeeVisuals = require('BeeVisuals');
const BeeHiveMind = require('BeeHiveMind');
var StructureLogic = require('Structure.Logic');
const BeeToolbox = require('BeeToolbox');
const CombatSquads = require('Combat.Squads');
const CpuProfiler = require('core.cpuProfiler');
require('Traveler');

const LOG_LEVEL = CoreConfig.LOG_LEVEL;

// Maintain backwards compatibility: expose log level helpers on global.
global.LOG_LEVEL = LOG_LEVEL;
Object.defineProperty(global, 'currentLogLevel', {
    configurable: true,
    get() {
        return Logger.getLogLevel();
    },
    set(value) {
        Logger.setLogLevel(value);
    }
});

const mainLog = Logger.createLogger('Main', LOG_LEVEL.BASIC);

function ensureFirstSpawnMemory() {
    // Memory.firstSpawnRoom is a legacy anchor used by roles that need a home
    // fallback before per-room ownership is fully initialized.
    // Track the room of our first spawn so other modules can reference it.
    if (Memory.GameTickCounter === undefined) Memory.GameTickCounter = 0;
    Memory.GameTickCounter++;
    if (Memory.GameTickCounter < 10) return;

    Memory.GameTickCounter = 0;
    const spawns = Object.values(Game.spawns);
    if (spawns.length === 0) {
        if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
            mainLog.debug('No owned spawns detected.');
        }
        return;
    }

    const primaryRoom = spawns[0].room.name;
    if (Memory.firstSpawnRoom !== primaryRoom) {
        Memory.firstSpawnRoom = primaryRoom;
        if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
            mainLog.debug('Updated Memory.firstSpawnRoom to', primaryRoom);
        }
    }
}

function maintainRepairTargets() {
    // Repair target ownership starts here: core.maintenance finds candidates and
    // this function stores the queue for towers and Repair creeps to consume.
    // Periodically refresh which structures need repairs in each visible room.
    if (Memory.GameTickRepairCounter === undefined) Memory.GameTickRepairCounter = 0;
    Memory.GameTickRepairCounter++;
    if (Memory.GameTickRepairCounter < CoreConfig.settings.maintenance.repairScanInterval) return;

    Memory.GameTickRepairCounter = 0;

    for (const room of Object.values(Game.rooms)) {
        const roomMem = MemoryUtils.ensureRoom(room.name);
        roomMem.repairTargets = Maintenance.findStructuresNeedingRepair(room);
    }
}

function refreshSourceIntel() {
    // Lightweight source-container refresh used by legacy container assignment
    // helpers. Veinseeker remote container status has its own dedicated Memory path.
    // Keep an eye on source containers so harvesters stay supplied.
    const maintenanceCfg = CoreConfig.settings.maintenance || {};
    const cadence = maintenanceCfg.sourceContainerRefreshModulo || 3;
    if (cadence > 1 && Game.time % cadence !== 0) return;

    for (const room of Object.values(Game.rooms)) {
        BeeToolbox.logSourceContainersInRoom(room);
    }
}

function maybeGeneratePixel() {
    // Optional cosmetic pixel generation when CPU bucket is healthy.
    const pixelCfg = CoreConfig.settings.pixels;
    //---Environment guards ---
    // 1) No Game.cpu or no generatePixel: sim/private/older envs.
    if (!Game.cpu || typeof Game.cpu.generatePixel !== 'function') {
        return;
    }
    // 2) Explicityly skip in SIM shard.
    if (Game.shard && Game.shard.name === 'sim') {
        return;
    }
    //--- Config guards ---
    if (!pixelCfg.enabled) return;
    // Some evironments may not have bucket; guard the check:
    if (typeof Game.cpu.bucket !== 'number') {
        return;
    }
    // Bucket check
    if (Game.cpu.bucket < pixelCfg.bucketThreshold) return;
    if (pixelCfg.tickModulo > 1 && (Game.time % pixelCfg.tickModulo) !== 0) return;
    //--- Pixel Generation ---
    var result = Game.cpu.generatePixel();
    if (result === OK) {
        mainLog.info('Pixel generated successfully.');
    }
}

function measureSafely(sectionName, fn) {
    try {
        CpuProfiler.measure(sectionName, fn);
    } catch (err) {
        mainLog.warn(sectionName + ' error: ' + err);
    }
}

module.exports.loop = function () {
    // Tick order matters: refresh intel/cleanup first, run roles and structures,
    // then draw visuals and do less frequent cleanup/pixel work.
    CpuProfiler.start('main.total');
    // --- Intel and housekeeping ---
    CpuProfiler.measure('refreshSourceIntel', refreshSourceIntel);
    CpuProfiler.measure('core.maintenance.cleanUpMemory', Maintenance.cleanUpMemory);
    CpuProfiler.measure('maintainRepairTargets', maintainRepairTargets);
    CpuProfiler.measure('ensureFirstSpawnMemory', ensureFirstSpawnMemory);

    // --- Primary AI behaviors ---
    CpuProfiler.measure('BeeHiveMind.run', BeeHiveMind.run);
    CpuProfiler.measure('Structure.Logic.runTowerLogic', StructureLogic.runTowerLogic);
    CpuProfiler.measure('Structure.Logic.runLinkManager', StructureLogic.runLinkManager);
    if (CoreConfig.settings.combat.ENABLE_SQUAD_SPAWNING === true) {
        CombatSquads.ensureSquadFlags();
    }

    // --- Visual aids for quick debugging ---
    measureSafely('BeeVisuals.drawVisuals', BeeVisuals.drawVisuals);
    measureSafely('BeeVisuals.drawEnergyBar', BeeVisuals.drawEnergyBar);
    measureSafely('BeeVisuals.drawWorkerBeeTaskTable', BeeVisuals.drawWorkerBeeTaskTable);

    // --- Less frequent maintenance ---
    if (Game.time % CoreConfig.settings.maintenance.roomSweepInterval === 0) {
        CpuProfiler.measure('cleanStaleRooms', Maintenance.cleanStaleRooms);
    }

    CpuProfiler.measure('maybeGeneratePixel', maybeGeneratePixel);
    CpuProfiler.end('main.total');
    CpuProfiler.reportMaybe();
};
