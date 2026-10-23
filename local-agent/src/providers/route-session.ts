/**
 * Where a prompt goes: the provider's web page, or the person.
 *
 *   browser  the provider's chat page, as always
 *   manual   copy and paste: each prompt is shown, the person puts it into
 *            any chat they like and pastes the reply back
 *
 * The browser comes first and the person moves between routes with /route.
 * Nothing switches on its own: a page that hits a rate limit or a human check
 * stops, says so, and the turn waits for /resume on whichever route they pick.
 * Each route keeps its own conversation, so moving to another one starts a new
 * chat there (the loop sends the preamble again).
 */
import { ChatSession, Readiness, AskOptions } from "./chat-session.js";
import { ConversationSize } from "../context-budget.js";

export type Route = "browser" | "manual";
export const ROUTES: Route[] = ["browser", "manual"];

export function routeOf(s: string): Route | null {
  const r = String(s || "").trim().toLowerCase();
  return ROUTES.indexOf(r as Route) !== -1 ? (r as Route) : null;
}

/** The person as the model: a prompt goes out to be copied, the reply comes back pasted. */
export class ManualSession implements ChatSession {
  private waiting: { resolve: (s: string) => void; reject: (e: Error) => void } | null = null;

  constructor(private show: (prompt: string) => void) {}

  async start(): Promise<void> {}

  async ready(): Promise<Readiness> {
    return { ok: true, detail: "Copy each prompt into any chat and paste its reply back" };
  }

  ask(prompt: string): Promise<string> {
    this.cancel("A new prompt replaced the one waiting for a reply.");
    return new Promise<string>((resolve, reject) => {
      this.waiting = { resolve: resolve, reject: reject };
      this.show(String(prompt || ""));
    });
  }

  /** Is a prompt waiting for its reply? */
  get awaiting(): boolean { return this.waiting !== null; }

  /** The pasted reply. False when nothing was waiting for one. */
  supply(text: string): boolean {
    const w = this.waiting;
    if (!w) return false;
    this.waiting = null;
    w.resolve(String(text || ""));
    return true;
  }

  /** Stop waiting: Esc, a route change, or closing. */
  cancel(why: string): void {
    const w = this.waiting;
    if (!w) return;
    this.waiting = null;
    w.reject(new Error(why));
  }

  async reset(): Promise<void> { this.cancel("The conversation was reset."); }

  async close(): Promise<void> { this.cancel("The session closed."); }
}

export interface RouteOptions {
  /** Opens the browser session; called again by /route browser after it failed. */
  openBrowser: () => Promise<ChatSession>;
  manual: ManualSession;
}

export class RoutedSession implements ChatSession {
  private browser: ChatSession | null = null;
  private current: Route = "browser";

  constructor(private o: RouteOptions) {}

  get route(): Route { return this.current; }

  /** The routes that can be used. */
  available(): Route[] {
    return ROUTES.slice();
  }

  /** Open the browser. On failure the session stays usable on another route. */
  async start(): Promise<void> {
    this.browser = await this.o.openBrowser();
  }

  /** Move to another route. Throws with a sentence when it cannot be used. */
  async use(route: Route): Promise<void> {
    if (route === "browser" && !this.browser) this.browser = await this.o.openBrowser();
    if (route !== "manual") this.o.manual.cancel("Moved to the " + route + " route.");
    this.current = route;
  }

  /** Where prompts go when the browser could not open. */
  fallBack(): void { this.current = "manual"; }

  private session(): ChatSession {
    if (this.current === "browser" && this.browser) return this.browser;
    return this.o.manual;
  }

  ready(): Promise<Readiness> { return this.session().ready(); }

  ask(prompt: string, opts?: AskOptions): Promise<string> { return this.session().ask(prompt, opts); }

  /** A new conversation on every route, so none carries the old one into it. */
  async reset(): Promise<void> {
    const now = this.session();
    await now.reset();
    for (const s of [this.browser, this.o.manual]) {
      if (s && s !== now) { try { await s.reset(); } catch { /* it starts over when next used */ } }
    }
  }

  size(): ConversationSize | undefined {
    const s = this.session();
    return s.size ? s.size() : undefined;
  }

  async close(): Promise<void> {
    for (const s of [this.o.manual, this.browser]) {
      if (s) { try { await s.close(); } catch { /* closing anyway */ } }
    }
  }
}
