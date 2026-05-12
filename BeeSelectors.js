'use strict';
// owns: stable public facade for selector APIs used across roles.
// does not own: internal snapshot/energy/builder/remote/repair implementations.
// called by: role modules, BeeHiveMind, planners via require('BeeSelectors').

var RoomSnapshot = require('Selectors.RoomSnapshot');
var Energy = require('Selectors.Energy');
var Builder = require('Selectors.Builder');
var Remote = require('Selectors.RemoteSources');
var Repair = require('Selectors.Repair');

function buildSnapshot(room){ if(!room) return null; var snap=RoomSnapshot.buildSnapshot(room, Repair.computeRepairGoal); if(snap&&snap.repairs) snap.repairs.sort(Repair.byRepairUrgency); return snap; }
function selectClosestByRange(pos,list){if(!pos||!list||!list.length)return null;var b=null,br=Infinity;for(var i=0;i<list.length;i++){var t=list[i];if(!t)continue;var d=pos.getRangeTo(t);if(d<br){br=d;b=t;}}return b;}

module.exports={
  prepareRoomSnapshot:function(room){return buildSnapshot(room);},
  getRoomEnergyData:function(room){return buildSnapshot(room);},
  findBestEnergyContainer:function(room){return Energy.findBestEnergyContainer(buildSnapshot(room));},
  findBestEnergyDrop:function(room){return Energy.findBestEnergyDrop(buildSnapshot(room));},
  getSourceContainerOrSite:function(source){return Remote.getSourceContainerOrSite(source);},
  getRemoteSourcesSnapshot:function(homeRoomName){return Remote.buildRemoteSourcesSnapshot(homeRoomName);},
  findRemoteSourceContainers:function(homeRoomName){var list=Remote.buildRemoteSourcesSnapshot(homeRoomName),out=[];for(var i=0;i<list.length;i++){var e=list[i];if(e&&e.container)out.push({container:e.container,source:e.source||null,roomName:e.roomName,energy:e.containerEnergy,seatPos:e.seatPos});}return out;},
  pickBestHaulTarget:function(containers,homeRoomName){if(!containers||!containers.length)return null;var best=null,bestScore=-999999;for(var i=0;i<containers.length;i++){var e=containers[i];if(!e||!e.container)continue;var energy=(e.energy==null)?((e.container.store&&e.container.store[RESOURCE_ENERGY])||0):e.energy;var score=energy;if(homeRoomName&&e.roomName){var dist=Game.map.getRoomLinearDistance(homeRoomName,e.roomName,true);if(typeof dist==='number'&&dist>0)score-=dist*25;}if(score>bestScore){bestScore=score;best=e;}}return best;},
  findTombstoneWithEnergy:function(room){var s=buildSnapshot(room);return(s&&s.tombstones.length)?s.tombstones[0]:null;},
  findRuinWithEnergy:function(room){var s=buildSnapshot(room);return(s&&s.ruins.length)?s.ruins[0]:null;},
  findTowersNeedingEnergy:function(room){return Energy.findTowersNeedingEnergy(buildSnapshot(room));},
  findSpawnLikeNeedingEnergy:function(room){return Energy.findSpawnLikeNeedingEnergy(buildSnapshot(room));},
  findStorageNeedingEnergy:function(room){var s=buildSnapshot(room);if(!s||!s.storage)return null; if(s.storage.store.getFreeCapacity(RESOURCE_ENERGY)<=0)return null; return s.storage;},
  getEnergySourcePriority:function(room){return Energy.getEnergySourcePriority(buildSnapshot(room));},
  selectClosestByRange:selectClosestByRange,
  findBestConstructionSite:function(room){var s=buildSnapshot(room);return(s&&s.sites.length)?s.sites[0]:null;},
  classifyBuilderSiteBucket:Builder.classifyBuilderSiteBucket,
  scoreConstructionSiteForBuilder:Builder.scoreConstructionSiteForBuilder,
  selectBestConstructionSiteForBuilder:Builder.selectBestConstructionSiteForBuilder,
  findBestRepairTarget:function(room){var s=buildSnapshot(room);return(s&&s.repairs.length)?s.repairs[0]:null;},
  reserveRepairTarget:function(room,reserverId){if(!room)return null;Repair.resetReservationsIfNeeded();var s=buildSnapshot(room);if(!s||!s.repairs.length)return null;var rn=room.name;if(!global.__BHM.repairReservations[rn])global.__BHM.repairReservations[rn]={};var r=global.__BHM.repairReservations[rn];for(var i=0;i<s.repairs.length;i++){var e=s.repairs[i];if(!e||!e.target||r[e.target.id])continue;r[e.target.id]=reserverId||'anon';return e;}return null;},
  releaseRepairTarget:function(roomName,targetId){if(!roomName||!targetId)return;Repair.resetReservationsIfNeeded();var byRoom=global.__BHM.repairReservations[roomName];if(byRoom&&byRoom[targetId])delete byRoom[targetId];},
  findRoomAnchor:function(room){var s=buildSnapshot(room);return s?s.anchor:null;},
  findControllerLink:function(room){var s=buildSnapshot(room);return s?s.controllerLink:null;},
  findClosestByRange:function(origin,objects){if(!origin||!objects||!objects.length)return null;var pos=origin.pos?origin.pos:origin;if(!pos||pos.x==null)return null;var c=null,b=9999;for(var i=0;i<objects.length;i++){var o=objects[i];if(!o)continue;var tp=o.pos?o.pos:o;if(!tp||tp.x==null)continue;var r=pos.getRangeTo(tp);if(r<b){b=r;c=o;}}return c;},
  findWithinRange:function(origin,objects,maxRange){if(!origin||!objects||!objects.length)return[];var pos=origin.pos?origin.pos:origin;if(!pos||pos.x==null)return[];var range=(typeof maxRange==='number')?maxRange:1,m=[];for(var i=0;i<objects.length;i++){var o=objects[i];if(!o)continue;var tp=o.pos?o.pos:o;if(!tp||tp.x==null)continue;if(pos.getRangeTo(tp)<=range)m.push(o);}return m;}
};
