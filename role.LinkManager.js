const roleLinkManager = {
    run: function () {
        // Get the room's spawn and controller
        //const room = Game.spawns['Spawn1'].room;
        //const spawn = Game.spawns['Spawn1'];
        for ( const spawnName in Game.spawns) {//rmoeve if braks
            const spawn = Game.spawns[spawnName];//remove if braks
            const room = spawn.room;//remove if braks
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
}//remove if broks
};
module.exports = roleLinkManager;
