/*
 * The renderer's decisions, without the renderer.
 *
 * Extracted from desktop/renderer/*.js (deleted with Electron in 0.4.0).
 * Those files shared one global scope and read state (the
 * workspace, the provider, the plan) from it; here that state comes in as
 * arguments, and saved values come in as the strings Prefs holds rather than
 * being read from localStorage. Everything here is pure.
 */
import * as Controls from "./controls-settings.mjs";
import * as PlanEdit from "./plan-edit.mjs";
import * as Scale from "./plan-scale.mjs";

// ------------------------------------------------------------------ core.js

var MODE_TITLES = { code: "CODE", chat: "PLAN", build: "BUILD", test: "TEST", research: "RESEARCH", push: "SHIP", settings: "SETTINGS" };
// The flow bar describes the planned build, so it shows only in that mode's panels.
var FLOW_MODES = { chat: true, build: true, test: true, push: true };

/** The console's unread badge: empty at zero, capped at 99+. */
function unreadBadge(n) {
  return n ? String(n > 99 ? "99+" : n) : "";
}

/**
 * What flow.mjs reads, from state the app already holds: how many messages
 * the user sent, whether there is a plan, the builder's stats and whether the
 * project was run or shipped from here.
 */
function flowSnapshot(messages, hasPlan, stats, seen) {
  stats = stats || {};
  return {
    messages: messages || 0,
    plan: !!hasPlan,
    stepsTotal: stats.total || 0,
    stepsDone: stats.done || 0,
    stepsFailed: stats.failed || 0,
    building: !!stats.running,
    tested: !!(seen && seen.tested),
    shipped: !!(seen && seen.shipped),
  };
}

/** One flow-bar stage's mark and tooltip. */
function flowMark(st, i) {
  return st.status === "done" ? "✓" : st.status === "failed" ? "!" : String(i + 1);
}

function flowTitle(st) {
  return st.status === "next" ? "Next: " + st.next : st.label + " - " + st.status;
}

function escapeHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function inline(s) {
  var o = escapeHtml(s);
  o = o.replace(/`([^`]+)`/g, '<code class="md-inline">$1</code>');
  o = o.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  o = o.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return o;
}
function renderTextPart(t) {
  var lines = t.split(/\r?\n/);
  var html = "", inList = false, para = [];
  function flush() { if (para.length) { html += '<p class="md-p">' + inline(para.join(" ")) + "</p>"; para = []; } }
  function close() { if (inList) { html += "</ul>"; inList = false; } }
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) { flush(); close(); continue; }
    var h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flush(); close(); html += '<div class="md-h">' + inline(h[2]) + "</div>"; continue; }
    var b = line.match(/^[-*•]\s+(.*)$/);
    if (b) { flush(); if (!inList) { html += '<ul class="md-ul">'; inList = true; } html += "<li>" + inline(b[1]) + "</li>"; continue; }
    var n = line.match(/^\d+[.)]\s+(.*)$/);
    if (n) { flush(); if (!inList) { html += '<ul class="md-ul">'; inList = true; } html += "<li>" + inline(n[1]) + "</li>"; continue; }
    para.push(line);
  }
  flush(); close();
  return html;
}
/**
 * The renderer's small markdown: fenced code, headings, lists, paragraphs,
 * inline code, bold and italic, as HTML. The class names are the Electron
 * stylesheet's; a QML Text in RichText mode ignores them.
 */
function renderMarkdown(md) {
  var re = /```\w*\n?([\s\S]*?)```/g;
  var last = 0, m, html = "";
  while ((m = re.exec(md)) !== null) {
    if (m.index > last) html += renderTextPart(md.substring(last, m.index));
    html += '<pre class="md-code">' + escapeHtml(m[1]) + "</pre>";
    last = re.lastIndex;
  }
  if (last < md.length) html += renderTextPart(md.substring(last));
  return html;
}

// --------------------------------------------------------------- account.js

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
var PHASE_WORDS = {
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

/** A phase event as { name, label, kind, detail }. */
function phaseLabel(p) {
  var name = (p && p.phase) || "idle";
  var known = PHASE_WORDS[name];
  return {
    name: name,
    label: known ? known[0] : name,
    kind: known ? known[1] : "busy",
    detail: (p && p.detail) || "",
  };
}

/**
 * "DeepSeek Chat (something)" is wider than the rail. Drop the parenthetical
 * and the redundant trailing "Chat".
 */
function shortProviderName(full) {
  return full.replace(/\s*\(.*\)$/, "").replace(/\s+Chat$/i, "");
}

/**
 * What onboarding.mjs reads. A saved conversation in this folder counts: someone
 * reopening a project they have already worked in does not need to be told to
 * say something.
 */
function onboardingState(providerList, provider, browserReady, workspace, account, chatCount, savedChats) {
  var p = providerList.find(function (x) { return x.id === provider; });
  return {
    browserReady: browserReady,
    workspace: workspace,
    account: account,
    providerName: p && p.name ? shortProviderName(p.name) : "your provider",
    termsUrl: p && p.termsUrl ? p.termsUrl : "",
    chatted: chatCount > 0 || savedChats > 0,
  };
}

/** The account light after an auth check: { state, text }. */
function accountFromStatus(r) {
  if (!r || !r.success) return { state: "unknown", text: "unknown" };
  return { state: r.signedIn ? "on" : "off", text: r.signedIn ? "signed in" : "signed out" };
}

/**
 * The thread label is the tail of the URL, never the URL: this line is on
 * screen during screen shares and lands in screenshots, and the full link
 * carries a live session.
 */
// The agent's describeThread (session-store.ts): a thread's url, short.
function describeThread(url) {
  var u = String(url || "").trim();
  if (!u) return "";
  var tail = u.split("/").filter(Boolean).pop() || "";
  return tail.length > 8 ? "\u2026" + tail.slice(-8) : tail || "thread";
}

function threadLabel(thread) {
  return thread && thread.url ? "thread " + thread.label : "";
}

/**
 * The selector check's findings as log lines, every one of them including the
 * skipped ones. A check that quietly omitted what it could not verify would
 * read as "everything is fine" while saying nothing about the read path.
 */
function healthLines(r) {
  var out = [{ text: "selector check - " + r.summary, tone: r.ok ? "ok" : "err" }];
  (r.findings || []).forEach(function (f) {
    out.push({
      text: "  " + f.selector + ": " + f.health + " (" + f.matched + " matched)" + (f.note ? " - " + f.note : ""),
      tone: f.health === "critical" ? "err" : "step",
    });
  });
  if (!r.resumed) {
    out.push({
      text: "  no saved conversation here, so the read path was not checked - " +
        "chat once in this workspace, then check again",
      tone: "step",
    });
  }
  return out;
}

// ------------------------------------------------------------- workspace.js

/**
 * A recent workspace's label. The tail is what distinguishes two projects;
 * the head is usually the same for all of them and would push the useful part
 * off the rail.
 */
function recentLabel(p) {
  return p.split(/[\\/]/).filter(Boolean).slice(-2).join("/");
}

// ------------------------------------------------------------- providers.js

/** Where a provider's chosen settings live. Per provider: a model name means
 *  nothing to a different one. */
function controlsKey(id) { return "closeni.controls." + id; }

/** A provider's saved choices, from the string Prefs holds under controlsKey. */
function parseSavedControls(raw) {
  try { return JSON.parse(raw || "{}") || {}; } catch (e) { return {}; }
}

/**
 * What to ask the provider for on the next run: the user's saved choices,
 * validated against what the provider still declares, with defaults filling the
 * gaps. Empty for a provider with no controls, which the agent reads as
 * "change nothing".
 */
function desiredControls(providerList, provider, savedRaw) {
  var p = providerList.find(function (x) { return x.id === provider; });
  if (!p || !p.controls || !p.controls.length) return {};
  return Controls.resolveControls(p.controls, parseSavedControls(savedRaw));
}

/** The saved choices with one control changed, as the string to store. */
function saveControl(savedRaw, id, value) {
  var next = parseSavedControls(savedRaw);
  next[id] = value;
  return JSON.stringify(next);
}

// ----------------------------------------------------------------- chats.js

function chatTitle(chat, i) {
  return chat.title || ("Chat " + (i + 1));
}

// When a chat was started, short: the time today, the day this year, else
// the date. `now` is for the tests.
function shortWhen(iso, now) {
  var d = new Date(iso || "");
  if (isNaN(d.getTime())) return "";
  var n = now ? new Date(now) : new Date();
  var pad = function (x) { return (x < 10 ? "0" : "") + x; };
  if (d.toDateString() === n.toDateString()) return pad(d.getHours()) + ":" + pad(d.getMinutes());
  var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  if (d.getFullYear() === n.getFullYear()) return months[d.getMonth()] + " " + d.getDate();
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

// A new chat's name, from its first message: the first line, cut at a word
// near 48 characters.
function chatName(text) {
  var line = String(text || "").split("\n").map(function (l) { return l.trim(); }).filter(Boolean)[0] || "";
  line = line.replace(/\s+/g, " ");
  if (line.length <= 48) return line;
  var cut = line.slice(0, 48);
  var sp = cut.lastIndexOf(" ");
  return (sp > 24 ? cut.slice(0, sp) : cut).replace(/[\s.,;:!?-]+$/, "") + "\u2026";
}

// ------------------------------------------------------------------ plan.js

function tryExtractPlan(text) {
  var jm = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  var s = jm ? jm[1].trim() : text.trim();
  try { var o = JSON.parse(s); if (o && o.steps) return o; } catch (e) {}
  try {
    var a = s.indexOf("{"), b = s.lastIndexOf("}");
    if (a !== -1 && b > a) { var o2 = JSON.parse(s.substring(a, b + 1)); if (o2 && o2.steps) return o2; }
  } catch (e) {}
  return null;
}

/**
 * Apply one plan-panel edit ("up", "down", "merge" or "del") to step i.
 *
 * Every operation goes through plan-edit, which remaps dependsOn. Editing the
 * array directly would leave indices pointing at whatever moved into that
 * slot - a graph that fails validation, falls back to the plain chain, and
 * silently undoes the scheduler work that lets independent steps survive a
 * failure. Returns plan-edit's result with `plan` set to the edited plan, or
 * null for an unknown action.
 */
function applyPlanEdit(plan, act, i) {
  var steps = plan.steps || [];
  var res;
  if (act === "up") res = PlanEdit.moveStep(steps, i, i - 1);
  else if (act === "down") res = PlanEdit.moveStep(steps, i, i + 1);
  else if (act === "merge") res = PlanEdit.mergeStepUp(steps, i);
  else if (act === "del") res = PlanEdit.deleteStep(steps, i);
  else return null;
  if (!res.refused) res.plan = Object.assign({}, plan, { steps: res.steps });
  return res;
}

/**
 * The plan's size and how long it will take. Each step is a browser
 * round-trip, so a long plan is a long build. Say so before the Build button
 * rather than after twenty minutes of waiting. Empty for a plan with no steps.
 */
function planScaleText(plan) {
  var stepCount = (plan.steps || []).length;
  return stepCount ? stepCount + " steps · " + Scale.estimateDuration(stepCount) : "";
}

/** Every file the plan's steps name, sorted, once each. */
function planFiles(plan) {
  var allFiles = new Set();
  (plan.steps || []).forEach(function (s) { (s.files || []).forEach(function (f) { allFiles.add(f); }); });
  return Array.from(allFiles).sort();
}

/** The languages and frameworks the plan's files and details mention, in first-seen order. */
function planTechStack(plan) {
  var techSet = new Set();
  (plan.steps || []).forEach(function (s) {
    (s.files || []).forEach(function (f) {
      if (f.endsWith(".py")) techSet.add("Python");
      else if (f.endsWith(".js")) techSet.add("JavaScript");
      else if (f.endsWith(".ts")) techSet.add("TypeScript");
      else if (f.endsWith(".html")) techSet.add("HTML");
      else if (f.endsWith(".css")) techSet.add("CSS");
    });
    var d = (s.detail || "").toLowerCase();
    ["flask", "django", "react", "sqlite", "postgres", "fastapi", "express"].forEach(function (k) {
      if (d.indexOf(k) !== -1) techSet.add(k.charAt(0).toUpperCase() + k.slice(1));
    });
  });
  return Array.from(techSet);
}

/**
 * What "Generate plan" sends: the chat so far, after the reference project
 * when one was picked in Research, so the plan is designed against how a real
 * project of that kind is laid out.
 */
function planRequest(history, reference) {
  var transcript = "";
  history.forEach(function (m) { transcript += (m.role === "user" ? "USER: " : "AI: ") + m.text + "\n\n"; });
  var refBlock = reference
    ? "Reference project " + reference.name + ":\n" + reference.readme +
      "\n\nIts file layout:\n" + reference.files.join("\n") + "\n\n---\n\n"
    : "";
  return refBlock + transcript;
}

/** Step titles for "export to a branch": the plan's, since a checkpoint stores only the detail. */
function exportRequest(workspace, plan) {
  return {
    workspace: workspace,
    summary: (plan && plan.summary) || "",
    steps: ((plan && plan.steps) || []).map(function (s) { return s.title || ""; }),
  };
}

// ------------------------------------------------------------------ test.js

var RUN_LABELS = {
  manifest: ["SAVED", "from closeni.run.json - edit it here and it sticks"],
  plan: ["FROM YOUR PLAN", "the model declared this while planning"],
  detected: ["DETECTED", "guessed from the files in this workspace"],
  none: ["NOT FOUND", "type a command, or build a project and one gets saved"],
};

/**
 * What to run, and where the answer came from.
 *
 * The manifest wins, then the plan, then filename detection. The badge shows
 * which, because "from your plan" and "detected from main.py" are different
 * levels of confidence and the user should be able to tell them apart.
 */
function chooseRunCommand(workspace, manifest, plan, detected) {
  if (!workspace) return { command: null, source: "none" };
  if (manifest && String(manifest.run || "").trim()) return { command: manifest.run.trim(), source: "manifest" };
  if (plan && String(plan.runCommand || "").trim()) return { command: plan.runCommand.trim(), source: "plan" };
  if (detected) return { command: detected, source: "detected" };
  return { command: null, source: "none" };
}

/**
 * The run history: newest first, a short list, not a log - enough that a
 * syntax check does not vanish the moment something else runs.
 */
function pushHistory(list, label, ok) {
  return [{ label: label, ok: ok }].concat(list).slice(0, 6);
}

/**
 * Behaviour, not syntax: the summary line. A suite that exists but whose
 * runner is missing is reported as not run rather than counted either way - a
 * green "0 failed" on a project whose tests never ran is the most misleading
 * thing the panel could show.
 */
function behaviourSummary(res) {
  var passed = res.passed || 0, failed = res.failed || 0, skipped = res.skipped || 0;
  var summary = passed + " passed, " + failed + " failed";
  if (skipped) summary += ", " + skipped + " not run";
  if (!passed && !failed && !skipped) summary = res.note || "nothing to run";
  return summary;
}

/** The syntax check's summary and history label. */
function syntaxSummary(res) {
  return {
    summary: (res.passed || 0) + " passed, " + (res.failed || 0) + " failed",
    history: "syntax check · " + ((res.passed || 0) + (res.failed || 0)) + " checks",
  };
}

/** The last run as the Test chat carries it: results are JSON, capped. */
function lastRunFromResults(command, results) {
  return { command: command, output: JSON.stringify(results || []).slice(0, 4000) };
}

// ------------------------------------------------------------------ ship.js

/** A workflow run's state. in_progress carries no conclusion yet, so status is what to colour by. */
function runState(run) {
  return run.status === "completed" ? (run.conclusion || "unknown") : "running";
}

/** A repository's entry in the picker: its clone URL and label. */
function repoOption(repo) {
  return {
    value: repo.clone_url || ("https://github.com/" + repo.full_name + ".git"),
    label: repo.full_name + (repo.private ? " (private)" : ""),
  };
}

/**
 * The clone confirmation. The licence is the user's to accept, so it goes in
 * front of them rather than into a doc they will not read.
 */
function cloneConfirmText(parsed, license) {
  var licence = license || "an unknown licence";
  return "Clone " + parsed.owner + "/" + parsed.repo + " into your workspace?\n\n" +
    "It carries " + licence + ", and the AI will go on to edit code it did not write.";
}

/**
 * A repository taken as reference, from github-safe's parse and the getReadme
 * and getTree replies; null when neither could be read.
 */
function referenceFrom(parsed, readme, tree) {
  if (!readme.ok && !tree.ok) return null;
  return {
    name: parsed.owner + "/" + parsed.repo,
    readme: (readme.ok ? readme.result : "").slice(0, 3000),
    files: (tree.ok ? tree.result : []).slice(0, 120),
  };
}

/** Said plainly rather than discovered next launch when the token is gone. */
function tokenStorageNote(encryptionAvailable) {
  return encryptionAvailable
    ? "Stored encrypted on this machine."
    : "This system offers no secure storage, so the token is kept in memory only and must be re-entered next launch.";
}

// Scopes pre-selected, so the user grants exactly what is needed and can see
// what that is before agreeing to it.
var TOKEN_URL = "https://github.com/settings/tokens/new?scopes=repo,workflow&description=CloseNI";

// --------------------------------------------------------------- startup.js

/**
 * The provider to select at launch. A preference saved before a provider was
 * gated would otherwise select it and fail on the first build. Coming-soon
 * providers are listed but never picked.
 */
function pickProvider(list, saved) {
  var usable = list.filter(function (p) { return !p.comingSoon; });
  if (saved && usable.some(function (p) { return p.id === saved; })) return saved;
  if (usable.length) return usable[0].id;
  return "";
}

function providerOptionLabel(p) {
  return p.comingSoon ? p.name + " — coming soon" : p.name;
}

// ---------------------------------------------------------------- skills.js

/** owner/repo/path/to/file.md, as the import request, or null. */
function parseSkillImport(raw) {
  var m = String(raw || "").trim().match(/^([^/]+)\/([^/]+)\/(.+\.md)$/i);
  return m ? { owner: m[1], repo: m[2], path: m[3], kind: "skill" } : null;
}

/** The ticked skills with one turned on or off. */
function toggleSkill(list, name, on) {
  return on ? list.concat([name]) : list.filter(function (x) { return x !== name; });
}

/** The ticked skills, from the string Prefs holds under closeni.skills. */
function parseSkills(raw) {
  try { return JSON.parse(raw || "[]") || []; } catch (e) { return []; }
}

/**
 * Why the MCP configuration cannot be saved, or "" when it can. Parsed before
 * saving so a typo is caught now rather than by a build that depends on it.
 * Empty is fine: it means no MCP at all.
 */
function mcpConfigError(text) {
  if (!String(text || "").trim()) return "";
  try { JSON.parse(text); } catch (e) { return "That is not valid JSON"; }
  return "";
}

/**
 * The preamble for a run (buildPreamble in skills.js), from what was read:
 * the persona's readSkill reply, each ticked skill's reply in order, and
 * gatherMcpContext's. A file that is missing, unreadable or blank adds nothing,
 * so a skill deleted outside the app simply stops being read.
 */
function composePreamble(persona, skills, mcp) {
  var parts = {};
  function usable(r) { return !!(r && r.ok && typeof r.text === "string" && r.text.trim()); }
  if (usable(persona)) parts.persona = persona.text;
  var texts = (skills || []).filter(usable).map(function (s) { return s.text; });
  if (texts.length) parts.skills = texts;
  if (mcp && mcp.texts && mcp.texts.length) parts.mcpContext = mcp.texts;
  return parts;
}

// -------------------------------------------------------------- settings.js

/** The permission policy's choices, as #autonomy-select listed them. */
var AUTONOMY_OPTIONS = [
  { value: "ask", label: "Ask each command" },
  { value: "auto", label: "Auto-allow" },
  { value: "never", label: "Never run commands" },
];

/**
 * The saved permission policy, or "ask". A value the select does not offer
 * left it blank in Electron, and getAutonomy read a blank select as "ask".
 */
function resolveAutonomy(saved) {
  return AUTONOMY_OPTIONS.some(function (o) { return o.value === saved; }) ? saved : "ask";
}

export {
  MODE_TITLES,
  FLOW_MODES,
  unreadBadge,
  flowSnapshot,
  flowMark,
  flowTitle,
  escapeHtml,
  renderMarkdown,
  PHASE_WORDS,
  phaseLabel,
  shortProviderName,
  onboardingState,
  accountFromStatus,
  threadLabel,
  healthLines,
  recentLabel,
  controlsKey,
  parseSavedControls,
  desiredControls,
  saveControl,
  chatTitle,
  chatName,
  describeThread,
  shortWhen,
  tryExtractPlan,
  applyPlanEdit,
  planScaleText,
  planFiles,
  planTechStack,
  planRequest,
  exportRequest,
  RUN_LABELS,
  chooseRunCommand,
  pushHistory,
  behaviourSummary,
  syntaxSummary,
  lastRunFromResults,
  runState,
  repoOption,
  cloneConfirmText,
  referenceFrom,
  tokenStorageNote,
  TOKEN_URL,
  pickProvider,
  providerOptionLabel,
  parseSkillImport,
  toggleSkill,
  parseSkills,
  mcpConfigError,
  composePreamble,
  AUTONOMY_OPTIONS,
  resolveAutonomy,
};
