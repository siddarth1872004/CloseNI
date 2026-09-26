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
  const swaps = [[0, 'green'], [4.9, 'blue'], [7.4, 'violet'], [9.9, 'amber'], [12.4, 'green']];
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
      rows += `<g fill="${RAMPS.green[r]}">${track('fill', CYCLE, swaps.map(([t, k]) => [t, RAMPS[k][r]]))}${rects}</g>`;
    });
    const t = 0.3 + i * 0.17;
    letters += `<g opacity="0">${rows}${shown([[t, t + 0.05], [t + 0.1, CYCLE - 0.25]], CYCLE)}</g>`;
  });
  const boot = 0.3 + word.length * 0.17 + 0.1;

  // Glitch: red and cyan copies knocked sideways, plus torn scan bars.
  const glitchAt = [4.9, 7.4, 9.9, 12.4];
  const gw = glitchAt.flatMap((t) => [[t - 0.08, t], [t + 0.04, t + 0.12]]);
  const glitch =
    `<use href="#logo" x="${-2 * PX}" fill="#ff7b72" opacity="0">${shown(gw, CYCLE)}</use>` +
    `<use href="#logo" x="${2 * PX}" y="${PX}" fill="#39d0d8" opacity="0">${shown(gw, CYCLE)}</use>`;
  let tears = '';
  for (let k = 0; k < 7; k++) {
    const ty = Y0 + Math.floor(rand() * LOGO_H), tx = X0 - 6 + Math.floor(rand() * (LOGO_W - 10));
    const tw = 8 + Math.floor(rand() * 40);
    tears += `<rect x="${tx * PX}" y="${ty * PX}" width="${tw * PX}" height="${PX}" fill="${[C.white, C.bg, '#39d0d8', '#ff7b72'][k % 4]}" opacity="0">${shown(gw, CYCLE)}</rect>`;
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
  const caret = `<rect y="${SY - 13}" width="9" height="15" fill="${C.green}" x="${SX}" opacity="0">${track('x', CYCLE, caretX)}` +
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
  g += panel(dx, dy, dw, dh, 'DESKTOP', C.blue, 'Electron');
  g += lines(dx, dy, [['renderer.js', 'panels, diffs'], ['builder.js', 'runs the steps'], ['scheduler.js', 'dependency graph'], ['main.js', 'IPC, git, keystore'], ['theme.js', 'nine themes'], ['github-safe.js', 'token redaction']], C.blue);

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

// ------------------------------------------------------------- UI states ----
// The page-state machine, with a mock of the page the detector is looking at.

function uiStates() {
  const COLS = 200, ROWS = 68, W = COLS * PX, H = ROWS * PX, CYCLE = 16;
  const NW = 27, NH = 7;
  const N = {
    LOADING: [3, 20, C.dim],
    CHAT_READY: [37, 10, C.green],
    GENERATING: [70, 10, C.blue],
    GENERATION_COMPLETE: [103, 10, C.green],
    AUTH_REQUIRED: [70, 30, C.red],
    CAPTCHA: [70, 40, C.amber],
    RATE_LIMITED: [70, 50, C.amber],
  };
  const slots = [
    ['LOADING', 0, 1.2, 'document loading · busy indicator'],
    ['CHAT_READY', 1.2, 2.6, 'composer visible and enabled'],
    ['GENERATING', 2.6, 5.2, 'stop control visible · text changing'],
    ['GENERATION_COMPLETE', 5.2, 6.4, 'reply request closed · 1s settle'],
    ['CHAT_READY', 6.4, 7.2, 'ready for the next prompt'],
    ['LOADING', 7.2, 8.0, 'a new page load'],
    ['AUTH_REQUIRED', 8.0, 10.0, 'password field · no chat composer'],
    ['LOADING', 10.0, 10.6, 'a new page load'],
    ['CAPTCHA', 10.6, 12.4, 'a challenge widget is on the page'],
    ['LOADING', 12.4, 13.0, 'a new page load'],
    ['RATE_LIMITED', 13.0, 15.2, 'HTTP 429 on the reply request'],
  ];
  const winsFor = (name) => slots.filter((s) => s[0] === name).map((s) => [s[1], s[2]]);

  let g = '';
  const R = {
    r1: [[30, 23], [33, 23], [33, 13], [36, 13]],
    r2: [[97 - 33, 13], [69, 13]],
    r3: [[97, 13], [102, 13]],
    r4: [[116, 9], [116, 6], [50, 6], [50, 9]],
    b1: [[16, 28], [16, 33], [69, 33]],
    b2: [[16, 28], [16, 43], [69, 43]],
    b3: [[16, 28], [16, 53], [69, 53]],
    s1: [[97, 33], [102, 33]],
    s2: [[97, 43], [102, 43]],
    s3: [[97, 53], [102, 53]],
  };
  for (const pts of Object.values(R)) g += rail(pts);
  g += `<text x="${18 * PX}" y="${(60.5) * PX}" fill="${C.dim}" font-size="10.5">on load, or after a prompt is sent</text>`;

  for (const [name, [x, y, col]] of Object.entries(N)) {
    g += run(x, y, NW, NH, C.panel) + frame(x, y, NW, NH, C.edge) + run(x, y, 1, NH, col);
    g += `<text x="${(x + NW / 2 + 0.5) * PX}" y="${(y + 4.4) * PX}" fill="${C.dim}" font-size="10.5" text-anchor="middle" letter-spacing="0.4">${name}</text>`;
    const w = winsFor(name);
    g += `<g opacity="0">${run(x, y, NW, NH, col + '26')}${frame(x - 1, y - 1, NW + 2, NH + 2, col)}` +
      `<text x="${(x + NW / 2 + 0.5) * PX}" y="${(y + 4.4) * PX}" fill="${col}" font-size="10.5" font-weight="700" text-anchor="middle" letter-spacing="0.4">${name}</text>${shown(w, CYCLE)}</g>`;
  }

  // The stop block.
  const SX = 103, SY = 30, SW = 27, SH = 27;
  g += run(SX, SY, SW, SH, C.panel) + frame(SX, SY, SW, SH, C.edge);
  g += `<text x="${(SX + SW / 2) * PX}" y="${(SY + 7) * PX}" fill="${C.text}" font-size="13" font-weight="700" text-anchor="middle" letter-spacing="2">THE RUN</text>`;
  g += `<text x="${(SX + SW / 2) * PX}" y="${(SY + 10) * PX}" fill="${C.text}" font-size="13" font-weight="700" text-anchor="middle" letter-spacing="2">STOPS</text>`;
  ['recorded', 'diagnostics saved', 'never bypassed', 'no sign-in tried'].forEach((t, i) => {
    g += `<text x="${(SX + SW / 2) * PX}" y="${(SY + 15 + i * 2.6) * PX}" fill="${C.dim}" font-size="10.5" text-anchor="middle">${t}</text>`;
  });
  g += `<g opacity="0">${frame(SX - 1, SY - 1, SW + 2, SH + 2, C.red)}${run(SX, SY, SW, SH, '#ff7b7218')}` +
    `<animate attributeName="opacity" dur="${CYCLE}s" repeatCount="indefinite" calcMode="discrete" keyTimes="${[0, 8.5, 8.7, 8.9, 10.0, 11.1, 11.3, 11.5, 12.4, 13.5, 13.7, 13.9, 15.2].map((t) => (t / CYCLE).toFixed(5)).join(';')}" values="0;1;0;1;0;1;0;1;0;1;0;1;0"/></g>`;

  // Packets at each transition.
  g += travel(R.r1, 1.0, 0.25, CYCLE, C.green);
  g += travel(R.r2, 2.4, 0.2, CYCLE, C.blue);
  g += travel(R.r3, 5.0, 0.2, CYCLE, C.green);
  g += travel(R.r4, 6.0, 0.4, CYCLE, C.green);
  g += travel(R.b1, 7.7, 0.35, CYCLE, C.red);
  g += travel(R.b2, 10.3, 0.35, CYCLE, C.amber);
  g += travel(R.b3, 12.7, 0.35, CYCLE, C.amber);
  g += travel(R.s1, 8.4, 0.15, CYCLE, C.red);
  g += travel(R.s2, 11.0, 0.15, CYCLE, C.amber);
  g += travel(R.s3, 13.4, 0.15, CYCLE, C.amber);

  // The detector panel: a small page, what it shows, and the verdict.
  const PX0 = 136, PY0 = 8, PW = 61, PH = 54;
  g += panel(PX0, PY0, PW, PH, 'WHAT THE DETECTOR SEES', C.dim);
  const mx = PX0 + 3, my = PY0 + 7, mw = PW - 6, mh = 28;
  g += run(mx, my, mw, mh, C.bg) + frame(mx, my, mw, mh, C.edge) + run(mx, my, mw, 3, C.edge2);
  g += run(mx + 2, my + 1, 1, 1, C.red) + run(mx + 4, my + 1, 1, 1, C.amber) + run(mx + 6, my + 1, 1, 1, C.green);
  const inPage = (inner, name) => `<g opacity="0">${inner}${shown(winsFor(name), CYCLE)}</g>`;
  // LOADING: the two gear frames alternating.
  g += inPage(`<g>${sprite(GEAR_A, mx + 22, my + 9, { g: C.dim })}<animate attributeName="opacity" dur="0.5s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.5" values="1;0"/></g>` +
    `<g opacity="0">${sprite(GEAR_B, mx + 22, my + 9, { g: C.dim })}<animate attributeName="opacity" dur="0.5s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.5" values="0;1"/></g>`, 'LOADING');
  // CHAT_READY: an empty composer with a blinking caret.
  const composer = (extra = '') => run(mx + 3, my + mh - 6, mw - 6, 4, C.panel) + frame(mx + 3, my + mh - 6, mw - 6, 4, C.green + '99') + extra;
  g += inPage(composer(`<g>${run(mx + 5, my + mh - 5, 1, 2, C.green)}<animate attributeName="opacity" dur="0.8s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.5" values="1;0"/></g>`), 'CHAT_READY');
  // GENERATING: reply bars growing, stop control lit.
  let grow = '';
  for (let k = 0; k < 10; k++) {
    const t0 = 2.7 + k * 0.24, t1 = k === 9 ? 5.2 : 2.7 + (k + 1) * 0.24;
    const w1 = Math.min(mw - 8, 4 + k * 6), w2 = Math.max(0, Math.min(mw - 14, (k - 3) * 6)), w3 = Math.max(0, (k - 6) * 6);
    grow += `<g opacity="0">${run(mx + 3, my + 5, w1, 1, C.text)}${w2 ? run(mx + 3, my + 8, w2, 1, C.text) : ''}${w3 ? run(mx + 3, my + 11, w3, 1, C.text) : ''}${shown([[t0, t1]], CYCLE)}</g>`;
  }
  g += grow + inPage(composer(`<g>${run(mx + mw - 8, my + mh - 5, 2, 2, C.red)}<animate attributeName="opacity" dur="0.4s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.5" values="1;0.2"/></g>`), 'GENERATING');
  // COMPLETE: full reply and a tick.
  g += inPage(run(mx + 3, my + 5, mw - 8, 1, C.text) + run(mx + 3, my + 8, mw - 14, 1, C.text) + run(mx + 3, my + 11, 18, 1, C.text) + sprite(CHECK, mx + mw - 11, my + 8, { c: C.green }) + composer(), 'GENERATION_COMPLETE');
  // AUTH_REQUIRED: a login form, no composer.
  g += inPage(`<text x="${(mx + 3) * PX}" y="${(my + 7) * PX}" fill="${C.text}" font-size="11">Log in</text>` +
    run(mx + 3, my + 9, mw - 20, 4, C.panel) + frame(mx + 3, my + 9, mw - 20, 4, C.edge) +
    run(mx + 3, my + 15, mw - 20, 4, C.panel) + frame(mx + 3, my + 15, mw - 20, 4, C.red) +
    `<text x="${(mx + 5) * PX}" y="${(my + 17.8) * PX}" fill="${C.red}" font-size="11" letter-spacing="2">••••••••</text>` +
    run(mx + 3, my + 21, 14, 4, C.red + '55'), 'AUTH_REQUIRED');
  // CAPTCHA: a tile grid and a box to tick.
  let tiles = '';
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) tiles += run(mx + 20 + c * 5, my + 6 + r * 5, 4, 4, (r + c) % 2 ? C.edge : C.amber + '55');
  g += inPage(tiles + frame(mx + 4, my + 12, 5, 5, C.amber), 'CAPTCHA');
  // RATE_LIMITED: a 429 banner.
  g += inPage(`<text x="${(mx + mw / 2) * PX}" y="${(my + 14) * PX}" fill="${C.amber}" font-size="26" font-weight="700" text-anchor="middle">429</text>` +
    `<text x="${(mx + mw / 2) * PX}" y="${(my + 19) * PX}" fill="${C.dim}" font-size="11" text-anchor="middle">Too many requests</text>`, 'RATE_LIMITED');

  // Evidence and verdict lines.
  slots.forEach(([name, a, b, why]) => {
    const col = N[name][2];
    g += `<g opacity="0"><text x="${(mx) * PX}" y="${(PY0 + 41) * PX}" fill="${C.text}" font-size="11">${esc(why)}</text>` +
      `<text x="${mx * PX}" y="${(PY0 + 45.5) * PX}" fill="${col}" font-size="12" font-weight="700" letter-spacing="0.8">→ ${name}</text>${shown([[a, b]], CYCLE)}</g>`;
  });
  g += `<text x="${mx * PX}" y="${(PY0 + 51) * PX}" fill="${C.dim}" font-size="10">order: challenge, login, 429, error, ready</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" shape-rendering="crispEdges" aria-label="The page states the browser layer tells apart: loading, ready, generating and complete, and the login, challenge and rate-limit states that stop a run">
<title>UI states</title>
<rect width="${W}" height="${H}" fill="${C.bg}"/>
${frame(0, 0, COLS, ROWS, C.edge)}
<g font-family="${MONO}">
  <text x="${3 * PX}" y="${4.4 * PX}" fill="${C.dim}" font-size="12" letter-spacing="2.4">PAGE STATE</text>
  ${g}
  <text x="${3 * PX}" y="${65 * PX}" fill="${C.dim}" font-size="10.5">classifyState() in local-agent/src/web/providers/state.ts · every rule unit-tested against signal sets</text>
</g>
</svg>
`;
}

// -------------------------------------------------------------- research ----

function research() {
  const COLS = 200, ROWS = 74, W = COLS * PX, H = ROWS * PX, CYCLE = 14;
  const SW = 28, SH = 40, SY = 10;
  const stageX = (i) => 3 + i * 33;
  const names = [['01 QUESTION', C.white], ['02 PLAN', C.blue], ['03 SEARCH', C.blue], ['04 READ', C.violet], ['05 EVIDENCE', C.amber], ['06 ANSWER', C.green]];
  const active = [[[0, 1.0]], [[1.0, 2.4]], [[2.6, 4.0], [7.8, 8.4]], [[4.0, 6.0], [8.2, 8.6]], [[6.0, 7.4], [8.6, 9.8]], [[10.0, 13.6]]];
  let g = '';

  // Rails between stages, and the loop back.
  for (let i = 0; i < 5; i++) g += rail([[stageX(i) + SW, SY + 20], [stageX(i + 1) - 1, SY + 20]]);
  const back = [[stageX(4) + 14, SY + SH], [stageX(4) + 14, SY + SH + 6], [stageX(2) + 14, SY + SH + 6], [stageX(2) + 14, SY + SH]];
  g += rail(back);
  g += `<text x="${(stageX(3) + 14) * PX}" y="${(SY + SH + 10) * PX}" fill="${C.dim}" font-size="11" text-anchor="middle">something still uncovered: another round, within the budget</text>`;

  names.forEach(([n, col], i) => {
    const x = stageX(i);
    g += panel(x, SY, SW, SH, n, col);
    g += glow(x, SY, SW, SH, col, active[i], CYCLE);
  });

  // 01: the question.
  let x = stageX(0);
  g += sprite(BUBBLE, x + 7, SY + 8, { w: C.white, d: C.text });
  g += `<text x="${(x + 2) * PX}" y="${(SY + 22) * PX}" fill="${C.text}" font-size="11">rate limits and</text>`;
  g += `<text x="${(x + 2) * PX}" y="${(SY + 25) * PX}" fill="${C.text}" font-size="11">performance?</text>`;

  // 02: three subquestions.
  x = stageX(1);
  ['rate limits', 'performance', 'official docs'].forEach((t, i) => {
    const y = SY + 7 + i * 6;
    const t0 = 1.2 + i * 0.25;
    g += `<g opacity="0">${run(x + 2, y, SW - 4, 4, C.bg)}${frame(x + 2, y, SW - 4, 4, C.blue + '99')}` +
      `<text x="${(x + 4) * PX}" y="${(y + 2.8) * PX}" fill="${C.text}" font-size="10.5">sq${i + 1} ${t}</text>${shown([[t0, CYCLE - 0.2]], CYCLE)}</g>`;
  });
  g += `<text x="${(x + 2) * PX}" y="${(SY + 30) * PX}" fill="${C.dim}" font-size="10">distinctive words</text>`;
  g += `<text x="${(x + 2) * PX}" y="${(SY + 33) * PX}" fill="${C.dim}" font-size="10">per subquestion</text>`;

  // 03: search backends light up one by one.
  x = stageX(2);
  ['browser engine', 'GitHub', 'provider search'].forEach((t, i) => {
    const y = SY + 7 + i * 6;
    g += run(x + 2, y, SW - 4, 4, C.bg) + frame(x + 2, y, SW - 4, 4, C.edge);
    g += `<text x="${(x + 4) * PX}" y="${(y + 2.8) * PX}" fill="${C.dim}" font-size="10.5">${t}</text>`;
    const t0 = 2.8 + i * 0.35;
    g += `<g opacity="0">${frame(x + 2, y, SW - 4, 4, C.blue)}<text x="${(x + 4) * PX}" y="${(y + 2.8) * PX}" fill="${C.blue}" font-size="10.5">${t}</text>${shown([[t0, 4.2], [7.9, 8.4]], CYCLE)}</g>`;
  });
  g += `<text x="${(x + 2) * PX}" y="${(SY + 30) * PX}" fill="${C.dim}" font-size="10">merged by</text>`;
  g += `<text x="${(x + 2) * PX}" y="${(SY + 33) * PX}" fill="${C.dim}" font-size="10">canonical URL</text>`;

  // 04: pages arrive; the mirror is struck out, an app shell escalates.
  x = stageX(3);
  const DOC = ['ddddd.', 'd...dd', 'd.tt.d', 'd....d', 'd.tttd', 'd....d', 'dddddd'];
  for (let k = 0; k < 7; k++) {
    const c = k % 3, r = Math.floor(k / 3);
    const dx = x + 3 + c * 8, dy = SY + 7 + r * 9;
    const t0 = k === 6 ? 8.3 : 4.2 + k * 0.25;
    const col = k === 6 ? C.green : C.violet;
    g += `<g opacity="0">${sprite(DOC, dx, dy, { d: col, t: C.dim })}${shown([[t0, CYCLE - 0.2]], CYCLE)}</g>`;
    if (k === 5) g += `<g opacity="0">${sprite(CROSS, dx, dy, { x: C.red })}${shown([[5.6, CYCLE - 0.2]], CYCLE)}</g>`;
    if (k === 2) g += `<g opacity="0">${frame(dx - 1, dy - 1, 8, 9, C.blue)}${shown([[5.0, CYCLE - 0.2]], CYCLE)}</g>`;
  }
  g += `<g opacity="0"><text x="${(x + 2) * PX}" y="${(SY + 33) * PX}" fill="${C.red}" font-size="10">mirror: not a 2nd source</text>${shown([[5.6, CYCLE - 0.2]], CYCLE)}</g>`;
  g += `<g opacity="0"><text x="${(x + 2) * PX}" y="${(SY + 36) * PX}" fill="${C.green}" font-size="10">+1 found via a link</text>${shown([[8.3, CYCLE - 0.2]], CYCLE)}</g>`;

  // 05: evidence lines, then the two contradictions flash.
  x = stageX(4);
  const ev = [['100 req/min', '[a]'], ['60 req/min', '[b]'], ['10,000 w/s', '[c]'], ['12,000 w/s', '[d]']];
  ev.forEach(([t, c], i) => {
    const y = SY + 8 + i * 4;
    g += `<g opacity="0"><text x="${(x + 2) * PX}" y="${y * PX}" fill="${C.text}" font-size="11">${t}</text>` +
      `<text x="${(x + SW - 2) * PX}" y="${y * PX}" fill="${C.dim}" font-size="10.5" text-anchor="end">${c}</text>${shown([[6.2 + i * 0.25, CYCLE - 0.2]], CYCLE)}</g>`;
    g += `<g opacity="0">${run(x + 1, y - 2, SW - 2, 3, '#ff7b7230')}<animate attributeName="opacity" dur="${CYCLE}s" repeatCount="indefinite" calcMode="discrete" keyTimes="${[0, 8.6, 8.9, 9.2, 9.5, 9.8].map((t) => (t / CYCLE).toFixed(5)).join(';')}" values="0;1;0;1;0;0"/></g>`;
  });
  g += `<g opacity="0"><text x="${(x + 2) * PX}" y="${(SY + 27) * PX}" fill="${C.red}" font-size="11" font-weight="700" letter-spacing="1">2 CONFLICTS</text>${shown([[8.6, CYCLE - 0.2]], CYCLE)}</g>`;
  g += `<text x="${(x + 2) * PX}" y="${(SY + 31) * PX}" fill="${C.dim}" font-size="10">same unit, sources</text>`;
  g += `<text x="${(x + 2) * PX}" y="${(SY + 34) * PX}" fill="${C.dim}" font-size="10">disagree: both kept</text>`;

  // 06: the answer, cited.
  x = stageX(5);
  g += `<g opacity="0">${sprite(CHECK, x + 10, SY + 7, { c: C.green })}` +
    ['every line cited', 'conflicts listed', 'gaps listed', 'source graph'].map((t, i) => `<text x="${(x + 2) * PX}" y="${(SY + 18 + i * 3.4) * PX}" fill="${i ? C.dim : C.green}" font-size="11">${t}</text>`).join('') +
    `${shown([[10.2, CYCLE - 0.2]], CYCLE)}</g>`;

  // Packets.
  const mid = SY + 20;
  const hop = (i, t, col) => travel([[stageX(i) + SW, mid], [stageX(i + 1) - 1, mid]], t, 0.2, CYCLE, col);
  g += hop(0, 0.9, C.white);
  g += hop(1, 2.4, C.blue);
  g += travel([[stageX(1) + SW, mid - 3], [stageX(2) - 1, mid - 3]], 2.5, 0.2, CYCLE, C.blue, 1);
  g += travel([[stageX(1) + SW, mid + 3], [stageX(2) - 1, mid + 3]], 2.6, 0.2, CYCLE, C.blue, 1);
  g += hop(2, 3.9, C.violet);
  g += hop(3, 5.9, C.amber);
  g += travel(back, 7.4, 0.4, CYCLE, C.amber);
  g += hop(4, 9.9, C.green);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" shape-rendering="crispEdges" aria-label="The research loop: a question is planned into subquestions, searched, read, turned into evidence with conflicts flagged, and answered with citations">
<title>Research loop</title>
<rect width="${W}" height="${H}" fill="${C.bg}"/>
${frame(0, 0, COLS, ROWS, C.edge)}
<g font-family="${MONO}">
  <text x="${3 * PX}" y="${4.4 * PX}" fill="${C.dim}" font-size="12" letter-spacing="2.4">RESEARCH</text>
  <text x="${(COLS - 3) * PX}" y="${4.4 * PX}" fill="${C.dim}" font-size="11" text-anchor="end">local-agent/src/web/research/agent.ts</text>
  ${g}
  <text x="${3 * PX}" y="${71 * PX}" fill="${C.dim}" font-size="10.5">On the fixture web it stops "sufficient", finds both planted contradictions, and does not count the mirror twice.</text>
</g>
</svg>
`;
}

// ----------------------------------------------------------------- stats ----
// Counters rolling up to the numbers the suites actually report.

function stats() {
  const tiles = [
    [1420, 'UNIT TESTS', 'npm test', C.green],
    [180, 'END-TO-END', 'real Chromium', C.blue],
    [199, 'BROWSER CHECKS', 'npm run test:web', C.violet],
    [12, 'LANGUAGES', 'syntax + compile', C.amber],
    [9, 'THEMES', 'one palette each', C.blue],
    [0, 'API KEYS', 'none, ever', C.red],
  ];
  const TW = 30, TG = 3, TH = 20, TY = 3;
  const COLS = 3 + tiles.length * (TW + TG), ROWS = TH + 6;
  const W = COLS * PX, H = ROWS * PX, CYCLE = 10, FR = 16;
  let g = '';
  tiles.forEach(([n, label, sub, col], i) => {
    const x = 3 + i * (TW + TG);
    g += run(x, TY, TW, TH, C.panel) + frame(x, TY, TW, TH, C.edge) + run(x, TY, TW, 1, col);
    const t0 = 0.3 + i * 0.3;
    const from = n === 0 ? 99 : 0;
    for (let k = 0; k <= FR; k++) {
      const e = 1 - Math.pow(1 - k / FR, 3);
      const v = Math.round(from + (n - from) * e);
      const a = t0 + k * 0.07, b = k === FR ? CYCLE - 0.3 : t0 + (k + 1) * 0.07;
      g += `<g opacity="0"><text x="${(x + 2) * PX}" y="${(TY + 10) * PX}" fill="${k === FR ? col : C.text}" font-size="34" font-weight="700">${v.toLocaleString('en-US')}</text>${shown([[a, b]], CYCLE)}</g>`;
    }
    g += `<text x="${(x + 2) * PX}" y="${(TY + 14.5) * PX}" fill="${C.text}" font-size="11.5" font-weight="700" letter-spacing="1.3">${esc(label)}</text>`;
    g += `<text x="${(x + 2) * PX}" y="${(TY + 17.5) * PX}" fill="${C.dim}" font-size="10.5">${esc(sub)}</text>`;
    const fill = [[0, '0']];
    for (let k = 0; k <= FR; k++) fill.push([t0 + k * 0.07, String(Math.round(((TW - 2) * k) / FR) * PX)]);
    fill.push([CYCLE - 0.3, '0']);
    g += `<rect x="${(x + 1) * PX}" y="${(TY + TH - 2) * PX}" height="${PX}" width="0" fill="${col}">${track('width', CYCLE, fill)}</rect>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" shape-rendering="crispEdges" aria-label="1420 unit tests, 180 end-to-end tests, 199 browser checks, twelve languages, nine themes, zero API keys">
<title>By the numbers</title>
<rect width="${W}" height="${H}" fill="${C.bg}"/>
<g font-family="${MONO}">${g}</g>
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
  'hero.svg': hero(),
  'architecture.svg': architecture(),
  'ui-states.svg': uiStates(),
  'research.svg': research(),
  'stats.svg': stats(),
};

for (const [name, svg] of Object.entries(files)) {
  writeFileSync(resolve(OUT, name), svg);
  console.log(`${name.padEnd(18)} ${(svg.length / 1024).toFixed(1)} KB`);
}
