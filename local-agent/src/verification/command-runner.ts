import { spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveTool } from "./toolchain.js";

export interface CommandResult {
  command: string;
  success: boolean;
  output: string;
  timedOut: boolean;
}

export interface RunOptions {
  /**
   * Treat a timeout as a failure. A syntax check is supposed to terminate, so
   * one that does not has told us nothing - and reporting that as a pass hides
   * exactly the case worth knowing about. Off by default, because a command the
   * model suggested may legitimately be a server that never exits.
   */
  timeoutIsFailure?: boolean;
  /**
   * Fail a pipeline when any stage fails. /bin/sh reports only the last stage,
   * so `pytest | tail` said "exit 0" over failing tests. Needs bash; where there
   * is none (Windows without Git, a bare container) the command runs as before.
   */
  pipefail?: boolean;
}

/**
 * The bash a pipefail command runs in. The agent's tool is called bash and the
 * model writes bash, so on Windows that is Git Bash when it is installed. Never
 * System32's bash.exe: that is WSL, which sees the project under other paths.
 */
export function findBash(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env,
                         exists: (p: string) => boolean = fs.existsSync): string | undefined {
  if (platform !== "win32") return ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash"].find((p) => exists(p));
  const w = path.win32;
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && w.join(env.LOCALAPPDATA, "Programs")]
    .filter((r): r is string => !!r).map((r) => w.join(r, "Git"));
  // A Git installed anywhere else puts <root>\cmd or <root>\bin on PATH.
  for (const dir of String(env.PATH || env.Path || "").split(";")) {
    if (dir && exists(w.join(dir, "git.exe"))) roots.push(w.dirname(dir));
  }
  return roots.map((r) => w.join(r, "bin", "bash.exe")).find((p) => exists(p));
}

const BASH = findBash();

/** The shell the agent's bash tool really runs in, named for the preamble. */
export function agentShell(platform: string = process.platform, bash: string | null | undefined = BASH): string {
  if (bash) return platform === "win32" ? "Git Bash" : "bash";
  return platform === "win32" ? "cmd.exe" : "sh";
}

/** How much of each end of a stream is kept; a runaway log is not held whole. */
export const KEEP_PER_END = 512 * 1024;

/** The one wording for a cut, so a later cut can add up what earlier ones dropped. */
export function omittedNote(lines: number, chars: number): string {
  return "\n\n[... " + lines + " line" + (lines === 1 ? "" : "s") + ", " + chars + " characters omitted ...]\n\n";
}
export const OMITTED_NOTE = /\n*\[\.\.\. (\d+) lines?, (\d+) characters omitted \.\.\.\]\n*/g;

function newlines(s: string): number {
  let n = 0;
  for (let i = s.indexOf("\n"); i !== -1; i = s.indexOf("\n", i + 1)) n++;
  return n;
}

/**
 * The start and the end of a stream, and a count of what fell between. `cat`
 * of a 5 GB log, or a test run stuck printing, used to be buffered whole until
 * the agent ran out of memory - only to be cut to 24 KB for the model anyway.
 */
export class KeptOutput {
  private head = "";
  private tail = "";
  private droppedChars = 0;
  private droppedLines = 0;
  constructor(private readonly keep: number = KEEP_PER_END) {}

  add(s: string): void {
    if (this.head.length < this.keep) {
      const n = this.keep - this.head.length;
      this.head += s.slice(0, n);
      s = s.slice(n);
    }
    if (!s) return;
    this.tail += s;
    // Trim only once the tail is twice its size, so a flood of small chunks
    // is not re-sliced on every one.
    if (this.tail.length > this.keep * 2) {
      const gone = this.tail.length - this.keep;
      this.droppedChars += gone;
      this.droppedLines += newlines(this.tail.slice(0, gone));
      this.tail = this.tail.slice(gone);
    }
  }

  text(): string {
    if (!this.droppedChars) return this.head + this.tail;
    // Cut on line ends, as cap() does, so the count is of whole lines.
    let head = this.head, tail = this.tail, lines = this.droppedLines, chars = this.droppedChars;
    const h = head.lastIndexOf("\n");
    if (h !== -1) { chars += head.length - h - 1; head = head.slice(0, h); }
    const t = tail.indexOf("\n");
    if (t !== -1) { chars += t + 1; lines += 1; tail = tail.slice(t + 1); }
    return head + omittedNote(lines, chars) + tail;
  }
}

/*
 * Every command runs in its own process group, so it can be stopped whole.
 * Killing only the shell left `sleep 20; echo x`, a pipeline or a dev server
 * running - and still holding the output pipe, so the call never returned.
 *
 * `running` is what is in flight; `background` is what a finished command left
 * behind (`npm run dev &`), kept so a later command can talk to it and stopped
 * when the session ends or the process exits.
 */
const running = new Set<() => void>();
const background = new Set<number>();
const GROUPS = process.platform !== "win32";
let exitHooked = false;

function alive(pid: number): boolean {
  try { process.kill(GROUPS ? -pid : pid, 0); return true; } catch { return false; }
}

/** Stop a command and everything it started: TERM first, KILL if it lingers. */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (!GROUPS) {
    try { spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch { /* gone */ }
    return;
  }
  try { process.kill(-pid, "SIGTERM"); } catch { return; }
  const hard = setTimeout(() => { try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ } }, 2000);
  hard.unref();
}

/** Stop the commands in flight. Their calls return with what they printed. */
export function stopRunning(): number {
  const n = running.size;
  for (const stop of Array.from(running)) stop();
  return n;
}

/** Stop what finished commands left running in the background. */
export function stopBackground(): number {
  let n = 0;
  for (const pid of Array.from(background)) {
    background.delete(pid);
    if (!alive(pid)) continue;
    n++;
    killTree(pid);
  }
  return n;
}

function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  const all = () => {
    for (const stop of Array.from(running)) stop();
    // At exit there is no later tick for the SIGKILL, so it goes now.
    for (const pid of Array.from(background)) { try { process.kill(GROUPS ? -pid : pid, "SIGKILL"); } catch { /* gone */ } }
  };
  process.on("exit", all);
  // A signal ends Node without an "exit" event: clean up, then die of it as
  // before, once the handler is out of the way.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as NodeJS.Signals[]) {
    process.once(sig, () => { all(); process.kill(process.pid, sig); });
  }
}

export function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number = 15000,
  options: RunOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const stdout = new KeptOutput();
    const stderr = new KeptOutput();
    let timedOut = false;
    let stopped = false;
    let finished = false;
    let hasErrorOutput = false;
    let exitCode: number | null = null;

    const env = Object.assign({}, process.env);
    if (command.includes("python")) {
      env.PYTHONIOENCODING = "utf-8";
      // py_compile writes a __pycache__ beside every file it checks, so the
      // syntax check alone left bytecode in the project it was inspecting - and
      // a Python project with no requirements.txt never gets the .gitignore
      // entry that would hide it, so the git export then refused the tree as
      // dirty. Python 3.8+ writes the cache here instead; older ones ignore it.
      if (!env.PYTHONPYCACHEPREFIX) env.PYTHONPYCACHEPREFIX = path.join(os.tmpdir(), "closeni-pycache");
    }

    hookExit();
    const bash = options.pipefail ? BASH : undefined;
    const proc = bash
      ? spawn(bash, ["-o", "pipefail", "-c", command], { cwd: cwd, env: env, detached: GROUPS, windowsHide: true })
      : spawn(command, { cwd: cwd, shell: true, env: env, detached: GROUPS, windowsHide: true });
    const pid = proc.pid;

    const stop = () => { stopped = true; killTree(pid); };
    running.add(stop);

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(pid);
    }, timeoutMs);

    // Decoded by the stream, so a character split across two chunks survives.
    // Read to the end even after the call returns: a server left in the
    // background dies of a broken pipe the first time it logs otherwise.
    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (text: string) => {
      if (finished) return;
      stdout.add(text);
      if (/error|traceback|exception|cannot find module|syntaxerror/i.test(text)) hasErrorOutput = true;
    });
    proc.stderr.on("data", (text: string) => {
      if (finished) return;
      stderr.add(text);
      hasErrorOutput = true;
    });

    proc.on("error", (e) => {
      if (finished) return;
      finished = true;
      running.delete(stop);
      clearTimeout(timer);
      resolve({ command: command, success: false, output: String(e), timedOut: timedOut });
    });

    const done = () => {
      if (finished) return;
      finished = true;
      running.delete(stop);
      clearTimeout(timer);
      // Whatever is still in the group was put in the background on purpose.
      if (GROUPS && pid && !timedOut && !stopped && alive(pid)) background.add(pid);
      let output = (stdout.text() + "\n" + stderr.text()).trim();
      if (stopped) output = (output + "\n[stopped by the user]").trim();

      if (timedOut && !hasErrorOutput && !options.timeoutIsFailure) {
        resolve({ 
          command: command, 
          success: true, 
          output: "[Process ran for " + (timeoutMs/1000) + "s with no errors, so it was taken to be a server and stopped.] \n" + output, 
          timedOut: true 
        });
        return;
      }

      resolve({ 
        command: command, 
        // 141 is a stage killed by SIGPIPE: `cat log | head` stopping early,
        // which pipefail would otherwise call a failure.
        success: (exitCode === 0 || (bash !== undefined && exitCode === 141)) && !timedOut && !stopped, 
        output: output, 
        timedOut: timedOut 
      });
    };

    // "close" waits for every holder of the pipe, and a background child is
    // one; the shell's own exit is the end of the command.
    proc.on("exit", (code) => {
      exitCode = code;
      setTimeout(done, 300).unref();
    });
    proc.on("close", (code) => {
      if (exitCode === null) exitCode = code;
      done();
    });
  });
}

// "python" only exists on Windows and on old Linux installs; elsewhere it is
// "python3". Guessing wrong makes every Python step fail its syntax check with
// "python: not found" and burn its retries on perfectly good code. The probing
// itself now lives in toolchain.ts, where every other compiler needs it too.
export function resolvePythonCommand(): string | null {
  return resolveTool("python");
}

let pythonAliasMissing: boolean | undefined;

function commandAvailable(command: string): boolean {
  try {
    return spawnSync(command + " --version", { shell: true, stdio: "ignore", timeout: 10000 }).status === 0;
  } catch {
    return false;
  }
}

// Models habitually suggest `python ...`, which does not exist on most Linux and
// macOS installs. Left alone it fails with "python: not found", and the agent
// spends a self-heal retry on the interpreter name instead of the real bug.
export function normalizeCommand(command: string): string {
  const python = resolvePythonCommand();
  if (!python || python === "python") return command;
  if (pythonAliasMissing === undefined) pythonAliasMissing = !commandAvailable("python");
  if (!pythonAliasMissing) return command;
  return command.replace(/(^|[\s;&|(])python(?=\s|$)/g, "$1" + python);
}

// detectSyntaxChecks used to live here, answering one file at a time. It was
// deleted rather than kept alongside the planner: a per-file-only API sitting
// next to a manifest-aware one is an invitation to call the wrong one, and the
// wrong one reports false failures on any Rust or Java project.
