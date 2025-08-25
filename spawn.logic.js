  // Logging Levels
  const LOG_LEVEL = {NONE: 0,BASIC: 1,DEBUG: 2};
  //if (currentLogLevel >= LOG_LEVEL.DEBUG) {}  
  const currentLogLevel = LOG_LEVEL.NONE;  // Adjust to LOG_LEVEL.DEBUG for more detailed logs
var BODYPART_COST = {
    [MOVE]: 50,
    [WORK]: 100,
    [CARRY]: 50,
    [ATTACK]: 80,
    [RANGED_ATTACK]: 150,
    [HEAL]: 250,
    [TOUGH]: 10,
    [CLAIM]: 600,
    // ... add other body parts and their costs
  };
  function getBodyForTask (task, Calculate_Spawn_Resource) {
    switch (task) {
      case 'builder':
        return Generate_Builder_Body(Calculate_Spawn_Resource);
      case 'repair':
        return Generate_Repair_Body(Calculate_Spawn_Resource);
      case 'baseharvest':
        return Generate_BaseHarvest_Body(Calculate_Spawn_Resource);
      case 'upgrader':
        return Generate_Upgrader_Body(Calculate_Spawn_Resource);
      case 'courier':
        return Generate_Courier_Body(Calculate_Spawn_Resource);
      case 'remoteharvest':
        return Generate_RemoteHarvest_Body(Calculate_Spawn_Resource);
      case 'scout':
        return Generate_Scout_Body(Calculate_Spawn_Resource);
      case 'queen':
        return Generate_Queen_Body(Calculate_Spawn_Resource);
      case 'CombatArcher':
        return Generate_CombatArcher_Body(Calculate_Spawn_Resource);
      case 'CombatMelee':
        return Generate_CombatMelee_Body(Calculate_Spawn_Resource);
      case 'CombatMedic':
        return Generate_CombatMedic_Body(Calculate_Spawn_Resource);
      case 'Dismantler':
        return Generate_Dismantler_Config_Body(Calculate_Spawn_Resource);
    }
  }

function Spawn_Worker_Bee(spawn, neededTask, Calculate_Spawn_Resource) {
    let body = getBodyForTask(neededTask, Calculate_Spawn_Resource);
    let name = Generate_Creep_Name(neededTask);
    let memory = { 
        role: 'Worker_Bee',           // Current role/behavior
        task: neededTask,             // Current task
        bornTask: neededTask,       // The "birth role"
        birthBody: body.slice(),      // The original body config (optional, but cool)
    };
    let result = spawn.spawnCreep(body, name, { memory: memory }); 
    if (result === OK) {
        console.log(`🟢 Spawned Worker_Bee: ${name} for task ${neededTask}`);
        return true;
    }
    return false; // If spawning failed, return false
}

  // Function to generate a creep name based on the set number value
  function Generate_Creep_Name(role) {
    for (var i = 1; i <= 70; i++) {
      var newName = role + '_' + i;
      if (!_.some(Game.creeps, (creep) => creep.name === newName)) {
        return newName;
      }
    }
    return null; // No available name found
  }
  function Calculate_Spawn_Resource() {
    let totalSpawnEnergy = 0;
    // Loop through all spawns and calculate their energy
    for (let spawnName in Game.spawns) {
        totalSpawnEnergy += Game.spawns[spawnName].store[RESOURCE_ENERGY];
    }    
    // Use _.sum to calculate the total energy from all extensions
    const extensionEnergy = _.sum(Game.structures, structure =>
        structure.structureType === STRUCTURE_EXTENSION ? structure.store[RESOURCE_ENERGY] : 0
    );  
    return totalSpawnEnergy + extensionEnergy;
}
if (currentLogLevel >= LOG_LEVEL.DEBUG) {
console.log(`Current Calculate_Spawn_Resource: ${Calculate_Spawn_Resource()}`);
}
// ---------- Shorthand Body Config --------------------
const B = (w,c,m)=>[...Array(w).fill(WORK), ...Array(c).fill(CARRY), ...Array(m).fill(MOVE)];// Save on typing do "B(1,1,1)," = (WORK,CARRY,MOVE)
const CM = (c,m)=>[...Array(c).fill(CARRY), ...Array(m).fill(MOVE)];
const WM = (w,m)=>[...Array(w).fill(WORK), ...Array(m).fill(MOVE)];
const MH = (m,h)=>[...Array(m).fill(MOVE), ...Array(h).fill(HEAL)];
const TAM = (t,a,m)=>[...Array(t).fill(TOUGH), ...Array(a).fill(ATTACK), ...Array(m).fill(MOVE)];
const WiPnotReady = (t,b,r,h,w,c,m)=>[...Array(t).fill(TOUGH),...Array(b).fill(ATTACK),...Array(r).fill(RANGED_ATTACK),...Array(h).fill(HEAL),...Array(w).fill(WORK), ...Array(c).fill(CARRY), ...Array(m).fill(MOVE)];
// Each task has a list of possible body arrays. The spawn will choose the most powerful one it can afford.
// Role-specific configurations
const BaseHarvest_Config = [
 B(6,0,5),
 B(5,1,5),
 B(4,1,4),
 B(3,1,3),
 B(2,1,2),
 B(1,1,1), 
];
const Courier_Config = [
  CM(22,22),
  CM(21,21),
  CM(20,20),
  CM(19,19),
  CM(18,18),
  CM(17,17),
  CM(16,16), //800
  CM(15,15), //750
  CM(14,14), //700
  CM(13,13), //650
  CM(12,12), //600
  CM(11,11), //550
  CM(10,10), //500
  CM(9,9),   //450
  CM(8,8),   //400
  CM(7,7),   //350
  CM(6,6),   //300
  CM(5,5),   //250
  CM(4,4),   //200
  CM(3,3),   //150
  CM(2,2),   //100
  CM(1,1),   //50
];

const Builder_Config = [
  //B(17,8,25), // 50 parts
  //B(16,7,23), // 46
  //B(14,7,21), // 42
  //B(13,6,19), // 38
  //B(12,5,17), // 34
  //B(10,5,15), // 30
  //B(9,4,13),  // 26
  //B(8,3,11),  // 22
  B(6,3,9),   // 18
  B(5,2,7),   // 14
  B(4,1,5),   // 10
  B(2,1,3),   // 6
];

const Upgrader_Config = [
  //B(9,4,13),// 26
  //B(8,3,11),// 22
  //B(6,3,9), // 18
  //B(5,2,7), // 14
  B(4,1,5), // 10
  B(2,1,3), // 6
];

const Repair_Config = [
  B(5,2,7),// 14
  B(4,1,5),// 10
  B(2,1,3),// 6
];

const Queen_Config = [
  B(1,10,11),
  B(1,9,10),
  B(1,8,9),
  B(1,7,8),
  B(1,6,7),
  B(1,5,6),
  B(1,4,5),
  B(1,3,4),
  B(1,2,3),
  B(1,1,2),
  B(1,1,1),
];

const RemoteHarvest_Config = [
  //B(5,20,25), // 50 parts: 5W 20C 25M  (1,000 carry cap)
  //B(5,18,23), // 46 900 carry cap
  //B(5,16,21), // 42 800 carry cap
  //B(5,14,19), // 38 700 carry cap
  //B(5,12,17), // 34 600 carry cap
  //B(5,10,15), // 30 500 carry cap
  B(5,8,13),  // 26 400 carry cap
  B(5,6,11),  // 22 300 carry cap
  B(5,4,9),  // 18 200 carry cap
  B(5,2,7),  // 14 100 carry cap
  B(4,2,6),  // 12 100 carry cap
  B(3,2,5),  // 10 100 carry cap
  B(2,2,4),  // 8 100 carry cap
  B(1,1,2),  // 4 50 carry cap
];

const Scout_Config = [
B(0,0,1),  // 4 50 carry cap
];

const CombatMelee_Config = [
  TAM(20,5,25),
  TAM(1,1,1),
];

const CombatArcher_Config = [
  [TOUGH, TOUGH, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
  [TOUGH, TOUGH, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, MOVE, MOVE, MOVE],
  [TOUGH, RANGED_ATTACK, RANGED_ATTACK, MOVE, MOVE],
  [TOUGH, RANGED_ATTACK, MOVE],
];

const CombatMedic_Config = [
  MH(7,7),
  MH(6,6),
  MH(5,5),
  MH(4,4),
  MH(3,3),
  MH(2,2),
  MH(1,1),
];

const Dismantler_Config = [
  WM(25,25),
  WM(20,20),
  WM(15,15),
];

// Array containing all task configurations
const configurations = [
  { task: 'baseharvest', body: BaseHarvest_Config },
  { task: 'courier', body: Courier_Config },
  { task: 'builder', body: Builder_Config },
  { task: 'upgrader', body: Upgrader_Config },
  { task: 'remoteharvest', body: RemoteHarvest_Config },
  { task: 'Queen', body: Queen_Config },
  { task: 'repair', body: Repair_Config },
  { task: 'Scout', body: Scout_Config },
  { task: 'CombatMelee' , body: CombatMelee_Config },
  { task: 'CombatArcher' , body: CombatArcher_Config },
  { task: 'CombatMedic' , body: CombatMedic_Config },
  { task: 'Dismantler_Config' , body: Dismantler_Config },
];


// 🔍 Selects the largest body config that fits within current available energy
function Generate_Body_From_Config(task,Calculate_Spawn_Resource) {
  const config = configurations.find(entry => entry.task === task);
  if (config) {
    let selectedConfig;
    let bodyCost; // Declare bodyCost here
    for (const bodyConfig of config.body) {
      bodyCost = bodyConfig.reduce((totalCost, part) => {
        const partCost = BODYPART_COST[part.toLowerCase()];  // Convert to lowercase
        return totalCost + (partCost ? partCost : 0);
      }, 0);
      if (bodyCost <=Calculate_Spawn_Resource) {
        selectedConfig = bodyConfig;
        break;
      }
    }
    if (selectedConfig) {
      if (currentLogLevel >= LOG_LEVEL.DEBUG) {
        console.log(`Available energy for ${task}: ${Calculate_Spawn_Resource}`);
      }
      return selectedConfig;
    } else {
      if (currentLogLevel >= LOG_LEVEL.DEBUG) {
      console.log(`Insufficient energy to spawn ${task}.`);
      }
    }
  } else {
    if (currentLogLevel >= LOG_LEVEL.DEBUG) {
    console.log(`Configuration not found for task: ${task}`);
    }
  }
  return [];
}
// Function to generate creep bodys form configs
// 🔧 Role-specific body generators, used by main loop
function Generate_Courier_Body(Calculate_Spawn_Resource) {
  return Generate_Body_From_Config('courier',Calculate_Spawn_Resource);
}
function Generate_BaseHarvest_Body(Calculate_Spawn_Resource) {
  return Generate_Body_From_Config('baseharvest',Calculate_Spawn_Resource);
}
function Generate_Builder_Body(Calculate_Spawn_Resource) {
  return Generate_Body_From_Config('builder',Calculate_Spawn_Resource);
}
function Generate_Repair_Body(Calculate_Spawn_Resource) {
  return Generate_Body_From_Config('repair',Calculate_Spawn_Resource);
} 
function Generate_Queen_Body(Calculate_Spawn_Resource) {
  return Generate_Body_From_Config('Queen',Calculate_Spawn_Resource);
}
function Generate_RemoteHarvest_Body(Calculate_Spawn_Resource) {
  return Generate_Body_From_Config('remoteharvest',Calculate_Spawn_Resource);
}
function Generate_Upgrader_Body(Calculate_Spawn_Resource) {
  return Generate_Body_From_Config('upgrader',Calculate_Spawn_Resource);
}
function Generate_Scout_Body(Calculate_Spawn_Resource) {
  return Generate_Body_From_Config('Scout', Calculate_Spawn_Resource);
}
function Generate_CombatMelee_Body(Calculate_Spawn_Resource){
  return Generate_Body_From_Config('CombatMelee', Calculate_Spawn_Resource);
}
function Generate_CombatArcher_Body(Calculate_Spawn_Resource){
  return Generate_Body_From_Config('CombatArcher' , Calculate_Spawn_Resource);
}
function Generate_CombatMedic_Body(Calculate_Spawn_Resource){
  return Generate_Body_From_Config('CombatMedic' , Calculate_Spawn_Resource);
}
function Generate_Dismantler_Config_Body(Calculate_Spawn_Resource){
  return Generate_Body_From_Config('Dismantler' , Calculate_Spawn_Resource);
}

// Function to spawn a creep of a specific role
function Spawn_Creep_Role(spawn, role_name, generateBodyFunction, Spawn_Resource, memory = {}) {
  const bodyParts = generateBodyFunction(Spawn_Resource);
  const newName = Generate_Creep_Name(role_name);
  if (currentLogLevel >= LOG_LEVEL.DEBUG) {
    console.log(`Trying to spawn ${role_name}: ${newName}, Body: [${bodyParts}]`);
  }
  const bodyCost = _.sum(bodyParts, (part) => BODYPART_COST[part]);
  if (currentLogLevel >= LOG_LEVEL.DEBUG) {
    console.log(`${role_name} - Spawn Energy: ${Spawn_Resource}`);
  }  
  if (Spawn_Resource >= bodyCost) {
    if (newName) {
      if (currentLogLevel >= LOG_LEVEL.DEBUG) {
        console.log(`Trying to spawn ${role_name}: ${newName}, Body: [${bodyParts.join(', ')}], Cost: ${bodyCost}`);
      }

      // 👇 Merge the role into the provided memory object
      memory.role = role_name;

      const result = spawn.spawnCreep(bodyParts.map(String), newName, { memory: memory });

      if (currentLogLevel >= LOG_LEVEL.DEBUG) {
        console.log(`Spawn result for ${role_name}: ${result}`);
      }

      if (result === OK) {
        if (currentLogLevel >= LOG_LEVEL.DEBUG) {
          console.log(`🟢 Spawned ${role_name}: ${newName}`);
        }
        return true;
      } else if (result === ERR_NOT_ENOUGH_ENERGY) {
        if (currentLogLevel >= LOG_LEVEL.DEBUG) {
          console.log(`🔴 F spawn ${role_name}: ${newName}. Insufficient energy. Result: ${result}`);
        }
      } else {
        if (currentLogLevel >= LOG_LEVEL.DEBUG) {
          console.log(`🔴 F spawn ${role_name}: ${newName}. Unknown error. Result: ${result}`);
        }
      }
    }
  } else {
    if (currentLogLevel >= LOG_LEVEL.DEBUG) {
      console.log(`Insufficient energy to spawn ${role_name}. Required: ${bodyCost}`);
    }
  }
  return false;
}

  module.exports = {
    Generate_Creep_Name,
    Calculate_Spawn_Resource,
    configurations,
    Generate_Body_From_Config,
    Spawn_Creep_Role,
    Generate_Courier_Body,
    Generate_BaseHarvest_Body,
    Generate_Upgrader_Body,
    Generate_Builder_Body,
    Generate_Repair_Body,
    Generate_Queen_Body,
    Generate_RemoteHarvest_Body,
    Generate_Scout_Body,
    Generate_CombatMelee_Body,
    Generate_CombatArcher_Body,
    Generate_CombatMedic_Body,
    Generate_Dismantler_Config_Body,
    getBodyForTask,
    Spawn_Worker_Bee,
  };