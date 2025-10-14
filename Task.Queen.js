// role.TaskQueen.queue.es5.js
// ES5-safe Queen with Job Queue + PIB + Controller-Feed + Courier-Assist
// - Builds per-room job queue (spawns/exts/towers...)
// - Predictive Intent Buffer (PIB) for smoother multitasking
// - Before courier mode: fills controller container for Upgraders
// - Falls back to courier assist when no jobs remain

'use strict';

var BeeToolbox = require('BeeToolbox');

/* =========================
   Tunables (tweak these)
========================= */
var JOB_WEIGHTS = {
  SPWNEXT: 100,
  TOWER:   80,
  LINK:    40
};
var TOWER_REFILL_AT_OR_BELOW = 0.70;

var MIN_DELIVER_CHUNK = 50;
var MIN_DELIVER_CHUNK_SPAWN = 1;
var MIN_DELIVER_CHUNK_EXTENSION = 10;
var MIN_SUPPORT_PICKUP = 80;
var MIN_TRIP_SIZE = 50;

/* =========================
   Movement helper
========================= */
function go(creep, dest, range, reuse) {
  range = (range != null) ? range : 1;
  reuse = (reuse != null) ? reuse : 30;
  var target = (dest.pos || dest);
  if (BeeToolbox && BeeToolbox.BeeTravel) {
    try { BeeToolbox.BeeTravel(creep, target, { range: range, reusePath: reuse }); return; } catch (e) {}
  }
  if (creep.pos.getRangeTo(target) > range) creep.moveTo(target, { reusePath: reuse, maxOps: 2000 });
}

function _nearest(pos, arr) {
  var best = null, bestD = 1e9, i, o, d;
  for (i = 0; i < arr.length; i++) {
    o = arr[i]; if (!o) continue;
    d = pos.getRangeTo(o);
    if (d < bestD) { bestD = d; best = o; }
  }
  return best;
}

/* =========================
   PIB (Predictive Intent Buffer)
========================= */
function pibSet(creep, type, targetId, nextTargetId) { creep.memory.pib = { t: type, id: targetId, next: nextTargetId, setAt: Game.time|0 }; }
function pibClear(creep) { creep.memory.pib = null; }

function _doAction(creep, type, target) {
  if (type === 'withdraw') return creep.withdraw(target, RESOURCE_ENERGY);
  if (type === 'transfer') return creep.transfer(target, RESOURCE_ENERGY);
  if (type === 'pickup')   return creep.pickup(target);
  if (type === 'build')    return creep.build(target);
  if (type === 'repair')   return creep.repair(target);
  if (type === 'upgrade')  return creep.upgradeController(target);
  if (type === 'harvest')  return creep.harvest(target);
  return ERR_INVALID_ARGS;
}

function pibTry(creep) {
  var pib = creep.memory.pib;
  if (!pib) return false;
  var tgt = Game.getObjectById(pib.id);
  if (!tgt) { pibClear(creep); return false; }
  if (creep.pos.getRangeTo(tgt) > 1) { pibClear(creep); return false; }
  var rc = _doAction(creep, pib.t, tgt);
  if (rc === OK && pib.next) {
    var nxt = Game.getObjectById(pib.next);
    if (nxt) go(creep, (nxt.pos || nxt), 1, 10);
  }
  pibClear(creep);
  return rc === OK;
}

/* =========================
   Room cache (one-pass helpers)
========================= */
if (!global.__QRM) global.__QRM = { tick: -1, byRoom: {} };
function _rc(room) {
  if (global.__QRM.tick !== Game.time) { global.__QRM.tick = Game.time; global.__QRM.byRoom = {}; }
  var R = global.__QRM.byRoom[room.name];
  if (R) return R;

  var spawnsAndExtsNeed = room.find(FIND_STRUCTURES, { filter: function(s){
    if (!s.store) return false;
    if (s.structureType !== STRUCTURE_SPAWN && s.structureType !== STRUCTURE_EXTENSION) return false;
    return (s.store.getFreeCapacity(RESOURCE_ENERGY) | 0) > 0;
  }});

  var towersNeed = room.find(FIND_STRUCTURES, { filter: function(s){
    if (s.structureType !== STRUCTURE_TOWER || !s.store) return false;
    var used = (s.store.getUsedCapacity(RESOURCE_ENERGY)|0);
    var cap = (s.store.getCapacity(RESOURCE_ENERGY)|0);
    if (cap <= 0) return false;
    var pct = used / cap;
    return pct <= TOWER_REFILL_AT_OR_BELOW;
  }});

  var storage = room.storage || null;
  var terminal = room.terminal || null;

  var graves = room.find(FIND_TOMBSTONES, { filter: function(t){ return (t.store && ((t.store[RESOURCE_ENERGY]|0) > 0)); } })
               .concat(room.find(FIND_RUINS, { filter: function(r){ return (r.store && ((r.store[RESOURCE_ENERGY]|0) > 0)); } }));

  var sideContainers = room.find(FIND_STRUCTURES, { filter: function(s){
    return s.structureType === STRUCTURE_CONTAINER &&
           (s.pos.findInRange(FIND_SOURCES, 1).length === 0) &&
           s.store && ((s.store.getUsedCapacity(RESOURCE_ENERGY)|0) > 0);
  }});

  var srcContainers = room.find(FIND_STRUCTURES, { filter: function(s){
    return s.structureType === STRUCTURE_CONTAINER &&
           (s.pos.findInRange(FIND_SOURCES, 1).length > 0) &&
           s.store && ((s.store.getUsedCapacity(RESOURCE_ENERGY)|0) > 0);
  }});

  global.__QRM.byRoom[room.name] = R = {
    spwnextNeed: spawnsAndExtsNeed,
    towersNeed: towersNeed,
    storage: storage,
    terminal: terminal,
    graves: graves,
    sideContainers: sideContainers,
    srcContainers: srcContainers
  };
  return R;
}

/* =========================
   Job queue (Memory)
========================= */
function _ensureRoomQueue(room) {
  if (!Memory.queenJobs) Memory.queenJobs = { tick: -1, rooms: {} };
  var MQ = Memory.queenJobs;
  var RR = MQ.rooms[room.name];
  if (MQ.tick !== Game.time || !RR) {
    MQ.tick = Game.time;
    if (!RR) MQ.rooms[room.name] = { jobs: [], ver: 0 };
  }
  if (!MQ.rooms[room.name]) MQ.rooms[room.name] = { jobs: [], ver: 0 };
  return MQ.rooms[room.name];
}

function buildJobs(room) {
  var Q = _ensureRoomQueue(room);
  if (Q.builtAt === Game.time) return Q;
  Q.jobs = [];
  var rc = _rc(room);
  var now = Game.time|0;

  function addJob(type, target, need, priority) {
    if (!target || !target.id || need <= 0) return;
    Q.jobs.push({
      id: target.id + ':' + type,
      type: type,
      targetId: target.id,
      priority: priority,
      need: need,
      remaining: need,
      assignedTo: null,
      createdAt: now
    });
  }

  var i, s, free, cap, pctEmpty, minChunk, prio;
  for (i = 0; i < rc.spwnextNeed.length; i++) {
    s = rc.spwnextNeed[i];
    free = (s.store.getFreeCapacity(RESOURCE_ENERGY)|0);
    cap  = (s.store.getCapacity(RESOURCE_ENERGY)|0);
    pctEmpty = cap > 0 ? (free / cap) : 0;

    minChunk = (s.structureType === STRUCTURE_SPAWN) ?
      MIN_DELIVER_CHUNK_SPAWN : MIN_DELIVER_CHUNK_EXTENSION;

    if (free >= minChunk) {
      prio = JOB_WEIGHTS.SPWNEXT + (pctEmpty * 100) + (free / 10);
      if (s.structureType === STRUCTURE_SPAWN) prio += 5;
      addJob('SPWNEXT', s, free, prio);
    }
  }

  for (i = 0; i < rc.towersNeed.length; i++) {
    s = rc.towersNeed[i];
    var used = (s.store.getUsedCapacity(RESOURCE_ENERGY)|0);
    cap  = (s.store.getCapacity(RESOURCE_ENERGY)|0);
    var freeT = cap - used;
    var pct = (cap>0) ? (used / cap) : 1;
    var urgency = (1 - pct) * 100;
    addJob('TOWER', s, freeT, JOB_WEIGHTS.TOWER + urgency);
  }

  Q.jobs.sort(function(a,b){ return b.priority - a.priority; });
  Q.builtAt = Game.time;
  return Q;
}

function claimJob(creep, room) {
  var Q = buildJobs(room);
  var i, J;
  for (i = 0; i < Q.jobs.length; i++) {
    J = Q.jobs[i];
    if (!J.assignedTo || !Game.creeps[J.assignedTo]) {
      J.assignedTo = creep.name;
      creep.memory.qJobId = J.id;
      creep.memory.qJobTargetId = J.targetId;
      creep.memory.qJobType = J.type;
      return J;
    }
  }
  return null;
}

function getJob(creep, room) {
  var Q = buildJobs(room);
  var id = creep.memory.qJobId;
  if (!id) return null;
  var i, J;
  for (i = 0; i < Q.jobs.length; i++) { J = Q.jobs[i]; if (J.id === id) return J; }
  creep.memory.qJobId = null; creep.memory.qJobTargetId = null; creep.memory.qJobType = null;
  return null;
}

function reportDelivery(creep, room, delivered) {
  var Q = buildJobs(room);
  var id = creep.memory.qJobId; if (!id) return;
  var i, J;
  for (i = 0; i < Q.jobs.length; i++) {
    J = Q.jobs[i];
    if (J.id === id) {
      J.remaining = Math.max(0, J.remaining - delivered);
      if (J.remaining <= 0) {
        Q.jobs.splice(i,1);
        creep.memory.qJobId = null; creep.memory.qJobTargetId = null; creep.memory.qJobType = null;
      }
      return;
    }
  }
  creep.memory.qJobId = null; creep.memory.qJobTargetId = null; creep.memory.qJobType = null;
}

/* =========================
   Support helpers
========================= */
function chooseSupportPickup(creep, rc) {
  var i, best = null, bestAmt = -1, amt, r;
  var drops = creep.room.find(FIND_DROPPED_RESOURCES, {
    filter: function (res) { return res.resourceType === RESOURCE_ENERGY && (res.amount | 0) >= MIN_SUPPORT_PICKUP; }
  });
  for (i = 0; i < drops.length; i++) {
    r = drops[i]; amt = (r.amount | 0);
    if (amt > bestAmt) { bestAmt = amt; best = r; }
  }
  if (best) return best;

  if (rc.graves && rc.graves.length) {
    best = null; bestAmt = -1;
    for (i = 0; i < rc.graves.length; i++) {
      r = rc.graves[i];
      amt = (r.store && (r.store[RESOURCE_ENERGY] | 0)) | 0;
      if (amt > bestAmt) { bestAmt = amt; best = r; }
    }
    if (best) return best;
  }

  if (rc.srcContainers && rc.srcContainers.length) {
    best = null; bestAmt = -1;
    for (i = 0; i < rc.srcContainers.length; i++) {
      r = rc.srcContainers[i];
      amt = (r.store && r.store.getUsedCapacity(RESOURCE_ENERGY)) | 0;
      if (amt > bestAmt) { bestAmt = amt; best = r; }
    }
    if (best) return best;
  }

  if (rc.sideContainers && rc.sideContainers.length) {
    best = null; bestAmt = -1;
    for (i = 0; i < rc.sideContainers.length; i++) {
      r = rc.sideContainers[i];
      amt = (r.store && r.store.getUsedCapacity(RESOURCE_ENERGY)) | 0;
      if (amt > bestAmt) { bestAmt = amt; best = r; }
    }
    if (best) return best;
  }

  return rc.storage || null;
}

function chooseSupportDropoff(rc) {
  if (rc.storage && (rc.storage.store.getFreeCapacity(RESOURCE_ENERGY)|0) > 0) return rc.storage;
  if (rc.terminal && (rc.terminal.store.getFreeCapacity(RESOURCE_ENERGY)|0) > 0) return rc.terminal;
  return null;
}

/* =========================
   New helper — fill controller container
========================= */
function maybeFeedControllerContainer(creep, rc) {
  var room = creep.room;
  if (!room || !room.controller) return false;

  var ctrlContainer = room.controller.pos.findClosestByRange(FIND_STRUCTURES, {
    filter: function(s) {
      return s.structureType === STRUCTURE_CONTAINER &&
             s.pos.getRangeTo(room.controller) <= 3 &&
             (s.store.getFreeCapacity(RESOURCE_ENERGY) | 0) > 0;
    }
  });
  if (!ctrlContainer) return false;

  var carry = (creep.store.getUsedCapacity(RESOURCE_ENERGY) | 0);

  if (carry <= 0) {
    var src = rc.storage && (rc.storage.store[RESOURCE_ENERGY] | 0) > 0 ? rc.storage :
              (rc.sideContainers && rc.sideContainers.length ? _nearest(creep.pos, rc.sideContainers) : null) ||
              (rc.srcContainers && rc.srcContainers.length ? _nearest(creep.pos, rc.srcContainers) : null);
    if (!src) return false;

    var d = creep.pos.getRangeTo(src);
    if (d >= 2) {
      if (d === 2) pibSet(creep, 'withdraw', src.id, ctrlContainer.id);
      go(creep, src, 1, 20);
      return true;
    }
    var rcIn = creep.withdraw(src, RESOURCE_ENERGY);
    if (rcIn === ERR_NOT_IN_RANGE) { go(creep, src); return true; }
    if (rcIn === OK) { go(creep, ctrlContainer, 1, 10); return true; }
    return true;
  }

  var dist = creep.pos.getRangeTo(ctrlContainer);
  if (dist >= 2) {
    if (dist === 2) pibSet(creep, 'transfer', ctrlContainer.id, null);
    go(creep, ctrlContainer, 1, 15);
    return true;
  }

  var rcOut = creep.transfer(ctrlContainer, RESOURCE_ENERGY);
  if (rcOut === ERR_NOT_IN_RANGE) { go(creep, ctrlContainer); return true; }
  if (rcOut === OK) creep.say('🎁 upgrader box full!');
  return true;
}

/* =========================
   Main role
========================= */
var TaskQueen = {
  run: function(creep) {
    var room = creep.room;
    var rc = _rc(room);

    if (pibTry(creep)) return;

    var job = getJob(creep, room);
    if (!job) job = claimJob(creep, room);

    // 👑 New: fill controller container before courier assist
    if (!job) {
      var didFill = maybeFeedControllerContainer(creep, rc);
      if (didFill) return;
      return this.fallbackCourier(creep, rc);
    }

    var target = Game.getObjectById(job.targetId);
    if (!target) {
      creep.memory.qJobId = null; creep.memory.qJobTargetId = null; creep.memory.qJobType = null;
      return;
    }

    var carry = (creep.store.getUsedCapacity(RESOURCE_ENERGY)|0);
    if (carry <= 0) {
      var pick = rc.storage && (rc.storage.store.getUsedCapacity(RESOURCE_ENERGY)|0) > 0 ? rc.storage
               : (rc.sideContainers && rc.sideContainers.length ? _nearest(creep.pos, rc.sideContainers) : null)
               || (rc.graves && rc.graves.length ? _nearest(creep.pos, rc.graves) : null)
               || creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, { filter: function(r){ return r.resourceType===RESOURCE_ENERGY && (r.amount|0) >= MIN_DELIVER_CHUNK; } });

      if (pick) {
        var dp = creep.pos.getRangeTo(pick);
        if (dp >= 2) { if (dp === 2) pibSet(creep, (pick.amount!=null)?'pickup':'withdraw', pick.id, target.id); go(creep, pick, 1, 20); return; }
        var rcIn = (pick.amount!=null) ? creep.pickup(pick) : creep.withdraw(pick, RESOURCE_ENERGY);
        if (rcIn === ERR_NOT_IN_RANGE) { go(creep, pick); return; }
        if (rcIn === OK) { if (target) go(creep, target, 1, 10); return; }
      } else {
        var srcs = room.find(FIND_SOURCES_ACTIVE);
        if (srcs && srcs.length) { var s = _nearest(creep.pos, srcs); var h = creep.harvest(s); if (h === ERR_NOT_IN_RANGE) go(creep, s); }
        return;
      }
      return;
    }

    var d = creep.pos.getRangeTo(target);
    if (d >= 2) { if (d === 2) pibSet(creep, 'transfer', target.id, null); go(creep, target, 1, 20); return; }

    var before = (creep.store.getUsedCapacity(RESOURCE_ENERGY)|0);
    var tr = creep.transfer(target, RESOURCE_ENERGY);
    if (tr === ERR_NOT_IN_RANGE) { go(creep, target, 1, 20); return; }
    if (tr === OK) {
      var after = (creep.store.getUsedCapacity(RESOURCE_ENERGY)|0);
      var delivered = Math.max(0, before - after);
      if (delivered > 0) reportDelivery(creep, room, delivered);
      if ((creep.store.getUsedCapacity(RESOURCE_ENERGY)|0) > 0) {
        var nextPick = rc.storage || (rc.sideContainers && rc.sideContainers.length ? _nearest(creep.pos, rc.sideContainers) : null);
        if (nextPick) go(creep, (nextPick.pos||nextPick), 1, 10);
      }
      return;
    }

    if (tr === ERR_FULL || tr === ERR_INVALID_TARGET) {
      creep.memory.qJobId = null; creep.memory.qJobTargetId = null; creep.memory.qJobType = null;
    }
  },

  fallbackCourier: function(creep, rc) {
    var carrying = (creep.store.getUsedCapacity(RESOURCE_ENERGY)|0) > 0;

    if (!carrying) {
      var pick = chooseSupportPickup(creep, rc);
      if (!pick) {
        var anchor = rc.storage || creep.pos.findClosestByRange(FIND_MY_SPAWNS) || creep.pos;
        go(creep, (anchor.pos||anchor), 2, 40); return;
      }
      var sinkHint = chooseSupportDropoff(rc);
      var dp = creep.pos.getRangeTo(pick);
      var isDrop = (pick.amount != null);
      if (dp >= 2) {
        if (dp === 2) pibSet(creep, isDrop ? 'pickup' : 'withdraw', pick.id, (sinkHint ? sinkHint.id : null));
        go(creep, pick, 1, 20); return;
      }
      var rcIn = isDrop ? creep.pickup(pick) : creep.withdraw(pick, RESOURCE_ENERGY);
      if (rcIn === ERR_NOT_IN_RANGE) { go(creep, pick); return; }
      if (rcIn === OK && sinkHint) go(creep, sinkHint, 1, 10);
      return;
    }

    var sink = chooseSupportDropoff(rc);
    if (!sink) { var anchor2 = rc.storage || creep.pos; go(creep, (anchor2.pos||anchor2), 2, 40); return; }
    var ds = creep.pos.getRangeTo(sink);
    if (ds >= 2) { if (ds === 2) pibSet(creep, 'transfer', sink.id, null); go(creep, sink, 1, 30); return; }
    var tr = creep.transfer(sink, RESOURCE_ENERGY);
    if (tr === ERR_NOT_IN_RANGE) { go(creep, sink); return; }
    if (tr === OK) return;
  }
};

module.exports = TaskQueen;
