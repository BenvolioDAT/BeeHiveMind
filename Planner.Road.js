"use strict";
// DEPRECATED: forwarded to Task.Builder.Planner.js
var BuilderPlanner = require('Task.Builder.Planner');
module.exports = {
  CONFIG: BuilderPlanner.CONFIG && BuilderPlanner.CONFIG.road || {},
  computeHub: BuilderPlanner.computeHub,
  getOrCreatePath: BuilderPlanner.getOrCreatePath,
  materializePath: BuilderPlanner.materializePath,
  ensureRemoteRoads: BuilderPlanner.ensureRemoteRoads,
  _ensureRemoteContainer: BuilderPlanner._ensureRemoteContainer,
  getActiveRemoteRooms: BuilderPlanner.getActiveRemoteRooms
};
