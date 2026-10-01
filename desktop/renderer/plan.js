/*
 * The Plan panel: the conversation, the plan document beside it, and the
 * actions that start from it - build, research and export.
 */

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
  refreshFlow();
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
  renderOnboarding();
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
