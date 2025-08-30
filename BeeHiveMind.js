// Logging Levels
const LOG_LEVEL = {NONE: 0,BASIC: 1,DEBUG: 2};
//if (currentLogLevel >= LOG_LEVEL.DEBUG) {}  
//const currentLogLevel = LOG_LEVEL.NONE;  // Adjust to LOG_LEVEL.DEBUG for more detailed logs
// Importing all role modules - These are the logic files for each creep role
var spawnLogic = require('spawn.logic');
var roleWorker_Bee = require('role.Worker_Bee');

// Creep role function mappings, wrapping their run methods for easier execution
var creepRoles = {Worker_Bee: roleWorker_Bee.run,};

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

    manageSpawns() {
        // Configurable quotas for each task type
        const workerTaskLimits = {
            baseharvest: 2,
            builder: 1,
            upgrader: 1,
            repair: 0,
            courier: 1,
            remoteharvest: 2,
            scout: 1,
            queen: 2,
            CombatArcher: 4,
            CombatMelee: 6,
            CombatMedic: 4,
            Dismantler: 2,
            Trucker: 0,

        };

        // Count how many creeps are assigned to each task (across all rooms)
        //const roleCounts = _.countBy(Game.creeps, c => c.memory.task);
        // Exact parity with _.countBy(Game.creeps, c => c.memory.task)
        /*const roleCounts = {};
            for (const name in Game.creeps) {
                const task = Game.creeps[name].memory.task; // no fallback, just like lodash
                roleCounts[task] = (roleCounts[task] || 0) + 1;
                }

        if (currentLogLevel >= LOG_LEVEL.DEBUG) {
        console.log('🐝 Task count snapshot:', JSON.stringify(roleCounts));
            }
        */
       // put this near your other constants
        const DYING_SOON_TTL = 25;

        // --- your existing block, with a lil’ ghost filter ---
        const roleCounts = {};
        const dyingSoonCounts = {}; // optional: for debug visibility

        for (const name in Game.creeps) {
        const creep = Game.creeps[name];
        const task = creep.memory.task; // no fallback, just like lodash
        const ttl = creep.ticksToLive;

        // New: ignore creeps about to croak (TTL <= 50).
        // Newborns sometimes have undefined TTL for a tick—still count those.
        if (typeof ttl === 'number' && ttl <= DYING_SOON_TTL) {
            dyingSoonCounts[task] = (dyingSoonCounts[task] || 0) + 1; // optional
            continue;
        }

        roleCounts[task] = (roleCounts[task] || 0) + 1;
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
                        // 🔧 NEW: make the snapshot reflect the scheduled spawn
                        roleCounts[task] = (roleCounts[task] || 0) + 1;
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
        }
    }
};

module.exports = BeeHiveMind; // Export the BeeHiveMind module for use in main.js
