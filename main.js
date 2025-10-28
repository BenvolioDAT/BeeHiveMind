var CoreConfig = require('core.config');
var Logger = require('core.logger');

var BeeMaintenance = require('BeeMaintenance');
var BeeHiveMind = require('BeeHiveMind');
var towerLogic = require('tower.logic');
var roleLinkManager = require('role.LinkManager');
require('Traveler');
var TaskSquad = require('Task.Squad');

var LOG_LEVEL = CoreConfig.LOG_LEVEL;
var TOOLBOX_LOG_LEVEL = Logger.LOG_LEVEL;
var MainSettings = (CoreConfig && CoreConfig.settings && CoreConfig.settings.Main) || {};
var SOURCE_CONTAINER_SCAN_INTERVAL = (typeof MainSettings.SOURCE_CONTAINER_SCAN_INTERVAL === 'number')
  ? MainSettings.SOURCE_CONTAINER_SCAN_INTERVAL
  : 50;

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
var toolboxLog = Logger.createLogger('Toolbox', TOOLBOX_LOG_LEVEL ? TOOLBOX_LOG_LEVEL.BASIC : LOG_LEVEL.BASIC);

function logSourceContainersInRoom(room) {
    if (!room) return;
    if (!Memory.rooms) Memory.rooms = {};
    if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};
    if (!Memory.rooms[room.name].sourceContainers) Memory.rooms[room.name].sourceContainers = {};

    var roomMem = Memory.rooms[room.name];
    if (!roomMem._toolbox) roomMem._toolbox = {};
    if (!roomMem._toolbox.sourceContainerScan) roomMem._toolbox.sourceContainerScan = {};

    var scanState = roomMem._toolbox.sourceContainerScan;
    var now = Game.time | 0;
    var nextScan = scanState.nextScan | 0;

    if (nextScan && now < nextScan) {
        return;
    }

    var containers = room.find(FIND_STRUCTURES, {
        filter: function (s) {
            if (s.structureType !== STRUCTURE_CONTAINER) return false;
            var near = s.pos.findInRange(FIND_SOURCES, 1);
            return near && near.length > 0;
        }
    });

    var found = {};
    for (var i = 0; i < containers.length; i++) {
        var c = containers[i];
        found[c.id] = true;
        if (!Object.prototype.hasOwnProperty.call(roomMem.sourceContainers, c.id)) {
            roomMem.sourceContainers[c.id] = null;
            if (Logger.shouldLog((TOOLBOX_LOG_LEVEL || LOG_LEVEL).BASIC)) {
                toolboxLog.info('Registered container', c.id, 'near source in', room.name);
            }
        }
    }

    for (var cid in roomMem.sourceContainers) {
        if (!Object.prototype.hasOwnProperty.call(roomMem.sourceContainers, cid)) continue;
        if (!found[cid]) {
            delete roomMem.sourceContainers[cid];
        }
    }

    scanState.lastScanTick = now;
    scanState.nextScan = now + SOURCE_CONTAINER_SCAN_INTERVAL;
    scanState.lastKnownCount = containers.length;
}

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
        logSourceContainersInRoom(room);
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
    maintainRepairTargets();
    ensureFirstSpawnMemory();
    TaskSquad.ensureSquadFlags();

    if (Game.time % CoreConfig.settings.maintenance.roomSweepInterval === 0) {
        BeeMaintenance.cleanStaleRooms();
    }

    maybeGeneratePixel();
};

