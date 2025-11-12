/**
 * BeeCombatSquads.js — central squad orchestration layer for BeeHiveMind combat creeps.
 *
 * Combat pipeline mapping: this module sits across Sense → Decide → Act → Move by
 * furnishing squad-level sensing caches, deciding shared targets, issuing movement
 * intents, and coordinating execution via Traveler reservations.
 *
 * Inputs: Game flags (via SquadFlagManager bindings), Memory.squads buckets, Traveler.js,
 * BeeToolbox room callbacks, creep.memory.squadId metadata. Outputs: shared target IDs,
 * anchor RoomPositions, per-creep movement reservations, and status breadcrumbs written
 * into Memory.squads and creep.memory.
 *
 * Collaborations: SquadFlagManager.js supplies flag bindings consumed by getAnchor();
 * role.CombatArcher.js, role.CombatMelee.js, and role.CombatMedic.js call sharedTarget()
 * and stepToward() to synchronize focus fire and positioning. This module guarantees
 * deterministic target sharing and safe pathing before role scripts run their per-tick
 * decisions.
 */

// PvE-only combat: squads fight Invader threats even in my reserved rooms while avoiding PvP.
var BeeToolbox; try { BeeToolbox = require('BeeToolbox'); } catch (e) { BeeToolbox = null; }
var Config; try { Config = require('core.config'); } catch (e3) { Config = { ALLOW_PVP: true, ALLOW_INVADERS_IN_FOREIGN_ROOMS: true }; }
try { require('Traveler'); } catch (e2) { /* ensure Traveler is loaded once */ }

/**
 * Memory schema reference for all consumers (BeeCombatSquads, SquadFlagManager, roles):
 *
 * Memory.squads[squadId] = {
 *   targetId: string|null,        // current shared hostile target for the squad
 *   targetAt: number,             // Game.time tick when targetId was last evaluated
 *   anchor: { x:number, y:number, roomName:string, room?:string }|null,
 *   anchorAt: number              // tick when anchor was last refreshed from flags/creeps
 * }
 *
 * Memory.squadFlags = {
 *   bindings: { [flagName:string]: roomName:string },
 *   rooms: {
 *     [roomName:string]: {
 *       lastPos: { x:number, y:number, roomName:string }, // last sighting of squad flag
 *       lastSeen: number                                  // tick of last observation
 *     }
 *   }
 * }
 *
 * creep.memory mutations performed here (nested under creep.memory):
 *   squadId: string (assigned externally by spawn logic)
 *   stickTargetId: string | undefined
 *   stickTargetAt: number | undefined
 *   squadFlag: string | undefined (when roles pin a specific flag)
 *   _movedAt: number (movement timestamp used for swap etiquette)
 *   _travBusy / _travNoPath: counters for Traveler fallback handling
 *   _lx/_ly: previous position for stuck detection
 */

var TaskSquad = (function () {
  var API = {};
  var _nullTargetLog = {};

  // -----------------------------
  // Tunables
  // -----------------------------
  /**
   * TARGET_STICKY_TICKS — keep a previously chosen target for a short duration to
   * minimize target churn across squad members.
   */
  var TARGET_STICKY_TICKS = 5; // how long to keep a chosen target before re-eval
  /**
   * RALLY_FLAG_PREFIX — root name used when searching for rally flags per squad.
   */
  var RALLY_FLAG_PREFIX   = 'Squad'; // e.g. "SquadAlpha", "Squad_Beta"
  /**
   * MAX_TARGET_RANGE — guard shared target validity for distant creeps.
   */
  var MAX_TARGET_RANGE    = 30;
  /**
   * ANCHOR_STICKY_TICKS — remember last anchor so regrouping continues when flags are unseen.
   */
  var ANCHOR_STICKY_TICKS = 75;  // remember last anchor for a little while (cross-room pathing)

  // Target scoring
  var HEALER_WEIGHT = -500, RANGED_WEIGHT = -260, MELEE_WEIGHT = -140, HURT_WEIGHT = -160, TOUGH_PENALTY = +25;

  // Traveler defaults for combat
  var TRAVELER_DEFAULTS = {
    ignoreCreeps: false,   // start conservative for squads; Traveler flips when stuck
    stuckValue: 2,
    repath: 0.05,
    maxOps: 6000,
    allowHostile: false
  };

  // Role priority (higher number = higher right-of-way)
  var ROLE_PRI = {
    'CombatMelee': 90,
    'Dismantler':  80,
    'CombatArcher':70,
    'CombatMedic': 60
  };

  var COMBAT_ROLES = {
    'CombatMelee': 1,
    'CombatArcher': 1,
    'CombatMedic': 1,
    'Dismantler': 1
  };

  /**
   * _isInvaderCreep
   *
   * @param {Creep|null} c Candidate hostile creep.
   * @return {boolean} True when the creep is owned by Screeps' Invader NPC.
   * Preconditions: none.
   * Postconditions: none.
   * Side-effects: none.
   * Handles missing/invalid creeps by returning false.
   */
  function _isInvaderCreep(c) {
    if (BeeToolbox && BeeToolbox.isNpcHostileCreep) return BeeToolbox.isNpcHostileCreep(c);
    // [1] Treat only Invader-owned creeps as PvE threats we may automatically attack.
    return !!(c && c.owner && c.owner.username === 'Invader');
  }

  /**
   * _isInvaderStruct
   *
   * @param {Structure|null} s Candidate hostile structure.
   * @return {boolean} True when structure is owned by Invader NPC.
   * Preconditions: none.
   * Postconditions: none.
   * Side-effects: none.
   */
  function _isInvaderStruct(s) {
    if (BeeToolbox && BeeToolbox.isNpcHostileStruct) return BeeToolbox.isNpcHostileStruct(s);
    // [1] Same ownership check as creeps so PvP possessions are respected.
    return !!(s && s.owner && s.owner.username === 'Invader');
  }

  var _myNameCacheTick = -1;
  var _myNameCache = null;

  /**
   * _myUsername
   *
   * @return {string|null} Cached player username derived from spawns/rooms.
   * Preconditions: Game global exists (Screeps runtime).
   * Postconditions: _myNameCache/_myNameCacheTick updated for this tick.
   * Side-effects: reads Game.spawns/Game.rooms to infer owner.
   * Failure handling: returns null when no owned asset is visible (e.g., respawn edge cases).
   */
  function _myUsername() {
    // [1] Fast path: reuse cached name within the same tick to avoid repeated scans.
    if (!Game) return null;
    if (BeeToolbox && BeeToolbox.myUsername) {
      var cached = BeeToolbox.myUsername();
      if (cached != null) {
        _myNameCacheTick = Game.time;
        _myNameCache = cached;
        return _myNameCache;
      }
    }
    if (_myNameCacheTick === Game.time && _myNameCache !== undefined) return _myNameCache;

    // [2] Refresh cache timestamp and pessimistically reset cached name.
    _myNameCacheTick = Game.time;
    _myNameCache = null;

    // [3] Scan owned spawns first because they are guaranteed to expose username.
    var s, k;
    for (k in Game.spawns) {
      if (!Game.spawns.hasOwnProperty(k)) continue;
      s = Game.spawns[k];
      if (s && s.owner && s.owner.username) {
        _myNameCache = s.owner.username;
        return _myNameCache;
      }
    }

    // [4] If spawns are absent (outposts), fall back to any controlled room controllers.
    for (k in Game.rooms) {
      var r = Game.rooms[k];
      if (!r || !r.controller) continue;
      if (r.controller.my && r.controller.owner && r.controller.owner.username) {
        _myNameCache = r.controller.owner.username;
        return _myNameCache;
      }
    }

    // [5] No owned asset found this tick; remember null so later lookups skip scanning.
    return _myNameCache;
  }

  /**
   * _isPlayerControlledRoom
   *
   * @param {Room} room Room to evaluate for PvP ownership.
   * @return {boolean} True when the room is owned/reserved by a non-Invader player.
   * Preconditions: room must be visible (caller already in room or observed).
   * Postconditions: none.
   * Side-effects: none beyond username cache read.
   * Handles neutral rooms by returning false.
   */
  function _isPlayerControlledRoom(room) {
    // [1] Validate basic controller presence; neutral rooms are not considered player controlled.
    if (!room || !room.controller) return false;
    var ctrl = room.controller;
    var me = _myUsername();

    if (BeeToolbox && BeeToolbox.isAllyRoom && BeeToolbox.isAllyRoom(room)) return true;

    // [2] Owned by self is considered safe PvE ground, so return false.
    if (ctrl.my) return false;

    // [3] Any non-Invader owner implies PvP; we opt out of offensive action here.
    if (ctrl.owner && ctrl.owner.username && ctrl.owner.username !== 'Invader') return true;

    // [4] Check reservations for remote players while ignoring our own reservation marker.
    if (ctrl.reservation && ctrl.reservation.username &&
        ctrl.reservation.username !== 'Invader' &&
        ctrl.reservation.username !== me) {
      return true;
    }

    // [5] Otherwise treat as unclaimed or Invader-controlled.
    return false;
  }

  /**
   * _roomIsMineOrReserved
   *
   * @param {Room} room Visible room object.
   * @return {boolean} True when owned or reserved by us.
   * Preconditions: visible room controller.
   * Postconditions: none.
   */
  function _roomIsMineOrReserved(room) {
    // [1] Neutral rooms without controllers cannot be ours.
    if (!room || !room.controller) return false;
    var ctrl = room.controller;

    // [2] Direct ownership short-circuits to true.
    if (ctrl.my) return true;

    // [3] Reservations require matching our username to avoid false positives.
    if (!ctrl.reservation || !ctrl.reservation.username) return false;
    var me = _myUsername();
    return !!(me && ctrl.reservation.username === me);
  }

  /**
   * _targetRoomForSquad
   *
   * @param {string} id Squad identifier.
   * @param {Object} S Memory bucket returned by _ensureSquadBucket.
   * @return {string|null} Room name where squad is currently aimed.
   * Preconditions: Memory.squads structure exists.
   * Postconditions: none.
   * Failure mode: returns null when no anchor exists yet (e.g., new squad).
   */
  function _targetRoomForSquad(id, S) {
    // [1] Prefer explicit Memory target assignment (populated by higher-level planners).
    if (S && S.targetRoom) return S.targetRoom;

    // [2] Otherwise attempt to derive a room from the current anchor position.
    var anchor = _bindingAnchorFor(id);
    if (anchor && anchor.roomName) return anchor.roomName;

    // [3] No known target room; likely regrouping or traveling without flag guidance.
    return null;
  }

  // -----------------------------
  // Per-tick move reservation map
  // -----------------------------
  if (!global.__MOVE_RES__) global.__MOVE_RES__ = { tick: -1, rooms: {} };

  /**
   * _resetReservations
   *
   * @return {void}
   * Preconditions: Traveler stepToward invoked within current tick.
   * Postconditions: global.__MOVE_RES__ refreshed for current Game.time.
   * Side-effects: mutates global reservation table once per tick.
   */
  function _resetReservations() {
    // [1] Only rebuild the table when a new tick begins.
    if (global.__MOVE_RES__.tick !== Game.time) {
      global.__MOVE_RES__.tick = Game.time;
      global.__MOVE_RES__.rooms = {};
    }
  }

  /**
   * _key
   *
   * @param {number} x Tile x-coordinate.
   * @param {number} y Tile y-coordinate.
   * @return {string} Unique key for reservation hash maps.
   * Preconditions: x/y are valid map coordinates.
   */
  function _key(x, y) {
    // [1] Simple coordinate concatenation ensures deterministic ordering.
    return x + '_' + y;
  }

  /**
   * _reserveTile
   *
   * @param {Creep} creep Requesting unit.
   * @param {RoomPosition|{pos:RoomPosition}} pos Desired next position.
   * @param {number} priority Priority score derived from role.
   * @return {boolean} True when reservation succeeds.
   * Preconditions: Called after _resetReservations for the tick.
   * Postconditions: global.__MOVE_RES__.rooms updated on success.
   * Side-effects: denies lower-priority creeps from claiming the same tile.
   * Edge cases: gracefully handles missing roomName by treating as success.
   */
  function _reserveTile(creep, pos, priority) {
    // [1] Ensure reservation table exists for current tick.
    _resetReservations();

    // [2] Resolve room name from naked RoomPosition or object with pos field.
    var roomName = pos.roomName || (pos.pos && pos.pos.roomName);
    if (!roomName) return true; // nothing to do

    // [3] Fetch or create room-specific reservation bucket.
    var roomMap = global.__MOVE_RES__.rooms[roomName];
    if (!roomMap) roomMap = (global.__MOVE_RES__.rooms[roomName] = {});

    // [4] Normalize coordinate key; supports either RoomPosition or {pos} containers.
    var k = _key(pos.x || pos.pos.x, pos.y || pos.pos.y);
    var cur = roomMap[k];

    // [5] Empty tile: claim immediately.
    if (!cur) {
      roomMap[k] = { name: creep.name, pri: priority|0 };
      return true;
    }

    // [6] Existing reservation from same creep is always valid (idempotent calls).
    if (cur.name === creep.name) return true;

    // [7] Higher priority overrides existing occupant; ensures melee anchors lead formations.
    if ((priority|0) > (cur.pri|0)) {
      roomMap[k] = { name: creep.name, pri: priority|0 };
      return true;
    }

    // [8] Equal priority is broken deterministically by creep name to avoid oscillation.
    if ((priority|0) === (cur.pri|0) && creep.name < cur.name) {
      roomMap[k] = { name: creep.name, pri: priority|0 };
      return true;
    }

    // [9] Otherwise keep original reservation so lower-priority unit must wait.
    return false; // someone stronger already owns it this tick
  }

  // -----------------------------
  // Utilities
  // -----------------------------

  /**
   * _roleOf
   *
   * @param {Creep} creep Any creep object.
   * @return {string} Role name or empty string when undefined.
   * Preconditions: creep.memory may or may not exist.
   */
  function _roleOf(creep) {
    // [1] Defensively read role metadata with null checks to avoid access errors.
    if (!creep || !creep.memory) return '';
    var role = creep.memory.role;
    if (role && role.length) return role;
    return creep.memory.role || '';
  }

  /**
   * _isCombat
   *
   * @param {Creep} creep Candidate unit.
   * @return {boolean} True if creep belongs to one of the combat roles.
   */
  function _isCombat(creep) {
    // [1] COMBAT_ROLES map doubles as a whitelist for movement right-of-way decisions.
    return !!COMBAT_ROLES[_roleOf(creep)];
  }

  /**
   * _isCivilian
   *
   * @param {Creep} creep Candidate unit.
   * @return {boolean} True when creep is not tagged as combat.
   */
  function _isCivilian(creep) {
    // [1] Negate combat membership to keep logic centralized in _isCombat.
    return !_isCombat(creep);
  }

  /**
   * _rolePri
   *
   * @param {Creep} creep Unit whose right-of-way priority is queried.
   * @return {number} Priority score used for swapping and tile reservations.
   * Preconditions: none.
   */
  function _rolePri(creep) {
    // [1] Fetch role-specific priority or fall back to a low default so civilians yield.
    var r = _roleOf(creep);
    var p = ROLE_PRI[r];
    return (p == null) ? 10 : p; // default low priority for unknown roles
  }

  /**
   * _movedThisTick
   *
   * @param {Creep} creep Unit to inspect.
   * @return {boolean} True when creep already executed a movement order this tick.
   * Preconditions: creep.memory exists when previously touched by this module.
   */
  function _movedThisTick(creep) {
    // [1] Compare stored timestamp with Game.time; undefined counts as not moved.
    return creep && creep.memory && creep.memory._movedAt === Game.time;
  }

  /**
   * getSquadId — exported helper.
   *
   * @param {Creep} creep Squad member creep.
   * @return {string} Squad identifier (defaults to "Alpha" for backwards compatibility).
   * Preconditions: creep.memory populated by spawn logic.
   * Postconditions: none.
   * Side-effects: none.
   */
  function getSquadId(creep) {
    // [1] Pull explicit squadId assigned by spawn/manager; fallback keeps old creeps functional.
    return (creep.memory && creep.memory.squadId) || 'Alpha';
  }

  /**
   * _ensureSquadBucket
   *
   * @param {string} id Squad identifier string.
   * @return {Object} Memory bucket for the squad (created if absent).
   * Preconditions: Memory global available.
   * Postconditions: Memory.squads[id] exists with default structure.
   * Side-effects: Mutates Memory.squads (persistent storage).
   */
  function _ensureSquadBucket(id) {
    // [1] Initialize root Memory.squads container when first squad is processed.
    if (!Memory.squads) Memory.squads = {};

    // [2] Lazily create squad bucket with default anchor/target metadata.
    if (!Memory.squads[id]) Memory.squads[id] = { targetId: null, targetAt: 0, anchor: null, anchorAt: 0 };
    return Memory.squads[id];
  }

  /**
   * _flagNamesFor
   *
   * @param {string} id Squad identifier.
   * @return {Array<string>} Candidate flag names (ordered by preference).
   * Preconditions: none.
   */
  function _flagNamesFor(id) {
    // [1] Provide multiple naming conventions so existing flags remain compatible.
    return [
      RALLY_FLAG_PREFIX + id,
      RALLY_FLAG_PREFIX + '_' + id,
      id
    ];
  }

  /**
   * _storeAnchor
   *
   * @param {Object} S Squad Memory bucket.
   * @param {RoomPosition} pos Anchor position.
   * @return {void}
   * Preconditions: Valid RoomPosition available (flag or creep).
   * Postconditions: S.anchor updated with coordinates and timestamp.
   * Side-effects: Persists rally breadcrumbs in Memory.
   */
  function _storeAnchor(S, pos) {
    // [1] Safety guard: ignore null positions (e.g., flag removed mid-tick).
    if (!S || !pos) return;

    // [2] Copy coordinates into plain object because Memory cannot persist RoomPosition.
    S.anchor = { x: pos.x, y: pos.y, roomName: pos.roomName };

    // [3] Maintain legacy property for older modules that expect anchor.room.
    S.anchor.room = pos.roomName;

    // [4] Timestamp for stale detection so squads can fall back when anchor disappears.
    S.anchorAt = Game.time;
  }

  /**
   * _anchorFromData
   *
   * @param {Object|null} data Serialized anchor stored in Memory.
   * @return {RoomPosition|null} Live RoomPosition reconstructed from stored coordinates.
   * Preconditions: data values numeric.
   * Postconditions: none.
   */
  function _anchorFromData(data) {
    // [1] Validate stored shape — missing coordinates mean anchor is unusable.
    if (!data || typeof data.x !== 'number' || typeof data.y !== 'number') return null;
    var roomName = data.roomName || data.room;
    if (!roomName) return null;

    // [2] Recreate RoomPosition for pathing utilities.
    return new RoomPosition(data.x, data.y, roomName);
  }

  /**
   * _bindingAnchorFor
   *
   * @param {string} id Squad identifier.
   * @return {RoomPosition|null} Anchor derived from SquadFlagManager Memory bindings.
   * Preconditions: Memory.squadFlags populated by SquadFlagManager.tick.
   * Postconditions: none.
   * Edge cases: returns null when flag data is missing or stale.
   */
  function _bindingAnchorFor(id) {
    // [1] Require bindings map; missing implies SquadFlagManager has not run recently.
    if (!Memory.squadFlags || !Memory.squadFlags.bindings) return null;
    var names = _flagNamesFor(id);
    var bindings = Memory.squadFlags.bindings;

    // [2] Iterate candidate flag names to locate the associated room.
    for (var i = 0; i < names.length; i++) {
      var roomName = bindings[names[i]];
      if (!roomName) continue;

      // [3] Attempt to load last known flag position if recorded.
      var info = (Memory.squadFlags.rooms && Memory.squadFlags.rooms[roomName]) || null;
      if (info && info.lastPos && typeof info.lastPos.x === 'number' && typeof info.lastPos.y === 'number') {
        return new RoomPosition(info.lastPos.x, info.lastPos.y, info.lastPos.roomName || roomName);
      }

      // [4] Without exact coordinates, default to room center so squad still moves toward area.
      if (roomName) return new RoomPosition(25, 25, roomName);
    }

    // [5] No binding located; squad likely free-roaming until flags refresh.
    return null;
  }

  /**
   * _rallyFlagFor
   *
   * @param {string} id Squad identifier.
   * @return {Flag|null} Live flag object if currently visible.
   * Preconditions: Game.flags accessible.
   */
  function _rallyFlagFor(id) {
    // [1] Evaluate naming variants so players can customize flag naming.
    var names = _flagNamesFor(id);
    for (var i = 0; i < names.length; i++) {
      if (Game.flags[names[i]]) return Game.flags[names[i]];
    }

    // [2] No visible flag — rely on stored anchor instead.
    return null;
  }

  /**
   * _isGood
   *
   * @param {RoomObject} obj Potential combat target.
   * @return {boolean} True when object is alive/exists and has a RoomPosition.
   * Preconditions: none.
   */
  function _isGood(obj) {
    // [1] Validate hits and coordinates to ensure we do not chase dead or stale objects.
    return obj && obj.hits != null && obj.hits > 0 && obj.pos && obj.pos.roomName;
  }

  /**
   * _scoreHostile
   *
   * @param {Creep} me Evaluating squad member (for distance metric).
   * @param {Creep} h Hostile creep to score.
   * @return {number} Weighted score (lower is better) for hostile prioritization.
   * Preconditions: Both creeps visible in same room.
   * Postconditions: none.
   */
  function _scoreHostile(me, h) {
    // [1] Measure distance so closer hostiles bubble up (reduces travel time).
    var dist   = me.pos.getRangeTo(h);

    // [2] Apply role-based weights to favor healers and ranged threats first.
    var healer = h.getActiveBodyparts(HEAL) > 0 ? HEALER_WEIGHT : 0;
    var ranged = h.getActiveBodyparts(RANGED_ATTACK) > 0 ? RANGED_WEIGHT : 0;
    var melee  = h.getActiveBodyparts(ATTACK) > 0 ? MELEE_WEIGHT : 0;
    var tough  = h.getActiveBodyparts(TOUGH) > 0 ? TOUGH_PENALTY : 0;

    // [3] Hurt targets receive bonus priority to finish low HP enemies.
    var hurt   = (1 - h.hits / Math.max(1, h.hitsMax)) * HURT_WEIGHT;

    // [4] Aggregate into single scalar; smaller scores represent higher urgency.
    return healer + ranged + melee + tough + hurt + dist;
  }

  /**
   * _chooseRoomTarget
   *
   * @param {Creep} me Squad member performing the evaluation.
   * @param {Object} S Squad Memory bucket.
   * @return {RoomObject|null} Best target (creep/structure) in current room or null.
   * Preconditions: Caller has room vision.
   * Postconditions: none here (caller stores target in Memory if needed).
   * Handles PvP rooms by returning null, causing squads to disengage.
   */
  function _chooseRoomTarget(me, S, outReason) {
    // [1] Guard against missing vision; without a room object there is nothing to target.
    var room = me.room; if (!room) {
      if (outReason) { outReason.reason = 'no-vision'; outReason.anyHostiles = false; }
      return null;
    }
    var id = getSquadId(me);
    var roomName = room.name;
    var myRoom = _roomIsMineOrReserved(room);
    var boundRoom = _targetRoomForSquad(id, S);
    var inBoundRoom = !!(boundRoom && boundRoom === roomName);

    var reason = null;

    var useToolbox = !!(BeeToolbox && BeeToolbox.canEngageTarget);
    if (useToolbox && BeeToolbox.isAllyRoom && BeeToolbox.isAllyRoom(room)) {
      if (outReason) {
        var seen = room.find(FIND_HOSTILE_CREEPS);
        outReason.reason = 'ally-room';
        outReason.anyHostiles = !!(seen && seen.length);
      }
      return null;
    }

    // [3] Determine whether we can engage any hostile or only Invader NPCs.
    var allowAnyHostile = myRoom || inBoundRoom;
    var myName = _myUsername();

    var hostiles = room.find(FIND_HOSTILE_CREEPS);
    var anyHostiles = hostiles && hostiles.length;
    var validHostiles = [];
    var skippedFriendly = false;
    var skippedNpc = false;
    var skippedPvp = false;

    if (hostiles && hostiles.length) {
      for (var hi = 0; hi < hostiles.length; hi++) {
        var h = hostiles[hi];
        if (!h || !h.hits || h.hits <= 0) continue;
        if (h.owner && h.owner.username && myName && h.owner.username === myName) {
          skippedFriendly = true; continue;
        }
        if (useToolbox) {
          if (BeeToolbox.isFriendlyObject && BeeToolbox.isFriendlyObject(h)) {
            skippedFriendly = true; continue;
          }
          if (!BeeToolbox.canEngageTarget(me, h)) {
            if (BeeToolbox.isNpcHostileCreep && BeeToolbox.isNpcHostileCreep(h)) {
              skippedNpc = true;
            } else {
              skippedPvp = true;
            }
            continue;
          }
        } else {
          if (!allowAnyHostile && !_isInvaderCreep(h)) {
            skippedPvp = true;
            continue;
          }
        }
        validHostiles.push(h);
      }
    }

    // [5] Score and pick best hostile creep when available.
    if (validHostiles.length) {
      var scored = _.map(validHostiles, function (h) { return { h: h, s: _scoreHostile(me, h) }; });
      var best = _.min(scored, 's');
      if (best && best.h) return best.h;
    }

    if (!validHostiles.length) {
      if (!reason) {
        if (skippedFriendly) reason = 'friendly-target';
        else if (skippedNpc) reason = 'npc-blocked';
        else if (skippedPvp) reason = 'pvp-disabled';
      }
    }

    // [6] Prioritize Invader towers next because they threaten the entire squad.
    var towers = room.find(FIND_HOSTILE_STRUCTURES, { filter: function (s) {
      return _isInvaderStruct(s) && s.structureType === STRUCTURE_TOWER;
    }});
    if (towers.length) return me.pos.findClosestByRange(towers);

    // [7] Target Invader spawns when towers are absent to shut down reinforcements.
    var spawns = room.find(FIND_HOSTILE_STRUCTURES, { filter: function (s) {
      return _isInvaderStruct(s) && s.structureType === STRUCTURE_SPAWN;
    }});
    if (spawns.length) return me.pos.findClosestByRange(spawns);

    // [8] Fallback: Invader cores in post-exit rooms.
    var cores = room.find(FIND_STRUCTURES, { filter: function (s) {
      return s.structureType === STRUCTURE_INVADER_CORE;
    }});
    if (cores.length) return me.pos.findClosestByRange(cores);

    // [9] Finally attack other structures when allowed (e.g., in our rooms or bound rooms).
    var others = room.find(FIND_HOSTILE_STRUCTURES, { filter: function (s) {
      if (!s || !s.hits || s.hits <= 0) return false;
      if (s.structureType === STRUCTURE_CONTROLLER) return false;
      if (allowAnyHostile) {
        if (s.owner && s.owner.username && myName && s.owner.username === myName) return false;
        if (BeeToolbox && BeeToolbox.isFriendlyObject && BeeToolbox.isFriendlyObject(s)) return false;
        return true;
      }
      return _isInvaderStruct(s) && s.structureType !== STRUCTURE_TOWER && s.structureType !== STRUCTURE_SPAWN;
    }});
    if (others.length) return me.pos.findClosestByRange(others);

    if (outReason) {
      outReason.reason = reason;
      outReason.anyHostiles = !!anyHostiles;
    }

    // [10] Nothing worth attacking; roles will default to regroup or hold actions.
    return null;
  }

  /**
   * sharedTarget — exported helper.
   *
   * @param {Creep} creep Squad member requesting a target.
   * @return {RoomObject|null} Shared hostile target or null when none.
   * Preconditions: creep.memory.squadId set; Memory.squads bucket accessible.
   * Postconditions: Memory.squads[id].targetId/targetAt updated; creep.memory stick fields refreshed.
   * Side-effects: Logs diagnostic message when hostiles exist but target is null.
   * Edge cases: handles disappearing targets, stale Memory anchors, and maximum range limits.
   */
  function sharedTarget(creep) {
    // [1] Load squad metadata and per-creep memory for stickiness tracking.
    var id = getSquadId(creep);
    var S  = _ensureSquadBucket(id);
    var mem = creep && creep.memory ? creep.memory : null;

    // [2] First honor per-creep sticky target to avoid thrashing when others temporarily lose sight.
    if (mem && mem.stickTargetId) {
      var memTarget = Game.getObjectById(mem.stickTargetId);
      if (memTarget && _isGood(memTarget)) {
        var stickAt = mem.stickTargetAt || 0;
        if ((Game.time - stickAt) <= TARGET_STICKY_TICKS) {
          mem.stickTargetAt = Game.time;
          return memTarget;
        }
      } else {
        delete mem.stickTargetId;
        delete mem.stickTargetAt;
      }
    }

    // [3] Use squad-level sticky target if still valid and within acceptable range.
    if (S.targetId && Game.time - (S.targetAt || 0) <= TARGET_STICKY_TICKS) {
      var keep = Game.getObjectById(S.targetId);
      if (_isGood(keep) && creep.pos.getRangeTo(keep) <= MAX_TARGET_RANGE) {
        if (mem) {
          mem.stickTargetId = keep.id;
          mem.stickTargetAt = Game.time;
        }
        return keep;
      }
    }

    // [4] Fall back to fresh room scan for a new target candidate.
    var reasonInfo = {};
    var nxt = _chooseRoomTarget(creep, S, reasonInfo);
    if (nxt) {
      S.targetId = nxt.id; S.targetAt = Game.time;
      if (mem) {
        mem.stickTargetId = nxt.id;
        mem.stickTargetAt = Game.time;
      }
      return nxt;
    }

    // [5] Clear target metadata when nothing is found so roles know to regroup.
    S.targetId = null; S.targetAt = Game.time;
    if (mem) {
      delete mem.stickTargetId;
      delete mem.stickTargetAt;
    }

    // [6] Diagnostic logging helps detect fog-of-war issues where hostiles are visible but filtered out.
    if (reasonInfo && reasonInfo.anyHostiles) {
      var roomName = (creep.room && creep.room.name) || (mem && mem.targetRoom) || 'unknown';
      var tag = reasonInfo.reason || 'unspecified';
      var key = roomName + ':' + tag;
      var lastLog = _nullTargetLog[key] || 0;
      if ((Game.time - lastLog) >= 50) {
        var msg;
        if (tag === 'ally-room') msg = 'holding fire in ally room';
        else if (tag === 'pvp-disabled') msg = 'PvP disabled for room';
        else if (tag === 'npc-blocked') msg = 'NPC blocked by room policy';
        else if (tag === 'friendly-target') msg = 'filtered friendly units';
        else msg = 'no valid targets';
        console.log('[Squad]', id, 'skipping hostiles in', roomName, '-', msg);
        _nullTargetLog[key] = Game.time;
      }
    }
    return null;
  }

  /**
   * getAnchor — exported helper.
   *
   * @param {Creep} creep Squad member.
   * @return {RoomPosition|null} Current anchor position for the squad.
   * Preconditions: SquadFlagManager ran recently or Memory holds fallback anchor.
   * Postconditions: Memory.squads anchor data refreshed when a flag/leader is located.
   * Edge cases: gracefully handles missing flags, dead anchors, or empty squads.
   */
  function getAnchor(creep) {
    // [1] Resolve squad bucket and inspect per-creep memory for explicit flag assignments.
    var id = getSquadId(creep);
    var S = _ensureSquadBucket(id);
    var mem = creep && creep.memory ? creep.memory : null;
    if (mem && mem.squadFlag) {
      var memFlag = Game.flags[mem.squadFlag];
      if (memFlag && memFlag.pos) {
        _storeAnchor(S, memFlag.pos);
        return memFlag.pos;
      }
    }

    // [2] Prefer live rally flag when visible; ensures squads follow flag movements instantly.
    var flag = _rallyFlagFor(id);

    if (flag) {
      _storeAnchor(S, flag.pos);
      return flag.pos;
    }

    // [3] Use cached anchor if it is still fresh (prevents jitter when flag temporarily disappears).
    var stored = _anchorFromData(S.anchor);
    if (stored) {
      if ((Game.time - (S.anchorAt || 0)) <= ANCHOR_STICKY_TICKS) {
        return stored;
      }
      stored = null;
    }

    // [4] Ask SquadFlagManager bindings for the last recorded flag location (cross-room persistence).
    var memAnchor = _bindingAnchorFor(id);
    if (memAnchor) {
      _storeAnchor(S, memAnchor);
      return memAnchor;
    }

    // [5] Final fallback: promote a melee (or any member) position as ad-hoc anchor for regrouping.
    var names = Object.keys(Game.creeps).sort();
    var leader = null;
    for (var i = 0; i < names.length; i++) {
      var c = Game.creeps[names[i]];
      if (c && c.memory && c.memory.squadId === id && (_roleOf(c) === 'CombatMelee')) { leader = c; break; }
    }
    if (!leader) {
      for (var j = 0; j < names.length; j++) {
        var c2 = Game.creeps[names[j]];
        if (c2 && c2.memory && c2.memory.squadId === id) { leader = c2; break; }
      }
    }
    if (leader && leader.pos) {
      _storeAnchor(S, leader.pos);
      return leader.pos;
    }

    // [6] No anchor available; caller should hold position until more data arrives.
    return null;
  }

  // -----------------------------
  // Polite traffic shim (priority aware)
  // -----------------------------

  /**
   * _politelyYieldFor
   *
   * @param {Creep} mover Active creep attempting to enter nextPos.
   * @param {RoomPosition} nextPos Target tile proposed by Traveler.
   * @return {void}
   * Preconditions: Traveler planned a move into nextPos this tick.
   * Postconditions: May cause ally to backstep or sidestep while updating _movedAt stamps.
   * Side-effects: Issues direct ally.move() orders after reserving target tiles.
   * Edge cases: ignores hostile blockers, fatigued allies, and low-priority conflicts.
   */
  function _politelyYieldFor(mover, nextPos) {
    // [1] Abort early when no tile is predicted (Traveler stuck or already adjacent).
    if (!nextPos) return;

    // [2] Inspect the tile for blocking creeps; Traveler already avoids terrain obstacles.
    var blockers = nextPos.lookFor(LOOK_CREEPS);
    if (!blockers || !blockers.length) return;

    // [3] Only consider the first creep because Screeps guarantees at most one per tile.
    var ally = blockers[0];
    if (!ally || !ally.my) return;

    // [4] Respect allies that have already spent their move this tick (prevents conflicts).
    if (_movedThisTick(ally)) return;

    // [5] Compare squad membership and role priorities to determine if swap is allowed.
    var sameSquad = (mover.memory && ally.memory &&
                     mover.memory.squadId && ally.memory.squadId &&
                     mover.memory.squadId === ally.memory.squadId);

    var moverPri = _rolePri(mover);
    var allyPri  = _rolePri(ally);

    // [6] Permit move when same squad and mover has >= priority, or combat unit needs to push civilian.
    var allow = (sameSquad && moverPri >= allyPri) || (_isCombat(mover) && _isCivilian(ally));
    if (!allow) return;

    // [7] Determine direction from mover to target tile to calculate reverse direction for swap.
    var dir = mover.pos.getDirectionTo(nextPos);
    var back = ((dir + 4 - 1) % 8) + 1;

    // [8] Reusable offsets for evaluating tiles relative to the ally.
    var off = [
      [0, 0],
      [0, -1],  [1, -1],  [1, 0],   [1, 1],
      [0, 1],   [-1, 1],  [-1, 0],  [-1, -1]
    ];

    /**
     * _isTileFree — inline helper scoped to minimize allocations.
     *
     * @param {RoomPosition} pos Candidate tile.
     * @return {boolean} True when tile is within room bounds and traversable.
     */
    function _isTileFree(pos) {
      // [1] Reject edge tiles (0 and 49) because Screeps forbids creeps from occupying room borders.
      if (!pos || pos.x <= 0 || pos.x >= 49 || pos.y <= 0 || pos.y >= 49) return false;

      // [2] Inspect tile contents to ensure no blocking terrain/creeps/structures exist.
      var look = pos.look();
      for (var i = 0; i < look.length; i++) {
        var o = look[i];
        if (o.type === LOOK_TERRAIN && o.terrain === 'wall') return false;
        if (o.type === LOOK_CREEPS) return false;
        if (o.type === LOOK_STRUCTURES) {
          var st = o.structure.structureType;
          if (st !== STRUCTURE_ROAD && st !== STRUCTURE_CONTAINER &&
             (st !== STRUCTURE_RAMPART || !o.structure.my)) return false;
        }
      }
      return true;
    }

    // [9] Try to make ally step backward into the tile opposite the mover.
    var bx = ally.pos.x + off[back][0], by = ally.pos.y + off[back][1];
    if (bx >= 0 && bx <= 49 && by >= 0 && by <= 49) {
      var bpos = new RoomPosition(bx, by, ally.pos.roomName);
      if (_isTileFree(bpos) && _reserveTile(ally, bpos, allyPri)) {
        ally.move(back);
        ally.memory._movedAt = Game.time;
        return;
      }
    }

    // [10] If backstep failed, attempt left/right sidestep using deterministic order.
    var left  = ((dir + 6 - 1) % 8) + 1; // -2
    var right = ((dir + 2 - 1) % 8) + 1; // +2
    var sides = [left, right];
    for (var s = 0; s < sides.length; s++) {
      var sd = sides[s];
      var sx = ally.pos.x + off[sd][0], sy = ally.pos.y + off[sd][1];
      if (sx < 0 || sx > 49 || sy < 0 || sy > 49) continue;
      var spos = new RoomPosition(sx, sy, ally.pos.roomName);
      if (_isTileFree(spos) && _reserveTile(ally, spos, allyPri)) {
        ally.move(sd);
        ally.memory._movedAt = Game.time;
        return;
      }
    }
  }

  /**
   * tryFriendlySwap — exported helper.
   *
   * @param {Creep} creep Active creep willing to move.
   * @param {RoomPosition|{pos:RoomPosition}} dest Tile currently occupied by an ally.
   * @return {boolean} True on successful coordinated swap.
   * Preconditions: creep adjacent to dest and both creeps have MOVE parts/fatigue 0.
   * Postconditions: creep._movedAt and ally._movedAt updated when swap succeeds.
   * Side-effects: Reserves both tiles in global reservation map to match new occupancy.
   * Edge cases: Cancels creep order when ally cannot move, preventing ghost intents.
   */
  function tryFriendlySwap(creep, dest) {
    // [1] Validate inputs and normalize destination into a RoomPosition.
    if (!creep || !dest) return false;

    var rawPos = dest.pos || dest;
    if (!rawPos || typeof rawPos.x !== 'number' || typeof rawPos.y !== 'number' || !rawPos.roomName) return false;
    var pos = (rawPos instanceof RoomPosition) ? rawPos : new RoomPosition(rawPos.x, rawPos.y, rawPos.roomName);

    // [2] Ensure creeps are adjacent, mobile, and share the same squad identity.
    if (!creep.pos.isNearTo(pos)) return false;
    if (creep.fatigue > 0) return false;
    if (creep.getActiveBodyparts(MOVE) <= 0) return false;

    var room = Game.rooms[pos.roomName];
    if (!room) return false;

    // [3] Identify the ally occupying destination tile and validate mobility.
    var look = room.lookForAt(LOOK_CREEPS, pos.x, pos.y);
    if (!look || !look.length) return false;

    var ally = look[0];
    if (!ally || !ally.my || ally.id === creep.id) return false;
    if (_movedThisTick(ally)) return false;
    if (ally.fatigue > 0) return false;

    var mySquad = (creep.memory && creep.memory.squadId) || 'Alpha';
    var allySquad = (ally.memory && ally.memory.squadId) || 'Alpha';
    if (mySquad !== allySquad) return false;

    if (ally.getActiveBodyparts(MOVE) <= 0) return false;

    // [4] Execute mirrored moves toward each other's tile.
    var dirToTarget = creep.pos.getDirectionTo(pos);
    var dirToMe = ally.pos.getDirectionTo(creep.pos);

    var creepMove = creep.move(dirToTarget);
    if (creepMove !== OK) return false;

    var allyMove = ally.move(dirToMe);
    if (allyMove !== OK) {
      if (typeof creep.cancelOrder === 'function') creep.cancelOrder('move');
      return false;
    }

    // [5] Stamp movement metadata and reserve swapped tiles for both participants.
    var creepMem = creep.memory = creep.memory || {};
    creepMem._movedAt = Game.time;

    ally.memory = ally.memory || {};
    ally.memory._movedAt = Game.time;

    _reserveTile(creep, pos, _rolePri(creep));
    _reserveTile(ally, creep.pos, _rolePri(ally));

    return true;
  }

  // -----------------------------
  // Traveler-backed stepToward with reservations
  // -----------------------------

  /**
   * stepToward — exported helper.
   *
   * @param {Creep} creep Moving creep.
   * @param {RoomPosition|{pos:RoomPosition}} pos Destination (flag/creep/anchor).
   * @param {number} range Desired stopping distance (0 = same tile).
   * @return {number} Screeps OK/ERR_* code from Traveler or moveTo fallback.
   * Preconditions: Traveler.js is loaded (gracefully falls back to moveTo otherwise).
   * Postconditions: Updates reservation map, creep memory movement metadata, and Traveler counters.
   * Edge cases: Handles stuck/fatigue detection, missing destinations, and blocked tiles.
   */
  function stepToward(creep, pos, range) {
    // [1] Validate parameters before doing any heavy computation.
    if (!creep || !pos) return ERR_NO_PATH;

    // [2] Determine how close we need to get to the goal tile.
    var tgtPos = (pos.pos || pos);
    var needRange = (typeof range === 'number' ? range : 0);
    if (creep.pos.getRangeTo(tgtPos) <= needRange) return OK;

    // [3] Ensure creep memory exists so movement bookkeeping works even on first tick.
    var mem = creep.memory = creep.memory || {};

    // [4] Fallback to native moveTo when Traveler is unavailable (e.g., fail-safe load order).
    if (typeof creep.travelTo !== 'function') {
      var fallbackCode = creep.moveTo(tgtPos, { reusePath: 3, maxOps: 1000 });
      if (fallbackCode === OK) {
        mem._movedAt = Game.time;
      }
      mem._travBusy = 0; mem._travNoPath = 0;
      return fallbackCode;
    }

    // [5] Configure Traveler with squad defaults and BeeToolbox terrain callback.
    var retData = {};
    var opts = {
      range: needRange,
      ignoreCreeps: TRAVELER_DEFAULTS.ignoreCreeps,
      stuckValue: TRAVELER_DEFAULTS.stuckValue,
      repath: TRAVELER_DEFAULTS.repath,
      maxOps: TRAVELER_DEFAULTS.maxOps,
      allowHostile: TRAVELER_DEFAULTS.allowHostile,
      roomCallback: (BeeToolbox && BeeToolbox.roomCallback) ? BeeToolbox.roomCallback : undefined,
      returnData: retData
    };

    // [6] Execute Traveler pathing and capture the resulting code/next position.
    var code = creep.travelTo(tgtPos, opts);
    var myPri = _rolePri(creep);

    // [7] Attempt to reserve planned nextPos; if busy, trigger fallback logic.
    if (retData && retData.nextPos) {
      // [7.1] Try to make blockers yield before giving up on reservation.
      _politelyYieldFor(creep, retData.nextPos);

      // [7.2] Re-attempt reservation after potential swap.
      if (!_reserveTile(creep, retData.nextPos, myPri)) {
        mem._travNoPath = 0;
        mem._travBusy = (mem._travBusy|0) + 1;
        if (mem._travBusy >= 2) {
          var busyFallback = creep.moveTo(tgtPos, { reusePath: 3, maxOps: 1000 });
          if (busyFallback === OK) {
            mem._movedAt = Game.time; // Acceptance: stamp only on successful moveTo fallback
          }
          mem._travBusy = 0; mem._travNoPath = 0;
          return busyFallback;
        }
        return ERR_BUSY;
      }
    }

    // [8] Post-process Traveler result to update movement counters or engage fallback.
    if (code === OK) {
      mem._movedAt = Game.time; // Acceptance: _movedAt only stamped on successful Traveler move
      mem._travBusy = 0;
      mem._travNoPath = 0;
    } else if (code === ERR_BUSY) {
      mem._travBusy = (mem._travBusy|0) + 1;
      mem._travNoPath = 0;
      if (mem._travBusy >= 2) {
        var errBusyFallback = creep.moveTo(tgtPos, { reusePath: 3, maxOps: 1000 });
        if (errBusyFallback === OK) {
          mem._movedAt = Game.time;
        }
        mem._travBusy = 0; mem._travNoPath = 0;
        return errBusyFallback;
      }
    } else if (code === ERR_NO_PATH) {
      mem._travNoPath = (mem._travNoPath|0) + 1;
      mem._travBusy = 0;
      if (mem._travNoPath >= 2) {
        var errNoPathFallback = creep.moveTo(tgtPos, { reusePath: 3, maxOps: 1000 });
        if (errNoPathFallback === OK) {
          mem._movedAt = Game.time;
        }
        mem._travBusy = 0; mem._travNoPath = 0;
        return errNoPathFallback;
      }
    } else {
      mem._travBusy = 0;
      mem._travNoPath = 0;
    }

    // [9] Lightweight unstick detection using last known coordinates to issue wiggle.
    var stuck = (creep.fatigue === 0 && creep.memory._lx === creep.pos.x && creep.memory._ly === creep.pos.y);
    if (stuck && creep.pos.getRangeTo(tgtPos) > needRange) {
      _unstickWiggle(creep, tgtPos);
    }
    mem._lx = creep.pos.x; mem._ly = creep.pos.y;

    return code;
  }

  /**
   * _unstickWiggle
   *
   * @param {Creep} creep Creep considered stuck.
   * @param {RoomPosition} goalPos Intended destination for direction scoring.
   * @return {void}
   * Preconditions: creep has fatigue 0 and has not changed position despite movement orders.
   * Postconditions: Issues a direct move command to nearest passable tile when available.
   */
  function _unstickWiggle(creep, goalPos) {
    // [1] Explore all eight directions to locate the closest passable tile toward the goal.
    var bestDir = 0, bestScore = 1e9, d, x, y, p, score;
    for (d = 1; d <= 8; d++) {
      x = creep.pos.x + (d === RIGHT || d === TOP_RIGHT || d === BOTTOM_RIGHT ? 1 :
                         d === LEFT  || d === TOP_LEFT  || d === BOTTOM_LEFT  ? -1 : 0);
      y = creep.pos.y + (d === BOTTOM || d === BOTTOM_LEFT || d === BOTTOM_RIGHT ? 1 :
                         d === TOP    || d === TOP_LEFT   || d === TOP_RIGHT    ? -1 : 0);
      if (x < 0 || x > 49 || y < 0 || y > 49) continue;
      p = new RoomPosition(x, y, creep.pos.roomName);

      // [2] Inspect terrain, creeps, and structures to ensure tile is traversable.
      var pass = true, look = p.look(), i;
      for (i = 0; i < look.length; i++) {
        var o = look[i];
        if (o.type === LOOK_TERRAIN && o.terrain === 'wall') { pass = false; break; }
        if (o.type === LOOK_CREEPS) { pass = false; break; }
        if (o.type === LOOK_STRUCTURES) {
          var st = o.structure.structureType;
          if (st !== STRUCTURE_ROAD && st !== STRUCTURE_CONTAINER &&
             (st !== STRUCTURE_RAMPART || !o.structure.my)) { pass = false; break; }
        }
      }
      if (!pass) continue;

      // [3] Score tile by distance to goal; choose minimal distance to preserve progress.
      score = p.getRangeTo(goalPos);
      if (score < bestScore) { bestScore = score; bestDir = d; }
    }

    // [4] Execute quick move when a candidate direction was found.
    if (bestDir) creep.move(bestDir);
  }

  // -----------------------------
  // Public API
  // -----------------------------
  API.getSquadId   = getSquadId;
  API.sharedTarget = sharedTarget;
  API.getAnchor    = getAnchor;
  API.stepToward   = stepToward;
  API.tryFriendlySwap = tryFriendlySwap;

  return API;
})();

module.exports = TaskSquad;

/**
 * Collaboration Map:
 * - Expects SquadFlagManager.js to update Memory.squadFlags.bindings/rooms before roles call
 *   getAnchor(), ensuring anchors are valid or gracefully degrading to leader positions.
 * - Provides sharedTarget() and stepToward() to role.CombatArcher.js, role.CombatMelee.js, and
 *   role.CombatMedic.js prior to their per-tick logic; assumes these roles maintain
 *   creep.memory.squadId and clear stickTargetId when they change squads or die.
 * - Supplies tryFriendlySwap() used by movement manager components; assumes Movement.Manager.js
 *   honors _movedAt timestamps to avoid double moves.
 * Edge cases noted:
 * - No room vision: sharedTarget() yields null so roles switch to rally/anchor behavior.
 * - Target disappearance mid-tick: stickTarget fields cleared, causing re-selection next tick.
 * - Path blockage: stepToward() engages fallbacks and wiggle to recover from terrain/creep jams.
 * - Flag relocation between ticks: getAnchor() reads Memory.squadFlags to detect the new position.
 * - Squad member death: getAnchor() re-anchors on surviving melee/any member if flags missing.
 */
