//Planner.Road.JS
// Plans & drip-places road construction sites from home to remote sources.

const RoadPlanner = {
    //main entry: call this every tick (super cheap when idle)
    ensureRemoteRoads(homeRoom) {
        if (!homeRoom || !homeRoom.controller || !homeRoom.controller.my) return;

        const mem = RoadPlanner._memory(homeRoom);
        const spawns = homeRoom.find(FIND_MY_SPAWNS);
        if (!spawns.length) return;
        const anchor = spawns[0].pos;

        //discover active remote rooms from your currently assigned creeps
        const activeRemotes = _.uniq(
            _.filter(Game.creeps, c => c.memory.task === 'remoteharvest' && c.memory.targetRoom)
            .map(c => c.memory.targetRoom)
        );

        for (const remote of activeRemotes) {
            const rmem = Memory.rooms[remote];
            if (!rmem || !rmem.sources) continue; //BeeToolbox.logSourcesInRoom fills this when you have vision

            //If we can see the room, we can obtain real source positions now
            const remoteRoomObj = Game.rooms[remote];
            if (!remoteRoomObj) continue; // need vision to place inside that room

            const sources = remoteRoomObj.find(FIND_SOURCES);
            for (const src of sources) {
                const key =`${remote}:${src.id}`;
                if (!mem.paths[key]) {
                    //plan (one big cross-room PathFinder search)
                    const ret = PathFinder.search(
                       anchor,
                       { pos: src.pos, range: 1 },
                       {
                        plainCost: 2,
                        swampCost: 10,
                        roomCallback: (roomName) => {
                            const room = Game.rooms[roomName];
                            if (!room) return; // undefined -> use fefault costs
                            const costs = new PathFinder.CostMatrix();
                            // prefer existing roads
                            room.find(FIND_STRUCTURES).forEach(s => {
                                if (s.structureType === STRUCTURE_ROAD) costs.set(s.pos.x, s.pos.y, 1);
                                else if (
                                    s.structureType !== STRUCTURE_CONTAINER &&
                                    (s.structureType !== STRUCTURE_RAMPART || !s.my)
                                ) {
                                    costs.set(s.pos.x, s.pos.y, 0xff);
                                }
                            });
                            // respect construction sites too
                            room.find(FIND_CONSTRUCTION_SITES).forEach(cs => {
                                if (cs.structureType !== STRUCTURE_ROAD) costs.set(cs.pos.x, cs.pos.y, 0xff);
                            });
                            return costs;
                        }
                       } 
                    );

                    mem.paths[key] = {
                        i: 0,
                        done: false,
                        // store as plain objects so Memory serializes nicely
                        path: ret.path.map(p => ({ x: p.x, y: p.y, roomName: p.roomName })),
                    };
                }
                //drip-place a few road sites per tick on visible segments
                RoadPlanner._placeAlongPath(homeRoom, key, 5);
            }
        }
    },

    //Helpers
    _placeAlongPath(homeRoom, key, budget) {
        const mem = RoadPlanner._memory(homeRoom);
        const rec = mem.paths[key];
        if (!rec || rec.done) return;

        let placed = 0;
        while (rec.i < rec.path.length && placed < budget) {
            const step = rec.path[rec.i];
            rec.i++;

            // can only create sites in visible rooms
            const roomObj = Game.rooms[step.roomName];
            if (!roomObj) continue;

            //skip walls / existing stuff
            const terr = roomObj.getTerrain().get(step.x, step.y);
            if (terr === TERRAIN_MASK_WALL) continue;

            const pos = new RoomPosition(step.x, step.y, step.roomName);
            const occuipied  =
                pos.lookFor(LOOK_STRUCTURES).some(s => s.structureType === STRUCTURE_ROAD) ||
                pos.lookFor(LOOK_CONSTRUCTION_SITES).some(cs => cs.structureType === STRUCTURE_ROAD);
            
            if (occuipied) continue;

            if (roomObj.createConstructionSite(pos, STRUCTURE_ROAD) === OK) {
                placed++;
            }
        }

        if (rec.i >= rec.path.length) rec.done = true;
    },

    _memory(homeRoom) {
        if (!Memory.rooms) Memory.rooms = {};
        if (!Memory.rooms[homeRoom.name]) Memory.rooms[homeRoom.name] = {};
        const r = Memory.rooms[homeRoom.name];
        if (!r.roadPlanner) r.roadPlanner = { paths: {} };
        if (!r.roadPlanner.paths) r.roadPlanner.paths = {};
        return r.roadPlanner;
    },
    getActiveRemoteRooms(homeRoom) {
        const mem = this._memory(homeRoom);
        const rooms = new Set();
        for (const key of Object.keys(mem.paths || {})) {
            const remoteRoom = key.split(':')[0];
            rooms.add(remoteRoom);
        }
        return [...rooms];
    },
};

module.exports = RoadPlanner;