/*
 * The Test panel: the run bar, the check and behaviour runs, their results and
 * the chat about them.
 */
function renderTestResults(rows, summary) {
  const sum = $("test-summary");
  if (sum) sum.textContent = summary || "";
  const box = $("test-results");
  if (!box) return;
  box.innerHTML = "";
  // Language tokens from desktop/language-mark.js, so a check row is marked by
  // what it checked. The row's own text is a command and has nothing to derive
  // this from.
  (rows || []).forEach(function (r) {
    const el = document.createElement("div");
    el.className = "test-row " + (r.success ? "pass" : "fail");
    const token = r.language && window.CNLang ? window.CNLang.languageToken(r.language) : null;
    const mark = token
      ? '<span class="lang-mark" style="color:var(' + token + ')">' + escapeHtml(r.language) + "</span>"
      : "";
    el.innerHTML = mark + '<span class="cmd">' + escapeHtml(r.command) + '</span><span class="verdict">' +
      (r.success ? "pass" : "fail") + "</span>";
    box.appendChild(el);
  });
}

function renderTestOutput(text) {
  const box = $("test-results");
  if (!box) return;
  const el = document.createElement("div");
  el.className = "test-output";
  el.innerHTML = "<pre>" + escapeHtml(text || "(no output)") + "</pre>";
  box.appendChild(el);
}

// The second argument is the prompt slot, which testall ignores. Kept rather
// than tidied: changing the positional layout would break the mode.
// The last run, carried into the chat automatically so nobody pastes a
// traceback into a box sitting directly beneath that same traceback.
let lastRun = { command: "", output: "" };

// A short list, not a log: enough that a syntax check does not vanish the
// moment something else runs.
const testHistory = [];

function pushHistory(label, ok) {
  testHistory.unshift({ label: label, ok: ok });
  testHistory.splice(6);
  const box = $("test-history");
  if (!box) return;
  box.innerHTML = "";
  testHistory.forEach(function (h) {
    const row = document.createElement("div");
    row.className = "test-row " + (h.ok ? "pass" : "fail");
    row.innerHTML = '<span class="cmd">' + escapeHtml(h.label) + "</span>" +
      '<span class="verdict">' + (h.ok ? "passed" : "failed") + "</span>";
    box.appendChild(row);
  });
  const heading = $("test-history-label");
  if (heading) heading.style.display = testHistory.length ? "" : "none";
}

/**
 * What to run, and where the answer came from.
 *
 * The manifest wins, then the plan, then filename detection. The badge shows
 * which, because "from your plan" and "detected from main.py" are different
 * levels of confidence and the user should be able to tell them apart. This is
 * the fix for "no entry point found" appearing when the app already knew.
 */
async function detectCommand() {
  let files = [];
  try {
    const listing = await window.api.listFiles(workspace);
    files = (listing && listing.files) || [];
  } catch (e) { /* an unreadable workspace simply detects nothing */ }
  let pkg = null;
  if (files.indexOf("package.json") !== -1) {
    try {
      const r = await window.api.readFile(workspace + "/package.json", { full: true });
      if (r && r.ok) pkg = JSON.parse(r.text);
    } catch (e) { /* an unreadable package.json falls through to the file rules */ }
  }
  let makefile = null;
  if (files.indexOf("Makefile") !== -1) {
    try {
      const mk = await window.api.readFile(workspace + "/Makefile", { full: true });
      if (mk && mk.ok) makefile = mk.text;
    } catch (e) { /* an unreadable Makefile just means no `run` target */ }
  }
  return window.CNEntry
    ? window.CNEntry.detectEntrypoint(files, pkg, { makefile: makefile }, window.api.platform)
    : null;
}

const RUN_LABELS = {
  manifest: ["SAVED", "from closeni.run.json - edit it here and it sticks"],
  plan: ["FROM YOUR PLAN", "the model declared this while planning"],
  detected: ["DETECTED", "guessed from the files in this workspace"],
  none: ["NOT FOUND", "type a command, or build a project and one gets saved"],
};

/** The run command and where it came from: what you saved, the plan's, or detected. */
async function resolveRunCommand() {
  if (!workspace) return { command: null, source: "none" };
  const manifest = await window.api.readManifest(workspace).catch(function () { return null; });
  const detected = await detectCommand();
  if (manifest && String(manifest.run || "").trim()) return { command: manifest.run.trim(), source: "manifest" };
  if (currentPlan && String(currentPlan.runCommand || "").trim()) return { command: currentPlan.runCommand.trim(), source: "plan" };
  if (detected) return { command: detected, source: "detected" };
  return { command: null, source: "none" };
}

async function refreshRunBar() {
  const box = $("test-cmd");
  const badge = $("run-source");
  const hint = $("run-hint");
  if (!box || !badge || !workspace) return;

  const { command, source } = await resolveRunCommand();

  box.value = command || "";
  badge.textContent = RUN_LABELS[source][0];
  badge.className = "run-badge " + source;
  if (hint) hint.textContent = RUN_LABELS[source][1];
}

// Editing the command saves it and marks it, so no later build overwrites it.
$("test-cmd").onchange = async function () {
  const cmd = $("test-cmd").value.trim();
  if (!cmd || !workspace) return;
  await window.api.writeManifest({ workspace: workspace, run: cmd, userEdited: true });
  await refreshRunBar();
  toast("Run command saved");
};

$("test-check").onclick = async function () {
  if (!workspace) { toast("Pick a workspace", "err"); return; }
  setStatus("testing");
  renderTestResults([], "running syntax checks...");
  const res = await runAgent(["testall", "x", workspace, provider]);
  setStatus("idle");
  if (!res) { renderTestResults([], "check failed"); pushHistory("syntax check", false); return; }
  renderTestResults(res.results || [], (res.passed || 0) + " passed, " + (res.failed || 0) + " failed");
  pushHistory("syntax check · " + ((res.passed || 0) + (res.failed || 0)) + " checks", !res.failed);
  lastRun = { command: "syntax check", output: JSON.stringify(res.results || []).slice(0, 4000) }; flowSeen.tested = true; refreshFlow();
};

/*
 * Behaviour, not syntax.
 *
 * "Syntax-check all" answers whether the code compiles. This answers whether it
 * works: the project's own suite if it has one, then a smoke run of the entry
 * point. A suite that exists but whose runner is missing is reported as skipped
 * rather than counted either way - a green "0 failed" on a project whose tests
 * never ran is the most misleading thing this panel could show.
 */
$("test-behaviour").onclick = async function () {
  if (!workspace) { toast("Pick a workspace", "err"); return; }
  setStatus("running tests");
  renderTestResults([], "running the project's tests...");
  const res = await runAgent(["behaviour", workspace, workspace, provider]);
  setStatus("idle");
  if (!res) { renderTestResults([], "could not run"); pushHistory("behaviour", false); return; }

  const passed = res.passed || 0, failed = res.failed || 0, skipped = res.skipped || 0;
  let summary = passed + " passed, " + failed + " failed";
  if (skipped) summary += ", " + skipped + " not run";
  if (!passed && !failed && !skipped) summary = res.note || "nothing to run";

  renderTestResults(res.results || [], summary);
  if (res.note) renderTestOutput(res.note);
  pushHistory("tests · " + summary, !failed);
  lastRun = { command: "behaviour checks", output: JSON.stringify(res.results || []).slice(0, 4000) }; flowSeen.tested = true; refreshFlow();
};

$("test-run").onclick = async function () {
  const cmd = $("test-cmd").value.trim();
  if (!cmd) { toast("Nothing to run - type a command or build a project", "err"); return; }
  if (!workspace) { toast("Pick a workspace", "err"); return; }
  setStatus("running");
  renderTestResults([], "running: " + cmd);
  const r = await window.api.runCommand({ command: cmd, cwd: workspace });
  setStatus("idle");
  renderTestResults([{ command: cmd, success: !!(r && r.success) }], (r && r.success) ? "command succeeded" : "command failed");
  renderTestOutput(r && r.output);
  pushHistory(cmd, !!(r && r.success));
  lastRun = { command: cmd, output: (r && r.output) || "" }; flowSeen.tested = true; refreshFlow();
  if (window.CNBuilderPreview) {
    let files = [];
    try { const l = await window.api.listFiles(workspace); files = (l && l.files) || []; } catch (e) {}
    window.CNBuilderPreview.update((r && r.output) || "", workspace, files);
  }
};

function addTestMsg(who, text) {
  const flow = $("test-chat-flow");
  if (!flow) return null;
  const wrap = document.createElement("div");
  wrap.className = "msg " + who;
  const tag = document.createElement("span");
  tag.className = "msg-label";
  tag.textContent = who === "user" ? "you" : "ai";
  const body = document.createElement("div");
  body.className = "msg-text";
  if (who === "ai" && text && text.length > 40) body.innerHTML = renderMarkdown(text);
  else body.textContent = text;
  wrap.appendChild(tag); wrap.appendChild(body);
  flow.appendChild(wrap);
  flow.scrollTop = flow.scrollHeight;
  return body;
}

$("test-chat-send").onclick = async function () {
  const input = $("test-chat-input");
  const q = input.value.trim();
  if (!q) return;
  if (!workspace) { toast("Pick a workspace", "err"); return; }
  input.value = "";
  addTestMsg("user", q);
  const pending = addTestMsg("ai", "thinking...");
  const cb = $("show-browser");
  const r = await window.api.askRun({
    workspace: workspace, provider: provider, question: q,
    command: lastRun.command, output: lastRun.output,
    headed: cb ? cb.checked : false, controls: desiredControls(),
  }).catch(function (e) { return { success: false, error: String(e) }; });

  if (r && r.success) {
    // A question usually has no fix, and a prose answer is the normal case -
    // it used to be reported as a failure and shown as nothing at all.
    pending.innerHTML = renderMarkdown(r.answer || "(no answer)");
    if (r.appliedFiles && r.appliedFiles.length) {
      const note = document.createElement("div");
      note.className = "hint applied-note";
      note.textContent = "Applied: " + r.appliedFiles.join(", ");
      pending.appendChild(note);
      toast(r.appliedFiles.length + " file(s) changed");
    }
  } else {
    pending.textContent = (r && r.error) || "Could not get an answer.";
  }
};

$("test-chat-input").addEventListener("keydown", function (e) {
  if (e.key === "Enter") { e.preventDefault(); $("test-chat-send").onclick(); }
});

// Re-detect, rather than run. Detection is now one of three sources feeding the
// run bar, so this refreshes it - it does not decide on its own what to execute.
$("test-run-project").onclick = async function () {
  if (!workspace) { toast("Pick a workspace", "err"); return; }
  const detected = await detectCommand();
  if (!detected) { toast("Nothing detectable in this workspace", "err"); return; }
  await window.api.writeManifest({ workspace: workspace, run: detected });
  await refreshRunBar();
  toast("Detected: " + detected);
};
