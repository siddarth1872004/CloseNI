/**
 * The agent's stdin and stdout: one line reader shared by approvals and
 * sessions, and the AGENT_OUTPUT framing every mode answers in.
 *
 * Split out of index.ts, which keeps the dispatcher.
 */
import * as readline from "readline";
import { decideApproval } from "./verification/approval-policy.js";
import { cleanError } from "./clean-error.js";

export const rl = readline.createInterface({ input: process.stdin, terminal: false });
const lineQueue: string[] = [];
let lineWaiter: ((l: string) => void) | null = null;
// Build sessions take their commands on the same stdin the approval flow reads.
// A second reader would mean step commands land in the approval queue and the
// next askApproval would parse one, find no `approved` field, and deny the
// command. One reader, dispatching by content, avoids that entirely.
let sessionLineHandler: ((line: string) => boolean) | null = null;
export function setSessionLineHandler(h: ((line: string) => boolean) | null): void { sessionLineHandler = h; }
rl.on("line", (line) => {
  if (sessionLineHandler && sessionLineHandler(line)) return;
  if (lineWaiter) { const w = lineWaiter; lineWaiter = null; w(line); }
  else lineQueue.push(line);
});
rl.on("close", () => {
  if (lineWaiter) { const w = lineWaiter; lineWaiter = null; w('{"approved":false}'); }
});
export function readLine(): Promise<string> {
  if (lineQueue.length) return Promise.resolve(lineQueue.shift()!);
  return new Promise((res) => (lineWaiter = res));
}

export function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

export async function askApproval(command: string, cwd: string, autonomy: string): Promise<boolean> {
  const decision = decideApproval(autonomy);
  if (decision === "allow") return true;
  // A policy denial takes the same path as a user denial, so the caller's
  // COMMAND_DENIED log and the self-heal path treat both identically.
  if (decision === "deny") return false;
  console.log("APPROVAL_REQUEST:" + JSON.stringify({ command: command, cwd: cwd }));
  const line = await readLine();
  try { return !!JSON.parse(line).approved; } catch { return false; }
}

export function projLog(text: string) {
  for (const l of text.split("\n")) console.log("PROJ|" + l);
}

export function emit(obj: any) {
  if (obj && typeof obj.error === "string") obj.error = cleanError(obj.error);
  console.log("AGENT_OUTPUT_START");
  console.log(JSON.stringify(obj));
  console.log("AGENT_OUTPUT_END");
}

export function capText(t: string, n: number): string {
  return t.length > n ? t.slice(t.length - n) : t;
}
