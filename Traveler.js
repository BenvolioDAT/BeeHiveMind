/**
 * To start using Traveler, require it in main.js:
 * Example: var Traveler = require('Traveler.js');
 */
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const CoreConfig = require("core.config");
const MovementOwnership = require("Movement.Ownership");
const MovementVerify = require("Movement.Verify");

function getCreepName(creep) {
    return (creep && creep.name) ? creep.name : null;
}
function getCreepRole(creep) {
    return (creep && creep.memory && creep.memory.role) ? creep.memory.role : null;
}
function getPosFields(pos, prefix = "") {
    const out = {};
    if (!pos)
        return out;
    if (pos.roomName != null)
        out[prefix + "rm"] = pos.roomName;
    if (pos.x != null)
        out[prefix + "x"] = pos.x;
    if (pos.y != null)
        out[prefix + "y"] = pos.y;
    return out;
}
function getDestFields(destination) {
    if (!destination)
        return {};
    const pos = destination.pos || destination;
    return getPosFields(pos, "d");
}
function isBorderPos(pos) {
    if (!pos)
        return false;
    return pos.x === 0 || pos.x === 49 || pos.y === 0 || pos.y === 49;
}
function verifyBase(creep, src, op) {
    const base = { c: getCreepName(creep), r: getCreepRole(creep), src: src, op: op };
    const p = getPosFields(creep && creep.pos ? creep.pos : null, "");
    if (p.rm != null)
        base.rm = p.rm;
    if (p.x != null)
        base.x = p.x;
    if (p.y != null)
        base.y = p.y;
    return base;
}
function recordMoveVerify(type, data) {
    try {
        if (!MovementVerify || typeof MovementVerify.event !== "function")
            return;
        if (MovementVerify.isEnabled && !MovementVerify.isEnabled())
            return;
        MovementVerify.event(type, data || {});
    }
    catch (e) {
    }
}
class Traveler {
    static shouldLogLunaEntry(creep) {
        if (!creep || creep.name !== "Luna" || !creep.memory)
            return false;
        let entryTick = creep.memory._roomEntryTick;
        if (typeof entryTick === "number") {
            let dt = Game.time - entryTick;
            if (dt >= 0 && dt <= 4)
                return true;
        }
        let targetRoom = creep.memory.targetRoom;
        if (targetRoom && creep.pos.roomName === targetRoom) {
            if (Traveler.isExit(creep.pos))
                return true;
        }
        return false;
    }
    /**
     * move creep to destination
     * @param creep
     * @param destination
     * @param options
     * @returns {number}
     */
    static travelTo(creep, destination, options = {}) {
        // uncomment if you would like to register hostile rooms entered
        // this.updateRoomStatus(creep.room);
        let verifyEntry = verifyBase(creep, "Traveler.travelTo", "travelTo");
        let verifyEntryDest = getDestFields(destination);
        verifyEntry.border = isBorderPos(creep && creep.pos ? creep.pos : null);
        if (verifyEntryDest.drm != null)
            verifyEntry.drm = verifyEntryDest.drm;
        if (verifyEntryDest.dx != null)
            verifyEntry.dx = verifyEntryDest.dx;
        if (verifyEntryDest.dy != null)
            verifyEntry.dy = verifyEntryDest.dy;
        recordMoveVerify("mv.travel.call", verifyEntry);
        if (!destination) {
            let destMissing = verifyBase(creep, "Traveler.travelTo", "normalize");
            destMissing.reason = "missingDestination";
            destMissing.rc = ERR_INVALID_ARGS;
            recordMoveVerify("mv.dest.bad", destMissing);
            return ERR_INVALID_ARGS;
        }
        if (creep.fatigue > 0) {
            Traveler.circle(creep.pos, "aqua", .3);
            return ERR_TIRED;
        }
        destination = this.normalizePos(destination);
        if (!destination || destination.x == null || destination.y == null || !destination.roomName) {
            let badDest = verifyBase(creep, "Traveler.travelTo", "normalize");
            badDest.reason = "normalizedInvalid";
            badDest.rc = ERR_INVALID_ARGS;
            recordMoveVerify("mv.dest.bad", badDest);
            return ERR_INVALID_ARGS;
        }
        let normOk = verifyBase(creep, "Traveler.travelTo", "normalize");
        let normDest = getDestFields(destination);
        if (normDest.drm != null)
            normOk.drm = normDest.drm;
        if (normDest.dx != null)
            normOk.dx = normDest.dx;
        if (normDest.dy != null)
            normOk.dy = normDest.dy;
        recordMoveVerify("mv.dest.norm.ok", normOk);
        // manage case where creep is nearby destination
        let rangeToDestination = creep.pos.getRangeTo(destination);
        let hasCustomRange = options.range !== undefined;
        let onExitNow = Traveler.isExit(creep.pos);
        let destinationIsExit = Traveler.isExit(destination);
        // Exit tiles are dangerous in Screeps: ending a tick on border can bounce a creep back
        // to the previous room. Stabilize inward before returning early in-range OK when possible.
        if (onExitNow && !options.flee && destination.roomName === creep.pos.roomName && !destinationIsExit) {
            let stabilize = Traveler.tryExitStabilize(creep, destination, "earlyRangeGuard", options);
            if (stabilize.attempted) {
                return stabilize.result;
            }
        }
        if (hasCustomRange && rangeToDestination <= options.range) {
            return OK;
        }
        if ((!hasCustomRange || options.range === 0) && rangeToDestination === 1) {
            // no custom range or exact-tile target: step onto the destination if adjacent
            let direction = creep.pos.getDirectionTo(destination);
            if (options.returnData) {
                options.returnData.nextPos = destination;
                options.returnData.path = direction.toString();
            }
            return MovementOwnership.move(creep, direction, "adjacentStep", "Traveler");
        }
        if (rangeToDestination <= 1) {
            return OK;
        }
        // initialize data object
        if (!creep.memory._trav) {
            delete creep.memory._travel;
            creep.memory._trav = {};
        }
        let travelData = creep.memory._trav;
        let state = this.deserializeState(travelData, destination);
        let lunaTrace = Traveler.shouldLogLunaEntry(creep);
        let invalidationReason = null;
        let hadPathAtStart = !!travelData.path;
        let previousDestination = state.destination ? new RoomPosition(state.destination.x, state.destination.y, state.destination.roomName) : null;
        let previousCoord = state.lastCoord || null;
        let justEnteredRoom = !!(previousCoord && previousCoord.roomName && previousCoord.roomName !== creep.pos.roomName);
        let onBorderNow = Traveler.isExit(creep.pos);
        if (justEnteredRoom) {
            let transEvt = verifyBase(creep, "Traveler.travelTo", "transition");
            transEvt.transition = true;
            transEvt.border = onBorderNow;
            recordMoveVerify("mv.border.transition", transEvt);
        }
        Traveler.pruneReverseHold(creep, travelData);
        let bounceState = Traveler.updateBorderBounceHistory(creep, destination, options);
        if (bounceState && bounceState.lastReason === "REPEATED_ROOM_BOUNCE" && bounceState.lastEntryTick === Game.time) {
            Traveler.logBounceHistoryDiagnostic(creep, destination, bounceState, "REPEATED_ROOM_BOUNCE", 0, false, false, null);
        }
        let bounceRecovery = Traveler.getActiveBounceRecovery(creep, destination, options);
        if (bounceRecovery && bounceRecovery.forceRepath) {
            delete travelData.path;
            delete travelData.state;
            delete travelData.reverseHold;
        }
        if (bounceRecovery && bounceRecovery.clearMoveCache && creep.memory && creep.memory._move) {
            delete creep.memory._move;
        }
        if (bounceRecovery && bounceRecovery.mode === "A" && onBorderNow) {
            let recoveryDirection = Traveler.chooseRecoveryDirection(creep);
            if (recoveryDirection) {
                let recoverEvt = verifyBase(creep, "Traveler.travelTo", "move");
                recoverEvt.reason = "bounceRecovery";
                recoverEvt.dir = recoveryDirection;
                recoverEvt.border = true;
                recordMoveVerify("mv.border.recover", recoverEvt);
                recordMoveVerify("mv.step", recoverEvt);
                let moveResult = MovementOwnership.move(creep, recoveryDirection, "bounceRecoveryStep", "Traveler");
                recoverEvt.rc = moveResult;
                recordMoveVerify("mv.step.result", recoverEvt);
                Traveler.logBounceHistoryDiagnostic(creep, destination, bounceState, "RECOVERY_INWARD_STEP", recoveryDirection, !!bounceRecovery.forceRepath, bounceRecovery.clearMoveCache, moveResult);
                return moveResult;
            }
            Traveler.logBounceHistoryDiagnostic(creep, destination, bounceState, "RECOVERY_BLOCKED", 0, !!bounceRecovery.forceRepath, bounceRecovery.clearMoveCache, ERR_BUSY);
            return ERR_BUSY;
        }

        // If some other logic moved this creep far off the recorded path, drop the
        // cached directions so we do not keep walking a stale route.
        if (travelData.path && state.lastCoord && !justEnteredRoom && !this.sameCoord(creep.pos, state.lastCoord) && !creep.pos.isNearTo(state.lastCoord)) {
            invalidationReason = "coordMismatchFar";
            delete travelData.path;
            if (onBorderNow || justEnteredRoom) {
                Traveler.logBorderDiagnostic(creep, destination, "INTENT_CONFLICT", invalidationReason, hadPathAtStart, false, null, null, false, false, true, false, previousCoord);
            }
        }
        // uncomment to visualize destination
        // this.circle(destination, "orange");
        // check if creep is stuck
        if (this.isStuck(creep, state)) {
            state.stuckCount++;
            Traveler.circle(creep.pos, "magenta", state.stuckCount * .2);
        }
        else {
            state.stuckCount = 0;
        }
        // handle case where creep is stuck
        if (options.stuckValue === undefined) {
            options.stuckValue = DEFAULT_STUCK_VALUE;
        }
        if (state.stuckCount >= options.stuckValue && Math.random() > .5) {
            options.ignoreCreeps = false;
            options.freshMatrix = true;
            invalidationReason = invalidationReason || "stuckRepath";
            delete travelData.path;
        }
        // If another system moved the creep but kept the same destination, wipe the
        // path so we recalc from the new position instead of following a stale
        // route from the previous coord.
        if (travelData.path && state.destination && this.samePos(state.destination, destination) && state.lastCoord && !justEnteredRoom && !this.sameCoord(creep.pos, state.lastCoord) && !creep.pos.isNearTo(state.lastCoord)) {
            invalidationReason = invalidationReason || "coordMismatchSameDest";
            delete travelData.path;
            state.stuckCount = 0;
            if (onBorderNow || justEnteredRoom) {
                Traveler.logBorderDiagnostic(creep, destination, "INTENT_CONFLICT", invalidationReason, hadPathAtStart, false, null, null, false, false, true, false, previousCoord);
            }
        }
        // delete path cache if destination is different
        if (!this.samePos(state.destination, destination)) {
            if (options.movingTarget && state.destination.isNearTo(destination)) {
                travelData.path += state.destination.getDirectionTo(destination);
                state.destination = destination;
            }
            else {
                invalidationReason = invalidationReason || "destinationChanged";
                delete travelData.path;
            }
        }
        if (options.repath && Math.random() < options.repath) {
            // add some chance that you will find a new path randomly
            invalidationReason = invalidationReason || "randomRepath";
            delete travelData.path;
        }
        // pathfinding
        let newPath = false;
        let pathOptions = options;
        if (bounceRecovery && bounceRecovery.forceRepath) {
            pathOptions = Object.assign({}, options);
            pathOptions.repath = 1;
            pathOptions.useFindRoute = true;
            if (bounceRecovery.avoidRoom && bounceRecovery.avoidRoom !== destination.roomName) {
                pathOptions.avoidRoom = bounceRecovery.avoidRoom;
            }
        }
        if (!travelData.path) {
            newPath = true;
            if (creep.spawning) {
                return ERR_BUSY;
            }
            state.destination = destination;
            let cpu = Game.cpu.getUsed();
            let ret = this.findTravelPath(creep.pos, destination, pathOptions);
            let cpuUsed = Game.cpu.getUsed() - cpu;
            state.cpu = _.round(cpuUsed + state.cpu);
            if (state.cpu > REPORT_CPU_THRESHOLD) {
                // see note at end of file for more info on this
                console.log(`TRAVELER: heavy cpu use: ${creep.name}, cpu: ${state.cpu} origin: ${creep.pos}, dest: ${destination}`);
            }
            let color = "orange";
            if (ret.incomplete) {
                // uncommenting this is a great way to diagnose creep behavior issues
                // console.log(`TRAVELER: incomplete path for ${creep.name}`);
                color = "red";
            }
            if (options.returnData) {
                options.returnData.pathfinderReturn = ret;
            }
            travelData.path = Traveler.serializePath(creep.pos, ret.path, color);
            state.stuckCount = 0;
        }
        if (bounceRecovery && bounceRecovery.mode === "B") {
            Traveler.logBounceHistoryDiagnostic(creep, destination, bounceState, "RECOVERY_REPATH_ONLY", 0, !!bounceRecovery.forceRepath, bounceRecovery.clearMoveCache, null);
        }
        this.serializeState(creep, destination, state, travelData);
        if (!travelData.path || travelData.path.length === 0) {
            return ERR_NO_PATH;
        }
        // consume path
        if (state.stuckCount === 0 && !newPath) {
            travelData.path = travelData.path.slice(1);
        }
        let nextDirection = parseInt(travelData.path[0], 10);
        let nextPos = null;
        let nextIsExit = false;
        let nextLeavesRoom = false;
        if (nextDirection) {
            nextPos = Traveler.positionAtDirection(creep.pos, nextDirection);
            nextIsExit = !!(nextPos && Traveler.isExit(nextPos));
            nextLeavesRoom = Traveler.isLeavingCurrentRoom(creep.pos, nextDirection);
        }
        let extraReverseGuard = Traveler.shouldApplyExtraReverseGuard(creep, travelData, nextDirection);
        let destinationInCurrentRoom = destination.roomName === creep.pos.roomName;
        let roomEntryReverseGuard = justEnteredRoom &&
            destinationInCurrentRoom &&
            !options.flee &&
            Traveler.isExit(creep.pos) &&
            nextLeavesRoom;
        let reverseByPreviousCoord = justEnteredRoom &&
            destinationInCurrentRoom &&
            !options.flee &&
            Traveler.wouldReverseExit(creep.pos, previousCoord, nextDirection);
        let aboutToReverseExit = roomEntryReverseGuard || reverseByPreviousCoord;
        if (justEnteredRoom && nextLeavesRoom && !destinationInCurrentRoom) {
            Traveler.logBorderDiagnostic(creep, destination, "TARGET_ROOM_CHANGED", invalidationReason || "none", hadPathAtStart, newPath, nextDirection, nextPos, nextIsExit, nextLeavesRoom, false, false, previousCoord);
        }
        if (aboutToReverseExit || extraReverseGuard) {
            let reasonCode = "STALE_PATH_REVERSE_EXIT";
            Traveler.logBorderDiagnostic(creep, destination, reasonCode, invalidationReason || "none", hadPathAtStart, newPath, nextDirection, nextPos, nextIsExit, nextLeavesRoom, false, false, previousCoord);
            let inwardDirection = Traveler.chooseExitStabilizeDirection(creep);
            if (inwardDirection && Traveler.canStepDirection(creep, inwardDirection)) {
                Traveler.clearReverseHold(travelData);
                if (options.returnData) {
                    options.returnData.reverseExitBlocked = true;
                }
                Traveler.logExitStabilize(creep, destination, "reverseExitBlocked", inwardDirection, OK, null, hadPathAtStart, nextDirection, !!options._hadIntentThisTick);
                Traveler.logBorderDiagnostic(creep, destination, "ROOM_ENTRY_STABILIZE", invalidationReason || "none", hadPathAtStart, newPath, inwardDirection, Traveler.positionAtDirection(creep.pos, inwardDirection), false, false, false, true, previousCoord);
                let reverseEvt = verifyBase(creep, "Traveler.reverseExitGuard", "move");
                reverseEvt.reason = "reverseExitBlocked";
                reverseEvt.dir = inwardDirection;
                reverseEvt.border = true;
                reverseEvt.transition = !!justEnteredRoom;
                recordMoveVerify("mv.reverse.block", reverseEvt);
                recordMoveVerify("mv.step", reverseEvt);
                let reverseRc = MovementOwnership.move(creep, inwardDirection, "reverseExitBlocked", "Traveler");
                reverseEvt.rc = reverseRc;
                recordMoveVerify("mv.step.result", reverseEvt);
                return reverseRc;
            }
            if (aboutToReverseExit && !extraReverseGuard) {
                Traveler.setReverseHold(creep, travelData, nextDirection);
            }
            else {
                Traveler.clearReverseHold(travelData);
            }
            delete travelData.path;
            if (options.returnData) {
                options.returnData.reverseExitBlocked = true;
            }
            Traveler.logBorderDiagnostic(creep, destination, reasonCode, invalidationReason || "none", hadPathAtStart, newPath, nextDirection, nextPos, nextIsExit, nextLeavesRoom, true, false, previousCoord);
            return ERR_BUSY;
        }
        if (options.returnData) {
            if (nextDirection) {
                let nextPos = Traveler.positionAtDirection(creep.pos, nextDirection);
                if (nextPos) {
                    options.returnData.nextPos = nextPos;
                }
            }
            options.returnData.state = state;
            options.returnData.path = travelData.path;
        }
        if (lunaTrace) {
            let destTag = `${destination.roomName}:${destination.x},${destination.y}`;
            let prevDest = previousDestination ? `${previousDestination.roomName}:${previousDestination.x},${previousDestination.y}` : "null";
            let mode = options._lunaMode || "unknown";
            console.log(`[LunaTrace] t=${Game.time} phase=traveler pos=${creep.pos.roomName}:${creep.pos.x},${creep.pos.y} mode=${mode} targetRoom=${creep.memory.targetRoom || "null"} sourceId=${creep.memory.sourceId || "null"} dest=${destTag} prevDest=${prevDest} hadPath=${hadPathAtStart ? "yes" : "no"} invalidated=${invalidationReason || "no"} newPath=${newPath ? "yes" : "no"} nextDir=${nextDirection || 0} nextPos=${nextPos ? (nextPos.roomName + ":" + nextPos.x + "," + nextPos.y) : "null"} nextIsExit=${nextIsExit ? "yes" : "no"}`);
        }
        let stepEvt = verifyBase(creep, "Traveler.travelTo", "move");
        stepEvt.reason = "pathStep";
        stepEvt.dir = nextDirection;
        stepEvt.border = isBorderPos(creep.pos);
        recordMoveVerify("mv.step", stepEvt);
        let stepRc = MovementOwnership.move(creep, nextDirection, "pathStep", "Traveler");
        stepEvt.rc = stepRc;
        recordMoveVerify("mv.step.result", stepEvt);
        return stepRc;
    }
    /**
     * make position objects consistent so that either can be used as an argument
     * @param destination
     * @returns {any}
     */
    static normalizePos(destination) {
        if (!destination)
            return null;
        if (destination instanceof RoomPosition) {
            return destination;
        }
        if (destination.pos && destination.pos.x != null && destination.pos.y != null && destination.pos.roomName) {
            return destination.pos;
        }
        if (destination.x != null && destination.y != null && destination.roomName) {
            return destination;
        }
        return null;
    }
    /**
     * check if room should be avoided by findRoute algorithm
     * @param roomName
     * @returns {RoomMemory|number}
     */
    static checkAvoid(roomName) {
        return Memory.rooms && Memory.rooms[roomName] && Memory.rooms[roomName].avoid;
    }
    /**
     * check if a position is an exit
     * @param pos
     * @returns {boolean}
     */
    static isExit(pos) {
        return pos.x === 0 || pos.y === 0 || pos.x === 49 || pos.y === 49;
    }
    /**
     * check two coordinates match
     * @param pos1
     * @param pos2
     * @returns {boolean}
     */
    static sameCoord(pos1, pos2) {
        return pos1.x === pos2.x && pos1.y === pos2.y;
    }
    /**
     * check if two positions match
     * @param pos1
     * @param pos2
     * @returns {boolean}
     */
    static samePos(pos1, pos2) {
        return this.sameCoord(pos1, pos2) && pos1.roomName === pos2.roomName;
    }
    /**
     * draw a circle at position
     * @param pos
     * @param color
     * @param opacity
     */
    static circle(pos, color, opacity) {
        new RoomVisual(pos.roomName).circle(pos, {
            radius: .45, fill: "transparent", stroke: color, strokeWidth: .15, opacity: opacity
        });
    }
    /**
     * update memory on whether a room should be avoided based on controller owner
     * @param room
     */
    static updateRoomStatus(room) {
        if (!room) {
            return;
        }
        if (room.controller) {
            if (room.controller.owner && !room.controller.my) {
                room.memory.avoid = 1;
            }
            else {
                delete room.memory.avoid;
            }
        }
    }
    /**
     * find a path from origin to destination
     * @param origin
     * @param destination
     * @param options
     * @returns {PathfinderReturn}
     */
    static findTravelPath(origin, destination, options = {}) {
        _.defaults(options, {
            ignoreCreeps: true,
            maxOps: DEFAULT_MAXOPS,
            range: 1,
        });
        if (options.movingTarget) {
            options.range = 0;
        }
        origin = this.normalizePos(origin);
        destination = this.normalizePos(destination);
        let originRoomName = origin.roomName;
        let destRoomName = destination.roomName;
        // check to see whether findRoute should be used
        let roomDistance = Game.map.getRoomLinearDistance(origin.roomName, destination.roomName);
        let allowedRooms = options.route;
        if (!allowedRooms && (options.useFindRoute || (options.useFindRoute === undefined && roomDistance > 2))) {
            let route = this.findRoute(origin.roomName, destination.roomName, options);
            if (route) {
                allowedRooms = route;
            }
        }
        let roomsSearched = 0;
        let callback = (roomName) => {
            if (allowedRooms && !allowedRooms[roomName]) {
                return false;
            }
            if (options.avoidRoom && roomName === options.avoidRoom &&
                roomName !== originRoomName && roomName !== destRoomName) {
                return false;
            }
            if (!allowedRooms && !options.allowHostile && Traveler.checkAvoid(roomName)
                && roomName !== destRoomName && roomName !== originRoomName) {
                return false;
            }
            roomsSearched++;
            let matrix;
            let room = Game.rooms[roomName];
            if (room) {
                if (options.ignoreStructures) {
                    matrix = new PathFinder.CostMatrix();
                    if (!options.ignoreCreeps) {
                        Traveler.addCreepsToMatrix(room, matrix);
                    }
                }
                else if (options.ignoreCreeps || roomName !== originRoomName) {
                    matrix = this.getStructureMatrix(room, options.freshMatrix);
                }
                else {
                    matrix = this.getCreepMatrix(room);
                }
                if (options.obstacles) {
                    matrix = matrix.clone();
                    for (let obstacle of options.obstacles) {
                        if (obstacle.pos.roomName !== roomName) {
                            continue;
                        }
                        matrix.set(obstacle.pos.x, obstacle.pos.y, 0xff);
                    }
                }
            }
            if (options.roomCallback) {
                if (!matrix) {
                    matrix = new PathFinder.CostMatrix();
                }
                let outcome = options.roomCallback(roomName, matrix.clone());
                if (outcome !== undefined) {
                    return outcome;
                }
            }
            return matrix;
        };
        let ret = PathFinder.search(origin, { pos: destination, range: options.range }, {
            maxOps: options.maxOps,
            maxRooms: options.maxRooms,
            plainCost: options.offRoad ? 1 : options.ignoreRoads ? 1 : 2,
            swampCost: options.offRoad ? 1 : options.ignoreRoads ? 5 : 10,
            roomCallback: callback,
        });
        if (!ret.incomplete || !options.ensurePath) return ret;
        if (ret.incomplete && options.avoidRoom) {
            const retryWithoutAvoid = Object.assign({}, options);
            delete retryWithoutAvoid.avoidRoom;
            return this.findTravelPath(origin, destination, retryWithoutAvoid);
        }

        // PathFinder can miss a valid short path if it avoids findRoute; retry once
        // with findRoute enabled instead of mutating the caller's options.
        if (options.useFindRoute === undefined && roomDistance <= 2) {
            console.log(`TRAVELER: path failed without findroute, trying with options.useFindRoute = true`);
            console.log(`from: ${origin}, destination: ${destination}`);
            const retryOptions = Object.assign({}, options, { useFindRoute: true });
            ret = this.findTravelPath(origin, destination, retryOptions);
            console.log(`TRAVELER: second attempt was ${ret.incomplete ? "not " : ""}successful`);
            return ret;
        }

        // TODO: handle case where a wall or other obstacle blocks the exit assumed by findRoute
        return ret;
    }
    /**
     * find a viable sequence of rooms that can be used to narrow down pathfinder's search algorithm
     * @param origin
     * @param destination
     * @param options
     * @returns {{}}
     */
    static findRoute(origin, destination, options = {}) {
        let restrictDistance = options.restrictDistance || Game.map.getRoomLinearDistance(origin, destination) + 10;
        let allowedRooms = { [origin]: true, [destination]: true };
        let highwayBias = 1;
        if (options.preferHighway) {
            highwayBias = 2.5;
            if (options.highwayBias) {
                highwayBias = options.highwayBias;
            }
        }
        let ret = Game.map.findRoute(origin, destination, {
            routeCallback: (roomName) => {
                if (options.routeCallback) {
                    let outcome = options.routeCallback(roomName);
                    if (outcome !== undefined) {
                        return outcome;
                    }
                }
                if (options.avoidRoom && roomName === options.avoidRoom &&
                    roomName !== destination && roomName !== origin) {
                    return Number.POSITIVE_INFINITY;
                }
                let rangeToRoom = Game.map.getRoomLinearDistance(origin, roomName);
                if (rangeToRoom > restrictDistance) {
                    // room is too far out of the way
                    return Number.POSITIVE_INFINITY;
                }
                if (!options.allowHostile && Traveler.checkAvoid(roomName) &&
                    roomName !== destination && roomName !== origin) {
                    // room is marked as "avoid" in room memory
                    return Number.POSITIVE_INFINITY;
                }
                let parsed;
                if (options.preferHighway) {
                    parsed = /^[WE]([0-9]+)[NS]([0-9]+)$/.exec(roomName);
                    let isHighway = (parsed[1] % 10 === 0) || (parsed[2] % 10 === 0);
                    if (isHighway) {
                        return 1;
                    }
                }
                // SK rooms are avoided when there is no vision in the room, harvested-from SK rooms are allowed
                if (!options.allowSK && !Game.rooms[roomName]) {
                    if (!parsed) {
                        parsed = /^[WE]([0-9]+)[NS]([0-9]+)$/.exec(roomName);
                    }
                    let fMod = parsed[1] % 10;
                    let sMod = parsed[2] % 10;
                    let isSK = !(fMod === 5 && sMod === 5) &&
                        ((fMod >= 4) && (fMod <= 6)) &&
                        ((sMod >= 4) && (sMod <= 6));
                    if (isSK) {
                        return 10 * highwayBias;
                    }
                }
                return highwayBias;
            },
        });
        if (!_.isArray(ret)) {
            console.log(`couldn't findRoute to ${destination}`);
            return;
        }
        for (let value of ret) {
            allowedRooms[value.room] = true;
        }
        return allowedRooms;
    }
    /**
     * check how many rooms were included in a route returned by findRoute
     * @param origin
     * @param destination
     * @returns {number}
     */
    static routeDistance(origin, destination) {
        let linearDistance = Game.map.getRoomLinearDistance(origin, destination);
        if (linearDistance >= 32) {
            return linearDistance;
        }
        let allowedRooms = this.findRoute(origin, destination);
        if (allowedRooms) {
            return Object.keys(allowedRooms).length;
        }
    }
    /**
     * build a cost matrix based on structures in the room. Will be cached for more than one tick. Requires vision.
     * @param room
     * @param freshMatrix
     * @returns {any}
     */
    static getStructureMatrix(room, freshMatrix) {
        if (!this.structureMatrixTick) this.structureMatrixTick = {};
        if (!this.structureMatrixCache[room.name] || (freshMatrix && Game.time !== this.structureMatrixTick[room.name])) {
            this.structureMatrixTick[room.name] = Game.time;
            let matrix = new PathFinder.CostMatrix();
            this.structureMatrixCache[room.name] = Traveler.addStructuresToMatrix(room, matrix, 1);
        }
        return this.structureMatrixCache[room.name];
    }
    /**
     * build a cost matrix based on creeps and structures in the room. Will be cached for one tick. Requires vision.
     * @param room
     * @returns {any}
     */
    static getCreepMatrix(room) {
        if (!this.creepMatrixTick) this.creepMatrixTick = {};
        if (!this.creepMatrixCache[room.name] || Game.time !== this.creepMatrixTick[room.name]) {
            this.creepMatrixTick[room.name] = Game.time;
            this.creepMatrixCache[room.name] = Traveler.addCreepsToMatrix(room, this.getStructureMatrix(room, true).clone());
        }
        return this.creepMatrixCache[room.name];
    }
    /**
     * add structures to matrix so that impassible structures can be avoided and roads given a lower cost
     * @param room
     * @param matrix
     * @param roadCost
     * @returns {CostMatrix}
     */
    static addStructuresToMatrix(room, matrix, roadCost) {
        let impassibleStructures = [];
        for (let structure of room.find(FIND_STRUCTURES)) {
            if (structure instanceof StructureRampart) {
                if (!structure.my && !structure.isPublic) {
                    impassibleStructures.push(structure);
                }
            }
            else if (structure instanceof StructureRoad) {
                matrix.set(structure.pos.x, structure.pos.y, roadCost);
            }
            else if (structure instanceof StructureContainer) {
                matrix.set(structure.pos.x, structure.pos.y, 5);
            }
            else {
                impassibleStructures.push(structure);
            }
        }
        for (let site of room.find(FIND_MY_CONSTRUCTION_SITES)) {
            if (site.structureType === STRUCTURE_CONTAINER || site.structureType === STRUCTURE_ROAD
                || site.structureType === STRUCTURE_RAMPART) {
                continue;
            }
            matrix.set(site.pos.x, site.pos.y, 0xff);
        }
        for (let structure of impassibleStructures) {
            matrix.set(structure.pos.x, structure.pos.y, 0xff);
        }
        return matrix;
    }
    /**
     * add creeps to matrix so that they will be avoided by other creeps
     * @param room
     * @param matrix
     * @returns {CostMatrix}
     */
    static addCreepsToMatrix(room, matrix) {
        room.find(FIND_CREEPS).forEach((creep) => matrix.set(creep.pos.x, creep.pos.y, 0xff));
        return matrix;
    }
    /**
     * serialize a path, traveler style. Returns a string of directions.
     * @param startPos
     * @param path
     * @param color
     * @returns {string}
     */
    static serializePath(startPos, path, color = "orange") {
        let serializedPath = "";
        let lastPosition = startPos;
        this.circle(startPos, color);
        for (let position of path) {
            if (position.roomName === lastPosition.roomName) {
                new RoomVisual(position.roomName)
                    .line(position, lastPosition, { color: color, lineStyle: "dashed" });
                serializedPath += lastPosition.getDirectionTo(position);
            }
            lastPosition = position;
        }
        return serializedPath;
    }
    /**
     * returns a position at a direction relative to origin
     * @param origin
     * @param direction
     * @returns {RoomPosition}
     */
    static positionAtDirection(origin, direction) {
        let offsetX = [0, 0, 1, 1, 1, 0, -1, -1, -1];
        let offsetY = [0, -1, -1, 0, 1, 1, 1, 0, -1];
        let x = origin.x + offsetX[direction];
        let y = origin.y + offsetY[direction];
        if (x > 49 || x < 0 || y > 49 || y < 0) {
            return;
        }
        return new RoomPosition(x, y, origin.roomName);
    }
    /**
     * convert room avoidance memory from the old pattern to the one currently used
     * @param cleanup
     */
    static patchMemory(cleanup = false) {
        if (!Memory.empire) {
            return;
        }
        if (!Memory.empire.hostileRooms) {
            return;
        }
        let count = 0;
        for (let roomName in Memory.empire.hostileRooms) {
            if (Memory.empire.hostileRooms[roomName]) {
                if (!Memory.rooms[roomName]) {
                    Memory.rooms[roomName] = {};
                }
                Memory.rooms[roomName].avoid = 1;
                count++;
            }
            if (cleanup) {
                delete Memory.empire.hostileRooms[roomName];
            }
        }
        if (cleanup) {
            delete Memory.empire.hostileRooms;
        }
        console.log(`TRAVELER: room avoidance data patched for ${count} rooms`);
    }
    static deserializeState(travelData, destination) {
        let state = {};
        if (travelData.state) {
            state.lastCoord = { x: travelData.state[STATE_PREV_X], y: travelData.state[STATE_PREV_Y], roomName: travelData.state[STATE_PREV_ROOMNAME] || null };
            state.cpu = travelData.state[STATE_CPU];
            state.stuckCount = travelData.state[STATE_STUCK];
            state.destination = new RoomPosition(travelData.state[STATE_DEST_X], travelData.state[STATE_DEST_Y], travelData.state[STATE_DEST_ROOMNAME]);
        }
        else {
            state.cpu = 0;
            state.destination = destination;
        }
        return state;
    }
    static serializeState(creep, destination, state, travelData) {
        travelData.state = [creep.pos.x, creep.pos.y, state.stuckCount, state.cpu, destination.x, destination.y,
            destination.roomName, creep.pos.roomName];
    }
    static inwardDirection(pos) {
        if (!pos)
            return null;
        if (pos.x === 0)
            return RIGHT;
        if (pos.x === 49)
            return LEFT;
        if (pos.y === 0)
            return BOTTOM;
        if (pos.y === 49)
            return TOP;
        return null;
    }
    static chooseExitStabilizeDirection(creep) {
        if (!creep || !Traveler.isExit(creep.pos))
            return 0;
        let preferred = Traveler.inwardDirection(creep.pos);
        let dirs = [];
        if (preferred)
            dirs.push(preferred);
        if (creep.pos.x === 0 && creep.pos.y === 0)
            dirs.push(BOTTOM_RIGHT, RIGHT, BOTTOM);
        else if (creep.pos.x === 0 && creep.pos.y === 49)
            dirs.push(TOP_RIGHT, RIGHT, TOP);
        else if (creep.pos.x === 49 && creep.pos.y === 0)
            dirs.push(BOTTOM_LEFT, LEFT, BOTTOM);
        else if (creep.pos.x === 49 && creep.pos.y === 49)
            dirs.push(TOP_LEFT, LEFT, TOP);
        else if (creep.pos.x === 0)
            dirs.push(TOP_RIGHT, BOTTOM_RIGHT);
        else if (creep.pos.x === 49)
            dirs.push(TOP_LEFT, BOTTOM_LEFT);
        else if (creep.pos.y === 0)
            dirs.push(BOTTOM_LEFT, BOTTOM_RIGHT);
        else if (creep.pos.y === 49)
            dirs.push(TOP_LEFT, TOP_RIGHT);
        let unique = _.uniq(dirs);
        for (let d of unique) {
            if (Traveler.canStepDirection(creep, d))
                return d;
        }
        return 0;
    }
    static tryExitStabilize(creep, destination, reasonCode, options = {}) {
        if (!creep || !Traveler.isExit(creep.pos) || creep.fatigue > 0 || options.flee) {
            return { attempted: false, result: ERR_INVALID_TARGET };
        }
        let dir = Traveler.chooseExitStabilizeDirection(creep);
        if (!dir)
            return { attempted: true, result: ERR_BUSY, direction: 0 };
        let stabilizeEvt = verifyBase(creep, "Traveler.tryExitStabilize", "move");
        stabilizeEvt.reason = reasonCode || "exitStabilize";
        stabilizeEvt.dir = dir;
        stabilizeEvt.border = true;
        recordMoveVerify("mv.border.recover", stabilizeEvt);
        recordMoveVerify("mv.step", stabilizeEvt);
        let result = MovementOwnership.move(creep, dir, reasonCode, "Traveler");
        stabilizeEvt.rc = result;
        recordMoveVerify("mv.step.result", stabilizeEvt);
        if (options.returnData) {
            options.returnData.exitStabilize = true;
            options.returnData.exitStabilizeDir = dir;
        }
        Traveler.logExitStabilize(creep, destination, reasonCode, dir, result, null, !!(creep.memory && creep.memory._trav && creep.memory._trav.path), 0, !!options._hadIntentThisTick);
        return { attempted: true, result: result, direction: dir };
    }
    static wouldReverseExit(currentPos, previousCoord, direction) {
        if (!currentPos || !previousCoord || !direction)
            return false;
        if (!Traveler.isExit(currentPos))
            return false;
        if (currentPos.x === 0 && direction === LEFT && previousCoord.x === 49)
            return true;
        if (currentPos.x === 49 && direction === RIGHT && previousCoord.x === 0)
            return true;
        if (currentPos.y === 0 && direction === TOP && previousCoord.y === 49)
            return true;
        if (currentPos.y === 49 && direction === BOTTOM && previousCoord.y === 0)
            return true;
        return false;
    }
    static canStepDirection(creep, direction) {
        if (!creep || !direction)
            return false;
        let target = Traveler.positionAtDirection(creep.pos, direction);
        if (!target)
            return false;
        let terrain = Game.map.getRoomTerrain(creep.pos.roomName);
        if (terrain.get(target.x, target.y) === TERRAIN_MASK_WALL)
            return false;
        if (creep.room) {
            let structures = creep.room.lookForAt(LOOK_STRUCTURES, target.x, target.y) || [];
            for (let s of structures) {
                if (s.structureType !== STRUCTURE_ROAD &&
                    s.structureType !== STRUCTURE_CONTAINER &&
                    !(s.structureType === STRUCTURE_RAMPART && s.my)) {
                    return false;
                }
            }
            let blockingCreeps = creep.room.lookForAt(LOOK_CREEPS, target.x, target.y) || [];
            for (let c of blockingCreeps) {
                if (c.id !== creep.id)
                    return false;
            }
            if (typeof LOOK_POWER_CREEPS !== "undefined") {
                let blockingPowerCreeps = creep.room.lookForAt(LOOK_POWER_CREEPS, target.x, target.y) || [];
                for (let pc of blockingPowerCreeps) {
                    if (pc.id !== creep.id)
                        return false;
                }
            }
        }
        return true;
    }
    static setReverseHold(creep, travelData, blockedDir) {
        if (!creep || !travelData || !blockedDir)
            return;
        travelData.reverseHold = {
            tick: Game.time,
            roomName: creep.pos.roomName,
            x: creep.pos.x,
            y: creep.pos.y,
            blockedDir: blockedDir
        };
    }
    static clearReverseHold(travelData) {
        if (!travelData)
            return;
        delete travelData.reverseHold;
    }
    static pruneReverseHold(creep, travelData) {
        if (!creep || !travelData || !travelData.reverseHold)
            return;
        let h = travelData.reverseHold;
        let stale = (Game.time > (h.tick + 1)) ||
            h.roomName !== creep.pos.roomName ||
            h.x !== creep.pos.x ||
            h.y !== creep.pos.y;
        if (stale) {
            delete travelData.reverseHold;
        }
    }
    static shouldApplyExtraReverseGuard(creep, travelData, direction) {
        if (!creep || !travelData || !travelData.reverseHold || !direction)
            return false;
        let h = travelData.reverseHold;
        if (Game.time !== (h.tick + 1))
            return false;
        if (h.roomName !== creep.pos.roomName || h.x !== creep.pos.x || h.y !== creep.pos.y)
            return false;
        return h.blockedDir === direction;
    }
    static movementBounceConfig() {
        let movementCfg = CoreConfig && CoreConfig.settings ? CoreConfig.settings.movement : null;
        return {
            enabled: !!((movementCfg && movementCfg.MOVEMENT_BOUNCE_HISTORY_ENABLED !== undefined)
                ? movementCfg.MOVEMENT_BOUNCE_HISTORY_ENABLED
                : (CoreConfig && CoreConfig.MOVEMENT_BOUNCE_HISTORY_ENABLED)),
            window: (movementCfg && movementCfg.MOVEMENT_BOUNCE_HISTORY_WINDOW) || CoreConfig.MOVEMENT_BOUNCE_HISTORY_WINDOW || 6,
            recoveryTicks: (movementCfg && movementCfg.MOVEMENT_BOUNCE_RECOVERY_TICKS) || CoreConfig.MOVEMENT_BOUNCE_RECOVERY_TICKS || 5,
            debug: !!((movementCfg && movementCfg.DEBUG_MOVEMENT_BOUNCE_HISTORY) || (CoreConfig && CoreConfig.DEBUG_MOVEMENT_BOUNCE_HISTORY)),
            logInterval: (movementCfg && movementCfg.MOVEMENT_BOUNCE_LOG_INTERVAL) || 5
        };
    }
    static isNearBorder(pos, margin = 1) {
        if (!pos)
            return false;
        return pos.x <= margin || pos.x >= (49 - margin) || pos.y <= margin || pos.y >= (49 - margin);
    }
    static updateBorderBounceHistory(creep, destination, options) {
        if (!creep || !creep.memory || !destination || !destination.roomName)
            return null;
        let cfg = Traveler.movementBounceConfig();
        if (!cfg.enabled) {
            delete creep.memory._borderBounce;
            return null;
        }
        let b = creep.memory._borderBounce || {};
        if (!b.lastPositions)
            b.lastPositions = [];
        if (!b.transitions)
            b.transitions = [];
        b.lastPositions.push({
            t: Game.time,
            room: creep.pos.roomName,
            x: creep.pos.x,
            y: creep.pos.y
        });
        while (b.lastPositions.length > 6)
            b.lastPositions.shift();
        let roomChanged = !!(b.lastRoom && b.lastRoom !== creep.pos.roomName);
        if (roomChanged) {
            b.previousRoom = b.lastRoom;
            b.lastEntryTick = Game.time;
            b.transitions.push({ t: Game.time, from: b.lastRoom, to: creep.pos.roomName });
        }
        b.lastRoom = creep.pos.roomName;
        while (b.transitions.length > 6)
            b.transitions.shift();
        let repeated = false;
        if (b.transitions.length >= 3) {
            let t0 = b.transitions[b.transitions.length - 3];
            let t1 = b.transitions[b.transitions.length - 2];
            let t2 = b.transitions[b.transitions.length - 1];
            let inWindow = (Game.time - t0.t) <= cfg.window;
            let alternates = t0.from === t1.to && t0.to === t1.from && t2.from === t1.to && t2.to === t1.from;
            repeated = inWindow && alternates;
        }
        if (!b.bounceCount)
            b.bounceCount = 0;
        if (repeated)
            b.bounceCount++;
        if (repeated &&
            roomChanged &&
            Traveler.isNearBorder(creep.pos, 1) &&
            !options.flee &&
            destination.roomName !== creep.pos.roomName) {
            b.recoveryUntil = Game.time + cfg.recoveryTicks;
            b.repathUntil = Game.time + cfg.recoveryTicks;
            b.clearMoveUntil = Game.time + 1;
            b.lastReason = "REPEATED_ROOM_BOUNCE";
            b.mode = "B";
            b.avoidRoom = null;
            b.avoidRoomUntil = 0;
        }
        if (repeated &&
            roomChanged &&
            Traveler.isNearBorder(creep.pos, 1) &&
            !options.flee &&
            destination.roomName === creep.pos.roomName) {
            b.recoveryUntil = Game.time + cfg.recoveryTicks;
            b.repathUntil = Game.time + cfg.recoveryTicks;
            b.clearMoveUntil = Game.time + 1;
            b.lastReason = "REPEATED_ROOM_BOUNCE";
            b.mode = "A";
            let avoidCandidate = b.previousRoom || null;
            if (avoidCandidate && avoidCandidate !== destination.roomName) {
                b.avoidRoom = avoidCandidate;
                b.avoidRoomUntil = Game.time + Math.min(cfg.recoveryTicks, 5);
            }
            else {
                b.avoidRoom = null;
                b.avoidRoomUntil = 0;
            }
        }
        if (b.avoidRoom && b.avoidRoomUntil && Game.time > b.avoidRoomUntil) {
            b.avoidRoom = null;
            b.avoidRoomUntil = 0;
        }
        if (!b.recoveryUntil || Game.time > b.recoveryUntil) {
            delete b.mode;
        }
        let idleTicks = Game.time - (b.lastEntryTick || Game.time);
        if (idleTicks > (cfg.window * 3) && (!b.recoveryUntil || Game.time > b.recoveryUntil)) {
            delete creep.memory._borderBounce;
            return null;
        }
        creep.memory._borderBounce = b;
        return b;
    }
    static getActiveBounceRecovery(creep, destination, options) {
        if (!creep || !creep.memory || !creep.memory._borderBounce)
            return null;
        if (!destination || options.flee)
            return null;
        let b = creep.memory._borderBounce;
        if (!b.recoveryUntil || Game.time > b.recoveryUntil)
            return null;
        let currentRoom = creep.pos.roomName;
        if (b.mode === "A" && currentRoom !== destination.roomName)
            return null;
        if (b.mode === "B" && currentRoom === destination.roomName)
            return null;
        let avoidRoom = null;
        if (b.avoidRoom && b.avoidRoomUntil && Game.time <= b.avoidRoomUntil && b.avoidRoom !== destination.roomName) {
            avoidRoom = b.avoidRoom;
        }
        return {
            mode: b.mode || null,
            avoidRoom: avoidRoom,
            forceRepath: !!(b.repathUntil && Game.time <= b.repathUntil),
            clearMoveCache: !!(b.clearMoveUntil && Game.time <= b.clearMoveUntil)
        };
    }
    static chooseRecoveryDirection(creep) {
        if (!creep || !Traveler.isExit(creep.pos))
            return 0;
        let dirs = [];
        if (creep.pos.x === 0 && creep.pos.y === 0)
            dirs = [BOTTOM_RIGHT, RIGHT, BOTTOM];
        else if (creep.pos.x === 0 && creep.pos.y === 49)
            dirs = [TOP_RIGHT, RIGHT, TOP];
        else if (creep.pos.x === 49 && creep.pos.y === 0)
            dirs = [BOTTOM_LEFT, LEFT, BOTTOM];
        else if (creep.pos.x === 49 && creep.pos.y === 49)
            dirs = [TOP_LEFT, LEFT, TOP];
        else if (creep.pos.x === 0)
            dirs = [RIGHT, TOP_RIGHT, BOTTOM_RIGHT];
        else if (creep.pos.x === 49)
            dirs = [LEFT, TOP_LEFT, BOTTOM_LEFT];
        else if (creep.pos.y === 0)
            dirs = [BOTTOM, BOTTOM_LEFT, BOTTOM_RIGHT];
        else if (creep.pos.y === 49)
            dirs = [TOP, TOP_LEFT, TOP_RIGHT];
        for (let d of dirs) {
            if (Traveler.canStepDirection(creep, d))
                return d;
        }
        return 0;
    }
    static isLeavingCurrentRoom(pos, direction) {
        if (!pos || !direction)
            return false;
        let offsetX = [0, 0, 1, 1, 1, 0, -1, -1, -1];
        let offsetY = [0, -1, -1, 0, 1, 1, 1, 0, -1];
        let dx = offsetX[direction] || 0;
        let dy = offsetY[direction] || 0;
        let nextX = pos.x + dx;
        let nextY = pos.y + dy;
        return nextX < 0 || nextX > 49 || nextY < 0 || nextY > 49;
    }
    static shouldLogBounce(creep, travelData) {
        let movementCfg = CoreConfig && CoreConfig.settings ? CoreConfig.settings.movement : null;
        let enabled = !!((CoreConfig && (CoreConfig.DEBUG_MOVEMENT_BOUNCE || CoreConfig.DEBUG_TRAVELER_BOUNCE)) ||
            (movementCfg && (movementCfg.DEBUG_MOVEMENT_BOUNCE || movementCfg.DEBUG_TRAVELER_BOUNCE)));
        if (!enabled || !creep || !travelData)
            return false;
        let interval = (movementCfg && typeof movementCfg.BOUNCE_DEBUG_LOG_INTERVAL === "number")
            ? movementCfg.BOUNCE_DEBUG_LOG_INTERVAL
            : 5;
        if (travelData._bounceLogTick != null && Game.time < (travelData._bounceLogTick + interval)) {
            return false;
        }
        travelData._bounceLogTick = Game.time;
        return true;
    }
    static shouldLogBounceHistory(creep) {
        let cfg = Traveler.movementBounceConfig();
        if (!cfg.debug || !creep || !creep.memory || !creep.memory._borderBounce)
            return false;
        let b = creep.memory._borderBounce;
        if (b._logTick != null && Game.time < (b._logTick + cfg.logInterval))
            return false;
        b._logTick = Game.time;
        return true;
    }
    static logBounceHistoryDiagnostic(creep, destination, bounceState, reasonCode, inwardDirection, pathCleared, moveCleared, resultCode) {
        if (!Traveler.shouldLogBounceHistory(creep))
            return;
        let b = bounceState || (creep.memory && creep.memory._borderBounce) || {};
        let roleName = creep.memory && creep.memory.role ? creep.memory.role : "unknown";
        let hist = (b.lastPositions || []).map((p) => `${p.room}:${p.x},${p.y}@${p.t}`).join(">");
        let res = (resultCode != null) ? resultCode : "na";
        console.log(`[TravelerBounceHistory] t=${Game.time} creep=${creep.name} role=${roleName} room=${creep.pos.roomName} prevRoom=${b.previousRoom || "unknown"} targetRoom=${destination ? destination.roomName : "none"} pos=${creep.pos.roomName}:${creep.pos.x},${creep.pos.y} history=${hist || "none"} bounceCount=${b.bounceCount || 0} avoidRoom=${b.avoidRoom || "none"} recoveryUntil=${b.recoveryUntil || 0} pathCleared=${pathCleared ? "yes" : "no"} moveCleared=${moveCleared ? "yes" : "no"} inwardDir=${inwardDirection || 0} result=${res} reason=${reasonCode || "none"}`);
    }
    static logBorderDiagnostic(creep, destination, reasonCode, invalidationReason, hadPath, newPath, nextDirection, nextPos, nextIsExit, nextLeavesRoom, cacheInvalidated, inwardNudgeUsed, previousCoord) {
        if (!creep || !destination)
            return;
        let travelData = creep.memory && creep.memory._trav ? creep.memory._trav : null;
        if (!Traveler.shouldLogBounce(creep, travelData))
            return;
        let pos = creep.pos;
        let justEntered = !!(previousCoord && previousCoord.roomName && previousCoord.roomName !== pos.roomName);
        if (!Traveler.isExit(pos) && !justEntered)
            return;
        let targetRoom = creep.memory ? creep.memory.targetRoom : null;
        let roleName = creep.memory && creep.memory.role ? creep.memory.role : "unknown";
        let prevTag = previousCoord ? `${previousCoord.roomName || "?"}:${previousCoord.x},${previousCoord.y}` : "null";
        let nextTag = nextPos ? `${nextPos.roomName}:${nextPos.x},${nextPos.y}` : "null";
        console.log(`[TravelerBounce] t=${Game.time} creep=${creep.name} role=${roleName} room=${pos.roomName} prevRoom=${previousCoord && previousCoord.roomName ? previousCoord.roomName : "unknown"} targetRoom=${targetRoom || "none"} pos=${pos.roomName}:${pos.x},${pos.y} dest=${destination.roomName}:${destination.x},${destination.y} prev=${prevTag} nextDir=${nextDirection || 0} nextPos=${nextTag} nextIsExit=${nextIsExit ? "yes" : "no"} nextLeavesRoom=${nextLeavesRoom ? "yes" : "no"} cacheInvalidated=${cacheInvalidated ? "yes" : "no"} inwardNudge=${inwardNudgeUsed ? "yes" : "no"} hadPath=${hadPath ? "yes" : "no"} newPath=${newPath ? "yes" : "no"} invalid=${invalidationReason || "none"} reason=${reasonCode || "none"}`);
    }
    static shouldLogExitStabilize(creep) {
        let movementCfg = CoreConfig && CoreConfig.settings ? CoreConfig.settings.movement : null;
        if (!movementCfg || !movementCfg.DEBUG_EXIT_STABILIZE || !creep)
            return false;
        let roles = movementCfg.DEBUG_EXIT_STABILIZE_ROLES || [];
        let roleName = (creep.memory && creep.memory.role) || "unknown";
        if (roles.length && roles.indexOf(roleName) === -1)
            return false;
        let interval = (typeof movementCfg.DEBUG_EXIT_STABILIZE_INTERVAL === "number") ? movementCfg.DEBUG_EXIT_STABILIZE_INTERVAL : 1;
        let travelData = creep.memory && creep.memory._trav ? creep.memory._trav : null;
        if (!travelData)
            return false;
        if (travelData._exitLogTick != null && Game.time < (travelData._exitLogTick + interval))
            return false;
        travelData._exitLogTick = Game.time;
        return true;
    }
    static logExitStabilize(creep, destination, reason, dir, result, blockedBy, hadPath, nextDir, hadIntentThisTick) {
        if (!Traveler.shouldLogExitStabilize(creep))
            return;
        let roleName = (creep.memory && creep.memory.role) || "unknown";
        let destTag = destination ? `${destination.roomName}:${destination.x},${destination.y}` : "none";
        console.log(`[ExitStabilize] t=${Game.time} creep=${creep.name} role=${roleName} pos=${creep.pos.roomName}:${creep.pos.x},${creep.pos.y} dest=${destTag} reason=${reason} dir=${dir || 0} result=${result} blockedBy=${blockedBy || "null"} hadPath=${hadPath ? "yes" : "no"} nextDir=${nextDir || 0} hadIntentThisTick=${hadIntentThisTick ? "yes" : "no"}`);
    }
    static isStuck(creep, state) {
        let stuck = false;
        if (state.lastCoord !== undefined) {
            if (this.sameCoord(creep.pos, state.lastCoord)) {
                // didn't move
                stuck = true;
            }
            else if (this.isExit(creep.pos) && this.isExit(state.lastCoord)) {
                // moved against exit
                stuck = true;
            }
        }
        return stuck;
    }
}
Traveler.structureMatrixCache = {};
Traveler.creepMatrixCache = {};
exports.Traveler = Traveler;
// this might be higher than you wish, setting it lower is a great way to diagnose creep behavior issues. When creeps
// need to repath to often or they aren't finding valid paths, it can sometimes point to problems elsewhere in your code
const REPORT_CPU_THRESHOLD = 1000;
const DEFAULT_MAXOPS = 20000;
const DEFAULT_STUCK_VALUE = 2;
const STATE_PREV_X = 0;
const STATE_PREV_Y = 1;
const STATE_STUCK = 2;
const STATE_CPU = 3;
const STATE_DEST_X = 4;
const STATE_DEST_Y = 5;
const STATE_DEST_ROOMNAME = 6;
const STATE_PREV_ROOMNAME = 7;
// assigns a function to Creep.prototype: creep.travelTo(destination)
Creep.prototype.travelTo = function (destination, options) {
    return Traveler.travelTo(this, destination, options);
};
