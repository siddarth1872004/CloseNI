/*
 * An agent that speaks the build-session protocol and drives no browser.
 *
 * Lets the headless CLI - and therefore the whole scheduling, resume,
 * checkpoint and timing path - be run end to end in a test. That path had no
 * coverage of any kind before this existed: it lived in the renderer, so
 * exercising it needed Electron, a provider and an account.
 *
 * FAKE_FAIL_STEPS is a comma-separated list of zero-based step indices to fail.
 */
const readline = require("readline");
const fail = new Set(String(process.env.FAKE_FAIL_STEPS || "")
  .split(",").filter(Boolean).map(Number));

console.log("SESSION_EVENT: " + JSON.stringify({ type: "ready" }));
readline.createInterface({ input: process.stdin }).on("line", function (l) {
  let m;
  try { m = JSON.parse(l); } catch (e) { return; }
  if (m.type === "close") {
    console.log("SESSION_EVENT: " + JSON.stringify({ type: "closed" }));
    process.exit(0);
  }
  if (m.type !== "step") return;
  console.log("PHASE:" + JSON.stringify({ phase: "writing" }));
  setTimeout(function () {
    console.log("SESSION_EVENT: " + JSON.stringify(fail.has(m.index)
      ? { type: "step-result", index: m.index, success: false, error: "fake failure" }
      : { type: "step-result", index: m.index, success: true, appliedFiles: ["f" + m.index + ".py"] }));
  }, 10);
});
