/**
 * What the model needs to know about this machine to install things on it.
 *
 * "Platform: linux" alone sent the model to apt-get on an Arch machine, and to
 * a system pip that PEP 668 refuses. Naming the distribution, its package
 * manager and a locked system Python saves those wasted rounds.
 */
import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

const PACKAGE_MANAGERS: Record<string, string[]> = {
  linux: ["pacman", "apt-get", "dnf", "zypper", "apk", "xbps-install", "emerge", "nix-env"],
  darwin: ["brew", "port"],
  win32: ["winget", "choco", "scoop"],
};

function onPath(name: string, platform: string): boolean {
  const exts = platform === "win32" ? [".exe", ".cmd", ".bat"] : [""];
  return (process.env.PATH || "").split(path.delimiter).some((dir) =>
    dir && exts.some((e) => { try { return fs.statSync(path.join(dir, name + e)).isFile(); } catch { return false; } }));
}

/** The distribution's own name, from /etc/os-release. */
export function osName(osRelease: string): string {
  const field = (k: string) => {
    const m = osRelease.match(new RegExp("^" + k + "=(.*)$", "m"));
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  };
  return field("PRETTY_NAME") || field("NAME");
}

/** The system Python's version and whether it refuses pip installs (PEP 668). */
function systemPython(platform: string): { version: string; managed: boolean } | null {
  if (platform === "win32") return null;
  try {
    const r = spawnSync("python3", ["-c", "import sys,sysconfig;print('%d.%d' % sys.version_info[:2]);print(sysconfig.get_path('stdlib'))"],
      { encoding: "utf-8", timeout: 5000 });
    if (r.status !== 0) return null;
    const [version, stdlib] = String(r.stdout).trim().split("\n");
    return { version: version, managed: !!stdlib && fs.existsSync(path.join(stdlib, "EXTERNALLY-MANAGED")) };
  } catch {
    return null;
  }
}

let cached: string | undefined;

/** One line for the preamble, or "" when there is nothing worth saying. */
export function describeMachine(platform: string = process.platform): string {
  if (cached !== undefined && platform === process.platform) return cached;
  const facts: string[] = [];
  if (platform === "linux") {
    try { const os = osName(fs.readFileSync("/etc/os-release", "utf-8")); if (os) facts.push("OS: " + os + "."); } catch { /* not every Linux has it */ }
  }
  const pm = (PACKAGE_MANAGERS[platform] || []).find((n) => onPath(n, platform));
  if (pm) facts.push("System package manager: " + pm + ".");
  const py = systemPython(platform);
  if (py) {
    facts.push("System Python: " + py.version + "." + (py.managed
      ? " It is externally managed (PEP 668), so pip install into it fails: make a venv first (python3 -m venv .venv) and use .venv/bin/pip."
      : ""));
  }
  const line = facts.join(" ");
  if (platform === process.platform) cached = line;
  return line;
}
