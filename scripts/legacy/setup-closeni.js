const fs = require('fs');
const path = require('path');

console.log('\n=== CLOSENI: Full fix + rename ===\n');

function write(p, c) {
  const full = path.join(__dirname, p);
  fs.writeFileSync(full, c, 'utf-8');
  console.log('  OK ' + p);
}

// ====== 1. Controller: fix browser visibility + 120s timeout ======
const cPath = 'local-agent/src/providers/playwright-controller.ts';
let c = fs.readFileSync(cPath, 'utf-8');

if (c.indexOf('private isHeaded') === -1) {
  c = c.replace('private chatUrlFile: string;', 'private chatUrlFile: string;\n  private isHeaded: boolean;');
}

if (c.indexOf('this.isHeaded = process.env') === -1) {
  c = c.replace(
    'constructor(config: ProviderConfig) {',
    'constructor(config: ProviderConfig) {\n    this.isHeaded = process.env.AGENT_HEADED === "1";'
  );
}

c = c.replace(/const isHeadless = [^;]+;/, 'const isHeadless = !this.isHeaded;');

c = c.replace(
  /console\.log\("Launching browser \([^)]+\) for " \+ config\.name/,
  'console.log("Launching browser (" + (isHeadless ? "headless" : "HEADED - watch me!") + ") for " + config.name'
);

c = c.replace(/const maxWait = \d+;/, 'const maxWait = 120000;');
c = c.replace(/console\.log\("Waiting for AI response \([^)]+\)"\);/, 'console.log("Waiting for AI response (120s)...");');

write(cPath, c);

// ====== 2. Renderer: full rewrite with CloseNI branding + QoL ======
const rPath = 'desktop/renderer.js';
write(rPath, String.raw`let workspace = "";
let provider = "deepseek";
let chatHistory = [];
let currentPlan = null;
let buildRunning = false;
let buildPaused = false;
let skipCurrentStep = false;
let builderSteps = [];
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
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = "opacity .3s"; }, 3500);
  setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 3900);
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

function escapeHtml(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
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
  const flush = () => { if (para.length) { html += '<p class="md-p">' + inline(para.join(" ")) + "</p>"; para = []; } };
  const close = () => { if (inList) { html += "</ul>"; inList = false; } };
  for (const raw of lines) {
    const line = raw.trim();
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
window.api.onApproval(req => {
  $("approval-cmd").textContent = req.command;
  $("approval-modal").classList.add("show");
});
$("approve-yes").onclick = () => { $("approval-modal").classList.remove("show"); window.api.respondApproval(true); };
$("approve-no").onclick  = () => { $("approval-modal").classList.remove("show"); window.api.respondApproval(false); };

document.querySelectorAll(".nav-btn").forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    const panel = $("panel-" + btn.dataset.mode);
    if (panel) panel.classList.add("active");
    $("mode-title").textContent = MODE_TITLES[btn.dataset.mode] || "";
  };
});

$("browse-btn").onclick = async () => {
  const f = await window.api.selectFolder();
  if (f) { workspace = f; $("workspace-label").textContent = f; log("workspace: " + f, "ok"); }
};
$("provider-select").onchange = (e) => { provider = e.target.value; };

function runAgent(args) {
  try {
    const cb = document.getElementById("show-browser");
    const headed = cb ? cb.checked : false;
    return window.api.runAgent({ args: args, headed: headed }).catch(e => ({ success: false, error: String(e) }));
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
  try { const o = JSON.parse(s); if (o && o.steps) return o; } catch {}
  try {
    const a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a !== -1 && b > a) { const o = JSON.parse(s.substring(a, b+1)); if (o && o.steps) return o; }
  } catch {}
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
  (plan.steps || []).forEach(s => (s.files || []).forEach(f => allFiles.add(f)));
  if (allFiles.size > 0) {
    const sec = document.createElement("div");
    sec.className = "plan-section";
    sec.innerHTML = '<div class="plan-section-title">File Structure</div><div class="plan-file-tree">' + escapeHtml([...allFiles].sort().join("\n")) + '</div>';
    content.appendChild(sec);
  }

  const techSet = new Set();
  (plan.steps || []).forEach(s => {
    (s.files || []).forEach(f => {
      if (f.endsWith(".py")) techSet.add("Python");
      else if (f.endsWith(".js")) techSet.add("JavaScript");
      else if (f.endsWith(".ts")) techSet.add("TypeScript");
      else if (f.endsWith(".html")) techSet.add("HTML");
      else if (f.endsWith(".css")) techSet.add("CSS");
    });
    const d = (s.detail || "").toLowerCase();
    ["flask","django","react","sqlite","postgres","fastapi","express","node"].forEach(k => {
      if (d.includes(k)) techSet.add(k.charAt(0).toUpperCase() + k.slice(1));
    });
  });
  if (techSet.size > 0) {
    const sec = document.createElement("div");
    sec.className = "plan-section";
    let tags = "";
    techSet.forEach(t => tags += '<span class="plan-tech-tag">' + escapeHtml(t) + '</span>');
    sec.innerHTML = '<div class="plan-section-title">Tech Stack</div><div class="plan-tech-stack">' + tags + '</div>';
    content.appendChild(sec);
  }

  const sec = document.createElement("div");
  sec.className = "plan-section";
  sec.innerHTML = '<div class="plan-section-title">Implementation Steps</div>';
  (plan.steps || []).forEach((s, i) => {
    const step = document.createElement("div");
    step.className = "plan-step";
    const files = (s.files || []).length ? '<div class="plan-step-files">' + escapeHtml(s.files.join("  ")) + '</div>' : "";
    step.innerHTML =
      '<div class="plan-step-head">' +
      '<span class="plan-step-num">0' + (i+1) + '</span>' +
      '<span class="plan-step-title">' + escapeHtml(s.title || "Step") + '</span>' +
      '</div>' +
      '<div class="plan-step-detail">' + escapeHtml(s.detail || "") + '</div>' +
      files;
    sec.appendChild(step);
  });
  content.appendChild(sec);

  $("plan-sidebar").classList.remove("hidden");
}

function resetEditState() {
  editingPlan = false;
  $("chat-input").placeholder = "Ask anything...";
  $("chat-send").textContent = "Send";
  $("edit-plan").textContent = "Suggest Changes";
}

$("chat-send").onclick = async () => {
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

$("generate-plan").onclick = async () => {
  if (!workspace) { toast("Pick a workspace first", "err"); return; }
  if (chatHistory.length === 0) { toast("Chat about your idea first", "err"); return; }
  let transcript = "";
  chatHistory.forEach(m => transcript += (m.role === "user" ? "USER: " : "AI: ") + m.text + "\n\n");
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

$("close-plan").onclick = () => $("plan-sidebar").classList.add("hidden");

$("edit-plan").onclick = () => {
  if (!currentPlan) { toast("No plan to edit", "err"); return; }
  editingPlan = !editingPlan;
  if (editingPlan) {
    $("chat-input").placeholder = "Describe changes to the plan...";
    $("chat-send").textContent = "Update Plan";
    $("edit-plan").textContent = "Cancel";
    $("chat-input").focus();
  } else resetEditState();
};

$("build-plan").onclick = () => {
  if (!currentPlan) { toast("No plan", "err"); return; }
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
  document.querySelector('.nav-btn[data-mode="build"]').classList.add("active");
  document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
  $("panel-build").classList.add("active");
  $("mode-title").textContent = "BUILDER";
  populateBuilderSteps();
  $("builder-start").click();
};

function populateBuilderSteps() {
  const list = $("step-list");
  if (!list || !currentPlan) return;
  list.innerHTML = "";
  builderSteps = currentPlan.steps.map(s => ({ title: s.title, detail: s.detail, files: s.files || [], status: "pending", result: null }));
  builderSteps.forEach((s, i) => {
    const card = document.createElement("div");
    card.className = "step-card";
    card.dataset.idx = i;
    card.innerHTML =
      '<span class="step-card-num">0' + (i+1) + '</span>' +
      '<span class="step-card-title">' + escapeHtml(s.title) + '</span>' +
      '<span class="step-card-status">pending</span>';
    card.onclick = () => selectStep(i);
    list.appendChild(card);
  });
  $("builder-empty").style.display = builderSteps.length ? "none" : "block";
}

function selectStep(i) {
  document.querySelectorAll(".step-card").forEach(c => c.classList.remove("active"));
  const cards = document.querySelectorAll(".step-card");
  if (cards[i]) cards[i].classList.add("active");
  const s = builderSteps[i];
  $("builder-empty").style.display = "none";
  $("step-detail").classList.remove("hidden");
  $("step-detail-label").textContent = "0" + (i+1) + " " + s.title;
  $("step-detail-status").textContent = s.status;

  const body = $("step-files");
  body.innerHTML = "";

  const detail = document.createElement("div");
  detail.className = "file-card";
  detail.innerHTML = '<div class="file-card-head"><span class="file-path">step detail</span><span class="file-mode">' + s.status + '</span></div>' +
    '<div class="file-body open"><pre>' + escapeHtml(s.detail || "(no detail)") + '</pre></div>';
  body.appendChild(detail);

  if (s.result && s.result.files) {
    s.result.files.forEach(f => {
      const fc = document.createElement("div");
      fc.className = "file-card";
      const head = document.createElement("div");
      head.className = "file-card-head";
      head.innerHTML = '<span class="file-path">' + escapeHtml(f.path) + '</span><span class="file-mode ' + (f.mode||"create") + '">' + (f.mode||"create") + '</span>';
      head.onclick = () => { const bb = fc.querySelector(".file-body"); if (bb) bb.classList.toggle("open"); };
      const bb = document.createElement("div");
      bb.className = "file-body";
      bb.innerHTML = "<pre>" + escapeHtml(f.content || "") + "</pre>";
      fc.appendChild(head); fc.appendChild(bb);
      body.appendChild(fc);
    });
  }
}

function setStepStatus(i, status) {
  builderSteps[i].status = status;
  const cards = document.querySelectorAll(".step-card");
  if (cards[i]) {
    const st = cards[i].querySelector(".step-card-status");
    if (st) { st.textContent = status; st.className = "step-card-status " + status; }
  }
  const active = document.querySelector(".step-card.active");
  if (active && active.dataset.idx == i) $("step-detail-status").textContent = status;
}

$("builder-start").onclick = async () => {
  if (!currentPlan) { toast("Generate a plan first", "err"); return; }
  if (buildRunning) { toast("Build already running", "err"); return; }
  if (!workspace) { toast("Pick a workspace", "err"); return; }
  buildRunning = true; buildPaused = false; skipCurrentStep = false;
  populateBuilderSteps();
  $("builder-start").style.display = "none";
  $("builder-pause").style.display = "block";
  $("builder-skip").style.display = "block";

  for (let k = 0; k < currentPlan.steps.length; k++) {
    if (!buildRunning) break;
    while (buildPaused) {
      await new Promise(r => setTimeout(r, 500));
      if (!buildRunning) break;
    }
    if (!buildRunning) break;

    if (skipCurrentStep) {
      skipCurrentStep = false;
      setStepStatus(k, "skipped");
      log("step " + (k+1) + " skipped", "step");
      toast("Step " + (k+1) + " skipped");
      continue;
    }

    const s = builderSteps[k];
    setStepStatus(k, "running");
    log("step " + (k+1) + "/" + currentPlan.steps.length + ": " + s.title, "step");
    toast("Step " + (k+1) + ": " + s.title);

    const stepDetail = "Overall: " + (currentPlan.summary || "") +
      "\n\nExecute ONLY this step: " + s.title + ". " + (s.detail || "") +
      (s.files && s.files.length ? " Expected files: " + s.files.join(", ") : "");
    const args = ["browser", stepDetail, workspace, provider, "ask", String(k), stepDetail, currentPlan.summary || ""];
    const res = await runAgent(args);

    if (res && res.success) {
      const filesArr = [];
      for (const af of (res.appliedFiles || [])) {
        let content = "[click to load]";
        try {
          const fr = await window.api.readFile(path_join(workspace, af));
          if (fr && fr.ok) content = fr.text + (fr.truncated ? "\n... (truncated)" : "");
        } catch (e) { content = "[error loading]"; }
        filesArr.push({ path: af, mode: "written", content: content });
      }
      s.result = { files: filesArr };
      setStepStatus(k, "done");
      log("step " + (k+1) + " done: " + (res.appliedFiles || []).join(", "), "ok");
      toast("Step " + (k+1) + " complete");
    } else {
      s.result = { error: (res && res.error) || "unknown" };
      setStepStatus(k, "failed");
      log("step " + (k+1) + " failed: " + ((res && res.error) || "unknown"), "err");
      toast("Step " + (k+1) + " failed", "err");
      break;
    }
  }

  buildRunning = false;
  $("builder-start").style.display = "block";
  $("builder-pause").style.display = "none";
  $("builder-resume").style.display = "none";
  $("builder-skip").style.display = "none";
  log("plan execution finished", "step");
};

// Simple path join for Windows/Unix
function path_join(a, b) {
  if (b.startsWith("/") || b.match(/^[A-Za-z]:/)) return b;
  return a.replace(/[/\\]$/, "") + "/" + b;
}

$("builder-pause").onclick = () => {
  buildPaused = true;
  $("builder-pause").style.display = "none";
  $("builder-resume").style.display = "block";
  toast("Build paused");
};
$("builder-resume").onclick = () => {
  buildPaused = false;
  $("builder-resume").style.display = "none";
  $("builder-pause").style.display = "block";
  toast("Build resumed");
};
$("builder-skip").onclick = () => {
  skipCurrentStep = true;
  toast("Will skip after current step");
};
$("builder-stop").onclick = () => {
  if (buildRunning) { buildRunning = false; toast("Build stopped", "err"); }
};

$("research-go").onclick = async () => {
  const q = $("research-q").value.trim();
  if (!q) { toast("Type a query", "err"); return; }
  if (!workspace) { toast("Pick a workspace", "err"); return; }
  setStatus("researching");
  const res = await runAgent(["research", q, workspace, provider]);
  setStatus("idle");
  const webBox = $("res-web"); const ghBox = $("res-gh");
  webBox.innerHTML = ""; ghBox.innerHTML = "";
  if (!res || !res.success) { toast("Research failed", "err"); return; }
  (res.web || []).forEach(r => {
    const el = document.createElement("div");
    el.className = "res-item";
    el.innerHTML = '<a href="' + escapeHtml(r.url) + '" target="_blank">' + escapeHtml(r.title || "(no title)") + '</a>' +
      '<div class="res-snippet">' + escapeHtml(r.snippet || "") + '</div>';
    webBox.appendChild(el);
  });
  (res.github || []).forEach(r => {
    const el = document.createElement("div");
    el.className = "res-item";
    el.innerHTML = '<a href="' + escapeHtml(r.url) + '" target="_blank">' + escapeHtml(r.title) + '</a>' +
      '<div class="res-snippet">' + escapeHtml(r.snippet || "") + '</div>' +
      '<div class="res-meta">' + (r.stars || 0) + ' stars</div>';
    ghBox.appendChild(el);
  });
  toast("Research done");
};

$("test-check").onclick = async () => {
  if (!workspace) { toast("Pick a workspace", "err"); return; }
  setStatus("testing");
  await runAgent(["testall", "x", workspace, provider]);
  setStatus("idle");
};
$("test-run").onclick = async () => {
  const cmd = $("test-cmd").value.trim();
  if (!cmd) { toast("Type a command", "err"); return; }
  if (!workspace) { toast("Pick a workspace", "err"); return; }
  const r = await window.api.runCommand({ command: cmd, cwd: workspace });
  log(r.success ? "exit 0" : "non-zero exit", r.success ? "ok" : "err");
};

async function g(args) { return await window.api.git({ args: args, cwd: workspace }); }
$("git-init").onclick = async () => { if (workspace) await g(["init","-b","main"]); else toast("Pick a workspace","err"); };
$("git-status").onclick = async () => { if (workspace) await g(["status","--short"]); else toast("Pick a workspace","err"); };
$("git-commit").onclick = async () => {
  if (!workspace) { toast("Pick a workspace","err"); return; }
  const msg = $("commit-msg").value.trim() || "AI: automated changes";
  await g(["add","-A"]);
  await g(["commit","-m",msg]);
};
$("git-push").onclick = async () => {
  if (!workspace) { toast("Pick a workspace","err"); return; }
  const remote = $("remote-url").value.trim();
  if (remote) { await g(["remote","remove","origin"]); await g(["remote","add","origin",remote]); }
  await g(["push","-u","origin","main"]);
};
`);

// ====== 3. index.html: rename to CloseNI ======
const hPath = 'desktop/index.html';
let h = fs.readFileSync(hPath, 'utf-8');
h = h.replace('<title>Agentic Coder</title>', '<title>CloseNI</title>');
h = h.replace(/AGT<span>\/<\/span>CODER/g, 'Close<span>NI</span>');
write(hPath, h);

// ====== 4. main.js: rename window title ======
const mPath = 'desktop/main.js';
let m = fs.readFileSync(mPath, 'utf-8');
m = m.replace(/title: "Agentic Coder"/g, 'title: "CloseNI"');
m = m.replace(/title: "Agentic Web Coder"/g, 'title: "CloseNI"');
write(mPath, m);

// ====== 5. package.json: rename ======
const pPath = 'desktop/package.json';
let p = JSON.parse(fs.readFileSync(pPath, 'utf-8'));
p.name = 'closeni';
write(pPath, JSON.stringify(p, null, 2));

// ====== 6. styles.css: update wordmark styling for CloseNI ======
const sPath = 'desktop/styles.css';
let s = fs.readFileSync(sPath, 'utf-8');
if (s.indexOf('#wordmark span{') === -1) {
  s += '\n#wordmark span{color:var(--mut);}';
}
write(sPath, s);

console.log('\n=== All fixes applied. Rebuilding... ===\n');
