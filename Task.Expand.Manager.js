/**
 * Task.Expand.Manager.js
 * -----------------------
 * Coordinates the three-phase expansion flow (idle → claiming → bootstrapping)
 * while delegating spawn execution to the central spawn logic. The manager only
 * mutates Memory.__BHM.expand and publishes spawn intents so the existing spawn
 * pipeline can decide when to build the requested creeps.
 *
 * Manual smoke walkthrough:
 * 1. Compare Game.gcl.level against owned rooms to confirm gating behaves.
 * 2. Seed Memory.__BHM.scoutQueue and ensure scouts record intel into Memory.rooms.
 * 3. Once ENERGY_BOOTSTRAP_MIN is met, phase should flip from idle to claiming.
 * 4. Watch a claimer intent queue, spawn, and capture the target controller.
 * 5. Observe two builder intents and one hauler intent fill during bootstrapping.
 * 6. After a spawn structure completes, verify lastDone and state reset to idle.
 *
 * Console helpers:
 * - global.helpExpand() → print current blockers plus the next candidate room.
 * - global.abortExpand() → reset expansion state to idle and clear expansion intents.
 */

var ConfigExpansion = require('Config.Expansion');
var ExpandSelector = require('Task.Expand.Selector');
var SpawnPlacement = require('Planner.SpawnPlacement');

var PHASE_IDLE = 'idle';
var PHASE_CLAIMING = 'claiming';
var PHASE_BOOTSTRAPPING = 'bootstrapping';
var EXPAND_CLAIMER_ROLE = 'ExpandClaimer'; // dedicated module for managed expansions

var DESIRED_BUILDERS = 2;   // bootstrap requires two builders for rapid spawn bring-up
var DESIRED_HAULERS = 1;    // single courier keeps builders supplied with energy
var CLAIMER_REQUEUE_TICKS = 50; // wait before re-queueing a claimer after loss
var BUILDER_REQUEUE_TICKS = 20; // don't spam builder intents when spawns are busy
var HAULER_REQUEUE_TICKS = 20;  // throttle hauler intent churn

var CFG = {
    DEBUG_SAY: false,
    DEBUG_DRAW: false,
    HUD_COLOR: '#ffe066',
    HUD_BG: '#000000'
};

function getMemoryRoot() {
    if (typeof Memory === 'undefined') return null;
    if (!Memory.__BHM) Memory.__BHM = {};
    if (!Memory.__BHM.expand) {
        Memory.__BHM.expand = {
            phase: PHASE_IDLE,
            target: null,
            created: 0
        };
    }
    var state = Memory.__BHM.expand;
    if (!state.phase) state.phase = PHASE_IDLE;
    if (!state.target) state.target = null;
    if (!state.created) state.created = 0;
    if (!state.lastClaimerRequest) state.lastClaimerRequest = 0;
    if (!state.lastBuilderRequest) state.lastBuilderRequest = 0;
    if (!state.lastHaulerRequest) state.lastHaulerRequest = 0;
    if (!state.status) state.status = '';
    if (!state.inProgress) state.inProgress = {};
    return state;
}

function getMainRoomName() {
    if (!ConfigExpansion || typeof ConfigExpansion.MAIN_ROOM_SELECTOR !== 'function') {
        return null;
    }
    try {
        return ConfigExpansion.MAIN_ROOM_SELECTOR();
    } catch (err) {
        return null;
    }
}

function getSpawnQueue() {
    if (typeof global === 'undefined') return null;
    if (!global.__BHM) global.__BHM = {};
    if (!global.__BHM.spawnIntents) global.__BHM.spawnIntents = [];
    return global.__BHM.spawnIntents;
}

function roleMatchesIntent(role, intentRole) {
    if (!role) return intentRole === null || intentRole === undefined;
    if (!intentRole) return false;
    if (role === intentRole) return true;
    if (role === EXPAND_CLAIMER_ROLE && intentRole === 'claimer') return true;
    if (role === 'claimer' && intentRole === EXPAND_CLAIMER_ROLE) return true;
    return false;
}

function countQueued(queue, target, role) {
    if (!queue || !queue.length) return 0;
    var count = 0;
    for (var i = 0; i < queue.length; i++) {
        var intent = queue[i];
        if (!intent) continue;
        if (intent.target !== target) continue;
        if (role && !roleMatchesIntent(role, intent.role)) continue;
        count++;
    }
    return count;
}

function findExpandCreeps(target, role) {
    var matches = [];
    if (typeof Game === 'undefined' || !Game.creeps) return matches;
    for (var name in Game.creeps) {
        if (!Object.prototype.hasOwnProperty.call(Game.creeps, name)) continue;
        var creep = Game.creeps[name];
        if (!creep || !creep.memory) continue;
        if (creep.memory.task !== 'expand') continue;
        if (creep.memory.target !== target) continue;
        if (role) {
            var cRole = creep.memory.role;
            if (cRole !== role) {
                if (role === EXPAND_CLAIMER_ROLE && cRole === 'claimer') {
                    // tolerate legacy role string while transitioning intents
                    matches.push(creep);
                    continue;
                }
                if (role === 'claimer' && cRole === EXPAND_CLAIMER_ROLE) {
                    matches.push(creep);
                    continue;
                }
                if (cRole !== role) continue;
            }
        }
        matches.push(creep);
    }
    return matches;
}

function buildIntent(role, mainRoom, target, priority, body) {
    var memory = {
        role: role,
        task: 'expand',
        home: mainRoom,
        target: target,
        expand: {
            home: mainRoom,
            target: target,
            role: role
        }
    };
    return {
        role: role,
        priority: priority,
        home: mainRoom,
        target: target,
        body: body,
        memory: memory
    };
}

function queueIntent(intent) {
    var queue = getSpawnQueue();
    if (!queue || !intent) return false;
    queue.push(intent);
    return true;
}

function recordInProgress(state, phase) {
    if (!state || !state.target) return;
    if (!state.inProgress) state.inProgress = {};
    var entry = state.inProgress[state.target] || { target: state.target };
    entry.phase = phase;
    if (typeof Game !== 'undefined' && typeof Game.time === 'number') {
        if (!entry.started) entry.started = Game.time;
        entry.updated = Game.time;
    }
    if (state.mainRoom) entry.mainRoom = state.mainRoom;
    state.inProgress[state.target] = entry;
}

function beginClaiming(state, mainRoom, target) {
    state.phase = PHASE_CLAIMING;
    state.target = target;
    state.created = (typeof Game !== 'undefined' && Game.time) ? Game.time : 0;
    state.bootStarted = 0;
    state.claimerId = null;
    state.lastClaimerRequest = 0;
    state.lastBuilderRequest = 0;
    state.lastHaulerRequest = 0;
    state.status = 'Claiming ' + target;
    state.mainRoom = mainRoom;
    recordInProgress(state, PHASE_CLAIMING);
}

function transitionToBootstrapping(state) {
    state.phase = PHASE_BOOTSTRAPPING;
    state.bootStarted = (typeof Game !== 'undefined' && Game.time) ? Game.time : 0;
    state.status = 'Bootstrapping ' + state.target;
    recordInProgress(state, PHASE_BOOTSTRAPPING);
}

function finishExpansion(state, outcome) {
    if (!state) return;
    var finishedTarget = state.target;
    state.lastDone = (typeof Game !== 'undefined' && Game.time) ? Game.time : 0;
    state.previousTarget = finishedTarget;
    state.previousOutcome = outcome || 'complete';
    if (state.inProgress && finishedTarget && state.inProgress[finishedTarget]) {
        delete state.inProgress[finishedTarget];
    }
    state.phase = PHASE_IDLE;
    state.target = null;
    state.created = 0;
    state.bootStarted = 0;
    state.claimerId = null;
    state.lastClaimerRequest = 0;
    state.lastBuilderRequest = 0;
    state.lastHaulerRequest = 0;
    state.status = 'Idle';
}

function handleIdle(state, mainRoom) {
    if (!ExpandSelector || typeof ExpandSelector.canAttemptExpansion !== 'function') {
        state.status = 'Selector offline';
        return;
    }
    if (!ExpandSelector.canAttemptExpansion()) {
        if (typeof ExpandSelector.explainBlockers === 'function') {
            var blockers = ExpandSelector.explainBlockers();
            if (blockers && blockers.length) {
                state.status = 'Blocked: ' + blockers.join(', ');
            } else {
                state.status = 'Blocked';
            }
        } else {
            state.status = 'Blocked';
        }
        return;
    }
    if (typeof ExpandSelector.selectExpansionTarget !== 'function') {
        state.status = 'No selector';
        return;
    }
    var target = ExpandSelector.selectExpansionTarget();
    if (!target) {
        state.status = 'No target';
        return;
    }
    beginClaiming(state, mainRoom, target);
}

function claimSucceeded(target) {
    if (typeof Game === 'undefined' || !Game.rooms) return false;
    var room = Game.rooms[target];
    if (!room || !room.controller) return false;
    return room.controller.my === true;
}

function ensureClaimer(state, mainRoom) {
    var target = state.target;
    var queue = getSpawnQueue();
    var alive = findExpandCreeps(target, EXPAND_CLAIMER_ROLE);
    if (alive.length > 0) {
        state.claimerId = alive[0].name;
        return;
    }
    state.claimerId = null;
    var queued = countQueued(queue, target, EXPAND_CLAIMER_ROLE);
    if (queued > 0) return;
    if (typeof Game === 'undefined' || !Game.time) return;
    if (Game.time - state.lastClaimerRequest < CLAIMER_REQUEUE_TICKS) {
        return;
    }
    if (!mainRoom) {
        state.status = 'No main room for claimer';
        return;
    }
    var body = [CLAIM, MOVE, MOVE];
    var intent = buildIntent(EXPAND_CLAIMER_ROLE, mainRoom, target, 5, body);
    if (queueIntent(intent) && typeof Game !== 'undefined') {
        state.lastClaimerRequest = Game.time;
        state.status = 'Queued claimer for ' + target;
    }
}

function countStructures(target) {
    if (typeof Game === 'undefined' || !Game.rooms) return 0;
    var room = Game.rooms[target];
    if (!room) return 0;
    var found = room.find(FIND_MY_STRUCTURES, {
        filter: function (structure) {
            return structure.structureType === STRUCTURE_SPAWN;
        }
    });
    if (found && found.length) return found.length;
    return 0;
}

function ensureSpawnSite(state) {
    if (!state || !state.target) return;
    if (typeof Game === 'undefined' || !Game.rooms) return;
    if (!SpawnPlacement || typeof SpawnPlacement.placeInitialSpawnSite !== 'function') return;
    var room = Game.rooms[state.target];
    if (!room || !room.controller || !room.controller.my) return;
    var existing = room.find(FIND_MY_STRUCTURES, {
        filter: function (s) { return s.structureType === STRUCTURE_SPAWN; }
    });
    if (existing && existing.length) return;
    var sites = room.find(FIND_MY_CONSTRUCTION_SITES, {
        filter: function (site) { return site.structureType === STRUCTURE_SPAWN; }
    });
    if (sites && sites.length) return;
    SpawnPlacement.placeInitialSpawnSite(room);
}

function ensureBuilders(state, mainRoom) {
    var target = state.target;
    var queue = getSpawnQueue();
    var alive = findExpandCreeps(target, 'builder').length;
    var queued = countQueued(queue, target, 'builder');
    var missing = DESIRED_BUILDERS - alive - queued;
    if (missing <= 0) return;
    if (!mainRoom) {
        state.status = 'No main room for builders';
        return;
    }
    if (typeof Game !== 'undefined' && Game.time && Game.time - state.lastBuilderRequest < BUILDER_REQUEUE_TICKS) {
        return;
    }
    var body = [WORK, WORK, CARRY, CARRY, MOVE, MOVE];
    var requested = false;
    for (var i = 0; i < missing; i++) {
        if (!queueIntent(buildIntent('builder', mainRoom, target, 10, body))) {
            break;
        }
        requested = true;
    }
    if (requested && typeof Game !== 'undefined' && Game.time) {
        state.lastBuilderRequest = Game.time;
    }
}

function ensureHauler(state, mainRoom) {
    var target = state.target;
    var queue = getSpawnQueue();
    var alive = findExpandCreeps(target, 'hauler').length;
    var queued = countQueued(queue, target, 'hauler');
    var missing = DESIRED_HAULERS - alive - queued;
    if (missing <= 0) return;
    if (!mainRoom) {
        state.status = 'No main room for hauler';
        return;
    }
    if (typeof Game !== 'undefined' && Game.time && Game.time - state.lastHaulerRequest < HAULER_REQUEUE_TICKS) {
        return;
    }
    var body = [CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE];
    if (queueIntent(buildIntent('hauler', mainRoom, target, 12, body)) && typeof Game !== 'undefined' && Game.time) {
        state.lastHaulerRequest = Game.time;
    }
}

function handleClaiming(state, mainRoom) {
    ensureClaimer(state, mainRoom);
    var status = state.status || '';
    if (status.indexOf('Queued claimer') !== 0 && status.indexOf('No main room') !== 0) {
        state.status = 'Claiming ' + state.target;
    }
    if (claimSucceeded(state.target)) {
        transitionToBootstrapping(state);
    } else {
        recordInProgress(state, PHASE_CLAIMING);
    }
}

function handleBootstrapping(state, mainRoom) {
    ensureSpawnSite(state);
    ensureBuilders(state, mainRoom);
    ensureHauler(state, mainRoom);
    if (!state.status || state.status.indexOf('No main room') !== 0) {
        state.status = 'Bootstrapping ' + state.target;
    }
    if (countStructures(state.target) > 0) {
        finishExpansion(state, 'complete');
    } else {
        recordInProgress(state, PHASE_BOOTSTRAPPING);
    }
}

function drawHud(state, mainRoomName) {
    if (!state) return;
    if (typeof Game === 'undefined') return;
    if (!mainRoomName) mainRoomName = state.mainRoom;
    if (!mainRoomName) return;
    var room = Game.rooms ? Game.rooms[mainRoomName] : null;
    if (!room || !room.visual) return;
    var text = '[Expand] ' + state.phase;
    if (state.target) {
        text += ' → ' + state.target;
    }
    if (state.status) {
        text += ' :: ' + state.status;
    }
    try {
        room.visual.text(text, 1, 1, {
            color: CFG.HUD_COLOR,
            backgroundColor: CFG.HUD_BG,
            backgroundOpacity: 0.4,
            font: 0.8,
            align: 'left'
        });
    } catch (err) {}
}

function installDebugHelper(state) {
    if (typeof global === 'undefined') return;
    if (typeof Game === 'undefined') return;
    if (!global.__BHM) global.__BHM = {};

    if (typeof global.helpExpand !== 'function' || global.helpExpand.__managerTag !== 'Task.Expand.Manager') {
        global.helpExpand = function () {
            var messages = [];
            var blockers = [];
            if (ExpandSelector && typeof ExpandSelector.explainBlockers === 'function') {
                try {
                    blockers = ExpandSelector.explainBlockers() || [];
                } catch (err) {
                    blockers = ['explainBlockers failed'];
                }
            }
            if (!blockers || !blockers.length) {
                messages.push('Blockers: none');
            } else {
                messages.push('Blockers: ' + blockers.join(', '));
            }
            var current = getMemoryRoot();
            if (current && current.phase && current.target) {
                messages.push('Active: ' + current.phase + ' → ' + current.target);
            }
            var next = null;
            if (ExpandSelector && typeof ExpandSelector.selectExpansionTarget === 'function') {
                try {
                    next = ExpandSelector.selectExpansionTarget();
                } catch (selErr) {
                    next = 'error';
                }
            }
            if (next) {
                messages.push('Next: ' + next);
            } else {
                messages.push('Next: none');
            }
            var output = messages.join(' | ');
            if (typeof console !== 'undefined' && console.log) {
                console.log('[helpExpand] ' + output);
            }
            return output;
        };
        global.helpExpand.__managerTag = 'Task.Expand.Manager';
        if (typeof Game.helpExpand !== 'function' || Game.helpExpand.__managerTag !== 'Task.Expand.Manager') {
            Game.helpExpand = global.helpExpand;
            Game.helpExpand.__managerTag = 'Task.Expand.Manager';
        }
    }

    if (typeof global.abortExpand !== 'function' || global.abortExpand.__managerTag !== 'Task.Expand.Manager') {
        global.abortExpand = function () {
            var output = [];
            var mem = getMemoryRoot();
            var previousTarget = null;
            if (mem) {
                previousTarget = mem.target;
                if (mem.inProgress && previousTarget && mem.inProgress[previousTarget]) {
                    delete mem.inProgress[previousTarget];
                }
                mem.phase = PHASE_IDLE;
                mem.target = null;
                mem.created = 0;
                mem.bootStarted = 0;
                mem.claimerId = null;
                mem.lastClaimerRequest = 0;
                mem.lastBuilderRequest = 0;
                mem.lastHaulerRequest = 0;
                mem.status = 'Aborted manually';
                mem.previousOutcome = 'aborted';
                mem.previousTarget = previousTarget;
            }
            var queue = getSpawnQueue();
            var removed = 0;
            if (queue && queue.length) {
                for (var i = queue.length - 1; i >= 0; i--) {
                    var intent = queue[i];
                    if (!intent) continue;
                    var intentMemory = intent.memory;
                    if (intentMemory && intentMemory.task === 'expand') {
                        queue.splice(i, 1);
                        removed++;
                    }
                }
            }
            if (previousTarget) {
                output.push('target ' + previousTarget + ' cleared');
            }
            output.push('removed ' + removed + ' intents');
            var summary = '[abortExpand] ' + output.join('; ');
            if (typeof console !== 'undefined' && console.log) {
                console.log(summary);
            }
            return summary;
        };
        global.abortExpand.__managerTag = 'Task.Expand.Manager';
        if (typeof Game.abortExpand !== 'function' || Game.abortExpand.__managerTag !== 'Task.Expand.Manager') {
            Game.abortExpand = global.abortExpand;
            Game.abortExpand.__managerTag = 'Task.Expand.Manager';
        }
    }
}

function run() {
    var state = getMemoryRoot();
    if (!state) return;
    installDebugHelper(state);
    var mainRoom = getMainRoomName();
    state.mainRoom = mainRoom;

    if (ConfigExpansion && ConfigExpansion.ENABLE_EXPANSION === false) {
        state.status = 'Disabled';
        if (state.phase !== PHASE_IDLE) {
            if (state.target && state.inProgress && state.inProgress[state.target]) {
                delete state.inProgress[state.target];
            }
            state.phase = PHASE_IDLE;
            state.target = null;
        }
        drawHud(state, mainRoom);
        return;
    }

    if (state.phase === PHASE_IDLE) {
        handleIdle(state, mainRoom);
    } else if (state.phase === PHASE_CLAIMING) {
        handleClaiming(state, mainRoom);
    } else if (state.phase === PHASE_BOOTSTRAPPING) {
        handleBootstrapping(state, mainRoom);
    } else {
        state.phase = PHASE_IDLE;
    }

    drawHud(state, mainRoom);
}

module.exports = {
    run: run
};
