let workspace = "";
let provider = "deepseek";
let chatHistory = [];
let currentPlan = null;
let editingPlan = false;

const MODE_TITLES = { chat: "CHAT", build: "BUILDER", test: "TEST", research: "RESEARCH", push: "SHIP", settings: "SETTINGS" };

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
  // The run bar reads the manifest from disk, so it must refresh on open
  // rather than only after a build.
  if (mode === "test" && typeof refreshRunBar === "function") refreshRunBar();
  if (mode === "push" && typeof refreshGitHub === "function") refreshGitHub();
  // Read from disk on open: a skill created in an editor should appear without
  // restarting the app.
  if (mode === "settings" && typeof refreshSkills === "function") refreshSkills();
}
document.querySelectorAll(".nav-btn").forEach(function (btn) {
  btn.onclick = function () {
    // A gated tab says so rather than doing nothing. Silent buttons read as
    // broken, which is the whole reason gated providers announce themselves too.
    if (btn.dataset.gated) { toast(btn.dataset.gatedMsg || "Not ready yet", "err"); return; }
    switchTab(btn.dataset.mode);
  };
});

/**
 * Switch to a workspace.
 *
 * The one path both Browse and the recent list go through, so a project opened
 * either way is opened identically - restoreBuild brings back its plan and
 * statuses, and nothing runs until the user asks. That is the same rule the
 * resume work established this morning: a restart is as often a crash as a
 * tidy shutdown.
 */
let recentWorkspaces = [];
try {
  recentWorkspaces = window.CNRecent.parse(localStorage.getItem("closeni.recent-workspaces"));
} catch (e) { recentWorkspaces = []; }

function saveRecent() {
  try { localStorage.setItem("closeni.recent-workspaces", JSON.stringify(recentWorkspaces)); } catch (e) {}
}

async function renderRecent() {
  const box = $("recent-list");
  if (!box || !window.CNRecent) return;
  box.innerHTML = "";
  if (!recentWorkspaces.length) return;

  // One call for the whole list: the rail redraws on every switch, and eight
  // round-trips to render eight lines is waste.
  let progress = {};
  try {
    const r = await window.api.workspaceProgress(recentWorkspaces);
    if (r && r.ok) progress = r.progress || {};
  } catch (e) { /* the list still renders, just without the numbers */ }

  recentWorkspaces.forEach(function (p) {
    const row = document.createElement("div");
    row.className = "recent-row" + (p === workspace ? " active" : "");
    const name = document.createElement("span");
    name.className = "recent-path";
    // The tail is what distinguishes two projects; the head is usually the
    // same for all of them and would push the useful part off the rail.
    name.textContent = p.split(/[\\/]/).filter(Boolean).slice(-2).join("/");
    name.title = p;
    const state = document.createElement("span");
    state.className = "recent-state";
    state.textContent = window.CNRecent.describe(progress[p]);
    const drop = document.createElement("button");
    drop.className = "recent-forget";
    drop.textContent = "x";
    drop.title = "Forget this workspace (the folder is not touched)";
    drop.onclick = function (ev) {
      ev.stopPropagation();
      recentWorkspaces = window.CNRecent.forget(recentWorkspaces, p);
      saveRecent();
      renderRecent();
    };
    row.appendChild(name); row.appendChild(state); row.appendChild(drop);
    row.onclick = function () { if (p !== workspace) openWorkspace(p); };
    box.appendChild(row);
  });
}

async function openWorkspace(folder) {
  if (!folder) return;
  workspace = folder;
  // Truncated in the rail, so the full path lives in the tooltip.
  $("workspace-label").textContent = folder;
  $("workspace-label").title = folder;
  log("workspace: " + folder, "ok");
  recentWorkspaces = window.CNRecent.remember(recentWorkspaces, folder);
  saveRecent();
  loadChatsForWorkspace();
  // A build left unfinished in this folder comes back with it. Restoring
  // only - nothing runs until the user presses Build.
  if (window.CN && window.CN.restoreBuild) {
    const restored = await window.CN.restoreBuild(folder);
    // Replaces whatever plan was in memory: the plan and the step list have to
    // describe the same build, and the step list has just been replaced.
    if (restored) { currentPlan = restored; renderPlanDocument(restored, { keepBuild: true }); }
  }
  renderRecent();
}

$("browse-btn").onclick = async function () {
  const f = await window.api.selectFolder();
  if (f) await openWorkspace(f);
};
// The picker lists whatever is enabled in local-agent/config/providers, so
// adding a provider is a JSON file rather than a markup edit.
let providerList = [];

/** Where a provider's chosen settings live. Per provider: a model name means
 *  nothing to a different one. */
function controlsKey(id) { return "closeni.controls." + id; }

function savedControls(id) {
  try { return JSON.parse(localStorage.getItem(controlsKey(id)) || "{}") || {}; } catch (e) { return {}; }
}

/**
 * What to ask the provider for on the next run: the user's saved choices,
 * validated against what the provider still declares, with defaults filling the
 * gaps. Empty for a provider with no controls, which the agent reads as
 * "change nothing".
 */
function desiredControls() {
  const p = providerList.find(function (x) { return x.id === provider; });
  if (!p || !p.controls || !p.controls.length) return {};
  return window.CNControls.resolveControls(p.controls, savedControls(provider));
}

/**
 * Build the sidebar panel from whatever the selected provider declares.
 *
 * The user chooses and the agent applies. Deciding a model per task would be an
 * invisible decision - the kind you only discover by reading a log.
 */
/**
 * Draw the selected provider's controls.
 *
 * Rendered twice - once in Settings and once in the rail - because switching
 * model or turning deep thinking off is something people do between prompts,
 * and burying it two tabs deep meant it never got used. Both copies write to
 * the same stored value and are redrawn together, so they cannot disagree.
 */
function renderProviderControls(hostId, compact) {
  const host = $(hostId || "provider-controls");
  if (!host) return;
  host.innerHTML = "";
  const p = providerList.find(function (x) { return x.id === provider; });
  if (!p || !p.controls || !p.controls.length) return;

  const current = desiredControls();
  // Ids must be unique across both copies or the labels point at each other.
  const idPrefix = "ctl-" + (compact ? "rail-" : "set-");
  // No heading in the rail: every control already carries its own label, and
  // "Model" sitting directly above "Mode" read as a mislabelled field.
  if (!compact) {
    const head = document.createElement("div");
    head.className = "micro";
    head.style.marginTop = "14px";
    head.textContent = "Provider settings";
    host.appendChild(head);
  }

  function save(id, value) {
    const next = savedControls(provider);
    next[id] = value;
    try { localStorage.setItem(controlsKey(provider), JSON.stringify(next)); } catch (e) {}
    // Redraw the other copy so the two never drift apart.
    renderAllProviderControls();
  }

  p.controls.forEach(function (c) {
    if (c.kind === "select") {
      const label = document.createElement("div");
      label.className = "micro";
      label.style.marginTop = "8px";
      label.textContent = c.label;
      host.appendChild(label);

      const s = document.createElement("select");
      (c.options || []).forEach(function (o) {
        const opt = document.createElement("option");
        opt.value = o.value;
        opt.textContent = o.label || o.value;
        s.appendChild(opt);
      });
      if (current[c.id] !== undefined) s.value = current[c.id];
      s.onchange = function () { save(c.id, s.value); };
      host.appendChild(s);
      return;
    }

    if (c.kind === "toggle") {
      const row = document.createElement("div");
      row.className = compact ? "rail-toggle" : "";
      if (!compact) row.style.cssText = "display:flex;align-items:center;gap:6px;margin-top:8px;";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.id = idPrefix + c.id;
      box.style.cssText = "width:auto;flex:none;accent-color:var(--txt);";
      box.checked = current[c.id] === true;
      box.onchange = function () { save(c.id, box.checked); };
      const lab = document.createElement("label");
      lab.setAttribute("for", box.id);
      lab.style.cssText = "font-size:11px;color:var(--dim);cursor:pointer;";
      lab.textContent = c.label;
      row.appendChild(box); row.appendChild(lab);
      host.appendChild(row);
    }
  });
}

function renderAllProviderControls() {
  renderProviderControls("provider-controls", false);
  renderProviderControls("rail-controls", true);
}

(async function () {
  const sel = $("provider-select");
  if (!sel) return;
  let list = [];
  try { list = await window.api.listProviders(); } catch (e) {}
  if (!list.length) list = [{ id: "deepseek", name: "DeepSeek Chat" }];
  sel.innerHTML = "";
  // Coming-soon providers are shown rather than hidden, so it is clear they are
  // planned rather than missing - but they cannot be picked, and the agent
  // refuses them too in case one arrives from somewhere other than this menu.
  list.forEach(function (p) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.comingSoon ? p.name + " — coming soon" : p.name;
    o.disabled = !!p.comingSoon;
    sel.appendChild(o);
  });
  const usable = list.filter(function (p) { return !p.comingSoon; });
  let saved = null;
  try { saved = localStorage.getItem("closeni.provider"); } catch (e) {}
  // A preference saved before a provider was gated would otherwise select it
  // and fail on the first build.
  if (saved && usable.some(function (p) { return p.id === saved; })) sel.value = saved;
  else if (usable.length) sel.value = usable[0].id;
  provider = sel.value;
  providerList = list;
  renderAllProviderControls();
  setAcct("unknown", "not checked");
  sel.onchange = function (e) {
    provider = e.target.value;
    try { localStorage.setItem("closeni.provider", provider); } catch (e) {}
    // Each provider offers different controls, so the panel is rebuilt rather
    // than left showing the last provider's models.
    renderAllProviderControls();
    // A different provider has a different session and a different thread; the
    // previous one's status would be actively misleading.
    setAcct("unknown", "not checked");
    setThread(null);
    refreshAccount(false);
  };
  // One check at startup. It costs a headless browser launch, so it is not on a
  // timer - the light says "not checked" rather than pretending to be live.
  refreshAccount(false);

  // Reopen the project you were last in, restored but not running - the same
  // thing clicking it in the list would do. Nothing starts, no browser opens
  // and no conversation is touched until you ask for something.
  if (typeof renderRecent === "function") {
    renderRecent();
    if (recentWorkspaces.length && typeof openWorkspace === "function") {
      openWorkspace(recentWorkspaces[0]);
    }
  }
})();

/* ---------- account status ----------
 *
 * Whether the provider is still signed in decides whether anything else works,
 * and until now the only way to find out was to start a build and watch it fail
 * with "no chat input appeared". The check is a real headless visit, so it is
 * never run automatically more than once per launch or per explicit request -
 * it opens the browser profile and would otherwise fight whatever is running.
 */
let acctThread = null;

/*
 * The live phase readout.
 *
 * Wording is the only thing decided here - which phase is true is decided by
 * the agent, from what it saw on the page. "thinking" and "writing" are
 * genuinely different states: the first means the prompt is in and no reply
 * text has appeared, the second means the assistant message is actually
 * growing. Anything not in this table is shown verbatim rather than dropped,
 * so a phase added later still appears.
 */
const PHASE_WORDS = {
  idle: ["idle", "idle"],
  opening: ["opening browser", "busy"],
  connecting: ["connecting", "busy"],
  sending: ["sending prompt", "busy"],
  thinking: ["thinking", "busy"],
  generating: ["generating", "work"],
  writing: ["writing reply", "work"],
  reading: ["reading reply", "busy"],
  applying: ["writing files", "work"],
  checking: ["running checks", "work"],
};

function setPhase(p) {
  const box = $("phase");
  if (!box) return;
  const name = (p && p.phase) || "idle";
  const known = PHASE_WORDS[name];
  const label = known ? known[0] : name;
  const kind = known ? known[1] : "busy";
  box.className = "phase " + kind;
  $("phase-text").textContent = label;
  $("phase-detail").textContent = (p && p.detail) || "";
  // Every phase is reported at the moment it was observed on the page, so the
  // clock here is measuring the real thing rather than an inference. The
  // builder owns the per-step timer; this only forwards the transition.
  if (window.CN && window.CN.notePhase) window.CN.notePhase(name);
}

window.api.onPhase(setPhase);

function setAcct(state, text) {
  const dot = $("acct-dot");
  const label = $("acct-state");
  if (dot) dot.className = "acct-dot " + state;
  if (label) label.textContent = text;
  const p = providerList.find(function (x) { return x.id === provider; });
  const nameEl = $("acct-name");
  if (nameEl) {
    // "DeepSeek Chat (something)" is wider than the rail. Drop the parenthetical
    // and the redundant trailing "Chat"; CSS truncates whatever is left.
    const full = (p && p.name) ? p.name : provider;
    nameEl.textContent = full.replace(/\s*\(.*\)$/, "").replace(/\s+Chat$/i, "");
    nameEl.title = full;
  }
  const signedIn = state === "on";
  const inBtn = $("acct-signin");
  const outBtn = $("acct-signout");
  if (inBtn) inBtn.classList.toggle("is-hidden", signedIn);
  if (outBtn) outBtn.classList.toggle("is-hidden", !signedIn);
}

function setThread(thread) {
  acctThread = thread && thread.url ? thread : null;
  const btn = $("open-thread-btn");
  const label = $("thread-label");
  if (btn) btn.classList.toggle("is-hidden", !acctThread);
  // The label is the tail of the URL, never the URL: this line is on screen
  // during screen shares and lands in screenshots, and the full link carries a
  // live session.
  if (label) label.textContent = acctThread ? "thread " + acctThread.label : "";
}

async function refreshAccount(explicit) {
  const p = providerList.find(function (x) { return x.id === provider; });
  if (p && p.comingSoon) { setAcct("unknown", "coming soon"); setThread(null); return; }
  setAcct("busy", "checking…");
  const r = await window.api.authStatus(provider, workspace).catch(function () { return null; });
  if (!r || !r.success) {
    setAcct("unknown", "unknown");
    if (explicit) toast("Could not check the account", "err");
    return;
  }
  setAcct(r.signedIn ? "on" : "off", r.signedIn ? "signed in" : "signed out");
  setThread(r.thread);
  if (explicit) toast(r.signedIn ? "Signed in" : "Not signed in - use Sign in");
}

$("acct-recheck").onclick = function () { refreshAccount(true); };
$("acct-signin").onclick = function () { $("provider-signin").click(); };

/**
 * Check the provider's selectors against a real page, on demand.
 *
 * Every finding is printed, including the skipped ones. A check that quietly
 * omitted what it could not verify would read as "everything is fine" while
 * saying nothing about the read path - which is the half that has actually
 * broken builds.
 */
$("acct-health").onclick = async function () {
  const btn = $("acct-health");
  btn.disabled = true;
  const was = btn.textContent;
  btn.textContent = "Checking...";
  try {
    const r = await window.api.providerHealth(provider, workspace).catch(function () { return null; });
    if (!r || !r.success) {
      log("selector check failed: " + ((r && r.error) || "no answer"), "err");
      toast((r && r.error) || "Could not check", "err");
      return;
    }
    log("selector check - " + r.summary, r.ok ? "ok" : "err");
    (r.findings || []).forEach(function (f) {
      log("  " + f.selector + ": " + f.health + " (" + f.matched + " matched)" +
        (f.note ? " - " + f.note : ""), f.health === "critical" ? "err" : "step");
    });
    if (!r.resumed) {
      log("  no saved conversation here, so the read path was not checked - " +
        "chat once in this workspace, then check again", "step");
    }
    toast(r.ok ? "Selectors look right" : "Selectors need attention", r.ok ? "" : "err");
  } finally {
    btn.disabled = false;
    btn.textContent = was;
  }
};

$("acct-signout").onclick = async function () {
  const r = await window.api.signOutProvider(provider);
  if (r && r.success) {
    log("signed out of " + provider + " (browser profile removed)", "ok");
    toast("Signed out");
    setAcct("off", "signed out");
    setThread(null);
  } else {
    toast((r && r.error) || "Could not sign out", "err");
  }
};

$("open-thread-btn").onclick = async function () {
  if (!acctThread) return;
  const r = await window.api.openThread(acctThread.url);
  if (!r || !r.success) toast((r && r.error) || "Could not open the conversation", "err");
};

$("provider-signin").onclick = async function () {
  const btn = $("provider-signin");
  btn.disabled = true;
  btn.textContent = "Opening browser...";
  toast("A browser window will open - sign in, then it closes itself");
  const r = await window.api.signIn(provider);
  btn.disabled = false;
  btn.textContent = "Sign in";
  if (r && r.success) {
    toast("Signed in to " + provider);
    log("signed in to " + provider, "ok");
    setAcct("on", "signed in");
  } else {
    toast("Sign-in did not complete", "err");
    log("sign-in failed: " + ((r && r.error) || "no chat input appeared"), "err");
    setAcct("off", "signed out");
  }
};

/**
 * One agent run, carrying whatever the user has configured.
 *
 * buildPreamble is awaited here rather than per step, because it runs the
 * configured MCP tools: per step it would pay a subprocess launch twenty times
 * for text that does not change during a build.
 */
function runAgent(args) {
  try {
    const cb = $("show-browser");
    const headed = cb ? cb.checked : false;
    return buildPreamble().then(function (preamble) {
      return window.api.runAgent({ args: args, headed: headed, controls: desiredControls(), preamble: preamble });
    }).catch(function (e) { return { success: false, error: String(e) }; });
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

/**
 * Apply one edit to the plan in memory, then redraw.
 *
 * Every operation goes through CNPlanEdit, which remaps dependsOn. Editing the
 * array here directly would leave indices pointing at whatever moved into that
 * slot - a graph that fails validation, falls back to the plain chain, and
 * silently undoes the scheduler work that lets independent steps survive a
 * failure.
 */
function editPlanStep(act, i) {
  if (!currentPlan || !window.CNPlanEdit) return;
  const steps = currentPlan.steps || [];
  let res;
  if (act === "up") res = window.CNPlanEdit.moveStep(steps, i, i - 1);
  else if (act === "down") res = window.CNPlanEdit.moveStep(steps, i, i + 1);
  else if (act === "merge") res = window.CNPlanEdit.mergeStepUp(steps, i);
  else if (act === "del") res = window.CNPlanEdit.deleteStep(steps, i);
  else return;

  if (res.refused) { toast(res.refused, "err"); log("edit refused: " + res.refused, "err"); return; }
  (res.notes || []).forEach(function (n) { log("plan: " + n, "step"); });

  currentPlan = Object.assign({}, currentPlan, { steps: res.steps });
  renderPlanDocument(currentPlan);
}

/**
 * Draw the plan sidebar.
 *
 * `keepBuild` matters more than it looks. This function ends by handing the
 * plan to the builder, which rebuilds its step list with every status set to
 * pending - correct for a plan that has just been generated, and destructive
 * for one that has just been RESTORED, where the statuses are the whole point.
 *
 * That was a live bug from the moment resume landed: opening a workspace with a
 * half-finished build showed every step pending, so pressing Build would have
 * redone all of it. It went unnoticed because restoreBuild's own log line said
 * "7/18 already done" while the cards beside it said otherwise.
 */
function renderPlanDocument(plan, opts) {
  const content = $("plan-content");
  if (!content) return;
  content.innerHTML = "";

  const summary = document.createElement("div");
  summary.className = "plan-summary";
  summary.textContent = plan.summary || "Implementation Plan";
  content.appendChild(summary);

  // Each step is a browser round-trip, so a long plan is a long build. Say so
  // before the Build button rather than after twenty minutes of waiting.
  const stepCount = (plan.steps || []).length;
  if (stepCount) {
    const scale = document.createElement("div");
    scale.className = "plan-scale hint";
    scale.textContent = stepCount + " steps · " +
      (window.CNScale ? window.CNScale.estimateDuration(stepCount) : "");
    content.appendChild(scale);
  }

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
      '<span class="plan-step-title">' + escapeHtml(s.title || "Step") + '</span>' +
      // Editing is inline rather than a separate mode: the plan is read here,
      // and the moment you want to change something is while reading it.
      '<span class="plan-step-edit">' +
        '<button class="btn btn-sm" data-act="up" data-i="' + i + '" title="Move earlier">^</button>' +
        '<button class="btn btn-sm" data-act="down" data-i="' + i + '" title="Move later">v</button>' +
        '<button class="btn btn-sm" data-act="merge" data-i="' + i + '" title="Merge into the step above">merge up</button>' +
        '<button class="btn btn-sm" data-act="del" data-i="' + i + '" title="Delete this step">delete</button>' +
      '</span></div>' +
      '<div class="plan-step-detail">' + escapeHtml(s.detail || "") + '</div>' + files;
    sec.appendChild(step);
  });
  // One handler for the section rather than four per step: the list is redrawn
  // after every edit, and per-button closures would be rebound each time.
  sec.onclick = function (ev) {
    const btn = ev.target.closest ? ev.target.closest("button[data-act]") : null;
    if (!btn) return;
    editPlanStep(btn.dataset.act, Number(btn.dataset.i));
  };
  content.appendChild(sec);

  $("plan-sidebar").classList.remove("hidden");
  // Skipped when restoring: restoreBuild has already populated the builder,
  // statuses and all, and setPlan would reset every one of them to pending.
  if (window.CN && !(opts && opts.keepBuild)) window.CN.setPlan(plan);
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
  // A repository picked in Research rides along, so the plan is designed against
  // how a real project of that kind is laid out.
  const refBlock = repoReference
    ? "Reference project " + repoReference.name + ":\n" + repoReference.readme +
      "\n\nIts file layout:\n" + repoReference.files.join("\n") + "\n\n---\n\n"
    : "";
  setStatus("generating plan");
  addBubble("ai", "Generating implementation plan...");
  const res = await runAgent(["plan", refBlock + transcript, workspace, provider]);
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

/**
 * Research: the provider's own web search, plus GitHub through our token.
 *
 * Two independent halves, run together and reported separately. GitHub failing
 * because you are not signed in must not hide a perfectly good web answer, and
 * a provider that is busy must not hide the repositories.
 */
$("research-go").onclick = async function () {
  const q = $("research-q").value.trim();
  if (!q) { toast("Type a query", "err"); return; }
  if (!workspace) { toast("Pick a workspace", "err"); return; }

  const webBox = $("res-web"); const ghBox = $("res-gh"); const via = $("research-via");
  webBox.innerHTML = '<div class="hint">searching...</div>';
  ghBox.innerHTML = '<div class="hint">searching...</div>';
  via.textContent = "";
  setStatus("researching");

  // Started together: the provider round trip takes seconds and the GitHub call
  // takes hundreds of milliseconds, so running them in series would make the
  // fast one wait for the slow one for no reason.
  const webPromise = runAgent(["research", q, workspace, provider]);
  const ghPromise = window.api.ghCall("searchRepos", [q, 8])
    .catch(function (e) { return { ok: false, error: String(e) }; });

  const res = await webPromise;
  if (res && res.success) {
    via.textContent = res.via || "";
    webBox.innerHTML = "";
    const answer = document.createElement("div");
    answer.className = "res-answer";
    answer.innerHTML = renderMarkdown(res.answer || "");
    webBox.appendChild(answer);
    (res.sources || []).forEach(function (u) {
      const el = document.createElement("div");
      el.className = "res-item";
      el.innerHTML = '<a href="' + escapeHtml(u) + '" target="_blank">' + escapeHtml(u) + "</a>";
      webBox.appendChild(el);
    });
    if (!(res.sources || []).length) {
      webBox.appendChild(Object.assign(document.createElement("div"), {
        className: "hint",
        textContent: "The provider cited no sources for this answer.",
      }));
    }
  } else {
    webBox.innerHTML = '<div class="hint">' + escapeHtml((res && res.error) || "the search failed") + "</div>";
  }

  const gh = await ghPromise;
  ghBox.innerHTML = "";
  if (!gh || !gh.ok) {
    ghBox.innerHTML = '<div class="hint">' +
      escapeHtml((gh && gh.error) || "GitHub search unavailable - sign in on the Ship tab") + "</div>";
  } else if (!(gh.result || []).length) {
    ghBox.innerHTML = '<div class="hint">no repositories matched</div>';
  } else {
    gh.result.forEach(function (r) {
      const el = document.createElement("div");
      el.className = "res-item";
      el.innerHTML = '<a href="' + escapeHtml(r.url) + '" target="_blank">' + escapeHtml(r.fullName) + "</a>" +
        '<div class="res-snippet">' + escapeHtml(r.description || "") + "</div>" +
        '<div class="res-meta">' + (r.stars || 0) + " stars" +
          (r.language ? " &middot; " + escapeHtml(r.language) : "") + "</div>";
      const actions = document.createElement("div");
      actions.className = "res-actions";
      // Kept from the old panel: it pulls the repo's README and file list into
      // the next plan's context, which is the whole reason to search for a
      // reference implementation rather than just read one.
      const ref = document.createElement("button");
      ref.className = "btn btn-sm";
      ref.textContent = "Use as reference";
      ref.onclick = function () { useAsReference({ url: r.url }); };
      actions.appendChild(ref);
      const clone = document.createElement("button");
      clone.className = "btn btn-sm";
      clone.textContent = "Clone";
      // cloneRepo reads owner/repo off the URL, which is the one field a search
      // result and a pasted link always agree on.
      clone.onclick = function () { cloneRepo({ url: r.url, title: r.fullName }); };
      actions.appendChild(clone);
      el.appendChild(actions);
      ghBox.appendChild(el);
    });
  }

  setStatus("idle");
  toast("Research done");
};

/**
 * Replay this workspace's build onto a branch of its own.
 *
 * Step titles come from the plan in memory when there is one, because a
 * checkpoint stores the step's detail rather than its title and "step 6:
 * Implement the streak calculation described in..." reads badly in git log.
 */
$("export-branch").onclick = async function () {
  if (!workspace) { toast("Pick a workspace", "err"); return; }
  const btn = $("export-branch");
  btn.disabled = true;
  const was = btn.textContent;
  btn.textContent = "Exporting...";
  try {
    const plan = currentPlan;
    const res = await window.api.exportBranch({
      workspace: workspace,
      summary: (plan && plan.summary) || "",
      steps: ((plan && plan.steps) || []).map(function (s) { return s.title || ""; }),
    }).catch(function (e) { return { ok: false, error: String(e) }; });

    if (!res || !res.ok) {
      log("export failed: " + ((res && res.error) || "unknown"), "err");
      toast((res && res.error) || "Export failed", "err");
      return;
    }
    log("exported " + res.commits + " commit(s) to " + res.branch, "ok");
    (res.warnings || []).forEach(function (w) { log("  " + w, "step"); });
    toast("Exported to " + res.branch);
  } finally {
    btn.disabled = false;
    btn.textContent = was;
  }
};

/**
 * The persona and skills the user has ticked.
 *
 * Selections live in localStorage; the files on disk are the source of truth,
 * so a skill deleted outside the app simply stops being read rather than
 * leaving a dangling reference.
 */
let selectedSkills = [];
try { selectedSkills = JSON.parse(localStorage.getItem("closeni.skills") || "[]") || []; } catch (e) {}
let selectedPersona = "";
try { selectedPersona = localStorage.getItem("closeni.persona") || ""; } catch (e) {}

async function refreshSkills() {
  if (!window.api.listSkills) return;
  const r = await window.api.listSkills().catch(function () { return null; });
  if (!r || !r.ok) return;

  const sel = $("persona-select");
  sel.innerHTML = '<option value="">(none)</option>';
  r.personas.forEach(function (n) {
    const o = document.createElement("option");
    o.value = n; o.textContent = n; o.selected = n === selectedPersona;
    sel.appendChild(o);
  });
  sel.onchange = function () {
    selectedPersona = sel.value;
    try { localStorage.setItem("closeni.persona", selectedPersona); } catch (e) {}
  };

  const list = $("skill-list");
  list.innerHTML = "";
  if (!r.skills.length) {
    list.innerHTML = '<div class="hint">No skills yet. Create one below, or import from GitHub.</div>';
  }
  r.skills.forEach(function (n) {
    const row = document.createElement("div");
    row.className = "settings-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = "skill-cb-" + n;
    cb.checked = selectedSkills.indexOf(n) !== -1;
    cb.onchange = function () {
      selectedSkills = cb.checked
        ? selectedSkills.concat([n])
        : selectedSkills.filter(function (x) { return x !== n; });
      try { localStorage.setItem("closeni.skills", JSON.stringify(selectedSkills)); } catch (e) {}
    };
    const name = document.createElement("label");
    name.setAttribute("for", cb.id);
    name.textContent = n;
    // Clicking the name opens it, which is what people reach for; the label's
    // own "for" still toggles the box, so both gestures do something.
    name.ondblclick = async function () {
      const got = await window.api.readSkill("skill", n);
      if (got && got.ok) { $("skill-editor").value = got.text; $("skill-editor").dataset.name = n; }
    };
    const edit = document.createElement("button");
    edit.className = "btn btn-sm";
    edit.textContent = "edit";
    edit.onclick = async function () {
      const got = await window.api.readSkill("skill", n);
      if (got && got.ok) { $("skill-editor").value = got.text; $("skill-editor").dataset.name = n; }
    };
    row.appendChild(cb); row.appendChild(name); row.appendChild(edit);
    list.appendChild(row);
  });

  const mcp = await window.api.readMcpConfig().catch(function () { return null; });
  if (mcp && mcp.ok) $("mcp-config").value = mcp.text || "";
}

$("skill-new").onclick = async function () {
  const name = $("skill-new-name").value.trim();
  if (!name) { toast("Name it first", "err"); return; }
  const r = await window.api.writeSkill("skill", name, "");
  if (!r.ok) { toast(r.error, "err"); return; }
  $("skill-new-name").value = "";
  $("skill-editor").value = "";
  $("skill-editor").dataset.name = name;
  await refreshSkills();
};

$("skill-save").onclick = async function () {
  const name = $("skill-editor").dataset.name;
  if (!name) { toast("Select a skill first", "err"); return; }
  const r = await window.api.writeSkill("skill", name, $("skill-editor").value);
  toast(r.ok ? "Saved " + name : (r.error || "Could not save"), r.ok ? "" : "err");
};

$("skill-delete").onclick = async function () {
  const name = $("skill-editor").dataset.name;
  if (!name) return;
  if (!confirm("Delete the skill \"" + name + "\"? The file is removed from disk.")) return;
  await window.api.deleteSkill("skill", name);
  $("skill-editor").value = "";
  delete $("skill-editor").dataset.name;
  selectedSkills = selectedSkills.filter(function (x) { return x !== name; });
  try { localStorage.setItem("closeni.skills", JSON.stringify(selectedSkills)); } catch (e) {}
  await refreshSkills();
};

$("skill-import-go").onclick = async function () {
  const raw = $("skill-import").value.trim();
  const m = raw.match(/^([^/]+)\/([^/]+)\/(.+\.md)$/i);
  if (!m) { toast("Use owner/repo/path/to/file.md", "err"); return; }
  const r = await window.api.importSkill({ owner: m[1], repo: m[2], path: m[3], kind: "skill" });
  if (!r.ok) { toast(r.error || "Import failed", "err"); log("skill import failed: " + r.error, "err"); return; }
  $("skill-import").value = "";
  log("imported skill: " + r.name, "ok");
  await refreshSkills();
};

$("mcp-save").onclick = async function () {
  const text = $("mcp-config").value;
  // Parsed here so a typo is caught now rather than by a build that depends on it.
  if (text.trim()) {
    try { JSON.parse(text); }
    catch (e) { toast("That is not valid JSON", "err"); return; }
  }
  const r = await window.api.writeMcpConfig(text);
  toast(r.ok ? "MCP configuration saved" : (r.error || "Could not save"), r.ok ? "" : "err");
};

/**
 * Everything the model should be told before the task, for this run.
 *
 * MCP tools run here - once, before the run - rather than per step. A tool
 * whose answer changes mid-build is therefore read once, which is recorded in
 * the design as the known cost of not paying a browser round-trip per call.
 */
async function buildPreamble() {
  const parts = {};
  try {
    if (selectedPersona) {
      const p = await window.api.readSkill("persona", selectedPersona);
      if (p && p.ok && p.text.trim()) parts.persona = p.text;
    }
    const skills = [];
    for (const n of selectedSkills) {
      const s = await window.api.readSkill("skill", n);
      if (s && s.ok && s.text.trim()) skills.push(s.text);
    }
    if (skills.length) parts.skills = skills;

    const mcp = await window.api.gatherMcpContext();
    if (mcp && mcp.texts && mcp.texts.length) parts.mcpContext = mcp.texts;
    (mcp && mcp.notes ? mcp.notes : []).forEach(function (n) { log("mcp: " + n, "err"); });
  } catch (e) {
    // A preamble that cannot be assembled means the behaviour before any of
    // this was configured, which is a working run.
    log("preamble unavailable: " + String(e), "err");
    return {};
  }
  return parts;
}

function renderTestResults(rows, summary) {
  const sum = $("test-summary");
  if (sum) sum.textContent = summary || "";
  const box = $("test-results");
  if (!box) return;
  box.innerHTML = "";
  // Language tokens, keyed the same way desktop/language-mark.js keys them, so a
  // check row is marked by what it checked. The row's own text is a command and
  // has nothing to derive this from.
  const LANG_TOKEN = {
    python: "--lang-py", javascript: "--lang-js", rust: "--lang-rs",
    java: "--lang-java", c: "--lang-c", cpp: "--lang-c",
  };
  (rows || []).forEach(function (r) {
    const el = document.createElement("div");
    el.className = "test-row " + (r.success ? "pass" : "fail");
    const token = LANG_TOKEN[r.language];
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

async function refreshRunBar() {
  const box = $("test-cmd");
  const badge = $("run-source");
  const hint = $("run-hint");
  if (!box || !badge || !workspace) return;

  const manifest = await window.api.readManifest(workspace).catch(function () { return null; });
  const detected = await detectCommand();

  let command = null;
  let source = "none";
  if (manifest && String(manifest.run || "").trim()) { command = manifest.run.trim(); source = "manifest"; }
  else if (currentPlan && String(currentPlan.runCommand || "").trim()) { command = currentPlan.runCommand.trim(); source = "plan"; }
  else if (detected) { command = detected; source = "detected"; }

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
  lastRun = { command: "syntax check", output: JSON.stringify(res.results || []).slice(0, 4000) };
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
  lastRun = { command: "behaviour checks", output: JSON.stringify(res.results || []).slice(0, 4000) };
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
  lastRun = { command: cmd, output: (r && r.output) || "" };
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

// Persist the permission policy: a setting that resets on restart is a nuisance.
(function () {
  const sel = $("autonomy-select");
  if (!sel) return;
  try { const saved = localStorage.getItem("closeni.autonomy"); if (saved) sel.value = saved; } catch (e) {}
  sel.onchange = function () { try { localStorage.setItem("closeni.autonomy", sel.value); } catch (e) {} };
})();

// A repository chosen as reference. Folded into the plan prompt so the model
// designs against how a real project of that kind is laid out. Nothing is
// written to the workspace, so there is no licence question on this path.
let repoReference = null;

async function useAsReference(r) {
  const parsed = window.CNGit ? window.CNGit.parseRepoUrl(r.url) : null;
  if (!parsed) { toast("Not a GitHub repository", "err"); return; }
  const readme = await window.api.ghCall("getReadme", [parsed.owner, parsed.repo]);
  const tree = await window.api.ghCall("getTree", [parsed.owner, parsed.repo]);
  if (!readme.ok && !tree.ok) {
    toast(readme.error || tree.error || "Could not read that repository", "err");
    return;
  }
  repoReference = {
    name: parsed.owner + "/" + parsed.repo,
    readme: (readme.ok ? readme.result : "").slice(0, 3000),
    files: (tree.ok ? tree.result : []).slice(0, 120),
  };
  toast("Referencing " + repoReference.name + " in the next plan");
  log("reference set: " + repoReference.name, "ok");
}

async function cloneRepo(r) {
  if (!workspace) { toast("Pick a workspace", "err"); return; }
  const parsed = window.CNGit ? window.CNGit.parseRepoUrl(r.url) : null;
  if (!parsed) { toast("Not a GitHub repository", "err"); return; }
  // The licence is the user's to accept, so it goes in front of them rather
  // than into a doc they will not read.
  const licence = r.license || "an unknown licence";
  const ok = confirm("Clone " + parsed.owner + "/" + parsed.repo + " into your workspace?\n\n" +
    "It carries " + licence + ", and the AI will go on to edit code it did not write.");
  if (!ok) return;
  setStatus("cloning");
  const res = await window.api.ghClone({ url: r.url, workspace: workspace });
  setStatus("idle");
  if (res && res.ok) toast("Cloned into " + res.into);
  else toast((res && res.error) || "Clone failed", "err");
}

// GitHub. The renderer never holds the token - it asks the main process to make
// calls on its behalf, and no getter for it exists on window.api.
async function refreshGitHub() {
  const st = await window.api.ghStatus().catch(function () { return { signedIn: false }; });
  const out = $("gh-signed-out");
  const inn = $("gh-signed-in");
  if (!out || !inn) return;
  out.classList.toggle("is-hidden", !!st.signedIn);
  inn.classList.toggle("is-hidden", !st.signedIn);

  const note = $("gh-storage-note");
  if (note) {
    // Said plainly rather than discovered next launch when the token is gone.
    note.textContent = st.encryptionAvailable
      ? "Stored encrypted on this machine."
      : "This system offers no secure storage, so the token is kept in memory only and must be re-entered next launch.";
  }
  if (!st.signedIn) return;

  $("gh-login").textContent = st.login ? "@" + st.login : "signed in";
  const r = await window.api.ghCall("listRepos", []);
  const sel = $("gh-repo");
  sel.innerHTML = "";
  if (!r || !r.ok) { log("github: " + ((r && r.error) || "could not list repositories"), "err"); return; }
  (r.result || []).forEach(function (repo) {
    const o = document.createElement("option");
    o.value = repo.clone_url || ("https://github.com/" + repo.full_name + ".git");
    o.textContent = repo.full_name + (repo.private ? " (private)" : "");
    sel.appendChild(o);
  });
  sel.onchange = function () { $("remote-url").value = sel.value; };
  if (sel.value) $("remote-url").value = sel.value;
  await refreshRuns();
}

$("gh-open-tokens").onclick = function () {
  // Scopes pre-selected, so the user grants exactly what is needed and can see
  // what that is before agreeing to it.
  window.open("https://github.com/settings/tokens/new?scopes=repo,workflow&description=CloseNI", "_blank");
};

$("gh-sign-in").onclick = async function () {
  const box = $("gh-token");
  const token = box.value.trim();
  if (!token) { toast("Paste a token first", "err"); return; }
  const r = await window.api.ghSignIn(token);
  box.value = "";                      // never leave a credential in the DOM
  if (r && r.ok) {
    toast("Signed in as @" + (r.login || "?"));
    if (!r.persisted) toast("Token kept in memory only - see the note", "err");
    await refreshGitHub();
  } else {
    toast((r && r.error) || "Sign-in failed", "err");
  }
};

$("gh-sign-out").onclick = async function () {
  await window.api.ghSignOut();
  toast("Signed out");
  await refreshGitHub();
};

$("gh-create-repo").onclick = async function () {
  const name = $("gh-new-repo").value.trim();
  if (!name) { toast("Name it first", "err"); return; }
  const r = await window.api.ghCall("createRepo", [name, true]);
  if (r && r.ok) { toast("Created " + name); $("gh-new-repo").value = ""; await refreshGitHub(); }
  else toast((r && r.error) || "Could not create it", "err");
};

function currentRepo() {
  const sel = $("gh-repo");
  const url = (sel && sel.value) || $("remote-url").value;
  return window.CNGit ? window.CNGit.parseRepoUrl(url) : null;
}

async function refreshRuns() {
  const box = $("gh-runs");
  const repo = currentRepo();
  if (!box || !repo) return;
  const r = await window.api.ghCall("listRuns", [repo.owner, repo.repo]);
  box.innerHTML = "";
  if (!r || !r.ok) { box.textContent = (r && r.error) || "Could not list runs."; return; }
  (r.result || []).forEach(function (run) {
    const el = document.createElement("div");
    // in_progress carries no conclusion yet, so status is what to colour by.
    const state = run.status === "completed" ? (run.conclusion || "unknown") : "running";
    el.className = "gh-run " + state;
    el.innerHTML = '<span class="name">' + escapeHtml(run.name || "workflow") + "</span>" +
      '<span class="verdict">' + escapeHtml(state) + "</span>";
    box.appendChild(el);
  });
  if (!(r.result || []).length) box.textContent = "No runs yet.";
}

$("gh-refresh-runs").onclick = refreshRuns;

$("gh-dispatch").onclick = async function () {
  const repo = currentRepo();
  const wf = $("gh-workflow").value.trim();
  if (!repo) { toast("Pick a repository first", "err"); return; }
  if (!wf) { toast("Name the workflow file", "err"); return; }
  const r = await window.api.ghCall("dispatchWorkflow", [repo.owner, repo.repo, wf, "main"]);
  // A missing `workflow` scope arrives as a 403, and the client already says
  // that is usually a scope problem rather than a generic refusal.
  if (r && r.ok) { toast("Triggered " + wf); setTimeout(refreshRuns, 3000); }
  else toast((r && r.error) || "Could not trigger it", "err");
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


let availableChats = [];
let currentChatIndex = 0;

function updateChatSelector() {
  const select = $("chat-select");
  if (!select) return;
  select.innerHTML = '<option value="new">+ New Chat</option>';
  availableChats.forEach((chat, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = chat.title || ("Chat " + (i + 1));
    if (i === currentChatIndex) opt.selected = true;
    select.appendChild(opt);
  });
}

async function loadChatsForWorkspace() {
    if (!workspace) return;
    try {
      const res = await window.api.getChats(workspace);
      availableChats = res.chats || [];
      currentChatIndex = -1;
      updateChatSelector();
    } catch (e) {
      console.log("Failed to load chats (first time?):", e);
      availableChats = [];
      currentChatIndex = -1;
      updateChatSelector();
    }
  }

$("chat-select").onchange = function (e) {
  const val = e.target.value;
  if (val === "new") {
    window.api.newChat(workspace).then(() => {
      currentChatIndex = -1;
      toast("Started new chat");
      log("New chat started", "ok");
    }).catch((err) => {
      log("Could not start new chat: " + err.message, "err");
    });
  } else {
    currentChatIndex = parseInt(val);
    const chat = availableChats[currentChatIndex];
    if (chat) {
      window.api.switchChat(workspace, chat.url).then(() => {
        toast("Switched to: " + chat.title);
        log("Switched to chat: " + chat.title, "ok");
      }).catch((err) => {
        log("Could not switch chat: " + err.message, "err");
      });
    }
  }
};

/**
 * Start a new chat.
 *
 * Clearing activeChat in sessions.json is only half of it: the transcript the
 * next plan is built from lives in chatHistory, and the messages the user can
 * see live in the DOM. Without clearing both, pressing this did nothing visible
 * and the old conversation still went into the next plan.
 */
$("new-chat-btn").onclick = async function () {
  if (!workspace) { toast("Pick a workspace", "err"); return; }
  const r = await window.api.newChat(workspace).catch(function (e) { return { ok: false, error: String(e) }; });
  if (!r || !r.ok) { toast((r && r.error) || "Could not start a new chat", "err"); return; }

  chatHistory = [];
  currentChatIndex = -1;
  currentPlan = null;
  const flow = $("chat-flow");
  if (flow) flow.innerHTML = "";
  const planContent = $("plan-content");
  if (planContent) planContent.innerHTML = "";
  const sidebar = $("plan-sidebar");
  if (sidebar) sidebar.classList.add("hidden");
  await loadChatsForWorkspace();

  toast("Started new chat");
  log("new chat started - transcript cleared", "ok");
};

window.CN = {
  getWorkspace: function () { return workspace; },
  getProvider: function () { return provider; },
  getAutonomy: function () { const s = $("autonomy-select"); return (s && s.value) || "ask"; },
  // One conversation, one composer: steps are serial and no longer configurable.
  // Kept as a function returning 1 rather than removed, so builder.js keeps a
  // single meaning for "how many may start now" instead of scattering the
  // assumption.
  getConcurrency: function () { return 1; },
  getPlan: function () { return currentPlan; },
  runAgent: runAgent,
  suggest: function (stepIndex, text) {
    try {
      const cb = $("show-browser");
      return window.api.suggest({
        workspace: workspace, provider: provider, stepIndex: stepIndex,
        text: text, headed: cb ? cb.checked : false, controls: desiredControls(),
      }).catch(function (e) { return { success: false, error: String(e) }; });
    } catch (e) { return Promise.resolve({ success: false, error: String(e) }); }
  },
  readFile: function (p, opts) { return window.api.readFile(p, opts); },
  isHeaded: function () { const cb = $("show-browser"); return cb ? cb.checked : false; },
  startSession: function (ws, prov, autonomy, resuming) {
    try {
      const cb = $("show-browser");
      // Awaited once here, because buildPreamble runs the configured MCP tools.
      return buildPreamble().then(function (preamble) {
        return window.api.startSession(ws, prov, autonomy, cb ? cb.checked : false,
          desiredControls(), window.CN.getConcurrency(), resuming, preamble);
      }).catch(function (e) { return { ok: false, error: String(e) }; });
    } catch (e) { return Promise.resolve({ ok: false, error: String(e) }); }
  },
  sendStep: function (index, detail, goal, testable) {
    try {
      return window.api.sendStep(index, detail, goal, testable)
        .catch(function (e) { return { success: false, error: String(e) }; });
    } catch (e) { return Promise.resolve({ success: false, error: String(e) }); }
  },
  endSession: function () {
    try { return window.api.endSession().catch(function () {}); } catch (e) { return Promise.resolve(); }
  },
  log: log,
  toast: toast,
  escapeHtml: escapeHtml,
  switchTab: switchTab,
  setPlan: function () {},
  startBuild: function () {},
  retryFailed: function () {},
  // Replaced by builder.js, which loads after this. Present so a workspace can
  // be opened before it does without the caller having to know the load order.
  restoreBuild: function () { return Promise.resolve(null); },
  notePhase: function () {},
};

/**
 * First run: without a browser the app can do nothing at all, so this blocks
 * rather than failing later at the first sign-in with a confusing message.
 * In development it never appears - the developer's own Playwright cache is
 * already there, and demanding a 389MB download would be the bug.
 */
(async function () {
  const gate = $("browser-gate");
  if (!gate || !window.api.browserStatus) return;
  const status = await window.api.browserStatus().catch(function () { return { ready: true }; });
  if (status.ready) return;

  gate.classList.add("show");
  const out = $("browser-progress");
  window.api.onBrowserProgress(function (line) { out.textContent = line; });

  $("browser-install").onclick = async function () {
    const btn = $("browser-install");
    btn.disabled = true;
    out.textContent = "Starting...";
    const r = await window.api.installBrowser();
    if (r && r.ok) {
      gate.classList.remove("show");
      toast("Browser ready");
    } else {
      btn.disabled = false;
      out.textContent = (r && r.error) || "Download failed.";
    }
  };
})();

// Settings section switching. Same shape as switchTab, scoped to the panel.
document.querySelectorAll(".settings-tab").forEach(function (tab) {
  tab.onclick = function () {
    const want = tab.dataset.section;
    document.querySelectorAll(".settings-tab").forEach(function (t) {
      t.classList.toggle("active", t.dataset.section === want);
    });
    document.querySelectorAll(".settings-section").forEach(function (s) {
      s.classList.toggle("active", s.dataset.section === want);
    });
  };
});

/**
 * The theme picker.
 *
 * A theme is one attribute on <html>; the styling is entirely CSS. The
 * attribute is also written by an inline script in <head>, so the app never
 * paints Midnight for a frame before switching.
 */
(function () {
  const grid = $("theme-grid");
  if (!grid || !window.CNTheme) return;
  const T = window.CNTheme;

  function saved(key, fallback) {
    try { return localStorage.getItem(key) || fallback; } catch (e) { return fallback; }
  }
  let current = T.resolveTheme(saved(T.THEME_KEY, null));

  function apply(id) {
    current = T.resolveTheme(id);
    document.documentElement.setAttribute("data-theme", current);
    try { localStorage.setItem(T.THEME_KEY, current); } catch (e) {}
    grid.querySelectorAll(".theme-swatch").forEach(function (s) {
      s.classList.toggle("active", s.dataset.theme === current);
    });
    // The decoration toggle is meaningless on a theme with no texture.
    const meta = T.THEMES.find(function (t) { return t.id === current; });
    const row = $("decor-row");
    if (row) row.style.display = meta && meta.decor ? "" : "none";
  }

  T.THEMES.forEach(function (t) {
    const s = document.createElement("button");
    s.className = "theme-swatch";
    s.dataset.theme = t.id;
    s.title = t.name;
    // The swatch carries the attribute itself, so the tokens inside it resolve
    // to the theme it selects rather than the one currently applied - each
    // swatch previews its own palette.
    s.setAttribute("data-theme", t.id);
    const chip = document.createElement("span");
    chip.className = "theme-swatch-chip";
    const name = document.createElement("span");
    name.className = "theme-swatch-name";
    name.textContent = t.name;
    s.appendChild(chip); s.appendChild(name);
    s.onclick = function () { apply(t.id); };
    grid.appendChild(s);
  });

  const decor = $("theme-decor");
  if (decor) {
    decor.checked = saved(T.DECOR_KEY, "on") !== "off";
    document.documentElement.setAttribute("data-decor", decor.checked ? "on" : "off");
    decor.onchange = function () {
      document.documentElement.setAttribute("data-decor", decor.checked ? "on" : "off");
      try { localStorage.setItem(T.DECOR_KEY, decor.checked ? "on" : "off"); } catch (e) {}
    };
  }

  apply(current);
})();
