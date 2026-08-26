/**
 * What goes in front of a step's prompt, and what gets cut when it will not fit.
 *
 * Order is the decision: persona, then skills, then MCP context, then the task.
 * Who you are, how to work, what is true, what to do - and the task last,
 * because it is what the model should still be reading when it starts to
 * generate.
 *
 * The budget exists because this project has lost whole builds to replies the
 * parser could not read. A persona plus three skills plus a fetched page of
 * documentation can put thousands of characters between the model and the JSON
 * formatting instruction. So `base` is never truncated at any budget - it
 * carries that instruction - and everything else is cut lowest-priority first
 * and REPORTED, because silently sending a smaller prompt than the user
 * configured is how a setting stops meaning anything.
 */

export const PREAMBLE_BUDGET_CHARS = 6000;

export interface PromptParts {
  persona?: string;
  skills?: string[];
  mcpContext?: string[];
  base: string;
}

export interface Composed {
  text: string;
  /** Names of the parts that did not fit, in the order they were dropped. */
  truncated: string[];
}

function clean(v: string | undefined | null): string {
  return typeof v === "string" ? v.trim() : "";
}

function cleanList(v: string[] | undefined | null): string[] {
  return (Array.isArray(v) ? v : []).map(clean).filter(Boolean);
}

export function composePrompt(parts: PromptParts | null | undefined, budget?: number): Composed {
  const p = parts || ({ base: "" } as PromptParts);
  const base = typeof p.base === "string" ? p.base : "";
  const limit = Number.isFinite(budget as number) && (budget as number) > 0
    ? Math.floor(budget as number)
    : PREAMBLE_BUDGET_CHARS;

  let persona = clean(p.persona);
  let skills = cleanList(p.skills);
  let mcpContext = cleanList(p.mcpContext);
  const truncated: string[] = [];

  // Only what is PREPENDED counts against the budget. Including base would mean
  // a long task silently deleting the user's persona, which is the opposite of
  // the intent: base is the thing being protected, not the thing competing.
  const size = () =>
    (persona ? persona.length + 2 : 0) +
    skills.reduce((a, s) => a + s.length + 2, 0) +
    mcpContext.reduce((a, s) => a + s.length + 2, 0);

  // Lowest priority first: context is the most replaceable, persona the least.
  if (size() > limit && mcpContext.length) { mcpContext = []; truncated.push("mcp context"); }
  if (size() > limit && skills.length) { skills = []; truncated.push("skills"); }
  if (size() > limit && persona) { persona = ""; truncated.push("persona"); }

  const blocks = ([] as string[])
    .concat(persona ? [persona] : [])
    .concat(skills)
    .concat(mcpContext)
    .concat([base]);

  return { text: blocks.join("\n\n"), truncated: truncated };
}
