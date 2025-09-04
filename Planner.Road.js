// Planner.Road.js
// Purpose: Plan and slowly (a few tiles per tick) place ROAD construction sites
// from your home room to remote energy sources used by your remote harvesters.
//
// Big picture:
// - Every tick, we look at remote-harvest creeps to discover which remote rooms matter.
// - For each remote room's sources, we PathFinder from home "anchor" -> source (range 1).
// - We remember the full path in Memory so we don't re-plan every tick.
// - Then we "drip-place" a small number of ROAD sites along that path, but ONLY
//   in rooms we can currently see (Screeps can't place sites in fog).
//
// Why drip placement?
// - Keeps CPU low and avoids hitting the global 100 construction-site cap.
// - Lets your builders gradually pave highways while you play the rest of the game.
//
// Glossary of Screeps globals used here (for new folks):
// - Game: runtime state (creeps, rooms, structures, etc.).
// - Memory: persistent JSON you can write/read across ticks.
// - PathFinder: powerful pathing API (multi-room, customizable costs).
// - RoomPosition: coordinates + room; used for pathing and building.
// - FIND_* constants: built-in filters for .find() calls.
// - LOOK_* constants: used with RoomPosition.lookFor() to see what's on a tile.
// - STRUCTURE_* constants: types of structures (ROAD, CONTAINER, etc.).
// - TERRAIN_MASK_* constants: terrain bit flags (WALL == impassable).
//
// Note: This module assumes lodash (_) is available (on most servers it is).
// If not, replace _.filter/_.uniq with plain JS equivalents.
// === Small helper: does this position already have a road or a road construction site? ===
function _hasRoadOrRoadSite(pos) {
  const structures = pos.lookFor(LOOK_STRUCTURES);
  for (const s of structures) {
    if (s.structureType === STRUCTURE_ROAD) return true;
  }
  const sites = pos.lookFor(LOOK_CONSTRUCTION_SITES);
  for (const cs of sites) {
    if (cs.structureType === STRUCTURE_ROAD) return true;
  }
  return false;
}

const RoadPlanner = {
    /**
    * Main entry point: call this every tick.
    * It is cheap when there's nothing to do (e.g., no remotes, path already planned, etc.).
    *
    * @param {Room} homeRoom - Your own room where the road should start.
    */
    //main entry: call this every tick (super cheap when idle)
    ensureRemoteRoads(homeRoom) {
        // Safety checks: If no room / no controller / not ours → bail early.
        if (!homeRoom || !homeRoom.controller || !homeRoom.controller.my) return;
        // 1) Grab our planner-specific memory bucket for this home room.
        const mem = RoadPlanner._memory(homeRoom);
        // 2) Find a starting "anchor" position for the highway.
        //    Here we use the first spawn's position. (You could swap to storage later.)
        const spawns = homeRoom.find(FIND_MY_SPAWNS);
        if (!spawns.length) return;
        const anchor = spawns[0].pos;
        // 3) Discover which remote rooms we care about *today*.
        //    We look at creeps with task === 'remoteharvest' and that have a targetRoom.
        //    _.uniq() ensures we don't repeat the same room twice.
        //discover active remote rooms from your currently assigned creeps
        const activeRemotes = _.uniq(
            _.filter(Game.creeps, c => c.memory.task === 'remoteharvest' && c.memory.targetRoom)
            .map(c => c.memory.targetRoom)
        );
        // 4) For each remote room we care about...
        for (const remote of activeRemotes) {
            // We only proceed if our Memory already knows about sources in that room.
            // (e.g., your scout/logging step filled Memory.rooms[remote].sources)
            const rmem = Memory.rooms[remote];
            if (!rmem || !rmem.sources) continue;// Need source IDs first.//BeeToolbox.logSourcesInRoom fills this when you have vision
            // We can only place construction sites where we have vision (room object exists).
            //If we can see the room, we can obtain real source positions now
            const remoteRoomObj = Game.rooms[remote];
            if (!remoteRoomObj) continue; // No vision → skip this remote for now.
            // 5) Get actual live Source objects from the visible remote room.
            const sources = remoteRoomObj.find(FIND_SOURCES);
            // 6) Plan/ensure a path to each source in that remote room.
            for (const src of sources) {
                // Unique key per remote-source pair so we can track progress separately.
                const key =`${remote}:${src.id}`;
                // If we haven't planned this path yet, do one big cross-room path search.
                if (!mem.paths[key]) {
                    // PathFinder.search(start, goal, opts)
                    // - start: our anchor Position in home room
                    // - goal: { pos, range } says "get within range of this position" (range 1 around the source)
                    // - opts: tuning for terrain costs + a roomCallback for custom per-tile rules
                    //plan (one big cross-room PathFinder search)
                    const harvestPos = RoadPlanner._chooseHarvestTile(src);
                    const ret = PathFinder.search(
                       anchor,
                       harvestPos ? { pos: harvestPos, range: 0 } : { pos: src.pos, range: 1 },
                       {
                        // Base terrain costs:
                        // - plains are cheap (2)
                        // - swamps are pricier (10) so roads (which reduce fatigue) matter more there
                        plainCost: 2,
                        swampCost: 10,
                        // roomCallback lets us tweak the cost matrix per room.
                        // Returning undefined means "use default terrain costs".
                        // Returning a CostMatrix lets us prefer roads / block impassables.
                        roomCallback: (roomName) => {
                            const room = Game.rooms[roomName];
                            if (!room) return;// No vision → undefined → default costs. // undefined -> use fefault costs
                            // Start with an empty matrix, and we will selectively mark tiles.
                            const costs = new PathFinder.CostMatrix();
                            // 1) Prefer existing roads by setting a *lower* cost on road tiles.
                            //    1 is extremely attractive vs plainCost(2)/swampCost(10).
                            // 2) Block (set 0xff) most non-passable structures:
                            //    - Anything that's not a CONTAINER
                            //    - RAMPARTs are okay only if they're ours (s.my)
                            // prefer existing roads
                            room.find(FIND_STRUCTURES).forEach(s => {
                                if (s.structureType === STRUCTURE_ROAD) 
                                    costs.set(s.pos.x, s.pos.y, 1);
                                else if (
                                    s.structureType !== STRUCTURE_CONTAINER &&
                                    (s.structureType !== STRUCTURE_RAMPART || !s.my)
                                ) {
                                    costs.set(s.pos.x, s.pos.y, 0xff);// basically impassable
                                }
                            });
                            // Also respect construction sites:
                            // - Block non-road sites so we don't plan through future walls/towers, etc.
                            // respect construction sites too
                            room.find(FIND_CONSTRUCTION_SITES).forEach(cs => {
                                if (cs.structureType !== STRUCTURE_ROAD) {
                                    costs.set(cs.pos.x, cs.pos.y, 0xff);
                                }
                            });
                            // 🚧 NEW: treat sources & minerals as impassable so we don't path "through" them
                            room.find(FIND_SOURCES).forEach(src => costs.set(src.pos.x, src.pos.y, 0xff));
                            const minerals = room.find ? room.find(FIND_MINERALS) : [];
                            minerals.forEach(min => costs.set(min.pos.x, min.pos.y, 0xff));
                            // Return the customized matrix for this room.
                            return costs;
                        }
                       } 
                    );

                    if (!ret.path || ret.path.length === 0 || ret.incomplete) {
                        // Optional: keep a small backoff timestamp in memory if you want.
                        continue;
                    }

                    // Store a *serializable* copy of the path in Memory.
                    // (RoomPosition objects aren't serializable as-is.)
                    mem.paths[key] = {
                        i: 0,           // progress index along path (which step we’re on)
                        done: false,    // once we've stepped through all tiles, we mark done
                        // store as plain objects so Memory serializes nicely
                        path: ret.path.map(p => ({ x: p.x, y: p.y, roomName: p.roomName })),
                    };
                }
                // Whether this was newly planned or already existed, place a few ROAD sites
                // along the path this tick (only on visible segments).
                // "5" is our per-tick placement budget to keep things gentle.
                //drip-place a few road sites per tick on visible segments
                RoadPlanner._placeAlongPath(homeRoom, key, 5);
                // Occasionally audit already-complete paths and relaunch if a tile decayed
                RoadPlanner._auditAndRelaunch(homeRoom, key, 1);
            }
        }
    },
    // ─────────────────────────────────────────────────────────────────────────────
    /**
     * Walk forward along a saved path and place up to `budget` ROAD sites this tick.
     * Only places in rooms we can see. Skips walls and already-occupied tiles.
     *
     * @param {Room} homeRoom - The home room this planner belongs to.
     * @param {string} key - Unique "remoteRoom:sourceId" identifying the saved path.
     * @param {number} budget - Max number of ROAD sites to place this tick.
     */
    //Helpers
    _placeAlongPath(homeRoom, key, budget) {
        // Hard global safety: Screeps has a global cap of 100 construction sites.
        // If we get near it, skip placing to avoid ERR_FULL & churn.
        if (Object.keys(Game.constructionSites).length > 90) return;
        // Load the path record for this remote-source pair.
        const mem = RoadPlanner._memory(homeRoom);
        const rec = mem.paths[key];
        if (!rec || rec.done) return;// Nothing to do.
        
        let placed = 0;
        let guard = 0; // safety: prevents infinite loops if logic breaks.
        // Walk forward from rec.i up to the end of the path,
        // but stop if we hit our per-tick placement budget.
        while (rec.i < rec.path.length && placed < budget) {
            if (++guard > budget + 10) break; //ultra-low overhead safety
            const step = rec.path[rec.i];
            //rec.i++;// Advance our progress pointer even if we end up skipping this step.
            // We can only create construction sites in rooms we can see (have a Room object).
            // can only create sites in visible rooms
            const roomObj = Game.rooms[step.roomName];
            if (!roomObj) break; // No vision → skip this step for now.
            // Skip impassable terrain. WALL tiles are a no-go for roads.
            // (TERRAIN_MASK_WALL is a bit mask; equality check is the standard pattern.)
            //skip walls / existing stuff
            const terr = roomObj.getTerrain().get(step.x, step.y);
            if (terr === TERRAIN_MASK_WALL) {
            // Create a RoomPosition object for this step.
            const pos = new RoomPosition(step.x, step.y, step.roomName);
            // Skip tiles that already have:
            // - An existing ROAD structure, or
            // - A ROAD construction site
            const occupied  =
                pos.lookFor(LOOK_STRUCTURES).some(s => s.structureType === STRUCTURE_ROAD) ||
                pos.lookFor(LOOK_CONSTRUCTION_SITES).some(cs => cs.structureType === STRUCTURE_ROAD);
            if (!occupied) {
            // Try to place the ROAD construction site.
            // createConstructionSite returns an OK/ERR_* code; we only count if it succeeded.
            const res = roomObj.createConstructionSite(pos, STRUCTURE_ROAD);
                if (res === OK) placed++;
            }
            
            rec.i++;
            console.log("pass rec.i++");
        }
        // If we've marched past the last path step, mark this path as done
        // so we never revisit it again (saves CPU in future ticks).
        if (rec.i >= rec.path.length) rec.done = true;
        }
    },
    // ─────────────────────────────────────────────────────────────────────────────
    /**
     * Get (and lazily initialize) this home room's RoadPlanner memory bucket.
     * We store everything under: Memory.rooms[homeRoom.name].roadPlanner
     * Structure:
     * {
     *   paths: {
     *     "<remoteName>:<sourceId>": {
     *       i: <number>,          // progress index along path
     *       done: <boolean>,      // have we finished placing along the path?
     *       path: [ {x, y, roomName}, ... ] // serialized path tiles
     *     },
     *     ...
     *   }
     * }
     *
     * @param {Room} homeRoom
     * @returns {object} planner memory object
     */
    _memory(homeRoom) {
        // Ensure top-level Memory.rooms exists.
        if (!Memory.rooms) Memory.rooms = {};
        // Ensure this specific room has a Memory bucket.
        if (!Memory.rooms[homeRoom.name]) Memory.rooms[homeRoom.name] = {};
        // Pull the room's memory object.
        const r = Memory.rooms[homeRoom.name];
        // Ensure the roadPlanner namespace and its 'paths' map exist.
        if (!r.roadPlanner) r.roadPlanner = { paths: {} };
        if (!r.roadPlanner.paths) r.roadPlanner.paths = {};
        // Return the namespace we will store/read from.
        return r.roadPlanner;
    },
    // ─────────────────────────────────────────────────────────────────────────────
    /**
     * Utility: List remote room names that currently have planned paths
     * (i.e., the keys we’ve stored in memory). This is purely informative.
     *
     * @param {Room} homeRoom
     * @returns {string[]} array of room names (e.g., ["W1N1","W2N1"])
     */
    getActiveRemoteRooms(homeRoom) {
        const mem = this._memory(homeRoom);
        const rooms = new Set();
        // Keys are shaped like "<remoteRoomName>:<sourceId>".
        for (const key of Object.keys(mem.paths || {})) {
            const remoteRoom = key.split(':')[0];
            rooms.add(remoteRoom);
        }
        // Convert the Set back to an Array for convenience.
        return [...rooms];
    },
    // === Occasionally audit a finished path; if a road tile is missing, relaunch placement ===
    _auditAndRelaunch(homeRoom, key, maxFixes = 1) {
        // pull this room's RoadPlanner memory
        const mem = RoadPlanner._memory(homeRoom);
        if (!mem || !mem.paths) return;

        const rec = mem.paths[key];
        if (!rec || !rec.done || !Array.isArray(rec.path) || rec.path.length === 0) return;

        // Throttle like crazy: run either once every 1000 ticks OR ~1% random chance
        // (Keeps CPU tiny; still catches decay sooner or later.)
        if (Game.time % 100 !== 0 && Math.random() > 0.01) return;

        let fixed = 0;

        for (let idx = 0; idx < rec.path.length && fixed < maxFixes; idx++) {
            const step = rec.path[idx];

            // need vision to audit/build
            const roomObj = Game.rooms[step.roomName];
            if (!roomObj) continue;

            // skip walls (shouldn't be on the path anyway, but being safe costs nothing)
            const terrain = roomObj.getTerrain().get(step.x, step.y);
            if (terrain === TERRAIN_MASK_WALL) continue;

            const pos = new RoomPosition(step.x, step.y, step.roomName);

            // If no road and no road site, create one
            if (!_hasRoadOrRoadSite(pos)) {
            const res = roomObj.createConstructionSite(pos, STRUCTURE_ROAD);
            if (res === OK) {
                // Roll pointer back so your existing drip-placer resumes from here
                if (typeof rec.i !== 'number' || rec.i > idx) rec.i = idx;

                // Mark "not done" so _placeAlongPath keeps doing its thing
                rec.done = false;

                fixed++;
            } else {
                // Optional: log if you want to see why it failed (e.g., site cap)
                // console.log('[RoadPlanner] CS create failed', res, 'at', pos);
            }
            }
        }

    },
    _chooseHarvestTile(src) {
        const room = Game.rooms[src.pos.roomName];
        if (!room) return null;
        const terrain = room.getTerrain();

        let best = null, bestScore = -Infinity;

        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;

            const x = src.pos.x + dx, y = src.pos.y + dy;
            // avoid room borders (annoying for pathing & building)
            if (x <= 0 || x >= 49 || y <= 0 || y >= 49) continue;

            const t = terrain.get(x, y);
            if (t === TERRAIN_MASK_WALL) continue;

            const pos = new RoomPosition(x, y, room.name);
            const structs = pos.lookFor(LOOK_STRUCTURES);

            let score = 0;
            // prefer an existing container (10) or road (5)
            if (structs.some(s => s.structureType === STRUCTURE_CONTAINER)) score += 10;
            if (structs.some(s => s.structureType === STRUCTURE_ROAD)) score += 5;

            // prefer plains over swamp
            if (t === TERRAIN_MASK_SWAMP) score -= 2;

            if (score > bestScore) { bestScore = score; best = pos; }
            }
        }
        return best; // may be null if no vision; caller should fall back
    },
    

};

module.exports = RoadPlanner;