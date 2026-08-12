/*
 * Does the project actually work?
 *
 * The syntax checks in check-planner prove a file parses and a project
 * compiles. That is a real bar and it catches most of what a model gets wrong,
 * but it says nothing about behaviour: a Flask app whose every route raises,
 * a parser that returns the wrong shape, a server that exits the moment it
 * starts - all of it compiles.
 *
 * Two things are worth asking that compilation cannot answer:
 *
 *   1. Does the project's own test suite pass? If the project has tests, they
 *      are a far better statement of intent than anything inferable from here.
 *   2. Does the thing start at all? A surprising share of generated projects
 *      fail on the first line of main - a missing import, a config read at
 *      module scope - and a smoke run finds that in seconds.
 *
 * Planning is separated from running, exactly as check-planner does, so the
 * decisions are testable without a workspace, a toolchain or a clock.
 */

export type ToolResolver = (name: string) => string | null;

export interface BehaviourCheck {
  /** "test" runs the project's suite; "smoke" starts it and watches. */
  kind: "test" | "smoke";
  command: string;
  language: string;
  timeoutMs: number;
  /** The executable this needs, for reporting when it is absent. */
  tool?: string;
  /**
   * False when the suite exists but its runner does not.
   *
   * Reported rather than dropped. Silently omitting it means a project with a
   * real test suite and no pytest looks identical to a project with no tests,
   * and the run claims a clean pass on the strength of a smoke check alone -
   * which is exactly the false confidence this module exists to remove.
   */
  available?: boolean;
  /**
   * A long-running process is the expected outcome, not a hang.
   *
   * A web server that is still up when the timer expires has passed; a script
   * that is still going has probably wedged. Only the smoke check for a server
   * sets this, and the runner reads it instead of treating every timeout as a
   * failure.
   */
  survivesTimeout?: boolean;
}

/** Long enough for a cold dependency graph, short enough to not look hung. */
export const TEST_TIMEOUT_MS = 300000;
/** A process that has not fallen over in this long is up. */
export const SMOKE_TIMEOUT_MS = 12000;

interface TestRule {
  /** Root entry that triggers the rule. */
  file: string;
  tool: string;
  command: (tool: string) => string;
  language: string;
  /**
   * Some manifests only mean "tests exist" in combination with something else -
   * a package.json is not a test suite unless it declares a test script.
   */
  requires?: (manifest: any) => boolean;
}

/*
 * Ordered: the first rule whose file is present wins, so a polyglot repo runs
 * one suite rather than every suite it could plausibly have. Running them all
 * would turn one failing language into a build that never reports.
 */
const TEST_RULES: TestRule[] = [
  {
    file: "package.json", tool: "npm", language: "javascript",
    command: (t) => t + " test --silent",
    // "npm test" with no test script exits 1 with "missing script", which reads
    // as a failing suite when the truth is that there is no suite.
    requires: (m) => !!(m && m.scripts && typeof m.scripts.test === "string" && m.scripts.test.trim()),
  },
  { file: "Cargo.toml", tool: "cargo", command: (t) => t + " test", language: "rust" },
  { file: "go.mod", tool: "go", command: (t) => t + " test ./...", language: "go" },
  { file: "pom.xml", tool: "mvn", command: (t) => t + " -q test", language: "java" },
  { file: "build.gradle", tool: "gradle", command: (t) => t + " test -q", language: "java" },
  { file: "pytest.ini", tool: "pytest", command: (t) => t + " -q", language: "python" },
  { file: "pyproject.toml", tool: "pytest", command: (t) => t + " -q", language: "python" },
  { file: "setup.cfg", tool: "pytest", command: (t) => t + " -q", language: "python" },
  { file: "Gemfile", tool: "rspec", command: (t) => t + " --format progress", language: "ruby" },
  { file: "composer.json", tool: "phpunit", command: (t) => t, language: "php" },
];

/** Directories that mean "there are Python tests here" without a manifest. */
const PYTHON_TEST_DIRS = ["tests", "test"];

/**
 * Does this project have any tests yet?
 *
 * Asked before running a suite during a build, and it is not a nicety. A
 * project with a pyproject.toml matches the pytest rule from step one, but
 * `pytest -q` with nothing to collect exits 5 - which reads as a failing suite.
 * Without this, every step before the first test was written would fail its
 * test check, and the repair loop would spend its attempts asking the model to
 * fix a suite that does not exist.
 *
 * Names only, deliberately: reading files to find out whether they contain
 * tests would be slower and no more certain. Every convention here is one the
 * language's own runner uses for discovery.
 */
export function hasTestFiles(paths: string[]): boolean {
  return (paths || []).some((raw) => {
    const p = String(raw || "").replace(/\\/g, "/");
    if (!p) return false;
    const segments = p.split("/");
    const name = segments[segments.length - 1] || "";
    // A tests/ or test/ directory anywhere in the path.
    if (segments.slice(0, -1).some((d) => PYTHON_TEST_DIRS.includes(d.toLowerCase()))) return true;
    if (/^test_.+\.py$/i.test(name) || /_test\.py$/i.test(name)) return true;
    if (/\.(test|spec)\.(js|jsx|ts|tsx|mjs|cjs)$/i.test(name)) return true;
    if (/_test\.go$/i.test(name)) return true;
    if (/Test\.java$/.test(name) || /Tests\.cs$/.test(name)) return true;
    if (/_spec\.rb$/i.test(name) || /Test\.php$/.test(name)) return true;
    return false;
  });
}

/**
 * A command that starts a server rather than running to completion.
 *
 * Matters because the two have opposite success conditions: a script that is
 * still running after the smoke window is suspect, a server that is *not* is
 * broken. Judged from the command because that is all there is before running
 * it - and erring towards "server" only on strong signals, since treating a
 * script as a server would call a hang a pass.
 */
export function looksLikeServer(command: string): boolean {
  const c = String(command || "").toLowerCase();
  if (!c.trim()) return false;
  return /\b(runserver|flask\s+run|uvicorn|gunicorn|hypercorn|daphne|waitress-serve)\b/.test(c)
    || /\bnpm\s+(run\s+)?(start|dev|serve)\b/.test(c)
    || /\b(next|vite|nodemon|http\.server|serve)\b/.test(c)
    || /\brails\s+s(erver)?\b/.test(c)
    || /\bphp\s+-S\b/.test(c)
    || /\bdotnet\s+run\b/.test(c);
}

/**
 * What to run to find out whether this project behaves.
 *
 * `rootEntries` is the workspace root listing, `readManifest` reads and parses
 * a root JSON file (returning null when absent or unparseable), `resolve` maps
 * a tool name to an executable or null, and `runCommand` is the project's own
 * run command from closeni.run.json when there is one.
 *
 * Returns an empty list rather than inventing work: a project with no tests and
 * no run command has nothing here that could be checked honestly.
 */
export function planBehaviourChecks(
  rootEntries: string[],
  readManifest: (file: string) => any,
  resolve: ToolResolver,
  runCommand: string | null,
): BehaviourCheck[] {
  const out: BehaviourCheck[] = [];
  const present = new Set((rootEntries || []).map((e) => String(e)));

  // --- the project's own suite, at most one ---
  let sawSuite = false;
  for (const rule of TEST_RULES) {
    if (!present.has(rule.file)) continue;
    if (rule.requires && !rule.requires(readManifest(rule.file))) continue;
    sawSuite = true;
    // A missing toolchain does not fail the project - the machine not having
    // pytest is not the code being wrong - but it is reported, not dropped.
    const tool = resolve(rule.tool);
    out.push({
      kind: "test", language: rule.language, timeoutMs: TEST_TIMEOUT_MS,
      tool: rule.tool, available: !!tool,
      command: tool ? rule.command(tool) : rule.command(rule.tool),
    });
    break;
  }

  // A tests/ directory with no manifest at all is still a Python suite.
  if (!sawSuite && PYTHON_TEST_DIRS.some((d) => present.has(d))) {
    const tool = resolve("pytest");
    out.push({
      kind: "test", language: "python", timeoutMs: TEST_TIMEOUT_MS,
      tool: "pytest", available: !!tool,
      command: (tool || "pytest") + " -q",
    });
  }

  // --- does it start ---
  const run = String(runCommand || "").trim();
  if (run) {
    out.push({
      kind: "smoke",
      command: run,
      language: "run",
      timeoutMs: SMOKE_TIMEOUT_MS,
      survivesTimeout: looksLikeServer(run),
    });
  }

  return out;
}

/**
 * Turn a finished run into a verdict.
 *
 * Separated from the running so the rule is visible and testable: a server is
 * judged by whether it was still alive, everything else by its exit code.
 */
export function judge(
  check: BehaviourCheck,
  outcome: { success: boolean; timedOut: boolean },
): { passed: boolean; detail: string } {
  if (check.kind === "smoke" && check.survivesTimeout) {
    // Still running when the window closed is exactly what a server should do.
    if (outcome.timedOut) return { passed: true, detail: "still running after " + Math.round(check.timeoutMs / 1000) + "s" };
    return { passed: false, detail: "exited instead of staying up" };
  }
  if (outcome.timedOut) return { passed: false, detail: "timed out" };
  return { passed: outcome.success, detail: outcome.success ? "passed" : "failed" };
}
