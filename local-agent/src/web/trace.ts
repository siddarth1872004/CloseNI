/**
 * Structured, redacted tracing for everything the browser layer does.
 *
 * Every navigation, selector resolution, prompt, wait and extraction becomes one
 * event with the same fields, so a failed run can be read back as a timeline
 * rather than reconstructed from prose log lines.
 *
 * Redaction is applied here, at the one place events are written, rather than
 * trusted to every caller. A caller that forgets is the normal case, not the
 * exception - the GitHub token rules in HANDOFF.md exist for the same reason.
 * Cookies, bearer tokens, authorization headers, and credential-shaped query
 * parameters never reach a sink.
 */
import * as fs from "fs";
import * as path from "path";
import { nowMs } from "./util.js";

export type TraceResult = "success" | "failure" | "info" | "skipped";

export interface TraceEvent {
  ts: string;
  session: string;
  provider?: string;
  page?: string;
  action: string;
  selector?: string;
  url?: string;
  durationMs?: number;
  result: TraceResult;
  detail?: string;
  error?: string;
  data?: Record<string, unknown>;
}

/** Query parameters whose values are credentials in practice. */
const SECRET_PARAM = /^(token|access_token|id_token|refresh_token|auth|authorization|key|api_key|apikey|secret|password|passwd|pwd|session|sessionid|sid|sig|signature|code|state|jwt|cookie)$/i;

/** Remove userinfo and credential-shaped query values from a URL. */
export function redactUrl(raw: string): string {
  const s = String(raw || "");
  let u: URL;
  try { u = new URL(s); } catch { return redactText(s); }
  if (u.username || u.password) { u.username = ""; u.password = ""; }
  for (const k of Array.from(u.searchParams.keys())) {
    if (SECRET_PARAM.test(k)) u.searchParams.set(k, "REDACTED");
  }
  return u.toString();
}

/**
 * Redact credential-shaped substrings from free text.
 *
 * Patterns, not a list of known secrets: a new token format that looks like a
 * token still gets caught, and nothing here needs to know what the real values
 * are - which means nothing here can leak them.
 */
export function redactText(raw: string): string {
  return String(raw == null ? "" : raw)
    .replace(/(authorization|cookie|set-cookie|x-api-key|proxy-authorization)\s*[:=]\s*[^\n]+/gi, "$1: REDACTED")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, "Bearer REDACTED")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "REDACTED_TOKEN")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "REDACTED_JWT")
    .replace(/([?&](?:token|access_token|key|api_key|password|session|sid|sig|signature|auth)=)[^&\s#]+/gi, "$1REDACTED")
    .replace(/"(password|token|secret|cookie|authorization)"\s*:\s*"[^"]*"/gi, "\"$1\":\"REDACTED\"");
}

function redactEvent(e: TraceEvent): TraceEvent {
  const out: TraceEvent = { ...e };
  if (out.url) out.url = redactUrl(out.url);
  if (out.detail) out.detail = redactText(out.detail).slice(0, 2000);
  if (out.error) out.error = redactText(out.error).split("\n")[0].slice(0, 600);
  if (out.selector) out.selector = out.selector.slice(0, 300);
  if (out.data) {
    // Values only ever pass through as text, and through the same filter.
    out.data = JSON.parse(redactText(JSON.stringify(out.data)));
  }
  return out;
}

/** One line a person can scan: [11:32:41] [QWEN] [navigation] URL=… duration=1840ms status=success */
export function formatEvent(e: TraceEvent): string {
  const t = e.ts.slice(11, 19);
  const parts = ["[" + t + "]"];
  if (e.provider) parts.push("[" + e.provider.toUpperCase() + "]");
  parts.push("[" + e.action + "]");
  if (e.url) parts.push("URL=" + e.url);
  if (e.selector) parts.push("selector=" + JSON.stringify(e.selector));
  if (typeof e.durationMs === "number") parts.push("duration=" + e.durationMs + "ms");
  parts.push("status=" + e.result);
  if (e.detail) parts.push(e.detail);
  if (e.error) parts.push("error=" + JSON.stringify(e.error));
  return parts.join(" ");
}

export interface TracerOptions {
  session?: string;
  /** Append JSON lines here. */
  file?: string;
  /** Print formatted lines to stdout as they happen. */
  echo?: boolean;
  /** Extra consumer, e.g. a test collecting events. */
  sink?: (e: TraceEvent) => void;
}

const MAX_BUFFER = 5000;

export class Tracer {
  private buffer: TraceEvent[];
  private readonly base: Partial<TraceEvent>;

  constructor(private opts: TracerOptions = {}, base: Partial<TraceEvent> = {}, shared?: TraceEvent[]) {
    this.base = { session: opts.session || "session-" + Date.now().toString(36), ...base };
    this.buffer = shared || [];
    if (opts.file) fs.mkdirSync(path.dirname(opts.file), { recursive: true });
  }

  get session(): string { return String(this.base.session); }

  /** A tracer whose events carry these fields too - one per provider or page. */
  child(fields: Partial<TraceEvent>): Tracer {
    const t = new Tracer(this.opts, { ...this.base, ...fields }, this.buffer);
    return t;
  }

  event(e: Partial<TraceEvent> & { action: string; result: TraceResult }): TraceEvent {
    const full = redactEvent({ ts: new Date().toISOString(), ...this.base, ...e } as TraceEvent);
    this.buffer.push(full);
    if (this.buffer.length > MAX_BUFFER) this.buffer.splice(0, this.buffer.length - MAX_BUFFER);
    if (this.opts.file) {
      try { fs.appendFileSync(this.opts.file, JSON.stringify(full) + "\n"); } catch { /* tracing never breaks a run */ }
    }
    if (this.opts.echo) console.log(formatEvent(full));
    if (this.opts.sink) { try { this.opts.sink(full); } catch { /* same */ } }
    return full;
  }

  /**
   * Time an action and record how it ended. The error is re-thrown unchanged:
   * tracing observes failures, it does not decide what they mean.
   */
  async span<T>(action: string, fields: Partial<TraceEvent>, fn: () => Promise<T>,
    describe?: (value: T) => Partial<TraceEvent>): Promise<T> {
    const start = nowMs();
    try {
      const value = await fn();
      this.event({ ...fields, ...(describe ? describe(value) : {}), action, result: "success", durationMs: nowMs() - start });
      return value;
    } catch (err: any) {
      this.event({ ...fields, action, result: "failure", durationMs: nowMs() - start, error: String(err && err.message || err) });
      throw err;
    }
  }

  events(filter?: (e: TraceEvent) => boolean): TraceEvent[] {
    return filter ? this.buffer.filter(filter) : this.buffer.slice();
  }
}

/** A tracer that records in memory and prints nothing - the default. */
export function quietTracer(session?: string): Tracer {
  return new Tracer({ session });
}
