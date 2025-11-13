'use strict';

const BeeCombatSquads = require('BeeCombatSquads');
const CombatAPI = BeeCombatSquads.CombatAPI;

const CFG = {
  DEBUG: false,
  SUPPORT_PREFIX: 'SQUAD_',
  TYPES: {
    RALLY: { color: COLOR_GREEN, secondary: COLOR_WHITE },
    ATTACK: { color: COLOR_RED, secondary: COLOR_WHITE },
    RETREAT: { color: COLOR_YELLOW, secondary: COLOR_WHITE },
    WAYPOINT: { color: COLOR_BLUE, secondary: COLOR_WHITE }
  }
};

/**
 * Gentle log helper so we can sprinkle debug statements without worrying about
 * console access. New contributors can set CFG.DEBUG = true for guided output.
 */
function logDebug() {
  if (!CFG.DEBUG || !console || !console.log) return;
  const args = Array.prototype.slice.call(arguments);
  args.unshift('[SquadFlagManager]');
  console.log.apply(console, args);
}

function isSupportFlag(name) {
  return Boolean(name && name.indexOf(CFG.SUPPORT_PREFIX) === 0);
}

function isSquadFlag(name) {
  if (!name) return false;
  if (isSupportFlag(name)) return false;
  return name.indexOf('Squad') === 0;
}

/**
 * Memory.squadFlags stores lightweight telemetry. This helper both initializes
 * the structure and returns it so calling code can read/write confidently.
 */
function ensureMem() {
  if (!Memory.squadFlags) Memory.squadFlags = { rooms: {}, bindings: {} };
  if (!Memory.squadFlags.rooms) Memory.squadFlags.rooms = {};
  if (!Memory.squadFlags.bindings) Memory.squadFlags.bindings = {};
  return Memory.squadFlags;
}

function updateRoomRecord(mem, flag, room, threatScore, sawThreat) {
  if (!flag || !flag.pos) return;
  const roomName = flag.pos.roomName;
  if (!mem.rooms[roomName]) {
    mem.rooms[roomName] = { lastSeen: 0, lastThreatAt: 0, lastPos: null, lastScore: 0 };
  }
  const rec = mem.rooms[roomName];
  rec.lastSeen = Game.time;
  rec.lastPos = { x: flag.pos.x, y: flag.pos.y, roomName };
  if (typeof threatScore === 'number') rec.lastScore = threatScore;
  if (sawThreat) rec.lastThreatAt = Game.time;
  mem.rooms[roomName] = rec;
}

function countHostiles(room) {
  if (!room) return { score: 0, hasThreat: false };
  const hostiles = room.find(FIND_HOSTILE_CREEPS);
  const hostileStructs = room.find(FIND_HOSTILE_STRUCTURES);
  const score = hostiles.length * 5 + hostileStructs.length * 3;
  return { score, hasThreat: (hostiles.length + hostileStructs.length) > 0 };
}

function sanitizeSlug(flagName) {
  if (!flagName) return 'SQUAD';
  let slug = flagName;
  if (slug.indexOf('Squad') === 0) slug = slug.substring(5);
  slug = slug.replace(/[^0-9A-Za-z]/g, '');
  if (!slug) slug = flagName.replace(/[^0-9A-Za-z]/g, '');
  if (!slug) slug = 'SQUAD';
  return slug.toUpperCase();
}

function serializePos(pos) {
  if (!pos) return null;
  if (pos instanceof RoomPosition) return { x: pos.x, y: pos.y, roomName: pos.roomName };
  if (pos.pos) return serializePos(pos.pos);
  if (pos.x != null && pos.y != null && pos.roomName) return { x: pos.x, y: pos.y, roomName: pos.roomName };
  if (typeof pos === 'string') {
    const flag = Game.flags[pos];
    if (flag && flag.pos) return serializePos(flag.pos);
  }
  return null;
}

function samePos(a, b) {
  return Boolean(a && b && a.x === b.x && a.y === b.y && a.roomName === b.roomName);
}

function posFrom(data) {
  const raw = serializePos(data);
  if (!raw || raw.x == null || raw.y == null || !raw.roomName) return null;
  return raw;
}

/**
 * Tactical plans live inside Memory.squads[flagName]. This helper reads the
 * various legacy property names we still support and returns a normalized plan
 * object novices can reason about (state + rally/attack/retreat/waypoints).
 */
function resolvePlan(flagName) {
  if (!flagName || !Memory.squads) return null;
  const bucket = Memory.squads[flagName];
  if (!bucket) return null;
  let attack = bucket.target || bucket.targetPos || bucket.attack || bucket.focusTargetPos;
  if (!attack && bucket.focusTarget) {
    const obj = Game.getObjectById(bucket.focusTarget);
    if (obj && obj.pos) attack = obj.pos;
  }
  return {
    name: flagName,
    state: extractState(flagName, bucket),
    rally: posFrom(bucket.rally || bucket.rallyPos || bucket.anchor || bucket.squadRally),
    attack: posFrom(attack),
    retreat: posFrom(bucket.retreat || bucket.retreatPos || bucket.fallback || bucket.fallbackPos),
    waypoints: normalizeWaypoints(bucket.waypoints || bucket.route || bucket.path || bucket.waypointList)
  };
}

function extractState(flagName, mem) {
  if (mem && mem.state) return mem.state;
  if (CombatAPI && typeof CombatAPI.getSquadState === 'function') {
    return CombatAPI.getSquadState(flagName);
  }
  return 'INIT';
}

function normalizeWaypoints(raw) {
  if (!raw) return [];
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw.points && Array.isArray(raw.points)) list = raw.points;
  else list = [raw];
  const normalized = [];
  for (let i = 0; i < list.length; i++) {
    const pos = posFrom(list[i]);
    if (pos) normalized.push(pos);
  }
  return normalized;
}

/**
 * Tiny IO shim that either reuses an existing flag or creates a new one in the
 * desired room. This wrapper hides defensive checks from the rest of the code.
 */
const FlagIO = {
  ensureFlag(name, pos, color, secondary, allowAlternate) {
    if (!name || !pos) return null;
    const desired = posFrom(pos);
    if (!desired) {
      if (CFG.DEBUG) logDebug('Invalid position for', name);
      return null;
    }
    const existing = Game.flags[name];
    if (existing && existing.pos && samePos(existing.pos, desired)) {
      const needsPrimary = color != null && existing.color !== color;
      const needsSecondary = secondary != null && existing.secondaryColor !== secondary;
      if ((needsPrimary || needsSecondary) && existing.setColor) {
        existing.setColor(color || existing.color, secondary || existing.secondaryColor);
      }
      return existing;
    }
    const roomName = desired.roomName;
    if (!roomName) {
      if (CFG.DEBUG) logDebug('Missing room for', name);
      return null;
    }
    const room = Game.rooms[roomName];
    if (!room) {
      if (CFG.DEBUG) logDebug('No vision in', roomName, 'to place flag', name);
      return null;
    }
    if (color == null || secondary == null) {
      if (CFG.DEBUG) logDebug('Color undefined for', name);
      return null;
    }
    const result = room.createFlag(desired.x, desired.y, name, color, secondary);
    if (typeof result === 'string') return Game.flags[result];
    if (result === ERR_NAME_EXISTS && allowAlternate !== false) {
      const altName = name + '_1';
      if (!Game.flags[altName]) {
        const retry = room.createFlag(desired.x, desired.y, altName, color, secondary);
        if (typeof retry === 'string') return Game.flags[retry];
      } else if (samePos(Game.flags[altName].pos, desired)) {
        return Game.flags[altName];
      }
    }
    if (result !== OK && CFG.DEBUG) logDebug('Failed to place', name, '->', result);
    return existing || null;
  },
  getOrMake(name, roomName, x, y, color, secondary) {
    if (!roomName || x == null || y == null) return null;
    return this.ensureFlag(name, { x, y, roomName }, color, secondary);
  }
};

function ensurePrimaryFlag(plan) {
  if (!plan || !plan.rally) return null;
  if (Game.flags[plan.name]) return Game.flags[plan.name];
  const colors = CFG.TYPES.RALLY;
  return FlagIO.ensureFlag(plan.name, plan.rally, colors.color, colors.secondary, false);
}

function buildSupportName(plan, type, index) {
  const slug = sanitizeSlug(plan.name);
  let suffix = type;
  if (index != null) suffix += '_' + index;
  return CFG.SUPPORT_PREFIX + slug + '_' + suffix;
}

function registerFlag(flag, expected) {
  if (!flag || !flag.name || !expected) return;
  expected[flag.name] = true;
}

function ensureSupportFlag(plan, type, pos, expected, order) {
  if (!plan || !pos || !expected) return null;
  const colors = CFG.TYPES[type];
  if (!colors) {
    if (CFG.DEBUG) logDebug('Missing color mapping for', type);
    return null;
  }
  const name = buildSupportName(plan, type, order);
  const flag = FlagIO.ensureFlag(name, pos, colors.color, colors.secondary, true);
  registerFlag(flag, expected);
  return flag;
}

function ensureSupportFlags(plan, expected) {
  if (!plan) return;
  if (plan.rally) ensureSupportFlag(plan, 'RALLY', plan.rally, expected, null);
  if (plan.attack) ensureSupportFlag(plan, 'ATTACK', plan.attack, expected, null);
  if (plan.retreat) ensureSupportFlag(plan, 'RETREAT', plan.retreat, expected, null);
  const waypoints = plan.waypoints || [];
  for (let i = 0; i < waypoints.length; i++) {
    ensureSupportFlag(plan, 'WAYPOINT', waypoints[i], expected, i + 1);
  }
}

function cleanupSupportFlags(expected) {
  for (const name in Game.flags) {
    if (!Object.prototype.hasOwnProperty.call(Game.flags, name)) continue;
    if (!isSupportFlag(name)) continue;
    if (expected && expected[name]) continue;
    const flag = Game.flags[name];
    if (flag && typeof flag.remove === 'function') flag.remove();
  }
}

function syncPlannedFlags() {
  if (!Memory.squads) return;
  const expected = {};
  for (const flagName in Memory.squads) {
    if (!Object.prototype.hasOwnProperty.call(Memory.squads, flagName)) continue;
    const plan = resolvePlan(flagName);
    if (!plan) continue;
    if (!plan.rally && CFG.DEBUG) logDebug('No rally defined for', flagName);
    ensurePrimaryFlag(plan);
    ensureSupportFlags(plan, expected);
  }
  cleanupSupportFlags(expected);
}

/**
 * High-level orchestration run once per tick. While the helper functions above
 * focus on one responsibility each, this routine strings them together:
 *   1. Scan visible flags, tagging which rooms host them and capturing threats.
 *   2. Nudge CombatAPI toward the correct state (FORM, ENGAGE, RETREAT).
 *   3. Trim stale metadata and then mirror plans from Memory into physical flags.
 */
function ensureSquadFlags() {
  const mem = ensureMem();
  const seen = {};

  for (const name in Game.flags) {
    if (!Object.prototype.hasOwnProperty.call(Game.flags, name)) continue;
    if (!isSquadFlag(name)) continue;
    const flag = Game.flags[name];
    seen[name] = true;
    mem.bindings[name] = flag.pos.roomName;

    // Ensure Memory.squads entry exists and rally is captured.
    CombatAPI.assignFormation(name, []);

    const room = flag.room || null;
    const threat = countHostiles(room);
    const currentState = CombatAPI.getSquadState(name);
    let nextState = currentState;
    if (currentState !== 'RETREAT') {
      nextState = threat.hasThreat ? 'ENGAGE' : 'FORM';
      if (room) {
        const targetId = CombatAPI.getAttackTarget(room, {});
        if (!targetId && !threat.hasThreat) nextState = 'FORM';
        if (targetId) nextState = 'ENGAGE';
      }
    }
    CombatAPI.setSquadState(name, nextState);
    updateRoomRecord(mem, flag, room, threat.score, threat.hasThreat);
  }

  for (const existing in mem.bindings) {
    if (!Object.prototype.hasOwnProperty.call(mem.bindings, existing)) continue;
    if (!seen[existing]) delete mem.bindings[existing];
  }

  for (const roomName in mem.rooms) {
    if (!Object.prototype.hasOwnProperty.call(mem.rooms, roomName)) continue;
    const rec = mem.rooms[roomName];
    if (!rec) continue;
    if ((Game.time - (rec.lastSeen || 0)) > 20000) delete mem.rooms[roomName];
  }

  syncPlannedFlags();
}

const SquadFlagManager = { ensureSquadFlags };
module.exports = SquadFlagManager;

// Console test checklist:
// 1. Ensure squads in RALLY/ATTACK/RETREAT states emit exactly one flag per type.
// 2. Toggle CFG.DEBUG = true for a single tick to verify placement logs.
// 3. Confirm cleanup skips valid SQUAD_* flags and removes stale ones.
