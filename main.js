"use strict";

const CoreConfig = require('core.config');
const Logger = require('core.logger');

const BeeMaintenance = require('BeeMaintenance');
const BeeVisuals = require('BeeVisuals');
const BeeHiveMind = require('BeeHiveMind');
const towerLogic = require('tower.logic');
const roleLinkManager = require('role.LinkManager');
const BeeToolbox = require('BeeToolbox');
require('Traveler');
const SquadFlagManager = require('SquadFlagManager');

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
    if (Memory.GameTickCounter === undefined) Memory.GameTickCounter = 0;
    Memory.GameTickCounter++;
    if (Memory.GameTickCounter < 10) return;

    Memory.GameTickCounter = 0;
    const spawns = Object.values(Game.spawns);
    if (!spawns.length) {
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
    if (Memory.GameTickRepairCounter === undefined) Memory.GameTickRepairCounter = 0;
    Memory.GameTickRepairCounter++;
    if (Memory.GameTickRepairCounter < CoreConfig.settings.maintenance.repairScanInterval) return;

    Memory.GameTickRepairCounter = 0;
    if (!Memory.rooms) Memory.rooms = {};

    for (const roomName in Game.rooms) {
        if (!Object.prototype.hasOwnProperty.call(Game.rooms, roomName)) continue;
        const room = Game.rooms[roomName];
        if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
        Memory.rooms[roomName].repairTargets = BeeMaintenance.findStructuresNeedingRepair(room);
    }
}

function refreshSourceIntel() {
    if (Game.time % 3 !== 0) return;
    for (const roomName in Game.rooms) {
        if (!Object.prototype.hasOwnProperty.call(Game.rooms, roomName)) continue;
        const room = Game.rooms[roomName];
        BeeToolbox.logSourceContainersInRoom(room);
    }
}

function maybeGeneratePixel() {
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
    refreshSourceIntel();
    BeeMaintenance.cleanUpMemory();
    BeeHiveMind.run();
    towerLogic.run();
    roleLinkManager.run();

    BeeVisuals.drawVisuals();
    BeeVisuals.drawEnergyBar();
    BeeVisuals.drawWorkerBeeTaskTable();

    maintainRepairTargets();
    ensureFirstSpawnMemory();
    SquadFlagManager.ensureSquadFlags();

    if (Game.time % CoreConfig.settings.maintenance.roomSweepInterval === 0) {
        BeeMaintenance.cleanStaleRooms();
    }

    maybeGeneratePixel();
};

