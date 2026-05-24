'use strict';

// Thin Veinseeker router. Behavior lives in role.Veinseeker.Home.js and
// role.Veinseeker.Remote.js.
var VeinseekerHome = require('role.Veinseeker.Home');
var VeinseekerRemote = require('role.Veinseeker.Remote');

function inferMode(creep) {
  if (!creep || !creep.memory) return 'home';
  if (creep.memory.mode === 'remote' || creep.memory.mode === 'home') return creep.memory.mode;
  var home = creep.memory.home || creep.memory._home || (creep.room && creep.room.name);
  if (creep.memory.targetRoom && creep.memory.targetRoom !== home) return 'remote';
  return 'home';
}

function run(creep) {
  if (!creep || !creep.memory) return;
  creep.memory.role = 'Veinseeker';
  creep.memory.task = 'veinseeker';
  var mode = inferMode(creep);
  creep.memory.mode = mode;
  if (mode === 'remote') return VeinseekerRemote.run(creep);
  return VeinseekerHome.run(creep);
}

module.exports = {
  run: run,
  runHome: VeinseekerHome.run,
  runRemote: VeinseekerRemote.run
};
