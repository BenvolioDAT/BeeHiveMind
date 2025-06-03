  // Logging Levels
  const LOG_LEVEL = {NONE: 0,BASIC: 1,DEBUG: 2};
  //if (currentLogLevel >= LOG_LEVEL.DEBUG) {}  
  const currentLogLevel = LOG_LEVEL.NONE;  // Adjust to LOG_LEVEL.DEBUG for more detailed logs
// Importing all role modules - These are the logic files for each creep role
var roleQueen = require('role.Queen');
var roleScout = require('role.Scout');
var roleHoneyGuard = require('role.HoneyGuard');
var roleWinged_Archer = require('role.Winged_Archer');
var roleApiary_Medics = require('role.Apiary_Medics');
var spawnLogic = require('spawn.logic');
var roleSiege_Bee = require('role.Siege_Bee');
var roleWorker_Bee = require('role.Worker_Bee');

// Creep role function mappings, wrapping their run methods for easier execution
var creepRoles = {
    Queen: roleQueen.run,
    Scout: roleScout.run,
    HoneyGuard: roleHoneyGuard.run,
    Winged_Archer: roleWinged_Archer.run,
    Apiary_Medics: roleApiary_Medics.run,
    Siege_Bee: roleSiege_Bee.run,
    Worker_Bee: roleWorker_Bee.run,
};

// Core BeeHiveMind object to manage creeps, rooms, and spawning
const BeeHiveMind = {
    // Main entry point called each tick
    run() {
        BeeHiveMind.initializeMemory(); // Ensure room memory structure is initialized

        // Loop through all rooms, handling per-room logic
        for (let roomName in Game.rooms) {
            const room = Game.rooms[roomName];
            BeeHiveMind.manageRoom(room);
        }

        // Loop through all creeps and run their role logic
        for (let name in Game.creeps) {
            const creep = Game.creeps[name];
            BeeHiveMind.assignRole(creep);
        }

        // Handle spawning logic across rooms
        BeeHiveMind.manageSpawns2();
        BeeHiveMind.manageSpawns();
    
        // Placeholder for managing remote operations (scouting, remote mining, claiming)
        BeeHiveMind.manageRemoteOps();
    },

    // Placeholder function for any room-specific logic you'd like to add later
    manageRoom(room) {
        // No current room-specific logic
    },

    // BeeHiveMind.js

    assignTask(creep) {
    // Example: Assign default tasks based on role
        if (!creep.memory.task) {
             if (creep.memory.role === 'Queen') {
                creep.memory.task = 'queen';
            } else if (creep.memory.role === 'Scout') {
                creep.memory.task = 'scout';
            } else if (creep.memory.role === 'repair') {
                creep.memory.task = 'repair';
            }
        }
    },

    // Determines the role of a creep and executes its logic
    assignRole(creep) {
        
        BeeHiveMind.assignTask(creep); // Assign a task if not already set
        var roleFn = creepRoles[creep.memory.role]; // Get the role function from the role map
        if (roleFn) {
            roleFn(creep); // Run the creep's role function
        } else {
            const creepName = creep.name || 'unknown';
            const role = creep.memory.role || 'undefined';
            console.log(`🐝 Unknown role: ${role} (Creep: ${creepName})`, 'color: red; font-weight: bold;'); // Log unknown roles
        }
    },

    // Manages spawning creeps based on room needs
    manageSpawns() {
        const spawner = _.find(Game.spawns, s => !s.spawning); // Find an idle spawner
        if (!spawner) return; // Exit if no spawner available

        const roomName = spawner.room.name; // The room of the spawner
        const spawnResource = spawnLogic.Calculate_Spawn_Resource(); // Calculate resources for spawning
        const limits = (Memory.rooms[roomName] && Memory.rooms[roomName].creepLimits) || {}; // Fetch room-specific creep limits

        // Define bee roles and their spawn limits and body configurations
        const beeTypes = [
            { name: 'Queen', limit: limits.Queen_Number_Limit, Body: spawnLogic.Generate_Queen_Body },
            { name: 'Winged_Archer', limit: limits.Winged_Archer_Number_Limit, Body: spawnLogic.Generate_Winged_Archer_Body },
            { name: 'Apiary_Medics', limit: limits.Apiary_Medics_Number_Limit, Body: spawnLogic.Generate_Apiary_Medic_Body },
            { name: 'Scout', limit: limits.Scout_Number_Limit, Body: spawnLogic.Generate_Scout_Body },
            { name: 'HoneyGuard', limit: limits.HoneyGuard_Number_Limit, Body: spawnLogic.Generate_HoneyGuard_Body },
            { name: 'Siege_Bee', limit: limits.Siege_Bee_Number_Limit, Body: spawnLogic.Generate_Siege_Bee_Body },
        ];

        const roleCounts = _.countBy(Game.creeps, c => c.memory.role); // Count existing creeps by role

        // Loop through bee roles, spawning if under limit
        for (const bee of beeTypes) {
            const count = roleCounts[bee.name] || 0;
            if (count < bee.limit) {
                const bodyConfig = bee.Body(spawnResource); // Get body configuration for this role
                try {
                    const result = spawnLogic.Spawn_Creep_Role(spawner, bee.name, () => bodyConfig, spawnResource, {
                        memory: { role: bee.name, spawnRoom: spawner.room.name }
                    });
                    if (result === OK) {
                        console.log(`${bee.name} spawned successfully.`);
                    }
                } catch (error) {
                    console.error(`Failed to spawn ${bee.name}: ${error}`);
                }
                break; // Spawn one creep per tick
            }
        }
    },

    manageSpawns2() {
        // Configurable quotas for each task type
        const workerTaskLimits = {
            baseharvest: 2,
            builder: 2,
            upgrader: 2,
            repair: 0,
            courier: 2,
            remoteharvest: 10,
            scout: 0,
        };

        // Count how many creeps are assigned to each task (across all rooms)
        const roleCounts = _.countBy(Game.creeps, c => c.memory.task);
        if (currentLogLevel >= LOG_LEVEL.DEBUG) {
        console.log('🐝 Task count snapshot:', JSON.stringify(roleCounts));
            }


        // Loop through your spawns and fill missing task slots
        for (const spawnName in Game.spawns) {
            const spawner = Game.spawns[spawnName];
            if (spawner.spawning) continue; // Skip if already spawning

            // Try to find a missing task to fill
            for (const [task, limit] of Object.entries(workerTaskLimits)) {
                const count = roleCounts[task] || 0;
                if (count < limit) {
                    const spawnResource = spawnLogic.Calculate_Spawn_Resource(spawner);
                    const didSpawn = spawnLogic.Spawn_Worker_Bee(spawner, task, spawnResource);
                    if (didSpawn) {
                        // Only try to spawn one creep per tick per spawn
                        break;
                    }
                }
            }
        }
    },
    
    // Placeholder for remote operations like foraging, scouting, claiming
    manageRemoteOps() {
        // assignment, scouting, room claiming logic
    },

    // Initializes creep limits and memory structure for each room
    initializeMemory() {
        if (!Memory.rooms) Memory.rooms = {}; // Initialize rooms memory if missing

        for (const roomName in Memory.rooms) {
            if (!Memory.rooms[roomName]) {
                Memory.rooms[roomName] = {}; // Initialize room memory
            }

            // Set default creep limits if missing
            if (!Memory.rooms[roomName].creepLimits) {
                Memory.rooms[roomName].creepLimits = {
                    Scout_Number_Limit: 0,
                    Queen_Number_Limit: 1,
                    HoneyGuard_Number_Limit: 0,
                    Apiary_Medics_Number_Limit: 0,
                    Winged_Archer_Number_Limit: 0,
                    Siege_Bee_Number_Limit: 0,
                };
            }
        }
    }
};

module.exports = BeeHiveMind; // Export the BeeHiveMind module for use in main.js
