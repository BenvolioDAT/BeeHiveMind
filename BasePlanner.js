"use strict";

var Logger = require('core.logger');
var BeeToolbox = require('BeeToolbox');

var LOG_LEVEL = Logger.LOG_LEVEL;
var plannerLog = Logger.createLogger('BasePlanner', LOG_LEVEL.BASIC);

var MAX_SITES_PER_TICK = 5;
var FALLBACK_STEPS = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
  { x: 1, y: 1 },
  { x: -1, y: 1 },
  { x: 1, y: -1 },
  { x: -1, y: -1 },
  { x: 2, y: 0 },
  { x: -2, y: 0 },
  { x: 0, y: 2 },
  { x: 0, y: -2 }
];

// Deterministic hub layout expands in rings by controller milestone.
var EXTENSION_OFFSETS = [
  { x: 0, y: 2 }, { x: 0, y: -2 }, { x: 0, y: 3 }, { x: 0, y: -3 },
  { x: -1, y: 3 }, { x: -1, y: -3 }, { x: 1, y: -3 }, { x: 1, y: 3 },
  { x: -1, y: 2 }, { x: -1, y: -2 }, { x: 1, y: 2 }, { x: 1, y: -2 },
  { x: -2, y: -1 }, { x: -2, y: 1 }, { x: 2, y: -1 }, { x: 2, y: 1 },
  { x: -3, y: 1 }, { x: -3, y: -1 }, { x: 3, y: 1 }, { x: 3, y: -1 },
  { x: -3, y: 2 }, { x: -3, y: -2 }, { x: 3, y: 2 }, { x: 3, y: -2 },
  { x: -4, y: 2 }, { x: -4, y: -2 }, { x: 4, y: 2 }, { x: 4, y: -2 },
  { x: 4, y: 3 }, { x: 4, y: -3 }, { x: -4, y: 3 }, { x: -4, y: -3 },
  { x: -4, y: 4 }, { x: -4, y: -4 }, { x: 4, y: 4 }, { x: 4, y: -4 },
  { x: 3, y: 4 }, { x: 3, y: -4 }, { x: -3, y: 4 }, { x: -3, y: -4 },
  { x: -2, y: 4 }, { x: -2, y: -4 }, { x: 2, y: 4 }, { x: 2, y: -4 },
  { x: 2, y: 5 }, { x: 2, y: -5 }, { x: -2, y: -5 }, { x: -2, y: 5 },
  { x: -1, y: -5 }, { x: -1, y: 5 }, { x: 1, y: 5 }, { x: 1, y: -5 },
  { x: 0, y: 5 }, { x: 0, y: -5 }, { x: -4, y: 0 }, { x: 4, y: 0 },
  { x: -5, y: 1 }, { x: -5, y: -1 }, { x: 5, y: 1 }, { x: 5, y: -1 }
];

var ROAD_OFFSETS = [
  { x: 1, y: 1 }, { x: 0, y: 1 }, { x: -1, y: 1 }, { x: -1, y: 0 },
  { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 0 },
  { x: 2, y: 0 }, { x: 3, y: 0 }, { x: -2, y: 0 }, { x: -3, y: 0 },
  { x: -4, y: 1 }, { x: -4, y: -1 }, { x: 4, y: -1 }, { x: 4, y: 1 },
  { x: 2, y: 2 }, { x: 2, y: -2 }, { x: 3, y: -3 }, { x: 3, y: 3 },
  { x: -2, y: 2 }, { x: -2, y: -2 }, { x: -3, y: -3 }, { x: -3, y: 3 },
  { x: -2, y: 3 }, { x: 2, y: 3 }, { x: -2, y: -3 }, { x: 2, y: -3 },
  { x: -1, y: 4 }, { x: 1, y: 4 }, { x: -1, y: -4 }, { x: 1, y: -4 },
  { x: 0, y: 4 }, { x: 0, y: -4 }
];

// Structure milestones per RCL.
var STRUCTURE_RULES = [
  {
    type: STRUCTURE_CONTAINER,
    minRcl: 1,
    comment: 'RCL1 bootstrap drop container near the hub to smooth early harvesting.',
    maxForRcl: function (rcl) {
      if (rcl >= 4) return 3;
      if (rcl >= 2) return 2;
      return 1;
    },
    offsets: [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }]
  },
  {
    type: STRUCTURE_ROAD,
    minRcl: 1,
    comment: 'RCL1 establishes a plus-shaped road core so creeps stop trampling swamp tiles.',
    maxForRcl: function (rcl) {
      if (rcl <= 1) return 8;
      if (rcl <= 3) return 16;
      return ROAD_OFFSETS.length;
    },
    offsets: ROAD_OFFSETS
  },
  {
    type: STRUCTURE_EXTENSION,
    minRcl: 2,
    comment: 'Extensions unlock progressively each RCL to support larger bodies.',
    maxForRcl: function (rcl) {
      return BeeToolbox.getMaxAllowed(STRUCTURE_EXTENSION, rcl);
    },
    offsets: EXTENSION_OFFSETS
  },
  {
    type: STRUCTURE_TOWER,
    minRcl: 3,
    comment: 'Towers appear at RCL3+ for automated defense and repairs.',
    maxForRcl: function (rcl) {
      return BeeToolbox.getMaxAllowed(STRUCTURE_TOWER, rcl);
    },
    offsets: [{ x: -3, y: 0 }, { x: 3, y: 0 }, { x: 0, y: -6 }, { x: 0, y: 6 }, { x: -6, y: 0 }, { x: 6, y: 0 }]
  },
  {
    type: STRUCTURE_STORAGE,
    minRcl: 4,
    comment: 'Storage anchors the mid-game hub once RCL4 is reached.',
    maxForRcl: function () { return 1; },
    offsets: [{ x: 0, y: 0 }]
  },
  {
    type: STRUCTURE_LINK,
    minRcl: 5,
    comment: 'Links come online once remote energy throughput matters (RCL5+).',
    maxForRcl: function (rcl) {
      return BeeToolbox.getMaxAllowed(STRUCTURE_LINK, rcl);
    },
    offsets: [{ x: 2, y: 1 }, { x: -2, y: 1 }, { x: 2, y: -1 }, { x: -2, y: -1 }, { x: 0, y: 4 }, { x: 0, y: -4 }]
  },
  {
    type: STRUCTURE_LAB,
    minRcl: 6,
    comment: 'Lab clusters unlock at RCL6 for mineral and boost operations.',
    maxForRcl: function (rcl) {
      return Math.min(6, BeeToolbox.getMaxAllowed(STRUCTURE_LAB, rcl));
    },
    offsets: [
      { x: -2, y: 2 }, { x: -2, y: -2 }, { x: 2, y: 2 }, { x: 2, y: -2 },
      { x: -3, y: 2 }, { x: 3, y: 2 }, { x: -3, y: -2 }, { x: 3, y: -2 }
    ]
  }
];

function hash(x, y) {
  return x + ':' + y;
}

function withinBounds(x, y) {
  return x >= 1 && x <= 48 && y >= 1 && y <= 48;
}

function findAnchor(room) {
  if (!room) return null;
  var storages = room.find(FIND_MY_STRUCTURES, {
    filter: function (s) { return s.structureType === STRUCTURE_STORAGE; }
  });
  if (storages && storages.length) {
    return { pos: storages[0].pos, type: STRUCTURE_STORAGE };
  }
  var spawns = room.find(FIND_MY_SPAWNS);
  if (spawns && spawns.length) {
    return { pos: spawns[0].pos, type: STRUCTURE_SPAWN };
  }
  return null;
}

function buildOccupancyMaps(room) {
  var builtMap = Object.create(null);
  var siteMap = Object.create(null);
  var existingCounts = Object.create(null);
  var siteCounts = Object.create(null);

  var myStructures = room.find(FIND_MY_STRUCTURES);
  for (var i = 0; i < myStructures.length; i++) {
    var s = myStructures[i];
    existingCounts[s.structureType] = (existingCounts[s.structureType] || 0) + 1;
  }

  var structures = room.find(FIND_STRUCTURES);
  for (var j = 0; j < structures.length; j++) {
    var st = structures[j];
    builtMap[hash(st.pos.x, st.pos.y)] = st.structureType;
  }

  var mySites = room.find(FIND_MY_CONSTRUCTION_SITES);
  for (var k = 0; k < mySites.length; k++) {
    var site = mySites[k];
    siteCounts[site.structureType] = (siteCounts[site.structureType] || 0) + 1;
  }

  var allSites = room.find(FIND_CONSTRUCTION_SITES);
  for (var m = 0; m < allSites.length; m++) {
    var any = allSites[m];
    siteMap[hash(any.pos.x, any.pos.y)] = any.structureType;
  }

  return {
    builtMap: builtMap,
    siteMap: siteMap,
    existingCounts: existingCounts,
    siteCounts: siteCounts
  };
}

function resolvePlacement(room, terrain, anchor, offset, type, maps, reserved) {
  var baseX = anchor.pos.x + offset.x;
  var baseY = anchor.pos.y + offset.y;
  for (var i = 0; i < FALLBACK_STEPS.length; i++) {
    var step = FALLBACK_STEPS[i];
    var tx = baseX + step.x;
    var ty = baseY + step.y;
    if (!withinBounds(tx, ty)) continue;
    var key = hash(tx, ty);
    if (reserved[key]) continue;
    if (terrain.get(tx, ty) === TERRAIN_MASK_WALL) continue;

    var builtType = maps.builtMap[key];
    if (builtType) {
      if (builtType === type) {
        return { status: 'already', x: tx, y: ty };
      }
      continue;
    }

    var siteType = maps.siteMap[key];
    if (siteType) {
      if (siteType === type) {
        return { status: 'already', x: tx, y: ty };
      }
      continue;
    }

    return { status: 'free', x: tx, y: ty };
  }
  return { status: 'blocked', x: baseX, y: baseY };
}

var BasePlanner = {
  planRoom: function (room) {
    var summary = {
      roomName: room ? room.name : null,
      rcl: BeeToolbox.getRoomRcl(room),
      anchor: null,
      placements: [],
      structures: {},
      nextSteps: []
    };

    if (!room || !room.controller || !room.controller.my) {
      return summary;
    }

    var anchor = findAnchor(room);
    if (!anchor) {
      return summary;
    }
    summary.anchor = { x: anchor.pos.x, y: anchor.pos.y, type: anchor.type };

    var terrain = room.getTerrain();
    var maps = buildOccupancyMaps(room);
    var reserved = Object.create(null);
    var rcl = summary.rcl;
    var sitesPlaced = 0;
    function friendlyStructure(type, count) {
      if (!type) return 'structures';
      var name = String(type).replace('structure_', '').toLowerCase();
      if (count > 1 && name.charAt(name.length - 1) !== 's') {
        name += 's';
      }
      return name;
    }

    for (var i = 0; i < STRUCTURE_RULES.length; i++) {
      var rule = STRUCTURE_RULES[i];
      if (rcl < rule.minRcl) continue;

      var existing = maps.existingCounts[rule.type] || 0;
      var sites = maps.siteCounts[rule.type] || 0;
      var allowed = BeeToolbox.getMaxAllowed(rule.type, rcl);
      var ruleCap = (typeof rule.maxForRcl === 'function') ? rule.maxForRcl(rcl, room) : rule.maxForRcl;
      if (ruleCap == null) {
        ruleCap = allowed;
      }
      if (ruleCap > allowed) ruleCap = allowed;
      var desired = Math.min(ruleCap, rule.offsets.length);
      var needed = desired - existing - sites;
      if (needed < 0) needed = 0;

      summary.structures[rule.type] = {
        existing: existing,
        sites: sites,
        desired: desired,
        planned: 0,
        blocked: 0,
        comment: rule.comment
      };

      if (needed <= 0) continue;

      for (var j = 0; j < rule.offsets.length && needed > 0; j++) {
        if (sitesPlaced >= MAX_SITES_PER_TICK) break;
        var offset = rule.offsets[j];
        var placement = resolvePlacement(room, terrain, anchor, offset, rule.type, maps, reserved);
        if (placement.status === 'blocked') {
          summary.structures[rule.type].blocked += 1;
          continue;
        }
        if (placement.status === 'already') {
          continue;
        }

        var rc = room.createConstructionSite(placement.x, placement.y, rule.type);
        if (rc === OK) {
          needed--;
          sitesPlaced++;
          reserved[hash(placement.x, placement.y)] = true;
          maps.siteCounts[rule.type] = (maps.siteCounts[rule.type] || 0) + 1;
          maps.siteMap[hash(placement.x, placement.y)] = rule.type;
          summary.structures[rule.type].planned += 1;
          summary.placements.push({ type: rule.type, x: placement.x, y: placement.y });
        } else if (rc === ERR_FULL) {
          summary.structures[rule.type].blocked += 1;
          break;
        } else {
          summary.structures[rule.type].blocked += 1;
          if (Logger.shouldLog(LOG_LEVEL.DEBUG)) {
            plannerLog.debug('Failed to place', rule.type, 'at', placement.x + ',' + placement.y, 'in', room.name, 'rc', rc);
          }
        }
      }

      var missing = (summary.structures[rule.type].desired - summary.structures[rule.type].existing - summary.structures[rule.type].sites);
      if (missing > 0) {
        summary.nextSteps.push('Build ' + missing + ' more ' + friendlyStructure(rule.type, missing) + ' to reach the planned layout.');
      }
    }

    BeeToolbox.storePlannerState(room.name, summary);
    return summary;
  },

  auditRoom: function (room, planSummary) {
    var audit = {
      roomName: room ? room.name : null,
      rcl: BeeToolbox.getRoomRcl(room),
      structures: {},
      removedSites: []
    };

    if (!room || !room.controller || !room.controller.my) {
      return audit;
    }

    var maps = buildOccupancyMaps(room);
    var trackedTypes = {};
    if (planSummary && planSummary.structures) {
      for (var key in planSummary.structures) {
        if (planSummary.structures.hasOwnProperty(key)) trackedTypes[key] = true;
      }
    }
    for (var t = 0; t < STRUCTURE_RULES.length; t++) {
      trackedTypes[STRUCTURE_RULES[t].type] = true;
    }

    var mySites = room.find(FIND_MY_CONSTRUCTION_SITES);

    for (var type in trackedTypes) {
      if (!trackedTypes.hasOwnProperty(type)) continue;
      var existing = maps.existingCounts[type] || 0;
      var sites = maps.siteCounts[type] || 0;
      var allowed = BeeToolbox.getMaxAllowed(type, audit.rcl);
      var total = existing + sites;
      var overflow = (total > allowed) ? (total - allowed) : 0;

      if (overflow > 0 && mySites.length) {
        for (var i = 0; i < mySites.length && overflow > 0; i++) {
          var site = mySites[i];
          if (!site || site.structureType !== type) continue;
          var res = site.remove();
          if (res === OK) {
            overflow--;
            audit.removedSites.push(site.pos.x + ',' + site.pos.y + ':' + type);
            maps.siteCounts[type] = (maps.siteCounts[type] || 0) - 1;
          }
        }
        sites = maps.siteCounts[type] || 0;
        total = existing + sites;
      }

      var missing = allowed - total;
      if (missing < 0) missing = 0;

      audit.structures[type] = {
        existing: existing,
        sites: sites,
        allowed: allowed,
        missing: missing,
        overflow: (total > allowed) ? (total - allowed) : 0
      };
    }

    BeeToolbox.storeAuditState(room.name, audit);
    return audit;
  }
};

module.exports = BasePlanner;
