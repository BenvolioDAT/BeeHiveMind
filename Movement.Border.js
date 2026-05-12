'use strict';
// owns: exit-tile detection and move-off-exit recovery helper.
// does not own: intent queueing.
// called by: Movement.Manager facade.
function isExitPosition(pos){return !!(pos&&(pos.x===0||pos.x===49||pos.y===0||pos.y===49));}
function tryMoveOffExit(creep, destination, travelOpts){if(!creep||creep.fatigue>0||!isExitPosition(creep.pos)||typeof creep.travelTo!=='function')return null;var resultData={};var opts=Object.assign({},travelOpts||{},{range:0,returnData:resultData});var result=creep.travelTo(destination,opts);return{result:result,data:resultData};}
module.exports={isExitPosition:isExitPosition,tryMoveOffExit:tryMoveOffExit};
