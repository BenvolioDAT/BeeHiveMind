'use strict';

/**
 * What changed & why:
 * - Documented the intent schema ({target, range, priority, flee, reusePath}) and standardized priority buckets per role type.
 * - Added deterministic FIFO ordering within a priority tier and preserved Traveler-based resolution in MOVE phase.
 * - Provides a single entry-point for all movement, simplifying future upgrades to a matching-based traffic solver.
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
  _seen: {},
  _order: 0,

  /**
   * Reset tick-local state; must be invoked once from the orchestrator before DECIDE/ACT.
   */
  startTick: function () {
    this._intents = [];
    this._seen = {};
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
    var intent = {
      creepName: creep.name,
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
      order: this._order++
    };
    if (this._seen[key]) {
      var existing = this._seen[key];
      if (intent.priority > existing.priority ||
          (intent.priority === existing.priority && intent.order < existing.order)) {
        this._seen[key] = intent;
      }
    } else {
      this._seen[key] = intent;
      this._intents.push(intent);
    }
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
      try {
        if (typeof creep.travelTo === 'function') {
          creep.travelTo(pos, travelOpts);
          continue;
        }
      } catch (err) {}
      if (creep.pos.getRangeTo(pos) > intent.range) {
        creep.moveTo(pos, {
          reusePath: travelOpts.reusePath,
          ignoreCreeps: travelOpts.ignoreCreeps,
          maxOps: travelOpts.maxOps,
          plainCost: travelOpts.plainCost,
          swampCost: travelOpts.swampCost
        });
      }
    }
  }
};

module.exports = MovementManager;
