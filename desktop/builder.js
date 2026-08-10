(function () {
  const CN = window.CN;
  let steps = [];
  let running = false, paused = false, skipNext = false, stopRequested = false;
  // A build runs through one long-lived agent session when it can; retryFailed
  // and any fallback keep using the per-step spawn.
  let sessionOn = false;
  function sessionActive() { return sessionOn; }
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
    // No entry for "pending" or "skipped": nothing has happened to them, so
    // nothing should move.
    const PIX_MOTION = { done: "pix-stamp", failed: "pix-flicker", running: "pix-spin", blocked: "" };
    steps.forEach(function (s, i) {
      const card = document.createElement("div");
      card.className = "step-card" + (i === selected ? " active" : "");
      card.innerHTML =
        '<span class="step-card-num">0' + (i + 1) + '</span>' +
        '<span class="step-card-title">' + CN.escapeHtml(s.title || "Step") + '</span>' +
        // Pixel motion marks the change: a finished step stamps in, a running
        // one spins, a failed one flickers. Event-driven only - none of this
        // runs on an idle screen.
        '<span class="step-card-status ' + s.status + ' ' + PIX_MOTION[s.status] + '">' + s.status + '</span>';
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
        // The mark's colour is a token value, so it goes inline - that is data
        // about the file, not styling of the card.
        const lm = window.CNLang ? window.CNLang.languageMark(f.path) : null;
        const markHtml = lm
          ? '<span class="lang-mark" style="color:var(' + lm.token + ')">' + CN.escapeHtml(lm.label) + "</span>"
          : "";
        head.innerHTML = markHtml + '<span class="file-path">' + CN.escapeHtml(f.path) + '</span><span class="file-mode ' + (f.mode || "create") + '">' + (f.mode || "create") + '</span>';
        head.onclick = function () { const bb = fc.querySelector(".file-body"); if (bb) bb.classList.toggle("open"); };
        const bb = document.createElement("div");
        bb.className = "file-body";
        if (f.diff && f.diff.length) {
          bb.innerHTML = "<pre>" + f.diff.map(function (r) {
            const mark = r.type === "add" ? "+" : r.type === "remove" ? "-" : " ";
            return '<span class="diff-line ' + r.type + '">' + CN.escapeHtml(mark + " " + r.text) + "</span>";
          }).join("") + "</pre>";
        } else {
          bb.innerHTML = "<pre>" + CN.escapeHtml(f.content || "") + "</pre>";
        }
        fc.appendChild(head); fc.appendChild(bb);
        body.appendChild(fc);
      });
    }
  }

  // Reads the written file and, when applyPatch made a backup, the version it
  // replaced, so the card can show a diff rather than a wall of content.
  async function loadFileDiffs(ws, res) {
    const out = [];
    for (const af of (res.appliedFiles || [])) {
      let after = "";
      let before = "";
      try {
        const fr = await CN.readFile(ws + "/" + af, { full: true });
        if (fr && fr.ok) after = fr.text;
      } catch (e) {}
      if (res.backupDir) {
        try {
          const br = await CN.readFile(res.backupDir + "/" + af, { full: true });
          if (br && br.ok) before = br.text;
        } catch (e) { /* no backup entry means the file was created */ }
      }
      out.push({
        path: af,
        mode: before ? "overwrite" : "create",
        content: after,
        diff: window.CNDiff ? window.CNDiff.diffLines(before, after) : null,
      });
    }
    return out;
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
    const args = ["browser", stepDetail, ws, CN.getProvider(), CN.getAutonomy(), String(i), stepDetail, (plan && plan.summary) || ""];
    const res = sessionActive()
      ? await CN.sendStep(i, stepDetail, (plan && plan.summary) || "")
      : await CN.runAgent(args);

    if (res && res.success) {
      const filesArr = await loadFileDiffs(ws, res);
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

    const started = await CN.startSession(CN.getWorkspace(), CN.getProvider(), CN.getAutonomy());
    sessionOn = !!(started && started.ok);
    if (!sessionOn) CN.log("session unavailable, falling back to a browser per step: " + ((started && started.error) || "unknown"), "step");
    else CN.log("build session ready - one browser for the whole build", "step");

    // The graph, declared or implied. A plan where nothing is declared is a
    // chain, which reproduces the old serial loop exactly - and every plan that
    // existed before this change is such a plan.
    const anyDeclared = steps.some(function (s) { return Array.isArray(s.dependsOn); });
    const graph = steps.map(function (s, i) {
      if (anyDeclared) return Array.isArray(s.dependsOn) ? s.dependsOn.slice() : [];
      return i === 0 ? [] : [i - 1];
    });
    const limit = CN.getConcurrency();
    // Seeded from what the step list already records, so pressing Build after a
    // partial run continues instead of redoing everything from step 0.
    const state = window.CNSched.seedState(steps);
    // A step that failed last time is being retried by starting again, so clear
    // it and anything it blocked - otherwise the scheduler treats the whole
    // subtree as settled and stops immediately.
    state.failed.concat(state.blocked).forEach(function (i) { setStatusOf(i, "pending"); });
    state.failed = [];
    state.blocked = [];
    if (state.completed.length) {
      CN.log("resuming: " + state.completed.length + "/" + steps.length + " already done", "step");
    }

    function done() {
      return state.completed.length + state.failed.length +
             state.blocked.length + state.skipped.length;
    }

    function settle(i, ok) {
      state.running = state.running.filter(function (x) { return x !== i; });
      (ok ? state.completed : state.failed).push(i);
      if (!ok) {
        // Blocked, not failed: these steps never ran, and calling them failed
        // would claim something about code nobody executed.
        window.CNSched.blockedBy(graph, state.failed).forEach(function (b) {
          if (state.blocked.indexOf(b) === -1 && state.completed.indexOf(b) === -1 &&
              state.failed.indexOf(b) === -1 && state.running.indexOf(b) === -1) {
            state.blocked.push(b);
            setStatusOf(b, "blocked");
            CN.log("step " + (b + 1) + " blocked: a step it depends on failed", "step");
          }
        });
      }
      progress(done() / steps.length);
    }

    while (!stopRequested) {
      while (paused && !stopRequested) await sleep(500);
      if (stopRequested) break;

      const ready = window.CNSched.runnableSteps(graph, state, limit);
      if (!ready.length) {
        // Nothing running and nothing startable means the build is over -
        // either finished, or every remaining step is blocked.
        if (state.running.length === 0) break;
        await sleep(250);
        continue;
      }

      ready.forEach(function (i) {
        if (skipNext) {
          skipNext = false;
          state.skipped.push(i);
          setStatusOf(i, "skipped");
          CN.log("step " + (i + 1) + " skipped", "step");
          progress(done() / steps.length);
          return;
        }
        state.running.push(i);
        runOne(i).then(function (ok) { settle(i, ok); }, function () { settle(i, false); });
      });
      await sleep(120);
    }

    // Let anything still in flight finish before the session closes, or its
    // apply would be cut off midway.
    while (state.running.length && !stopRequested) await sleep(250);

    if (sessionOn) { await CN.endSession(); sessionOn = false; }

    running = false;
    buttons("idle");
    const finished = steps.filter(function (s) { return s.status === "done" || s.status === "skipped"; }).length;
    status("finished: " + finished + "/" + steps.length);
    CN.log("build finished: " + finished + "/" + steps.length, "step");
    CN.toast("Build finished: " + finished + "/" + steps.length);
    await saveRunManifest();
  };

  /**
   * Persist how to run what was just built.
   *
   * The model declared this while planning; without writing it down the answer
   * dies with the session and the Test panel is back to guessing from
   * filenames. mergeManifest preserves a command the user edited, so this
   * cannot undo a correction.
   */
  async function saveRunManifest() {
    const ws = CN.getWorkspace();
    if (!ws) return;
    const plan = CN.getPlan();
    let detected = null;
    try {
      const files = await window.api.listFiles(ws);
      detected = window.CNEntry
        ? window.CNEntry.detectEntrypoint(files, null, null, window.api.platform)
        : null;
    } catch (e) { /* an unreadable workspace just means no detection */ }
    const chosen = (plan && plan.runCommand) || detected;
    if (!chosen) return;
    const r = await window.api.writeManifest({ workspace: ws, run: chosen });
    if (r && r.ok) CN.log("run command saved: " + r.manifest.run, "ok");
  }

  /**
   * The frontend preview.
   *
   * Only offered when there is genuinely something to show - an empty frame is
   * worse than no button. Exposed for renderer.js to call after a run, since
   * that is where the server output arrives.
   */
  window.CNBuilderPreview = {
    update: function (runOutput, ws, files) {
      const btn = document.getElementById("builder-preview");
      if (!btn || !window.CNPreview) return;
      const target = window.CNPreview.previewTarget(runOutput || "", files || []);
      btn.classList.toggle("is-hidden", !target);
      btn.dataset.url = target ? target.url : "";
      btn.dataset.kind = target ? target.kind : "";
      btn.dataset.ws = ws || CN.getWorkspace() || "";
    },
  };

  document.getElementById("builder-preview").onclick = function () {
    const btn = document.getElementById("builder-preview");
    if (!btn.dataset.url) return;
    const url = btn.dataset.kind === "file"
      ? "file://" + btn.dataset.ws + "/" + btn.dataset.url
      : btn.dataset.url;
    document.getElementById("preview-frame").src = url;
    document.getElementById("preview-url").textContent = url;
    document.getElementById("preview-pane").classList.remove("is-hidden");
  };

  document.getElementById("preview-close").onclick = function () {
    document.getElementById("preview-pane").classList.add("is-hidden");
    // about:blank rather than leaving it loaded: a preview nobody is looking at
    // should not keep running a generated page's scripts.
    document.getElementById("preview-frame").src = "about:blank";
  };

  /**
   * Retry the failed step and carry on through the rest.
   *
   * This used to run exactly one step and stop, so the only way forward was
   * Start Build - which restarted from step 0 and redid everything. Delegating
   * to startBuild now resumes: seedState keeps what succeeded, and the failed
   * step and anything it blocked are reset to pending.
   */
  CN.retryFailed = async function () {
    if (running) { CN.toast("Already running", "err"); return; }
    if (!steps.some(function (s) { return s.status === "failed" || s.status === "blocked"; })) {
      CN.toast("Nothing failed to retry");
      return;
    }
    await CN.startBuild();
  };

  $("builder-start").onclick = function () { CN.startBuild(); };
  $("builder-pause").onclick = function () { paused = true; buttons("paused"); status("paused"); CN.toast("Paused"); };
  $("builder-resume").onclick = function () { paused = false; buttons("running"); status("resumed"); CN.toast("Resumed"); };
  $("builder-skip").onclick = function () { skipNext = true; CN.toast("Will skip next step"); };
  $("builder-stop").onclick = function () { stopRequested = true; paused = false; status("stopping..."); CN.toast("Stopping", "err"); };
  $("builder-retry").onclick = function () { CN.retryFailed(); };

  if (CN.getPlan()) CN.setPlan(CN.getPlan());

  $("suggest-send").onclick = async function () {
    const input = $("suggest-input");
    const text = (input.value || "").trim();
    if (!text) return;
    if (selected < 0 || !steps[selected]) { CN.toast("Select a step first", "err"); return; }
    if (steps[selected].status === "pending" || steps[selected].status === "running") {
      CN.toast("That step has not finished yet", "err"); return;
    }
    input.disabled = true;
    $("suggest-send").disabled = true;
    CN.log("suggesting on step " + (selected + 1) + ": " + text, "step");
    const res = await CN.suggest(selected, text);
    input.disabled = false;
    $("suggest-send").disabled = false;
    if (res && res.success) {
      input.value = "";
      steps[selected].result = { files: await loadFileDiffs(CN.getWorkspace(), res) };
      selectStep(selected);
      CN.log("suggestion applied: " + (res.appliedFiles || []).join(", "), "ok");
      CN.toast("Change applied");
    } else {
      CN.log("suggestion failed: " + ((res && res.error) || "unknown"), "err");
      CN.toast((res && res.error) || "Suggestion failed", "err");
    }
  };
  $("suggest-input").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); $("suggest-send").click(); }
  });

})();
