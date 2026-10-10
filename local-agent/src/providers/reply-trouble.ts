/**
 * What a provider puts where a reply should be when it cannot answer.
 *
 * DeepSeek does not fail with an HTTP error most of the time. A busy server,
 * a rate limit or a full conversation arrive as an ordinary 200 stream that
 * ends with a final message status (INCOMPLETE, CONTEXT_LENGTH_EXCEEDED, ...)
 * or with a `hint` / `toast` event, and the page shows a line of text such as
 * "Server busy, please try again later." where the answer would be. Read as
 * a reply, that line - or the half-written answer above it - became the
 * model's answer.
 *
 * Every string, status and selector comes from the provider config
 * (`replyErrors`, `selectors.replySignals`), measured on the live site; this
 * module only classifies what the controller saw and says what to do.
 */

export type TroubleKind = "busy" | "rate-limit" | "full" | "refused" | "too-long" | "signed-out";

export interface ReplyErrorRules {
  /** The reply's final message status -> what it means. */
  statuses?: Record<string, TroubleKind>;
  /** Text the provider shows instead of a reply, as case-insensitive regex sources. */
  texts?: Array<{ kind: TroubleKind; match: string }>;
  /** The newest item of the conversation, read for `texts` once a reply ends. */
  notice?: string;
  /** Removed from `notice` before reading it: the reply itself and the prompt. */
  noticeExclude?: string;
  /** A page URL that means the account is signed out. */
  signedOutUrl?: string;
  /** Waits before each resend of a busy or failed reply; its length is the retry count. */
  retryBackoffMs?: number[];
  /** The same for a rate limit. */
  rateLimitBackoffMs?: number[];
}

/** What the in-page tap read from the reply stream. */
export interface ReplySignals {
  status: string;
  notices: string[];
}

export interface Trouble {
  kind: TroubleKind;
  /** The provider's own words, or the status / HTTP code, for the message. */
  detail: string;
}

export interface TroubleInput {
  url?: string;
  httpStatus?: number;
  signals?: ReplySignals;
  pageNotice?: string;
}

/** A hint/toast event's data is JSON; what matters is its text. */
function noticeText(raw: string): string {
  try {
    const d = JSON.parse(raw);
    if (d && typeof d.content === "string") return d.content;
  } catch { /* not JSON: use it as it is */ }
  return raw;
}

function byText(text: string, rules: ReplyErrorRules): Trouble | null {
  const t = (text || "").trim();
  if (!t) return null;
  for (const r of rules.texts || []) {
    try { if (new RegExp(r.match, "i").test(t)) return { kind: r.kind, detail: t.split("\n")[0].slice(0, 200) }; }
    catch { /* a bad pattern in config matches nothing */ }
  }
  return null;
}

/**
 * Null when nothing is wrong. Checked most certain first: the URL, the HTTP
 * status, the stream's final status, its notices, then the page's text.
 */
export function classifyTrouble(input: TroubleInput, rules: ReplyErrorRules | undefined): Trouble | null {
  if (!rules) return null;
  if (input.url && rules.signedOutUrl) {
    try { if (new RegExp(rules.signedOutUrl).test(input.url)) return { kind: "signed-out", detail: input.url }; } catch { /* ignore */ }
  }
  const code = Number(input.httpStatus);
  if (code === 401 || code === 403) return { kind: "signed-out", detail: "HTTP " + code };
  if (code === 429) return { kind: "rate-limit", detail: "HTTP 429" };
  if (code >= 500 && code < 600) return { kind: "busy", detail: "HTTP " + code };
  const sig = input.signals;
  if (sig) {
    // A notice names the cause better than the status does ("Server busy"
    // rather than INCOMPLETE), so it is tried first.
    for (const n of sig.notices) {
      const text = noticeText(n);
      const hit = byText(text, rules);
      if (hit) return hit;
    }
    const kind = sig.status && rules.statuses ? rules.statuses[sig.status] : undefined;
    if (kind) {
      const said = sig.notices.map(noticeText).filter(Boolean)[0];
      return { kind: kind, detail: said || sig.status };
    }
    // An error notice nobody listed still means no reply came.
    for (const n of sig.notices) {
      try { const d = JSON.parse(n); if (d && d.type === "error" && d.content) return { kind: "busy", detail: String(d.content).slice(0, 200) }; } catch { /* ignore */ }
    }
  }
  return byText(input.pageNotice || "", rules);
}

/** How long to wait before resend number `attempt` (0-based), or null to give up. */
export function backoffFor(kind: TroubleKind, attempt: number, rules: ReplyErrorRules | undefined): number | null {
  const r = rules || {};
  let plan: number[] = [];
  if (kind === "busy") plan = r.retryBackoffMs || [];
  else if (kind === "rate-limit") plan = r.rateLimitBackoffMs || [];
  // A filter can trip on a harmless prompt; once more, then it stands.
  else if (kind === "refused") plan = (r.retryBackoffMs || []).slice(0, 1);
  return attempt < plan.length ? plan[attempt] : null;
}

/** What the person is told. `tries` is how many times the prompt was sent. */
export function describeTrouble(t: Trouble, tries: number, provider: string): string {
  const said = /^(HTTP \d+|[A-Z_]+)$/.test(t.detail) ? " (" + t.detail + ")" : ": \"" + t.detail + "\"";
  const after = tries > 1 ? " after " + tries + " tries" : "";
  switch (t.kind) {
    case "signed-out":
      return "Signed out of " + provider + ". Use Sign in (in Settings or the rail), then send your message again.";
    case "rate-limit":
      return provider + " is rate limiting this account" + said + after + ". Wait a few minutes - longer for a daily limit - then send your message again.";
    case "full":
      return "The " + provider + " conversation is full" + said + ". It continues in a new chat.";
    case "refused":
      return provider + " withheld its reply" + said + after + ". Rephrase the request and send it again.";
    case "too-long":
      return provider + " refused the message as too long" + said + ". Send a shorter message, or use /compact to start a new chat.";
    default:
      return provider + " could not answer" + said + after + ". Its servers are busy - send your message again in a few minutes.";
  }
}

/** The reply did not come, for a reason the provider stated. */
export class ProviderTrouble extends Error {
  readonly kind: TroubleKind;
  readonly trouble: Trouble;
  constructor(trouble: Trouble, message: string) {
    super(message);
    this.name = "ProviderTrouble";
    this.kind = trouble.kind;
    this.trouble = trouble;
  }
}

