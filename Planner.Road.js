// Planner.Road.clean.js
// Readable road planner for Screeps
// Plans + drip-places ROAD sites from your home room to remotes,
// AND (new) builds a home-room network to sources using a staged anchor (spawn → storage).

/** Tweakables */
const PLAIN_COST = 2;
const SWAMP_COST = 10;
const ROAD_COST  = 1;
const PLACE_BUDGET_PER_TICK = 10;
const CSITE_SAFETY_LIMIT = 95;
const AUDIT_INTERVAL = 100;
// Optional: include controller in the staged home network
const INCLUDE_CONTROLLER = true;

/** Helpers */
function hasRoadOrRoadSite(pos) {
  const structures = pos.lookFor(LOOK_STRUCTURES);
  for (const s of structures) if (s.structureType === STRUCTURE_ROAD) return true;
  const sites = pos.lookFor(LOOK_CONSTRUCTION_SITES);
  for (const cs of sites) if (cs.structureType === STRUCTURE_ROAD) return true;
  return false;
}

const RoadPlanner = {
  /**
   * Call this once per tick from your main loop.
   * @param {Room} homeRoom
   */
  ensureRemoteRoads(homeRoom) {
    if (!homeRoom || !homeRoom.controller || !homeRoom.controller.my) return;

    const mem = this._memory(homeRoom);

    const spawns = homeRoom.find(FIND_MY_SPAWNS);
    if (spawns.length === 0) return;

    // NEW: stage-aware local network (spawn → storage when available)
    this.ensureStagedHomeNetwork(homeRoom);

    // --- existing remote logic ---
    const activeRemotes = this._getActiveRemoteRoomsFromCreeps();

    for (const remoteName of activeRemotes) {
      const rmem = Memory.rooms[remoteName];
      if (!rmem || !rmem.sources) continue;

      const remoteRoom = Game.rooms[remoteName];
      if (!remoteRoom) continue;

      const sources = remoteRoom.find(FIND_SOURCES);
      for (const src of sources) {
        const key = `${remoteName}:${src.id}`;

        if (!mem.paths[key]) {
          const harvestPos = this._chooseHarvestTile(src);
          const goal = harvestPos ? { pos: harvestPos, range: 0 } : { pos: src.pos, range: 1 };

          const ret = PathFinder.search(this._getAnchorPos(homeRoom), goal, {
            plainCost: PLAIN_COST,
            swampCost: SWAMP_COST,
            roomCallback: (roomName) => this._roomCostMatrix(roomName)
          });

          if (!ret.path || ret.path.length === 0 || ret.incomplete) continue;

          mem.paths[key] = {
            i: 0,
            done: false,
            path: ret.path.map(p => ({ x: p.x, y: p.y, roomName: p.roomName }))
          };
        }

        this._placeAlongPath(homeRoom, key, PLACE_BUDGET_PER_TICK);
        this._auditAndRelaunch(homeRoom, key, 1);
      }
    }
  },

  /** NEW: choose anchor (spawn until storage exists, then storage). */
  _getAnchorPos(homeRoom) {
    if (homeRoom.storage) return homeRoom.storage.pos;
    const spawns = homeRoom.find(FIND_MY_SPAWNS);
    return spawns.length ? spawns[0].pos : null;
  },

  /** NEW: Path + track with a stable key, then drip-place + audit (one-stop helper). */
  _planAndTrack(homeRoom, fromPos, goalPos, key, range = 1) {
    if (!fromPos || !goalPos) return;
    const mem = this._memory(homeRoom);

    if (!mem.paths[key]) {
      const ret = PathFinder.search(fromPos, { pos: goalPos, range }, {
        plainCost: PLAIN_COST,
        swampCost: SWAMP_COST,
        roomCallback: (roomName) => this._roomCostMatrix(roomName)
      });
      if (!ret.path || ret.path.length === 0 || ret.incomplete) return;

      mem.paths[key] = {
        i: 0,
        done: false,
        path: ret.path.map(p => ({ x: p.x, y: p.y, roomName: p.roomName }))
      };
    }

    this._placeAlongPath(homeRoom, key, PLACE_BUDGET_PER_TICK);
    this._auditAndRelaunch(homeRoom, key, 1);
  },

  /** NEW: stage-aware local network to sources (+controller optional) */
  ensureStagedHomeNetwork(homeRoom) {
    const anchor = this._getAnchorPos(homeRoom);
    if (!anchor) return;

    // pave to each home-room source (use harvest tile if we can see it)
    const sources = homeRoom.find(FIND_SOURCES);
    for (let i = 0; i < sources.length; i++) {
      const src = sources[i];
      const harv = this._chooseHarvestTile(src) || src.pos;
      const range = (harv === src.pos) ? 1 : 0;
      const key = `${homeRoom.name}:LOCAL:source${i}:from=${homeRoom.storage ? 'storage' : 'spawn'}`;
      this._planAndTrack(homeRoom, anchor, harv, key, range);
    }

    // optional: pave to controller and storage (nice logistics spine)
    if (INCLUDE_CONTROLLER && homeRoom.controller) {
      const keyC = `${homeRoom.name}:LOCAL:controller:from=${homeRoom.storage ? 'storage' : 'spawn'}`;
      this._planAndTrack(homeRoom, anchor, homeRoom.controller.pos, keyC, 1);
    }
    if (homeRoom.storage) {
      // If we just “graduated” to storage, make sure spawn ↔ storage is paved
      const spawns = homeRoom.find(FIND_MY_SPAWNS);
      if (spawns.length) {
        const keyS = `${homeRoom.name}:LOCAL:spawn0-to-storage`;
        this._planAndTrack(homeRoom, spawns[0].pos, homeRoom.storage.pos, keyS, 1);
      }
    }
  },

  /** Cost matrix builder (shared) */
  _roomCostMatrix(roomName) {
    const room = Game.rooms[roomName];
    if (!room) return;
    const costs = new PathFinder.CostMatrix();

    room.find(FIND_STRUCTURES).forEach(s => {
      if (s.structureType === STRUCTURE_ROAD) {
        costs.set(s.pos.x, s.pos.y, ROAD_COST);
      } else if (
        s.structureType !== STRUCTURE_CONTAINER &&
        (s.structureType !== STRUCTURE_RAMPART || !s.my)
      ) {
        costs.set(s.pos.x, s.pos.y, 0xff);
      }
    });

    room.find(FIND_CONSTRUCTION_SITES).forEach(cs => {
      if (cs.structureType !== STRUCTURE_ROAD) {
        costs.set(cs.pos.x, cs.pos.y, 0xff);
      }
    });

    room.find(FIND_SOURCES).forEach(s => costs.set(s.pos.x, s.pos.y, 0xff));
    const minerals = room.find(FIND_MINERALS) || [];
    minerals.forEach(m => costs.set(m.pos.x, m.pos.y, 0xff));

    return costs;
  },

  /** Drip-placer (unchanged except for minor comment) */
  _placeAlongPath(homeRoom, key, budget) {
    if (Object.keys(Game.constructionSites).length > CSITE_SAFETY_LIMIT) return;

    const mem = this._memory(homeRoom);
    const rec = mem.paths[key];
    if (!rec || rec.done) return;

    let placed = 0;
    let iterations = 0;

    while (rec.i < rec.path.length && placed < budget) {
      if (++iterations > budget + 10) break;

      const step = rec.path[rec.i];
      const roomObj = Game.rooms[step.roomName];
      if (!roomObj) break;

      const terrainVal = roomObj.getTerrain().get(step.x, step.y);
      if (terrainVal !== TERRAIN_MASK_WALL) {
        const pos = new RoomPosition(step.x, step.y, step.roomName);
        if (!hasRoadOrRoadSite(pos)) {
          const res = roomObj.createConstructionSite(pos, STRUCTURE_ROAD);
          if (res === OK) {
            placed++;
          } else if (res === ERR_FULL) {
            break; // global cap
          } // else: silently skip other rc (tile blocked); pointer still advances
        }
      }
      rec.i++;
    }
    if (rec.i >= rec.path.length) rec.done = true;
  },

  /** Memory bucket */
  _memory(homeRoom) {
    if (!Memory.rooms) Memory.rooms = {};
    if (!Memory.rooms[homeRoom.name]) Memory.rooms[homeRoom.name] = {};
    const r = Memory.rooms[homeRoom.name];
    if (!r.roadPlanner) r.roadPlanner = { paths: {} };
    if (!r.roadPlanner.paths) r.roadPlanner.paths = {};
    return r.roadPlanner;
  },

  /** Info helper */
  getActiveRemoteRooms(homeRoom) {
    const mem = this._memory(homeRoom);
    const rooms = new Set();
    for (const key of Object.keys(mem.paths || {})) {
      rooms.add(key.split(':')[0]);
    }
    return [...rooms];
  },

  /** Audit + relaunch if tiles decayed (unchanged) */
  _auditAndRelaunch(homeRoom, key, maxFixes = 1) {
    const mem = this._memory(homeRoom);
    const rec = mem.paths[key];
    if (!rec || !rec.done || !Array.isArray(rec.path) || rec.path.length === 0) return;

    if (Game.time % AUDIT_INTERVAL !== 0 && Math.random() > 0.01) return;

    let fixed = 0;
    for (let idx = 0; idx < rec.path.length && fixed < maxFixes; idx++) {
      const step = rec.path[idx];
      const roomObj = Game.rooms[step.roomName];
      if (!roomObj) continue;

      const terrainVal = roomObj.getTerrain().get(step.x, step.y);
      if (terrainVal === TERRAIN_MASK_WALL) continue;

      const pos = new RoomPosition(step.x, step.y, step.roomName);
      if (!hasRoadOrRoadSite(pos)) {
        const res = roomObj.createConstructionSite(pos, STRUCTURE_ROAD);
        if (res === OK) {
          if (typeof rec.i !== 'number' || rec.i > idx) rec.i = idx;
          rec.done = false;
          fixed++;
        }
      }
    }
  },

  /** Harvest tile chooser (unchanged) */
  _chooseHarvestTile(src) {
    const room = Game.rooms[src.pos.roomName];
    if (!room) return null;

    const terrain = room.getTerrain();
    let best = null;
    let bestScore = -Infinity;

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
  },

  /** Remote room discovery (unchanged) */
  _getActiveRemoteRoomsFromCreeps() {
    const set = new Set();
    for (const name in Game.creeps) {
      const c = Game.creeps[name];
      if (c && c.memory && c.memory.task === 'remoteharvest' && c.memory.targetRoom) {
        set.add(c.memory.targetRoom);
      }
    }
    return [...set];
  }
};

module.exports = RoadPlanner;
