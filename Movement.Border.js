'use strict';
// owns: exit-tile detection and move-off-exit recovery helper.
// does not own: intent queueing.
// called by: Movement.Manager facade.

function isExitPosition(pos) {
  if (!pos) return false;
  if (pos.x === 0 || pos.x === 49) return true;
  if (pos.y === 0 || pos.y === 49) return true;
  return false;
}

function tryMoveOffExit(creep, destination, travelOpts) {
  if (!creep) return null;
  if (creep.fatigue > 0) return null;
  if (!isExitPosition(creep.pos)) return null;
  if (typeof creep.travelTo !== 'function') return null;

  var resultData = {};
  var options = Object.assign({}, travelOpts || {}, {
    range: 0,
    returnData: resultData
  });

  var result = creep.travelTo(destination, options);
  return {
    result: result,
    data: resultData
  };
}

module.exports = {
  isExitPosition: isExitPosition,
  tryMoveOffExit: tryMoveOffExit
};
