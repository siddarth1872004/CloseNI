/**
 * The Node end of `python/needle_bridge.py`.
 *
 * One bridge process per agent run, started on first use. Every call is time-
 * bounded: a bridge that stops answering is killed and every call waiting on it
 * fails, which the caller reads as "no extraction" and falls back from. Nothing
 * here may hang a build - that is the one property the rest is built around.
 */
import { spawn, ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { ExtractRequest, ExtractResult, StructuredExtractor } from "./extractor.js";

export interface NeedleClientOptions {
  python: string;
  /** Path to needle_bridge.py. Defaults to the copy shipped beside dist/. */
  bridge?: string;
  weights?: string;
  /** Starting the interpreter and importing the package. */
  startTimeoutMs?: number;
  /** The first extraction may download the engine and weights (~35 MB). */
  firstCallTimeoutMs?: number;
  callTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export function defaultBridgePath(): string {
  if (process.env.CLOSENI_NEEDLE_BRIDGE) return process.env.CLOSENI_NEEDLE_BRIDGE;
  // dist/extract/needle-client.js -> local-agent/python/needle_bridge.py
  return path.join(__dirname, "..", "..", "python", "needle_bridge.py");
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class NeedleClient implements StructuredExtractor {
  readonly id = "needle";
  private proc: ChildProcess | null = null;
  private starting: Promise<any> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buf = "";
  private dead: string | null = null;
  private calls = 0;
  private stderrTail = "";
  info: { version?: string; python?: string; weights?: string } = {};

  constructor(private opts: NeedleClientOptions) {}

  /** Start the bridge and confirm the package imports. Resolves with its hello. */
  start(): Promise<any> {
    if (this.starting) return this.starting;
    this.starting = this.spawnAndHello();
    return this.starting;
  }

  private async spawnAndHello(): Promise<any> {
    const bridge = this.opts.bridge || defaultBridgePath();
    if (!fs.existsSync(bridge)) throw new Error("Needle bridge not found at " + bridge);
    const env: NodeJS.ProcessEnv = Object.assign({}, process.env, this.opts.env || {}, {
      PYTHONUNBUFFERED: "1",
      PYTHONIOENCODING: "utf-8",
    });
    if (this.opts.weights) env.CLOSENI_NEEDLE_WEIGHTS = this.opts.weights;
    let proc: ChildProcess;
    try {
      proc = spawn(this.opts.python, [bridge], { env, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e: any) {
      throw new Error("could not start " + this.opts.python + ": " + (e && e.message ? e.message : String(e)));
    }
    this.proc = proc;
    // The bridge must never be what keeps the agent alive. A pending call holds
    // the event loop through its timer; between calls nothing does, and when
    // the agent exits the bridge reads end-of-input and exits too.
    proc.unref();
    for (const s of [proc.stdin, proc.stdout, proc.stderr] as any[]) { if (s && typeof s.unref === "function") s.unref(); }
    proc.stdout!.setEncoding("utf-8");
    proc.stdout!.on("data", (d: string) => this.onData(d));
    proc.stderr!.setEncoding("utf-8");
    proc.stderr!.on("data", (d: string) => {
      this.stderrTail = (this.stderrTail + d).slice(-2000);
    });
    proc.on("error", (e) => this.fail("could not start " + this.opts.python + ": " + e.message));
    proc.on("close", (code) => this.fail("the Needle bridge exited (code " + code + ")" + this.lastStderr()));
    const hello = await this.request({ op: "hello" }, this.opts.startTimeoutMs ?? 20000);
    if (!hello.ok) throw new Error(hello.error || "the Needle bridge refused to start");
    this.info = { version: hello.version, python: hello.python, weights: hello.weights };
    return hello;
  }

  private lastStderr(): string {
    const line = this.stderrTail.trim().split(/\r?\n/).pop() || "";
    return line ? " - " + line.slice(0, 300) : "";
  }

  private onData(d: string): void {
    this.buf += d;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.substring(0, idx).trim();
      this.buf = this.buf.substring(idx + 1);
      if (!line) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      p.resolve(msg);
    }
  }

  private fail(reason: string): void {
    if (this.dead) return;
    this.dead = reason;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
    if (this.proc) { try { this.proc.kill(); } catch { /* already gone */ } }
  }

  private request(body: Record<string, any>, timeoutMs: number): Promise<any> {
    if (this.dead) return Promise.reject(new Error(this.dead));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A bridge that missed one deadline is not trusted with the next: its
        // late answer would arrive for a request nobody is waiting on, and the
        // engine may be wedged. Kill it and let the caller fall back.
        this.fail("the Needle bridge did not answer within " + Math.round(timeoutMs / 1000) + "s");
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc!.stdin!.write(JSON.stringify(Object.assign({ id }, body)) + "\n");
      } catch (e: any) {
        this.fail("could not write to the Needle bridge: " + (e && e.message ? e.message : String(e)));
      }
    });
  }

  /** Fetch the engine and weights now, rather than during a build. */
  async warm(timeoutMs: number = 300000): Promise<void> {
    await this.start();
    const r = await this.request({ op: "warm" }, timeoutMs);
    if (!r.ok) throw new Error(r.error || "warm-up failed");
  }

  async extract(req: ExtractRequest): Promise<ExtractResult> {
    await this.start();
    const first = this.calls === 0;
    this.calls++;
    const timeout = first ? (this.opts.firstCallTimeoutMs ?? 180000) : (this.opts.callTimeoutMs ?? 30000);
    const r = await this.request({
      op: "extract",
      name: req.name,
      description: req.description,
      schema: req.schema,
      text: req.text,
      maxNewTokens: req.maxNewTokens ?? 256,
    }, timeout);
    if (!r.ok) throw new Error(r.error || "extraction failed");
    return {
      found: !!r.found,
      value: r.arguments && typeof r.arguments === "object" ? r.arguments : {},
      confidence: typeof r.confidence === "number" ? r.confidence : null,
      withheld: !!r.withheld,
      reasoning: typeof r.reasoning === "string" ? r.reasoning : "",
      ungrounded: Array.isArray(r.ungrounded) ? r.ungrounded.map(String) : [],
    };
  }

  async close(): Promise<void> {
    const proc = this.proc;
    if (!proc || this.dead) return;
    try {
      await Promise.race([
        this.request({ op: "shutdown" }, 2000).catch(() => {}),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
    } finally {
      this.dead = this.dead || "closed";
      try { proc.kill(); } catch { /* already gone */ }
    }
  }
}
