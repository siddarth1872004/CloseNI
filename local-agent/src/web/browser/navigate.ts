/**
 * Getting a page to a URL and knowing whether it got there.
 *
 * "networkidle" is never waited for: chat applications hold a socket or a poll
 * open forever, so it either never arrives or arrives on a timer that means
 * nothing. Navigation waits for DOMContentLoaded, and readiness is a separate,
 * explicit question answered by the caller's own predicate - the UI state
 * detector for a provider, a content check for a research page.
 */
import { Page } from "playwright";
import { ManagedPage } from "./session-manager.js";
import { Tracer, quietTracer } from "../trace.js";
import { nowMs, sleep } from "../util.js";

export type NavErrorKind = "timeout" | "dns" | "refused" | "blocked" | "tls" | "aborted" | "crash" | "http" | "unknown";

export interface NavOutcome {
  ok: boolean;
  url: string;
  finalUrl: string;
  status?: number;
  redirected: boolean;
  /** Ended on a different host than asked for - a login redirect looks like this. */
  crossHost: boolean;
  durationMs: number;
  attempts: number;
  errorKind?: NavErrorKind;
  error?: string;
}

/**
 * What kind of failure a Playwright navigation error is.
 *
 * Pure, so each branch is tested against the real error strings. The kinds are
 * chosen by what the caller should do next: a timeout is worth retrying, a DNS
 * failure is not, and a proxy refusal is a fact about the network rather than
 * the site - the distinction the test matrix records as BLOCKED.
 */
export function classifyNavError(message: string): NavErrorKind {
  const m = String(message || "");
  if (/Timeout \d+ms exceeded|TimeoutError|timeout/i.test(m)) return "timeout";
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i.test(m)) return "dns";
  if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_BLOCKED_BY|ERR_UNSAFE_PORT|403 Forbidden.*proxy|net::ERR_ACCESS_DENIED/i.test(m)) return "blocked";
  if (/ERR_CONNECTION_REFUSED|ECONNREFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE/i.test(m)) return "refused";
  if (/ERR_CERT|SSL|TLS/i.test(m)) return "tls";
  if (/ERR_ABORTED|frame was detached|Navigation.*interrupted/i.test(m)) return "aborted";
  if (/crash|Target (page, context or browser )?has been closed|Target closed/i.test(m)) return "crash";
  return "unknown";
}

/** Retrying these cannot help. */
function terminal(kind: NavErrorKind): boolean {
  return kind === "dns" || kind === "blocked" || kind === "tls" || kind === "crash";
}

export interface NavigateOptions {
  timeoutMs?: number;
  retries?: number;
  tracer?: Tracer;
  /** Treat HTTP >= 400 as a failure. On by default; a 404 page is not the page asked for. */
  httpErrorsFail?: boolean;
}

export async function navigate(mp: ManagedPage, url: string, opts: NavigateOptions = {}): Promise<NavOutcome> {
  const tracer = opts.tracer || quietTracer();
  const timeoutMs = opts.timeoutMs ?? 30000;
  const retries = opts.retries ?? 1;
  const start = nowMs();
  mp.intendedUrl = url;
  let lastErr = "";
  let lastKind: NavErrorKind = "unknown";
  let attempts = 0;

  for (let attempt = 0; attempt <= retries; attempt++) {
    attempts++;
    if (!mp.healthy()) {
      lastKind = "crash";
      lastErr = "page is " + (mp.crashed ? "crashed" : "closed");
      break;
    }
    try {
      const res = await mp.page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      const finalUrl = mp.page.url();
      const status = res ? res.status() : undefined;
      const outcome: NavOutcome = {
        ok: !(opts.httpErrorsFail !== false && status !== undefined && status >= 400),
        url, finalUrl, status,
        redirected: stripHash(finalUrl) !== stripHash(url),
        crossHost: hostOf(finalUrl) !== hostOf(url),
        durationMs: nowMs() - start,
        attempts,
      };
      if (!outcome.ok) { outcome.errorKind = "http"; outcome.error = "HTTP " + status; }
      tracer.event({ action: "navigation", result: outcome.ok ? "success" : "failure", url, durationMs: outcome.durationMs,
        detail: (outcome.redirected ? "redirected to " + finalUrl + " " : "") + (status ? "HTTP " + status : ""), error: outcome.error });
      return outcome;
    } catch (err: any) {
      lastErr = String(err && err.message || err).split("\n")[0];
      lastKind = classifyNavError(lastErr);
      tracer.event({ action: "navigation-attempt", result: "failure", url, error: lastErr, detail: "kind=" + lastKind + " attempt=" + attempts });
      if (terminal(lastKind)) break;
      await sleep(500 * (attempt + 1));
    }
  }
  const outcome: NavOutcome = {
    ok: false, url, finalUrl: safeUrl(mp.page), redirected: false, crossHost: false,
    durationMs: nowMs() - start, attempts, errorKind: lastKind, error: lastErr,
  };
  tracer.event({ action: "navigation", result: "failure", url, durationMs: outcome.durationMs, error: lastErr, detail: "kind=" + lastKind });
  return outcome;
}

/**
 * Poll a predicate until it holds. The primitive every "is it ready" check is
 * built from, instead of a fixed sleep. A predicate that throws counts as
 * "not yet" - pages are mid-render more often than they are broken.
 */
export async function waitFor(page: Page, predicate: () => Promise<boolean>, opts: { timeoutMs: number; intervalMs?: number }): Promise<boolean> {
  const deadline = nowMs() + opts.timeoutMs;
  const interval = opts.intervalMs ?? 250;
  while (nowMs() < deadline) {
    if (page.isClosed()) return false;
    try { if (await predicate()) return true; } catch { /* not yet */ }
    await sleep(interval);
  }
  try { return await predicate(); } catch { return false; }
}

function stripHash(u: string): string { return String(u || "").replace(/#.*$/, "").replace(/\/$/, ""); }
function hostOf(u: string): string { try { return new URL(u).host; } catch { return ""; } }
function safeUrl(p: Page): string { try { return p.url(); } catch { return ""; } }
