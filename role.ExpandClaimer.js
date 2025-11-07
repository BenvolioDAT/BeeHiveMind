// role.ExpandClaimer.js -- Expansion claimer specialist
// ------------------------------------------------------
// This dedicated role moves toward an expansion target, claims its controller,
// and optionally performs light follow-up work before retiring. The logic is
// intentionally defensive because scouts/managers may lose vision mid-run, so
// every branch checks for nulls and avoids throwing.

// Traveler augments creep.travelTo; guard against multiple load attempts.
try {
    require('Traveler');
} catch (e) {}

var BeeToolbox = require('BeeToolbox');

var normRoomName = (BeeToolbox && typeof BeeToolbox.normRoomName === 'function')
    ? BeeToolbox.normRoomName
    : function (value) {
        if (value === undefined || value === null) return null;
        return String(value).toUpperCase();
    };

var CFG = {
    DEBUG_SAY: false,
    DEBUG_DRAW: false
};

function debugSay(creep, msg) {
    if (!CFG.DEBUG_SAY || !creep || !msg) {
        return;
    }
    try {
        creep.say(msg, true);
    } catch (e) {}
}

function drawBreadcrumb(creep, text) {
    if (!CFG.DEBUG_DRAW || !creep || !creep.room || !creep.room.visual) {
        return;
    }
    try {
        creep.room.visual.text(text, creep.pos.x, creep.pos.y - 0.6, {
            color: '#f5f5f5',
            font: 0.6,
            opacity: 0.7,
            align: 'center',
            backgroundColor: '#000000',
            backgroundOpacity: 0.25
        });
    } catch (e) {}
}

function hasClaimed(creep) {
    if (!creep || !creep.memory) {
        return false;
    }
    return creep.memory.claimed === true;
}

function markClaimed(creep) {
    if (!creep || !creep.memory) {
        return;
    }
    creep.memory.claimed = true;
}

function getTargetRoom(creep) {
    if (!creep || !creep.memory) {
        return null;
    }
    var tgt = creep.memory.target;
    if (!tgt && creep.memory.targetRoom) {
        tgt = creep.memory.targetRoom;
    }
    var normalized = normRoomName(tgt);
    if (normalized) {
        creep.memory.target = normalized;
        creep.memory.targetRoom = normalized;
    }
    return normalized;
}

function moveToTargetRoom(creep, roomName) {
    if (!creep || !roomName) {
        return;
    }
    var normalized = normRoomName(roomName);
    if (!normalized) return;
    // Aim for the room center to avoid edge bouncing while we seek the controller.
    var center = new RoomPosition(25, 25, normalized);
    if (typeof creep.travelTo === 'function') {
        creep.travelTo(center);
    } else {
        creep.moveTo(center);
    }
    debugSay(creep, 'to ' + normalized);
    drawBreadcrumb(creep, '» ' + normalized);
}

function claimOrApproach(creep, controller) {
    if (!creep || !controller) {
        return;
    }
    var result = creep.claimController(controller);
    if (result === ERR_NOT_IN_RANGE) {
        if (typeof creep.travelTo === 'function') {
            creep.travelTo(controller);
        } else {
            creep.moveTo(controller);
        }
        debugSay(creep, 'claim');
        drawBreadcrumb(creep, 'claim');
        return;
    }
    if (result === OK) {
        markClaimed(creep);
        debugSay(creep, 'mine');
        drawBreadcrumb(creep, 'claimed');
    }
}

function assistBootstrap(creep) {
    if (!creep || !creep.room) {
        return;
    }
    // If we somehow have energy, help nearby construction to accelerate ramp-up.
    if (creep.store && creep.store.getUsedCapacity && creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
        var site = creep.pos.findClosestByRange(FIND_CONSTRUCTION_SITES);
        if (site) {
            if (creep.build(site) === ERR_NOT_IN_RANGE) {
                if (typeof creep.travelTo === 'function') {
                    creep.travelTo(site);
                } else {
                    creep.moveTo(site);
                }
                debugSay(creep, 'build');
                drawBreadcrumb(creep, 'build');
            }
            return;
        }
    }
    // When worn out and without duties, retire to save CPU / upkeep.
    if (creep.ticksToLive !== undefined && creep.ticksToLive < 50 && (!creep.store || !creep.store.getUsedCapacity || creep.store.getUsedCapacity() === 0)) {
        debugSay(creep, 'zzz');
        creep.suicide();
    }
}

var roleExpandClaimer = {
    run: function (creep) {
        if (!creep || creep.spawning) {
            return;
        }

        if (!creep.memory._expandAnnounce) {
            try {
                creep.say('EX-CLM', true);
            } catch (announceErr) {}
            var stamp = (typeof Game !== 'undefined' && typeof Game.time === 'number') ? Game.time : true;
            creep.memory._expandAnnounce = stamp;
        }

        // Core decision tree:
        // 1. Without a target, we deliberately idle so the manager can recycle/retask us.
        // 2. If we have a target but are outside the room, march toward the center to
        //    acquire vision and avoid edge thrashing.
        // 3. Once inside, claim the controller if it is not yet ours. Successful claims
        //    set a sticky memory flag so the manager knows this creep has completed its
        //    primary objective.
        // 4. After claiming, optionally help bootstrap construction or retire gracefully.
        var targetRoom = getTargetRoom(creep);
        if (!targetRoom) {
            // Without a target we cannot progress; idle safely.
            debugSay(creep, 'idle');
            drawBreadcrumb(creep, 'idle');
            return;
        }

        var currentRoom = (creep.room && creep.room.name) ? normRoomName(creep.room.name) : null;
        var inTargetRoom = currentRoom && targetRoom && currentRoom === targetRoom;
        if (!inTargetRoom) {
            moveToTargetRoom(creep, targetRoom);
            return;
        }

        var controller = creep.room.controller;
        if (controller && !controller.my) {
            claimOrApproach(creep, controller);
            return;
        }

        if (controller && controller.my && !hasClaimed(creep)) {
            // Controller already ours (maybe pre-claimed by another unit); mark state to avoid retries.
            markClaimed(creep);
        }

        if (hasClaimed(creep)) {
            assistBootstrap(creep);
        } else {
            // No controller to claim, linger in center awaiting vision refresh.
            moveToTargetRoom(creep, targetRoom);
        }
    }
};

module.exports = roleExpandClaimer;
