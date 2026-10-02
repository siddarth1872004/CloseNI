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
  acctNow = state;
  renderOnboarding();
  if (window.CN && window.CN.onAccountChange) window.CN.onAccountChange();
  const signedIn = state === "on";
  const inBtn = $("acct-signin");
  const outBtn = $("acct-signout");
  if (inBtn) inBtn.classList.toggle("is-hidden", signedIn);
  if (outBtn) outBtn.classList.toggle("is-hidden", !signedIn);
}

/*
 * The getting-started guide above the chat.
 *
 * The decisions - order, wording, what counts as done - live in onboarding.js
 * where they are tested; this only draws them and wires the buttons to the
 * controls that already exist, so each step does exactly what the rail or
 * Settings would do.
 */
function onboardingState() {
  const p = providerList.find(function (x) { return x.id === provider; });
  return {
    browserReady: browserReady,
    workspace: workspace,
    account: acctNow,
    providerName: p && p.name ? p.name.replace(/\s*\(.*\)$/, "").replace(/\s+Chat$/i, "") : "your provider",
    termsUrl: p && p.termsUrl ? p.termsUrl : "",
    // A saved conversation in this folder counts: someone reopening a project
    // they have already worked in does not need to be told to say something.
    chatted: chatHistory.length > 0 || savedChatCount() > 0,
  };
}

// availableChats is declared in chats.js, which loads after this file; reading
// it before then throws rather than returning undefined, so the guard is a try.
function savedChatCount() {
  try { return availableChats.length; } catch (e) { return 0; }
}

function onboardingDismissed() {
  try { return window.CNOnboarding.isDismissed(localStorage.getItem(window.CNOnboarding.DISMISS_KEY)); }
  catch (e) { return false; }
}

function onboardingAction(id) {
  if (id === "browser") { const g = $("browser-gate"); if (g) g.classList.add("show"); return; }
  if (id === "workspace") { $("browse-btn").click(); return; }
  if (id === "signin") {
    if (acctNow === "unknown") refreshAccount(true);
    else $("provider-signin").click();
    return;
  }
  if (id === "prompt") {
    const input = $("chat-input");
    input.value = window.CNOnboarding.EXAMPLE_PROMPT;
    input.focus();
    toast("Example filled in - press Send");
  }
}

function renderOnboarding() {
  const box = $("welcome");
  if (!box || !window.CNOnboarding) return;
  const O = window.CNOnboarding;
  const state = onboardingState();
  if (!O.visible(state, onboardingDismissed())) {
    box.classList.add("is-hidden");
    box.innerHTML = "";
    return;
  }
  const next = O.current(state);
  box.classList.remove("is-hidden");
  box.innerHTML = "";

  const head = document.createElement("div");
  head.className = "welcome-head";
  const title = document.createElement("div");
  title.className = "micro";
  title.textContent = "Getting started";
  const hide = document.createElement("button");
  hide.className = "btn btn-sm";
  hide.textContent = "Hide";
  hide.title = "Hide this guide. Settings, About brings it back.";
  hide.onclick = function () {
    try { localStorage.setItem(O.DISMISS_KEY, "dismissed"); } catch (e) {}
    renderOnboarding();
  };
  head.appendChild(title); head.appendChild(hide);
  box.appendChild(head);

  const intro = document.createElement("div");
  intro.className = "hint";
  intro.textContent = "CloseNI plans and builds software by chatting with a free AI site in a " +
    "real browser - no API key. Four things, in this order:";
  box.appendChild(intro);

  const list = document.createElement("ol");
  list.className = "welcome-steps";
  O.steps(state).forEach(function (step) {
    const li = document.createElement("li");
    li.className = "welcome-step" + (step.done ? " done" : "") + (step.id === next ? " next" : "");
    const mark = document.createElement("span");
    mark.className = "welcome-mark";
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = step.done ? "✓" : "";
    const body = document.createElement("div");
    body.className = "welcome-body";
    const t = document.createElement("div");
    t.className = "welcome-title";
    t.textContent = step.title + (step.done ? " - done" : "");
    body.appendChild(t);
    // Only the step you are on explains itself; the rest are one line each.
    if (step.id === next) {
      const d = document.createElement("div");
      d.className = "hint";
      d.textContent = step.detail;
      body.appendChild(d);
      if (step.terms) {
        const t2 = document.createElement("div");
        t2.className = "hint";
        t2.textContent = step.terms + " ";
        if (step.termsUrl) {
          const a = document.createElement("a");
          a.href = "#";
          a.className = "terms-link";
          a.textContent = "Read the terms";
          a.onclick = function (e) { e.preventDefault(); window.api.openThread(step.termsUrl); };
          t2.appendChild(a);
        }
        body.appendChild(t2);
      }
    }
    li.appendChild(mark); li.appendChild(body);
    if (step.action && step.id === next) {
      const b = document.createElement("button");
      b.className = "btn btn-sm invert";
      b.textContent = step.action;
      b.onclick = function () { onboardingAction(step.id); };
      li.appendChild(b);
    }
    list.appendChild(li);
  });
  box.appendChild(list);
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
