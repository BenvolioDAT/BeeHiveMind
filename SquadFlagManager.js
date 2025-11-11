/**
 * SquadFlagManager.js — maintains rally/target flags that drive BeeCombatSquads.
 *
 * Combat pipeline placement: Sense → Decide. This module senses threats via room scans
 * and decides which rooms deserve squad attention by binding Squad* flags accordingly.
 *
 * Inputs: live Game.flags, Game.rooms, Game.creeps, configuration constants below, and
 * Memory.squadFlags/Memory.squads. Outputs: created/removed flags, Memory.squadFlags
 * updates (rooms + bindings), and anchor breadcrumbs written into Memory.squads for
 * consumption by BeeCombatSquads and combat roles.
 *
 * Collaborations: BeeCombatSquads.js reads Memory.squadFlags.bindings/rooms to compute
 * anchors; role.CombatArcher.js, role.CombatMelee.js, and role.CombatMedic.js follow
 * those anchors through BeeCombatSquads.getAnchor(). BeeCombatSquads shared targeting
 * assumes flags remain stable across ticks.
 */

var SquadFlagManager = (function () {

  // ------------- Config -------------
  var CFG = {
    // Stagger scanning work: 1 = every tick, 3 = ~1/3 of rooms per tick (by hash)
    scanModulo: 3,

    // Scoring threshold before we consider a room a threat (for assignment)
    minThreatScore: 5,

    // Consider non-Invader hostiles too?
    includeNonInvaderHostiles: false,

    // Threat scoring knobs
    score: {
      invaderCreep: 5,      // per invader creep
      otherHostileCreep: 2, // per non-invader hostile (if enabled)
      invaderCore: 15,      // core present
      hostileTower: 10,     // hostile tower
      hostileSpawn: 6       // hostile spawn
    },

    // Persistence:
    // - We only DROP a bound flag when we have vision AND
    //   (Game.time - lastThreatAt) > dropGrace.
    dropGrace: 50,

    // When assigning an unbound flag, treat rooms as "recently threatened" if
    // last threat was seen within this window (helps with stagger & brief vision gaps).
    assignRecentWindow: 20,

    // Flag names managed (priority order)
    names: ['SquadAlpha', 'SquadBravo', 'SquadCharlie', 'SquadDelta'],

    // Hard cap (normally just names.length)
    maxFlags: 4
  };

  /**
   * Memory schema reference:
   *
   * Memory.squadFlags = {
   *   rooms: {
   *     [roomName]: {
   *       lastSeen: number,                 // last Game.time tick we had vision
   *       lastThreatAt: number,             // last tick we detected a threat
   *       lastPos: { x:number, y:number, roomName:string }|null,
   *       lastScore: number                 // cached threat score at last scan
   *     }
   *   },
   *   bindings: { [flagName:string]: roomName:string }
   * }
   *
   * Memory.squads[squadId] (populated here when anchors are remembered) mirrors the
   * structure documented in BeeCombatSquads.js.
   */

  // ------------- Memory bucket -------------
  /**
   * _mem
   *
   * @return {Object} Root Memory.squadFlags object with rooms/bindings maps.
   * Preconditions: Memory global is available.
   * Postconditions: Memory.squadFlags.rooms/bindings exist.
   * Side-effects: Initializes persistent Memory keys when missing.
   */
  function _mem() {
    // [1] Ensure root container exists so callers can rely on object structure.
    if (!Memory.squadFlags) Memory.squadFlags = { rooms: {}, bindings: {} };
    if (!Memory.squadFlags.rooms) Memory.squadFlags.rooms = {};
    if (!Memory.squadFlags.bindings) Memory.squadFlags.bindings = {};
    return Memory.squadFlags;
  }

  /**
   * _ensureSquadMem
   *
   * @param {string} id Squad identifier derived from flag name.
   * @return {Object|null} Memory bucket for given squad or null when id invalid.
   * Preconditions: Memory global available.
   * Postconditions: Memory.squads[id] initialized with anchor metadata.
   * Side-effects: Mutates persistent Memory.squads.
   */
  function _ensureSquadMem(id) {
    // [1] Validate identifier to avoid polluting Memory with null keys.
    if (!id) return null;
    if (!Memory.squads) Memory.squads = {};

    // [2] Lazily create squad bucket if absent (mirrors BeeCombatSquads defaults).
    if (!Memory.squads[id]) Memory.squads[id] = { targetId: null, targetAt: 0, anchor: null, anchorAt: 0 };
    return Memory.squads[id];
  }

  /**
   * _squadIdFromFlagName
   *
   * @param {string} name Flag name (e.g., "SquadAlpha" or "Squad_Beta").
   * @return {string|null} Squad identifier extracted from flag naming convention.
   * Preconditions: name follows Squad* pattern.
   * Postconditions: none.
   */
  function _squadIdFromFlagName(name) {
    // [1] Support both legacy "Squad" and "Squad_" prefixes.
    if (!name) return null;
    if (name.indexOf('Squad_') === 0) return name.substring(6);
    if (name.indexOf('Squad') === 0) return name.substring(5);
    return null;
  }

  /**
   * _rememberAnchor
   *
   * @param {string} flagName Managed flag name.
   * @param {RoomPosition} pos Position where flag currently resides or is placed.
   * @return {void}
   * Preconditions: Valid flagName resolves to a squadId.
   * Postconditions: Memory.squads[squadId].anchor updated with position + timestamp.
   * Side-effects: Persists anchor coordinates for BeeCombatSquads.getAnchor().
   */
  function _rememberAnchor(flagName, pos) {
    // [1] No position available means we keep previous anchor.
    if (!pos) return;
    var squadId = _squadIdFromFlagName(flagName);
    if (!squadId) return;

    // [2] Acquire squad Memory bucket; bail if initialization failed.
    var bucket = _ensureSquadMem(squadId);
    if (!bucket) return;

    // [3] Serialize RoomPosition for Memory storage and stamp timestamp for freshness.
    bucket.anchor = { x: pos.x, y: pos.y, roomName: pos.roomName };
    bucket.anchor.room = pos.roomName;
    bucket.anchorAt = Game.time;
  }

  /**
   * _clearAnchor
   *
   * @param {string} flagName Managed flag name being removed.
   * @return {void}
   * Preconditions: Corresponding squad Memory bucket exists.
   * Postconditions: anchor cleared so BeeCombatSquads falls back to alternate sources.
   */
  function _clearAnchor(flagName) {
    // [1] Translate flagName to squadId and guard against missing Memory bucket.
    var squadId = _squadIdFromFlagName(flagName);
    if (!squadId || !Memory.squads || !Memory.squads[squadId]) return;

    // [2] Clear anchor data and mark timestamp for stale detection.
    Memory.squads[squadId].anchor = null;
    Memory.squads[squadId].anchorAt = Game.time;
  }

  // ------------- Helpers -------------

  /**
   * _roomsWithNonScoutCreeps
   *
   * @return {Array<string>} Room names currently containing our non-scout creeps.
   * Preconditions: Game.creeps populated.
   * Postconditions: none.
   * Side-effects: none.
   * Edge cases: ignores creeps lacking memory or classification.
   */
  function _roomsWithNonScoutCreeps() {
    // [1] Build temporary set of room names where allied combat/logistics creeps exist.
    var set = {};
    for (var cname in Game.creeps) {
      var c = Game.creeps[cname];
      if (!c || !c.my || !c.memory) continue;
      var tagSource = (c.memory.role != null) ? c.memory.role : c.memory.task;
      var tag = (tagSource || '').toString().toLowerCase();
      if (tag === 'scout' || tag.indexOf('scout') === 0) continue;
      set[c.pos.roomName] = true;
    }

    // [2] Convert set to array for deterministic downstream iteration.
    var out = [];
    for (var rn in set) out.push(rn);
    return out;
  }

  /**
   * _roomHashMod
   *
   * @param {string} roomName Room identifier to hash.
   * @param {number} mod Modulo base controlling scan staggering.
   * @return {number} Deterministic hash bucket (0..mod-1).
   * Preconditions: mod >= 1.
   */
  function _roomHashMod(roomName, mod) {
    // [1] A modulo of 1 disables staggering.
    if (mod <= 1) return 0;

    // [2] Simple polynomial hash to distribute rooms evenly across ticks.
    var h = 0, i;
    for (i = 0; i < roomName.length; i++) h = ((h * 31) + roomName.charCodeAt(i)) | 0;
    return Math.abs(h) % mod;
  }

  /**
   * _scoreRoom
   *
   * @param {Room} room Visible room to evaluate for Invader threats.
   * @return {{score:number,pos:RoomPosition|null}} Threat score and representative position.
   * Preconditions: Caller has vision (room exists in Game.rooms).
   * Postconditions: none.
   * Edge cases: gracefully ignores PvP rooms by returning zero score.
   */
  function _scoreRoom(room) {
    // [1] Initialize accumulators used to choose anchor location.
    var s = 0;
    var pos = null;

    // [2] Hard bail on PvP rooms: skip rooms owned or reserved by non-Invader players.
    var ctrl = room.controller;
    if (ctrl) {
      if (ctrl.owner && !ctrl.my && ctrl.owner.username !== 'Invader') {
        return { score: 0, pos: null };
      }
      if (ctrl.reservation &&
          ctrl.reservation.username &&
          ctrl.reservation.username !== 'Invader') {
        return { score: 0, pos: null };
      }
    }

    // [3] Score Invader cores first; they anchor the threat location.
    var cores = room.find(FIND_STRUCTURES, {
      filter: function (st) {
        return st.structureType === STRUCTURE_INVADER_CORE;
      }
    });
    if (cores.length > 0) {
      s += cores.length * CFG.score.invaderCore; // e.g., +15 each
      if (!pos) pos = cores[0].pos;
    }

    // [4] Count Invader creeps only; PvE charter avoids retaliating against players.
    var invaderCreeps = room.find(FIND_HOSTILE_CREEPS, {
      filter: function (c) {
        return c.owner && c.owner.username === 'Invader';
      }
    });
    if (invaderCreeps.length > 0) {
      s += invaderCreeps.length * CFG.score.invaderCreep;
      if (!pos) pos = invaderCreeps[0].pos;
    }

    // [5] Score Invader towers to prioritize heavy defenses.
    var invaderTowers = room.find(FIND_HOSTILE_STRUCTURES, {
      filter: function (st) {
        return st.structureType === STRUCTURE_TOWER &&
              st.owner && st.owner.username === 'Invader';
      }
    });
    if (invaderTowers.length > 0) {
      s += invaderTowers.length * CFG.score.hostileTower;
      if (!pos) pos = invaderTowers[0].pos;
    }

    // [6] Score Invader spawns as secondary objectives.
    var invaderSpawns = room.find(FIND_HOSTILE_STRUCTURES, {
      filter: function (st) {
        return st.structureType === STRUCTURE_SPAWN &&
              st.owner && st.owner.username === 'Invader';
      }
    });
    if (invaderSpawns.length > 0) {
      s += invaderSpawns.length * CFG.score.hostileSpawn;
      if (!pos) pos = invaderSpawns[0].pos;
    }

    // [7] Return aggregated threat score and fallback position (null when no threats).
    return { score: s, pos: pos };
  }

  /**
   * _ensureFlagAt
   *
   * @param {string} name Flag name to create or reposition.
   * @param {RoomPosition} pos Desired target position.
   * @return {void}
   * Preconditions: pos is within visible room for final placement.
   * Postconditions: Flag at or near position; Memory anchors updated via _rememberAnchor.
   * Side-effects: May create/remove flags and mutate Memory.squads anchor data.
   * Edge cases: Nudges flag around blocked tiles via concentric search.
   */
  function _ensureFlagAt(name, pos) {
    // [1] If flag already at correct tile, simply refresh anchor timestamp.
    var f = Game.flags[name];
    if (f) {
      if (f.pos.roomName === pos.roomName && f.pos.x === pos.x && f.pos.y === pos.y) {
        _rememberAnchor(name, f.pos);
        return;
      }
      try { f.remove(); } catch (e) {}
    }

    // [2] Attempt to create flag exactly at requested coordinates (requires vision).
    var rc = pos.roomName && Game.rooms[pos.roomName]
      ? Game.rooms[pos.roomName].createFlag(pos, name)
      : ERR_INVALID_TARGET;

    // [3] When placement fails (tile blocked), spiral outward up to distance 2 looking for free tile.
    if (rc !== OK && Game.rooms[pos.roomName]) {
      var i, dx, dy, x, y;
      for (i = 1; i <= 2; i++) {
        for (dx = -i; dx <= i; dx++) {
          for (dy = -i; dy <= i; dy++) {
            if (Math.abs(dx) !== i && Math.abs(dy) !== i) continue;
            x = pos.x + dx; y = pos.y + dy;
            if (x < 1 || x > 48 || y < 1 || y > 48) continue;
            if (Game.rooms[pos.roomName].createFlag(x, y, name) === OK) {
              _rememberAnchor(name, new RoomPosition(x, y, pos.roomName));
              return;
            }
          }
        }
      }
    }

    // [4] Successful placement at original tile updates anchor immediately.
    if (rc === OK) {
      _rememberAnchor(name, pos);
    }
  }

  /**
   * _removeFlag
   *
   * @param {string} name Flag to delete.
   * @return {void}
   * Preconditions: none (handles missing flag gracefully).
   * Postconditions: Flag removed and Memory anchor cleared.
   * Side-effects: Mutates Game.flags and Memory.squads anchors.
   */
  function _removeFlag(name) {
    // [1] Remove live flag when it exists; ignore errors to remain resilient.
    var f = Game.flags[name];
    if (f) { try { f.remove(); } catch (e) {} }

    // [2] Clear anchor so squads fall back to other cues until new flag assigned.
    _clearAnchor(name);
  }

  // ------------- Core logic -------------

  /**
   * ensureSquadFlags — exported function.
   *
   * @return {void}
   * Preconditions: Called every tick (or regularly) after creep/flag updates.
   * Postconditions: Maintains Memory.squadFlags, binds Squad* flags to active threats,
   *   updates Memory.squads anchors, and removes stale flags.
   * Side-effects: Creates/removes flags, writes to Memory.squadFlags and Memory.squads.
   * Edge cases: Handles vision loss by delaying drops until room observed again.
   */
  function ensureSquadFlags() {
    // [1] Acquire Memory bucket and current tick once to share across steps.
    var mem = _mem();
    var tick = Game.time | 0;

    // [2] Scan rooms where we maintain presence (non-scout creeps) using hash staggering.
    var rooms = _roomsWithNonScoutCreeps();
    for (var r = 0; r < rooms.length; r++) {
      var rn = rooms[r];
      var room = Game.rooms[rn];
      if (!room) continue; // no vision; do not change any state

      if ((tick + _roomHashMod(rn, 4)) % (CFG.scanModulo || 1)) continue; // stagger

      var info = _scoreRoom(room);
      var rec = mem.rooms[rn] || (mem.rooms[rn] = { lastSeen: 0, lastThreatAt: 0, lastPos: null, lastScore: 0 });

      rec.lastSeen = tick;
      rec.lastScore = info.score | 0;
      if (info.score >= CFG.minThreatScore && info.pos) {
        rec.lastThreatAt = tick;
        rec.lastPos = { x: info.pos.x, y: info.pos.y, roomName: info.pos.roomName };
      } else {
        // [2.1] Keep lastThreatAt to allow grace-period retention; seed position with room center when missing.
        if (!rec.lastPos) rec.lastPos = { x: 25, y: 25, roomName: rn };
      }
      mem.rooms[rn] = rec;
    }

    // [3] Maintain existing bindings to avoid flag flicker.
    var boundNames = {};
    var nameIdx, fname, boundRoom;

    for (nameIdx = 0; nameIdx < CFG.names.length; nameIdx++) {
      fname = CFG.names[nameIdx];
      boundRoom = mem.bindings[fname];

      if (!boundRoom) continue; // unbound, will assign later

      boundNames[fname] = true;

      var rrec = mem.rooms[boundRoom]; // may be undefined if we never scanned it yet
      var keep = true;

      if (Game.rooms[boundRoom]) {
        // [3.1] With vision, release binding when threat absent beyond dropGrace ticks.
        var lastAt = rrec && rrec.lastThreatAt || 0;
        if ((tick - lastAt) > CFG.dropGrace) {
          _removeFlag(fname);
          delete mem.bindings[fname];
          keep = false;
        }
      }
      if (keep) {
        // [3.2] Re-plant flag near last known threat position (default to room center).
        var pos = (rrec && rrec.lastPos)
          ? new RoomPosition(rrec.lastPos.x, rrec.lastPos.y, rrec.lastPos.roomName)
          : new RoomPosition(25, 25, boundRoom);
        _ensureFlagAt(fname, pos);
        _rememberAnchor(fname, pos);
      }
    }

    // [4] Assign unbound flags to the strongest recent threats.
    var candidates = [];
    var now = tick;
    for (var rn in mem.rooms) {
      if (!mem.rooms.hasOwnProperty(rn)) continue;
      var rec2 = mem.rooms[rn];
      if (!rec2 || typeof rec2.lastThreatAt !== 'number') continue;
      if ((now - rec2.lastThreatAt) <= CFG.assignRecentWindow) {
        var already = false;
        for (var n2 in mem.bindings) {
          if (mem.bindings[n2] === rn) { already = true; break; }
        }
        if (!already) {
          candidates.push({ rn: rn, lastSeen: rec2.lastSeen | 0, lastThreatAt: rec2.lastThreatAt | 0 });
        }
      }
    }

    // [4.1] Prefer the freshest threats; tie-break by most recent vision.
    candidates.sort(function(a,b){
      if (b.lastThreatAt !== a.lastThreatAt) return b.lastThreatAt - a.lastThreatAt;
      return b.lastSeen - a.lastSeen;
    });

    // [4.2] Bind available flags in configured order until we run out of threats or names.
    var maxN = Math.min(CFG.maxFlags, CFG.names.length);
    var usedCount = 0;
    for (nameIdx = 0; nameIdx < maxN; nameIdx++) {
      fname = CFG.names[nameIdx];
      if (mem.bindings[fname]) { usedCount++; continue; }

      var pick = candidates.shift();
      if (!pick) break;

      mem.bindings[fname] = pick.rn;
      usedCount++;

      var rec3 = mem.rooms[pick.rn];
      var placePos = (rec3 && rec3.lastPos)
        ? new RoomPosition(rec3.lastPos.x, rec3.lastPos.y, rec3.lastPos.roomName)
        : new RoomPosition(25,25,pick.rn);
      _ensureFlagAt(fname, placePos);
      _rememberAnchor(fname, placePos);
    }

    // [5] Cleanup stray flags that lost bindings or exceed our managed list.
    for (var fName in Game.flags) {
      if (!Game.flags.hasOwnProperty(fName)) continue;
      if (CFG.names.indexOf(fName) === -1) continue; // not ours
      if (!mem.bindings[fName]) {
        _removeFlag(fName);
      }
    }

    // [6] Prune ancient room records to keep Memory lean.
    for (var k in mem.rooms) {
      if (!mem.rooms.hasOwnProperty(k)) continue;
      if ((tick - (mem.rooms[k].lastSeen | 0)) > 20000) delete mem.rooms[k];
    }
  }

  return {
    ensureSquadFlags: ensureSquadFlags
  };
})();

module.exports = SquadFlagManager;

/**
 * Collaboration Map:
 * - Runs before BeeCombatSquads.getAnchor(), ensuring Memory.squadFlags.bindings points
 *   to rooms containing active threats and that anchors reflect flag positions.
 * - Supplies rally data for role.CombatArcher.js, role.CombatMelee.js, and
 *   role.CombatMedic.js indirectly through BeeCombatSquads shared anchor logic.
 * - Expects BeeCombatSquads to respect Memory.squadFlags updates and to fall back to
 *   stored anchors when flags are temporarily missing.
 * Edge cases noted:
 * - No vision in target room: bindings preserved until dropGrace expires after regained vision.
 * - Enemy disappears mid-tick: lastThreatAt retains recent timestamp to avoid premature drop.
 * - Flag moved manually: ensureSquadFlags re-anchors Memory based on actual flag position.
 * - Flag deleted externally: _rememberAnchor/_clearAnchor reset Memory and next scan reassigns.
 */
