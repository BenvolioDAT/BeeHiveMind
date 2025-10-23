'use strict';

// FIX: Replace ES2015 class syntax with an ES5-friendly module so Traveler loads under older runtimes without syntax errors.

var Traveler = {};

var REPORT_CPU_THRESHOLD = 1000;
var DEFAULT_MAXOPS = 20000;
var DEFAULT_STUCK_VALUE = 2;
var STATE_PREV_X = 0;
var STATE_PREV_Y = 1;
var STATE_STUCK = 4;
var STATE_CPU = 2;
var STATE_DEST_X = 4;
var STATE_DEST_Y = 5;
var STATE_DEST_ROOMNAME = 6;

Traveler.structureMatrixCache = {};
Traveler.creepMatrixCache = {};
Traveler.structureMatrixTick = 0;
Traveler.creepMatrixTick = 0;

Traveler.travelTo = function (creep, destination, options) {
  if (!options) options = {};

  if (!destination) {
    return ERR_INVALID_ARGS;
  }
  if (creep.fatigue > 0) {
    Traveler.circle(creep.pos, 'aqua', 0.3);
    return ERR_TIRED;
  }

  destination = Traveler.normalizePos(destination);

  var rangeToDestination = creep.pos.getRangeTo(destination);
  if (options.range && rangeToDestination <= options.range) {
    return OK;
  } else if (rangeToDestination <= 1) {
    if (rangeToDestination === 1 && !options.range) {
      var direction = creep.pos.getDirectionTo(destination);
      if (options.returnData) {
        options.returnData.nextPos = destination;
        options.returnData.path = String(direction);
      }
      return creep.move(direction);
    }
    return OK;
  }

  if (!creep.memory._trav) {
    delete creep.memory._travel;
    creep.memory._trav = {};
  }

  var travelData = creep.memory._trav;
  var state = Traveler.deserializeState(travelData, destination);

  if (Traveler.isStuck(creep, state)) {
    state.stuckCount++;
    Traveler.circle(creep.pos, 'magenta', state.stuckCount * 0.2);
  } else {
    state.stuckCount = 0;
  }

  if (!options.stuckValue) {
    options.stuckValue = DEFAULT_STUCK_VALUE;
  }
  if (state.stuckCount >= options.stuckValue && Math.random() > 0.5) {
    options.ignoreCreeps = false;
    options.freshMatrix = true;
    delete travelData.path;
  }

  if (!Traveler.samePos(state.destination, destination)) {
    if (options.movingTarget && state.destination && state.destination.isNearTo && state.destination.isNearTo(destination)) {
      travelData.path = travelData.path + state.destination.getDirectionTo(destination);
      state.destination = destination;
    } else {
      delete travelData.path;
    }
  }

  if (options.repath && Math.random() < options.repath) {
    delete travelData.path;
  }

  var newPath = false;
  if (!travelData.path) {
    newPath = true;
    if (creep.spawning) {
      return ERR_BUSY;
    }
    state.destination = destination;
    var cpuStart = Game.cpu.getUsed();
    var ret = Traveler.findTravelPath(creep.pos, destination, options);
    var cpuUsed = Game.cpu.getUsed() - cpuStart;
    state.cpu = _.round(cpuUsed + state.cpu);
    if (state.cpu > REPORT_CPU_THRESHOLD) {
      console.log('TRAVELER: heavy cpu use: ' + creep.name + ', cpu: ' + state.cpu + ' origin: ' + creep.pos + ', dest: ' + destination);
    }
    var color = 'orange';
    if (ret.incomplete) {
      color = 'red';
    }
    if (options.returnData) {
      options.returnData.pathfinderReturn = ret;
    }
    travelData.path = Traveler.serializePath(creep.pos, ret.path, color);
    state.stuckCount = 0;
  }

  Traveler.serializeState(creep, destination, state, travelData);
  if (!travelData.path || !travelData.path.length) {
    return ERR_NO_PATH;
  }

  if (state.stuckCount === 0 && !newPath) {
    travelData.path = travelData.path.substr(1);
  }
  var nextDirection = parseInt(travelData.path[0], 10);
  if (options.returnData) {
    if (nextDirection) {
      var nextPos = Traveler.positionAtDirection(creep.pos, nextDirection);
      if (nextPos) {
        options.returnData.nextPos = nextPos;
      }
    }
    options.returnData.state = state;
    options.returnData.path = travelData.path;
  }
  return creep.move(nextDirection);
};

Traveler.normalizePos = function (destination) {
  if (!(destination instanceof RoomPosition)) {
    return destination.pos;
  }
  return destination;
};

Traveler.checkAvoid = function (roomName) {
  return Memory.rooms && Memory.rooms[roomName] && Memory.rooms[roomName].avoid;
};

Traveler.isExit = function (pos) {
  return pos.x === 0 || pos.y === 0 || pos.x === 49 || pos.y === 49;
};

Traveler.sameCoord = function (pos1, pos2) {
  return pos1.x === pos2.x && pos1.y === pos2.y;
};

Traveler.samePos = function (pos1, pos2) {
  return Traveler.sameCoord(pos1, pos2) && pos1.roomName === pos2.roomName;
};

Traveler.circle = function (pos, color, opacity) {
  new RoomVisual(pos.roomName).circle(pos, {
    radius: 0.45,
    fill: 'transparent',
    stroke: color,
    strokeWidth: 0.15,
    opacity: opacity
  });
};

Traveler.updateRoomStatus = function (room) {
  if (!room) {
    return;
  }
  if (room.controller) {
    if (room.controller.owner && !room.controller.my) {
      room.memory.avoid = 1;
    } else {
      delete room.memory.avoid;
    }
  }
};

Traveler.findTravelPath = function (origin, destination, options) {
  if (!options) options = {};

  _.defaults(options, {
    ignoreCreeps: true,
    maxOps: DEFAULT_MAXOPS,
    range: 1
  });
  if (options.movingTarget) {
    options.range = 0;
  }

  origin = Traveler.normalizePos(origin);
  destination = Traveler.normalizePos(destination);

  var originRoomName = origin.roomName;
  var destRoomName = destination.roomName;
  var roomDistance = Game.map.getRoomLinearDistance(origin.roomName, destination.roomName);
  var allowedRooms = options.route;
  if (!allowedRooms && (options.useFindRoute || (options.useFindRoute === undefined && roomDistance > 2))) {
    var route = Traveler.findRoute(origin.roomName, destination.roomName, options);
    if (route) {
      allowedRooms = route;
    }
  }

  var callback = function (roomName) {
    if (allowedRooms) {
      if (!allowedRooms[roomName]) {
        return false;
      }
    } else if (!options.allowHostile && Traveler.checkAvoid(roomName) && roomName !== destRoomName && roomName !== originRoomName) {
      return false;
    }

    var matrix = null;
    var room = Game.rooms[roomName];
    if (room) {
      if (options.ignoreStructures) {
        matrix = new PathFinder.CostMatrix();
        if (!options.ignoreCreeps) {
          Traveler.addCreepsToMatrix(room, matrix);
        }
      } else if (options.ignoreCreeps || roomName !== originRoomName) {
        matrix = Traveler.getStructureMatrix(room, options.freshMatrix);
      } else {
        matrix = Traveler.getCreepMatrix(room);
      }
      if (options.obstacles) {
        matrix = matrix.clone();
        for (var o = 0; o < options.obstacles.length; o++) {
          var obstacle = options.obstacles[o];
          if (!obstacle || !obstacle.pos || obstacle.pos.roomName !== roomName) continue;
          matrix.set(obstacle.pos.x, obstacle.pos.y, 0xFF);
        }
      }
    }
    if (options.roomCallback) {
      if (!matrix) {
        matrix = new PathFinder.CostMatrix();
      }
      var outcome = options.roomCallback(roomName, matrix.clone());
      if (outcome !== undefined) {
        return outcome;
      }
    }
    return matrix;
  };

  var ret = PathFinder.search(origin, { pos: destination, range: options.range }, {
    maxOps: options.maxOps,
    maxRooms: options.maxRooms,
    plainCost: options.offRoad ? 1 : options.ignoreRoads ? 1 : 2,
    swampCost: options.offRoad ? 1 : options.ignoreRoads ? 5 : 10,
    roomCallback: callback
  });

  if (ret.incomplete && options.ensurePath) {
    if (options.useFindRoute === undefined) {
      if (roomDistance <= 2) {
        console.log('TRAVELER: path failed without findroute, trying with options.useFindRoute = true');
        console.log('from: ' + origin + ', destination: ' + destination);
        options.useFindRoute = true;
        ret = Traveler.findTravelPath(origin, destination, options);
        console.log('TRAVELER: second attempt was ' + (ret.incomplete ? 'not ' : '') + 'successful');
        return ret;
      }
    }
  }

  return ret;
};

Traveler.findRoute = function (origin, destination, options) {
  if (!options) options = {};

  var restrictDistance = options.restrictDistance || Game.map.getRoomLinearDistance(origin, destination) + 10;
  var allowedRooms = {};
  allowedRooms[origin] = true;
  allowedRooms[destination] = true;
  var highwayBias = 1;
  if (options.preferHighway) {
    highwayBias = 2.5;
    if (options.highwayBias) {
      highwayBias = options.highwayBias;
    }
  }

  var ret = Game.map.findRoute(origin, destination, {
    routeCallback: function (roomName) {
      if (options.routeCallback) {
        var outcome = options.routeCallback(roomName);
        if (outcome !== undefined) {
          return outcome;
        }
      }
      var rangeToRoom = Game.map.getRoomLinearDistance(origin, roomName);
      if (rangeToRoom > restrictDistance) {
        return Number.POSITIVE_INFINITY;
      }
      if (!options.allowHostile && Traveler.checkAvoid(roomName) && roomName !== destination && roomName !== origin) {
        return Number.POSITIVE_INFINITY;
      }
      var parsed = null;
      if (options.preferHighway) {
        parsed = /^[WE]([0-9]+)[NS]([0-9]+)$/.exec(roomName);
        var isHighway = parsed && ((parseInt(parsed[1], 10) % 10 === 0) || (parseInt(parsed[2], 10) % 10 === 0));
        if (isHighway) {
          return 1;
        }
      }
      if (!options.allowSK && !Game.rooms[roomName]) {
        if (!parsed) {
          parsed = /^[WE]([0-9]+)[NS]([0-9]+)$/.exec(roomName);
        }
        if (parsed) {
          var fMod = parseInt(parsed[1], 10) % 10;
          var sMod = parseInt(parsed[2], 10) % 10;
          var isSK = !(fMod === 5 && sMod === 5) && (fMod >= 4 && fMod <= 6) && (sMod >= 4 && sMod <= 6);
          if (isSK) {
            return 10 * highwayBias;
          }
        }
      }
      return highwayBias;
    }
  });

  if (!_.isArray(ret)) {
    console.log('couldn\'t findRoute to ' + destination);
    return;
  }
  for (var i = 0; i < ret.length; i++) {
    allowedRooms[ret[i].room] = true;
  }
  return allowedRooms;
};

Traveler.routeDistance = function (origin, destination) {
  var linearDistance = Game.map.getRoomLinearDistance(origin, destination);
  if (linearDistance >= 32) {
    return linearDistance;
  }
  var allowedRooms = Traveler.findRoute(origin, destination);
  if (allowedRooms) {
    return Object.keys(allowedRooms).length;
  }
};

Traveler.getStructureMatrix = function (room, freshMatrix) {
  if (!Traveler.structureMatrixCache[room.name] || (freshMatrix && Game.time !== Traveler.structureMatrixTick)) {
    Traveler.structureMatrixTick = Game.time;
    var matrix = new PathFinder.CostMatrix();
    Traveler.structureMatrixCache[room.name] = Traveler.addStructuresToMatrix(room, matrix, 1);
  }
  return Traveler.structureMatrixCache[room.name];
};

Traveler.getCreepMatrix = function (room) {
  if (!Traveler.creepMatrixCache[room.name] || Game.time !== Traveler.creepMatrixTick) {
    Traveler.creepMatrixTick = Game.time;
    Traveler.creepMatrixCache[room.name] = Traveler.addCreepsToMatrix(room, Traveler.getStructureMatrix(room, true).clone());
  }
  return Traveler.creepMatrixCache[room.name];
};

Traveler.addStructuresToMatrix = function (room, matrix, roadCost) {
  var impassibleStructures = [];
  var structures = room.find(FIND_STRUCTURES);
  for (var i = 0; i < structures.length; i++) {
    var structure = structures[i];
    if (structure instanceof StructureRampart) {
      if (!structure.my && !structure.isPublic) {
        impassibleStructures.push(structure);
      }
    } else if (structure instanceof StructureRoad) {
      matrix.set(structure.pos.x, structure.pos.y, roadCost);
    } else if (structure instanceof StructureContainer) {
      matrix.set(structure.pos.x, structure.pos.y, 5);
    } else {
      impassibleStructures.push(structure);
    }
  }
  var sites = room.find(FIND_MY_CONSTRUCTION_SITES);
  for (var s = 0; s < sites.length; s++) {
    var site = sites[s];
    if (site.structureType === STRUCTURE_CONTAINER || site.structureType === STRUCTURE_ROAD || site.structureType === STRUCTURE_RAMPART) {
      continue;
    }
    matrix.set(site.pos.x, site.pos.y, 0xFF);
  }
  for (var j = 0; j < impassibleStructures.length; j++) {
    matrix.set(impassibleStructures[j].pos.x, impassibleStructures[j].pos.y, 0xFF);
  }
  return matrix;
};

Traveler.addCreepsToMatrix = function (room, matrix) {
  var creeps = room.find(FIND_CREEPS);
  for (var i = 0; i < creeps.length; i++) {
    var creep = creeps[i];
    matrix.set(creep.pos.x, creep.pos.y, 0xFF);
  }
  return matrix;
};

Traveler.serializePath = function (startPos, path, color) {
  if (!color) color = 'orange';
  var serializedPath = '';
  var lastPosition = startPos;
  Traveler.circle(startPos, color);
  for (var i = 0; i < path.length; i++) {
    var position = path[i];
    if (position.roomName === lastPosition.roomName) {
      new RoomVisual(position.roomName).line(position, lastPosition, { color: color, lineStyle: 'dashed' });
      serializedPath += lastPosition.getDirectionTo(position);
    }
    lastPosition = position;
  }
  return serializedPath;
};

Traveler.positionAtDirection = function (origin, direction) {
  var offsetX = [0, 0, 1, 1, 1, 0, -1, -1, -1];
  var offsetY = [0, -1, -1, 0, 1, 1, 1, 0, -1];
  var x = origin.x + offsetX[direction];
  var y = origin.y + offsetY[direction];
  if (x > 49 || x < 0 || y > 49 || y < 0) {
    return;
  }
  return new RoomPosition(x, y, origin.roomName);
};

Traveler.patchMemory = function (cleanup) {
  if (cleanup === undefined) cleanup = false;
  if (!Memory.empire) {
    return;
  }
  if (!Memory.empire.hostileRooms) {
    return;
  }
  var count = 0;
  for (var roomName in Memory.empire.hostileRooms) {
    if (!Memory.empire.hostileRooms.hasOwnProperty(roomName)) continue;
    if (Memory.empire.hostileRooms[roomName]) {
      if (!Memory.rooms[roomName]) {
        Memory.rooms[roomName] = {};
      }
      Memory.rooms[roomName].avoid = 1;
      count++;
    }
    if (cleanup) {
      delete Memory.empire.hostileRooms[roomName];
    }
  }
  if (cleanup) {
    delete Memory.empire.hostileRooms;
  }
  console.log('TRAVELER: room avoidance data patched for ' + count + ' rooms');
};

Traveler.deserializeState = function (travelData, destination) {
  var state = {};
  if (travelData.state) {
    state.lastCoord = { x: travelData.state[STATE_PREV_X], y: travelData.state[STATE_PREV_Y] };
    state.cpu = travelData.state[STATE_CPU];
    state.stuckCount = travelData.state[STATE_STUCK];
    state.destination = new RoomPosition(travelData.state[STATE_DEST_X], travelData.state[STATE_DEST_Y], travelData.state[STATE_DEST_ROOMNAME]);
  } else {
    state.cpu = 0;
    state.destination = destination;
  }
  return state;
};

Traveler.serializeState = function (creep, destination, state, travelData) {
  travelData.state = [
    creep.pos.x,
    creep.pos.y,
    state.stuckCount,
    state.cpu,
    destination.x,
    destination.y,
    destination.roomName
  ];
};

Traveler.isStuck = function (creep, state) {
  var stuck = false;
  if (state.lastCoord !== undefined) {
    if (Traveler.sameCoord(creep.pos, state.lastCoord)) {
      stuck = true;
    } else if (Traveler.isExit(creep.pos) && Traveler.isExit(state.lastCoord)) {
      stuck = true;
    }
  }
  return stuck;
};

module.exports = Traveler;

Creep.prototype.travelTo = function (destination, options) {
  return Traveler.travelTo(this, destination, options);
};
