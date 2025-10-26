"use strict";

var CoreConfig = require('core.config');
var Logger = require('core.logger');

var BeeMaintenance = require('BeeMaintenance');
var BeeHiveMind = require('BeeHiveMind');
var towerLogic = require('tower.logic');
var roleLinkManager = require('role.LinkManager');
var BeeToolbox = require('BeeToolbox');
require('Traveler');
var SquadFlagManager = require('SquadFlagManager');

var LOG_LEVEL = CoreConfig.LOG_LEVEL;

// Maintain backwards compatibility: expose log level helpers on global.
global.LOG_LEVEL = LOG_LEVEL;
Object.defineProperty(global, 'currentLogLevel', {
    configurable: true,
    get: function () {
        return Logger.getLogLevel();
    },
    set: function (value) {
        Logger.setLogLevel(value);
    }
});

var mainLog = Logger.createLogger('Main', LOG_LEVEL.BASIC);

function ensureFirstSpawnMemory() {
    if (Memory.GameTickCounter === undefined) Memory.GameTickCounter = 0;
    Memory.GameTickCounter++;
    if (Memory.GameTickCounter < 10) return;

    Memory.GameTickCounter = 0;
    var spawns = [];
    for (var name in Game.spawns) {
        if (Object.prototype.hasOwnProperty.call(Game.spawns, name)) {
            spawns.push(Game.spawns[name]);
        }
    }
    if (!spawns.length) {
        if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
            mainLog.debug('No owned spawns detected.');
        }
        return;
    }

    var primaryRoom = spawns[0].room.name;
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

    for (var roomName in Game.rooms) {
        if (!Object.prototype.hasOwnProperty.call(Game.rooms, roomName)) continue;
        var room = Game.rooms[roomName];
        if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
        Memory.rooms[roomName].repairTargets = BeeMaintenance.findStructuresNeedingRepair(room);
    }
}

function refreshSourceIntel() {
    if (Game.time % 3 !== 0) return;
    for (var roomName in Game.rooms) {
        if (!Object.prototype.hasOwnProperty.call(Game.rooms, roomName)) continue;
        var room = Game.rooms[roomName];
        BeeToolbox.logSourceContainersInRoom(room);
    }
}

function maybeGeneratePixel() {
    var pixelCfg = CoreConfig.settings.pixels;
    if (!pixelCfg.enabled) return;
    if (Game.cpu.bucket < pixelCfg.bucketThreshold) return;
    if (pixelCfg.tickModulo > 1 && (Game.time % pixelCfg.tickModulo) !== 0) return;

    var result = Game.cpu.generatePixel();
    if (result === OK && Logger.shouldLog(LOG_LEVEL.BASIC)) {
        mainLog.info('Pixel generated successfully.');
    }
}

module.exports.loop = function () {
    refreshSourceIntel();
    BeeMaintenance.cleanUpMemory();
    BeeHiveMind.run();
    towerLogic.run();
    roleLinkManager.run();

    // Visuals removed: legacy visuals module deleted (see PR #XXXX).

    maintainRepairTargets();
    ensureFirstSpawnMemory();
    SquadFlagManager.ensureSquadFlags();

    if (Game.time % CoreConfig.settings.maintenance.roomSweepInterval === 0) {
        BeeMaintenance.cleanStaleRooms();
    }

    maybeGeneratePixel();
};

