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
console.log("  2. Click whatever opens the MODEL picker, so the list of models is showing.");
console.log("  3. Leave it open and come back here.");
console.log("");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
await new Promise((r) => rl.question("Press Enter once the model list is visible... ", () => { rl.close(); r(); }));

const out = path.join(os.tmpdir(), "closeni-ui-" + providerId + "-" + Date.now() + ".html");
fs.writeFileSync(out, await page.content(), "utf-8");

// A summary of everything clickable, so the useful selectors are obvious without
// reading the whole document.
const clickable = await page.evaluate(() => {
  const rows = [];
  const els = document.querySelectorAll('button, [role="button"], [role="option"], [role="menuitem"], li, a, [class*="model"], [class*="select"]');
  for (const el of els) {
    const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 60);
    if (!text) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const attrs = [];
    for (const a of el.attributes) {
      if (["class", "id", "role", "aria-label", "title"].includes(a.name) || a.name.startsWith("data-")) {
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
