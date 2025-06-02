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
        return Generate_Builder_Bee_Body(Calculate_Spawn_Resource);
      case 'repair':
        return Generate_Repair_Body(Calculate_Spawn_Resource);
      case 'harvest':
        return Generate_Forager_Bee_Body(Calculate_Spawn_Resource);
      case 'upgrade':
        return Generate_Nectar_Bee_Body(Calculate_Spawn_Resource);
      case 'courier':
        return Generate_Courier_Bee_Body(Calculate_Spawn_Resource);
    }
    
  }

  function Spawn_Worker_Bee(spawn, neededTask, Calculate_Spawn_Resource) {
    let body = getBodyForTask(neededTask, Calculate_Spawn_Resource);
    let name = Generate_Creep_Name('Worker_Bee');
    let memory = { role: 'Worker_Bee', task: neededTask };
    let result = spawn.spawnCreep(body, name, { memory: memory }); 
    if (result === OK ) {
      console.log(`🟢 Spawned Worker_Bee: ${name} for task ${neededTask}`);
      return true;
    }
    return false; // If spawning failed, return false
  }

  // Function to generate a creep name based on the set number value
  function Generate_Creep_Name(role) {
    for (var i = 1; i <= 10; i++) {
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
// 🧱 Body configurations per role
// Each role has a list of possible body arrays. The spawn will choose the most powerful one it can afford.
// Role-specific configurations
const Nurse_Bee_Config = [
  [WORK, WORK, WORK, WORK, WORK, WORK, WORK, MOVE,  MOVE, MOVE, MOVE, MOVE, CARRY],
  [WORK, WORK, WORK, WORK, WORK, WORK,  MOVE, MOVE, MOVE, MOVE, CARRY],
  [WORK, WORK, WORK, WORK, WORK, MOVE, MOVE, MOVE, CARRY],
  [WORK, WORK, WORK, WORK, MOVE, MOVE, CARRY],
  [WORK, WORK, WORK, MOVE, MOVE, CARRY],
  [WORK, WORK, MOVE, MOVE, CARRY],
  [WORK, WORK, MOVE, CARRY],
  [WORK, MOVE, CARRY],
];
// Role-specific configurations
const Courier_Bee_Config = [
  [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
  [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
  [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
  [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
  [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
  [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
  [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
  [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
  [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
  [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
  [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
  [CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE],
  [CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE],
  [CARRY, CARRY, CARRY, MOVE, MOVE, MOVE],
  [CARRY, CARRY, MOVE, MOVE],
  [CARRY, MOVE],
];
// Role-specific configurations
const Builder_Bee_Config = [
  [WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE],
  [WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE],
  [WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE],
  [WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE],
  [WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE],
  [WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE],
  [WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE],
  [WORK, WORK, CARRY, MOVE, MOVE,],
  [WORK, WORK, CARRY, MOVE],
  [WORK, CARRY, MOVE],
];
// Role-specific configurations
const Nectar_Bee_Config = [
  [WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE],
  [WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE],
  [WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE],
  [WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE],
  [WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE],
  [WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE],
  [WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE],
  [WORK, WORK, CARRY, MOVE, MOVE,],
  [WORK, WORK, CARRY, MOVE],
  [WORK, CARRY, MOVE],
];
// Role-specific configurations
const Repair_Config = [
  //[WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE],
  //[WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE],
  //[WORK, WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE],//700E
  //[WORK, WORK, WORK, CARRY, CARRY, MOVE, MOVE, MOVE],//550
  //[WORK, WORK, CARRY, MOVE, MOVE,],//350E
  //[WORK, WORK, CARRY, MOVE],//300E
  [WORK, CARRY, MOVE],//200E
];
// Role-specific configurations
const Queen_Config = [
  [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE],
  [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE],
  [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE],
  [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE],
  [CARRY, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE],
  [CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE],
  [CARRY, CARRY, CARRY, CARRY, MOVE, MOVE],
  [CARRY, CARRY, CARRY, MOVE, MOVE],
  [CARRY, CARRY, MOVE],
  [CARRY, MOVE],
];
// Role-specific configurations
const Forager_Bee_Config = [
  //[WORK, WORK, WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE, MOVE],
  //[WORK, WORK, WORK, CARRY, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE, MOVE],
  //[WORK, WORK, CARRY, CARRY, CARRY, CARRY, MOVE, MOVE, MOVE],
  //[WORK, CARRY, CARRY, MOVE, MOVE, MOVE],
  [WORK, WORK, CARRY, CARRY, MOVE, MOVE],
  [WORK, CARRY, CARRY, MOVE, MOVE],
  [WORK, CARRY, MOVE, MOVE],
];
const Scout_Config = [
[MOVE],
];
const HoneyGuard_Config = [
  //[TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, MOVE, TOUGH, MOVE, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
  //[TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, MOVE, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
  //[TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
  //[TOUGH, TOUGH, TOUGH, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
  //[TOUGH, ATTACK, ATTACK, ATTACK, ATTACK, ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
  [TOUGH, ATTACK, ATTACK, ATTACK, ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE],
  [TOUGH, ATTACK, ATTACK, ATTACK, MOVE, MOVE, MOVE, MOVE],
  [TOUGH, ATTACK, ATTACK, MOVE, MOVE, MOVE],
  [TOUGH, ATTACK, MOVE],
];
const Winged_Archer_Config = [
  //[TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
  //[TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
  //[TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
  //[TOUGH, TOUGH, TOUGH, TOUGH, TOUGH, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE],
  [TOUGH, TOUGH, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE],
  [TOUGH, TOUGH, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, MOVE, MOVE, MOVE],
  [TOUGH, RANGED_ATTACK, RANGED_ATTACK, MOVE, MOVE],
  [TOUGH, RANGED_ATTACK, MOVE],
];
const Apiary_Medic_Config = [
  //[MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL],
  //[MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL],
  //[MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL],
  //[MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL],
  //[MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL],
  //[MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL],
  //[MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL],
  //[MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL],
  //[MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL],
  //[MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL],
  //[MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL],
  //[MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL],
  //[MOVE, MOVE, MOVE, MOVE, MOVE, MOVE, HEAL, HEAL, HEAL, HEAL, HEAL, HEAL],
  //[MOVE, MOVE, MOVE, MOVE, MOVE, HEAL, HEAL, HEAL, HEAL, HEAL],
  [MOVE, MOVE, MOVE, MOVE, HEAL, HEAL, HEAL, HEAL],
  [MOVE, MOVE, MOVE, HEAL, HEAL, HEAL],
  [MOVE, MOVE, HEAL, HEAL],
  [MOVE, HEAL,],
];
const Siege_Bee_Config = [
  [WORK, MOVE],
];
// Array containing all role configurations
const configurations = [
  { role: 'Nurse_Bee', body: Nurse_Bee_Config },
  { role: 'Courier_Bee', body: Courier_Bee_Config },
  { role: 'Builder_Bee', body: Builder_Bee_Config },
  { role: 'Nectar_Bee', body: Nectar_Bee_Config },
  { role: 'Forager_Bee', body: Forager_Bee_Config },
  { role: 'Queen', body: Queen_Config },
  { role: 'repair', body: Repair_Config },
  { role: 'Scout', body: Scout_Config },
  { role: 'HoneyGuard' , body: HoneyGuard_Config },
  { role: 'Winged_Archer' , body: Winged_Archer_Config },
  { role: 'Apiary_Medic' , body: Apiary_Medic_Config },
  { role: 'Siege_Bee' , body: Siege_Bee_Config },
];
// 🔍 Selects the largest body config that fits within current available energy
function Generate_Body_From_Config(role,Calculate_Spawn_Resource) {
  const config = configurations.find(entry => entry.role === role);
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
        console.log(`Available energy for ${role}: ${Calculate_Spawn_Resource}`);
      }
      return selectedConfig;
    } else {
      if (currentLogLevel >= LOG_LEVEL.DEBUG) {
      console.log(`Insufficient energy to spawn ${role}.`);
      }
    }
  } else {
    if (currentLogLevel >= LOG_LEVEL.DEBUG) {
    console.log(`Configuration not found for role: ${role}`);
    }
  }
  return [];
}
// Function to generate creep bodys form configs
// 🔧 Role-specific body generators, used by main loop
function Generate_Courier_Bee_Body(Calculate_Spawn_Resource) {
  return Generate_Body_From_Config('Courier_Bee',Calculate_Spawn_Resource);
}
function Generate_Nurse_Bee_Body(Calculate_Spawn_Resource) {
  return Generate_Body_From_Config('Nurse_Bee',Calculate_Spawn_Resource);
}
function Generate_Builder_Bee_Body(Calculate_Spawn_Resource) {
  return Generate_Body_From_Config('Builder_Bee',Calculate_Spawn_Resource);
}
function Generate_Repair_Body(Calculate_Spawn_Resource) {
  return Generate_Body_From_Config('repair',Calculate_Spawn_Resource);
} 
function Generate_Queen_Body(Calculate_Spawn_Resource) {
  return Generate_Body_From_Config('Queen',Calculate_Spawn_Resource);
}
function Generate_Forager_Bee_Body(Calculate_Spawn_Resource) {
  return Generate_Body_From_Config('Forager_Bee',Calculate_Spawn_Resource);
}
function Generate_Nectar_Bee_Body(Calculate_Spawn_Resource) {
  return Generate_Body_From_Config('Nectar_Bee',Calculate_Spawn_Resource);
}
function Generate_Scout_Body(Calculate_Spawn_Resource) {
  return Generate_Body_From_Config('Scout', Calculate_Spawn_Resource);
}
function Generate_HoneyGuard_Body(Calculate_Spawn_Resource){
  return Generate_Body_From_Config('HoneyGuard', Calculate_Spawn_Resource);
}
function Generate_Winged_Archer_Body(Calculate_Spawn_Resource){
  return Generate_Body_From_Config('Winged_Archer' , Calculate_Spawn_Resource);
}
function Generate_Apiary_Medic_Body(Calculate_Spawn_Resource){
  return Generate_Body_From_Config('Apiary_Medic' , Calculate_Spawn_Resource);
}
function Generate_Siege_Bee_Body(Calculate_Spawn_Resource){
  return Generate_Body_From_Config('Siege_Bee' , Calculate_Spawn_Resource);
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
    Generate_Courier_Bee_Body,
    Generate_Nurse_Bee_Body,
    Generate_Nectar_Bee_Body,
    Generate_Builder_Bee_Body,
    Generate_Repair_Body,
    Generate_Queen_Body,
    Generate_Forager_Bee_Body,
    Generate_Scout_Body,
    Generate_HoneyGuard_Body,
    Generate_Winged_Archer_Body,
    Generate_Apiary_Medic_Body,
    Generate_Siege_Bee_Body,
    getBodyForTask,
    Spawn_Worker_Bee,
  };