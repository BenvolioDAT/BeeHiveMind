
const Taskidle = {
  run: function (creep) {
        // Just chill, or go to a parking spot
        creep.say('😴 Idle');
        // Optional: creep.moveTo(25,25,creep.room.name); // park in the middle
    }
};

module.exports = Taskidle;