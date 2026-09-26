/**
 * A browser-accessed AI, as the rest of the system sees it.
 *
 * Not an API client: every method here is something a person does in a chat
 * page - open it, see whether it is usable, type, wait, read. The research
 * engine and the test harness talk to this interface and never to a page, so a
 * new site is one adapter (adapters.ts), not a change anywhere else.
 */
import { Block } from "../semantic/blocks.js";
import { DomNode } from "../semantic/dom.js";
import { DebugArtifacts } from "../browser/diagnostics.js";
import { ChainDiagnosis, Provenance } from "../selectors/chain.js";
import { ManagedPage } from "../browser/session-manager.js";

export type UIState =
  | "LOADING"
  | "READY"
  | "AUTH_REQUIRED"
  | "CAPTCHA"
  | "ERROR"
  | "CHAT_READY"
  | "GENERATING"
  | "GENERATION_COMPLETE"
  | "GENERATION_FAILED"
  | "RATE_LIMITED"
  | "UNKNOWN";

export interface StateReport {
  state: UIState;
  /** The signals that decided it, in words - never just a label. */
  evidence: string[];
  url: string;
  /** Set when the page could not be reached at all. */
  navigation?: { ok: boolean; errorKind?: string; error?: string; status?: number; finalUrl?: string };
}

export interface SubmitResult {
  sent: boolean;
  /** How the text got into the composer and how it was sent. */
  method: string;
  composer: string;
  chars: number;
  error?: string;
}

export type CompletionSignal = "stream-closed" | "stop-button-gone" | "stability" | "stalled" | "timeout" | "no-start" | "failed" | "interrupted" | "empty";

export interface WaitResult {
  status: "complete" | "partial" | "timeout" | "failed" | "no-start";
  signal: CompletionSignal;
  waitedMs: number;
  /** Incremental snapshots of the reply text while it streamed. */
  partials: Array<{ atMs: number; chars: number; delta: string; kind: "append" | "rewrite" }>;
  finalState: UIState;
  error?: string;
}

export interface ResponseContent {
  text: string;
  markdown: string;
  code: Array<{ lang: string; text: string }>;
  tables: Array<{ caption?: string; header: string[]; rows: string[][] }>;
  links: Array<{ text: string; href: string }>;
  citations: Array<{ text: string; href?: string }>;
}

export interface Artifact {
  kind: "code" | "image" | "file-link";
  label: string;
  /** Code text, or a URL. */
  value: string;
  lang?: string;
}

export interface ExtractionMetadata {
  /** Which selector-chain link found the reply. */
  strategy: string;
  provenance: Provenance | "UNKNOWN";
  chainVerdict?: ChainDiagnosis["verdict"];
  completionSignal?: CompletionSignal;
  waitedMs?: number;
  extractMs: number;
  partialCount?: number;
  domNodes: number;
  copyButtonUsed: boolean;
  warnings: string[];
}

/**
 * One reply, in the shape the rest of the system uses.
 *
 * Only fields the page actually exposed are set. conversationId comes from the
 * URL when the adapter knows the pattern; messageId only when the markup carries
 * one. Nothing is invented to fill the shape.
 */
export interface AIResponse {
  provider: string;
  conversationId?: string;
  messageId?: string;
  timestamp: string;
  status: WaitResult["status"] | "empty";
  content: ResponseContent;
  reasoning?: { text: string; markdown: string; blocks: Block[] };
  attachments: Array<{ label: string; href: string }>;
  artifacts: Artifact[];
  raw_dom_snapshot?: DomNode;
  extraction_metadata: ExtractionMetadata;
}

export interface HealthReport {
  provider: string;
  state: StateReport;
  chains: ChainDiagnosis[];
  ok: boolean;
  summary: string;
}

export interface AskOptions {
  maxWaitMs?: number;
  onPartial?: (p: { chars: number; delta: string }) => void;
  keepDom?: boolean;
}

export interface AIWebProvider {
  readonly id: string;
  readonly name: string;

  /** Acquire this provider's isolated context and page. Opens no URL. */
  launch(): Promise<void>;
  /** Drive a page someone else opened (replay, fixtures). */
  attach(page: ManagedPage): void;
  healthCheck(): Promise<HealthReport>;
  /** Go to the chat and report what state it is in. */
  openChat(): Promise<StateReport>;
  /** A new, empty conversation. */
  startConversation(): Promise<StateReport>;
  submitPrompt(prompt: string): Promise<SubmitResult>;
  waitForResponse(opts?: AskOptions): Promise<WaitResult>;
  extractResponse(opts?: { keepDom?: boolean; wait?: WaitResult }): Promise<AIResponse>;
  extractReasoning(): Promise<AIResponse["reasoning"] | null>;
  extractArtifacts(): Promise<Artifact[]>;
  stopGeneration(): Promise<boolean>;
  clearConversation(): Promise<void>;
  diagnostics(label: string, extra?: Record<string, unknown>): Promise<DebugArtifacts | null>;
  detectState(): Promise<StateReport>;
  /** submit + wait + extract. */
  ask(prompt: string, opts?: AskOptions): Promise<AIResponse>;
  close(): Promise<void>;
}
