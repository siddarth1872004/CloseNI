/*
 * The Code panel: a coding agent in the style of a terminal one.
 *
 * Loaded after renderer.js (it uses window.CN, renderMarkdown, CNDiff and
 * CNCode). The agent lives in a long-lived process started on the first
 * message; this file only draws what it reports and sends what the user
 * types. Everything it shows comes from an event - nothing here guesses at
 * what the agent did.
 */
(function () {
  const CN = window.CN;
  const V = window.CNCode;
  function $(id) { return document.getElementById(id); }
  if (!V || !$("panel-code")) return;

  const S = {
    up: false, starting: null, busy: false, mode: "default", provider: "",
    history: [], hIndex: -1, queue: [], tools: {}, permission: null,
    spinnerTimer: null, turnStart: 0, step: 0, verbSeed: 0, files: null, popup: null,
    lastWasPlan: false,
    // Mode actions: a test or research run in flight, the build's todo list
    // for its progress bar, and which sources research searches.
    running: false, todos: [], research: { web: true, gh: true }, modebarSeq: 0,
  };

  const transcript = $("code-transcript");
  const input = $("code-input");
  const scroller = $("code-scroll");

  function esc(s) { return CN.escapeHtml(String(s == null ? "" : s)); }
  function stick() { scroller.scrollTop = scroller.scrollHeight; }
  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function add(node) { transcript.appendChild(node); stick(); return node; }

  function note(text, tone) {
    return add(el("div", "cc-note" + (tone ? " " + tone : ""), '<span class="cc-elbow">⎿</span><span class="cc-note-text">' + esc(text) + "</span>"));
  }

  // ------------------------------------------------------------ header bits

  function refreshWelcome() {
    const ws = CN.getWorkspace();
    $("code-cwd").textContent = ws || "no folder selected";
    const need = $("code-need");
    need.innerHTML = "";
    if (!ws) {
      const b = el("button", "btn btn-sm", "Choose a project folder");
      b.onclick = function () { const x = $("browse-btn"); if (x) x.click(); };
      need.appendChild(el("span", "hint", "The agent works inside one folder. "));
      need.appendChild(b);
    }
  }

  function showMode() {
    const m = V.modeLabel(S.mode);
    const node = $("code-mode");
    node.textContent = m.text;
    node.className = "code-mode " + m.cls;
    $("code-box").dataset.mode = S.mode;
    renderModebar();
  }

  function showMeta() {
    const bits = [];
    if (S.provider) bits.push(S.provider);
    const ws = CN.getWorkspace();
    if (ws) bits.push(ws.split(/[\\/]/).filter(Boolean).pop());
    $("code-meta").textContent = bits.join(" · ");
  }

  // ------------------------------------------------------------------ spinner

  function spinnerOn(verb) {
    const sp = $("code-spinner");
    sp.classList.remove("hidden");
    if (verb) sp.querySelector(".cs-verb").textContent = verb + "…";
    if (S.spinnerTimer) return;
    let g = 0;
    S.spinnerTimer = setInterval(function () {
      g = (g + 1) % V.GLYPHS.length;
      sp.querySelector(".cs-glyph").textContent = V.GLYPHS[g];
      sp.querySelector(".cs-meta").textContent = "(" + V.elapsed(Date.now() - S.turnStart) + " · esc to interrupt)";
    }, 140);
  }
  function spinnerOff() {
    $("code-spinner").classList.add("hidden");
    if (S.spinnerTimer) { clearInterval(S.spinnerTimer); S.spinnerTimer = null; }
  }

  // ----------------------------------------------------------------- tools

  function diffHtml(before, after) {
    if (!window.CNDiff) return "";
    const rows = window.CNDiff.diffLines(before || "", after || "");
    let a = 1, b = 1;
    return rows.map(function (r) {
      if (r.type === "gap") {
        const n = parseInt((r.text.match(/(\d+)/) || [0, 0])[1], 10) || 0;
        a += n; b += n;
        return '<div class="cc-diff-row gap"><span class="ln"></span><span class="tx">' + esc(r.text) + "</span></div>";
      }
      let ln;
      if (r.type === "add") { ln = b++; }
      else if (r.type === "remove") { ln = a++; }
      else { ln = b; a++; b++; }
      const sign = r.type === "add" ? "+" : r.type === "remove" ? "-" : " ";
      return '<div class="cc-diff-row ' + r.type + '"><span class="ln">' + ln + '</span><span class="tx">' + sign + " " + esc(r.text) + "</span></div>";
    }).join("");
  }

  function toolNode(ev) {
    let node = S.tools[ev.id];
    if (!node) {
      node = el("div", "cc-tool");
      node.innerHTML =
        '<div class="cc-tool-head"><span class="cc-dot">⏺</span><span class="cc-tool-title"></span></div>' +
        '<div class="cc-tool-res"><span class="cc-elbow">⎿</span><pre class="cc-sum"></pre></div>' +
        '<div class="cc-tool-more hidden"></div>';
      node.querySelector(".cc-tool-head").onclick = function () { node.querySelector(".cc-tool-more").classList.toggle("hidden"); };
      node.querySelector(".cc-tool-res").onclick = function () { node.querySelector(".cc-tool-more").classList.toggle("hidden"); };
      S.tools[ev.id] = node;
      add(node);
    }
    return node;
  }

  function onTool(ev) {
    const node = toolNode(ev);
    const t = V.toolTitle(ev);
    node.className = "cc-tool " + V.toolTone(ev.status) + " tool-" + (ev.name || "invalid");
    node.querySelector(".cc-tool-title").innerHTML = "<b>" + esc(t.verb) + "</b>" + (t.arg ? "(" + esc(t.arg) + ")" : "");
    node.querySelector(".cc-sum").textContent = V.toolSummary(ev);
    const more = node.querySelector(".cc-tool-more");
    const d = ev.detail || {};
    if ((ev.name === "edit" || ev.name === "write") && ev.status === "done" && d.after !== undefined) {
      more.innerHTML = '<div class="cc-diff">' + diffHtml(d.before, d.after) + "</div>";
      // An edit's diff is the point of the line: shown, as a terminal agent does.
      more.classList.remove("hidden");
    } else if (ev.name === "bash" && ev.output) {
      more.innerHTML = '<pre class="cc-out">' + esc(ev.output) + "</pre>";
    } else if (ev.name === "todo" && d.items) {
      more.innerHTML = todoHtml(d.items);
      more.classList.remove("hidden");
    } else if (ev.output && ev.status === "done") {
      more.innerHTML = '<pre class="cc-out">' + esc(ev.output) + "</pre>";
    }
    stick();
  }

  function todoHtml(items) {
    return '<div class="cc-todos">' + items.map(function (it) {
      const box = it.status === "done" ? "☒" : it.status === "in_progress" ? "◼" : "☐";
      return '<div class="cc-todo ' + it.status + '"><span class="box">' + box + "</span>" + esc(it.text) + "</div>";
    }).join("") + "</div>";
  }

  function onTodos(items) {
    S.todos = items || [];
    if (S.mode === "build") renderModebar();
    const box = $("code-todos");
    if (!items || !items.length || items.every(function (i) { return i.status === "done"; })) { box.classList.add("hidden"); box.innerHTML = ""; return; }
    box.innerHTML = todoHtml(items);
    box.classList.remove("hidden");
  }

  // ------------------------------------------------------------ permissions

  function onPermission(req) {
    const node = S.tools[req.id] || toolNode({ id: req.id });
    const opts = V.permissionOptions(req);
    const box = el("div", "cc-perm");
    const pv = req.preview || {};
    let body = "";
    if (req.tool === "bash") body = '<pre class="cc-perm-cmd">' + esc(pv.command || req.input.command) + "</pre>";
    else if (pv.after !== undefined) body = '<div class="cc-perm-path">' + esc(pv.path || "") + '</div><div class="cc-diff">' + diffHtml(pv.before, pv.after) + "</div>";
    box.innerHTML =
      '<div class="cc-perm-q">' + esc(V.permissionQuestion(req)) + "</div>" + body +
      '<div class="cc-perm-ask">Do you want to proceed?</div>' +
      '<div class="cc-perm-opts">' + opts.map(function (o, i) {
        return '<button class="cc-perm-opt' + (i === 0 ? " sel" : "") + '" data-key="' + o.key + '"><span class="n">' + (i + 1) + ".</span> " + esc(o.label) + "</button>";
      }).join("") + "</div>" +
      '<div class="cc-perm-feedback hidden"><input placeholder="Tell CloseNI what to do instead (enter to send, esc to skip)"></div>';
    node.appendChild(box);
    S.permission = { req: req, box: box, opts: opts, sel: 0 };
    box.querySelectorAll(".cc-perm-opt").forEach(function (b, i) {
      b.onclick = function () { choosePermission(i); };
    });
    stick();
    box.querySelector(".cc-perm-opt").focus();
  }

  function selectPermission(i) {
    const P = S.permission; if (!P) return;
    P.sel = (i + P.opts.length) % P.opts.length;
    P.box.querySelectorAll(".cc-perm-opt").forEach(function (b, k) { b.classList.toggle("sel", k === P.sel); });
    P.box.querySelectorAll(".cc-perm-opt")[P.sel].focus();
  }

  function answerPermission(decision, feedback) {
    const P = S.permission; if (!P) return;
    S.permission = null;
    window.api.codePermission(P.req.id, decision, feedback || "");
    const label = decision === "deny" ? "No" + (feedback ? ": " + feedback : "") : decision === "always" ? "Yes, don't ask again" : "Yes";
    P.box.innerHTML = '<div class="cc-perm-done">' + esc(label) + "</div>";
    P.box.classList.add("answered");
    input.focus();
  }

  function choosePermission(i) {
    const P = S.permission; if (!P) return;
    const opt = P.opts[i];
    if (opt.key !== "deny") { answerPermission(opt.key); return; }
    // "No" takes an optional note, the way a person would say what they want instead.
    const fb = P.box.querySelector(".cc-perm-feedback");
    fb.classList.remove("hidden");
    const f = fb.querySelector("input");
    f.focus();
    f.onkeydown = function (e) {
      if (e.key === "Enter") { e.preventDefault(); answerPermission("deny", f.value.trim()); }
      else if (e.key === "Escape") { e.preventDefault(); answerPermission("deny", ""); }
    };
  }

  // ----------------------------------------------------------- plan approval

  function offerPlan() {
    const box = add(el("div", "cc-perm cc-plan-offer"));
    const opts = [
      { label: "Yes, in build mode: steps, edits and checks", mode: "build" },
      { label: "Yes, and auto-accept edits", mode: "acceptEdits" },
      { label: "Yes, and manually approve edits", mode: "default" },
      { label: "No, keep planning", mode: null },
    ];
    box.innerHTML = '<div class="cc-perm-q">Ready to code?</div><div class="cc-perm-ask">Would you like to proceed with this plan?</div>' +
      '<div class="cc-perm-opts">' + opts.map(function (o, i) {
        return '<button class="cc-perm-opt' + (i === 0 ? " sel" : "") + '"><span class="n">' + (i + 1) + ".</span> " + esc(o.label) + "</button>";
      }).join("") + "</div>";
    box.querySelectorAll(".cc-perm-opt").forEach(function (b, i) {
      b.onclick = function () {
        box.innerHTML = '<div class="cc-perm-done">' + esc(opts[i].label) + "</div>";
        box.classList.add("answered");
        if (!opts[i].mode) { input.focus(); return; }
        setMode(opts[i].mode);
        send("Go ahead and implement the plan.");
      };
    });
  }

  // ------------------------------------------------------------------- modes
  //
  // One window, one transcript. Each mode puts a strip above the prompt that
  // says what it is for and carries the actions its old tab had; what those
  // actions find comes back into the transcript as a card, so the conversation
  // stays the one record of what happened.

  function langMark(language) {
    if (!language) return "";
    const L = window.CNLang;
    const token = L && L.languageToken ? L.languageToken(language) : "--lang-default";
    return '<span class="lang-mark" style="color:var(' + token + ')">' + esc(language) + "</span>";
  }

  function card(kind, title, summary) {
    const c = add(el("div", "cc-card " + kind,
      '<div class="cc-card-head"><span class="cc-card-kind">' + esc(title) + '</span><span class="cc-card-sum">' + esc(summary || "") + "</span></div>" +
      '<div class="cc-card-body"></div>'));
    return { node: c, sum: c.querySelector(".cc-card-sum"), body: c.querySelector(".cc-card-body") };
  }

  function mbtn(label, onclick, title, cls) {
    const b = el("button", "btn btn-sm" + (cls ? " " + cls : ""));
    b.textContent = label;
    if (title) b.title = title;
    b.onclick = function () { onclick(); input.focus(); };
    return b;
  }

  // The one-shot runs borrow the browser profile, and the agent's session
  // yields it to them - which would cut a turn off mid-reply.
  function freeForRun() {
    if (S.busy || S.starting || S.running) { note("Wait for the current turn to finish, or press esc.", "err"); return false; }
    if (!CN.getWorkspace()) { note("Choose a project folder first - every mode works inside one.", "err"); refreshWelcome(); return false; }
    return true;
  }

  function runStart(verb, status) {
    S.running = true;
    S.turnStart = Date.now();
    spinnerOn(verb);
    if (CN.setStatus) CN.setStatus(status);
    renderModebar();
  }
  function runEnd() {
    S.running = false;
    spinnerOff();
    if (CN.setStatus) CN.setStatus("idle");
    renderModebar();
    if (S.queue.length && !S.busy) { const next = S.queue.shift(); setTimeout(function () { send(next.text, next.shownAs); }, 50); }
  }

  function outputBlock(parent, text, open) {
    if (!text) return;
    const wrap = el("div", "cc-card-out" + (open ? "" : " folded"));
    const head = el("div", "cc-card-toggle", open ? "hide output" : "show output");
    const pre = el("pre", "cc-out");
    pre.textContent = String(text).slice(-20000);
    head.onclick = function () {
      wrap.classList.toggle("folded");
      head.textContent = wrap.classList.contains("folded") ? "show output" : "hide output";
    };
    wrap.appendChild(head); wrap.appendChild(pre);
    parent.appendChild(wrap);
  }

  function testRows(parent, rows) {
    (rows || []).forEach(function (r) {
      const skipped = /^(skipped|not run)\b/i.test(r.detail || "") && !r.success;
      const row = el("div", "cc-test-row " + (r.success ? "pass" : skipped ? "skip" : "fail"));
      row.innerHTML = '<span class="cc-verdict">' + (r.success ? "✓" : skipped ? "–" : "✗") + "</span>" +
        langMark(r.language) + '<span class="cc-test-cmd">' + esc(r.command || "") + "</span>" +
        (r.detail ? '<span class="cc-test-detail">' + esc(String(r.detail).split("\n")[0].slice(0, 160)) + "</span>" : "");
      parent.appendChild(row);
      if (r.detail && String(r.detail).indexOf("\n") !== -1) outputBlock(parent, r.detail, false);
    });
  }

  /** Tests ("behaviour") or syntax checks ("testall"), as a card. */
  function runChecks(kind) {
    if (!freeForRun()) return;
    const ws = CN.getWorkspace();
    const syntax = kind === "testall";
    const c = card("test", syntax ? "Syntax check" : "Tests", "running…");
    runStart(syntax ? "Checking every file" : "Running the tests", syntax ? "testing" : "running tests");
    const args = syntax ? ["testall", "x", ws, CN.getProvider()] : ["behaviour", ws, ws, CN.getProvider()];
    CN.runAgent(args).then(function (res) {
      if (!res) { c.sum.textContent = "could not run"; c.node.classList.add("fail"); return; }
      const passed = res.passed || 0, failed = res.failed || 0, skipped = res.skipped || 0;
      let sum = passed + " passed, " + failed + " failed";
      if (skipped) sum += ", " + skipped + " not run";
      if (!passed && !failed && !skipped) sum = res.note || res.error || "nothing to run";
      c.sum.textContent = sum;
      c.node.classList.add(failed ? "fail" : passed ? "pass" : "none");
      testRows(c.body, res.results);
      if (res.note && (passed || failed || skipped)) c.body.appendChild(el("div", "cc-card-hint", esc(res.note)));
      if (failed) {
        const fix = mbtn("Ask the agent to fix it", function () {
          const failing = (res.results || []).filter(function (r) { return !r.success; })
            .map(function (r) { return "- " + r.command + (r.detail ? ": " + String(r.detail).slice(0, 600) : ""); }).join("\n");
          send(V.modePrompt("test", "These checks failed. Find out why and fix the code:\n" + failing), "fix the failing checks");
        });
        c.body.appendChild(el("div", "cc-card-actions")).appendChild(fix);
      }
      if (CN.markTested) CN.markTested();
    }, function (e) { c.sum.textContent = String(e); c.node.classList.add("fail"); }).then(runEnd);
  }

  /** The project's own run command, run once, output in the card. */
  function runCommand() {
    if (!freeForRun()) return;
    const ws = CN.getWorkspace();
    (CN.resolveRunCommand ? CN.resolveRunCommand() : Promise.resolve({ command: "" })).then(function (rc) {
      if (!rc || !rc.command) { note("No run command found - the Runner panel (/runner) can set one", "warn"); return; }
      const c = card("test", "Run", rc.command);
      runStart("Running " + rc.command, "running");
      window.api.runCommand({ command: rc.command, cwd: ws }).then(function (r) {
        const ok = !!(r && r.success);
        c.node.classList.add(ok ? "pass" : "fail");
        c.body.appendChild(el("div", "cc-test-row " + (ok ? "pass" : "fail"),
          '<span class="cc-verdict">' + (ok ? "✓" : "✗") + '</span><span class="cc-test-cmd">' + esc(ok ? "exited cleanly" : "failed") + "</span>"));
        outputBlock(c.body, r && r.output, !ok);
        if (CN.markTested) CN.markTested();
      }, function (e) { c.sum.textContent = String(e); c.node.classList.add("fail"); }).then(runEnd);
    });
  }

  /** Web answer and GitHub repositories for `q`, as one card. */
  function research(q) {
    const want = S.research;
    if (!want.web && !want.gh) { note("Turn on Web or GitHub in the research bar first", "err"); return; }
    if (!freeForRun()) return;
    const ws = CN.getWorkspace();
    const c = card("research", "Research", q);
    const webBox = want.web ? c.body.appendChild(el("div", "cc-res-web", '<div class="cc-card-hint">searching the web…</div>')) : null;
    const ghBox = want.gh ? c.body.appendChild(el("div", "cc-res-gh", '<div class="cc-card-hint">searching GitHub…</div>')) : null;
    runStart("Researching", "researching");
    // Together, not in series: GitHub answers in milliseconds, the provider in seconds.
    const web = want.web ? CN.runAgent(["research", q, ws, CN.getProvider()]) : Promise.resolve(null);
    const gh = want.gh ? window.api.ghCall("searchRepos", [q, 8]).catch(function (e) { return { ok: false, error: String(e) }; }) : Promise.resolve(null);

    gh.then(function (r) {
      if (!ghBox) return;
      ghBox.innerHTML = '<div class="cc-res-title">GitHub</div>';
      if (!r || !r.ok) { ghBox.appendChild(el("div", "cc-card-hint", esc((r && r.error) || "GitHub search unavailable - sign in with /github"))); return; }
      if (!(r.result || []).length) { ghBox.appendChild(el("div", "cc-card-hint", "no repositories matched")); return; }
      r.result.forEach(function (repo) {
        const row = el("div", "cc-repo",
          '<a href="' + esc(repo.url) + '" target="_blank">' + esc(repo.fullName) + "</a>" +
          '<span class="cc-repo-meta">★ ' + (repo.stars || 0) + (repo.language ? " · " : "") + "</span>" + langMark(repo.language) +
          (repo.description ? '<div class="cc-repo-desc">' + esc(repo.description) + "</div>" : ""));
        const acts = row.appendChild(el("div", "cc-card-actions"));
        acts.appendChild(mbtn("Use as reference", function () { CN.useAsReference({ url: repo.url }); }, "Pull its README and file list into the next plan"));
        acts.appendChild(mbtn("Clone", function () { CN.cloneRepo({ url: repo.url, title: repo.fullName }); }));
        ghBox.appendChild(row);
      });
      stick();
    });

    web.then(function (res) {
      if (!webBox) return;
      webBox.innerHTML = "";
      if (!res || !res.success) { webBox.appendChild(el("div", "cc-card-hint", esc((res && res.error) || "the web search failed"))); return; }
      const answer = webBox.appendChild(el("div", "cc-res-answer md"));
      answer.innerHTML = typeof renderMarkdown === "function" ? renderMarkdown(res.answer || "") : esc(res.answer || "");
      const sources = res.sources || [];
      if (sources.length) {
        const list = webBox.appendChild(el("div", "cc-res-sources", '<div class="cc-res-title">Sources' + (res.via ? " · via " + esc(res.via) : "") + "</div>"));
        sources.forEach(function (u, i) {
          list.appendChild(el("div", "cc-source", '<span class="n">[' + (i + 1) + ']</span> <a href="' + esc(u) + '" target="_blank">' + esc(u) + "</a>"));
        });
      } else webBox.appendChild(el("div", "cc-card-hint", "The provider cited no sources for this answer."));
      const acts = webBox.appendChild(el("div", "cc-card-actions"));
      acts.appendChild(mbtn("Plan with this", function () {
        setMode("plan");
        send("Using this research, plan how to apply it to this project:\n\n" + (res.answer || "").slice(0, 6000), "plan with this research");
      }, "Switch to plan mode and hand the answer to the agent"));
      stick();
    });

    Promise.all([web, gh]).then(runEnd, runEnd);
  }

  function diffPre(text) {
    const pre = el("pre", "cc-out cc-gitdiff");
    pre.innerHTML = String(text).slice(0, 40000).split("\n").map(function (l) {
      const cls = /^\+(?!\+\+)/.test(l) ? "add" : /^-(?!--)/.test(l) ? "del" : /^@@/.test(l) ? "hunk" : /^(diff|index|\+\+\+|---) /.test(l) ? "meta" : "";
      return cls ? '<span class="' + cls + '">' + esc(l) + "</span>" : esc(l);
    }).join("\n");
    return pre;
  }

  /** One git command, its output in a card. */
  function gitCard(title, args) {
    if (!CN.getWorkspace()) { note("Choose a project folder first", "err"); return; }
    const c = card("git", title, "git " + args.join(" "));
    CN.git(args).then(function (r) {
      const out = (r && r.output) || "";
      if (!r || !r.success) c.node.classList.add("fail");
      if (!out.trim()) { c.body.appendChild(el("div", "cc-card-hint", r && r.success ? "nothing to show" : "git failed")); return; }
      c.body.appendChild(args[0] === "diff" || args[0] === "show" ? diffPre(out) : el("pre", "cc-out", esc(out.slice(0, 20000))));
      stick();
    }).then(function () { renderModebar(); });
  }

  // What the strip above the prompt says and offers, per mode.
  const MODEBAR = {
    plan: {
      glyph: "⏸", name: "Plan",
      info: "Read-only. The agent looks around and answers with a plan; approve it to start building.",
      actions: function () { return [mbtn("Step-by-step builder", function () { CN.switchTab("chat"); }, "The planned, step-at-a-time build (/steps)")]; },
    },
    build: {
      glyph: "⚒", name: "Build",
      info: function () {
        const t = S.todos || [];
        if (!t.length) return "Say what to build. It plans steps, edits without asking and runs each step with the project's toolchain.";
        const done = t.filter(function (i) { return i.status === "done"; }).length;
        const now = t.find(function (i) { return i.status === "in_progress"; });
        return done + "/" + t.length + " steps done" + (now ? " · now: " + now.text : "");
      },
      progress: function () { const t = S.todos || []; return t.length ? t.filter(function (i) { return i.status === "done"; }).length / t.length : null; },
      actions: function () { return [mbtn("Step-by-step builder", function () { CN.switchTab("chat"); }, "The planned, step-at-a-time build (/steps)")]; },
    },
    test: {
      glyph: "✓", name: "Test",
      info: "Finding how this project runs…",
      load: function () {
        return CN.resolveRunCommand ? CN.resolveRunCommand().then(function (rc) {
          return rc && rc.command ? "run: " + rc.command + (rc.source ? "  (" + rc.source + ")" : "") : "No run command yet. Type what to test, or run the suite.";
        }) : null;
      },
      actions: function () {
        return [
          mbtn("Run tests ⏎", function () { runChecks("behaviour"); }, "The project's own test suite, then a smoke run (enter on an empty line)", "primary"),
          mbtn("Syntax-check", function () { runChecks("testall"); }, "Compile or parse every source file"),
          mbtn("Run", runCommand, "Run the project's run command once"),
          mbtn("Runner…", function () { CN.switchTab("test"); }, "The full runner panel (/runner)"),
        ];
      },
    },
    research: {
      glyph: "⌕", name: "Research",
      info: "Enter searches. Nothing in the project changes.",
      actions: function () {
        return [["web", "Web"], ["gh", "GitHub"]].map(function (k) {
          const b = mbtn((S.research[k[0]] ? "● " : "○ ") + k[1], function () { S.research[k[0]] = !S.research[k[0]]; renderModebar(); },
            "Search " + k[1] + " too", S.research[k[0]] ? "on" : "off");
          return b;
        });
      },
    },
    ship: {
      glyph: "⇡", name: "Ship",
      info: "Reading git…",
      load: function () {
        if (!CN.getWorkspace()) return null;
        return CN.git(["status", "--short", "--branch"]).then(function (r) {
          if (!r || !r.success) return "Not a git repository yet - ask the agent to set one up, or use /github.";
          const lines = String(r.output || "").split("\n").filter(Boolean);
          const head = (lines[0] || "").replace(/^##\s*/, "");
          const branch = head.split("...")[0] || "detached";
          const ahead = (head.match(/ahead (\d+)/) || [])[1], behind = (head.match(/behind (\d+)/) || [])[1];
          const changed = lines.length - 1;
          return "on " + branch + (ahead ? " ↑" + ahead : "") + (behind ? " ↓" + behind : "") + " · " +
            (changed ? changed + " changed file" + (changed === 1 ? "" : "s") : "clean") + ". Enter on an empty line reviews, tests and commits.";
        });
      },
      actions: function () {
        return [
          mbtn("Commit ⏎", function () { send(""); }, "Review, run the tests, then commit (enter on an empty line)", "primary"),
          mbtn("Status", function () { gitCard("Status", ["status", "--short", "--branch"]); }),
          mbtn("Diff", function () { gitCard("Diff", ["diff", "HEAD"]); }),
          mbtn("Log", function () { gitCard("Log", ["log", "--oneline", "-n", "15"]); }),
          mbtn("GitHub…", function () { CN.switchTab("push"); }, "Sign in, export a branch, open a pull request (/github)"),
        ];
      },
    },
  };

  function renderModebar() {
    const bar = $("code-modebar");
    if (!bar) return;
    const spec = MODEBAR[S.mode];
    bar.className = "code-modebar" + (spec ? " " + S.mode : " hidden");
    bar.innerHTML = "";
    if (!spec) return;
    const seq = S.modebarSeq = (S.modebarSeq || 0) + 1;
    const info = typeof spec.info === "function" ? spec.info() : spec.info;
    bar.innerHTML = '<span class="cm-name"><span class="cm-glyph">' + spec.glyph + "</span>" + esc(spec.name) + '</span><span class="cm-info"></span><span class="cm-actions"></span>';
    const infoNode = bar.querySelector(".cm-info");
    infoNode.textContent = info;
    const acts = bar.querySelector(".cm-actions");
    spec.actions().forEach(function (b) { b.disabled = !!S.running && S.mode !== "research"; acts.appendChild(b); });
    const pr = spec.progress ? spec.progress() : null;
    if (pr !== null && pr !== undefined) {
      const bar2 = bar.appendChild(el("span", "cm-progress"));
      bar2.style.width = Math.round(pr * 100) + "%";
    }
    const p = spec.load && spec.load();
    if (p) p.then(function (text) { if (seq === S.modebarSeq && text) infoNode.textContent = text; }, function () {});
  }

  // ------------------------------------------------------------------ events

  function setBusy(on) {
    S.busy = on;
    $("code-box").classList.toggle("busy", on);
    if (on) { S.turnStart = Date.now(); S.step = 0; S.verbSeed = Math.floor(Math.random() * 1000); spinnerOn(V.spinnerVerb(0, S.verbSeed)); }
    else spinnerOff();
  }

  function onEvent(ev) {
    switch (ev.type) {
      case "ready":
        S.provider = ev.provider || S.provider;
        showMeta();
        if (ev.memory) note("Using " + ev.memory + " from the project", "dim");
        break;
      case "turn-start": setBusy(true); break;
      case "thinking": S.step = ev.step; spinnerOn(V.spinnerVerb(ev.step, S.verbSeed)); break;
      case "assistant": {
        const m = add(el("div", "cc-msg", '<span class="cc-dot">⏺</span><div class="cc-body md"></div>'));
        m.querySelector(".cc-body").innerHTML = typeof renderMarkdown === "function" ? renderMarkdown(ev.text) : esc(ev.text);
        break;
      }
      case "tool": onTool(ev); break;
      case "permission": onPermission(ev); break;
      case "todos": onTodos(ev.items); break;
      case "attached": note("Attached " + ev.files.map(function (f) { return "@" + f; }).join(", "), "dim"); break;
      // The agent only knows its permission mode; build, test, research and
      // ship ride on one of those, so their own echo must not undo them.
      case "mode": if (ev.mode !== V.agentModeOf(S.mode)) { S.mode = ev.mode; showMode(); } break;
      case "interrupting": spinnerOn("Stopping after this reply"); break;
      case "rewound":
        note(ev.files.length ? "Rewound " + ev.files.length + " file" + (ev.files.length === 1 ? "" : "s") + ": " + ev.files.join(", ") : "Nothing to rewind");
        break;
      case "cleared": transcript.innerHTML = ""; S.tools = {}; onTodos([]); note("Started a new conversation", "dim"); break;
      case "compacting": note("Conversation at " + ev.size + " - summarising it to continue in a new one", "dim"); break;
      case "compacted": note("Continuing in a new conversation" + (ev.summary ? ", with a summary of the last" : " (no summary could be read)"), ev.summary ? "dim" : "warn"); break;
      case "error": note(ev.message, "err"); break;
      case "done": {
        setBusy(false);
        if (S.permission) { S.permission.box.remove(); S.permission = null; }
        if (ev.reason === "interrupted") note("Interrupted by user", "err");
        else if (ev.reason === "denied") note("Stopped. Tell CloseNI what to do instead.", "dim");
        else if (ev.reason === "step-limit") note("Stopped after the step limit. Say \"continue\" to let it keep going.", "warn");
        else if (ev.reason === "error") note(ev.error || "Something went wrong", "err");
        else if (ev.reason === "complete" && S.mode === "plan") offerPlan();
        CN.setStatus && CN.setStatus("idle");
        if (S.mode === "ship" || S.mode === "test") renderModebar();
        if (S.queue.length && !S.running) { const next = S.queue.shift(); setTimeout(function () { send(next.text, next.shownAs); }, 50); }
        break;
      }
      case "closed":
        S.up = false;
        if (S.busy) { setBusy(false); note("The session ended", "err"); }
        break;
    }
  }
  window.api.onCodeEvent(onEvent);

  // --------------------------------------------------------------- sending

  function ensureSession() {
    if (S.up) return Promise.resolve(true);
    if (S.starting) return S.starting;
    const ws = CN.getWorkspace();
    if (!ws) { note("Choose a project folder first - the agent works inside one.", "err"); refreshWelcome(); return Promise.resolve(false); }
    spinnerOn("Opening " + (CN.getProviderName ? CN.getProviderName() : "the provider"));
    S.turnStart = Date.now();
    S.starting = (CN.buildPreamble ? CN.buildPreamble() : Promise.resolve({})).catch(function () { return {}; }).then(function (preamble) {
      return window.api.codeStart({
        workspace: ws, provider: CN.getProvider(), mode: V.agentModeOf(S.mode),
        headed: CN.isHeaded(), controls: CN.getControls ? CN.getControls() : {}, preamble: preamble,
      });
    }).then(function (r) {
      S.starting = null;
      if (!r || !r.ok) { spinnerOff(); note("Could not start: " + ((r && r.error) || "unknown error"), "err"); return false; }
      S.up = true;
      if (r.provider) { S.provider = r.provider; showMeta(); }
      return true;
    }, function (e) { S.starting = null; spinnerOff(); note("Could not start: " + String(e), "err"); return false; });
    return S.starting;
  }

  function setMode(mode) {
    S.mode = mode;
    showMode();
    if (S.up) window.api.codeMode(V.agentModeOf(mode));
  }

  // /build, /test, /research and /ship switch on and off like /plan.
  function toggleMode(mode) {
    setMode(S.mode === mode ? "default" : mode);
    if (S.mode === mode) note(V.modeLabel(mode).text.replace(/\s*\(shift\+tab to cycle\)/, ""), "dim");
    else note(mode.charAt(0).toUpperCase() + mode.slice(1) + " mode off", "dim");
  }

  function slash(p) {
    switch (p.cmd) {
      case "/help": add(el("pre", "cc-help", esc(V.HELP))); return;
      case "/clear":
        if (S.busy) { note("Wait for the current turn to finish, or press esc.", "err"); return; }
        if (S.up) window.api.codeClear(); else onEvent({ type: "cleared" });
        return;
      case "/plan": setMode(S.mode === "plan" ? "default" : "plan"); note(S.mode === "plan" ? "Plan mode on: read-only, answers with a plan" : "Plan mode off", "dim"); return;
      case "/mode": {
        const m = V.modeFromWord(p.arg);
        if (!m) { note("Modes: default, accept, plan, build, test, research, ship, auto", "dim"); return; }
        const was = S.mode;
        setMode(m); note("Mode: " + V.modeLabel(m).text.replace(/\s*\(shift\+tab to cycle\)/, ""), "dim");
        if (m === "auto" && was !== "auto") note(V.AUTO_WARNING, "warn");
        return;
      }
      case "/compact":
        if (S.busy) { note("Wait for the current turn to finish, or press esc.", "err"); return; }
        if (!S.up) { note("Nothing to compact yet", "dim"); return; }
        window.api.codeCompact(); return;
      case "/rewind":
        if (!S.up) { note("Nothing to rewind yet", "dim"); return; }
        window.api.codeRewind(); return;
      case "/init": send(V.INIT_PROMPT, "/init"); return;
      case "/memory": {
        const ws = CN.getWorkspace();
        if (!ws) { note("Choose a project folder first", "err"); return; }
        window.api.readFile(ws.replace(/[\\/]$/, "") + "/CLOSENI.md", { full: true }).then(function (r) {
          const text = r && (r.content || r.text);
          if (!text) { note("No CLOSENI.md yet - /init writes one", "dim"); return; }
          add(el("pre", "cc-help", esc(text)));
        }, function () { note("No CLOSENI.md yet - /init writes one", "dim"); });
        return;
      }
      case "/build": case "/test": case "/research": case "/ship": {
        // "/test add a case for x" switches and does it; bare, it toggles.
        const m = p.cmd.slice(1);
        if (!p.arg) { toggleMode(m); return; }
        if (S.mode !== m) setMode(m);
        if (m === "research") research(p.arg);
        else send(V.modePrompt(m, p.arg), p.arg);
        return;
      }
      // The step-by-step builder, the runner and the GitHub screen keep their
      // full panels; these open them, and the Agent button comes back.
      case "/steps": CN.switchTab("chat"); return;
      case "/runner": CN.switchTab("test"); return;
      case "/github": CN.switchTab("push"); return;
      case "/settings": CN.switchTab("settings"); return;
      case "/model": CN.switchTab("settings"); { const t = document.querySelector('.settings-tab[data-section="provider"]'); if (t) t.click(); } return;
      case "/theme": CN.switchTab("settings"); { const t = document.querySelector('.settings-tab[data-section="appearance"]'); if (t) t.click(); } return;
      case "/stop": interrupt(); return;
      default: note("Unknown command " + p.cmd + " - /help lists them", "err");
    }
  }

  function userLine(text, cls) {
    return add(el("div", "cc-user" + (cls ? " " + cls : ""), '<span class="cc-prompt">&gt;</span><span>' + esc(text) + "</span>"));
  }

  function send(text, shownAs) {
    const t = String(text || "").trim();
    const p = t ? V.parseSlash(t) : null;
    if (p && !shownAs) {
      userLine(t);
      slash(p);
      return;
    }
    // Enter on an empty line is the mode's own action: run the tests, or ship.
    if (!t && S.mode === "test") { userLine("run the tests"); runChecks("behaviour"); return; }
    if (S.mode === "research" && !shownAs) {
      if (!t) return;
      userLine(t);
      research(t);
      return;
    }
    // What the agent receives: the mode's job above the user's words. The
    // transcript shows only the words.
    const wire = shownAs ? t : V.modePrompt(S.mode, t);
    if (!wire) return;
    const shown = shownAs || t || "review, test and commit";
    if (S.busy || S.starting || S.running) {
      S.queue.push({ text: wire, shownAs: shown });
      add(el("div", "cc-user queued", '<span class="cc-prompt">&gt;</span><span>' + esc(shown) + '</span><span class="cc-queued">queued</span>'));
      return;
    }
    userLine(shown);
    ensureSession().then(function (ok) {
      if (!ok) return;
      window.api.codeSend(wire).then(function (r) {
        if (r && r.ok === false) note("Could not send: " + (r.error || "no session"), "err");
      });
    });
  }

  function interrupt() {
    if (S.permission) { answerPermission("deny", ""); }
    if (S.busy && S.up) window.api.codeInterrupt();
  }

  // ----------------------------------------------------------------- input

  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(220, input.scrollHeight) + "px";
  }

  function closePopup() { S.popup = null; $("code-suggest").classList.add("hidden"); }

  function showPopup(items, kind) {
    const box = $("code-suggest");
    if (!items.length) { closePopup(); return; }
    S.popup = { items: items, kind: kind, sel: 0 };
    box.innerHTML = items.map(function (it, i) {
      return '<div class="cc-sug' + (i === 0 ? " sel" : "") + '" data-i="' + i + '"><span class="k">' + esc(it.label) + '</span><span class="d">' + esc(it.desc || "") + "</span></div>";
    }).join("");
    box.querySelectorAll(".cc-sug").forEach(function (n) { n.onmousedown = function (e) { e.preventDefault(); pickPopup(parseInt(n.dataset.i, 10)); }; });
    box.classList.remove("hidden");
  }

  function movePopup(d) {
    const P = S.popup; if (!P) return;
    P.sel = (P.sel + d + P.items.length) % P.items.length;
    $("code-suggest").querySelectorAll(".cc-sug").forEach(function (n, i) { n.classList.toggle("sel", i === P.sel); });
  }

  function pickPopup(i) {
    const P = S.popup; if (!P) return;
    const it = P.items[i == null ? P.sel : i];
    if (P.kind === "cmd") { input.value = it.label + (it.arg ? " " : ""); }
    else {
      const r = V.completeMention(input.value, input.selectionStart, it.label);
      input.value = r.text;
      input.setSelectionRange(r.caret, r.caret);
    }
    closePopup();
    autosize();
    input.focus();
  }

  function loadFiles() {
    const ws = CN.getWorkspace();
    if (!ws) return Promise.resolve([]);
    if (S.files && S.files.ws === ws) return Promise.resolve(S.files.list);
    return window.api.listFiles(ws).then(function (r) {
      S.files = { ws: ws, list: (r && r.files) || [] };
      return S.files.list;
    }, function () { return []; });
  }

  function updatePopup() {
    const v = input.value;
    if (/^\/\S*$/.test(v)) {
      showPopup(V.matchCommands(v).map(function (c) { return { label: c.name, desc: c.desc, arg: c.arg }; }), "cmd");
      return;
    }
    const at = V.mentionAt(v, input.selectionStart);
    if (at) {
      loadFiles().then(function (files) {
        showPopup(V.rankFiles(files, at.query, 8).map(function (f) { return { label: f, desc: "" }; }), "file");
      });
      return;
    }
    closePopup();
  }

  input.addEventListener("input", function () { autosize(); updatePopup(); });

  input.addEventListener("keydown", function (e) {
    if (S.popup) {
      if (e.key === "ArrowDown") { e.preventDefault(); movePopup(1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); movePopup(-1); return; }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && S.popup.kind === "file")) { e.preventDefault(); pickPopup(); return; }
      if (e.key === "Escape") { e.preventDefault(); closePopup(); return; }
    }
    if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); setMode(V.nextMode(S.mode)); return; }
    if (e.key === "Escape") { e.preventDefault(); if (S.busy || S.permission) interrupt(); else { input.value = ""; autosize(); } return; }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const t = input.value;
      if (!t.trim()) {
        // Test and ship have something to do with nothing typed.
        if (S.mode === "test" || S.mode === "ship") send("");
        return;
      }
      S.history.push(t); S.hIndex = -1;
      input.value = ""; autosize(); closePopup();
      send(t);
      return;
    }
    if (e.key === "?" && !input.value) { e.preventDefault(); add(el("pre", "cc-help", esc(V.HELP))); return; }
    if (e.key === "ArrowUp" && input.selectionStart === 0 && S.history.length) {
      e.preventDefault();
      S.hIndex = S.hIndex === -1 ? S.history.length - 1 : Math.max(0, S.hIndex - 1);
      input.value = S.history[S.hIndex]; autosize();
      return;
    }
    if (e.key === "ArrowDown" && S.hIndex !== -1 && input.selectionStart === input.value.length) {
      e.preventDefault();
      S.hIndex++;
      if (S.hIndex >= S.history.length) { S.hIndex = -1; input.value = ""; } else input.value = S.history[S.hIndex];
      autosize();
    }
  });

  // Permission prompts answer to the keyboard wherever focus is: 1-3, arrows, enter, esc.
  document.addEventListener("keydown", function (e) {
    const P = S.permission;
    if (!P || !$("panel-code").classList.contains("active")) return;
    if (document.activeElement && document.activeElement.closest && document.activeElement.closest(".cc-perm-feedback")) return;
    const n = parseInt(e.key, 10);
    if (n >= 1 && n <= P.opts.length) { e.preventDefault(); choosePermission(n - 1); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); selectPermission(P.sel + 1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); selectPermission(P.sel - 1); return; }
    if (e.key === "Enter" && document.activeElement !== input) { e.preventDefault(); choosePermission(P.sel); return; }
    if (e.key === "Escape") { e.preventDefault(); answerPermission("deny", ""); }
  });

  $("code-box").onclick = function (e) { if (e.target === this || e.target.classList.contains("code-caret")) input.focus(); };

  CN.onWorkspaceChange = function () {
    // A different folder is a different project: the old session yields and
    // the next message opens one there.
    S.files = null;
    if (S.up) { window.api.codeEnd(); S.up = false; }
    refreshWelcome();
    showMeta();
    renderModebar();
  };
  CN.focusCode = function () { input.focus(); };

  refreshWelcome();
  showMode();
  showMeta();
})();
