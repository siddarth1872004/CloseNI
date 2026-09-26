/**
 * The three sites, described - and only described.
 *
 * An adapter is data: selector chains, a stream pattern if one was measured,
 * extraction hints, timing. The behaviour lives once, in ChatWebProvider. Adding
 * a fourth site is writing one more of these.
 *
 * Every strategy carries its provenance, and the rule for it is strict:
 *
 *   MEASURED    observed working against the live site, with the config note or
 *               commit that recorded it named beside it.
 *   UNVERIFIED  anything else - a reasonable guess, a generic ARIA description,
 *               a selector written from a screenshot.
 *   FIXTURE     generic heuristics, proven against local fixture pages only.
 *
 * Where a thing was measured to NOT exist (DeepSeek's distinct stop control),
 * the chain is empty rather than filled with a hopeful guess.
 */
import { ChainSpec, Strategy } from "../selectors/chain.js";
import { BlockHints } from "../semantic/blocks.js";
import { StateHints } from "./state.js";

export interface AdapterTiming {
  maxWaitMs: number;
  startTimeoutMs: number;
  stabilityMs: number;
  settleMs: number;
  /** Prompts longer than this go in through the native value setter. */
  longPromptChars: number;
  /** How long openChat waits for the page to settle into a named state. */
  readyTimeoutMs: number;
  pollMs: number;
  /** A page that answers nothing for this long is unresponsive: its main thread is stuck. */
  unresponsiveMs: number;
  /** Quiet time after which a reply whose request is still open counts as stalled. */
  streamStallMs: number;
}

export interface AdapterSpec {
  id: string;
  name: string;
  baseUrl: string;
  chains: {
    composer: ChainSpec;
    send: ChainSpec;
    stop: ChainSpec;
    assistant: ChainSpec;
    newChat: ChainSpec;
    copy: ChainSpec;
  };
  /** Only when measured. The reply request, used to know when a reply ENDED. */
  streamUrlPattern?: string;
  conversationIdPattern?: RegExp;
  hints: BlockHints;
  stateHints?: StateHints;
  timing: AdapterTiming;
  /** Free-text record of what is and is not known, carried into reports. */
  knowledge: Record<string, "MEASURED" | "UNVERIFIED" | "UNKNOWN" | "NOT_APPLICABLE">;
}

export const DEFAULT_TIMING: AdapterTiming = {
  maxWaitMs: 300000,
  startTimeoutMs: 120000,
  stabilityMs: 6000,
  settleMs: 1000,
  longPromptChars: 5000,
  readyTimeoutMs: 20000,
  pollMs: 400,
  unresponsiveMs: 20000,
  streamStallMs: 60000,
};

/** A conversation id is a long opaque last path segment. Heuristic, not a claim about any site's routing. */
const GENERIC_CONVERSATION_ID = /\/([0-9a-f]{8}-[0-9a-f-]{27,36}|[A-Za-z0-9_-]{16,})\/?(?:[?#]|$)/;

const H = (name: "composer" | "send-button" | "stop-button" | "last-assistant-block"): Strategy => ({ kind: "heuristic", name, provenance: "FIXTURE" });

const genericComposer = (primary: Strategy[]): ChainSpec => ({
  name: "composer", visibleOnly: true,
  // A chat composer is a textarea or a contenteditable region. role=textbox
  // alone also matches a login form's email <input>, which made a login page
  // read as a ready chat - so single-line inputs are excluded here, and the
  // state classifier double-checks with the composer's kind.
  strategies: primary.concat([
    { kind: "css", css: "textarea", provenance: "UNVERIFIED" },
    { kind: "css", css: '[contenteditable="true"]', provenance: "UNVERIFIED" },
    { kind: "css", css: '[role="textbox"]:not(input)', provenance: "UNVERIFIED" },
    H("composer"),
  ]),
});

const genericSend = (primary: Strategy[]): ChainSpec => ({
  name: "send", visibleOnly: true,
  strategies: primary.concat([
    { kind: "role", role: "button", name: "/^\\s*(send|submit|发送)\\s*$/i", provenance: "UNVERIFIED" },
    H("send-button"),
  ]),
});

const genericNewChat: ChainSpec = {
  name: "newChat", visibleOnly: true,
  strategies: [
    { kind: "role", role: "button", name: "/new (chat|conversation)|新对话|新建对话/i", provenance: "UNVERIFIED" },
    { kind: "role", role: "link", name: "/new (chat|conversation)|新对话|新建对话/i", provenance: "UNVERIFIED" },
  ],
};

export const DEEPSEEK: AdapterSpec = {
  id: "deepseek",
  name: "DeepSeek",
  baseUrl: "https://chat.deepseek.com/",
  chains: {
    // textarea[placeholder] is the first alternative of the configured chatInput,
    // which carried every live build on 11 August.
    composer: genericComposer([{ kind: "css", css: "textarea[placeholder]", provenance: "MEASURED" }]),
    // The configured send selectors are known to MISS on the live site - the
    // controller falls back to Enter, which works (docs/HANDOFF.md). Kept first
    // so a diagnosis shows the miss; Enter remains the real path.
    send: genericSend([{ kind: "css", css: 'button[type="submit"], button[data-testid="send-button"]', provenance: "UNVERIFIED" }]),
    // MEASURED to not exist: the stop control IS the send control, told apart
    // only by hashed classes (config _stopButtonNote). Empty on purpose.
    stop: { name: "stop", visibleOnly: true, strategies: [] },
    assistant: {
      name: "assistant",
      strategies: [
        { kind: "css", css: 'div[class*="ds-markdown"]', provenance: "MEASURED" },
        { kind: "css", css: '[data-testid="assistant-message"]', provenance: "UNVERIFIED" },
        { kind: "css", css: ".markdown-body", provenance: "UNVERIFIED" },
        H("last-assistant-block"),
      ],
    },
    newChat: genericNewChat,
    copy: { name: "copy", strategies: [{ kind: "css", css: 'div[role="button"]:has(span.code-info-button-text)', provenance: "MEASURED" }] },
  },
  streamUrlPattern: "/api/v0/chat/completion",
  conversationIdPattern: GENERIC_CONVERSATION_ID,
  hints: {},
  timing: { ...DEFAULT_TIMING },
  knowledge: {
    "composer": "MEASURED",
    "send button": "UNVERIFIED",
    "send via Enter": "MEASURED",
    "stop control": "NOT_APPLICABLE",
    "assistant container": "MEASURED",
    "reply stream endpoint": "MEASURED",
    "copy button": "MEASURED",
    "reasoning markup": "UNKNOWN",
    "login wall markup": "UNKNOWN",
    "guest access": "UNKNOWN",
    "new-chat control": "UNVERIFIED",
  },
};

export const QWEN: AdapterSpec = {
  id: "qwen",
  name: "Qwen",
  baseUrl: "https://chat.qwen.ai/",
  chains: {
    // "input, clipboard paste, send and completion detection all verified
    // against the live site" - qwen-studio.json _comingSoonReason.
    composer: genericComposer([{ kind: "css", css: 'textarea, div[contenteditable="true"]', provenance: "MEASURED" }]),
    send: genericSend([{ kind: "css", css: 'button[type="submit"]', provenance: "MEASURED" }]),
    stop: { name: "stop", visibleOnly: true, strategies: [
      { kind: "css", css: 'button[class*="stop"]', provenance: "MEASURED" },
      { kind: "role", role: "button", name: "/stop|停止/i", provenance: "UNVERIFIED" },
    ] },
    // Completion detection was verified; reading the reply out was not claimed.
    assistant: {
      name: "assistant",
      strategies: [
        { kind: "css", css: '[class*="assistant"]', provenance: "UNVERIFIED" },
        { kind: "css", css: ".markdown-body", provenance: "UNVERIFIED" },
        H("last-assistant-block"),
      ],
    },
    newChat: genericNewChat,
    copy: { name: "copy", strategies: [] },
  },
  conversationIdPattern: GENERIC_CONVERSATION_ID,
  hints: {},
  timing: { ...DEFAULT_TIMING },
  knowledge: {
    "composer": "MEASURED",
    "send button": "MEASURED",
    "stop control": "MEASURED",
    "assistant container": "UNVERIFIED",
    "reply stream endpoint": "UNKNOWN",
    "copy button": "UNKNOWN",
    "reasoning markup": "UNKNOWN",
    "login wall markup": "UNKNOWN",
    "guest access": "UNKNOWN",
    "new-chat control": "UNVERIFIED",
  },
};

export const GLM: AdapterSpec = {
  id: "glm",
  name: "GLM",
  baseUrl: "https://chat.z.ai/",
  chains: {
    // glm.json: "Selectors here have never been confirmed."
    composer: genericComposer([{ kind: "css", css: 'textarea, div[contenteditable="true"]', provenance: "UNVERIFIED" }]),
    send: genericSend([{ kind: "css", css: 'button[type="submit"], button[class*="send"]', provenance: "UNVERIFIED" }]),
    stop: { name: "stop", visibleOnly: true, strategies: [
      { kind: "css", css: 'button[class*="stop"]', provenance: "UNVERIFIED" },
      { kind: "role", role: "button", name: "/stop|停止/i", provenance: "UNVERIFIED" },
    ] },
    assistant: {
      name: "assistant",
      strategies: [
        { kind: "css", css: '[class*="assistant"]', provenance: "UNVERIFIED" },
        { kind: "css", css: ".markdown-body", provenance: "UNVERIFIED" },
        { kind: "css", css: '[class*="message"][class*="bot"]', provenance: "UNVERIFIED" },
        H("last-assistant-block"),
      ],
    },
    newChat: genericNewChat,
    copy: { name: "copy", strategies: [] },
  },
  conversationIdPattern: GENERIC_CONVERSATION_ID,
  hints: {},
  timing: { ...DEFAULT_TIMING },
  knowledge: {
    "composer": "UNVERIFIED",
    "send button": "UNVERIFIED",
    "stop control": "UNVERIFIED",
    "assistant container": "UNVERIFIED",
    "reply stream endpoint": "UNKNOWN",
    "copy button": "UNKNOWN",
    "reasoning markup": "UNKNOWN",
    "login wall markup": "UNKNOWN",
    "guest access": "UNKNOWN",
    "new-chat control": "UNVERIFIED",
  },
};

export const ADAPTERS: Record<string, AdapterSpec> = { deepseek: DEEPSEEK, qwen: QWEN, glm: GLM };

/** Accept the config ids the rest of the app uses ("qwen-studio"). */
export function adapterFor(id: string): AdapterSpec | undefined {
  const key = id === "qwen-studio" ? "qwen" : id;
  return ADAPTERS[key];
}

/**
 * An adapter from an existing provider config JSON - how the fixture providers
 * and any config-only site are driven through the same class.
 */
export function adapterFromConfig(cfg: any, timing: Partial<AdapterTiming> = {}): AdapterSpec {
  const sel = (cfg && cfg.selectors) || {};
  const css = (c: string | undefined): Strategy[] => (c ? [{ kind: "css", css: c, provenance: "UNVERIFIED" }] : []);
  return {
    id: String(cfg.id),
    name: String(cfg.name || cfg.id),
    baseUrl: String(cfg.baseUrl),
    chains: {
      composer: genericComposer(css(sel.chatInput)),
      send: genericSend(css(sel.sendButton)),
      stop: { name: "stop", visibleOnly: true, strategies: css(sel.stopButton) },
      assistant: { name: "assistant", strategies: css(sel.assistantMessage).concat([H("last-assistant-block")]) },
      newChat: genericNewChat,
      copy: { name: "copy", strategies: css(sel.copyButton) },
    },
    streamUrlPattern: sel.streamUrlPattern,
    conversationIdPattern: GENERIC_CONVERSATION_ID,
    hints: {},
    timing: { ...DEFAULT_TIMING, ...(cfg.completionRules && cfg.completionRules.maxWaitMs ? { maxWaitMs: cfg.completionRules.maxWaitMs } : {}), ...timing },
    knowledge: {},
  };
}

/** With timing overridden - tests shorten every window. */
export function withTiming(spec: AdapterSpec, timing: Partial<AdapterTiming>): AdapterSpec {
  return { ...spec, timing: { ...spec.timing, ...timing } };
}

/** With a different base URL - how fixture sites stand in for the live ones. */
export function withBaseUrl(spec: AdapterSpec, baseUrl: string, streamUrlPattern?: string): AdapterSpec {
  return { ...spec, baseUrl, ...(streamUrlPattern !== undefined ? { streamUrlPattern } : {}) };
}
