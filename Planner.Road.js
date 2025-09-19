// Planner.Road.clean.refactor.js
// Readable, staged road planner for Screeps
// - Builds a home-room logistics spine (spawn → storage) and spokes to sources (and optional controller).
// - Plans + drip-places ROAD sites to remote sources used by your remote-harvest creeps.
// - Audits occasionally and relaunches placements if tiles decay.
// Compatible with vanilla Screeps API: PathFinder, CostMatrix, Room.createConstructionSite, etc.

'use strict';

/** =========================
 *  Config (tweak here)
 *  ========================= */
const CFG = Object.freeze({
  // Pathfinding weights
  plainCost: 2,
  swampCost: 10,
  roadCost: 1,

  // Placement behavior
  placeBudgetPerTick: 10, // how many tiles we attempt to place per tick across a path
  globalCSiteSafetyLimit: 95, // stop if we’re close to the global 100 cap
  auditInterval: 100, // every N ticks we do a light audit pass (with a tiny random chance in between)
  randomAuditChance: 0.01, // 1% random background audit on off-ticks

  // Home network
  includeControllerSpoke: true
});

/** =========================
 *  Small utilities
 *  ========================= */

/**
 * @param {RoomPosition} pos
 * @returns {boolean} true if there is already a road or a road construction site on this tile
 */
function hasRoadOrRoadSite(pos) {
  // Structures first (fast)
  const structures = pos.lookFor(LOOK_STRUCTURES);
  for (const s of structures) if (s.structureType === STRUCTURE_ROAD) return true;

  // Sites next
  const sites = pos.lookFor(LOOK_CONSTRUCTION_SITES);
  for (const cs of sites) if (cs.structureType === STRUCTURE_ROAD) return true;

  return false;
}

/** Convert plain step (x,y,roomName) into a RoomPosition. */
function toPos(step) {
  return new RoomPosition(step.x, step.y, step.roomName);
}

/** =========================
 *  RoadPlanner module
 *  ========================= */
const RoadPlanner = {
  /**
   * Call this once per tick from your main loop.
   * - Ensures staged home network (spawn→storage, spokes to sources, optional controller).
   * - Ensures remote roads to active remote sources (discovered via creeps with task=remoteharvest).
   * @param {Room} homeRoom
   */
  ensureRemoteRoads(homeRoom) {
    if (!homeRoom || !homeRoom.controller || !homeRoom.controller.my) return;

    const mem = this._memory(homeRoom);

    // Require at least one spawn known early game
    const spawns = homeRoom.find(FIND_MY_SPAWNS);
    if (!spawns.length && !homeRoom.storage) return;

    // 1) Staged home logistics network
    this._ensureStagedHomeNetwork(homeRoom);

    // 2) Remote spokes for any active remote-harvest creeps
    const activeRemotes = this._discoverActiveRemoteRoomsFromCreeps();
    for (const remoteName of activeRemotes) {
      const rmem = Memory.rooms && Memory.rooms[remoteName];
      if (!rmem || !rmem.sources) continue;                 // needs your exploration/memory elsewhere
      const remoteRoom = Game.rooms[remoteName];
      if (!remoteRoom) continue;                            // only plan when visible (safe + accurate)

      const sources = remoteRoom.find(FIND_SOURCES);
      for (const src of sources) {
        const key = `${remoteName}:${src.id}`;
        // Path is planned once then drip-placed and audited forever after
        if (!mem.paths[key]) {
          const harvestPos = this._chooseHarvestTile(src);
          const goal = harvestPos ? { pos: harvestPos, range: 0 } : { pos: src.pos, range: 1 };

          const ret = PathFinder.search(this._getAnchorPos(homeRoom), goal, {
            plainCost: CFG.plainCost,
            swampCost: CFG.swampCost,
            roomCallback: (roomName) => this._roomCostMatrix(roomName)
          });

          if (!ret.path || !ret.path.length || ret.incomplete) continue;

          mem.paths[key] = {
            i: 0,
            done: false,
            path: ret.path.map(p => ({ x: p.x, y: p.y, roomName: p.roomName }))
          };
        }

        this._dripPlaceAlongPath(homeRoom, key, CFG.placeBudgetPerTick);
        this._auditAndRelaunch(homeRoom, key, /*maxFixes*/ 1);
      }
    }
  },

  // ---------- Home network (staged) ----------

  /**
   * Decide the “anchor” for home roads:
   * - Before STORAGE: use first spawn.
   * - After STORAGE exists: use storage (more central/logistics-friendly).
   * @param {Room} homeRoom
   * @returns {RoomPosition|null}
   */
  _getAnchorPos(homeRoom) {
    if (homeRoom.storage) return homeRoom.storage.pos;
    const spawns = homeRoom.find(FIND_MY_SPAWNS);
    return spawns.length ? spawns[0].pos : null;
  },

  /**
   * High-level helper: plan if needed, then drip-place + audit under a stable memory key.
   * @param {Room} homeRoom
   * @param {RoomPosition} fromPos
   * @param {RoomPosition} goalPos
   * @param {string} key stable memory key
   * @param {number} range acceptable range to goal
   */
  _planTrackPlaceAudit(homeRoom, fromPos, goalPos, key, range = 1) {
    if (!fromPos || !goalPos) return;
    const mem = this._memory(homeRoom);

    if (!mem.paths[key]) {
      const ret = PathFinder.search(fromPos, { pos: goalPos, range }, {
        plainCost: CFG.plainCost,
        swampCost: CFG.swampCost,
        roomCallback: (roomName) => this._roomCostMatrix(roomName)
      });
      if (!ret.path || !ret.path.length || ret.incomplete) return;

      mem.paths[key] = {
        i: 0,
        done: false,
        path: ret.path.map(p => ({ x: p.x, y: p.y, roomName: p.roomName }))
      };
    }

    this._dripPlaceAlongPath(homeRoom, key, CFG.placeBudgetPerTick);
    this._auditAndRelaunch(homeRoom, key, /*maxFixes*/ 1);
  },

  /**
   * Build the home logistics network:
   *  - Anchor: spawn → switch to storage when available.
   *  - Spokes: to each source (prefer container/road-adjacent harvest tile).
   *  - Optional: to controller.
   *  - If storage exists, ensure spawn↔storage is paved (handy for early refill loops).
   */
  _ensureStagedHomeNetwork(homeRoom) {
    const anchor = this._getAnchorPos(homeRoom);
    if (!anchor) return;

    // (A) Spokes to sources
    const sources = homeRoom.find(FIND_SOURCES);
    for (let i = 0; i < sources.length; i++) {
      const src = sources[i];
      const harv = this._chooseHarvestTile(src) || src.pos; // prefer smart tile; fallback to pos
      const range = (harv === src.pos) ? 1 : 0;             // if tile is exact, range 0; else 1
      const stage = homeRoom.storage ? 'storage' : 'spawn';
      const key = `${homeRoom.name}:LOCAL:source${i}:from=${stage}`;
      this._planTrackPlaceAudit(homeRoom, anchor, harv, key, range);
    }

    // (B) Optional spoke to controller
    if (CFG.includeControllerSpoke && homeRoom.controller) {
      const stage = homeRoom.storage ? 'storage' : 'spawn';
      const keyC = `${homeRoom.name}:LOCAL:controller:from=${stage}`;
      this._planTrackPlaceAudit(homeRoom, anchor, homeRoom.controller.pos, keyC, 1);
    }

    // (C) Spawn ↔ storage backbone once storage exists
    if (homeRoom.storage) {
      const spawns = homeRoom.find(FIND_MY_SPAWNS);
      if (spawns.length) {
        const keyS = `${homeRoom.name}:LOCAL:spawn0-to-storage`;
        this._planTrackPlaceAudit(homeRoom, spawns[0].pos, homeRoom.storage.pos, keyS, 1);
      }
    }
  },

  // ---------- Path placement + auditing ----------

  /**
   * Drip-placer: walk along a stored path and attempt to place ROAD sites up to a budget.
   * - Advances the cursor (rec.i) whether or not a placement happens to avoid re-trying blocked tiles forever.
   * - Stops if global construction sites are near the cap.
   * @param {Room} homeRoom
   * @param {string} key
   * @param {number} budget
   */
  _dripPlaceAlongPath(homeRoom, key, budget) {
    if (Object.keys(Game.constructionSites).length > CFG.globalCSiteSafetyLimit) return;

    const mem = this._memory(homeRoom);
    const rec = mem.paths[key];
    if (!rec || rec.done) return;

    let placed = 0;
    let iterations = 0;

    // We intentionally keep the inner loop simple; rec.i only moves forward.
    while (rec.i < rec.path.length && placed < budget) {
      if (++iterations > budget + 10) break; // soft guard against infinite loops

      const step = rec.path[rec.i];
      const roomObj = Game.rooms[step.roomName];
      if (!roomObj) break; // need visibility to place

      // Skip walls
      if (roomObj.getTerrain().get(step.x, step.y) !== TERRAIN_MASK_WALL) {
        const pos = toPos(step);
        if (!hasRoadOrRoadSite(pos)) {
          const rc = roomObj.createConstructionSite(pos, STRUCTURE_ROAD);
          if (rc === OK) {
            placed++;
          } else if (rc === ERR_FULL) {
            // Hit the global (100) cap; bail out this tick
            break;
          }
          // Other error codes: skip silently (blocked by rampart/structure); still advance cursor
        }
      }
      rec.i++;
    }

    if (rec.i >= rec.path.length) rec.done = true;
  },

  /**
   * Every so often (or randomly with tiny probability) we check a handful of path tiles.
   * If a tile lacks a road/road-site and isn’t a wall, we re-queue construction from that point.
   * @param {Room} homeRoom
   * @param {string} key
   * @param {number} maxFixes how many missing tiles we try to revive per audit
   */
  _auditAndRelaunch(homeRoom, key, maxFixes = 1) {
    const mem = this._memory(homeRoom);
    const rec = mem.paths[key];
    if (!rec || !rec.done || !Array.isArray(rec.path) || !rec.path.length) return;

    // Throttle audits to reduce CPU (regular interval OR low-probability random check)
    const onInterval = (Game.time % CFG.auditInterval) === 0;
    const randomTick = Math.random() < CFG.randomAuditChance;
    if (!onInterval && !randomTick) return;

    let fixed = 0;
    for (let idx = 0; idx < rec.path.length && fixed < maxFixes; idx++) {
      const step = rec.path[idx];
      const roomObj = Game.rooms[step.roomName];
      if (!roomObj) continue; // need visibility to fix

      if (roomObj.getTerrain().get(step.x, step.y) === TERRAIN_MASK_WALL) continue;

      const pos = toPos(step);
      if (!hasRoadOrRoadSite(pos)) {
        const rc = roomObj.createConstructionSite(pos, STRUCTURE_ROAD);
        if (rc === OK) {
          // Rewind cursor to this gap so drip placer resumes from here
          if (typeof rec.i !== 'number' || rec.i > idx) rec.i = idx;
          rec.done = false;
          fixed++;
        }
      }
    }
  },

  // ---------- Cost matrix ----------

  /**
   * Favor roads; block most non-road buildings; allow own ramparts; block minerals/sources.
   * @param {string} roomName
   * @returns {PathFinder.CostMatrix|undefined}
   */
  _roomCostMatrix(roomName) {
    const room = Game.rooms[roomName];
    if (!room) return; // no visibility → leave undefined (PathFinder uses defaults)

    const costs = new PathFinder.CostMatrix();

    // Existing roads are cheap to encourage reuse
    room.find(FIND_STRUCTURES).forEach(s => {
      if (s.structureType === STRUCTURE_ROAD) {
        costs.set(s.pos.x, s.pos.y, CFG.roadCost);
      } else if (
        // Walk through own ramparts; block others (and most buildings)
        s.structureType !== STRUCTURE_CONTAINER &&
        (s.structureType !== STRUCTURE_RAMPART || !s.my)
      ) {
        costs.set(s.pos.x, s.pos.y, 0xff);
      }
    });

    // Block non-road construction sites (don't plan through someone else's incoming walls)
    room.find(FIND_CONSTRUCTION_SITES).forEach(cs => {
      if (cs.structureType !== STRUCTURE_ROAD) {
        costs.set(cs.pos.x, cs.pos.y, 0xff);
      }
    });

    // Keep sources/minerals non-walkable for pathfinding
    room.find(FIND_SOURCES).forEach(s => costs.set(s.pos.x, s.pos.y, 0xff));
    const minerals = room.find(FIND_MINERALS);
    for (const m of minerals) costs.set(m.pos.x, m.pos.y, 0xff);

    return costs;
  },

  // ---------- Memory + info ----------

  /**
   * @param {Room} homeRoom
   * @returns {{paths: Record<string,{i:number,done:boolean,path:Array<{x:number,y:number,roomName:string}>}>}} roadPlanner memory bucket
   */
  _memory(homeRoom) {
    if (!Memory.rooms) Memory.rooms = {};
    if (!Memory.rooms[homeRoom.name]) Memory.rooms[homeRoom.name] = {};
    const r = Memory.rooms[homeRoom.name];
    if (!r.roadPlanner) r.roadPlanner = { paths: {} };
    if (!r.roadPlanner.paths) r.roadPlanner.paths = {};
    return r.roadPlanner;
  },

  /**
   * External info helper: list rooms that have planned paths under this home’s planner.
   * @param {Room} homeRoom
   * @returns {string[]}
   */
  getActiveRemoteRooms(homeRoom) {
    const mem = this._memory(homeRoom);
    const rooms = new Set();
    for (const key of Object.keys(mem.paths || {})) {
      rooms.add(key.split(':')[0]);
    }
    return [...rooms];
  },

  // ---------- Discovery helpers ----------

  /**
   * Find remote rooms by scanning creeps with task === 'remoteharvest' and a targetRoom.
   * (Keeps your planner decoupled from other systems; dead simple and effective.)
   * @returns {string[]}
   */
  _discoverActiveRemoteRoomsFromCreeps() {
    const set = new Set();
    for (const name in Game.creeps) {
      const c = Game.creeps[name];
      if (c && c.memory && c.memory.task === 'remoteharvest' && c.memory.targetRoom) {
        set.add(c.memory.targetRoom);
      }
    }
    return [...set];
  },

  /**
   * Pick the best adjacent harvest tile for a Source:
   * - Prefer tiles with an existing container (big bonus) or road (smaller bonus).
   * - Avoid walls; penalize swamps slightly.
   * Returns a RoomPosition or null (if room not visible).
   * @param {Source} src
   * @returns {RoomPosition|null}
   */
  _chooseHarvestTile(src) {
    const room = Game.rooms[src.pos.roomName];
    if (!room) return null;

    const terrain = room.getTerrain();
    let best = null;
    let bestScore = -Infinity;

    // Check the 8 neighbors around the source
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;

        const x = src.pos.x + dx;
        const y = src.pos.y + dy;
        if (x <= 0 || x >= 49 || y <= 0 || y >= 49) continue;

        const t = terrain.get(x, y);
        if (t === TERRAIN_MASK_WALL) continue;

        const pos = new RoomPosition(x, y, room.name);
        const structs = pos.lookFor(LOOK_STRUCTURES);

        let score = 0;
        if (structs.some(s => s.structureType === STRUCTURE_CONTAINER)) score += 10;
        if (structs.some(s => s.structureType === STRUCTURE_ROAD)) score += 5;
        if (t === TERRAIN_MASK_SWAMP) score -= 2;

        if (score > bestScore) { bestScore = score; best = pos; }
      }
    }
    return best;
  }
};

module.exports = RoadPlanner;
