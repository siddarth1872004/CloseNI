/*
 * The unit suite: one count over every area's tests.
 *
 * Run against the compiled output:   npm run build && npm test
 *
 * Each area is its own file (parse-, build-, checks-, provider-, desktop-,
 * web-, extract- and agent-unit.cjs) exporting run(check, section). The
 * provider area drives a real page and needs Playwright's chromium ("npx
 * playwright install chromium"); without it those sections are skipped rather
 * than failed, so everything else still runs on a machine without a browser.
 */

let pass = 0;
let fail = 0;
// Sections that need Chromium skip without it, so npm test runs on a machine
// with no browser. The summary names them, and CI, which has Chromium, fails.
const skipped = [];

function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log("  ok   " + name);
  } else {
    fail++;
    console.log("  FAIL " + name + (extra ? "  -> " + extra : ""));
  }
}

function section(name) {
  console.log("\n" + name);
}

(async () => {
  await require("./parse-unit.cjs").run(check, section, skipped);
  await require("./build-unit.cjs").run(check, section, skipped);
  await require("./checks-unit.cjs").run(check, section, skipped);
  await require("./provider-unit.cjs").run(check, section, skipped);
  await require("./desktop-unit.cjs").run(check, section, skipped);
  // The browser-native layer's pure logic (src/web). Its browser suite is
  // run-web.cjs, which needs Chromium and is run separately.
  await require("./web-unit.cjs").run(check, section);
  // The optional structured-extraction backend (src/extract).
  await require("./extract-unit.cjs").run(check, section);
  // The coding agent (src/agent): protocol, tools, permissions and the loop.
  await require("./agent-unit.cjs").run(check, section);

  if (skipped.length) {
    console.log("\nSkipped, as Chromium is not installed (npx playwright install chromium): " + skipped.join(", "));
    if (process.env.CI) fail++;
  }
  console.log("\n" + (fail === 0 ? "PASS" : "FAIL") + " — " + pass + " passed, " + fail + " failed" + (skipped.length ? ", " + skipped.length + " sections skipped" : ""));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("test runner threw:", e);
  process.exit(1);
});
