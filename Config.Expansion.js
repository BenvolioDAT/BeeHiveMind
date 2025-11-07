var CFG = {
    // Global kill-switch for expansion orchestration features.
    ENABLE_EXPANSION: true,

    // Maximum number of simultaneous expansion targets to pursue.
    MAX_EXPANSIONS: 1,

    // Maximum number of room-to-room hops allowed between main room and expansion.
    MAX_EXPANSION_DISTANCE: 2,

    // Minimum time between finishing one expansion and starting the next.
    EXPANSION_COOLDOWN_TICKS: 500,

    // Selects the main room name for expansion planning.
    MAIN_ROOM_SELECTOR: function () {
        // Prefer the room containing the first available spawn.
        for (var spawnName in Game.spawns) {
            if (!Game.spawns.hasOwnProperty(spawnName)) {
                continue;
            }
            var spawn = Game.spawns[spawnName];
            if (spawn && spawn.room && spawn.room.name) {
                return spawn.room.name;
            }
        }

        // Fallback to the owned room with the highest controller level.
        var bestRoomName = null;
        var bestLevel = -1;
        for (var roomName in Game.rooms) {
            if (!Game.rooms.hasOwnProperty(roomName)) {
                continue;
            }
            var room = Game.rooms[roomName];
            if (!room || !room.controller || !room.controller.my) {
                continue;
            }
            var level = room.controller.level || 0;
            if (level > bestLevel) {
                bestLevel = level;
                bestRoomName = roomName;
            }
        }

        // No eligible rooms found.
        return bestRoomName;
    },

    // Minimum stored energy (storage + terminal) before expansion is allowed.
    ENERGY_BOOTSTRAP_MIN: 8000,
};

module.exports = CFG;
