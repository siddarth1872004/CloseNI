/**
 * What a suggested command is, and what that means for the build.
 *
 * Written after a real run auto-executed `sudo apt install` and
 * `curl ... | python3` with no confirmation, then failed the whole build - and
 * blocked fourteen perfectly good steps - because a virtualenv could not be
 * created on that machine.
 */

/**
 * Commands that always ask, whatever the autonomy setting says.
 *
 * "Auto-allow" is about not being interrupted for `pytest` and `npm run build`.
 * It was never meant to mean "install system packages as root" or "download a
 * script and pipe it into an interpreter". Those need a human every time.
 */
const ALWAYS_CONFIRM = [
  /\bsudo\b/,
  /\bsu\b\s/,
  /\bapt(-get)?\b/,
  /\bdnf\b|\byum\b|\bpacman\b|\bapk\b|\bbrew\b/,
  /\brm\s+-[a-z]*[rf]/,
  /\bdd\s+if=/,
  /\bmkfs\b/,
  /\bchmod\s+(-[a-zA-Z]+\s+)*777\b/,
  /\bchown\b/,
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /\bcurl\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|python3?|node|perl|ruby)\b/,
  /\bwget\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|python3?|node|perl|ruby)\b/,
  />\s*\/dev\/(sd|nvme|disk)/,
  /\bgit\s+push\b.*--force(?!-with-lease)/,
];

/**
 * Environment setup: creating a virtualenv, installing dependencies, adding
 * system packages.
 *
 * When one of these fails it is a fact about the machine, not about the code the
 * model just wrote. Failing the step for it is how a PEP 668 error on one
 * developer's laptop blocked fourteen steps whose files had already passed
 * their syntax checks.
 */
const ENVIRONMENT_SETUP = [
  /\bpython3?\s+-m\s+venv\b/,
  /\bvirtualenv\b/,
  /\bsource\b.*\bactivate\b/,
  /\.\s+\S*\bactivate\b/,
  /\bpip3?\s+install\b/,
  /\bpoetry\s+(install|add)\b/,
  /\bpipenv\s+install\b/,
  /\bconda\s+(install|create|env)\b/,
  /\bnpm\s+(install|ci)\b(?!.*\brun\b)/,
  /\byarn\s+(install|add)\b/,
  /\bpnpm\s+(install|add)\b/,
  /\bapt(-get)?\s+(install|update)\b/,
  /\bcargo\s+(fetch|install)\b/,
  /\bgo\s+(get|mod\s+download)\b/,
  /\bbundle\s+install\b/,
];

/** Files the app writes for the project. The model must not adopt them. */
const GENERATED_FILES = ["closeni.run.json", "run.sh", "run.bat"];

export function needsConfirmation(command: string | null | undefined): boolean {
  const c = String(command || "");
  if (!c.trim()) return false;
  // Tested against the whole string rather than the first clause: a real reply
  // hid `sudo apt install` behind `apt install ... || sudo apt install ...`.
  return ALWAYS_CONFIRM.some((re) => re.test(c));
}

export function isEnvironmentSetup(command: string | null | undefined): boolean {
  const c = String(command || "");
  if (!c.trim()) return false;
  return ENVIRONMENT_SETUP.some((re) => re.test(c));
}

/**
 * Is this a file the app generates?
 *
 * Root-level only: a project's own `scripts/run.sh` is its business. The model
 * saw our generated `run.sh` in the workspace listing and started maintaining
 * it, overwriting what the app had written.
 */
export function isGeneratedFile(filePath: string | null | undefined): boolean {
  const p = String(filePath || "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (!p) return false;
  return GENERATED_FILES.indexOf(p) !== -1;
}

export { GENERATED_FILES };
