// ai.utility.js — utility-scoring brain for tasks & creeps



// Persist a summary for observability
Memory.rooms = Memory.rooms || {};
Memory.rooms[room.name] = Memory.rooms[room.name] || {};
Memory.rooms[room.name].signals = sig;


if (currentLogLevel >= LOG_LEVEL.DEBUG) console.log(`📊 ${room.name} signals: ` + JSON.stringify(sig));
return sig;



// ---- Task Scores (per-room) ----
// Output is an object: { taskName: numericScore }
// Keep numbers small; relative order matters.
function scoreTasks(room) {
const S = Memory.rooms?.[room.name]?.signals || computeSignals(room);


// normalize helper
const N = (x, d) => x / (d || 1);


const scores = {
baseharvest: 1 + 2 * (1 - N(room.energyAvailable, room.energyCapacityAvailable)),
courier: 1 + 2 * S.energyNeedRatio + N(S.droppedEnergy, 500) + N(S.sourceBackpressure, 1200),
trucker: N(S.sourceBackpressure, 800) + N(S.droppedEnergy, 400),
builder: N(S.buildRemaining, 50000) + (S.sites > 0 ? 0.5 : 0),
upgrader: (room.storage && room.storage.store[RESOURCE_ENERGY] > 30000 ? 1.5 : 0.3)
+ (room.controller && room.controller.level < 8 ? 0.2 : 0),
repair: 0.2 + 0.4 * N(S.damagedRoads, 40) + 0.6 * N(S.damagedContainers, 10),
remoteharvest: (Memory.remotePlans?.length || 0) > 0 ? 1 : 0, // optional hook; see remote sizing
scout: 0, // raise when you need more vision
};
return scores;
}


// ---- Creep Affinity (prefer tasks that suit the body) ----
function bodyAffinity(creep, task) {
const parts = _.countBy(creep.body, p => p.type);
const W = parts[WORK] || 0;
const C = parts[CARRY] || 0;
const M = parts[MOVE] || 0;


switch (task) {
case 'builder':
case 'repair':
case 'upgrader': return W + 0.1*M; // WORK heavy
case 'courier':
case 'trucker': return C + 0.05*M; // CARRY heavy
case 'baseharvest':
case 'remoteharvest': return 0.6*W + 0.4*M;
default: return 1;
}
}


// ---- Choose best task for this creep with hysteresis ----
function chooseBestTask(creep) {
const room = creep.room;
const scores = scoreTasks(room);


// combine room score with body affinity
const weighted = Object.entries(scores).map(([t, s]) => [t, s * bodyAffinity(creep, t)]);
weighted.sort((a,b) => b[1] - a[1]);


const current = creep.memory.task;
const currentScore = (scores[current] || 0) * bodyAffinity(creep, current);
const best = weighted[0];


const RETARGET_COOLDOWN = 15; // ticks
const HYSTERESIS = 1.25; // require 25% better to switch


creep.memory._nextRetarget = creep.memory._nextRetarget || 0;
if (Game.time < creep.memory._nextRetarget) return current || (best && best[0]) || 'idle';


if (!current || !best || best[1] > currentScore * HYSTERESIS) {
creep.memory._nextRetarget = Game.time + RETARGET_COOLDOWN;
return best ? best[0] : 'idle';
}
return current;
}


module.exports = { computeSignals, scoreTasks, chooseBestTask };