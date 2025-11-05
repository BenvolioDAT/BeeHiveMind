'use strict';

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

var MovementManager = {
  PRIORITIES: {
    emergency: 100,
    combat: 90,
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
  request: function (creep, dest, priority, opts) {
    if (!creep || !creep.name || !dest) return ERR_INVALID_ARGS;
    var pos = dest.pos || dest;
    if (!pos || pos.x == null || pos.y == null || !pos.roomName) return ERR_INVALID_ARGS;
    var pr = (typeof priority === 'number') ? priority : this._priorityFromOpts(opts);
    var key = creep.name;
    var idx = this._indexByCreep[key];
    var shard = (dest.shard && typeof dest.shard === 'string') ? dest.shard : (pos.shard || null);
    var targetId = dest.id || null;
    var intent;
    if (idx == null || this._intents[idx] == null) {
      intent = {
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
      this._intents.push(intent);
      return OK;
    }
    intent = this._intents[idx];
    if (!intent) return ERR_INVALID_ARGS;
    if (pr < intent.priority) return intent.priority;
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
    return OK;
  },

  _priorityFromOpts: function (opts) {
    if (!opts || !opts.intentType) return this.PRIORITIES.default;
    var key = opts.intentType;
    if (this.PRIORITIES.hasOwnProperty(key)) return this.PRIORITIES[key];
    return this.PRIORITIES.default;
  },

  /**
   * Resolve all movement intents in deterministic priority order.
   */
  resolveAndMove: function () {
    if (!this._intents || !this._intents.length) return;
    this._intents.sort(function (a, b) {
      if (b.priority !== a.priority) return b.priority - a.priority;
      if (a.order !== b.order) return a.order - b.order;
      var aId = a.creepId || a.creepName;
      var bId = b.creepId || b.creepName;
      if (aId < bId) return -1;
      if (aId > bId) return 1;
      if (a.creepName < b.creepName) return -1;
      if (a.creepName > b.creepName) return 1;
      return 0;
    });
    for (var i = 0; i < this._intents.length; i++) {
      var intent = this._intents[i];
      if (!intent) continue;
      var creep = Game.creeps[intent.creepName];
      if (!creep) continue;
      if (creep.fatigue > 0) continue;
      if (intent.startRoom && creep.room && creep.room.name !== intent.startRoom) continue;
      if (!intent.roomName || intent.x == null || intent.y == null) continue;
      if (intent.shard && Game.shard && Game.shard.name !== intent.shard) continue;
      if (intent.targetId && Game.rooms[intent.roomName] && !Game.getObjectById(intent.targetId)) continue;
      var pos = new RoomPosition(intent.x, intent.y, intent.roomName);
      if (creep.pos.getRangeTo(pos) <= intent.range) continue;
      var travelOpts = {
        range: intent.range,
        reusePath: (intent.reusePath != null) ? intent.reusePath : 20,
        ignoreCreeps: (intent.ignoreCreeps != null) ? intent.ignoreCreeps : false,
        maxOps: (intent.maxOps != null) ? intent.maxOps : 4000,
        plainCost: intent.plainCost,
        swampCost: intent.swampCost,
        flee: intent.flee || false
      };
      if (typeof creep.travelTo === 'function') {
        creep.travelTo(pos, travelOpts);
      }
    }
    this._intents = [];
    this._indexByCreep = {};
  }
};

module.exports = MovementManager;
