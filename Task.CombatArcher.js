var BeeToolbox = require('BeeToolbox');
var TaskCombatArcher = {
  run: function (creep) {
    if (creep.spawning) {return;}
    //if (BeeToolbox.shouldWaitForMedic(creep)) {
   // creep.say('🐝 Wait');
   // return;
   // }    
    const target = BeeToolbox.findAttackTarget(creep);
    if (target) {
      if (creep.pos.inRangeTo(target, 3)) {
        creep.rangedAttack(target);
      } 
      const range = creep.pos.getRangeTo(target);
        if (range > 3) {
        creep.moveTo(target);creep.rangedAttack(target);
      } else if (range < 3 ) {
        //too close, kite away!
        const fleePath = PathFinder.search(
            creep.pos,
            { pos: target.pos, range: 3 },
            {
              flee: true,
              maxOps: 2000,
              roomCallback: BeeToolbox.roomCallback}
        )
      }
    } else {
      const rallyFlag = Game.flags.Rally;
      if (rallyFlag) creep.moveTo(rallyFlag);
    }
  }
};
module.exports = TaskCombatArcher;
