/*
 * GLSL sources.  The landscape is a single full-screen fragment shader:
 * sky, stars, moon, clouds, four parallax mountain/forest layers, a lake with
 * physically-placed reflections, shore mist and a foreground reed bank.
 * Fireflies and petals are drawn afterwards as soft sprites.
 */
(function () {
  'use strict';

  const S = window.WMC.SCENE;
  const f = (v) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

  const SCENE_VS = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

  const SCENE_FS = `
precision highp float;

uniform vec2  uRes;
uniform float uPhase;      // loop phase 0..1
uniform float uLoop;       // loop length (s)
uniform vec3  uCam;        // zoom, pitch, bob
uniform vec4  uOff;        // layer offsets  (far, mid, near, trees)
uniform vec4  uPer;        // layer periods
uniform vec2  uFg;         // foreground offset, period
uniform float uTravel;     // foreground travel per loop (water period)
uniform vec2  uCloud;      // cloud offset, period
uniform vec4  uWave[${S.WAVES}];
uniform vec4  uMetA[2];    // meteor head.xy, dir.xy
uniform vec4  uMetB[2];    // brightness, tail length, active, -
uniform vec2  uCon[8];     // constellation stars
uniform vec2  uConAnim;    // segments drawn, alpha
uniform vec2  uWire;       // wire sweep x, alpha
uniform float uFade;
uniform float uFrame;

#define TAU 6.28318530718

const float Y0 = ${f(S.Y0)};
const float HC = ${f(S.HC)};
const float K1 = ${f(S.K1)};
const float K2 = ${f(S.K2)};
const float K3 = ${f(S.K3)};
const float KT = ${f(S.KT)};
const float KF = ${f(S.KF)};
const vec2  MOON = vec2(${f(S.MOON[0])}, ${f(S.MOON[1])});
const float MOON_R = ${f(S.MOON_R)};

// palette (display space)
const vec3 SKY_ZEN  = vec3(0.016, 0.022, 0.070);
const vec3 SKY_HIGH = vec3(0.040, 0.046, 0.140);
const vec3 SKY_MID  = vec3(0.105, 0.090, 0.235);
const vec3 SKY_LOW  = vec3(0.235, 0.165, 0.330);
const vec3 SKY_HOR  = vec3(0.395, 0.270, 0.430);
const vec3 HAZE     = vec3(0.285, 0.215, 0.385);
const vec3 MOONLIT  = vec3(0.640, 0.680, 0.900);

float gPx;   // one pixel in view units
float gBob;  // camera vertical float

// ---------------------------------------------------------------- hashes
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 hash32(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yzz) * p3.zyx); }
vec3 hash31(float p) { vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xxy + p3.yzz) * p3.zyx); }

// whole number of cycles per loop -> seamless
float cyc(float n) { return TAU * fract(n * uPhase); }
float loopN(float period) { return max(1.0, floor(uLoop / period + 0.5)); }

// ----------------------------------------------------------------- noise
// periodic 1D value noise with analytic derivative (x in cells, period P cells)
vec2 vnoiseD(float x, float P, float seed) {
  float i = floor(x);
  float fr = x - i;
  float a = hash11(mod(i, P) + seed);
  float b = hash11(mod(i + 1.0, P) + seed);
  float u = fr * fr * (3.0 - 2.0 * fr);
  return vec2(a + (b - a) * u, (b - a) * 6.0 * fr * (1.0 - fr));
}

float vnoise2(vec2 x) {
  vec2 i = floor(x); vec2 fr = x - i; vec2 u = fr * fr * (3.0 - 2.0 * fr);
  float a = hash12(i), b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0)), d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// 2D value noise, periodic in x with period P cells
float vnoise2p(vec2 x, float P) {
  vec2 i = floor(x); vec2 fr = x - i; vec2 u = fr * fr * (3.0 - 2.0 * fr);
  float i0 = mod(i.x, P), i1 = mod(i.x + 1.0, P);
  float a = hash12(vec2(i0, i.y)), b = hash12(vec2(i1, i.y));
  float c = hash12(vec2(i0, i.y + 1.0)), d = hash12(vec2(i1, i.y + 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm2(vec2 x) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise2(x); x = x * 2.03 + vec2(17.1, 9.3); a *= 0.5; }
  return s / 0.96875;
}

float fbm2p(vec2 x, float P) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * vnoise2p(x, P); x = x * 2.0 + vec2(0.0, 13.7); P *= 2.0; a *= 0.5; }
  return s / 0.9375;
}

// ridged fbm -> sharp mountain crests.  returns (height 0..1, d/du)
vec2 ridgedD(float u, float P, float cell, float seed) {
  float N = max(1.0, floor(P / cell + 0.5));
  float sc = N / P;
  float x = u * sc;
  float s = 0.0, ds = 0.0, a = 0.5, w = 1.0, norm = 0.0;
  for (int i = 0; i < 6; i++) {
    vec2 v = vnoiseD(x, N, seed + float(i) * 7.31);
    float t = 2.0 * v.x - 1.0;
    float r = 1.0 - abs(t);
    float dr = -(t / sqrt(t * t + 0.06)) * 2.0 * v.y * sc;   // smoothed |t|' : no seams
    s  += a * w * r * r;
    if (i < 3) ds += a * w * 2.0 * r * dr;   // slope from broad shapes only
    norm += a;
    w = clamp(r * r * 1.5, 0.3, 1.0);
    x *= 2.0; N *= 2.0; sc *= 2.0; a *= 0.5;
  }
  return vec2(s, ds) / norm;
}

// smooth fbm with derivative
vec2 fbmD(float u, float P, float cell, float seed, int oct) {
  float N = max(1.0, floor(P / cell + 0.5));
  float sc = N / P;
  float x = u * sc;
  float s = 0.0, ds = 0.0, a = 0.5, norm = 0.0;
  for (int i = 0; i < 6; i++) {
    if (i >= oct) break;
    vec2 v = vnoiseD(x, N, seed + float(i) * 5.17);
    s += a * v.x; norm += a;
    if (i < 3) ds += a * v.y * sc;
    x *= 2.0; N *= 2.0; sc *= 2.0; a *= 0.5;
  }
  return vec2(s, ds) / norm;
}

// ------------------------------------------------------------------- sky
vec3 skyGradient(float h) {
  vec3 c = mix(SKY_HOR, SKY_LOW, smoothstep(0.0, 0.075, h));
  c = mix(c, SKY_MID, smoothstep(0.04, 0.20, h));
  c = mix(c, SKY_HIGH, smoothstep(0.15, 0.36, h));
  c = mix(c, SKY_ZEN, smoothstep(0.30, 0.60, h));
  return c;
}

float milkyWay(vec2 s, out float core) {
  vec2 a = vec2(-0.92, 0.06);
  vec2 dir = normalize(vec2(0.78, 0.62));
  vec2 d = s - a;
  float along = dot(d, dir);
  float across = dot(d, vec2(-dir.y, dir.x)) + 0.035 * sin(along * 3.1 + 0.7);
  float band = exp(-across * across / 0.0085) * smoothstep(-0.05, 0.35, along);
  core = exp(-across * across / 0.0016) * smoothstep(0.0, 0.4, along);
  if (band < 0.004) { core = 0.0; return 0.0; }
  float cloud = fbm2(s * 5.0 + 3.0);
  float dust = fbm2(s * 11.0 + vec2(7.0, 1.0));
  float m = band * (0.35 + 0.9 * cloud * cloud);
  m *= 1.0 - 0.75 * smoothstep(0.45, 0.72, dust) * exp(-across * across / 0.0022);
  return m;
}

// one grid of stars: cell = cells per view unit
vec3 starLayer(vec2 s, float cell, float prob, float bMin, float bPow, float sigma, float halo, float seed) {
  vec2 g = s * cell;
  vec2 id = floor(g);
  vec3 h = hash32(id + seed);
  if (h.x > prob) return vec3(0.0);
  vec2 pos = 0.2 + 0.6 * hash22(id + seed * 1.37 + 11.0);
  vec2 d = (g - id - pos) / cell;
  float dist = length(d) / gPx;                    // in pixels
  float b = bMin + (1.0 - bMin) * pow(h.y, bPow);
  float sg = sigma * (0.75 + 0.5 * b);
  float I = exp(-dist * dist / (2.0 * sg * sg)) + halo * exp(-dist / (sigma * 4.0));
  // independent twinkle: two incommensurate whole-loop frequencies
  float n1 = floor(mix(loopN(9.0), loopN(2.6), h.z));
  float n2 = floor(mix(loopN(5.0), loopN(1.7), fract(h.z * 7.7)));
  float tw = 1.0 + 0.30 * sin(cyc(n1) + h.y * 40.0) + 0.16 * sin(cyc(n2) + h.x * 61.0);
  vec3 tint = mix(vec3(0.70, 0.80, 1.00), vec3(1.00, 0.89, 0.76), fract(h.z * 13.1));
  tint = mix(tint, vec3(1.0), 0.35);
  return tint * I * b * tw;
}

vec3 stars(vec2 s, float refl, float mwCore, float mw) {
  vec3 c = vec3(0.0);
  c += starLayer(s, 9.0, 0.42, 0.55, 1.6, 1.15, 0.22, 3.1) * 1.05;
  c += starLayer(s, 31.0, 0.55 + 0.3 * mw, 0.25, 2.5, 0.95, 0.06, 17.3) * 0.75;
  if (refl < 0.5) {
    c += starLayer(s, 88.0, 0.50 + 0.45 * clamp(mw * 2.0, 0.0, 1.0), 0.15, 3.0, 0.70, 0.0, 41.7) * 0.55;
    c += starLayer(s, 150.0, 0.85 * mwCore, 0.10, 2.0, 0.60, 0.0, 77.1) * 0.35;
  }
  return c;
}

// the hidden constellation:  </>
float segment(vec2 s, vec2 a, vec2 b, float prog) {
  vec2 ab = b - a;
  float L = length(ab);
  vec2 dir = ab / L;
  float gap = 0.0075;
  vec2 a2 = a + dir * gap;
  float L2 = max(L - 2.0 * gap, 0.0) * prog;
  vec2 d = s - a2;
  float t = clamp(dot(d, dir), 0.0, L2);
  float dist = length(d - dir * t) / gPx;
  return exp(-dist * dist / 1.1) * smoothstep(0.0, 0.03, prog);
}

vec3 constellation(vec2 s, float refl) {
  vec3 c = vec3(0.0);
  // the stars themselves are always there
  for (int i = 0; i < 8; i++) {
    float dist = length(s - uCon[i]) / gPx;
    float tw = 0.9 + 0.1 * sin(cyc(floor(uLoop / (3.0 + float(i) * 0.37))) + float(i));
    float b = (i == 1 || i == 6) ? 1.0 : 0.78;
    c += vec3(0.86, 0.90, 1.0) * b * tw * (exp(-dist * dist / 3.2) + 0.12 * exp(-dist / 5.0));
  }
  if (uConAnim.y > 0.001) {
    float l = 0.0;
    l += segment(s, uCon[0], uCon[1], clamp(uConAnim.x - 0.0, 0.0, 1.0));
    l += segment(s, uCon[1], uCon[2], clamp(uConAnim.x - 1.0, 0.0, 1.0));
    l += segment(s, uCon[3], uCon[4], clamp(uConAnim.x - 2.0, 0.0, 1.0));
    l += segment(s, uCon[5], uCon[6], clamp(uConAnim.x - 3.0, 0.0, 1.0));
    l += segment(s, uCon[6], uCon[7], clamp(uConAnim.x - 4.0, 0.0, 1.0));
    c += vec3(0.62, 0.70, 1.0) * l * 0.16 * uConAnim.y;
  }
  return c;
}

vec3 meteor(vec2 s, vec4 A, vec4 B) {
  vec2 d = s - A.xy;
  float behind = -dot(d, A.zw);
  float across = abs(dot(d, vec2(-A.w, A.z)));
  float t = clamp(behind / max(B.y, 1e-4), 0.0, 1.0);
  float w = gPx * (0.75 + 1.1 * (1.0 - t));
  float trail = exp(-across * across / (w * w)) * pow(1.0 - t, 1.6) * step(0.0, behind) * step(behind, B.y);
  float head = exp(-length(d) / (gPx * 2.2));
  return vec3(0.86, 0.90, 1.0) * (trail * 0.75 + head * 0.9) * B.x;
}

float cloudField(vec2 s) {
  float h = s.y - Y0;
  float mask = smoothstep(0.02, 0.11, h) * (1.0 - smoothstep(0.30, 0.46, h));
  if (mask <= 0.0) return 0.0;
  float P = uCloud.y;
  float N = max(1.0, floor(P * 1.6 + 0.5));
  float u = (s.x + uCloud.x) / P * N;
  vec2 q = vec2(u, s.y * 10.5);
  float w = vnoise2p(q * vec2(0.5, 0.35) + vec2(0.0, 4.0), N * 0.5);
  q.y += (w - 0.5) * 1.3;
  float n = fbm2p(q, N);
  float c = smoothstep(0.50, 0.82, n) * mask;
  return c * 0.80;
}

vec3 moonDisc(vec2 s, float soft) {
  vec2 d = s - MOON;
  float r = length(d);
  float disc = 1.0 - smoothstep(MOON_R - soft, MOON_R + soft, r);
  vec3 c = vec3(0.0);
  if (disc > 0.0) {
    vec2 m = d / MOON_R;
    float z = sqrt(max(0.0, 1.0 - dot(m, m)));
    float maria = fbm2(m * 1.9 + vec2(4.2, 1.3));
    float crater = fbm2(m * 6.0 + 9.0);
    float tex = 1.0 - 0.22 * smoothstep(0.42, 0.66, maria) - 0.07 * smoothstep(0.5, 0.8, crater);
    c = vec3(1.0, 0.965, 0.90) * (0.78 + 0.22 * z) * tex * 1.12 * disc;
  }
  return c;
}

vec3 moonGlow(vec2 s) {
  float r = length(s - MOON);
  float e = max(r - MOON_R, 0.0);
  return MOONLIT * (0.30 * exp(-e * 46.0) + 0.11 * exp(-e * 11.0) + 0.06 * exp(-r * 3.0) + 0.04 * exp(-r * 1.1));
}

vec3 sky(vec2 s, float refl) {
  float h = s.y - Y0;
  vec3 c = skyGradient(h);
  float dm = length(s - MOON);

  float core;
  float mw = milkyWay(s, core);
  float moonWash = smoothstep(0.06, 0.45, dm);
  float horizon = smoothstep(0.0, 0.14, h);

  c += vec3(0.30, 0.27, 0.48) * mw * 0.075 * moonWash;
  vec3 st = stars(s, refl, core, mw) * moonWash * mix(0.18, 1.0, horizon);
  if (uConAnim.x > -1.0) st += constellation(s, refl);

  float cl = cloudField(s);
  vec3 glow = moonGlow(s);
  // clouds: dark veils that catch silver light near the moon
  vec3 cloudCol = mix(c * 0.78, MOONLIT * 0.9, clamp(exp(-dm * 5.5) * 1.15, 0.0, 1.0));
  cloudCol += SKY_LOW * 0.12 * (1.0 - smoothstep(0.0, 0.2, h));

  c += glow * (1.0 - 0.35 * cl);
  c += st * (1.0 - 0.92 * cl);

  vec3 md = moonDisc(s, refl > 0.5 ? gPx * 3.0 : gPx * 0.9);
  c += md * (1.0 - 0.55 * cl);
  c = mix(c, cloudCol, cl * 0.75);

  for (int i = 0; i < 2; i++) {
    if (uMetB[i].z > 0.5) c += meteor(s, uMetA[i], uMetB[i]) * (1.0 - 0.8 * cl);
  }
  return c;
}

// ------------------------------------------------------- landscape layers
// shades a mountain layer: h = (height above base, slope)
vec4 shadeRange(vec2 p, float u, float base, vec2 h, vec3 cDark, float haze, float rimAmt, float aa, float seed) {
  float H = base + h.x;
  float dd = H - p.y;
  float a = smoothstep(-aa, aa, dd);
  if (a <= 0.0) return vec4(0.0);
  float facing = clamp(0.45 - h.y * 0.9, 0.0, 1.0);          // slopes facing the moon
  float texN = vnoise2(vec2(u * 38.0 + seed, p.y * 70.0));
  vec3 c = cDark * (0.93 + 0.14 * texN);
  c *= mix(1.0, mix(0.90, 1.13, facing), exp(-dd * 34.0));    // faceted moonlight
  c += MOONLIT * rimAmt * facing * facing * exp(-dd / (gPx * 2.2 + 0.0012));
  float hb = p.y - base;
  float mist = 1.0 - smoothstep(0.0, 0.085, hb);
  c = mix(c, HAZE, clamp(haze + mist * mist * 0.62, 0.0, 1.0));
  return vec4(c, a);
}

vec2 profM1(float u) { vec2 r = ridgedD(u, uPer.x, 0.36, 0.37);  return vec2(0.050 + 0.215 * r.x, 0.215 * r.y); }
vec2 profM2(float u) { vec2 r = ridgedD(u, uPer.y, 0.25, 5.71); vec2 g = fbmD(u, uPer.y, 0.55, 9.13, 3); return vec2(0.026 + 0.105 * r.x + 0.06 * g.x, 0.105 * r.y + 0.06 * g.y); }
vec2 profM3(float u) { vec2 g = fbmD(u, uPer.z, 0.27, 2.33, 5); return vec2(0.030 + 0.090 * g.x, 0.090 * g.y); }

// faint mesh that reveals the far range is "made of code"
float wireMesh(vec2 p, float u, float base, float H) {
  float P = uPer.x;
  float N = floor(P / 0.042 + 0.5);
  float ws = P / N;
  float x = u / ws;
  float i0 = floor(x);
  float fu = x - i0;
  float hL = base + profM1(i0 * ws).x;
  float hR = base + profM1((i0 + 1.0) * ws).x;
  float Hl = mix(hL, hR, fu);
  float rowH = 0.021;
  float r = (Hl - p.y) / rowH;
  if (r < -0.3 || r > 8.0) return 0.0;
  float pxR = gPx / rowH;
  float slope = (hR - hL) / ws;
  float stretch = sqrt(1.0 + slope * slope);
  float dh = abs(fract(r + 0.5) - 0.5) / (pxR * stretch);
  float dv = abs(fract(fu + 0.5) - 0.5) * ws / gPx;
  float dg = abs(fract(r - fu + 0.5) - 0.5) / (pxR * 1.6);
  float lines = max(max(exp(-dh * dh * 1.4), exp(-dv * dv * 1.4)) , exp(-dg * dg * 1.4) * 0.6);
  vec2 vtx = vec2((fract(fu + 0.5) - 0.5) * ws, (fract(r + 0.5) - 0.5) * rowH) / gPx;
  float dots = exp(-dot(vtx, vtx) / 3.5) * 1.6;
  float fade = exp(-max(r, 0.0) * 0.42) * smoothstep(-0.3, 0.2, r);
  float under = smoothstep(-gPx * 1.5, gPx * 0.5, H - p.y + gPx);  // stay on the mountain
  return (lines * 0.55 + dots) * fade * under;
}

// far shore: rolling ground, a dark wooded band and blossoming cherry trees
vec4 treeLayer(float u, float y, float base, float aa) {
  float hy = y - base;
  if (hy > 0.095) return vec4(0.0);
  float P = uPer.w;
  vec2 g = fbmD(u, P, 0.33, 21.7, 3);
  float ground = 0.003 + 0.026 * g.x * g.x;
  // low wooded band so the trees grow out of a forest edge, not a lawn
  float Nb = floor(P / 0.006 + 0.5);
  float bush = ground + 0.003 + 0.010 * fbmD(u, P, 0.06, 13.1, 2).x + 0.004 * vnoiseD(u / P * Nb, Nb, 4.4).x;
  float cov = smoothstep(-aa, aa, bush - hy);

  float N = floor(P / 0.024 + 0.5);
  float cw = P / N;
  float ci = floor(u / cw);
  vec2 lp = vec2(u, hy);
  float fn = vnoise2p(lp * (5.0 / cw), N * 5.0) * 0.6 + vnoise2p(lp * (13.0 / cw), N * 13.0) * 0.4;

  float best = 1e3;
  vec2 bestD = vec2(0.0, 1.0);
  float trunk = 1e3;
  for (int j = -2; j <= 2; j++) {
    float c = ci + float(j);
    vec3 h = hash31(mod(c, N) + 3.17);
    float grove = vnoiseD(mod(c, N) * 0.21, N * 0.21, 8.8).x;   // trees cluster in groves
    if (h.x > 0.25 + 0.85 * grove) continue;
    float cx = (c + 0.5 + (h.y - 0.5) * 0.7) * cw;
    float R = cw * (0.55 + 1.05 * h.z * h.z) * (0.75 + 0.5 * grove);
    float th = R * (0.15 + 0.35 * fract(h.x * 7.13));
    vec2 cc = vec2(cx, ground + th + R * 0.45);
    for (int k = 0; k < 3; k++) {
      vec2 off = k == 0 ? vec2(-0.50, -0.10) : (k == 1 ? vec2(0.52, -0.05) : vec2(0.02, 0.22));
      float rr = R * (k == 2 ? 0.74 : 0.62);
      vec2 d = (lp - cc - off * R) / vec2(rr, rr * 0.74);
      float e = (length(d) - 1.0) * rr * 0.85 + (fn - 0.5) * 0.32 * rr;
      if (e < best) { best = e; bestD = d; }
    }
    float tt = clamp((hy - ground) / (th + R * 0.45), 0.0, 1.0);
    float tx = abs(u - cx - (h.y - 0.5) * 0.004 * tt) - mix(0.0011, 0.0005, tt);
    if (hy < cc.y && hy > ground - 0.003) trunk = min(trunk, tx);
  }
  float canopy = smoothstep(aa, -aa, best);
  float tcov = smoothstep(aa, -aa, trunk);
  float a = max(max(cov, canopy), tcov);
  if (a <= 0.0) return vec4(0.0);

  vec3 c = vec3(0.030, 0.025, 0.066);
  // moonlight catching the blossoms on the upper-right edges
  vec2 nrm = normalize(bestD + vec2(0.0, 0.0001));
  float lit = clamp(dot(nrm, normalize(vec2(0.62, 0.78))), 0.0, 1.0);
  float edge = smoothstep(-0.010, 0.0, best);
  float blossom = canopy * (lit * lit * (0.30 + 0.70 * edge) + 0.30 * smoothstep(0.60, 0.80, fn) * (0.3 + lit));
  c += vec3(0.46, 0.27, 0.40) * blossom * 0.55;
  c += vec3(0.22, 0.13, 0.24) * canopy * 0.10;
  c = mix(c, HAZE, 0.10 + 0.30 * (1.0 - smoothstep(0.0, 0.03, hy)) * (1.0 - canopy * 0.6));
  return vec4(c, a);
}

// near bank with grass and reeds (foreground, parallax 1.0)
vec4 bankLayer(vec2 p) {
  float base = Y0 - (HC + gBob) * KF;
  float y = p.y;
  if (y - base > 0.44) return vec4(0.0);
  float P = uFg.y;
  float u = p.x + uFg.x;
  vec2 g = fbmD(u, P, 0.55, 41.3, 4);
  float ground = base + 0.100 + 0.150 * smoothstep(0.25, 0.80, g.x);
  float a = smoothstep(-gPx, gPx, ground - y);
  float sway = cyc(loopN(7.0));

  // grass blades, two densities
  for (int L = 0; L < 2; L++) {
    float cw0 = L == 0 ? 0.0046 : 0.0029;
    float N = floor(P / cw0 + 0.5);
    float cw = P / N;
    float ci = floor(u / cw);
    for (int j = -2; j <= 2; j++) {
      float c = ci + float(j);
      vec3 h = hash31(mod(c, N) + float(L) * 101.0 + 7.0);
      float bh = mix(0.008, 0.050, h.y * h.y) * (L == 0 ? 1.0 : 0.7);
      float t = (y - ground) / bh;
      if (t < 0.0 || t > 1.0) continue;
      float cx = (c + 0.5 + (h.x - 0.5) * 0.9) * cw;
      float lean = (h.z - 0.5) * 0.9 + 0.12 * sin(sway + u * 9.0 + h.x * 6.0);
      float bx = cx + lean * bh * t * t;
      float w = 0.0017 * (1.0 - t) + gPx * 0.3;
      a = max(a, smoothstep(gPx, -gPx, abs(u - bx) - w));
    }
  }
  // reeds / cattails
  {
    float N = floor(P / 0.055 + 0.5);
    float cw = P / N;
    float ci = floor(u / cw);
    for (int j = -1; j <= 1; j++) {
      float c = ci + float(j);
      vec3 h = hash31(mod(c, N) + 55.5);
      if (h.x > 0.42) continue;
      float rh = 0.07 + 0.11 * h.y;
      float t = (y - ground) / rh;
      if (t < 0.0 || t > 1.0) continue;
      float cx = (c + 0.5 + (h.z - 0.5) * 0.6) * cw;
      float lean = (h.z - 0.5) * 0.35 + 0.05 * sin(sway * 1.0 + h.y * 5.0 + u * 3.0);
      float bx = cx + lean * rh * t * t;
      float w = 0.00095 * (1.0 - 0.6 * t) + gPx * 0.3;
      if (h.x < 0.22 && t > 0.70 && t < 0.88) w += 0.0021 * sin((t - 0.70) / 0.18 * 3.14159);
      a = max(a, smoothstep(gPx, -gPx, abs(u - bx) - w));
    }
  }
  vec3 c = vec3(0.007, 0.008, 0.020);
  return vec4(c, a);
}

// --------------------------------------------------------------- scene
vec4 over(vec4 acc, vec4 L) {   // front-to-back: acc.a holds transmittance
  acc.rgb += acc.a * L.a * L.rgb;
  acc.a *= 1.0 - L.a;
  return acc;
}

// direct view above the waterline.  yShift = per-layer mirror (reflections)
vec3 landAndSky(vec2 p, float refl, float aa, float dy) {
  vec4 acc = vec4(0.0, 0.0, 0.0, 1.0);
  float bT = Y0 - (HC + gBob) * KT;
  float b3 = Y0 - (HC + gBob) * K3;
  float b2 = Y0 - (HC + gBob) * K2;
  float b1 = Y0 - (HC + gBob) * K1;
  // in reflections each layer mirrors about its own base line
  float yT = refl > 0.5 ? 2.0 * bT - p.y + dy : p.y;
  float y3 = refl > 0.5 ? 2.0 * b3 - p.y + dy : p.y;
  float y2 = refl > 0.5 ? 2.0 * b2 - p.y + dy : p.y;
  float y1 = refl > 0.5 ? 2.0 * b1 - p.y + dy : p.y;
  float yS = refl > 0.5 ? 2.0 * Y0 - p.y + dy : p.y;

  acc = over(acc, treeLayer(p.x + uOff.w, yT, bT, aa));
  if (acc.a > 0.002 && y3 - b3 < 0.14) {
    float u = p.x + uOff.z;
    acc = over(acc, shadeRange(vec2(p.x, y3), u, b3, profM3(u), vec3(0.052, 0.050, 0.125), 0.14, 0.10, aa, 3.0));
  }
  if (acc.a > 0.002 && y2 - b2 < 0.20) {
    float u = p.x + uOff.y;
    acc = over(acc, shadeRange(vec2(p.x, y2), u, b2, profM2(u), vec3(0.082, 0.078, 0.185), 0.26, 0.16, aa, 7.0));
  }
  if (acc.a > 0.002 && y1 - b1 < 0.29) {
    float u = p.x + uOff.x;
    vec2 h = profM1(u);
    vec4 L = shadeRange(vec2(p.x, y1), u, b1, h, vec3(0.135, 0.125, 0.265), 0.40, 0.30, aa, 11.0);
    if (L.a > 0.0) {
      // moonlit snow on the high peaks
      float H = b1 + h.x;
      float hgt = smoothstep(0.15, 0.22, h.x);
      float sn = vnoise2(vec2(u * 60.0, y1 * 140.0)) * 0.6 + vnoise2(vec2(u * 150.0, y1 * 300.0)) * 0.4;
      float facing = clamp(0.5 - h.y * 0.9, 0.0, 1.0);
      float snow = hgt * smoothstep(0.035, 0.0, H - y1) * smoothstep(0.42, 0.65, sn + facing * 0.25);
      L.rgb = mix(L.rgb, vec3(0.50, 0.50, 0.70), snow * 0.38);
      if (uWire.y > 0.001 && refl < 0.5) {
        float bx = p.x < uWire.x ? (uWire.x - p.x) / 0.55 : (p.x - uWire.x) / 0.16;
        float band = exp(-bx * bx);
        L.rgb += vec3(0.60, 0.66, 1.0) * wireMesh(vec2(p.x, y1), u, b1, H) * band * uWire.y * 0.20;
      }
    }
    acc = over(acc, L);
  }
  if (acc.a > 0.002) acc.rgb += acc.a * sky(vec2(p.x, yS), refl);
  return acc.rgb;
}

vec3 water(vec2 p) {
  float hcam = HC + gBob;
  float depthY = max(Y0 - p.y, 1e-3);
  float z = hcam / depthY;
  vec2 W = vec2(p.x * z, z);
  float fx = z * gPx;
  float fz = hcam / (depthY * depthY) * gPx;

  vec2 gradD = vec2(0.0);   // broad, calm: bends the mirror image
  vec2 gradS = vec2(0.0);   // fine facets: scatter moonlight into a glitter path
  for (int j = 0; j < ${S.WAVES}; j++) {
    vec4 w = uWave[j];
    float kx = w.x / uTravel;
    float kz = w.y;
    float cpp = abs(kx) * fx + abs(kz) * fz;               // cycles per pixel
    float lod = 1.0 - smoothstep(0.10, 0.35, cpp);
    if (lod <= 0.0) continue;
    float ph = fract(kx * W.x + fract(w.x * uPhase) + kz * W.y - fract(w.z * uPhase) + hash11(float(j) * 7.31));
    vec2 gj = w.w * lod * TAU * vec2(kx, kz) * cos(TAU * ph);
    float fj = float(j) / float(${S.WAVES - 1});
    gradD += gj * mix(1.0, 0.25, fj);
    gradS += gj * mix(0.8, 3.2, fj);
  }
  vec3 n = normalize(vec3(-gradD.x, 1.0, -gradD.y));
  vec3 d = normalize(vec3(p.x, p.y - Y0, 1.0));
  vec3 r = reflect(d, n);
  r.y = max(r.y, 0.0005);
  vec2 sr = vec2(r.x / r.z, r.y / r.z + Y0);
  vec2 delta = sr - vec2(p.x, 2.0 * Y0 - p.y);

  vec3 refl = landAndSky(vec2(p.x + delta.x, p.y), 1.0, gPx * 2.2, delta.y);

  float cosT = max(dot(-d, n), 0.0);
  float fres = 0.02 + 0.98 * pow(clamp(1.0 - cosT, 0.0, 1.0), 5.0);
  float R = clamp(0.58 + 0.55 * fres, 0.0, 1.0);
  float ys = Y0 - hcam * KT;
  float fromShore = ys - p.y;
  vec3 deep = mix(vec3(0.030, 0.034, 0.080), vec3(0.012, 0.016, 0.040), smoothstep(0.0, 0.30, fromShore));
  deep += HAZE * 0.06 * exp(-fromShore * 18.0);
  vec3 c = mix(deep, refl * vec3(0.86, 0.89, 0.98) + SKY_MID * 0.10, R);

  // moon glitter path
  vec3 nS = normalize(vec3(-gradS.x, 1.0, -gradS.y));
  vec3 rS = reflect(d, nS);
  vec3 Ld = normalize(vec3(MOON.x, MOON.y - Y0, 1.0));
  float sp = max(dot(rS, Ld), 0.0);
  float glint = pow(sp, 1500.0) * 1.1 + pow(sp, 220.0) * 0.07 + pow(sp, 40.0) * 0.025;
  c += vec3(1.0, 0.96, 0.88) * glint;
  return c;
}

float shoreMist(vec2 p, float ys) {
  float d = p.y - (ys + 0.006);
  float band = exp(-d * d / (0.020 * 0.020));
  if (band < 0.01) return 0.0;
  float P = uPer.w;
  float N = floor(P * 3.0 + 0.5);
  float u = (p.x + uOff.w) / P * N;
  float n = fbm2p(vec2(u, p.y * 18.0 + 3.0), N);
  return band * smoothstep(0.25, 0.85, n);
}

void main() {
  vec2 q = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  vec2 p = q / uCam.x + vec2(0.0, uCam.y);
  gPx = 1.0 / (uRes.y * uCam.x);
  gBob = uCam.z;

  float ys = Y0 - (HC + gBob) * KT;   // far shoreline / waterline
  vec3 col;
  float edge = (p.y - ys) / gPx;
  if (edge > 1.0) {
    col = landAndSky(p, 0.0, gPx, 0.0);
  } else if (edge < -1.0) {
    col = water(p);
  } else {
    col = mix(water(p), landAndSky(p, 0.0, gPx, 0.0), smoothstep(-1.0, 1.0, edge));
  }

  // low mist clinging to the far shore, lit from the moon's side
  float mist = shoreMist(p, ys);
  vec3 mistCol = mix(HAZE * 1.05, MOONLIT * 0.55, 0.35 * exp(-abs(p.x - MOON.x) * 2.5));
  col = mix(col, mistCol, mist * 0.42);
  // a thin bright line where the lake meets the shore
  col += HAZE * 0.10 * exp(-abs(p.y - ys) / (gPx * 1.5));

  // foreground bank
  vec4 bank = bankLayer(p);
  col = mix(col, bank.rgb, bank.a);

  // grade: lifted blue shadows, soft shoulder for the moon
  col = col + vec3(0.004, 0.005, 0.012) * (1.0 - col);
  col = mix(col, 0.72 + 0.28 * (1.0 - exp(-(col - 0.72) / 0.28)), step(0.72, col));

  // vignette
  float v = length(q * vec2(0.82, 1.0));
  col *= mix(1.0, 0.62, smoothstep(0.35, 1.05, v));

  // fine grain + dither (kills banding in the dark gradients)
  vec2 fc = gl_FragCoord.xy + fract(uFrame * 0.6180339) * 113.0;
  float grain = hash12(fc) + hash12(fc + 17.3) - 1.0;
  col += grain * (1.2 / 255.0 + col * 0.018);

  gl_FragColor = vec4(max(col, 0.0) * uFade, 1.0);
}
`;

  const SPRITE_VS = `
attribute vec2 aPos;
attribute vec2 aUv;
attribute vec4 aCol;
attribute vec2 aPar;
varying vec2 vUv;
varying vec4 vCol;
varying vec2 vPar;
void main() {
  vUv = aUv; vCol = aCol; vPar = aPar;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

  const SPRITE_FS = `
precision mediump float;
uniform vec2 uRes;
uniform float uFade;
varying vec2 vUv;
varying vec4 vCol;
varying vec2 vPar;   // type (0 glow, 1 bokeh, 2 petal), shape parameter
void main() {
  vec2 q = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float vig = mix(1.0, 0.62, smoothstep(0.35, 1.05, length(q * vec2(0.82, 1.0))));
  float r2 = dot(vUv, vUv);
  vec4 o = vec4(0.0);
  if (vPar.x < 0.5) {
    // firefly: bright core + soft warm halo, fades to 0 at quad edge
    float k = vPar.y;
    float I = exp(-r2 / (k * k)) + 0.30 * exp(-r2 * 10.0) + 0.09 * exp(-r2 * 3.0);
    I *= 1.0 - smoothstep(0.7, 1.0, r2);
    vec3 c = mix(vCol.rgb, vec3(1.0, 0.97, 0.86), exp(-r2 / (k * k * 0.4)) * 0.6);
    o = vec4(c * I * vCol.a, 0.0);
  } else if (vPar.x < 1.5) {
    // out-of-focus firefly very close to the lens
    float r = sqrt(r2);
    float soft = vPar.y;
    float disc = 1.0 - smoothstep(1.0 - soft, 1.0, r);
    float I = disc * (0.75 + 0.25 * smoothstep(0.3, 0.95, r));
    o = vec4(vCol.rgb * I * vCol.a, 0.0);
  } else {
    // cherry blossom petal (uv.y along the petal)
    vec2 uv = vUv;
    // broad cherry petal, narrow at the base (uv.y=-1), notched at the tip
    float yy = uv.y * 0.5 + 0.5;
    float w = 0.92 * sqrt(max(0.0, 1.0 - uv.y * uv.y)) * mix(0.45, 1.0, smoothstep(0.0, 0.7, yy));
    float d = abs(uv.x) - w;
    float notch = 0.30 - length(vec2(uv.x * 1.6, uv.y - 1.08));
    d = max(d, notch);
    float soft = vPar.y;
    float a = 1.0 - smoothstep(-soft, soft, d);
    vec3 base = vCol.rgb * vec3(1.0, 0.82, 0.92);
    vec3 tip = vCol.rgb * 1.18 + vec3(0.04);
    vec3 c = mix(base, tip, smoothstep(-0.6, 0.9, uv.y)) * (0.92 + 0.12 * uv.x);
    a *= vCol.a;
    o = vec4(c * a, a);
  }
  gl_FragColor = o * vig * uFade;
}
`;

  window.WMC.SHADERS = { SCENE_VS, SCENE_FS, SPRITE_VS, SPRITE_FS };
})();
