// Traveler.cpu.es5.js
// ES5-safe, CPU-minded pathing helper for Screeps.
// Public API: Creep.prototype.travelTo(dest, options)
// Notes:
// - Fixes state indices (STUCK=2, CPU=3) matching serializeState order.
// - Caches structure/creep matrices per tick; avoids re-cloning unless needed.
// - Throttles repaths: only rebuild path when necessary or options.repath chance hits.
// - Visuals are off by default; enable via options.visualizePath or options.drawPathColor.

'use strict';

var Traveler = (function () {
  // ---------- Tunables ----------
  var REPORT_CPU_THRESHOLD = 1000;
  var DEFAULT_MAXOPS = 20000;
  var DEFAULT_STUCK_VALUE = 2;

  // state array indices (must match serializeState order)
  var STATE_PREV_X = 0;
  var STATE_PREV_Y = 1;
  var STATE_STUCK  = 2;
  var STATE_CPU    = 3;
  var STATE_DEST_X = 4;
  var STATE_DEST_Y = 5;
  var STATE_DEST_ROOMNAME = 6;

  // caches
  var structureMatrixCache = {}; // roomName -> CostMatrix
  var creepMatrixCache = {};     // roomName -> CostMatrix
  var structureMatrixTick = -1;
  var creepMatrixTick = -1;

  // ---------- Utils ----------
  function normalizePos(x) {
    if (x && !(x instanceof RoomPosition)) return x.pos;
    return x;
  }
  function sameCoord(a, b) { return a && b && a.x === b.x && a.y === b.y; }
  function samePos(a, b) { return a && b && a.roomName === b.roomName && a.x === b.x && a.y === b.y; }
  function isExit(pos) { return pos.x === 0 || pos.y === 0 || pos.x === 49 || pos.y === 49; }

  function circle(pos, color, opacity) {
    if (!pos) return;
    new RoomVisual(pos.roomName).circle(pos, {
      radius: 0.45, fill: 'transparent', stroke: color || 'aqua', strokeWidth: 0.15, opacity: opacity || 0.3
    });
  }

  function updateRoomStatus(room) {
    if (!room || !room.controller) return;
    if (room.controller.owner && !room.controller.my) room.memory.avoid = 1;
    else delete room.memory.avoid;
  }

  function checkAvoid(roomName) {
    return Memory.rooms && Memory.rooms[roomName] && Memory.rooms[roomName].avoid;
  }

  // ---------- State (serialize/deserialize) ----------
  function deserializeState(travelData, destination) {
    var state = {};
    if (travelData.state) {
      state.lastCoord  = { x: travelData.state[STATE_PREV_X], y: travelData.state[STATE_PREV_Y] };
      state.stuckCount = travelData.state[STATE_STUCK] | 0;
      state.cpu        = travelData.state[STATE_CPU] | 0;
      state.destination = new RoomPosition(
        travelData.state[STATE_DEST_X], travelData.state[STATE_DEST_Y], travelData.state[STATE_DEST_ROOMNAME]
      );
    } else {
      state.cpu = 0;
      state.stuckCount = 0;
      state.destination = destination;
    }
    return state;
  }

  function serializeState(creep, destination, state, travelData) {
    travelData.state = [
      creep.pos.x,                 // 0
      creep.pos.y,                 // 1
      state.stuckCount | 0,        // 2
      state.cpu | 0,               // 3
      destination.x | 0,           // 4
      destination.y | 0,           // 5
      destination.roomName         // 6
    ];
  }

  function isStuck(creep, state) {
    var stuck = false;
    if (state.lastCoord) {
      if (sameCoord(creep.pos, state.lastCoord)) stuck = true; // didn't move
      else if (isExit(creep.pos) && isExit(state.lastCoord)) stuck = true; // bounced on border
    }
    return stuck;
  }

  // ---------- Matrix builders (cached) ----------
  function addStructuresToMatrix(room, matrix, roadCost) {
    var imp = [];
    var list = room.find(FIND_STRUCTURES);
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (s instanceof StructureRampart) {
        if (!s.my && !s.isPublic) imp.push(s);
      } else if (s instanceof StructureRoad) {
        matrix.set(s.pos.x, s.pos.y, roadCost);
      } else if (s instanceof StructureContainer) {
        matrix.set(s.pos.x, s.pos.y, 5);
      } else {
        imp.push(s);
      }
    }
    var sites = room.find(FIND_MY_CONSTRUCTION_SITES);
    for (var j = 0; j < sites.length; j++) {
      var cs = sites[j];
      if (cs.structureType === STRUCTURE_CONTAINER ||
          cs.structureType === STRUCTURE_ROAD ||
          cs.structureType === STRUCTURE_RAMPART) continue;
      matrix.set(cs.pos.x, cs.pos.y, 0xff);
    }
    for (var k = 0; k < imp.length; k++) {
      var b = imp[k];
      matrix.set(b.pos.x, b.pos.y, 0xff);
    }
    return matrix;
  }

  function addCreepsToMatrix(room, matrix) {
    var creeps = room.find(FIND_CREEPS);
    for (var i = 0; i < creeps.length; i++) {
      matrix.set(creeps[i].pos.x, creeps[i].pos.y, 0xff);
    }
    return matrix;
  }

  function getStructureMatrix(room, freshMatrix) {
    if (!structureMatrixCache[room.name] || (freshMatrix && Game.time !== structureMatrixTick)) {
      structureMatrixTick = Game.time;
      var m = new PathFinder.CostMatrix();
      structureMatrixCache[room.name] = addStructuresToMatrix(room, m, 1);
    }
    return structureMatrixCache[room.name];
  }

  function getCreepMatrix(room) {
    if (!creepMatrixCache[room.name] || Game.time !== creepMatrixTick) {
      creepMatrixTick = Game.time;
      // clone structure matrix to overlay creeps
      var base = getStructureMatrix(room, true).clone();
      creepMatrixCache[room.name] = addCreepsToMatrix(room, base);
    }
    return creepMatrixCache[room.name];
  }

  // ---------- Routing helpers ----------
  function findRoute(origin, destination, options) {
    options = options || {};
    var restrictDistance = options.restrictDistance || Game.map.getRoomLinearDistance(origin, destination) + 10;

    var allowedRooms = {};
    allowedRooms[origin] = true;
    allowedRooms[destination] = true;

    var highwayBias = 1;
    if (options.preferHighway) highwayBias = options.highwayBias || 2.5;

    var ret = Game.map.findRoute(origin, destination, {
      routeCallback: function (roomName) {
        if (options.routeCallback) {
          var out = options.routeCallback(roomName);
          if (out !== undefined) return out;
        }
        var rangeTo = Game.map.getRoomLinearDistance(origin, roomName);
        if (rangeTo > restrictDistance) return Number.POSITIVE_INFINITY;

        if (!options.allowHostile && checkAvoid(roomName) && roomName !== destination && roomName !== origin) {
          return Number.POSITIVE_INFINITY;
        }

        var parsed;
        if (options.preferHighway) {
          parsed = /^[WE]([0-9]+)[NS]([0-9]+)$/.exec(roomName);
          var isHighway = (parsed && ((parsed[1] % 10) === 0 || (parsed[2] % 10) === 0));
          if (isHighway) return 1;
        }

        // Avoid SK rooms when no vision (unless center (5,5))
        if (!options.allowSK && !Game.rooms[roomName]) {
          if (!parsed) parsed = /^[WE]([0-9]+)[NS]([0-9]+)$/.exec(roomName);
          if (parsed) {
            var fMod = parsed[1] % 10;
            var sMod = parsed[2] % 10;
            var isSK = !(fMod === 5 && sMod === 5) && (fMod >= 4 && fMod <= 6) && (sMod >= 4 && sMod <= 6);
            if (isSK) return 10 * highwayBias;
          }
        }
        return highwayBias;
      }
    });

    if (!_.isArray(ret)) {
      // console.log('Traveler: findRoute failed to ' + destination);
      return;
    }
    for (var i = 0; i < ret.length; i++) {
      allowedRooms[ret[i].room] = true;
    }
    return allowedRooms;
  }

  function findTravelPath(origin, destination, options) {
    options = options || {};
    if (typeof _.defaults === 'function') {
      _.defaults(options, { ignoreCreeps: true, maxOps: DEFAULT_MAXOPS, range: 1 });
    } else {
      if (options.ignoreCreeps == null) options.ignoreCreeps = true;
      if (options.maxOps == null) options.maxOps = DEFAULT_MAXOPS;
      if (options.range == null) options.range = 1;
    }
    if (options.movingTarget) options.range = 0;

    origin = normalizePos(origin);
    destination = normalizePos(destination);

    var originRoomName = origin.roomName;
    var destRoomName = destination.roomName;

    // Limit search space with findRoute when far
    var roomDistance = Game.map.getRoomLinearDistance(origin.roomName, destination.roomName);
    var allowedRooms = options.route;
    if (!allowedRooms && (options.useFindRoute || (options.useFindRoute === undefined && roomDistance > 2))) {
      var route = findRoute(origin.roomName, destination.roomName, options);
      if (route) allowedRooms = route;
    }

    var callback = function (roomName) {
      if (allowedRooms) {
        if (!allowedRooms[roomName]) return false;
      } else if (!options.allowHostile && checkAvoid(roomName) &&
                 roomName !== destRoomName && roomName !== originRoomName) {
        return false;
      }

      var room = Game.rooms[roomName];
      var matrix;

      if (room) {
        if (options.ignoreStructures) {
          matrix = new PathFinder.CostMatrix();
          if (!options.ignoreCreeps) addCreepsToMatrix(room, matrix);
        } else if (options.ignoreCreeps || roomName !== originRoomName) {
          matrix = getStructureMatrix(room, options.freshMatrix);
        } else {
          matrix = getCreepMatrix(room);
        }

        if (options.obstacles) {
          matrix = matrix.clone();
          for (var i = 0; i < options.obstacles.length; i++) {
            var ob = options.obstacles[i];
            if (ob && ob.pos && ob.pos.roomName === roomName) {
              matrix.set(ob.pos.x, ob.pos.y, 0xff);
            }
          }
        }
      }

      if (typeof options.roomCallback === 'function') {
        if (!matrix) matrix = new PathFinder.CostMatrix();
        var outcome = options.roomCallback(roomName, matrix.clone());
        if (outcome !== undefined) return outcome;
      }
      return matrix;
    };

    var ret = PathFinder.search(
      origin,
      { pos: destination, range: options.range },
      {
        maxOps: options.maxOps,
        maxRooms: options.maxRooms,
        plainCost: options.offRoad ? 1 : (options.ignoreRoads ? 1 : 2),
        swampCost: options.offRoad ? 1 : (options.ignoreRoads ? 5 : 10),
        roomCallback: callback
      }
    );

    if (ret.incomplete && options.ensurePath) {
      if (options.useFindRoute === undefined && roomDistance <= 2) {
        // retry with useFindRoute enabled for weird local cases
        // console.log('Traveler: retry with findRoute');
        options.useFindRoute = true;
        ret = findTravelPath(origin, destination, options);
      }
    }
    return ret;
  }

  // ---------- Path serialization ----------
  function positionAtDirection(origin, direction) {
    var offsetX = [0, 0, 1, 1, 1, 0, -1, -1, -1];
    var offsetY = [0, -1, -1, 0, 1, 1, 1, 0, -1];
    var x = origin.x + offsetX[direction];
    var y = origin.y + offsetY[direction];
    if (x > 49 || x < 0 || y > 49 || y < 0) return;
    return new RoomPosition(x, y, origin.roomName);
  }

  function serializePath(startPos, path, color) {
    var serialized = '';
    var last = startPos;
    var draw = color != null;
    if (draw) circle(startPos, color);

    for (var i = 0; i < path.length; i++) {
      var p = path[i];
      if (p.roomName === last.roomName) {
        if (draw) new RoomVisual(p.roomName).line(p, last, { color: color, lineStyle: 'dashed' });
        serialized += last.getDirectionTo(p);
      }
      last = p;
    }
    return serialized;
  }

  // ---------- Public: main move ----------
  function travelTo(creep, destination, options) {
    options = options || {};

    // updateRoomStatus(creep.room); // optional
    if (!destination) return ERR_INVALID_ARGS;
    if (creep.spawning) return ERR_BUSY;

    if (creep.fatigue > 0) {
      if (options.visualizeFatigue) circle(creep.pos, 'aqua', 0.3);
      return ERR_TIRED;
    }

    destination = normalizePos(destination);

    // close enough?
    var rangeTo = creep.pos.getRangeTo(destination);
    if (options.range && rangeTo <= options.range) return OK;
    if (!options.range && rangeTo <= 1) {
      var dir = creep.pos.getDirectionTo(destination);
      if (options.returnData) {
        options.returnData.nextPos = destination;
        options.returnData.path = String(dir);
      }
      return creep.move(dir);
    }

    // data bucket
    if (!creep.memory._trav) { delete creep.memory._travel; creep.memory._trav = {}; }
    var travelData = creep.memory._trav;

    // state
    var state = deserializeState(travelData, destination);

    // stuck check
    if (isStuck(creep, state)) {
      state.stuckCount++;
      if (options.visualizeStuck) circle(creep.pos, 'magenta', 0.2 + 0.1 * Math.min(5, state.stuckCount));
    } else {
      state.stuckCount = 0;
    }

    // defaults
    var stuckValue = (options.stuckValue != null) ? options.stuckValue : DEFAULT_STUCK_VALUE;

    // if very stuck, drop ignoreCreeps and refresh matrices
    if (state.stuckCount >= stuckValue) {
      options.ignoreCreeps = false;
      options.freshMatrix = true;
      delete travelData.path; // force repath
    }

    // destination change: drop/append
    if (!samePos(state.destination, destination)) {
      if (options.movingTarget && state.destination && state.destination.isNearTo(destination)) {
        travelData.path = (travelData.path || '') + state.destination.getDirectionTo(destination);
        state.destination = destination;
      } else {
        delete travelData.path;
      }
    }

    // probabilistic repath if requested
    if (options.repath && Math.random() < options.repath) delete travelData.path;

    // compute path if needed
    var newPath = false;
    if (!travelData.path) {
      newPath = true;

      var cpu0 = Game.cpu.getUsed();
      var ret = findTravelPath(creep.pos, destination, options);
      var cpuUsed = Game.cpu.getUsed() - cpu0;
      state.cpu = (state.cpu | 0) + Math.round(cpuUsed);

      if (state.cpu > REPORT_CPU_THRESHOLD) {
        console.log('TRAVELER: heavy cpu ' + creep.name + ' cpu: ' + state.cpu +
          ' origin: ' + creep.pos + ' dest: ' + destination);
      }

      var color = options.drawPathColor; // undefined -> no draw
      travelData.path = ret && ret.path && ret.path.length ? serializePath(creep.pos, ret.path, color) : '';

      state.stuckCount = 0;
      state.destination = destination;
    }

    // persist state
    serializeState(creep, destination, state, travelData);

    if (!travelData.path || travelData.path.length === 0) return ERR_NO_PATH;

    // consume path if we moved last tick (avoid double-step on fresh path)
    if (state.stuckCount === 0 && !newPath) {
      travelData.path = travelData.path.substr(1);
    }

    var nextDir = parseInt(travelData.path[0], 10);
    if (options.returnData) {
      if (nextDir) {
        var nextPos = positionAtDirection(creep.pos, nextDir);
        if (nextPos) options.returnData.nextPos = nextPos;
      }
      options.returnData.state = state;
      options.returnData.path = travelData.path;
    }

    return creep.move(nextDir);
  }

  // ---------- Optional utilities ----------
  function routeDistance(origin, destination) {
    var d = Game.map.getRoomLinearDistance(origin, destination);
    if (d >= 32) return d;
    var allowed = findRoute(origin, destination, {});
    if (allowed) return Object.keys(allowed).length;
  }

  function patchMemory(cleanup) {
    if (!Memory.empire || !Memory.empire.hostileRooms) return;
    var count = 0;
    for (var rn in Memory.empire.hostileRooms) {
      if (Memory.empire.hostileRooms[rn]) {
        if (!Memory.rooms[rn]) Memory.rooms[rn] = {};
        Memory.rooms[rn].avoid = 1; count++;
      }
      if (cleanup) delete Memory.empire.hostileRooms[rn];
    }
    if (cleanup) delete Memory.empire.hostileRooms;
    console.log('TRAVELER: room avoidance data patched for ' + count + ' rooms');
  }

  // export
  return {
    travelTo: travelTo,
    normalizePos: normalizePos,
    sameCoord: sameCoord,
    samePos: samePos,
    isExit: isExit,
    circle: circle,
    updateRoomStatus: updateRoomStatus,
    checkAvoid: checkAvoid,
    findTravelPath: findTravelPath,
    findRoute: findRoute,
    routeDistance: routeDistance,
    positionAtDirection: positionAtDirection,
    serializePath: serializePath,
    // expose caches (optional)
    _getStructureMatrix: getStructureMatrix,
    _getCreepMatrix: getCreepMatrix,
    _patchMemory: patchMemory
  };
})();

module.exports = Traveler;

// Prototype sugar: creep.travelTo(dest, options)
Creep.prototype.travelTo = function (destination, options) {
  return Traveler.travelTo(this, destination, options || {});
};
