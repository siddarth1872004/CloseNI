/*
 * Capture a provider's model-switching UI so it can be automated.
 *
 *   source scripts/wsl-env.sh
 *   node scripts/capture-provider-ui.mjs deepseek
 *
 * Opens the provider in a visible browser using its saved profile, waits for you
 * to open the model dropdown, then writes the page markup to a temp file and
 * prints a summary of every clickable thing it can see.
 *
 * The dump can contain your conversation titles and account details. It is
 * written to the system temp directory, not the repository. Look before sharing.
 */
import { chromium } from "playwright";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as readline from "readline";

const providerId = process.argv[2] || "deepseek";
const repo = path.resolve(import.meta.dirname, "..");
const cfgPath = path.join(repo, "local-agent", "config", "providers", providerId + ".json");

if (!fs.existsSync(cfgPath)) {
  console.error("No config for '" + providerId + "'. Available:");
  for (const f of fs.readdirSync(path.join(repo, "local-agent", "config", "providers"))) {
    if (f.endsWith(".json")) console.error("  " + f.replace(/\.json$/, ""));
  }
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
const profileDir = path.resolve(repo, cfg.profileDir);

console.log("Provider : " + cfg.name);
console.log("URL      : " + cfg.baseUrl);
console.log("Profile  : " + profileDir + (fs.existsSync(profileDir) ? "" : "  (missing - you may need to sign in)"));
console.log("");

const ctx = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  viewport: { width: 1400, height: 900 },
  args: ["--disable-blink-features=AutomationControlled"],
});
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto(cfg.baseUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

console.log("A browser window is open.");
console.log("");
console.log("  1. Sign in if you are asked to.");
console.log("  2. That is all - do NOT open any menus yourself.");
console.log("     Menus close when you switch windows, so the tool opens them itself.");
console.log("");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await new Promise((r) => rl.question("Press Enter once you are signed in and the chat page is showing... ", () => { rl.close(); r(); }));

// Open each menu-like trigger in turn and record what appears. Doing this from
// the script avoids the trap that made earlier captures useless: a dropdown
// closes the moment focus leaves the window, so a human cannot hold one open
// while pressing Enter in a terminal.
const TRIGGERS = '[aria-haspopup], [data-dropdown-menu-trigger], .ant-select, [role="combobox"], [aria-expanded]';
const opened = [];
const triggerCount = await page.locator(TRIGGERS).count();
console.log("");
console.log("Opening " + triggerCount + " menu-like controls, one at a time...");

for (let i = 0; i < Math.min(triggerCount, 12); i++) {
  const trigger = page.locator(TRIGGERS).nth(i);
  let label = "";
  try {
    if (!(await trigger.isVisible())) continue;
    label = ((await trigger.getAttribute("aria-label")) || (await trigger.innerText()) || "").trim().replace(/\s+/g, " ").slice(0, 40);
    const before = await page.evaluate(() => document.body.innerHTML.length);
    await trigger.click({ timeout: 4000 });
    await page.waitForTimeout(700);
    const after = await page.evaluate(() => document.body.innerHTML.length);
    if (after <= before + 200) { await page.keyboard.press("Escape").catch(() => {}); continue; }

    // Something appeared. Record the newly visible option-like elements.
    const items = await page.evaluate(() => {
      const rows = [];
      const sel = '[role="menuitem"], [role="option"], [role="menuitemradio"], [data-radix-collection-item], .ant-select-item, li';
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60);
        if (!text) continue;
        const attrs = [];
        for (const a of el.attributes) {
          if (a.name.startsWith("data-") || a.name.startsWith("aria-") || a.name === "role") {
            if (!/^data-(styled|beam|css-hash|token-hash|rc-order|rc-priority|spm)/.test(a.name)) {
              attrs.push(a.name + '="' + String(a.value).slice(0, 40) + '"');
            }
          }
        }
        rows.push({ text, attrs: attrs.join(" ") });
      }
      return rows.slice(0, 30);
    });
    if (items.length) opened.push({ label: label || "(trigger " + i + ")", items });
    fs.writeFileSync(path.join(os.tmpdir(), "closeni-open-" + providerId + "-" + i + ".html"), await page.content(), "utf-8");
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(400);
  } catch (e) {
    await page.keyboard.press("Escape").catch(() => {});
  }
}

console.log("");
console.log("=== MENU CONTENTS FOUND ===");
if (!opened.length) console.log("  none - the controls may need a different trigger.");
for (const o of opened) {
  console.log("");
  console.log("  [" + o.label + "]");
  for (const it of o.items) console.log("      " + JSON.stringify(it.text) + (it.attrs ? "   " + it.attrs : ""));
}

const out = path.join(os.tmpdir(), "closeni-ui-" + providerId + "-" + Date.now() + ".html");
fs.writeFileSync(out, await page.content(), "utf-8");

// Candidate controls first: anything that looks like a toggle, a mode selector
// or a menu item. These are what a `controls` block is built from, so they are
// reported in roughly that shape rather than as raw markup.
const candidates = await page.evaluate(() => {
  const out = [];
  const seen = new Set();
  const sel = [
    "[aria-pressed]", "[aria-checked]", '[role="switch"]', '[role="radio"]',
    '[role="menuitem"]', '[role="option"]', "select",
  ].join(",");
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 50);
    const data = {};
    for (const a of el.attributes) if (a.name.startsWith("data-")) data[a.name] = a.value;
    // Classes that look designed rather than generated: hashed build output is
    // useless as a selector because it changes on every deploy.
    const stable = (el.className || "").toString().split(/\s+/)
      .filter((c) => c.length > 3 && /[a-z]-[a-z]/.test(c) && !/^_/.test(c));
    const key = text + JSON.stringify(data) + stable.join();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      tag: el.tagName.toLowerCase(),
      text: text,
      role: el.getAttribute("role") || "",
      pressed: el.getAttribute("aria-pressed"),
      checked: el.getAttribute("aria-checked"),
      data: data,
      stableClasses: stable.slice(0, 4),
    });
  }
  return out.slice(0, 60);
});

console.log("");
console.log("=== CANDIDATE CONTROLS ===");
if (!candidates.length) {
  console.log("  none found - the controls may only exist once a menu is opened.");
  console.log("  Re-run and open the model/settings menu before pressing Enter.");
}
for (const c of candidates) {
  const state = c.pressed !== null ? "aria-pressed=" + c.pressed
              : c.checked !== null ? "aria-checked=" + c.checked
              : "(no readable state)";
  const dataStr = Object.entries(c.data).map(([k, v]) => k + '="' + v + '"').join(" ");
  console.log("  " + JSON.stringify(c.text || "(no text)"));
  console.log("      tag=" + c.tag + (c.role ? " role=" + c.role : "") + "  " + state);
  if (dataStr) console.log("      data: " + dataStr);
  if (c.stableClasses.length) console.log("      stable classes: " + c.stableClasses.join(" "));
}

// Fallback listing: when a provider exposes no ARIA at all, the candidate scan
// above finds nothing and this is the only way to see what is on the page.
const clickable = await page.evaluate(() => {
  const rows = [];
  const els = document.querySelectorAll('button, [role="button"], li, a, [class*="model"], [class*="select"], [class*="toggle"], [class*="switch"]');
  for (const el of els) {
    const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60);
    if (!text) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const attrs = [];
    for (const a of el.attributes) {
      if (["class", "id", "role", "aria-label", "title"].includes(a.name) || a.name.startsWith("data-") || a.name.startsWith("aria-")) {
        attrs.push(a.name + '="' + String(a.value).slice(0, 70) + '"');
      }
    }
    rows.push({ tag: el.tagName.toLowerCase(), text: text, attrs: attrs.join(" ") });
  }
  return rows.slice(0, 120);
});

console.log("");
console.log("=== clickable elements currently visible ===");
for (const r of clickable) console.log("  <" + r.tag + " " + r.attrs + ">  " + JSON.stringify(r.text));
console.log("");
console.log("=== full page markup written to ===");
console.log(out);
console.log("");
console.log("Send me that path, or paste the lines above that look like the model list.");

await ctx.close();
