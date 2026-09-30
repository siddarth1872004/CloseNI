/*
 * The prompt for one build step.
 *
 * Moved out of index.ts so it can be tested without starting the CLI -
 * requiring the entry point runs main().
 *
 * Laid out in labelled sections, task last. Two kinds of file context go in and
 * they are labelled differently on purpose: files this step is expected to
 * change are quoted in full, in the same fenced shape the reply uses; every
 * other file is an outline and says so. A real build lost four steps because
 * an outline sat under a heading that said "use overwrite mode with FULL
 * content", and the model did exactly that - from memory.
 */

import { renderFiles } from "./follow-up.js";

export interface PromptFile {
  path: string;
  content: string;
}

export interface StepPromptInput {
  /** What to do: the overall goal and this step's instruction. */
  task: string;
  /** The project tree; only sent when the thread has not seen it. */
  tree: string;
  /** Existing files this step is expected to change, in full. */
  toEdit: PromptFile[];
  /** Outlines (signatures) of other files the step may call into. */
  outlines: PromptFile[];
  /** Paths that appeared since the last step, or all of them on the first. */
  newFiles: string[];
  /** Does the thread need the whole format specification? */
  isFirstStep: boolean;
  testable?: boolean;
  /** Facts about this machine the model has to work around. */
  environmentNotes?: string[];
  /** Files the app writes itself, which the model must leave alone. */
  generatedFiles?: string[];
}

export const EDIT_FILES_BUDGET_CHARS = 12000;

/** Said on every step: models drift, and re-stating it is cheaper than a failed step. */
export const KEEP_NAMES_RULE =
  "If you change an existing file, send it complete and keep every name it already " +
  "defines (constants, functions, classes). Other files import them. Only remove or " +
  "rename one if you also update, and send, every file that uses it.";

function section(title: string, body: string): string {
  return "\n\n### " + title + "\n" + body.replace(/^\n+/, "");
}

function contextSections(input: StepPromptInput): string {
  let out = "";
  if (input.testable) {
    // Asked for only where the plan said there is behaviour to assert. Requesting
    // tests on a scaffolding step produces a test that the config file says what
    // it says, which costs tokens and teaches everyone to skip the test output.
    out += section("Tests",
      "This step has behaviour worth testing, so include tests for it in the same " +
      "reply, as ordinary files alongside the code. Use the project's own convention - " +
      "test_<name>.py for Python, <name>.test.ts for TypeScript, and so on. Test what " +
      "the step is supposed to DO, including the edge cases; do not write a test that " +
      "only restates a constant. They will be run, and a failure will come back to you.");
  }
  if (input.tree) out += section("Project structure", input.tree);

  const editing = new Set(input.toEdit.map((f) => f.path));
  if (input.toEdit.length) {
    out += section("Files this step changes - current contents",
      "These are exactly what is on disk now. Start from them, not from memory, and " +
      "send each one back complete.\n" + renderFiles(input.toEdit, EDIT_FILES_BUDGET_CHARS));
  }
  const outlines = input.outlines.filter((f) => !editing.has(f.path));
  if (outlines.length) {
    let body = "Signatures only - NOT the full files. Use them to call into these modules. " +
      "Do not rewrite one of these files from its outline; if you must change one, keep " +
      "everything it already defines.\n";
    for (const f of outlines) body += "\n--- " + f.path + " (outline) ---\n" + f.content + "\n";
    out += section("Other existing files", body);
  }
  if (input.newFiles.length) {
    // After the first step the thread already holds the earlier listing, so only
    // what appeared since is worth the tokens.
    out += section(input.isFirstStep ? "Files already in the workspace" : "New files since the last step",
      "Do not recreate these or collapse them into one another.\n" +
      input.newFiles.map((f) => "- " + f).join("\n"));
  }
  const notes = (input.environmentNotes || []).filter(Boolean);
  if (notes.length) out += section("Environment on this machine", notes.map((n) => "- " + n).join("\n"));
  return out;
}

export function buildStepPrompt(input: StepPromptInput): string {
  const context = contextSections(input);
  const generated = input.generatedFiles || [];

  // The format specification runs to about two thousand characters and used to
  // be repeated on every single step, because each step was talking to a thread
  // that had never seen it. In one conversation it is said once and then
  // referred back to. A short reminder still goes with each step: models drift,
  // and re-stating the shape is cheaper than a re-ask.
  if (!input.isFirstStep) {
    return "Next step. Same reply format as before - either the " +
      "{\"files\":[{\"path\",\"mode\",\"content\"}]} JSON block, or one code block per " +
      "file with the path on the fence line. Write every file completely; no " +
      "ellipses and no '... rest unchanged'.\n" + KEEP_NAMES_RULE +
      context +
      section("Step", input.task);
  }

  return "You are an autonomous coding agent assistant.\n" +
    "Reply with the file changes. There are two accepted formats. Pick ONE.\n" +
    "\n" +
    "FORMAT A - JSON (preferred, and required if you need commands or search_replace):\n" +
    "{\n  \"files\": [\n    {\n      \"path\": \"src/hello.py\",\n      \"mode\": \"create\",\n      \"content\": \"def greet():\\n    return 'Hello'\\n\"\n    }\n  ],\n  \"commands\": [\"python src/hello.py\"]\n}\n" +
    "Wrap it in one ```json code block. No prose before or after it.\n" +
    "Inside \"content\": literal \\n for newlines, exact whitespace preserved,\n" +
    "and mode must be one of create, overwrite, search_replace.\n" +
    "\n" +
    // Escaping a few hundred lines of code into a JSON string is where these
    // replies break, and a model that cannot manage it produces something
    // unparseable rather than asking for another way. Naming the alternative
    // is what stops that: this format is read natively, not as a rescue.
    "FORMAT B - one code block per file, when the code is long enough that JSON\n" +
    "escaping would be error-prone. Put the path on the fence line itself:\n" +
    "```python src/hello.py\n" +
    "def greet():\n" +
    "    return 'Hello'\n" +
    "```\n" +
    "One block per file, the complete file in each, no JSON at all.\n" +
    "\n" +
    "RULES THAT APPLY TO BOTH:\n" +
    "- Write every file COMPLETELY. Never abbreviate with '# ... rest unchanged',\n" +
    "  '// existing code here', ellipses, or a comment standing in for real code.\n" +
    "  A partial file overwrites the real one and destroys work.\n" +
    "- Do not mix the two formats in one reply.\n" +
    "- If the step is too large to write out fully, write fewer files completely\n" +
    "  rather than all of them partially.\n" +
    "- " + KEEP_NAMES_RULE + "\n" +
    "CRITICAL ARCHITECTURE RULE:\n" +
    "- Follow clean separation of concerns. Each file has a single responsibility.\n" +
    "- DO NOT collapse multiple modules into one file.\n" +
    "- DO NOT reuse or overwrite files that are not related to the current step.\n" +
    // Deliberately short. This prompt is terse because unparseable replies have
    // cost whole builds before; more prose means more chance the model explains
    // itself outside the code fence.
    "CODE QUALITY:\n" +
    "- Handle errors and validate input. Do not write happy-path-only code.\n" +
    "- Docstrings on public functions. Comments explain why, not what.\n" +
    "- Avoid needless passes, quadratic loops over large inputs, and repeated I/O.\n" +
    "- The project must be runnable: keep requirements.txt / package.json in step with what the code imports.\n" +
    "- Pin only versions that install on the Python / Node in use; prefer a minimum (>=) over an exact pin.\n" +
    (generated.length ? "- DO NOT create or edit " + generated.join(", ") + " — the app generates those.\n" : "") +
    "- Do not add commands that create virtualenvs or install packages unless the step is specifically about that.\n" +
    context +
    section("User request", input.task);
}
