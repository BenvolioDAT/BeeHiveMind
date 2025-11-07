/**
 * Task.Expand.Manager.js — orchestrates expansion claim→bootstrap pipeline (ES5 compliant)
 *
 * Manual smoke checklist (run in sim/private server):
 * 1. Toggle Game.gcl.level and owned room count to verify canAttemptExpansion() blocks when ownership >= GCL.
 * 2. Seed Memory.__BHM.scoutQueue with nearby rooms and watch scouts record intel via Intel.Room.collectRoomIntel().
 * 3. When stored energy in the main room reaches ENERGY_BOOTSTRAP_MIN, confirm phase advances from idle to claiming.
 * 4. Observe a claimer intent pushed into global.__BHM.spawnIntents, the creep spawning, and successfully claiming the controller.
 * 5. Verify builder and courier intents appear, a spawn construction site is placed, and remote units build it up.
 * 6. After the spawn finishes, ensure the manager resets to idle and clears expansion state.
 */

var ConfigExpansion = require('Config.Expansion');
var ExpandSelector = require('Task.Expand.Selector');

var CFG = Object.freeze({
    DEBUG_SAY: false,   // toggle to surface high-level status inside Memory for debugging
    DEBUG_DRAW: false,  // toggle RoomVisual breadcrumbs for current expansion state
    DRAW: {
        TEXT: '#ffe066',
        LINE: '#a0ffa0',
        WIDTH: 0.15,
        OPACITY: 0.55,
        FONT: 0.9
    }
});

var MANAGER_TAG = 'Task.Expand.Manager';
var MANAGER_MEMORY_KEY = 'expand';
var DESIRED_BUILDERS = 2; // desired remote builder count during bootstrapping
var DESIRED_COURIERS = 1; // desired remote courier count during bootstrapping
var INTENT_COOLDOWN = 5;  // ticks before re-issuing the same spawn intent request

// Canonical bodies for expansion intents so the central spawn logic receives explicit specs.
var INTENT_BODIES = {
    claimer: [CLAIM, MOVE, MOVE],
    builder: [WORK, WORK, CARRY, CARRY, MOVE, MOVE],
    courier: [CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE]
};

function cloneIntentBody(key) {
    var preset = INTENT_BODIES[key];
    if (!preset || !preset.length) {
        return [];
    }
    var body = [];
    for (var i = 0; i < preset.length; i++) {
        body[i] = preset[i];
    }
    return body;
}

function ensureInProgressTable(state) {
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

function mergeLegacyInProgress(targetMap, legacy) {
    if (!legacy) {
        return;
    }
    if (Array.isArray(legacy)) {
        for (var i = 0; i < legacy.length; i++) {
            mergeLegacyInProgress(targetMap, legacy[i]);
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

function isExpansionEnabled() {
    if (!ConfigExpansion) return true;
    return ConfigExpansion.ENABLE_EXPANSION !== false;
}

function getManagerMemory() {
    if (typeof Memory === 'undefined') return {};
    if (!Memory.__BHM) Memory.__BHM = {};
    if (!Memory.__BHM[MANAGER_MEMORY_KEY]) Memory.__BHM[MANAGER_MEMORY_KEY] = {};
    var state = Memory.__BHM[MANAGER_MEMORY_KEY];

    if (!state.phase) state.phase = 'idle';
    if (!state.intentTicks || typeof state.intentTicks !== 'object') state.intentTicks = {};
    if (!Array.isArray(state.builderSlots)) state.builderSlots = [];
    if (!state.status) state.status = 'idle';
    if (!state.metrics || typeof state.metrics !== 'object') state.metrics = {};
    return state;
}

function resetState(state, keepHistory) {
    if (!state) return;
    if (keepHistory) {
        state.previous = keepHistory;
    }
    state.phase = 'idle';
    state.target = null;
    state.created = 0;
    state.mainRoom = null;
    state.bootStarted = null;
    state.claimerName = null;
    state.courierSlot = null;
    state.builderSlots = [];
    state.intentTicks = {};
    state.status = 'idle';
    state.metrics = {};
}

function ensureSpawnIntentQueue() {
    if (typeof global === 'undefined') return null;
    if (!global.__BHM) global.__BHM = {};
    if (!global.__BHM.spawnIntents || global.__BHM.spawnIntentsTick !== Game.time) {
        global.__BHM.spawnIntents = [];
        global.__BHM.spawnIntentsTick = Game.time;
    }
    return global.__BHM.spawnIntents;
}

function buildIntentId(target, roleKey, slot) {
    var parts = ['expand', target || 'unknown', roleKey || 'unit'];
    if (slot !== null && slot !== undefined) {
        parts.push('slot' + slot);
    }
    return parts.join(':');
}

function publishSpawnIntent(spec) {
    if (!spec) return false;
    var queue = ensureSpawnIntentQueue();
    if (!queue) return false;
    if (spec.intentId) {
        for (var i = 0; i < queue.length; i++) {
            var existing = queue[i];
            if (!existing) continue;
            if (existing.intentId && existing.intentId === spec.intentId) {
                return false;
            }
        }
    }
    queue.push(spec);
    return true;
}

function ensureMainRoom(state) {
    if (state && state.mainRoom) return state.mainRoom;
    if (!ConfigExpansion || typeof ConfigExpansion.MAIN_ROOM_SELECTOR !== 'function') return null;
    var roomName = null;
    try {
        roomName = ConfigExpansion.MAIN_ROOM_SELECTOR();
    } catch (err) {
        roomName = null;
    }
    if (state && roomName) state.mainRoom = roomName;
    return roomName;
}

function getExpansionMemory() {
    var state = getManagerMemory();
    if (!state) {
        return null;
    }
    var table = ensureInProgressTable(state);
    if (Memory.__BHM && Memory.__BHM.expansion) {
        var legacyRoot = Memory.__BHM.expansion;
        if (legacyRoot.inProgress) {
            mergeLegacyInProgress(table, legacyRoot.inProgress);
        }
        if (legacyRoot.lastTarget && !state.lastTarget) {
            state.lastTarget = legacyRoot.lastTarget;
        }
        if (legacyRoot.lastUpdated && !state.lastUpdated) {
            state.lastUpdated = legacyRoot.lastUpdated;
        }
        if (legacyRoot.lastDone && !state.lastDone) {
            state.lastDone = legacyRoot.lastDone;
        }
        if (legacyRoot.lastCompleted && !state.lastCompleted) {
            state.lastCompleted = legacyRoot.lastCompleted;
        }
        try {
            delete Memory.__BHM.expansion;
        } catch (cleanupErr) {
            Memory.__BHM.expansion = undefined;
        }
    }
    return state;
}

function updateInProgressEntry(state, phase) {
    if (!state || !state.target) return;
    var store = getExpansionMemory();
    if (!store) return;
    var table = store.inProgress;
    var entry = table[state.target];
    if (!entry) {
        entry = { target: state.target, started: Game.time };
    }
    if (state.created && !entry.created) entry.created = state.created;
    entry.phase = phase || state.phase || 'unknown';
    entry.updated = Game.time;
    if (state.mainRoom) entry.mainRoom = state.mainRoom;
    table[state.target] = entry;
    store.lastTarget = state.target;
    store.lastUpdated = Game.time;
}

function finalizeInProgressEntry(target, outcome) {
    if (!target) return;
    var store = getExpansionMemory();
    if (!store) return;
    var table = store.inProgress;
    if (!table || typeof table !== 'object') return;
    var entry = table[target] || { target: target };
    entry.completed = Game.time;
    entry.outcome = outcome || 'complete';
    store.lastCompleted = entry;
    delete table[target];
}

function recordStatus(state, message) {
    if (!state) return;
    state.status = message;
    state.statusTick = Game.time;
}

function findExpandCreeps(target, roleKey) {
    var list = [];
    if (typeof Game === 'undefined' || !Game.creeps) return list;
    for (var name in Game.creeps) {
        if (!Object.prototype.hasOwnProperty.call(Game.creeps, name)) continue;
        var creep = Game.creeps[name];
        if (!creep || !creep.memory) continue;
        var expand = creep.memory.expand;
        var matches = false;
        if (expand && expand.target === target) {
            if (!roleKey || expand.role === roleKey) {
                matches = true;
            }
        }
        if (!matches && roleKey === 'claimer') {
            if ((creep.memory.task === 'Claimer') && creep.memory.targetRoom === target) {
                matches = true;
            }
        }
        if (!matches && roleKey === 'builder') {
            if (creep.memory.task === 'builder' && creep.memory.targetRoom === target) {
                matches = true;
            }
        }
        if (!matches && roleKey === 'courier') {
            if (creep.memory.task === 'courier' && creep.memory.targetRoom === target) {
                matches = true;
            }
        }
        if (matches) list.push(creep);
    }
    return list;
}

function syncClaimer(state) {
    var names = findExpandCreeps(state.target, 'claimer');
    if (names.length > 1) {
        names.sort(function (a, b) {
            return (a.ticksToLive || 0) - (b.ticksToLive || 0);
        });
    }
    var first = names.length ? names[0] : null;
    state.claimerName = first ? first.name : null;
    state.metrics.claimerCount = names.length;
    return names.length;
}

function ensureBuilderSlots(state) {
    while (state.builderSlots.length < DESIRED_BUILDERS) {
        state.builderSlots.push(null);
    }
    if (state.builderSlots.length > DESIRED_BUILDERS) {
        state.builderSlots = state.builderSlots.slice(0, DESIRED_BUILDERS);
    }
}

function syncBuilders(state) {
    ensureBuilderSlots(state);
    var slots = [];
    var i;
    for (i = 0; i < state.builderSlots.length; i++) {
        slots[i] = null;
    }
    var creeps = findExpandCreeps(state.target, 'builder');
    for (i = 0; i < creeps.length; i++) {
        var creep = creeps[i];
        if (!creep.memory) continue;
        var slot = null;
        if (creep.memory.expand && typeof creep.memory.expand.slot === 'number') {
            slot = creep.memory.expand.slot | 0;
        }
        if (slot !== null && slot !== undefined && slot >= 0 && slot < slots.length && slots[slot] === null) {
            slots[slot] = creep.name;
            continue;
        }
        for (var s = 0; s < slots.length; s++) {
            if (slots[s] === null) {
                slots[s] = creep.name;
                if (!creep.memory.expand) creep.memory.expand = {};
                creep.memory.expand.role = 'builder';
                creep.memory.expand.target = state.target;
                creep.memory.expand.slot = s;
                creep.memory.expand.manager = MANAGER_TAG;
                break;
            }
        }
    }
    state.builderSlots = slots;
    state.metrics.builderCount = creeps.length;
    return creeps.length;
}

function syncCourier(state) {
    var creeps = findExpandCreeps(state.target, 'courier');
    var courierName = null;
    if (creeps.length) courierName = creeps[0].name;
    state.courierSlot = courierName;
    state.metrics.courierCount = creeps.length;
    return creeps.length;
}

function intentCooldownPassed(state, roleKey, slot) {
    if (!state.intentTicks) state.intentTicks = {};
    var key = roleKey;
    if (slot !== null && slot !== undefined) key = roleKey + ':' + slot;
    var last = state.intentTicks[key] || 0;
    if (Game.time - last < INTENT_COOLDOWN) return false;
    return true;
}

function stampIntentRequest(state, roleKey, slot) {
    if (!state.intentTicks) state.intentTicks = {};
    var key = roleKey;
    if (slot !== null && slot !== undefined) key = roleKey + ':' + slot;
    state.intentTicks[key] = Game.time;
}

function requestClaimer(state) {
    if (!intentCooldownPassed(state, 'claimer')) return;
    var mainRoom = ensureMainRoom(state);
    var body = cloneIntentBody('claimer');
    var intent = {
        intentId: buildIntentId(state.target, 'claimer'),
        role: 'claimer',
        task: 'Claimer',
        priority: 100,
        home: mainRoom,
        homeRoom: mainRoom,
        target: state.target,
        targetRoom: state.target,
        origin: MANAGER_TAG,
        body: body.length ? body : undefined,
        memory: {
            role: 'Worker_Bee',
            task: 'Claimer',
            targetRoom: state.target,
            expand: {
                manager: MANAGER_TAG,
                target: state.target,
                role: 'claimer',
                phase: state.phase,
                requested: Game.time,
                home: mainRoom
            }
        }
    };
    if (!intent.body) {
        delete intent.body;
    }
    if (publishSpawnIntent(intent)) {
        stampIntentRequest(state, 'claimer');
    }
}

function requestBuilder(state, slot) {
    if (!intentCooldownPassed(state, 'builder', slot)) return;
    var mainRoom = ensureMainRoom(state);
    var body = cloneIntentBody('builder');
    var intent = {
        intentId: buildIntentId(state.target, 'builder', slot),
        role: 'builder',
        task: 'builder',
        priority: 70,
        home: mainRoom,
        homeRoom: mainRoom,
        target: state.target,
        targetRoom: state.target,
        origin: MANAGER_TAG,
        slot: slot,
        body: body.length ? body : undefined,
        memory: {
            role: 'Worker_Bee',
            task: 'builder',
            homeRoom: mainRoom,
            targetRoom: state.target,
            expand: {
                manager: MANAGER_TAG,
                target: state.target,
                role: 'builder',
                slot: slot,
                phase: state.phase,
                requested: Game.time,
                home: mainRoom
            }
        }
    };
    if (!intent.body) {
        delete intent.body;
    }
    if (publishSpawnIntent(intent)) {
        stampIntentRequest(state, 'builder', slot);
    }
}

function requestCourier(state) {
    if (!intentCooldownPassed(state, 'courier', 0)) return;
    var mainRoom = ensureMainRoom(state);
    var body = cloneIntentBody('courier');
    var intent = {
        intentId: buildIntentId(state.target, 'courier', 0),
        role: 'hauler',
        task: 'courier',
        priority: 65,
        home: mainRoom,
        homeRoom: mainRoom,
        target: state.target,
        targetRoom: state.target,
        origin: MANAGER_TAG,
        body: body.length ? body : undefined,
        memory: {
            role: 'Worker_Bee',
            task: 'courier',
            homeRoom: mainRoom,
            targetRoom: state.target,
            expand: {
                manager: MANAGER_TAG,
                target: state.target,
                role: 'courier',
                slot: 0,
                phase: state.phase,
                requested: Game.time,
                home: mainRoom
            }
        }
    };
    if (!intent.body) {
        delete intent.body;
    }
    if (publishSpawnIntent(intent)) {
        stampIntentRequest(state, 'courier', 0);
    }
}

function detectClaimSuccess(state) {
    if (typeof Game === 'undefined' || !state.target) return false;
    var room = Game.rooms ? Game.rooms[state.target] : null;
    if (!room || !room.controller) return false;
    if (!room.controller.my) return false;
    return true;
}

function detectSpawnPresence(state) {
    if (typeof Game === 'undefined' || !state.target) return false;
    var room = Game.rooms ? Game.rooms[state.target] : null;
    if (!room) return false;
    var spawns = room.find ? room.find(FIND_MY_STRUCTURES, {
        filter: function (structure) {
            return structure && structure.structureType === STRUCTURE_SPAWN;
        }
    }) : [];
    return spawns && spawns.length > 0;
}

function abortIfHostile(state) {
    if (typeof Game === 'undefined' || !state.target) return false;
    var room = Game.rooms ? Game.rooms[state.target] : null;
    if (!room || !room.controller) return false;
    if (room.controller.my) return false;
    if (!room.controller.owner) return false;
    var username = room.controller.owner.username;
    if (!username) return false;
    var targetName = state.target;
    finalizeInProgressEntry(targetName, 'blocked');
    resetState(state, { target: targetName, outcome: 'blocked', at: Game.time, owner: username });
    recordStatus(state, 'Blocked ' + targetName + ' by ' + username);
    return true;
}

function handleIdle(state) {
    recordStatus(state, 'Idle');
    if (!ExpandSelector || typeof ExpandSelector.canAttemptExpansion !== 'function') return;
    if (!ExpandSelector.canAttemptExpansion()) {
        if (CFG.DEBUG_SAY) state.metrics.blockers = ExpandSelector.explainBlockers ? ExpandSelector.explainBlockers() : [];
        return;
    }
    if (!ExpandSelector.selectExpansionTarget || typeof ExpandSelector.selectExpansionTarget !== 'function') return;
    var mainRoom = ensureMainRoom(state);
    if (!mainRoom) {
        recordStatus(state, 'No main room');
        return;
    }
    var target = ExpandSelector.selectExpansionTarget();
    if (!target) {
        recordStatus(state, 'No target');
        return;
    }
    state.target = target;
    state.phase = 'claiming';
    state.created = Game.time;
    state.builderSlots = [];
    state.intentTicks = {};
    state.metrics = {};
    recordStatus(state, 'Claiming ' + target);
    updateInProgressEntry(state, 'claiming');
}

function handleClaiming(state) {
    if (!state.target) {
        resetState(state);
        return;
    }
    if (abortIfHostile(state)) return;
    updateInProgressEntry(state, 'claiming');
    var count = syncClaimer(state);
    if (count === 0) {
        requestClaimer(state);
        recordStatus(state, 'Claiming ' + state.target + ' (queue claimer)');
    } else {
        recordStatus(state, 'Claiming ' + state.target + ' (active)');
    }
    if (detectClaimSuccess(state)) {
        state.phase = 'bootstrapping';
        state.bootStarted = Game.time;
        state.intentTicks = {};
        state.builderSlots = [];
        state.courierSlot = null;
        recordStatus(state, 'Bootstrapping ' + state.target);
        updateInProgressEntry(state, 'bootstrapping');
    }
}

function handleBootstrapping(state) {
    if (!state.target) {
        resetState(state);
        return;
    }
    if (!detectClaimSuccess(state)) {
        state.phase = 'claiming';
        recordStatus(state, 'Reclaim ' + state.target);
        return;
    }
    if (abortIfHostile(state)) return;
    updateInProgressEntry(state, 'bootstrapping');
    var builders = syncBuilders(state);
    var couriers = syncCourier(state);
    var slot;
    for (slot = 0; slot < state.builderSlots.length; slot++) {
        if (!state.builderSlots[slot]) {
            requestBuilder(state, slot);
        }
    }
    if (!state.courierSlot && couriers < DESIRED_COURIERS) {
        requestCourier(state);
    }
    var message = 'Bootstrapping ' + state.target;
    if (builders < DESIRED_BUILDERS) {
        message += ' [builders ' + builders + '/' + DESIRED_BUILDERS + ']';
    }
    if (couriers < DESIRED_COURIERS) {
        message += ' [couriers ' + couriers + '/' + DESIRED_COURIERS + ']';
    }
    recordStatus(state, message);
    if (detectSpawnPresence(state)) {
        var finishedTarget = state.target;
        finalizeInProgressEntry(finishedTarget, 'complete');
        state.lastDone = Game.time;
        resetState(state, { target: finishedTarget, outcome: 'complete', at: Game.time });
        recordStatus(state, 'Expansion complete ' + finishedTarget);
    }
}

function drawVisuals(state) {
    if (!CFG.DEBUG_DRAW || !state || !state.target) return;
    if (typeof Game === 'undefined') return;
    var mainRoom = state.mainRoom ? Game.rooms[state.mainRoom] : null;
    var targetRoom = Game.rooms ? Game.rooms[state.target] : null;
    var label = 'EXP→ ' + state.target + ' [' + state.phase + ']';
    if (mainRoom && mainRoom.visual) {
        try {
            mainRoom.visual.text(label, 2, 1, {
                color: CFG.DRAW.TEXT,
                font: CFG.DRAW.FONT,
                opacity: CFG.DRAW.OPACITY,
                align: 'left'
            });
        } catch (drawErr) {}
    }
    if (targetRoom && targetRoom.visual) {
        try {
            targetRoom.visual.text('← ' + (state.mainRoom || '?') + ' [' + state.phase + ']', 2, 1, {
                color: CFG.DRAW.TEXT,
                font: CFG.DRAW.FONT,
                opacity: CFG.DRAW.OPACITY,
                align: 'left'
            });
            var center = new RoomPosition(25, 25, state.target);
            targetRoom.visual.circle(center, {
                radius: 1.5,
                fill: 'transparent',
                stroke: CFG.DRAW.LINE,
                opacity: CFG.DRAW.OPACITY,
                lineStyle: 'dashed'
            });
        } catch (drawErr2) {}
    }
}

function installDebugHelper() {
    if (typeof global === 'undefined') return;
    if (typeof Game === 'undefined') return;
    if (typeof Game.helpExpand === 'function' && Game.helpExpand.__managerTag === MANAGER_TAG) {
        return;
    }
    Game.helpExpand = function () {
        var notes = [];
        var blockers = [];
        if (ExpandSelector && typeof ExpandSelector.explainBlockers === 'function') {
            try {
                blockers = ExpandSelector.explainBlockers() || [];
            } catch (ex) {
                blockers = ['explainBlockers error: ' + ex];
            }
        } else {
            blockers = ['explainBlockers unavailable'];
        }
        if (!blockers || !blockers.length) {
            notes.push('Blockers: none');
        } else {
            notes.push('Blockers: ' + blockers.join(', '));
        }
        var candidate = null;
        if (ExpandSelector && typeof ExpandSelector.canAttemptExpansion === 'function' && !ExpandSelector.canAttemptExpansion()) {
            candidate = null;
        } else if (ExpandSelector && typeof ExpandSelector.selectExpansionTarget === 'function') {
            try {
                candidate = ExpandSelector.selectExpansionTarget();
            } catch (selErr) {
                candidate = 'select error: ' + selErr;
            }
        }
        notes.push('Next: ' + (candidate || 'none'));
        var output = notes.join(' | ');
        if (typeof console !== 'undefined' && console.log) {
            console.log('[helpExpand] ' + output);
        }
        return output;
    };
    Game.helpExpand.__managerTag = MANAGER_TAG;
}

function run() {
    installDebugHelper();
    var state = getManagerMemory();
    if (!isExpansionEnabled()) {
        if (state.phase && state.phase !== 'idle') {
            resetState(state, { reason: 'disabled', previousPhase: state.phase, target: state.target, at: Game.time });
        }
        recordStatus(state, 'Expansion disabled');
        drawVisuals(state);
        return;
    }
    if (!state.phase) state.phase = 'idle';
    if (state.phase === 'idle') {
        handleIdle(state);
    } else if (state.phase === 'claiming') {
        handleClaiming(state);
    } else if (state.phase === 'bootstrapping') {
        handleBootstrapping(state);
    } else {
        resetState(state);
    }
    drawVisuals(state);
}

module.exports = {
    run: run
};
