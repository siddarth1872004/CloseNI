/*
 * What to say to the model when a step did not work.
 *
 * Kept apart from index.ts so the wording can be tested without starting the
 * CLI - requiring the entry point runs main().
 */

/**
 * The retry for changes that could not be applied at all.
 *
 * Distinct from a test failure, and the distinction matters: nothing ran, so
 * there is no root cause to fix and no traceback to read. Sending the generic
 * "your code failed when tested, fix the root cause, do not silence it with
 * try/except" invites the model to rewrite working logic in answer to a problem
 * that was entirely about how the edit was addressed.
 *
 * A real run missed six of seven search blocks and recovered only because the
 * generic follow-up happened to prompt whole files. This asks for that
 * deliberately, names the files, and says which tactic to abandon - retrying
 * the same way is how a step burns both attempts on the same mistake.
 */
export function buildApplyFollowUp(errors: string, priorFiles: string[]): string {
  const text = String(errors || "");
  const files = Array.from(new Set(
    [...text.matchAll(/^Failed to apply ([^:]+):/gm)].map((m) => m[1].trim()),
  ));

  const searchMissed = /Search block (?:not found|appears more than once)/i.test(text);
  const abbreviated = /abbreviated file/i.test(text);
  const outside = /outside workspace/i.test(text);

  let why = "None of those edits could be applied, so nothing changed on disk.";
  if (searchMissed) {
    why = "The search_replace edits did not match the files. A search block has to " +
      "reproduce the existing text exactly, and yours did not - most likely the file " +
      "differs from what you remember of it.";
  } else if (abbreviated) {
    why = "The file was refused because it contained a placeholder such as " +
      "\"... rest of the file unchanged ...\" instead of the real contents. A partial " +
      "file would have overwritten the working one.";
  } else if (outside) {
    why = "A path pointed outside the project directory and was refused.";
  }

  const target = files.length
    ? "these files: " + files.join(", ")
    : "the files for this step";

  const instruction = outside
    ? "Use paths relative to the project root - no leading slash, no drive letter, no \"..\"."
    : "Send the COMPLETE current contents of " + target + " using mode \"overwrite\". " +
      "Do not use search_replace this time, and do not abbreviate any part of a file.";

  const priorNote = priorFiles.length
    ? "\nExisting files in this project: " + priorFiles.join(", ") +
      ". Keep them separate - do not merge unrelated files into one.\n"
    : "";

  return "The changes you sent could not be applied.\n\n" + why + "\n\n" +
    text.slice(0, 1500) + "\n\n" + instruction + "\n" + priorNote +
    "Reply with the same JSON format, wrapped in a \`\`\`json code block.";
}

