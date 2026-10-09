/*
 * The Code panel's decisions, without the panel.
 *
 * Extracted from desktop/code.js (deleted with Electron in 0.4.0).
 * code-view.mjs already held the panel's vocabulary
 * (commands, modes, tool titles); this holds the rest of what code.js worked
 * out inline: diff line numbers, the mode strip's text, the notes a turn ends
 * with, and how a typed line is routed. Everything here is pure; the session,
 * timers and drawing stay with the Code panel.
 */
import * as V from "./code-view.mjs";
import * as Diff from "./diff.mjs";

/**
 * An edit's diff as numbered rows: { type, ln, sign, text }. A "gap" row
 * carries no number and moves both sides on by the lines it stands for.
 */
function numberDiff(before, after) {
  var rows = Diff.diffLines(before || "", after || "");
  var a = 1, b = 1;
  return rows.map(function (r) {
    if (r.type === "gap") {
      var n = parseInt((r.text.match(/(\d+)/) || [0, 0])[1], 10) || 0;
      a += n; b += n;
      return { type: "gap", ln: "", sign: "", text: r.text };
    }
    var ln;
    if (r.type === "add") { ln = b++; }
    else if (r.type === "remove") { ln = a++; }
    else { ln = b; a++; b++; }
    var sign = r.type === "add" ? "+" : r.type === "remove" ? "-" : " ";
    return { type: r.type, ln: ln, sign: sign, text: r.text };
  });
}

/** The box in front of a todo item. */
function todoBox(status) {
  return status === "done" ? "☒" : status === "in_progress" ? "◼" : "☐";
}

/** The todo list is shown while anything on it is still to do. */
function todosVisible(items) {
  return !!(items && items.length) && !items.every(function (i) { return i.status === "done"; });
}

// The answers offered when a plan-mode turn completes. The first is selected.
var PLAN_OFFER_OPTIONS = [
  { label: "Yes, in build mode: steps, edits and checks", mode: "build" },
  { label: "Yes, and auto-accept edits", mode: "acceptEdits" },
  { label: "Yes, and manually approve edits", mode: "default" },
  { label: "No, keep planning", mode: null },
];

// What the strip above the prompt says, per mode. The actions it carries are
// the panel's to draw; their labels are here so both stay in one place.
var MODEBAR = {
  plan: { glyph: "⏸", name: "Plan",
    info: "Read-only. The agent looks around and answers with a plan; approve it to start building." },
  build: { glyph: "⚒", name: "Build",
    info: "Say what to build. It plans steps, edits without asking and runs each step with the project's toolchain." },
  test: { glyph: "✓", name: "Test", info: "Finding how this project runs…" },
  research: { glyph: "⌕", name: "Research", info: "Enter searches. Nothing in the project changes." },
  ship: { glyph: "⇡", name: "Ship", info: "Reading git…" },
};

/** Build mode's strip text, from the agent's todo list. */
function buildModeInfo(todos) {
  var t = todos || [];
  if (!t.length) return MODEBAR.build.info;
  var done = t.filter(function (i) { return i.status === "done"; }).length;
  var now = t.find(function (i) { return i.status === "in_progress"; });
  return done + "/" + t.length + " steps done" + (now ? " · now: " + now.text : "");
}

/** Build mode's progress bar, 0..1, or null when there is no list. */
function buildModeProgress(todos) {
  var t = todos || [];
  return t.length ? t.filter(function (i) { return i.status === "done"; }).length / t.length : null;
}

/** Test mode's strip text, from resolveRunCommand's answer. */
function testModeInfo(rc) {
  return rc && rc.command ? "run: " + rc.command + (rc.source ? "  (" + rc.source + ")" : "") : "No run command yet. Type what to test, or run the suite.";
}

/** Ship mode's strip text, from `git status --short --branch`. */
function shipModeInfo(ok, output) {
  if (!ok) return "Not a git repository yet - ask the agent to set one up, or use /github.";
  var lines = String(output || "").split("\n").filter(Boolean);
  var head = (lines[0] || "").replace(/^##\s*/, "");
  var branch = head.split("...")[0] || "detached";
  var ahead = (head.match(/ahead (\d+)/) || [])[1], behind = (head.match(/behind (\d+)/) || [])[1];
  var changed = lines.length - 1;
  return "on " + branch + (ahead ? " ↑" + ahead : "") + (behind ? " ↓" + behind : "") + " · " +
    (changed ? changed + " changed file" + (changed === 1 ? "" : "s") : "clean") + ". Enter on an empty line reviews, tests and commits.";
}

/** A tests or syntax-check card's summary and tone, from the agent's result. */
function checksSummary(res) {
  if (!res) return { text: "could not run", tone: "fail" };
  var passed = res.passed || 0, failed = res.failed || 0, skipped = res.skipped || 0;
  var sum = passed + " passed, " + failed + " failed";
  if (skipped) sum += ", " + skipped + " not run";
  if (!passed && !failed && !skipped) sum = res.note || res.error || "nothing to run";
  return { text: sum, tone: failed ? "fail" : passed ? "pass" : "none" };
}

/** One check's row: its kind, mark and first line of detail. */
function testRow(r) {
  var skipped = /^(skipped|not run)\b/i.test(r.detail || "") && !r.success;
  return {
    kind: r.success ? "pass" : skipped ? "skip" : "fail",
    mark: r.success ? "✓" : skipped ? "–" : "✗",
    command: r.command || "",
    detail: r.detail ? String(r.detail).split("\n")[0].slice(0, 160) : "",
    multiline: !!(r.detail && String(r.detail).indexOf("\n") !== -1),
  };
}

/** The failing checks as a list for the "fix it" prompt. */
function failingChecks(results) {
  return (results || []).filter(function (r) { return !r.success; })
    .map(function (r) { return "- " + r.command + (r.detail ? ": " + String(r.detail).slice(0, 600) : ""); }).join("\n");
}

/** The prompt "Ask the agent to fix it" sends. */
function fixChecksPrompt(results) {
  return V.modePrompt("test", "These checks failed. Find out why and fix the code:\n" + failingChecks(results));
}

/** The class of one line of git diff output: add, del, hunk, meta or "". */
function gitDiffLineClass(l) {
  return /^\+(?!\+\+)/.test(l) ? "add" : /^-(?!--)/.test(l) ? "del" : /^@@/.test(l) ? "hunk" : /^(diff|index|\+\+\+|---) /.test(l) ? "meta" : "";
}

/** What an answered permission prompt collapses to. */
function permissionAnswerLabel(decision, feedback) {
  return decision === "deny" ? "No" + (feedback ? ": " + feedback : "") : decision === "always" ? "Yes, don't ask again" : "Yes";
}

/**
 * What a finished turn ends with: a note, the plan offer or the run offer.
 * `changed` is whether the turn wrote or edited a file and `fixing` whether it
 * was fixing a failed run. Returns { note, tone } or { offer: "plan"|"run" }
 * or null.
 */
function doneOutcome(ev, mode, changed, fixing) {
  if (ev.reason === "interrupted") return { note: "Interrupted by user", tone: "err" };
  if (ev.reason === "denied") return { note: "Stopped. Tell CloseNI what to do instead.", tone: "dim" };
  if (ev.reason === "step-limit") return { note: "Stopped after the step limit. Say \"continue\" to let it keep going.", tone: "warn" };
  if (ev.reason === "error") return { note: ev.error || "Something went wrong", tone: "err" };
  if (ev.reason === "complete" && mode === "plan") return { offer: "plan" };
  if (ev.reason === "complete" && (changed || fixing)) return { offer: "run" };
  return null;
}

function rewoundNote(files) {
  return files.length ? "Rewound " + files.length + " file" + (files.length === 1 ? "" : "s") + ": " + files.join(", ") : "Nothing to rewind";
}

function compactedNote(summary) {
  return {
    text: "Continuing in a new conversation" + (summary ? ", with a summary of the last" : " (no summary could be read)"),
    tone: summary ? "dim" : "warn",
  };
}

/** The header's "provider · folder" line. */
function metaText(provider, ws) {
  var bits = [];
  if (provider) bits.push(provider);
  if (ws) bits.push(ws.split(/[\\/]/).filter(Boolean).pop());
  return bits.join(" · ");
}

/** The note /build, /test, /research or /ship leaves when it toggles. */
function toggleNote(mode, nowMode) {
  if (nowMode === mode) return V.modeLabel(mode).text.replace(/\s*\(shift\+tab to cycle\)/, "");
  return mode.charAt(0).toUpperCase() + mode.slice(1) + " mode off";
}

/** /mode's note for the mode just set. */
function modeNote(mode) {
  return "Mode: " + V.modeLabel(mode).text.replace(/\s*\(shift\+tab to cycle\)/, "");
}

/** Where /memory reads from. */
function memoryPath(ws) {
  return ws.replace(/[\\/]$/, "") + "/CLOSENI.md";
}

/** "Plan with this": a research answer handed to plan mode. */
function researchPlanPrompt(answer) {
  return "Using this research, plan how to apply it to this project:\n\n" + (answer || "").slice(0, 6000);
}

/**
 * How a typed line is routed, for everything that is not a slash command.
 *
 * A build request in a mode that cannot build goes to Build instead. What the
 * agent receives is the mode's job above the user's words; the transcript
 * shows only the words. Returns { mode, switched, research, wire, shown }:
 * `research` is the query when the line is a search, and `wire` is empty when
 * there is nothing to send.
 */
function routeLine(mode, text, shownAs) {
  var t = String(text || "").trim();
  var switched = "";
  if ((mode === "research" || mode === "ship") && !shownAs && V.looksLikeBuild(t)) {
    switched = "That asks for something to be built, so Build mode is on (it was " + mode + "; shift+tab to change)";
    mode = "build";
  }
  if (mode === "research" && !shownAs) {
    return { mode: mode, switched: switched, research: t, wire: "", shown: t };
  }
  var wire = shownAs ? t : V.modePrompt(mode, t);
  return { mode: mode, switched: switched, research: "", wire: wire || "", shown: shownAs || t || "review, test and commit" };
}

/**
 * Prompt history. Up from the end starts at the newest entry; down past the
 * newest leaves history (index -1) with an empty line.
 */
function historyUp(history, index) {
  var i = index === -1 ? history.length - 1 : Math.max(0, index - 1);
  return { index: i, text: history[i] };
}

function historyDown(history, index) {
  var i = index + 1;
  if (i >= history.length) return { index: -1, text: "" };
  return { index: i, text: history[i] };
}

export {
  numberDiff,
  todoBox,
  todosVisible,
  PLAN_OFFER_OPTIONS,
  MODEBAR,
  buildModeInfo,
  buildModeProgress,
  testModeInfo,
  shipModeInfo,
  checksSummary,
  testRow,
  failingChecks,
  fixChecksPrompt,
  gitDiffLineClass,
  permissionAnswerLabel,
  doneOutcome,
  rewoundNote,
  compactedNote,
  metaText,
  toggleNote,
  modeNote,
  memoryPath,
  researchPlanPrompt,
  routeLine,
  historyUp,
  historyDown,
};
