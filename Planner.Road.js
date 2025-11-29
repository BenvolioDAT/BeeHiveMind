
/** =========================
 *  Config (tweak here)
 *  ========================= */
const CFG = Object.freeze({
  // Pathfinding weights
  plainCost: 2,
  swampCost: 10,
  roadCost: 1,

  // Pathfinding safety caps (prevent expensive searches on mega routes)
  maxRoomsPlanning: 4,        // cap path search footprint (tune for your empire layout)
  maxOpsPlanning: 20000,       // PathFinder ops guardrail; lower on CPU pinches

  // Placement behavior
  placeBudgetPerTick: 3,      // ROAD sites we attempt per tick across a path
  globalCSiteSafetyLimit: 3,  // skip if near 100 cap
  plannerTickModulo: 3,        // run ensureRemoteRoads only 1/modulo ticks (staggered by room)

  // Auditing: regular interval + tiny random chance to smooth load
  auditInterval: 100,          // bumped for calmer CPU
  randomAuditChance: 0.01,     // 1% background audit on off-ticks

  // Home network
  includeControllerSpoke: true,

  // NEW: hard cap on how far (in room hops) we will plan remote roads from this home.
  // Set to 0 (or negative) to disable radius limiting.
  maxRemoteRadius: 1
});

// Road planner keeps all “how do we lay roads?” choices here so the main Screeps
// loop can simply call ensureRemoteRoads each tick. The helpers below focus on
// being readable and showing why each step runs, not on clever abstractions.

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
    remotes: []
  };
}

/** Get global construction site count once per tick. */
function getCSiteCountOnce() {
  if (__RPM.csiteCountTick === _tick()) return __RPM.csiteCount;
  __RPM.csiteCountTick = _tick();
  __RPM.csiteCount = Object.keys(Game.constructionSites).length;
  return __RPM.csiteCount;
}

/** Cached active remote rooms (scan creeps once per tick). */
function activeRemotesOncePerTick() {
  if (__RPM.remoteTick === _tick()) return __RPM.remotes;
  const set = new Set();
  for (const name in Game.creeps) {
    const c = Game.creeps[name];
    if (c && c.memory && c.memory.task === 'luna' && c.memory.targetRoom) {
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
function hasRoadOrRoadSiteFast(room, x, y) {
  const sArr = room.lookForAt(LOOK_STRUCTURES, x, y);
  for (let i = 0; i < sArr.length; i++) if (sArr[i].structureType === STRUCTURE_ROAD) return true;

  const siteArr = room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y);
  for (let i = 0; i < siteArr.length; i++) if (siteArr[i].structureType === STRUCTURE_ROAD) return true;

  return false;
}

/** =========================
 *  RoadPlanner module helpers
 *  ========================= */

/** Quick ownership guard so we never work on neutral/safe-mode rooms. */
function isOwnedRoom(room) {
  return room && room.controller && room.controller.my;
}

/**
 * Pseudo-randomly stagger the heavy planner work so multi-room empires
 * do not pile all the CPU on the same tick. We hash the name just once
 * per call and compare it to the configured modulo cadence.
 */
function shouldSkipTick(homeRoom) {
  if (CFG.plannerTickModulo <= 1) return false;
  // Simple deterministic hash to stagger work; summing character codes keeps it obvious.
  let hash = 0;
  const name = homeRoom.name;
  for (let i = 0; i < name.length; i++) {
    hash += name.charCodeAt(i);
  }
  const stagger = Math.abs(hash % CFG.plannerTickModulo);
  return (((_tick() + stagger) % CFG.plannerTickModulo) !== 0);
}

function ensureRemoteRoads(homeRoom) {
  if (!isOwnedRoom(homeRoom)) return;
  if (shouldSkipTick(homeRoom)) return;

  // Keep memory fresh and clean before doing any heavier work.
  const mem = memoryFor(homeRoom);
  pruneOutOfRadiusPaths(homeRoom, mem);

  // We need at least a spawn or storage anchor to lay meaningful roads.
  if (!hasAnchorReady(homeRoom)) return;

  const anchor = getAnchorPos(homeRoom);
  ensureStagedHomeNetwork(homeRoom, anchor);
  ensureRemoteSpokes(homeRoom, mem, anchor);
}

// ---------- Home network (staged) ----------

function hasAnchorReady(homeRoom) {
  if (homeRoom.storage) return true;
  return homeRoom.find(FIND_MY_SPAWNS).length > 0;
}

function getAnchorPos(homeRoom) {
  if (homeRoom.storage) return homeRoom.storage.pos;
  const spawns = homeRoom.find(FIND_MY_SPAWNS);
  return spawns.length ? spawns[0].pos : null;
}

/**
 * Friendly wrapper that plans (if needed), drip-places, and audits a track
 * between two in-room positions. Novice contributors can call this for any
 * “from → goal” pair without touching the lower-level PathFinder code.
 */
function planTrackPlaceAudit(homeRoom, fromPos, goalPos, key, range = 1) {
  if (!fromPos || !goalPos) return;
  const mem = memoryFor(homeRoom);

  if (!mem.paths[key]) {
    const pathRecord = planPathRecord(fromPos, { pos: goalPos, range });
    if (!pathRecord) return;
    mem.paths[key] = pathRecord;
  }

  dripPlaceAlongPath(homeRoom, key, CFG.placeBudgetPerTick);
  auditAndRelaunch(homeRoom, key, /*maxFixes*/ 1);
}

function planPathRecord(fromPos, goal) {
  const ret = PathFinder.search(fromPos, goal, {
    plainCost: CFG.plainCost,
    swampCost: CFG.swampCost,
    maxRooms: CFG.maxRoomsPlanning,
    maxOps: CFG.maxOpsPlanning,
    roomCallback: (roomName) => roomCostMatrix(roomName)
  });
  if (!ret.path || !ret.path.length || ret.incomplete) return null;
  return {
    i: 0,
    done: false,
    path: ret.path.map(p => ({ x: p.x, y: p.y, roomName: p.roomName }))
  };
}

function ensureStagedHomeNetwork(homeRoom, anchor) {
  if (!anchor) return;

  // (A) Spokes to sources
  const sources = homeRoom.find(FIND_SOURCES);
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    const harv = chooseHarvestTile(src) || src.pos;
    const range = (harv === src.pos) ? 1 : 0;
    const stage = homeRoom.storage ? 'storage' : 'spawn';
    const key = `${homeRoom.name}:LOCAL:source${i}:from=${stage}`;
    planTrackPlaceAudit(homeRoom, anchor, harv, key, range);
  }

  // (B) Optional spoke to controller
  if (CFG.includeControllerSpoke && homeRoom.controller) {
    const stage = homeRoom.storage ? 'storage' : 'spawn';
    const keyC = `${homeRoom.name}:LOCAL:controller:from=${stage}`;
    planTrackPlaceAudit(homeRoom, anchor, homeRoom.controller.pos, keyC, 1);
  }

  // (C) Spawn ↔ storage backbone once storage exists
  if (homeRoom.storage) {
    const spawns = homeRoom.find(FIND_MY_SPAWNS);
    if (spawns.length) {
      const keyS = `${homeRoom.name}:LOCAL:spawn0-to-storage`;
      planTrackPlaceAudit(homeRoom, spawns[0].pos, homeRoom.storage.pos, keyS, 1);
    }
  }
}

// ---------- Path placement + auditing ----------

function dripPlaceAlongPath(homeRoom, key, budget) {
  if (getCSiteCountOnce() > CFG.globalCSiteSafetyLimit) return;

  const mem = memoryFor(homeRoom);
  const rec = mem.paths[key];
  if (!rec || rec.done) return;

  let placed = 0;
  let iterations = 0;

  while (rec.i < rec.path.length && placed < budget) {
    if (++iterations > budget + 10) break;

    const step = rec.path[rec.i];
    const roomObj = Game.rooms[step.roomName];
    if (!roomObj) break; // need visibility to place

    if (roomObj.getTerrain().get(step.x, step.y) !== TERRAIN_MASK_WALL) {
      if (!hasRoadOrRoadSiteFast(roomObj, step.x, step.y)) {
        const rc = roomObj.createConstructionSite(step.x, step.y, STRUCTURE_ROAD);
        if (rc === OK) {
          placed++;
          if (getCSiteCountOnce() > CFG.globalCSiteSafetyLimit) break;
        } else if (rc === ERR_FULL) {
          break;
        }
      }
    }
    rec.i++;
  }

  if (rec.i >= rec.path.length) rec.done = true;
}

function auditAndRelaunch(homeRoom, key, maxFixes = 1) {
  const mem = memoryFor(homeRoom);
  const rec = mem.paths[key];
  if (!rec || !rec.done || !Array.isArray(rec.path) || !rec.path.length) return;

  const onInterval = (_tick() % CFG.auditInterval) === 0;
  const randomTick = Math.random() < CFG.randomAuditChance;
  if (!onInterval && !randomTick) return;

  let fixed = 0;
  for (let idx = 0; idx < rec.path.length && fixed < maxFixes; idx++) {
    const step = rec.path[idx];
    const roomObj = Game.rooms[step.roomName];
    if (!roomObj) continue;

    if (roomObj.getTerrain().get(step.x, step.y) === TERRAIN_MASK_WALL) continue;

    if (!hasRoadOrRoadSiteFast(roomObj, step.x, step.y)) {
      const rc = roomObj.createConstructionSite(step.x, step.y, STRUCTURE_ROAD);
      if (rc === OK) {
        if (typeof rec.i !== 'number' || rec.i > idx) rec.i = idx;
        rec.done = false;
        fixed++;
        if (getCSiteCountOnce() > CFG.globalCSiteSafetyLimit) break;
      } else if (rc === ERR_FULL) {
        break;
      }
    }
  }
}

// ---------- Cost matrix (per-tick cache) ----------

function roomCostMatrix(roomName) {
  const room = Game.rooms[roomName];
  if (!room) return;

  if (__RPM.cmTick !== _tick()) {
    __RPM.cmTick = _tick();
    __RPM.cm = Object.create(null);
  }

  const cached = __RPM.cm[roomName];
  if (cached) return cached;

  const costs = new PathFinder.CostMatrix();

  // Roads cheaper, all other impassable structures fully blocked.
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

  // Avoid construction sites that would block travel when finished.
  const sites = room.find(FIND_CONSTRUCTION_SITES);
  for (let i = 0; i < sites.length; i++) {
    const cs = sites[i];
    if (cs.structureType !== STRUCTURE_ROAD) {
      costs.set(cs.pos.x, cs.pos.y, 0xff);
    }
  }

  // Keep harvest targets out of the matrix so we do not path through them.
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
}

  // ---------- Memory + info ----------

function memoryFor(homeRoom) {
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[homeRoom.name]) Memory.rooms[homeRoom.name] = {};

  const r = Memory.rooms[homeRoom.name];
  if (!r.roadPlanner) r.roadPlanner = { paths: {} };
  if (!r.roadPlanner.paths) r.roadPlanner.paths = {};
  return r.roadPlanner;
}
 
function getActiveRemoteRooms(homeRoom) {
  const mem = memoryFor(homeRoom);
  const rooms = new Set();
  for (const key of Object.keys(mem.paths || {})) {
    rooms.add(key.split(':')[0]);
  }
  return [...rooms];
}

function discoverActiveRemoteRoomsFromCreeps() {
  return activeRemotesOncePerTick();
}

// ---------- Remote spokes ----------

function ensureRemoteSpokes(homeRoom, mem, anchor) {
  const activeRemotes = activeRemotesOncePerTick();
  for (const remoteName of activeRemotes) {
    if (shouldSkipRemoteByRadius(homeRoom.name, remoteName)) continue;

    const remoteRoom = Game.rooms[remoteName];
    if (!remoteRoom) continue; // only plan while visible so we avoid stale terrain

    const rmem = Memory.rooms && Memory.rooms[remoteName];
    if (!rmem || !rmem.sources) continue; // needs intel before we can pick sources

    const sources = remoteRoom.find(FIND_SOURCES);
    for (const src of sources) {
      const key = `${remoteName}:${src.id}`;
      if (!mem.paths[key]) {
        const record = planRemotePath(anchor, src);
        if (!record) continue;
        mem.paths[key] = record;
      }

      dripPlaceAlongPath(homeRoom, key, CFG.placeBudgetPerTick);
      auditAndRelaunch(homeRoom, key, /*maxFixes*/ 1);
    }
  }
}

function shouldSkipRemoteByRadius(homeName, remoteName) {
  if (CFG.maxRemoteRadius <= 0) return false;
  const dist = Game.map.getRoomLinearDistance(homeName, remoteName);
  return dist > CFG.maxRemoteRadius;
}

function planRemotePath(anchorPos, src) {
  if (!anchorPos || !src) return null;
  const harvestPos = chooseHarvestTile(src);
  const goal = harvestPos ? { pos: harvestPos, range: 0 } : { pos: src.pos, range: 1 };
  return planPathRecord(anchorPos, goal);
}

// ---------- NEW: radius pruning ----------

function pruneOutOfRadiusPaths(homeRoom, mem) {
  if (!mem || !mem.paths) return;
  if (CFG.maxRemoteRadius <= 0) return; // disabled

  const home = homeRoom.name;
  for (const key of Object.keys(mem.paths)) {
    const remotePrefix = key.split(':')[0];
    if (!remotePrefix || remotePrefix === home || remotePrefix === 'LOCAL') continue;

    if (shouldSkipRemoteByRadius(home, remotePrefix)) {
      delete mem.paths[key];
    }
  }
}

// ---------- Discovery helpers ----------

function chooseHarvestTile(src) {
  const room = Game.rooms[src.pos.roomName];
  if (!room) return null;

  const terrain = room.getTerrain();

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

      const structs = room.lookForAt(LOOK_STRUCTURES, x, y);
      let score = 0;
      for (let i = 0; i < structs.length; i++) {
        if (structs[i].structureType === STRUCTURE_ROAD) score += 5;
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

const RoadPlanner = {
  ensureRemoteRoads,
  getActiveRemoteRooms,
  _memory: memoryFor,
  _pruneOutOfRadiusPaths: pruneOutOfRadiusPaths,
  _planTrackPlaceAudit: planTrackPlaceAudit,
  _ensureStagedHomeNetwork: ensureStagedHomeNetwork,
  _dripPlaceAlongPath: dripPlaceAlongPath,
  _auditAndRelaunch: auditAndRelaunch,
  _roomCostMatrix: roomCostMatrix,
  _getAnchorPos: getAnchorPos,
  _chooseHarvestTile: chooseHarvestTile,
  _discoverActiveRemoteRoomsFromCreeps: discoverActiveRemoteRoomsFromCreeps
};

module.exports = RoadPlanner;
