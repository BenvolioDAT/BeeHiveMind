// Teaching note: this planner intentionally keeps its knobs in one object
// so novice contributors can tweak behavior without spelunking the code.
const CFG = Object.freeze({
  maxSitesPerTick: 5,
  csiteSafetyLimit: 40,
  tickModulo: 2,
  noPlacementCooldownPlaced: 4,
  noPlacementCooldownNone: 10
});

// Hard caps (upper bounds). Still clamped by CONTROLLER_STRUCTURES per RCL.
const STRUCTURE_LIMITS = (() => {
  const limits = {};
  limits[STRUCTURE_TOWER] = 6;
  limits[STRUCTURE_EXTENSION] = 60;
  limits[STRUCTURE_CONTAINER] = 10;
  limits[STRUCTURE_RAMPART] = 2;
  limits[STRUCTURE_ROAD] = 150;
  return limits;
})();

// Base layout blueprint: offsets around the anchor spawn. Keeping the
// array flat makes it easy to tweak or visualize.
const BASE_OFFSETS = [
  { type: STRUCTURE_STORAGE,   x:  8, y:  0 },
  { type: STRUCTURE_SPAWN,     x: -5, y:  0 },
  { type: STRUCTURE_SPAWN,     x:  5, y:  0 },

  { type: STRUCTURE_EXTENSION, x:  0, y:  2 },
  { type: STRUCTURE_EXTENSION, x:  0, y: -2 },
  { type: STRUCTURE_EXTENSION, x:  0, y:  3 },
  { type: STRUCTURE_EXTENSION, x:  0, y: -3 },
  { type: STRUCTURE_EXTENSION, x: -1, y:  3 },
  { type: STRUCTURE_EXTENSION, x: -1, y: -3 },
  { type: STRUCTURE_EXTENSION, x:  1, y: -3 },
  { type: STRUCTURE_EXTENSION, x:  1, y:  3 },
  { type: STRUCTURE_EXTENSION, x: -1, y:  2 },
  { type: STRUCTURE_EXTENSION, x: -1, y: -2 },
  { type: STRUCTURE_EXTENSION, x:  1, y:  2 },
  { type: STRUCTURE_EXTENSION, x:  1, y: -2 },
  { type: STRUCTURE_EXTENSION, x: -2, y: -1 },
  { type: STRUCTURE_EXTENSION, x: -2, y:  1 },
  { type: STRUCTURE_EXTENSION, x:  2, y: -1 },
  { type: STRUCTURE_EXTENSION, x:  2, y:  1 },
  { type: STRUCTURE_EXTENSION, x: -3, y:  1 },
  { type: STRUCTURE_EXTENSION, x: -3, y: -1 },
  { type: STRUCTURE_EXTENSION, x:  3, y:  1 },
  { type: STRUCTURE_EXTENSION, x:  3, y: -1 },
  { type: STRUCTURE_EXTENSION, x: -3, y:  2 },
  { type: STRUCTURE_EXTENSION, x: -3, y: -2 },
  { type: STRUCTURE_EXTENSION, x:  3, y:  2 },
  { type: STRUCTURE_EXTENSION, x:  3, y: -2 },
  { type: STRUCTURE_EXTENSION, x: -4, y:  2 },
  { type: STRUCTURE_EXTENSION, x: -4, y: -2 },
  { type: STRUCTURE_EXTENSION, x:  4, y:  2 },
  { type: STRUCTURE_EXTENSION, x:  4, y: -2 },
  { type: STRUCTURE_EXTENSION, x:  4, y:  3 },
  { type: STRUCTURE_EXTENSION, x:  4, y: -3 },
  { type: STRUCTURE_EXTENSION, x: -4, y:  3 },
  { type: STRUCTURE_EXTENSION, x: -4, y: -3 },
  { type: STRUCTURE_EXTENSION, x: -4, y:  4 },
  { type: STRUCTURE_EXTENSION, x: -4, y: -4 },
  { type: STRUCTURE_EXTENSION, x:  4, y:  4 },
  { type: STRUCTURE_EXTENSION, x:  4, y: -4 },
  { type: STRUCTURE_EXTENSION, x:  3, y:  4 },
  { type: STRUCTURE_EXTENSION, x:  3, y: -4 },
  { type: STRUCTURE_EXTENSION, x: -3, y:  4 },
  { type: STRUCTURE_EXTENSION, x: -3, y: -4 },
  { type: STRUCTURE_EXTENSION, x: -2, y:  4 },
  { type: STRUCTURE_EXTENSION, x: -2, y: -4 },
  { type: STRUCTURE_EXTENSION, x:  2, y:  4 },
  { type: STRUCTURE_EXTENSION, x:  2, y: -4 },
  { type: STRUCTURE_EXTENSION, x:  2, y:  5 },
  { type: STRUCTURE_EXTENSION, x:  2, y: -5 },
  { type: STRUCTURE_EXTENSION, x: -2, y: -5 },
  { type: STRUCTURE_EXTENSION, x: -2, y:  5 },
  { type: STRUCTURE_EXTENSION, x: -1, y: -5 },
  { type: STRUCTURE_EXTENSION, x: -1, y:  5 },
  { type: STRUCTURE_EXTENSION, x:  1, y:  5 },
  { type: STRUCTURE_EXTENSION, x:  1, y: -5 },
  { type: STRUCTURE_EXTENSION, x:  0, y:  5 },
  { type: STRUCTURE_EXTENSION, x:  0, y: -5 },
  { type: STRUCTURE_EXTENSION, x: -4, y:  0 },
  { type: STRUCTURE_EXTENSION, x:  4, y:  0 },
  { type: STRUCTURE_EXTENSION, x: -5, y:  1 },
  { type: STRUCTURE_EXTENSION, x: -5, y: -1 },
  { type: STRUCTURE_EXTENSION, x:  5, y:  1 },
  { type: STRUCTURE_EXTENSION, x:  5, y: -1 }
];

function isOwnedRoom(room) {
  return room && room.controller && room.controller.my;
}

function shouldSkipTick(room) {
  if (CFG.tickModulo <= 1) return false;
  let hash = 0;
  const name = room.name;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return (((Game.time + (hash & 3)) % CFG.tickModulo) !== 0);
}

function plannerMemory(room) {
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};
  if (!Memory.rooms[room.name].planner) Memory.rooms[room.name].planner = {};
  return Memory.rooms[room.name].planner;
}

function globalConstructionSiteCount() {
  return Object.keys(Game.constructionSites).length;
}

function pickAnchor(room) {
  const spawns = room.find(FIND_MY_SPAWNS);
  return spawns.length ? spawns[0].pos : null;
}

/** Snapshot the room once so we do not repeatedly scan structures/sites. */
function scanRoomState(room) {
  const built = Object.create(null);
  const sites = Object.create(null);
  const terrain = room.getTerrain();

  const arrStructs = room.find(FIND_STRUCTURES);
  for (let i = 0; i < arrStructs.length; i++) {
    const stype = arrStructs[i].structureType;
    built[stype] = (built[stype] | 0) + 1;
  }

  const arrSites = room.find(FIND_CONSTRUCTION_SITES);
  for (let j = 0; j < arrSites.length; j++) {
    const sType = arrSites[j].structureType;
    sites[sType] = (sites[sType] | 0) + 1;
  }

  return { built, sites, terrain };
}

function allowedCount(type, room) {
  const hard = (STRUCTURE_LIMITS[type] !== undefined) ? STRUCTURE_LIMITS[type] : Infinity;
  let controllerLimit = Infinity;
  if (room.controller && typeof CONTROLLER_STRUCTURES !== 'undefined') {
    const table = CONTROLLER_STRUCTURES[type];
    if (table) {
      const lvl = room.controller.level | 0;
      controllerLimit = (table[lvl] != null) ? table[lvl] : 0;
    } else {
      controllerLimit = 0;
    }
  }
  return (hard < controllerLimit) ? hard : controllerLimit;
}

function buildOccupancyChecker(room) {
  return function hasAnythingAt(x, y) {
    if (room.lookForAt(LOOK_STRUCTURES, x, y).length) return true;
    if (room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y).length) return true;
    return false;
  };
}

/**
 * High level orchestration:
 *  1. Skip work unless this is our tick slice (smooth CPU).
 *  2. Bail early if global construction sites are near the limit.
 *  3. Place one container per owned source before touching the core base.
 *  4. Lay out the base blueprint offsets as the final drip.
 */
function ensureSites(room) {
  if (!isOwnedRoom(room)) return;
  if (shouldSkipTick(room)) return;

  const mem = plannerMemory(room);
  if (mem.nextPlanTick && Game.time < mem.nextPlanTick) return;

  const anchor = pickAnchor(room);
  if (!anchor) return;

  const globalCount = globalConstructionSiteCount();
  if (globalCount >= CFG.csiteSafetyLimit) {
    mem.nextPlanTick = Game.time + CFG.noPlacementCooldownNone;
    return;
  }

  const snapshot = scanRoomState(room);
  const allowedFn = (type) => allowedCount(type, room);
  let placed = 0;
  let cCount = globalCount;

  // Phase 1: shore up source containers so harvesters always have parking.
  const containerDelta = ensureSourceContainers(
    room,
    snapshot.terrain,
    snapshot.built,
    snapshot.sites,
    allowedFn,
    CFG.maxSitesPerTick - placed,
    CFG.csiteSafetyLimit - cCount
  );
  placed += containerDelta.placed;
  cCount += containerDelta.placed;

  if (placed >= CFG.maxSitesPerTick || cCount >= CFG.csiteSafetyLimit) {
    mem.nextPlanTick = Game.time + CFG.noPlacementCooldownPlaced;
    return;
  }

  // Phase 2: follow the base offsets as long as we have placements left.
  const basePlaced = ensureBaseLayout(
    room,
    anchor,
    snapshot,
    allowedFn,
    CFG.maxSitesPerTick - placed,
    CFG.csiteSafetyLimit - cCount
  );
  placed += basePlaced;
  cCount += basePlaced;

  mem.nextPlanTick = Game.time + (placed ? CFG.noPlacementCooldownPlaced : CFG.noPlacementCooldownNone);
}

/**
 * Given the anchor spawn/storage, iterate the BASE_OFFSETS blueprint and
 * place whatever is still missing. Everything is kept tiny and linear so
 * new contributors can trace the decision making.
 */
function ensureBaseLayout(room, anchor, snapshot, allowedFn, slotsLeft, globalCapLeft) {
  if (!anchor) return 0;
  if (slotsLeft <= 0 || globalCapLeft <= 0) return 0;

  const hasAnythingAt = buildOccupancyChecker(room);
  let placed = 0;

  for (let i = 0; i < BASE_OFFSETS.length; i++) {
    if (slotsLeft <= 0 || globalCapLeft <= 0) break;

    const plan = BASE_OFFSETS[i];
    const tx = anchor.x + plan.x;
    const ty = anchor.y + plan.y;

    if (tx < 1 || tx > 48 || ty < 1 || ty > 48) continue;
    if (snapshot.terrain.get(tx, ty) === TERRAIN_MASK_WALL) continue;
    if (hasAnythingAt(tx, ty)) continue;

    const have = (snapshot.built[plan.type] | 0) + (snapshot.sites[plan.type] | 0);
    const cap = allowedFn(plan.type);
    if (have >= cap) continue;

    const rc = room.createConstructionSite(tx, ty, plan.type);
    if (rc === OK) {
      placed++;
      slotsLeft--;
      globalCapLeft--;
      snapshot.sites[plan.type] = (snapshot.sites[plan.type] | 0) + 1;
    }
  }

  return placed;
}

/**
 * Place exactly one container per source in an owned room that has a spawn.
 * Updates Memory.rooms[roomName].sources[sourceId].container = {status, x, y, id/siteId}
 *
 * Status values:
 *  - "Good"    : container exists and is healthy
 *  - "Repair"  : container exists but needs TLC
 *  - "Building": csite exists within range 1 of the source
 *  - "Need"    : no container/csite; we will attempt to place (respecting caps)
 */
function ensureSourceContainers(room, terrain, built, sites, allowedFn, slotsLeft, globalCapLeft) {
  let placed = 0;

  if (!room) return { placed: 0 };
  if (slotsLeft <= 0 || globalCapLeft <= 0) return { placed: 0 };

  const capContainers = allowedFn(STRUCTURE_CONTAINER);
  let haveContainers = (built[STRUCTURE_CONTAINER] | 0) + (sites[STRUCTURE_CONTAINER] | 0);
  if (haveContainers >= capContainers) return { placed: 0 };

  const sourcesMem = ensureRoomSourceMemory(room);
  const passable = buildPassableChecker(room, terrain);
  const sources = room.find(FIND_SOURCES);

  for (let s = 0; s < sources.length; s++) {
    const src = sources[s];
    const sid = src.id;
    if (!sourcesMem[sid]) sourcesMem[sid] = {};
    if (!sourcesMem[sid].container) sourcesMem[sid].container = {};
    const cmem = sourcesMem[sid].container;

    const structs = src.pos.findInRange(FIND_STRUCTURES, 1, {
      filter: (o) => o.structureType === STRUCTURE_CONTAINER
    });
    if (structs.length) {
      const cont = structs[0];
      cmem.x = cont.pos.x;
      cmem.y = cont.pos.y;
      cmem.id = cont.id;
      cmem.siteId = undefined;
      const healthy = (cont.hits != null && cont.hitsMax != null) ? (cont.hits / cont.hitsMax) : 1;
      cmem.status = (healthy < 0.60) ? 'Repair' : 'Good';
      continue;
    }

    const cs = src.pos.findInRange(FIND_CONSTRUCTION_SITES, 1, {
      filter: (c) => c.structureType === STRUCTURE_CONTAINER
    });
    if (cs.length) {
      cmem.x = cs[0].pos.x;
      cmem.y = cs[0].pos.y;
      cmem.id = undefined;
      cmem.siteId = cs[0].id;
      cmem.status = 'Building';
      continue;
    }

    cmem.status = 'Need';
    if (slotsLeft <= 0 || globalCapLeft <= 0) continue;
    if (haveContainers >= capContainers) continue;

    let placedHere = false;
    for (let dx = -1; dx <= 1 && !placedHere; dx++) {
      for (let dy = -1; dy <= 1 && !placedHere; dy++) {
        if (dx === 0 && dy === 0) continue;
        const tx = src.pos.x + dx;
        const ty = src.pos.y + dy;
        if (!passable(tx, ty)) continue;

        const rc = room.createConstructionSite(tx, ty, STRUCTURE_CONTAINER);
        if (rc === OK) {
          cmem.x = tx;
          cmem.y = ty;
          cmem.id = undefined;
          cmem.status = 'Building';
          const lookup = room.lookForAt(LOOK_CONSTRUCTION_SITES, tx, ty);
          cmem.siteId = (lookup && lookup.length) ? lookup[0].id : undefined;

          placed++;
          slotsLeft--;
          globalCapLeft--;
          haveContainers++;
          sites[STRUCTURE_CONTAINER] = (sites[STRUCTURE_CONTAINER] | 0) + 1;
          placedHere = true;
        }
      }
    }
  }

  return { placed };
}

function ensureRoomSourceMemory(room) {
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};
  if (!Memory.rooms[room.name].sources) Memory.rooms[room.name].sources = {};
  return Memory.rooms[room.name].sources;
}

function buildPassableChecker(room, terrain) {
  return function isPassable(x, y) {
    if (x < 1 || x > 48 || y < 1 || y > 48) return false;
    if (terrain.get(x, y) === TERRAIN_MASK_WALL) return false;

    const ss = room.lookForAt(LOOK_STRUCTURES, x, y);
    for (let i = 0; i < ss.length; i++) {
      const st = ss[i].structureType;
      if (st === STRUCTURE_ROAD) continue;
      if (st === STRUCTURE_CONTAINER) continue;
      if (st === STRUCTURE_RAMPART && ss[i].my) continue;
      return false;
    }

    if (room.lookForAt(LOOK_CONSTRUCTION_SITES, x, y).length) return false;
    return true;
  };
}

const RoomPlanner = {
  structureLimits: STRUCTURE_LIMITS,
  BASE_OFFSETS,
  ensureSites,
  _ensureSourceContainers: ensureSourceContainers,
  _memory: plannerMemory
};

module.exports = RoomPlanner;
