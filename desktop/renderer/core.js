/*
 * The renderer's shared core: the state every panel reads, $ and the status,
 * toast and console helpers, markdown, the approval prompt, tab switching and
 * the flow bar.
 *
 * The renderer is a set of classic scripts sharing one global scope, loaded in
 * order by index.html: core, workspace, providers, account, plan, skills,
 * test, ship, chats, settings, then startup. A file may call into an earlier
 * one at load time, never a later one; startup.js runs last and is where
 * launch work starts.
 */
let workspace = "";
let provider = "deepseek";
let chatHistory = [];
let currentPlan = null;
let editingPlan = false;
// What the getting-started guide reads. Both are written where the state
// actually changes - the browser gate and the account light - never by the
// guide itself, so it cannot report a step done that is not.
let browserReady = true;
let acctNow = "unknown";

const MODE_TITLES = { code: "CODE", chat: "PLAN", build: "BUILD", test: "TEST", research: "RESEARCH", push: "SHIP", settings: "SETTINGS" };
// The flow bar describes the planned build, so it shows only in that mode's panels.
const FLOW_MODES = { chat: true, build: true, test: true, push: true };

function $(id) { return document.getElementById(id); }
function setStatus(t) {
  const el = $("status-line"); if (el) el.textContent = t;
  // Every status change is a moment the flow may have moved on.
  if (typeof refreshFlow === "function") refreshFlow();
}

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
  consoleArrived(cls === "err");
}
function plog(line) {
  const box = $("plog"); if (!box) return;
  const el = document.createElement("div");
  el.className = "log-line"; el.textContent = line;
  box.appendChild(el); box.scrollTop = box.scrollHeight;
  consoleArrived(false);
}

/**
 * The console drawer. Closed, it counts what arrived; an error opens it,
 * because an error nobody sees is the failure mode the old always-open panes
 * existed to prevent. Open or closed is remembered, as a convenience only.
 */
let consoleUnread = 0;
function consoleIsOpen() { const c = $("console"); return !!c && !c.classList.contains("collapsed"); }
function setConsole(open, remember) {
  const c = $("console"); if (!c) return;
  c.classList.toggle("collapsed", !open);
  const t = $("console-toggle"); if (t) t.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) { consoleUnread = 0; paintUnread(); }
  if (remember) { try { localStorage.setItem("closeni.console", open ? "open" : "closed"); } catch (e) {} }
}
function paintUnread() {
  const u = $("console-unread"); if (!u) return;
  u.textContent = consoleUnread ? String(consoleUnread > 99 ? "99+" : consoleUnread) : "";
  u.classList.toggle("on", consoleUnread > 0);
}
function consoleArrived(isError) {
  if (consoleIsOpen()) return;
  if (isError) { setConsole(true, false); return; }
  consoleUnread++; paintUnread();
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
  // Every panel but the agent is somewhere you visit: say how to get back.
  const back = $("back-to-code"); if (back) back.classList.toggle("is-hidden", mode === "code");
  // The run bar reads the manifest from disk, so it must refresh on open
  // rather than only after a build.
  if (mode === "test" && typeof refreshRunBar === "function") refreshRunBar();
  if (mode === "push" && typeof refreshGitHub === "function") refreshGitHub();
  // Read from disk on open: a skill created in an editor should appear without
  // restarting the app.
  if (mode === "settings" && typeof refreshSkills === "function") refreshSkills();
  const fl = $("flow"); if (fl) fl.style.display = FLOW_MODES[mode] ? "" : "none";
  if (mode === "code" && window.CN && window.CN.focusCode) window.CN.focusCode();
  refreshFlow();
}

/**
 * The flow bar: describe, plan, build, test, ship.
 *
 * Redrawn on the events that can move it - a message, a plan, a step status,
 * a run, a push, a tab switch - never on a timer. Each stage is read from
 * state the app already holds (see desktop/flow.js), so it cannot claim a
 * build that failed.
 */
// var, not const: setStatus can run before this line has, and a const read
// there would throw rather than draw nothing.
var flowSeen = { tested: false, shipped: false };
function flowSnapshot() {
  const stats = window.CN && window.CN.buildStats ? window.CN.buildStats() : {};
  const flow = $("chat-flow");
  return {
    messages: flow ? flow.querySelectorAll(".msg.user").length : 0,
    plan: !!currentPlan,
    stepsTotal: stats.total || 0,
    stepsDone: stats.done || 0,
    stepsFailed: stats.failed || 0,
    building: !!stats.running,
    tested: flowSeen.tested,
    shipped: flowSeen.shipped,
  };
}
function refreshFlow() {
  const bar = $("flow");
  if (!bar || !window.CNFlow || !flowSeen) return;
  const list = window.CNFlow.stages(flowSnapshot());
  const active = (document.querySelector(".nav-btn.active") || {}).dataset || {};
  bar.innerHTML = "";
  list.forEach(function (st, i) {
    if (i) {
      const sep = document.createElement("span");
      sep.className = "flow-sep" + (list[i - 1].status === "done" ? " done" : "");
      sep.setAttribute("aria-hidden", "true");
      bar.appendChild(sep);
    }
    const b = document.createElement("button");
    b.className = "flow-step " + st.status + (st.mode === active.mode ? " here" : "");
    b.dataset.mode = st.mode;
    b.title = st.status === "next" ? "Next: " + st.next : st.label + " - " + st.status;
    const mark = document.createElement("i");
    mark.textContent = st.status === "done" ? "\u2713" : st.status === "failed" ? "!" : String(i + 1);
    b.appendChild(mark);
    b.appendChild(document.createTextNode(st.label));
    b.onclick = function () { switchTab(st.mode); };
    bar.appendChild(b);
  });
}
$("back-to-code").onclick = function () { switchTab("code"); };
document.querySelectorAll(".nav-btn").forEach(function (btn) {
  btn.onclick = function () {
    // A gated tab says so rather than doing nothing. Silent buttons read as
    // broken, which is the whole reason gated providers announce themselves too.
    if (btn.dataset.gated) { toast(btn.dataset.gatedMsg || "Not ready yet", "err"); return; }
    switchTab(btn.dataset.mode);
  };
});
