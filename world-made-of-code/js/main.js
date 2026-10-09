/*
 * A World Made of Code — runtime.
 * Pure WebGL, no dependencies.  Open index.html and it plays forever.
 */
(function () {
  'use strict';

  const { SCENE, CFG, SHADERS } = window.WMC;
  const TAU = Math.PI * 2;
  const T = CFG.loop;

  // ------------------------------------------------------------ helpers
  const fract = (x) => x - Math.floor(x);
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const wrap = (x, w) => x - w * Math.floor(x / w + 0.5); // -> [-w/2, w/2)
  // whole number of cycles per loop for an approximate period (seconds)
  const cycles = (period) => Math.max(1, Math.round(T / period));
  const osc = (n, phase, offset) => Math.sin(TAU * fract(n * phase) + offset);

  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // -------------------------------------------------------------- WebGL
  const canvas = document.getElementById('world');
  const gl = canvas.getContext('webgl', {
    antialias: false, alpha: false, depth: false, stencil: false,
    premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance',
  });
  if (!gl) {
    document.body.classList.add('no-webgl');
    console.error('WebGL is not available in this browser.');
    return;
  }

  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      console.error(log, '\n', src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n'));
      throw new Error('Shader compile failed: ' + log);
    }
    return sh;
  }
  function program(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link failed: ' + gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const name = info.name.replace(/\[0\]$/, '');
      u[name] = gl.getUniformLocation(p, name);
    }
    return { p, u };
  }

  const sceneProg = program(SHADERS.SCENE_VS, SHADERS.SCENE_FS);
  const spriteProg = program(SHADERS.SPRITE_VS, SHADERS.SPRITE_FS);

  const quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

  const SPRITE_FLOATS = 10; // pos2 uv2 col4 par2
  const MAX_SPRITES = 400;
  const spriteData = new Float32Array(MAX_SPRITES * 6 * SPRITE_FLOATS);
  const spriteBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, spriteBuf);
  gl.bufferData(gl.ARRAY_BUFFER, spriteData.byteLength, gl.DYNAMIC_DRAW);
  const sAttr = {
    pos: gl.getAttribLocation(spriteProg.p, 'aPos'),
    uv: gl.getAttribLocation(spriteProg.p, 'aUv'),
    col: gl.getAttribLocation(spriteProg.p, 'aCol'),
    par: gl.getAttribLocation(spriteProg.p, 'aPar'),
  };
  const scenePosAttr = gl.getAttribLocation(sceneProg.p, 'aPos');

  // ----------------------------------------------------- world motion
  // Camera drifts sideways forever.  Each layer moves by (parallax * D) per
  // loop; its noise is periodic with a period that divides that distance.
  const D = SCENE.FG_SPEED * T;
  function layerPeriod(k, target) {
    const travel = Math.max(D * k, 2.6);
    return { travel, period: travel / Math.max(1, Math.floor(travel / target)) };
  }
  const L1 = layerPeriod(SCENE.K1, 2.8);
  const L2 = layerPeriod(SCENE.K2, 2.8);
  const L3 = layerPeriod(SCENE.K3, 2.8);
  const LT = layerPeriod(SCENE.KT, 2.8);
  const LF = layerPeriod(SCENE.KF, 2.8);
  const CLOUD = { travel: 2.6, period: 2.6 };

  let frameZoom = 1.0;   // < 1 on narrow / portrait screens so the moon stays in frame
  function camera(phase) {
    return {
      zoom: frameZoom * (1.0 + 0.010 * osc(cycles(68), phase, 0.6) + 0.004 * osc(cycles(29), phase, 2.0)),
      pitch: 0.0035 * osc(cycles(53), phase, 1.3) + 0.0015 * osc(cycles(23), phase, 0.2),
      bob: 0.009 * osc(cycles(37), phase, 0.0) + 0.0035 * osc(cycles(16), phase, 2.1),
    };
  }

  // Water: a sum of gentle wave trains.  Spatial frequency along x is locked
  // to the camera travel and temporal frequency to the loop -> seamless.
  const waves = new Float32Array(SCENE.WAVES * 4);
  (function makeWaves() {
    const rnd = mulberry32(20240611);
    const N = SCENE.WAVES;
    for (let j = 0; j < N; j++) {
      const lambda = 0.55 * Math.pow(0.022 / 0.55, j / (N - 1));
      const k = 1 / lambda;
      const ang = (rnd() - 0.5) * 1.9 + (j % 4 === 1 ? 0.6 : 0);
      const m = Math.round(k * Math.sin(ang) * D) || 1;
      const kz = -k * Math.cos(ang);
      const speed = 0.10 * Math.sqrt(lambda / 0.55) * (0.8 + 0.4 * rnd());
      const n = Math.max(1, Math.round(speed * k * T));
      const steep = 0.0052 * (0.7 + 0.6 * rnd()) * (j < 3 ? 0.7 : 1.0);
      waves.set([m, kz, n, steep / (TAU * k)], j * 4);
    }
  })();

  // Shooting stars: a fixed, seeded schedule inside the loop.
  const meteors = (function () {
    const rnd = mulberry32(777);
    const list = [{ t0: 9.0, dur: 1.55, x: 0.10, y: 0.445, ang: Math.PI + 0.33, travel: 0.30, tail: 0.11, b: 0.9 }];
    let t = 9.0 + 34 + rnd() * 10;
    while (t < T - 10) {
      let x, y, tries = 0;
      do {
        x = -0.75 + rnd() * 1.45; y = 0.24 + rnd() * 0.24; tries++;
      } while (Math.hypot(x - SCENE.MOON[0], y - SCENE.MOON[1]) < 0.22 && tries < 30);
      const dir = x > 0.25 ? Math.PI : (rnd() < 0.5 ? 0 : Math.PI);
      const ang = dir === 0 ? -(0.22 + rnd() * 0.4) : Math.PI + (0.22 + rnd() * 0.4);
      list.push({ t0: t, dur: 1.15 + rnd() * 0.6, x, y, ang, travel: 0.20 + rnd() * 0.16, tail: 0.07 + rnd() * 0.06, b: 0.55 + rnd() * 0.4 });
      t += 30 + rnd() * 34;
    }
    return list;
  })();

  // The constellation  < / >  hiding in the upper-left sky.
  const constellation = (function () {
    const c = [-0.50, 0.305], s = 0.052;
    const pts = [[-1.25, 0.95], [-2.15, 0.02], [-1.22, -0.92],  // <
      [-0.42, -1.08], [0.40, 1.10],                              // /
      [1.22, 0.93], [2.12, -0.03], [1.27, -0.95]];              // >
    const jitter = [[0.04, -0.03], [0, 0], [-0.03, 0.02], [0.02, 0], [-0.03, 0.02], [0.02, 0.03], [0, 0], [-0.02, -0.03]];
    const out = new Float32Array(16);
    pts.forEach((p, i) => { out[i * 2] = c[0] + (p[0] + jitter[i][0]) * s; out[i * 2 + 1] = c[1] + (p[1] + jitter[i][1]) * s; });
    return out;
  })();

  // ----------------------------------------------- fireflies & petals
  let W = 2.2;           // horizontal wrap width (view units)
  let flies = [], petals = [];

  function buildSprites(aspect) {
    W = aspect + 0.6;
    const step = W / D;                // parallax quantum -> seamless wrap
    const nFor = (k) => Math.max(1, Math.round(k / step));
    const rnd = mulberry32(4242);
    flies = [];
    const COUNT = 70;
    for (let i = 0; i < COUNT; i++) {
      const r = rnd();
      const kTarget = 0.21 + Math.pow(r, 1.6) * 0.62;
      const n = nFor(kTarget);
      const k = n * step;
      flies.push({
        type: 0, n, k, x0: rnd() * W,
        h0: (0.05 + Math.pow(rnd(), 1.3) * 0.36), // world height above the water
        ax: (0.012 + rnd() * 0.03) * k, nx: cycles(14 + rnd() * 16), px: rnd() * TAU,
        ax2: (0.006 + rnd() * 0.012) * k, nx2: cycles(5 + rnd() * 6), px2: rnd() * TAU,
        ah: 0.02 + rnd() * 0.05, nh: cycles(9 + rnd() * 12), ph: rnd() * TAU,
        nf: cycles(3.5 + rnd() * 5.5), pf: rnd() * TAU, steady: rnd() < 0.25,
        nf2: cycles(11 + rnd() * 9), pf2: rnd() * TAU,
        size: 0.0022 + rnd() * 0.0012, bright: 0.55 + rnd() * 0.45,
        hue: rnd(),
      });
    }
    // a few drifting right in front of the lens, out of focus
    for (let i = 0; i < 4; i++) {
      const n = nFor(1.15 + rnd() * 0.3);
      flies.push({
        type: 1, n, k: n * step, x0: rnd() * W, y0: -0.36 + rnd() * 0.5,
        ax: 0.03 + rnd() * 0.03, nx: cycles(20 + rnd() * 10), px: rnd() * TAU,
        ah: 0.025 + rnd() * 0.03, nh: cycles(16 + rnd() * 10), ph: rnd() * TAU,
        nf: cycles(6 + rnd() * 5), pf: rnd() * TAU,
        size: 0.020 + rnd() * 0.018, bright: 0.035 + rnd() * 0.025, hue: rnd(),
      });
    }
    petals = [];
    if (CFG.petals) {
      const PC = 16;
      const H = 1.25;
      for (let i = 0; i < PC; i++) {
        const n = nFor(0.45 + rnd() * 0.85);
        const k = n * step;
        petals.push({
          type: 2, n, k, x0: rnd() * W, y0: rnd() * H, H,
          fall: Math.max(1, Math.round((0.022 + rnd() * 0.018) * k * T / H)),
          ax: 0.02 + rnd() * 0.03, nx: cycles(7 + rnd() * 6), px: rnd() * TAU,
          nr: cycles(9 + rnd() * 9) * (rnd() < 0.5 ? -1 : 1), pr: rnd() * TAU,
          nt: cycles(3 + rnd() * 3), pt: rnd() * TAU,
          size: (0.0085 + rnd() * 0.004) * Math.min(k, 1.15), bright: 0.48 + rnd() * 0.16,
        });
      }
    }
  }

  // ------------------------------------------------------ sprite writer
  let spriteCount = 0;
  function pushQuad(cx, cy, hx, hy, rot, r, g, b, a, type, shape, res) {
    if (spriteCount >= MAX_SPRITES) return;
    const cs = Math.cos(rot), sn = Math.sin(rot);
    const sx = 2 / res[0], sy = 2 / res[1];
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
    let o = spriteCount * 6 * SPRITE_FLOATS;
    for (const [u, v] of corners) {
      const px = u * hx, py = v * hy;
      spriteData[o++] = cx + (px * cs - py * sn) * sx;
      spriteData[o++] = cy + (px * sn + py * cs) * sy;
      spriteData[o++] = u; spriteData[o++] = v;
      spriteData[o++] = r; spriteData[o++] = g; spriteData[o++] = b; spriteData[o++] = a;
      spriteData[o++] = type; spriteData[o++] = shape;
    }
    spriteCount++;
  }

  function buildSpriteFrame(phase, cam, res) {
    spriteCount = 0;
    const aspect = res[0] / res[1];
    const pxPerUnit = res[1] * cam.zoom;
    // view -> clip
    const toClip = (x, y) => [((x) * cam.zoom) * 2 / aspect, ((y - cam.pitch) * cam.zoom) * 2];
    const list = [];
    for (const f of flies) list.push(f);
    for (const p of petals) list.push(p);
    list.sort((a, b) => a.k - b.k);

    for (const f of list) {
      const drift = f.n * W * phase; // == parallax * camera travel, wraps exactly
      if (f.type === 0) {
        let x = f.x0 + f.ax * osc(f.nx, phase, f.px) + f.ax2 * osc(f.nx2, phase, f.px2) - drift;
        x = wrap(x, W);
        const base = SCENE.Y0 - (SCENE.HC + cam.bob) * f.k;
        const h = f.h0 + f.ah * osc(f.nh, phase, f.ph);
        const y = base + h * f.k;
        let flash = f.steady ? 0.55 + 0.1 * osc(f.nf, phase, f.pf)
          : Math.pow(0.5 + 0.5 * osc(f.nf, phase, f.pf), 2.2) * (0.75 + 0.25 * osc(f.nf2, phase, f.pf2));
        flash = 0.08 + 0.92 * flash;
        const I = f.bright * flash * (0.65 + 0.5 * f.k);
        const core = Math.max(1.1, f.size * f.k * pxPerUnit * 0.8 + 0.8);
        const R = core * 11;
        const warm = f.hue;
        const cr = 1.0, cg = 0.80 + 0.10 * warm, cb = 0.42 + 0.16 * warm;
        const [cx, cy] = toClip(x, y);
        if (Math.abs(cx) < 1.2 && cy > -1.2 && cy < 1.2) {
          pushQuad(cx, cy, R, R, 0, cr, cg, cb, I, 0, core / R, res);
          // reflection on the lake (only over water, not over the bank)
          if (f.k < 0.78) {
            const yr = base - h * f.k;
            const fadeR = smooth(-0.47, -0.36, yr) * smooth(-0.002, 0.012, h * f.k);
            if (fadeR > 0) {
              const wob = 0.0012 * osc(cycles(2.3), phase, f.px * 3) * f.k;
              const [rx, ry] = toClip(x + wob, yr);
              pushQuad(rx, ry, R * 0.9, R * 1.5, 0, cr, cg * 0.95, cb * 0.9, I * 0.30 * fadeR, 0, core / R * 1.1, res);
            }
          }
        }
      } else if (f.type === 1) {
        let x = f.x0 + f.ax * osc(f.nx, phase, f.px) - drift;
        x = wrap(x, W);
        const y = f.y0 + f.ah * osc(f.nh, phase, f.ph);
        const I = f.bright * (0.55 + 0.45 * osc(f.nf, phase, f.pf));
        const R = f.size * pxPerUnit;
        const [cx, cy] = toClip(x, y);
        pushQuad(cx, cy, R, R, 0, 1.0, 0.80, 0.50, I, 1, clamp(10 / R, 0.15, 0.7), res);
      } else {
        let x = f.x0 + f.ax * osc(f.nx, phase, f.px) - drift;
        x = wrap(x, W);
        const y = 0.62 - (((f.y0 + f.fall * f.H * phase) % f.H) + f.H) % f.H;
        const rot = TAU * fract(f.nr * phase) + f.pr;
        const tumble = 0.25 + 0.75 * Math.abs(osc(f.nt, phase, f.pt));
        const s = f.size * pxPerUnit;
        const [cx, cy] = toClip(x, y);
        const soft = clamp(1.6 / s + Math.max(0, f.k - 1.0) * 0.35, 0.04, 0.45);
        const lum = f.bright * (0.85 + 0.3 * tumble);
        pushQuad(cx, cy, s * 0.80 * tumble, s, rot, 0.98 * lum, 0.66 * lum, 0.80 * lum, 0.82, 2, soft, res);
      }
    }
  }

  // ------------------------------------------------------------ timeline
  function codeTimeline(t) {
    // every ~2 minutes the world briefly shows how it is made
    const cycleLen = T / Math.max(1, Math.round(T / 120));
    const cs = ((t % cycleLen) + cycleLen) % cycleLen;
    const conDrawn = clamp((cs - 5.5) / 2.0, 0, 5);
    const conAlpha = smooth(5.0, 6.0, cs) * (1 - smooth(70, 82, cs));
    const sweep = (cs - 2.0) / 30.0;
    const wireX = -1.25 + 2.5 * sweep;
    const wireA = smooth(0.0, 0.08, sweep) * (1 - smooth(0.92, 1.0, sweep));
    return { conDrawn, conAlpha, wireX, wireA };
  }

  function meteorState(t) {
    const lt = ((t % T) + T) % T;
    const A = new Float32Array(8), B = new Float32Array(8);
    let slot = 0;
    for (const m of meteors) {
      if (slot > 1) break;
      const p = (lt - m.t0) / m.dur;
      if (p < 0 || p > 1) continue;
      const dx = Math.cos(m.ang), dy = Math.sin(m.ang);
      const e = Math.pow(Math.sin(Math.PI * p), 0.9);
      A.set([m.x + dx * m.travel * p, m.y + dy * m.travel * p, dx, dy], slot * 4);
      B.set([m.b * e, m.tail * clamp(p * 3.5, 0.15, 1), 1, 0], slot * 4);
      slot++;
    }
    return { A, B };
  }

  // ------------------------------------------------------ sizing & quality
  let renderScale = CFG.scale !== null ? CFG.scale : 1.0;
  const MAX_PIXELS = 2880 * 1800;
  let res = [1, 1];
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const cssW = window.innerWidth, cssH = window.innerHeight;
    let w = cssW * dpr * renderScale, h = cssH * dpr * renderScale;
    if (w * h > MAX_PIXELS) { const k = Math.sqrt(MAX_PIXELS / (w * h)); w *= k; h *= k; }
    w = Math.max(2, Math.round(w)); h = Math.max(2, Math.round(h));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
    }
    res = [w, h];
    frameZoom = Math.min(1.0, (w / h) / 1.25);
    buildSprites(w / h / frameZoom);
  }
  window.addEventListener('resize', resize);
  resize();

  // Frame pacing: find the display refresh, then render every Nth vsync so
  // 120 Hz panels get a perfectly even 60 fps (60/75/90 Hz render every frame).
  const pacer = { samples: [], skip: 1, tick: 0, vsync: 1000 / 60, locked: false };
  function pace(dt) {
    if (!pacer.locked) {
      if (dt > 0) pacer.samples.push(dt);
      if (pacer.samples.length >= 30) {
        const s = pacer.samples.slice().sort((a, b) => a - b);
        pacer.vsync = s[Math.floor(s.length * 0.2)];
        pacer.skip = Math.max(1, Math.round((1000 / CFG.fpsCap) / pacer.vsync));
        pacer.locked = true;
        if (CFG.debug) console.log('[world] vsync', pacer.vsync.toFixed(2), 'ms, rendering every', pacer.skip, 'frame(s)');
      }
      return true;
    }
    pacer.tick = (pacer.tick + 1) % pacer.skip;
    return pacer.tick === 0;
  }

  // auto quality: measured while the opening fade hides any change
  const autoQ = { on: CFG.scale === null && !CFG.freeze, samples: [], tries: 0, until: 5.0 };
  function autoQuality(elapsed, dt) {
    if (!autoQ.on || !pacer.locked) return;
    autoQ.samples.push(dt);
    if (autoQ.samples.length < 30) return;
    const s = autoQ.samples.slice().sort((a, b) => a - b);
    const med = s[Math.floor(s.length / 2)];
    // every display refreshes at >= 60 Hz, so a slower "vsync" means the GPU is the limit
    const budget = Math.min(pacer.vsync, 1000 / 60) * pacer.skip;
    autoQ.samples = [];
    if (med > budget * 1.25 && autoQ.tries < 4 && renderScale > 0.5) {
      renderScale = Math.max(0.5, renderScale * clamp(budget / med * 1.05, 0.6, 0.9));
      autoQ.tries++;
      resize();
      if (CFG.debug) console.log('[world] render scale ->', renderScale.toFixed(2), 'median frame', med.toFixed(1), 'ms');
    } else if (elapsed > autoQ.until || autoQ.tries >= 4) {
      autoQ.on = false;
      if (CFG.debug) console.log('[world] quality locked at', renderScale.toFixed(2), canvas.width + 'x' + canvas.height);
    }
  }

  // --------------------------------------------------------------- render
  function render(t, elapsed) {
    const phase = fract(t / T);
    const cam = camera(phase);
    const fade = CFG.freeze ? 1 : (CFG.fadeIn > 0 ? smooth(0, CFG.fadeIn, elapsed) : 1);
    const code = codeTimeline(t);
    const met = meteorState(t);

    gl.viewport(0, 0, res[0], res[1]);
    gl.disable(gl.BLEND);
    gl.useProgram(sceneProg.p);
    const u = sceneProg.u;
    gl.uniform2f(u.uRes, res[0], res[1]);
    gl.uniform1f(u.uPhase, phase);
    gl.uniform1f(u.uLoop, T);
    gl.uniform3f(u.uCam, cam.zoom, cam.pitch, cam.bob);
    gl.uniform4f(u.uOff, fract(phase * L1.travel / L1.period) * L1.period, fract(phase * L2.travel / L2.period) * L2.period,
      fract(phase * L3.travel / L3.period) * L3.period, fract(phase * LT.travel / LT.period) * LT.period);
    gl.uniform4f(u.uPer, L1.period, L2.period, L3.period, LT.period);
    gl.uniform2f(u.uFg, fract(phase * LF.travel / LF.period) * LF.period, LF.period);
    gl.uniform1f(u.uTravel, D);
    gl.uniform2f(u.uCloud, fract(phase * CLOUD.travel / CLOUD.period) * CLOUD.period, CLOUD.period);
    gl.uniform4fv(u.uWave, waves);
    gl.uniform4fv(u.uMetA, met.A);
    gl.uniform4fv(u.uMetB, met.B);
    gl.uniform2fv(u.uCon, constellation);
    gl.uniform2f(u.uConAnim, CFG.code ? code.conDrawn : -2, CFG.code ? code.conAlpha : 0);
    gl.uniform2f(u.uWire, code.wireX, CFG.code ? code.wireA : 0);
    gl.uniform1f(u.uFade, fade);
    gl.uniform1f(u.uFrame, frameNo % 1024);

    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.enableVertexAttribArray(scenePosAttr);
    gl.vertexAttribPointer(scenePosAttr, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disableVertexAttribArray(scenePosAttr);

    // sprites
    buildSpriteFrame(phase, cam, res);
    if (spriteCount > 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(spriteProg.p);
      gl.uniform2f(spriteProg.u.uRes, res[0], res[1]);
      gl.uniform1f(spriteProg.u.uFade, fade);
      gl.bindBuffer(gl.ARRAY_BUFFER, spriteBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, spriteData.subarray(0, spriteCount * 6 * SPRITE_FLOATS));
      const stride = SPRITE_FLOATS * 4;
      gl.enableVertexAttribArray(sAttr.pos); gl.vertexAttribPointer(sAttr.pos, 2, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(sAttr.uv); gl.vertexAttribPointer(sAttr.uv, 2, gl.FLOAT, false, stride, 8);
      gl.enableVertexAttribArray(sAttr.col); gl.vertexAttribPointer(sAttr.col, 4, gl.FLOAT, false, stride, 16);
      gl.enableVertexAttribArray(sAttr.par); gl.vertexAttribPointer(sAttr.par, 2, gl.FLOAT, false, stride, 32);
      gl.drawArrays(gl.TRIANGLES, 0, spriteCount * 6);
      gl.disableVertexAttribArray(sAttr.pos); gl.disableVertexAttribArray(sAttr.uv);
      gl.disableVertexAttribArray(sAttr.col); gl.disableVertexAttribArray(sAttr.par);
    }
  }

  // ----------------------------------------------------------------- loop
  let start = null, lastTick = 0, lastRender = 0, frameNo = 0, paused = false, pauseOffset = 0, pausedAt = 0;

  function frame(now) {
    requestAnimationFrame(frame);
    if (start === null) { start = now; lastTick = lastRender = now; }
    const tickDt = now - lastTick;
    lastTick = now;
    if (!pace(tickDt)) return;
    const dt = now - lastRender;
    lastRender = now;
    if (paused) return;
    const elapsed = (now - start - pauseOffset) / 1000;
    const t = CFG.freeze ? CFG.startAt : CFG.startAt + elapsed;
    render(t, elapsed);
    frameNo++;
    autoQuality(elapsed, dt);
    window.__worldReady = true;
  }
  requestAnimationFrame(frame);

  // ------------------------------------------------- cursor & fullscreen
  let hideTimer = 0;
  document.body.classList.add('hide-cursor');
  window.addEventListener('mousemove', () => {
    document.body.classList.remove('hide-cursor');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => document.body.classList.add('hide-cursor'), 1500);
  });

  function toggleFullscreen() {
    const d = document, el = d.documentElement;
    const isFs = d.fullscreenElement || d.webkitFullscreenElement;
    if (!isFs) (el.requestFullscreen || el.webkitRequestFullscreen || function () {}).call(el);
    else (d.exitFullscreen || d.webkitExitFullscreen || function () {}).call(d);
  }
  window.addEventListener('dblclick', toggleFullscreen);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'f' || e.key === 'F') toggleFullscreen();
    if (e.key === ' ') {
      e.preventDefault();
      paused = !paused;
      const now = performance.now();
      if (paused) pausedAt = now; else pauseOffset += now - pausedAt;
    }
  });

  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); }, false);
  canvas.addEventListener('webglcontextrestored', () => window.location.reload(), false);

  // test hooks (used for previews / timing notes)
  window.__worldInfo = { loop: T, meteors: meteors.map((m) => +m.t0.toFixed(1)) };
  // test hook: render one exact moment (used for previews)
  window.__renderAt = (t) => { CFG.freeze = true; CFG.startAt = t; render(t, 99); gl.finish(); };
})();
