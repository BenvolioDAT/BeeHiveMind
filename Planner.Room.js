//Planner.Room.js
// Single source of truth for room/base planning & construction site placement

const RoomPlanner = {
    // Define limits for each structure type
    structureLimits: {
        STRUCTURE_TOWER: 6,
        STRUCTURE_EXTENSION: 60,
        STRUCTURE_CONTAINER: 1,
        STRUCTURE_RAMPART: 2,
        STRUCTURE_ROAD: 20,
    },

    BASE_OFFSETS:[
        { type: STRUCTURE_STORAGE,   x:  8, y: 0},//1
        { type: STRUCTURE_SPAWN,     x: -5, y: 0},
        { type: STRUCTURE_SPAWN,     x:  5, y: 0},

        //{ type: STRUCTURE_CONTAINER, x: 5, y: 0},

        { type: STRUCTURE_EXTENSION, x: 0, y: 2 },//1
        { type: STRUCTURE_EXTENSION, x: 0, y:-2 },//2
        { type: STRUCTURE_EXTENSION, x: 0, y: 3 },//3
        { type: STRUCTURE_EXTENSION, x: 0, y:-3 },//4
        { type: STRUCTURE_EXTENSION, x:-1, y: 3 },//5
        { type: STRUCTURE_EXTENSION, x:-1, y:-3 },//6
        { type: STRUCTURE_EXTENSION, x: 1, y:-3 },//7
        { type: STRUCTURE_EXTENSION, x: 1, y: 3 },//8
        { type: STRUCTURE_EXTENSION, x:-1, y: 2 },//9
        { type: STRUCTURE_EXTENSION, x:-1, y:-2 },//10
        { type: STRUCTURE_EXTENSION, x: 1, y: 2 },//11
        { type: STRUCTURE_EXTENSION, x: 1, y:-2 },//12 
        { type: STRUCTURE_EXTENSION, x:-2, y:-1 },//13
        { type: STRUCTURE_EXTENSION, x:-2, y: 1 },//14
        { type: STRUCTURE_EXTENSION, x: 2, y:-1 },//15
        { type: STRUCTURE_EXTENSION, x: 2, y: 1 },//16
        { type: STRUCTURE_EXTENSION, x:-3, y: 1 },//17
        { type: STRUCTURE_EXTENSION, x:-3, y:-1 },//18
        { type: STRUCTURE_EXTENSION, x: 3, y: 1 },//19
        { type: STRUCTURE_EXTENSION, x: 3, y:-1 },//20
        { type: STRUCTURE_EXTENSION, x:-3, y: 2 },//21
        { type: STRUCTURE_EXTENSION, x:-3, y:-2 },//22
        { type: STRUCTURE_EXTENSION, x: 3, y: 2 },//23
        { type: STRUCTURE_EXTENSION, x: 3, y:-2 },//24
        { type: STRUCTURE_EXTENSION, x:-4, y: 2 },//25
        { type: STRUCTURE_EXTENSION, x:-4, y:-2 },//26
        { type: STRUCTURE_EXTENSION, x: 4, y: 2 },//27
        { type: STRUCTURE_EXTENSION, x: 4, y:-2 },//28
        { type: STRUCTURE_EXTENSION, x: 4, y: 3 },//29
        { type: STRUCTURE_EXTENSION, x: 4, y:-3 },//30
        { type: STRUCTURE_EXTENSION, x:-4, y: 3 },//31
        { type: STRUCTURE_EXTENSION, x:-4, y:-3 },//32
        { type: STRUCTURE_EXTENSION, x:-4, y: 4 },//33
        { type: STRUCTURE_EXTENSION, x:-4, y:-4 },//34
        { type: STRUCTURE_EXTENSION, x: 4, y: 4 },//35
        { type: STRUCTURE_EXTENSION, x: 4, y:-4 },//36
        { type: STRUCTURE_EXTENSION, x: 3, y: 4 },//37
        { type: STRUCTURE_EXTENSION, x: 3, y:-4 },//38
        { type: STRUCTURE_EXTENSION, x:-3, y: 4 },//39
        { type: STRUCTURE_EXTENSION, x:-3, y:-4 },//40
        { type: STRUCTURE_EXTENSION, x:-2, y: 4 },//41
        { type: STRUCTURE_EXTENSION, x:-2, y:-4 },//42
        { type: STRUCTURE_EXTENSION, x: 2, y: 4 },//43
        { type: STRUCTURE_EXTENSION, x: 2, y:-4 },//44
        { type: STRUCTURE_EXTENSION, x: 2, y: 5 },//45
        { type: STRUCTURE_EXTENSION, x: 2, y:-5 },//46
        { type: STRUCTURE_EXTENSION, x:-2, y:-5 },//47
        { type: STRUCTURE_EXTENSION, x:-2, y: 5 },//48
        { type: STRUCTURE_EXTENSION, x:-1, y:-5 },//49
        { type: STRUCTURE_EXTENSION, x:-1, y: 5 },//50
        { type: STRUCTURE_EXTENSION, x: 1, y: 5 },//51
        { type: STRUCTURE_EXTENSION, x: 1, y:-5 },//52
        { type: STRUCTURE_EXTENSION, x: 0, y: 5 },//53
        { type: STRUCTURE_EXTENSION, x: 0, y:-5 },//54
        { type: STRUCTURE_EXTENSION, x:-4, y: 0 },//55
        { type: STRUCTURE_EXTENSION, x: 4, y: 0 },//56
        { type: STRUCTURE_EXTENSION, x:-5, y: 1 },//57
        { type: STRUCTURE_EXTENSION, x:-5, y:-1 },//58
        { type: STRUCTURE_EXTENSION, x: 5, y: 1 },//59
        { type: STRUCTURE_EXTENSION, x: 5, y:-1 },//60 
        // TOWER LOCATIONS
        //{ type: STRUCTURE_TOWER, x:-5, y:-5 },//1
        //{ type: STRUCTURE_TOWER, x: 5, y: 5 },//2
        //{ type: STRUCTURE_TOWER, x:-5, y: 5 },//3
        //{ type: STRUCTURE_TOWER, x: 5, y:-5 },//4
        //{ type: STRUCTURE_TOWER, x:-1, y: 0 },//5
        //{ type: STRUCTURE_TOWER, x: 1, y: 0 },//6
        { type: STRUCTURE_ROAD, x: 1, y: 1 },
        { type: STRUCTURE_ROAD, x: 0, y: 1 },
        { type: STRUCTURE_ROAD, x:-1, y: 1 },
        { type: STRUCTURE_ROAD, x:-1, y: 0 },
        { type: STRUCTURE_ROAD, x:-1, y:-1 },
        { type: STRUCTURE_ROAD, x: 0, y:-1 },
        { type: STRUCTURE_ROAD, x: 1, y:-1 },
        { type: STRUCTURE_ROAD, x: 1, y: 0 },
        { type: STRUCTURE_ROAD, x: 2, y: 0 },
        { type: STRUCTURE_ROAD, x: 3, y: 0 },
        { type: STRUCTURE_ROAD, x:-2, y: 0 },
        { type: STRUCTURE_ROAD, x:-3, y: 0 },
        { type: STRUCTURE_ROAD, x:-4, y: 1 },
        { type: STRUCTURE_ROAD, x:-4, y:-1 },
        { type: STRUCTURE_ROAD, x: 4, y:-1 },
        { type: STRUCTURE_ROAD, x: 4, y: 1 },
        { type: STRUCTURE_ROAD, x: 2, y: 2 },
        { type: STRUCTURE_ROAD, x: 2, y:-2 },
        { type: STRUCTURE_ROAD, x: 3, y:-3 },
        { type: STRUCTURE_ROAD, x: 3, y: 3 },
        { type: STRUCTURE_ROAD, x:-2, y: 2 },
        { type: STRUCTURE_ROAD, x:-2, y:-2 },
        { type: STRUCTURE_ROAD, x:-3, y:-3 },
        { type: STRUCTURE_ROAD, x:-3, y: 3 },
        { type: STRUCTURE_ROAD, x:-2, y: 3 },
        { type: STRUCTURE_ROAD, x: 2, y: 3 },
        { type: STRUCTURE_ROAD, x:-2, y:-3 },
        { type: STRUCTURE_ROAD, x: 2, y:-3 },
        { type: STRUCTURE_ROAD, x:-1, y: 4 },
        { type: STRUCTURE_ROAD, x: 1, y: 4 },
        { type: STRUCTURE_ROAD, x:-1, y:-4 },
        { type: STRUCTURE_ROAD, x: 1, y:-4 },
        { type: STRUCTURE_ROAD, x: 0, y: 4 },
        { type: STRUCTURE_ROAD, x: 0, y:-4 },
        // Add more structures with their positions
    ],

    ensureSites(room) {
        if (!room || !room.controller || !room.controller.my) return;

        //anchor = first spawn(stable & cheap)
        const spawns = room.find(FIND_MY_SPAWNS);
        if (!spawns.length) return;
        const anchor = spawns[0].pos;

        const mem = RoomPlanner._memory(room);
        if (mem.netPlanTick && Game.time < mem.nextPlanTick) return;

        const MAX_SITES_PER_TICK = 5; // be gentle: site cap is 100 global
        let placed = 0;

        for (const p of RoomPlanner.BASE_OFFSETS) {
            if (placed >= MAX_SITES_PER_TICK) break;

            const tx = anchor.x + p.x;
            const ty = anchor.y + p.y;
            if (tx < 1 || tx > 48 || ty < 1 || ty > 48) continue;

            const target = new RoomPosition(tx, ty, room.name);

            //skip if something already here
            const already =
                target.lookFor(LOOK_STRUCTURES).length ||
                target.lookFor(LOOK_CONSTRUCTION_SITES).length;
            if (already) continue;

            //respect hard limits (existing + sites)
            if (RoomPlanner._isAtLimit(room, p.type)) continue;

            // don't place into walls
            const terr = room.getTerrain().get(tx, ty);
            if (terr === TERRAIN_MASK_WALL) continue;

            if (room.createConstructionSite(target, p.type) === OK) {
                placed++;
            }
        }

        mem.nextPlanTick = Game.time + (placed ? 10 : 25);
    },

    // ---Helpers---
    _memory(room) {
        if (!Memory.rooms) Memory.rooms = {};
        if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};
        if (!Memory.rooms[room.name].planner) Memory.rooms[room.name].planner = {};
        return Memory.rooms[room.name].planner;
    },

    _isAtLimit(room, type) {
        const lim = this.structureLimits[type];
        if (!lim) return false;
        const built = room.find(FIND_STRUCTURES, { filter: s => s.structureType === type }).length;
        const sties = room.find(FIND_CONSTRUCTION_STIES, { filter: s => s.structureType === type}).length;
        return (built + sites) >= lim;
    },
};

MediaSourceHandle.exports = RoomPlanner;