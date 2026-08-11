#!/usr/bin/env node
/*
 * Renders the application and the Pages site in a real browser and checks the
 * things only a renderer can answer: does every theme actually resolve, and is
 * the text in it readable.
 *
 *   node scripts/verify-visual.mjs
 *
 * The CSS lint in the unit suite proves each theme *declares* the whole
 * palette. It cannot prove the declared colours are legible together - a theme
 * can be complete and still put dark red on near-black. That is what this does.
 */

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const THEMES = require_themes();
function require_themes() {
  const src = readFileSync(join(ROOT, 'desktop/theme.js'), 'utf8');
  return [...src.matchAll(/\{ id: "([a-z-]+)",\s*name: "([^"]+)"/g)].map((m) => ({ id: m[1], name: m[2] }));
}

// Representative markup covering the classes that carry meaning. If a theme
// breaks, it breaks on one of these.
const FIXTURE = `
<div id="vtest" style="padding:20px">
  <div class="micro">MICRO LABEL</div>
  <p class="hint">A hint line.</p>
  <button class="btn">Button</button>
  <button class="btn invert">Primary</button>
  <div class="step-card"><span class="step-card-num">01</span>
    <span class="step-card-title">Step title</span>
    <span class="step-card-status done">done</span></div>
  <div class="step-card"><span class="step-card-status failed">failed</span></div>
  <div class="step-card"><span class="step-card-status running">running</span></div>
  <div class="step-card"><span class="step-card-status blocked">blocked</span></div>
  <pre class="diff"><span class="diff-line add">+ added line</span><span class="diff-line remove">- removed line</span><span class="diff-line same">  same line</span></pre>
  <div class="test-row"><span class="verdict pass">PASS</span><span class="verdict fail">FAIL</span></div>
</div>`;

const luminance = ([r, g, b]) => {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a, b) => {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};

let fail = 0, pass = 0;
const problems = [];

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // The renderer talks to the main process over the preload bridge, which does
  // not exist in a plain browser. Without a stub the page dies on api.onLog and
  // every measurement below is taken against a half-initialised DOM.
  await page.addInitScript(() => {
    // Resolves to [] rather than null: the renderer calls .length and .forEach
    // on several of these, and a null would fail the page for a reason that
    // has nothing to do with what is being measured.
    window.api = new Proxy({}, { get: () => () => Promise.resolve([]) });
  });

  await page.goto(pathToFileURL(join(ROOT, 'desktop/index.html')).href);
  await page.evaluate((html) => { document.body.insertAdjacentHTML('beforeend', html); }, FIXTURE);

  console.log('\n  Application themes\n');
  for (const t of THEMES) {
    await page.evaluate((id) => document.documentElement.setAttribute('data-theme', id), t.id);
    // Theme changes are animated (.step-card carries a bare `transition:.12s`).
    // Sampling early returns colours blended between the old palette and the
    // new one, which reads as a contrast failure in a theme that is fine.
    await page.waitForTimeout(700);

    const res = await page.evaluate(() => {
      const parse = (c) => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      const bgOf = (el) => {
        let n = el;
        while (n) {
          const c = getComputedStyle(n).backgroundColor;
          if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return parse(c);
          n = n.parentElement;
        }
        return parse(getComputedStyle(document.body).backgroundColor || 'rgb(0,0,0)');
      };
      const out = [];
      const sel = ['.micro', '.hint', '.btn', '.btn.invert', '.step-card-title',
        '.step-card-status.done', '.step-card-status.failed', '.step-card-status.running',
        '.step-card-status.blocked', '.diff-line.add', '.diff-line.remove', '.diff-line.same',
        '.verdict.pass', '.verdict.fail'];
      for (const s of sel) {
        const el = document.querySelector('#vtest ' + s);
        if (!el) { out.push({ s, missing: true }); continue; }
        out.push({ s, fg: parse(getComputedStyle(el).color), bg: bgOf(el) });
      }
      // Any custom property that failed to resolve shows up as an empty string.
      const cs = getComputedStyle(document.documentElement);
      const unresolved = [];
      for (const name of ['--bg', '--panel', '--txt', '--dim', '--mut', '--line', '--line-strong',
        '--ok', '--ok-bg', '--warn', '--warn-bg', '--err', '--err-bg', '--surface', '--inverse']) {
        if (!cs.getPropertyValue(name).trim()) unresolved.push(name);
      }
      return { out, unresolved };
    });

    let worst = { r: 99, s: '' };
    const bad = [];
    const weak = [];
    for (const row of res.out) {
      if (row.missing) continue;
      const r = ratio(row.fg, row.bg);
      if (r < worst.r) worst = { r, s: row.s };
      // 3.0 is the hard floor: below it the text is not de-emphasised, it is
      // gone. Between 3.0 and 4.5 is reported but not failed - those are the
      // deliberately muted labels, and holding them to body-text contrast
      // would mean having no muted text at all.
      if (r < 3.0) bad.push(`${row.s} ${r.toFixed(2)}:1`);
      else if (r < 4.5) weak.push(`${row.s} ${r.toFixed(1)}`);
    }
    const ok = bad.length === 0 && res.unresolved.length === 0;
    if (ok) pass++; else { fail++; problems.push(`${t.name}: ${[...bad, ...res.unresolved.map((u) => 'unresolved ' + u)].join(', ')}`); }
    console.log(`    ${ok ? ' ok ' : 'FAIL'}  ${t.name.padEnd(18)} worst ${worst.r.toFixed(2)}:1 on ${worst.s}` +
      (weak.length ? `   muted: ${weak.join(', ')}` : '') +
      (ok ? '' : `   <-- ${bad.concat(res.unresolved).join(', ')}`));
  }

  console.log(`\n    ${errors.length === 0 ? ' ok ' : 'FAIL'}  the app renderer raised no JS errors${errors.length ? ': ' + errors[0] : ''}`);
  if (errors.length) fail++; else pass++;

  // ---------------------------------------------------------------- site ----
  console.log('\n  Pages site\n');
  for (const [tag, w, h] of [['desktop', 1280, 900], ['mobile', 390, 760]]) {
    const p = await browser.newPage({ viewport: { width: w, height: h } });
    const errs = [];
    const bad = [];
    p.on('pageerror', (e) => errs.push(e.message));
    p.on('response', (r) => { if (r.status() >= 400) bad.push(r.url().split('/').pop()); });
    await p.goto(pathToFileURL(join(ROOT, 'docs/index.html')).href);
    // Lazy-loaded images grow the page as they arrive, so re-read the height
    // each step instead of trusting the value at the top.
    await p.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 250) {
        window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 60));
      }
      window.scrollTo(0, document.body.scrollHeight);
    });
    // Long enough to outlast the 4s reveal failsafe. Anything still hidden
    // after this is genuinely stranded, not merely below the fold.
    await p.waitForTimeout(4600);
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    const hidden = await p.evaluate(() =>
      [...document.querySelectorAll('.reveal')].filter((r) => getComputedStyle(r).opacity !== '1').length);
    const ok = !overflow && hidden === 0 && errs.length === 0 && bad.length === 0;
    if (ok) pass++; else { fail++; problems.push(`site ${tag}: overflow=${overflow} hidden=${hidden} errors=${errs.length} missing=${bad.join(',')}`); }
    console.log(`    ${ok ? ' ok ' : 'FAIL'}  ${tag.padEnd(10)} overflow ${overflow ? 'YES' : 'none'} · stranded reveals ${hidden} · js errors ${errs.length} · failed loads ${bad.length}`);
    await p.close();
  }

  await browser.close();

  console.log(`\n  ${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  if (fail) { console.log('\n  Problems:'); problems.forEach((x) => console.log('    · ' + x)); }
  console.log('');
  process.exit(fail === 0 ? 0 : 1);
})();
