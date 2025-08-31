// role.CombatMedic.js 🐝 - Dedicated healers for offensive bees
var BeeToolbox = require('BeeToolbox'); // Import common utilities for bee roles

const TaskCombatMedic = {
    // Main function for CombatMedic behavior, runs every tick
    run: function(creep) {
        if (creep.spawning) { return; } // Skip logic if creep is still spawning

        // 1) Self-heal if the medic is damaged
        if (creep.hits < creep.hitsMax) {
            creep.heal(creep);
            creep.say('⚕️'); // Say "SH" as a visual indicator for self-healing
            return; // Exit early after healing self
        }

        // Check if we already have a target stored in memory
        let target = Game.getObjectById(creep.memory.followTarget);
        // If no target or the target is invalid, find a new one
        if (!target || target.memory.task === undefined || target.hits === 0) {
            target = _.find(Game.creeps, (ally) => {
                return (ally.memory.task === 'CombatMelee' || 
                        ally.memory.task === 'CombatArcher' ||
                        ally.memory.task === 'Dismantler') &&
                        !TaskCombatMedic.isTargetAssigned(ally.id); // Avoid duplicating medics on the same target
            });

            // If a valid target is found, assign it in memory
            if (target) {
                creep.memory.followTarget = target.id;
                target.memory.medicId = creep.id; // Mark the medic ID in the target's memory
            } else {
                // No valid target found, head to rally flag if it exists
                let rallyFlag = Game.flags['MedicRally'];
                if (rallyFlag) {
                    creep.moveTo(rallyFlag); // Move to rally point
                }
                return; // Exit logic if no target
            }
        }

        // Find other nearby injured allies within 3 tiles (but not the main target)
        let nearbyInjured = creep.pos.findClosestByRange(FIND_MY_CREEPS, {
            filter: (ally) => {
                return ally.hits < ally.hitsMax && 
                       ally.id !== target.id && // Ignore the main target here
                       creep.pos.inRangeTo(ally, 3); // Only within 3 tiles
            }
        });

        // If there's an injured ally nearby, prioritize healing them first
        if (nearbyInjured) {
            if (creep.pos.isNearTo(nearbyInjured)) {
                creep.heal(nearbyInjured); // Direct heal if in adjacent range
            } else {
                creep.moveTo(nearbyInjured); // Move towards them
                creep.rangedHeal(nearbyInjured); // Heal at range if possible
            }
        } else if (target) {
            // If no other injured allies, follow the main target and heal them
            if (creep.pos.roomName !== target.pos.roomName || target.pos.x === 0 || target.pos.x === 49 || target.pos.y === 0 || target.pos.y === 49) {
                // If target is in another room or on an exit tile, rush to them
                creep.moveTo(target, { range: 1 });
                creep.say('🚑 Catch up!'); // Visual indicator
            } else {
                // In the same room: heal or follow target
                if (creep.pos.isNearTo(target)) {
                    creep.heal(target); // Direct heal
                } else {
                    creep.moveTo(target, { range: 1 }); // Move close to target
                    creep.rangedHeal(target); // Ranged heal if in range
                }
            }
        }
    },

    // Helper function to check if a target is already assigned to another CombatMedic
    isTargetAssigned: function(targetId) {
        return Object.values(Game.creeps).some(ally => {
            return ally.memory.task === 'CombatMedic' && ally.memory.followTarget === targetId;
        });
    }
};

module.exports = TaskCombatMedic; // Export the role for use in the HiveMind system
