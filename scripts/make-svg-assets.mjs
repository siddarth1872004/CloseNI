#!/usr/bin/env node
// Generates the animated SVGs used by README.md.
//
// GitHub renders repo-relative SVGs through its image proxy and strips <script>
// and (unreliably) <style>. SMIL animation elements survive, so every animation
// here is expressed as <animate> / <animateMotion> with no CSS and no JS.
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
  panel: '#101418',
  bar: '#161b22',
  edge: '#212934',
  text: '#c9d1d9',
  dim: '#6b7684',
  faint: '#3d4655',
  green: '#57d38c',
  red: '#ff7b72',
  amber: '#e3b341',
  blue: '#79c0ff',
  violet: '#bc8cff',
};

const MONO = "ui-monospace,'SF Mono','DejaVu Sans Mono',Menlo,Consolas,monospace";

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Opacity animate that fades in at `t0` and holds for the rest of `cycle`. */
function fadeIn(t0, cycle, ramp = 0.28) {
  const k = [0, t0 / cycle, (t0 + ramp) / cycle, 1].map((n) => n.toFixed(5));
  return `<animate attributeName="opacity" dur="${cycle}s" repeatCount="indefinite" keyTimes="${k.join(';')}" values="0;0;1;1" calcMode="linear"/>`;
}

/** Character-by-character reveal driven by a clipPath rect. */
function typewriter(id, x, y, w, h, chars, charW, typeDur, cycle) {
  const values = [];
  const keys = [];
  for (let i = 0; i <= chars; i++) {
    values.push((i * charW).toFixed(2));
    keys.push(((i * typeDur) / chars / cycle).toFixed(5));
  }
  values.push((chars * charW).toFixed(2));
  keys.push('1');
  const clip =
    `<clipPath id="${id}"><rect x="${x}" y="${y}" height="${h}" width="0">` +
    `<animate attributeName="width" dur="${cycle}s" repeatCount="indefinite" calcMode="discrete"` +
    ` keyTimes="${keys.join(';')}" values="${values.join(';')}"/></rect></clipPath>`;
  const cursorX = [];
  for (let i = 0; i <= chars; i++) cursorX.push((x + i * charW).toFixed(2));
  cursorX.push((x + chars * charW).toFixed(2));
  const cursor =
    `<rect y="${y + 3}" width="${charW.toFixed(2)}" height="${h - 6}" fill="${C.text}" x="${x}">` +
    `<animate attributeName="x" dur="${cycle}s" repeatCount="indefinite" calcMode="discrete"` +
    ` keyTimes="${keys.join(';')}" values="${cursorX.join(';')}"/>` +
    `<animate attributeName="opacity" dur="1.06s" repeatCount="indefinite" calcMode="discrete"` +
    ` keyTimes="0;0.5" values="1;0"/></rect>`;
  return { clip, cursor, width: w };
}

// ---------------------------------------------------------------- banner ----

function banner() {
  const W = 1200;
  const CYCLE = 16;
  const CW = 9.02; // advance width of 15px monospace
  const LH = 25;
  const X = 34;
  const top = 76;

  const cmd = '$ closeni build "flask todo api with jwt auth"';
  const tw = typewriter('type', X, top - 17, cmd.length * CW, 22, cmd.length, CW, 2.6, CYCLE);

  // Fixed columns keep the status stack readable: label | detail | tag | status
  const LABEL = 0;
  const DETAIL = 9;
  const TAG = 46;
  const STATUS = 58;

  // rows: [appearTime, [text, colour, column]...]
  const rows = [
    [3.3, ['plan', C.dim, LABEL], ['7 steps  ·  about 11 min', C.text, DETAIL]],
    null,
    [4.1, ['step 1', C.dim, LABEL], ['requirements.txt, src/config.py', C.text, DETAIL], ['done', C.green, STATUS]],
    [4.7, ['step 2', C.dim, LABEL], ['src/models.py', C.text, DETAIL], ['done', C.green, STATUS]],
    [5.3, ['step 3', C.dim, LABEL], ['src/store.py', C.text, DETAIL], ['parallel', C.violet, TAG], ['done', C.green, STATUS]],
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
    const spans = cells
      .map(([txt, fill, col]) => {
        const cx = X + col * CW;
        const weight = fill === C.green || fill === C.red ? '600' : '400';
        return `<text x="${cx.toFixed(1)}" y="${y}" fill="${fill}" font-weight="${weight}">${esc(txt)}</text>`;
      })
      .join('');
    body += `<g opacity="0">${spans}${fadeIn(t0, CYCLE)}</g>`;
  });

  const H = top + rows.length * LH + 36;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="CloseNI planning and building a Flask todo API, one step at a time">
<title>CloseNI — a build in progress</title>
<defs>
${tw.clip}
<linearGradient id="glow" x1="0" y1="0" x2="1" y2="1">
  <stop offset="0" stop-color="#1c2430"/><stop offset="1" stop-color="#0b0d0f"/>
</linearGradient>
</defs>
<rect width="${W}" height="${H}" rx="12" fill="url(#glow)"/>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" fill="none" stroke="${C.edge}"/>
<rect x="1" y="1" width="${W - 2}" height="40" rx="11" fill="${C.bar}"/>
<rect x="1" y="30" width="${W - 2}" height="12" fill="${C.bar}"/>
<line x1="1" y1="41.5" x2="${W - 1}" y2="41.5" stroke="${C.edge}"/>
<circle cx="24" cy="21" r="5" fill="#2d3540"/><circle cx="42" cy="21" r="5" fill="#2d3540"/><circle cx="60" cy="21" r="5" fill="#2d3540"/>
<g font-family="${MONO}" font-size="12" letter-spacing="2.4">
  <text x="84" y="25" fill="${C.dim}">CLOSENI</text>
  <text x="${W - 34}" y="25" fill="${C.faint}" text-anchor="end">NO API KEYS</text>
</g>
<g font-family="${MONO}" font-size="15">
  <g clip-path="url(#type)"><text x="${X}" y="${top}" fill="${C.text}">${esc(cmd)}</text></g>
  ${tw.cursor}
  ${body}
</g>
</svg>
`;
}

// -------------------------------------------------------------- pipeline ----

function pipeline() {
  const W = 1200;
  const H = 250;
  const CYCLE = 8;
  const boxes = [
    ['YOU', 'a sentence', 40],
    ['CLOSENI', 'plan · steps · checks', 330],
    ['CHAT SITE', 'a real browser tab', 620],
    ['YOUR DISK', 'files, plus a run file', 910],
  ];
  const BW = 250;
  const BH = 84;
  const BY = 74;

  let out = '';
  boxes.forEach(([title, sub, x], i) => {
    const accent = [C.blue, C.green, C.violet, C.amber][i];
    out += `<g>
  <rect x="${x}" y="${BY}" width="${BW}" height="${BH}" rx="10" fill="${C.panel}" stroke="${C.edge}"/>
  <rect x="${x}" y="${BY}" width="3" height="${BH}" rx="1.5" fill="${accent}"/>
  <text x="${x + 22}" y="${BY + 35}" fill="${C.text}" font-size="16" font-weight="600" letter-spacing="1.6">${esc(title)}</text>
  <text x="${x + 22}" y="${BY + 60}" fill="${C.dim}" font-size="13">${esc(sub)}</text>
</g>`;
  });

  // connecting rails + travelling packets
  for (let i = 0; i < 3; i++) {
    const x1 = boxes[i][2] + BW;
    const x2 = boxes[i + 1][2];
    const y = BY + BH / 2;
    out += `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${C.edge}" stroke-width="2"/>`;
    out += `<path d="M ${x2 - 11} ${y - 5} L ${x2 - 2} ${y} L ${x2 - 11} ${y + 5} Z" fill="${C.faint}"/>`;
    const delay = (i * 0.9).toFixed(2);
    out += `<circle r="4.5" fill="${C.green}" opacity="0">
  <animate attributeName="opacity" dur="${CYCLE}s" repeatCount="indefinite" keyTimes="0;${(delay / CYCLE).toFixed(4)};${((+delay + 0.1) / CYCLE).toFixed(4)};${((+delay + 0.85) / CYCLE).toFixed(4)};${((+delay + 0.95) / CYCLE).toFixed(4)};1" values="0;0;1;1;0;0"/>
  <animateMotion dur="${CYCLE}s" repeatCount="indefinite" keyTimes="0;${(delay / CYCLE).toFixed(4)};${((+delay + 0.9) / CYCLE).toFixed(4)};1" values="0,0;0,0;0,0;0,0" path="M ${x1} ${y} L ${x2 - 12} ${y}" calcMode="linear"/>
</circle>`;
  }

  // return path: disk -> you (the review loop)
  const ry = BY + BH + 46;
  out += `<path d="M ${boxes[3][2] + 40} ${BY + BH} L ${boxes[3][2] + 40} ${ry} L ${boxes[0][2] + 40} ${ry} L ${boxes[0][2] + 40} ${BY + BH}" fill="none" stroke="${C.edge}" stroke-width="2" stroke-dasharray="5 5"/>
<text x="${W / 2}" y="${ry + 22}" fill="${C.dim}" font-size="12.5" text-anchor="middle" letter-spacing="1.4">EVERY STEP IS SHOWN TO YOU BEFORE THE NEXT ONE STARTS</text>
<circle r="4" fill="${C.blue}">
  <animateMotion dur="${CYCLE}s" repeatCount="indefinite" keyPoints="0;0;1;1" keyTimes="0;0.36;0.72;1" calcMode="linear"
    path="M ${boxes[3][2] + 40} ${BY + BH} L ${boxes[3][2] + 40} ${ry} L ${boxes[0][2] + 40} ${ry} L ${boxes[0][2] + 40} ${BY + BH}"/>
</circle>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="A prompt travels from you to CloseNI, to a chat site, to files on your disk, and back to you for review">
<title>The loop CloseNI runs</title>
<rect width="${W}" height="${H}" rx="12" fill="${C.bg}"/>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" fill="none" stroke="${C.edge}"/>
<g font-family="${MONO}">
  <text x="40" y="42" fill="${C.dim}" font-size="12.5" letter-spacing="2.6">ONE STEP, END TO END</text>
  ${out}
</g>
</svg>
`;
}

// ------------------------------------------------------------ repair loop ----

function repairLoop() {
  const W = 1200;
  const H = 300;
  const CYCLE = 9;
  const cx = 600;
  const cy = 158;
  const rx = 400;
  const ry = 92;

  const nodes = [
    ['ASK', 'the step, as a prompt', -1, 0, C.blue],
    ['WRITE', 'files land on disk', 0, -1, C.violet],
    ['CHECK', 'compiler, not vibes', 1, 0, C.green],
    ['REPAIR', 'the real error goes back', 0, 1, C.amber],
  ];

  let g = '';
  g += `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="${C.edge}" stroke-width="2" stroke-dasharray="6 7"/>`;

  nodes.forEach(([title, sub, ux, uy, accent]) => {
    const x = cx + ux * rx;
    const y = cy + uy * ry;
    const bw = 210;
    const bh = 68;
    g += `<rect x="${x - bw / 2}" y="${y - bh / 2}" width="${bw}" height="${bh}" rx="10" fill="${C.panel}" stroke="${C.edge}"/>
<rect x="${x - bw / 2}" y="${y - bh / 2}" width="${bw}" height="3" rx="1.5" fill="${accent}"/>
<text x="${x}" y="${y - 4}" fill="${C.text}" font-size="15" font-weight="600" text-anchor="middle" letter-spacing="1.8">${esc(title)}</text>
<text x="${x}" y="${y + 18}" fill="${C.dim}" font-size="12.5" text-anchor="middle">${esc(sub)}</text>`;
  });

  const path = `M ${cx - rx} ${cy} A ${rx} ${ry} 0 0 1 ${cx} ${cy - ry} A ${rx} ${ry} 0 0 1 ${cx + rx} ${cy} A ${rx} ${ry} 0 0 1 ${cx} ${cy + ry} A ${rx} ${ry} 0 0 1 ${cx - rx} ${cy}`;
  g += `<circle r="6" fill="${C.green}"><animateMotion dur="${CYCLE}s" repeatCount="indefinite" path="${path}" calcMode="linear"/>
  <animate attributeName="fill" dur="${CYCLE}s" repeatCount="indefinite" calcMode="discrete" keyTimes="0;0.25;0.5;0.75" values="${C.blue};${C.violet};${C.green};${C.amber}"/></circle>`;
  g += `<circle r="12" fill="${C.green}" opacity="0.14"><animateMotion dur="${CYCLE}s" repeatCount="indefinite" path="${path}" calcMode="linear"/></circle>`;

  g += `<text x="${cx}" y="${cy - 12}" fill="${C.text}" font-size="14" text-anchor="middle" letter-spacing="1.6">TWO REPAIR ATTEMPTS PER STEP</text>
<text x="${cx}" y="${cy + 12}" fill="${C.dim}" font-size="12.5" text-anchor="middle">then it stops and tells you, instead of writing broken code forever</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="A loop: ask, write, check with a real compiler, feed the error back, retry twice at most">
<title>What happens when a step fails</title>
<rect width="${W}" height="${H}" rx="12" fill="${C.bg}"/>
<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="12" fill="none" stroke="${C.edge}"/>
<g font-family="${MONO}">
  <text x="40" y="42" fill="${C.dim}" font-size="12.5" letter-spacing="2.6">WHEN A STEP FAILS</text>
  ${g}
</g>
</svg>
`;
}

const files = {
  'banner.svg': banner(),
  'pipeline.svg': pipeline(),
  'repair-loop.svg': repairLoop(),
};

for (const [name, svg] of Object.entries(files)) {
  const p = resolve(OUT, name);
  writeFileSync(p, svg);
  console.log(`${name.padEnd(18)} ${(svg.length / 1024).toFixed(1)} KB`);
}
