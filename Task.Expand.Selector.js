// Task.Expand.Selector.js — chooses next expansion target using stored intel (ES5 compliant)

var ConfigExpansion = require('Config.Expansion');
var IntelRoom = require('Intel.Room');

// Normalise the resource key for stored energy access.
var ENERGY_RESOURCE = (typeof RESOURCE_ENERGY !== 'undefined') ? RESOURCE_ENERGY : 'energy';

// Cache username locally so we can compare reservations without repeated scans.
var _myUsername = null;

/**
 * Resolve the player's username by inspecting spawns or owned controllers.
 * Needed so we treat our own reservations as neutral but skip enemy claims.
 */
function getMyUsername() {
    if (_myUsername) return _myUsername;
    if (typeof Game === 'undefined') return null;

    var name;
    for (name in Game.spawns) {
        if (!Game.spawns.hasOwnProperty(name)) {
            continue;
        }
        var spawn = Game.spawns[name];
        if (spawn && spawn.owner && spawn.owner.username) {
            _myUsername = spawn.owner.username;
            return _myUsername;
        }
    }

    for (name in Game.rooms) {
        if (!Game.rooms.hasOwnProperty(name)) {
            continue;
        }
        var room = Game.rooms[name];
        if (room && room.controller && room.controller.my && room.controller.owner && room.controller.owner.username) {
            _myUsername = room.controller.owner.username;
            return _myUsername;
        }
    }

    return null;
}

/**
 * Safely fetch (or build) the shared expansion state under Memory.__BHM.
 */
function normalizeProgressTable(state) {
    if (!state.inProgress) {
        state.inProgress = {};
        return state.inProgress;
    }
    if (Array.isArray(state.inProgress)) {
        var converted = {};
        for (var i = 0; i < state.inProgress.length; i++) {
            var entry = state.inProgress[i];
            if (!entry) {
                continue;
            }
            if (typeof entry === 'string') {
                if (!converted[entry]) {
                    converted[entry] = { target: entry, legacy: true };
                }
                continue;
            }
            var roomName = entry.target || entry.roomName || entry.name || null;
            if (!roomName) {
                continue;
            }
            if (!converted[roomName]) {
                converted[roomName] = entry;
            }
        }
        state.inProgress = converted;
        return state.inProgress;
    }
    if (typeof state.inProgress !== 'object') {
        state.inProgress = {};
    }
    return state.inProgress;
}

function mergeLegacyProgress(targetMap, legacy) {
    if (!legacy) {
        return;
    }
    if (Array.isArray(legacy)) {
        for (var i = 0; i < legacy.length; i++) {
            mergeLegacyProgress(targetMap, legacy[i]);
        }
        return;
    }
    if (typeof legacy === 'string') {
        if (!targetMap[legacy]) {
            targetMap[legacy] = { target: legacy, legacy: true };
        }
        return;
    }
    if (typeof legacy !== 'object') {
        return;
    }
    for (var key in legacy) {
        if (!Object.prototype.hasOwnProperty.call(legacy, key)) {
            continue;
        }
        if (!targetMap[key]) {
            targetMap[key] = legacy[key];
        }
    }
}

function getExpansionMemory() {
    if (typeof Memory === 'undefined') return null;
    if (!Memory.__BHM) Memory.__BHM = {};
    if (!Memory.__BHM.expand || typeof Memory.__BHM.expand !== 'object') Memory.__BHM.expand = {};
    var state = Memory.__BHM.expand;
    var table = normalizeProgressTable(state);
    if (Memory.__BHM.expansion) {
        var legacy = Memory.__BHM.expansion;
        if (legacy.inProgress) {
            mergeLegacyProgress(table, legacy.inProgress);
        }
        if (legacy.lastTarget && !state.lastTarget) state.lastTarget = legacy.lastTarget;
        if (legacy.lastUpdated && !state.lastUpdated) state.lastUpdated = legacy.lastUpdated;
        if (legacy.lastDone && !state.lastDone) state.lastDone = legacy.lastDone;
        if (legacy.lastCompleted && !state.lastCompleted) state.lastCompleted = legacy.lastCompleted;
        try {
            delete Memory.__BHM.expansion;
        } catch (legacyErr) {
            Memory.__BHM.expansion = undefined;
        }
    }
    return state;
}

/**
 * Access the manager-owned expansion state where cooldown metadata is stored.
 */
function getManagerState() {
    if (typeof Memory === 'undefined') return null;
    if (!Memory.__BHM) Memory.__BHM = {};
    if (!Memory.__BHM.expand) Memory.__BHM.expand = {};
    return Memory.__BHM.expand;
}

/**
 * Utility to count active expansion efforts recorded in Memory.
 * Accepts either arrays (['W1N1', 'W2N2']) or keyed objects ({W1N1: {...}}).
 */
function getExpansionsInProgressCount() {
    var state = getExpansionMemory();
    if (!state || !state.inProgress) return 0;

    var queue = state.inProgress;
    if (Array.isArray(queue)) {
        return queue.length;
    }

    var count = 0;
    var key;
    for (key in queue) {
        if (!Object.prototype.hasOwnProperty.call(queue, key)) {
            continue;
        }
        var entry = queue[key];
        if (!entry) {
            continue;
        }
        if (entry.completed) {
            continue;
        }
        count++;
    }
    return count;
}

/**
 * Count owned rooms we actively control (controller.my === true).
 */
function getOwnedRoomCount() {
    if (typeof Game === 'undefined') return 0;
    var count = 0;
    var roomName;
    for (roomName in Game.rooms) {
        if (!Game.rooms.hasOwnProperty(roomName)) {
            continue;
        }
        var room = Game.rooms[roomName];
        if (room && room.controller && room.controller.my) {
            count++;
        }
    }
    return count;
}

/**
 * Computes available stored energy in the main room (storage + terminal only).
 */
function getMainRoomStoredEnergy(mainRoom) {
    if (!mainRoom) return 0;

    var total = 0;
    if (mainRoom.storage && mainRoom.storage.store && typeof mainRoom.storage.store[ENERGY_RESOURCE] === 'number') {
        total += mainRoom.storage.store[ENERGY_RESOURCE];
    }
    if (mainRoom.terminal && mainRoom.terminal.store && typeof mainRoom.terminal.store[ENERGY_RESOURCE] === 'number') {
        total += mainRoom.terminal.store[ENERGY_RESOURCE];
    }
    return total;
}

/**
 * Resolve the main room for expansion as dictated by Config.Expansion.
 */
function getMainRoomName() {
    if (!ConfigExpansion || typeof ConfigExpansion.MAIN_ROOM_SELECTOR !== 'function') return null;
    try {
        return ConfigExpansion.MAIN_ROOM_SELECTOR();
    } catch (err) {
        return null;
    }
}

/**
 * Determine how far (in hops) we allow expansions from the main room.
 */
function getMaxExpansionDistance() {
    if (!ConfigExpansion || typeof ConfigExpansion.MAX_EXPANSION_DISTANCE === 'undefined') {
        return 0;
    }
    return ConfigExpansion.MAX_EXPANSION_DISTANCE | 0;
}

/**
 * Checks whether intel stored in Memory.rooms marks the target as neutral.
 * Falls back to live room objects when available so we honour up-to-date vision.
 */
function memoryShowsNeutral(roomName, intel) {
    var roomObj = (typeof Game !== 'undefined' && Game.rooms) ? Game.rooms[roomName] : null;
    if (roomObj) {
        if (IntelRoom && typeof IntelRoom.isRoomNeutral === 'function') {
            return IntelRoom.isRoomNeutral(roomObj);
        }
    }

    if (!intel) return false;
    if (intel.owner) {
        return false;
    }

    if (intel.reserved && intel.reserved.username && intel.reserved.username !== getMyUsername()) {
        return false;
    }

    return true;
}

/**
 * Evaluate candidate intel and compute prioritisation metrics for selectExpansionTarget().
 */
function scoreCandidate(roomName, intel, mainRoomName) {
    var distance = IntelRoom && typeof IntelRoom.getHopDistance === 'function' ? IntelRoom.getHopDistance(mainRoomName, roomName) : Infinity;
    if (distance === Infinity) return null;
    var maxDist = getMaxExpansionDistance();
    if (maxDist > 0 && distance > maxDist) return null;

    var sources = (intel && intel.sources && typeof intel.sources.count === 'number') ? intel.sources.count : 0;
    var hasTwoSources = sources >= 2 ? 1 : 0;
    var timestamp = intel && typeof intel.ts === 'number' ? intel.ts : 0;

    return {
        roomName: roomName,
        distance: distance,
        hasTwoSources: hasTwoSources,
        timestamp: timestamp
    };
}

/**
 * Returns true when all expansion pre-conditions are satisfied.
 */
function canAttemptExpansion() {
    var blockers = explainBlockers();
    return blockers.length === 0;
}

/**
 * Provide human-readable reasons preventing expansion attempts.
 */
function explainBlockers() {
    var issues = [];

    if (ConfigExpansion && ConfigExpansion.ENABLE_EXPANSION === false) {
        issues.push('Expansion disabled');
        return issues;
    }

    if (typeof Game === 'undefined' || !Game.gcl) {
        issues.push('Game API unavailable');
        return issues;
    }

    var cooldownTicks = (ConfigExpansion && typeof ConfigExpansion.EXPANSION_COOLDOWN_TICKS === 'number') ? ConfigExpansion.EXPANSION_COOLDOWN_TICKS : 0;
    if (cooldownTicks > 0 && typeof Game !== 'undefined') {
        var managerState = getManagerState();
        var lastDone = managerState && typeof managerState.lastDone === 'number' ? managerState.lastDone : null;
        if (lastDone !== null && typeof Game.time === 'number') {
            var remaining = (lastDone + cooldownTicks) - Game.time;
            if (remaining > 0) {
                issues.push('Expansion cooldown (' + remaining + ' ticks)');
            }
        }
    }

    var ownedRooms = getOwnedRoomCount();
    var gclLevel = Game.gcl.level || 0;
    if (ownedRooms >= gclLevel) {
        issues.push('Owned rooms at or above GCL limit');
    }

    var expansionsInProgress = getExpansionsInProgressCount();
    var maxExpansions = ConfigExpansion && typeof ConfigExpansion.MAX_EXPANSIONS === 'number' ? ConfigExpansion.MAX_EXPANSIONS : 1;
    if (expansionsInProgress >= maxExpansions) {
        issues.push('Expansion slots exhausted');
    }

    var mainRoomName = getMainRoomName();
    if (!mainRoomName) {
        issues.push('No main room');
    }

    var mainRoom = (mainRoomName && Game.rooms) ? Game.rooms[mainRoomName] : null;
    if (!mainRoom) {
        issues.push('Main room not visible');
    } else {
        var availableEnergy = getMainRoomStoredEnergy(mainRoom);
        var requiredEnergy = ConfigExpansion && typeof ConfigExpansion.ENERGY_BOOTSTRAP_MIN === 'number' ? ConfigExpansion.ENERGY_BOOTSTRAP_MIN : 0;
        if (availableEnergy < requiredEnergy) {
            issues.push('Not enough energy');
        }
    }

    return issues;
}

/**
 * Scan Memory.rooms and select the strongest neutral room candidate for expansion.
 * Prefers fully scouted two-source rooms, then nearest hop distance, then freshest intel.
 */
function selectExpansionTarget() {
    if (!canAttemptExpansion()) return null;
    if (typeof Memory === 'undefined' || !Memory.rooms) return null;

    var mainRoomName = getMainRoomName();
    if (!mainRoomName) return null;

    var best = null;
    var roomName;
    for (roomName in Memory.rooms) {
        if (!Object.prototype.hasOwnProperty.call(Memory.rooms, roomName)) {
            continue;
        }
        var intel = Memory.rooms[roomName];
        if (!memoryShowsNeutral(roomName, intel)) {
            continue;
        }

        var score = scoreCandidate(roomName, intel, mainRoomName);
        if (!score) {
            continue;
        }

        if (!best) {
            best = score;
            continue;
        }

        if (score.hasTwoSources > best.hasTwoSources) {
            best = score;
            continue;
        }

        if (score.hasTwoSources === best.hasTwoSources) {
            if (score.distance < best.distance) {
                best = score;
                continue;
            }
            if (score.distance === best.distance && score.timestamp > best.timestamp) {
                best = score;
            }
        }
    }

    return best ? best.roomName : null;
}

module.exports = {
    canAttemptExpansion: canAttemptExpansion,
    selectExpansionTarget: selectExpansionTarget,
    explainBlockers: explainBlockers
};
