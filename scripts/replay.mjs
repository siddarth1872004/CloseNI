#!/usr/bin/env node
/*
 * Run the real extractors against recorded provider markup.
 *
 *   npm run replay
 *
 * docs/NEXT.md asked for record-and-replay of a real session's network traffic.
 * That turned out to be unusable: a HAR of a signed-in DeepSeek session is 4.1MB
 * carrying live cookies on 13 requests and Authorization on 11, so it is a
 * credential file and can never be committed. A scrubber that misses one field
 * leaks a session.
 *
 * The markup is the part worth keeping anyway. Every expensive bug this project
 * has had was in reading the page - a frozen selector, a virtualised list,
 * highlighting shredded across spans - and none of that needs the network. The
 * fixture is 9KB of real DeepSeek output with no headers, no cookies and no
 * URLs beyond the SVG namespace.
 *
 * No account, no network, and it drives the REAL controller methods rather than
 * a copy of them.
 */
import { chromium } from "playwright";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require_ = createRequire(import.meta.url);
const { PlaywrightController } = require_(join(ROOT, "local-agent", "dist", "providers", "playwright-controller.js"));
const config = JSON.parse(readFileSync(join(ROOT, "local-agent", "config", "providers", "deepseek.json"), "utf8"));
const markup = readFileSync(join(ROOT, "local-agent", "test", "fixtures", "replay", "deepseek-reply.html"), "utf8");

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log("   ok   " + label); }
  else { fail++; console.log("  FAIL  " + label + (detail ? "  (" + String(detail).slice(0, 120) + ")" : "")); }
}

console.log("\n  Replay — real provider markup, no network, no account\n  " + "-".repeat(58));

const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setContent("<html><body>" + markup + "</body></html>");

const controller = new PlaywrightController(config);
controller.attachPageForReplay(page);

const count = await controller.countMessages(config);
check("the assistant selector matches the recorded reply", count > 0, "matched " + count);

const text = await controller.getLastMessageText(config);
check("text comes back", text.trim().length > 0, text.length + " chars");
check("the prose is there", /slug/i.test(text), text.slice(0, 60));

const inner = await controller.getLastMessageInnerText(config);
check("innerText extraction works too", inner.trim().length > 0, inner.length + " chars");

const structured = await controller.getLastMessageStructured(config);
check("structured extraction works", structured.trim().length > 0, structured.length + " chars");

// The reason this fixture is worth having: the code is shredded across dozens of
// Prism <span class="token ..."> elements, and un-shredding it is where reading
// a page goes wrong.
check("the code block is recovered as one fenced block",
  /```/.test(structured), structured.slice(0, 80));
check("and its code is contiguous, not split by highlighting spans",
  /def\s+slugify\s*\(/.test(structured), (structured.match(/def[^\n]*/) || [""])[0]);
check("prose before the code survives",
  structured.indexOf("```") > 20, "fence at " + structured.indexOf("```"));
check("prose after the code survives",
  structured.lastIndexOf("```") < structured.length - 20,
  "last fence at " + structured.lastIndexOf("```") + " of " + structured.length);

await browser.close();
console.log("  " + "-".repeat(58));
console.log("  " + (fail === 0 ? "PASS" : "FAIL") + " — " + pass + " passed, " + fail + " failed\n");
process.exit(fail === 0 ? 0 : 1);
