/*
 * Last of the renderer scripts: window.CN, the interface builder.js and code.js
 * use, and the work that starts at launch. Launch work lives here, not beside
 * the panel it fills, because an async start may resume before a later script
 * has loaded; from here every function it can reach is already defined.
 */
window.CN = {
  getWorkspace: function () { return workspace; },
  getProvider: function () { return provider; },
  // The getting-started guide's sign-in step, for the Code panel's welcome:
  // that is the screen a first launch lands on, not the chat panel's guide.
  signInStep: function () {
    return window.CNOnboarding.steps(onboardingState()).find(function (s) { return s.id === "signin"; });
  },
  onboardingAction: onboardingAction,
  openUrl: function (url) { return window.api.openThread(url); },
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
  sendStep: function (index, detail, goal, testable, title) {
    try {
      return window.api.sendStep(index, detail, goal, testable, title)
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
  buildStats: function () { return {}; },
  getControls: function () { return desiredControls(); },
  buildPreamble: function () { return buildPreamble(); },
  setStatus: function (t) { setStatus(t); },
  getProviderName: function () {
    const p = providerList.find(function (x) { return x.id === provider; });
    return p ? p.name : provider;
  },
  openConsole: function () { setConsole(true, false); },
  refreshFlow: function () { refreshFlow(); },
  // For the modes in the Code panel: the same actions the old panels ran.
  resolveRunCommand: function () { return resolveRunCommand(); },
  useAsReference: function (r) { return useAsReference(r); },
  cloneRepo: function (r) { return cloneRepo(r); },
  git: function (args) { return workspace ? g(args) : Promise.resolve({ success: false, output: "No project folder chosen" }); },
  markTested: function () { flowSeen.tested = true; refreshFlow(); },
  markShipped: function () { flowSeen.shipped = true; refreshFlow(); },
};

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

  browserReady = false;
  renderOnboarding();
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
      browserReady = true;
      renderOnboarding();
      toast("Browser ready");
    } else {
      btn.disabled = false;
      out.textContent = (r && r.error) || "Download failed.";
    }
  };
})();

renderOnboarding();

refreshFlow();

(function () {
  const t = $("console-toggle");
  if (t) t.onclick = function () { setConsole(!consoleIsOpen(), true); };
  let saved = null;
  try { saved = localStorage.getItem("closeni.console"); } catch (e) {}
  setConsole(saved === "open", false);
})();
