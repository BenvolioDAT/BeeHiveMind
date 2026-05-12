'use strict';

var RoomPlanner = require('Planner.Room');
var RoadPlanner = require('Planner.Road');

var Planner = {
  ensureSites: function (room) {
    if (!RoomPlanner || typeof RoomPlanner.ensureSites !== 'function') return;
    return RoomPlanner.ensureSites(room);
  },

  ensureRemoteRoads: function (room) {
    if (!RoadPlanner || typeof RoadPlanner.ensureRemoteRoads !== 'function') return;
    return RoadPlanner.ensureRemoteRoads(room);
  },

  getActiveRemoteRooms: function (room) {
    if (!RoadPlanner || typeof RoadPlanner.getActiveRemoteRooms !== 'function') return undefined;
    return RoadPlanner.getActiveRemoteRooms(room);
  }
};

module.exports = Planner;
