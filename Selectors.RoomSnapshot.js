'use strict';
// owns: room snapshot construction + per-tick caching for room scans.
// does not own: energy/repair/business decision policies.
// called by: BeeSelectors facade and selector submodules.

var TOWER_REFILL_AT = 0.8;
var BUILD_PRIORITY = { spawn:6, extension:5, tower:4, storage:3, terminal:3, container:2, link:2, road:1 };

function ensureGlobalCache() {
  if (!global.__BHM) global.__BHM = { caches: {} };
  if (!global.__BHM.caches) global.__BHM.caches = {};
  if (typeof global.__BHM.getCached !== 'function') {
    // CPU saver: expensive room scans are cached for this tick only.
    global.__BHM.getCached = function (key, ttl, compute) {
      var caches = global.__BHM.caches; var entry = caches[key]; var now = Game.time;
      if (entry && entry.expireTick >= now) return entry.value;
      var value = compute(); caches[key] = { value: value, expireTick: (ttl > 0) ? (now + ttl) : now }; return value;
    };
  }
}
function byEnergyDesc(a,b){var ae=(a.store&&a.store[RESOURCE_ENERGY])||(a.amount||0);var be=(b.store&&b.store[RESOURCE_ENERGY])||(b.amount||0);return be-ae;}
function byBuildPriority(a,b){var pa=BUILD_PRIORITY[a.structureType]||0;var pb=BUILD_PRIORITY[b.structureType]||0;if(pb!==pa)return pb-pa;return a.progress-b.progress;}
function buildSnapshot(room, computeRepairGoal) {
  ensureGlobalCache();
  return global.__BHM.getCached('selectors:snapshot:'+room.name, 0, function () {
    var snap={room:room,energyContainers:[],sourceContainers:[],otherContainers:[],spawnLikeNeedy:[],towerNeedy:[],dropped:[],tombstones:[],ruins:[],storage:room.storage||null,terminal:room.terminal||null,sites:[],repairs:[],anchor:null,controllerLink:null,linksWithEnergy:[],sources:[]};
    var controller=room.controller||null; var sources=room.find(FIND_SOURCES); for (var si=0;si<sources.length;si++) snap.sources.push(sources[si]);
    var structures=room.find(FIND_STRUCTURES);
    for (var i=0;i<structures.length;i++) { var s=structures[i]; if(!s||!s.structureType) continue;
      if (s.structureType===STRUCTURE_CONTAINER&&s.store){var stored=s.store[RESOURCE_ENERGY]||0; if(stored>0){var near=false; for(var sc=0;sc<sources.length;sc++){if(s.pos.inRangeTo(sources[sc].pos,1)){near=true;break;}} if(near)snap.sourceContainers.push(s); else snap.otherContainers.push(s);} }
      if (s.structureType===STRUCTURE_EXTENSION||s.structureType===STRUCTURE_SPAWN){ if((s.energy||0)<(s.energyCapacity||0)) snap.spawnLikeNeedy.push(s); }
      if (s.structureType===STRUCTURE_TOWER){var used=(s.store[RESOURCE_ENERGY]||0); var cap=s.store.getCapacity(RESOURCE_ENERGY)||1; if((used/cap)<=TOWER_REFILL_AT)snap.towerNeedy.push(s);}
      if (s.structureType===STRUCTURE_LINK){ if(controller&&controller.pos&&s.pos.inRangeTo(controller.pos,3)) snap.controllerLink=s; var le=(s.store&&s.store[RESOURCE_ENERGY])||s.energy||0; if(le>0) snap.linksWithEnergy.push(s); }
      var goal=computeRepairGoal(s); if(goal&&s.hits<goal) snap.repairs.push({target:s, goalHits:goal});
    }
    snap.dropped=room.find(FIND_DROPPED_RESOURCES,{filter:function(r){return r.resourceType===RESOURCE_ENERGY&&r.amount>0;}});
    snap.tombstones=room.find(FIND_TOMBSTONES,{filter:function(t){return t.store&&(t.store[RESOURCE_ENERGY]||0)>0;}});
    snap.ruins=room.find(FIND_RUINS,{filter:function(r){return r.store&&(r.store[RESOURCE_ENERGY]||0)>0;}});
    snap.sites=room.find(FIND_CONSTRUCTION_SITES);
    if(room.storage)snap.anchor=room.storage; else if(room.terminal)snap.anchor=room.terminal; else {var spawns=room.find(FIND_MY_SPAWNS); if(spawns&&spawns.length)snap.anchor=spawns[0];}
    snap.sourceContainers.sort(byEnergyDesc); snap.otherContainers.sort(byEnergyDesc); snap.energyContainers=snap.sourceContainers.concat(snap.otherContainers);
    snap.dropped.sort(byEnergyDesc); snap.tombstones.sort(byEnergyDesc); snap.ruins.sort(byEnergyDesc); snap.sites.sort(byBuildPriority); snap.linksWithEnergy.sort(byEnergyDesc);
    return snap;
  });
}
module.exports = { buildSnapshot: buildSnapshot, byEnergyDesc: byEnergyDesc };
