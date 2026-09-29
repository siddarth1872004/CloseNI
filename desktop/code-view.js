/*
 * The Code panel's vocabulary: how tool calls are titled and summarised, the
 * slash commands, the modes, the spinner.
 *
 * Loaded by index.html (window.CNCode) and require()d by the test harness.
 * There is no bundler, so no import/export. Everything here is pure; the DOM
 * lives in code.js.
 *
 * The panel reads like a terminal coding agent's transcript: a line per thing
 * that happened, the tool and its argument as a title - Read(src/app.py),
 * Bash(npm test) - and one indented result line under it, expandable.
 */
(function (root) {
  var COMMANDS = [
    { name: "/help", desc: "Commands and shortcuts" },
    { name: "/clear", desc: "Start a new conversation" },
    { name: "/plan", desc: "Toggle plan mode: read-only, answers with a plan" },
    { name: "/mode", desc: "Set the mode: default, accept, plan or auto", arg: "<mode>" },
    { name: "/rewind", desc: "Undo the file changes of the last turn" },
    { name: "/init", desc: "Write a CLOSENI.md describing this project" },
    { name: "/memory", desc: "Show the project's CLOSENI.md" },
    { name: "/build", desc: "Planned build mode: plan first, then build step by step" },
    { name: "/model", desc: "Choose the provider and its model" },
    { name: "/theme", desc: "Change the theme" },
    { name: "/stop", desc: "Stop after the current reply" },
  ];
  var ALIASES = { "/undo": "/rewind", "/reset": "/clear", "/new": "/clear", "/?": "/help", "/config": "/model", "/settings": "/model" };

  /** "/mode plan" -> { cmd: "/mode", arg: "plan" }. Null for ordinary text. */
  function parseSlash(text) {
    var t = String(text || "").trim();
    if (t.charAt(0) !== "/" || /^\/\S*\//.test(t)) return null;   // a path like /usr/bin is not a command
    var sp = t.search(/\s/);
    var cmd = (sp === -1 ? t : t.slice(0, sp)).toLowerCase();
    cmd = ALIASES[cmd] || cmd;
    var known = COMMANDS.some(function (c) { return c.name === cmd; });
    return { cmd: cmd, arg: sp === -1 ? "" : t.slice(sp + 1).trim(), known: known };
  }

  /** Commands for the popup while typing "/pl". */
  function matchCommands(prefix) {
    var p = String(prefix || "").toLowerCase();
    if (p.charAt(0) !== "/") return [];
    return COMMANDS.filter(function (c) { return c.name.indexOf(p) === 0; });
  }

  var MODES = ["default", "acceptEdits", "plan", "auto"];

  function modeFromWord(w) {
    var s = String(w || "").toLowerCase().replace(/[\s_-]/g, "");
    if (s === "default" || s === "normal" || s === "ask") return "default";
    if (s === "accept" || s === "acceptedits" || s === "edits") return "acceptEdits";
    if (s === "plan" || s === "planning" || s === "readonly") return "plan";
    if (s === "auto" || s === "yolo" || s === "bypass" || s === "autoapprove") return "auto";
    return null;
  }

  /** shift+tab: default, accept edits, plan, back. Auto is chosen, never cycled into. */
  function nextMode(mode) {
    if (mode === "default") return "acceptEdits";
    if (mode === "acceptEdits") return "plan";
    return "default";
  }

  function modeLabel(mode) {
    if (mode === "acceptEdits") return { text: "⏵⏵ accept edits on (shift+tab to cycle)", cls: "accept" };
    if (mode === "plan") return { text: "⏸ plan mode on (shift+tab to cycle)", cls: "plan" };
    if (mode === "auto") return { text: "⏵⏵ auto-approve on: commands run without asking (shift+tab to cycle)", cls: "auto" };
    return { text: "? for shortcuts", cls: "default" };
  }

  function clip(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n - 1) + "…" : s; }

  /** Read(src/app.py), Bash(npm test), Update(calc.py) ... */
  function toolTitle(ev) {
    var i = (ev && ev.input) || {};
    switch (ev && ev.name) {
      case "read": return { verb: "Read", arg: i.path || "" };
      case "write": return { verb: "Write", arg: i.path || "" };
      case "edit": return { verb: "Update", arg: i.path || "" };
      case "bash": return { verb: "Bash", arg: clip(i.command || "", 90) };
      case "glob": return { verb: "Search", arg: "pattern: \"" + (i.pattern || "") + "\"" + (i.path ? ", path: \"" + i.path + "\"" : "") };
      case "grep": return { verb: "Search", arg: "pattern: \"" + clip(i.pattern || "", 60) + "\"" + (i.path ? ", path: \"" + i.path + "\"" : "") + (i.glob ? ", glob: \"" + i.glob + "\"" : "") };
      case "ls": return { verb: "List", arg: i.path || "." };
      case "todo": return { verb: "Update Todos", arg: "" };
      default: return { verb: "Invalid tool call", arg: "" };
    }
  }

  function plural(n, one, many) { return n + " " + (n === 1 ? one : (many || one + "s")); }

  function countChanges(before, after) {
    var a = String(before || "").split("\n"), b = String(after || "").split("\n");
    var seen = {}, added = 0, removed = 0, k;
    for (k = 0; k < a.length; k++) seen[a[k]] = (seen[a[k]] || 0) + 1;
    for (k = 0; k < b.length; k++) { if (seen[b[k]]) seen[b[k]]--; else added++; }
    for (k in seen) if (Object.prototype.hasOwnProperty.call(seen, k)) removed += seen[k];
    return { added: added, removed: removed };
  }

  /** The one line under a tool call, the way a terminal agent writes it. */
  function toolSummary(ev) {
    if (!ev) return "";
    if (ev.status === "waiting") return "Waiting for permission…";
    if (ev.status === "running") return "Running…";
    if (ev.status === "denied") return ev.summary === "declined by the user" ? "User declined" : clip("Not run: " + (ev.summary || ""), 200);
    if (ev.status === "error") return clip("Error: " + String(ev.output || ev.summary || "").replace(/^Error:\s*/, "").split("\n")[0], 200);
    var d = ev.detail || {};
    switch (ev.name) {
      case "read": return "Read " + plural(d.lines || 0, "line");
      case "write": {
        var n = String(d.after || "").split("\n").length - (String(d.after || "").slice(-1) === "\n" ? 1 : 0);
        return (d.created ? "Wrote " : "Overwrote ") + plural(n, "line") + " to " + (d.path || "");
      }
      case "edit": {
        var c = countChanges(d.before, d.after);
        return "Updated " + (d.path || "") + " with " + plural(c.added, "addition") + " and " + plural(c.removed, "removal");
      }
      case "bash": {
        var lines = String(d.output || ev.output || "").replace(/\s+$/, "").split("\n");
        if (!lines[0]) return d.timedOut ? "Left running (no exit after the timeout)" : "(No content)";
        return lines.slice(0, 3).join("\n") + (lines.length > 3 ? "\n… +" + (lines.length - 3) + " lines (click to expand)" : "");
      }
      case "glob": return "Found " + plural(d.total || 0, "file");
      case "grep": return "Found " + plural(d.matches || 0, "match", "matches") + (d.files ? " in " + plural(d.files, "file") : "");
      case "ls": return "Listed " + plural(d.entries || 0, "path");
      case "todo": {
        var items = d.items || [];
        var done = items.filter(function (x) { return x.status === "done"; }).length;
        return done + " of " + plural(items.length, "task") + " done";
      }
    }
    return ev.summary || "";
  }

  /** The dot colour for a tool line. */
  function toolTone(status) {
    if (status === "done") return "ok";
    if (status === "error" || status === "denied") return "err";
    if (status === "running") return "run";
    return "wait";
  }

  /** What a permission question offers, in order. */
  function permissionOptions(req) {
    var opts = [{ key: "allow", label: "Yes" }];
    if (!req.alwaysAsk) {
      if (req.tool === "write" || req.tool === "edit") opts.push({ key: "always", label: "Yes, allow all edits during this session" });
      else if (req.rememberAs) opts.push({ key: "always", label: "Yes, and don't ask again for " + req.rememberAs + " commands in this session" });
    }
    opts.push({ key: "deny", label: "No, and tell CloseNI what to do differently (esc)" });
    return opts;
  }

  function permissionQuestion(req) {
    if (req.tool === "bash") return "Bash command";
    if (req.tool === "write") return req.preview && req.preview.created ? "Create file" : "Overwrite file";
    if (req.tool === "edit") return "Edit file";
    return "Tool call";
  }

  // Shown while the model is working. It is a web page doing the work, so the
  // words say so rather than pretending to be a local model's thoughts.
  var VERBS = ["Thinking", "Pondering", "Working", "Reading", "Considering", "Composing", "Tinkering", "Reasoning", "Crafting", "Mulling"];
  var GLYPHS = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];

  function spinnerVerb(step, seed) {
    if (step > 0) return ["Reading the results", "Continuing", "Working", "Checking"][(step - 1) % 4];
    return VERBS[Math.abs(seed | 0) % VERBS.length];
  }

  function elapsed(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s";
  }

  /** The @word the caret is in, for file completion. */
  function mentionAt(text, caret) {
    var before = String(text || "").slice(0, caret);
    var m = before.match(/(^|\s)@([\w./-]*)$/);
    return m ? { query: m[2], start: caret - m[2].length - 1 } : null;
  }

  function completeMention(text, caret, path) {
    var at = mentionAt(text, caret);
    if (!at) return { text: text, caret: caret };
    var out = text.slice(0, at.start) + "@" + path + " " + text.slice(caret);
    return { text: out, caret: at.start + path.length + 2 };
  }

  function rankFiles(files, query, limit) {
    var q = String(query || "").toLowerCase();
    var scored = [];
    (files || []).forEach(function (f) {
      var l = f.toLowerCase(), base = l.split("/").pop();
      var score = !q ? 1 : base.indexOf(q) === 0 ? 4 : base.indexOf(q) !== -1 ? 3 : l.indexOf(q) !== -1 ? 2 : 0;
      if (score) scored.push({ f: f, s: score });
    });
    scored.sort(function (a, b) { return b.s - a.s || a.f.length - b.f.length || (a.f < b.f ? -1 : 1); });
    return scored.slice(0, limit || 8).map(function (x) { return x.f; });
  }

  var INIT_PROMPT =
    "Look through this project and write a CLOSENI.md file at its root for future sessions. Include: " +
    "what the project is, how to install, build, run and test it (the exact commands), how the code is " +
    "organised, and conventions a contributor must follow. Keep it short and factual - only what you " +
    "verified by reading files. If CLOSENI.md already exists, improve it rather than replacing it.";

  var HELP = [
    "Commands",
    COMMANDS.map(function (c) { return "  " + (c.name + (c.arg ? " " + c.arg : "")).padEnd(16) + c.desc; }).join("\n"),
    "",
    "Shortcuts",
    "  enter           send",
    "  shift+enter     new line",
    "  shift+tab       cycle mode: default, accept edits, plan",
    "  esc             stop after the current reply",
    "  ↑ / ↓           previous messages",
    "  @path           attach a file",
    "",
    "Modes",
    "  default         reads freely; asks before edits and commands",
    "  accept edits    edits without asking; still asks before commands",
    "  plan            read-only; answers with a plan you can approve",
    "  auto            runs everything, except commands that always ask",
  ].join("\n");

  var api = {
    COMMANDS: COMMANDS, MODES: MODES, INIT_PROMPT: INIT_PROMPT, HELP: HELP,
    parseSlash: parseSlash, matchCommands: matchCommands, modeFromWord: modeFromWord,
    nextMode: nextMode, modeLabel: modeLabel, toolTitle: toolTitle, toolSummary: toolSummary,
    toolTone: toolTone, permissionOptions: permissionOptions, permissionQuestion: permissionQuestion,
    spinnerVerb: spinnerVerb, GLYPHS: GLYPHS, elapsed: elapsed, mentionAt: mentionAt,
    completeMention: completeMention, rankFiles: rankFiles, countChanges: countChanges,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CNCode = api;
})(typeof window !== "undefined" ? window : globalThis);
