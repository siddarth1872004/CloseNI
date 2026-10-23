#!/usr/bin/env node
/*
 * Renders the Pages site and its pixel-art SVGs in a real browser and checks
 * what only a renderer can answer: does every diagram have something drawn on
 * its first frame, and does the site lay out at desktop and phone widths with
 * no stranded reveals, script errors or failed loads.
 *
 *   node scripts/verify-site.mjs      (npm run verify:site)
 *
 * The app's theme palettes are checked by the unit suite
 * (local-agent/test/app-unit.cjs, "theme palettes").
 */

import { chromium } from 'playwright';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let fail = 0, pass = 0;
const problems = [];

(async () => {
  const browser = await chromium.launch();

  // ------------------------------------------------------- pixel-art SVGs ----
  //
  // A diagram whose resting frame is empty reads as a broken image, and gets
  // reported as one. build-strip drew seven hollow boxes for the first second
  // of every seven-second cycle, and looked exactly like a failed load. Every
  // asset must have something on it the moment it appears.
  console.log('\n  Pixel-art SVGs: the frame you see first\n');
  {
    const dir = join(ROOT, 'docs/assets');
    const files = (await import('node:fs')).readdirSync(dir).filter((f) => f.endsWith('.svg'));
    const p = await browser.newPage({ viewport: { width: 1400, height: 500 } });
    await p.goto('about:blank');
    const fsMod = await import('node:fs');
    for (const f of files) {
      // A data URI rather than file://: an image loaded from file:// into a
      // page that is not itself file:// refuses to decode, and a canvas needs
      // same-origin pixels to be readable at all.
      const url = 'data:image/svg+xml;base64,' +
        Buffer.from(fsMod.readFileSync(join(dir, f))).toString('base64');
      // Drawn onto a canvas over a known background so "ink" can be counted.
      const ink = await p.evaluate(async (src) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = Math.min(img.naturalWidth, 1400);
        c.height = Math.min(img.naturalHeight, 500);
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#0b0d0f';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let lit = 0;
        for (let i = 0; i < d.length; i += 4) {
          // Anything meaningfully brighter than the backdrop counts as drawn.
          if (Math.abs(d[i] - 11) + Math.abs(d[i + 1] - 13) + Math.abs(d[i + 2] - 15) > 40) lit++;
        }
        return lit / (c.width * c.height);
      }, url);
      const ok = ink >= 0.02;
      if (ok) pass++; else { fail++; problems.push(`${f}: first frame is ${(ink * 100).toFixed(1)}% drawn - reads as a broken image`); }
      console.log(`    ${ok ? ' ok ' : 'FAIL'}  ${f.padEnd(20)} ${(ink * 100).toFixed(1)}% of the first frame is drawn`);
    }
    await p.close();
  }

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
