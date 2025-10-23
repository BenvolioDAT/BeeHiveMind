'use strict';

var TaskBuilder = require('Task.Builder'); // guarded below
var Logger = require('core.logger');
var LOG_LEVEL = Logger.LOG_LEVEL;

// Config: draw every tick, but keep caps to avoid runaway CPU
var CFG = {
  maxCreepsRenderedDebug: 30,
  showCpuStats: true,
  showRepairCounter: true,
  drawDebugEachTick: true,
  debugTickModulo: 1,
  tableTickModulo: 1,

  // World/overview map overlay throttles
  worldDrawModulo: 0,          // 1 = every tick (raise to 2/3 if you want less)
  worldMaxFlagMarkers: 600,    // hard cap marker count for safety
  worldMaxPlannedTiles: 800    // hard cap for planned-road dots
};

// ---------- helpers ----------

function _getMainRoom() {
  var rn = Memory.firstSpawnRoom;
  if (rn && Game.rooms[rn]) return Game.rooms[rn];
  for (var name in Game.spawns) {
    if (!Game.spawns.hasOwnProperty(name)) continue;
    var sp = Game.spawns[name];
    if (sp && sp.room) return sp.room;
  }
  return null;
}

function _shouldDraw(mod, roomName) {
  if (mod <= 1) return true;
  var h = 0;
  for (var i = 0; i < roomName.length; i++) h = (h * 31 + roomName.charCodeAt(i)) | 0;
  return ((Game.time + (h & 3)) % mod) === 0;
}

var HUD_CACHE = { tick: -1, header: {}, seatLine1: {}, seatLine2: {}, route: {} };
var HUD_DEFAULT_PALETTE = {
  statusOK: '#88ff88',
  statusDEGRADED: '#ffd966',
  statusBLOCKED: '#ff6b6b',
  statusNOVISION: '#c0c0c0',
  statusROUTEFAIL: '#ffa94d',
  statusUnknown: '#ffffff',
  headerText: '#ffffff',
  headerShadow: '#000000',
  subText: '#e5e5e5',
  seatFree: '#66ccff',
  seatOccupied: '#ffd54f',
  seatQueued: '#ffa94d',
  barBg: '#1a1a1a',
  barFill: '#ffd54f',
  reserverGood: '#88ff88',
  reserverWarn: '#ffb347',
  reserverFail: '#ff6b6b',
  legendText: '#dddddd',
  legendShadow: '#000000',
  pathStroke: '#66ccff',
  pathLabel: '#ffffff',
  contested: '#ff6b6b'
};

function _resetHudCache() {
  if (HUD_CACHE.tick === Game.time) return;
  HUD_CACHE.tick = Game.time;
  HUD_CACHE.header = {};
  HUD_CACHE.seatLine1 = {};
  HUD_CACHE.seatLine2 = {};
  HUD_CACHE.route = {};
}

function _getCachedString(bucketName, key, hash, builder) {
  _resetHudCache();
  var bucket = HUD_CACHE[bucketName];
  if (!bucket) return builder();
  var entry = bucket[key];
  if (!entry || entry.hash !== hash) {
    entry = { hash: hash, value: builder() };
    bucket[key] = entry;
  }
  return entry.value;
}

function _mergePalette(custom) {
  if (!custom) return HUD_DEFAULT_PALETTE;
  var merged = {};
  var key;
  for (key in HUD_DEFAULT_PALETTE) {
    if (Object.prototype.hasOwnProperty.call(HUD_DEFAULT_PALETTE, key)) {
      merged[key] = HUD_DEFAULT_PALETTE[key];
    }
  }
  for (key in custom) {
    if (Object.prototype.hasOwnProperty.call(custom, key)) {
      merged[key] = custom[key];
    }
  }
  return merged;
}

function _createHudContext(roomName, opts) {
  var visual = new RoomVisual(roomName);
  var drawBudget = Infinity;
  if (opts && opts.drawBudget != null) {
    var parsed = opts.drawBudget | 0;
    if (parsed > 0) drawBudget = parsed;
  }
  var palette = _mergePalette(opts && opts.palette);
  return {
    visual: visual,
    usedBudget: 0,
    budget: drawBudget,
    palette: palette
  };
}

function _consume(ctx, cost) {
  if (!ctx) return false;
  var needed = cost || 1;
  if (ctx.usedBudget + needed > ctx.budget) {
    return false;
  }
  ctx.usedBudget += needed;
  return true;
}

function _drawText(ctx, text, x, y, style) {
  if (!ctx || text == null) return false;
  if (!_consume(ctx, 1)) return false;
  ctx.visual.text(text, x, y, style || {});
  return true;
}

function _drawRect(ctx, x, y, w, h, style) {
  if (!ctx) return false;
  if (!_consume(ctx, 1)) return false;
  ctx.visual.rect(x, y, w, h, style || {});
  return true;
}

function _drawLine(ctx, x1, y1, x2, y2, style) {
  if (!ctx) return false;
  if (!_consume(ctx, 1)) return false;
  ctx.visual.line(x1, y1, x2, y2, style || {});
  return true;
}

function _drawPoly(ctx, points, style) {
  if (!ctx || !points || !points.length) return false;
  if (!_consume(ctx, 1)) return false;
  ctx.visual.poly(points, style || {});
  return true;
}

function _statusToColor(palette, status) {
  if (!palette) palette = HUD_DEFAULT_PALETTE;
  if (status === 'OK') return palette.statusOK;
  if (status === 'DEGRADED') return palette.statusDEGRADED;
  if (status === 'BLOCKED') return palette.statusBLOCKED;
  if (status === 'NOVISION') return palette.statusNOVISION;
  if (status === 'ROUTEFAIL') return palette.statusROUTEFAIL;
  return palette.statusUnknown;
}

function _formatRemoteHeader(ledger) {
  if (!ledger) return '';
  var minersHave = ledger.minersHave != null ? ledger.minersHave : 0;
  var minersNeed = ledger.minersNeed != null ? ledger.minersNeed : 0;
  var haulersHave = ledger.haulers && ledger.haulers.countHave != null ? ledger.haulers.countHave : 0;
  var haulersNeed = ledger.haulers && ledger.haulers.countNeed != null ? ledger.haulers.countNeed : 0;
  var reserverHave = ledger.reserver && ledger.reserver.have != null ? ledger.reserver.have : 0;
  var reserverNeed = ledger.reserver && ledger.reserver.needed != null ? ledger.reserver.needed : 0;
  var ttl = ledger.reserver && ledger.reserver.ttl != null ? ledger.reserver.ttl : 0;
  var net = 0;
  if (ledger.energyFlow) {
    var out = ledger.energyFlow.outPerTick || 0;
    var inn = ledger.energyFlow.inPerTick || 0;
    net = out - inn;
  }
  var status = ledger.status || 'UNKNOWN';
  var reason = ledger.notes || '';
  var key = status + '|' + minersHave + '|' + minersNeed + '|' + haulersHave + '|' + haulersNeed + '|' + reserverHave + '|' + reserverNeed + '|' + ttl + '|' + net + '|' + reason;
  return _getCachedString('header', ledger.roomName || ledger.remote || 'remote', key, function () {
    var parts = [];
    var name = ledger.roomName || ledger.remote || 'remote';
    parts.push(name);
    parts.push(' | ');
    var statusLabel = status;
    if (status !== 'OK' && reason) {
      statusLabel = status + ' (' + reason + ')';
    }
    parts.push(statusLabel);
    parts.push(' | ');
    parts.push('miners ' + minersHave + '/' + minersNeed);
    parts.push(' | ');
    parts.push('haulers ' + haulersHave + '/' + haulersNeed);
    parts.push(' | ');
    parts.push('resv ' + ttl + 's');
    parts.push(' | ');
    var netLabel = net >= 0 ? '+' + net : String(net);
    parts.push(netLabel + '/t');
    return parts.join('');
  });
}

function _formatSourceLine1(source) {
  if (!source) return '';
  var state = source.seatState || 'FREE';
  var ttl = source.minerTtl != null ? source.minerTtl : 0;
  var hash = state + '|' + ttl;
  return _getCachedString('seatLine1', source.id || hash, hash, function () {
    return 'S: ' + state + ' (TTL ' + ttl + ')';
  });
}

function _formatSourceLine2(source) {
  if (!source) return '';
  var fill = source.containerFill != null ? Math.round(Math.max(0, Math.min(1, source.containerFill)) * 100) : 0;
  var linkEnergy = source.linkEnergy != null ? source.linkEnergy : 0;
  var hash = fill + '|' + linkEnergy;
  return _getCachedString('seatLine2', source.id || hash, hash, function () {
    return 'Cont: ' + fill + '% | Link: ' + linkEnergy;
  });
}

function _formatRouteLabel(eta, load) {
  var cleanEta = eta != null ? eta : 0;
  var cleanLoad = load != null ? load : 0;
  var hash = cleanEta + '|' + cleanLoad;
  return _getCachedString('route', hash, hash, function () {
    return 'ETA ~' + cleanEta + 't | load ~' + cleanLoad + '%';
  });
}

// ---------- module ----------
var BeeVisuals = {

  drawVisuals: function () {
    var room = _getMainRoom();
    if (!room) return;

    var visual = new RoomVisual(room.name);

    // DEBUG creep lines
    if (Logger.shouldLog(LOG_LEVEL.DEBUG) && (CFG.drawDebugEachTick || _shouldDraw(CFG.debugTickModulo, room.name))) {
      var yOffset = 1;
      var count = 0;
      for (var cname in Game.creeps) {
        if (!Game.creeps.hasOwnProperty(cname)) continue;
        var creep = Game.creeps[cname];

        var parts = [];
        parts.push((creep.name || 'bee') + ': ' + (creep.ticksToLive || 0));
        if (creep.memory && creep.memory.assignedSource) parts.push('A.S.ID:' + creep.memory.assignedSource);
        if (creep.memory && creep.memory.assignedContainer) parts.push('C.ID:' + creep.memory.assignedContainer);
        if (creep.memory && creep.memory.targetRoom) parts.push('T.R:' + creep.memory.targetRoom);
        if (creep.memory && creep.memory.sourceId) parts.push('S.ID:' + creep.memory.sourceId);

        visual.text(parts.join(', '), 0, yOffset, { color: 'white', font: 0.5, opacity: 1, align: 'left' });
        yOffset += 1;
        count++;
        if (count >= CFG.maxCreepsRenderedDebug) break;
      }

      // structure placement markers near first spawn (cheap)
      var firstSpawn = null;
      for (var sn in Game.spawns) { if (Game.spawns.hasOwnProperty(sn)) { firstSpawn = Game.spawns[sn]; break; } }
      if (firstSpawn && TaskBuilder && TaskBuilder.structurePlacements) {
        var baseX = firstSpawn.pos.x;
        var baseY = firstSpawn.pos.y;
        var placements = TaskBuilder.structurePlacements;
        for (var p = 0; p < placements.length; p++) {
          var pl = placements[p];
          visual.circle(baseX + pl.x, baseY + pl.y, { radius: 0.4, opacity: 0.1, stroke: 'cyan' });
        }
      }
    }

    // CPU + bucket readouts
    if (CFG.showCpuStats) {
      var used = Game.cpu.getUsed();
      var last = Memory.lastCpuUsage || 0;
      var delta = used - last;
      Memory.lastCpuUsage = used;

      visual.text('CPU Bucket: ' + Game.cpu.bucket, 20, 1, { color: 'white', font: 0.6, opacity: 1 });
      visual.text('CPU Used: ' + used.toFixed(2) + ' / Δ ' + delta.toFixed(2), 20, 2, { color: 'white', font: 0.6, opacity: 1 });
    }

    // In-room planned roads (DEBUG)
    BeeVisuals.drawPlannedRoadsDebug();

    // NEW: world/overview map overlays (flags + planned roads)
    BeeVisuals.drawWorldOverview();

    // Repair counter
    if (CFG.showRepairCounter) {
      var counter = Memory.GameTickRepairCounter || 0;
      visual.text('Repair Tick Count: ' + counter + '/5', 20, 3, { color: 'white', font: 0.6, opacity: 1 });
    }

    BeeVisuals.drawLunaDebug(room, visual);
  },

  drawEnergyBar: function () {
    var room = _getMainRoom();
    if (!room) return;

    var visuals = new RoomVisual(room.name);
    var energy = room.energyAvailable | 0;
    var capacity = room.energyCapacityAvailable | 0;
    var pct = (capacity > 0) ? (energy / capacity) : 0;

    var x = 0, y = 19, width = 5.2, height = 1;

    visuals.rect(x, y, width, height, { fill: '#000000', opacity: 0.3, stroke: '#000000' });
    visuals.rect(x, y, width * pct, height, { fill: '#00ff00', opacity: 0.5, stroke: '#000000' });
    visuals.text(String(energy) + '/' + String(capacity), x + width / 2, y + height - 0.15, {
      color: 'white', font: 0.5, align: 'center', opacity: 1, stroke: '#000000'
    });
  },

  drawWorkerBeeTaskTable: function () {
    var room = _getMainRoom();
    if (!room) return;
    if (!_shouldDraw(CFG.tableTickModulo, room.name)) return;

    var visual = new RoomVisual(room.name);

    var workerBees = [];
    for (var cn in Game.creeps) {
      if (!Game.creeps.hasOwnProperty(cn)) continue;
      var c = Game.creeps[cn];
      if (c && c.memory && c.memory.role === 'Worker_Bee') workerBees.push(c);
    }
    var totalCount = workerBees.length | 0;

    var maxTasks = {
      baseharvest: 2, builder: 1, upgrader: 1, repair: 0,
      courier: 1, luna: 8, scout: 1, queen: 2,
      CombatArcher: 0, CombatMelee: 0, CombatMedic: 0,
      Dismantler: 0, Claimer: 2
    };

    var tasks = {};
    var k;
    for (k in maxTasks) if (maxTasks.hasOwnProperty(k)) tasks[k] = 0;
    for (var i = 0; i < workerBees.length; i++) {
      var t = (workerBees[i].memory && workerBees[i].memory.task) ? workerBees[i].memory.task : 'idle';
      if (tasks.hasOwnProperty(t)) tasks[t] = (tasks[t] | 0) + 1;
    }

    var maxTotal = 0; for (k in maxTasks) if (maxTasks.hasOwnProperty(k)) maxTotal += (maxTasks[k] | 0);

    var x0 = 0, y0 = 20;
    var nameW = 4, valueW = 1.2, cellH = 0.7;
    var font = 0.5, fillColor = '#000000', strokeColor = '#000000', opacityLvl = 0.4;

    visual.rect(x0, y0, nameW, cellH, { fill: fillColor, stroke: strokeColor, opacity: opacityLvl, radius: 0.05 });
    visual.rect(x0 + nameW, y0, valueW, cellH, { fill: fillColor, stroke: strokeColor, opacity: opacityLvl, radius: 0.05 });
    visual.text('Worker_Bee', x0 + 0.3, y0 + cellH / 2 + 0.15, { font: font, color: '#ffffff', align: 'left', opacity: 1 });
    visual.text(String(totalCount) + '/' + String(maxTotal), x0 + nameW + valueW - 0.3, y0 + cellH / 2 + 0.15, { font: font, color: '#ffffff', align: 'right', opacity: 1 });

    var row = 1;
    for (k in maxTasks) {
      if (!maxTasks.hasOwnProperty(k)) continue;
      var y = y0 + row * cellH;
      var val = String(tasks[k] | 0) + '/' + String(maxTasks[k] | 0);

      visual.rect(x0, y, nameW, cellH, { fill: fillColor, stroke: strokeColor, opacity: opacityLvl, radius: 0.05 });
      visual.rect(x0 + nameW, y, valueW, cellH, { fill: fillColor, stroke: strokeColor, opacity: opacityLvl, radius: 0.05 });
      visual.text(k, x0 + 0.3, y + cellH / 2 + 0.15, { font: font, color: '#ffffff', align: 'left', opacity: 1 });
      visual.text(val, x0 + nameW + valueW - 0.3, y + cellH / 2 + 0.15, { font: font, color: '#ffffff', align: 'right', opacity: 1 });

      row++;
    }
  }
};

// --- Planned road overlay (in-room, DEBUG only) ---

BeeVisuals.drawPlannedRoadsDebug = function () {
  if (!Logger.shouldLog(LOG_LEVEL.DEBUG)) return;
  var room = _getMainRoom(); if (!room) return;
  var MOD = 1; if (((Game.time + 3) % MOD) !== 0) return;

  var v = new RoomVisual(room.name);

  if (!Memory.rooms || !Memory.rooms[room.name] || !Memory.rooms[room.name].roadPlanner) return;
  var rp = Memory.rooms[room.name].roadPlanner;
  var paths = rp.paths || {};
  var key;

  var MAX_PATHS = 6;
  var MAX_TILES = 250;

  var drawnPaths = 0;
  var drawnTiles = 0;

  var COLOR_PLANNED = '#ffe066';
  var COLOR_BUILT   = '#99ff99';
  var COLOR_CURSOR  = '#66ccff';

function _hasRoadOrSiteFast(roomObj, x, y) {
    var arr = roomObj.lookForAt(LOOK_STRUCTURES, x, y);
    for (var i = 0; i < arr.length; i++) if (arr[i].structureType === STRUCTURE_ROAD) return true;
    var siteArr = roomObj.lookForAt(LOOK_CONSTRUCTION_SITES, x, y);
    for (var j = 0; j < siteArr.length; j++) if (siteArr[j].structureType === STRUCTURE_ROAD) return true;
    return false;
  }

  for (key in paths) {
    if (!paths.hasOwnProperty(key)) continue;
    if (drawnPaths >= MAX_PATHS) break;

    var rec = paths[key];
    if (!rec || !rec.path || !rec.path.length) continue;

    v.text(key, 1, 5 + (drawnPaths * 0.6), { color: '#ffffff', font: 0.5, opacity: 0.6, align: 'left' });

    var lastX = -1, lastY = -1, lastRoom = null;

    for (var idx = 0; idx < rec.path.length; idx++) {
      if (drawnTiles >= MAX_TILES) break;

      var step = rec.path[idx];
      var rname = step.roomName;
      var rx = step.x | 0, ry = step.y | 0;
      var theRoom = Game.rooms[rname];
      if (!theRoom) continue;

      if (typeof rec.i === 'number' && idx === rec.i) {
        new RoomVisual(rname).circle(rx, ry, { radius: 0.4, stroke: COLOR_CURSOR, fill: 'transparent', opacity: 0.7 });
      }

      if (theRoom.getTerrain().get(rx, ry) === TERRAIN_MASK_WALL) continue;

      var already = _hasRoadOrSiteFast(theRoom, rx, ry);
      var color = already ? COLOR_BUILT : COLOR_PLANNED;
      var opacity = already ? 0.55 : 0.35;

      new RoomVisual(rname).circle(rx, ry, { radius: 0.25, fill: color, opacity: opacity, stroke: undefined });

      if (lastRoom === rname && lastX !== -1) {
        new RoomVisual(rname).line(lastX, lastY, rx, ry, { width: 0.09, color: color, opacity: opacity });
      }

      lastX = rx; lastY = ry; lastRoom = rname;
      drawnTiles++;
      if (drawnTiles >= MAX_TILES) break;
    }

    if (rec.done && lastRoom === room.name && lastX !== -1) {
      v.text('✓', lastX, lastY, { color: COLOR_BUILT, font: 0.6, opacity: 0.7, align: 'center' });
    }

    drawnPaths++;
  }
};

function _statusColor(status) {
  switch (status) {
    case 'READY':
    case 'HATCHING':
      return '#88ff88';
    case 'DEFERRED':
    case 'SATURATED':
      return '#ffd966';
    case 'BLOCKED':
    default:
      return '#ff8888';
  }
}

BeeVisuals.drawLunaDebug = function (room, visual) {
  if (!global.CFG || global.CFG.DEBUG_LUNA !== true) return;
  var debugCache = global.__lunaDebugCache;
  if (!debugCache || debugCache.tick !== Game.time) return;

  var roomInfo = debugCache.rooms ? debugCache.rooms[room.name] : null;
  if (roomInfo) {
    var status = roomInfo.status || 'UNKNOWN';
    var color = _statusColor(status);
    var reason = roomInfo.reason ? (' (' + roomInfo.reason + ')') : '';
    var nextStr = '';
    if (roomInfo.nextAttempt != null) {
      var delta = roomInfo.nextAttempt - Game.time;
      if (delta > 0) nextStr = ' next:' + delta;
    }
    var spawn = null;
    var spawns = room.find(FIND_MY_SPAWNS) || [];
    if (spawns.length) spawn = spawns[0];
    var labelX = spawn ? spawn.pos.x : 2;
    var labelY = spawn ? (spawn.pos.y - 1) : 1;
    visual.text('Luna: ' + status + reason + nextStr, labelX, labelY, {
      color: color,
      font: 0.6,
      opacity: 0.9,
      stroke: '#000000',
      align: 'center'
    });
  }

  var creepInfo = debugCache.creeps || {};
  for (var name in creepInfo) {
    if (!creepInfo.hasOwnProperty(name)) continue;
    var info = creepInfo[name];
    if (!info || info.room !== room.name) continue;
    if (info.x == null || info.y == null) continue;
    var line1 = (info.state || 'STATE') + ' ttl:' + (info.ttl || 0);
    var line2 = info.target ? ('→ ' + info.target) : '';
    var ypos = info.y - 0.8;
    visual.text(line1, info.x, ypos, { color: '#ffffff', font: 0.5, opacity: 0.9, stroke: '#000000', align: 'center' });
    if (line2) {
      visual.text(line2, info.x, ypos - 0.6, { color: '#aaaaaa', font: 0.4, opacity: 0.8, stroke: '#000000', align: 'center' });
    }
  }
};

BeeVisuals.drawRemoteStatus = function () {
  var cache = global.__lunaVisualCache;
  if (!cache || cache.tick !== Game.time) return;
  for (var remoteName in cache.remotes) {
    if (!cache.remotes.hasOwnProperty(remoteName)) continue;
    var data = cache.remotes[remoteName];
    var room = Game.rooms[remoteName];
    if (!room) continue;
    var visual = new RoomVisual(remoteName);
    var color = '#ffd966';
    if (data.status === 'OK') color = '#88ff88';
    else if (data.status === 'BLOCKED') color = '#ff7777';
    var header = '[' + data.status + '] ' + (data.reason || '');
    visual.text(header, 1, 1, { align: 'left', color: color, font: 0.6, stroke: '#000000', opacity: 0.9 });
    var quotaText = 'M ' + (data.actual.miners || 0) + '/' + (data.quotas.miners || 0) +
      ' H ' + (data.actual.haulers || 0) + '/' + (data.quotas.haulers || 0) +
      ' R ' + (data.actual.reserver || 0) + '/' + (data.quotas.reserver || 0);
    visual.text(quotaText, 1, 1.8, { align: 'left', color: '#ffffff', font: 0.5, stroke: '#000000', opacity: 0.9 });

    if (room.controller) {
      visual.text('Reserve: ' + (data.reserverTicks || 0) + 't', room.controller.pos.x, room.controller.pos.y - 1.1, {
        align: 'center', color: '#ffffff', font: 0.5, stroke: '#000000', opacity: 0.8
      });
    }

    var sources = data.sources || [];
    for (var i = 0; i < sources.length; i++) {
      var seat = sources[i];
      if (!seat || !seat.pos) continue;
      var pos = new RoomPosition(seat.pos.x, seat.pos.y, remoteName);
      var status = seat.occupant ? 'OCC' : 'FREE';
      if (!seat.occupant && seat.queue && seat.queue.length) status = 'QUE';
      var ttl = seat.ttl != null ? seat.ttl : '-';
      var label = status + ' (' + ttl + ')';
      visual.text(label, pos.x, pos.y - 0.8, { align: 'center', color: '#ffffff', font: 0.5, stroke: '#000000' });
      if (seat.containerFill != null) {
        var pct = Math.floor(seat.containerFill * 100);
        visual.text('C:' + pct + '%', pos.x, pos.y - 1.5, { align: 'center', color: '#ffd966', font: 0.4, stroke: '#000000' });
      }
    }
  }
};

BeeVisuals.drawWorldOverview = function () {
  // Throttle — treat 0/false as "disabled"
  var mod = CFG.worldDrawModulo | 0;
  if (mod <= 0) return;
  if ((Game.time % mod) !== 0) return;

  var mv = Game.map.visual; // MapVisual

  // 1) Source flags on the world map (any room, no vision required)
  var drawn = 0;
  for (var fname in Game.flags) {
    if (!Game.flags.hasOwnProperty(fname)) continue;
    if (fname.indexOf('SRC-') !== 0) continue; // your source-flag prefix
    var f = Game.flags[fname];

    // A visible yellow ring + small center dot
    mv.circle(f.pos, { radius: 5.0, fill: 'transparent', stroke: '#ffd54f', opacity: 0.9, strokeWidth: 0.8 });
    mv.circle(f.pos, { radius: 0.9, fill: '#ffd54f', opacity: 0.9 });

    drawn++;
    if (drawn >= CFG.worldMaxFlagMarkers) break;
  }

  // 2) Planned construction (roads) on the world map.
  //    Uses the same Memory.rooms[*].roadPlanner.paths you already render in-room.
  var tiles = 0;
  if (Memory.rooms) {
    for (var rn in Memory.rooms) {
      if (!Memory.rooms.hasOwnProperty(rn)) continue;
      var rm = Memory.rooms[rn];
      if (!rm || !rm.roadPlanner || !rm.roadPlanner.paths) continue;

      var paths = rm.roadPlanner.paths;
      for (var key in paths) {
        if (!paths.hasOwnProperty(key)) continue;
        var rec = paths[key];
        if (!rec || !rec.path || !rec.path.length) continue;

        for (var i = 0; i < rec.path.length; i++) {
          var step = rec.path[i];
          var pos = new RoomPosition(step.x | 0, step.y | 0, step.roomName || rn);

          // amber dot per planned tile
          mv.circle(pos, { radius: 0.8, fill: '#ffe066', opacity: 0.6, stroke: undefined });

          tiles++;
          if (tiles >= CFG.worldMaxPlannedTiles) return; // stop early if we hit our cap
        }
      }
    }
  }

  // (Optional) If you ever want to draw lines between rooms:
  // Game.map.visual.connectRooms('W38S47', 'W39S47', { color: '#66ccff', width: 1, opacity: 0.4 });
};

function _drawRemoteLegend(ctx, opts) {
  if (!ctx || !opts || opts.showLegend === false) return;
  var remaining = ctx.budget - ctx.usedBudget;
  if (remaining <= 4) return;
  var palette = ctx.palette;
  var baseX = 1;
  var baseY = 47.5;
  var fontSize = 0.45;
  _drawRect(ctx, baseX - 0.2, baseY - 0.4, 6, 1.6, { fill: '#000000', opacity: 0.25, stroke: '#000000', strokeWidth: 0.05 });
  _drawText(ctx, 'Legend:', baseX, baseY + 0.1, { align: 'left', color: palette.legendText, font: fontSize, stroke: palette.legendShadow, opacity: 0.9 });
  _drawText(ctx, 'OK/DEG/BLOCK', baseX, baseY - 0.5, { align: 'left', color: palette.legendText, font: fontSize, stroke: palette.legendShadow, opacity: 0.9 });
  _drawText(ctx, 'Seat FREE/OCC/QUE', baseX + 2.6, baseY + 0.1, { align: 'left', color: palette.legendText, font: fontSize, stroke: palette.legendShadow, opacity: 0.9 });
  _drawText(ctx, 'Fill%', baseX + 4.6, baseY - 0.5, { align: 'left', color: palette.legendText, font: fontSize, stroke: palette.legendShadow, opacity: 0.9 });
}

function _drawContainerBar(ctx, x, y, pct) {
  var palette = ctx.palette;
  var width = 1.4;
  var height = 0.08;
  var clamped = pct;
  if (clamped == null) clamped = 0;
  if (clamped < 0) clamped = 0;
  if (clamped > 1) clamped = 1;
  _drawRect(ctx, x - width / 2, y, width, height, { fill: palette.barBg, opacity: 0.45, stroke: undefined });
  if (clamped > 0) {
    _drawRect(ctx, x - width / 2, y, width * clamped, height, { fill: palette.barFill, opacity: 0.7, stroke: undefined });
  }
}

function _drawReserverLabel(ctx, pos, reserver, palette) {
  if (!ctx || !reserver) return;
  var ttl = reserver.ttl != null ? reserver.ttl : 0;
  var refresh = reserver.refreshAt != null ? reserver.refreshAt : 0;
  var color = palette.reserverGood;
  if (ttl <= refresh) color = palette.reserverWarn;
  if (ttl <= Math.max(0, refresh - 400)) color = palette.reserverFail;
  var text = 'RESV ' + ttl + 's';
  _drawText(ctx, text, pos.x, pos.y, { align: 'center', color: color, font: 0.6, stroke: '#000000', opacity: 0.9 });
}

function _remoteRouteTarget(sourcePos) {
  if (!sourcePos) return null;
  var edge = { x: sourcePos.x, y: 0, roomName: sourcePos.roomName };
  if (sourcePos.y < 25) edge.y = 1;
  else if (sourcePos.y > 25) edge.y = 48;
  if (sourcePos.x < 25) edge.x = 1;
  else if (sourcePos.x > 25) edge.x = 48;
  return edge;
}

function _drawRemoteRoutes(ctx, source, haulers, opts) {
  if (!ctx || !source || !opts || opts.showPaths === false) return;
  if (ctx.usedBudget >= ctx.budget) return;
  if (!source.containerPos && !source.containerId) return;
  var containerPos = source.containerPos;
  if (!containerPos && source.containerId) {
    var obj = Game.getObjectById(source.containerId);
    if (obj && obj.pos) containerPos = obj.pos;
  }
  if (!containerPos) return;
  var target = _remoteRouteTarget(containerPos);
  if (!target) return;
  var points = [
    { x: containerPos.x, y: containerPos.y },
    { x: target.x, y: target.y }
  ];
  if (!_drawPoly(ctx, points, { stroke: ctx.palette.pathStroke, opacity: 0.35, width: 0.08 })) return;
  var midX = (containerPos.x + target.x) / 2;
  var midY = (containerPos.y + target.y) / 2;
  var eta = haulers && haulers.avgEtaTicks != null ? haulers.avgEtaTicks : 0;
  var load = haulers && haulers.avgLoadPct != null ? haulers.avgLoadPct : 0;
  var label = _formatRouteLabel(eta, load);
  _drawText(ctx, label, midX, midY, { align: 'center', color: ctx.palette.pathLabel, font: 0.4, stroke: '#000000', opacity: 0.85 });
}

function _drawRemoteSources(ctx, ledger, roomName) {
  if (!ctx || !ledger || !ledger.sources) return;
  for (var i = 0; i < ledger.sources.length; i++) {
    if (ctx.usedBudget >= ctx.budget) break;
    var source = ledger.sources[i];
    if (!source || !source.pos) continue;
    if (source.pos.roomName !== roomName) continue;
    var anchorX = source.pos.x + 1;
    var anchorY = source.pos.y - 0.5;
    var line1 = _formatSourceLine1(source);
    var color = ctx.palette.seatFree;
    if (source.seatState === 'OCCUPIED') color = ctx.palette.seatOccupied;
    else if (source.seatState === 'QUEUED') color = ctx.palette.seatQueued;
    _drawText(ctx, line1, anchorX, anchorY, { align: 'left', color: color, font: 0.45, stroke: '#000000', opacity: 0.9 });
    var line2 = _formatSourceLine2(source);
    _drawText(ctx, line2, anchorX, anchorY - 0.5, { align: 'left', color: ctx.palette.subText, font: 0.42, stroke: '#000000', opacity: 0.8 });
    _drawContainerBar(ctx, anchorX + 1.1, anchorY - 0.9, source.containerFill != null ? source.containerFill : 0);
  }
}

BeeVisuals.drawRemoteHUD = function (roomName, ledger, opts) {
  var result = { usedBudget: 0 };
  if (!roomName || !ledger) return result;
  opts = opts || {};
  var remoteRoom = Game.rooms[roomName];
  var targetRoomName = remoteRoom ? roomName : (opts.ownerRoomName || ledger.homeName || ledger.home || roomName);
  if (!targetRoomName) return result;
  var ctx = _createHudContext(targetRoomName, opts);
  var anchor = opts.anchor || { x: 1, y: 1 };
  if (remoteRoom) {
    anchor = { x: 1, y: 1 };
  }
  var header = _formatRemoteHeader(ledger);
  var headerColor = _statusToColor(ctx.palette, ledger.status);
  _drawText(ctx, header, anchor.x, anchor.y, { align: 'left', color: headerColor, font: 0.6, stroke: ctx.palette.headerShadow, opacity: 0.95 });
  if (remoteRoom) {
    var allowDetails = ledger.status !== 'BLOCKED' && ledger.status !== 'ROUTEFAIL';
    if (allowDetails) {
      _drawRemoteSources(ctx, ledger, roomName);
    }
    if (remoteRoom.controller) {
      _drawReserverLabel(ctx, { x: remoteRoom.controller.pos.x, y: remoteRoom.controller.pos.y - 1 }, ledger.reserver, ctx.palette);
    } else if (opts.anchor) {
      var fallback = { x: opts.anchor.x, y: opts.anchor.y + 1 };
      _drawReserverLabel(ctx, fallback, ledger.reserver, ctx.palette);
    }
    if (allowDetails && opts.showPaths !== false && ctx.usedBudget < ctx.budget) {
      for (var si = 0; si < ledger.sources.length; si++) {
        if (ctx.usedBudget >= ctx.budget) break;
        _drawRemoteRoutes(ctx, ledger.sources[si], ledger.haulers, opts);
      }
    }
    if (ctx.usedBudget < ctx.budget) {
      _drawRemoteLegend(ctx, opts);
    }
  }
  result.usedBudget = ctx.usedBudget;
  return result;
};

function _formatBaseSeatLine(seat) {
  if (!seat) return '';
  var state = seat.seatState || 'FREE';
  var ttl = seat.minerTtl != null ? seat.minerTtl : 0;
  var pct = seat.containerFill != null ? Math.round(Math.max(0, Math.min(1, seat.containerFill)) * 100) : 0;
  return 'BaseSeat: ' + state + ' (TTL ' + ttl + ') | C: ' + pct + '%';
}

function _drawBaseSeatChip(ctx, seat, opts) {
  if (!ctx || !seat || !seat.pos) return;
  var anchorX = seat.pos.x + 1;
  var anchorY = seat.pos.y - 0.4;
  var color = ctx.palette.seatFree;
  if (seat.seatState === 'OCCUPIED') color = ctx.palette.seatOccupied;
  else if (seat.seatState === 'QUEUED') color = ctx.palette.seatQueued;
  var text = _formatBaseSeatLine(seat);
  _drawText(ctx, text, anchorX, anchorY, { align: 'left', color: color, font: 0.45, stroke: '#000000', opacity: 0.95 });
  if (seat.queuedMiner) {
    _drawText(ctx, 'handoff ...', anchorX, anchorY - 0.5, { align: 'left', color: ctx.palette.subText, font: 0.42, stroke: '#000000', opacity: 0.85 });
  }
  if (seat.contestedUntilTick && seat.contestedUntilTick > Game.time) {
    var remain = seat.contestedUntilTick - Game.time;
    _drawText(ctx, 'contested ' + remain + 't', anchorX, anchorY - 1, { align: 'left', color: ctx.palette.contested, font: 0.42, stroke: '#000000', opacity: 0.85 });
  }
  _drawContainerBar(ctx, anchorX + 1.1, anchorY - 0.85, seat.containerFill != null ? seat.containerFill : 0);
}

function _ensureBasePathCache() {
  var cache = global.__baseSeatPathCache;
  if (!cache || cache.tick !== Game.time) {
    cache = { tick: Game.time, paths: {} };
    global.__baseSeatPathCache = cache;
  }
  return cache;
}

function _getSeatPath(roomName, seatPos) {
  if (!roomName || !seatPos) return null;
  var cache = _ensureBasePathCache();
  var key = roomName + ':' + seatPos.x + ':' + seatPos.y;
  if (cache.paths[key]) return cache.paths[key];
  var room = Game.rooms[roomName];
  if (!room) return null;
  var spawns = room.find(FIND_MY_SPAWNS) || [];
  if (!spawns.length) return null;
  var target = spawns[0].pos;
  var path = room.findPath(new RoomPosition(seatPos.x, seatPos.y, roomName), target, { maxOps: 200, ignoreCreeps: true });
  cache.paths[key] = path;
  return path;
}

function _drawSeatPath(ctx, roomName, seat, opts) {
  if (!ctx || !seat || !seat.pos || !opts || opts.showPaths !== true) return;
  if (ctx.usedBudget >= ctx.budget) return;
  var path = _getSeatPath(roomName, seat.pos);
  if (!path || !path.length) return;
  var limit = Math.min(path.length, 12);
  var points = [{ x: seat.pos.x, y: seat.pos.y }];
  for (var i = 0; i < limit; i++) {
    var step = path[i];
    if (!step) break;
    points.push({ x: step.x, y: step.y });
  }
  if (!_drawPoly(ctx, points, { stroke: ctx.palette.pathStroke, opacity: 0.25, width: 0.06 })) return;
  for (var j = 5; j < limit; j += 5) {
    var mark = path[j];
    if (!mark) continue;
    _drawText(ctx, '+', mark.x, mark.y, { align: 'center', color: ctx.palette.pathLabel, font: 0.4, stroke: '#000000', opacity: 0.8 });
  }
}

BeeVisuals.drawBaseHarvestHUD = function (roomName, seats, opts) {
  var result = { usedBudget: 0 };
  if (!roomName) return result;
  seats = seats || [];
  opts = opts || {};
  var ctx = _createHudContext(roomName, opts);
  for (var i = 0; i < seats.length; i++) {
    if (ctx.usedBudget >= ctx.budget) break;
    _drawBaseSeatChip(ctx, seats[i], opts);
    _drawSeatPath(ctx, roomName, seats[i], opts);
  }
  result.usedBudget = ctx.usedBudget;
  return result;
};

BeeVisuals.clearRoomHUD = function (roomName) {
  if (!roomName) return;
  var visual = new RoomVisual(roomName);
  if (visual && typeof visual.clear === 'function') {
    visual.clear();
  }
};

module.exports = BeeVisuals;
