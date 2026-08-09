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
    const res = sessionActive()
      ? await CN.sendStep(i, stepDetail, (plan && plan.summary) || "")
      : await CN.runAgent(args);

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

    const started = await CN.startSession(CN.getWorkspace(), CN.getProvider(), "ask");
    sessionOn = !!(started && started.ok);
    if (!sessionOn) CN.log("session unavailable, falling back to a browser per step: " + ((started && started.error) || "unknown"), "step");
    else CN.log("build session ready - one browser for the whole build", "step");

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

    if (sessionOn) { await CN.endSession(); sessionOn = false; }

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
