/*
 * The Code panel, driven through its real page in Chromium.
 *
 *   node scripts/ui-code.mjs          (npm run test:ui)
 *
 * The interface is the real index.html, styles and scripts; only the backend
 * (preload's window.api) is a script that answers the way the agent session
 * does. So this proves the panel's behaviour - typing, sending, slash commands,
 * mode cycling, permission prompts answered by keyboard, queued messages,
 * interrupts, plan approval - not the agent, which run-e2e.cjs covers.
 */
import { chromium } from "playwright";
import * as path from "path";

const repo = path.resolve(import.meta.dirname, "..");
let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  -> " + extra : "")); }
}

// A backend that records every call and lets the test push agent events.
const STUB = `
window.__calls = [];
window.__emit = function (ev) { if (window.__codeEvent) window.__codeEvent(ev); };
const rec = (name) => (...args) => { window.__calls.push({ name: name, args: args }); return Promise.resolve({ ok: true }); };
const API = {
  listProviders: async () => ([{ id: "deepseek", name: "DeepSeek Chat", controls: [] }]),
  authStatus: async () => ({ success: true, signedIn: true, provider: "deepseek", name: "DeepSeek Chat" }),
  browserStatus: async () => ({ ready: true }),
  getChats: async () => ([]),
  listFiles: async () => ({ files: ["src/app.py", "src/models.py", "README.md", "tests/test_app.py"] }),
  readFile: async () => ({ ok: true, text: "# Project notes" }),
  selectFolder: async () => "/tmp/project",
  onCodeEvent: (cb) => { window.__codeEvent = cb; },
  codeStart: async (p) => { window.__calls.push({ name: "codeStart", args: [p] }); return { ok: true, provider: "DeepSeek Chat" }; },
  codeSend: rec("codeSend"), codePermission: rec("codePermission"), codeMode: rec("codeMode"),
  codeInterrupt: rec("codeInterrupt"), codeRewind: rec("codeRewind"), codeClear: rec("codeClear"), codeEnd: rec("codeEnd"),
};
window.api = new Proxy(API, { get: (t, k) => k in t ? t[k] : (String(k).indexOf("on") === 0 ? () => {} : async () => ([])) });
`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1300, height: 860 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.addInitScript(STUB);
await page.goto("file://" + path.join(repo, "desktop", "index.html"), { waitUntil: "load" });
await page.waitForTimeout(300);

const calls = (name) => page.evaluate((n) => window.__calls.filter((c) => c.name === n), name);
const emit = (ev) => page.evaluate((e) => window.__emit(e), ev);
const text = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.textContent : null; }, sel);
const visible = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== "none" && !e.classList.contains("hidden"); }, sel);

console.log("\ncode panel: first launch");
check("Code is the panel that opens", await visible("#panel-code") && (await text("#mode-title")) === "CODE");
check("the flow bar belongs to planned builds and is hidden here", !(await visible("#flow")));
check("Terminal is the default theme", (await page.evaluate(() => document.documentElement.getAttribute("data-theme"))) === "terminal");
check("the welcome box asks for a folder", /Choose a project folder/.test(await text("#code-need")));

console.log("\ncode panel: sending needs a folder");
await page.fill("#code-input", "hello");
await page.keyboard.press("Enter");
check("with no folder nothing is started", (await calls("codeStart")).length === 0 && /Choose a project folder first/.test(await text("#code-transcript")));

await page.evaluate(() => { document.getElementById("browse-btn").click(); });
await page.waitForTimeout(300);
check("choosing a folder updates cwd", (await text("#code-cwd")) === "/tmp/project");

console.log("\ncode panel: a turn");
await page.fill("#code-input", "fix the bug in @src/app.py please");
await page.keyboard.press("Enter");
await page.waitForTimeout(200);
const starts = await calls("codeStart");
check("the first message starts the session in the folder", starts.length === 1 && starts[0].args[0].workspace === "/tmp/project" && starts[0].args[0].mode === "default");
check("and sends the text", (await calls("codeSend")).map((c) => c.args[0]).join() === "fix the bug in @src/app.py please");
check("the message shows as a prompt line", /fix the bug in @src\/app\.py/.test(await text(".cc-user:last-of-type")));
check("the input clears", (await page.inputValue("#code-input")) === "");

await emit({ type: "turn-start" });
check("the spinner shows while working", await visible("#code-spinner"));
await page.fill("#code-input", "also add a test");
await page.keyboard.press("Enter");
check("a message sent while busy is queued, not sent", (await calls("codeSend")).length === 1 && /queued/.test(await text("#code-transcript")));

await emit({ type: "assistant", text: "Looking at **app.py** now." });
await emit({ type: "tool", id: "t1", name: "read", input: { path: "src/app.py" }, status: "done", detail: { lines: 42 } });
check("assistant text renders as markdown", (await page.evaluate(() => document.querySelector(".cc-msg .cc-body strong") && document.querySelector(".cc-msg .cc-body strong").textContent)) === "app.py");
check("a tool line reads like Read(path) with its result", /Read\(src\/app\.py\)/.test(await text(".cc-tool:last-of-type")) && /Read 42 lines/.test(await text(".cc-tool:last-of-type .cc-sum")));

await emit({ type: "tool", id: "t2", name: "edit", input: { path: "src/app.py" }, status: "waiting" });
await emit({ type: "permission", id: "t2", tool: "edit", title: "edit src/app.py", input: { path: "src/app.py" },
  preview: { path: "src/app.py", before: "a = 1\nb = 2\n", after: "a = 1\nb = 3\n", created: false }, alwaysAsk: false, rememberAs: "edits" });
check("a permission prompt shows the diff", await visible(".cc-perm .cc-diff") && /b = 3/.test(await text(".cc-perm .cc-diff")));
check("it offers yes, yes-for-the-session, and no", (await page.$$(".cc-perm-opt")).length === 3 && /allow all edits/.test(await text(".cc-perm-opts")));
check("the feedback box waits for a no", !(await visible(".cc-perm-feedback")));
await page.keyboard.press("2");
await page.waitForTimeout(100);
const perms = await calls("codePermission");
check("pressing 2 answers 'always' for that call", perms.length === 1 && perms[0].args[0] === "t2" && perms[0].args[1] === "always");
check("the prompt collapses to the answer", /don't ask again/.test(await text(".cc-perm.answered")));

await emit({ type: "tool", id: "t2", name: "edit", input: { path: "src/app.py" }, status: "done",
  detail: { path: "src/app.py", before: "a = 1\nb = 2\n", after: "a = 1\nb = 3\n" } });
check("a finished edit shows its diff under the line", /Updated src\/app\.py with 1 addition and 1 removal/.test(await text("#code-transcript")) && await visible(".cc-tool.tool-edit .cc-diff"));

await emit({ type: "tool", id: "t3", name: "bash", input: { command: "rm -rf build" }, status: "waiting" });
await emit({ type: "permission", id: "t3", tool: "bash", title: "bash", input: { command: "rm -rf build" }, preview: { command: "rm -rf build" }, alwaysAsk: true });
check("a command that always asks offers no 'don't ask again'", (await page.$$(".cc-perm:not(.answered) .cc-perm-opt")).length === 2);
await page.keyboard.press("Escape");
await page.waitForTimeout(100);
const denied = (await calls("codePermission")).pop();
check("esc declines", denied.args[0] === "t3" && denied.args[1] === "deny");

await emit({ type: "todos", items: [{ text: "Fix it", status: "done" }, { text: "Test it", status: "in_progress" }] });
check("the todo list shows above the input", await visible("#code-todos") && /Test it/.test(await text("#code-todos")));

await emit({ type: "done", reason: "complete" });
await page.waitForTimeout(150);
check("the spinner stops when the turn ends", !(await visible("#code-spinner")));
check("the queued message goes out after the turn", (await calls("codeSend")).map((c) => c.args[0]).pop() === "also add a test");

console.log("\ncode panel: modes and commands");
await page.focus("#code-input");
await page.keyboard.press("Shift+Tab");
check("shift+tab turns on accept edits", /accept edits on/.test(await text("#code-mode")) && (await calls("codeMode")).pop().args[0] === "acceptEdits");
await page.keyboard.press("Shift+Tab");
check("again: plan mode", /plan mode on/.test(await text("#code-mode")));
await page.keyboard.press("Shift+Tab");
check("again: back to default", /\? for shortcuts/.test(await text("#code-mode")));

await page.fill("#code-input", "/pl");
await page.waitForTimeout(100);
check("typing / suggests commands", await visible("#code-suggest") && /\/plan/.test(await text("#code-suggest")));
await page.keyboard.press("Tab");
check("tab completes the command", (await page.inputValue("#code-input")).trim() === "/plan");
await page.keyboard.press("Enter");
check("/plan turns plan mode on", /plan mode on/.test(await text("#code-mode")));

await emit({ type: "turn-start" });
await emit({ type: "assistant", text: "Plan:\n1. Change the query\n2. Add a test" });
await emit({ type: "done", reason: "complete" });
check("a finished plan offers to proceed", /Would you like to proceed/.test(await text("#code-transcript")));
const sendsBefore = (await calls("codeSend")).length;
await page.click(".cc-plan-offer .cc-perm-opt");
await page.waitForTimeout(150);
check("proceeding switches to accept edits and asks for the implementation",
  (await calls("codeMode")).pop().args[0] === "acceptEdits" && (await calls("codeSend")).length === sendsBefore + 1 &&
  /implement the plan/.test((await calls("codeSend")).pop().args[0]));
await emit({ type: "done", reason: "complete" });

await page.fill("#code-input", "look at @src/mo");
await page.waitForTimeout(200);
check("@ suggests project files", await visible("#code-suggest") && /src\/models\.py/.test(await text("#code-suggest")));
await page.keyboard.press("Enter");
check("enter completes the file", (await page.inputValue("#code-input")) === "look at @src/models.py ");
await page.fill("#code-input", "");

await page.fill("#code-input", "/help");
await page.keyboard.press("Enter");
check("/help lists commands and shortcuts", /shift\+tab/.test(await text(".cc-help:last-of-type")) && /\/rewind/.test(await text(".cc-help:last-of-type")));
await page.fill("#code-input", "/rewind");
await page.keyboard.press("Enter");
check("/rewind asks the session", (await calls("codeRewind")).length === 1);
await emit({ type: "rewound", files: ["src/app.py"] });
check("and reports what it restored", /Rewound 1 file: src\/app\.py/.test(await text("#code-transcript")));
await page.fill("#code-input", "/clear");
await page.keyboard.press("Enter");
check("/clear asks the session", (await calls("codeClear")).length === 1);
await emit({ type: "cleared" });
check("and empties the transcript", (await page.$$(".cc-tool")).length === 0);
await page.fill("#code-input", "/frobnicate");
await page.keyboard.press("Enter");
check("an unknown command says so", /Unknown command \/frobnicate/.test(await text("#code-transcript")));
await page.fill("#code-input", "/usr/bin/python3 --version please");
await page.keyboard.press("Enter");
await page.waitForTimeout(100);
check("a path is not a command", (await calls("codeSend")).pop().args[0] === "/usr/bin/python3 --version please");

console.log("\ncode panel: interrupting");
await emit({ type: "turn-start" });
await page.focus("#code-input");
await page.keyboard.press("Escape");
check("esc while working interrupts", (await calls("codeInterrupt")).length === 1);
await emit({ type: "done", reason: "interrupted" });
check("and the transcript says so", /Interrupted by user/.test(await text("#code-transcript")));

await page.fill("#code-input", "first");
await page.keyboard.press("Enter");
await page.fill("#code-input", "");
await page.keyboard.press("ArrowUp");
check("up recalls the last message", (await page.inputValue("#code-input")) === "first");

check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
console.log("\n" + (fail === 0 ? "PASS" : "FAIL") + " - " + pass + " passed, " + fail + " failed");
process.exit(fail === 0 ? 0 : 1);
