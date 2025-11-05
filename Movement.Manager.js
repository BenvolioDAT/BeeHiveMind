'use strict';

/**
 * What changed & why:
 * - Added a centralized movement intent collector so creeps request travel once and resolve in MOVE phase.
 * - Keeps ordering deterministic (priority desc, FIFO per priority) so replacements stay predictable.
 */

var MovementManager = {
  _intents: [],
  _seen: {},

  /**
   * Reset tick-local state; must be called from BeeHiveMind before roles act.
   */
  startTick: function () {
    this._intents = [];
    this._seen = {};
  },

  /**
   * Record a creep movement intent for later resolution.
   * @param {Creep} creep - actor requesting movement.
   * @param {RoomPosition|{pos:RoomPosition}} dest - destination or object with .pos.
   * @param {number} priority - higher value resolves first.
   * @param {object} opts - {range,reusePath,ignoreCreeps,maxOps,plainCost,swampCost}.
   */
  request: function (creep, dest, priority, opts) {
    if (!creep || !creep.name || !dest) return ERR_INVALID_ARGS;
    var pos = dest.pos || dest;
    if (!pos || pos.x == null || pos.y == null || !pos.roomName) return ERR_INVALID_ARGS;
    var key = creep.name;
    var intent = {
      creepName: creep.name,
      roomName: pos.roomName,
      x: pos.x,
      y: pos.y,
      range: (opts && opts.range != null) ? opts.range : 1,
      priority: (typeof priority === 'number') ? priority : 0,
      reusePath: opts && opts.reusePath,
      ignoreCreeps: opts && opts.ignoreCreeps,
      maxOps: opts && opts.maxOps,
      plainCost: opts && opts.plainCost,
      swampCost: opts && opts.swampCost
    };
    if (this._seen[key]) {
      // Keep the higher priority intent per creep to avoid thrash.
      var existing = this._seen[key];
      if (intent.priority > existing.priority) {
        this._seen[key] = intent;
      }
    } else {
      this._seen[key] = intent;
      this._intents.push(intent);
    }
    return OK;
  },

  /**
   * Resolve all movement intents in deterministic priority order.
   */
  resolveAndMove: function () {
    if (!this._intents || !this._intents.length) return;
    this._intents.sort(function (a, b) {
      if (b.priority !== a.priority) return b.priority - a.priority;
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
        swampCost: intent.swampCost
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
