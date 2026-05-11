'use strict';

var CoreConfig = require('core.config');
var MovementVerify = require('Movement.Verify');


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

function getTargetFields(target) {
  if (!target) return {};
  var pos = target.pos || target;
  return getPosFields(pos, 'd');
}

function buildVerifyBase(creep, source, reason, op) {
  var base = {
    c: getCreepName(creep),
    r: getCreepRole(creep),
    src: source || 'MovementOwnership',
    reason: reason || 'none'
  };
  if (op) base.op = op;
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

function _state() {
  if (typeof global === 'undefined') return null;
  if (!global.__BHM_MOVE_OWNERSHIP || global.__BHM_MOVE_OWNERSHIP.tick !== Game.time) {
    global.__BHM_MOVE_OWNERSHIP = { tick: Game.time, creeps: {} };
  }
  return global.__BHM_MOVE_OWNERSHIP;
}

function _isMarkableResult(result) {
  return result === OK;
}

function _shouldDebug(creep) {
  var movementCfg = CoreConfig && CoreConfig.settings ? CoreConfig.settings.movement : null;
  if (!movementCfg || !movementCfg.DEBUG_MOVE_OWNERSHIP || !creep) return false;
  var roles = movementCfg.DEBUG_MOVE_OWNERSHIP_ROLES || [];
  var roleName = (creep.memory && creep.memory.role) || 'unknown';
  if (roles.length && roles.indexOf(roleName) === -1) return false;
  var interval = (typeof movementCfg.DEBUG_MOVE_OWNERSHIP_INTERVAL === 'number') ? movementCfg.DEBUG_MOVE_OWNERSHIP_INTERVAL : 1;
  var s = _state();
  if (!s) return false;
  var rec = s.creeps[creep.name];
  if (rec && rec._logTick != null && Game.time < (rec._logTick + interval)) return false;
  if (!rec) {
    rec = {};
    s.creeps[creep.name] = rec;
  }
  rec._logTick = Game.time;
  return true;
}

function _debug(creep, source, action, reason, result, extra) {
  if (!_shouldDebug(creep)) return;
  var roleName = (creep.memory && creep.memory.role) || 'unknown';
  var posTag = creep && creep.pos ? (creep.pos.roomName + ':' + creep.pos.x + ',' + creep.pos.y) : 'unknown';
  var ownerReason = extra && extra.ownerReason ? extra.ownerReason : 'none';
  var dir = extra && extra.direction != null ? extra.direction : 0;
  console.log('[MoveOwnership] t=' + Game.time + ' creep=' + creep.name + ' role=' + roleName + ' source=' + source + ' action=' + action + ' reason=' + reason + ' result=' + result + ' dir=' + dir + ' ownerReason=' + ownerReason + ' pos=' + posTag);
}

var MovementOwnership = {
  has: function (creep) {
    if (!creep || !creep.name) return false;
    var s = _state();
    if (!s) return false;
    var rec = s.creeps[creep.name];
    return !!(rec && rec.marked === true);
  },

  get: function (creep) {
    if (!creep || !creep.name) return null;
    var s = _state();
    if (!s) return null;
    return s.creeps[creep.name] || null;
  },

  mark: function (creep, source, reason, result, extra) {
    if (!creep || !creep.name) return result;
    var s = _state();
    if (!s) return result;
    if (_isMarkableResult(result)) {
      s.creeps[creep.name] = {
        marked: true,
        tick: Game.time,
        source: source || 'unknown',
        reason: reason || 'none',
        result: result,
        extra: extra || {}
      };
      var markBase = buildVerifyBase(creep, source || 'unknown', reason || 'none', 'mark');
      markBase.rc = result;
      markBase.ownerSource = source || 'unknown';
      markBase.ownerReason = reason || 'none';
      recordMoveVerify('mv.own.mark.ok', markBase);
    }
    _debug(creep, source || 'unknown', 'mark', reason || 'none', result, extra || {});
    return result;
  },

  move: function (creep, direction, reason, source) {
    if (!creep || typeof creep.move !== 'function') return ERR_INVALID_ARGS;
    var moveBase = buildVerifyBase(creep, source || 'MovementOwnership.move', reason || 'move', 'move');
    moveBase.dir = direction;
    recordMoveVerify('mv.own.call', moveBase);
    var rc = creep.move(direction);
    this.mark(creep, source || 'direct', reason || 'move', rc, { direction: direction });
    if (rc !== OK) {
      moveBase.rc = rc;
      moveBase.ownerReason = reason || 'move';
      recordMoveVerify('mv.fail', moveBase);
    }
    _debug(creep, source || 'direct', 'move', reason || 'move', rc, { direction: direction });
    return rc;
  },

  moveTo: function (creep, target, opts, reason, source) {
    if (!creep || typeof creep.moveTo !== 'function') return ERR_INVALID_ARGS;
    var moveToBase = buildVerifyBase(creep, source || 'MovementOwnership.moveTo', reason || 'moveTo', 'moveTo');
    var t = getTargetFields(target);
    if (t.drm != null) moveToBase.drm = t.drm;
    if (t.dx != null) moveToBase.dx = t.dx;
    if (t.dy != null) moveToBase.dy = t.dy;
    recordMoveVerify('mv.own.call', moveToBase);
    var rc = creep.moveTo(target, opts || {});
    this.mark(creep, source || 'direct', reason || 'moveTo', rc, {});
    if (rc !== OK) {
      moveToBase.rc = rc;
      moveToBase.ownerReason = reason || 'moveTo';
      recordMoveVerify('mv.fail', moveToBase);
    }
    _debug(creep, source || 'direct', 'moveTo', reason || 'moveTo', rc, {});
    return rc;
  },

  logSkip: function (creep, source, reason, extra) {
    var owner = this.get(creep);
    var ownerReason = owner && owner.reason ? owner.reason : 'none';
    var skipBase = buildVerifyBase(creep, source || 'unknown', reason || 'alreadyMoved', 'skip');
    skipBase.ownerSource = owner && owner.source ? owner.source : 'none';
    skipBase.ownerReason = ownerReason;
    recordMoveVerify('mv.own.skip', skipBase);
    _debug(creep, source || 'unknown', 'skip', reason || 'alreadyMoved', OK, Object.assign({}, extra || {}, { ownerReason: ownerReason }));
  }
};

module.exports = MovementOwnership;
