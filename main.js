
// Core utilities and shared config
const CoreConfig = require('core.config');
const Logger = require('core.logger');

// Core game logic modules
const BeeMaintenance = require('BeeMaintenance');
const BeeVisuals = require('BeeVisuals');
const BeeHiveMind = require('BeeHiveMind');
var BeeStructureLogic = require('BeeStructureLogic');
const BeeToolbox = require('BeeToolbox');
const BeeCombatSquads = require('BeeCombatSquads');
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
    // Periodically refresh which structures need repairs in each visible room.
    if (Memory.GameTickRepairCounter === undefined) Memory.GameTickRepairCounter = 0;
    Memory.GameTickRepairCounter++;
    if (Memory.GameTickRepairCounter < CoreConfig.settings.maintenance.repairScanInterval) return;

    Memory.GameTickRepairCounter = 0;
    if (!Memory.rooms) Memory.rooms = {};

    for (const room of Object.values(Game.rooms)) {
        if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};
        Memory.rooms[room.name].repairTargets = BeeMaintenance.findStructuresNeedingRepair(room);
    }
}

function refreshSourceIntel() {
    // Keep an eye on source containers so harvesters stay supplied.
    if (Game.time % 3 !== 0) return;

    for (const room of Object.values(Game.rooms)) {
        BeeToolbox.logSourceContainersInRoom(room);
    }
}

function maybeGeneratePixel() {
    // Optional cosmetic pixel generation when CPU bucket is healthy.
    const pixelCfg = CoreConfig.settings.pixels;
    if (!pixelCfg.enabled) return;
    if (Game.cpu.bucket < pixelCfg.bucketThreshold) return;
    if (pixelCfg.tickModulo > 1 && (Game.time % pixelCfg.tickModulo) !== 0) return;

    const result = Game.cpu.generatePixel();
    if (result === OK) {
        mainLog.info('Pixel generated successfully.');
    }
}

module.exports.loop = function () {
    // --- Intel and housekeeping ---
    refreshSourceIntel();
    BeeMaintenance.cleanUpMemory();
    maintainRepairTargets();
    ensureFirstSpawnMemory();

    // --- Primary AI behaviors ---
    BeeHiveMind.run();
    BeeStructureLogic.runTowerLogic();
    BeeStructureLogic.runLinkManager();
    BeeCombatSquads.ensureSquadFlags();

    // --- Visual aids for quick debugging ---
    BeeVisuals.drawVisuals();
    BeeVisuals.drawEnergyBar();
    BeeVisuals.drawWorkerBeeTaskTable();

    // --- Less frequent maintenance ---
    if (Game.time % CoreConfig.settings.maintenance.roomSweepInterval === 0) {
        BeeMaintenance.cleanStaleRooms();
    }

    maybeGeneratePixel();
};

