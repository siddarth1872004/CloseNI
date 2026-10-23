/*
 * Reading a research answer.
 *
 * Apart from index.ts so these can be tested without starting the CLI -
 * requiring the entry point runs main(), which is the same reason follow-up.ts
 * exists.
 */

/** Does this provider offer a web-search control at all? */
export function hasSearchControl(config: any): boolean {
  const controls = (config && config.controls) || [];
  return controls.some((c: any) => c && c.id === "smart-search");
}

export const RESEARCH_PROMPT_PREFIX =
  "Research question. Search the web and answer from what you find.\n\n" +
  "Give a short factual answer first, then list the sources you used as plain " +
  "URLs, one per line, under a line reading SOURCES:. Do not write code unless " +
  "the question asks for it.\n\nQuestion: ";

/**
 * Pull the URLs the model cited out of its answer.
 *
 * Best-effort and deliberately forgiving: a missing SOURCES block means an
 * answer with no links, not a failed research run. Falls back to any URL in the
 * text, because models put citations inline about half the time.
 */
export function extractSources(answer: string): string[] {
  const text = String(answer || "");
  const marker = text.search(/^\s*SOURCES:/im);
  const region = marker === -1 ? text : text.slice(marker);
  const urls = region.match(/https?:\/\/[^\s)\]<>"']+/g) || [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    // Trailing punctuation belongs to the sentence, not the URL.
    const url = raw.replace(/[.,;:]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out.slice(0, 20);
}
