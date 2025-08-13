const roleLinkManager = {
    run: function () {
        // Get the room's spawn and controller
        //const room = Game.spawns['Spawn1'].room;
        //const spawn = Game.spawns['Spawn1'];
        for ( const spawnName in Game.spawns) {
            const spawn = Game.spawns[spawnName];
            const room = spawn.room;
        const controller = room.controller;
        // Find the link closest to the spawn (sending link)
        const sendingLink = spawn.pos.findClosestByRange(FIND_STRUCTURES, {
            filter: (structure) => structure.structureType === STRUCTURE_LINK
        });
        // Find the link closest to the controller (receiving link)
        const receivingLink = controller.pos.findClosestByRange(FIND_STRUCTURES, {
            filter: (structure) => structure.structureType === STRUCTURE_LINK
        });
        // Check if both links exist and the sending link has energy
        if (sendingLink && receivingLink && sendingLink.store[RESOURCE_ENERGY] > 0 && sendingLink.cooldown === 0) {
            const result = sendingLink.transferEnergy(receivingLink);            
            if (result === OK) {
               // console.log(`Transferred energy from link near spawn to link near controller.`);
            } else {
                //console.log(`Failed to transfer energy: ${result}`);
            }
        } else {
            //console.log(`No valid links found or link is on cooldown.`);
        }
    }
}
};
module.exports = roleLinkManager;
