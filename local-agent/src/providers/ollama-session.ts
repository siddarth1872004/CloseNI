/**
 * A model running on this machine.
 *
 * The first provider that cannot break because someone redesigned a web page.
 * No selectors, no completion heuristics, no login, no rate limit, and the
 * conversation is ours rather than a thread on a site we do not control.
 *
 * Written against Ollama's /api/chat, which LM Studio also serves - so one
 * implementation covers both, and anything else speaking the same shape.
 *
 * Deliberately no HTTP client dependency. Node's own http is enough for a POST
 * to localhost, and a build tool that drives browsers has no business growing a
 * dependency tree to talk to a port on the same machine.
 */

import * as http from "http";
import * as https from "https";
import { ChatSession, Readiness } from "./chat-session.js";

export interface OllamaConfig {
  /** Where the server listens. Defaults to Ollama's own. */
  endpoint?: string;
  /** Which model to ask for, e.g. "qwen2.5-coder". */
  model?: string;
  /** How long one reply may take. Local models on CPU are slow, not broken. */
  timeoutMs?: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export const DEFAULT_ENDPOINT = "http://127.0.0.1:11434";
/**
 * Generous on purpose. A 7B model on a CPU can take minutes for a long answer,
 * and cutting it off would report a working setup as broken - the same mistake
 * as treating a slow reply from a web provider as a failure.
 */
export const DEFAULT_TIMEOUT_MS = 300000;

/** Parse Ollama's /api/tags reply into model names, tolerating anything else. */
export function modelNames(body: any): string[] {
  let obj = body;
  if (typeof body === "string") {
    try { obj = JSON.parse(body); } catch { return []; }
  }
  if (!obj || !Array.isArray(obj.models)) return [];
  return obj.models
    .map((m: any) => (m && typeof m.name === "string" ? m.name : ""))
    .filter((n: string) => !!n);
}

/**
 * Is `want` among the installed models?
 *
 * Ollama tags carry a version - "qwen2.5-coder:7b" - and people write the bare
 * name. Matching the part before the colon means a config saying
 * "qwen2.5-coder" finds "qwen2.5-coder:7b", which is what anyone would expect
 * and what `ollama run` itself does.
 */
export function hasModel(installed: string[], want: string): boolean {
  const target = String(want || "").trim().toLowerCase();
  if (!target) return false;
  return (installed || []).some((raw) => {
    const name = String(raw || "").trim().toLowerCase();
    if (name === target) return true;
    if (target.indexOf(":") === -1 && name.split(":")[0] === target) return true;
    return false;
  });
}

/** The reply text out of an /api/chat response, or "" if it is not in there. */
export function replyText(body: any): string {
  let obj = body;
  if (typeof body === "string") {
    try { obj = JSON.parse(body); } catch { return ""; }
  }
  if (!obj || typeof obj !== "object") return "";
  if (obj.message && typeof obj.message.content === "string") return obj.message.content;
  // /api/generate shape, in case an endpoint answers that instead.
  if (typeof obj.response === "string") return obj.response;
  return "";
}

/** A message that says what to do, not merely what went wrong. */
export function describeFailure(err: any, endpoint: string, model: string): string {
  const code = err && (err.code || err.errno);
  if (code === "ECONNREFUSED") {
    return "Nothing is listening on " + endpoint + ". Start Ollama (`ollama serve`) " +
      "or LM Studio's local server, then try again.";
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return "Could not resolve " + endpoint + ". Check the endpoint in this provider's config.";
  }
  if (code === "ETIMEDOUT" || (err && err.timedOut)) {
    return "The model at " + endpoint + " did not answer in time. A large model on a CPU " +
      "can be very slow - raise timeoutMs in the provider config if that is expected.";
  }
  return "Could not reach " + (model ? model + " at " : "") + endpoint + ": " +
    (err && err.message ? err.message : String(err));
}

function request(url: string, body: any, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let target: URL;
    try { target = new URL(url); } catch (e) { reject(e); return; }
    const payload = body === null ? null : Buffer.from(JSON.stringify(body), "utf-8");
    const lib = target.protocol === "https:" ? https : http;
    const req = lib.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: payload ? "POST" : "GET",
        headers: payload
          ? { "content-type": "application/json", "content-length": String(payload.length) }
          : {},
        timeout: timeoutMs,
      },
      (res) => {
        let out = "";
        res.setEncoding("utf-8");
        res.on("data", (c) => { out += c; });
        res.on("end", () => {
          if ((res.statusCode || 0) >= 400) {
            const e: any = new Error("HTTP " + res.statusCode + ": " + out.slice(0, 300));
            e.status = res.statusCode;
            reject(e);
            return;
          }
          resolve(out);
        });
      },
    );
    req.on("timeout", () => { const e: any = new Error("timed out"); e.timedOut = true; req.destroy(e); });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export class OllamaSession implements ChatSession {
  private endpoint: string;
  private model: string;
  private timeoutMs: number;
  /**
   * The conversation, held here.
   *
   * The difference that matters between this and a browser provider: the thread
   * belongs to us. Nothing can virtualise it, truncate it, or redesign it, and
   * "new conversation" is emptying an array rather than clicking something.
   */
  private history: ChatMessage[] = [];

  constructor(config: OllamaConfig) {
    this.endpoint = (config.endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, "");
    this.model = config.model || "";
    this.timeoutMs = config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS;
  }

  /** Nothing to open. Kept so the caller does not special-case transports. */
  async start(): Promise<void> {}

  async ready(): Promise<Readiness> {
    if (!this.model) {
      return { ok: false, detail: "No model set for this provider - add \"model\" to its config." };
    }
    let raw: string;
    try {
      raw = await request(this.endpoint + "/api/tags", null, 10000);
    } catch (e: any) {
      return { ok: false, detail: describeFailure(e, this.endpoint, this.model) };
    }
    const installed = modelNames(raw);
    if (!installed.length) {
      return { ok: false, detail: "Reached " + this.endpoint + " but it reports no models. Pull one, e.g. `ollama pull " + this.model + "`." };
    }
    if (!hasModel(installed, this.model)) {
      return {
        ok: false,
        detail: this.model + " is not installed. Available: " + installed.slice(0, 8).join(", ") +
          ". Pull it with `ollama pull " + this.model + "`.",
      };
    }
    return { ok: true, detail: this.model + " is ready on " + this.endpoint };
  }

  async ask(prompt: string): Promise<string> {
    this.history.push({ role: "user", content: String(prompt || "") });
    let raw: string;
    try {
      raw = await request(this.endpoint + "/api/chat", {
        model: this.model,
        messages: this.history,
        // One reply, not a token stream. There is no page to watch fill up and
        // no user waiting on a partial answer - the caller wants the whole
        // thing, and asking for it whole removes an entire class of
        // reassembly bug that the browser path spends real effort on.
        stream: false,
      }, this.timeoutMs);
    } catch (e: any) {
      // The failed turn comes back off the history: leaving it would make every
      // later request re-send a question that was never answered.
      this.history.pop();
      throw new Error(describeFailure(e, this.endpoint, this.model));
    }
    const answer = replyText(raw);
    if (!answer) {
      this.history.pop();
      throw new Error("The model replied with nothing usable. Raw: " + String(raw).slice(0, 200));
    }
    this.history.push({ role: "assistant", content: answer });
    return answer;
  }

  async reset(): Promise<void> {
    this.history = [];
  }

  async close(): Promise<void> {}

  /** For tests and for the conversation-size accounting. */
  turns(): number { return this.history.length; }
}
