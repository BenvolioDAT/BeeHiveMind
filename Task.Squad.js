var CoreConfig = require('core.config');
var CoreLogger = require('core.logger');
try { require('Traveler'); } catch (e2) { /* ensure Traveler is loaded once */ }

var squadLog = (CoreLogger && CoreLogger.createLogger)
  ? CoreLogger.createLogger('Task.Squad', (CoreLogger.LOG_LEVEL && CoreLogger.LOG_LEVEL.BASIC) || 1)
  : {
      info: function () {},
      debug: function () {},
      warn: function () {},
      error: function () {}
    };

var DEFAULT_CALLSIGNS = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot'];
var SQUAD_STATE_ASSEMBLING = 'assembling';
var SQUAD_STATE_ACTIVE = 'active';
var SQUAD_STATE_RETREATING = 'retreating';
var SQUAD_STATE_DISBANDED = 'disbanded';
var SQUAD_ASSEMBLING_TIMEOUT = 300;

var MEMBER_ROLE_KEYS = {
  CombatMelee: 'melee',
  CombatArcher: 'archer',
  CombatMedic: 'medic',
  Dismantler: 'dismantler'
};

function _combatSettings() {
  var settings = (CoreConfig && CoreConfig.settings) ? CoreConfig.settings : {};
  var combat = settings.Combat;
  if (!combat) {
    combat = settings.Combat = {};
  }
  if (!Array.isArray(combat.SQUAD_CALLSIGNS) || combat.SQUAD_CALLSIGNS.length === 0) {
    combat.SQUAD_CALLSIGNS = DEFAULT_CALLSIGNS.slice();
  }
  if (typeof combat.MAX_ACTIVE_SQUADS_GLOBAL !== 'number' || combat.MAX_ACTIVE_SQUADS_GLOBAL <= 0) {
    combat.MAX_ACTIVE_SQUADS_GLOBAL = Math.min(2, combat.SQUAD_CALLSIGNS.length);
  }
  if (typeof combat.MAX_ACTIVE_SQUADS_PER_COLONY !== 'number' || combat.MAX_ACTIVE_SQUADS_PER_COLONY <= 0) {
    combat.MAX_ACTIVE_SQUADS_PER_COLONY = 1;
  }
  return combat;
}

function _callsignList() {
  var combat = _combatSettings();
  if (!Array.isArray(combat.SQUAD_CALLSIGNS) || combat.SQUAD_CALLSIGNS.length === 0) {
    return DEFAULT_CALLSIGNS.slice();
  }
  return combat.SQUAD_CALLSIGNS.slice();
}

function _maxGlobalSquads() {
  var combat = _combatSettings();
  var list = _callsignList();
  var max = combat.MAX_ACTIVE_SQUADS_GLOBAL;
  if (typeof max !== 'number' || max <= 0) {
    max = list.length;
  }
  return Math.min(max, list.length);
}

function _maxSquadsPerColony() {
  var combat = _combatSettings();
  var per = combat.MAX_ACTIVE_SQUADS_PER_COLONY;
  if (typeof per !== 'number' || per <= 0) {
    per = 1;
  }
  return per;
}

function _flagNameForCallsign(callsign) {
  if (!callsign) return 'SquadAlpha';
  return 'Squad' + callsign;
}

function _friendlyList() {
  var settings = CoreConfig && CoreConfig.settings && CoreConfig.settings['Task.Squad'];
  var list = settings && settings.FRIENDLY_USERNAMES;
  return Array.isArray(list) ? list : [];
}

function isAlly(username) {
  if (!username) return false;
  var list = _friendlyList();
  for (var i = 0; i < list.length; i++) {
    if (list[i] === username) return true;
  }
  return false;
}

function friendlyUsernames() {
  var list = _friendlyList();
  return list.slice();
}

function noteFriendlyFireAvoid(creepName, username, context) {
  try {
    if (isAlly(username)) {
      if (squadLog && squadLog.info) {
        squadLog.info('Friendly-fire avoided: ' + username + ' ctx=' + context);
      }
      return true;
    }
  } catch (friendlyError) {}
  return false;
}

var _flagObjectHasOwn = Object.prototype.hasOwnProperty;
var _flagCachedUsername = null;

function _flagHasOwn(obj, key) {
  return !!obj && _flagObjectHasOwn.call(obj, key);
}

function _flagIsValidRoomName(name) {
  if (typeof name !== 'string') return false;
  return /^[WE]\d+[NS]\d+$/.test(name);
}

function _flagGetMyUsername() {
  if (_flagCachedUsername) return _flagCachedUsername;
  var name = null;
  var k;
  for (k in Game.spawns) {
    if (!_flagHasOwn(Game.spawns, k)) continue;
    var spawn = Game.spawns[k];
    if (spawn && spawn.owner && spawn.owner.username) {
      name = spawn.owner.username;
      break;
    }
  }
  if (!name) {
    for (k in Game.creeps) {
      if (!_flagHasOwn(Game.creeps, k)) continue;
      var creep = Game.creeps[k];
      if (creep && creep.owner && creep.owner.username) {
        name = creep.owner.username;
        break;
      }
    }
  }
  _flagCachedUsername = name || 'me';
  return _flagCachedUsername;
}

function _flagIsEnemyUsername(username) {
  if (!username) return false;
  if (isAlly(username)) return false;
  var mine = _flagGetMyUsername();
  if (mine && username === mine) return false;
  return true;
}

function _flagSafeLinearDistance(a, b, allowInexact) {
  if (!_flagIsValidRoomName(a) || !_flagIsValidRoomName(b)) return 9999;
  if (!Game || !Game.map || typeof Game.map.getRoomLinearDistance !== 'function') return 9999;
  return Game.map.getRoomLinearDistance(a, b, allowInexact);
}

function _flagRoomHashMod(roomName, mod) {
  if (mod <= 1) return 0;
  var h = 0;
  var i;
  for (i = 0; i < roomName.length; i++) {
    h = ((h * 31) + roomName.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % mod;
}

function _flagPassesModuloThrottle(roomName, tick, modulo, salt) {
  if (!modulo || modulo <= 1) return true;
  return ((tick + _flagRoomHashMod(roomName, salt || 0)) % modulo) === 0;
}

var SQUAD_FLAG_CFG = {
  scanModulo: 3,
  minThreatScore: 5,
  includeNonInvaderHostiles: false,
  score: {
    invaderCreep: 5,
    otherHostileCreep: 2,
    invaderCore: 15,
    hostileTower: 10,
    hostileSpawn: 6
  },
  dropGrace: 50,
  assignRecentWindow: 20,
  names: [],
  maxFlags: 0
};

function _refreshFlagConfigNames() {
  var names = [];
  var callsigns = _callsignList();
  for (var i = 0; i < callsigns.length; i++) {
    names.push(_flagNameForCallsign(callsigns[i]));
  }
  SQUAD_FLAG_CFG.names = names;
  SQUAD_FLAG_CFG.maxFlags = Math.min(_maxGlobalSquads(), names.length);
}

_refreshFlagConfigNames();

var SQUAD_REGISTRY_VERSION = 2;

function _createSquadRecord(id) {
  var now = Game.time || 0;
  return {
    callsign: id || 'Alpha',
    state: SQUAD_STATE_ASSEMBLING,
    colony: null,
    targetRoom: null,
    members: { melee: [], archer: [], medic: [], dismantler: [], other: [] },
    memberRecords: {},
    createdAt: now,
    lastActive: now,
    lastPlanTick: 0,
    flagName: null,
    spawnCooldownUntil: 0,
    desiredRoles: {},
    roleOrder: ['CombatMelee', 'CombatArcher', 'CombatMedic'],
    minReady: 1,
    targetId: null,
    targetAt: 0,
    anchor: null,
    anchorAt: 0,
    rally: null,
    lastSpawnTick: 0,
    lastSpawnRole: null,
    suppressed: false
  };
}

function _memberKeyForRole(role) {
  if (!role) return 'other';
  if (MEMBER_ROLE_KEYS[role]) return MEMBER_ROLE_KEYS[role];
  var lower = ('' + role).toLowerCase();
  if (lower.indexOf('melee') !== -1) return 'melee';
  if (lower.indexOf('archer') !== -1 || lower.indexOf('range') !== -1) return 'archer';
  if (lower.indexOf('medic') !== -1 || lower.indexOf('heal') !== -1) return 'medic';
  if (lower.indexOf('dismant') !== -1) return 'dismantler';
  return 'other';
}

function _ensureMemberBuckets(bucket) {
  if (!bucket.members || typeof bucket.members !== 'object') {
    bucket.members = { melee: [], archer: [], medic: [], dismantler: [], other: [] };
  }
  if (!bucket.members.melee) bucket.members.melee = [];
  if (!bucket.members.archer) bucket.members.archer = [];
  if (!bucket.members.medic) bucket.members.medic = [];
  if (!bucket.members.dismantler) bucket.members.dismantler = [];
  if (!bucket.members.other) bucket.members.other = [];
}

function _updateMemberAggregates(bucket) {
  _ensureMemberBuckets(bucket);
  var roster = bucket.memberRecords || {};
  var melee = [];
  var archer = [];
  var medic = [];
  var dismantler = [];
  var other = [];
  for (var name in roster) {
    if (!Object.prototype.hasOwnProperty.call(roster, name)) continue;
    var rec = roster[name];
    if (!rec) continue;
    var key = _memberKeyForRole(rec.role);
    if (key === 'melee') melee.push(name);
    else if (key === 'archer') archer.push(name);
    else if (key === 'medic') medic.push(name);
    else if (key === 'dismantler') dismantler.push(name);
    else other.push(name);
  }
  bucket.members.melee = melee;
  bucket.members.archer = archer;
  bucket.members.medic = medic;
  bucket.members.dismantler = dismantler;
  bucket.members.other = other;
}

function _normalizeSquadRecord(bucket, id) {
  if (!bucket || typeof bucket !== 'object') {
    bucket = _createSquadRecord(id);
  }
  if (!bucket.callsign) bucket.callsign = id || 'Alpha';
  if (!bucket.memberRecords || typeof bucket.memberRecords !== 'object') {
    bucket.memberRecords = {};
  }
  if (!bucket.desiredRoles || typeof bucket.desiredRoles !== 'object') {
    bucket.desiredRoles = {};
  }
  if (!Array.isArray(bucket.roleOrder) || !bucket.roleOrder.length) {
    bucket.roleOrder = ['CombatMelee', 'CombatArcher', 'CombatMedic'];
  }
  if (typeof bucket.minReady !== 'number' || bucket.minReady < 1) {
    bucket.minReady = 1;
  }
  if (!bucket.members || typeof bucket.members !== 'object') {
    bucket.members = { melee: [], archer: [], medic: [], dismantler: [], other: [] };
  } else {
    _ensureMemberBuckets(bucket);
  }
  if (!bucket.state) bucket.state = SQUAD_STATE_ASSEMBLING;
  if (typeof bucket.createdAt !== 'number') bucket.createdAt = Game.time || 0;
  if (typeof bucket.lastActive !== 'number') bucket.lastActive = Game.time || bucket.createdAt;
  if (typeof bucket.lastPlanTick !== 'number') bucket.lastPlanTick = 0;
  if (typeof bucket.spawnCooldownUntil !== 'number') bucket.spawnCooldownUntil = 0;
  if (typeof bucket.targetAt !== 'number') bucket.targetAt = 0;
  if (typeof bucket.anchorAt !== 'number') bucket.anchorAt = 0;
  _updateMemberAggregates(bucket);
  return bucket;
}

function _migrateSquadRegistry(registry) {
  for (var key in registry) {
    if (!Object.prototype.hasOwnProperty.call(registry, key)) continue;
    var entry = registry[key];
    if (!entry || typeof entry !== 'object') {
      registry[key] = _createSquadRecord(key);
      continue;
    }
    if (entry.members && !entry.memberRecords && !Array.isArray(entry.members)) {
      entry.memberRecords = entry.members;
      entry.members = null;
    }
    if (!entry.memberRecords || typeof entry.memberRecords !== 'object') {
      entry.memberRecords = {};
    }
    _normalizeSquadRecord(entry, key);
  }
}

function _ensureSquadRegistry() {
  if (!Memory.squads || typeof Memory.squads !== 'object') {
    Memory.squads = {};
  }
  var registry = Memory.squads;
  if (!Memory.__squadRegistryVersion || Memory.__squadRegistryVersion < SQUAD_REGISTRY_VERSION) {
    _migrateSquadRegistry(registry);
    Memory.__squadRegistryVersion = SQUAD_REGISTRY_VERSION;
  }
  return registry;
}

function _trimMemberRecords(bucket) {
  var roster = bucket.memberRecords || {};
  var changed = false;
  for (var name in roster) {
    if (!Object.prototype.hasOwnProperty.call(roster, name)) continue;
    if (!Game.creeps[name]) {
      delete roster[name];
      changed = true;
    }
  }
  if (changed) {
    _updateMemberAggregates(bucket);
  }
  return changed;
}

function _computeSquadSnapshot(registry) {
  registry = registry || _ensureSquadRegistry();
  var callsigns = _callsignList();
  var activeCount = 0;
  var countsByColony = {};
  var byTarget = {};
  var freeCallsigns = [];
  for (var i = 0; i < callsigns.length; i++) {
    var call = callsigns[i];
    var record = registry[call];
    if (!record) {
      freeCallsigns.push(call);
      continue;
    }
    record = _normalizeSquadRecord(record, call);
    var state = record.state || SQUAD_STATE_ASSEMBLING;
    if (state === SQUAD_STATE_DISBANDED) {
      freeCallsigns.push(call);
      continue;
    }
    if (state === SQUAD_STATE_ASSEMBLING || state === SQUAD_STATE_ACTIVE || state === SQUAD_STATE_RETREATING) {
      activeCount += 1;
      if (record.colony) {
        countsByColony[record.colony] = (countsByColony[record.colony] || 0) + 1;
      }
      if (record.targetRoom) {
        byTarget[record.targetRoom] = call;
      }
    } else {
      freeCallsigns.push(call);
    }
  }
  return {
    registry: registry,
    callsigns: callsigns,
    maxGlobal: _maxGlobalSquads(),
    maxPerColony: _maxSquadsPerColony(),
    activeCount: activeCount,
    countsByColony: countsByColony,
    byTarget: byTarget,
    freeCallsigns: freeCallsigns
  };
}

function _hasFlagForCallsign(callsign) {
  var mem = _flagMem();
  for (var name in mem.bindings) {
    if (!Object.prototype.hasOwnProperty.call(mem.bindings, name)) continue;
    if (_flagDeriveSquadId(name) === callsign) {
      if (Game.flags[name]) return true;
    }
  }
  if (Game.flags) {
    for (var fname in Game.flags) {
      if (!Object.prototype.hasOwnProperty.call(Game.flags, fname)) continue;
      if (_flagDeriveSquadId(fname) === callsign) {
        return true;
      }
    }
  }
  return false;
}

function _reserveCallsign(targetRoom, colony, options) {
  var registry = _ensureSquadRegistry();
  var snapshot = _computeSquadSnapshot(registry);
  if (targetRoom && snapshot.byTarget[targetRoom]) {
    var existing = snapshot.byTarget[targetRoom];
    var record = registry[existing];
    record = _normalizeSquadRecord(record, existing);
    if (colony && !record.colony) record.colony = colony;
    if (options && options.flagName) record.flagName = options.flagName;
    return { callsign: existing, record: record, reused: true, snapshot: snapshot };
  }
  if (snapshot.activeCount >= snapshot.maxGlobal) {
    return null;
  }
  if (colony && snapshot.countsByColony[colony] >= snapshot.maxPerColony) {
    return null;
  }
  var free = snapshot.freeCallsigns || [];
  if (!free.length) {
    return null;
  }
  var call = free[0];
  var bucket = registry[call];
  if (!bucket) {
    bucket = _createSquadRecord(call);
    registry[call] = bucket;
  }
  bucket = _normalizeSquadRecord(bucket, call);
  bucket.state = SQUAD_STATE_ASSEMBLING;
  if (targetRoom) bucket.targetRoom = targetRoom;
  if (typeof bucket.targetAt !== 'number') bucket.targetAt = 0;
  if (targetRoom && (!bucket.targetAt || bucket.targetRoom !== targetRoom)) {
    bucket.targetAt = Game.time || 0;
  }
  if (colony) bucket.colony = colony;
  bucket.createdAt = bucket.createdAt || (Game.time || 0);
  bucket.lastActive = Game.time || bucket.lastActive || bucket.createdAt;
  if (options && options.flagName) {
    bucket.flagName = options.flagName;
  }
  bucket.suppressed = false;
  return { callsign: call, record: bucket, reused: false, snapshot: snapshot };
}

function _unlinkFlagBindings(callsign) {
  var mem = _flagMem();
  for (var name in mem.bindings) {
    if (!Object.prototype.hasOwnProperty.call(mem.bindings, name)) continue;
    if (_flagDeriveSquadId(name) === callsign) {
      delete mem.bindings[name];
      if (mem.manual && mem.manual[name]) {
        delete mem.manual[name];
      }
      _flagRemoveFlag(name);
    }
  }
}

function _releaseCallsign(callsign, options) {
  if (!callsign) return false;
  var registry = _ensureSquadRegistry();
  if (!registry[callsign]) {
    return false;
  }
  _unlinkFlagBindings(callsign);
  if (options && options.keepRecord) {
    var record = _normalizeSquadRecord(registry[callsign], callsign);
    record.state = SQUAD_STATE_DISBANDED;
    record.colony = null;
    record.targetRoom = null;
    record.flagName = null;
    record.memberRecords = {};
    _updateMemberAggregates(record);
    record.lastActive = Game.time || record.lastActive || 0;
    return true;
  }
  delete registry[callsign];
  return true;
}

function _noteSquadPlan(callsign, data) {
  if (!callsign) return;
  var registry = _ensureSquadRegistry();
  var record = registry[callsign];
  if (!record) {
    record = _createSquadRecord(callsign);
    registry[callsign] = record;
  }
  record = _normalizeSquadRecord(record, callsign);
  record.lastPlanTick = Game.time || 0;
  record.state = record.state === SQUAD_STATE_DISBANDED ? SQUAD_STATE_ASSEMBLING : record.state;
  if (data) {
    if (data.targetRoom) record.targetRoom = data.targetRoom;
    if (data.colony) record.colony = data.colony;
    if (data.flagName) record.flagName = data.flagName;
  }
  if (!record.createdAt) record.createdAt = Game.time || 0;
  if (!record.lastActive) record.lastActive = Game.time || record.createdAt;
}

function _noteSpawnResult(callsign, outcome, context) {
  if (!callsign) return;
  var registry = _ensureSquadRegistry();
  var record = registry[callsign];
  if (!record) return;
  record = _normalizeSquadRecord(record, callsign);
  if (context && context.role) {
    record.lastSpawnRole = context.role;
  }
  record.lastSpawnTick = Game.time || record.lastSpawnTick || 0;
  if (outcome === 'spawned') {
    record.state = SQUAD_STATE_ASSEMBLING;
    record.lastActive = Game.time || record.lastActive || record.createdAt;
  } else if (outcome === 'unaffordable') {
    record.unaffordableAt = Game.time || 0;
  } else if (outcome === 'failed') {
    record.failedAt = Game.time || 0;
  }
}

function _maintainSquadRegistry(options) {
  var registry = _ensureSquadRegistry();
  var now = Game.time || 0;
  var released = [];
  for (var key in registry) {
    if (!Object.prototype.hasOwnProperty.call(registry, key)) continue;
    var record = registry[key];
    record = _normalizeSquadRecord(record, key);
    _trimMemberRecords(record);
    var living = 0;
    var roster = record.memberRecords || {};
    for (var name in roster) {
      if (!Object.prototype.hasOwnProperty.call(roster, name)) continue;
      if (Game.creeps[name]) living += 1;
    }
    if (living > 0) {
      record.state = SQUAD_STATE_ACTIVE;
      record.lastActive = now;
    }
    var flagPresent = _hasFlagForCallsign(key);
    var assemblingTooLong = (record.state === SQUAD_STATE_ASSEMBLING && living === 0 && now - (record.lastPlanTick || record.createdAt || now) > SQUAD_ASSEMBLING_TIMEOUT);
    var staleNoFlag = (!flagPresent && living === 0 && (now - (record.lastActive || record.createdAt || now) > 100));
    if (assemblingTooLong || staleNoFlag) {
      _releaseCallsign(key, options && options.keepRecords ? { keepRecord: true } : null);
      if (!(options && options.keepRecords)) {
        delete registry[key];
      }
      released.push(key);
    }
  }
  return released;
}

function _flagMem() {
  if (!Memory.squadFlags) Memory.squadFlags = { rooms: {}, bindings: {}, manual: {} };
  if (!Memory.squadFlags.rooms) Memory.squadFlags.rooms = {};
  if (!Memory.squadFlags.bindings) Memory.squadFlags.bindings = {};
  if (!Memory.squadFlags.manual) Memory.squadFlags.manual = {};
  return Memory.squadFlags;
}

function _flagDebug(message) {
  if (!Memory || !Memory.DEBUG_SQUAD_SPAWN) return;
  if (squadLog && typeof squadLog.info === 'function') {
    squadLog.info(message);
  }
}

function _flagRoomsWithNonScoutCreeps() {
  var set = {};
  for (var cname in Game.creeps) {
    if (!_flagHasOwn(Game.creeps, cname)) continue;
    var c = Game.creeps[cname];
    if (!c || !c.my || !c.memory) continue;
    var tag = (c.memory.task || c.memory.role || '').toString().toLowerCase();
    if (tag === 'scout' || tag.indexOf('scout') === 0) continue;
    set[c.pos.roomName] = true;
  }
  if (Memory.attackTargets) {
    for (var tn in Memory.attackTargets) {
      if (!_flagHasOwn(Memory.attackTargets, tn)) continue;
      var target = Memory.attackTargets[tn];
      if (!target) continue;
      var roomName = target.roomName || tn;
      if (!_flagIsValidRoomName(roomName)) continue;
      var ownerName = null;
      if (typeof target.owner === 'string') ownerName = target.owner;
      else if (target.owner && typeof target.owner.username === 'string') ownerName = target.owner.username;
      if (ownerName && !_flagIsEnemyUsername(ownerName)) continue;
      set[roomName] = true;
    }
  }
  var out = [];
  for (var rn in set) {
    if (!_flagHasOwn(set, rn)) continue;
    out.push(rn);
  }
  return out;
}

function _flagScoreRoom(room) {
  if (!room) return { score: 0, pos: null, details: null };

  var cfg = SQUAD_FLAG_CFG;
  var s = 0;
  var pos = null;

  var hostiles = room.find(FIND_HOSTILE_CREEPS) || [];
  var i, invCount = 0, otherCount = 0;
  var hasRanged = false;
  var hasAttack = false;
  var hasHeal = false;

  for (i = 0; i < hostiles.length; i++) {
    var h = hostiles[i];
    var inv = (h.owner && h.owner.username === 'Invader');
    if (inv) invCount++;
    else if (cfg.includeNonInvaderHostiles) otherCount++;

    if (h.getActiveBodyparts) {
      if (h.getActiveBodyparts(RANGED_ATTACK) > 0) hasRanged = true;
      if (h.getActiveBodyparts(ATTACK) > 0 || h.getActiveBodyparts(WORK) > 0) hasAttack = true;
      if (h.getActiveBodyparts(HEAL) > 0) hasHeal = true;
    }
  }

  if (invCount > 0) {
    s += invCount * cfg.score.invaderCreep;
    if (!pos) {
      for (i = 0; i < hostiles.length; i++) {
        if (hostiles[i].owner && hostiles[i].owner.username === 'Invader') { pos = hostiles[i].pos; break; }
      }
    }
  }
  if (otherCount > 0) {
    s += otherCount * cfg.score.otherHostileCreep;
    if (!pos && hostiles.length) pos = hostiles[0].pos;
  }

  var structures = room.find(FIND_HOSTILE_STRUCTURES) || [];
  var hasHostileTower = false;
  var hasHostileSpawn = false;
  for (i = 0; i < structures.length; i++) {
    var st = structures[i];
    if (st.structureType === STRUCTURE_INVADER_CORE) {
      s += cfg.score.invaderCore;
      if (!pos) pos = st.pos;
      continue;
    }
    if (st.structureType === STRUCTURE_TOWER) {
      hasHostileTower = true;
      s += cfg.score.hostileTower;
      if (!pos) pos = st.pos;
    } else if (st.structureType === STRUCTURE_SPAWN) {
      hasHostileSpawn = true;
      s += cfg.score.hostileSpawn;
      if (!pos) pos = st.pos;
    }
  }

  if (!pos) pos = new RoomPosition(25, 25, room.name);
  return {
    score: s,
    pos: pos,
    details: {
      hasRanged: hasRanged,
      hasAttack: hasAttack,
      hasHeal: hasHeal,
      hasHostileTower: hasHostileTower,
      hasHostileSpawn: hasHostileSpawn,
      hostileCount: hostiles.length
    }
  };
}

function _flagEnsureFlagAt(name, pos) {
  var f = Game.flags[name];
  if (f) {
    if (f.pos.roomName === pos.roomName && f.pos.x === pos.x && f.pos.y === pos.y) return;
    try { f.remove(); } catch (flagRemoveError) {}
  }
  var rc = pos.roomName && Game.rooms[pos.roomName]
    ? Game.rooms[pos.roomName].createFlag(pos, name)
    : ERR_INVALID_TARGET;

  if (rc !== OK && Game.rooms[pos.roomName]) {
    var i, dx, dy, x, y;
    for (i = 1; i <= 2; i++) {
      for (dx = -i; dx <= i; dx++) {
        for (dy = -i; dy <= i; dy++) {
          if (Math.abs(dx) !== i && Math.abs(dy) !== i) continue;
          x = pos.x + dx; y = pos.y + dy;
          if (x < 1 || x > 48 || y < 1 || y > 48) continue;
          if (Game.rooms[pos.roomName].createFlag(x, y, name) === OK) return;
        }
      }
    }
  }
}

function _flagRemoveFlag(name) {
  var f = Game.flags[name];
  if (f) { try { f.remove(); } catch (flagDeleteError) {} }
}

function _flagDeriveSquadId(flagName) {
  if (!flagName) return 'Alpha';
  var base = flagName;
  if (base.indexOf('Squad_') === 0) base = base.substr(6);
  else if (base.indexOf('Squad') === 0) base = base.substr(5);
  if (!base) base = flagName;
  return base;
}

function _flagPositionFromRecord(rec, roomName) {
  if (rec && rec.lastPos && _flagIsValidRoomName(rec.lastPos.roomName)) {
    return new RoomPosition(rec.lastPos.x, rec.lastPos.y, rec.lastPos.roomName);
  }
  if (_flagIsValidRoomName(roomName)) {
    return new RoomPosition(25, 25, roomName);
  }
  return null;
}

function _flagPickHomeRoom(targetRoom, ownedRooms, currentHome) {
  if (currentHome && Game.rooms[currentHome] && Game.rooms[currentHome].controller && Game.rooms[currentHome].controller.my) {
    return currentHome;
  }
  if (!ownedRooms || !ownedRooms.length) return currentHome || null;
  var best = null;
  var bestDist = Infinity;
  for (var i = 0; i < ownedRooms.length; i++) {
    var room = ownedRooms[i];
    if (!room || !room.controller || !room.controller.my) continue;
    var dist = _flagSafeLinearDistance(room.name, targetRoom, true);
    if (dist < bestDist) {
      bestDist = dist;
      best = room.name;
    }
  }
  return best || currentHome || null;
}

function ensureSquadFlags(options) {
  var mem = _flagMem();
  var tick = Game.time | 0;
  var cfg = SQUAD_FLAG_CFG;
  var manual = mem.manual;

  _maintainSquadRegistry({ keepRecords: true });

  var snapshot = _computeSquadSnapshot();
  var capReached = snapshot.activeCount >= snapshot.maxGlobal;
  if (capReached) {
    mem.capSuppressedAt = tick;
  }

  var rooms = _flagRoomsWithNonScoutCreeps();
  for (var r = 0; r < rooms.length; r++) {
    var rn = rooms[r];
    var room = Game.rooms[rn];
    if (!room) continue;

    if (!_flagPassesModuloThrottle(rn, tick, cfg.scanModulo || 1, 4)) continue;

    var info = _flagScoreRoom(room);
    var rec = mem.rooms[rn] || (mem.rooms[rn] = { lastSeen: 0, lastThreatAt: 0, lastPos: null, lastScore: 0, lastDetails: null });

    rec.lastSeen = tick;
    rec.lastScore = info.score | 0;
    if (info.details) {
      rec.lastDetails = info.details;
    }
    if (info.score >= cfg.minThreatScore) {
      rec.lastThreatAt = tick;
      rec.lastPos = { x: info.pos.x, y: info.pos.y, roomName: info.pos.roomName };
    } else {
      if (!rec.lastPos) rec.lastPos = { x: 25, y: 25, roomName: rn };
    }
    mem.rooms[rn] = rec;
  }

  var boundNames = {};
  var nameIdx, fname, boundRoom;

  for (fname in Game.flags) {
    if (!_flagHasOwn(Game.flags, fname)) continue;
    if (cfg.names.indexOf(fname) === -1) continue;
    var flag = Game.flags[fname];
    if (!flag || !flag.pos || !flag.pos.roomName) continue;
    var currentBinding = mem.bindings[fname];
    if (!currentBinding) {
      mem.bindings[fname] = flag.pos.roomName;
      manual[fname] = true;
      _flagDebug('[TaskSquad] Manual bind: ' + fname + ' -> ' + flag.pos.roomName);
      var callManual = _flagDeriveSquadId(fname);
      var bucketManual = _ensureSquadBucket(callManual);
      bucketManual.flagName = fname;
      bucketManual.targetRoom = flag.pos.roomName;
      bucketManual.targetAt = tick;
      bucketManual.lastActive = tick;
    } else if (manual[fname] && currentBinding !== flag.pos.roomName) {
      mem.bindings[fname] = flag.pos.roomName;
      _flagDebug('[TaskSquad] Manual rebalance: ' + fname + ' -> ' + flag.pos.roomName);
      var manualCallsign = _flagDeriveSquadId(fname);
      var manualBucket = _ensureSquadBucket(manualCallsign);
      manualBucket.flagName = fname;
      manualBucket.targetRoom = flag.pos.roomName;
      manualBucket.targetAt = tick;
      manualBucket.lastActive = tick;
    }
  }

  for (nameIdx = 0; nameIdx < cfg.names.length; nameIdx++) {
    fname = cfg.names[nameIdx];
    boundRoom = mem.bindings[fname];

    if (!boundRoom) continue;

    boundNames[fname] = true;

    var rrec = mem.rooms[boundRoom];
    var keep = true;

    if (Game.rooms[boundRoom]) {
      var lastAt = rrec && rrec.lastThreatAt || 0;
      if ((tick - lastAt) > cfg.dropGrace) {
        _flagRemoveFlag(fname);
        delete mem.bindings[fname];
        if (manual && manual[fname]) delete manual[fname];
        _releaseCallsign(_flagDeriveSquadId(fname));
        keep = false;
      }
    }
    if (keep) {
      var pos = (rrec && rrec.lastPos)
        ? new RoomPosition(rrec.lastPos.x, rrec.lastPos.y, rrec.lastPos.roomName)
        : new RoomPosition(25, 25, boundRoom);
      _flagEnsureFlagAt(fname, pos);
      var call = _flagDeriveSquadId(fname);
      var bucket = _ensureSquadBucket(call);
      bucket.flagName = fname;
      bucket.targetRoom = boundRoom;
      bucket.targetAt = tick;
      bucket.lastActive = tick;
    }
  }

  var candidates = [];
  var now = tick;
  for (var rn in mem.rooms) {
    if (!_flagHasOwn(mem.rooms, rn)) continue;
    var rec2 = mem.rooms[rn];
    if (!rec2 || typeof rec2.lastThreatAt !== 'number') continue;
    if ((now - rec2.lastThreatAt) <= cfg.assignRecentWindow) {
      var already = false;
      for (var n2 in mem.bindings) {
        if (!_flagHasOwn(mem.bindings, n2)) continue;
        if (mem.bindings[n2] === rn) { already = true; break; }
      }
      if (!already) {
        candidates.push({ rn: rn, lastSeen: rec2.lastSeen | 0, lastThreatAt: rec2.lastThreatAt | 0 });
      }
    }
  }

  candidates.sort(function (a, b) {
    if (b.lastThreatAt !== a.lastThreatAt) return b.lastThreatAt - a.lastThreatAt;
    return b.lastSeen - a.lastSeen;
  });

  var maxN = Math.min(cfg.maxFlags, cfg.names.length);
  for (nameIdx = 0; nameIdx < maxN; nameIdx++) {
    fname = cfg.names[nameIdx];
    if (mem.bindings[fname]) {
      continue;
    }

    if (capReached) {
      break;
    }

    var pick = candidates.shift();
    if (!pick) break;

    mem.bindings[fname] = pick.rn;

    var rec3 = mem.rooms[pick.rn];
    var placePos = (rec3 && rec3.lastPos)
      ? new RoomPosition(rec3.lastPos.x, rec3.lastPos.y, rec3.lastPos.roomName)
      : new RoomPosition(25, 25, pick.rn);
    _flagEnsureFlagAt(fname, placePos);

    var callAssign = _flagDeriveSquadId(fname);
    var reserve = _reserveCallsign(pick.rn, null, { flagName: fname });
    if (!reserve) {
      mem.bindings[fname] = null;
      _flagRemoveFlag(fname);
      if (!mem.capLog || tick - (mem.capLog | 0) > 50) {
        mem.capLog = tick;
        if (squadLog && squadLog.info) {
          squadLog.info('[TaskSquad] CAP_REACHED - unable to allocate callsign for ' + pick.rn);
        }
      }
      capReached = true;
      break;
    }
    var assignedBucket = _ensureSquadBucket(callAssign);
    assignedBucket.flagName = fname;
    assignedBucket.targetRoom = pick.rn;
    assignedBucket.targetAt = tick;
    assignedBucket.lastActive = tick;
  }

  for (var fName in Game.flags) {
    if (!_flagHasOwn(Game.flags, fName)) continue;
    if (SQUAD_FLAG_CFG.names.indexOf(fName) === -1) continue;
    if (!mem.bindings[fName]) {
      _flagRemoveFlag(fName);
    }
  }

  for (fname in manual) {
    if (!_flagHasOwn(manual, fname)) continue;
    if (!manual[fname]) continue;
    if (!Game.flags[fname]) {
      delete manual[fname];
      delete mem.bindings[fname];
    }
  }

  for (var k in mem.rooms) {
    if (!_flagHasOwn(mem.rooms, k)) continue;
    if ((tick - (mem.rooms[k].lastSeen | 0)) > 20000) delete mem.rooms[k];
  }
}

function getActiveSquads(options) {
  var mem = _flagMem();
  var ownedRooms = (options && options.ownedRooms) || [];
  var out = [];

  for (var nameIdx = 0; nameIdx < SQUAD_FLAG_CFG.names.length; nameIdx++) {
    var fname = SQUAD_FLAG_CFG.names[nameIdx];
    var boundRoom = mem.bindings[fname];
    if (!boundRoom) continue;

    var squadId = _flagDeriveSquadId(fname);
    var bucket = _ensureSquadBucket(squadId);

    var rec = mem.rooms[boundRoom];
    var flag = Game.flags[fname];
    var rallyPos = flag ? flag.pos : _flagPositionFromRecord(rec, boundRoom);
    if (rallyPos) {
      bucket.rally = { x: rallyPos.x, y: rallyPos.y, roomName: rallyPos.roomName };
    }
    bucket.flagName = fname;
    bucket.targetRoom = boundRoom;
    bucket.targetAt = Game.time;
    bucket.home = _flagPickHomeRoom(boundRoom, ownedRooms, bucket.home);
    bucket.colony = bucket.home;
    bucket.lastIntelTick = Game.time;
    bucket.lastIntelScore = rec && typeof rec.lastScore === 'number' ? rec.lastScore : 0;
    bucket.lastIntelDetails = rec && rec.lastDetails ? rec.lastDetails : null;
    bucket.state = bucket.state === SQUAD_STATE_DISBANDED ? SQUAD_STATE_ASSEMBLING : bucket.state;
    bucket.lastActive = Game.time || bucket.lastActive || bucket.createdAt || 0;

    out.push({
      squadId: squadId,
      flagName: fname,
      targetRoom: boundRoom,
      rallyPos: rallyPos,
      threatScore: bucket.lastIntelScore || 0,
      details: bucket.lastIntelDetails || null,
      homeRoom: bucket.home,
      flag: flag,
      state: bucket.state
    });
  }

  return out;
}

var TaskSquad = (function () {
  var API = {};

  var HAS = Object.prototype.hasOwnProperty;

  function _hasOwn(obj, key) {
    return !!obj && HAS.call(obj, key);
  }

  function _getRoomCallback() {
    if (typeof global !== 'undefined') {
      if (typeof global.SQUAD_ROOM_CALLBACK === 'function') {
        return global.SQUAD_ROOM_CALLBACK;
      }
      if (typeof global.TRAVELER_ROOM_CALLBACK === 'function') {
        return global.TRAVELER_ROOM_CALLBACK;
      }
    }
    return undefined;
  }

  // -----------------------------
  // Tunables
  // -----------------------------
  var TARGET_STICKY_TICKS = 12; // how long to keep a chosen target before re-eval
  var RALLY_FLAG_PREFIX   = 'Squad'; // e.g. "SquadAlpha", "Squad_Beta"
  var MAX_TARGET_RANGE    = 30;
  var MEMBER_STALE_TICKS  = 50;

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

  // -----------------------------
  // Per-tick move reservation map
  // -----------------------------
  if (!global.__MOVE_RES__) global.__MOVE_RES__ = { tick: -1, rooms: {} };

  function _resetReservations() {
    if (global.__MOVE_RES__.tick !== Game.time) {
      global.__MOVE_RES__.tick = Game.time;
      global.__MOVE_RES__.rooms = {};
    }
  }

  function _key(x, y) { return x + '_' + y; }

  function _reserveTile(creep, pos, priority) {
    _resetReservations();
    var roomName = pos.roomName || (pos.pos && pos.pos.roomName);
    if (!roomName) return true; // nothing to do

    var roomMap = global.__MOVE_RES__.rooms[roomName];
    if (!roomMap) roomMap = (global.__MOVE_RES__.rooms[roomName] = {});

    var k = _key(pos.x || pos.pos.x, pos.y || pos.pos.y);
    var cur = roomMap[k];
    if (!cur) {
      roomMap[k] = { name: creep.name, pri: priority|0 };
      return true;
    }

    // If the same creep, ok
    if (cur.name === creep.name) return true;

    // Higher priority wins
    if ((priority|0) > (cur.pri|0)) {
      roomMap[k] = { name: creep.name, pri: priority|0 };
      return true;
    }

    return false; // someone stronger already owns it this tick
  }

  // -----------------------------
  // Squad snapshot cache (members + follow counts per tick)
  // -----------------------------
  var _squadCache = global.__TASKSQUAD_CACHE;
  if (!_squadCache || _squadCache.__ver !== 'SQUAD_CACHE_v1') {
    _squadCache = { __ver: 'SQUAD_CACHE_v1', tick: -1, membersBySquad: {}, followCounts: {} };
    global.__TASKSQUAD_CACHE = _squadCache;
  }


  function _ensureTickCache() {
    var cache = global.__TASKSQUAD_CACHE;
    if (!cache || cache.tick !== Game.time) {
      cache = { __ver: 'SQUAD_CACHE_v1', tick: Game.time, membersBySquad: {}, followCounts: {} };
      for (var name in Game.creeps) {
        if (!Game.creeps.hasOwnProperty(name)) continue;
        var creep = Game.creeps[name];
        if (!creep || !creep.my || !creep.memory) continue;
        var sid = getSquadId(creep);
        var list = cache.membersBySquad[sid];
        if (!list) list = cache.membersBySquad[sid] = [];
        list.push(creep);

        var followId = creep.memory.followTarget;
        if (followId) {
          var role = _roleOf(creep);
          var perSquad = cache.followCounts[sid];
          if (!perSquad) perSquad = cache.followCounts[sid] = {};
          var perRole = perSquad[role];
          if (!perRole) perRole = perSquad[role] = {};
          perRole[followId] = (perRole[followId] || 0) + 1;
        }
      }
      global.__TASKSQUAD_CACHE = cache;
    }
    return cache;
  }

  function getCachedMembers(squadId) {
    var cache = _ensureTickCache();
    var id = squadId || 'Alpha';
    var members = cache.membersBySquad[id];
    // Consumers must not mutate the array; it is reused for all lookups during the tick.
    return members ? members : [];
  }

  function getFollowLoad(squadId, targetId, roleName) {
    if (!targetId) return 0;
    var cache = _ensureTickCache();
    var id = squadId || 'Alpha';
    var perSquad = cache.followCounts[id];
    if (!perSquad) return 0;
    var perRole = perSquad[roleName || ''];
    if (!perRole) return 0;
    return perRole[targetId] || 0;
  }

  function getRoleFollowMap(squadId, roleName) {
    var cache = _ensureTickCache();
    var id = squadId || 'Alpha';
    var perSquad = cache.followCounts[id];
    if (!perSquad) return {};
    var perRole = perSquad[roleName || ''];
    // Callers should treat the returned object as read-only because it is shared for the tick.
    return perRole || {};
  }

  // -----------------------------
  // Utilities
  // -----------------------------
  function _roleOf(creep) {
    return (creep && creep.memory && (creep.memory.task || creep.memory.role)) || '';
  }
  function _isCombat(creep) { return !!COMBAT_ROLES[_roleOf(creep)]; }
  function _isCivilian(creep) { return !_isCombat(creep); }
  function _rolePri(creep) {
    var r = _roleOf(creep);
    var p = ROLE_PRI[r];
    return (p == null) ? 10 : p; // default low priority for unknown roles
  }
  function _movedThisTick(creep) { return creep && creep.memory && creep.memory._movedAt === Game.time; }

  function getSquadId(creep) {
    return (creep.memory && creep.memory.squadId) || 'Alpha';
  }

  function _ensureSquadBucket(id) {
    var callsign = id || 'Alpha';
    var registry = _ensureSquadRegistry();
    var bucket = registry[callsign];
    if (!bucket) {
      bucket = _createSquadRecord(callsign);
      registry[callsign] = bucket;
    }
    bucket = _normalizeSquadRecord(bucket, callsign);
    if (bucket.desiredRoles && typeof bucket.desiredRoles !== 'object') {
      bucket.desiredRoles = {};
    }
    if (!Array.isArray(bucket.roleOrder) || !bucket.roleOrder.length) {
      bucket.roleOrder = ['CombatMelee', 'CombatArcher', 'CombatMedic'];
    }
    if (typeof bucket.minReady !== 'number' || bucket.minReady < 1) {
      bucket.minReady = 1;
    }
    if (bucket.leader === undefined) bucket.leader = null;
    if (bucket.leaderPri === undefined) bucket.leaderPri = null;
    return bucket;
  }

  function _rallyFlagFor(id) {
    return Game.flags[RALLY_FLAG_PREFIX + id] ||
           Game.flags[RALLY_FLAG_PREFIX + '_' + id] ||
           Game.flags[id] || null;
  }

  function _cleanupMembers(bucket, id) {
    if (!bucket) return;
    var roster = bucket.memberRecords || {};
    for (var name in roster) {
      if (!_hasOwn(roster, name)) continue;
      var rec = roster[name];
      if (!rec) {
        delete roster[name];
        continue;
      }
      if (!Game.creeps[name]) {
        delete roster[name];
        continue;
      }
      if (rec.updated && Game.time - rec.updated > MEMBER_STALE_TICKS) {
        var c = Game.creeps[name];
        if (c && c.my) {
          rec.updated = Game.time;
        } else {
          delete roster[name];
        }
      }
    }
    if (bucket.leader && (!roster[bucket.leader] || !Game.creeps[bucket.leader])) {
      bucket.leader = null;
      bucket.leaderPri = null;
    }
    _updateMemberAggregates(bucket);
    if (id) _refreshLeader(bucket, id);
  }

  function _refreshLeader(bucket, id, candidateName) {
    if (!bucket) return;

    var roster = bucket.memberRecords || {};

    if (bucket.leader && (!roster[bucket.leader] || !Game.creeps[bucket.leader])) {
      bucket.leader = null;
      bucket.leaderPri = null;
    }

    if (candidateName) {
      var cand = Game.creeps[candidateName];
      if (cand && cand.memory && (cand.memory.squadId || 'Alpha') === id) {
        var pri = _rolePri(cand);
        if (!bucket.leader || bucket.leaderPri == null || pri > bucket.leaderPri || bucket.leader === candidateName) {
          bucket.leader = candidateName;
          bucket.leaderPri = pri;
        }
      }
    }

    if (!bucket.leader) {
      var cache = _ensureTickCache();
      var members = cache.membersBySquad[id] || [];
      var best = null;
      var bestPri = -9999;
      for (var i = 0; i < members.length; i++) {
        var member = members[i];
        if (!member || !member.memory) continue;
        if ((member.memory.squadId || 'Alpha') !== id) continue;
        var priVal = _rolePri(member);
        if (!best || priVal > bestPri) {
          best = member;
          bestPri = priVal;
        }
      }
      if (best) {
        bucket.leader = best.name;
        bucket.leaderPri = bestPri;
      }
    }
  }

  function getRallyPos(squadId) {
    var id = squadId || 'Alpha';
    var bucket = _ensureSquadBucket(id);
    var rally = bucket && bucket.rally;
    if (rally && rally.roomName != null) {
      return new RoomPosition(rally.x, rally.y, rally.roomName);
    }
    var flag = _rallyFlagFor(id);
    if (flag) {
      bucket.rally = { x: flag.pos.x, y: flag.pos.y, roomName: flag.pos.roomName };
      return flag.pos;
    }
    return null;
  }

  function _isGood(obj) { return obj && obj.hits != null && obj.hits > 0 && obj.pos && obj.pos.roomName; }

  function _scoreHostile(me, h) {
    var dist   = me.pos.getRangeTo(h);
    var healer = h.getActiveBodyparts(HEAL) > 0 ? HEALER_WEIGHT : 0;
    var ranged = h.getActiveBodyparts(RANGED_ATTACK) > 0 ? RANGED_WEIGHT : 0;
    var melee  = h.getActiveBodyparts(ATTACK) > 0 ? MELEE_WEIGHT : 0;
    var tough  = h.getActiveBodyparts(TOUGH) > 0 ? TOUGH_PENALTY : 0;
    var hurt   = (1 - h.hits / Math.max(1, h.hitsMax)) * HURT_WEIGHT;
    return healer + ranged + melee + tough + hurt + dist;
  }

  function _isNpcUsername(name) {
    return !name || name === 'Invader' || name === 'Source Keeper';
  }

  // FIX: Reuse the alliance helper so we only ignore creeps and structures owned by trusted players.
  function _isAllyUsername(name) {
    return isAlly(name);
  }

  function _chooseRoomTarget(me) {
    var room = me.room; if (!room) return null;

    // FIX: Include all non-allied hostiles (players and NPCs) instead of only NPC creeps.
    var hostiles = room.find(FIND_HOSTILE_CREEPS, {
      filter: function (h) {
        var owner = h.owner && h.owner.username;
        return !_isAllyUsername(owner);
      }
    });
    if (hostiles && hostiles.length) {
      var scored = _.map(hostiles, function (h) { return { h: h, s: _scoreHostile(me, h) }; });
      var best = _.min(scored, 's');
      if (best && best.h) return best.h;
    }

    var key = room.find(FIND_HOSTILE_STRUCTURES, { filter: function (s) {
      var owner = s.owner && s.owner.username;
      if (!owner) return false;
      if (_isAllyUsername(owner)) return false;
      return s.structureType === STRUCTURE_TOWER || s.structureType === STRUCTURE_SPAWN;
    }});
    if (key.length) return me.pos.findClosestByRange(key);

    var others = room.find(FIND_HOSTILE_STRUCTURES, { filter: function (s) {
      var owner = s.owner && s.owner.username;
      if (!owner) return false;
      return !_isAllyUsername(owner);
    }});
    if (others.length) return me.pos.findClosestByRange(others);

    return null;
  }

  function sharedTarget(creep) {
    var id = getSquadId(creep);
    var S  = _ensureSquadBucket(id);

    if (S.targetId && Game.time - (S.targetAt || 0) <= TARGET_STICKY_TICKS) {
      var keep = Game.getObjectById(S.targetId);
      if (_isGood(keep) && creep.pos.getRangeTo(keep) <= MAX_TARGET_RANGE) return keep;
    }
    var nxt = _chooseRoomTarget(creep);
    if (nxt) { S.targetId = nxt.id; S.targetAt = Game.time; return nxt; }
    S.targetId = null; S.targetAt = Game.time;
    return null;
  }

  function getAnchor(creep) {
    var id = getSquadId(creep), S = _ensureSquadBucket(id);
    var rally = getRallyPos(id);
    if (rally) {
      S.anchor = { x: rally.x, y: rally.y, room: rally.roomName };
      S.anchorAt = Game.time;
      return rally;
    }

    var leader = null;
    if (S.leader) {
      leader = Game.creeps[S.leader] || null;
      if (!leader || !leader.memory || (leader.memory.squadId || 'Alpha') !== id) {
        S.leader = null;
        S.leaderPri = null;
        leader = null;
      }
    }
    if (!leader) {
      _refreshLeader(S, id);
      if (S.leader) leader = Game.creeps[S.leader] || null;
    }
    if (leader && leader.pos) {
      S.anchor = { x: leader.pos.x, y: leader.pos.y, room: leader.pos.roomName };
      S.anchorAt = Game.time;
      return leader.pos;
    }
    return null;
  }

  // -----------------------------
  // Polite traffic shim (priority aware)
  // -----------------------------
  function _politelyYieldFor(mover, nextPos) {
    if (!nextPos) return;

    var blockers = nextPos.lookFor(LOOK_CREEPS);
    if (!blockers || !blockers.length) return;

    var ally = blockers[0];
    if (!ally || !ally.my) return;

    // If ally already moved this tick, don't disturb
    if (_movedThisTick(ally)) return;

    var sameSquad = (mover.memory && ally.memory &&
                     mover.memory.squadId && ally.memory.squadId &&
                     mover.memory.squadId === ally.memory.squadId);

    var moverPri = _rolePri(mover);
    var allyPri  = _rolePri(ally);

    // Only try to move ally if:
    //   - same squad and mover has >= priority, or
    //   - mover is combat and ally is civilian (ROW)
    var allow = (sameSquad && moverPri >= allyPri) || (_isCombat(mover) && _isCivilian(ally));
    if (!allow) return;

    // Compute direction mover -> ally tile
    var dir = mover.pos.getDirectionTo(nextPos);
    var back = ((dir + 4 - 1) % 8) + 1;

    var off = [
      [0, 0],
      [0, -1],  [1, -1],  [1, 0],   [1, 1],
      [0, 1],   [-1, 1],  [-1, 0],  [-1, -1]
    ];

    function _isTileFree(pos) {
      if (!pos || pos.x <= 0 || pos.x >= 49 || pos.y <= 0 || pos.y >= 49) return false;
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

    // Try ally back-step
    var bx = ally.pos.x + off[back][0], by = ally.pos.y + off[back][1];
    if (bx >= 0 && bx <= 49 && by >= 0 && by <= 49) {
      var bpos = new RoomPosition(bx, by, ally.pos.roomName);
      if (_isTileFree(bpos) && _reserveTile(ally, bpos, allyPri)) { ally.move(back); ally.memory._movedAt = Game.time; return; }
    }

    // Try side-steps (left/right)
    var left  = ((dir + 6 - 1) % 8) + 1; // -2
    var right = ((dir + 2 - 1) % 8) + 1; // +2
    var sides = [left, right];
    for (var s = 0; s < sides.length; s++) {
      var sd = sides[s];
      var sx = ally.pos.x + off[sd][0], sy = ally.pos.y + off[sd][1];
      if (sx < 0 || sx > 49 || sy < 0 || sy > 49) continue;
      var spos = new RoomPosition(sx, sy, ally.pos.roomName);
      if (_isTileFree(spos) && _reserveTile(ally, spos, allyPri)) { ally.move(sd); ally.memory._movedAt = Game.time; return; }
    }
  }

  // -----------------------------
  // Traveler-backed stepToward with reservations
  // -----------------------------
  function stepToward(creep, pos, range) {
    if (!creep || !pos) return ERR_NO_PATH;

    // Already close enough?
    var tgtPos = (pos.pos || pos);
    var needRange = (typeof range === 'number' ? range : 0);
    if (creep.pos.getRangeTo(tgtPos) <= needRange) return OK;

    var retData = {};
    var opts = {
      range: needRange,
      ignoreCreeps: TRAVELER_DEFAULTS.ignoreCreeps,
      stuckValue: TRAVELER_DEFAULTS.stuckValue,
      repath: TRAVELER_DEFAULTS.repath,
      maxOps: TRAVELER_DEFAULTS.maxOps,
      allowHostile: TRAVELER_DEFAULTS.allowHostile,
      roomCallback: _getRoomCallback(),
      returnData: retData
    };

    // Ask Traveler to plan + possibly move
    var code = creep.travelTo(tgtPos, opts);

    var myPri = _rolePri(creep);

    // If a nextPos is planned, try to claim it. If we lose the reservation race to
    // a higher-priority unit, stop this tick (prevents “dance”).
    if (retData && retData.nextPos) {
      // If another creep is physically there, try to politely yield them first
      _politelyYieldFor(creep, retData.nextPos);

      // Re-check reservation after yield attempt
      if (!_reserveTile(creep, retData.nextPos, myPri)) {
        // Could not reserve (someone more important got it) → do nothing this tick
        return ERR_BUSY;
      }
    }

    // Mark that we issued movement this tick (helps yield logic)
    creep.memory = creep.memory || {};
    creep.memory._movedAt = Game.time;

    // Lightweight unstick (rare)
    var stuck = (creep.fatigue === 0 && creep.memory._lx === creep.pos.x && creep.memory._ly === creep.pos.y);
    if (stuck && creep.pos.getRangeTo(tgtPos) > needRange) {
      _unstickWiggle(creep, tgtPos);
    }
    creep.memory._lx = creep.pos.x; creep.memory._ly = creep.pos.y;

    return code;
  }

  function _unstickWiggle(creep, goalPos) {
    var bestDir = 0, bestScore = 1e9, d, x, y, p, score;
    for (d = 1; d <= 8; d++) {
      x = creep.pos.x + (d === RIGHT || d === TOP_RIGHT || d === BOTTOM_RIGHT ? 1 :
                         d === LEFT  || d === TOP_LEFT  || d === BOTTOM_LEFT  ? -1 : 0);
      y = creep.pos.y + (d === BOTTOM || d === BOTTOM_LEFT || d === BOTTOM_RIGHT ? 1 :
                         d === TOP    || d === TOP_LEFT   || d === TOP_RIGHT    ? -1 : 0);
      if (x < 0 || x > 49 || y < 0 || y > 49) continue;
      p = new RoomPosition(x, y, creep.pos.roomName);
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
      score = p.getRangeTo(goalPos);
      if (score < bestScore) { bestScore = score; bestDir = d; }
    }
    if (bestDir) creep.move(bestDir);
  }

  function registerMember(squadId, creepName, role, opts) {
    var id = squadId || 'Alpha';
    var bucket = _ensureSquadBucket(id);
    if (!creepName) return;

    _cleanupMembers(bucket, id);

    var roster = bucket.memberRecords || (bucket.memberRecords = {});
    var entry = roster[creepName];
    if (!entry) {
      entry = roster[creepName] = { role: role || 'unknown', rallied: false };
    }
    if (role) entry.role = role;
    entry.updated = Game.time;

    var rallyPos = null;
    if (opts && opts.rallyPos) {
      rallyPos = opts.rallyPos;
    } else if (opts && opts.creep) {
      rallyPos = getRallyPos(id);
    }
    if (rallyPos && (!bucket.rally || bucket.rally.x !== rallyPos.x || bucket.rally.y !== rallyPos.y || bucket.rally.roomName !== rallyPos.roomName)) {
      bucket.rally = { x: rallyPos.x, y: rallyPos.y, roomName: rallyPos.roomName };
    }

    var rallied = false;
    if (opts) {
      if (typeof opts.rallied === 'boolean') {
        rallied = opts.rallied;
      } else if (opts.creep && rallyPos) {
        rallied = opts.creep.pos && opts.creep.pos.inRangeTo(rallyPos, 1);
      }
    }

    if (rallied) {
      entry.rallied = true;
      entry.ralliedAt = Game.time;
    }

    bucket.state = SQUAD_STATE_ACTIVE;
    bucket.lastActive = Game.time || bucket.lastActive || bucket.createdAt || 0;
    _updateMemberAggregates(bucket);
    _refreshLeader(bucket, id, creepName);
  }

  function isReady(squadId) {
    var id = squadId || 'Alpha';
    var bucket = _ensureSquadBucket(id);
    _cleanupMembers(bucket, id);

    var desired = bucket.desiredRoles || {};
    var counts = {};
    var totalRallied = 0;

    var roster = bucket.memberRecords || {};
    for (var name in roster) {
      if (!_hasOwn(roster, name)) continue;
      var rec = roster[name];
      if (!rec) continue;
      var live = Game.creeps[name];
      if (!live || !live.my) continue;
      var role = rec.role || (live.memory && (live.memory.squadRole || live.memory.task)) || 'unknown';
      if (rec.rallied) {
        counts[role] = (counts[role] || 0) + 1;
        totalRallied += 1;
      }
    }

    var totalNeeded = 0;
    var allMet = true;
    for (var key in desired) {
      if (!_hasOwn(desired, key)) continue;
      var need = desired[key] | 0;
      if (need <= 0) continue;
      totalNeeded += need;
      if ((counts[key] || 0) < need) {
        allMet = false;
      }
    }

    if (allMet && totalNeeded > 0) {
      return true;
    }

    var threshold = bucket.minReady || 1;
    if (threshold < 1) threshold = 1;
    return totalRallied >= threshold;
  }

  // -----------------------------
  // Public API
  // -----------------------------
  API.getSquadId     = getSquadId;
  API.sharedTarget   = sharedTarget;
  API.getAnchor      = getAnchor;
  API.getRallyPos    = getRallyPos;
  API.stepToward     = stepToward;
  API.politelyYieldFor = _politelyYieldFor;
  API.registerMember = registerMember;
  API.isReady        = isReady;
  API.getCachedMembers = getCachedMembers;
  API.getFollowLoad    = getFollowLoad;
  API.getRoleFollowMap = getRoleFollowMap;
  API.isAlly = isAlly;
  API.friendlyUsernames = friendlyUsernames;
  API.noteFriendlyFireAvoid = noteFriendlyFireAvoid;
  API.ensureSquadFlags = ensureSquadFlags;
  API.getActiveSquads = getActiveSquads;
  API.ensureSquadRecord = _ensureSquadBucket;
  API.reserveCallsign = _reserveCallsign;
  API.releaseCallsign = _releaseCallsign;
  API.getSquadRegistrySnapshot = _computeSquadSnapshot;
  API.maintainSquadRegistry = _maintainSquadRegistry;
  API.noteSquadPlan = _noteSquadPlan;
  API.noteSpawnResult = _noteSpawnResult;

  return API;
})();

module.exports = TaskSquad;
module.exports.isAlly = isAlly;
module.exports.friendlyUsernames = friendlyUsernames;
module.exports.noteFriendlyFireAvoid = noteFriendlyFireAvoid;
module.exports.ensureSquadFlags = ensureSquadFlags;
module.exports.getActiveSquads = getActiveSquads;
module.exports.ensureSquadRecord = TaskSquad.ensureSquadRecord;
module.exports.reserveCallsign = TaskSquad.reserveCallsign;
module.exports.releaseCallsign = TaskSquad.releaseCallsign;
module.exports.getSquadRegistrySnapshot = TaskSquad.getSquadRegistrySnapshot;
module.exports.maintainSquadRegistry = TaskSquad.maintainSquadRegistry;
module.exports.noteSquadPlan = TaskSquad.noteSquadPlan;
module.exports.noteSpawnResult = TaskSquad.noteSpawnResult;
