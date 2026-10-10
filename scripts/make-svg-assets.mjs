#!/usr/bin/env node
// Generates the animated pixel-art SVGs used by README.md and the Pages site.
//
// GitHub renders repo-relative SVGs through its image proxy and strips <script>
// and (unreliably) <style>. SMIL animation elements survive, so every animation
// here is expressed as <animate> with no CSS and no JS.
//
// Everything is drawn on a cell grid at whole-pixel coordinates with
// shape-rendering="crispEdges", and every animation uses calcMode="discrete".
// Pixel art that eases and tweens stops reading as pixel art - the stepping is
// the whole point, and it matches the steps() motion the app itself uses.
//
//   node scripts/make-svg-assets.mjs

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'docs/assets');
mkdirSync(OUT, { recursive: true });

const C = {
  bg: '#0b0d0f',
  panel: '#12171c',
  edge: '#232c37',
  edge2: '#39465699',
  text: '#c9d1d9',
  dim: '#7d8896',
  faint: '#49556420',
  green: '#57d38c',
  red: '#ff7b72',
  amber: '#e3b341',
  blue: '#79c0ff',
  violet: '#bc8cff',
  white: '#e8e8ea',
};

const MONO = "ui-monospace,'SF Mono','DejaVu Sans Mono',Menlo,Consolas,monospace";
const PX = 6; // one art pixel, in user units

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ------------------------------------------------------------ primitives ----

/** One art pixel at cell (cx, cy). */
function p(cx, cy, fill, extra = '') {
  return `<rect x="${cx * PX}" y="${cy * PX}" width="${PX}" height="${PX}" fill="${fill}"${extra ? ' ' + extra : ''}/>`;
}

/** A solid run of cells - cheaper than one rect per pixel for straight lines. */
function run(cx, cy, w, h, fill, extra = '') {
  return `<rect x="${cx * PX}" y="${cy * PX}" width="${w * PX}" height="${h * PX}" fill="${fill}"${extra ? ' ' + extra : ''}/>`;
}

/** A one-cell-thick hollow border. */
function frame(cx, cy, w, h, fill) {
  return (
    run(cx, cy, w, 1, fill) +
    run(cx, cy + h - 1, w, 1, fill) +
    run(cx, cy + 1, 1, h - 2, fill) +
    run(cx + w - 1, cy + 1, 1, h - 2, fill)
  );
}

/**
 * Draw a sprite map. `map` is an array of equal-length strings; each character
 * is looked up in `pal`, and '.' / ' ' are transparent. Consecutive identical
 * cells on a row collapse into one rect.
 */
function sprite(map, cx, cy, pal) {
  let out = '';
  for (let y = 0; y < map.length; y++) {
    const row = map[y];
    let x = 0;
    while (x < row.length) {
      const ch = row[x];
      if (ch === '.' || ch === ' ' || !pal[ch]) { x++; continue; }
      let n = 1;
      while (x + n < row.length && row[x + n] === ch) n++;
      out += run(cx + x, cy + y, n, 1, pal[ch]);
      x += n;
    }
  }
  return out;
}

/** Discrete keyTimes/values animate - the only kind used here. */
function step(attr, cycle, keys, values) {
  return `<animate attributeName="${attr}" dur="${cycle}s" repeatCount="indefinite" calcMode="discrete" keyTimes="${keys.map((k) => k.toFixed(5)).join(';')}" values="${values.join(';')}"/>`;
}

/** Visible from t0 to t1 within the cycle, hidden otherwise. */
function visible(t0, t1, cycle) {
  const keys = [0, t0 / cycle];
  const vals = ['0', '1'];
  if (t1 < cycle) { keys.push(t1 / cycle); vals.push('0'); }
  return step('opacity', cycle, keys, vals);
}

// --------------------------------------------------------------- sprites ----

// The CloseNI mark: ] [ - arms facing outward, verticals inward.
// A 5x4 mark for title bars. The full MARK is ten cells tall and overflows a
// six-cell title bar straight into the first line of output.
const MARK_SM = [
  'aa.aa',
  '.a.a.',
  '.a.a.',
  'aa.aa',
];

const MARK = [
  'aaaa...aaaa',
  '...a...a...',
  '...a...a...',
  '...a...a...',
  '...a...a...',
  '...a...a...',
  '...a...a...',
  '...a...a...',
  '...a...a...',
  'aaaa...aaaa',
];

const BUBBLE = [
  '.wwwwwwwwwwww.',
  'w............w',
  'w..d..d..d...w',
  'w............w',
  'w............w',
  '.wwwwwwwwwwww.',
  '..w.w.........',
  '..ww..........',
];

// Two gear frames sharing one body, with the teeth an eighth-turn apart.
// Alternating them reads as rotation while every pixel stays on the grid -
// an actual <animateTransform rotate> resamples the art off-grid and turns a
// pixel gear into a blurred diamond.
const GEAR_A = [
  '....ggg....',
  '....ggg....',
  '..ggggggg..',
  '..ggggggg..',
  'gggg...gggg',
  'gggg...gggg',
  'gggg...gggg',
  '..ggggggg..',
  '..ggggggg..',
  '....ggg....',
  '....ggg....',
];

const GEAR_B = [
  '...........',
  '.gg.....gg.',
  '.ggggggggg.',
  '..ggggggg..',
  '..gg...gg..',
  '..gg...gg..',
  '..gg...gg..',
  '..ggggggg..',
  '.ggggggggg.',
  '.gg.....gg.',
  '...........',
];

const BROWSER = [
  'wwwwwwwwwwwwwwwwww',
  'w................w',
  'w.r..y..g........w',
  'wwwwwwwwwwwwwwwwww',
  'w................w',
  'w..mmmmmmmm......w',
  'w................w',
  'w......uuuuuuuuu.w',
  'w................w',
  'w..mmmmm.........w',
  'w................w',
  'wwwwwwwwwwwwwwwwww',
];

const FILES = [
  '....ffffffff....',
  '....f......f....',
  '....f.tttt.f....',
  '..ffffffffff....',
  '..f........f....',
  '..f.tttttt.f....',
  'ffffffffffff....',
  'f..........f....',
  'f..tttttt..f....',
  'f..........f....',
  'f..tttt....f....',
  'ffffffffffff....',
];

const CHECK = [
  '......c',
  '.....cc',
  'c...cc.',
  'cc.cc..',
  '.ccc...',
  '..c....',
];


// -------------------------------------------------------------- pipeline ----
// Four pixel-art stations with packets that jump between them cell by cell.

function pipeline() {
  const CYCLE = 8;
  const COLS = 200;   // cells
  const ROWS = 50;
  const W = COLS * PX;
  const H = ROWS * PX;

  const pal = {
    w: C.text, d: C.dim, g: C.green, r: C.red, y: C.amber,
    m: C.dim, u: C.blue, a: C.white, f: C.text, t: C.dim, c: C.green, x: C.red,
  };

  const stations = [
    { x: 8,   label: 'YOU',       sub: 'a sentence',        accent: C.blue },
    { x: 58,  label: 'CLOSENI',   sub: 'plan · run · check', accent: C.green },
    { x: 108, label: 'CHAT SITE', sub: 'a real browser',    accent: C.violet },
    { x: 158, label: 'YOUR DISK', sub: 'files + a run file', accent: C.amber },
  ];
  const SW = 34; // station width in cells
  const SY = 9;  // station top
  const SH = 26;

  let g = '';

  stations.forEach((s, i) => {
    g += run(s.x, SY, SW, SH, C.panel);
    g += frame(s.x, SY, SW, SH, C.edge);
    g += run(s.x, SY, SW, 1, s.accent);

    const artY = SY + 4;
    if (i === 0) g += sprite(BUBBLE, s.x + 10, artY + 2, { w: C.blue, d: C.text });
    if (i === 1) {
      g += sprite(MARK, s.x + 6, artY + 1, { a: C.white });
      const gx = s.x + 20, gy = artY + 1;
      g += `<g opacity="1">${sprite(GEAR_A, gx, gy, { g: C.green })}` +
        `<animate attributeName="opacity" dur="0.64s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.5" values="1;0"/></g>`;
      g += `<g opacity="0">${sprite(GEAR_B, gx, gy, { g: C.green })}` +
        `<animate attributeName="opacity" dur="0.64s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.5" values="0;1"/></g>`;
    }
    if (i === 2) g += sprite(BROWSER, s.x + 8, artY + 1, pal);
    if (i === 3) g += sprite(FILES, s.x + 9, artY + 1, { f: C.amber, t: C.dim });

    g += `<text x="${(s.x + SW / 2) * PX}" y="${(SY + SH - 6) * PX}" fill="${C.text}" font-size="14" font-weight="600" text-anchor="middle" letter-spacing="1.6">${esc(s.label)}</text>`;
    g += `<text x="${(s.x + SW / 2) * PX}" y="${(SY + SH - 2.2) * PX}" fill="${C.dim}" font-size="11.5" text-anchor="middle">${esc(s.sub)}</text>`;
  });

  // Rails: a dashed row of single cells between stations.
  const railY = SY + 11;
  for (let i = 0; i < 3; i++) {
    const from = stations[i].x + SW + 1;
    const to = stations[i + 1].x - 1;
    for (let cx = from; cx < to; cx += 2) g += p(cx, railY, C.edge);

    // A 2x2 packet stepping one cell at a time - discrete, never tweened.
    const t0 = i * 0.85;
    const dur = 0.75;
    const cells = [];
    const keys = [];
    const n = to - from;
    for (let k = 0; k <= n; k++) {
      cells.push(((from + k) * PX).toString());
      keys.push((t0 + (k * dur) / n) / CYCLE);
    }
    const colour = [C.blue, C.green, C.violet][i];
    g += `<rect x="${from * PX}" y="${(railY - 0.5) * PX}" width="${PX * 2}" height="${PX * 2}" fill="${colour}" opacity="0">` +
      step('x', CYCLE, keys, cells) +
      step('opacity', CYCLE, [0, t0 / CYCLE, (t0 + dur) / CYCLE], ['0', '1', '0']) +
      `</rect>`;
  }

  // Return rail along the bottom: the review that gates the next step.
  const backY = SY + SH + 4;
  for (let cx = stations[0].x + 4; cx <= stations[3].x + SW - 4; cx += 2) g += p(cx, backY, C.edge);
  const bFrom = stations[3].x + SW - 4, bTo = stations[0].x + 4;
  const bKeys = [], bCells = [];
  const bn = bFrom - bTo;
  for (let k = 0; k <= bn; k++) {
    bCells.push(((bFrom - k) * PX).toString());
    bKeys.push((3.4 + (k * 1.6) / bn) / CYCLE);
  }
  g += `<rect x="${bFrom * PX}" y="${(backY - 0.5) * PX}" width="${PX * 2}" height="${PX * 2}" fill="${C.text}" opacity="0">` +
    step('x', CYCLE, bKeys, bCells) +
    step('opacity', CYCLE, [0, 3.4 / CYCLE, 5.0 / CYCLE], ['0', '1', '0']) + `</rect>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" shape-rendering="crispEdges" aria-label="A prompt travels from you to CloseNI, to a chat site, to files on your disk, and back to you for review">
<title>The loop CloseNI runs</title>
<rect width="${W}" height="${H}" fill="${C.bg}"/>
${frame(0, 0, COLS, ROWS, C.edge)}
<g font-family="${MONO}">
  <text x="${8 * PX}" y="${5.6 * PX}" fill="${C.dim}" font-size="12" letter-spacing="2.6">ONE STEP, END TO END</text>
  ${g}
  <text x="${(COLS / 2) * PX}" y="${(backY + 4) * PX}" fill="${C.dim}" font-size="12" text-anchor="middle" letter-spacing="1.2">EVERY STEP IS SHOWN TO YOU BEFORE THE NEXT ONE STARTS</text>
</g>
</svg>
`;
}

// ---------------------------------------------------------- themes strip ----

function themesStrip() {
  const THEMES = [
    ['Terminal', '#141414', '#e4e4e4'],
    ['Pixel', '#0d1117', '#56d364'],
    ['Midnight', '#0b0b0c', '#e8e8ea'],
    ['Paper', '#f7f7f5', '#1b1b1d'],
    ['Phosphor', '#020a04', '#7bffa0'],
    ['Amber', '#120b02', '#ffb638'],
    ['Cas · Indigo', '#0d0a1c', '#f08cff'],
    ['Cas · Miami', '#1a0715', '#ff7b9d'],
    ['Cas · Grid', '#0c0c13', '#79c0ff'],
    ['Blueprint', '#081a2e', '#8fc4ef'],
    ['Contrast', '#000000', '#ffffff'],
  ];
  const CYCLE = 11;
  const SWW = 20, SWH = 13, gap = 2;
  const COLS = THEMES.length * (SWW + gap) + 6;
  const ROWS = 26;
  const W = COLS * PX, H = ROWS * PX;

  let g = '';
  THEMES.forEach(([name, bg, fg], i) => {
    const x = 3 + i * (SWW + gap);
    const y = 6;
    g += run(x, y, SWW, SWH, bg);
    g += frame(x, y, SWW, SWH, C.edge);
    // A miniature of the app inside each swatch: title bar, mark, two rows.
    g += run(x + 1, y + 1, SWW - 2, 3, fg + '22');
    g += sprite(MARK_SM, x + 2, y + 2, { a: fg });
    g += run(x + 2, y + 6, 10, 1, fg + 'cc');
    g += run(x + 2, y + 8, 14, 1, fg + '77');
    g += run(x + 2, y + 10, 7, 1, fg + '55');

    // Selection bracket, one theme at a time.
    const t0 = (i * CYCLE) / THEMES.length;
    const t1 = ((i + 1) * CYCLE) / THEMES.length;
    g += `<g opacity="0">${frame(x - 1, y - 1, SWW + 2, SWH + 2, C.text)}${visible(t0, t1, CYCLE)}</g>`;
    g += `<g opacity="0"><text x="${(x + SWW / 2) * PX}" y="${(y + SWH + 4) * PX}" fill="${C.text}" font-size="11" text-anchor="middle" font-family="${MONO}">${esc(name)}</text>${visible(t0, t1, CYCLE)}</g>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" shape-rendering="crispEdges" aria-label="Eleven CloseNI themes, each shown as a miniature of the interface, cycling one at a time">
<title>Eleven themes</title>
<rect width="${W}" height="${H}" fill="${C.bg}"/>
<g font-family="${MONO}">
  <text x="${3 * PX}" y="${4 * PX}" fill="${C.dim}" font-size="10.5" letter-spacing="2.2">APPEARANCE</text>
  ${g}
</g>
</svg>
`;
}

// ============================================================== README art ==
// The larger pieces at the top of README.md. Same rules as everything above:
// whole cells, crisp edges, discrete steps only - nothing eases or tweens.

/** Deterministic pseudo-random numbers, so regenerating changes nothing. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}

/**
 * A discrete animation from [seconds, value] pairs. Discrete mode needs its
 * first key at 0, so one is added holding the first value.
 */
function track(attr, cycle, pairs) {
  const ps = pairs.slice().sort((a, b) => a[0] - b[0]);
  if (ps[0][0] > 0) ps.unshift([0, ps[0][1]]);
  const keys = [], vals = [];
  for (const [t, v] of ps) {
    const k = Math.round(Math.min(1, Math.max(0, t / cycle)) * 1e5) / 1e5;
    if (keys.length && k <= keys[keys.length - 1]) { vals[vals.length - 1] = v; continue; }
    keys.push(k); vals.push(v);
  }
  return `<animate attributeName="${attr}" dur="${cycle}s" repeatCount="indefinite" calcMode="discrete" keyTimes="${keys.map((k) => k.toFixed(5)).join(';')}" values="${vals.join(';')}"/>`;
}

/** Visible during each [t0, t1] window, hidden otherwise. */
function shown(windows, cycle) {
  const pairs = [[0, '0']];
  for (const [a, b] of windows) { pairs.push([a, '1']); if (b < cycle) pairs.push([b, '0']); }
  return track('opacity', cycle, pairs);
}

/** Every cell along an orthogonal polyline. */
function walk(points) {
  const out = [points[0].slice()];
  for (let i = 1; i < points.length; i++) {
    let [x, y] = out[out.length - 1];
    const [tx, ty] = points[i];
    while (x !== tx || y !== ty) { x += Math.sign(tx - x); y += Math.sign(ty - y); out.push([x, y]); }
  }
  return out;
}

/** A dotted rail along a polyline. */
function rail(points, fill = C.edge, gap = 2) {
  return walk(points).filter((_, k) => k % gap === 0).map(([x, y]) => p(x, y, fill)).join('');
}

/**
 * A packet hopping cell by cell along a polyline between t0 and t0 + dur,
 * with a fading trail of copies a step or two behind it.
 */
function travel(points, t0, dur, cycle, colour, trail = 2) {
  const cells = walk(points);
  const n = Math.max(1, cells.length - 1);
  const stepT = dur / n;
  let out = '';
  for (let tr = trail; tr >= 0; tr--) {
    const lag = tr * stepT * 1.5;
    const xs = [], ys = [];
    cells.forEach(([cx, cy], k) => {
      const t = t0 + lag + k * stepT;
      xs.push([t, cx * PX - PX / 2]);
      ys.push([t, cy * PX - PX / 2]);
    });
    const fill = tr === 0 ? colour : colour + (tr === 1 ? '88' : '40');
    out += `<rect x="${xs[0][1]}" y="${ys[0][1]}" width="${PX * 2}" height="${PX * 2}" fill="${fill}" opacity="0">` +
      track('x', cycle, xs) + track('y', cycle, ys) + shown([[t0 + lag, Math.min(cycle, t0 + lag + dur + stepT)]], cycle) + `</rect>`;
  }
  return out;
}

/** A panel with an accent bar, a title and an optional right-hand note. */
function panel(x, y, w, h, title, accent, sub) {
  let g = run(x, y, w, h, C.panel) + frame(x, y, w, h, C.edge) + run(x, y, w, 1, accent);
  g += `<text x="${(x + 2) * PX}" y="${(y + 4) * PX}" fill="${accent}" font-size="12.5" font-weight="700" letter-spacing="1.4">${esc(title)}</text>`;
  if (sub) g += `<text x="${(x + w - 2) * PX}" y="${(y + 4) * PX}" fill="${C.dim}" font-size="10.5" text-anchor="end">${esc(sub)}</text>`;
  return g;
}

/** A bright outline around a panel while it is doing something. */
function glow(x, y, w, h, colour, windows, cycle) {
  return `<g opacity="0">${frame(x - 1, y - 1, w + 2, h + 2, colour)}${run(x + 1, y + 1, w - 2, 1, colour + '66')}${shown(windows, cycle)}</g>`;
}

// A 5x7 pixel font, only the letters the logo needs.
const FONT = {
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
};

/** Runs of lit font pixels in one glyph row: [[x, n], ...]. */
function glyphRuns(row) {
  const out = [];
  let x = 0;
  while (x < row.length) {
    if (row[x] !== '#') { x++; continue; }
    let n = 1;
    while (x + n < row.length && row[x + n] === '#') n++;
    out.push([x, n]);
    x += n;
  }
  return out;
}

const RAMPS = {
  green: ['#e8fff1', '#b9f5cf', '#8be8b0', '#57d38c', '#3fb877', '#2f9a62', '#237a4d'],
  blue: ['#eef6ff', '#c5e1ff', '#9fcdff', '#79c0ff', '#58a6ff', '#3b82d6', '#2a64ad'],
  violet: ['#f6efff', '#e0cbff', '#cfaeff', '#bc8cff', '#a371f7', '#8957e5', '#6e40c9'],
  amber: ['#fff6dd', '#ffe6a6', '#f4cf6e', '#e3b341', '#d29922', '#b07d12', '#8a6008'],
  // The hero title: white fading to grey, top row to bottom.
  mono: ['#ffffff', '#ececec', '#d6d6d6', '#bdbdbd', '#a3a3a3', '#8a8a8a', '#717171'],
};

// ------------------------------------------------------------------ hero ----
// The logo boots letter by letter, gets swept by a shine, glitches on every
// palette change, and sits over a CRT: twinkling pixels, scanlines, a rolling
// band and two lights running round the frame.

function hero() {
  const COLS = 200, ROWS = 80, W = COLS * PX, H = ROWS * PX, CYCLE = 14;
  const rand = rng(1872004);
  const S = 3;                    // cells per font pixel
  const word = 'CLOSENI';
  const LW = 5 * S, GAP = S;
  const LOGO_W = word.length * LW + (word.length - 1) * GAP;
  const X0 = Math.floor((COLS - LOGO_W) / 2), Y0 = 13, LOGO_H = 7 * S;

  // Starfield, kept out of the logo and text block.
  let stars = '';
  for (let i = 0; i < 110; i++) {
    const x = 2 + Math.floor(rand() * (COLS - 4)), y = 8 + Math.floor(rand() * (ROWS - 10));
    if (x > X0 - 3 && x < X0 + LOGO_W + 3 && y > Y0 - 3 && y < 62) { continue; }
    const col = [C.dim, C.edge, C.blue, C.violet, C.green][Math.floor(rand() * 5)];
    const a = rand() * (CYCLE - 1.5), d = 0.2 + rand() * 0.9;
    stars += `<rect x="${x * PX}" y="${y * PX}" width="${PX}" height="${PX}" fill="${col}" opacity="0.3">` +
      track('opacity', CYCLE, [[0, '0.3'], [a, '1'], [a + d, '0.3']]) + `</rect>`;
  }

  // The logo, once as shape (for shadow, glitch copies and the clip) and once
  // per letter and row so each row can take its own colour from the ramp.
  let shape = '';
  let letters = '';
  // Monochrome: the title keeps its boot, shine and glitch, but no hue.
  const swaps = [[0, 'mono']];
  [...word].forEach((ch, i) => {
    const lx = X0 + i * (LW + GAP);
    let rows = '';
    FONT[ch].forEach((row, r) => {
      let rects = '';
      for (const [fx, n] of glyphRuns(row)) {
        const rect = `<rect x="${(lx + fx * S) * PX}" y="${(Y0 + r * S) * PX}" width="${n * S * PX}" height="${S * PX}"/>`;
        rects += rect;
        shape += rect;
      }
      rows += `<g fill="${RAMPS.mono[r]}">${rects}</g>`;
    });
    const t = 0.3 + i * 0.17;
    letters += `<g opacity="0">${rows}${shown([[t, t + 0.05], [t + 0.1, CYCLE - 0.25]], CYCLE)}</g>`;
  });
  const boot = 0.3 + word.length * 0.17 + 0.1;

  // Glitch: light and dark copies knocked sideways, plus torn scan bars.
  const glitchAt = [4.9, 7.4, 9.9, 12.4];
  const gw = glitchAt.flatMap((t) => [[t - 0.08, t], [t + 0.04, t + 0.12]]);
  const glitch =
    `<use href="#logo" x="${-2 * PX}" fill="#f5f5f5" opacity="0">${shown(gw, CYCLE)}</use>` +
    `<use href="#logo" x="${2 * PX}" y="${PX}" fill="#5c5c5c" opacity="0">${shown(gw, CYCLE)}</use>`;
  let tears = '';
  for (let k = 0; k < 7; k++) {
    const ty = Y0 + Math.floor(rand() * LOGO_H), tx = X0 - 6 + Math.floor(rand() * (LOGO_W - 10));
    const tw = 8 + Math.floor(rand() * 40);
    tears += `<rect x="${tx * PX}" y="${ty * PX}" width="${tw * PX}" height="${PX}" fill="${[C.white, C.bg, '#9a9a9a', '#dcdcdc'][k % 4]}" opacity="0">${shown(gw, CYCLE)}</rect>`;
  }

  // Shine: a stepped diagonal band swept across the letters, clipped to them.
  let band = '';
  for (let r = 0; r < LOGO_H; r++) band += run(Math.floor((LOGO_H - r) * 0.6), Y0 + r, 3, 1, '#ffffff');
  const sweep = [];
  for (let k = 0; k <= 34; k++) sweep.push([2.0 + k * 0.03, `${(X0 - 16 + k * 4) * PX},0`]);
  for (let k = 0; k <= 34; k++) sweep.push([8.4 + k * 0.03, `${(X0 - 16 + k * 4) * PX},0`]);
  const shine = `<g clip-path="url(#logoclip)"><g opacity="0.6"><animateTransform attributeName="transform" type="translate" dur="${CYCLE}s" repeatCount="indefinite" calcMode="discrete" ` +
    `keyTimes="0;${sweep.map(([t]) => (t / CYCLE).toFixed(5)).join(';')}" values="-4000,0;${sweep.map(([, v]) => v).join(';')}"/>${band}</g></g>`;

  // Typed subtitle.
  const sub = 'drives free web AI chats in a real browser: plans, writes, checks, repairs';
  const CW = 9.02, SX = Math.round((W - sub.length * CW) / 2), SY = 45 * PX;
  const typeKeys = [];
  for (let i = 0; i <= sub.length; i++) typeKeys.push([boot + 0.2 + i * 0.022, (i * CW).toFixed(2)]);
  typeKeys.push([CYCLE - 0.25, (sub.length * CW).toFixed(2)]);
  const typeClip = `<clipPath id="typed"><rect x="${SX}" y="${SY - 16}" height="22" width="0">${track('width', CYCLE, [[0, '0'], ...typeKeys, [CYCLE - 0.2, '0']])}</rect></clipPath>`;
  const caretX = typeKeys.map(([t, w]) => [t, (SX + Number(w)).toFixed(2)]);
  const caret = `<rect y="${SY - 13}" width="9" height="15" fill="#e4e4e4" x="${SX}" opacity="0">${track('x', CYCLE, caretX)}` +
    `${shown([[boot + 0.2, CYCLE - 0.25]], CYCLE)}</rect>`;
  const tagline = `<g opacity="0"><text x="${W / 2}" y="${50 * PX}" fill="${C.dim}" font-size="13" text-anchor="middle" letter-spacing="1.1">no API keys · no billing · the session you are already signed into</text>${shown([[boot + 2.0, CYCLE - 0.25]], CYCLE)}</g>`;

  // Provider chips.
  const chips = [
    ['DEEPSEEK', 'READY', C.green, 'steady'],
    ['QWEN STUDIO', 'COMING SOON', C.amber, 'blink'],
    ['GLM', 'COMING SOON', C.amber, 'blink'],
    ['OLLAMA', 'CHAT-ONLY', C.blue, 'steady'],
  ];
  const CHW = 42, CHG = 4, CX0 = Math.floor((COLS - (chips.length * CHW + (chips.length - 1) * CHG)) / 2), CY = 55;
  let chipG = '';
  chips.forEach(([name, state, col, mode], i) => {
    const x = CX0 + i * (CHW + CHG);
    const t = boot + 2.2 + i * 0.18;
    const led = mode === 'blink'
      ? `<g>${run(x + 2, CY + 2, 2, 2, col)}<animate attributeName="opacity" dur="0.9s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.55" values="1;0.15"/></g>`
      : `<g>${run(x + 2, CY + 2, 2, 2, col)}<animate attributeName="opacity" dur="2.4s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.92" values="1;0.3"/></g>`;
    chipG += `<g opacity="0">${run(x, CY, CHW, 6, C.panel)}${frame(x, CY, CHW, 6, col + '99')}${led}` +
      `<text x="${(x + 6) * PX}" y="${(CY + 3.9) * PX}" fill="${C.text}" font-size="12" font-weight="700" letter-spacing="1.1">${esc(name)}</text>` +
      `<text x="${(x + CHW - 2) * PX}" y="${(CY + 3.9) * PX}" fill="${col}" font-size="10.5" text-anchor="end" letter-spacing="0.8">${esc(state)}</text>` +
      shown([[t, t + 0.06], [t + 0.12, CYCLE - 0.25]], CYCLE) + `</g>`;
  });

  // Progress bar that fills in steps, then a runner that loops along it.
  const BX = 38, BY = 67, BW = 124;
  let bar = frame(BX, BY, BW, 4, C.edge);
  const fillPairs = [[0, '0']];
  for (let k = 0; k <= 24; k++) fillPairs.push([boot + 2.8 + k * 0.07, String(Math.round((k / 24) * (BW - 2)) * PX)]);
  fillPairs.push([CYCLE - 0.2, '0']);
  bar += `<rect x="${(BX + 1) * PX}" y="${(BY + 1) * PX}" height="${2 * PX}" width="0" fill="${C.green}55">${track('width', CYCLE, fillPairs)}</rect>`;
  bar += travel([[BX + 2, BY + 2], [BX + BW - 3, BY + 2]], boot + 4.7, 2.2, CYCLE, C.green, 3);
  bar += travel([[BX + 2, BY + 2], [BX + BW - 3, BY + 2]], boot + 7.5, 2.2, CYCLE, C.white, 3);
  const phases = ['PLAN', 'WRITE', 'CHECK', 'REPAIR', 'VERIFY', 'SHIP'];
  phases.forEach((ph, i) => {
    const t = boot + 4.6 + i * 1.1;
    const end = i === phases.length - 1 ? CYCLE - 0.25 : t + 1.1;
    bar += `<g opacity="0"><text x="${(BX + BW + 3) * PX}" y="${(BY + 3.2) * PX}" fill="${[C.blue, C.text, C.green, C.amber, C.green, C.violet][i]}" font-size="12" font-weight="700" letter-spacing="1.4">${ph}</text>${shown([[t, end]], CYCLE)}</g>`;
  });
  bar += `<text x="${(BX - 3) * PX}" y="${(BY + 3.2) * PX}" fill="${C.dim}" font-size="12" text-anchor="end" letter-spacing="1.4">BUILD</text>`;

  // Two lights running round the frame, half a lap apart.
  const per = [];
  for (let x = 0; x < COLS - 1; x += 2) per.push([x, 0]);
  for (let y = 0; y < ROWS - 1; y += 2) per.push([COLS - 1, y]);
  for (let x = COLS - 1; x > 0; x -= 2) per.push([x, ROWS - 1]);
  for (let y = ROWS - 1; y > 0; y -= 2) per.push([0, y]);
  const LAP = 10;
  let lights = '';
  [[C.green, 0], [C.violet, 0.5]].forEach(([col, off]) => {
    const n = per.length;
    const rot = per.slice(Math.floor(off * n)).concat(per.slice(0, Math.floor(off * n)));
    const xs = rot.map(([x], k) => [(k / n) * LAP, x * PX]);
    const ys = rot.map(([, y], k) => [(k / n) * LAP, y * PX]);
    lights += `<rect width="${PX}" height="${PX}" fill="${col}" x="${xs[0][1]}" y="${ys[0][1]}">${track('x', LAP, xs)}${track('y', LAP, ys)}</rect>`;
  });

  // CRT: scanlines and a slow rolling band.
  let scan = '';
  for (let y = 0; y < H; y += 4) scan += `<rect x="0" y="${y}" width="${W}" height="1" fill="#000000" opacity="0.22"/>`;
  const rollPairs = [];
  for (let k = 0; k <= ROWS / 2; k++) rollPairs.push([k * (5 / (ROWS / 2)), String(k * 2 * PX)]);
  const roll = `<rect x="0" y="0" width="${W}" height="${4 * PX}" fill="#ffffff" opacity="0.035">${track('y', 5, rollPairs)}</rect>`;

  // Title bar, as in the banner below it.
  let chrome = run(1, 1, COLS - 2, 6, C.panel) + run(1, 7, COLS - 2, 1, C.edge);
  chrome += run(3, 3, 2, 2, C.edge) + run(6, 3, 2, 2, C.edge) + run(9, 3, 2, 2, C.edge);
  for (let i = 0; i < 3; i++) {
    chrome += `<g opacity="0">${run(3 + i * 3, 3, 2, 2, [C.red, C.amber, C.green][i])}` +
      `<animate attributeName="opacity" dur="1.5s" repeatCount="indefinite" calcMode="discrete" keyTimes="${(i / 3).toFixed(4)};${(i / 3 + 0.22).toFixed(4)}" values="1;0"/></g>`;
  }
  chrome += sprite(MARK_SM, 14, 3, { a: C.text });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" shape-rendering="crispEdges" aria-label="CloseNI: the logo boots up over a CRT screen, with the four providers and their status">
<title>CloseNI</title>
<defs>
<g id="logo">${shape}</g>
<clipPath id="logoclip">${shape}</clipPath>
${typeClip}
</defs>
<rect width="${W}" height="${H}" fill="${C.bg}"/>
${stars}
${frame(0, 0, COLS, ROWS, C.edge)}
${chrome}
<g font-family="${MONO}" font-size="12" letter-spacing="2.4" shape-rendering="auto">
  <text x="130" y="29" fill="${C.dim}">CLOSENI  //  BOOT</text>
  <text x="${W - 24}" y="30" fill="${C.dim}" text-anchor="end">NO API KEYS · A REAL BROWSER</text>
</g>
<g opacity="0"><use href="#logo" x="${PX}" y="${PX}" fill="${C.edge}"/>${shown([[boot, CYCLE - 0.25]], CYCLE)}</g>
${letters}
${shine}
${glitch}
${tears}
<g font-family="${MONO}" shape-rendering="auto">
  <g clip-path="url(#typed)"><text x="${SX}" y="${SY}" fill="${C.text}" font-size="15">${esc(sub)}</text></g>
  ${caret}
  ${tagline}
  ${chipG}
  ${bar}
</g>
${lights}
${scan}
${roll}
</svg>
`;
}

// ---------------------------------------------------------- architecture ----
// Every box is a real part of the code; every packet is a call it makes.

function architecture() {
  const COLS = 200, ROWS = 106, W = COLS * PX, H = ROWS * PX, CYCLE = 12;
  let g = '';

  const B = {
    desk: [3, 8, 46, 38],
    you: [3, 56, 46, 16],
    agent: [62, 8, 62, 38],
    web: [62, 56, 62, 38],
    chrome: [138, 8, 59, 38],
    ollama: [138, 52, 59, 10],
    net: [138, 68, 59, 10],
    disk: [138, 84, 59, 10],
  };

  const lines = (x, y, items, accent) => items.map(([name, desc], i) => {
    const ly = y + 8 + i * 3;
    return run(x + 2, ly - 1, 1, 1, accent) +
      `<text x="${(x + 4) * PX}" y="${ly * PX}" font-size="11.5"><tspan fill="${C.text}">${esc(name)}</tspan><tspan fill="${C.dim}">  ${esc(desc)}</tspan></text>`;
  }).join('');

  // Rails first, so boxes and packets sit on top.
  const R = {
    youUp: [[22, 56], [22, 46]], youDown: [[30, 46], [30, 56]],
    daOut: [[49, 20], [62, 20]], daBack: [[62, 27], [49, 27]],
    acOut: [[124, 18], [138, 18]], acBack: [[138, 24], [124, 24]],
    ao: [[124, 32], [130, 32], [130, 57], [138, 57]],
    oa: [[138, 59], [132, 59], [132, 34], [124, 34]],
    ad: [[124, 40], [127, 40], [127, 89], [138, 89]],
    aw: [[93, 46], [93, 56]],
    wc: [[124, 62], [135, 62], [135, 38], [138, 38]],
    wnOut: [[124, 72], [138, 72]], wnBack: [[138, 75], [124, 75]],
  };
  for (const [k, pts] of Object.entries(R)) g += rail(pts, k === 'aw' ? C.dim : C.edge, k === 'aw' ? 3 : 2);

  // Boxes.
  const [dx, dy, dw, dh] = B.desk;
  g += panel(dx, dy, dw, dh, 'DESKTOP', C.blue, 'Qt / QML');
  g += lines(dx, dy, [['qml/panels/', 'panels, diffs'], ['BuildState.qml', 'runs the steps'], ['scheduler.mjs', 'dependency graph'], ['src/*.cpp', 'git, files, keyring'], ['Theme.qml', 'eleven themes'], ['GitHubSafe.cpp', 'token redaction']], C.blue);

  const [ux, uy, uw, uh] = B.you;
  g += panel(ux, uy, uw, uh, 'YOU', C.white);
  g += sprite(BUBBLE, ux + 3, uy + 6, { w: C.white, d: C.text });
  g += `<text x="${(ux + 19) * PX}" y="${(uy + 9) * PX}" fill="${C.text}" font-size="11.5">approve the plan</text>`;
  g += `<text x="${(ux + 19) * PX}" y="${(uy + 12) * PX}" fill="${C.dim}" font-size="11.5">read every diff</text>`;

  const [ax, ay, aw, ah] = B.agent;
  g += panel(ax, ay, aw, ah, 'LOCAL-AGENT', C.green, 'TypeScript CLI');
  g += lines(ax, ay, [['PlaywrightController', 'send, wait, read'], ['parser', 'JSON repair'], ['patch applier', 'contained, backed up'], ['check planner', 'twelve languages'], ['command policy', 'confirmation floor'], ['run manifest', 'closeni.run.json']], C.green);

  const [wx, wy, ww, wh] = B.web;
  g += panel(wx, wy, ww, wh, 'SRC/WEB', C.violet, 'beside, not yet in builds');
  g += lines(wx, wy, [['session manager', 'isolated contexts'], ['UI state', 'AUTH_REQUIRED stops'], ['completion', 'stream, stop, stability'], ['extraction', 'DOM to typed blocks'], ['research', 'plan, search, cite'], ['webtest', 'identical scenarios']], C.violet);

  const [cx, cy, cw, ch] = B.chrome;
  g += panel(cx, cy, cw, ch, 'CHROMIUM', C.violet, 'Playwright');
  [['DeepSeek', 'READY', C.green], ['Qwen Studio', 'COMING SOON', C.amber], ['GLM', 'COMING SOON', C.amber]].forEach(([n, st, col], i) => {
    const y = cy + 7 + i * 7;
    g += run(cx + 2, y, cw - 4, 5, C.bg) + frame(cx + 2, y, cw - 4, 5, col + '77') + run(cx + 4, y + 2, 1, 1, col);
    g += `<text x="${(cx + 7) * PX}" y="${(y + 3.3) * PX}" fill="${C.text}" font-size="11.5" font-weight="600">${esc(n)}</text>`;
    g += `<text x="${(cx + cw - 4) * PX}" y="${(y + 3.3) * PX}" fill="${col}" font-size="10" text-anchor="end">${esc(st)}</text>`;
  });
  g += `<text x="${(cx + 2) * PX}" y="${(cy + 34) * PX}" fill="${C.dim}" font-size="11">one persistent profile per site</text>`;
  // DeepSeek streaming: its lamp flickers while a reply comes in.
  g += `<g opacity="0">${run(cx + 4, cy + 9, 1, 1, C.white)}<animate attributeName="opacity" dur="0.3s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.5" values="1;0"/></g>`;
  let bars = '';
  for (let k = 0; k < 8; k++) bars += `<rect x="${(cx + 24) * PX}" y="${(cy + 9) * PX}" height="${PX}" width="${(k + 1) * 3 * PX}" fill="${C.green}66" opacity="0">${shown([[1.5 + k * 0.18, k === 7 ? 3.0 : 1.5 + (k + 1) * 0.18]], CYCLE)}</rect>`;
  g += bars;

  const small = [['ollama', 'OLLAMA', C.blue, 'local HTTP · chat-only'], ['net', 'THE WEB', C.blue, 'search + pages · logged out'], ['disk', 'WORKSPACE', C.amber, 'your files · closeni.run.json']];
  for (const [k, title, col, sub] of small) {
    const [x, y, w, h] = B[k];
    g += panel(x, y, w, h, title, col);
    g += `<text x="${(x + 2) * PX}" y="${(y + 7.6) * PX}" fill="${C.dim}" font-size="11">${esc(sub)}</text>`;
  }

  // Activity outlines.
  const act = {
    you: [[0, 0.5], [5.5, 6.0]], desk: [[0.5, 1.0], [4.5, 5.5]],
    agent: [[1.0, 1.5], [3.5, 4.5], [6.0, 6.5], [9.4, 10.0], [10.9, 11.3]],
    chrome: [[1.5, 3.0], [8.8, 9.3]], disk: [[4.5, 5.0]], web: [[6.5, 8.8]],
    net: [[7.0, 7.4]], ollama: [[10.0, 10.3]],
  };
  const accent = { you: C.white, desk: C.blue, agent: C.green, chrome: C.violet, disk: C.amber, web: C.violet, net: C.blue, ollama: C.blue };
  for (const [k, w] of Object.entries(act)) { const [x, y, bw, bh] = B[k]; g += glow(x, y, bw, bh, accent[k], w, CYCLE); }

  // Packets.
  g += travel(R.youUp, 0.0, 0.5, CYCLE, C.white);
  g += travel(R.daOut, 0.5, 0.5, CYCLE, C.blue);
  g += travel(R.acOut, 1.0, 0.5, CYCLE, C.violet);
  g += travel(R.acBack, 3.0, 0.5, CYCLE, C.violet);
  g += travel(R.ad, 3.5, 1.0, CYCLE, C.amber);
  g += travel(R.daBack, 4.5, 0.5, CYCLE, C.green);
  g += travel(R.youDown, 5.0, 0.5, CYCLE, C.green);
  g += travel(R.aw, 6.0, 0.5, CYCLE, C.dim);
  g += travel(R.wnOut, 6.5, 0.5, CYCLE, C.blue);
  g += travel(R.wnBack, 7.4, 0.5, CYCLE, C.blue);
  g += travel(R.wc, 8.0, 0.8, CYCLE, C.violet);
  g += travel(R.ao, 9.4, 0.6, CYCLE, C.blue);
  g += travel(R.oa, 10.3, 0.6, CYCLE, C.blue);

  // Legend.
  const LX = 3, LY = 80;
  g += `<text x="${LX * PX}" y="${LY * PX}" fill="${C.dim}" font-size="11" letter-spacing="2">PACKETS</text>`;
  [[C.blue, 'a prompt, or a fetch'], [C.violet, 'Playwright driving a page'], [C.amber, 'a patch written to your files'], [C.green, 'a result on its way back to you'], [C.dim, 'src/web: built beside the controller']].forEach(([col, label], i) => {
    const y = LY + 3 + i * 3;
    g += run(LX, y - 1, 2, 2, col) + `<text x="${(LX + 4) * PX}" y="${(y + 0.6) * PX}" fill="${C.text}" font-size="11">${esc(label)}</text>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" shape-rendering="crispEdges" aria-label="Architecture: the desktop app spawns the local agent, which drives Chromium, writes to the workspace, and has the src/web layer beside it for research and live tests">
<title>CloseNI architecture</title>
<rect width="${W}" height="${H}" fill="${C.bg}"/>
${frame(0, 0, COLS, ROWS, C.edge)}
<g font-family="${MONO}">
  <text x="${3 * PX}" y="${4.4 * PX}" fill="${C.dim}" font-size="12" letter-spacing="2.4">ARCHITECTURE</text>
  <text x="${(COLS - 3) * PX}" y="${4.4 * PX}" fill="${C.dim}" font-size="11" text-anchor="end" letter-spacing="1">every packet is a call the code really makes</text>
  ${g}
</g>
</svg>
`;
}

const files = {
  'pipeline.svg': pipeline(),
  'themes-strip.svg': themesStrip(),
  'hero.svg': hero(),
  'architecture.svg': architecture(),
};

for (const [name, svg] of Object.entries(files)) {
  writeFileSync(resolve(OUT, name), svg);
  console.log(`${name.padEnd(18)} ${(svg.length / 1024).toFixed(1)} KB`);
}
