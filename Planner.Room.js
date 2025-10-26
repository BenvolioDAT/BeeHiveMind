'use strict';

var RoadPlanner = require('Planner.Road');
var BeeToolbox = require('BeeToolbox');

var CFG = {
  MAX_SITES_PER_TICK: 5
};

function _logExtensionPlanning(room, info) {
  if (!Memory || !Memory.__traceExtensions) return;
  if (!room || !info) return;
  var gates = info.gates || {};
  var text = 'EXT-PLAN ' + room.name;
  text += ' rcl=' + info.rcl;
  text += ' allowed=' + info.allowed;
  text += ' existing=' + info.existing;
  text += ' sites=' + info.sites;
  text += ' action=' + info.action;
  if (info.rc != null) {
    text += ' rc=' + info.rc;
  }
  text += ' gates=' + JSON.stringify(gates);
  console.log(text);
}

// RCL Milestone Checklist (consumed by Task.Builder and remote throttles):
// RCL1: online spawn with hub↔source and hub↔controller roads so harvesters never slog.
// RCL2: finish the first extension block to unlock bigger worker bodies and stable economy.
// RCL3: complete Extension Block A before touching side projects for tier upgrades.
// RCL4: drop tower #1, place storage (hub anchor), then finish Extension Block B and hub roads.
// RCL5: add source↔hub links plus controller↔hub link once extension blocks are filled.
// RCL6: raise additional towers as allowed and prep terminal infrastructure.
// RCL7-8: reserve lab, factory, observer, powerSpawn, and nuker stamps for late-tech builds.
// Rule: NO remote buildout until storage energy beats ECON_CFG and home milestones for the current RCL are satisfied.

var HUB_STAMP = [
  { key: 'storage',      type: STRUCTURE_STORAGE,   dx: 0,  dy: 0,  rcl: 4, priority: 5 },
  { key: 'terminal',     type: STRUCTURE_TERMINAL,  dx: 1,  dy: 0,  rcl: 6, priority: 8 },
  { key: 'factory',      type: STRUCTURE_FACTORY,   dx: -1, dy: 0,  rcl: 7, priority: 9 },
  { key: 'powerSpawn',   type: STRUCTURE_POWER_SPAWN, dx: 0, dy: 1, rcl: 8, priority: 10 },
  { key: 'nuker',        type: STRUCTURE_NUKER,     dx: 1,  dy: 1,  rcl: 8, priority: 11 },
  { key: 'tower_core',   type: STRUCTURE_TOWER,     dx: 0,  dy: -2, rcl: 4, priority: 4 },
  { key: 'tower_west',   type: STRUCTURE_TOWER,     dx: -2, dy: -2, rcl: 6, priority: 7 },
  { key: 'lab_1',        type: STRUCTURE_LAB,       dx: 2,  dy: 1,  rcl: 6, priority: 12 },
  { key: 'lab_2',        type: STRUCTURE_LAB,       dx: 2,  dy: 2,  rcl: 6, priority: 12 },
  { key: 'lab_3',        type: STRUCTURE_LAB,       dx: 1,  dy: 2,  rcl: 6, priority: 12 },
  { key: 'observer',     type: STRUCTURE_OBSERVER,  dx: -2, dy: 2,  rcl: 8, priority: 13 }
];

var EXTENSION_BLOCKS = [
  { key: 'extA', rcl: 3, offsets: [
    {dx: 2, dy: 0}, {dx: -2, dy: 0}, {dx: 0, dy: 2}, {dx: 0, dy: -2}, {dx: 2, dy: 1},
    {dx: 1, dy: 2}, {dx: -1, dy: 2}, {dx: -2, dy: 1}, {dx: 2, dy: -1}, {dx: 1, dy: -2}
  ] },
  { key: 'extB', rcl: 4, offsets: [
    {dx: -1, dy: -2}, {dx: -2, dy: -1}, {dx: -2, dy: -2}, {dx: 3, dy: 0}, {dx: -3, dy: 0},
    {dx: 0, dy: 3}, {dx: 0, dy: -3}, {dx: 3, dy: 1}, {dx: 1, dy: 3}, {dx: -1, dy: 3}
  ] },
  { key: 'extC', rcl: 5, offsets: [
    {dx: -3, dy: -1}, {dx: -3, dy: 1}, {dx: 3, dy: -1}, {dx: 3, dy: 1}, {dx: 2, dy: 3},
    {dx: -2, dy: 3}, {dx: -3, dy: 2}, {dx: 3, dy: 2}, {dx: 2, dy: -3}, {dx: -2, dy: -3}
  ] },
  { key: 'extD', rcl: 6, offsets: [
    {dx: 4, dy: 0}, {dx: -4, dy: 0}, {dx: 4, dy: 1}, {dx: 4, dy: -1}, {dx: -4, dy: 1},
    {dx: -4, dy: -1}, {dx: 1, dy: 4}, {dx: -1, dy: 4}, {dx: 1, dy: -4}, {dx: -1, dy: -4}
  ] }
];

var HUB_ROAD_RING = [
  {dx: 0, dy: -1}, {dx: 1, dy: -1}, {dx: 1, dy: 0}, {dx: 1, dy: 1},
  {dx: 0, dy: 1}, {dx: -1, dy: 1}, {dx: -1, dy: 0}, {dx: -1, dy: -1}
];

if (!global.__ROOM_PLAN_CACHE) {
  global.__ROOM_PLAN_CACHE = { tick: -1, plans: {} };
}

function _apply(anchor, offset) {
  return new RoomPosition(anchor.x + offset.dx, anchor.y + offset.dy, anchor.roomName);
}

function _inBounds(pos) {
  return pos.x > 1 && pos.x < 48 && pos.y > 1 && pos.y < 48;
}

function _structureState(room) {
  var state = { built: {}, sites: {} };
  var structs = room.find(FIND_STRUCTURES);
  for (var i = 0; i < structs.length; i++) {
    var s = structs[i];
    if (!state.built[s.structureType]) state.built[s.structureType] = [];
    state.built[s.structureType].push(s.pos);
  }
  var sites = room.find(FIND_CONSTRUCTION_SITES);
  for (var j = 0; j < sites.length; j++) {
    var cs = sites[j];
    if (!state.sites[cs.structureType]) state.sites[cs.structureType] = [];
    state.sites[cs.structureType].push(cs.pos);
  }
  return state;
}

function _hasStructureOrSite(state, type, pos) {
  var arr = state.built[type] || [];
  for (var i = 0; i < arr.length; i++) {
    var p = arr[i];
    if (p.x === pos.x && p.y === pos.y && p.roomName === pos.roomName) return true;
  }
  arr = state.sites[type] || [];
  for (var j = 0; j < arr.length; j++) {
    var p2 = arr[j];
    if (p2.x === pos.x && p2.y === pos.y && p2.roomName === pos.roomName) return true;
  }
  return false;
}

function _hasRoad(room, state, pos) {
  var built = state.built[STRUCTURE_ROAD] || [];
  for (var i = 0; i < built.length; i++) {
    var p = built[i];
    if (p.x === pos.x && p.y === pos.y && p.roomName === pos.roomName) return true;
  }
  var sites = state.sites[STRUCTURE_ROAD] || [];
  for (var j = 0; j < sites.length; j++) {
    var ps = sites[j];
    if (ps.x === pos.x && ps.y === pos.y && ps.roomName === pos.roomName) return true;
  }
  return false;
}

function _planHubStructures(room, anchor) {
  var planned = [];
  for (var i = 0; i < HUB_STAMP.length; i++) {
    var entry = HUB_STAMP[i];
    var pos = _apply(anchor, entry);
    if (!_inBounds(pos)) continue;
    planned.push({
      key: entry.key,
      type: entry.type,
      pos: pos,
      rcl: entry.rcl,
      priority: entry.priority || 10,
      category: 'hub'
    });
  }
  return planned;
}

function _planExtensions(anchor) {
  var list = [];
  for (var i = 0; i < EXTENSION_BLOCKS.length; i++) {
    var block = EXTENSION_BLOCKS[i];
    for (var j = 0; j < block.offsets.length; j++) {
      var pos = _apply(anchor, block.offsets[j]);
      if (!_inBounds(pos)) continue;
      list.push({
        key: block.key + ':' + j,
        type: STRUCTURE_EXTENSION,
        pos: pos,
        rcl: block.rcl,
        priority: block.rcl,
        category: 'extension',
        group: block.key
      });
    }
  }
  return list;
}

function _chooseWalkable(room, center, preferList) {
  var terrain = room.getTerrain();
  var options = preferList || [];
  for (var i = 0; i < options.length; i++) {
    var off = options[i];
    var x = center.x + off.dx;
    var y = center.y + off.dy;
    if (x <= 0 || x >= 49 || y <= 0 || y >= 49) continue;
    if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
    return new RoomPosition(x, y, center.roomName);
  }
  for (var dx = -2; dx <= 2; dx++) {
    for (var dy = -2; dy <= 2; dy++) {
      if (dx === 0 && dy === 0) continue;
      var nx = center.x + dx;
      var ny = center.y + dy;
      if (nx <= 0 || nx >= 49 || ny <= 0 || ny >= 49) continue;
      if (terrain.get(nx, ny) === TERRAIN_MASK_WALL) continue;
      return new RoomPosition(nx, ny, center.roomName);
    }
  }
  return null;
}

function _planLinks(room, hubPos) {
  var list = [];
  var hubLink = _chooseWalkable(room, hubPos, [
    {dx: -1, dy: -1}, {dx: 1, dy: -1}, {dx: -1, dy: 1}, {dx: 1, dy: 1},
    {dx: 0, dy: -1}, {dx: 0, dy: 1}
  ]);
  if (hubLink) {
    list.push({
      key: 'link:hub',
      type: STRUCTURE_LINK,
      pos: hubLink,
      rcl: 5,
      priority: 6,
      category: 'link'
    });
  }

  if (room.controller) {
    var ctrlLink = _chooseWalkable(room, room.controller.pos, [
      {dx: 1, dy: 0}, {dx: -1, dy: 0}, {dx: 0, dy: 1}, {dx: 0, dy: -1},
      {dx: 1, dy: 1}, {dx: -1, dy: 1}, {dx: 1, dy: -1}, {dx: -1, dy: -1}
    ]);
    if (ctrlLink) {
      list.push({
        key: 'link:controller',
        type: STRUCTURE_LINK,
        pos: ctrlLink,
        rcl: 5,
        priority: 6,
        category: 'link'
      });
    }
  }
  return list;
}

function _planSourceContainers(room) {
  var list = [];
  var sources = room.find(FIND_SOURCES);
  var terrain = room.getTerrain();
  for (var i = 0; i < sources.length; i++) {
    var src = sources[i];
    var best = null;
    for (var dx = -1; dx <= 1; dx++) {
      for (var dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dy === 0) continue;
        var x = src.pos.x + dx;
        var y = src.pos.y + dy;
        if (x <= 0 || x >= 49 || y <= 0 || y >= 49) continue;
        if (terrain.get(x, y) === TERRAIN_MASK_WALL) continue;
        var score = Math.abs(dx) + Math.abs(dy);
        if (!best || score < best.score) {
          best = { x: x, y: y, score: score };
        }
      }
    }
    if (!best) continue;
    list.push({
      key: 'src:' + src.id,
      type: STRUCTURE_CONTAINER,
      pos: new RoomPosition(best.x, best.y, room.name),
      rcl: 2,
      priority: 3,
      category: 'container',
      sourceId: src.id
    });
  }
  var minerals = room.find(FIND_MINERALS);
  if (minerals.length) {
    var min = minerals[0];
    var bestMin = null;
    for (var dx2 = -1; dx2 <= 1; dx2++) {
      for (var dy2 = -1; dy2 <= 1; dy2++) {
        if (dx2 === 0 && dy2 === 0) continue;
        var mx = min.pos.x + dx2;
        var my = min.pos.y + dy2;
        if (mx <= 0 || mx >= 49 || my <= 0 || my >= 49) continue;
        if (terrain.get(mx, my) === TERRAIN_MASK_WALL) continue;
        var scoreMin = Math.abs(dx2) + Math.abs(dy2);
        if (!bestMin || scoreMin < bestMin.score) {
          bestMin = { x: mx, y: my, score: scoreMin };
        }
      }
    }
    if (bestMin) {
      list.push({
        key: 'mineral:' + min.id,
        type: STRUCTURE_CONTAINER,
        pos: new RoomPosition(bestMin.x, bestMin.y, room.name),
        rcl: 5,
        priority: 7,
        category: 'container'
      });
    }
  }
  return list;
}

function _planControllerRing(room) {
  if (!room.controller) return [];
  var tiles = [];
  var ctrl = room.controller;
  for (var dx = -1; dx <= 1; dx++) {
    for (var dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      var x = ctrl.pos.x + dx;
      var y = ctrl.pos.y + dy;
      if (x <= 0 || x >= 49 || y <= 0 || y >= 49) continue;
      tiles.push({ x: x, y: y, roomName: room.name });
    }
  }
  return tiles;
}

function _planRoadGraph(room, hubPos, state) {
  var graph = {};
  var sources = room.find(FIND_SOURCES);
  var terrain = room.getTerrain();

  for (var i = 0; i < sources.length; i++) {
    var src = sources[i];
    var key = 'hub:source:' + src.id;
    var path = RoadPlanner.getOrCreatePath(hubPos, src.pos, { label: key, range: 1 });
    if (path && path.length) {
      graph[key] = {
        key: key,
        from: hubPos,
        to: src.pos,
        path: path,
        missing: _missingRoadTiles(room, state, path, terrain),
        category: 'critical'
      };
    }
  }

  if (room.controller) {
    var keyCtrl = 'hub:controller';
    var ctrlPath = RoadPlanner.getOrCreatePath(hubPos, room.controller.pos, { label: keyCtrl, range: 1 });
    if (ctrlPath && ctrlPath.length) {
      graph[keyCtrl] = {
        key: keyCtrl,
        from: hubPos,
        to: room.controller.pos,
        path: ctrlPath,
        missing: _missingRoadTiles(room, state, ctrlPath, terrain),
        category: 'critical'
      };
    }
  }

  var minerals = room.find(FIND_MINERALS);
  if (minerals.length) {
    var minKey = 'hub:mineral';
    var minPath = RoadPlanner.getOrCreatePath(hubPos, minerals[0].pos, { label: minKey, range: 1 });
    if (minPath && minPath.length) {
      graph[minKey] = {
        key: minKey,
        from: hubPos,
        to: minerals[0].pos,
        path: minPath,
        missing: _missingRoadTiles(room, state, minPath, terrain),
        category: 'support'
      };
    }
  }

  var hubRing = [];
  for (var r = 0; r < HUB_ROAD_RING.length; r++) {
    var rp = _apply(hubPos, HUB_ROAD_RING[r]);
    if (!_inBounds(rp)) continue;
    hubRing.push({ x: rp.x, y: rp.y, roomName: rp.roomName });
  }
  graph['hub:ring'] = {
    key: 'hub:ring',
    from: hubPos,
    to: hubPos,
    path: hubRing,
    missing: _missingRoadTiles(room, state, hubRing, terrain),
    category: 'hub'
  };

  return graph;
}

function _missingRoadTiles(room, state, path, terrain) {
  var missing = [];
  for (var i = 0; i < path.length; i++) {
    var step = path[i];
    if (terrain.get(step.x, step.y) === TERRAIN_MASK_WALL) continue;
    if (!_hasRoad(room, state, step)) {
      missing.push(step);
    }
  }
  return missing;
}

function _collectNeeds(structPlan, roadGraph, state, rcl) {
  var needs = [];
  for (var i = 0; i < structPlan.length; i++) {
    var task = structPlan[i];
    if (task.rcl > rcl) continue;
    if (_hasStructureOrSite(state, task.type, task.pos)) continue;
    needs.push(task);
  }
  for (var key in roadGraph) {
    if (!BeeToolbox.hasOwn(roadGraph, key)) continue;
    var edge = roadGraph[key];
    if (edge.category === 'critical' && rcl >= 2) {
      for (var j = 0; j < edge.missing.length; j++) {
        needs.push({
          key: key + ':road:' + j,
          type: STRUCTURE_ROAD,
          pos: edge.missing[j],
          rcl: 2,
          priority: 2,
          category: 'road'
        });
      }
    }
    if (edge.key === 'hub:ring' && rcl >= 4) {
      for (var k = 0; k < edge.missing.length; k++) {
        needs.push({
          key: key + ':road:' + k,
          type: STRUCTURE_ROAD,
          pos: edge.missing[k],
          rcl: 4,
          priority: 5,
          category: 'road'
        });
      }
    }
  }
  return needs;
}

function _readyForRemotes(structPlan, state) {
  var storageReady = false;
  var towerReady = false;
  var extBlockA = true;
  var extBlockB = true;
  for (var i = 0; i < structPlan.length; i++) {
    var task = structPlan[i];
    if (task.type === STRUCTURE_STORAGE) {
      if (_hasStructureOrSite(state, task.type, task.pos)) storageReady = true;
    }
    if (task.key && task.key.indexOf('tower') === 0 && task.rcl <= 4) {
      if (_hasStructureOrSite(state, task.type, task.pos)) towerReady = true;
    }
    if (task.group === 'extA') {
      if (!_hasStructureOrSite(state, task.type, task.pos)) extBlockA = false;
    }
    if (task.group === 'extB') {
      if (!_hasStructureOrSite(state, task.type, task.pos)) extBlockB = false;
    }
  }
  return storageReady && towerReady && extBlockA && extBlockB;
}

function planRoom(room) {
  if (!room || !room.controller || !room.controller.my) return null;
  var cache = global.__ROOM_PLAN_CACHE;
  if (cache.tick === Game.time && cache.plans[room.name]) {
    return cache.plans[room.name];
  }

  var hubPos = RoadPlanner.computeHub(room);
  if (!hubPos) return null;

  var state = _structureState(room);
  var hubStructs = _planHubStructures(room, hubPos);
  var extensions = _planExtensions(hubPos);
  var containers = _planSourceContainers(room);
  var links = _planLinks(room, hubPos);
  var structPlan = hubStructs.concat(extensions).concat(containers).concat(links);

  var roadGraph = _planRoadGraph(room, hubPos, state);
  var needsByRCL = {};
  var maxRCL = room.controller.level || 1;
  for (var r = 1; r <= maxRCL; r++) {
    needsByRCL[r] = _collectNeeds(structPlan, roadGraph, state, r);
  }

  var plan = {
    roomName: room.name,
    anchor: hubPos,
    hub: hubPos,
    structures: structPlan,
    roads: roadGraph,
    needsByRCL: needsByRCL,
    readyForRemotes: _readyForRemotes(structPlan, state)
  };

  cache.tick = Game.time;
  cache.plans[room.name] = plan;
  return plan;
}

function _taskPriority(task) {
  if (!task) return 0;
  if (task.type === STRUCTURE_STORAGE) return 120;
  if (task.type === STRUCTURE_SPAWN) return 118;
  if (task.category === 'road') {
    return 1;
  }
  if (task.category === 'extension') {
    if (task.group === 'extA') return 114;
    if (task.group === 'extB') return 113;
    if (task.group === 'extC') return 111;
    if (task.group === 'extD') return 109;
    return 105;
  }
  if (task.type === STRUCTURE_TOWER) return 108;
  if (task.category === 'container') return 106;
  if (task.category === 'link') return 104;
  if (task.category === 'hub') return 80 - (task.priority || 0);
  return 10;
}

function ensureSites(room) {
  if (!room || !room.controller || !room.controller.my) return;
  var plan = planRoom(room);
  if (!plan) {
    if (Memory && Memory.__traceExtensions) {
      var currentLevel = room.controller.level || 1;
      var allowedIfAny = 0;
      if (typeof CONTROLLER_STRUCTURES === 'object' && CONTROLLER_STRUCTURES && CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION]) {
        allowedIfAny = CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION][currentLevel] || 0;
      }
      var builtCount = (room.find(FIND_MY_STRUCTURES, { filter: { structureType: STRUCTURE_EXTENSION } }) || []).length;
      var siteCount = (room.find(FIND_CONSTRUCTION_SITES, { filter: { structureType: STRUCTURE_EXTENSION } }) || []).length;
      _logExtensionPlanning(room, {
        rcl: currentLevel,
        allowed: allowedIfAny,
        existing: builtCount,
        sites: siteCount,
        action: 'skip-no-plan',
        rc: null,
        gates: { hasPlan: false }
      });
    }
    return;
  }

  var state = _structureState(room);
  var currentRCL = room.controller.level || 1;
  var extExisting = (state.built[STRUCTURE_EXTENSION] || []).length;
  var extSites = (state.sites[STRUCTURE_EXTENSION] || []).length;
  var extAllowed = 0;
  if (typeof CONTROLLER_STRUCTURES === 'object' && CONTROLLER_STRUCTURES && CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION]) {
    extAllowed = CONTROLLER_STRUCTURES[STRUCTURE_EXTENSION][currentRCL] || 0;
  }
  var tasks = [];
  for (var r = 1; r <= currentRCL; r++) {
    var needList = plan.needsByRCL[r] || [];
    for (var n = 0; n < needList.length; n++) {
      tasks.push(needList[n]);
    }
  }

  tasks.sort(function (a, b) {
    var pa = _taskPriority(a);
    var pb = _taskPriority(b);
    if (pa !== pb) return pb - pa;
    if (a.rcl !== b.rcl) return a.rcl - b.rcl;
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    return a.key < b.key ? -1 : 1;
  });

  var extensionTaskCount = 0;
  for (var pre = 0; pre < tasks.length; pre++) {
    if (tasks[pre].type === STRUCTURE_EXTENSION) {
      extensionTaskCount++;
    }
  }

  var placed = 0;
  var extensionLogs = 0;
  for (var i = 0; i < tasks.length && placed < CFG.MAX_SITES_PER_TICK; i++) {
    var task = tasks[i];
    var alreadyPresent = _hasStructureOrSite(state, task.type, task.pos);
    if (task.type === STRUCTURE_EXTENSION && Memory && Memory.__traceExtensions) {
      var gates = {
        hasPlan: true,
        hasAnchor: !!(plan && plan.anchor),
        tasksAvailable: extensionTaskCount > 0,
        underCap: (extExisting + extSites) < extAllowed,
        maxSitesAvailable: placed < CFG.MAX_SITES_PER_TICK,
        alreadyPresent: alreadyPresent
      };
      if (alreadyPresent) {
        _logExtensionPlanning(room, {
          rcl: currentRCL,
          allowed: extAllowed,
          existing: extExisting,
          sites: extSites,
          action: 'skip-existing',
          rc: null,
          gates: gates
        });
        extensionLogs++;
      }
    }
    if (alreadyPresent) continue;
    if (task.type === STRUCTURE_ROAD) {
      var stubPath = [];
      if (task.pos) {
        stubPath.push({ x: task.pos.x, y: task.pos.y, roomName: task.pos.roomName });
      }
      if (stubPath.length) {
        var created = RoadPlanner.materializePath(stubPath, { maxSites: 1, dirtyKey: task.key, roomName: room.name });
        if (created > 0) {
          placed += created;
        }
      }
      continue;
    }
    var rc = room.createConstructionSite(task.pos.x, task.pos.y, task.type);
    if (rc === OK) {
      placed++;
      if (task.type === STRUCTURE_EXTENSION) {
        extSites++;
      }
    }
    if (task.type === STRUCTURE_EXTENSION && Memory && Memory.__traceExtensions) {
      var gatesAfter = {
        hasPlan: true,
        hasAnchor: !!(plan && plan.anchor),
        tasksAvailable: extensionTaskCount > 0,
        underCap: (extExisting + extSites) < extAllowed,
        maxSitesAvailable: placed < CFG.MAX_SITES_PER_TICK,
        alreadyPresent: false
      };
      _logExtensionPlanning(room, {
        rcl: currentRCL,
        allowed: extAllowed,
        existing: extExisting,
        sites: extSites,
        action: 'attempt',
        rc: rc,
        gates: gatesAfter
      });
      extensionLogs++;
    }
  }

  if (Memory && Memory.__traceExtensions) {
    if (extensionTaskCount === 0 && extAllowed > 0) {
      _logExtensionPlanning(room, {
        rcl: currentRCL,
        allowed: extAllowed,
        existing: extExisting,
        sites: extSites,
        action: 'skip-no-extension-tasks',
        rc: null,
        gates: {
          hasPlan: true,
          hasAnchor: !!(plan && plan.anchor),
          tasksAvailable: false,
          underCap: (extExisting + extSites) < extAllowed,
          maxSitesAvailable: placed < CFG.MAX_SITES_PER_TICK
        }
      });
    } else if (extensionTaskCount > 0 && extensionLogs === 0) {
      _logExtensionPlanning(room, {
        rcl: currentRCL,
        allowed: extAllowed,
        existing: extExisting,
        sites: extSites,
        action: 'skip-max-sites-preempted',
        rc: null,
        gates: {
          hasPlan: true,
          hasAnchor: !!(plan && plan.anchor),
          tasksAvailable: true,
          underCap: (extExisting + extSites) < extAllowed,
          maxSitesAvailable: false
        }
      });
    }
  }

  // Acceptance test: Re-running planners does not increase identical construction sites.
  // Guard by caching plan per tick; ensureSites only tries MAX_SITES_PER_TICK new sites and
  // checks existing state before creation.
}

module.exports = {
  plan: planRoom,
  ensureSites: ensureSites
};
