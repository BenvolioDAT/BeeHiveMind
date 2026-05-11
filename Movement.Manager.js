// -----------------------------------------------------------------------------
// Movement.Manager.js – centralised movement intent queue for creeps
// Responsibilities:
// * Collects per-tick move requests from tasks/actions (BeeActions.safe*,
//   role.Queen idle, combat scripts) and resolves them in deterministic order.
// * Delegates actual pathfinding to Traveler (creep.travelTo) when available,
//   falling back to Screeps moveTo with same options if Traveler absent.
// * Detects stale intents (creep moved rooms, target invalid, wrong shard) and
//   drops them silently to prevent wasting CPU.
// Data touched:
// * Local transient state: MovementManager._intents/_indexByCreep (reset each tick).
// * Reads Game.creeps/Game.rooms to validate intents.
// Called from: BeeHiveMind.run (startTick() before creep logic,
//   resolveAndMove() after all roles execute). BeeActions/Task modules call
//   MovementManager.request() to queue movement.
// -----------------------------------------------------------------------------
'use strict';
var MovementOwnership = require('Movement.Ownership');
var MovementVerify = require('Movement.Verify');

/**
 * What changed & why:
 * - Documented deterministic intent ordering (priority → first-request wins → creepId) and ensured MOVE flushes every tick.
 * - Guarantees one queued intent per creep while routing every move through Traveler for consistency with Harabi-style traffic.
 * - Drops invalid/outdated intents (room swap, missing target, wrong shard) so MOVE remains idempotent and side-effect free.
 */

/**
 * Invariants:
 * - startTick() MUST be called before queuing intents; resolveAndMove() clears all intents at the end of MOVE.
 * - Intent order = priority desc, then first queued (order asc), then creepId/name asc for deterministic tie-breaking.
 * - Only creep.travelTo is used; intents targeting other shards or stale rooms are skipped without side effects.
 */


function getCreepName(creep) {
  return (creep && creep.name) ? creep.name : null;
}

function getCreepRole(creep) {
  return (creep && creep.memory && creep.memory.role) ? creep.memory.role : null;
}

function getPosFields(pos, prefix) {
  var out = {};
  if (!pos) return out;
  var p = prefix || '';
  if (pos.roomName != null) out[p + 'rm'] = pos.roomName;
  if (pos.x != null) out[p + 'x'] = pos.x;
  if (pos.y != null) out[p + 'y'] = pos.y;
  return out;
}

function buildVerifyBase(creep, src) {
  var base = {
    c: getCreepName(creep),
    r: getCreepRole(creep),
    src: src || 'MovementManager'
  };
  if (creep && creep.pos) {
    var p = getPosFields(creep.pos);
    if (p.rm != null) base.rm = p.rm;
    if (p.x != null) base.x = p.x;
    if (p.y != null) base.y = p.y;
  }
  return base;
}

function recordMoveVerify(type, data) {
  try {
    if (!MovementVerify || typeof MovementVerify.event !== 'function') return;
    if (MovementVerify.isEnabled && !MovementVerify.isEnabled()) return;
    MovementVerify.event(type, data || {});
  } catch (e) {
    // verifier is strictly side-channel and must never affect movement behavior
  }
}

function compareIntents(a, b) {
  if (b.priority !== a.priority) return b.priority - a.priority;
  if (a.order !== b.order) return a.order - b.order;
  var aId = a.creepId || a.creepName;
  var bId = b.creepId || b.creepName;
  if (aId < bId) return -1;
  if (aId > bId) return 1;
  if (a.creepName < b.creepName) return -1;
  if (a.creepName > b.creepName) return 1;
  return 0;
}

var MovementManager = {
  PRIORITIES: {
    emergency: 100,
    combat: 90,
    attack: 90,
    rangedAttack: 90,
    heal: 90,
    rangedHeal: 90,
    pickup: 80,
    withdraw: 70,
    deliver: 60,
    harvest: 55,
    build: 50,
    repair: 45,
    upgrade: 40,
    reserve: 35,
    claim: 35,
    scout: 30,
    idle: 5,
    default: 0
  },

  _intents: [],
  _indexByCreep: {},
  _order: 0,

  /**
   * Reset tick-local state; must be invoked once from the orchestrator before DECIDE/ACT.
   */
  // Function header: startTick()
  // Inputs: none
  // Output: none; resets internal arrays for the new tick.
  // Side-effects: clears previous intents so new requests can be added safely.
  startTick: function () {
    this._intents = [];
    this._indexByCreep = {};
    this._order = 0;
  },

  /**
   * Record a creep movement intent for later resolution.
   * Intent schema: {
   *   creepName: string,
   *   x/y/roomName: coordinates,
   *   range: number (default 1),
   *   priority: higher resolves first (see PRIORITIES),
   *   flee: bool,
   *   reusePath/ignoreCreeps/maxOps/plainCost/swampCost: Traveler options
   * }
   */
  // Function header: request(creep, dest, priority, opts)
  // Inputs: creep object, destination (structure or RoomPosition), optional
  //         priority override, options (range, reusePath, flee, ignoreCreeps,
  //         etc.).
  // Output: OK when accepted, ERR_INVALID_ARGS if inputs malformed, or existing
  //         priority when attempting to downgrade an existing intent.
  // Side-effects: stores/updates MovementManager._intents entry for the creep.
  // Preconditions: BeeHiveMind.startTick must have been called this tick.
  // Notes: Each creep keeps only one active intent; newer requests overwrite if
  //        they are same or higher priority.
  request: function (creep, dest, priority, opts) {
    if (!creep || !creep.name) {
      recordMoveVerify('mv.req.invalid', { src: 'MovementManager.request', reason: 'invalidCreep', priority: priority });
      return ERR_INVALID_ARGS;
    }
    if (!dest) {
      var missingDestBase = buildVerifyBase(creep, 'MovementManager.request');
      missingDestBase.priority = priority;
      missingDestBase.reason = 'missingDest';
      recordMoveVerify('mv.req.invalid', missingDestBase);
      return ERR_INVALID_ARGS;
    }

    // Normalise destination so we always have coordinates, shard, and target ID
    // recorded on the intent. This keeps validation inside resolveAndMove
    // straightforward and visible.
    var pos = dest.pos || dest;
    if (!pos || pos.x == null || pos.y == null || !pos.roomName) {
      var badPosBase = buildVerifyBase(creep, 'MovementManager.request');
      badPosBase.priority = priority;
      badPosBase.reason = 'invalidDestination';
      recordMoveVerify('mv.req.invalid', badPosBase);
      return ERR_INVALID_ARGS;
    }
    var shard = (dest.shard && typeof dest.shard === 'string') ? dest.shard : (pos.shard || null);
    var targetId = dest.id || null;

    var pr = (typeof priority === 'number') ? priority : this._priorityFromOpts(opts);
    var key = creep.name;
    var idx = this._indexByCreep[key];

    if (idx == null || this._intents[idx] == null) {
      // First intent for this creep: copy caller options into a record so
      // nothing mutates mid-tick.
      var newIntent = {
        creepName: creep.name,
        creepId: creep.id || creep.name,
        roomName: pos.roomName,
        x: pos.x,
        y: pos.y,
        range: (opts && opts.range != null) ? opts.range : 1,
        priority: pr,
        flee: opts && !!opts.flee,
        reusePath: opts && opts.reusePath,
        ignoreCreeps: opts && opts.ignoreCreeps,
        maxOps: opts && opts.maxOps,
        plainCost: opts && opts.plainCost,
        swampCost: opts && opts.swampCost,
        intentType: opts && opts.intentType ? opts.intentType : null,
        order: this._order++,
        startRoom: creep.room ? creep.room.name : null,
        shard: shard,
        targetId: targetId,
        createdTick: Game.time
      };
      this._indexByCreep[key] = this._intents.length;
      this._intents.push(newIntent);
      var reqBase = buildVerifyBase(creep, 'MovementManager.request');
      var reqDest = getPosFields(pos, 'd');
      reqBase.priority = pr;
      reqBase.meta = 'acceptedNew';
      if (reqDest.drm != null) reqBase.drm = reqDest.drm;
      if (reqDest.dx != null) reqBase.dx = reqDest.dx;
      if (reqDest.dy != null) reqBase.dy = reqDest.dy;
      recordMoveVerify('mv.req', reqBase);
      return OK;
    }

    var intent = this._intents[idx];
    if (!intent) {
      var missingIntentBase = buildVerifyBase(creep, 'MovementManager.request');
      missingIntentBase.priority = pr;
      missingIntentBase.reason = 'missingIntentRecord';
      recordMoveVerify('mv.req.invalid', missingIntentBase);
      return ERR_INVALID_ARGS;
    }
    if (pr < intent.priority) {
      var downgradeBase = buildVerifyBase(creep, 'MovementManager.request');
      var downgradeDest = getPosFields(pos, 'd');
      downgradeBase.priority = pr;
      downgradeBase.existingPriority = intent.priority;
      downgradeBase.meta = 'keptExistingHigher';
      if (downgradeDest.drm != null) downgradeBase.drm = downgradeDest.drm;
      if (downgradeDest.dx != null) downgradeBase.dx = downgradeDest.dx;
      if (downgradeDest.dy != null) downgradeBase.dy = downgradeDest.dy;
      recordMoveVerify('mv.req.downgrade', downgradeBase);
      return intent.priority;
    }

    // Higher or equal priority replaces destination/opts; retains earliest
    // startRoom to avoid executing after portal jumps.
    intent.roomName = pos.roomName;
    intent.x = pos.x;
    intent.y = pos.y;
    intent.range = (opts && opts.range != null) ? opts.range : 1;
    intent.priority = pr;
    intent.flee = opts && !!opts.flee;
    intent.reusePath = opts && opts.reusePath;
    intent.ignoreCreeps = opts && opts.ignoreCreeps;
    intent.maxOps = opts && opts.maxOps;
    intent.plainCost = opts && opts.plainCost;
    intent.swampCost = opts && opts.swampCost;
    intent.intentType = opts && opts.intentType ? opts.intentType : intent.intentType;
    intent.startRoom = intent.startRoom || (creep.room ? creep.room.name : null);
    intent.shard = shard;
    intent.targetId = targetId;
    intent.updatedTick = Game.time;
    var replaceBase = buildVerifyBase(creep, 'MovementManager.request');
    var replaceDest = getPosFields(pos, 'd');
    replaceBase.priority = pr;
    replaceBase.existingPriority = intent.priority;
    replaceBase.meta = 'replacedExisting';
    if (replaceDest.drm != null) replaceBase.drm = replaceDest.drm;
    if (replaceDest.dx != null) replaceBase.dx = replaceDest.dx;
    if (replaceDest.dy != null) replaceBase.dy = replaceDest.dy;
    recordMoveVerify('mv.req', replaceBase);
    return OK;
  },

  // Function header: _priorityFromOpts(opts)
  // Inputs: options object (may include intentType).
  // Output: numeric priority; defaults to PRIORITIES.default.
  _priorityFromOpts: function (opts) {
    if (!opts || !opts.intentType) return this.PRIORITIES.default;
    var key = opts.intentType;
    if (this.PRIORITIES.hasOwnProperty(key)) return this.PRIORITIES[key];
    return this.PRIORITIES.default;
  },

  _isExitPosition: function (pos) {
    if (!pos) return false;
    return pos.x === 0 || pos.x === 49 || pos.y === 0 || pos.y === 49;
  },

  _tryMoveOffExit: function (creep, reason, destination, travelOpts) {
    if (!creep || creep.fatigue > 0 || !this._isExitPosition(creep.pos)) return null;
    if (typeof creep.travelTo !== 'function') return null;
    var resultData = {};
    var opts = Object.assign({}, travelOpts || {}, { range: 0, returnData: resultData });
    var result = creep.travelTo(destination, opts);
    var borderBase = buildVerifyBase(creep, 'MovementManager._tryMoveOffExit');
    var borderDest = getPosFields(destination, 'd');
    borderBase.meta = reason || 'offExit';
    borderBase.rc = result;
    if (borderDest.drm != null) borderBase.drm = borderDest.drm;
    if (borderDest.dx != null) borderBase.dx = borderDest.dx;
    if (borderDest.dy != null) borderBase.dy = borderDest.dy;
    recordMoveVerify('mv.border.recover', borderBase);
    return { result: result, data: resultData, reason: reason };
  },

  /**
   * Resolve all movement intents in deterministic priority order.
   */
  // Function header: resolveAndMove()
  // Inputs: none
  // Output: none; executes creep.travelTo for each pending intent in priority
  //         order.
  // Side-effects: issues move intents to creeps, clears internal intent list.
  // Failure modes: silently skips creeps with fatigue or invalid targets.
  resolveAndMove: function () {
    var hadIntentByCreep = {};
    var intents = this._intents || [];
    for (var h = 0; h < intents.length; h++) {
      var hi = intents[h];
      if (hi && hi.creepName) hadIntentByCreep[hi.creepName] = true;
    }
    if (intents.length) this._intents.sort(compareIntents);
    for (var i = 0; i < this._intents.length; i++) {
      var intent = this._intents[i];
      if (!intent) continue;
      var creep = Game.creeps[intent.creepName];
      // Skip intents that can never execute this tick so we avoid wasted CPU.
      if (!creep) {
        recordMoveVerify('mv.resolve.skip.missing', { src: 'MovementManager.resolveAndMove', reason: 'missingCreep', c: intent.creepName, priority: intent.priority });
        continue;
      }
      if (MovementOwnership.has(creep)) {
        var ownedBase = buildVerifyBase(creep, 'MovementManager.resolveAndMove');
        ownedBase.priority = intent.priority;
        ownedBase.reason = 'alreadyOwned';
        recordMoveVerify('mv.resolve.skip.owned', ownedBase);
        MovementOwnership.logSkip(creep, 'MovementManager', 'alreadyMoved');
        continue;
      }
      if (creep.fatigue > 0) {
        var skipBase = buildVerifyBase(creep, 'MovementManager.resolveAndMove');
        skipBase.priority = intent.priority;
        skipBase.reason = 'fatigued';
        recordMoveVerify('mv.resolve.skip.missing', skipBase);
        continue;
      }
      if (intent.startRoom && creep.room && creep.room.name !== intent.startRoom) {
        var skipBase = buildVerifyBase(creep, 'MovementManager.resolveAndMove');
        skipBase.priority = intent.priority;
        skipBase.reason = 'startRoomMismatch';
        recordMoveVerify('mv.resolve.skip.missing', skipBase);
        continue;
      }
      if (!intent.roomName || intent.x == null || intent.y == null) {
        var skipBase = buildVerifyBase(creep, 'MovementManager.resolveAndMove');
        skipBase.priority = intent.priority;
        skipBase.reason = 'invalidIntentPos';
        recordMoveVerify('mv.resolve.skip.missing', skipBase);
        continue;
      }
      if (intent.shard && Game.shard && Game.shard.name !== intent.shard) {
        var skipBase = buildVerifyBase(creep, 'MovementManager.resolveAndMove');
        skipBase.priority = intent.priority;
        skipBase.reason = 'shardMismatch';
        recordMoveVerify('mv.resolve.skip.missing', skipBase);
        continue;
      }
      if (intent.targetId && Game.rooms[intent.roomName] && !Game.getObjectById(intent.targetId)) {
        var skipBase = buildVerifyBase(creep, 'MovementManager.resolveAndMove');
        skipBase.priority = intent.priority;
        skipBase.reason = 'missingTarget';
        recordMoveVerify('mv.resolve.skip.missing', skipBase);
        continue;
      }
      var pos = new RoomPosition(intent.x, intent.y, intent.roomName);
      var inRange = creep.pos.getRangeTo(pos) <= intent.range;
      var onExit = this._isExitPosition(creep.pos);
      if (inRange && !onExit) {
        var rangeSkipBase = buildVerifyBase(creep, 'MovementManager.resolveAndMove');
        rangeSkipBase.priority = intent.priority;
        rangeSkipBase.reason = 'alreadyInRange';
        recordMoveVerify('mv.resolve.skip.missing', rangeSkipBase);
        continue;
      } // Already within desired range and not on a transfer border.
      var travelOpts = {
        range: intent.range,
        reusePath: (intent.reusePath != null) ? intent.reusePath : 20,
        ignoreCreeps: (intent.ignoreCreeps != null) ? intent.ignoreCreeps : false,
        maxOps: (intent.maxOps != null) ? intent.maxOps : 4000,
        plainCost: intent.plainCost,
        swampCost: intent.swampCost,
        flee: intent.flee || false,
        _hadIntentThisTick: true
      };
      if (inRange && onExit) {
        var rangeExitBase = buildVerifyBase(creep, 'MovementManager.resolveAndMove');
        var rangeExitDest = getPosFields(pos, 'd');
        rangeExitBase.priority = intent.priority;
        rangeExitBase.reason = 'inRangeOnExit';
        if (rangeExitDest.drm != null) rangeExitBase.drm = rangeExitDest.drm;
        if (rangeExitDest.dx != null) rangeExitBase.dx = rangeExitDest.dx;
        if (rangeExitDest.dy != null) rangeExitBase.dy = rangeExitDest.dy;
        recordMoveVerify('mv.border.recover', rangeExitBase);
        this._tryMoveOffExit(creep, 'rangeSkipOnExit', pos, travelOpts);
        continue;
      }
      if (typeof creep.travelTo === 'function') {
        // Traveler (Traveler.js) handles caching/stuck detection internally and
        // respects reusePath/maxOps options provided.
        var execBase = buildVerifyBase(creep, 'MovementManager.resolveAndMove');
        var execDest = getPosFields(pos, 'd');
        execBase.priority = intent.priority;
        execBase.reason = 'execTravelTo';
        if (execDest.drm != null) execBase.drm = execDest.drm;
        if (execDest.dx != null) execBase.dx = execDest.dx;
        if (execDest.dy != null) execBase.dy = execDest.dy;
        recordMoveVerify('mv.resolve.exec', execBase);
        var rc = creep.travelTo(pos, travelOpts);
        execBase.rc = rc;
        recordMoveVerify('mv.resolve.result', execBase);
      } else {
        // When Traveler is not mixed in, we skip issuing a move to avoid
        // inconsistent behaviour; callers should provide travelTo globally.
        var noTravelBase = buildVerifyBase(creep, 'MovementManager.resolveAndMove');
        noTravelBase.priority = intent.priority;
        noTravelBase.reason = 'travelToMissing';
        recordMoveVerify('mv.resolve.skip.missing', noTravelBase);
      }
    }
    // Post-resolve, per-creep safety fallback: even when queue had other intents,
    // a creep with no intent can still be stranded on an exit tile and bounce.
    for (var name in Game.creeps) {
      var idleCreep = Game.creeps[name];
      if (!idleCreep || idleCreep.spawning || idleCreep.fatigue > 0) continue;
      if (hadIntentByCreep[name]) continue;
      if (MovementOwnership.has(idleCreep)) {
        MovementOwnership.logSkip(idleCreep, 'MovementManager', 'alreadyMoved');
        continue;
      }
      if (!this._isExitPosition(idleCreep.pos)) continue;
      var fallbackDest = new RoomPosition(
        Math.max(1, Math.min(48, idleCreep.pos.x)),
        Math.max(1, Math.min(48, idleCreep.pos.y)),
        idleCreep.pos.roomName
      );
      this._tryMoveOffExit(idleCreep, 'postResolveIdleOnExitFallback', fallbackDest, {
        reusePath: 0,
        ignoreCreeps: false,
        maxOps: 800,
        _hadIntentThisTick: false
      });
    }
    this._intents = [];
    this._indexByCreep = {};
  }
};

module.exports = MovementManager;
