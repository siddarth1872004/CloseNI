/**
 * Whether a tool call may run, must ask, or is refused.
 *
 * Four modes, cycled from the input box:
 *   default      reading is free; edits and commands ask
 *   acceptEdits  edits run; commands still ask
 *   plan         read-only - edits and commands are refused, not asked
 *   auto         everything runs
 *
 * Under every mode sits the floor the builder already had: sudo, package
 * managers, recursive deletes, piping a download into a shell and the rest of
 * command-policy's list always ask, and "don't ask again" is never offered
 * for them. Auto means "stop interrupting me for pytest", not "run anything".
 */
import { needsConfirmation } from "../verification/command-policy.js";
import { Mode, ToolCall } from "./protocol.js";
import { isReadOnly } from "./tools.js";

export interface SessionRules {
  /** Every edit and write this session, after "yes, and don't ask again". */
  editAll: boolean;
  /** Command prefixes allowed for the session, such as "npm test" or "pytest". */
  commands: string[];
}

export function emptyRules(): SessionRules {
  return { editAll: false, commands: [] };
}

export type Decision =
  | { action: "allow" }
  | { action: "ask"; alwaysAsk: boolean; rememberAs?: string }
  | { action: "deny"; reason: string };

// For these, the command alone says little: "npm" could be "npm test" or
// "npm publish". The second word is kept in the remembered prefix.
const TWO_WORD = new Set(["npm", "npx", "yarn", "pnpm", "bun", "git", "cargo", "go", "python", "python3", "pip", "pip3", "node", "deno", "dotnet", "mvn", "gradle", "make", "docker", "uv", "poetry", "bundle", "rake"]);

/** Each command in a compound one: a && b, a; b, a | b, a || b. */
export function clauses(command: string): string[] {
  return command.split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter(Boolean);
}

/** The prefix a "don't ask again" answer remembers for one command. */
export function prefixOf(command: string): string {
  const words = command.trim().replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, "").split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  if (TWO_WORD.has(words[0]) && words[1] && !words[1].startsWith("-")) return words[0] + " " + words[1];
  return words[0];
}

function allowedByRules(command: string, rules: SessionRules): boolean {
  const parts = clauses(command);
  if (!parts.length) return false;
  return parts.every((p) => rules.commands.some((pre) => p === pre || p.startsWith(pre + " ")));
}

export function decide(call: ToolCall, mode: Mode, rules: SessionRules): Decision {
  if (isReadOnly(call.tool)) return { action: "allow" };

  if (mode === "plan") {
    return { action: "deny", reason: "plan mode is read-only; " + call.tool + " is not available until plan mode is turned off" };
  }

  if (call.tool === "write" || call.tool === "edit") {
    if (mode === "acceptEdits" || mode === "auto" || rules.editAll) return { action: "allow" };
    return { action: "ask", alwaysAsk: false, rememberAs: "edits" };
  }

  if (call.tool === "bash") {
    const command = String(call.input.command || "");
    if (needsConfirmation(command)) return { action: "ask", alwaysAsk: true };
    if (mode === "auto" || allowedByRules(command, rules)) return { action: "allow" };
    const prefixes = Array.from(new Set(clauses(command).map(prefixOf).filter(Boolean)));
    return { action: "ask", alwaysAsk: false, rememberAs: prefixes.join(", ") };
  }

  return { action: "ask", alwaysAsk: true };
}

/** Record "yes, and don't ask again" for this call. */
export function remember(call: ToolCall, rules: SessionRules): void {
  if (call.tool === "write" || call.tool === "edit") { rules.editAll = true; return; }
  if (call.tool === "bash") {
    const command = String(call.input.command || "");
    if (needsConfirmation(command)) return;
    for (const p of clauses(command).map(prefixOf)) if (p && rules.commands.indexOf(p) === -1) rules.commands.push(p);
  }
}

export function nextMode(mode: Mode): Mode {
  // The order the input box cycles through, as shift+tab does in a terminal
  // agent: normal, then accept edits, then plan, then back. Auto is chosen
  // deliberately, from the menu or /mode, never reached by cycling past it.
  if (mode === "default") return "acceptEdits";
  if (mode === "acceptEdits") return "plan";
  return "default";
}
