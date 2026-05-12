'use strict';
// owns: repair goals, urgency sort, and per-tick reservations.
// does not own: room scanning.
// called by: BeeSelectors facade.
function computeRepairGoal(s){if(!s||s.hits==null||s.hitsMax==null)return null;var t=s.structureType;if(t===STRUCTURE_WALL)return null;if(t===STRUCTURE_RAMPART){if(s.hits>=50000)return null;return Math.min(s.hitsMax,50000);}if(t===STRUCTURE_ROAD)return Math.min(s.hitsMax,Math.floor(s.hitsMax*0.75));if(t===STRUCTURE_CONTAINER)return Math.min(s.hitsMax,Math.floor(s.hitsMax*0.9));return Math.min(s.hitsMax,Math.floor(s.hitsMax*0.9));}
function byRepairUrgency(a,b){var ar=a.target?(a.target.hits/Math.max(1,a.goalHits)):1;var br=b.target?(b.target.hits/Math.max(1,b.goalHits)):1;if(ar!==br)return ar-br;if(!a.target||!b.target)return 0;return a.target.hits-b.target.hits;}
function resetReservationsIfNeeded(){if(!global.__BHM)return; if(!global.__BHM.repairReservationsTick||global.__BHM.repairReservationsTick!==Game.time){global.__BHM.repairReservationsTick=Game.time;global.__BHM.repairReservations={};}}
module.exports={computeRepairGoal:computeRepairGoal,byRepairUrgency:byRepairUrgency,resetReservationsIfNeeded:resetReservationsIfNeeded};
