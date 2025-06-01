var BeeToolbox = require('BeeToolbox');
  // Logging Levels
  const LOG_LEVEL = {NONE: 0,BASIC: 1,DEBUG: 2};
  //if (currentLogLevel >= LOG_LEVEL.DEBUG) {}  
  const currentLogLevel = LOG_LEVEL.NONE;  // Adjust to LOG_LEVEL.DEBUG for more detailed logs
const TaskScout = {
  // Function to check if the exit is blocked by novice walls
  isExitBlocked: function (creep, exitDir) {
    const exit = creep.pos.findClosestByRange(exitDir);
    if (!exit) return false;  
    // Ensure the coordinates are within the valid room range (0 to 49)
    const xMin = Math.max(exit.x - 1, 0);
    const xMax = Math.min(exit.x + 1, 49);
    const yMin = Math.max(exit.y - 1, 0);
    const yMax = Math.min(exit.y + 1, 49);  
    // Look for novice walls or impassable terrain in the valid exit area
    const structures = creep.room.lookForAtArea(LOOK_STRUCTURES, yMin, xMin, yMax, xMax, true);
    for (const structure of structures) {
      if (structure.structure.structureType === STRUCTURE_WALL) {
        // Assume walls in this area are novice zone walls
        return true;
      }
    }
    return false;
  },
  run: function (creep) {    
    //creep.say('🕵🏻‍♀️');
    creep.say('🐝 Bzzz!', true);
    const revisitDelay = 5000; // Delay in ticks before revisiting a room
    const blockCheckDelay = 10000; // Delay for checking a blocked room again  
    BeeToolbox.logSourcesInRoom(creep.room);
    BeeToolbox.logHostileStructures(creep.room);  
    if (creep.memory.targetRoom && creep.room.name !== creep.memory.targetRoom) {
      const exitDir = creep.room.findExitTo(creep.memory.targetRoom);  
      // Check if the target exit is blocked by a novice wall
      if (TaskScout.isExitBlocked(creep, exitDir)) {
        if (currentLogLevel >= LOG_LEVEL.DEBUG) {
        console.log(`${creep.name} detected blocked exit to ${creep.memory.targetRoom}.`);
        }  
        // Mark the room as blocked and store it in memory
        if (!Memory.rooms[creep.memory.targetRoom]) {
          Memory.rooms[creep.memory.targetRoom] = {};
        }
        Memory.rooms[creep.memory.targetRoom].blocked = Game.time;  
        // Clear the current target and pick another room
        creep.memory.targetRoom = null;
        return; // Exit here to prevent further actions
      }  
      const exit = creep.pos.findClosestByRange(exitDir);
      if (exit) {
          creep.moveTo(exit, {reusePath: 10, visualizePathStyle: { stroke: '#ffaa00' }});
      }
      return; // Keep moving to the target room
    }
    // Get exits from the current room
    const exits = Game.map.describeExits(creep.room.name);
    // Filter out rooms that are blocked and should not be revisited
    // Filter out rooms that are blocked or revisited, and exclude the current room
    const unvisitedRooms = Object.values(exits).filter(roomName => {
      const roomMemory = Memory.rooms[roomName];
      const isBlocked = roomMemory && roomMemory.blocked && (Game.time - roomMemory.blocked < blockCheckDelay);
      const isCurrentRoom = roomName === creep.room.name;      
      // Skip if the room is blocked or is the current room
      if (isBlocked || isCurrentRoom) {
          if (currentLogLevel >= LOG_LEVEL.DEBUG) {
              console.log(`${creep.name} skipping blocked or current room: ${roomName}`);
          }
          return false;
      }      
      return !roomMemory || (Game.time - roomMemory.lastVisited > revisitDelay);
    });
    if (unvisitedRooms.length > 0) {
      const nextRoom = unvisitedRooms[Math.floor(Math.random() * unvisitedRooms.length)];
      creep.memory.targetRoom = nextRoom;
      // Reset the announcement flag for the new room
      creep.memory.hasAnnouncedRoomVisit = false;
      if (currentLogLevel >= LOG_LEVEL.DEBUG) {
      console.log(`${creep.name} moving to new room: ${nextRoom}`);
      }
    } else {
      // No unvisited or revisitable rooms, pick a random neighboring room
      const randomRoom = Object.values(exits)[Math.floor(Math.random() * Object.values(exits).length)];
      creep.memory.targetRoom = randomRoom;
      creep.memory.hasAnnouncedRoomVisit = false;
      if (currentLogLevel >= LOG_LEVEL.DEBUG) {
      console.log(`${creep.name} moving randomly to room: ${randomRoom}`);
      }
    }
  }
};
module.exports = TaskScout;