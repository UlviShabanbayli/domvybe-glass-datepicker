// DV64 GLASS: one WebGL2 canvas behind the DOM. Every frame is one full-screen pass that draws, back to front:
//   1. the sunset photo in soft focus (sharp + blurred mix), graded toward the board's violet sky / plum floor, drifting
//   2. up to four glass month panes. Each pane is a rounded slab seen through a projective homography (the same matrix
//      the DOM pane uses for its CSS matrix3d), so the glass and the numbers stay locked together in 3D. Glass = heavy
//      frost of the photo, a bevel that refracts a sharper copy of the photo with chromatic dispersion, a rim light, a
//      pointer light, a slow light sweep and a ripple that runs through it when a day is picked.
//   3. glass tiles (bevelled squares) inside each pane, hover / press states
//   4. the molten liquid: a smooth union of round-cone segments (rows of the range, S-curves where it wraps to the next
//      week, the thread that feeds it from the tube) clipped by the flow front G, lifted into a height field for real
//      normals; amber absorption, hot core, flow streaks that travel along the path, speculars, and glow on the glass
//   5. violet glass end tiles with bloom (on top of the liquid)
//   6. the glass tube reservoir (screen space, fixed beside the front slot): a calm sloshing molten level (no bubbles)
// Segment data lives in a small RGBA32F texture (2 texels per segment, one row per pane).
// Pre-pass (once per image): two separable Gaussian blurs into half- and eighth-size textures.

const MAXP = 4, MAXSEG = 80;
// the tube is a calm gauge: no bubbles (they read as droplets)

const VS = `#version 300 es
in vec2 p; void main(){ gl_Position = vec4(p, 0., 1.); }`;

const BLUR = `#version 300 es
precision highp float;
uniform sampler2D uSrc; uniform vec2 uDir; uniform vec2 uDst; uniform float uSigma;
out vec4 o;
void main(){
  vec2 uv = gl_FragCoord.xy / uDst;
  vec3 acc = vec3(0.); float wsum = 0.;
  for (int i = -12; i <= 12; i++) {
    float x = float(i); float w = exp(-0.5 * x * x / (uSigma * uSigma));
    acc += texture(uSrc, uv + uDir * x).rgb * w; wsum += w;
  }
  o = vec4(acc / wsum, 1.);
}`;

const COPY = `#version 300 es
precision highp float;
uniform sampler2D uSrc; uniform vec2 uRes;
out vec4 o;
void main(){ o = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0); }`;

const FS = `#version 300 es
precision highp float;
precision highp sampler2D;
#define MAXP ${MAXP}
#define MAXSEG ${MAXSEG}
uniform vec2 uRes; uniform float uDpr; uniform float uTime; uniform vec2 uStage;
uniform sampler2D uBg, uBgM, uBgH, uSeg;
uniform vec4 uBgXf;   // stage css px -> photo uv
uniform vec4 uDrift;  // drift xy, zoom z, sharp mix w
uniform vec4 uPtr;    // pointer xy (css), on, unused
uniform int uN; uniform int uFront;
uniform mat3 uInv[MAXP]; uniform mat3 uFwd[MAXP];
uniform vec4 uSize[MAXP];  // w, h, corner radius, alpha
uniform vec4 uGridA[MAXP]; // grid x0, y0, cell, gap
uniform vec4 uGridB[MAXP]; // lead, days, rows, hover idx
uniform vec4 uSel[MAXP];   // start idx, end idx, ring idx, press idx
uniform vec4 uLiq[MAXP];   // seg count, flow front G, frontness, band radius
uniform vec4 uHead[MAXP];  // head x, y, r, on
uniform vec4 uBox[MAXP];   // liquid bbox (local)
uniform vec4 uRip;         // ripple x, y (front pane local), age s, on
uniform vec4 uTube;        // x, y, w, h (stage css)
uniform vec4 uTubeL;       // level, tilt, wave, alpha
uniform vec4 uFx;          // sweep phase, glow pulse, unused, layout scale
out vec4 o;

float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y); }
float smin(float a, float b, float k){ float h = max(k - abs(a - b), 0.) / k; return min(a, b) - h * h * k * 0.25; }
float sdRR(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - r; }
vec3 sdgRR(vec2 p, vec2 b, float r){
  vec2 sg = sign(p) + vec2(equal(p, vec2(0.))); vec2 q = abs(p) - b + r;
  if (q.x > 0. && q.y > 0.) { float l = length(q); return vec3(l - r, q / l * sg); }
  return q.x > q.y ? vec3(q.x - r, sg.x, 0.) : vec3(q.y - r, 0., sg.y);
}
vec2 proj(mat3 m, vec2 p){ vec3 q = m * vec3(p, 1.); return q.xy / q.z; }

vec2 uvOf(vec2 p){ vec2 uv = p * uBgXf.xy + uBgXf.zw; return (uv - 0.5) * uDrift.z + 0.5 + uDrift.xy; }
vec3 grade(vec3 c, vec2 p){
  vec2 pn = p / uStage;
  c *= c * 0.06 + 0.94;
  // violet sky at the top, plum floor at the bottom (the board's palette), a warm band behind the panes, vignette
  c = mix(c, c * vec3(0.74, 0.66, 1.18) + vec3(0.03, 0.02, 0.08), smoothstep(0.5, 0.0, pn.y) * 0.75);
  c += vec3(0.10, 0.04, 0.0) * exp(-pow((pn.y - 0.56) / 0.12, 2.)) * (1. - 0.6 * abs(pn.x - 0.5));
  float fl = smoothstep(0.55, 1.02, pn.y);
  c = mix(c, c * vec3(0.46, 0.26, 0.46) + vec3(0.03, 0.01, 0.035), fl * 0.9);
  vec2 v = (pn - vec2(0.5, 0.46)) * vec2(1.05, 1.15);
  c *= 1.0 - 0.45 * smoothstep(0.25, 0.95, length(v));
  return c;
}
vec3 photo(vec2 p){ vec2 uv = uvOf(p); return grade(mix(texture(uBg, uv).rgb, texture(uBgM, uv).rgb, uDrift.w), p); }
vec3 photoM(vec2 p){ return grade(texture(uBgM, uvOf(p)).rgb, p); }
vec3 photoH(vec2 p){ return grade(texture(uBgH, uvOf(p)).rgb, p); }

// ---- liquid: smooth union of round cones (one evaluation; the caller asks for neighbours only near the surface)
float gConf = 1.;
float liqD(int i, vec2 q, bool wantS, out float sOut){
  int n = int(uLiq[i].x); float G = uLiq[i].y; float fr = uLiq[i].z; float Rb = uLiq[i].w;
  float k = Rb * 0.62;
  float d = 1e5; float sw = 0., ss = 0.;
  for (int j = 0; j < MAXSEG; j++) {
    if (j >= n) break;
    vec4 A = texelFetch(uSeg, ivec2(2 * j, i), 0);
    if (G <= A.w) continue;
    vec4 B = texelFetch(uSeg, ivec2(2 * j + 1, i), 0);
    float t = clamp((G - A.w) / max(B.w - A.w, 1e-4), 0., 1.);
    vec2 b = mix(A.xy, B.xy, t); float ra = A.z, rb = mix(A.z, B.z, t);
    if (B.w <= 0.0001) { ra *= fr; rb *= fr; }
    vec2 ba = b - A.xy; float bb = dot(ba, ba);
    vec2 pa = q - A.xy; float h = bb > 0.01 ? clamp(dot(pa, ba) / bb, 0., 1.) : 0.;
    float r0 = bb > 0.01 ? mix(ra, rb, h) : rb;
    float d0 = length(pa - ba * h) - r0;
    if (wantS) {
      float wj = exp(-clamp(d0, -Rb, 4. * Rb) / (0.3 * Rb)) * (B.w <= 0.0001 ? 0. : 1.);
      ss += wj * mix(A.w, mix(A.w, B.w, t), h); sw += wj;
    }
    d = smin(d, d0, k);
  }
  if (uHead[i].w > 0.5) d = smin(d, length(q - uHead[i].xy) - uHead[i].z, k);
  sOut = ss / max(sw, 1e-5);
  if (wantS) gConf = smoothstep(1e-4, 3e-2, sw);       // how well the flow coordinate is known here
  return d;
}
vec3 liq3(int i, vec2 q, float e, out float sOut){
  float d = liqD(i, q, true, sOut), dummy;
  if (d > 2.5) return vec3(d);
  return vec3(d, liqD(i, q + vec2(e, 0.), false, dummy), liqD(i, q + vec2(0., e), false, dummy));
}
float hgt(float d, float R){ float t = clamp(-d / R, 0., 1.); float x = 1. - t; return R * sqrt(max(1. - x * x, 0.)); }

const vec3 L1 = vec3(-0.5, -0.72, 0.48);

vec3 molten(float th, float fl, float s){
  vec3 deep = vec3(0.60, 0.16, 0.05), body = vec3(0.98, 0.48, 0.14), hot = vec3(1.0, 0.88, 0.60);
  vec3 c = mix(deep, body, smoothstep(0.0, 0.55, th));
  c = mix(c, hot, smoothstep(0.42, 1.0, th) * (0.35 + 0.65 * fl));
  return c;
}

// liquid layer of pane i at local q (masked by m); writes over col
void liquid(int i, vec2 p, vec2 q, float m, inout vec3 col){
  vec4 bx = uBox[i]; float Rb = uLiq[i].w;
  float Rg = uGridA[i].z * 0.3;
  float pad = uGridA[i].z * 1.25;
  float bd = length(max(max(bx.xy - q, q - bx.zw), 0.));
  if (uLiq[i].x < 0.5 || bd > pad) return;
  float gfade = 1. - smoothstep(pad * 0.45, pad, bd);
  float s; vec3 D = liq3(i, q, 0.75, s);
  float d0 = D.x;
  // breathing surface + flow ripples travelling along the path
  // a long, shallow swell travelling with the flow (no beads: the width stays even)
  float breathe = sin(s * 1.1 - uTime * 1.3);
  d0 -= breathe * 0.35 * uFx.w; D.yz -= breathe * 0.35 * uFx.w;
  float h0 = hgt(d0, Rb), hx = hgt(D.y, Rb), hy = hgt(D.z, Rb);
  vec3 n = normalize(vec3(-(hx - h0) / 0.75, -(hy - h0) / 0.75, 1.0));
  float aa = max(fwidth(d0), 0.35);
  float cov = clamp(0.5 - d0 / aa, 0., 1.) * m;
  float th = h0 / Rb;
  float fl = noise(vec2(s * 2.2 - uTime * 1.25, d0 / Rb * 1.8 + s * 0.6));
  fl = 0.55 * fl + 0.45 * noise(vec2(s * 5.3 - uTime * 2.1, d0 / Rb * 3.4 - 1.7));
  fl = mix(0.55, fl, gConf);                           // the feed thread far from the ribbon: an even, calm stream
  vec3 lc = molten(th, fl, s);
  // what is behind, refracted and absorbed by the amber
  vec2 off = proj(uFwd[i], q - n.xy * 16. * th) - proj(uFwd[i], q);
  vec3 behind = photoM(p + off);
  lc = lc * (0.62 + 0.5 * fl * th) + behind * vec3(0.95, 0.55, 0.30) * 0.30;
  // hot filaments travelling along the flow
  float fil = smoothstep(0.55, 0.92, noise(vec2(s * 1.5 - uTime * 1.4, d0 / Rb * 3.2 + 3.)));
  lc += fil * gConf * th * vec3(1.0, 0.84, 0.58) * 0.32;
  // light
  vec3 r = vec3(2. * n.z * n.x, 2. * n.z * n.y, 2. * n.z * n.z - 1.);
  float sp = max(dot(r, normalize(L1)), 0.);
  lc += pow(sp, 90.) * 1.6 * vec3(1.0, 0.97, 0.92) + pow(sp, 10.) * 0.12;
  float fres = pow(1. - n.z, 2.0);
  lc = mix(lc, lc * vec3(0.9, 0.55, 0.38), fres * 0.45);
  lc += exp(-abs(d0 + 1.2) / 1.1) * vec3(1.0, 0.82, 0.55) * 0.35;           // bright meniscus edge
  if (uPtr.z > 0.5) {
    vec2 lp = proj(uInv[i], uPtr.xy);
    vec3 L2 = normalize(vec3((lp - q) / 160., 0.9));
    lc += pow(max(dot(r, L2), 0.), 50.) * 0.55 * vec3(1.0, 0.92, 0.8);
  }
  float alpha = 0.5 + 0.5 * smoothstep(0.0, 0.6, th);
  col = mix(col, lc, cov * alpha);
  // glow thrown onto the glass around the liquid
  float glow = exp(-max(d0, 0.) / (Rg * 0.7)) * 0.42 + exp(-max(d0, 0.) / (Rg * 1.7)) * 0.2;
  glow *= (1. - cov) * m * gfade;
  col += glow * vec3(1.0, 0.50, 0.18) * uFx.y;
}

// violet end tile (glass, tinted) + bloom
void endTile(int i, vec2 q, float idx, float strength, float m, inout vec3 col){
  if (idx < 0.) return;
  float cs = uGridA[i].z, gp = uGridA[i].w, sc = uFx.w;
  vec2 cen = uGridA[i].xy + vec2(mod(idx, 7.), floor(idx / 7.)) * (cs + gp) + cs * 0.5;
  vec2 cl = q - cen;
  if (abs(cl.x) > cs * 1.6 || abs(cl.y) > cs * 1.6) return;
  float td = sdRR(cl, vec2(cs * 0.5), 11. * sc);
  float aa = max(fwidth(td), 0.35);
  float pulse = 0.88 + 0.12 * sin(uTime * 1.9);
  // bloom
  col += exp(-max(td, 0.) / (9. * sc)) * step(0., td) * vec3(0.42, 0.34, 1.0) * 0.55 * strength * pulse * m;
  float cov = clamp(0.5 - td / aa, 0., 1.) * m;
  if (cov <= 0.) return;
  float yy = cl.y / cs + 0.5;
  vec3 c = mix(vec3(0.58, 0.52, 1.0), vec3(0.27, 0.20, 0.84), smoothstep(0.0, 1.0, yy));
  float e = -td;
  c += exp(-e / (4.5 * sc)) * vec3(0.62, 0.58, 1.0) * 0.7;                       // inner edge glow
  c += smoothstep(0.55, 0.0, length((cl / cs) - vec2(-0.18, -0.26))) * 0.22;        // soft top-left sheen
  c += exp(-abs(td + 0.7) / (0.8 * sc)) * vec3(0.92, 0.9, 1.0) * 0.55;              // crisp rim
  c *= pulse * 0.1 + 0.92;
  col = mix(col, c, cov * (0.93 * strength));
}

void ring(int i, vec2 q, float idx, float m, inout vec3 col){
  if (idx < 0.) return;
  float cs = uGridA[i].z, gp = uGridA[i].w, sc = uFx.w;
  vec2 cen = uGridA[i].xy + vec2(mod(idx, 7.), floor(idx / 7.)) * (cs + gp) + cs * 0.5;
  vec2 cl = q - cen;
  if (abs(cl.x) > cs || abs(cl.y) > cs) return;
  float td = sdRR(cl, vec2(cs * 0.5), 11. * sc);
  col += exp(-abs(td + 1.0) / (1.2 * sc)) * vec3(0.75, 0.70, 1.0) * 0.7 * m;
  col += exp(-max(td, 0.) / (7. * sc)) * step(0., td) * vec3(0.45, 0.38, 1.0) * 0.3 * m;
  col = mix(col, col * 0.8 + vec3(0.30, 0.25, 0.75) * 0.25, clamp(-td, 0., 1.) * m * 0.6);
}

// glass slab + tiles of pane i; returns pane coverage
float pane(int i, vec2 p, vec2 q, inout vec3 col){
  vec2 S = uSize[i].xy; float R = uSize[i].z, A = uSize[i].w, sc = uFx.w;
  vec2 c = q - S * 0.5;
  vec3 dg = sdgRR(c, S * 0.5, R);
  float d = dg.x;
  float aa = max(fwidth(d), 0.35);
  if (d > 0.) {
    // halo of light round the slab, soft contact shadow below it
    float ds = sdRR(c - vec2(0., 24. * sc), S * 0.5, R);
    col *= 1.0 - 0.28 * A * exp(-max(ds, 0.) / (34. * sc));
    col += A * (exp(-d / (2.4 * sc)) * 0.20 + exp(-d / (30. * sc)) * 0.05) * vec3(1.0, 0.86, 0.80);
  }
  float cov = clamp(0.5 - d / aa, 0., 1.) * A;
  if (cov <= 0.) return 0.;
  float e = -d, bw = 17. * sc;
  vec2 g = dg.yz;
  float x = clamp(1. - e / bw, 0., 1.);
  // ripple from a pick
  vec2 rip = vec2(0.);
  float rr = 0.;
  if (uRip.w > 0.5 && i == uFront) {
    float rd = length(q - uRip.xy), front = uRip.z * 620. * sc;
    float amp = exp(-uRip.z * 2.2) * smoothstep(0., 0.05, uRip.z);
    rr = amp * exp(-pow((rd - front) / (16. * sc), 2.)) * sin((rd - front) / (5. * sc));
    rip = normalize(q - uRip.xy + 1e-3) * rr * 9. * sc;
  }
  // refraction at the bevel (+ chromatic dispersion), frost inside
  float bend = x * x * x * 34. * sc;
  vec2 o0 = proj(uFwd[i], q - g * bend + rip) - p;
  vec2 o1 = o0 * 1.12, o2 = o0 * 1.24;
  vec3 frost = photoH(p + o0 * 0.5);
  vec3 img = frost;
  if (x > 0.02) {
    vec3 rim = vec3(texture(uBgM, uvOf(p + o0)).r, texture(uBgM, uvOf(p + o1)).g, texture(uBgM, uvOf(p + o2)).b);
    img = mix(frost, grade(rim, p), smoothstep(0.05, 0.9, x));
  }
  float fn = hash(floor(q * 1.5));
  vec3 gc = img * 0.80 + vec3(0.075, 0.062, 0.085) + (fn - 0.5) * 0.010;
  gc += 0.035 * (1. - q.y / S.y);
  // rim light: bright top-left, warm sunset light on the right edge, crisp outer line, inner glow
  float lit = max(dot(g, normalize(vec2(-0.55, -0.83))), 0.);
  gc += pow(x, 2.4) * (0.07 + 0.42 * lit) * vec3(1.0, 0.97, 0.96);
  gc += pow(x, 3.0) * 0.30 * max(dot(g, normalize(vec2(1.0, 0.25))), 0.) * vec3(1.0, 0.72, 0.52);
  gc += exp(-e / (0.85 * sc)) * (0.30 + 0.45 * lit);
  gc += exp(-e / (7. * sc)) * 0.035;
  if (uPtr.z > 0.5) { float pd = length(p - uPtr.xy); gc += exp(-pd / (260. * sc)) * pow(x, 1.6) * 0.30 * vec3(1.0, 0.95, 0.9); }
  gc += rr * 0.16;
  // slow diagonal light sweep
  float w = (q.x / S.x) * 0.8 + (q.y / S.y) * 0.45;
  gc += exp(-pow((w - uFx.x) * 4.2, 2.)) * 0.055 * vec3(1.0, 0.96, 0.92);
  // tiles
  float cs = uGridA[i].z, gp = uGridA[i].w;
  vec2 gq = q - uGridA[i].xy; vec2 ci = floor(gq / (cs + gp));
  if (ci.x >= 0. && ci.x < 7. && ci.y >= 0. && ci.y < uGridB[i].z) {
    vec2 cl = gq - ci * (cs + gp) - cs * 0.5;
    float idx = ci.y * 7. + ci.x;
    vec3 tdg = sdgRR(cl, vec2(cs * 0.5), 10. * sc);
    float td = tdg.x;
    float ta = max(fwidth(td), 0.35);
    bool day = idx >= uGridB[i].x && idx < uGridB[i].x + uGridB[i].y;
    float hov = idx == uGridB[i].w ? 1. : 0.;
    float prs = idx == uSel[i].w ? 1. : 0.;
    float tin = clamp(0.5 - td / ta, 0., 1.);
    float te = clamp(1. + td / (3.2 * sc), 0., 1.);
    vec2 tg = tdg.yz;
    float tlit = dot(tg, normalize(vec2(-0.5, -0.86)));
    float fill = (day ? 0.045 : 0.018) + hov * 0.075 - prs * 0.05;
    gc += tin * fill;
    gc += tin * te * (0.10 * max(tlit, 0.) - 0.05 * max(-tlit, 0.)) * (day ? 1. : 0.5);
    gc += exp(-abs(td + 0.5) / (0.55 * sc + 0.25)) * (day ? 0.16 : 0.085) * (1. + hov * 1.2);
    gc -= exp(-max(td, 0.) / (2.5 * sc)) * step(0., td) * 0.03;                     // tiny contact shade
  }
  col = mix(col, gc, cov);
  return cov / max(A, 1e-3);
}

void main(){
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uDpr;
  vec3 col = photo(p);
  for (int i = 0; i < MAXP; i++) {
    if (i >= uN) break;
    vec2 q = proj(uInv[i], p);
    float m = pane(i, p, q, col);
    float lm = i == uFront ? 1. : m * uSize[i].w;
    liquid(i, p, q, lm, col);
    endTile(i, q, uSel[i].x, 1., m * uSize[i].w, col);
    endTile(i, q, uSel[i].y, 1., m * uSize[i].w, col);
    ring(i, q, uSel[i].z, m * uSize[i].w, col);
  }
  // the tube
  if (uTubeL.w > 0.01) {
    vec2 TS = uTube.zw; vec2 tq = p - uTube.xy; float tr = TS.x * 0.5, sc = uFx.w;
    float td = sdRR(tq - TS * 0.5, TS * 0.5, tr);
    float aa = max(fwidth(td), 0.35);
    if (td > 0.) col += exp(-td / (2.2 * sc)) * 0.16 * uTubeL.w * vec3(1.0, 0.86, 0.8);
    float cov = clamp(0.5 - td / aa, 0., 1.) * uTubeL.w;
    if (cov > 0.) {
      float xn = (tq.x - tr) / tr;
      float cyl = sqrt(max(1. - xn * xn, 0.));
      vec3 g = mix(photoM(p + vec2(-xn * 7. * sc, 0.)), col, 0.55) * (0.8 + 0.2 * cyl);
      float wall = 3.2 * sc;
      float id = sdRR(tq - TS * 0.5, TS * 0.5 - wall, tr - wall);
      // liquid
      float lvl = uTubeL.x;
      float surf = (TS.y - wall) - (TS.y - 2. * wall) * lvl + uTubeL.y * (tq.x - tr) + uTubeL.z * sin(tq.x * 0.32 / sc + uTime * 2.8);
      surf -= 2.6 * sc * pow(abs(xn), 4.);                                       // meniscus climbs the wall
      float lin = clamp(0.5 - id / max(fwidth(id), 0.35), 0., 1.) * clamp((tq.y - surf) / 1.2 + 0.5, 0., 1.);
      if (lin > 0.) {
        float fl = noise(vec2(xn * 1.6, tq.y * 0.05 / sc + uTime * 0.55)) * 0.6 + noise(vec2(xn * 3.1 + 4., tq.y * 0.11 / sc + uTime * 1.2)) * 0.4;
        vec3 lc = molten(cyl * 0.95, fl, 0.);
        lc += exp(-abs(tq.y - surf) / (1.4 * sc)) * vec3(1.0, 0.92, 0.75) * 0.55;    // lit surface line
        lc *= 0.82 + 0.18 * cyl;
        g = mix(g, lc, lin);
      }
      // glass: edges, inner wall line, vertical speculars, lip highlight
      g += pow(1. - cyl, 3.) * 0.30;
      g += exp(-abs(id + 0.4) / (0.7 * sc)) * 0.18;
      g += exp(-pow((xn + 0.46) / 0.13, 2.)) * 0.30 * vec3(1.0, 0.98, 0.95);
      g += exp(-pow((xn - 0.6) / 0.07, 2.)) * 0.13;
      g += exp(td / (0.8 * sc)) * 0.35;
      col = mix(col, g, cov);
    }
  }
  col += (hash(p * uDpr + fract(uTime) * 61.) - 0.5) / 255. * 1.5;          // dither
  o = vec4(col, 1.);
}`;

const UNIF = ['uRes', 'uDpr', 'uTime', 'uStage', 'uBg', 'uBgM', 'uBgH', 'uSeg', 'uBgXf', 'uDrift', 'uPtr', 'uN', 'uFront',
  'uRip', 'uTube', 'uTubeL', 'uFx'];
const ARR = ['uInv', 'uFwd', 'uSize', 'uGridA', 'uGridB', 'uSel', 'uLiq', 'uHead', 'uBox'];

export class Glass {
  constructor(canvas) {
    this.canvas = canvas;
    this.ok = false;
    this.segData = new Float32Array(MAXSEG * 2 * MAXP * 4);
    this.MAXSEG = MAXSEG; this.MAXP = MAXP; this.bubbles = false;
    try { this._init(); } catch (e) { console.warn('[dv64] WebGL2 unavailable:', e.message); this.ok = false; }
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.ok = false; this.lost = true; });
    canvas.addEventListener('webglcontextrestored', () => { this._init(); if (this.img) this.setImage(this.img); this.lost = false; });
  }

  _init() {
    const gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('no webgl2');
    this.gl = gl;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = (fs) => { const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
      gl.bindAttribLocation(p, 0, 'p'); gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)); return p; };
    this.pMain = prog(FS); this.pBlur = prog(BLUR); this.pCopy = prog(COPY);
    this.uc = { uSrc: gl.getUniformLocation(this.pCopy, 'uSrc') };
    this.bgFbo = gl.createFramebuffer(); this.bgTex = null; this.bgDirty = true;
    const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.u = {};
    for (const n of UNIF) this.u[n] = gl.getUniformLocation(this.pMain, n);
    for (const n of ARR) this.u[n] = gl.getUniformLocation(this.pMain, n + '[0]');
    this.ub = { uSrc: gl.getUniformLocation(this.pBlur, 'uSrc'), uDir: gl.getUniformLocation(this.pBlur, 'uDir'), uDst: gl.getUniformLocation(this.pBlur, 'uDst'), uSigma: gl.getUniformLocation(this.pBlur, 'uSigma') };
    const tex = (w, h, data, fmt = gl.RGBA8, f = gl.LINEAR) => {
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
      if (fmt === gl.RGBA32F) gl.texImage2D(gl.TEXTURE_2D, 0, fmt, w, h, 0, gl.RGBA, gl.FLOAT, data);
      else gl.texImage2D(gl.TEXTURE_2D, 0, fmt, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      return t; };
    this._tex = tex;
    const px = new Uint8Array([120, 60, 90, 255]);
    this.tBg = tex(1, 1, px); this.tM = tex(1, 1, px); this.tH = tex(1, 1, px);
    this.tSeg = tex(MAXSEG * 2, MAXP, this.segData, gl.RGBA32F, gl.NEAREST);
    gl.useProgram(this.pMain);
    gl.uniform1i(this.u.uBg, 0); gl.uniform1i(this.u.uBgM, 1); gl.uniform1i(this.u.uBgH, 2); gl.uniform1i(this.u.uSeg, 3);
    this.ok = true;
  }

  // the photo + its two blurred copies (half size σ≈5 px, eighth size σ≈32 px of the source)
  setImage(img) {
    this.img = img; const gl = this.gl; if (!gl) return;
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    this.iw = iw; this.ih = ih;
    gl.bindTexture(gl.TEXTURE_2D, this.tBg);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
    const fbo = gl.createFramebuffer();
    const pass = (src, sw, sh, dst, dw, dh, dir, sigma) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dst, 0);
      gl.viewport(0, 0, dw, dh);
      gl.useProgram(this.pBlur);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src);
      gl.uniform1i(this.ub.uSrc, 0); gl.uniform2f(this.ub.uDst, dw, dh);
      gl.uniform2f(this.ub.uDir, dir[0] / dw, dir[1] / dh); gl.uniform1f(this.ub.uSigma, sigma);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const mw = Math.max(2, Math.round(iw / 2)), mh = Math.max(2, Math.round(ih / 2));
    const hw = Math.max(2, Math.round(iw / 8)), hh = Math.max(2, Math.round(ih / 8));
    const a = this._tex(mw, mh, null), tM = this._tex(mw, mh, null);
    pass(this.tBg, iw, ih, a, mw, mh, [1, 0], 2.6); pass(a, mw, mh, tM, mw, mh, [0, 1], 2.6);
    const b = this._tex(hw, hh, null), c = this._tex(hw, hh, null), tH = this._tex(hw, hh, null);
    pass(tM, mw, mh, b, hw, hh, [1, 0], 3.2); pass(b, hw, hh, c, hw, hh, [0, 1], 3.2);
    pass(c, hw, hh, b, hw, hh, [1, 0], 2.4); pass(b, hw, hh, tH, hw, hh, [0, 1], 2.4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteTexture(a); gl.deleteTexture(b); gl.deleteTexture(c); gl.deleteFramebuffer(fbo);
    gl.deleteTexture(this.tM); gl.deleteTexture(this.tH);
    this.tM = tM; this.tH = tH;
    gl.useProgram(this.pMain);
    this.hasImage = true; this.bgDirty = true;
  }

  resize(cssW, cssH, dpr) {
    const W = Math.max(1, Math.round(cssW * dpr)), H = Math.max(1, Math.round(cssH * dpr));
    this.cssW = cssW; this.cssH = cssH; this.dpr = W / cssW;
    if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
    this.bgDirty = true;
  }

  uploadSegments() {
    const gl = this.gl; if (!gl) return;
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.tSeg);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, MAXSEG * 2, MAXP, gl.RGBA, gl.FLOAT, this.segData);
  }

  // f: frame description built by the app (see app.js render())
  // one reduced-resolution target, sized for the largest scale (0.8); smaller scales render into its corner
  _ensureLow(W, H) {
    const gl = this.gl, mw = Math.ceil(W * 0.8), mh = Math.ceil(H * 0.8);
    if (this.lowTex && this.lowW === mw && this.lowH === mh) return;
    if (this.lowTex) gl.deleteTexture(this.lowTex);
    this.lowTex = this._tex(mw, mh, null, gl.RGBA8, gl.LINEAR); this.lowW = mw; this.lowH = mh;
    if (!this.lowFbo) this.lowFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.lowFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.lowTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  _uniforms(f, bgOnly, k = 1) {
    const gl = this.gl, u = this.u;
    gl.useProgram(this.pMain);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tBg);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.tM);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.tH);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.tSeg);
    gl.uniform2f(u.uRes, this.canvas.width * k, this.canvas.height * k); gl.uniform1f(u.uDpr, this.dpr * k);
    gl.uniform2f(u.uStage, this.cssW, this.cssH);
    gl.uniform1f(u.uTime, f.time);
    gl.uniform4fv(u.uBgXf, f.bgXf); gl.uniform4fv(u.uDrift, f.drift); gl.uniform4fv(u.uPtr, f.ptr);
    gl.uniform1i(u.uN, bgOnly ? 0 : f.n); gl.uniform1i(u.uFront, f.front);
    gl.uniformMatrix3fv(u.uInv, false, f.inv); gl.uniformMatrix3fv(u.uFwd, false, f.fwd);
    for (const k of ['uSize', 'uGridA', 'uGridB', 'uSel', 'uLiq', 'uHead', 'uBox']) gl.uniform4fv(u[k], f[k]);
    gl.uniform4fv(u.uRip, f.rip); gl.uniform4fv(u.uTube, f.tube); gl.uniform4fv(u.uTubeL, bgOnly ? [0, 0, 0, 0] : f.tubeL); gl.uniform4fv(u.uFx, f.fx);
  }

  // f: frame description built by the app (see app.js). The photo backdrop is static: it is rendered once into a
  // texture; every frame copies it (one fetch per pixel) and shades the glass only inside f.box (css px, the picker).
  draw(f) {
    const gl = this.gl; if (!this.ok || !gl || this.lost) return;
    const W = this.canvas.width, H = this.canvas.height;
    if (this.bgDirty || !this.bgTex || this.bgW !== W || this.bgH !== H) {
      if (this.bgTex) gl.deleteTexture(this.bgTex);
      this.bgTex = this._tex(W, H, null, gl.RGBA8, gl.NEAREST); this.bgW = W; this.bgH = H;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bgFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.bgTex, 0);
      gl.viewport(0, 0, W, H);
      this._uniforms(f, true);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.bgDirty = false;
      this._ensureLow(W, H);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(this.pCopy);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.bgTex); gl.uniform1i(this.uc.uSrc, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const d = this.dpr, b = f.box;
    const k = f.scale || 1;
    if (k >= 0.999) {
      const x0 = Math.max(0, Math.floor(b[0] * d)), x1 = Math.min(W, Math.ceil(b[2] * d));
      const y0 = Math.max(0, Math.floor(H - b[3] * d)), y1 = Math.min(H, Math.ceil(H - b[1] * d));
      if (x1 <= x0 || y1 <= y0) return;
      gl.enable(gl.SCISSOR_TEST); gl.scissor(x0, y0, x1 - x0, y1 - y0);
      this._uniforms(f, false);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.disable(gl.SCISSOR_TEST);
      return;
    }
    // while the panes swing: shade the picker at reduced resolution and stretch it over the box (motion hides it)
    const lw = Math.ceil(W * k), lh = Math.ceil(H * k);
    this._ensureLow(W, H);
    const dl = d * k;
    const x0 = Math.max(0, Math.floor(b[0] * dl)), x1 = Math.min(lw, Math.ceil(b[2] * dl));
    const y0 = Math.max(0, Math.floor(lh - b[3] * dl)), y1 = Math.min(lh, Math.ceil(lh - b[1] * dl));
    if (x1 <= x0 || y1 <= y0) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.lowFbo);
    gl.viewport(0, 0, lw, lh);
    gl.enable(gl.SCISSOR_TEST); gl.scissor(x0, y0, x1 - x0, y1 - y0);
    this._uniforms(f, false, lw / W);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.lowFbo); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    const sx = W / lw, sy = H / lh;
    gl.blitFramebuffer(x0 + 1, y0 + 1, x1 - 1, y1 - 1, Math.round((x0 + 1) * sx), Math.round((y0 + 1) * sy), Math.round((x1 - 1) * sx), Math.round((y1 - 1) * sy), gl.COLOR_BUFFER_BIT, gl.LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
}
