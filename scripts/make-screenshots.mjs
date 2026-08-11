/*
 * Capture screenshots of the application UI.
 *
 *   source scripts/wsl-env.sh
 *   node scripts/make-screenshots.mjs
 *
 * The renderer is plain HTML and CSS, so it is loaded straight into Chromium
 * with a stubbed IPC bridge rather than photographed through a window manager.
 * The markup, the stylesheet and the theme tokens are the real ones, so the
 * images stay accurate and can be regenerated whenever the interface changes.
 *
 * Panel content is built with the application's own class names rather than by
 * driving the app, because the alternative is exporting test hooks from
 * production code for the sake of a picture.
 *
 * Writes to docs/screenshots/.
 */
import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";

const repo = path.resolve(import.meta.dirname, "..");
const out = path.join(repo, "docs", "screenshots");
fs.mkdirSync(out, { recursive: true });

/*
 * Stands in for preload.js.
 *
 * The interesting values are spelled out; everything else falls through a Proxy
 * to a no-op that resolves to []. That fallback is the point: this used to be a
 * hand-maintained list of "everything preload exposes", so adding one method to
 * preload threw inside renderer.js before it reached `window.CN = {...}`, and
 * every screenshot came out as an empty shell. The failure looked like a
 * screenshot bug rather than a missing stub, which is how it survived a run.
 */
const STUB = `
const API = {
  platform: "linux",
  listProviders: async () => ([
    { id: "deepseek", name: "DeepSeek Chat", controls: [
      { id: "mode", label: "Mode", kind: "select", default: "default",
        options: [{ value: "default", label: "Instant" }, { value: "expert", label: "Advanced" }] },
      { id: "deep-thinking", label: "Deep thinking", kind: "toggle", default: false },
      { id: "smart-search", label: "Smart Search", kind: "toggle", default: false }] },
    { id: "qwen-studio", name: "Qwen Studio", comingSoon: true, controls: [] },
    { id: "glm", name: "GLM (Z.ai)", comingSoon: true, controls: [] },
  ]),
  authStatus: async () => ({
    success: true, signedIn: true, provider: "deepseek", name: "DeepSeek Chat",
    thread: { label: "…a7e6c2", url: "https://example.invalid/c/x" },
  }),
  getChats: async () => ([]),
  browserStatus: async () => ({ ready: true }),
  ghStatus: async () => ({ signedIn: false, encryptionAvailable: true }),
  ghCall: async () => ({ ok: true, result: [] }),
  readManifest: async () => null,
  listFiles: async () => ({ files: [] }),
  readFile: async () => ({ ok: true, text: "" }),
  writeManifest: async () => ({ ok: true }),
  runCommand: async () => ({ success: true, output: "" }),
  git: async () => ({ success: true, output: "" }),
  onLog: () => {}, onPLog: () => {}, onApproval: () => {},
  onStepEvent: () => {}, onBrowserProgress: () => {},
  selectFolder: async () => null, runAgent: async () => ({}), suggest: async () => ({}),
  askRun: async () => ({}), startSession: async () => ({ ok: true }), sendStep: async () => ({}),
  endSession: async () => ({}), signIn: async () => ({}), newChat: async () => ({ ok: true }),
  switchChat: async () => ({}), respondApproval: () => {}, installBrowser: async () => ({ ok: true }),
  ghSignIn: async () => ({ ok: true }), ghSignOut: async () => ({ ok: true }), ghClone: async () => ({ ok: true }),
  listMcp: async () => ([]),
};

// Anything preload gains later resolves to [] instead of being undefined, so a
// new method can never blank every screenshot again. on* handlers must return a
// plain function rather than a promise: the renderer calls them with a callback
// and does not await them.
window.api = new Proxy(API, {
  get(target, key) {
    if (key in target) return target[key];
    if (typeof key === "string" && key.startsWith("on")) return function () {};
    return async function () { return []; };
  },
});
`;

/** Small helpers available to every setup script, using the real class names. */
const HELPERS = `
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, html) => { const e = document.createElement(tag);
    if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; };
  const msg = (box, who, text) => {
    const w = el("div", "msg " + who);
    w.appendChild(el("span", "msg-label", who === "user" ? "you" : "ai"));
    const b = el("div", "msg-text"); b.textContent = text; w.appendChild(b);
    box.appendChild(w);
  };
  const STEPS = [
    ["Project setup and configuration", "requirements.txt, src/app/config.py"],
    ["Database models", "src/app/models.py"],
    ["Storage layer", "src/app/store.py"],
    ["API routes", "src/app/routes.py"],
    ["Application entry point", "src/app/server.py"],
    ["Frontend", "static/index.html, static/app.js"],
    ["Tests", "tests/test_routes.py"],
  ];
  const stepList = (statuses) => {
    const list = $("step-list"); list.innerHTML = "";
    STEPS.forEach(([title], i) => {
      const st = statuses[i] || "pending";
      const pix = { done: "pix-stamp", failed: "pix-flicker", running: "pix-spin" }[st] || "";
      const card = el("div", "step-card" + (statuses.selected === i ? " active" : ""),
        '<span class="step-card-num">0' + (i + 1) + '</span>' +
        '<span class="step-card-title">' + title + '</span>' +
        '<span class="step-card-status ' + st + ' ' + pix + '">' + st + '</span>');
      list.appendChild(card);
    });
  };
  const workspace = () => { $("workspace-label").textContent = "~/projects/habits"; };
  const logs = (agent, project) => {
    const a = $("log"), p = $("plog");
    (agent || []).forEach((l) => {
      const cls = /fail|error|blocked/i.test(l) ? "err" : /step|resuming/i.test(l) ? "step" : /pass|done|saved|ready/i.test(l) ? "ok" : "";
      const e = el("div", "log-line " + cls); e.textContent = l; a.appendChild(e);
    });
    (project || []).forEach((l) => { const e = el("div", "log-line"); e.textContent = l; p.appendChild(e); });
  };
`;

/**
 * The running spinner animates through | / - \\, so a still frame catches it
 * mid-cycle and it reads as a stray character. Hidden for stills only; the
 * chip's colour already carries the state.
 */
const STILL = `.pix-spin::after{display:none!important;}`;

const shots = [
  {
    name: "chat",
    theme: "midnight",
    setup: `
      workspace(); CN.switchTab("chat");
      const flow = $("chat-flow");
      msg(flow, "user", "Build a habit tracker: a FastAPI backend with SQLite, and a small static frontend that talks to it.");
      msg(flow, "ai", "A sensible shape here is four layers. Storage holds Habit and Completion rows through SQLAlchemy. A repository module wraps the queries so routes never touch a session directly. FastAPI exposes the lifecycle — create, list, complete, archive. The frontend is a single page that fetches from the API, so there is no build step to maintain.\\n\\nI would keep completions in their own table rather than as a counter on Habit: a streak then becomes a query, instead of a field you have to keep correct on every write.");
      $("plan-sidebar").classList.remove("hidden");
      const c = $("plan-content");
      c.appendChild(el("div", "plan-summary", "A habit tracker: FastAPI backend, SQLite storage, and a static frontend."));
      c.appendChild(el("div", "plan-scale hint", "7 steps · roughly 11 min"));
      c.appendChild(el("div", "plan-section",
        '<div class="plan-section-title">File Structure</div><div class="plan-file-tree">' +
        "requirements.txt\\nsrc/app/config.py\\nsrc/app/models.py\\nsrc/app/routes.py\\nsrc/app/server.py\\nsrc/app/store.py\\nstatic/app.js\\nstatic/index.html\\ntests/test_routes.py</div>"));
      STEPS.slice(0, 4).forEach(([t, f], i) => {
        c.appendChild(el("div", "plan-step",
          '<div class="plan-step-head"><span class="plan-step-num">0' + (i+1) + '</span>' +
          '<span class="plan-step-title">' + t + '</span></div>' +
          '<div class="plan-step-files">' + f + '</div>'));
      });
    `,
  },
  {
    name: "builder",
    theme: "midnight",
    setup: `
      workspace(); CN.switchTab("build");
      const s = ["done","done","done","running","running","pending","pending"]; s.selected = 3;
      stepList(s);
      $("builder-empty").style.display = "none";
      $("step-detail").classList.remove("hidden");
      $("step-detail-label").textContent = "STEP 04 · API ROUTES";
      $("step-detail-status").textContent = "running";
      $("builder-status").textContent = "building 4/7 · 2 in parallel";
      $("builder-progress").style.width = "43%";
      $("builder-preview").classList.remove("is-hidden");
      const files = $("step-files"); files.innerHTML = "";
      const fc = el("div", "file-card");
      fc.appendChild(el("div", "file-card-head",
        '<span class="lang-mark" style="color:var(--lang-py)">py</span>' +
        '<span class="file-path">src/app/routes.py</span><span class="file-mode create">create</span>'));
      const body = el("div", "file-body open");
      const diff = [["same","from sqlalchemy.orm import Session"],["same",""],
        ["remove","def list_habits(db):"],
        ["add","def list_habits(db: Session, *, archived: bool = False):"],
        ["add",'    """Return habits newest first. Archived ones are excluded."""'],
        ["same","    q = db.query(Habit)"],
        ["add","    if not archived:"],
        ["add","        q = q.filter(Habit.archived.is_(False))"],
        ["same","    return q.order_by(Habit.created_at.desc()).all()"]];
      body.innerHTML = "<pre>" + diff.map(([t, x]) =>
        '<span class="diff-line ' + t + '">' + (t==="add"?"+ ":t==="remove"?"- ":"  ") + x + "</span>").join("") + "</pre>";
      fc.appendChild(body); files.appendChild(fc);
      logs([
        "build session ready with 2 worker(s)",
        "step 3/7: Storage layer",
        "step 3 complete",
        "step 4/7: API routes",
        "step 5/7: Application entry point",
      ], [
        "RUNNING_CHECK: python3 -m py_compile \\"src/app/store.py\\"",
        "CHECK_RESULT: PASS",
        "RUNNING_CHECK: python3 -m py_compile \\"src/app/models.py\\"",
        "CHECK_RESULT: PASS",
      ]);
    `,
  },
  {
    name: "test",
    theme: "midnight",
    setup: `
      workspace(); CN.switchTab("test");
      $("test-cmd").value = "python3 src/app/server.py";
      const b = $("run-source"); b.textContent = "FROM YOUR PLAN"; b.className = "run-badge plan";
      $("run-hint").textContent = "the model declared this while planning";
      $("test-summary").textContent = "2 passed, 1 failed";
      const res = $("test-results"); res.innerHTML = "";
      [["python",'python3 -m py_compile "src/app/routes.py"',true],
       ["python",'python3 -m py_compile "src/app/models.py"',true],
       ["javascript",'node --check "static/app.js"',false]].forEach(([lang,cmd,ok]) => {
        const tok = lang === "python" ? "--lang-py" : "--lang-js";
        res.appendChild(el("div", "test-row " + (ok ? "pass" : "fail"),
          '<span class="lang-mark" style="color:var(' + tok + ')">' + lang + '</span>' +
          '<span class="cmd">' + cmd + '</span>' +
          '<span class="verdict">' + (ok ? "pass" : "fail") + '</span>'));
      });
      $("test-history-label").style.display = "";
      $("test-history").appendChild(el("div", "test-row pass",
        '<span class="cmd">syntax check · 9 checks</span><span class="verdict">passed</span>'));
      const flow = $("test-chat-flow");
      msg(flow, "user", "why did this fail?");
      msg(flow, "ai", "static/app.js line 24 opens a template literal on line 22 that is never closed, so the parser reaches the end of the function still inside a string. Adding the closing backtick fixes it — nothing else in that file is wrong.");
    `,
  },
  {
    name: "settings",
    theme: "midnight",
    setup: `
      workspace(); CN.switchTab("settings");
      document.querySelector('.settings-tab[data-section="appearance"]').click();
    `,
  },
  {
    name: "theme-paper",
    theme: "paper",
    setup: `
      workspace(); CN.switchTab("build");
      const s = ["done","done","done","failed","blocked","blocked","blocked"]; s.selected = 3;
      stepList(s);
      $("builder-empty").style.display = "none";
      $("step-detail").classList.remove("hidden");
      $("step-detail-label").textContent = "STEP 04 · API ROUTES";
      $("step-detail-status").textContent = "failed";
      $("builder-status").textContent = "finished: 3/7";
      $("builder-progress").style.width = "100%";
      $("builder-retry").classList.remove("is-hidden");
      const files = $("step-files"); files.innerHTML = "";
      const fc = el("div", "file-card");
      fc.appendChild(el("div", "file-card-head",
        '<span class="file-path">error</span><span class="file-mode failed">failed</span>'));
      fc.appendChild(el("div", "file-body open",
        "<pre>RUNNING_CHECK: python3 -m py_compile \\"src/app/routes.py\\"\\nCHECK_RESULT: FAIL\\n\\n  File \\"src/app/routes.py\\", line 41\\n    return {\\"habits\\": [h.as_dict() for h in habits}\\n                                             ^\\nSyntaxError: closing parenthesis '}' does not match opening '['</pre>"));
      files.appendChild(fc);
      logs([
        "resuming: 3/7 already done",
        "step 4/7: API routes",
        "TEST_FAILED: python3 -m py_compile \\"src/app/routes.py\\"",
        "step 4 failed: Still failing after 2 fix attempts.",
        "step 5 blocked: a step it depends on failed",
      ], ["SyntaxError: closing parenthesis '}' does not match opening '['"]);
    `,
  },
  {
    name: "theme-phosphor",
    theme: "phosphor",
    setup: `
      workspace(); CN.switchTab("build");
      const s = ["done","done","running","running","pending","pending","pending"]; s.selected = 2;
      stepList(s);
      $("builder-empty").style.display = "none";
      $("step-detail").classList.remove("hidden");
      $("step-detail-label").textContent = "STEP 03 · STORAGE LAYER";
      $("step-detail-status").textContent = "running";
      $("builder-status").textContent = "building 3/7 · 2 in parallel";
      $("builder-progress").style.width = "29%";
      const files = $("step-files"); files.innerHTML = "";
      const fc = el("div", "file-card");
      fc.appendChild(el("div", "file-card-head",
        '<span class="file-path">step detail</span><span class="file-mode">running</span>'));
      fc.appendChild(el("div", "file-body open",
        "<pre>Repository functions for creating, listing and completing\\nhabits. Routes must never touch a session directly.</pre>"));
      files.appendChild(fc);
    `,
  },
  {
    name: "theme-cassette",
    theme: "cassette-indigo",
    setup: `
      workspace(); CN.switchTab("chat");
      const flow = $("chat-flow");
      msg(flow, "user", "Add streak tracking to the habit model.");
      msg(flow, "ai", "A streak is derived, not stored. Keep Completion rows as the source of truth and compute the streak as a query over consecutive dates — otherwise every write path has to remember to keep a counter correct, and one that forgets is a bug you only find weeks later.");
      $("plan-sidebar").classList.remove("hidden");
      const c = $("plan-content");
      c.appendChild(el("div", "plan-summary", "Add derived streak tracking to the habit API."));
      c.appendChild(el("div", "plan-scale hint", "3 steps · roughly 5 min"));
      [["Streak query","src/app/store.py"],["Expose it on the API","src/app/routes.py"],["Tests","tests/test_streaks.py"]]
        .forEach(([t, f], i) => c.appendChild(el("div", "plan-step",
          '<div class="plan-step-head"><span class="plan-step-num">0' + (i+1) + '</span>' +
          '<span class="plan-step-title">' + t + '</span></div>' +
          '<div class="plan-step-files">' + f + '</div>')));
    `,
  },
  {
    name: "ship",
    theme: "blueprint",
    setup: `
      workspace(); CN.switchTab("push");
      $("gh-signed-out").classList.add("is-hidden");
      $("gh-signed-in").classList.remove("is-hidden");
      $("gh-login").textContent = "@siddarth1872004";
      const sel = $("gh-repo");
      sel.appendChild(el("option", null, "siddarth1872004/CloseNI"));
      $("remote-url").value = "https://github.com/siddarth1872004/CloseNI.git";
      $("commit-msg").value = "Add streak tracking";
      $("gh-workflow").value = "release.yml";
      const runs = $("gh-runs");
      [["release","success"],["release","running"],["release","success"]].forEach(([n,s]) =>
        runs.appendChild(el("div", "gh-run " + s,
          '<span class="name">' + n + '</span><span class="verdict">' + s + '</span>')));
    `,
  },
];

const browser = await chromium.launch();
let failures = 0;
for (const shot of shots) {
  const page = await browser.newPage({ viewport: { width: 1400, height: 880 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(STUB);
  await page.goto("file://" + path.join(repo, "desktop", "index.html"), { waitUntil: "load" });
  await page.evaluate(`document.documentElement.setAttribute("data-theme", ${JSON.stringify(shot.theme)});`);
  await page.addStyleTag({ content: STILL });
  try {
    await page.evaluate(HELPERS + shot.setup);
  } catch (e) {
    failures++;
    console.log("  FAILED " + shot.name + ": " + e.message.split("\n")[0]);
  }
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, shot.name + ".png") });
  console.log("wrote docs/screenshots/" + shot.name + ".png" + (errors.length ? "  (page errors: " + errors.length + ")" : ""));
  await page.close();
}
await browser.close();
console.log(failures ? failures + " setup failures" : "all screenshots captured");
// A non-zero exit, because these run unattended from `npm run assets`. Writing
// eight empty shells and exiting 0 is how a whole set of blank screenshots got
// committed once already.
if (failures) process.exit(1);
