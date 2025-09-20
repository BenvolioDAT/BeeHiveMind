// Planner.Road.clean.refactor.cpu.js
// CPU-minded, staged road planner for Screeps
// - Builds a home-room logistics spine (spawn → storage) and spokes to sources (+ optional controller).
// - Plans + drip-places ROAD sites to remote sources used by your remote-harvest creeps.
// - Audits occasionally and relaunches placements if tiles decay.
// Design goals: cut repeated work per tick; reuse path/state; avoid allocations in hot loops.

'use strict';

/** =========================
 *  Config (tweak here)
 *  ========================= */
const CFG = Object.freeze({
  // Pathfinding weights
  plainCost: 2,
  swampCost: 10,
  roadCost: 1,

  // Pathfinding safety caps (prevent expensive searches on mega routes)
  maxRoomsPlanning: 8,        // cap path search footprint (tune for your empire layout)
  maxOpsPlanning: 20000,      // PathFinder ops guardrail; lower on CPU pinches

  // Placement behavior
  placeBudgetPerTick: 10,     // ROAD sites we attempt per tick across a path
  globalCSiteSafetyLimit: 95, // skip if near 100 cap
  plannerTickModulo: 3,       // run ensureRemoteRoads only 1/modulo ticks (staggered by room)
  // Auditing: regular interval + tiny random chance to smooth load
  auditInterval: 100,         // bumped for calmer CPU
  randomAuditChance: 0.01,    // 1% background audit on off-ticks

  // Home network
  includeControllerSpoke: true
});

/** =========================
 *  One-tick caches (zero cost across module calls the same tick)
 *  ========================= */
const _tick = () => Game.time;

if (!global.__RPM) {
  global.__RPM = {
    csiteCountTick: -1,
    csiteCount: 0,
    cmTick: -1,
    cm: Object.create(null), // roomName -> CostMatrix (per tick)
    remoteTick: -1,
    remotes: [],
  };
}

/** Get global construction site count once per tick. */
function getCSiteCountOnce() {
  if (__RPM.csiteCountTick === _tick()) return __RPM.csiteCount;
  __RPM.csiteCountTick = _tick();
  // Counting keys is fine; we do it once.
  __RPM.csiteCount = Object.keys(Game.constructionSites).length;
  return __RPM.csiteCount;
}

/** Cached active remote rooms (scan creeps once per tick). */
function activeRemotesOncePerTick() {
  if (__RPM.remoteTick === _tick()) return __RPM.remotes;
  const set = new Set();
  for (const name in Game.creeps) {
    const c = Game.creeps[name];
    if (c && c.memory && c.memory.task === 'remoteharvest' && c.memory.targetRoom) {
      set.add(c.memory.targetRoom);
    }
  }
  __RPM.remotes = [...set];
  __RPM.remoteTick = _tick();
  return __RPM.remotes;
}

/** =========================
 *  Fast tile checks (avoid allocations)
 *  ========================= */
/**
 * Cheap check for existing road or road site at (x,y) in room.
 * Uses room.lookForAt to avoid constructing RoomPosition objects in hot loops.
 */
function hasRoadOrRoadSiteFast(room, x, y) {
  // Structures first (fast path)
  const sArr = room.lookForAt(LOOK_STRUCTURES, x, y);
  for (let i = 0; i < sArr.length; i++) if (sArr[i].structureType === STRUCTURE_ROAD) return true;

  // Then sites
  const siteArr = room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y);
  for (let i = 0; i < siteArr.length; i++) if (siteArr[i].structureType === STRUCTURE_ROAD) return true;

  return false;
}

/** =========================
 *  RoadPlanner module
 *  ========================= */
const RoadPlanner = {
  /**
   * Call this from your main loop (once per owned room, or just your primary room).
   * CPU guards:
   *  - Stagger by room via plannerTickModulo
   *  - Remote list cached once per tick
   *  - Per-room CostMatrix cached per tick
   * @param {Room} homeRoom
   */
  ensureRemoteRoads(homeRoom) {
    if (!homeRoom || !homeRoom.controller || !homeRoom.controller.my) return;

    // Stagger work across rooms/ticks to flatten spikes:
    if (CFG.plannerTickModulo > 1) {
      // Stagger by roomName hash (cheap + stable)
      let h = 0;
      for (let i = 0; i < homeRoom.name.length; i++) h = (h * 31 + homeRoom.name.charCodeAt(i)) | 0;
      if (((_tick() + (h & 3)) % CFG.plannerTickModulo) !== 0) return;
    }

    const mem = this._memory(homeRoom);

    // Require some anchor in early game
    const spawns = homeRoom.find(FIND_MY_SPAWNS);
    if (!spawns.length && !homeRoom.storage) return;

    // 1) Staged home logistics network
    this._ensureStagedHomeNetwork(homeRoom);

    // 2) Remote spokes for any active remote-harvest creeps (list cached once per tick)
    const activeRemotes = activeRemotesOncePerTick();
    for (const remoteName of activeRemotes) {
      const rmem = Memory.rooms && Memory.rooms[remoteName];
      if (!rmem || !rmem.sources) continue;            // needs your exploration/memory elsewhere
      const remoteRoom = Game.rooms[remoteName];
      if (!remoteRoom) continue;                       // only plan when visible (safe + accurate)

      const sources = remoteRoom.find(FIND_SOURCES);
      for (const src of sources) {
        const key = `${remoteName}:${src.id}`;
        // Plan once, then drip-place and audit thereafter
        if (!mem.paths[key]) {
          const harvestPos = this._chooseHarvestTile(src);
          const goal = harvestPos ? { pos: harvestPos, range: 0 } : { pos: src.pos, range: 1 };

          const ret = PathFinder.search(this._getAnchorPos(homeRoom), goal, {
            plainCost: CFG.plainCost,
            swampCost: CFG.swampCost,
            maxRooms: CFG.maxRoomsPlanning,
            maxOps: CFG.maxOpsPlanning,
            roomCallback: (roomName) => this._roomCostMatrix(roomName)
          });

          if (!ret.path || !ret.path.length || ret.incomplete) continue;

          mem.paths[key] = {
            i: 0,
            done: false,
            // Store minimal plain objects (no RoomPosition instances)
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
        maxRooms: CFG.maxRoomsPlanning,
        maxOps: CFG.maxOpsPlanning,
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
   * - Uses zero-allocation coordinate form (x,y) to avoid RoomPosition churn.
   * - Advances the cursor (rec.i) whether or not a placement happens to avoid re-trying blocked tiles forever.
   * - Stops if global construction sites are near the cap.
   * @param {Room} homeRoom
   * @param {string} key
   * @param {number} budget
   */
  _dripPlaceAlongPath(homeRoom, key, budget) {
    if (getCSiteCountOnce() > CFG.globalCSiteSafetyLimit) return;

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

      // Skip walls fast
      if (roomObj.getTerrain().get(step.x, step.y) !== TERRAIN_MASK_WALL) {
        if (!hasRoadOrRoadSiteFast(roomObj, step.x, step.y)) {
          const rc = roomObj.createConstructionSite(step.x, step.y, STRUCTURE_ROAD);
          if (rc === OK) {
            placed++;
            // Re-check global cap in case we got close during loop
            if (getCSiteCountOnce() > CFG.globalCSiteSafetyLimit) break;
          } else if (rc === ERR_FULL) {
            break; // hit global cap
          }
          // Other error codes: silently skip; still advance cursor
        }
      }
      rec.i++;
    }

    if (rec.i >= rec.path.length) rec.done = true;
  },

  /**
   * Periodic gap-fix audit:
   * - On schedule or tiny random chance, scan a handful of tiles.
   * - If missing road & not a wall & visible, queue a site and rewind cursor so drip-placer resumes from there.
   */
  _auditAndRelaunch(homeRoom, key, maxFixes = 1) {
    const mem = this._memory(homeRoom);
    const rec = mem.paths[key];
    if (!rec || !rec.done || !Array.isArray(rec.path) || !rec.path.length) return;

    // Throttle audits to reduce CPU (regular interval OR low-probability random check)
    const onInterval = (_tick() % CFG.auditInterval) === 0;
    const randomTick = Math.random() < CFG.randomAuditChance;
    if (!onInterval && !randomTick) return;

    let fixed = 0;
    for (let idx = 0; idx < rec.path.length && fixed < maxFixes; idx++) {
      const step = rec.path[idx];
      const roomObj = Game.rooms[step.roomName];
      if (!roomObj) continue; // need visibility to fix

      if (roomObj.getTerrain().get(step.x, step.y) === TERRAIN_MASK_WALL) continue;

      if (!hasRoadOrRoadSiteFast(roomObj, step.x, step.y)) {
        const rc = roomObj.createConstructionSite(step.x, step.y, STRUCTURE_ROAD);
        if (rc === OK) {
          // Rewind cursor to this gap so drip placer resumes from here
          if (typeof rec.i !== 'number' || rec.i > idx) rec.i = idx;
          rec.done = false;
          fixed++;
          if (getCSiteCountOnce() > CFG.globalCSiteSafetyLimit) break;
        } else if (rc === ERR_FULL) {
          break;
        }
      }
    }
  },

  // ---------- Cost matrix (per-tick cache) ----------

  /**
   * Favor roads; block most non-road buildings; allow own ramparts; block minerals/sources.
   * Cached per room per tick so repeated PathFinder calls don’t rebuild it.
   * @param {string} roomName
   * @returns {PathFinder.CostMatrix|undefined}
   */
  _roomCostMatrix(roomName) {
    const room = Game.rooms[roomName];
    if (!room) return; // no visibility → leave undefined (PathFinder uses defaults)

    if (__RPM.cmTick !== _tick()) {
      __RPM.cmTick = _tick();
      __RPM.cm = Object.create(null);
    }
    const cached = __RPM.cm[roomName];
    if (cached) return cached;

    const costs = new PathFinder.CostMatrix();

    // Existing roads are cheap to encourage reuse
    const structs = room.find(FIND_STRUCTURES);
    for (let i = 0; i < structs.length; i++) {
      const s = structs[i];
      if (s.structureType === STRUCTURE_ROAD) {
        costs.set(s.pos.x, s.pos.y, CFG.roadCost);
      } else if (
        s.structureType !== STRUCTURE_CONTAINER &&
        (s.structureType !== STRUCTURE_RAMPART || !s.my)
      ) {
        costs.set(s.pos.x, s.pos.y, 0xff);
      }
    }

    // Block non-road construction sites (don't plan through incoming walls)
    const sites = room.find(FIND_CONSTRUCTION_SITES);
    for (let i = 0; i < sites.length; i++) {
      const cs = sites[i];
      if (cs.structureType !== STRUCTURE_ROAD) {
        costs.set(cs.pos.x, cs.pos.y, 0xff);
      }
    }

    // Keep sources/minerals non-walkable for pathfinding
    const sources = room.find(FIND_SOURCES);
    for (let i = 0; i < sources.length; i++) {
      const s = sources[i];
      costs.set(s.pos.x, s.pos.y, 0xff);
    }
    const minerals = room.find(FIND_MINERALS);
    for (let i = 0; i < minerals.length; i++) {
      const m = minerals[i];
      costs.set(m.pos.x, m.pos.y, 0xff);
    }

    __RPM.cm[roomName] = costs;
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
   * Kept for API compatibility, but not used internally (we cache once per tick).
   * @returns {string[]}
   */
  _discoverActiveRemoteRoomsFromCreeps() {
    return activeRemotesOncePerTick();
  },

  /**
   * Pick the best adjacent harvest tile for a Source:
   * - Prefer tiles with a container (big bonus) or road (smaller bonus).
   * - Avoid walls; penalize swamps slightly.
   * Early-out if we find a container tile.
   * @param {Source} src
   * @returns {RoomPosition|null}
   */
  _chooseHarvestTile(src) {
    const room = Game.rooms[src.pos.roomName];
    if (!room) return null;

    const terrain = room.getTerrain();
    let best = null;
    let bestScore = -Infinity;

    // First pass: if any container-adjacent tile exists, return it immediately.
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const x = src.pos.x + dx;
        const y = src.pos.y + dy;
        if (x <= 0 || x >= 49 || y <= 0 || y >= 49) continue;
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
        const structs = room.lookForAt(LOOK_STRUCTURES, x, y);
        for (let i = 0; i < structs.length; i++) {
          if (structs[i].structureType === STRUCTURE_CONTAINER) {
            return new RoomPosition(x, y, room.name);
          }
        }
      }
    }

    // Second pass: scoring (road bonus, swamp penalty)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        const x = src.pos.x + dx;
        const y = src.pos.y + dy;
        if (x <= 0 || x >= 49 || y <= 0 || y >= 49) continue;

        const t = terrain.get(x, y);
        if (t === TERRAIN_MASK_WALL) continue;

        const structs = room.lookForAt(LOOK_STRUCTURES, x, y);
        let score = 0;
        for (let i = 0; i < structs.length; i++) {
          const type = structs[i].structureType;
          if (type === STRUCTURE_ROAD) score += 5;
        }
        if (t === TERRAIN_MASK_SWAMP) score -= 2;

        if (score > bestScore) {
          bestScore = score;
          best = new RoomPosition(x, y, room.name);
        }
      }
    }
    return best;
  }
};

module.exports = RoadPlanner;
