// Task.Expand.Selector.js — lightweight brain that decides when/where to expand (ES5 compliant)

var ConfigExpansion = require('Config.Expansion');
var IntelRoom = require('Intel.Room');

// Resolve Screeps' energy constant when available so the selector works in sim/test contexts.
var ENERGY_KEY = (typeof RESOURCE_ENERGY !== 'undefined') ? RESOURCE_ENERGY : 'energy';

/**
 * Ensure the shared expansion memory bucket exists and return it for reuse.
 */
function ensureExpansionMemory() {
    if (typeof Memory === 'undefined') return null;
    if (!Memory.__BHM) Memory.__BHM = {};
    if (!Memory.__BHM.expand) Memory.__BHM.expand = {};
    if (!Memory.rooms) Memory.rooms = {};
    return Memory.__BHM.expand;
}

/**
 * Pick our main room once per evaluation through the configured selector helper.
 */
function pickMainRoom() {
    if (!ConfigExpansion || typeof ConfigExpansion.MAIN_ROOM_SELECTOR !== 'function') return null;
    try {
        var name = ConfigExpansion.MAIN_ROOM_SELECTOR();
        return name || null;
    } catch (err) {
        return null;
    }
}

/**
 * Count how many rooms we truly own (controller.my === true) right now.
 */
function countOwnedRooms() {
    if (typeof Game === 'undefined' || !Game.rooms) return 0;
    var count = 0;
    for (var name in Game.rooms) {
        if (!Object.prototype.hasOwnProperty.call(Game.rooms, name)) continue;
        var room = Game.rooms[name];
        if (room && room.controller && room.controller.my) count++;
    }
    return count;
}

/**
 * Compute stored energy in storage + terminal for the given room.
 */
function getStoredEnergyFor(roomName) {
    if (typeof Game === 'undefined' || !Game.rooms) return 0;
    var room = Game.rooms[roomName];
    if (!room) return 0;

    var total = 0;
    if (room.storage && room.storage.store) {
        total += room.storage.store[ENERGY_KEY] || 0;
    }
    if (room.terminal && room.terminal.store) {
        total += room.terminal.store[ENERGY_KEY] || 0;
    }
    return total;
}

/**
 * Count any expansions marked in-progress in Memory.__BHM.expand.inProgress.
 */
function getExpansionsInProgress() {
    var expandMem = ensureExpansionMemory();
    if (!expandMem || !expandMem.inProgress) return 0;

    var table = expandMem.inProgress;
    if (Array.isArray(table)) return table.length;

    var count = 0;
    for (var key in table) {
        if (!Object.prototype.hasOwnProperty.call(table, key)) continue;
        var entry = table[key];
        if (!entry || entry.completed) continue;
        count++;
    }
    return count;
}

/**
 * Evaluate gating rules and return a list of friendly explanations when blocked.
 */
function gatherBlockers() {
    var blockers = [];
    if (!ConfigExpansion || ConfigExpansion.ENABLE_EXPANSION === false) {
        blockers.push('Expansion disabled');
        return blockers;
    }

    if (typeof Game === 'undefined' || typeof Game.time !== 'number') {
        blockers.push('Game globals unavailable');
        return blockers;
    }

    var expandMem = ensureExpansionMemory();
    var cooldownTicks = (ConfigExpansion && typeof ConfigExpansion.EXPANSION_COOLDOWN_TICKS === 'number') ? ConfigExpansion.EXPANSION_COOLDOWN_TICKS : 0;
    if (cooldownTicks < 0) cooldownTicks = 0;
    var lastDone = expandMem && expandMem.lastDone ? expandMem.lastDone : 0;
    var delta = Game.time - lastDone;
    if (cooldownTicks > 0 && delta < cooldownTicks) {
        var remaining = cooldownTicks - delta;
        if (remaining < 0) remaining = 0;
        blockers.push('Expansion cooldown ' + remaining + 't');
    }

    var mainRoom = pickMainRoom();
    if (!mainRoom) blockers.push('No main room');

    var ownedRooms = countOwnedRooms();
    var gclLevel = (Game.gcl && typeof Game.gcl.level === 'number') ? Game.gcl.level : 1;
    if (ownedRooms >= gclLevel) blockers.push('GCL limit (' + ownedRooms + '/' + gclLevel + ')');

    // Parallel slot cap: how many expansions may run at once, independent of
    // how many rooms we already control. Fall back to the legacy MAX_EXPANSIONS
    // knob if the new name is unavailable to preserve compatibility.
    var parallelCap = 1;
    if (ConfigExpansion) {
        if (typeof ConfigExpansion.MAX_PARALLEL_EXPANSIONS === 'number') {
            parallelCap = ConfigExpansion.MAX_PARALLEL_EXPANSIONS;
        } else if (typeof ConfigExpansion.MAX_EXPANSIONS === 'number') {
            parallelCap = ConfigExpansion.MAX_EXPANSIONS;
        }
    }
    var inProgress = getExpansionsInProgress();
    if (parallelCap >= 0 && inProgress >= parallelCap) {
        blockers.push('Expansion slots busy');
    }

    if (mainRoom) {
        var visible = (Game.rooms && Game.rooms[mainRoom]) ? true : false;
        if (!visible) {
            blockers.push('Main room not visible');
        } else {
            var storedEnergy = getStoredEnergyFor(mainRoom);
            var minEnergy = (ConfigExpansion && typeof ConfigExpansion.ENERGY_BOOTSTRAP_MIN === 'number') ? ConfigExpansion.ENERGY_BOOTSTRAP_MIN : 0;
            if (storedEnergy < minEnergy) {
                blockers.push('Need energy ' + storedEnergy + '/' + minEnergy);
            }
        }
    }

    return blockers;
}

/**
 * Decide if we can currently attempt an expansion.
 */
function canAttemptExpansion() {
    var blockers = gatherBlockers();
    return blockers.length === 0;
}

/**
 * Pick the best candidate room based on stored intel.
 */
function selectExpansionTarget() {
    if (!canAttemptExpansion()) return null;
    if (typeof Memory === 'undefined' || !Memory.rooms) return null;

    var mainRoom = pickMainRoom();
    if (!mainRoom) return null;

    var maxDistance = (ConfigExpansion && typeof ConfigExpansion.MAX_EXPANSION_DISTANCE === 'number') ? ConfigExpansion.MAX_EXPANSION_DISTANCE : 1;

    var best = null;
    for (var roomName in Memory.rooms) {
        if (!Object.prototype.hasOwnProperty.call(Memory.rooms, roomName)) continue;
        var intel = Memory.rooms[roomName];
        if (!intel || typeof intel !== 'object') continue;

        if (intel.owner) continue;
        if (intel.reserved) continue;

        var hops = Infinity;
        if (IntelRoom && typeof IntelRoom.getHopDistance === 'function') {
            hops = IntelRoom.getHopDistance(mainRoom, roomName);
        }
        if (hops === Infinity || hops > maxDistance) continue;

        var sources = intel.sources;
        // Normalize intel.sources into a consistent numeric count.
        var sourceCount = 0;
        if (Array.isArray(sources)) {
            sourceCount = sources.length;
        } else if (typeof sources === 'number') {
            sourceCount = sources;
        } else if (sources && typeof sources === 'object') {
            sourceCount = Object.keys(sources).length;
        }
        var twoSource = sourceCount >= 2 ? 1 : 0;
        var freshness = intel.ts || 0;

        if (!best) {
            best = { room: roomName, twoSource: twoSource, hops: hops, ts: freshness, sources: sourceCount };
            continue;
        }

        if (twoSource > best.twoSource) {
            best = { room: roomName, twoSource: twoSource, hops: hops, ts: freshness, sources: sourceCount };
            continue;
        }
        if (twoSource === best.twoSource) {
            if (hops < best.hops) {
                best = { room: roomName, twoSource: twoSource, hops: hops, ts: freshness, sources: sourceCount };
                continue;
            }
            if (hops === best.hops) {
                if (freshness > best.ts) {
                    best = { room: roomName, twoSource: twoSource, hops: hops, ts: freshness, sources: sourceCount };
                    continue;
                }
            }
        }
    }

    return best ? best.room : null;
}

/**
 * Provide human-readable reasons explaining why expansion is blocked.
 */
function explainBlockers() {
    return gatherBlockers();
}

module.exports = {
    canAttemptExpansion: canAttemptExpansion,
    selectExpansionTarget: selectExpansionTarget,
    explainBlockers: explainBlockers
};
