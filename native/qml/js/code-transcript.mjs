/*
 * The Code panel's transcript, as data.
 *
 * desktop/code.js built the transcript as DOM nodes and decided inline what
 * each node held: which part of a tool line folds out, what a permission
 * prompt shows above its options, how much of an output a card keeps. The
 * native panel draws from plain entries kept by CodeStore, so those decisions
 * live here, pure, beside code-logic.mjs (the rest of what code.js worked
 * out) and code-view.mjs (the panel's vocabulary).
 */
import * as C from "./code-logic.mjs";
import * as V from "./code-view.mjs";
import * as L from "./language-mark.mjs";

// The transcript is bounded: a long session must not grow it without limit.
// Electron kept every node; 2000 entries is far more than a screen's worth of
// scrollback and keeps a day-long session's memory flat.
var MAX_ENTRIES = 2000;

// What code.js kept of each output: the tail of a card's output block, the
// head of `git diff` and of any other git output.
var OUTPUT_TAIL = 20000;
var GIT_DIFF_CAP = 40000;
var GIT_OUT_CAP = 20000;

/** How many of the oldest entries to drop so that at most `max` remain. */
function overflow(count, max) {
  return Math.max(0, count - (max || MAX_ENTRIES));
}

/** Whether a tool event wrote or edited a file: only then is there something new to run. */
function toolChanged(ev) {
  return (ev.name === "edit" || ev.name === "write") && ev.status === "done";
}

/**
 * What a tool line folds out, from one tool event, or null to keep what it
 * already has. An edit's diff and a todo list are shown at once (open: true),
 * as a terminal agent shows them; command output stays folded until the line
 * is clicked (open: null leaves the line as it was).
 *   { kind: "diff", rows } | { kind: "out", text } | { kind: "todos", items }
 */
function toolMore(ev) {
  var d = ev.detail || {};
  if (toolChanged(ev) && d.after !== undefined) return { kind: "diff", rows: C.numberDiff(d.before, d.after), open: true };
  if (ev.name === "bash" && ev.output) return { kind: "out", text: String(ev.output), open: null };
  if (ev.name === "todo" && d.items) return { kind: "todos", items: d.items, open: true };
  if (ev.output && ev.status === "done") return { kind: "out", text: String(ev.output), open: null };
  return null;
}

/**
 * What a permission prompt shows between its question and its options: the
 * command for bash, the path and diff for a write or edit, or nothing.
 *   { kind: "cmd", text } | { kind: "diff", path, rows } | null
 */
function permissionBody(req) {
  var pv = req.preview || {};
  if (req.tool === "bash") return { kind: "cmd", text: String(pv.command || (req.input && req.input.command) || "") };
  if (pv.after !== undefined) return { kind: "diff", path: pv.path || "", rows: C.numberDiff(pv.before, pv.after) };
  return null;
}

/** The part of a run's output a card keeps: its end, where the error is. */
function outputTail(text) {
  return String(text == null ? "" : text).slice(-OUTPUT_TAIL);
}

/** Whether a git command's output is a diff, drawn line by line in colour. */
function gitShowsDiff(args) {
  return args[0] === "diff" || args[0] === "show";
}

/** `git diff` output as { text, cls } lines, cls from gitDiffLineClass. */
function gitDiffLines(text) {
  return String(text).slice(0, GIT_DIFF_CAP).split("\n").map(function (l) {
    return { text: l, cls: C.gitDiffLineClass(l) };
  });
}

/** Any other git output, as a card keeps it. */
function gitOutput(text) {
  return String(text).slice(0, GIT_OUT_CAP);
}

/**
 * What the welcome box says is missing, in order: a folder, then the sign-in
 * and with it - once, before the first one - the terms. `steps` is the
 * getting-started guide's list. Null when nothing is missing.
 *   { kind: "folder", text } | { kind: "signin", text, action, terms, termsUrl }
 */
function welcomeNeed(ws, steps) {
  if (!ws) return { kind: "folder", text: "The agent works inside one folder. " };
  var step = (steps || []).find(function (s) { return s.id === "signin"; });
  if (!step || step.done) return null;
  return {
    kind: "signin",
    text: step.title + ". ",
    action: step.action || "",
    terms: step.terms ? step.terms + " " : "",
    termsUrl: step.termsUrl || "",
  };
}

/** A language name's colour token (--lang-py and so on), or "" for no mark. */
function langToken(language) {
  return language ? L.languageToken(language) : "";
}

/** The note a failed check row carries in a card, and whether its whole output follows. */
function checkRows(results) {
  return (results || []).map(function (r) {
    var row = C.testRow(r);
    row.language = r.language || "";
    row.output = row.multiline ? String(r.detail) : "";
    return row;
  });
}

/** A repository's line under GitHub in a research card. */
function repoMeta(repo) {
  return "★ " + (repo.stars || 0) + (repo.language ? " · " : "");
}

/** The heading over a research answer's sources. */
function sourcesTitle(via) {
  return "Sources" + (via ? " · via " + via : "");
}

/** The question in front of a clone: the licence is the user's to accept. */
function cloneQuestion(name, license) {
  return "Clone " + name + " into your workspace?\n\n" +
    "It carries " + (license || "an unknown licence") + ", and the AI will go on to edit code it did not write.";
}

/** The note when the run window's "Fix errors" names a different folder. */
function runFixElsewhere(cwd) {
  return "The run window ran " + cwd + ", not the open project. Open that folder to fix it here.";
}

/** The spinner's line after its verb. */
function spinnerMeta(ms) {
  return "(" + V.elapsed(ms) + " · esc to interrupt)";
}

export {
  MAX_ENTRIES,
  OUTPUT_TAIL,
  GIT_DIFF_CAP,
  GIT_OUT_CAP,
  overflow,
  toolChanged,
  toolMore,
  permissionBody,
  outputTail,
  gitShowsDiff,
  gitDiffLines,
  gitOutput,
  welcomeNeed,
  langToken,
  checkRows,
  repoMeta,
  sourcesTitle,
  cloneQuestion,
  runFixElsewhere,
  spinnerMeta,
};
