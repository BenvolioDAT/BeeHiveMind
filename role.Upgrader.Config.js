'use strict';

// Safe tuning knobs for Upgrader behavior and role-specific debug visuals.
module.exports = Object.freeze({
  DEBUG_SAY: false,
  DEBUG_DRAW: true,
  SIGN_TEXT: "BeeNice Please.",
  PATH_REUSE: 40,

  DRAW: Object.freeze({
    DROP: "#ffe66e",
    CTRL: "#8ab6ff",
    LINK: "#6ec1ff",
    STORE: "#6effa1",
    CONT: "#6effa1",
    IDLE: "#bfbfbf",
    WIDTH: 0.12,
    OPACITY: 0.45,
    FONT: 0.6
  })
});
