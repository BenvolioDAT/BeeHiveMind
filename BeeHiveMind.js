'use strict';

/**
 * What changed & why:
 * - Reworked the orchestrator around a SENSE → DECIDE → ACT → MOVE pipeline to reduce per-tick thrash.
 * - Centralized global caches on global.__BHM with TTL helpers so sensors run once per tick.
 * - Added plumbing for Logistics and Movement managers plus persistent task scaffolding.
 * - Preserved the existing spawn-queue policy while staging decisions ahead of actions for clarity.
 *
 * Phases:
 *   SENSE  → build room/empire snapshots, prep selectors, reset movement.
 *   DECIDE → derive quotas, planner cadences, logistics intents.
 *   ACT    → run planners/roles/spawns/trade while queuing actions & movement.
 *   MOVE   → resolve Movement.Manager intents last for deterministic traffic.
 */

// ----------------------------- Dependencies -----------------------------
var CoreLogger = require('core.logger');
var LOG_LEVEL = CoreLogger.LOG_LEVEL;
var hiveLog = CoreLogger.createLogger('HiveMind', LOG_LEVEL.BASIC);

var BeeVisualsSpawnPanel = require('BeeVisuals.SpawnPanel');
var spawnLogic = require('spawn.logic');
var roleWorker_Bee = require('role.Worker_Bee');
var roleExpandClaimer = require('role.ExpandClaimer');
var RoomPlanner = require('Planner.Room');
var RoadPlanner = require('Planner.Road');
var TradeEnergy = require('Trade.Energy');
var TaskLuna = require('Task.Luna');
var BeeSelectors = require('BeeSelectors');
var MovementManager = require('Movement.Manager');
var LogisticsManager = require('Logistics.Manager');
var TaskExpandManager = require('Task.Expand.Manager');
var ConfigExpansion = require('Config.Expansion');
var ExpandSelector = require('Task.Expand.Selector');

// Map role -> run fn (extend as roles migrate).
var creepRoles = {
  Worker_Bee: roleWorker_Bee.run,
  claimer: roleExpandClaimer.run,
  ExpandClaimer: roleExpandClaimer.run,
  Claimer: roleExpandClaimer.run
};

// --------------------------- Tunables & Constants ------------------------
var DYING_SOON_TTL = 60;            // Skip creeps about to expire when counting quotas
var INVADER_LOCK_TTL = 1500;        // Mem lock suppression window for remotes

var QUEUE_RETRY_COOLDOWN = 5;       // ticks to wait before retrying a failed queue item
var QUEUE_HARD_LIMIT = 20;          // per-room queue sanity cap

var DEBUG_SPAWN_QUEUE = true;
var DBG_EVERY = 5;

var ROLE_PRIORITY = {
  baseharvest: 100,
  courier:      95,
  queen:        90,
  upgrader:     80,
  builder:      75,
  luna:         70,
  repair:       60,
  Claimer:      55,
  ExpandClaimer: 55,
  scout:        40,
  Trucker:      35,
  Dismantler:   30,
  CombatArcher: 25,
  CombatMelee:  25,
  CombatMedic:  25
};

var ROLE_MIN_ENERGY = {
  baseharvest: 200,
  courier:     150,
  queen:       200,
  upgrader:    200,
  builder:     200,
  luna:        250,
  repair:      200,
  Claimer:     650,
  ExpandClaimer: 650,
  scout:       50,
  Trucker:     200,
  Dismantler:  150,
  CombatArcher:200,
  CombatMelee: 200,
  CombatMedic: 200
};

// --------------------------- Global Tick Cache ---------------------------
if (!global.__BHM) global.__BHM = {};
if (!global.__BHM.caches) global.__BHM.caches = {};
if (!global.__BHM.spawnIntentSequence) global.__BHM.spawnIntentSequence = 0;

function resetTickCacheIfNeeded() {
  if (global.__BHM.tick !== Game.time) {
    global.__BHM.tick = Game.time;
    global.__BHM.caches = {};
  }
}

/**
 * Cache helper with TTL (0 => recompute every tick, >0 => expireTick = now + ttl).
 * The compute function should be pure and cheap to re-run.
 */
function cacheValue(key, ttl, compute) {
  resetTickCacheIfNeeded();
  var store = global.__BHM.caches;
  var entry = store[key];
  var now = Game.time;
  if (entry && entry.expireTick >= now) {
    return entry.value;
  }
  var value = compute();
  var expire = (ttl > 0) ? (now + ttl) : now;
  store[key] = { value: value, expireTick: expire };
  return value;
}

global.__BHM.getCached = cacheValue;

function minEnergyFor(role) {
  if (spawnLogic && typeof spawnLogic.minEnergyFor === 'function') {
    var v = spawnLogic.minEnergyFor(role);
    if (typeof v === 'number') return v;
  }
  return ROLE_MIN_ENERGY[role] || 200;
}

// ------------------------------ Debug utils ------------------------------
function tickEvery(n) { return Game.time % n === 0; }
function dlog() {
  if (!DEBUG_SPAWN_QUEUE) return;
  try { hiveLog.debug.apply(hiveLog, arguments); } catch (e) {}
}
function fmt(room) { return room && room.name ? room.name : String(room); }
function energyStatus(room) {
  var a = room.energyAvailable | 0;
  var c = room.energyCapacityAvailable | 0;
  return a + '/' + c;
}

// ------------------------------ Spawn Queue ------------------------------
function ensureRoomQueue(roomName) {
  if (!Memory.rooms) Memory.rooms = {};
  if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
  if (!Memory.rooms[roomName].spawnQueue) Memory.rooms[roomName].spawnQueue = [];
  return Memory.rooms[roomName].spawnQueue;
}
function queuedCount(roomName, role) {
  var q = ensureRoomQueue(roomName);
  var n = 0;
  for (var i = 0; i < q.length; i++) {
    if (q[i] && q[i].role === role) n++;
  }
  return n;
}
function enqueue(roomName, role, opts) {
  var q = ensureRoomQueue(roomName);
  if (q.length >= QUEUE_HARD_LIMIT) {
    dlog('🐝 [Queue]', roomName, 'queue full (', q.length, '/', QUEUE_HARD_LIMIT, '), skip enqueue of', role);
    return false;
  }
  var item = {
    role: role,
    home: roomName,
    created: Game.time,
    priority: ROLE_PRIORITY[role] || 0,
    retryAt: 0
  };
  if (opts) {
    for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) item[k] = opts[k];
  }
  q.push(item);
  dlog('➕ [Queue]', roomName, 'enqueued', role, '(prio', item.priority + ')');
  return true;
}
function pruneOverfilledQueue(roomName, quotas, C) {
  var q = ensureRoomQueue(roomName);
  var before = q.length;
  q.sort(function (a, b) {
    var prio = (b.priority - a.priority);
    if (prio !== 0) return prio;
    var aOrder = (typeof a.intentOrder === 'number') ? a.intentOrder : a.created;
    var bOrder = (typeof b.intentOrder === 'number') ? b.intentOrder : b.created;
    return aOrder - bOrder;
  });
  var remaining = {};
  for (var role in quotas) {
    if (!Object.prototype.hasOwnProperty.call(quotas, role)) continue;
    var active = (role === 'luna')
      ? ((C.lunaCountsByHome && C.lunaCountsByHome[roomName]) | 0)
      : ((C.roleCounts[role]) | 0);
    remaining[role] = Math.max(0, (quotas[role] | 0) - active);
  }
  var kept = [];
  var used = {};
  for (var i = 0; i < q.length; i++) {
    var it = q[i];
    if (!it) continue;
    var left = remaining[it.role] | 0;
    var usedSoFar = used[it.role] | 0;
    if (usedSoFar < left) {
      kept.push(it);
      used[it.role] = usedSoFar + 1;
    }
  }
  Memory.rooms[roomName].spawnQueue = kept;
  var dropped = before - kept.length;
  if (dropped > 0 || tickEvery(DBG_EVERY)) {
    dlog('🧹 [Queue]', roomName, 'prune:',
      'before=', before, 'kept=', kept.length, 'dropped=', dropped,
      'remaining=', JSON.stringify(remaining));
  }
}

function getBuilderNeed(C, room) {
  if (!room) return 0;
  var local = C.roomSiteCounts[room.name] || 0;
  var remote = 0;
  var remotes = C.remotesByHome[room.name] || [];
  for (var i = 0; i < remotes.length; i++) remote += (C.roomSiteCounts[remotes[i]] || 0);
  var need = (local + remote) > 0 ? 1 : 0;
  if (tickEvery(DBG_EVERY)) dlog('🧱 [Signal] builderNeed', fmt(room), 'local=', local, 'remote=', remote, '->', need);
  return need;
}
// Determine additional quota allowances for active expansions so the per-room queue
// does not prune claimer/builder/hauler intents published by Task.Expand.Manager.
function getExpansionQuotaBoost(room) {
  if (!room || typeof Memory === 'undefined') return null;
  if (!Memory.__BHM || !Memory.__BHM.expand) return null;
  var state = Memory.__BHM.expand;
  if (!state || !state.target) return null;
  var mainRoom = state.mainRoom || null;
  if (!mainRoom && ConfigExpansion && typeof ConfigExpansion.MAIN_ROOM_SELECTOR === 'function') {
    try {
      mainRoom = ConfigExpansion.MAIN_ROOM_SELECTOR();
    } catch (selectorErr) {
      mainRoom = null;
    }
  }
  if (!mainRoom || mainRoom !== room.name) return null;
  var phase = state.phase || 'idle';
  var boost = { expandClaimer: 0, builder: 0, courier: 0 };
  if (phase === 'claiming') {
    boost.expandClaimer = 1;
  } else if (phase === 'bootstrapping') {
    boost.builder = 2;
    boost.courier = 1;
  }
  if (!boost.expandClaimer && !boost.builder && !boost.courier) return null;
  return boost;
}
function determineLunaQuota(C, room) {
  if (!room) return 0;
  var remotes = C.remotesByHome[room.name] || [];
  if (!remotes.length) return 0;
  var remoteSet = {};
  for (var i = 0; i < remotes.length; i++) remoteSet[remotes[i]] = true;
  var roomsMem = Memory.rooms || {};
  var perSource = (TaskLuna && TaskLuna.MAX_LUNA_PER_SOURCE) || 1;
  var totalSources = 0;
  for (var r = 0; r < remotes.length; r++) {
    var remoteName = remotes[r];
    var mem = roomsMem[remoteName] || {};
    if (mem.hostile) continue;
    if (mem._invaderLock && mem._invaderLock.locked) {
      var lockTick = (typeof mem._invaderLock.t === 'number') ? mem._invaderLock.t : null;
      if (lockTick == null || (Game.time - lockTick) <= INVADER_LOCK_TTL) continue;
    }
    var srcCount = 0;
    var live = Game.rooms[remoteName];
    if (live) {
      var found = live.find(FIND_SOURCES);
      srcCount = found ? found.length : 0;
    }
    if (srcCount === 0 && mem.sources) {
      for (var sid in mem.sources) if (Object.prototype.hasOwnProperty.call(mem.sources, sid)) srcCount++;
    }
    if (srcCount === 0 && mem.intel && typeof mem.intel.sources === 'number') {
      srcCount = mem.intel.sources | 0;
    }
    totalSources += srcCount;
  }
  if (totalSources <= 0 && remotes.length > 0) totalSources = remotes.length;
  var active = 0;
  var assignments = Memory.remoteAssignments || {};
  for (var aid in assignments) {
    if (!Object.prototype.hasOwnProperty.call(assignments, aid)) continue;
    var entry = assignments[aid];
    if (!entry) continue;
    var rName = entry.roomName || entry.room;
    if (!rName || !remoteSet[rName]) continue;
    var count = entry.count || 0;
    if (!count && entry.owner) count = 1;
    if (count > 0) active += count;
  }
  var desired = Math.max(active, totalSources * perSource);
  if (tickEvery(DBG_EVERY)) dlog('🌙 [Signal] lunaQuota', fmt(room), 'remotes=', remotes.length, 'sources=', totalSources, 'active=', active, '->', desired);
  return desired;
}
function computeRoomQuotas(C, room) {
  var quotas = {
    baseharvest:  2,
    courier:      1,
    queen:        1,
    upgrader:     2,
    builder:      getBuilderNeed(C, room),
    scout:        1,
    luna:         0,
    repair:       0,
    CombatArcher: 0,
    CombatMelee:  0,
    CombatMedic:  0,
    Dismantler:   0,
    Trucker:      0,
    Claimer:      0,
    ExpandClaimer: 0
  };
  // Expansion manager publishes spawn intents with canonical role names; bump
  // quotas here so queue pruning keeps those items alive until spawns fire.
  var expansionBoost = getExpansionQuotaBoost(room);
  if (expansionBoost) {
    var claimerBoost = expansionBoost.expandClaimer || expansionBoost.ExpandClaimer || expansionBoost.claimer || 0;
    if (claimerBoost > 0) {
      if ((quotas.ExpandClaimer | 0) < claimerBoost) quotas.ExpandClaimer = claimerBoost;
    }
    if (expansionBoost.builder > 0) quotas.builder = (quotas.builder | 0) + expansionBoost.builder;
    if (expansionBoost.courier > 0) quotas.courier = (quotas.courier | 0) + expansionBoost.courier;
    if (tickEvery(DBG_EVERY)) {
      dlog('🎯 [QuotasExpand]', fmt(room), JSON.stringify(expansionBoost));
    }
  }
  if (tickEvery(DBG_EVERY)) dlog('🎯 [Quotas]', fmt(room), JSON.stringify(quotas));
  return quotas;
}
function fillQueueForRoom(C, room) {
  var quotas = computeRoomQuotas(C, room);
  var roomName = room.name;
  pruneOverfilledQueue(roomName, quotas, C);
  for (var role in quotas) {
    if (!Object.prototype.hasOwnProperty.call(quotas, role)) continue;
    var limit = quotas[role] | 0;
    var active = (role === 'luna')
      ? ((C.lunaCountsByHome && C.lunaCountsByHome[roomName]) | 0)
      : ((C.roleCounts[role]) | 0);
    var queued = queuedCount(roomName, role);
    var deficit = Math.max(0, limit - active - queued);
    if (deficit > 0 && tickEvery(DBG_EVERY)) {
      dlog('📥 [Queue]', roomName, 'role=', role, 'limit=', limit, 'active=', active, 'queued=', queued, 'deficit=', deficit);
    }
    for (var i = 0; i < deficit; i++) enqueue(roomName, role);
  }
}
function spawnFromPrimaryQueue(spawner) {
  if (!spawner) return false;
  var room = spawner.room;
  var roomName = room.name;
  var q = ensureRoomQueue(roomName);
  if (!q.length) {
    if (tickEvery(DBG_EVERY)) dlog('🕳️ [Queue]', roomName, 'empty (energy', energyStatus(room) + ')');
    return false;
  }
  q.sort(function (a, b) {
    var prio = (b.priority - a.priority);
    if (prio !== 0) return prio;
    var aOrder = (typeof a.intentOrder === 'number') ? a.intentOrder : a.created;
    var bOrder = (typeof b.intentOrder === 'number') ? b.intentOrder : b.created;
    return aOrder - bOrder;
  });
  var headPriority = q[0].priority;
  var headRole = q[0].role;
  var needed = energyNeededForQueueItem(q[0]);
  if ((room.energyAvailable | 0) < needed) {
    if (tickEvery(DBG_EVERY)) dlog('⛽ [QueueHold]', roomName, 'prio', headPriority, 'role', headRole,
                                   'need', needed, 'have', room.energyAvailable);
    return false;
  }
  var pickIndex = -1;
  for (var i = 0; i < q.length; i++) {
    var it = q[i];
    if (!it) continue;
    if (it.priority !== headPriority) break;
    if (it.retryAt && Game.time < it.retryAt) continue;
    pickIndex = i;
    break;
  }
  if (pickIndex === -1) {
    if (tickEvery(DBG_EVERY)) dlog('⏸️ [Queue]', roomName, 'head priority cooling down');
    return false;
  }
  var item = q[pickIndex];
  var age = Game.time - item.created;
  if (typeof item.intentOrder === 'number') age = Math.max(0, Game.time - item.created);
  dlog('🎬 [SpawnTry]', roomName, 'role=', item.role, 'prio=', item.priority,
       'age=', age, 'energy=', energyStatus(room));
  var spawnResource = null;
  if (spawnLogic && typeof spawnLogic.Calculate_Spawn_Resource === 'function') {
    spawnResource = spawnLogic.Calculate_Spawn_Resource(spawner);
  }
  var ok = false;
  if (item.intentSpec && spawnLogic && typeof spawnLogic.Spawn_From_Intent === 'function') {
    ok = spawnLogic.Spawn_From_Intent(spawner, item.intentSpec, spawnResource);
  } else if (spawnLogic && typeof spawnLogic.Spawn_Worker_Bee === 'function') {
    ok = spawnLogic.Spawn_Worker_Bee(spawner, item.role, spawnResource, item);
  }
  if (ok) {
    dlog('✅ [SpawnOK]', roomName, 'spawned', item.role, 'at', spawner.name);
    q.splice(pickIndex, 1);
    return true;
  }
  item.retryAt = Game.time + QUEUE_RETRY_COOLDOWN;
  dlog('⏳ [SpawnWait]', roomName, item.role, 'backoff to', item.retryAt, '(energy', energyStatus(room) + ')');
  return false;
}

function dequeueAndSpawn(spawner) {
  if (!spawner || spawner.spawning) return false;
  var handled = spawnFromPrimaryQueue(spawner);
  if (handled) return true;
  if (spawnLogic && typeof spawnLogic.Consume_Spawn_Intents === 'function') {
    return spawnLogic.Consume_Spawn_Intents(spawner);
  }
  return false;
}

// ------------------------------ Sensors ---------------------------------
function getOwnedRooms() {
  return cacheValue('ownedRooms', 0, function () {
    var result = [];
    for (var name in Game.rooms) {
      if (!Object.prototype.hasOwnProperty.call(Game.rooms, name)) continue;
      var room = Game.rooms[name];
      if (room && room.controller && room.controller.my) result.push(room);
    }
    return result;
  });
}
function indexByName(rooms) {
  var map = {};
  for (var i = 0; i < rooms.length; i++) map[rooms[i].name] = rooms[i];
  return map;
}
function getAllSpawns() {
  return cacheValue('spawns', 0, function () {
    var out = [];
    for (var name in Game.spawns) if (Object.prototype.hasOwnProperty.call(Game.spawns, name)) out.push(Game.spawns[name]);
    return out;
  });
}
function buildCreepAndRoleCounts() {
  return cacheValue('creepScan', 0, function () {
    var creeps = [];
    var roleCounts = {};
    var lunaCountsByHome = {};
    for (var name in Game.creeps) {
      if (!Object.prototype.hasOwnProperty.call(Game.creeps, name)) continue;
      var c = Game.creeps[name];
      creeps.push(c);
      var ttl = c.ticksToLive;
      if (typeof ttl === 'number' && ttl <= DYING_SOON_TTL) continue;
      var task = c.memory && c.memory.task;
      if (task === 'remoteharvest' && c.memory) {
        task = 'luna';
        c.memory.task = 'luna';
      }
      if (!task) continue;
      roleCounts[task] = (roleCounts[task] || 0) + 1;
      if (task === 'luna') {
        var home = (c.memory && c.memory.home) || null;
        if (!home && c.memory && c.memory._home) home = c.memory._home;
        if (!home && c.room) home = c.room.name;
        if (home) lunaCountsByHome[home] = (lunaCountsByHome[home] || 0) + 1;
      }
    }
    return { creeps: creeps, roleCounts: roleCounts, lunaCountsByHome: lunaCountsByHome };
  });
}
function computeConstructionSiteCounts() {
  return cacheValue('constructionSites', 0, function () {
    var byRoom = {};
    var total = 0;
    for (var id in Game.constructionSites) {
      if (!Object.prototype.hasOwnProperty.call(Game.constructionSites, id)) continue;
      var site = Game.constructionSites[id];
      if (!site || !site.my) continue;
      total += 1;
      var rn = site.pos && site.pos.roomName;
      if (rn) byRoom[rn] = (byRoom[rn] || 0) + 1;
    }
    return { byRoom: byRoom, total: total };
  });
}
function computeRemotesByHome(ownedRooms) {
  return cacheValue('remotesByHome', 5, function () {
    var out = {};
    var hasHelper = RoadPlanner && typeof RoadPlanner.getActiveRemoteRooms === 'function';
    if (!hasHelper) return out;
    for (var i = 0; i < ownedRooms.length; i++) {
      var home = ownedRooms[i];
      out[home.name] = RoadPlanner.getActiveRemoteRooms(home) || [];
    }
    return out;
  });
}

// ------------------------------ Main Module ------------------------------
var BeeHiveMind = {
  sense: function () {
    BeeHiveMind.initializeMemory();
    resetTickCacheIfNeeded();
    var context = {};
    context.tick = Game.time;
    context.roomsOwned = getOwnedRooms();
    context.roomsMap = indexByName(context.roomsOwned);
    context.roomSnapshots = {};
    for (var rs = 0; rs < context.roomsOwned.length; rs++) {
      var senseRoom = context.roomsOwned[rs];
      context.roomSnapshots[senseRoom.name] = BeeSelectors.prepareRoomSnapshot(senseRoom);
    }
    context.spawns = getAllSpawns();
    var creepScan = buildCreepAndRoleCounts();
    context.creeps = creepScan.creeps;
    context.roleCounts = creepScan.roleCounts;
    context.lunaCountsByHome = creepScan.lunaCountsByHome;
    var sites = computeConstructionSiteCounts();
    context.roomSiteCounts = sites.byRoom;
    context.totalSiteCount = sites.total;
    context.remotesByHome = computeRemotesByHome(context.roomsOwned);
    context.logistics = LogisticsManager.beginTick(context);
    return context;
  },

  decide: function (context) {
    context.roomPlans = {};
    context.spawnDecisions = [];
    var i;
    for (i = 0; i < context.roomsOwned.length; i++) {
      var room = context.roomsOwned[i];
      context.roomPlans[room.name] = computeRoomQuotas(context, room);
      context.spawnDecisions.push({ room: room, quotas: context.roomPlans[room.name] });
    }
    context.logisticsIntents = LogisticsManager.plan(context);
  },

  act: function (context) {
    if (BeeVisualsSpawnPanel && typeof BeeVisualsSpawnPanel.drawVisuals === 'function') {
      BeeVisualsSpawnPanel.drawVisuals();
    }
    BeeHiveMind.runPlanners(context);
    if (TaskExpandManager && typeof TaskExpandManager.run === 'function') {
      TaskExpandManager.run();
    }
    BeeHiveMind.mergeSpawnIntents(context);
    BeeHiveMind.runCreeps(context);
    BeeHiveMind.manageSpawns(context);
    BeeHiveMind.drawExpansionPanel(context);
    LogisticsManager.execute(context.logisticsIntents, context);
    if (TradeEnergy && typeof TradeEnergy.runAll === 'function') {
      TradeEnergy.runAll();
    }
  },

  move: function () {
    MovementManager.resolveAndMove();
  },

  run: function () {
    if (typeof global !== 'undefined') {
      if (!global.__BHM) global.__BHM = {};
      if (!Array.isArray(global.__BHM.spawnIntents)) global.__BHM.spawnIntents = [];
    }
    BeeHiveMind.prepareSpawnIntents();
    MovementManager.startTick();
    var context = BeeHiveMind.sense();
    BeeHiveMind.decide(context);
    BeeHiveMind.act(context);
    BeeHiveMind.move(context);
  },

  runPlanners: function (context) {
    for (var i = 0; i < context.roomsOwned.length; i++) {
      var room = context.roomsOwned[i];
      if (RoomPlanner && typeof RoomPlanner.ensureSites === 'function') RoomPlanner.ensureSites(room, context);
      if (RoadPlanner && typeof RoadPlanner.ensureRemoteRoads === 'function') RoadPlanner.ensureRemoteRoads(room, context);
    }
  },

  runCreeps: function (context) {
    try { require('Traveler'); } catch (travErr) {}
    for (var i = 0; i < context.creeps.length; i++) {
      var creep = context.creeps[i];
      BeeHiveMind.ensureTaskEnvelope(creep);
      var roleName = (creep.memory && creep.memory.role) || 'Worker_Bee';
      var roleFn = creepRoles[roleName];
      if (typeof roleFn !== 'function') roleFn = roleWorker_Bee.run;
      try { roleFn(creep, context); }
      catch (e) { hiveLog.debug('⚠️ Role error for', (creep.name || 'unknown'), '(' + roleName + '):', e); }
    }
  },

  ensureTaskEnvelope: function (creep) {
    if (!creep || !creep.memory) return;
    if (!creep.memory._task) creep.memory._task = null;
    if (!creep.memory.task) {
      var role = creep.memory.role;
      if (role === 'Queen') creep.memory.task = 'queen';
      else if (role === 'Scout') creep.memory.task = 'scout';
      else if (role === 'repair') creep.memory.task = 'repair';
    }
  },

  manageSpawns: function (context) {
    if (!context || !context.spawns || !context.roomsOwned) return;
    for (var i = 0; i < context.roomsOwned.length; i++) {
      var room = context.roomsOwned[i];
      if (!room.find(FIND_MY_SPAWNS).length) continue;
      ensureRoomQueue(room.name);
      fillQueueForRoom(context, room);
    }
    var squadHandled = false;
    for (var s = 0; s < context.spawns.length; s++) {
      var spawner = context.spawns[s];
      if (!spawner || spawner.spawning) continue;
      if (!squadHandled && spawnLogic && typeof spawnLogic.Spawn_Squad === 'function') {
        var didSquad = spawnLogic.Spawn_Squad(spawner, 'Alpha');
        if (didSquad) {
          squadHandled = true;
          dlog('🛡️ [Squad]', spawner.room.name, 'Alpha maintained at', spawner.name);
          continue;
        }
      }
      dequeueAndSpawn(spawner);
    }
  },

  initializeMemory: function () {
    if (!Memory.rooms) Memory.rooms = {};
    for (var roomName in Memory.rooms) {
      if (Object.prototype.hasOwnProperty.call(Memory.rooms, roomName)) {
        if (!Memory.rooms[roomName]) Memory.rooms[roomName] = {};
      }
    }
  },

  prepareSpawnIntents: function () {
    if (typeof global === 'undefined') return;
    if (!global.__BHM) global.__BHM = {};
    if (!global.__BHM.spawnIntents || global.__BHM.spawnIntentsTick !== Game.time) {
      global.__BHM.spawnIntents = [];
      global.__BHM.spawnIntentsTick = Game.time;
    }
  },

  drawExpansionPanel: function (context) {
    // Draw a compact summary so operators can see expansion status without opening Memory.
    var roomName = null;
    if (ConfigExpansion && typeof ConfigExpansion.MAIN_ROOM_SELECTOR === 'function') {
      try {
        roomName = ConfigExpansion.MAIN_ROOM_SELECTOR();
      } catch (selectorErr) {
        roomName = null;
      }
    }
    if (!roomName && context && context.roomsOwned && context.roomsOwned.length) {
      roomName = context.roomsOwned[0].name;
    }
    if (!roomName || !Game.rooms || !Game.rooms[roomName]) return;
    var panelRoom = Game.rooms[roomName];
    if (!panelRoom.visual) return;

    if (!Memory.__BHM) Memory.__BHM = {};
    if (!Memory.__BHM.expand) Memory.__BHM.expand = {};
    var state = Memory.__BHM.expand;
    var phase = state.phase || 'idle';
    var target = state.target || '-';

    var lines = [];
    lines.push('Expand: ' + phase);
    lines.push('Target: ' + target);

    if (phase === 'idle') {
      var blockers = null;
      if (ExpandSelector && typeof ExpandSelector.explainBlockers === 'function') {
        try {
          blockers = ExpandSelector.explainBlockers();
        } catch (blockErr) {
          blockers = ['error'];
        }
      }
      if (typeof blockers === 'string') blockers = [blockers];
      if (!Array.isArray(blockers)) blockers = [];
      if (blockers.length) {
        lines.push('Block: ' + blockers.join(', '));
      } else {
        lines.push('Block: none');
      }
    }

    var x = 1;
    var y = 1;
    var lineHeight = 0.8;
    var opts = { align: 'left', opacity: 0.85, font: 0.6, color: '#98fb98' };
    var i;
    for (i = 0; i < lines.length; i++) {
      panelRoom.visual.text(lines[i], x, y + (i * lineHeight), opts);
    }
  },

  mergeSpawnIntents: function (context) {
    if (typeof global === 'undefined' || !global.__BHM || !Array.isArray(global.__BHM.spawnIntents)) return;
    if (!global.__BHM.spawnIntents.length) return;
    var intents = global.__BHM.spawnIntents.slice();
    global.__BHM.spawnIntents.length = 0;
    var sequence = global.__BHM.spawnIntentSequence | 0;
    for (var i = 0; i < intents.length; i++) {
      var raw = intents[i];
      if (!raw) continue;
      var spec = cloneIntentSpec(raw);
      if (!spec) continue;
      sequence++;
      var home = resolveIntentHome(spec, context);
      if (!home) continue;
      var queue = ensureRoomQueue(home);
      if (!queue) continue;
      if (spec.intentId && queueHasIntent(queue, spec.intentId)) continue;
      if (!spec.home) spec.home = home;
      if (!spec.homeRoom) spec.homeRoom = home;
      var queueItem = buildQueueItemFromIntent(spec, sequence);
      if (!queueItem) continue;
      queue.push(queueItem);
      dlog('📨 [Intent]', home, 'queued intent for', queueItem.role, 'prio', queueItem.priority, 'target', queueItem.targetRoom || 'n/a');
    }
    global.__BHM.spawnIntentSequence = sequence;
  }
};

function cloneIntentSpec(spec) {
  try {
    if (typeof _ !== 'undefined' && _.cloneDeep) return _.cloneDeep(spec);
  } catch (cloneErr) {}
  try {
    return JSON.parse(JSON.stringify(spec));
  } catch (jsonErr) {}
  var copy = {};
  for (var key in spec) {
    if (!Object.prototype.hasOwnProperty.call(spec, key)) continue;
    copy[key] = spec[key];
  }
  return copy;
}

function resolveIntentHome(spec, context) {
  var home = null;
  if (spec.home) home = spec.home;
  if (!home && spec.homeRoom) home = spec.homeRoom;
  if (!home && spec.memory && spec.memory.homeRoom) home = spec.memory.homeRoom;
  if (!home && context && context.roomsOwned && context.roomsOwned.length) home = context.roomsOwned[0].name;
  if (!home && spec.memory && spec.memory.home) home = spec.memory.home;
  return home;
}

function queueHasIntent(queue, intentId) {
  if (!intentId) return false;
  for (var i = 0; i < queue.length; i++) {
    var entry = queue[i];
    if (!entry) continue;
    if (entry.intentId && entry.intentId === intentId) return true;
  }
  return false;
}

function buildQueueItemFromIntent(spec, sequence) {
  var role = canonicalIntentRole(spec.role || spec.task || null);
  if (!role) return null;
  var item = {
    role: role,
    task: spec.task || role,
    home: spec.home || spec.homeRoom || null,
    created: Game.time,
    intentOrder: sequence,
    priority: convertIntentPriority(spec.priority),
    retryAt: 0,
    intentId: spec.intentId || null,
    targetRoom: spec.targetRoom || spec.target || null,
    intentSpec: spec
  };
  if (spec.memory && spec.memory.targetRoom && !item.targetRoom) item.targetRoom = spec.memory.targetRoom;
  if (Array.isArray(spec.body)) item.body = spec.body.slice();
  return item;
}

function canonicalIntentRole(role) {
  if (!role) return null;
  if (typeof role !== 'string') return role;
  if (role === 'hauler') return 'courier';
  if (role === 'Hauler' || role === 'HAULER') return 'courier';
  if (role === 'ExpandClaimer') return 'ExpandClaimer';
  if (role === 'claimer') return 'ExpandClaimer';
  if (role === 'CLAIMER') return 'Claimer';
  if (role === 'claimerTask') return 'Claimer';
  if (role === 'builder') return 'builder';
  if (role === 'Builder') return 'builder';
  if (role === 'courier') return 'courier';
  if (role === 'Courier') return 'courier';
  if (role === 'Claimer' || role === 'builder' || role === 'courier') return role;
  return role;
}

function convertIntentPriority(raw) {
  var base = (typeof raw === 'number') ? raw : 50;
  if (base < 0) base = 0;
  if (base > 999) base = 999;
  return 1000 - base;
}

function energyNeededForQueueItem(item) {
  if (!item) return 0;
  if (Array.isArray(item.body) && item.body.length) return bodyCost(item.body);
  if (item.intentSpec && Array.isArray(item.intentSpec.body) && item.intentSpec.body.length) {
    return bodyCost(item.intentSpec.body);
  }
  var role = item.role || (item.intentSpec ? item.intentSpec.role : null);
  if (!role && item.intentSpec && item.intentSpec.task) role = item.intentSpec.task;
  role = canonicalIntentRole(role);
  return minEnergyFor(role);
}

function bodyCost(body) {
  if (!Array.isArray(body)) return 0;
  var total = 0;
  for (var i = 0; i < body.length; i++) {
    var part = body[i];
    total += BODYPART_COST[part] || 0;
  }
  return total;
}

module.exports = BeeHiveMind;
