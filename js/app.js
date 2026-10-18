// DV64 GLASS date-range picker: state, DOM, input, 3D pane layout, liquid flow, render loop.
import * as C from './cal.js';
import { Glass } from './glass.js';
import manifest from '../img/manifest.js';

const $ = (s, r = document) => r.querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const qs = new URLSearchParams(location.search);
const root = document.documentElement;

// storage hygiene: nothing is persisted (the page always opens on the showcase); drop any older dv64 keys
try { for (const k of Object.keys(localStorage)) if (k.startsWith('dv64.') && !k.startsWith('dv64.v1.')) localStorage.removeItem(k); } catch (e) { /* private mode */ }

const mq = matchMedia('(prefers-reduced-motion: reduce)');
let reduced = mq.matches || qs.has('reduced');
mq.addEventListener?.('change', (e) => { reduced = e.matches || qs.has('reduced'); root.classList.toggle('reduced', reduced); kick(); });
root.classList.toggle('reduced', reduced);

// ------------------------------------------------------------------ state
const TODAY = qs.has('today') ? C.fromIso(qs.get('today')) : C.today();
const T0 = C.ymd(TODAY);
const S = {
  lo: C.dn(T0.y, T0.m, 14), hi: C.dn(T0.y, T0.m, 21),   // committed range (showcase: the 14th – 21st of this month)
  origin: C.dn(T0.y, T0.m, 14),                          // the first pick: where the liquid springs from
  anchor: null, preview: null,                           // an unfinished pick
  saved: null,                                           // committed range to restore on Escape
  focus: C.dn(T0.y, T0.m, 14),
  month: C.mIndex(T0.y, T0.m),
};
const P = { p: S.month, v: 0, drag: null };              // carousel position (float month index)
const LQ = { spec: { origin: S.origin, far: S.hi }, max: 0, G: 0, target: 0, gv: 0, init: false };
const TUBE = { level: 0.9, lv: 0, tilt: 0, tv: 0, wave: 0 };
const UI = { stress: -1e9, lastInput: 0, hover: -1, press: -1, ptr: [0, 0, 0, 0], rip: null, wheel: 0, wheelT: 0 };

// ------------------------------------------------------------------ DOM
const stage = $('.stage'), canvas = $('canvas.gl'), panesEl = $('.panes');
const navEl = $('.nav'), prevBtn = $('#prev'), nextBtn = $('#next'), live = $('[data-announce]');
const glass = qs.has('nogl') ? { ok: false } : new Glass(canvas);
root.classList.toggle('gl', !!glass.ok);
$('.credit').textContent = manifest.credit;

const CHEV = (d) => `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="${d === 'l' ? 'M14.5 5.5 8 12l6.5 6.5' : 'M9.5 5.5 16 12l-6.5 6.5'}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

class Pane {
  constructor(mi) {
    this.mi = mi; this.g = C.monthGrid(mi);
    const el = this.el = document.createElement('div');
    el.className = 'pane'; el.dataset.mi = mi;
    const id = `m${mi}`;
    const { y } = C.ym(mi);
    el.innerHTML = `<div class="content"><div class="head"><div class="title" id="${id}" role="heading" aria-level="2">${C.monthName(mi)} <span class="yr">${y}</span></div>
      <div class="chevs" aria-hidden="true"><span>${CHEV('l')}</span><span>${CHEV('r')}</span></div></div>
      <div class="grid" role="grid" aria-labelledby="${id}" aria-describedby="help" aria-multiselectable="true">
        <div class="wd" role="row">${C.WEEKDAYS.map((w) => `<div role="columnheader" aria-label="${w.long}">${w.short}</div>`).join('')}</div>
        <div class="rows" role="rowgroup"></div></div>
      <div class="foot"><span class="sel"></span></div></div>`;
    const rows = $('.rows', el); this.cells = [];
    const g = this.g;
    for (let r = 0; r < g.rows; r++) {
      const row = document.createElement('div'); row.className = 'row'; row.setAttribute('role', 'row');
      for (let c = 0; c < 7; c++) {
        const idx = r * 7 + c, day = idx - g.lead + 1;
        const cell = document.createElement('div');
        cell.setAttribute('role', 'gridcell');
        if (day >= 1 && day <= g.days) {
          const n = g.first + day - 1;
          cell.className = 'cell'; cell.dataset.dn = n; cell.tabIndex = -1; cell._n = n; cell._base = C.longDate(n) + (n === TODAY ? ', today' : ''); cell._st = '';
          cell.innerHTML = `<span class="num">${day}</span>`;
          if (n === TODAY) cell.setAttribute('aria-current', 'date');
          this.cells[idx] = cell;
        } else cell.className = 'cell blank';
        row.append(cell);
      }
      rows.append(row);
    }
    this.sel = $('.sel', el); this.content = $('.content', el); this.cop = '';
    this.tf = ''; this.clip = ''; this.op = ''; this.z = '';
    this.front = null;
    panesEl.append(el);
  }
  cellEl(n) { const i = C.cellOf(this.g, n); return i < 0 ? null : this.cells[i]; }
  setFront(on) {
    if (on === this.front) return; this.front = on;
    this.el.classList.toggle('is-front', on);
    if (on) this.el.removeAttribute('aria-hidden'); else this.el.setAttribute('aria-hidden', 'true');
  }
  remove() { this.el.remove(); }
}
const panes = new Map();

// ------------------------------------------------------------------ metrics
let M = null;
const GL_BUDGET = +(qs.get('px') || 3.6e6);          // canvas pixel budget: the glass is soft, the type is DOM and stays sharp
function metrics() {
  const vw = stage.clientWidth || innerWidth, vh = innerHeight;
  const phone = vw < 640;
  const touch = matchMedia('(pointer: coarse)').matches;
  const fit = (cell) => {
    const gap = Math.round(clamp(cell * 0.13, 3, 8)), pad = Math.round(cell * 0.44), itop = Math.round(cell * 0.36);
    const headH = Math.round(cell * 1.28), wdH = Math.round(cell * 0.56), footGap = Math.round(cell * 0.26), footH = Math.round(cell * 1.06);
    const w = 2 * pad + 7 * cell + 6 * gap;
    const h = (rows) => itop + headH + wdH + rows * (cell + gap) - gap + footGap + footH;
    return { cell, gap, pad, itop, headH, wdH, footGap, footH, w, h, h6: h(6) };
  };
  let cell;
  if (phone) {
    const gut = vw < 360 ? 8 : 14;
    // solve w = 2·pad + 7·cell + 6·gap ≤ vw − 2·gut  (pad ≈ 0.28·cell on phones, gap 4)
    cell = Math.floor((vw - 2 * gut - 24) / (7 + 0.3));
    cell = clamp(cell, 36, 60);
  } else {
    cell = clamp(Math.round(vh * 0.066), 40, 88);
    while (cell > 34 && fit(cell).h6 > vh - Math.max(40, vh * 0.09)) cell--;
    if (touch) cell = Math.max(cell, 40);
  }
  let m = fit(cell);
  if (phone) {           // tighter padding on phones
    const pad = Math.max(10, Math.round((vw - 7 * cell - 6 * 4 - 2 * (vw < 360 ? 8 : 14)) / 2));
    m = { ...m, gap: 4, pad: Math.min(pad, Math.round(cell * 0.34)) };
    m.w = 2 * m.pad + 7 * cell + 6 * m.gap;
    m.h = (rows) => m.itop + m.headH + m.wdH + rows * (cell + m.gap) - m.gap + m.footGap + m.footH;
    m.h6 = m.h(6);
  }
  const sc = cell / 54;
  const tube = !phone, tubeGap = Math.round(10 * sc), tubeW = Math.round(40 * sc);
  const blockW = m.w + (tube ? tubeGap + tubeW : 0);
  const stageH = Math.max(vh, m.h6 + 2 * Math.max(12, Math.round(vh * 0.04)));
  // the arc: side panes rotated about Y with their outer edge toward the viewer, pushed back and tucked behind
  const F = 1600 * sc, A = (phone ? 42 : 30) * Math.PI / 180;
  let Zs = -377 * sc, Xs = 328 * sc;
  const Xextra = tube ? tubeGap + tubeW : 0;
  let sideA = 1;
  if (!phone) {
    // fit the trio to the width: outer edges at most vw/2 − 12 from the centre of the block
    const outer = (X) => (X + (m.w / 2) * Math.cos(A)) * (F / (F - (Zs + (m.w / 2) * Math.sin(A))));
    const avail = vw / 2 - 14 - Xextra / 2;
    while (Xs > 150 * sc && outer(Xs) > avail) Xs -= 4;
    const visible = outer(Xs) - m.w / 2;
    if (visible < 130 * Math.min(1, sc + 0.2)) sideA = 0;                                   // too narrow for the arc: single pane
  } else { Xs = vw * 0.9; Zs = -220 * sc; sideA = 0; }
  // block (front pane + tube) centred; the trio is then symmetric round it
  const left = Math.round((vw - blockW) / 2);
  const top = Math.round((stageH - (m.h6 + m.h(5)) / 2) / 2 - (phone ? Math.min(24, vh * 0.025) : vh * 0.01));
  return { ...m, vw, vh, stageH, phone, touch, sc, tube, tubeGap, tubeW, F, A, Zs, Xs, Xextra, sideA, left, top,
    cx: left + m.w / 2, cy: top + m.h6 / 2, x0: m.pad, y0: m.itop + m.headH + m.wdH, radius: Math.round(26 * sc) };
}

function applyMetrics() {
  M = metrics();
  const s = stage.style;
  s.height = M.stageH + 'px';
  for (const [k, v] of Object.entries({ cell: M.cell, gap: M.gap, pad: M.pad, top: M.itop, headH: M.headH, wdH: M.wdH, footGap: M.footGap, footH: M.footH, w: M.w, r: M.radius }))
    s.setProperty('--' + k, v + 'px');
  s.setProperty('--sc', M.sc.toFixed(4));
  for (const pn of panes.values()) pn.tf = '';
  // the real nav buttons sit on the front slot's chevrons
  navEl.style.left = Math.round(M.left + M.w - M.pad + 10 * M.sc - 88) + 'px';
  navEl.style.top = Math.round(M.top + M.itop + (M.headH - 44) / 2) + 'px';
  const dpr = Math.min(devicePixelRatio || 1, 2, Math.sqrt(GL_BUDGET / (M.vw * M.stageH)));
  if (glass.ok) glass.resize(M.vw, M.stageH, Math.max(1, dpr));
}

// ------------------------------------------------------------------ projection
function pose(s) {
  const u = Math.abs(s), sg = Math.sign(s);
  let X, Z, th, a;
  if (u <= 1) {
    X = M.Xs * Math.sin(u * Math.PI / 2); Z = M.Zs * (1 - Math.cos(u * Math.PI / 2));
    th = M.A * (u + 0.32 * Math.sin(u * Math.PI));
    a = M.sideA ? 1 : 1 - smooth(0.2, 0.8, u);
  } else {
    const v = Math.min(u - 1, 1.6);
    X = M.Xs * (1 + 0.6 * v); Z = M.Zs * (1 + 1.1 * v); th = M.A * (1 + 0.45 * v);
    a = M.sideA ? 1 - smooth(0.1, 0.7, v) : 0;
  }
  if (sg > 0) X += M.Xextra * Math.min(u, 1);
  return { X: sg * X, Z, th: sg * th, a };
}
function project(ps, w, lx, ly) {
  const rx = lx - w / 2, ry = ly - M.h6 / 2, c = Math.cos(ps.th), s = Math.sin(ps.th);
  const x3 = ps.X + rx * c, z3 = ps.Z + rx * s;
  const k = M.F / (M.F - z3);
  return [M.cx + x3 * k, M.cy + ry * k];
}
// homography (row-major 3×3) taking the local rect (0,0)-(w,h) onto quad q[4]
function homography(q, w, h) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  let a, b, c, d, e, f, g, hh;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) { a = x1 - x0; b = x2 - x1; c = x0; d = y1 - y0; e = y2 - y1; f = y0; g = 0; hh = 0; }
  else {
    const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2, den = dx1 * dy2 - dx2 * dy1;
    g = (sx * dy2 - dx2 * sy) / den; hh = (dx1 * sy - sx * dy1) / den;
    a = x1 - x0 + g * x1; b = x3 - x0 + hh * x3; c = x0; d = y1 - y0 + g * y1; e = y3 - y0 + hh * y3; f = y0;
  }
  return [a / w, b / h, c, d / w, e / h, f, g / w, hh / h, 1];
}
function inv3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), Cc = d * h - e * g, det = a * A + b * B + c * Cc;
  const r = 1 / det;
  return [A * r, -(b * i - c * h) * r, (b * f - c * e) * r, B * r, (a * i - c * g) * r, -(a * f - c * d) * r, Cc * r, -(a * h - b * g) * r, (a * e - b * d) * r];
}
const apply3 = (m, x, y) => { const z = m[6] * x + m[7] * y + m[8]; return [(m[0] * x + m[1] * y + m[2]) / z, (m[3] * x + m[4] * y + m[5]) / z]; };
const f2 = (v) => +v.toFixed(5);

// ------------------------------------------------------------------ liquid geometry
const cellCenter = (g, idx) => [M.x0 + (idx % 7) * (M.cell + M.gap) + M.cell / 2, M.y0 + Math.floor(idx / 7) * (M.cell + M.gap) + M.cell / 2];
const FEED = () => (M.tube ? 1.4 : 0.35);

// The liquid in one month pane: ONE continuous ribbon of water of uniform width (Ulvi's water rule, 2026-10-18: no
// drips, no droplets, no necks, no bulbs). It runs from the origin along the selected days in date order; at the end
// of a week it turns in a U into the gutter between the rows, runs back along the gutter like water in a channel and
// turns again into the start of the next week. Arrival s of every point = when the pour reaches it (1 per day, 1.5 for
// the channel); the shader shows s < G. Returns segments [ax, ay, ar, sA, bx, by, br, sB] and the largest arrival.
const RIBBON = () => M.cell * 0.19;
const CHANNEL_T = 1.5;
function segmentsFor(pn, isFront, spec) {
  const g = pn.g, out = [], R = RIBBON();
  const { origin: o, far } = spec, dir = Math.sign(far - o) || 1;
  const lo = Math.min(o, far), hi = Math.max(o, far);
  const a0 = Math.max(lo, g.first), b0 = Math.min(hi, g.last);
  if (a0 > b0) return { segs: out, max: 0 };
  const rowsMap = new Map();
  for (let d = a0; d <= b0; d++) { const idx = C.cellOf(g, d), r = Math.floor(idx / 7), c = idx % 7; const iv = rowsMap.get(r); if (iv) { iv[0] = Math.min(iv[0], c); iv[1] = Math.max(iv[1], c); } else rowsMap.set(r, [c, c]); }
  const rows = [...rowsMap.keys()].sort((x, y) => dir * (x - y));
  const pitch = M.cell + M.gap;
  const cc = (r, c) => [M.x0 + c * pitch + M.cell / 2, M.y0 + r * pitch + M.cell / 2];
  const first = dir > 0 ? a0 : b0;
  let k = Math.abs(first - o);
  const hasOrigin = o >= g.first && o <= g.last;
  if (hasOrigin) {
    const idx = C.cellOf(g, o), c = cc(Math.floor(idx / 7), idx % 7);
    if (isFront && M.tube) { const tx = M.w + M.tubeGap + M.tubeW / 2; out.push([tx, c[1], R, -FEED(), c[0], c[1], R, 0]); }
    out.push([c[0], c[1], 0, 0, c[0], c[1], R, 0.3]);      // the ribbon's start cap fills in under the first pick
  } else {
    const idx = C.cellOf(g, first), c = cc(Math.floor(idx / 7), idx % 7);
    out.push([c[0], c[1], 0, k, c[0], c[1], R, k + 0.3]);
  }
  let max = k + 0.3;
  rows.forEach((r, i) => {
    const [ca, cb] = rowsMap.get(r);
    const xs = dir > 0 ? ca : cb, xe = dir > 0 ? cb : ca;   // traverse the week in date order
    const A = cc(r, xs), B = cc(r, xe), len = Math.abs(xe - xs);
    if (len) out.push([A[0], A[1], R, k, B[0], B[1], R, k + len]);
    k += len; max = Math.max(max, k);
    const rn = rows[i + 1]; if (rn == null) return;
    const [na, nb] = rowsMap.get(rn), xn = dir > 0 ? na : nb;
    // the channel: U-turn into the gutter, back along it, U-turn into the next week
    const N = cc(rn, xn), yg = (B[1] + N[1]) / 2, v = Math.sign(N[1] - B[1]), bulge = Math.sign(B[0] - N[0]) || 1, rho = Math.abs(yg - B[1]) / 2;
    const pts = [];
    for (let j = 0; j <= 7; j++) { const t = j / 7; pts.push([B[0] + bulge * rho * Math.sin(Math.PI * t), (B[1] + yg) / 2 - v * rho * Math.cos(Math.PI * t)]); }
    for (let j = 0; j <= 7; j++) { const t = j / 7; pts.push([N[0] - bulge * rho * Math.sin(Math.PI * t), (yg + N[1]) / 2 - v * rho * Math.cos(Math.PI * t)]); }
    let L = 0; const acc = [0]; for (let j = 1; j < pts.length; j++) { L += Math.hypot(pts[j][0] - pts[j - 1][0], pts[j][1] - pts[j - 1][1]); acc.push(L); }
    for (let j = 0; j < pts.length - 1; j++) {
      if (acc[j + 1] - acc[j] < 1e-3) continue;
      out.push([pts[j][0], pts[j][1], R, k + acc[j] / L * CHANNEL_T, pts[j + 1][0], pts[j + 1][1], R, k + acc[j + 1] / L * CHANNEL_T]);
    }
    k += CHANNEL_T; max = Math.max(max, k);
  });
  return { segs: out.slice(0, glass.MAXSEG || 80), max };
}
const specMax = (spec) => { let m = 0; for (const pn of panes.values()) m = Math.max(m, segmentsFor(pn, pn.mi === S.month, spec).max); return m; };

// ------------------------------------------------------------------ selection model
function wantedSpec() {
  if (S.anchor != null) return { origin: S.anchor, far: S.preview ?? S.anchor };
  return { origin: S.origin, far: S.origin === S.lo ? S.hi : S.lo };
}

function pick(n) {
  if (S.anchor == null) {
    S.saved = { lo: S.lo, hi: S.hi, origin: S.origin };
    S.anchor = n; S.preview = n;
    announce(`Range start ${C.longDate(n)}. Choose an end date.`);
  } else {
    const a = S.anchor;
    S.lo = Math.min(a, n); S.hi = Math.max(a, n); S.origin = a; S.anchor = null; S.preview = null; S.saved = null;
    const days = S.hi - S.lo + 1;
    announce(`Selected ${C.longDate(S.lo)} to ${C.longDate(S.hi)}, ${days} day${days > 1 ? 's' : ''}.`);
    stage.dispatchEvent(new CustomEvent('rangechange', { bubbles: true, detail: { start: C.iso(S.lo), end: C.iso(S.hi) } }));
  }
  const pn = panes.get(S.month), idx = pn ? C.cellOf(pn.g, n) : -1;
  if (idx >= 0) UI.rip = { x: cellCenter(pn.g, idx)[0], y: cellCenter(pn.g, idx)[1], t0: performance.now() };
  syncSelection(); kick();
}
function cancelPick() {
  if (S.anchor == null) return;
  S.anchor = null; S.preview = null;
  if (S.saved) Object.assign(S, S.saved); S.saved = null;
  announce(`Selection cancelled. ${C.rangeLabel(S.lo, S.hi)} kept.`);
  syncSelection(); kick();
}
function setPreview(n) { if (S.anchor == null || n === S.preview) return; S.preview = n; syncSelection(); kick(); }

let annT = 0;
function announce(t) { clearTimeout(annT); live.textContent = ''; annT = setTimeout(() => { live.textContent = t; }, 60); }

function footerText() {
  if (S.anchor != null) {
    const b = S.preview ?? S.anchor;
    if (b === S.anchor) return `<b>Start:</b> ${C.rangeLabel(S.anchor, S.anchor)} <i>· pick an end date</i>`;
    const lo = Math.min(S.anchor, b), hi = Math.max(S.anchor, b);
    return `<b>Selected:</b> ${C.rangeLabel(lo, hi)} <i>· ${hi - lo + 1} days</i>`;
  }
  return `<b>Selected:</b> ${C.rangeLabel(S.lo, S.hi)} <i>· ${S.hi - S.lo + 1} days</i>`;
}

function syncSelection() {
  const pending = S.anchor != null;
  const lo = pending ? Math.min(S.anchor, S.preview ?? S.anchor) : S.lo, hi = pending ? Math.max(S.anchor, S.preview ?? S.anchor) : S.hi;
  const html = footerText();
  for (const pn of panes.values()) {
    if (pn.selHtml !== html) { pn.selHtml = html; pn.sel.innerHTML = html; }
    const isFrontPane = pn.mi === S.month;
    for (const cell of pn.cells) {
      if (!cell) continue;
      const n = cell._n;
      const inR = n >= lo && n <= hi, isS = pending ? n === S.anchor : n === lo, isE = !pending && n === hi;
      const ring = pending && n === S.preview && n !== S.anchor;
      const tab = n === S.focus && isFrontPane;
      const key = `${+inR}${+isS}${+isE}${+ring}${+tab}${+pending}${+(lo === hi)}`;
      if (key === cell._st) continue;                     // nothing changed for this day
      cell._st = key;
      cell.classList.toggle('in-range', inR); cell.classList.toggle('is-start', isS); cell.classList.toggle('is-end', isE);
      cell.classList.toggle('is-ring', ring);
      cell.setAttribute('aria-selected', pending ? String(n === S.anchor) : String(inR));
      let label = cell._base;
      if (pending && n === S.anchor) label += ', range start';
      else if (!pending && n === lo && n === hi) label += ', selected';
      else if (!pending && n === lo) label += ', range start';
      else if (!pending && n === hi) label += ', range end';
      cell.setAttribute('aria-label', label);
      cell.tabIndex = tab ? 0 : -1;
    }
  }
  root.dataset.mode = pending ? 'picking' : 'range';
  const out = $('#value'); out.value = `${C.iso(S.lo)}/${C.iso(S.hi)}`;
}

// ------------------------------------------------------------------ months
function ensurePanes() {
  const lo = Math.min(Math.floor(P.p), S.month) - 2, hi = Math.max(Math.ceil(P.p), S.month) + 2;
  let made = false;
  for (let mi = lo; mi <= hi; mi++) if (!panes.has(mi)) { panes.set(mi, new Pane(mi)); made = true; }
  for (const [mi, pn] of panes) if (mi < lo - 1 || mi > hi + 1) { pn.remove(); panes.delete(mi); }
  if (made) syncSelection();
}
function goMonth(k, { focusCell = false, keepFocusDate = false } = {}) {
  if (!keepFocusDate) S.focus = C.addMonths(S.focus, k);
  S.month += k;
  if (reduced) P.p = S.month;
  else if (Math.abs(S.month - P.p) > 1.4) { P.p = S.month - Math.sign(k) * 1.4; P.v = 0; }   // long jumps swing in from the neighbour
  ensurePanes();
  for (const [mi, pn] of panes) pn.setFront(mi === S.month);
  syncSelection();
  const { y } = C.ym(S.month);
  announce(`${C.monthName(S.month)} ${y}`);
  if (focusCell) focusDate();
  kick();
}
// Focus must always match the state. The target month's pane can still be visibility:hidden from earlier frames
// (a long jump swings it in from far away), where focus() silently fails: un-hide it first, and check again on the
// next frame in case anything moved the focus elsewhere meanwhile.
function focusDate(retry = true) {
  const pn = panes.get(S.month); if (!pn) return;
  const el = pn.cellEl(S.focus);
  if (!el) return;
  if (pn.el.style.visibility === 'hidden') { pn.el.style.visibility = ''; pn.op = ''; }
  for (const c of pn.cells) if (c) c.tabIndex = c === el ? 0 : -1;
  el.focus({ preventScroll: true });
  if (retry) requestAnimationFrame(() => {
    const want = panes.get(S.month)?.cellEl(S.focus);
    const act = document.activeElement;
    if (want && act !== want && (act === document.body || act?.closest?.('.panes'))) focusDate(false);
  });
}
function moveFocus(n) {
  const mi = C.mOf(n);
  S.focus = n;
  if (mi !== S.month) goMonth(mi - S.month, { focusCell: true, keepFocusDate: true });
  else { syncSelection(); focusDate(); }
  setPreview(n);
}

// ------------------------------------------------------------------ input
panesEl.addEventListener('keydown', (e) => {
  UI.lastInput = performance.now();
  const cell = e.target.closest?.('.cell[data-dn]'); if (!cell) return;
  const n = +cell.dataset.dn, d = C.dow(n);
  let to = null;
  switch (e.key) {
    case 'ArrowLeft': to = n - 1; break;
    case 'ArrowRight': to = n + 1; break;
    case 'ArrowUp': to = n - 7; break;
    case 'ArrowDown': to = n + 7; break;
    case 'Home': to = n - d; break;
    case 'End': to = n + (6 - d); break;
    case 'PageUp': to = C.addMonths(n, e.shiftKey ? -12 : -1); break;
    case 'PageDown': to = C.addMonths(n, e.shiftKey ? 12 : 1); break;
    case 'Enter': case ' ': e.preventDefault(); pick(n); return;
    case 'Escape': if (S.anchor != null) { e.preventDefault(); cancelPick(); } return;
    default: return;
  }
  e.preventDefault(); moveFocus(to);
});
panesEl.addEventListener('focusin', (e) => { const c = e.target.closest?.('.cell[data-dn]'); if (c) S.focus = +c.dataset.dn; });

const cellAt = (x, y) => { const el = document.elementFromPoint(x, y); const c = el?.closest?.('.pane.is-front .cell[data-dn]'); return c || null; };
const idxOf = (c) => { const pn = panes.get(S.month); return pn ? C.cellOf(pn.g, +c.dataset.dn) : -1; };

stage.addEventListener('pointermove', (e) => {
  UI.lastInput = performance.now();
  const sr = stage.getBoundingClientRect();
  UI.ptr = [e.clientX - sr.left, e.clientY - sr.top, e.pointerType === 'mouse' ? 1 : 0, 0];
  if (P.drag) { dragMove(e); return; }
  const c = e.pointerType === 'mouse' ? cellAt(e.clientX, e.clientY) : null;
  const hi = c ? idxOf(c) : -1;
  if (hi !== UI.hover) { UI.hover = hi; kick(); }
  if (c && S.anchor != null && (e.pointerType === 'mouse' || UI.down)) setPreview(+c.dataset.dn);
  if (e.pointerType === 'mouse' && !reduced) kick();
});
stage.addEventListener('pointerleave', () => { UI.ptr[2] = 0; UI.hover = -1; kick(); });

stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (e.target.closest('.nav, button, a')) return;
  const cell = e.target.closest('.pane.is-front .cell[data-dn]');
  const side = !cell && e.target.closest('.pane:not(.is-front)');
  UI.down = { x: e.clientX, y: e.clientY, t: performance.now(), cell, side, id: e.pointerId, type: e.pointerType, moved: false };
  if (cell && e.pointerType === 'mouse') {
    e.preventDefault();
    const n = +cell.dataset.dn; S.focus = n; cell.focus({ preventScroll: true });
    UI.press = idxOf(cell);
    if (S.anchor == null) { pick(n); UI.down.started = true; }      // drag-select starts here
    kick();
  }
  if (!cell || e.pointerType !== 'mouse') {
    // touch / pen anywhere, or the mouse on glass that is not a day: a horizontal drag scrubs the months
    P.drag = { x0: e.clientX, p0: P.p, last: e.clientX, t: performance.now(), v: 0, live: false, id: e.pointerId };
  }
});
function dragMove(e) {
  const D = P.drag; const dx = e.clientX - D.x0;
  if (!D.live && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(e.clientY - UI.down.y)) { D.live = true; stage.setPointerCapture?.(D.id); UI.down.moved = true; root.classList.add('dragging'); }
  if (!D.live) return;
  const now = performance.now(), span = M.w * 0.85;
  D.v = 0.8 * D.v + 0.2 * (-(e.clientX - D.last) / span) / Math.max((now - D.t) / 1000, 1e-3);
  D.last = e.clientX; D.t = now;
  P.p = D.p0 - dx / span; P.v = 0;
  ensurePanes(); kick();
}
addEventListener('pointerup', (e) => {
  const D = UI.down; UI.down = null; UI.press = -1;
  if (P.drag) {
    const dg = P.drag; P.drag = null; root.classList.remove('dragging');
    if (dg.live) {
      const proj = P.p + clamp(dg.v, -6, 6) * 0.18;
      const to = clamp(Math.round(proj), S.month - 3, S.month + 3);
      P.v = dg.v; if (to !== S.month) goMonth(to - S.month); else kick();
      return;
    }
  }
  if (!D || D.moved) { kick(); return; }
  if (D.side) { const mi = +D.side.dataset.mi; if (mi !== S.month) goMonth(mi - S.month); return; }
  const cell = D.cell;
  if (!cell) return;
  const n = +cell.dataset.dn;
  if (D.type === 'mouse') {
    const up = cellAt(e.clientX, e.clientY);
    if (D.started) { if (up && +up.dataset.dn !== n) pick(+up.dataset.dn); }      // press-drag-release
    else pick(+(up?.dataset.dn ?? n));                                             // second click
  } else { S.focus = n; pick(n); }
  kick();
});
addEventListener('pointercancel', () => { UI.down = null; if (P.drag) { P.drag = null; root.classList.remove('dragging'); kick(); } });

stage.addEventListener('wheel', (e) => {
  if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 1.2) return;
  e.preventDefault();
  const now = performance.now();
  if (now - UI.wheelT > 260) UI.wheel = 0;
  UI.wheelT = now; UI.wheel += e.deltaX;
  if (Math.abs(UI.wheel) > 70 && !UI.wheelLock) { goMonth(Math.sign(UI.wheel)); UI.wheel = 0; UI.wheelLock = true; setTimeout(() => { UI.wheelLock = false; }, 420); }
}, { passive: false });

prevBtn.addEventListener('click', () => goMonth(-1));
nextBtn.addEventListener('click', () => goMonth(1));
addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.anchor != null && !e.target.closest?.('.cell')) cancelPick(); });

// ------------------------------------------------------------------ frame
let running = false, lastT = 0, frameN = 0;
const T_START = performance.now();
function kick() { if (!running) { running = true; lastT = performance.now(); requestAnimationFrame(tick); } }

function stepLiquid(dt) {
  const W = wantedSpec(), C0 = LQ.spec;
  const sgn = (sp) => Math.sign(sp.far - sp.origin);
  if (W.origin !== C0.origin) {                           // drain back into the tube, then pour from the new origin
    LQ.target = -FEED();
    if (LQ.G <= -FEED() + 0.02 || reduced) { LQ.spec = W; LQ.max = specMax(W); LQ.G = reduced ? LQ.max : -FEED(); LQ.target = LQ.max; }
  } else if (sgn(W) && sgn(C0) && sgn(W) !== sgn(C0) && LQ.G > 0.31) {
    LQ.target = 0.3;                                      // flowing the other way: pull back into the origin first
  } else if (W.far !== C0.far) {
    const mW = specMax(W);
    const grows = (sgn(W) === sgn(C0) || !sgn(C0)) && Math.abs(W.far - W.origin) >= Math.abs(C0.far - C0.origin);
    if (grows || LQ.G <= mW + 0.01 || reduced) { LQ.spec = W; LQ.max = mW; LQ.target = mW; }
    else LQ.target = mW;                                  // shrinking: let the liquid run back, then drop the cells
  } else LQ.target = LQ.max;
  if (reduced) { LQ.G = LQ.target; LQ.gv = 0; return; }
  const diff = LQ.target - LQ.G;
  const v = Math.sign(diff) * Math.min(Math.abs(diff) * 9, Math.max(5, Math.abs(diff) * 3.6), 40);
  LQ.gv += (v - LQ.gv) * Math.min(1, dt * 14);
  LQ.G += LQ.gv * dt;
  if ((diff > 0 && LQ.G > LQ.target) || (diff < 0 && LQ.G < LQ.target) || Math.abs(diff) < 0.002) { LQ.G = LQ.target; LQ.gv = 0; }
}
function stepTube(dt) {
  const days = Math.abs(LQ.spec.far - LQ.spec.origin) * clamp(LQ.G / Math.max(LQ.max, 1e-3), 0, 1);
  const lvl = LQ.G <= -FEED() + 0.01 ? 0.06 : 0.1 + 0.82 * (1 - Math.exp(-(days + (LQ.G > 0 ? 1 : 0)) / 4.6));
  if (reduced) { TUBE.level = lvl; TUBE.tilt = 0; TUBE.wave = 0; return; }
  TUBE.lv += (60 * (lvl - TUBE.level) - 11 * TUBE.lv) * dt; TUBE.level += TUBE.lv * dt;
  const push = clamp(P.v, -6, 6) * 0.05 + clamp(LQ.gv, -30, 30) * 0.002;
  TUBE.tv += (-90 * TUBE.tilt - 5 * TUBE.tv + push * 60) * dt; TUBE.tilt = clamp(TUBE.tilt + TUBE.tv * dt, -0.35, 0.35);
  TUBE.wave = 0.45 * M.sc + Math.min(2.5, Math.abs(TUBE.tv) * 4) * M.sc;
}
function stepCarousel(dt) {
  if (P.drag?.live) return;
  if (reduced) { P.p = S.month; P.v = 0; return; }
  const k = 135, c = 2 * Math.sqrt(k) * 0.74;
  P.v += (k * (S.month - P.p) - c * P.v) * dt; P.p += P.v * dt;
  if (Math.abs(S.month - P.p) < 0.0004 && Math.abs(P.v) < 0.003) { P.p = S.month; P.v = 0; }
}

const F = { inv: new Float32Array(36), fwd: new Float32Array(36), uSize: new Float32Array(16), uGridA: new Float32Array(16), uGridB: new Float32Array(16),
  uSel: new Float32Array(16), uLiq: new Float32Array(16), uHead: new Float32Array(16), uBox: new Float32Array(16),
  box: [0, 0, 0, 0], bgXf: [0, 0, 0, 0], drift: [0, 0, 1, 0.5], ptr: [0, 0, 0, 0], rip: [0, 0, 0, 0], tube: [0, 0, 0, 0], tubeL: [0, 0, 0, 0], fx: [0, 1, 0, 1], n: 0, front: 0, time: 0 };
let segKey = '';
const CLIP = { on: true, epoch: 0 };

function layoutAndRender(now) {
  ensurePanes();
  const live = [...panes.values()].map((pn) => ({ pn, s: pn.mi - P.p })).filter((o) => Math.abs(o.s) < 2.4);
  live.sort((a, b) => Math.abs(a.s) - Math.abs(b.s));              // front first
  const frontPn = panes.get(S.month);
  // DOM transforms + z order
  const infos = [];
  live.forEach((o, rank) => {
    const pn = o.pn, h = M.h(pn.g.rows), ps = pose(o.s);
    const atRest = Math.abs(o.s) < 1e-4;
    let H;
    if (atRest) {
      const lx = M.left, ly = M.top;
      H = [1, 0, lx, 0, 1, ly, 0, 0, 1];
      if (pn.tf !== `r${lx},${ly}`) { pn.tf = `r${lx},${ly}`; pn.el.style.transform = `translate(${lx}px,${ly}px)`; }
    } else {
      const q = [project(ps, M.w, 0, 0), project(ps, M.w, M.w, 0), project(ps, M.w, M.w, h), project(ps, M.w, 0, h)];
      H = homography(q, M.w, h);
      const t = `matrix3d(${f2(H[0])},${f2(H[3])},0,${f2(H[6])},${f2(H[1])},${f2(H[4])},0,${f2(H[7])},0,0,1,0,${f2(H[2])},${f2(H[5])},0,${f2(H[8])})`;
      if (pn.tf !== t) { pn.tf = t; pn.el.style.transform = t; }
    }
    const a = ps.a, op = a.toFixed(3), z = String(20 - rank);
    // the front month is never visibility:hidden (it may be transparent mid-swing): a hidden element cannot hold focus
    if (pn.op !== op) { pn.op = op; pn.el.style.opacity = op; pn.el.style.visibility = a < 0.01 && pn.mi !== S.month ? 'hidden' : ''; }
    if (pn.z !== z) { pn.z = z; pn.el.style.zIndex = z; }
    if (pn.hh !== h) { pn.hh = h; pn.el.style.height = h + 'px'; }
    infos.push({ pn, s: o.s, H, Hi: inv3(H), h, a });
  });
  for (const pn of panes.values()) if (pn.mi !== S.month && !live.find((o) => o.pn === pn) && pn.op !== '0') { pn.op = '0'; pn.el.style.opacity = '0'; pn.el.style.visibility = 'hidden'; }
  // tube rect (stage css)
  const fh = frontPn ? M.h(frontPn.g.rows) : M.h6;
  TUBE.h = TUBE.h ? TUBE.h + (fh - TUBE.h) * 0.2 : fh;
  const tubeA = M.tube ? 1 - smooth(0.02, 0.12, Math.abs(P.p - S.month)) : 0;
  const tube = tubeA > 0.5 ? [M.left + M.w + M.tubeGap, M.top + 2 * M.sc, M.tubeW, TUBE.h - 4 * M.sc] : null;
  // Numbers of the panes behind must never show through the glass in front. At rest each pane behind is clipped once
  // (clip-path). While the panes swing, a changing clip-path would repaint their text every frame, so instead the clip
  // is dropped and the content of every pane but the front-most fades out on its own compositor layer.
  const off = Math.abs(P.p - S.month), dragLive = !!P.drag?.live;
  if (CLIP.on && (off > 0.06 || dragLive)) CLIP.on = false;
  else if (!CLIP.on && off < 0.02 && !dragLive) CLIP.on = true;
  const minS = infos.length ? Math.abs(infos[0].s) : 0;
  infos.forEach((inf, k) => {
    let path = '', op = 1;
    if (k > 0 && CLIP.on) {
      const holes = [];
      // only the front-most nearer pane (+ the tube, which never overlaps it): overlapping holes would cancel under evenodd
      for (let j = 0; j < k; j++) {
        const o = infos[j]; if (o.a < 0.05 || Math.abs(o.s) > Math.abs(inf.s) - 0.05) continue;
        if (holes.length) break;
        const r = 2, ext = tube && Math.abs(o.s) < 0.06 ? M.tubeGap + 2 : 0;
        holes.push([[r, r], [M.w - r + ext, r], [M.w - r + ext, o.h - r], [r, o.h - r]].map(([x, y]) => apply3(o.H, x, y)));
      }
      if (tube) holes.push([[tube[0], tube[1]], [tube[0] + tube[2], tube[1]], [tube[0] + tube[2], tube[1] + tube[3]], [tube[0], tube[1] + tube[3]]]);
      const sub = holes.map((q) => 'M' + q.map(([x, y]) => apply3(inf.Hi, x, y).map((v) => v.toFixed(1)).join(' ')).join('L') + 'Z').join('');
      path = `path(evenodd,"M-20 -20H${M.w + 20}V${inf.h + 20}H-20Z${sub}")`;
    } else if (k > 0) op = 1 - smooth(0, 0.2, Math.abs(inf.s) - minS);
    // while clipped, keep the clip fixed (the pose only creeps while the spring settles)
    if (CLIP.on && k > 0 && inf.pn.clip && inf.pn.clipFor === CLIP.epoch) path = inf.pn.clip;
    if (inf.pn.clip !== path) { inf.pn.clip = path; inf.pn.el.style.clipPath = path || ''; }
    inf.pn.clipFor = CLIP.epoch;
    const os = op.toFixed(2);
    if (inf.pn.cop !== os) { inf.pn.cop = os; inf.pn.content.style.opacity = os; }
  });
  if (!CLIP.on) CLIP.epoch++;
  // the picker's screen box (panes + tube + halo/shadow room): the only region the glass shader has to shade
  let bb = [1e9, 1e9, -1e9, -1e9];
  for (const inf of infos) {
    if (inf.a < 0.01) continue;
    for (const [x, y] of [[0, 0], [M.w, 0], [M.w, inf.h], [0, inf.h]]) { const q = apply3(inf.H, x, y); bb = [Math.min(bb[0], q[0]), Math.min(bb[1], q[1]), Math.max(bb[2], q[0]), Math.max(bb[3], q[1])]; }
  }
  if (M.tube) bb = [bb[0], bb[1], Math.max(bb[2], M.left + M.w + M.tubeGap + M.tubeW), Math.max(bb[3], M.top + TUBE.h)];
  const mg = 110 * M.sc;
  F.box = [bb[0] - mg, bb[1] - mg, bb[2] + mg, bb[3] + mg * 1.4];
  // nav buttons follow the front slot's frontness
  const navOp = clamp(1 - Math.abs(P.p - S.month) * 2.2, 0, 1);
  navEl.style.opacity = navOp.toFixed(3);

  if (!glass.ok || !glass.hasImage) return;
  // ---- frame for the shader: back to front
  const gl = infos.filter((o) => o.a > 0.01).slice(0, 4).reverse();
  const n = gl.length; F.n = n; F.front = -1;
  let key = `${M.w}|${LQ.spec.origin}|${LQ.spec.far}|${M.cell}|`;
  gl.forEach((o) => { key += o.pn.mi + ',' + (o.pn === frontPn ? 1 : 0) + ';'; });
  const rebuild = key !== segKey;
  const pending = S.anchor != null;
  const lo = pending ? Math.min(S.anchor, S.preview ?? S.anchor) : S.lo, hi = pending ? Math.max(S.anchor, S.preview ?? S.anchor) : S.hi;
  gl.forEach((o, i) => {
    const { pn } = o, g = pn.g;
    const isFront = pn === frontPn && Math.abs(o.s) < 0.5;
    if (isFront) F.front = i;
    F.inv.set(colMajor(o.Hi), i * 9); F.fwd.set(colMajor(o.H), i * 9);
    F.uSize.set([M.w, o.h, M.radius, o.a * (isFront ? 1 : 0.92)], i * 4);
    F.uGridA.set([M.x0, M.y0, M.cell, M.gap], i * 4);
    F.uGridB.set([g.lead, g.days, g.rows, pn === frontPn ? UI.hover : -1], i * 4);
    const sIdx = pending ? C.cellOf(g, S.anchor) : C.cellOf(g, lo);
    const eIdx = pending ? -1 : C.cellOf(g, hi);
    const rIdx = pending && S.preview != null && S.preview !== S.anchor ? C.cellOf(g, S.preview) : -1;
    F.uSel.set([sIdx, eIdx === sIdx ? -1 : eIdx, rIdx, pn === frontPn ? UI.press : -1], i * 4);
    if (rebuild || !o.pn._lq) o.pn._lq = segmentsFor(pn, pn === frontPn, LQ.spec);
    const { segs } = o.pn._lq;
    if (rebuild) {
      const base = i * glass.MAXSEG * 2 * 4;
      glass.segData.fill(0, base, base + glass.MAXSEG * 8);
      segs.forEach((sg, j) => glass.segData.set(sg, base + j * 8));
    }
    let bx = [1e5, 1e5, -1e5, -1e5];
    for (const sg of segs) {
      bx = [Math.min(bx[0], sg[0] - sg[2], sg[4] - sg[6]), Math.min(bx[1], sg[1] - sg[2], sg[5] - sg[6]),
            Math.max(bx[2], sg[0] + sg[2], sg[4] + sg[6]), Math.max(bx[3], sg[1] + sg[2], sg[5] + sg[6])];
    }
    const Rb = RIBBON();
    F.uHead.set([0, 0, 0, 0], i * 4);                 // no drops: the liquid is only ever the continuous ribbon
    F.uBox.set(bx, i * 4);
    F.uLiq.set([segs.length, LQ.G, isFront ? (1 - smooth(0, 0.08, Math.abs(o.s))) : 0, RIBBON()], i * 4);
  });
  if (rebuild) { segKey = key; glass.uploadSegments(); }
  // backdrop cover mapping
  const iw = glass.iw, ih = glass.ih, W = M.vw, Hs = M.stageH;
  const sc = Math.max(W / iw, Hs / ih);
  F.bgXf = [1 / (iw * sc), 1 / (ih * sc), -(W - iw * sc) / 2 / (iw * sc), -(Hs - ih * sc) / 2 / (ih * sc)];
  const t = reduced ? 0 : (now - T_START) / 1000;
  F.drift = [0, 0, 1 / 1.045, 0.86];          // static backdrop: it is cached in a texture
  F.ptr = UI.ptr;
  if (UI.rip) { const age = (now - UI.rip.t0) / 1000; if (age > 1.6 || reduced) UI.rip = null; else F.rip = [UI.rip.x, UI.rip.y, age, 1]; }
  if (!UI.rip) F.rip = [0, 0, 0, 0];
  F.tube = M.tube ? [M.left + M.w + M.tubeGap, M.top + 2 * M.sc, M.tubeW, TUBE.h - 4 * M.sc] : [0, 0, 0, 0];
  F.tubeL = [clamp(TUBE.level, 0, 1), TUBE.tilt, TUBE.wave, tubeA];
  const sweep = ((t % 11) / 11) * 2.4 - 0.6;
  F.fx = [reduced ? -9 : sweep, reduced ? 1 : 0.9 + 0.1 * Math.sin(t * 1.7), 0, M.sc];
  F.time = t;
  // dynamic resolution: the swing renders at 0.62, a moving liquid at 0.8 (both hide it); everything at rest is full
  F.scale = (Math.abs(P.p - S.month) > 0.03 || P.drag?.live) ? 0.62 : (Math.abs(LQ.gv) > 0.05 || UI.rip) && !reduced ? 0.8 : 1;
  if (F.scale < 1 && now - UI.stress < 600) F.scale *= 0.8;          // a late frame while moving: one step lower for a moment
  glass.draw(F);
}
const colMajor = (m) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

function tick(now) {
  if (now - lastT > 12.5 && now - lastT < 200 && (P.p !== S.month || LQ.G !== LQ.target)) UI.stress = now;
  const dt = window.__dv64?.held ? 0 : clamp((now - lastT) / 1000, 0, 1 / 30); lastT = now;
  stepCarousel(dt); stepLiquid(dt); stepTube(dt);
  // at rest only the slow idle light moves: draw it at half rate and give the GPU back every other frame
  const moving = P.p !== S.month || LQ.G !== LQ.target || UI.rip || P.drag || Math.abs(TUBE.lv) > 0.002 || Math.abs(TUBE.tv) > 0.01 || now - UI.lastInput < 400;
  frameN++;
  if (moving || frameN % 2 === 0 || reduced) layoutAndRender(now);
  const busy = !reduced || P.drag || Math.abs(P.p - S.month) > 0 || LQ.G !== LQ.target || UI.rip;
  if (busy && !document.hidden) requestAnimationFrame(tick); else running = false;
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });

// ------------------------------------------------------------------ boot
let resizeT = 0;
addEventListener('resize', () => { cancelAnimationFrame(resizeT); resizeT = requestAnimationFrame(() => { applyMetrics(); kick(); }); });

function pickImage() {
  const phone = innerWidth / innerHeight < 0.8;
  if (phone && manifest.phone) return 'img/wallpaper-phone.webp';
  const need = innerWidth * Math.min(devicePixelRatio || 1, 2) * 0.6;
  const w = manifest.sizes.find(([w]) => w >= need)?.[0] ?? manifest.sizes[manifest.sizes.length - 1][0];
  return `img/wallpaper-${w}.webp`;
}

// The first change inside a pane after its first raster costs a one-off 30–60 ms frame on a throttled phone (measured:
// it vanishes when any footer is touched once beforehand). Pay it shortly after load, while nothing moves.
function warmUp() {
  const tmp = [];
  for (const pn of panes.values()) { const i = document.createElement('i'); i.className = 'warm'; i.textContent = '·'; pn.sel.after(i); tmp.push(i); }
  setTimeout(() => tmp.forEach((i) => i.remove()), 200);
}

const ready = new Promise((res) => {
  applyMetrics(); ensurePanes();
  for (const [mi, pn] of panes) pn.setFront(mi === S.month);
  syncSelection();
  LQ.max = specMax(LQ.spec); LQ.G = LQ.target = LQ.max;
  if (!glass.ok) { root.classList.add('nogl'); kick(); requestAnimationFrame(res); setTimeout(warmUp, 700); return; }
  const img = new Image(); img.decoding = 'async';
  img.onload = () => { glass.setImage(img); kick(); requestAnimationFrame(() => requestAnimationFrame(res)); setTimeout(warmUp, 700); };
  img.onerror = () => { root.classList.remove('gl'); kick(); res(); };
  img.src = pickImage();
});

// test / tooling API
window.__dv64 = {
  ready,
  state: () => ({ lo: C.iso(S.lo), hi: C.iso(S.hi), origin: C.iso(S.origin), anchor: S.anchor == null ? null : C.iso(S.anchor),
    preview: S.preview == null ? null : C.iso(S.preview), focus: C.iso(S.focus), month: S.month, monthName: C.monthName(S.month),
    p: P.p, G: LQ.G, target: LQ.target, liquidOrigin: C.iso(LQ.spec.origin), liquidFar: C.iso(LQ.spec.far), max: LQ.max, tube: TUBE.level, gl: !!glass.ok,
    settled: P.p === S.month && LQ.G === LQ.target && !UI.rip && LQ.spec.origin === wantedSpec().origin && LQ.spec.far === wantedSpec().far, reduced, mode: M.phone ? 'phone' : M.sideA ? 'arc' : 'single' }),
  goMonth, pick, cancel: cancelPick,
  setRange: (a, b) => { const x = C.fromIso(a), y = C.fromIso(b); S.anchor = null; S.preview = null; S.lo = Math.min(x, y); S.hi = Math.max(x, y); S.origin = x; syncSelection(); kick(); },
  hold: (on) => { window.__dv64.held = on; },
  cellRect: (iso) => { const n = C.fromIso(iso); const pn = panes.get(S.month); const el = pn?.cellEl(n); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; },
  metrics: () => M,
  // the liquid as drawn (front pane): segments, whether any drop/head/bubble exists, ribbon radius
  liquid: () => { const pn = panes.get(S.month); const L = pn?._lq || segmentsFor(pn, true, LQ.spec);
    return { segs: L.segs.map((q) => [...q]), ribbon: RIBBON(), head: F.uHead[0] || F.uHead[3] ? [...F.uHead] : null, bubbles: glass.bubbles === true, G: LQ.G, max: LQ.max }; },
};
