global.LOG_LEVEL = { NONE: 0, BASIC: 1, DEBUG: 2 }; // Define levels: NONE < BASIC < DEBUG
global.currentLogLevel = LOG_LEVEL.BASIC; // Default log level (adjust to DEBUG for more output)

var BeeToolbox = {
    // Logs all sources in a room to memory
    logSourcesInRoom: function(room) {
        // Ensure the room's memory object exists
        if (!Memory.rooms[room.name]) {
            Memory.rooms[room.name] = {};
        }
        // Check if sources object already exists and has at least one key
        if (Memory.rooms[room.name].sources) {
            // Sources already logged, skip logging again
            return;
        }
        // If sources object doesn't exist, initialize it
        if (!Memory.rooms[room.name].sources) {
            Memory.rooms[room.name].sources = {};
        }
        // Find all energy sources in the room
        const sources = room.find(FIND_SOURCES);
        // For each source, ensure it's logged as an array for creep assignments
        sources.forEach(source => {
            // If no array exists for this source, create it
            if (!Array.isArray(Memory.rooms[room.name].sources[source.id])) {
                // Old Memory.rooms[room.name].sources[source.id] = {};
                //New
                Memory.rooms[room.name].sources[source.id] = Memory.rooms[room.name].sources[source.id] || {
                    entrySteps: null,     // we’ll fill this the first time a creep enters and measures it
                    reservedBy: null,     // soft lock (see part C)
                    reservedAt: 0
                    };
                console.log(`[BeeToolbox] Logged source ${source.id} in room ${room.name}`);
            }
        });
        // Optional: Log the full sources structure for debugging
        console.log(`[BeeToolbox] Final sources in room ${room.name}:`, JSON.stringify(Memory.rooms[room.name].sources, null, 2));
    },

    // Logs containers near sources in a room to memory
    logSourceContainersInRoom: function(room) {
        if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};
        if (!Memory.rooms[room.name].sourceContainers) Memory.rooms[room.name].sourceContainers = {};
        const containers = room.find(FIND_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_CONTAINER && s.pos.findInRange(FIND_SOURCES, 1).length > 0
        });
        for (const c of containers) {
            if (!Memory.rooms[room.name].sourceContainers.hasOwnProperty(c.id)) {
                Memory.rooms[room.name].sourceContainers[c.id] = null; // Unassigned initially
                console.log(`[🐝 BeeToolbox] Registered container ${c.id} near source in ${room.name}`);
            }
        }
    },

    // Assigns an unassigned container from memory to a Courier_Bee
    assignContainerFromMemory: function(creep) {
        if (!creep.memory.targetRoom || creep.memory.assignedContainer) return;
        const roomMemory = Memory.rooms[creep.memory.targetRoom];
        if (!roomMemory || !roomMemory.sourceContainers) return;
        for (const [containerId, assigned] of Object.entries(roomMemory.sourceContainers)) {
            if (!assigned || !Game.creeps[assigned]) { // Find an unassigned container or one whose creep has died
                creep.memory.assignedContainer = containerId;
                roomMemory.sourceContainers[containerId] = creep.name; // Assign the Courier to the container
                console.log(`🚛 Courier ${creep.name} pre-assigned to container ${containerId} in ${creep.memory.targetRoom}`);
                return;
            }
        }
    },

    // Logs hostile structures in a room (like Invader Cores)
    logHostileStructures: function(room) {
        const invaderCore = room.find(FIND_HOSTILE_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_INVADER_CORE
        });
        if (invaderCore.length > 0) {
            if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};
            Memory.rooms[room.name].hostile = true;
            console.log(`[BeeToolbox] Marked ${room.name} as hostile due to Invader Core.`);
        }
    }, 

    // 🧠 Switch creep between harvesting and returning modes based on energy capacity
    updateReturnState: function (creep) {
        if (creep.memory.returning && creep.store[RESOURCE_ENERGY] === 0) {
            creep.memory.returning = false;
        }
        if (!creep.memory.returning && creep.store.getFreeCapacity() === 0) {
            creep.memory.returning = true;
        }
    },

    // 🌍 Find nearby rooms that have source memory entries (within a range)
    getNearbyRoomsWithSources: function (roomName, range = 1) {
        const match = roomName.match(/([WE])(\d+)([NS])(\d+)/); // Regex parse room name (e.g., W8N3)
        if (!match) return [];
        const [, ew, xStr, ns, yStr] = match;
        const x = parseInt(xStr, 10);
        const y = parseInt(yStr, 10);
        const candidates = [];
        for (let dx = -range; dx <= range; dx++) {
            for (let dy = -range; dy <= range; dy++) {
                if (dx === 0 && dy === 0) continue;
                const newX = ew === 'W' ? x - dx : x + dx;
                const newY = ns === 'N' ? y - dy : y + dy;
                const newEW = newX >= 0 ? 'E' : 'W';
                const newNS = newY >= 0 ? 'S' : 'N';
                const room = `${newEW}${Math.abs(newX)}${newNS}${Math.abs(newY)}`;
                const mem = Memory.rooms[room];
                if (mem && mem.sources && Object.keys(mem.sources).length > 0) {
                    candidates.push(room);
                }
            }
        }
        return candidates;
    },

    // 🐝 Energy collection logic: tombstones, dropped energy, containers, storage
    collectEnergy: function(creep) {
        const tryWithdraw = (targets, action) => {
            const target = creep.pos.findClosestByPath(targets);
            if (!target) return false;
            const result = (action === 'pickup') ? creep.pickup(target) : creep.withdraw(target, RESOURCE_ENERGY);
            if (result === ERR_NOT_IN_RANGE) {
                BeeToolbox.BeeTravel(creep, target, 1, 10);
                //creep.moveTo(target);
            }
            return result === OK;
        };
        // Ruins with energy
        if (tryWithdraw(creep.room.find(FIND_RUINS, { filter: r => r.store[RESOURCE_ENERGY] > 0 }), 'withdraw')) return;
        // Tombstones with energy
        if (tryWithdraw(creep.room.find(FIND_TOMBSTONES, { filter: t => t.store[RESOURCE_ENERGY] > 0 }), 'withdraw')) return;
        // Dropped energy piles
        if (tryWithdraw(creep.room.find(FIND_DROPPED_RESOURCES, { filter: r => r.resourceType === RESOURCE_ENERGY }), 'pickup')) return;
        // Containers with energy
        if (tryWithdraw(creep.room.find(FIND_STRUCTURES, { filter: s => s.structureType === STRUCTURE_CONTAINER && s.store[RESOURCE_ENERGY] > 0 }), 'withdraw')) return;
        // Storage
        const storage = creep.room.storage;
        if (storage && storage.store[RESOURCE_ENERGY] > 0) {
            if (creep.withdraw(storage, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                BeeToolbox.BeeTravel(creep, storage, 1, 10);
                //creep.moveTo(storage, {reusePath: 10, visualizePathStyle:{opacity: .8 ,stroke: '#f29705',lineStyle: 'dashed'}});
            }
        }
    },

    // Placeholder for advanced attack target finder logic
    findAttackTarget: function(creep) {
        // Find nearest hostile creep
        const target = creep.pos.findClosestByRange(FIND_HOSTILE_CREEPS);
        if (target) return target;

        //Next, target invader core if present
        const invaderCore = creep.pos.findClosestByPath(FIND_STRUCTURES, {
            filter: s => s.structureType === STRUCTURE_INVADER_CORE && s.hits > 0
        });
        if (invaderCore) return invaderCore;

        
         //If no hostile creeps, look for structures that block progress (walls, enemy ramparts)
        const barrier = creep.pos.findClosestByPath(FIND_STRUCTURES, {
            filter: s => (s.structureType === STRUCTURE_WALL || (s.structureType === STRUCTURE_RAMPART && !s.my && !s.isPublic)) && s.hits > 0
        });
        return barrier;
    },

    // Determines if an attacker should wait for a medic to catch up
    shouldWaitForMedic: function(attacker) {
        const medic = _.find(Game.creeps, c => c.memory.role === 'Apiary_Medics' && c.memory.followTarget === attacker.id);
        if (!medic) return false;
        if (attacker.memory.noWaitForMedic) return false; // Optional override
        if (attacker.memory.waitTicks === undefined) attacker.memory.waitTicks = 0;
        const onExit = (attacker.pos.x <= 1 || attacker.pos.x >= 48 || attacker.pos.y <= 1 || attacker.pos.y >= 48);
        const nearExit = (attacker.pos.x <= 3 || attacker.pos.x >= 46 || attacker.pos.y <= 3 || attacker.pos.y >= 46);
        if (!attacker.memory.advanceDone && !attacker.pos.inRangeTo(medic, 2)) {
            attacker.memory.waitTicks = 2;
            if (nearExit) {
                const center = new RoomPosition(25, 25, attacker.room.name);
                const dir = attacker.pos.getDirectionTo(center);
                attacker.move(dir);
                attacker.say('🚶 Clear exit');
                return true;
            }
            return true;
        }
        if (attacker.memory.waitTicks > 0) {
            attacker.memory.waitTicks--;
            return true;
        }
        return false;
    },

    deliverEnergy: function(creep, structureTypes = []) {
            const STRUCTURE_PRIORITY = {
                 [STRUCTURE_EXTENSION]:  2,
                 [STRUCTURE_SPAWN]:      3,
                 [STRUCTURE_TOWER]:      4,
                 [STRUCTURE_STORAGE]:    1,
                 [STRUCTURE_CONTAINER]:  5
                };

        const sources = creep.room.find(FIND_SOURCES); // Get sources once
        const targets = creep.room.find(FIND_STRUCTURES, {
            filter: (s) => {
                if (!structureTypes.includes(s.structureType)) return false;
                if (s.structureType === STRUCTURE_CONTAINER) {
                    // Exclude containers within 1 tile of any source
                    for (const source of sources) {
                        if (s.pos.inRangeTo(source.pos, 1)) return false;
                    }
                }
                return s.store.getFreeCapacity(RESOURCE_ENERGY) > 0;
            }
        });
        // Sort targets by priority first, then by distance
        targets.sort((a, b) => {
            const prioA = STRUCTURE_PRIORITY[a.structureType] || 99;
            const prioB = STRUCTURE_PRIORITY[b.structureType] || 99;
            if (prioA !== prioB) return prioA - prioB;
            return creep.pos.getRangeTo(a) - creep.pos.getRangeTo(b);
        });

        if (targets.length) {
            const target = targets[0];
            const result = creep.transfer(target, RESOURCE_ENERGY);
            if (result === ERR_NOT_IN_RANGE) {
                BeeToolbox.BeeTravel(creep, target, 1, 10);
                //creep.moveTo(target, {reusePath: 10, visualizePathStyle:{opacity: .8 ,stroke: '#ae34eb',lineStyle: 'dashed'}});
            }
                return result;
            }
        },


        ensureContainerNearSource: function(creep, targetSource) {
            const sourcePos = targetSource.pos;
            // Check for existing containers at the source's adjacent positions
            const containersNearby = sourcePos.findInRange(FIND_STRUCTURES, 1, {
                filter: (structure) => structure.structureType === STRUCTURE_CONTAINER,
            });
            // If a container already exists nearby, return
            if (containersNearby.length > 0) return;
            // Check for existing construction sites near the source
            const constructionSites = sourcePos.findInRange(FIND_CONSTRUCTION_SITES, 1, {
                filter: (site) => site.structureType === STRUCTURE_CONTAINER,
            });
            // If a construction site for the container exists, build it
            if (constructionSites.length > 0) {
                if (creep.build(constructionSites[0]) === ERR_NOT_IN_RANGE) {
                    BeeToolbox.BeeTravel(creep, constructionSites[0]);
                    //creep.moveTo(constructionSites[0], { reusePath: 10 });
                }
                return;
            }
            // Otherwise, attempt to create a construction site for a container
            const roomTerrain = Game.map.getRoomTerrain(sourcePos.roomName);
            const validPositions = [
                { x: sourcePos.x - 1, y: sourcePos.y },     // Left
                { x: sourcePos.x + 1, y: sourcePos.y },     // Right
                { x: sourcePos.x, y: sourcePos.y - 1 },     // Top
                { x: sourcePos.x, y: sourcePos.y + 1 },     // Bottom
                { x: sourcePos.x - 1, y: sourcePos.y - 1 }, // Top-left
                { x: sourcePos.x + 1, y: sourcePos.y - 1 }, // Top-right
                { x: sourcePos.x - 1, y: sourcePos.y + 1 }, // Bottom-left
                { x: sourcePos.x + 1, y: sourcePos.y + 1 }, // Bottom-right
            ];
            for (const pos of validPositions) {
                const terrain = roomTerrain.get(pos.x, pos.y);
                if (terrain !== TERRAIN_MASK_WALL) { // Only skip wall tiles
                    const result = creep.room.createConstructionSite(pos.x, pos.y, STRUCTURE_CONTAINER);
                    if (currentLogLevel >= LOG_LEVEL.DEBUG) {
                    console.log(`Attempted to place container at (${pos.x}, ${pos.y}): Result ${result}`);
                    }            
                    if (result === OK) {
                        BeeToolbox.BeeTravel(creep, pos);
                        //creep.moveTo(pos.x, pos.y, { reusePath: 10 }); // Move to the container position
                        return;
                    }
                }
            }  
        },

        // 🐝 Travel function for Bee creeps with path visualization
        BeeTravel: function(creep, target, range, reuse) {
            range = (range !== undefined) ? range : 1;
            reuse = (reuse !== undefined) ? reuse : 30;

            const roleColors = {
            Queen: '#ffaa00',        // Yellow gold
            Courier_Bee: '#00ff00',  // Green
            Nurse_Bee: '#ff69b4',    // Pink
            Forager_Bee: '#87ceeb',  // Sky blue
            Builder_Bee: '#a0522d',  // Brown
            Apiary_Medics: '#ff0000',// Red
            Winged_Archer: '#0000ff',// Blue
            HoneyGuard: '#ff4500',   // Orange red
            Siege_Bee: '#8b0000',    // Dark red
            Scout: '#9400d3',        // Purple
            default: '#0093a1'       // Teal as fallback
        };
        //store the target as a unique string (position or ID)
        const destKey = `${target.room.name}-${target.pos.x}-${target.pos.y}`;
        //check if destination changed or path is missing
        if (!creep.memory.moveDest ||
            creep.memory.moveDest !== destKey ||
            !creep.memory.movePath){
                const path = creep.pos.findPathTo(target.pos, {range: range, reusePath: reuse});
                if (path.length > 0) {
                    creep.memory.movePath = Room.serializePath(path);
                    creep.memory.moveDest = destKey;
                } else {    
                    if (currentLogLevel >= LOG_LEVEL.DEBUG) {                
                    console.log(`🐝 ${creep.name} failed to find path to ${destKey}.`);
                    }
                    return ERR_NO_PATH;
                }
            }
        // Visualize the path
        const color = roleColors[creep.memory.role] || roleColors.default;  // Fallback to default if role not found
        const deserializedPath = Room.deserializePath(creep.memory.movePath);
            for (let i = 0; i < deserializedPath.length; i++) {
                const step = deserializedPath[i];
                creep.room.visual.circle(step, {
                    radius: 0.05,
                    fill: 'transparent',
                    stroke: color,
                    strokeWidth: 0.1,
                    opacity: 1,
                });
                // Optionally label the path with the creep's name at the first step
                if (i === 0) {
                    creep.room.visual.text(`🐝 ${creep.name}`, step.x, step.y - 0.5, {
                        font: 0.3,
                        color: color
                    });
                }
            }
         //Attempt to move by stored path
         const result = creep.moveByPath(creep.memory.movePath);
         if (result !== OK) { 
            if (currentLogLevel >= LOG_LEVEL.DEBUG) {      
            console.log(`🐝 ${creep.name} moveByPath failed with ${result}. Clearing path.`);
            }
            //clear path to force recalculation next tick
            creep.memory.movePath = null;
            creep.memory.moveDest = null;
            creep.memory.deserializedPath = null;  // 🧹 Clear cache too!

         }
            return result;
    },
};

module.exports = BeeToolbox; // Export the BeeToolbox module
