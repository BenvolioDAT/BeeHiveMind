'use strict';

var CoreConfig = require('core.config');
var CoreLogger = require('core.logger');
var verifyLog = CoreLogger.createLogger('MoveVerify', CoreLogger.LOG_LEVEL.BASIC);

function getMovementCfg() {
  var settings = CoreConfig && CoreConfig.settings;
  return settings && settings.movement ? settings.movement : null;
}

function isEnabled() {
  var cfg = getMovementCfg();
  return !!(cfg && cfg.DEBUG_MOVEMENT_VERIFY === true);
}

function maxSamples() {
  var cfg = getMovementCfg();
  var max = cfg && cfg.DEBUG_MOVEMENT_VERIFY_MAX_EVENTS_PER_TICK;
  return (typeof max === 'number' && max > 0) ? max : 200;
}

function safeTick() {
  return (typeof Game === 'object' && Game && typeof Game.time === 'number') ? Game.time : 0;
}

function createState(tick) {
  return {
    tick: tick,
    byCreep: {},
    counters: {
      travelCall: 0,
      destNormOk: 0,
      step: 0,
      stepResult: 0,
      borderTransition: 0,
      toolboxCall: 0,
      toolboxResult: 0,
      req: 0,
      reqInvalid: 0,
      reqDowngrade: 0,
      resolveExec: 0,
      resolveSkipOwned: 0,
      resolveSkipMissing: 0,
      resolveResult: 0,
      ownCall: 0,
      ownMarkOk: 0,
      ownSkip: 0,
      fails: 0,
      failThenMove: 0,
      queueDirectConflict: 0,
      borderRecover: 0,
      reverseBlock: 0,
      destBad: 0,
      toolboxFallback: 0
    },
    samples: []
  };
}

function ensureState() {
  if (typeof global === 'undefined') return null;
  var tick = safeTick();
  if (!global.__BHM_MOVEMENT_VERIFY || global.__BHM_MOVEMENT_VERIFY.tick !== tick) {
    global.__BHM_MOVEMENT_VERIFY = createState(tick);
  }
  return global.__BHM_MOVEMENT_VERIFY;
}

function sanitizeScalar(v) {
  var t = typeof v;
  if (v == null || t === 'string' || t === 'number' || t === 'boolean') return v;
  return String(v);
}

function sanitizeData(data) {
  var out = {};
  if (!data || typeof data !== 'object') return out;
  for (var k in data) {
    if (!Object.prototype.hasOwnProperty.call(data, k)) continue;
    out[k] = sanitizeScalar(data[k]);
  }
  return out;
}


function hasListFilter(list) {
  return Array.isArray(list) && list.length > 0;
}

function eventPassesFilters(type, data) {
  var cfg = getMovementCfg() || {};
  var d = data || {};

  var role = d.r != null ? d.r : d.role;
  var creepName = d.c != null ? d.c : (d.creep != null ? d.creep : d.creepName);
  var room = d.rm != null ? d.rm : d.room;
  var destRoom = d.drm != null ? d.drm : null;
  var border = (d.b != null) ? d.b : d.border;

  if (hasListFilter(cfg.DEBUG_MOVEMENT_VERIFY_ROLES) && cfg.DEBUG_MOVEMENT_VERIFY_ROLES.indexOf(role) === -1) {
    return false;
  }
  if (hasListFilter(cfg.DEBUG_MOVEMENT_VERIFY_CREEPS) && cfg.DEBUG_MOVEMENT_VERIFY_CREEPS.indexOf(creepName) === -1) {
    return false;
  }
  if (hasListFilter(cfg.DEBUG_MOVEMENT_VERIFY_ROOMS)) {
    var rooms = cfg.DEBUG_MOVEMENT_VERIFY_ROOMS;
    if (rooms.indexOf(room) === -1 && rooms.indexOf(destRoom) === -1) {
      return false;
    }
  }

  if (cfg.DEBUG_MOVEMENT_VERIFY_BORDERS_ONLY === true) {
    var important = (
      type === 'mv.dest.bad' ||
      type === 'mv.fail.then.move' ||
      type === 'mv.queue.direct.conflict' ||
      type === 'mv.reverse.block' ||
      type === 'mv.border.recover' ||
      type === 'mv.toolbox.fallback'
    );
    var stateBuilding = (
      type === 'mv.fail' ||
      type === 'mv.own.call' ||
      type === 'mv.own.mark.ok' ||
      type === 'mv.travel.call' ||
      type === 'mv.req'
    );
    if (!important && !stateBuilding && border !== true) {
      return false;
    }
  }

  return true;
}

function ensureCreepRecord(state, creepName) {
  if (!creepName) return null;
  if (!state.byCreep[creepName]) {
    state.byCreep[creepName] = {
      attempts: 0,
      failedCount: 0,
      okCount: 0,
      hadManagerIntent: false,
      hadDirectTravel: false,
      lastFailRc: null,
      lastOwnerReason: null,
      _didFailThenMove: false,
      _didQueueDirectConflict: false
    };
  }
  return state.byCreep[creepName];
}

function maybeSample(state, sample) {
  if (!state || !sample) return;
  if (state.samples.length >= maxSamples()) return;
  state.samples.push(sample);
}

function markCounter(counters, type) {
  if (!counters || !type) return;
  if (type === 'mv.travel.call') counters.travelCall += 1;
  else if (type === 'mv.dest.norm.ok') counters.destNormOk += 1;
  else if (type === 'mv.step') counters.step += 1;
  else if (type === 'mv.step.result') counters.stepResult += 1;
  else if (type === 'mv.border.transition') counters.borderTransition += 1;
  else if (type === 'mv.toolbox.call') counters.toolboxCall += 1;
  else if (type === 'mv.toolbox.result') counters.toolboxResult += 1;
  else if (type === 'mv.req') counters.req += 1;
  else if (type === 'mv.req.invalid') counters.reqInvalid += 1;
  else if (type === 'mv.req.downgrade') counters.reqDowngrade += 1;
  else if (type === 'mv.resolve.exec') counters.resolveExec += 1;
  else if (type === 'mv.resolve.skip.owned') counters.resolveSkipOwned += 1;
  else if (type === 'mv.resolve.skip.missing') counters.resolveSkipMissing += 1;
  else if (type === 'mv.resolve.result') counters.resolveResult += 1;
  else if (type === 'mv.own.call') counters.ownCall += 1;
  else if (type === 'mv.own.mark.ok') counters.ownMarkOk += 1;
  else if (type === 'mv.own.skip') counters.ownSkip += 1;
  else if (type === 'mv.fail') counters.fails += 1;
  else if (type === 'mv.border.recover') counters.borderRecover += 1;
  else if (type === 'mv.reverse.block') counters.reverseBlock += 1;
  else if (type === 'mv.dest.bad') counters.destBad += 1;
  else if (type === 'mv.toolbox.fallback') counters.toolboxFallback += 1;
}

function startTick() {
  if (!isEnabled()) return null;
  return ensureState();
}

function event(type, data) {
  if (!isEnabled()) return;
  var state = ensureState();
  if (!state) return;
  var d = sanitizeData(data);
  if (!eventPassesFilters(type, d)) return;
  markCounter(state.counters, type);

  var creepName = d.c || d.creep || d.creepName || null;
  var rec = ensureCreepRecord(state, creepName);
  if (rec) {
    if (type === 'mv.req') rec.hadManagerIntent = true;
    if (type === 'mv.travel.call') rec.hadDirectTravel = true;
    if (type === 'mv.own.call' || type === 'mv.travel.call') rec.attempts += 1;
    if (type === 'mv.fail') {
      rec.failedCount += 1;
      rec.lastFailRc = (d.rc != null) ? d.rc : null;
      rec.lastOwnerReason = d.ownerReason || d.reason || rec.lastOwnerReason;
    }
    if (type === 'mv.own.mark.ok') {
      rec.okCount += 1;
      if (rec.failedCount > 0 && !rec._didFailThenMove) {
        rec._didFailThenMove = true;
        state.counters.failThenMove += 1;
        maybeSample(state, {
          e: 'mv.fail.then.move',
          t: safeTick(),
          c: creepName,
          rc: rec.lastFailRc,
          ownReason: rec.lastOwnerReason
        });
      }
    }
    if (rec.hadManagerIntent && rec.hadDirectTravel && !rec._didQueueDirectConflict) {
      rec._didQueueDirectConflict = true;
      state.counters.queueDirectConflict += 1;
      maybeSample(state, {
        e: 'mv.queue.direct.conflict',
        t: safeTick(),
        c: creepName,
        rm: d.rm || d.room || null
      });
    }
  }

  if (type === 'mv.dest.bad' || type === 'mv.border.recover' || type === 'mv.reverse.block' || type === 'mv.toolbox.fallback') {
    maybeSample(state, {
      e: type,
      t: safeTick(),
      c: creepName,
      rm: d.rm || d.room || null,
      rc: d.rc != null ? d.rc : null
    });
  }
}

function flushSummary() {
  if (!isEnabled()) return;
  var cfg = getMovementCfg();
  if (!cfg || cfg.DEBUG_MOVEMENT_VERIFY_SUMMARY === false) return;
  var state = ensureState();
  if (!state) return;
  var counters = state.counters || {};
  var creepCount = Object.keys(state.byCreep || {}).length;
  var interval = (typeof cfg.DEBUG_MOVEMENT_VERIFY_INTERVAL === 'number' && cfg.DEBUG_MOVEMENT_VERIFY_INTERVAL > 0)
    ? cfg.DEBUG_MOVEMENT_VERIFY_INTERVAL
    : 25;

  verifyLog.warnEvery(
    'moveVerify.summary',
    interval,
    '[MoveVerifySummary]',
    't=' + state.tick,
    'creeps=' + creepCount,
    'travelCall=' + (counters.travelCall || 0),
    'destNormOk=' + (counters.destNormOk || 0),
    'step=' + (counters.step || 0),
    'stepResult=' + (counters.stepResult || 0),
    'borderTransition=' + (counters.borderTransition || 0),
    'toolboxCall=' + (counters.toolboxCall || 0),
    'toolboxResult=' + (counters.toolboxResult || 0),
    'req=' + (counters.req || 0),
    'reqInvalid=' + (counters.reqInvalid || 0),
    'reqDowngrade=' + (counters.reqDowngrade || 0),
    'resolveExec=' + (counters.resolveExec || 0),
    'resolveSkipOwned=' + (counters.resolveSkipOwned || 0),
    'resolveSkipMissing=' + (counters.resolveSkipMissing || 0),
    'resolveResult=' + (counters.resolveResult || 0),
    'ownCall=' + (counters.ownCall || 0),
    'ownMarkOk=' + (counters.ownMarkOk || 0),
    'ownSkip=' + (counters.ownSkip || 0),
    'fails=' + (counters.fails || 0),
    'failThenMove=' + (counters.failThenMove || 0),
    'queueDirectConflict=' + (counters.queueDirectConflict || 0),
    'borderRecover=' + (counters.borderRecover || 0),
    'reverseBlock=' + (counters.reverseBlock || 0),
    'destBad=' + (counters.destBad || 0),
    'toolboxFallback=' + (counters.toolboxFallback || 0)
  );
}

function _getState() {
  if (typeof global === 'undefined') return null;
  return global.__BHM_MOVEMENT_VERIFY || null;
}

module.exports = {
  isEnabled: isEnabled,
  startTick: startTick,
  event: event,
  flushSummary: flushSummary,
  _getState: _getState
};
