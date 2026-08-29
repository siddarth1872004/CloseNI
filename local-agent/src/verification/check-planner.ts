/**
 * What should we run to verify this step?
 *
 * The interesting decision is scope. Python and JS have a genuine per-file
 * syntax check, which is why the old code could answer one file at a time.
 * Rust and Java are module-aware: a .rs file containing `mod utils;` fails on
 * its own even when the crate is perfect. Checking it alone would report a
 * failure the model then burns its retries trying to fix.
 *
 * So a manifest claims its language. Cargo.toml means one `cargo check` and no
 * per-file rustc at all.
 *
 * planChecks is pure - it takes a resolver rather than probing - so every
 * decision below is tested on a machine with none of these compilers installed.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveTool } from "./toolchain.js";

export type ToolResolver = (name: string) => string | null;

export interface Check {
  command: string;
  /** "project" runs once for the whole workspace; "file" runs per changed file. */
  scope: "file" | "project";
  language: string;
  timeoutMs: number;
  /**
   * What kind of wrong this catches. "syntax" means it does not parse or does
   * not compile; "types" means it does both and is still wrong.
   *
   * Reported separately because they read differently to a user: a syntax
   * failure is the model producing nonsense, a type failure is the model
   * producing plausible code with a real bug in it.
   */
  kind?: "syntax" | "types";
}

export const FILE_CHECK_TIMEOUT_MS = 15000;
/** cargo check on a first run downloads and compiles the dependency tree. */
export const PROJECT_CHECK_TIMEOUT_MS = 180000;
/** mypy is slower than py_compile, and slowest on the first run of a project. */
export const TYPE_CHECK_TIMEOUT_MS = 60000;

interface ManifestRule {
  /** Root-level file that triggers this rule, or a suffix when `bySuffix`. */
  file: string;
  /** Match by file extension instead of exact name: a .csproj is named after
   *  the project, so there is no fixed filename to look for. */
  bySuffix?: boolean;
  tool: string;
  /** Built from the resolved tool name. */
  command: (tool: string) => string;
  language: string;
  /** Extensions this manifest takes responsibility for. */
  extensions: string[];
}

const MANIFESTS: ManifestRule[] = [
  { file: "Cargo.toml", tool: "cargo", command: (t) => t + " check", language: "rust", extensions: [".rs"] },
  { file: "pom.xml", tool: "mvn", command: (t) => t + " -q compile", language: "java", extensions: [".java"] },
  { file: "build.gradle", tool: "gradle", command: (t) => t + " compileJava -q", language: "java", extensions: [".java"] },
  { file: "build.gradle.kts", tool: "gradle", command: (t) => t + " compileJava -q", language: "java", extensions: [".java"] },
  // -n is a dry run: it proves the Makefile parses and its targets resolve
  // without building anything. A real make would drop object files and binaries
  // into the user's workspace, which is more than a check should do.
  { file: "Makefile", tool: "make", command: (t) => t + " -n", language: "c", extensions: [".c", ".h", ".cpp", ".hpp", ".cc"] },
  { file: "go.mod", tool: "go", command: (t) => t + " build ./...", language: "go", extensions: [".go"] },
  // TypeScript has Rust's problem: a file importing a sibling fails on its own,
  // so a project with a tsconfig is checked once as a project.
  { file: "tsconfig.json", tool: "tsc", command: (t) => t + " --noEmit", language: "typescript", extensions: [".ts", ".tsx"] },
  { file: ".csproj", bySuffix: true, tool: "dotnet", command: (t) => t + " build", language: "csharp", extensions: [".cs"] },
];

interface FileRule {
  extensions: string[];
  tool: string;
  language: string;
  command: (tool: string, file: string, tmpDir: string) => string;
}

const FILE_RULES: FileRule[] = [
  { extensions: [".py"], tool: "python", language: "python", command: (t, f) => t + ' -m py_compile "' + f + '"' },
  { extensions: [".js", ".cjs", ".mjs"], tool: "node", language: "javascript", command: (t, f) => t + ' --check "' + f + '"' },
  { extensions: [".c", ".h"], tool: "gcc", language: "c", command: (t, f) => t + ' -fsyntax-only "' + f + '"' },
  { extensions: [".cpp", ".cc", ".hpp"], tool: "gxx", language: "cpp", command: (t, f) => t + ' -fsyntax-only "' + f + '"' },
  // --crate-type lib so a file without `fn main` is not rejected for lacking
  // one; a file that has one still compiles as a library. --out-dir keeps the
  // .rmeta out of the user's source tree.
  {
    extensions: [".rs"], tool: "rustc", language: "rust",
    command: (t, f, tmp) => t + ' --edition 2021 --crate-type lib --emit=metadata --out-dir "' + tmp + '" "' + f + '"',
  },
  // -d for the same reason: .class files beside the sources would mean the
  // check modified the project it was inspecting.
  { extensions: [".java"], tool: "javac", language: "java", command: (t, f, tmp) => t + ' -d "' + tmp + '" "' + f + '"' },
  // gofmt -e reports syntax errors and writes nothing, which is what a check
  // wants: `go vet` needs a package, and `go build` needs a module.
  { extensions: [".go"], tool: "gofmt", language: "go", command: (t, f) => t + ' -e "' + f + '"' },
  { extensions: [".ts", ".tsx"], tool: "tsc", language: "typescript",
    command: (t, f) => t + ' --noEmit --skipLibCheck "' + f + '"' },
  { extensions: [".rb"], tool: "ruby", language: "ruby", command: (t, f) => t + ' -c "' + f + '"' },
  { extensions: [".php"], tool: "php", language: "php", command: (t, f) => t + ' -l "' + f + '"' },
  { extensions: [".sh", ".bash"], tool: "bash", language: "shell", command: (t, f) => t + ' -n "' + f + '"' },
  // No per-file rule for .cs: there is no single-file C# syntax checker worth
  // relying on, so it is verified through its project file or not at all.
];

/**
 * Checks that run IN ADDITION to the syntax rule above, not instead of it.
 *
 * Only Python is here, and the list being one entry long is the finding rather
 * than an omission. NEXT.md asked for "mypy, tsc --strict, cargo clippy"; two of
 * those would be wrong:
 *
 *   - `tsc --noEmit` already runs, and it honours the project's OWN tsconfig.
 *     Forcing --strict would override what the project's author configured and
 *     fail code that is correct by its own rules.
 *   - `cargo check` already catches type errors. Clippy adds lint, which is a
 *     different thing and would have a step burning repair attempts on style.
 *
 * Python is the real gap: py_compile checks that a file parses and nothing
 * else, so a whole class of error walks straight through the only language this
 * app generates most often.
 */
const TYPE_RULES: FileRule[] = [
  {
    extensions: [".py"], tool: "mypy", language: "python",
    // Every flag here is load-bearing:
    //
    //   --ignore-missing-imports  Without it, `import flask` fails with "Cannot
    //     find implementation or library stub", so EVERY step of a Flask
    //     project would fail on a missing type stub rather than on its code.
    //     That one omission would make this feature actively harmful.
    //   --follow-imports=silent   Resolve sibling modules for type information
    //     but report nothing inside them. Otherwise step 6 fails over something
    //     step 2 wrote, and the repair loop asks the model to fix a file it was
    //     never shown.
    //   --cache-dir               mypy drops a .mypy_cache directory into the
    //     working directory otherwise, and a check must not leave things in the
    //     project it is inspecting.
    //   --no-error-summary        "Found 3 errors in 1 file" adds nothing to a
    //     message that has just listed all three.
    command: (t, f, tmp) =>
      t + ' --ignore-missing-imports --follow-imports=silent --no-error-summary' +
      ' --cache-dir "' + tmp + '/mypy" "' + f + '"',
  },
];

function extensionOf(filePath: string): string {
  const name = filePath.replace(/\\/g, "/").split("/").pop() || "";
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

export function planChecks(
  changedPaths: string[],
  rootEntries: string[],
  resolve: ToolResolver,
  tmpDir: string,
): Check[] {
  const checks: Check[] = [];
  const present = new Set(rootEntries || []);
  const changed = Array.from(new Set(changedPaths || []));

  // A manifest claims its extensions whether or not its tool is installed.
  // Falling back to per-file checks for a crate would produce exactly the false
  // failures this design exists to prevent, so a missing cargo means no Rust
  // check at all rather than a misleading one.
  const claimed = new Set<string>();
  for (const rule of MANIFESTS) {
    const found = rule.bySuffix
      ? (rootEntries || []).some((e) => String(e).toLowerCase().endsWith(rule.file))
      : present.has(rule.file);
    if (!found) continue;
    for (const ext of rule.extensions) claimed.add(ext);

    // Running cargo check because a README changed is waste.
    const touched = changed.some((p) => rule.extensions.includes(extensionOf(p)));
    if (!touched) continue;

    const tool = resolve(rule.tool);
    if (!tool) continue;
    const command = rule.command(tool);
    if (checks.some((c) => c.command === command)) continue;
    checks.push({ command: command, scope: "project", language: rule.language, timeoutMs: PROJECT_CHECK_TIMEOUT_MS, kind: "syntax" });
  }

  for (const filePath of changed) {
    const ext = extensionOf(filePath);
    if (claimed.has(ext)) continue;
    const rule = FILE_RULES.find((r) => r.extensions.includes(ext));
    if (!rule) continue;
    const tool = resolve(rule.tool);
    if (!tool) continue;
    checks.push({
      command: rule.command(tool, filePath, tmpDir),
      scope: "file",
      language: rule.language,
      timeoutMs: FILE_CHECK_TIMEOUT_MS,
      kind: "syntax",
    });
  }

  // Type checks run after, and in addition to, the syntax pass. Ordering is
  // deliberate: a file that does not parse produces a type-checker error about
  // the parse, and reporting that as a type failure would send the model
  // looking for a bug that is really a typo.
  for (const filePath of changed) {
    const ext = extensionOf(filePath);
    if (claimed.has(ext)) continue;
    const rule = TYPE_RULES.find((r) => r.extensions.includes(ext));
    if (!rule) continue;
    const tool = resolve(rule.tool);
    // Absent means skipped, not failed. mypy is not installed on most machines,
    // and a build that refuses to run without it would be worse than one that
    // checks a little less.
    if (!tool) continue;
    checks.push({
      command: rule.command(tool, filePath, tmpDir),
      scope: "file",
      language: rule.language,
      timeoutMs: TYPE_CHECK_TIMEOUT_MS,
      kind: "types",
    });
  }

  return checks;
}

/**
 * The impure shell: read the workspace root, make somewhere for compiler
 * artifacts to land, then defer every decision to the pure function above.
 */
export function planChecksForWorkspace(
  workspace: string,
  changedPaths: string[],
  resolve?: ToolResolver,
): Check[] {
  let rootEntries: string[] = [];
  try {
    rootEntries = fs.readdirSync(workspace);
  } catch {
    /* an unreadable workspace simply has no manifests */
  }
  // rustc --out-dir does not create the directory; javac -d does. Making it
  // here covers both.
  const tmpDir = path.join(os.tmpdir(), "closeni-checks");
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
  } catch {
    /* a check that cannot write its artifacts will report that itself */
  }
  // The resolver is a parameter so a build can hand in one that prefers its own
  // virtualenv. Checking code with the system interpreter after installing its
  // dependencies into a venv finds none of them.
  return planChecks(changedPaths, rootEntries, resolve || resolveTool, tmpDir);
}
