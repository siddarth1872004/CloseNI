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
}

export const FILE_CHECK_TIMEOUT_MS = 15000;
/** cargo check on a first run downloads and compiles the dependency tree. */
export const PROJECT_CHECK_TIMEOUT_MS = 180000;

interface ManifestRule {
  /** Root-level file that triggers this rule. */
  file: string;
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
    if (!present.has(rule.file)) continue;
    for (const ext of rule.extensions) claimed.add(ext);

    // Running cargo check because a README changed is waste.
    const touched = changed.some((p) => rule.extensions.includes(extensionOf(p)));
    if (!touched) continue;

    const tool = resolve(rule.tool);
    if (!tool) continue;
    const command = rule.command(tool);
    if (checks.some((c) => c.command === command)) continue;
    checks.push({ command: command, scope: "project", language: rule.language, timeoutMs: PROJECT_CHECK_TIMEOUT_MS });
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
    });
  }

  return checks;
}

/**
 * The impure shell: read the workspace root, make somewhere for compiler
 * artifacts to land, then defer every decision to the pure function above.
 */
export function planChecksForWorkspace(workspace: string, changedPaths: string[]): Check[] {
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
  return planChecks(changedPaths, rootEntries, resolveTool, tmpDir);
}
