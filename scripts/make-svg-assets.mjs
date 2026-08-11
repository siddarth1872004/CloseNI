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

const CROSS = [
  'x.....x',
  '.x...x.',
  '..x.x..',
  '...x...',
  '..x.x..',
  '.x...x.',
  'x.....x',
];

// ---------------------------------------------------------------- banner ----

function banner() {
  const W = 1200;
  const CYCLE = 16;
  const CW = 9.02;
  const LH = 25;
  const X = 34;
  const top = 76;

  const cmd = '$ closeni build "flask todo api with jwt auth"';
  const n = cmd.length;
  const keys = [];
  const widths = [];
  const cursors = [];
  for (let i = 0; i <= n; i++) {
    keys.push((i * 2.6) / n / CYCLE);
    widths.push((i * CW).toFixed(2));
    cursors.push((X + i * CW).toFixed(2));
  }
  keys.push(1); widths.push((n * CW).toFixed(2)); cursors.push((X + n * CW).toFixed(2));

  const clip =
    `<clipPath id="type"><rect x="${X}" y="${top - 17}" height="22" width="0">` +
    step('width', CYCLE, keys, widths) + `</rect></clipPath>`;
  const cursor =
    `<rect y="${top - 14}" width="${CW.toFixed(2)}" height="16" fill="${C.text}" x="${X}" shape-rendering="crispEdges">` +
    step('x', CYCLE, keys, cursors) +
    `<animate attributeName="opacity" dur="1.06s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.5" values="1;0"/></rect>`;

  const LABEL = 0, DETAIL = 9, TAG = 46, STATUS = 58;
  const rows = [
    [3.3, ['plan', C.dim, LABEL], ['7 steps  ·  about 11 min', C.text, DETAIL]],
    null,
    [4.1, ['step 1', C.dim, LABEL], ['requirements.txt, src/config.py', C.text, DETAIL], ['done', C.green, STATUS]],
    [4.7, ['step 2', C.dim, LABEL], ['src/models.py', C.text, DETAIL], ['done', C.green, STATUS]],
    [5.3, ['step 3', C.dim, LABEL], ['src/store.py', C.text, DETAIL], ['done', C.green, STATUS]],
    [5.9, ['step 4', C.dim, LABEL], ['src/routes.py', C.text, DETAIL], ['failed', C.red, STATUS]],
    [6.5, ['SyntaxError: line 41 · unmatched brace → sent back to the model', C.amber, DETAIL]],
    [7.4, ['step 4', C.dim, LABEL], ['src/routes.py', C.text, DETAIL], ['retry', C.amber, TAG], ['done', C.green, STATUS]],
    [8.0, ['step 5', C.dim, LABEL], ['src/server.py', C.text, DETAIL], ['done', C.green, STATUS]],
    null,
    [8.9, ['7/7', C.green, LABEL], ['verified · wrote closeni.run.json · run: ./run.sh', C.text, DETAIL]],
  ];

  let body = '';
  rows.forEach((row, i) => {
    if (!row) return;
    const [t0, ...cells] = row;
    const y = top + (i + 1) * LH + 14;
    const spans = cells.map(([txt, fill, col]) => {
      const weight = fill === C.green || fill === C.red ? '600' : '400';
      return `<text x="${(X + col * CW).toFixed(1)}" y="${y}" fill="${fill}" font-weight="${weight}">${esc(txt)}</text>`;
    }).join('');
    body += `<g opacity="0">${spans}${visible(t0, CYCLE, CYCLE)}</g>`;
  });

  const H = top + rows.length * LH + 36;

  // Pixel chrome: square lights and the small mark, all inside the title bar
  // (rows 1-6). The three lights blink in sequence while the build runs.
  let chrome = run(3, 3, 2, 2, C.edge) + run(6, 3, 2, 2, C.edge) + run(9, 3, 2, 2, C.edge);
  for (let i = 0; i < 3; i++) {
    chrome += `<g opacity="0">${run(3 + i * 3, 3, 2, 2, C.green)}` +
      `<animate attributeName="opacity" dur="1.5s" repeatCount="indefinite" calcMode="discrete" keyTimes="${(i / 3).toFixed(4)};${(i / 3 + 0.22).toFixed(4)}" values="1;0"/></g>`;
  }
  chrome += sprite(MARK_SM, 14, 3, { a: C.text });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" shape-rendering="crispEdges" aria-label="CloseNI planning and building a Flask todo API, one step at a time">
<title>CloseNI — a build in progress</title>
<defs>${clip}</defs>
<rect width="${W}" height="${H}" fill="${C.bg}"/>
${frame(0, 0, W / PX, H / PX, C.edge)}
${run(1, 1, W / PX - 2, 6, C.panel)}
${run(1, 7, W / PX - 2, 1, C.edge)}
${chrome}
<g font-family="${MONO}" font-size="12" letter-spacing="2.4" shape-rendering="auto">
  <text x="130" y="29" fill="${C.dim}">CLOSENI</text>
  <text x="${W - 24}" y="30" fill="${C.dim}" text-anchor="end">NO API KEYS</text>
</g>
<g font-family="${MONO}" font-size="15" shape-rendering="auto">
  <g clip-path="url(#type)"><text x="${X}" y="${top}" fill="${C.text}">${esc(cmd)}</text></g>
  ${cursor}
  ${body}
</g>
</svg>
`;
}

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

// ------------------------------------------------------------ repair loop ----
// A filmstrip of one file's actual state, rather than four labelled boxes.

function repairLoop() {
  const CYCLE = 9;
  const COLS = 214;
  const ROWS = 52;
  const W = COLS * PX;
  const H = ROWS * PX;

  const PANW = 46;
  const PANH = 30;
  const PY = 10;
  const gap = 6;
  const x0 = 6;

  const panels = [
    { t: 'WRITE',  sub: 'model returns a file', accent: C.violet, state: 'plain' },
    { t: 'CHECK',  sub: 'python3 -m py_compile', accent: C.blue,  state: 'fail' },
    { t: 'REPAIR', sub: 'the real error goes back', accent: C.amber, state: 'fixing' },
    { t: 'PASS',   sub: 'step 4 done', accent: C.green, state: 'pass' },
  ];

  const at = [0.4, 2.2, 4.2, 6.2];

  let g = '';
  panels.forEach((pan, i) => {
    const x = x0 + i * (PANW + gap);
    g += run(x, PY, PANW, PANH, C.panel);
    g += frame(x, PY, PANW, PANH, C.edge);

    // Lit accent bar - only while this panel is the active one.
    g += `<g opacity="0">${run(x, PY, PANW, 1, pan.accent)}${visible(at[i], i === 3 ? CYCLE : at[i + 1], CYCLE)}</g>`;
    g += `<g opacity="0.35">${run(x, PY, PANW, 1, C.edge2)}</g>`;

    // The file sprite, coloured by what this frame is showing.
    const fileCol = pan.state === 'fail' ? C.red : pan.state === 'pass' ? C.green : pan.state === 'fixing' ? C.amber : C.dim;
    g += sprite(FILES, x + 4, PY + 6, { f: fileCol, t: C.dim });

    // Code lines beside it: the failing line flips red, then amber, then green.
    // Kept short enough to clear the status badge in the corner - a check mark
    // sitting on top of the code reads as a rendering fault, not a status.
    const lines = [8, 11, 6, 12, 9, 6];
    lines.forEach((len, li) => {
      const ly = PY + 8 + li * 2;
      let col = C.edge;
      if (li === 3) col = pan.state === 'fail' ? C.red : pan.state === 'fixing' ? C.amber : pan.state === 'pass' ? C.green : C.edge;
      g += run(x + 22, ly, len, 1, col);
    });

    if (pan.state === 'fail') g += sprite(CROSS, x + PANW - 9, PY + 3, { x: C.red });
    if (pan.state === 'pass') g += sprite(CHECK, x + PANW - 9, PY + 3, { c: C.green });

    g += `<text x="${(x + 3) * PX}" y="${(PY + PANH - 5) * PX}" fill="${C.text}" font-size="13" font-weight="600" letter-spacing="1.6">${esc(pan.t)}</text>`;
    g += `<text x="${(x + 3) * PX}" y="${(PY + PANH - 1.6) * PX}" fill="${C.dim}" font-size="11">${esc(pan.sub)}</text>`;

    // Pixel arrow to the next panel.
    if (i < 3) {
      const ax = x + PANW + 1;
      const ay = PY + Math.floor(PANH / 2);
      g += p(ax, ay - 1, C.edge) + p(ax + 1, ay, C.edge) + p(ax, ay + 1, C.edge);
      g += `<g opacity="0">${p(ax, ay - 1, C.text)}${p(ax + 1, ay, C.text)}${p(ax, ay + 1, C.text)}${visible(at[i + 1] - 0.25, at[i + 1] + 0.25, CYCLE)}</g>`;
    }
  });

  // Attempt budget, spelled out: two slots, the second one never needed here.
  const by = PY + PANH + 4;
  g += `<text x="${x0 * PX}" y="${(by + 1.6) * PX}" fill="${C.dim}" font-size="11.5" letter-spacing="1.4">REPAIR BUDGET</text>`;
  for (let k = 0; k < 2; k++) {
    const bx = x0 + 26 + k * 5;
    g += frame(bx, by, 4, 3, C.edge);
    if (k === 0) g += `<g opacity="0">${run(bx + 1, by + 1, 2, 1, C.amber)}${visible(4.2, CYCLE, CYCLE)}</g>`;
  }
  g += `<text x="${(x0 + 38) * PX}" y="${(by + 1.6) * PX}" fill="${C.dim}" font-size="11.5">two attempts per step, then it stops and tells you</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" shape-rendering="crispEdges" aria-label="One file across four frames: written, failing a compile check, repaired from the real error, then passing">
<title>What happens when a step fails</title>
<rect width="${W}" height="${H}" fill="${C.bg}"/>
${frame(0, 0, COLS, ROWS, C.edge)}
<g font-family="${MONO}">
  <text x="${x0 * PX}" y="${6.4 * PX}" fill="${C.dim}" font-size="12" letter-spacing="2.6">WHEN A STEP FAILS</text>
  ${g}
</g>
</svg>
`;
}

// ------------------------------------------------- pixel strip for the site --
// A compact looping build strip the Pages hero can sit beside.

function buildStrip() {
  const CYCLE = 7;
  const COLS = 142;
  const ROWS = 22;
  const W = COLS * PX;
  const H = ROWS * PX;

  let g = '';
  const y = 8;
  const n = 7;
  const bw = 15;
  const outcome = ['ok', 'ok', 'ok', 'fail', 'ok', 'ok', 'ok'];

  for (let i = 0; i < n; i++) {
    const x = 4 + i * (bw + 3);
    g += frame(x, y, bw, 6, C.edge);
    // A resting fill, so no frame of the animation is blank.
    //
    // These boxes used to be empty outlines until their fill animated in, which
    // meant the first second of every seven-second cycle showed seven hollow
    // rectangles - indistinguishable from an image that failed to load, and
    // reported as exactly that. A pending step now looks pending.
    g += run(x + 1, y + 1, bw - 2, 4, C.edge2);
    const t0 = 0.35 + i * 0.7;
    const col = outcome[i] === 'fail' ? C.red : C.green;
    g += `<g opacity="0">${run(x + 1, y + 1, bw - 2, 4, col)}${visible(t0, CYCLE, CYCLE)}</g>`;
    // the failing block flips to green when the repair lands
    if (outcome[i] === 'fail') {
      g += `<g opacity="0">${run(x + 1, y + 1, bw - 2, 4, C.green)}${visible(t0 + 1.4, CYCLE, CYCLE)}</g>`;
      g += `<g opacity="0">${sprite(CROSS, x + 4, y - 8, { x: C.red })}${visible(t0, t0 + 1.4, CYCLE)}</g>`;
    }
    g += `<text x="${(x + bw / 2) * PX}" y="${(y + 9) * PX}" fill="${C.dim}" font-size="10" text-anchor="middle">${i + 1}</text>`;
  }
  g += `<g opacity="0">${sprite(CHECK, COLS - 8, y + 1, { c: C.green })}${visible(6.0, CYCLE, CYCLE)}</g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" shape-rendering="crispEdges" aria-label="Seven build steps filling in, one failing and turning green after a repair">
<title>Seven steps, one repair</title>
<rect width="${W}" height="${H}" fill="none"/>
<g font-family="${MONO}">
  <text x="${4 * PX}" y="${4.6 * PX}" fill="${C.dim}" font-size="10.5" letter-spacing="2.2">BUILD</text>
  ${g}
</g>
</svg>
`;
}

// ---------------------------------------------------------------- divider ----
// A rule made of pixels, with a few brighter ones marching along it.

function divider() {
  const COLS = 200;
  const ROWS = 3;
  const W = COLS * PX;
  const H = ROWS * PX;
  const CYCLE = 5;

  let g = '';
  for (let cx = 0; cx < COLS; cx += 2) g += p(cx, 1, C.edge);

  // Three lit pixels chasing each other, stepping cell by cell.
  [C.green, C.blue, C.violet].forEach((col, i) => {
    const keys = [];
    const xs = [];
    const n = COLS / 2;
    for (let k = 0; k <= n; k++) { xs.push((k * 2 * PX).toString()); keys.push(k / n); }
    g += `<rect x="0" y="${PX}" width="${PX}" height="${PX}" fill="${col}">` +
      `<animate attributeName="x" dur="${CYCLE}s" begin="${(i * 0.18).toFixed(2)}s" repeatCount="indefinite" calcMode="discrete" keyTimes="${keys.map((k) => k.toFixed(5)).join(';')}" values="${xs.join(';')}"/>` +
      `</rect>`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="presentation" shape-rendering="crispEdges" aria-hidden="true">
<rect width="${W}" height="${H}" fill="none"/>${g}
</svg>
`;
}

// ---------------------------------------------------------- themes strip ----

function themesStrip() {
  const THEMES = [
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
  const CYCLE = 9;
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

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" shape-rendering="crispEdges" aria-label="Nine CloseNI themes, each shown as a miniature of the interface, cycling one at a time">
<title>Nine themes</title>
<rect width="${W}" height="${H}" fill="${C.bg}"/>
<g font-family="${MONO}">
  <text x="${3 * PX}" y="${4 * PX}" fill="${C.dim}" font-size="10.5" letter-spacing="2.2">APPEARANCE</text>
  ${g}
</g>
</svg>
`;
}

// ---------------------------------------------------------- verify strip ----

function verifyStrip() {
  const LANGS = ['rust', 'go', 'typescript', 'java', 'c#', 'c', 'c++', 'python', 'javascript', 'ruby', 'php', 'shell'];
  const CYCLE = 8;
  // Wide enough for "javascript" plus a check with clear space between them.
  const CHW = 24, CHH = 8, gapX = 2, gapY = 3;
  const perRow = 4;
  const rows = Math.ceil(LANGS.length / perRow);
  const COLS = perRow * (CHW + gapX) + 6;
  const ROWS = 8 + rows * (CHH + gapY) + 6;
  const W = COLS * PX, H = ROWS * PX;

  let g = '';
  LANGS.forEach((name, i) => {
    const col = i % perRow, row = Math.floor(i / perRow);
    const x = 3 + col * (CHW + gapX);
    const y = 8 + row * (CHH + gapY);
    g += frame(x, y, CHW, CHH, C.edge);

    const t0 = 0.35 + i * 0.42;
    // Lit state is a left accent bar, not a green outline. A one-cell frame is
    // six pixels of solid colour and swamps a chip this size.
    g += `<g opacity="0">` +
      run(x, y, 1, CHH, C.green) +
      run(x + 1, y + 1, CHW - 2, CHH - 2, '#57d38c12') +
      sprite(CHECK, x + CHW - 8, y + 1, { c: C.green }) +
      `<text x="${(x + 3) * PX}" y="${(y + CHH - 2.4) * PX}" fill="${C.green}" font-size="10.5" font-family="${MONO}">${esc(name)}</text>` +
      visible(t0, CYCLE, CYCLE) + `</g>`;

    g += `<text x="${(x + 3) * PX}" y="${(y + CHH - 2.4) * PX}" fill="${C.dim}" font-size="10.5" font-family="${MONO}">${esc(name)}</text>`;
  });

  const capY = 8 + rows * (CHH + gapY) + 3;
  g += `<g opacity="0"><text x="${3 * PX}" y="${capY * PX}" fill="${C.green}" font-size="12" font-family="${MONO}" letter-spacing="1.2">12/12 CHECKED</text>${visible(0.35 + 12 * 0.42, CYCLE, CYCLE)}</g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" shape-rendering="crispEdges" aria-label="Twelve languages checking green one after another">
<title>Twelve languages checked</title>
<rect width="${W}" height="${H}" fill="${C.bg}"/>
<g font-family="${MONO}">
  <text x="${3 * PX}" y="${4 * PX}" fill="${C.dim}" font-size="10.5" letter-spacing="2.2">VERIFICATION</text>
  ${g}
</g>
</svg>
`;
}

const files = {
  'banner.svg': banner(),
  'pipeline.svg': pipeline(),
  'repair-loop.svg': repairLoop(),
  'build-strip.svg': buildStrip(),
  'divider.svg': divider(),
  'themes-strip.svg': themesStrip(),
  'verify-strip.svg': verifyStrip(),
};

for (const [name, svg] of Object.entries(files)) {
  writeFileSync(resolve(OUT, name), svg);
  console.log(`${name.padEnd(18)} ${(svg.length / 1024).toFixed(1)} KB`);
}
