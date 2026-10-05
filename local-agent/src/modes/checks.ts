/**
 * The behaviour and test-all modes: run a workspace's checks without a
 * provider.
 *
 * Split out of index.ts, which keeps the dispatcher.
 */
import * as path from "path";
import * as fs from "fs";
import { runCommand } from "../verification/command-runner.js";
import { planChecksForWorkspace } from "../verification/check-planner.js";
import { needsConfirmation } from "../verification/command-policy.js";
import { planBehaviourChecks, judge as judgeBehaviour } from "../verification/behaviour-checker.js";
import { MANIFEST_NAME } from "../run-manifest.js";
import { projLog, emit } from "../cli-io.js";
import { workspaceResolver } from "../workspace-env.js";

// Every extension the check planner knows about. A file the walker misses is a
// file nothing ever verifies, and the run reports success on it regardless.
export const SOURCE_FILE = /\.(py|pyw|js|cjs|mjs|ts|tsx|jsx|rs|go|java|c|h|cpp|hpp|cc|cxx|rb|php|sh|bash|cs)$/;

export function walk(dir: string, out: string[]) {
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (["node_modules", ".git", ".agent-backups", "__pycache__", "dist", "build", "venv", "env"].indexOf(e.name) !== -1) continue;
    if (e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (SOURCE_FILE.test(e.name)) out.push(p);
  }
}

/**
 * Run the project, not just compile it.
 *
 * testall answers "does this parse". This answers "does this work": the
 * project's own test suite if it has one, and a smoke run of whatever
 * closeni.run.json says starts it.
 *
 * Deliberately never invents a test command. A project with no suite reports
 * that it has none - claiming a pass for tests that do not exist would be worse
 * than saying nothing, because it is the number people would trust.
 */
export async function behaviourMode(workspace: string) {
  let rootEntries: string[] = [];
  try { rootEntries = fs.readdirSync(workspace); } catch { /* unreadable root */ }

  const readManifest = (file: string): any => {
    try { return JSON.parse(fs.readFileSync(path.join(workspace, file), "utf-8")); }
    catch { return null; }
  };

  // The run command the build recorded, if any. Named apart from the imported
  // runCommand(): shadowing it made the smoke run call a string.
  let projectRun: string | null = null;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(workspace, MANIFEST_NAME), "utf-8"));
    projectRun = typeof m.run === "string" && m.run.trim() ? m.run.trim() : null;
  } catch { /* no manifest, no smoke check */ }

  const checks = planBehaviourChecks(rootEntries, readManifest, workspaceResolver(workspace), projectRun);
  if (!checks.length) {
    emit({
      success: true, passed: 0, failed: 0, results: [],
      note: "Nothing to run: this project declares no test suite and no run command.",
    });
    return;
  }

  const results: { command: string; kind: string; success: boolean; language: string; detail: string }[] = [];
  let pass = 0; let fail = 0; let skipped = 0;

  for (const c of checks) {
    // A suite that exists but cannot be run is reported, not counted. Treating
    // it as a pass would be the false confidence this mode exists to remove;
    // treating it as a failure would blame the project for the machine.
    if (c.available === false) {
      console.log("SKIPPED_TEST: " + c.command + " (" + c.tool + " is not installed)");
      results.push({ command: c.command, kind: c.kind, success: false, language: c.language,
        detail: "not run: " + c.tool + " is not installed" });
      skipped++;
      continue;
    }
    // A run command can be anything the model wrote, so it goes through the
    // same floor as any other command rather than being trusted for being ours.
    if (needsConfirmation(c.command)) {
      console.log("COMMAND_NEEDS_REVIEW: " + c.command);
      results.push({ command: c.command, kind: c.kind, success: false, language: c.language,
        detail: "skipped: needs confirmation" });
      continue;
    }
    console.log("RUNNING_" + c.kind.toUpperCase() + ": " + c.command);
    const r = await runCommand(c.command, workspace, c.timeoutMs);
    const verdict = judgeBehaviour(c, { success: r.success, timedOut: !!r.timedOut });
    console.log((verdict.passed ? "PASS " : "FAIL ") + c.kind + ": " + verdict.detail);
    if (r.output) projLog(r.output.slice(0, 2000));
    results.push({ command: c.command, kind: c.kind, success: verdict.passed, language: c.language, detail: verdict.detail });
    if (verdict.passed) pass++; else fail++;
  }

  emit({
    success: fail === 0, passed: pass, failed: fail, skipped: skipped, results: results,
    // Said explicitly, because "0 failed" on a project whose suite never ran is
    // the most misleading number this could report.
    note: skipped ? skipped + " check(s) could not run; install the tool named above to include them." : undefined,
  });
}

export async function testAllMode(workspace: string) {
  const files: string[] = [];
  walk(workspace, files);
  let pass = 0; let fail = 0;
  const results: { command: string; success: boolean; language: string }[] = [];
  // Asked once, for every file at once: a per-file question cannot see that a
  // Cargo.toml means one cargo check instead of a rustc per module.
  const checks = planChecksForWorkspace(workspace, files.map((f) => path.relative(workspace, f)));
  for (const c of checks) {
    const r = await runCommand(c.command, workspace, c.timeoutMs, { timeoutIsFailure: true });
    console.log((r.success ? "PASS " : "FAIL ") + c.command);
    // The language travels with the result so the Test panel can mark each row.
    // A row's text is a command, not a path, so it has nothing to derive it from.
    results.push({ command: c.command, success: r.success, language: c.language });
    if (r.success) pass++; else { fail++; if (r.output) projLog(r.output.slice(0, 800)); }
  }
  emit({ success: fail === 0, passed: pass, failed: fail, results: results });
}
