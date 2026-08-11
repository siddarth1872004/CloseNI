/**
 * A build that survives closing the app.
 *
 * The plan and its per-step statuses used to live only in the renderer, as
 * `let currentPlan = null`. Closing the window did not lose progress tracking -
 * it lost the plan, which is a different and worse thing: seventeen steps of
 * agreed design, gone, with the half-built project still on disk.
 *
 * Written into the workspace rather than into app state, for the same reason
 * closeni.run.json is: the answer survives this install, and the project can be
 * understood without it.
 */

export const BUILD_STATE_DIR = ".closeni";
export const BUILD_STATE_NAME = "build.json";
const BUILD_STATE_VERSION = 1;

export type StepStatus = "pending" | "running" | "done" | "failed" | "blocked" | "skipped";

export interface BuildStateStep {
  title: string;
  detail: string;
  files: string[];
  dependsOn?: number[];
  status: StepStatus;
}

export interface BuildState {
  version: number;
  summary: string;
  runCommand?: string;
  provider?: string;
  startedAt: string;
  updatedAt: string;
  steps: BuildStateStep[];
}

const STATUSES: StepStatus[] = ["pending", "running", "done", "failed", "blocked", "skipped"];

function str(v: any): string {
  return typeof v === "string" ? v : "";
}

/**
 * A step's status, as it should be read back.
 *
 * "running" becomes "pending" deliberately. A step that was running when the
 * app closed is not running now, and restoring it as such would seed the
 * scheduler with a step it waits on forever - the same reasoning that keeps
 * `running` out of seedState.
 */
function readStatus(v: any): StepStatus {
  if (v === "running") return "pending";
  return STATUSES.indexOf(v) === -1 ? "pending" : v;
}

/** What to write for the builder's current step list. */
export function serialiseBuildState(
  plan: { summary?: string; runCommand?: string } | null,
  steps: any[],
  meta: { provider?: string; startedAt?: string; now?: string },
): BuildState {
  const now = meta.now || new Date().toISOString();
  return {
    version: BUILD_STATE_VERSION,
    summary: str(plan && plan.summary),
    runCommand: str(plan && plan.runCommand) || undefined,
    provider: meta.provider || undefined,
    startedAt: meta.startedAt || now,
    updatedAt: now,
    steps: (steps || []).map((s) => ({
      title: str(s && s.title),
      detail: str(s && s.detail),
      files: Array.isArray(s && s.files) ? s.files.filter((f: any) => typeof f === "string") : [],
      // Carried across on purpose. Losing it here would do to a resumed build
      // exactly what dropping it in setPlan did to every build: turn a declared
      // graph back into a chain, so one failure blocks everything behind it.
      dependsOn: Array.isArray(s && s.dependsOn) ? s.dependsOn.slice() : undefined,
      status: readStatus(s && s.status),
    })),
  };
}

/**
 * Read a build back, or null if there is nothing usable here.
 *
 * Absent, corrupt, wrong version and empty all return null. A file we cannot
 * make sense of must leave the builder exactly as it would have been without
 * one; refusing to open a workspace because a state file is malformed would
 * make this feature worse than not having it.
 */
export function parseBuildState(raw: any): BuildState | null {
  let obj = raw;
  if (typeof raw === "string") {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  if (obj.version !== BUILD_STATE_VERSION) return null;
  if (!Array.isArray(obj.steps) || obj.steps.length === 0) return null;

  const steps: BuildStateStep[] = [];
  for (const s of obj.steps) {
    if (!s || typeof s !== "object") return null;
    steps.push({
      title: str(s.title),
      detail: str(s.detail),
      files: Array.isArray(s.files) ? s.files.filter((f: any) => typeof f === "string") : [],
      dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.slice() : undefined,
      status: readStatus(s.status),
    });
  }

  return {
    version: BUILD_STATE_VERSION,
    summary: str(obj.summary),
    runCommand: str(obj.runCommand) || undefined,
    provider: str(obj.provider) || undefined,
    startedAt: str(obj.startedAt),
    updatedAt: str(obj.updatedAt),
    steps: steps,
  };
}

/** How far along a restored build is, for the line the user reads. */
export function describeProgress(state: BuildState | null): { done: number; total: number; unfinished: boolean } {
  const steps = (state && state.steps) || [];
  const done = steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  return { done: done, total: steps.length, unfinished: steps.length > 0 && done < steps.length };
}
