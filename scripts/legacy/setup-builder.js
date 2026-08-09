const fs = require("fs");
const path = require("path");
function writeFile(p, c) { fs.writeFileSync(path.join(__dirname, p), c, "utf-8"); console.log("  OK " + p); }

console.log("\n=== REBUILDING BUILD SECTION FROM SCRATCH ===\n");

// ================= 1. index.html (clean, all IDs correct, CloseNI) =================
writeFile("desktop/index.html", `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>CloseNI</title>
<link rel="stylesheet" href="styles.css">
</head>
<body>
<div id="app">
  <aside id="rail">
    <div id="wordmark">Close<span>NI</span></div>
    <nav>
      <button class="nav-btn active" data-mode="chat"><i>01</i>Chat</button>
      <button class="nav-btn" data-mode="build"><i>02</i>Builder</button>
      <button class="nav-btn" data-mode="test"><i>03</i>Test</button>
      <button class="nav-btn" data-mode="research"><i>04</i>Research</button>
      <button class="nav-btn" data-mode="push"><i>05</i>Ship</button>
    </nav>
    <div id="rail-bottom">
      <div class="micro">Workspace</div>
      <div id="workspace-label">none selected</div>
      <button id="browse-btn" class="btn">Browse</button>
      <div class="micro" style="margin-top:10px;">Provider</div>
      <select id="provider-select">
        <option value="deepseek">DeepSeek</option>
        <option value="qwen-studio">Qwen Studio</option>
      </select>
      <div style="display:flex;align-items:center;gap:6px;margin-top:12px;">
        <input type="checkbox" id="show-browser" style="width:auto;flex:none;accent-color:var(--txt);">
        <label for="show-browser" style="font-size:11px;color:var(--dim);cursor:pointer;">Show Browser</label>
      </div>
    </div>
  </aside>
  <main id="main">
    <header id="topbar">
      <span id="mode-title">CHAT</span>
      <span id="status-line">idle</span>
    </header>

    <section id="panel-chat" class="panel active">
      <div id="chat-view">
        <div id="chat-column">
          <div id="chat-flow"></div>
          <div id="chat-bar">
            <textarea id="chat-input" placeholder="Ask anything..."></textarea>
            <button id="chat-send" class="btn invert">Send</button>
          </div>
          <button id="generate-plan" class="btn">Generate Implementation Plan</button>
        </div>
        <div id="plan-sidebar" class="hidden">
          <div id="plan-head">
            <div class="micro">Implementation Plan</div>
            <button id="close-plan" class="btn">×</button>
          </div>
          <div id="plan-content"></div>
          <div id="plan-actions">
            <button id="edit-plan" class="btn">Suggest Changes</button>
            <button id="build-plan" class="btn invert">Build with this</button>
          </div>
        </div>
      </div>
    </section>

    <section id="panel-build" class="panel">
      <div id="builder-toolbar">
        <button id="builder-start" class="btn invert">Start Build</button>
        <button id="builder-pause" class="btn" style="display:none;">Pause</button>
        <button id="builder-resume" class="btn" style="display:none;">Resume</button>
        <button id="builder-skip" class="btn" style="display:none;">Skip Step</button>
        <button id="builder-retry" class="btn" style="display:none;">Retry Failed</button>
        <button id="builder-stop" class="btn" style="display:none;">Stop</button>
        <div id="builder-progress-wrap"><div id="builder-progress"></div></div>
        <span id="builder-status">idle</span>
      </div>
      <div id="builder-view">
        <div id="builder-sidebar">
          <div class="micro">Steps</div>
          <div id="step-list"></div>
        </div>
        <div id="builder-main">
          <div id="builder-empty">No plan loaded. Go to Chat, describe your idea, hit Generate Implementation Plan, then Build with this.</div>
          <div id="step-detail" class="hidden">
            <div id="step-detail-head">
              <div class="micro" id="step-detail-label"></div>
              <div id="step-detail-status"></div>
            </div>
            <div id="step-detail-body">
              <div id="step-files"></div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section id="panel-test" class="panel">
      <div class="micro">Test</div>
      <button id="test-check" class="btn">Syntax-check all files</button>
      <div class="row">
        <input id="test-cmd" placeholder="custom command, e.g. python src/main.py">
        <button id="test-run" class="btn">Run</button>
      </div>
    </section>

    <section id="panel-research" class="panel">
      <div class="micro">Research</div>
      <div class="row">
        <input id="research-q" placeholder="e.g. Python Flask SQLite patterns">
        <button id="research-go" class="btn invert">Search</button>
      </div>
      <div id="research-results">
        <div class="research-col"><div class="micro">Web</div><div id="res-web"></div></div>
        <div class="research-col"><div class="micro">GitHub repos</div><div id="res-gh"></div></div>
      </div>
    </section>

    <section id="panel-push" class="panel">
      <div class="micro">Ship</div>
      <div class="row"><button id="git-init" class="btn">git init</button><button id="git-status" class="btn">git status</button></div>
      <div class="row"><input id="commit-msg" placeholder="commit message"><button id="git-commit" class="btn">commit all</button></div>
      <div class="row"><input id="remote-url" placeholder="https://github.com/you/repo.git"><button id="git-push" class="btn">push origin</button></div>
      <div class="hint">First push triggers a one-time GitHub sign-in via Windows.</div>
    </section>

    <div id="log-row">
      <div class="log-box"><div class="micro">Agent</div><div id="log"></div></div>
      <div class="log-box"><div class="micro">Project</div><div id="plog"></div></div>
    </div>
  </main>
</div>

<div id="approval-modal">
  <div id="approval-card">
    <div class="micro">Permission Required</div>
    <p>The agent wants to run:</p>
    <pre id="approval-cmd"></pre>
    <div class="row">
      <button id="approve-yes" class="btn invert">Allow</button>
      <button id="approve-no" class="btn">Deny</button>
    </div>
  </div>
</div>

<div id="toast-stack"></div>
<script src="renderer.js"></script>
<script src="builder.js"></script>
</body>
</html>
`);

// ================= 2. renderer.js (chat/plan/etc, NO builder code) =================
writeFile("desktop/renderer.js", String.raw`let workspace = "";
let provider = "deepseek";
let chatHistory = [];
let currentPlan = null;
let editingPlan = false;

const MODE_TITLES = { chat: "CHAT", build: "BUILDER", test: "TEST", research: "RESEARCH", push: "SHIP" };

function $(id) { return document.getElementById(id); }
function setStatus(t) { const el = $("status-line"); if (el) el.textContent = t; }

function toast(msg, kind) {
  const stack = $("toast-stack"); if (!stack) return;
  const el = document.createElement("div");
  el.className = "toast" + (kind === "err" ? " err" : "");
  el.textContent = (kind === "err" ? "x " : "") + msg;
  stack.appendChild(el);
  setTimeout(function () { el.style.opacity = "0"; el.style.transition = "opacity .3s"; }, 3500);
  setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 3900);
}

function log(line, cls) {
  const box = $("log"); if (!box) return;
  const el = document.createElement("div");
  el.className = "log-line" + (cls ? " " + cls : "");
  el.textContent = line;
  box.appendChild(el); box.scrollTop = box.scrollHeight;
}
function plog(line) {
  const box = $("plog"); if (!box) return;
  const el = document.createElement("div");
  el.className = "log-line"; el.textContent = line;
  box.appendChild(el); box.scrollTop = box.scrollHeight;
}

function escapeHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function inline(s) {
  let o = escapeHtml(s);
  o = o.replace(/\`([^\`]+)\`/g, '<code class="md-inline">$1</code>');
  o = o.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  o = o.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return o;
}
function renderTextPart(t) {
  const lines = t.split(/\r?\n/);
  let html = "", inList = false, para = [];
  function flush() { if (para.length) { html += '<p class="md-p">' + inline(para.join(" ")) + "</p>"; para = []; } }
  function close() { if (inList) { html += "</ul>"; inList = false; } }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) { flush(); close(); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flush(); close(); html += '<div class="md-h">' + inline(h[2]) + "</div>"; continue; }
    const b = line.match(/^[-*•]\s+(.*)$/);
    if (b) { flush(); if (!inList) { html += '<ul class="md-ul">'; inList = true; } html += "<li>" + inline(b[1]) + "</li>"; continue; }
    const n = line.match(/^\d+[.)]\s+(.*)$/);
    if (n) { flush(); if (!inList) { html += '<ul class="md-ul">'; inList = true; } html += "<li>" + inline(n[1]) + "</li>"; continue; }
    para.push(line);
  }
  flush(); close();
  return html;
}
function renderMarkdown(md) {
  const re = /\`\`\`\w*\n?([\s\S]*?)\`\`\`/g;
  let last = 0, m, html = "";
  while ((m = re.exec(md)) !== null) {
    if (m.index > last) html += renderTextPart(md.substring(last, m.index));
    html += '<pre class="md-code">' + escapeHtml(m[1]) + "</pre>";
    last = re.lastIndex;
  }
  if (last < md.length) html += renderTextPart(md.substring(last));
  return html;
}

window.api.onLog(log);
window.api.onPLog(plog);
window.api.onApproval(function (req) {
  $("approval-cmd").textContent = req.command;
  $("approval-modal").classList.add("show");
});
$("approve-yes").onclick = function () { $("approval-modal").classList.remove("show"); window.api.respondApproval(true); };
$("approve-no").onclick = function () { $("approval-modal").classList.remove("show"); window.api.respondApproval(false); };

function switchTab(mode) {
  document.querySelectorAll(".nav-btn").forEach(function (b) { b.classList.toggle("active", b.dataset.mode === mode); });
  document.querySelectorAll(".panel").forEach(function (p) { p.classList.remove("active"); });
  const panel = $("panel-" + mode);
  if (panel) panel.classList.add("active");
  $("mode-title").textContent = MODE_TITLES[mode] || "";
}
document.querySelectorAll(".nav-btn").forEach(function (btn) {
  btn.onclick = function () { switchTab(btn.dataset.mode); };
});

$("browse-btn").onclick = async function () {
  const f = await window.api.selectFolder();
  if (f) { workspace = f; $("workspace-label").textContent = f; log("workspace: " + f, "ok"); }
};
$("provider-select").onchange = function (e) { provider = e.target.value; };

function runAgent(args) {
  try {
    const cb = $("show-browser");
    const headed = cb ? cb.checked : false;
    return window.api.runAgent({ args: args, headed: headed }).catch(function (e) { return { success: false, error: String(e) }; });
  } catch (e) { return Promise.resolve({ success: false, error: String(e) }); }
}

function addBubble(who, text) {
  const flow = $("chat-flow"); if (!flow) return null;
  const wrap = document.createElement("div");
  wrap.className = "msg " + who;
  const label = document.createElement("span");
  label.className = "msg-label";
  label.textContent = who === "user" ? "you" : "ai";
  const body = document.createElement("div");
  body.className = "msg-text";
  if (who === "ai" && text && text.length > 40) body.innerHTML = renderMarkdown(text);
  else body.textContent = text;
  wrap.appendChild(label); wrap.appendChild(body);
  flow.appendChild(wrap);
  flow.scrollTop = flow.scrollHeight;
  return body;
}

function tryExtractPlan(text) {
  const jm = text.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/);
  const s = jm ? jm[1].trim() : text.trim();
  try { const o = JSON.parse(s); if (o && o.steps) return o; } catch (e) {}
  try {
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a !== -1 && b > a) { const o = JSON.parse(s.substring(a, b + 1)); if (o && o.steps) return o; }
  } catch (e) {}
  return null;
}

function renderPlanDocument(plan) {
  const content = $("plan-content");
  if (!content) return;
  content.innerHTML = "";

  const summary = document.createElement("div");
  summary.className = "plan-summary";
  summary.textContent = plan.summary || "Implementation Plan";
  content.appendChild(summary);

  const allFiles = new Set();
  (plan.steps || []).forEach(function (s) { (s.files || []).forEach(function (f) { allFiles.add(f); }); });
  if (allFiles.size > 0) {
    const sec = document.createElement("div");
    sec.className = "plan-section";
    sec.innerHTML = '<div class="plan-section-title">File Structure</div><div class="plan-file-tree">' + escapeHtml(Array.from(allFiles).sort().join("\n")) + '</div>';
    content.appendChild(sec);
  }

  const techSet = new Set();
  (plan.steps || []).forEach(function (s) {
    (s.files || []).forEach(function (f) {
      if (f.endsWith(".py")) techSet.add("Python");
      else if (f.endsWith(".js")) techSet.add("JavaScript");
      else if (f.endsWith(".ts")) techSet.add("TypeScript");
      else if (f.endsWith(".html")) techSet.add("HTML");
      else if (f.endsWith(".css")) techSet.add("CSS");
    });
    const d = (s.detail || "").toLowerCase();
    ["flask", "django", "react", "sqlite", "postgres", "fastapi", "express"].forEach(function (k) {
      if (d.indexOf(k) !== -1) techSet.add(k.charAt(0).toUpperCase() + k.slice(1));
    });
  });
  if (techSet.size > 0) {
    const sec = document.createElement("div");
    sec.className = "plan-section";
    let tags = "";
    techSet.forEach(function (t) { tags += '<span class="plan-tech-tag">' + escapeHtml(t) + '</span>'; });
    sec.innerHTML = '<div class="plan-section-title">Tech Stack</div><div class="plan-tech-stack">' + tags + '</div>';
    content.appendChild(sec);
  }

  const sec = document.createElement("div");
  sec.className = "plan-section";
  sec.innerHTML = '<div class="plan-section-title">Implementation Steps</div>';
  (plan.steps || []).forEach(function (s, i) {
    const step = document.createElement("div");
    step.className = "plan-step";
    const files = (s.files || []).length ? '<div class="plan-step-files">' + escapeHtml(s.files.join("  ")) + '</div>' : "";
    step.innerHTML =
      '<div class="plan-step-head"><span class="plan-step-num">0' + (i + 1) + '</span>' +
      '<span class="plan-step-title">' + escapeHtml(s.title || "Step") + '</span></div>' +
      '<div class="plan-step-detail">' + escapeHtml(s.detail || "") + '</div>' + files;
    sec.appendChild(step);
  });
  content.appendChild(sec);

  $("plan-sidebar").classList.remove("hidden");
  if (window.CN) window.CN.setPlan(plan);
}

function resetEditState() {
  editingPlan = false;
  $("chat-input").placeholder = "Ask anything...";
  $("chat-send").textContent = "Send";
  $("edit-plan").textContent = "Suggest Changes";
}

$("chat-send").onclick = async function () {
  const text = $("chat-input").value.trim();
  if (!text) return;
  if (!workspace) { toast("Pick a workspace first", "err"); return; }

  if (editingPlan && currentPlan) {
    addBubble("user", text);
    $("chat-input").value = "";
    const ph = addBubble("ai", "...");
    setStatus("updating plan");
    const res = await runAgent(["revise", text, workspace, provider]);
    setStatus("idle");
    if (res && res.plan && res.plan.steps) {
      currentPlan = res.plan;
      renderPlanDocument(res.plan);
      ph.textContent = "Plan updated: " + (res.plan.summary || "") + " (" + res.plan.steps.length + " steps)";
      toast("Plan updated");
    } else {
      ph.textContent = "Plan update failed: " + ((res && res.error) || "unknown");
      toast("Plan update failed", "err");
    }
    resetEditState();
    chatHistory.push({ role: "user", text: text });
    return;
  }

  addBubble("user", text);
  $("chat-input").value = "";
  const ph = addBubble("ai", "...");
  setStatus("agent working");
  const res = await runAgent(["chat", text, workspace, provider]);
  setStatus("idle");
  if (res && res.answer) {
    ph.innerHTML = renderMarkdown(res.answer);
    const p = tryExtractPlan(res.answer);
    if (p) { currentPlan = p; renderPlanDocument(p); toast("Plan detected"); }
  } else {
    ph.textContent = "AI reply failed: " + ((res && res.error) || "unknown");
  }
  chatHistory.push({ role: "user", text: text });
  if (ph.textContent && ph.textContent !== "...") chatHistory.push({ role: "ai", text: ph.textContent });
};

$("generate-plan").onclick = async function () {
  if (!workspace) { toast("Pick a workspace first", "err"); return; }
  if (chatHistory.length === 0) { toast("Chat about your idea first", "err"); return; }
  let transcript = "";
  chatHistory.forEach(function (m) { transcript += (m.role === "user" ? "USER: " : "AI: ") + m.text + "\n\n"; });
  setStatus("generating plan");
  addBubble("ai", "Generating implementation plan...");
  const res = await runAgent(["plan", transcript, workspace, provider]);
  setStatus("idle");
  if (res && res.plan && res.plan.steps) {
    currentPlan = res.plan;
    renderPlanDocument(res.plan);
    toast("Plan ready: " + res.plan.steps.length + " steps");
  } else {
    toast("Plan failed: " + ((res && res.error) || "unknown"), "err");
  }
};

$("close-plan").onclick = function () { $("plan-sidebar").classList.add("hidden"); };

$("edit-plan").onclick = function () {
  if (!currentPlan) { toast("No plan to edit", "err"); return; }
  editingPlan = !editingPlan;
  if (editingPlan) {
    $("chat-input").placeholder = "Describe changes to the plan...";
    $("chat-send").textContent = "Update Plan";
    $("edit-plan").textContent = "Cancel";
    $("chat-input").focus();
  } else resetEditState();
};

$("build-plan").onclick = function () {
  if (!currentPlan) { toast("No plan", "err"); return; }
  switchTab("build");
  if (window.CN) { window.CN.setPlan(currentPlan); window.CN.startBuild(); }
};

$("research-go").onclick = async function () {
  const q = $("research-q").value.trim();
  if (!q) { toast("Type a query", "err"); return; }
  if (!workspace) { toast("Pick a workspace", "err"); return; }
  setStatus("researching");
  const res = await runAgent(["research", q, workspace, provider]);
  setStatus("idle");
  const webBox = $("res-web"); const ghBox = $("res-gh");
  webBox.innerHTML = ""; ghBox.innerHTML = "";
  if (!res || !res.success) { toast("Research failed", "err"); return; }
  (res.web || []).forEach(function (r) {
    const el = document.createElement("div");
    el.className = "res-item";
    el.innerHTML = '<a href="' + escapeHtml(r.url) + '" target="_blank">' + escapeHtml(r.title || "(no title)") + '</a>' +
      '<div class="res-snippet">' + escapeHtml(r.snippet || "") + '</div>';
    webBox.appendChild(el);
  });
  (res.github || []).forEach(function (r) {
    const el = document.createElement("div");
    el.className = "res-item";
    el.innerHTML = '<a href="' + escapeHtml(r.url) + '" target="_blank">' + escapeHtml(r.title) + '</a>' +
      '<div class="res-snippet">' + escapeHtml(r.snippet || "") + '</div>' +
      '<div class="res-meta">' + (r.stars || 0) + ' stars</div>';
    ghBox.appendChild(el);
  });
  toast("Research done");
};

$("test-check").onclick = async function () {
  if (!workspace) { toast("Pick a workspace", "err"); return; }
  setStatus("testing");
  await runAgent(["testall", "x", workspace, provider]);
  setStatus("idle");
};
$("test-run").onclick = async function () {
  const cmd = $("test-cmd").value.trim();
  if (!cmd) { toast("Type a command", "err"); return; }
  if (!workspace) { toast("Pick a workspace", "err"); return; }
  const r = await window.api.runCommand({ command: cmd, cwd: workspace });
  log(r.success ? "exit 0" : "non-zero exit", r.success ? "ok" : "err");
};

async function g(args) { return await window.api.git({ args: args, cwd: workspace }); }
$("git-init").onclick = async function () { if (workspace) await g(["init", "-b", "main"]); else toast("Pick a workspace", "err"); };
$("git-status").onclick = async function () { if (workspace) await g(["status", "--short"]); else toast("Pick a workspace", "err"); };
$("git-commit").onclick = async function () {
  if (!workspace) { toast("Pick a workspace", "err"); return; }
  const msg = $("commit-msg").value.trim() || "AI: automated changes";
  await g(["add", "-A"]);
  await g(["commit", "-m", msg]);
};
$("git-push").onclick = async function () {
  if (!workspace) { toast("Pick a workspace", "err"); return; }
  const remote = $("remote-url").value.trim();
  if (remote) { await g(["remote", "remove", "origin"]); await g(["remote", "add", "origin", remote]); }
  await g(["push", "-u", "origin", "main"]);
};

window.CN = {
  getWorkspace: function () { return workspace; },
  getProvider: function () { return provider; },
  getPlan: function () { return currentPlan; },
  runAgent: runAgent,
  log: log,
  toast: toast,
  escapeHtml: escapeHtml,
  readFile: function (p) { return window.api.readFile(p); },
  switchTab: switchTab,
  setPlan: function () {},
  startBuild: function () {},
  retryFailed: function () {},
};
`);

// ================= 3. builder.js (isolated build module) =================
writeFile("desktop/builder.js", String.raw`(function () {
  const CN = window.CN;
  let steps = [];
  let running = false, paused = false, skipNext = false, stopRequested = false;
  let selected = -1;

  function $(id) { return document.getElementById(id); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function status(t) { const el = $("builder-status"); if (el) el.textContent = t; }
  function progress(frac) { const el = $("builder-progress"); if (el) el.style.width = Math.round(frac * 100) + "%"; }

  function buttons(mode) {
    function show(id, on) { const el = $(id); if (el) el.style.display = on ? "inline-block" : "none"; }
    show("builder-start", mode === "idle");
    show("builder-pause", mode === "running");
    show("builder-skip", mode === "running");
    show("builder-stop", mode === "running" || mode === "paused");
    show("builder-resume", mode === "paused");
    show("builder-retry", mode === "idle" && steps.some(function (s) { return s.status === "failed"; }));
  }

  function renderList() {
    const list = $("step-list"); if (!list) return;
    list.innerHTML = "";
    steps.forEach(function (s, i) {
      const card = document.createElement("div");
      card.className = "step-card" + (i === selected ? " active" : "");
      card.innerHTML =
        '<span class="step-card-num">0' + (i + 1) + '</span>' +
        '<span class="step-card-title">' + CN.escapeHtml(s.title || "Step") + '</span>' +
        '<span class="step-card-status ' + s.status + '">' + s.status + '</span>';
      card.onclick = function () { selectStep(i); };
      list.appendChild(card);
    });
  }

  function setStatusOf(i, st) {
    steps[i].status = st;
    renderList();
    if (i === selected) $("step-detail-status").textContent = st;
  }

  function selectStep(i) {
    selected = i;
    renderList();
    const s = steps[i];
    $("builder-empty").style.display = "none";
    $("step-detail").classList.remove("hidden");
    $("step-detail-label").textContent = "0" + (i + 1) + " " + (s.title || "");
    $("step-detail-status").textContent = s.status;

    const body = $("step-files");
    body.innerHTML = "";

    const detail = document.createElement("div");
    detail.className = "file-card";
    detail.innerHTML = '<div class="file-card-head"><span class="file-path">step detail</span><span class="file-mode">' + s.status + '</span></div>' +
      '<div class="file-body open"><pre>' + CN.escapeHtml(s.detail || "(no detail)") + '</pre></div>';
    body.appendChild(detail);

    if (s.result && s.result.error) {
      const err = document.createElement("div");
      err.className = "file-card";
      err.innerHTML = '<div class="file-card-head"><span class="file-path">error</span><span class="file-mode failed">failed</span></div>' +
        '<div class="file-body open"><pre>' + CN.escapeHtml(s.result.error) + '</pre></div>';
      body.appendChild(err);
    }

    if (s.result && s.result.files) {
      s.result.files.forEach(function (f) {
        const fc = document.createElement("div");
        fc.className = "file-card";
        const head = document.createElement("div");
        head.className = "file-card-head";
        head.innerHTML = '<span class="file-path">' + CN.escapeHtml(f.path) + '</span><span class="file-mode ' + (f.mode || "create") + '">' + (f.mode || "create") + '</span>';
        head.onclick = function () { const bb = fc.querySelector(".file-body"); if (bb) bb.classList.toggle("open"); };
        const bb = document.createElement("div");
        bb.className = "file-body";
        bb.innerHTML = "<pre>" + CN.escapeHtml(f.content || "") + "</pre>";
        fc.appendChild(head); fc.appendChild(bb);
        body.appendChild(fc);
      });
    }
  }

  async function runOne(i) {
    const ws = CN.getWorkspace();
    const plan = CN.getPlan();
    const s = steps[i];
    selectStep(i);
    setStatusOf(i, "running");
    status("building " + (i + 1) + "/" + steps.length);
    CN.log("step " + (i + 1) + "/" + steps.length + ": " + (s.title || ""), "step");
    CN.toast("Step " + (i + 1) + ": " + (s.title || ""));

    const stepDetail = "Overall: " + ((plan && plan.summary) || "") +
      "\n\nExecute ONLY this step: " + (s.title || "") + ". " + (s.detail || "") +
      (s.files && s.files.length ? " Expected files: " + s.files.join(", ") : "");
    const args = ["browser", stepDetail, ws, CN.getProvider(), "ask", String(i), stepDetail, (plan && plan.summary) || ""];
    const res = await CN.runAgent(args);

    if (res && res.success) {
      const filesArr = [];
      for (const af of (res.appliedFiles || [])) {
        let content = "[could not load]";
        try {
          const fr = await CN.readFile(ws + "/" + af);
          if (fr && fr.ok) content = fr.text + (fr.truncated ? "\n... (truncated)" : "");
        } catch (e) {}
        filesArr.push({ path: af, mode: "written", content: content });
      }
      s.result = { files: filesArr };
      setStatusOf(i, "done");
      CN.log("step " + (i + 1) + " done: " + (res.appliedFiles || []).join(", "), "ok");
      CN.toast("Step " + (i + 1) + " complete");
      return true;
    } else {
      s.result = { error: (res && res.error) || "unknown" };
      setStatusOf(i, "failed");
      CN.log("step " + (i + 1) + " failed: " + ((res && res.error) || "unknown"), "err");
      CN.toast("Step " + (i + 1) + " failed", "err");
      selectStep(i);
      return false;
    }
  }

  CN.setPlan = function (plan) {
    if (!plan || !plan.steps) return;
    steps = plan.steps.map(function (s) { return { title: s.title, detail: s.detail, files: s.files || [], status: "pending", result: null }; });
    selected = -1;
    renderList();
    $("builder-empty").style.display = steps.length ? "none" : "block";
    $("step-detail").classList.add("hidden");
    buttons("idle");
    progress(0);
    status("ready: " + steps.length + " steps");
  };

  CN.startBuild = async function () {
    if (running) { CN.toast("Already running", "err"); return; }
    if (!steps.length) { CN.toast("No plan - generate one first", "err"); return; }
    if (!CN.getWorkspace()) { CN.toast("Pick a workspace", "err"); return; }
    running = true; stopRequested = false; paused = false;
    buttons("running");

    for (let i = 0; i < steps.length; i++) {
      if (stopRequested) break;
      while (paused && !stopRequested) await sleep(500);
      if (stopRequested) break;
      if (skipNext) {
        skipNext = false;
        setStatusOf(i, "skipped");
        CN.log("step " + (i + 1) + " skipped", "step");
        progress((i + 1) / steps.length);
        continue;
      }
      const ok = await runOne(i);
      progress((i + 1) / steps.length);
      if (!ok) break;
    }

    running = false;
    buttons("idle");
    const done = steps.filter(function (s) { return s.status === "done" || s.status === "skipped"; }).length;
    status("finished: " + done + "/" + steps.length);
    CN.log("build finished: " + done + "/" + steps.length, "step");
    CN.toast("Build finished: " + done + "/" + steps.length);
  };

  CN.retryFailed = async function () {
    if (running) { CN.toast("Already running", "err"); return; }
    const i = steps.findIndex(function (s) { return s.status === "failed"; });
    if (i === -1) return;
    running = true;
    buttons("running");
    await runOne(i);
    running = false;
    buttons("idle");
  };

  $("builder-start").onclick = function () { CN.startBuild(); };
  $("builder-pause").onclick = function () { paused = true; buttons("paused"); status("paused"); CN.toast("Paused"); };
  $("builder-resume").onclick = function () { paused = false; buttons("running"); status("resumed"); CN.toast("Resumed"); };
  $("builder-skip").onclick = function () { skipNext = true; CN.toast("Will skip next step"); };
  $("builder-stop").onclick = function () { stopRequested = true; paused = false; status("stopping..."); CN.toast("Stopping", "err"); };
  $("builder-retry").onclick = function () { CN.retryFailed(); };

  if (CN.getPlan()) CN.setPlan(CN.getPlan());
})();
`);

// ================= 4. styles.css: add builder toolbar styles =================
const sPath = path.join(__dirname, "desktop", "styles.css");
let s = fs.readFileSync(sPath, "utf-8");
if (s.indexOf("#builder-toolbar") === -1) {
  s += `
#builder-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
#builder-progress-wrap{flex:1;min-width:120px;height:6px;background:#17171a;border:1px solid var(--line);border-radius:3px;overflow:hidden;}
#builder-progress{height:100%;width:0%;background:var(--txt);transition:width .4s ease;}
#builder-status{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--dim);}
.step-card-status.done{color:var(--txt);border-color:var(--txt);}
.step-card-status.failed{color:#fff;background:var(--mut);border-color:var(--mut);}
.step-card-status.skipped{color:var(--mut);border-style:dashed;}
.step-card-status.running{color:var(--txt);border-color:var(--txt);animation:pulse 1.4s infinite;}
`;
  fs.writeFileSync(sPath, s, "utf-8");
  console.log("  OK styles.css (builder toolbar styles)");
}

console.log("\n=== Build section rebuilt. Rebuild + launch ===\n");
