// BeeVisuals.js 🎨🐝
var TaskBuilder = require('./Task.Builder'); // Import Builder Bee role for building tasks
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
        if (currentLogLevel >= LOG_LEVEL.DEBUG) {
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
        // Draw a visual for the TaskBuilder
        const spawn = Game.spawns[Object.keys(Game.spawns)[0]];
            if (spawn) {
                const visual = new RoomVisual(spawn.room.name);
                const baseX = spawn.pos.x;
                const baseY = spawn.pos.y;

                for (const placement of TaskBuilder.structurePlacements) {
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
        const y = 19; // Adjust as needed
        const width = 8.5; // Bar width
        const height = 1 ; // Bar height

        // Draw the background bar
        visuals.rect(x, y, width, height, {
            fill: '#555555',
            opacity: 0.3,
            stroke: '#000000'
        });

        // Draw the fill bar
        visuals.rect(x, y, width * percentage, height, {
            fill: '#00ff00',
            opacity: 0.2,
            stroke: '#000000'
        });

        // Draw the text
        visuals.text(`${energy}/${capacity}`, x + width / 2, y + height - .15 , {
            color: 'white',
            font: 1,
            align: 'center',
            valign: 'middle',
            opacity: 0.5,
            stroke: '#000000'
        });
    },

drawWorkerBeeTaskTable: function() {
    const roomName = Memory.firstSpawnRoom;
    if (!roomName || !Game.rooms[roomName]) return;
    const visual = new RoomVisual(roomName);

    // Gather bees and tasks (same as before)
    const workerBees = _.filter(Game.creeps, c => c.memory.role === 'Worker_Bee');
    const totalCount = workerBees.length;
    //const maxTotal = 50;

    const maxTasks = {
        baseharvest: 2,
        builder: 4,
        upgrader: 1,
        repair: 1,
        courier: 2,
        remoteharvest: 10,
        scout: 1,
    };
    
    const maxTotal = Object.values(maxTasks).reduce((sum, count) => sum + count, 0);

    const tasks = {};
    for (const creep of workerBees) {
        const task = creep.memory.task || 'idle';
        if (!tasks[task]) tasks[task] = 0;
        tasks[task]++;
    }
    for (let t in maxTasks) if (!tasks[t]) tasks[t] = 0;
    const taskNames = Object.keys(maxTasks);
    const nRows = 1 + taskNames.length;

    // **Customizable column widths!**
    const x0 = 0, y0 = 20;
    const nameW = 6;   // Left (task name) cell width
    const valueW = 2.5;  // Right (count/max) cell width
    const cellH = 1;
    const font = 0.7;
    const fillColor = "#ffffff";
    const strokeColor = "#000000";

    for (let i = 0; i < nRows; i++) {
        const name = (i === 0) ? "Worker_Bee" : taskNames[i-1];
        const value = (i === 0)
            ? `${totalCount}/${maxTotal}`
            : `${tasks[taskNames[i-1]]}/${maxTasks[taskNames[i-1]]}`;

        // Draw left cell (task name)
        visual.rect(x0, y0 + i*cellH, nameW, cellH, {
            fill: fillColor, 
            stroke: strokeColor, 
            opacity: 0.1, 
            radius: 0.05
        });
        // Draw right cell (count/max)
        visual.rect(x0 + nameW, y0 + i*cellH, valueW, cellH, {
            fill: fillColor, 
            stroke: strokeColor, 
            opacity: 0.1, 
            radius: 0.05
        });

        // Name text (left cell, left-aligned)
        visual.text(name, x0 + 0.3, y0 + i*cellH + cellH/2 + 0.15, {
            font, 
            color: "#000000", 
            align: 'left', 
            valign: 'middle', 
            opacity: 0.7
        });
        // Value text (right cell, right-aligned)
        visual.text(value, x0 + nameW + valueW - 0.3, y0 + i*cellH + cellH/2 + 0.15, {
            font, 
            color: "#000000", 
            align: 'right', 
            valign: 'middle', 
            opacity: 0.7
        });
    }
},

};
// Export the BeeVisuals module so other files can use it
module.exports = BeeVisuals;
