'use strict';

var BeeToolbox = require('BeeToolbox');
var CoreConfig = require('core.config');
var CFG = CoreConfig.ROLE_CFG;

// Phase 2 refactor note: visuals + debug flags now live in core.config and
// BeeToolbox so every role shares the same behaviour and new readers have one
// place to tweak draw settings.
function debugSay(creep, msg) { BeeToolbox.debugSay(creep, msg, CFG.DEBUG_SAY); }
function debugDrawLine(creep, target, color, label) { BeeToolbox.debugDrawLine(creep, target, color, label, CFG); }
function debugRing(room, pos, color, text) { BeeToolbox.debugRing(room, pos, color, text, CFG); }

  // -----------------------------
  // A) Config + state helpers
  // -----------------------------
  // ==============================
  // Tunables
  // ==============================
  // Builders will commute home to withdraw when storage/terminal has at least this much energy.
  var HOME_RICH_ENERGY = 5000;
  // Below this threshold we consider home "low" and allow remote harvesting to stay productive.
  var HOME_LOW_ENERGY = 1000;
  var ALLOW_HARVEST_FALLBACK = true; // flip true if you really want last-resort mining
  var PICKUP_MIN = 50;                // ignore tiny crumbs
  var SRC_CONTAINER_MIN = 100;        // minimum energy to bother at source containers

  // Simple and explicit builder state machine so new players can trace behaviour.
  // HARVEST → refill; TRAVEL → cross rooms safely; BUILD → spend energy; IDLE → wait + retarget.
  var BUILDER_STATES = {
    HARVEST: 'HARVEST',
    TRAVEL: 'TRAVEL',
    BUILD: 'BUILD',
    IDLE: 'IDLE'
  };

  // ==============================
  // Tiny helpers
  // ==============================
  function ensureBuilderIdentity(creep) {
    if (!creep || !creep.memory) return;
    creep.memory.role = 'Builder';
    if (!creep.memory.task) creep.memory.task = 'builder';
  }

  // Memory keys:
  // - builderTargetId: sticky id for a construction site
  // - builderTargetType: 'construction'
  // - builderState: current state from BUILDER_STATES

  function needsEnergy(creep) {
    // Using explicit numbers keeps the "is empty" check easy to read.
    var stored = creep.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    return stored === 0;
  }

  function setBuilderState(creep, state) {
    creep.memory.builderState = state;
  }

  function getBuilderState(creep) {
    if (!creep.memory.builderState) {
      setBuilderState(creep, BUILDER_STATES.HARVEST);
    }
    return creep.memory.builderState;
  }

  // -----------------------------
  // B) Energy collection helpers
  // -----------------------------
  function collectEnergy(creep) {
    // Prefer grabbing energy from a rich home storage/terminal to speed up remote building.
    var homeName = (typeof getHomeName === 'function') ? getHomeName(creep) : null;
    var homeRoom = homeName ? Game.rooms[homeName] : null;
    var homeStorage = homeRoom ? homeRoom.storage : null;
    var homeTerminal = homeRoom ? homeRoom.terminal : null;
    var homeEnergy = 0;
    if (homeStorage && homeStorage.store) homeEnergy += homeStorage.store[RESOURCE_ENERGY] || 0;
    if (homeTerminal && homeTerminal.store) homeEnergy += homeTerminal.store[RESOURCE_ENERGY] || 0;

    var homeIsRich = homeEnergy >= HOME_RICH_ENERGY;
    var homeIsLow = homeEnergy <= HOME_LOW_ENERGY;

    if (homeIsRich && homeName) {
      if (!homeRoom || creep.pos.roomName !== homeName) {
        var anchorPos = (typeof getAnchorPos === 'function') ? getAnchorPos(homeName) : null;
        if (anchorPos) {
          debugSay(creep, '🏠');
          debugDrawLine(creep, anchorPos, CFG.DRAW.IDLE_COLOR, "HOME•ENERGY");
          creep.travelTo(anchorPos, { range: 2, reusePath: 25 });
          return true; // commuting home to refuel from rich storage
        }
      } else {
        var withdrawTarget = null;
        if (homeStorage && (homeStorage.store[RESOURCE_ENERGY] || 0) > 0) {
          withdrawTarget = homeStorage;
        } else if (homeTerminal && (homeTerminal.store[RESOURCE_ENERGY] || 0) > 0) {
          withdrawTarget = homeTerminal;
        }

        if (withdrawTarget) {
          debugSay(creep, '🏦');
          debugDrawLine(creep, withdrawTarget, CFG.DRAW.FILL_COLOR, "HOME•WITHDRAW");
          var homeWithdraw = creep.withdraw(withdrawTarget, RESOURCE_ENERGY);
          if (homeWithdraw === ERR_NOT_IN_RANGE) {
            creep.travelTo(withdrawTarget, { range: 1, reusePath: 15 });
          }
          return true;
        }
      }
    }

    // 1) Tombstones / Ruins
    var tomb = creep.pos.findClosestByRange(FIND_TOMBSTONES, {
      filter: function (t) {
        var energy = t.store[RESOURCE_ENERGY] || 0;
        return energy > 0;
      }
    });
    if (tomb) {
      debugSay(creep, '🪦');
      debugDrawLine(creep, tomb, CFG.DRAW.GRAVE_COLOR, "TOMB");
      var tr = creep.withdraw(tomb, RESOURCE_ENERGY);
      if (tr === ERR_NOT_IN_RANGE) {
        creep.travelTo(tomb, { range: 1, reusePath: 20 });
      }
      return true;
    }

    var ruin = creep.pos.findClosestByRange(FIND_RUINS, {
      filter: function (r) {
        var energy = r.store[RESOURCE_ENERGY] || 0;
        return energy > 0;
      }
    });
    if (ruin) {
      debugSay(creep, '🏚️');
      debugDrawLine(creep, ruin, CFG.DRAW.GRAVE_COLOR, "RUIN");
      var rr = creep.withdraw(ruin, RESOURCE_ENERGY);
      if (rr === ERR_NOT_IN_RANGE) {
        creep.travelTo(ruin, { range: 1, reusePath: 20 });
      }
      return true;
    }

    // 2) Dropped
    var dropped = creep.pos.findClosestByRange(FIND_DROPPED_RESOURCES, {
      filter: function (r) {
        var amount = r.amount || 0;
        return r.resourceType === RESOURCE_ENERGY && amount >= PICKUP_MIN;
      }
    });
    if (dropped) {
      debugSay(creep, '🍪');
      debugDrawLine(creep, dropped, CFG.DRAW.DROP_COLOR, "DROP");
      if (creep.pickup(dropped) === ERR_NOT_IN_RANGE) {
        creep.travelTo(dropped, { range: 1, reusePath: 15 });
      }
      return true;
    }

    // 3) Source-adjacent container
    var srcCont = creep.pos.findClosestByRange(FIND_STRUCTURES, {
      filter: function (s) {
        if (s.structureType !== STRUCTURE_CONTAINER || !s.store) return false;
        if (s.pos.findInRange(FIND_SOURCES, 1).length === 0) return false;
        var energy = s.store[RESOURCE_ENERGY] || 0;
        return energy >= SRC_CONTAINER_MIN;
      }
    });
    if (srcCont) {
      debugSay(creep, '📦');
      debugDrawLine(creep, srcCont, CFG.DRAW.FILL_COLOR, "SRC•CONT");
      var cr = creep.withdraw(srcCont, RESOURCE_ENERGY);
      if (cr === ERR_NOT_IN_RANGE) {
        creep.travelTo(srcCont, { range: 1, reusePath: 25 });
      }
      return true;
    }

    // 4) Any store (container/link/storage/terminal) in THIS room
    var storeLike = creep.pos.findClosestByRange(FIND_STRUCTURES, {
      filter: function (s) {
        if (!s.store) return false;
        var t = s.structureType;
        if (t !== STRUCTURE_CONTAINER &&
            t !== STRUCTURE_LINK &&
            t !== STRUCTURE_STORAGE &&
            t !== STRUCTURE_TERMINAL) return false;
        var energy = s.store[RESOURCE_ENERGY] || 0;
        return energy > 0;
      }
    });
    if (storeLike) {
      debugSay(creep, '🏦');
      debugDrawLine(creep, storeLike, CFG.DRAW.FILL_COLOR, "WITHDRAW");
      var sr = creep.withdraw(storeLike, RESOURCE_ENERGY);
      if (sr === ERR_NOT_IN_RANGE) {
        creep.travelTo(storeLike, { range: 1, reusePath: 25 });
      }
      return true;
    }

    // 5) Optional last resort: harvest locally
    if (ALLOW_HARVEST_FALLBACK || homeIsLow) {
      var src = creep.pos.findClosestByRange(FIND_SOURCES_ACTIVE);
      if (src) {
        debugSay(creep, '⛏️');
        debugDrawLine(creep, src, CFG.DRAW.SOURCE, "MINE");
        var hr = creep.harvest(src);
        if (hr === ERR_NOT_IN_RANGE) {
          creep.travelTo(src, { range: 1, reusePath: 20 });
        }
        return true;
      }
    }

    // 6) No local energy and harvest fallback is OFF → walk toward home room
    if (typeof getHomeName === 'function' && typeof getAnchorPos === 'function') {
      var homeName = getHomeName(creep);
      if (homeName && creep.pos.roomName !== homeName) {
        var anchorPos = getAnchorPos(homeName);
        if (anchorPos) {
          debugSay(creep, '🏠');
          debugDrawLine(creep, anchorPos, CFG.DRAW.IDLE_COLOR, "HOME");
          creep.travelTo(anchorPos, { range: 2, reusePath: 25 });
          return true; // we are actively walking home to refuel
        }
      }
    }

    // 7) Already in home room (or no home info) → idle near local anchor
    idleNearAnchor(creep);
    return false;
  }

  function idleNearAnchor(creep) {
    var anchor = creep.room.storage || creep.pos.findClosestByRange(FIND_MY_SPAWNS) || creep.pos;
    if (anchor && anchor.pos) {
      debugSay(creep, '🧘');
      debugDrawLine(creep, anchor, CFG.DRAW.IDLE_COLOR, "IDLE");
      creep.travelTo(anchor, { range: 2, reusePath: 20 });
    }
  }

  function dumpEnergyToSink(creep) {
    var carried = creep.store.getUsedCapacity(RESOURCE_ENERGY) || 0;
    if (carried <= 0) return false;
    var sink = creep.pos.findClosestByRange(FIND_STRUCTURES, {
      filter: function (s) {
        if (!s.store) return false;
        var free = s.store.getFreeCapacity(RESOURCE_ENERGY) || 0;
        return free > 0 &&
               (s.structureType === STRUCTURE_STORAGE   ||
                s.structureType === STRUCTURE_TERMINAL  ||
                s.structureType === STRUCTURE_SPAWN     ||
                s.structureType === STRUCTURE_EXTENSION ||
                s.structureType === STRUCTURE_TOWER     ||
                s.structureType === STRUCTURE_CONTAINER ||
                s.structureType === STRUCTURE_LINK);
      }
    });
    if (!sink) return false;
    debugSay(creep, '➡️SINK');
    debugDrawLine(creep, sink, CFG.DRAW.SINK_COLOR, "SINK");
    if (creep.transfer(sink, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
      creep.travelTo(sink, { range: 1, reusePath: 20 });
    }
    return true;
  }

  // -----------------------------
  // C) Target helpers (build only)
  // -----------------------------
  // Target selection priority:
  // 1) Sticky target from memory; 2) construction in current room; 3) nearest other room site.
  function getBuilderTarget(creep) {
    var cachedId = creep.memory.builderTargetId;
    var cachedType = creep.memory.builderTargetType;

    // Reuse a remembered site when it still exists.
    if (cachedId && cachedType === 'construction') {
      var cachedSite = Game.constructionSites[cachedId];
      if (cachedSite) {
        return { target: cachedSite, type: 'build' };
      }
      creep.memory.builderTargetId = null;
      creep.memory.builderTargetType = null;
    }

    // 2) Prefer a nearby site with a small priority list so vital structures get finished first.
    var localSites = creep.room.find(FIND_CONSTRUCTION_SITES);
    if (localSites && localSites.length > 0) {
      var prio = { 'spawn': 5, 'extension': 4, 'tower': 3, 'container': 2, 'road': 1 };
      var bestLocal = null;
      var bestScore = -1;
      var bestRange = 1e9;
      for (var i = 0; i < localSites.length; i++) {
        var site = localSites[i];
        var score = prio[site.structureType] || 0;
        var range = creep.pos.getRangeTo(site.pos);
        if (score > bestScore || (score === bestScore && range < bestRange)) {
          bestLocal = site;
          bestScore = score;
          bestRange = range;
        }
      }
      if (bestLocal) {
        creep.memory.builderTargetId = bestLocal.id;
        creep.memory.builderTargetType = 'construction';
        debugRing(creep.room, bestLocal.pos, CFG.DRAW.BUILD_COLOR, 'BUILD');
        return { target: bestLocal, type: 'build' };
      }
    }

    // 3) Otherwise grab the nearest construction site in any visible room.
    var nearestSite = null;
    var bestDistance = 1e9;
    for (var sid in Game.constructionSites) {
      if (!Game.constructionSites.hasOwnProperty(sid)) continue;
      var s2 = Game.constructionSites[sid];
      var dist = Game.map.getRoomLinearDistance(creep.pos.roomName, s2.pos.roomName);
      if (dist < bestDistance) {
        bestDistance = dist;
        nearestSite = s2;
      }
    }

    if (nearestSite) {
      creep.memory.builderTargetId = nearestSite.id;
      creep.memory.builderTargetType = 'construction';
      debugRing(creep.room, nearestSite.pos, CFG.DRAW.BUILD_COLOR, 'REMOTE');
      return { target: nearestSite, type: 'build' };
    }

    return null;
  }

  // -----------------------------
  // D) Movement helpers
  // -----------------------------
  function isOnBorder(pos) {
    return pos.x === 0 || pos.x === 49 || pos.y === 0 || pos.y === 49;
  }

  // Step off the exit tiles so we do not bounce between rooms.
  function nudgeOffBorder(creep) {
    if (!isOnBorder(creep.pos)) return false;
    if (creep.pos.x === 0) return creep.move(RIGHT) === OK;
    if (creep.pos.x === 49) return creep.move(LEFT) === OK;
    if (creep.pos.y === 0) return creep.move(BOTTOM) === OK;
    if (creep.pos.y === 49) return creep.move(TOP) === OK;
    return false;
  }

  // Explicit cross-room navigation: walk to the nearest exit leading to the target room.
  // Using exits + nudges keeps creeps from bouncing on borders when the site is in another room.
  function moveToRoom(creep, targetRoomName) {
    if (!targetRoomName || creep.pos.roomName === targetRoomName) return false;

    if (nudgeOffBorder(creep)) return true;

    var exitDir = Game.map.findExit(creep.room, targetRoomName);
    if (exitDir < 0) return false;

    var exit = creep.pos.findClosestByRange(exitDir);
    if (exit) {
      debugDrawLine(creep, exit, CFG.DRAW.TRAVEL, 'EXIT');
      creep.moveTo(exit, { reusePath: 10, maxRooms: 1 });
      return true;
    }
    return false;
  }

  // -----------------------------
  // E) Work handlers
  // -----------------------------
  function handleBuild(creep, target) {
    if (!target) return false;
    if (target.pos.roomName !== creep.pos.roomName) {
      setBuilderState(creep, BUILDER_STATES.TRAVEL);
      return true;
    }

    if (nudgeOffBorder(creep)) return true;

    if (!creep.pos.inRangeTo(target.pos, 3)) {
      debugDrawLine(creep, target, CFG.DRAW.TRAVEL, 'TO•SITE');
      creep.moveTo(target, { range: 3, reusePath: 10 });
      return true;
    }

    debugSay(creep, '🔨');
    debugDrawLine(creep, target, CFG.DRAW.BUILD_COLOR, 'BUILD');
    var r = creep.build(target);
    if (r === ERR_NOT_ENOUGH_RESOURCES) return false;
    if (r === ERR_INVALID_TARGET) {
      creep.memory.builderTargetId = null;
      creep.memory.builderTargetType = null;
      setBuilderState(creep, BUILDER_STATES.IDLE);
    }
    return true;
  }

  function handleTravel(creep, targetInfo) {
    if (!targetInfo || !targetInfo.target) return false;
    var target = targetInfo.target;
    var targetRoom = target.pos.roomName;
    if (moveToRoom(creep, targetRoom)) return true;
    if (isOnBorder(creep.pos)) {
      nudgeOffBorder(creep);
      return true;
    }
    setBuilderState(creep, BUILDER_STATES.BUILD);
    return false;
  }

  // -----------------------------
  // F) Home helpers (copied so the role stays standalone)
  // -----------------------------
  function getHomeName(creep){
    if (creep.memory.home) return creep.memory.home;
    var spawns = Object.keys(Game.spawns).map(function(k){return Game.spawns[k];});
    if (spawns.length){
      var best = spawns[0], bestD = Game.map.getRoomLinearDistance(creep.pos.roomName, best.pos.roomName);
      for (var i=1;i<spawns.length;i++){
        var s=spawns[i], d=Game.map.getRoomLinearDistance(creep.pos.roomName, s.pos.roomName);
        if (d<bestD){ best=s; bestD=d; }
      }
      creep.memory.home = best.pos.roomName; return creep.memory.home;
    }
    creep.memory.home = creep.pos.roomName; return creep.memory.home;
  }
  function getAnchorPos(homeName){
    var r = Game.rooms[homeName];
    if (r){
      if (r.storage) return r.storage.pos;
      var spawns = r.find(FIND_MY_SPAWNS); if (spawns.length) return spawns[0].pos;
      if (r.controller && r.controller.my) return r.controller.pos;
    }
    return new RoomPosition(25,25,homeName);
  }

  // ==============================
  // Public API
  // ==============================
  var roleBuilder = {
    role: 'Builder',
    run: function (creep) {
      ensureBuilderIdentity(creep);

      var state = getBuilderState(creep);
      if (needsEnergy(creep)) {
        setBuilderState(creep, BUILDER_STATES.HARVEST);
        state = BUILDER_STATES.HARVEST;
        creep.memory.builderTargetId = null;
        creep.memory.builderTargetType = null;
      }

      if (state === BUILDER_STATES.HARVEST) {
        if (collectEnergy(creep) && creep.store.getFreeCapacity() > 0) return;
        if (creep.store.getFreeCapacity() === 0) {
          setBuilderState(creep, BUILDER_STATES.IDLE);
        }
        return;
      }

      var targetInfo = getBuilderTarget(creep);
      if (!targetInfo) {
        if (dumpEnergyToSink(creep)) return;
        setBuilderState(creep, BUILDER_STATES.IDLE);
        idleNearAnchor(creep);
        return;
      }

      if (state === BUILDER_STATES.IDLE) {
        setBuilderState(creep, BUILDER_STATES.TRAVEL);
        state = BUILDER_STATES.TRAVEL;
      }

      if (state === BUILDER_STATES.TRAVEL) {
        if (handleTravel(creep, targetInfo)) return;
        state = getBuilderState(creep);
      }

      if (state === BUILDER_STATES.BUILD) {
        if (handleBuild(creep, targetInfo.target)) return;
        return;
      }

      // Safety fallback
      setBuilderState(creep, BUILDER_STATES.IDLE);
      idleNearAnchor(creep);
    }
  };

module.exports = roleBuilder;
