/**
 * Talking to a model, without assuming a browser.
 *
 * docs/NEXT.md claimed "the architecture already separates provider from how you
 * talk to it". It did not. PlaywrightController is a concrete class with a
 * twenty-three method surface that index.ts depends on directly, and most of
 * that surface only means anything to a web page: probeSelectors,
 * readCodeViaCopy, countMessages, getLastMessageText, waitForLogin,
 * navigateToChat, streamStats.
 *
 * Those exist because we are scraping. A local model needs one thing: send a
 * prompt, get a reply. So the seam is deliberately much narrower than the class
 * it is being extracted from - four methods, none of which mention a page.
 *
 * The risk in extracting an interface from exactly one implementation is that it
 * comes out shaped like that implementation. Hence a second one, against Ollama,
 * in the same change: an abstraction with one implementor is a rename.
 */

export type TransportKind = "browser" | "ollama";

export interface Readiness {
  ok: boolean;
  /** Shown to the user when not ok. Says what to do, not just what failed. */
  detail: string;
}

export interface ChatSession {
  /** Open whatever this provider needs - a browser, a socket, nothing at all. */
  start(): Promise<void>;

  /**
   * Can this actually be used right now?
   *
   * Signed in, for a browser. Reachable and holding the named model, for a
   * local server. Separated from start() because "it opened" and "it will work"
   * are different questions, and the second is the one worth showing a user.
   */
  ready(): Promise<Readiness>;

  /**
   * One turn: send this, return the reply as text.
   *
   * Deliberately one call rather than the send/poll/read triple the browser
   * needs. Polling for a reply is a consequence of not being told when one
   * arrives; a transport that is told has no use for it, and an interface that
   * insisted on it would make every non-browser provider implement three
   * methods to satisfy a shape it does not have.
   */
  ask(prompt: string): Promise<string>;

  /** Abandon the current conversation and begin an empty one. */
  reset(): Promise<void>;

  close(): Promise<void>;
}

/**
 * Which transport a provider config asks for.
 *
 * Absent means browser, so every existing config keeps working untouched -
 * there are five of them and none mention a transport.
 */
export function transportOf(config: { transport?: string } | null | undefined): TransportKind {
  const t = config && config.transport;
  return t === "ollama" ? "ollama" : "browser";
}

/**
 * Does this provider run in a browser?
 *
 * Used by the paths that are still browser-only - plan and build - so they can
 * refuse a local provider with a sentence that says why, rather than failing
 * somewhere deep in a page interaction that will never happen.
 */
export function isBrowserTransport(config: { transport?: string } | null | undefined): boolean {
  return transportOf(config) === "browser";
}

/**
 * The browser, behind the same four methods.
 *
 * Nothing here is new behaviour - it is chatMode's existing sequence moved
 * behind the seam, including the retry that reads the structured text and falls
 * back to innerText. That retry exists because a reply is occasionally readable
 * a beat after the wait ends, and losing it would turn a working chat into an
 * empty one.
 *
 * The adapter is thin on purpose. A thick one would be a second place for
 * browser behaviour to live, and the point of the seam is to have exactly one.
 */
export class BrowserChatSession implements ChatSession {
  constructor(
    private controller: any,
    private config: any,
    private opts: { workspace?: string; sleep: (ms: number) => Promise<void> },
  ) {}

  async start(): Promise<void> {
    this.controller.setWorkspace(this.opts.workspace || "");
    await this.controller.launch(this.config);
    await this.controller.navigateToChat(this.config);
    await this.controller.waitForLogin();
  }

  async ready(): Promise<Readiness> {
    const signedIn = await this.controller.waitForLogin(20000);
    return signedIn
      ? { ok: true, detail: "signed in to " + this.config.name }
      : { ok: false, detail: "Not signed in to " + this.config.name + " - use Sign in." };
  }

  async ask(prompt: string): Promise<string> {
    const prevCount = await this.controller.countMessages(this.config);
    const prevContent = await this.controller.getLastMessageText(this.config);
    await this.controller.sendPrompt(prompt, this.config);
    await this.controller.waitForResponse(this.config, prevCount, prevContent);
    let answer = "";
    for (let i = 0; i < 4 && answer.trim().length < 2; i++) {
      if (i > 0) await this.opts.sleep(1500);
      answer = await this.controller.getLastMessageStructured(this.config);
      if (answer.trim().length < 2) answer = await this.controller.getLastMessageInnerText(this.config);
    }
    return answer;
  }

  async reset(): Promise<void> {
    await this.controller.navigateFresh(this.config);
  }

  async close(): Promise<void> {
    await this.controller.close();
  }
}
