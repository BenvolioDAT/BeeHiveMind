'use strict';
// owns: energy selection priority from room snapshot slices.
// does not own: snapshot building.
// called by: BeeSelectors facade.
function findBestEnergyContainer(snap){if(!snap)return null; if(snap.sourceContainers.length)return snap.sourceContainers[0]; if(snap.otherContainers.length)return snap.otherContainers[0]; return null;}
function findBestEnergyDrop(snap){return (snap&&snap.dropped.length)?snap.dropped[0]:null;}
function findSpawnLikeNeedingEnergy(snap){return snap?snap.spawnLikeNeedy.slice():[];}
function findTowersNeedingEnergy(snap){return snap?snap.towerNeedy.slice():[];}
function getEnergySourcePriority(snap){if(!snap)return[];var list=[];var i;for(i=0;i<snap.tombstones.length;i++)list.push({kind:'tomb',target:snap.tombstones[i]});for(i=0;i<snap.ruins.length;i++)list.push({kind:'ruin',target:snap.ruins[i]});for(i=0;i<snap.dropped.length;i++)list.push({kind:'drop',target:snap.dropped[i]});for(i=0;i<snap.sourceContainers.length;i++)list.push({kind:'container',target:snap.sourceContainers[i]});if(snap.storage&&(snap.storage.store[RESOURCE_ENERGY]||0)>0)list.push({kind:'storage',target:snap.storage});if(snap.terminal&&(snap.terminal.store[RESOURCE_ENERGY]||0)>0)list.push({kind:'terminal',target:snap.terminal});for(i=0;i<snap.otherContainers.length;i++)list.push({kind:'container',target:snap.otherContainers[i]});for(i=0;i<snap.linksWithEnergy.length;i++)list.push({kind:'link',target:snap.linksWithEnergy[i]});for(i=0;i<snap.sources.length;i++)list.push({kind:'source',target:snap.sources[i]});return list;}
module.exports={findBestEnergyContainer:findBestEnergyContainer,findBestEnergyDrop:findBestEnergyDrop,findSpawnLikeNeedingEnergy:findSpawnLikeNeedingEnergy,findTowersNeedingEnergy:findTowersNeedingEnergy,getEnergySourcePriority:getEnergySourcePriority};
