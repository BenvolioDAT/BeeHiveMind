// role.TaskQueen.queue.es5.js
// ES5-safe Queen with Job Queue + PIB + Controller-Feed + Courier-Assist + Visual Flags
// - Stable job IDs across ticks (per-room idByKey)
// - Multi-Queen safe claiming (tickClaimed)
// - Creep-side hard cleanup after successful transfer
// - Ghost-flag janitor
'use strict';

var BeeToolbox = require('BeeToolbox');

/* =========================
   Tunables
========================= */
var JOB_WEIGHTS = { SPWNEXT: 100, TOWER: 80, LINK: 40 };
var TOWER_REFILL_AT_OR_BELOW = 0.70;

var MIN_DELIVER_CHUNK = 50;
var MIN_DELIVER_CHUNK_SPAWN = 1;
var MIN_DELIVER_CHUNK_EXTENSION = 10;
var MIN_SUPPORT_PICKUP = 80;

var FLAG_UPDATE_INTERVAL = 10; // ticks

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
  for (i = 0; i < arr.length; i++) { o = arr[i]; if (!o) continue; d = pos.getRangeTo(o); if (d < bestD) { bestD = d; best = o; } }
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
   Job queue (Memory shape)
========================= */
function _ensureRoomQueue(room) {
  if (!Memory.queenJobs) Memory.queenJobs = { tick: -1, rooms: {} };
  var MQ = Memory.queenJobs;
  var RR = MQ.rooms[room.name];
  if (!RR) {
    RR = MQ.rooms[room.name] = { jobs: [], ver: 0, idByKey: {} };
  }
  // bump tick marker
  MQ.tick = Game.time;
  // backfill idByKey
  if (!RR.idByKey) RR.idByKey = {};
  if (!RR.jobs) RR.jobs = [];
  return RR;
}

/* =========================
   Stable ID helpers
========================= */
function _jobKey(type, targetId) { return targetId + ':' + type; }
function _getShortIdForKey(Q, key) {
  var id = Q.idByKey[key];
  if (!id) {
    // allocate 1..99, avoid collisions
    var used = {};
    for (var k in Q.idByKey) used[Q.idByKey[k]] = true;
    for (var n = 1; n <= 99; n++) {
      if (!used[n]) { id = n; break; }
    }
    if (!id) id = 1; // fallback recycle
    Q.idByKey[key] = id;
  }
  return id;
}

/* =========================
   Job creation + Flags (with stable IDs)
========================= */
function buildJobs(room) {
  var Q = _ensureRoomQueue(room);
  if (Q.builtAt === Game.time) return Q;

  var rc = _rc(room);
  var now = Game.time|0;

  // Build a set of active keys this tick
  var activeKeys = {};
  var jobs = [];

  function addJob(type, target, need, priority) {
    if (!target || !target.id || need <= 0) return;
    var key = _jobKey(type, target.id);
    var shortId = _getShortIdForKey(Q, key);
    var job = {
      key: key,
      id: shortId,
      type: type,
      targetId: target.id,
      flagName: 'job_' + shortId,
      priority: priority,
      need: need,
      remaining: need,
      assignedTo: null,
      createdAt: now,
      tickClaimed: -1
    };
    jobs.push(job);
    activeKeys[key] = true;
  }

  var i, s, free, cap, pctEmpty, minChunk, prio;

  // Spawns + Extensions
  for (i = 0; i < rc.spwnextNeed.length; i++) {
    s = rc.spwnextNeed[i];
    free = (s.store.getFreeCapacity(RESOURCE_ENERGY)|0);
    cap  = (s.store.getCapacity(RESOURCE_ENERGY)|0);
    pctEmpty = cap > 0 ? (free / cap) : 0;
    minChunk = (s.structureType === STRUCTURE_SPAWN) ? MIN_DELIVER_CHUNK_SPAWN : MIN_DELIVER_CHUNK_EXTENSION;
    if (free >= minChunk) {
      prio = JOB_WEIGHTS.SPWNEXT + (pctEmpty * 100) + (free / 10);
      if (s.structureType === STRUCTURE_SPAWN) prio += 5;
      addJob('SPWNEXT', s, free, prio);
    }
  }

  // Towers
  for (i = 0; i < rc.towersNeed.length; i++) {
    s = rc.towersNeed[i];
    var used = (s.store.getUsedCapacity(RESOURCE_ENERGY)|0);
    cap  = (s.store.getCapacity(RESOURCE_ENERGY)|0);
    var freeT = cap - used;
    var pct = (cap>0) ? (used / cap) : 1;
    var urgency = (1 - pct) * 100;
    addJob('TOWER', s, freeT, JOB_WEIGHTS.TOWER + urgency);
  }

  // Keep prior assignments where possible (match by key)
  var prev = Q.jobs || [];
  for (i = 0; i < jobs.length; i++) {
    var J = jobs[i];
    // find previous entry with same key
    for (var j = 0; j < prev.length; j++) {
      if (prev[j] && prev[j].key === J.key) {
        J.assignedTo = prev[j].assignedTo && Game.creeps[prev[j].assignedTo] ? prev[j].assignedTo : null;
        // preserve partial remaining if lower than fresh 'need'
        if (prev[j].remaining != null && prev[j].remaining < J.remaining) J.remaining = prev[j].remaining;
        break;
      }
    }
  }

  // Sort by priority
  jobs.sort(function(a,b){ return b.priority - a.priority; });

  // Install new list
  Q.jobs = jobs;
  Q.builtAt = Game.time;

  // Ghost-flag janitor + ensure flags exist
  if (Game.time % FLAG_UPDATE_INTERVAL === 0) {
    // remove flags for keys not active
    for (var k in Q.idByKey) {
      if (!activeKeys[k]) {
        var fname = 'job_' + Q.idByKey[k];
        if (Game.flags[fname]) Game.flags[fname].remove();
        delete Q.idByKey[k];
      }
    }
    // create flags for active jobs if missing
    for (i = 0; i < Q.jobs.length; i++) {
      var job = Q.jobs[i];
      var tgt = Game.getObjectById(job.targetId);
      if (!tgt) continue;
      if (!Game.flags[job.flagName]) {
        var color = (job.type === 'TOWER') ? COLOR_RED :
                    (job.type === 'SPWNEXT') ? COLOR_YELLOW :
                    COLOR_ORANGE;
        room.createFlag(tgt.pos, job.flagName, color, COLOR_ORANGE);
      }
    }
  }

  return Q;
}

/* =========================
   Job claim / lookup / report
========================= */
function claimJob(creep, room) {
  var Q = buildJobs(room);
  var i, J;
  for (i = 0; i < Q.jobs.length; i++) {
    J = Q.jobs[i];
    if (J.assignedTo && Game.creeps[J.assignedTo]) continue;
    if (J.tickClaimed === Game.time) continue;
    J.assignedTo = creep.name;
    J.tickClaimed = Game.time;
    creep.memory.qJobId = J.id;
    creep.memory.qJobTargetId = J.targetId;
    creep.memory.qJobType = J.type;
    creep.memory.qFlagName = J.flagName;
    creep.memory.qJobKey = J.key;
    return J;
  }
  return null;
}

function getJob(creep, room) {
  var Q = buildJobs(room);
  var id = creep.memory.qJobId;
  if (!id) return null;
  var i, J;
  for (i = 0; i < Q.jobs.length; i++) { J = Q.jobs[i]; if (J.id === id) return J; }
  // not found -> clear
  creep.memory.qJobId = creep.memory.qJobTargetId = creep.memory.qJobType = creep.memory.qFlagName = creep.memory.qJobKey = null;
  return null;
}

function _hardRemoveJobByKey(room, key) {
  var QR = Memory.queenJobs && Memory.queenJobs.rooms && Memory.queenJobs.rooms[room.name];
  if (!QR) return;
  if (!QR.idByKey) QR.idByKey = {};
  // remove from jobs
  var i;
  for (i = 0; i < QR.jobs.length; i++) {
    if (QR.jobs[i].key === key) {
      // remove flag
      var fname = 'job_' + QR.jobs[i].id;
      if (Game.flags[fname]) Game.flags[fname].remove();
      QR.jobs.splice(i,1);
      break;
    }
  }
  // release ID so it can be reused later
  var sid = QR.idByKey[key];
  if (sid) delete QR.idByKey[key];
}

function reportDelivery(creep, room, delivered) {
  var Q = buildJobs(room);
  var id = creep.memory.qJobId; if (!id) return;
  var i, J;
  for (i = 0; i < Q.jobs.length; i++) {
    J = Q.jobs[i];
    if (J.id === id) {
      J.remaining = Math.max(0, (J.remaining|0) - (delivered|0));
      if (J.remaining <= 0) {
        // done -> remove flag + job + id mapping
        if (Game.flags[J.flagName]) Game.flags[J.flagName].remove();
        var key = J.key;
        Q.jobs.splice(i,1);
        if (Q.idByKey && Q.idByKey[key]) delete Q.idByKey[key];
        creep.memory.qJobId = creep.memory.qJobTargetId = creep.memory.qJobType = creep.memory.qFlagName = creep.memory.qJobKey = null;
      }
      return;
    }
  }
}

/* =========================
   Support helpers
========================= */
function chooseSupportPickup(creep, rc) {
  // 1. If storage has energy, prefer it
  if (rc.storage && (rc.storage.store[RESOURCE_ENERGY] | 0) > 0) {
    return rc.storage;
  }

  // 2. Then try dropped resources
  var drops = creep.room.find(FIND_DROPPED_RESOURCES, {
    filter: function (res) {
      return res.resourceType === RESOURCE_ENERGY && (res.amount | 0) >= MIN_SUPPORT_PICKUP;
    }
  });
  if (drops.length) return _nearest(creep.pos, drops);

  // 3. Then tombstones, ruins, or containers
  var all = [];
  if (rc.graves) all = all.concat(rc.graves);
  if (rc.srcContainers) all = all.concat(rc.srcContainers);
  if (rc.sideContainers) all = all.concat(rc.sideContainers);
  var best = _nearest(creep.pos, all);

  // 4. Finally, fallback to storage (if it somehow wasn’t caught earlier)
  return best || rc.storage || null;
}


function chooseSupportDropoff(rc) {
  if (rc.storage && (rc.storage.store.getFreeCapacity(RESOURCE_ENERGY)|0) > 0) return rc.storage;
  if (rc.terminal && (rc.terminal.store.getFreeCapacity(RESOURCE_ENERGY)|0) > 0) return rc.terminal;
  return null;
}

/* =========================
   Controller-feed helper
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
  if (rcOut === OK) creep.say('🎁 upgrader box!');
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

    // if no job, try controller feed then courier fallback
    if (!job) {
      if (maybeFeedControllerContainer(creep, rc)) return;
      return this.fallbackCourier(creep, rc);
    }

    var target = Game.getObjectById(job.targetId);
    if (!target) {
      creep.memory.qJobId = creep.memory.qJobTargetId = creep.memory.qJobType = creep.memory.qFlagName = creep.memory.qJobKey = null;
      return;
    }

    var carry = (creep.store.getUsedCapacity(RESOURCE_ENERGY)|0);

    // need energy first
    if (carry <= 0) {
      var pick = chooseSupportPickup(creep, rc);
      if (!pick) return;
      var dp = creep.pos.getRangeTo(pick);
      if (dp >= 2) { if (dp === 2) pibSet(creep, (pick.amount!=null)?'pickup':'withdraw', pick.id, target.id); go(creep, pick, 1, 20); return; }
      var rcIn = (pick.amount!=null) ? creep.pickup(pick) : creep.withdraw(pick, RESOURCE_ENERGY);
      if (rcIn === ERR_NOT_IN_RANGE) { go(creep, pick); return; }
      if (rcIn === OK) { if (target) go(creep, target, 1, 10); return; }
      return;
    }

    // deliver
    var d = creep.pos.getRangeTo(target);
    if (d >= 2) { if (d === 2) pibSet(creep, 'transfer', target.id, null); go(creep, target, 1, 20); return; }

    // record "before" correctly to avoid ReferenceError
    var before = (creep.store.getUsedCapacity(RESOURCE_ENERGY)|0);
    var tr = creep.transfer(target, RESOURCE_ENERGY);
    if (tr === ERR_NOT_IN_RANGE) { go(creep, target, 1, 20); return; }

    if (tr === OK) {
      var after = (creep.store.getUsedCapacity(RESOURCE_ENERGY)|0);
      var delivered = Math.max(0, before - after);

      // sync with queue accounting
      if (delivered > 0) reportDelivery(creep, room, delivered);

      // if target now full (or has no store for some reason), hard remove by key
      var fullNow = (target.store && target.store.getFreeCapacity(RESOURCE_ENERGY) === 0);
      if (fullNow) {
        var key = creep.memory.qJobKey;
        if (key) _hardRemoveJobByKey(room, key);
        // also remove via flag name in case mapping already gone
        var flagName = creep.memory.qFlagName;
        if (flagName && Game.flags[flagName]) Game.flags[flagName].remove();

        creep.memory.qJobId = creep.memory.qJobTargetId = creep.memory.qJobType = creep.memory.qFlagName = creep.memory.qJobKey = null;
        creep.say('✅ done');
      }

      // chain toward next pickup if still holding some
      if ((creep.store.getUsedCapacity(RESOURCE_ENERGY)|0) > 0) {
        var nextPick = rc.storage || (rc.sideContainers && rc.sideContainers.length ? _nearest(creep.pos, rc.sideContainers) : null);
        if (nextPick) go(creep, (nextPick.pos||nextPick), 1, 10);
      }
      return;
    }

    if (tr === ERR_FULL || tr === ERR_INVALID_TARGET) {
      // give up gracefully
      var key2 = creep.memory.qJobKey;
      if (key2) _hardRemoveJobByKey(room, key2);
      creep.memory.qJobId = creep.memory.qJobTargetId = creep.memory.qJobType = creep.memory.qFlagName = creep.memory.qJobKey = null;
    }
  },

  // Courier fallback: gather → sink (storage/terminal)
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
    creep.transfer(sink, RESOURCE_ENERGY);
  }
};

module.exports = TaskQueen;
