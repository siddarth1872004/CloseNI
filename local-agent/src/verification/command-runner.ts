import { spawn, spawnSync } from "child_process";
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
}

export function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number = 15000,
  options: RunOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let finished = false;
    let hasErrorOutput = false;

    const env = Object.assign({}, process.env);
    if (command.includes("python")) {
      env.PYTHONIOENCODING = "utf-8";
    }

    const proc = spawn(command, { cwd: cwd, shell: true, env: env });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);

    proc.stdout.on("data", (d) => { 
      const text = d.toString();
      stdout += text; 
      if (/error|traceback|exception|cannot find module|syntaxerror/i.test(text)) hasErrorOutput = true;
    });
    proc.stderr.on("data", (d) => { 
      stderr += d.toString(); 
      hasErrorOutput = true;
    });

    proc.on("error", (e) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ command: command, success: false, output: String(e), timedOut: timedOut });
    });

    proc.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const output = (stdout + "\n" + stderr).trim();
      
      if (timedOut && !hasErrorOutput && !options.timeoutIsFailure) {
        resolve({ 
          command: command, 
          success: true, 
          output: "[Process ran for " + (timeoutMs/1000) + "s with no errors. Assuming it's a running server/background task.] \n" + output, 
          timedOut: true 
        });
        return;
      }

      resolve({ 
        command: command, 
        success: code === 0 && !timedOut, 
        output: output, 
        timedOut: timedOut 
      });
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

export function detectSyntaxChecks(filePath: string): string[] {
  if (filePath.endsWith(".py")) {
    const python = resolvePythonCommand();
    // Better to skip the check than to emit a command that can never succeed.
    return python ? [python + " -m py_compile \"" + filePath + "\""] : [];
  }
  if (filePath.endsWith(".js")) {
    return ["node --check \"" + filePath + "\""];
  }
  return [];
}
