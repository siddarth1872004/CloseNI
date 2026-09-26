/**
 * What state is this chat page in?
 *
 * The old controller asked one question - "did a composer appear within 15
 * seconds?" - and answered every other situation with "not signed in". A login
 * wall, a CAPTCHA, a slow load, a 500 page, a rate-limit banner and a network
 * refusal all looked identical. This separates them.
 *
 * Two halves. collectSignals() runs in the page and reports facts: is there a
 * visible composer, a password field, a challenge iframe, an alert. The
 * classifier below is pure and decides what those facts mean, so every rule is
 * unit-tested against signal sets rather than against live sites nobody here
 * can reach.
 *
 * The markers are generic web conventions - a password input means a login
 * form, a reCAPTCHA/hCaptcha/Turnstile frame means a challenge - not claims
 * about any provider's undocumented markup. An adapter can add its own. Nothing
 * here tries to get past what it detects; detection exists so the run can stop
 * and say why.
 */
import { UIState } from "./ai-web-provider.js";

export interface PageSignals {
  url: string;
  title: string;
  readyState: string;
  composerVisible: boolean;
  composerEnabled: boolean;
  /** "textarea" | "contenteditable" | "input" | "" - a single-line input next to a password field is a login form. */
  composerKind?: string;
  stopVisible: boolean;
  sendEnabled: boolean | null;
  assistantCount: number;
  lastAssistantChars: number;
  passwordField: boolean;
  /** Login/sign-in controls visible. */
  loginPrompt: boolean;
  /** A visible modal dialog is up. */
  modalOpen: boolean;
  /** The modal looks like a login (password field or login text inside). */
  modalIsLogin: boolean;
  captcha: boolean;
  alerts: string[];
  busy: boolean;
  bodyChars: number;
  httpStatus?: number;
  streamStatus?: number;
}

export interface StateHints {
  /** Extra regexes (as strings) for login text, beyond the generic ones. */
  loginText?: string[];
  rateLimitText?: string[];
  errorText?: string[];
}

export const LOGIN_TEXT = ["^\\s*(log ?in|sign ?in|sign up|register|continue with (google|github|apple|email|phone))\\b", "登录", "注册"];
export const RATE_LIMIT_TEXT = ["too many requests", "rate.?limit", "try again (later|in \\d+)", "server is busy", "请求过于频繁", "服务器繁忙"];
export const ERROR_TEXT = ["something went wrong", "an error occurred", "network error", "failed to (load|fetch)", "internal server error", "出错了", "网络错误"];

/**
 * Runs in the page. Selectors for composer/stop/assistant come from the
 * adapter's resolved chains; everything else is generic.
 */
export function collectSignalsInPage(arg: { composer: string | null; stop: string | null; send: string | null; assistant: string | null; loginText: string[] }): any {
  const doc: any = (globalThis as any).document;
  const win: any = globalThis as any;
  const vis = (el: any) => {
    if (!el) return false;
    if (typeof el.checkVisibility === "function") { try { if (!el.checkVisibility({ visibilityProperty: true })) return false; } catch { /* old engine */ } }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const q = (sel: string | null) => { if (!sel) return []; try { return Array.from(doc.querySelectorAll(sel)) as any[]; } catch { return []; } };
  const composers = q(arg.composer).filter(vis);
  const composer = composers[composers.length - 1];
  const stopVisible = q(arg.stop).some(vis);
  const sends = q(arg.send).filter(vis);
  const assistants = q(arg.assistant);
  const last = assistants[assistants.length - 1];
  const loginRe = arg.loginText.map((s) => new RegExp(s, "i"));
  const controls = (Array.from(doc.querySelectorAll('a, button, [role="button"]')) as any[]).filter(vis).slice(0, 300);
  const loginPrompt = controls.some((el) => {
    const t = String(el.innerText || el.getAttribute("aria-label") || "").trim();
    return t.length > 0 && t.length < 60 && loginRe.some((r) => r.test(t));
  });
  const pw = (Array.from(doc.querySelectorAll('input[type="password"]')) as any[]).some(vis);
  const modals = (Array.from(doc.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog[open]')) as any[]).filter(vis);
  const modalIsLogin = modals.some((m) => !!m.querySelector('input[type="password"]') ||
    loginRe.some((r) => r.test(String(m.innerText || "").slice(0, 400))));
  const frames = Array.from(doc.querySelectorAll("iframe")) as any[];
  const captcha = frames.some((f) => /recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile|geetest|arkoselabs|funcaptcha/i.test(String(f.src || "") + " " + String(f.title || ""))) ||
    !!doc.querySelector('#challenge-form, #cf-challenge-running, .g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey]');
  const alerts = (Array.from(doc.querySelectorAll('[role="alert"], [aria-live="assertive"], .ant-message-notice, [role="status"]')) as any[])
    .filter(vis).map((a) => String(a.innerText || "").trim().slice(0, 200)).filter(Boolean).slice(0, 5);
  const busy = !!doc.querySelector('[aria-busy="true"], [role="progressbar"]');
  return {
    url: String(win.location.href),
    title: String(doc.title || ""),
    readyState: String(doc.readyState),
    composerVisible: !!composer,
    composerEnabled: !!composer && !composer.disabled && composer.getAttribute("aria-disabled") !== "true" && composer.getAttribute("readonly") === null,
    stopVisible,
    sendEnabled: sends.length ? sends.some((b) => !b.disabled && b.getAttribute("aria-disabled") !== "true" && !/disabled/.test(String(b.className || ""))) : null,
    assistantCount: assistants.length,
    lastAssistantChars: last ? String(last.innerText || last.textContent || "").length : 0,
    passwordField: pw,
    loginPrompt,
    modalOpen: modals.length > 0,
    modalIsLogin,
    captcha,
    alerts,
    busy,
    bodyChars: String(doc.body ? doc.body.innerText || "" : "").length,
  };
}

export interface Classification { state: UIState; evidence: string[] }

function anyMatch(texts: string[], patterns: string[]): string | null {
  for (const t of texts) for (const p of patterns) { if (new RegExp(p, "i").test(t)) return t; }
  return null;
}

/**
 * Pure. Precedence is deliberate: a challenge outranks a login (you cannot log
 * in behind it), a login outranks a rate limit (an anonymous page cannot be
 * rate-limited as a user), and an explicit failure outranks "looks ready".
 *
 * `generating` is the completion detector's view, when a prompt is in flight.
 */
export function classifyState(s: PageSignals, ctx: { hints?: StateHints; inFlight?: boolean; detector?: "waiting" | "streaming" | "complete" | "failed" } = {}): Classification {
  const ev: string[] = [];
  const hints = ctx.hints || {};
  const rl = RATE_LIMIT_TEXT.concat(hints.rateLimitText || []);
  const er = ERROR_TEXT.concat(hints.errorText || []);

  if (s.captcha) return { state: "CAPTCHA", evidence: ["a challenge widget (reCAPTCHA/hCaptcha/Turnstile-style) is on the page"] };

  if (s.modalOpen && s.modalIsLogin) {
    return { state: "AUTH_REQUIRED", evidence: ["a login dialog is open" + (s.composerVisible ? " over the composer" : "")] };
  }
  if (s.passwordField && s.composerKind === "input") {
    return { state: "AUTH_REQUIRED", evidence: ["password field visible", "the only text field is a single-line input - a login form, not a chat composer"] };
  }
  if (!s.composerVisible && (s.passwordField || s.loginPrompt)) {
    if (s.passwordField) ev.push("password field visible");
    if (s.loginPrompt) ev.push("login/sign-in control visible");
    ev.push("no chat composer");
    return { state: "AUTH_REQUIRED", evidence: ev };
  }
  if (s.httpStatus === 401 || s.httpStatus === 403 || s.streamStatus === 401 || s.streamStatus === 403) {
    return { state: "AUTH_REQUIRED", evidence: ["HTTP " + (s.streamStatus || s.httpStatus) + " on " + (s.streamStatus ? "the reply request" : "the page")] };
  }
  if (s.httpStatus === 429 || s.streamStatus === 429) {
    return { state: "RATE_LIMITED", evidence: ["HTTP 429 on " + (s.streamStatus === 429 ? "the reply request" : "the page")] };
  }
  const rlAlert = anyMatch(s.alerts, rl);
  if (rlAlert) return { state: "RATE_LIMITED", evidence: ["alert: " + JSON.stringify(rlAlert)] };

  if ((s.httpStatus && s.httpStatus >= 500) || (s.streamStatus && s.streamStatus >= 500)) {
    return { state: ctx.inFlight ? "GENERATION_FAILED" : "ERROR", evidence: ["HTTP " + (s.streamStatus || s.httpStatus)] };
  }
  const errAlert = anyMatch(s.alerts, er);
  if (errAlert && (ctx.inFlight || !s.composerVisible)) {
    return { state: ctx.inFlight ? "GENERATION_FAILED" : "ERROR", evidence: ["alert: " + JSON.stringify(errAlert)] };
  }

  if (ctx.detector === "failed") return { state: "GENERATION_FAILED", evidence: ["the reply never started or the request failed"] };
  if (s.stopVisible) return { state: "GENERATING", evidence: ["stop control visible"] };
  if (ctx.detector === "streaming") return { state: "GENERATING", evidence: ["reply text still changing"] };
  if (ctx.detector === "complete") return { state: "GENERATION_COMPLETE", evidence: ["completion detected"] };

  if (s.composerVisible && s.composerEnabled) {
    return { state: "CHAT_READY", evidence: ["composer visible and enabled" + (s.loginPrompt ? " (a login control is also shown - guest mode or optional login)" : "")] };
  }
  if (s.composerVisible && !s.composerEnabled) {
    return { state: ctx.inFlight ? "GENERATING" : "LOADING", evidence: ["composer visible but disabled"] };
  }
  if (s.readyState !== "complete" || s.busy) return { state: "LOADING", evidence: ["document " + s.readyState + (s.busy ? ", busy indicator" : "")] };
  if (s.bodyChars < 20) return { state: "LOADING", evidence: ["page has almost no text yet"] };
  if (s.httpStatus && s.httpStatus >= 400) return { state: "ERROR", evidence: ["HTTP " + s.httpStatus] };
  return { state: "READY", evidence: ["page loaded, but no chat composer and no login markers - not a chat page, or a layout no chain describes"] };
}

/** States a run cannot proceed past on its own. */
export function isTerminalForAutomation(state: UIState): boolean {
  return state === "AUTH_REQUIRED" || state === "CAPTCHA" || state === "RATE_LIMITED" || state === "ERROR";
}
