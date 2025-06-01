// BeeVisuals.js 🎨🐝
var roleBuilder_Bee = require('role.Builder_Bee'); // Import Builder Bee role for building tasks
// Handles RoomVisual overlays for displaying debug information and creep data
  // Logging Levels
  const LOG_LEVEL = {NONE: 0,BASIC: 1,DEBUG: 2};
  //if (currentLogLevel >= LOG_LEVEL.DEBUG) {}  
  const currentLogLevel = LOG_LEVEL.NONE;  // Adjust to LOG_LEVEL.DEBUG for more detailed logs  

const BeeVisuals = {
    // Main function to draw visuals on the screen each tick
    drawVisuals: function () {
        const roomName = Memory.firstSpawnRoom; // The room used for displaying visuals (likely the "main" room)
        if (!roomName || !Game.rooms[roomName]) return; // If no valid room, skip drawing
        const room = Game.rooms[roomName]; // Get the room object
        let yOffset = 1; // Start vertical position for text stacking
        // Iterate over all creeps to display their info
        for (const creepName in Game.creeps) {
            const creep = Game.creeps[creepName];
            const text = [
                `${creep.name}: ${creep.ticksToLive}`, // Creep name and remaining life ticks
                creep.memory.assignedSource ? 'A.S.ID:' + creep.memory.assignedSource : '', // Assigned source ID if set
                creep.memory.assignedContainer ? 'C.ID:' + creep.memory.assignedContainer : '', // Assigned container ID if set
                creep.memory.targetRoom ? `T.R:${creep.memory.targetRoom}` : '', // Target room info if set
                creep.memory.sourceId ? `S.ID:${creep.memory.sourceId}` : '' // Assigned source ID if set
            ].filter(Boolean).join(', '); // Filter out empty strings and join with commas

            // Draw the text at a fixed position in the room, incrementing vertical offset for each creep
            new RoomVisual(room.name).text(text, 0, yOffset++, {
                color: 'white', font: 0.5, opacity: 1, align: 'Left'
            });
        }
        // Draw the CPU bucket value (how much CPU reserve you have)
        new RoomVisual(room.name).text(`CPU Bucket: ${Game.cpu.bucket}`, 20, 1, {
            color: 'white', font: 0.6, opacity: 1
        });
        // Calculate CPU usage delta for performance tracking
        const used = Game.cpu.getUsed(); // Current tick's CPU usage
        const delta = used - (Memory.lastCpuUsage || 0); // Difference from last tick's usage
        Memory.lastCpuUsage = used; // Update for next tick

        // Display CPU usage stats on screen
        new RoomVisual(room.name).text(`CPU Used: ${used.toFixed(2)} / Δ ${delta.toFixed(2)}`, 20, 2, {
            color: 'white', font: 0.6, opacity: 1
        });
        // Display a repair counter (likely linked to repair logic updates)
        const counter = Memory.GameTickRepairCounter || 0;
        new RoomVisual(room.name).text(`Repair Tick Count: ${counter}/5`, 20, 3, {
            color: 'white', font: 0.6, opacity: 1
        });
        /////////////////////////////////////////////
        if (currentLogLevel >= LOG_LEVEL.DEBUG) {
        // Draw a visual for the Builder Bee role
        const spawn = Game.spawns[Object.keys(Game.spawns)[0]];
            if (spawn) {
                const visual = new RoomVisual(spawn.room.name);
                const baseX = spawn.pos.x;
                const baseY = spawn.pos.y;

                for (const placement of roleBuilder_Bee.structurePlacements) {
                    const posX = baseX + placement.x;
                    const posY = baseY + placement.y;
                    visual.circle(posX, posY, { radius: 0.4,opacity: .1, stroke: 'cyan' });
                    //visual.text(placement.type.replace('STRUCTURE_', ''), posX, posY, { font: 0.3, color: 'cyan' });
                }
            }
        }
        ////////////////////////////////////////////
    },
        drawEnergyBar: function() {
        const roomName = Memory.firstSpawnRoom; // The room used for displaying visuals (likely the "main" room)
        if (!roomName || !Game.rooms[roomName]) return; // If no valid room, skip drawing
        const room = Game.rooms[roomName]; // Get the room object    

        const visuals = new RoomVisual(roomName);
        const energy = room.energyAvailable;
        const capacity = room.energyCapacityAvailable;
        const percentage = energy / capacity;

        // Bar position and dimensions
        const x = 0; // Adjust as needed
        const y = 25; // Adjust as needed
        const width = 3; // Bar width
        const height = 0.5 ; // Bar height

        // Draw the background bar
        visuals.rect(x, y, width, height, {
            fill: '#555555',
            opacity: 0.3,
            stroke: '#000000'
        });

        // Draw the fill bar
        visuals.rect(x, y, width * percentage, height, {
            fill: '#00ff00',
            opacity: 0.3,
            stroke: '#000000'
        });

        // Draw the text
        visuals.text(`${energy}/${capacity}`, x + width / 2, y + height / 2, {
            color: 'white',
            font: 0.4,
            align: 'center',
            valign: 'middle'
        });
    },
};
// Export the BeeVisuals module so other files can use it
module.exports = BeeVisuals;
