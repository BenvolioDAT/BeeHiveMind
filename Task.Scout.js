// --- Bee Comedy Club ---
const BeeStandup = {
  // 10-char say limit helper
  _chunk(text, size = 10) {
    const chunks = [];
    let i = 0;
    while (i < text.length) {
      chunks.push(text.slice(i, i + size));
      i += size;
    }
    return chunks;
  },

  // Queue any text to say publicly in chunks
  queueSpeech(creep, text) {
    if (!text || !text.trim()) return;
    if (!creep.memory.sayQueue) creep.memory.sayQueue = [];
    const chunks = this._chunk(text);
    // Use a separator between jokes if the tail doesn't end with punctuation
    if (creep.memory.sayQueue.length && !/[.?!)]$/.test(creep.memory.sayQueue[creep.memory.sayQueue.length-1])) {
      creep.memory.sayQueue.push(" |");
    }
    creep.memory.sayQueue.push(...chunks);
  },

  // Says the next chunk if it's time
  sayTick(creep, interval = 2) {
    if (!creep.memory.sayQueue || creep.memory.sayQueue.length === 0) return;
    if (Game.time % interval !== 0) return; // rate limit
    const next = creep.memory.sayQueue.shift();
    if (next) creep.say(next, true); // public speech
  },

  // One-liners to sprinkle in
  randomLine() {
      const book = [
        "🌸➡️🤧😂",        // pollen → achoo → funny
        "🔎🍯➡️🏃‍♂️🐝",    // found nectar → be right back
        "🏠5️⃣✋",          // hive five
        "🐝🪤❓😱",         // wasp trap?
        "🕵️‍♂️🐝✈️",        // scout’s honor, winging it
        "❓🎵🐝=🐝",        // why the buzz? I am the buzz
        "✈️🐝🏠🏠",        // Air Bee & Bee
        "💻📡🍯",          // APIs → bee internet → honey data
        "🧴💇🐝😂",        // comb → funny
        "🗺️❌➡️〰️🐝"        // not lost, zigzag strategy
      ];
    return book[Math.floor(Math.random() * book.length)];
  },

  // Dad jokes (longer; will be chunked)
  randomJoke() {
    const jokes = [
      "🐝👔📈➡️🌻",        // bee promoted → outstanding in field of flowers
      "🍯😂🤏🩹",          // honey joke → sticky but held together
      "🐝❓🤷‍♂️➡️🤔🐝",     // bee + indecision → may-bee
      "🗺️➡️🌸👂🎵🐝",       // asked directions → follow the buzz
      "👨‍💼:✈️🙅 🐝:✈️🏢", // boss says flighty, bee says that’s how I get to work
    ];
    return jokes[Math.floor(Math.random() * jokes.length)];
  },

  // A tiny “story” that plays out across movement ticks
  storyIntro(roomName) {
    return [
      `🆕🚪${roomName}`, //New Room
      "🔍🚪", //Scanning Exits
      "👃🍯", //Sniffing Nectar
      "🗺️✏️", //Plotting Routes
      "🙏🐝👑"//If I get swatted, tell the queen I tried.
    ];
  }
};

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
    //creep.say('🐝', true);

    const revisitDelay = 5000; // Delay in ticks before revisiting a room
    const blockCheckDelay = 10000; // Delay for checking a blocked room again

      // --- NEW: initialize comedy memory ---
    if (!creep.memory.sayQueue) creep.memory.sayQueue = [];
    if (!creep.memory.lastRoom) creep.memory.lastRoom = creep.room.name;
    if (creep.memory.lastRoom !== creep.room.name) {
      // Entered a new room: queue a tiny “story”
      const lines = BeeStandup.storyIntro(creep.room.name);
      lines.forEach(l => BeeStandup.queueSpeech(creep, l));
      creep.memory.lastRoom = creep.room.name;
      creep.memory.hasAnnouncedRoomVisit = false; // keep your existing flag behavior
    }
        // Occasionally sprinkle a one-liner while traveling
    if (Game.time % 37 === 0 && Math.random() < 0.7) {
      BeeStandup.queueSpeech(creep, BeeStandup.randomLine());
    }
    // Less often, a full dad joke
    if (Game.time % 181 === 0 && Math.random() < 0.5) {
      BeeStandup.queueSpeech(creep, BeeStandup.randomJoke());
    }

    // Play next chunk if queued
    BeeStandup.sayTick(creep, /*interval=*/2);

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

        // NEW: quip about the wall
        BeeStandup.queueSpeech(creep, "Novice wall? More like 'not-vice wall.'");
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

      // NEW: travel quip
      BeeStandup.queueSpeech(creep, `Next: ${nextRoom}. Pack your pollen!`);
      if (currentLogLevel >= LOG_LEVEL.DEBUG) {
      console.log(`${creep.name} moving to new room: ${nextRoom}`);
      }
    } else {
      // No unvisited or revisitable rooms, pick a random neighboring room
      const randomRoom = Object.values(exits)[Math.floor(Math.random() * Object.values(exits).length)];
      creep.memory.targetRoom = randomRoom;
      creep.memory.hasAnnouncedRoomVisit = false;

      // NEW: fallback quip
      BeeStandup.queueSpeech(creep, `Wing it to ${randomRoom}. YOLO = You Only Live Once… per spawn.`);    

      if (currentLogLevel >= LOG_LEVEL.DEBUG) {
      console.log(`${creep.name} moving randomly to room: ${randomRoom}`);
      }
    }
  }
};
module.exports = TaskScout;