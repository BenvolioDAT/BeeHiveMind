'use strict';
// owns: movement intent creation, priority lookup, intent compare ordering.
// does not own: traveler execution and border recovery execution.
// called by: Movement.Manager facade.
var PRIORITIES={emergency:100,combat:90,attack:90,rangedAttack:90,heal:90,rangedHeal:90,pickup:80,withdraw:70,deliver:60,harvest:55,build:50,repair:45,upgrade:40,reserve:35,claim:35,scout:30,idle:5,default:0};
function priorityFromOpts(opts){if(!opts||!opts.intentType)return PRIORITIES.default;var k=opts.intentType;return Object.prototype.hasOwnProperty.call(PRIORITIES,k)?PRIORITIES[k]:PRIORITIES.default;}
function compareIntents(a,b){if(b.priority!==a.priority)return b.priority-a.priority;if(a.order!==b.order)return a.order-b.order;var aId=a.creepId||a.creepName,bId=b.creepId||b.creepName;if(aId<bId)return-1;if(aId>bId)return 1;if(a.creepName<b.creepName)return-1;if(a.creepName>b.creepName)return 1;return 0;}
module.exports={PRIORITIES:PRIORITIES,priorityFromOpts:priorityFromOpts,compareIntents:compareIntents};
