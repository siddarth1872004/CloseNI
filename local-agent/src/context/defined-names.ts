/*
 * Did an overwrite take away something the rest of the project still uses?
 *
 * A real build lost four steps to this. The model rewrote src/settings.py from
 * memory at step 7 and dropped BRICK_SCORE; the repair rewrote it again and
 * dropped BRICK_GAP; the next repair dropped PADDLE_MARGIN_BOTTOM and a dozen
 * more. Each time the tests reported an AttributeError somewhere else, and the
 * model - which had not been shown the file - guessed again.
 *
 * The check is deliberately narrow: a top-level name that existed before the
 * step, is gone now, and is still mentioned by a file that imports this module.
 * A rename that updated every caller is not flagged, because the callers on
 * disk no longer mention the old name.
 */

export interface SourceFile {
  path: string;
  content: string;
}

export interface DroppedName {
  name: string;
  /** Files, other than the one rewritten, that still use it. */
  usedIn: string[];
}

function isPython(p: string): boolean { return /\.py$/.test(p); }
function isScript(p: string): boolean { return /\.(js|cjs|mjs|ts|tsx|jsx)$/.test(p); }

/** Names a module defines at its top level - what another file could import. */
export function topLevelNames(src: string, filePath: string): string[] {
  const text = String(src || "");
  const out = new Set<string>();
  if (isPython(filePath)) {
    for (const line of text.split("\n")) {
      let m = line.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)/) || line.match(/^class\s+([A-Za-z_]\w*)/);
      if (!m) m = line.match(/^([A-Za-z_]\w*)\s*(?::[^=\n]*)?=(?!=)/);
      if (m && !/^__\w+__$/.test(m[1])) out.add(m[1]);
    }
  } else if (isScript(filePath)) {
    for (const line of text.split("\n")) {
      const m = line.match(/^export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/)
        || line.match(/^(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/);
      if (m) out.add(m[1]);
    }
    const obj = text.match(/module\.exports\s*=\s*\{([^}]*)\}/);
    if (obj) {
      for (const part of obj[1].split(",")) {
        const key = part.trim().match(/^([A-Za-z_$][\w$]*)/);
        if (key) out.add(key[1]);
      }
    }
  }
  return Array.from(out);
}

/** The name other files use to import this module: the file stem, or the package for __init__. */
function moduleStem(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/");
  let base = parts[parts.length - 1].replace(/\.[^.]+$/, "");
  if ((base === "__init__" || base === "index") && parts.length > 1) base = parts[parts.length - 2];
  return base;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Comments mention names too, and a stale comment is not a caller. */
function withoutComments(src: string, filePath: string): string {
  if (isPython(filePath)) return src.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "")).join("\n");
  if (isScript(filePath)) return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  return src;
}

function importsModule(other: SourceFile, stem: string): boolean {
  const s = escapeRe(stem);
  if (isPython(other.path)) {
    return new RegExp("^\\s*(?:from|import)\\b[^\\n]*\\b" + s + "\\b", "m").test(other.content);
  }
  if (isScript(other.path)) {
    return new RegExp("(?:require\\(\\s*|from\\s+|import\\s*\\(\\s*)['\"][^'\"]*\\b" + s +
      "(?:\\.[cm]?[jt]sx?)?['\"]").test(other.content);
  }
  return false;
}

/**
 * Names `before` defined that `after` does not, and that other files importing
 * this module still use. Empty for languages it does not understand - a guard
 * that guesses would fail good steps.
 */
export function findDroppedNames(
  filePath: string,
  before: string | null,
  after: string | null,
  others: SourceFile[],
): DroppedName[] {
  if (before === null || after === null) return [];
  if (!isPython(filePath) && !isScript(filePath)) return [];
  const now = new Set(topLevelNames(after, filePath));
  const gone = topLevelNames(before, filePath).filter((n) => !now.has(n));
  if (!gone.length) return [];

  const stem = moduleStem(filePath);
  const callers = (others || []).filter((o) =>
    o && o.path !== filePath && (isPython(o.path) || isScript(o.path)) && importsModule(o, stem));
  const out: DroppedName[] = [];
  for (const name of gone) {
    const re = new RegExp("\\b" + escapeRe(name) + "\\b");
    const usedIn = callers
      .filter((o) => re.test(withoutComments(o.content, o.path)))
      .map((o) => o.path)
      .sort();
    if (usedIn.length) out.push({ name: name, usedIn: usedIn });
  }
  return out;
}

/** The failure text, in the shape the rest of the repair loop passes around. */
export function describeDroppedNames(filePath: string, dropped: DroppedName[]): string {
  return "Rewriting " + filePath + " removed names other files still use:\n" +
    dropped.map((d) => "- " + d.name + " (used in " + d.usedIn.join(", ") + ")").join("\n");
}
