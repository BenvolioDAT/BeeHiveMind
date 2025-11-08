var CFG = {
    // Global kill-switch for expansion orchestration features.
    ENABLE_EXPANSION: true,

    // Maximum number of simultaneous expansion targets to pursue.
    // This controls how many expansions may run in parallel regardless of how
    // many rooms we already own (that limit is enforced separately via GCL).
    MAX_PARALLEL_EXPANSIONS: 3,

    // Maximum number of room-to-room hops allowed between main room and expansion.
    MAX_EXPANSION_DISTANCE: 8,

    // Minimum time between finishing one expansion and starting the next.
    EXPANSION_COOLDOWN_TICKS: 500,

    // Selects the main room name for expansion planning.
    MAIN_ROOM_SELECTOR: function () {
        var gameRef = typeof Game !== 'undefined' ? Game : { spawns: {}, rooms: {} };

        // Prefer the room containing the first available spawn.
        for (var spawnName in gameRef.spawns) {
            if (!gameRef.spawns.hasOwnProperty(spawnName)) {
                continue;
            }
            var spawn = gameRef.spawns[spawnName];
            if (spawn && spawn.room && spawn.room.name) {
                return spawn.room.name;
            }
        }

        // Fallback to the owned room with the highest controller level.
        var bestRoomName = null;
        var bestLevel = -1;
        for (var roomName in gameRef.rooms) {
            if (!gameRef.rooms.hasOwnProperty(roomName)) {
                continue;
            }
            var room = gameRef.rooms[roomName];
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

// Legacy alias for backwards compatibility while consumers migrate to the
// clearer MAX_PARALLEL_EXPANSIONS name. Both represent the same concurrency
// limit for expansion orchestration.
CFG.MAX_EXPANSIONS = CFG.MAX_PARALLEL_EXPANSIONS;

module.exports = CFG;
