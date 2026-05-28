/**
 * To start using Traveler, require it in main.js:
 * Example: var Traveler = require('Traveler.js');
 */
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const CoreConfig = require("core.config");
class Traveler {
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
        if (!destination) {
            return ERR_INVALID_ARGS;
        }
        if (creep.fatigue > 0) {
            Traveler.circle(creep.pos, "aqua", .3);
            return ERR_TIRED;
        }
        destination = this.normalizePos(destination);
        // manage case where creep is nearby destination
        let rangeToDestination = creep.pos.getRangeTo(destination);
        let hasCustomRange = options.range !== undefined;
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
            return creep.move(direction);
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

        // If some other logic moved this creep far off the recorded path, drop the
        // cached directions so we do not keep walking a stale route.
        if (travelData.path && state.lastCoord && !this.sameCoord(creep.pos, state.lastCoord) && !creep.pos.isNearTo(state.lastCoord)) {
            delete travelData.path;
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
            delete travelData.path;
        }
        // If another system moved the creep but kept the same destination, wipe the
        // path so we recalc from the new position instead of following a stale
        // route from the previous coord.
        if (travelData.path && state.destination && this.samePos(state.destination, destination) && state.lastCoord && !this.sameCoord(creep.pos, state.lastCoord)) {
            delete travelData.path;
            state.stuckCount = 0;
        }
        // delete path cache if destination is different
        if (!this.samePos(state.destination, destination)) {
            if (options.movingTarget && state.destination.isNearTo(destination)) {
                travelData.path += state.destination.getDirectionTo(destination);
                state.destination = destination;
            }
            else {
                delete travelData.path;
            }
        }
        if (options.repath && Math.random() < options.repath) {
            // add some chance that you will find a new path randomly
            delete travelData.path;
        }
        // pathfinding
        let newPath = false;
        if (!travelData.path) {
            newPath = true;
            if (creep.spawning) {
                return ERR_BUSY;
            }
            state.destination = destination;
            if (this.shouldSkipFreshPathSearch(options)) {
                state.cpu = 0;
                if (options.returnData) {
                    options.returnData.pathfinderSkipped = "cpu-budget";
                }
                this.serializeState(creep, destination, state, travelData);
                return ERR_BUSY;
            }
            let cpu = Game.cpu.getUsed();
            let ret = this.findTravelPath(creep.pos, destination, options);
            let cpuUsed = Game.cpu.getUsed() - cpu;
            if (ret.incomplete && (!ret.path || ret.path.length === 0)) {
                delete travelData.path;
                // Avoid stale cumulative heavy-cpu warnings when this tick's
                // result is a cheap fast-fail no-route response.
                state.cpu = 0;
                this.logNoRouteLimited(creep.pos.roomName, destination.roomName, ret.reason || "empty-incomplete-path", creep.name);
                if (options.returnData) {
                    options.returnData.pathfinderReturn = ret;
                }
                this.serializeState(creep, destination, state, travelData);
                return ERR_NO_PATH;
            }
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
        this.serializeState(creep, destination, state, travelData);
        if (!travelData.path || travelData.path.length === 0) {
            return ERR_NO_PATH;
        }
        // consume path
        if (state.stuckCount === 0 && !newPath) {
            travelData.path = travelData.path.slice(1);
        }
        let nextDirection = parseInt(travelData.path[0], 10);
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
        return creep.move(nextDirection);
    }
    /**
     * make position objects consistent so that either can be used as an argument
     * @param destination
     * @returns {any}
     */
    static normalizePos(destination) {
        if (!(destination instanceof RoomPosition)) {
            return destination.pos;
        }
        return destination;
    }
    static shouldSkipFreshPathSearch(options = {}) {
        if (options.ignoreCpuGuard) return false;
        const intentType = options.intentType || "";
        if (intentType === "emergency" || intentType === "combat" || intentType === "attack" ||
            intentType === "rangedAttack" || intentType === "heal" || intentType === "rangedHeal") {
            return false;
        }
        const settings = CoreConfig && CoreConfig.settings && CoreConfig.settings.movement ? CoreConfig.settings.movement : {};
        const guard = Number(settings.freshPathCpuGuard || 0);
        if (!(guard > 0)) return false;
        try {
            if (!Game.cpu || typeof Game.cpu.getUsed !== "function") return false;
            const minBucket = Number(settings.freshPathMinBucket || 0);
            if (minBucket > 0 && typeof Game.cpu.bucket === "number" && Game.cpu.bucket < minBucket) return true;
            const useLimit = settings.freshPathUseCpuLimit !== false;
            const baseline = useLimit ? Number(Game.cpu.limit || Game.cpu.tickLimit || 0) : Number(Game.cpu.tickLimit || Game.cpu.limit || 0);
            if (!(baseline > 0)) return false;
            return Game.cpu.getUsed() >= Math.max(0, baseline - guard);
        }
        catch (err) {
            return false;
        }
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
    static getMovementSettings() {
        return (CoreConfig && CoreConfig.settings && CoreConfig.settings.movement) || {};
    }
    static getNoRouteCache() {
        if (!global.__BHM_TRAVEL_NO_ROUTE || typeof global.__BHM_TRAVEL_NO_ROUTE !== "object") {
            global.__BHM_TRAVEL_NO_ROUTE = {};
        }
        return global.__BHM_TRAVEL_NO_ROUTE;
    }
    static getRoomStatusSafe(roomName) {
        if (!roomName || !Game.map || typeof Game.map.getRoomStatus !== "function") {
            return null;
        }
        try {
            return Game.map.getRoomStatus(roomName) || null;
        }
        catch (e) {
            return null;
        }
    }
    static isRoomClosed(roomName) {
        const status = this.getRoomStatusSafe(roomName);
        return !!(status && status.status === "closed");
    }
    static hasDirectExitBetween(fromRoomName, toRoomName) {
        if (!fromRoomName || !toRoomName || !Game.map || typeof Game.map.describeExits !== "function") {
            return false;
        }
        let exits;
        try {
            exits = Game.map.describeExits(fromRoomName);
        }
        catch (e) {
            exits = null;
        }
        if (!exits) {
            return false;
        }
        for (const direction in exits) {
            if (exits[direction] === toRoomName) {
                return true;
            }
        }
        return false;
    }
    static rememberNoRoute(originRoomName, destRoomName, reason) {
        if (!originRoomName || !destRoomName) return;
        const cache = this.getNoRouteCache();
        const key = `${originRoomName}>${destRoomName}`;
        cache[key] = { tick: Game.time, reason: reason || "unknown" };
        this.logNoRouteLimited(originRoomName, destRoomName, reason);
    }
    static isNoRouteRecentlyKnown(originRoomName, destRoomName) {
        const cache = this.getNoRouteCache();
        const key = `${originRoomName}>${destRoomName}`;
        const rec = cache[key];
        if (!rec || typeof rec.tick !== "number") return false;
        const settings = this.getMovementSettings();
        const ttl = settings.NO_ROUTE_CACHE_TTL || 150;
        if ((Game.time - rec.tick) > ttl) {
            delete cache[key];
            return false;
        }
        return true;
    }
    static logNoRouteLimited(originRoomName, destRoomName, reason, creepName) {
        const settings = this.getMovementSettings();
        if (!settings.DEBUG_NO_ROUTE) return;
        if (!global.__BHM_TRAVEL_NO_ROUTE_LOG || typeof global.__BHM_TRAVEL_NO_ROUTE_LOG !== "object") {
            global.__BHM_TRAVEL_NO_ROUTE_LOG = {};
        }
        const key = `${originRoomName}>${destRoomName}:${reason || "unknown"}`;
        const interval = settings.NO_ROUTE_LOG_INTERVAL || 250;
        const last = global.__BHM_TRAVEL_NO_ROUTE_LOG[key] || 0;
        if ((Game.time - last) < interval) return;
        global.__BHM_TRAVEL_NO_ROUTE_LOG[key] = Game.time;
        console.log(`[TravelerNoRoute] ${creepName || "unknown"} ${originRoomName} -> ${destRoomName} reason=${reason || "unknown"}`);
    }
    static makeNoPathResult(reason) {
        return { path: [], ops: 0, cost: 0, incomplete: true, reason: reason || "no-path" };
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
        if (originRoomName !== destRoomName) {
            if (this.isRoomClosed(destRoomName)) {
                this.rememberNoRoute(originRoomName, destRoomName, "closed-room");
                return this.makeNoPathResult("closed-room");
            }
            if (this.isNoRouteRecentlyKnown(originRoomName, destRoomName)) {
                return this.makeNoPathResult("cached-no-route");
            }
            if (roomDistance === 1 && !this.hasDirectExitBetween(originRoomName, destRoomName)) {
                this.rememberNoRoute(originRoomName, destRoomName, "missing-direct-exit");
                return this.makeNoPathResult("missing-direct-exit");
            }
            if (!allowedRooms) {
                let route = this.findRoute(originRoomName, destRoomName, options);
                if (!route || !_.isObject(route)) {
                    this.rememberNoRoute(originRoomName, destRoomName, "findRoute-failed");
                    return this.makeNoPathResult("findRoute-failed");
                }
                allowedRooms = route;
            }
        }
        let roomsSearched = 0;
        let callback = (roomName) => {
            if (allowedRooms && !allowedRooms[roomName]) {
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
            state.lastCoord = { x: travelData.state[STATE_PREV_X], y: travelData.state[STATE_PREV_Y] };
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
            destination.roomName];
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
// assigns a function to Creep.prototype: creep.travelTo(destination)
Creep.prototype.travelTo = function (destination, options) {
    return Traveler.travelTo(this, destination, options);
};
