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


/* ---- the long-prompt composer, against a React-style controlled textarea ----
 *
 * React does not use the prototype's value setter. It installs an OWN property
 * on the element - its value tracker - so `el.value = x` hits that shadow and
 * React never learns the text changed. The send control stays disabled and
 * Enter does nothing.
 *
 * A real build hit this the first time a conversation rolled over: a 6384
 * character seeded prompt went in, nothing sent, and the step sat at
 * "messages=0" for its whole 300s timeout. Reproduced here so it cannot come
 * back, without needing a provider or an account.
 */
const composer = await browser.newPage();
await composer.setContent("<html><body><textarea id=t></textarea></body></html>");
await composer.evaluate(() => {
  const el = document.getElementById("t");
  const w = window;
  w.__reactValue = "";
  const proto = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, "value");
  // The shadow React installs: writes here are recorded but never reach the
  // element, which is what makes a naive el.value assignment silently useless.
  Object.defineProperty(el, "value", {
    get() { return w.__reactValue; },
    set(v) { w.__shadowed = true; w.__reactValue = ""; },
    configurable: true,
  });
  w.__native = proto.set;
});

const LONG = "x".repeat(6384);
await composer.evaluate((text) => {
  const doc = document, w = window;
  const el = doc.querySelector('textarea, div[contenteditable="true"]');
  if (!el) return;
  if (el.tagName === "TEXTAREA") {
    const desc = Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, "value");
    if (desc && desc.set) desc.set.call(el, text);
    else el.value = text;
  } else {
    el.textContent = text;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
}, LONG);

const landed = await composer.evaluate(() => {
  const el = document.getElementById("t");
  const proto = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value");
  return { real: proto.get.call(el).length, shadowed: !!window.__shadowed };
});
check("a long prompt reaches the element past a React-style value shadow",
  landed.real === LONG.length, "element holds " + landed.real + " of " + LONG.length);
check("and does not go through the shadow that swallows it",
  landed.shadowed === false, "the naive el.value path was taken");
await composer.close();


/* ---- a reply request that fails, against the real wait loop ----------------
 *
 * The failure this covers cannot be provoked on demand: you cannot ask a
 * provider to rate limit you. So the page is synthetic and the 429 is fulfilled
 * by the router - but the tap, the status plumbing and waitForResponse are the
 * real ones.
 *
 * Before this, a 429 meant the reply never arrived and the step polled an
 * element that would never change for its full five-minute timeout, then
 * reported a slow model. It was never asked.
 */
const failing = await browser.newPage();
// The document is served from a routed origin rather than set with
// setContent, so the page has a real URL and a relative XHR is same-origin -
// exactly as it is on the provider.
await failing.route("**/api/v0/chat/completion", (route) =>
  route.fulfill({ status: 429, contentType: "application/json", body: '{"error":"rate limited"}' }));
await failing.route("https://example.test/", (route) =>
  route.fulfill({ status: 200, contentType: "text/html",
    body: "<html><body><textarea></textarea><div class='ds-markdown'></div></body></html>" }));
await failing.goto("https://example.test/", { waitUntil: "domcontentloaded" });

const failCtl = new PlaywrightController(config);
failCtl.attachPageForReplay(failing);

// sendPrompt arms the tap; the page then issues the request the tap watches.
await failCtl.sendPrompt("probe", config);
await failing.evaluate(() => {
  const x = new XMLHttpRequest();
  x.open("POST", "/api/v0/chat/completion");
  x.send("{}");
});
await failing.waitForTimeout(1500);

const stats = failCtl.streamStats();
check("the tap records the reply request's HTTP status", stats.status === 429, "status " + stats.status);

const began = Date.now();
let failure = null;
try {
  await failCtl.waitForResponse(config, 0, "");
} catch (e) { failure = e.message; }
const waited = Date.now() - began;

check("a failed reply request stops the wait", !!failure, "no error thrown");
check("and says it is rate limiting, not a slow model",
  /rate limiting/i.test(failure || ""), failure);
check("and tells the user to wait rather than blaming their code",
  /nothing is wrong with the code/i.test(failure || ""), failure);
// The whole point: seconds, not the full maxWaitMs.
check("in seconds rather than the full timeout",
  waited < 30000, Math.round(waited / 1000) + "s of " + Math.round(config.completionRules.maxWaitMs / 1000) + "s");
await failing.close();

await browser.close();
console.log("  " + "-".repeat(58));
console.log("  " + (fail === 0 ? "PASS" : "FAIL") + " — " + pass + " passed, " + fail + " failed\n");
process.exit(fail === 0 ? 0 : 1);
