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

  /**
   * The step currently on the clock.
   *
   * A session runs one step at a time, so "which step is this phase about" has
   * exactly one answer - the same property that lets the review gate work. A
   * phase arriving with nothing running belongs to a chat or a plan, not to a
   * build, and is dropped.
   */
  let stepTimer = null;

  CN.notePhase = function (name) {
    if (!stepTimer || !window.CNTiming) return;
    window.CNTiming.markPhase(stepTimer, name === "idle" ? null : name);
  };

  function setStatusOf(i, st) {
    steps[i].status = st;
    renderList();
    if (i === selected) $("step-detail-status").textContent = st;
    saveBuildState();
  }

  /**
   * Write the build to the workspace so closing the app does not lose it.
   *
   * Hung off setStatusOf rather than settle() because it is the one place every
   * status change passes through - settle misses a skip and misses the blocked
   * steps a failure cascades into.
   *
   * Coalesced on a timer: marking a failure blocks its whole subtree, which is
   * one setStatusOf per blocked step, and that should be one write rather than
   * fourteen. Fire-and-forget, and a failure is deliberately silent - a build
   * must not stop because its bookkeeping could not be written. A read-only
   * workspace costs the resume, not the run.
   */
  let saveTimer = null;
  let buildStartedAt = null;
  function saveBuildState() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = null;
      const ws = CN.getWorkspace();
      if (!ws || !steps.length || !window.api.writeBuildState) return;
      window.api.writeBuildState({
        workspace: ws, plan: CN.getPlan(), steps: steps,
        provider: CN.getProvider(), startedAt: buildStartedAt,
      }).then(function (r) {
        if (r && r.ok && !buildStartedAt) buildStartedAt = r.startedAt;
      }, function () { /* see above: never fatal */ });
    }, 250);
  }

  /**
   * Bring back the build this workspace was in the middle of.
   *
   * Restores the plan and its statuses and stops there. Nothing runs: a restart
   * is as often a crash or a deliberate escape as a tidy shutdown, and resuming
   * into one automatically would repeat whatever went wrong, unattended. The
   * user presses Build, and seedState skips what is already done.
   */
  CN.restoreBuild = async function (workspace) {
    if (running || !workspace || !window.api.readBuildState) return null;
    let state = null;
    try { state = await window.api.readBuildState(workspace); } catch (e) { return null; }
    if (!state || !state.steps || !state.steps.length) return null;

    steps = state.steps.map(function (s) {
      return {
        title: s.title, detail: s.detail, files: s.files || [],
        dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.slice() : undefined,
        testable: s.testable === true,
        timing: s.timing,
        status: s.status || "pending", result: null,
      };
    });
    buildStartedAt = state.startedAt || null;
    selected = -1;
    renderList();
    $("builder-empty").style.display = "none";
    $("step-detail").classList.add("hidden");
    buttons("idle");

    const done = steps.filter(function (s) { return s.status === "done" || s.status === "skipped"; }).length;
    progress(done / steps.length);
    status(done ? "resumable: " + done + "/" + steps.length + " done" : "ready: " + steps.length + " steps");
    if (done) CN.log("found an unfinished build here: " + done + "/" + steps.length +
      " steps done - press Build to carry on", "step");

    // Handed back so the caller can restore currentPlan. Every step is told the
    // overall goal alongside its own detail; without the summary a resumed
    // build sends each remaining step off with no idea what it is building.
    return {
      summary: state.summary || "",
      runCommand: state.runCommand || undefined,
      steps: steps.map(function (s) {
        return { title: s.title, detail: s.detail, files: s.files, dependsOn: s.dependsOn, testable: s.testable };
      }),
    };
  };

  /**
   * Put the workspace back to just before this step.
   *
   * Everything after it goes too. Step 6 was written against a step 4 that is
   * about to stop existing, and leaving it done would describe a workspace no
   * plan matches - which the next step would then be written against.
   *
   * The plan is computed first and shown before anything is touched. A file the
   * user edited by hand since the build wrote it is named rather than quietly
   * overwritten, because the backup that would recover it is the one about to
   * be replaced.
   */
  /**
   * Undo a step without asking, for the Reject path.
   *
   * The button confirms because the user is undoing work they may have
   * forgotten writing. Reject does not, because the confirmation already
   * happened - pressing Reject IS the decision, and asking "are you sure?"
   * immediately after would be asking the same question twice.
   */
  async function rollbackQuietly(i) {
    const ws = CN.getWorkspace();
    if (!ws || !window.api.planRollback) return false;
    const res = await window.api.planRollback(ws, i);
    if (!res || !res.ok) { CN.log("could not undo step " + (i + 1) + ": " + ((res && res.error) || "unknown"), "err"); return false; }
    const applied = await window.api.applyRollback(ws, res.plan);
    if (!applied || !applied.ok) { CN.log("could not undo step " + (i + 1), "err"); return false; }
    CN.log("step " + (i + 1) + " undone: " + applied.restored.length + " restored, " +
      applied.removed.length + " removed", "step");
    return true;
  }

  /**
   * Wait for the user's verdict on a step that has just finished.
   *
   * A promise resolved by whichever button is pressed, so the build loop simply
   * awaits it. Stop resolves it too - a build that will not end because it is
   * waiting for a verdict nobody is going to give would be worse than one that
   * did not pause at all.
   */
  let pendingReview = null;
  function awaitReview(i) {
    selectStep(i);
    const bar = $("review-bar");
    if (bar) bar.style.display = "inline-block";
    const box = $("review-reason");
    if (box) box.value = "";
    status("step " + (i + 1) + " waiting for review");
    CN.log("step " + (i + 1) + " finished - review the changes, then Accept or Reject", "step");
    return new Promise(function (resolve) {
      pendingReview = function (verdict) {
        pendingReview = null;
        if (bar) bar.style.display = "none";
        resolve(verdict);
      };
    });
  }

  function settleReview(verdict) {
    if (pendingReview) pendingReview(verdict);
  }

  CN.rollbackTo = async function (i) {
    if (running) { CN.toast("Stop the build first", "err"); return; }
    const ws = CN.getWorkspace();
    if (!ws || !window.api.planRollback) return;

    const res = await window.api.planRollback(ws, i);
    if (!res || !res.ok) { CN.toast("Cannot roll back: " + ((res && res.error) || "unknown"), "err"); return; }
    const plan = res.plan;

    const undone = (plan.steps || []).length;
    if (!undone) { CN.toast("Nothing recorded for step " + (i + 1) + " onwards"); return; }

    let msg = "Roll back to before step " + (i + 1) + "?\n\n" +
      "This undoes " + undone + " step" + (undone === 1 ? "" : "s") + ": " +
      Object.keys(plan.restore || {}).length + " file(s) restored, " +
      (plan.remove || []).length + " removed.";
    if ((plan.drifted || []).length) {
      msg += "\n\nThese have changed since the build wrote them, and those " +
        "changes will be lost:\n  " + plan.drifted.join("\n  ");
    }
    if ((plan.unrestorable || []).length) {
      msg += "\n\nToo large to have been saved, so these will be left as they are:\n  " +
        plan.unrestorable.join("\n  ");
    }
    if (!confirm(msg)) return;

    const applied = await window.api.applyRollback(ws, plan);
    if (!applied || !applied.ok) { CN.toast("Rollback failed: " + ((applied && applied.error) || "unknown"), "err"); return; }

    for (let s = i; s < steps.length; s++) {
      steps[s].result = null;
      setStatusOf(s, "pending");
    }
    selected = -1;
    $("step-detail").classList.add("hidden");
    const done = steps.filter(function (s) { return s.status === "done" || s.status === "skipped"; }).length;
    progress(done / steps.length);
    buttons("idle");
    status("rolled back: " + done + "/" + steps.length + " done");
    CN.log("rolled back to before step " + (i + 1) + ": " +
      applied.restored.length + " restored, " + applied.removed.length + " removed", "ok");
    if ((applied.refused || []).length) {
      CN.log("refused to touch paths outside the workspace: " + applied.refused.join(", "), "err");
    }
    CN.toast("Rolled back to step " + (i + 1));
  };

  function selectStep(i) {
    selected = i;
    renderList();
    const s = steps[i];
    $("builder-empty").style.display = "none";
    $("step-detail").classList.remove("hidden");
    $("step-detail-label").textContent = "0" + (i + 1) + " " + (s.title || "");
    $("step-detail-status").textContent = s.status;

    // Offered only where there is something to undo. A pending step never wrote
    // anything, and a build in progress must not have the ground moved.
    const rb = $("step-rollback");
    if (rb) {
      const ranAlready = steps.slice(i).some(function (st) {
        return st.status === "done" || st.status === "failed";
      });
      rb.style.display = ranAlready && !running ? "inline-block" : "none";
      rb.onclick = function () { CN.rollbackTo(i); };
    }

    const body = $("step-files");
    body.innerHTML = "";

    if (s.timing && window.CNTiming) {
      const rows = window.CNTiming.phaseRows({ phases: s.timing.phases });
      const t = document.createElement("div");
      t.className = "file-card";
      t.innerHTML = '<div class="file-card-head"><span class="file-path">time</span>' +
        '<span class="file-mode">' + window.CNTiming.formatDuration(s.timing.totalMs) + '</span></div>' +
        '<div class="file-body open"><pre>' + CN.escapeHtml(
          rows.map(function (r) {
            return r.phase.padEnd(14) + window.CNTiming.formatDuration(r.ms);
          }).join("\n") || "(no phases recorded)") + '</pre></div>';
      body.appendChild(t);
    }

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
    // Set by Reject and carried into the next attempt, so the model is told
    // what was wrong rather than being asked to guess a second time.
    let rejection = "";

    while (true) {
    selectStep(i);
    stepTimer = window.CNTiming ? window.CNTiming.newTimer(Date.now()) : null;
    setStatusOf(i, "running");
    status("building " + (i + 1) + "/" + steps.length);
    CN.log("step " + (i + 1) + "/" + steps.length + ": " + (s.title || ""), "step");
    CN.toast("Step " + (i + 1) + ": " + (s.title || ""));

    const stepDetail = "Overall: " + ((plan && plan.summary) || "") +
      "\n\nExecute ONLY this step: " + (s.title || "") + ". " + (s.detail || "") +
      (s.files && s.files.length ? " Expected files: " + s.files.join(", ") : "") +
      (rejection ? "\n\nA previous attempt at this step was rejected. What was wrong: " +
        rejection + "\nAddress that specifically." : "");
    const args = ["browser", stepDetail, ws, CN.getProvider(), CN.getAutonomy(), String(i), stepDetail, (plan && plan.summary) || ""];
    const res = sessionActive()
      ? await CN.sendStep(i, stepDetail, (plan && plan.summary) || "", !!s.testable)
      : await CN.runAgent(args);

    if (stepTimer && window.CNTiming) {
      window.CNTiming.finish(stepTimer, Date.now());
      s.timing = window.CNTiming.toRecord(stepTimer);
      stepTimer = null;
    }

    if (res && res.success) {
      const filesArr = await loadFileDiffs(ws, res);
      s.result = { files: filesArr };
      setStatusOf(i, "done");
      if (s.timing) {
        CN.log("step " + (i + 1) + " took " + window.CNTiming.formatDuration(s.timing.totalMs) +
          " (" + window.CNTiming.phaseRows({ phases: s.timing.phases })
            .slice(0, 3)
            .map(function (r) { return r.phase + " " + window.CNTiming.formatDuration(r.ms); })
            .join(", ") + ")", "step");
      }
      CN.log("step " + (i + 1) + " done: " + (res.appliedFiles || []).join(", "), "ok");
      CN.toast("Step " + (i + 1) + " complete");

      // Nothing to review on a step that changed no files, and a stopping build
      // must not stop to ask a question.
      if (!reviewOn() || !filesArr.length || stopRequested) return true;

      const verdict = await awaitReview(i);
      if (!verdict || verdict.accept) return true;

      // Rejected: put the workspace back before trying again, or the next
      // attempt edits files the last one wrote and the diff stops describing
      // one step's work.
      await rollbackQuietly(i);
      rejection = verdict.reason || "";
      CN.log("step " + (i + 1) + " rejected" + (rejection ? ": " + rejection : "") + " - running it again", "step");
      continue;
    } else {
      s.result = { error: (res && res.error) || "unknown" };
      setStatusOf(i, "failed");
      CN.log("step " + (i + 1) + " failed: " + ((res && res.error) || "unknown"), "err");
      CN.toast("Step " + (i + 1) + " failed", "err");
      selectStep(i);
      return false;
    }
    }
  }

  CN.setPlan = function (plan) {
    if (!plan || !plan.steps) return;
    // dependsOn is carried across deliberately. Dropping it - which this line
    // did - made every plan look like an undeclared one, so the scheduler built
    // a chain and a single failure blocked every step behind it regardless of
    // what the plan said.
    steps = plan.steps.map(function (s) {
      return {
        title: s.title, detail: s.detail, files: s.files || [],
        dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.slice() : undefined,
        testable: s.testable === true,
        status: "pending", result: null,
      };
    });
    selected = -1;
    renderList();
    $("builder-empty").style.display = steps.length ? "none" : "block";
    $("step-detail").classList.add("hidden");
    buttons("idle");
    progress(0);
    status("ready: " + steps.length + " steps");
    // A new plan starts a new build, so the old one's timestamp goes with it -
    // and so do the previous build's checkpoints, which are addressed by step
    // number and would otherwise let "roll back to step 4" restore a file from
    // a build that has nothing to do with this one.
    buildStartedAt = null;
    const ws = CN.getWorkspace();
    if (ws && window.api.clearCheckpoints) window.api.clearCheckpoints(ws).catch(function () {});
    saveBuildState();
  };

  CN.startBuild = async function () {
    if (running) { CN.toast("Already running", "err"); return; }
    if (!steps.length) { CN.toast("No plan - generate one first", "err"); return; }
    if (!CN.getWorkspace()) { CN.toast("Pick a workspace", "err"); return; }
    running = true; stopRequested = false; paused = false;
    buttons("running");

    // A build with steps already done is being picked up, not started. The
    // session needs to know: it decides whether to clear the record of what the
    // conversation has been shown.
    const resuming = steps.some(function (s) { return s.status === "done"; });
    const started = await CN.startSession(CN.getWorkspace(), CN.getProvider(), CN.getAutonomy(), resuming);
    sessionOn = !!(started && started.ok);
    if (!sessionOn) CN.log("session unavailable, falling back to a browser per step: " + ((started && started.error) || "unknown"), "step");
    else CN.log("build session ready - one browser for the whole build", "step");

    // The graph, declared or implied. A plan where nothing is declared is a
    // chain, which reproduces the old serial loop exactly.
    const built = window.CNSched.graphFor(steps);
    const graph = built.graph;
    if (built.reason) {
      CN.log("plan dependencies unusable (" + built.reason + ") - running the steps in order", "err");
    } else if (built.declared) {
      const independent = graph.filter(function (d, i) { return i > 0 && d.length === 0; }).length;
      CN.log("plan declares its own dependencies" +
        (independent ? "; " + independent + " step(s) do not wait on anything" : ""), "step");
    }
    // A conversation has one composer, so a session runs one step at a time no
    // matter what the graph permits. This mattered the moment dependsOn started
    // being honoured: before, a chain made exactly one step runnable and the
    // limit never had to hold anything back.
    const limit = sessionOn ? 1 : CN.getConcurrency();
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
    //
    // This drains on stop too, which it did not before: ending the session
    // pulls the browser out from under a step that is still waiting, and the
    // step then fails with "Target page, context or browser has been closed" -
    // an internal error where the honest answer is "you stopped it". Bounded,
    // because a step waiting out a five-minute completion should not hold the
    // interface hostage after the user has asked it to stop.
    const drainUntil = Date.now() + (stopRequested ? 20000 : 10 * 60 * 1000);
    if (stopRequested && state.running.length) {
      CN.log("stopping: letting " + state.running.length + " running step(s) unwind", "step");
    }
    while (state.running.length && Date.now() < drainUntil) await sleep(250);
    if (state.running.length) {
      CN.log("step(s) still in flight when the session closed; they are reported as failed", "err");
    }

    if (sessionOn) { await CN.endSession(); sessionOn = false; }

    running = false;
    buttons("idle");
    const rb = $("review-bar");
    if (rb) rb.style.display = "none";
    const finished = steps.filter(function (s) { return s.status === "done" || s.status === "skipped"; }).length;
    if (window.CNTiming) {
      const roll = window.CNTiming.summarise(steps.map(function (st) {
        return st.timing ? { totalMs: st.timing.totalMs, phases: st.timing.phases } : null;
      }));
      if (roll.steps) {
        CN.log("build time " + window.CNTiming.formatDuration(roll.totalMs) +
          " across " + roll.steps + " step(s)", "step");
        roll.phases.forEach(function (r) {
          CN.log("  " + r.phase + " " + window.CNTiming.formatDuration(r.ms) + " (" + r.percent + "%)", "step");
        });
      }
    }
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

  /**
   * Is step review switched on?
   *
   * Read at the moment a step finishes rather than captured when the build
   * started, so turning it on mid-build takes effect at the next step - which
   * is what someone reaching for it after a bad step wants.
   */
  function reviewOn() {
    const cb = $("review-steps");
    return !!(cb && cb.checked);
  }

  (function initReview() {
    const cb = $("review-steps");
    if (!cb) return;
    try { cb.checked = localStorage.getItem("closeni.review-steps") === "on"; } catch (e) {}
    cb.onchange = function () {
      try { localStorage.setItem("closeni.review-steps", cb.checked ? "on" : "off"); } catch (e) {}
    };
  })();

  $("review-accept").onclick = function () { settleReview({ accept: true }); };
  $("review-reject").onclick = function () {
    const box = $("review-reason");
    const reason = box ? String(box.value || "").trim() : "";
    // Required, not optional. A rejection with no reason gives the next attempt
    // nothing to go on, and it will most likely produce the same thing again -
    // costing a step and teaching the user that Reject does not work.
    if (!reason) {
      CN.toast("Say what was wrong first - the model is told your reason", "err");
      if (box) box.focus();
      return;
    }
    if (box) box.value = "";
    settleReview({ accept: false, reason: reason });
  };

  $("review-reason").onkeydown = function (e) {
    if (e.key === "Enter") { e.preventDefault(); $("review-reject").click(); }
  };

  $("builder-start").onclick = function () { CN.startBuild(); };
  $("builder-pause").onclick = function () { paused = true; buttons("paused"); status("paused"); CN.toast("Paused"); };
  $("builder-resume").onclick = function () { paused = false; buttons("running"); status("resumed"); CN.toast("Resumed"); };
  $("builder-skip").onclick = function () { skipNext = true; CN.toast("Will skip next step"); };
  $("builder-stop").onclick = function () {
    stopRequested = true;
    paused = false;
    // A step waiting for Accept or Reject would wait forever otherwise, and
    // Stop would be the one button that does not stop anything. Accepting is
    // the safe reading: the work is already on disk, and undoing it silently
    // because someone pressed Stop would destroy a step they never rejected.
    settleReview({ accept: true });
    status("stopping...");
    CN.toast("Stopping", "err");
  };
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
