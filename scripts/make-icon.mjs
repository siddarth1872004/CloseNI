/*
 * Rasterise build/icon.svg to build/icon.png at 512x512.
 *
 *   source scripts/wsl-env.sh
 *   node scripts/make-icon.mjs
 *
 * electron-builder cannot read SVG. Rather than add an image library for one
 * file, this uses the Chromium the project already depends on. The PNG is
 * committed, so a build never needs a browser - run this only when the mark
 * changes.
 */
import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";

const repo = path.resolve(import.meta.dirname, "..");
const svg = fs.readFileSync(path.join(repo, "build", "icon.svg"), "utf-8");
const out = path.join(repo, "build", "icon.png");

// The mark is drawn in currentColor and sits on a dark ground inside the app.
// An installer icon has no page behind it, so the background is painted here.
const page = `<!doctype html><html><body style="margin:0;background:#0b0b0c;color:#e8e8ea">
<div id="m" style="width:512px;height:512px;display:flex;align-items:center;justify-content:center">
  <div style="width:340px;height:340px">${svg}</div>
</div></body></html>`;

const browser = await chromium.launch();
const p = await browser.newPage({ viewport: { width: 512, height: 512 } });
await p.setContent(page);
await p.locator("#m").screenshot({ path: out });
await browser.close();

const png = fs.readFileSync(out);
console.log("wrote " + out + "  " + png.readUInt32BE(16) + "x" + png.readUInt32BE(20));
