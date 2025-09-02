// Import core modules for different logic areas
var BeeMaintenance = require('BeeMaintenance'); // Handles memory cleanup and repair target tracking
var BeeVisuals = require('BeeVisuals');         // Handles visuals and overlays in the room
var BeeHiveMind = require('BeeHiveMind');       // Central logic hub for managing creeps, spawns, and roles
var towerLogic = require('tower.logic');        // Tower management: defense and repairs
var roleLinkManager = require('role.LinkManager'); // Logic for energy transfer between links
var BeeToolbox = require('BeeToolbox');         // Utility functions for movement, energy, etc.
var Traveler = require('Traveler');

// Initialize CPU usage tracking memory
if (!Memory.cpuUsage) Memory.cpuUsage = []; // Array to store CPU usage data per tick

// Capture the starting CPU usage for this tick (used for delta calculations)
const tickStart = Game.cpu.getUsed();

// Logging levels for controlling console output detail
global.LOG_LEVEL = { NONE: 0, BASIC: 1, DEBUG: 2 }; // Define levels: NONE < BASIC < DEBUG
global.currentLogLevel = LOG_LEVEL.DEBUG; // Default log level (adjust to DEBUG for more output)

// Pixel generation flag (set to 1 to enable pixel generation when conditions met)
const GenPixel = 1;
// Main game loop function that runs every tick
module.exports.loop = function () {
    // Every 3 ticks, log containers near sources in all rooms
    if (Game.time % 3 === 0) { 
        for (const roomName in Game.rooms) { 
            const room = Game.rooms[roomName];
            BeeToolbox.logSourceContainersInRoom(room); // Logs containers near sources for Courier_Bee logic
        }
    }

    // Perform routine memory cleanup for creeps and rooms
    BeeMaintenance.cleanUpMemory();

    // Run the core creep and room logic through the HiveMind system
    BeeHiveMind.run();

    // Execute tower logic: defense and repair
    towerLogic.run();

    // Run link management logic for transferring energy
    roleLinkManager.run();

    // Draw visuals such as CPU usage, creep data, and repair info
    BeeVisuals.drawVisuals();

    BeeVisuals.drawEnergyBar();
    
    BeeVisuals.drawWorkerBeeTaskTable()

    // Handle repair target list updates every 5 ticks
    if (Memory.GameTickRepairCounter === undefined) Memory.GameTickRepairCounter = 0;
    Memory.GameTickRepairCounter++;
    if (Memory.GameTickRepairCounter >= 5) {
        Memory.GameTickRepairCounter = 0;
        for (const roomName in Game.rooms) {
            const room = Game.rooms[roomName];
            Memory.rooms[roomName].repairTargets = BeeMaintenance.findStructuresNeedingRepair(room);
        }
    }

    // Track the first spawn's room in memory every 10 ticks
    if (Memory.GameTickCounter === undefined) Memory.GameTickCounter = 0;
    Memory.GameTickCounter++;
    if (Memory.GameTickCounter >= 10) {
        Memory.GameTickCounter = 0;
        const spawns = Object.values(Game.spawns);
        if (spawns.length > 0) {
            const currentRoom = spawns[0].room.name;
            if (currentRoom !== Memory.firstSpawnRoom) {
                Memory.firstSpawnRoom = currentRoom;
                if (currentLogLevel >= LOG_LEVEL.DEBUG) {
                    console.log("Updated Memory.firstSpawnRoom to:", currentRoom);
                }
            }
        } else if (currentLogLevel >= LOG_LEVEL.DEBUG) {
            console.log("No spawns found.");
        }
    }
BeeMaintenance.cleanStaleRooms();
    // Every 50 ticks, clean up stale room memory for rooms not seen in a while
    if (Game.time % 50 === 0) {
        BeeMaintenance.cleanStaleRooms();
    }

    // Generate pixels if enabled and CPU bucket is full
    if (GenPixel >= 1 && Game.cpu.bucket >= 9900 && Game.time % 5 === 0) {
        const result = Game.cpu.generatePixel();
        if (result === OK && currentLogLevel >= LOG_LEVEL.BASIC) {
            console.log("Pixel generated successfully.");
        }
    };
}

