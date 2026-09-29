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
      case "mode": S.mode = ev.mode; showMode(); break;
      case "interrupting": spinnerOn("Stopping after this reply"); break;
      case "rewound":
        note(ev.files.length ? "Rewound " + ev.files.length + " file" + (ev.files.length === 1 ? "" : "s") + ": " + ev.files.join(", ") : "Nothing to rewind");
        break;
      case "cleared": transcript.innerHTML = ""; S.tools = {}; onTodos([]); note("Started a new conversation", "dim"); break;
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
        if (S.queue.length) { const next = S.queue.shift(); setTimeout(function () { send(next); }, 50); }
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
        workspace: ws, provider: CN.getProvider(), mode: S.mode,
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
    if (S.up) window.api.codeMode(mode);
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
        if (!m) { note("Modes: default, accept, plan, auto", "dim"); return; }
        setMode(m); note("Mode: " + V.modeLabel(m).text.replace(/\s*\(shift\+tab to cycle\)/, ""), "dim"); return;
      }
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
      case "/build": CN.switchTab("chat"); return;
      case "/model": CN.switchTab("settings"); { const t = document.querySelector('.settings-tab[data-section="provider"]'); if (t) t.click(); } return;
      case "/theme": CN.switchTab("settings"); { const t = document.querySelector('.settings-tab[data-section="appearance"]'); if (t) t.click(); } return;
      case "/stop": interrupt(); return;
      default: note("Unknown command " + p.cmd + " - /help lists them", "err");
    }
  }

  function send(text, shownAs) {
    const t = String(text || "").trim();
    if (!t) return;
    const p = V.parseSlash(t);
    if (p && !shownAs) {
      add(el("div", "cc-user", '<span class="cc-prompt">&gt;</span><span>' + esc(t) + "</span>"));
      slash(p);
      return;
    }
    if (S.busy || S.starting) {
      S.queue.push(t);
      add(el("div", "cc-user queued", '<span class="cc-prompt">&gt;</span><span>' + esc(shownAs || t) + '</span><span class="cc-queued">queued</span>'));
      return;
    }
    add(el("div", "cc-user", '<span class="cc-prompt">&gt;</span><span>' + esc(shownAs || t) + "</span>"));
    ensureSession().then(function (ok) {
      if (!ok) return;
      window.api.codeSend(t).then(function (r) {
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
      if (!t.trim()) return;
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
  };
  CN.focusCode = function () { input.focus(); };

  refreshWelcome();
  showMode();
  showMeta();
})();
