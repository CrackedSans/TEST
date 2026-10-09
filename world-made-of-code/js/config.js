/*
 * A World Made of Code — shared configuration.
 *
 * Everything in the scene is driven by a single loop phase (0..1).  Every
 * motion inside the loop completes a whole number of cycles, so the end of
 * the loop is identical to its beginning and the piece runs forever without
 * a visible seam.
 *
 * URL options (all optional, none of them show anything on screen):
 *   ?t=30        start 30 seconds into the timeline
 *   ?fade=0      skip the opening fade-in from black (seconds, default 4)
 *   ?scale=0.8   force the internal render scale (default: automatic)
 *   ?fps=120     frame-rate cap (default 60)
 *   ?loop=480    loop length in seconds (min 240, default 480)
 *   ?code=0      hide the hidden "code" details (constellation + wireframe)
 *   ?petals=0    no cherry-blossom petals
 *   ?freeze      hold a single still frame at ?t
 */
(function () {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const num = (key, fallback) => {
    if (!params.has(key)) return fallback;
    const v = parseFloat(params.get(key));
    return Number.isFinite(v) ? v : fallback;
  };

  // World layout.  Units are "view units": 1.0 = screen height.
  // Y0 is the horizon (eye level), HC the camera height above the lake,
  // K* the parallax factors (1 / depth) of each landscape layer.
  const SCENE = {
    Y0: 0.033,
    HC: 0.667,
    K1: 0.055, // far snowy range
    K2: 0.085, // middle range
    K3: 0.13,  // near ridges
    KT: 0.20,  // far shore with cherry trees
    KF: 1.0,   // foreground bank
    MOON: [0.36, 0.272],
    MOON_R: 0.038,
    FG_SPEED: 0.08, // view units / second at parallax 1.0
    WAVES: 16,
  };

  const CFG = {
    loop: Math.max(240, num('loop', 480)),
    startAt: Math.max(0, num('t', 0)),
    fadeIn: Math.max(0, num('fade', 4)),
    scale: params.has('scale') ? Math.min(2, Math.max(0.3, num('scale', 1))) : null,
    fpsCap: Math.max(24, num('fps', 60)),
    code: num('code', 1) > 0,
    petals: num('petals', 1) > 0,
    freeze: params.has('freeze'),
    debug: params.has('debug'),
  };

  window.WMC = { SCENE, CFG };
})();
