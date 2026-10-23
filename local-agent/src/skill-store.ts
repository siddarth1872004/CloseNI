/**
 * Personas and skills, as plain Markdown files.
 *
 * A persona is a stance; a skill is a practice. Both are a paragraph of prose,
 * and inventing frontmatter, a registry or versioning around a paragraph would
 * be the larger commitment. The filename is the display name.
 *
 * Under the same user data directory the desktop app uses, so a headless run
 * and the app see the same skills - the mistake fixed on 11 August, where the
 * app and the CLI read two different browser profiles and only one of them was
 * signed in.
 */
import * as fs from "fs";
import * as path from "path";

export function skillsDir(root: string): string {
  return path.join(root, "skills");
}

export function personasDir(root: string): string {
  return path.join(root, "personas");
}

/**
 * Is this a name we will turn into a path?
 *
 * Refused rather than sanitised. A sanitised name silently reads or writes a
 * different file than the one asked for, and the name arrives from the
 * renderer. A leading dot is refused too: a skill called ".gitignore" is not a
 * traversal, but it is a hidden file the user cannot see in their own
 * directory listing.
 */
export function isSafeName(name: string): boolean {
  const n = String(name || "").trim();
  if (!n) return false;
  if (n.includes("/") || n.includes("\\")) return false;
  if (n.startsWith(".")) return false;
  return /^[A-Za-z0-9._-]+$/.test(n);
}

/** Display names of the .md files in a directory, sorted, without extensions. */
export function listMarkdown(dir: string): string[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // A directory that does not exist yet is a user who has written no skills,
    // not an error worth surfacing.
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
    .map((e) => e.name.slice(0, -3))
    .filter(isSafeName)
    .sort();
}

/** The contents of the named files, in the order given, skipping any that fail. */
export function readSelected(dir: string, names: string[]): string[] {
  const out: string[] = [];
  for (const name of names || []) {
    if (!isSafeName(name)) continue;
    try {
      const text = fs.readFileSync(path.join(dir, name + ".md"), "utf-8").trim();
      if (text) out.push(text);
    } catch {
      // A selected skill whose file has been deleted is a stale checkbox, not a
      // reason to fail a build.
    }
  }
  return out;
}
