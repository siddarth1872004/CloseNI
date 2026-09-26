/**
 * Caches for the research engine, one namespace per kind of thing:
 *
 *   search    SearchResult[] per (backend, query)        short TTL: results move
 *   page      WebPage per canonical URL                   medium TTL
 *   parsed    reserved for derived representations        medium TTL
 *   chunks    Chunk[] per content hash                    long TTL: same content, same chunks
 *   evidence  Evidence[] per (content hash, subquestion)  long TTL
 *   meta      browser metadata (robots, redirects…)       long TTL
 *
 * In memory with an LRU bound, optionally mirrored to disk as JSON so a second
 * research run does not refetch what the first already read.
 *
 * Authenticated content is refused, not just "not cached by default": an entry
 * marked authenticated throws. Research fetches run in an isolated context with
 * no login, and AI provider replies are never cached here - so this refusal is
 * the guard that keeps it that way if either assumption is ever broken.
 */
import * as fs from "fs";
import * as path from "path";
import { hashText } from "../util.js";

export type CacheNamespace = "search" | "page" | "parsed" | "chunks" | "evidence" | "meta";

export const DEFAULT_TTL_MS: Record<CacheNamespace, number> = {
  search: 30 * 60 * 1000,
  page: 6 * 60 * 60 * 1000,
  parsed: 6 * 60 * 60 * 1000,
  chunks: 7 * 24 * 60 * 60 * 1000,
  evidence: 7 * 24 * 60 * 60 * 1000,
  meta: 24 * 60 * 60 * 1000,
};

interface Entry<V> { value: V; expires: number; at: number }

export class TtlCache<V> {
  private map = new Map<string, Entry<V>>();
  hits = 0;
  misses = 0;

  constructor(readonly ns: CacheNamespace, private ttlMs: number = DEFAULT_TTL_MS[ns], private maxEntries: number = 500, private dir?: string) {
    if (dir) fs.mkdirSync(path.join(dir, ns), { recursive: true });
  }

  private file(key: string): string | null {
    return this.dir ? path.join(this.dir, this.ns, hashText(key) + ".json") : null;
  }

  get(key: string, now: number = Date.now()): V | undefined {
    let e = this.map.get(key);
    if (!e) {
      const f = this.file(key);
      if (f && fs.existsSync(f)) {
        try { e = JSON.parse(fs.readFileSync(f, "utf-8")) as Entry<V>; this.map.set(key, e); } catch { e = undefined; }
      }
    }
    if (!e || e.expires <= now) {
      if (e) this.delete(key);
      this.misses++;
      return undefined;
    }
    // Refresh LRU position.
    this.map.delete(key);
    this.map.set(key, e);
    this.hits++;
    return e.value;
  }

  set(key: string, value: V, opts: { authenticated?: boolean; ttlMs?: number } = {}, now: number = Date.now()): void {
    if (opts.authenticated) throw new Error("refusing to cache authenticated content (" + this.ns + ")");
    const e: Entry<V> = { value, expires: now + (opts.ttlMs ?? this.ttlMs), at: now };
    this.map.delete(key);
    this.map.set(key, e);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value as string;
      this.delete(oldest);
    }
    const f = this.file(key);
    if (f) { try { fs.writeFileSync(f, JSON.stringify(e)); } catch { /* cache is an optimisation */ } }
  }

  delete(key: string): void {
    this.map.delete(key);
    const f = this.file(key);
    if (f) { try { fs.unlinkSync(f); } catch { /* not there */ } }
  }

  get size(): number { return this.map.size; }
}

export class ResearchCaches {
  readonly search: TtlCache<any>;
  readonly page: TtlCache<any>;
  readonly parsed: TtlCache<any>;
  readonly chunks: TtlCache<any>;
  readonly evidence: TtlCache<any>;
  readonly meta: TtlCache<any>;

  constructor(dir?: string, ttl: Partial<Record<CacheNamespace, number>> = {}) {
    const mk = (ns: CacheNamespace) => new TtlCache<any>(ns, ttl[ns] ?? DEFAULT_TTL_MS[ns], 500, dir);
    this.search = mk("search"); this.page = mk("page"); this.parsed = mk("parsed");
    this.chunks = mk("chunks"); this.evidence = mk("evidence"); this.meta = mk("meta");
  }

  stats(): Record<string, { size: number; hits: number; misses: number }> {
    const out: Record<string, { size: number; hits: number; misses: number }> = {};
    for (const c of [this.search, this.page, this.parsed, this.chunks, this.evidence, this.meta]) out[c.ns] = { size: c.size, hits: c.hits, misses: c.misses };
    return out;
  }
}
