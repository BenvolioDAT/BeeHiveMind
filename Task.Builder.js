var BeeToolbox = require('BeeToolbox');
// === Builder refuel helpers ===
function ensureHome(creep) {
  if (creep.memory.home) return creep.memory.home;

  // pick closest owned spawn by room distance; fallback to current room
  const spawns = Object.values(Game.spawns);
  if (spawns.length) {
    let best = spawns[0];
    let bestDist = Game.map.getRoomLinearDistance(creep.pos.roomName, best.pos.roomName);
    for (let i = 1; i < spawns.length; i++) {
      const d = Game.map.getRoomLinearDistance(creep.pos.roomName, spawns[i].pos.roomName);
      if (d < bestDist) { best = spawns[i]; bestDist = d; }
    }
    creep.memory.home = best.pos.roomName;
  } else {
    creep.memory.home = creep.pos.roomName;
  }
  return creep.memory.home;
}

function getHomeAnchorPos(homeName) {
  const room = Game.rooms[homeName];
  if (room) {
    if (room.storage) return room.storage.pos;
    const spawns = room.find(FIND_MY_SPAWNS);
    if (spawns.length) return spawns[0].pos;
    if (room.controller && room.controller.my) return room.controller.pos;
  }
  // no vision? head toward center; moveTo will path inter-room
  return new RoomPosition(25, 25, homeName);
}

function findWithdrawTargetInRoom(room) {
  if (!room) return null;
  const targets = room.find(FIND_STRUCTURES, {
    filter: s =>
      s.store &&
      s.store.getUsedCapacity(RESOURCE_ENERGY) > 0 &&
      (
        s.structureType === STRUCTURE_STORAGE ||
        s.structureType === STRUCTURE_TERMINAL ||
        s.structureType === STRUCTURE_LINK ||
        s.structureType === STRUCTURE_CONTAINER
      )
  });
  if (!targets.length) return null;
  targets.sort((a, b) =>
    b.store.getUsedCapacity(RESOURCE_ENERGY) - a.store.getUsedCapacity(RESOURCE_ENERGY)
  );
  return targets[0];
}

function go(creep, dest, opts = {}) {
  if (typeof BeeToolbox !== 'undefined' && BeeToolbox.BeeTravel) {
    BeeToolbox.BeeTravel(creep, dest, opts);
  } else {
    const range = opts.range != null ? opts.range : 1;
    creep.moveTo(dest, { reusePath: 20, range });
  }
}




var TaskBuilder = {
  // Define limits for each structure type
  structureLimits: {
    STRUCTURE_TOWER: 6,
    STRUCTURE_EXTENSION: 60,
    STRUCTURE_CONTAINER: 1,
    STRUCTURE_RAMPART: 2,
    STRUCTURE_ROAD: 20,
  },
  // Define site weights for sorting construction sites
  siteWeights: {
    STRUCTURE_TOWER: 5,
    STRUCTURE_CONTAINER: 4,
    STRUCTURE_EXTENSION: 3,
    STRUCTURE_RAMPART: 2,
    STRUCTURE_ROAD: 1,
  },
  // Define positions and types for each structure to be built
  // Y being negative counts as a up while a postive number goes down and X negitvie go left and postive goes right.
  structurePlacements: [
    { type: STRUCTURE_STORAGE,   x:  8, y: 0},//1
    { type: STRUCTURE_SPAWN,     x: -5, y: 0},
    { type: STRUCTURE_SPAWN,     x:  5, y: 0},

    //{ type: STRUCTURE_CONTAINER, x: 5, y: 0},

    { type: STRUCTURE_EXTENSION, x: 0, y: 2 },//1
    { type: STRUCTURE_EXTENSION, x: 0, y:-2 },//2
    { type: STRUCTURE_EXTENSION, x: 0, y: 3 },//3
    { type: STRUCTURE_EXTENSION, x: 0, y:-3 },//4
    { type: STRUCTURE_EXTENSION, x:-1, y: 3 },//5
    { type: STRUCTURE_EXTENSION, x:-1, y:-3 },//6
    { type: STRUCTURE_EXTENSION, x: 1, y:-3 },//7
    { type: STRUCTURE_EXTENSION, x: 1, y: 3 },//8
    { type: STRUCTURE_EXTENSION, x:-1, y: 2 },//9
    { type: STRUCTURE_EXTENSION, x:-1, y:-2 },//10
    { type: STRUCTURE_EXTENSION, x: 1, y: 2 },//11
    { type: STRUCTURE_EXTENSION, x: 1, y:-2 },//12 
    { type: STRUCTURE_EXTENSION, x:-2, y:-1 },//13
    { type: STRUCTURE_EXTENSION, x:-2, y: 1 },//14
    { type: STRUCTURE_EXTENSION, x: 2, y:-1 },//15
    { type: STRUCTURE_EXTENSION, x: 2, y: 1 },//16
    { type: STRUCTURE_EXTENSION, x:-3, y: 1 },//17
    { type: STRUCTURE_EXTENSION, x:-3, y:-1 },//18
    { type: STRUCTURE_EXTENSION, x: 3, y: 1 },//19
    { type: STRUCTURE_EXTENSION, x: 3, y:-1 },//20
    { type: STRUCTURE_EXTENSION, x:-3, y: 2 },//21
    { type: STRUCTURE_EXTENSION, x:-3, y:-2 },//22
    { type: STRUCTURE_EXTENSION, x: 3, y: 2 },//23
    { type: STRUCTURE_EXTENSION, x: 3, y:-2 },//24
    { type: STRUCTURE_EXTENSION, x:-4, y: 2 },//25
    { type: STRUCTURE_EXTENSION, x:-4, y:-2 },//26
    { type: STRUCTURE_EXTENSION, x: 4, y: 2 },//27
    { type: STRUCTURE_EXTENSION, x: 4, y:-2 },//28
    { type: STRUCTURE_EXTENSION, x: 4, y: 3 },//29
    { type: STRUCTURE_EXTENSION, x: 4, y:-3 },//30
    { type: STRUCTURE_EXTENSION, x:-4, y: 3 },//31
    { type: STRUCTURE_EXTENSION, x:-4, y:-3 },//32
    { type: STRUCTURE_EXTENSION, x:-4, y: 4 },//33
    { type: STRUCTURE_EXTENSION, x:-4, y:-4 },//34
    { type: STRUCTURE_EXTENSION, x: 4, y: 4 },//35
    { type: STRUCTURE_EXTENSION, x: 4, y:-4 },//36
    { type: STRUCTURE_EXTENSION, x: 3, y: 4 },//37
    { type: STRUCTURE_EXTENSION, x: 3, y:-4 },//38
    { type: STRUCTURE_EXTENSION, x:-3, y: 4 },//39
    { type: STRUCTURE_EXTENSION, x:-3, y:-4 },//40
    { type: STRUCTURE_EXTENSION, x:-2, y: 4 },//41
    { type: STRUCTURE_EXTENSION, x:-2, y:-4 },//42
    { type: STRUCTURE_EXTENSION, x: 2, y: 4 },//43
    { type: STRUCTURE_EXTENSION, x: 2, y:-4 },//44
    { type: STRUCTURE_EXTENSION, x: 2, y: 5 },//45
    { type: STRUCTURE_EXTENSION, x: 2, y:-5 },//46
    { type: STRUCTURE_EXTENSION, x:-2, y:-5 },//47
    { type: STRUCTURE_EXTENSION, x:-2, y: 5 },//48
    { type: STRUCTURE_EXTENSION, x:-1, y:-5 },//49
    { type: STRUCTURE_EXTENSION, x:-1, y: 5 },//50
    { type: STRUCTURE_EXTENSION, x: 1, y: 5 },//51
    { type: STRUCTURE_EXTENSION, x: 1, y:-5 },//52
    { type: STRUCTURE_EXTENSION, x: 0, y: 5 },//53
    { type: STRUCTURE_EXTENSION, x: 0, y:-5 },//54
    { type: STRUCTURE_EXTENSION, x:-4, y: 0 },//55
    { type: STRUCTURE_EXTENSION, x: 4, y: 0 },//56
    { type: STRUCTURE_EXTENSION, x:-5, y: 1 },//57
    { type: STRUCTURE_EXTENSION, x:-5, y:-1 },//58
    { type: STRUCTURE_EXTENSION, x: 5, y: 1 },//59
    { type: STRUCTURE_EXTENSION, x: 5, y:-1 },//60 
    // TOWER LOCATIONS
    //{ type: STRUCTURE_TOWER, x:-5, y:-5 },//1
    //{ type: STRUCTURE_TOWER, x: 5, y: 5 },//2
    //{ type: STRUCTURE_TOWER, x:-5, y: 5 },//3
    //{ type: STRUCTURE_TOWER, x: 5, y:-5 },//4
    //{ type: STRUCTURE_TOWER, x:-1, y: 0 },//5
    //{ type: STRUCTURE_TOWER, x: 1, y: 0 },//6
    { type: STRUCTURE_ROAD, x: 1, y: 1 },
    { type: STRUCTURE_ROAD, x: 0, y: 1 },
    { type: STRUCTURE_ROAD, x:-1, y: 1 },
    { type: STRUCTURE_ROAD, x:-1, y: 0 },
    { type: STRUCTURE_ROAD, x:-1, y:-1 },
    { type: STRUCTURE_ROAD, x: 0, y:-1 },
    { type: STRUCTURE_ROAD, x: 1, y:-1 },
    { type: STRUCTURE_ROAD, x: 1, y: 0 },
    { type: STRUCTURE_ROAD, x: 2, y: 0 },
    { type: STRUCTURE_ROAD, x: 3, y: 0 },
    { type: STRUCTURE_ROAD, x:-2, y: 0 },
    { type: STRUCTURE_ROAD, x:-3, y: 0 },
    { type: STRUCTURE_ROAD, x:-4, y: 1 },
    { type: STRUCTURE_ROAD, x:-4, y:-1 },
    { type: STRUCTURE_ROAD, x: 4, y:-1 },
    { type: STRUCTURE_ROAD, x: 4, y: 1 },
    { type: STRUCTURE_ROAD, x: 2, y: 2 },
    { type: STRUCTURE_ROAD, x: 2, y:-2 },
    { type: STRUCTURE_ROAD, x: 3, y:-3 },
    { type: STRUCTURE_ROAD, x: 3, y: 3 },
    { type: STRUCTURE_ROAD, x:-2, y: 2 },
    { type: STRUCTURE_ROAD, x:-2, y:-2 },
    { type: STRUCTURE_ROAD, x:-3, y:-3 },
    { type: STRUCTURE_ROAD, x:-3, y: 3 },
    { type: STRUCTURE_ROAD, x:-2, y: 3 },
    { type: STRUCTURE_ROAD, x: 2, y: 3 },
    { type: STRUCTURE_ROAD, x:-2, y:-3 },
    { type: STRUCTURE_ROAD, x: 2, y:-3 },
    { type: STRUCTURE_ROAD, x:-1, y: 4 },
    { type: STRUCTURE_ROAD, x: 1, y: 4 },
    { type: STRUCTURE_ROAD, x:-1, y:-4 },
    { type: STRUCTURE_ROAD, x: 1, y:-4 },
    { type: STRUCTURE_ROAD, x: 0, y: 4 },
    { type: STRUCTURE_ROAD, x: 0, y:-4 },
    // Add more structures with their positions
  ],
  // Main function to control the Builder_Bee creep
  run: function (creep) {  
    // Check if the creep is currently building and has no energy left
    if (creep.memory.building && creep.store[RESOURCE_ENERGY] == 0) {
      creep.memory.building = false;
    }
    // Check if the creep is not building and has full energy capacity
    if (!creep.memory.building && creep.store.getFreeCapacity() == 0) {
      creep.memory.building = true;
    }
    // If the creep is building
    if (creep.memory.building) {// Grab ALL my construction sites (home + remotes)
var targets = Object.values(Game.constructionSites || {});

// If none found, fall back to current room (keeps behavior sane if Game.constructionSites is empty)
if (!targets.length) {
  targets = creep.room.find(FIND_MY_CONSTRUCTION_SITES);
}

if (targets.length) {
  // Choose an anchor: storage if present, else first spawn, else creep position
  const home = creep.room;
  const spawns = home.find(FIND_MY_SPAWNS);
  const anchor = (home.storage && home.storage.pos) || (spawns[0] && spawns[0].pos) || creep.pos;

  // Sort so we:
  // 1) Prefer your existing weights (towers > containers > extensions > ...)
  // 2) Then prefer rooms closer to anchor's room (home -> neighbors -> farther)
  // 3) Then prefer sites nearer to the anchor inside the same room
  targets.sort((a, b) => {
    const wa = (TaskBuilder.siteWeights && TaskBuilder.siteWeights[a.structureType]) || 0;
    const wb = (TaskBuilder.siteWeights && TaskBuilder.siteWeights[b.structureType]) || 0;
    if (wb !== wa) return wb - wa;

    const ra = Game.map.getRoomLinearDistance(anchor.roomName, a.pos.roomName);
    const rb = Game.map.getRoomLinearDistance(anchor.roomName, b.pos.roomName);
    if (ra !== rb) return ra - rb;

    const da = (a.pos.roomName === anchor.roomName) ? anchor.getRangeTo(a.pos) : 999;
    const db = (b.pos.roomName === anchor.roomName) ? anchor.getRangeTo(b.pos) : 999;
    return da - db;
  });

  // Build/move (creep.moveTo handles inter-room travel automatically)
  if (creep.build(targets[0]) === ERR_NOT_IN_RANGE) {
    BeeToolbox.BeeTravel(creep, targets[0]); // you already use this helper
  }
}
      /*var targets = creep.room.find(FIND_CONSTRUCTION_SITES);
      if (targets.length) {
        // Sort construction sites by weight in descending order
        targets.sort((a, b) => (TaskBuilder.siteWeights[b.structureType] || 0) - (TaskBuilder.siteWeights[a.structureType] || 0));
        if (creep.build(targets[0]) == ERR_NOT_IN_RANGE) {
          // If not in range, move towards the construction site with visualization
          BeeToolbox.BeeTravel(creep, targets[0]);
          //creep.moveTo(targets[0], {reusePath: 10,visualizePathStyle:{lineStyle: 'dashed'}});
        }
      }*/ else {
                  // No construction sites anywhere:
                  // 1) Return any carried energy to base
                  // 2) Recycle at nearest spawn (refunds some energy)
                  // 3) Fallback: suicide if no spawn found (edge case)

                  // Step 1: if we’re carrying energy, drop it off first
                  if (creep.store.getUsedCapacity(RESOURCE_ENERGY) > 0) {
                    // Prefer Storage/Terminal, then Spawn/Extensions/Towers, then Containers/Links
                    const sink = creep.pos.findClosestByPath(FIND_STRUCTURES, {
                      filter: s => (
                        (
                          (s.structureType === STRUCTURE_STORAGE) ||
                          (s.structureType === STRUCTURE_TERMINAL) ||
                          (s.structureType === STRUCTURE_SPAWN) ||
                          (s.structureType === STRUCTURE_EXTENSION) ||
                          (s.structureType === STRUCTURE_TOWER) ||
                          (s.structureType === STRUCTURE_CONTAINER) ||
                          (s.structureType === STRUCTURE_LINK)
                        ) &&
                        s.store && s.store.getFreeCapacity(RESOURCE_ENERGY) > 0
                      )
                    });

                    if (sink) {
                      if (creep.transfer(sink, RESOURCE_ENERGY) === ERR_NOT_IN_RANGE) {
                        // Use your travel helper for consistency
                        if (typeof BeeToolbox !== 'undefined' && BeeToolbox.BeeTravel) {
                          BeeToolbox.BeeTravel(creep, sink);
                        } else {
                          creep.moveTo(sink, { reusePath: 15, range: 1 });
                        }
                      }
                      // We’ll try recycling next tick after we’ve emptied out.
                      return;
                    }
                    // If no valid sink, we’ll still proceed to recycle to avoid idling forever
                  }

                  // Step 2: recycle at the nearest spawn
                  const spawn = creep.pos.findClosestByPath(FIND_MY_SPAWNS);
                  if (spawn) {
                    if (creep.pos.getRangeTo(spawn) > 1) {
                      if (typeof BeeToolbox !== 'undefined' && BeeToolbox.BeeTravel) {
                        BeeToolbox.BeeTravel(creep, spawn, {range: 1});
                      } else {
                        creep.moveTo(spawn, { reusePath: 20, range: 1 });
                      }
                    } else {
                      // Adjacent: recycle me, daddy
                      spawn.recycleCreep(creep);
                    }
                    return;
                  }

                  // Step 3: extreme edge case: no spawn in vision/room — avoid endless wandering
                  creep.suicide();
                }
      
    }
    // If the creep is not building
else {
  // === CROSS-ROOM REFUEL LOGIC ===
  const homeName = ensureHome(creep);

  // 1) Try to refuel in the current room first
  let src = findWithdrawTargetInRoom(creep.room);
  if (src) {
    const r = creep.withdraw(src, RESOURCE_ENERGY);
    if (r === ERR_NOT_IN_RANGE) go(creep, src, { range: 1 });
    return;
  }

  // 2) No energy here. If not in home room, travel home to refuel.
  if (creep.pos.roomName !== homeName) {
    const anchor = getHomeAnchorPos(homeName);
    go(creep, anchor, { range: 1 });
    return;
  }

  // 3) We're in home; check again (vision may differ)
  src = findWithdrawTargetInRoom(creep.room);
  if (src) {
    const r = creep.withdraw(src, RESOURCE_ENERGY);
    if (r === ERR_NOT_IN_RANGE) go(creep, src, { range: 1 });
    return;
  }

  // 4) Last resort so we don't stall forever: harvest
  const source = creep.pos.findClosestByPath(FIND_SOURCES_ACTIVE);
  if (source) {
    const r = creep.harvest(source);
    if (r === ERR_NOT_IN_RANGE) go(creep, source);
    return;
  }

  // 5) Truly nothing available? Idle at anchor and wait for haulers.
  go(creep, getHomeAnchorPos(homeName), { range: 2 });
  return;
}   
  },
  // Function to upgrade the controller when there are no construction sites
  upgradeController: function (creep) {
    var controller = creep.room.controller;
    if (controller.level === 8 && controller.ticksToDowngrade > 180000) {
      // Skip upgrading to save energy when controller is stable
      return;
    }
    if (creep.upgradeController(controller) == ERR_NOT_IN_RANGE) {
      // If not in range, move towards the controller with visualization
      BeeToolbox.BeeTravel(creep, controller);
      //creep.moveTo(controller, {reusePath: 10, visualizePathStyle:{opacity: .8 ,stroke: '#32a852',lineStyle: 'dashed'}});
    }
  },
  // Function to build predefined structures at specified positions
  buildPredefinedStructures: function (creep) {
    for (var i = 0; i < TaskBuilder.structurePlacements.length; i++) {
      var placement = TaskBuilder.structurePlacements[i];
      var targetPosition = new RoomPosition(
        placement.x + creep.room.find(FIND_MY_SPAWNS)[0].pos.x,
        placement.y + creep.room.find(FIND_MY_SPAWNS)[0].pos.y,
        creep.room.find(FIND_MY_SPAWNS)[0].pos.roomName
      );
      // Check if a structure or construction site already exists at the specified spot
      if (
        targetPosition.lookFor(LOOK_STRUCTURES).length === 0 &&
        targetPosition.lookFor(LOOK_CONSTRUCTION_SITES).length === 0
      ) {
        // Build the structure at the specified spot
        TaskBuilder.buildStructures(creep, targetPosition, placement.type);
      }
    }
  },
  // Function to build structures at a specified position
  buildStructures: function (creep, targetPosition, structureType) {
    // Check if the structure limit has been reached for the specified type
    if (
      TaskBuilder.structureLimits[structureType] &&
      TaskBuilder.countStructures(creep.room, structureType) >= TaskBuilder.structureLimits[structureType]
    ) {
      return;
    }
    // Create a construction site for the structure at the specified position
    creep.room.createConstructionSite(targetPosition, structureType);
  },
  // Function to count structures of a specific type in the room
  countStructures: function (room, structureType) {
    return (
      room.find(FIND_STRUCTURES, { filter: { structureType: structureType } }).length +
      room.find(FIND_CONSTRUCTION_SITES, { filter: { structureType: structureType } }).length
    );
  },


  // Plan construction sites every tick without needing a Builder creep
  ensureSites(room) {
    if (!room || !room.controller || !room.controller.my) return;

    const spawns = room.find(FIND_MY_SPAWNS);
    if (!spawns.length) return;
    const center = spawns[0].pos;

    // gentle throttle & cap so we don't spam sites
    const MAX_SITES_PER_TICK = 5;
    if (!Memory.rooms) Memory.rooms = {};
    if (!Memory.rooms[room.name]) Memory.rooms[room.name] = {};
    const mem = Memory.rooms[room.name];
    const next = mem.nextPlanTick || 0;
    if (Game.time < next) return;

    let placed = 0;

    for (let i = 0; i < TaskBuilder.structurePlacements.length; i++) {
      if (placed >= MAX_SITES_PER_TICK) break;

      const p = TaskBuilder.structurePlacements[i];
      const target = new RoomPosition(center.x + p.x, center.y + p.y, room.name);

      // skip if blocked or already has structure/site
      if (target.lookFor(LOOK_STRUCTURES).length > 0) continue;
      if (target.lookFor(LOOK_CONSTRUCTION_SITES).length > 0) continue;

      // respect RCL and any soft limits you defined
      const rcl = room.controller.level;
      const rclLimit = (CONTROLLER_STRUCTURES[p.type] && CONTROLLER_STRUCTURES[p.type][rcl]);
      const softLimit = (TaskBuilder.structureLimits && TaskBuilder.structureLimits[p.type]);
      const allowed = Math.min(rclLimit, softLimit);

      // how many exist (built + sites) of this type
      const have = TaskBuilder.countStructures(room, p.type);
      if (have >= allowed) continue;

      const terr = room.getTerrain().get(target.x, target.y);
      if (terr === TERRAIN_MASK_WALL) continue;

      const res = room.createConstructionSite(target, p.type);
      if (res === OK) placed++;
    }

    // try again in a few ticks (skip extra CPU if we just placed some)
    mem.nextPlanTick = Game.time + (placed ? 10 : 25);
  },
  
  
};
module.exports = TaskBuilder;
