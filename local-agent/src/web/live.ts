/**
 * The identical scenarios, against the LIVE sites.
 *
 *   node local-agent/dist/index.js webtest deepseek|qwen|glm|all [--headed]
 *
 * Rules this runner keeps, whatever the site does:
 *   - It uses the profile the app already signs in to. It never opens a login
 *     form, types a credential, creates an account or solves a challenge.
 *   - Nothing is sent unless the page is CHAT_READY. AUTH_REQUIRED, CAPTCHA,
 *     RATE_LIMITED and unreachable hosts end that provider's run and every
 *     remaining row is recorded with that reason - never as PASS or FAIL.
 *   - A model's answer is judged by checks it can objectively pass (a token it
 *     was asked to repeat, JSON that parses), never by taste.
 *
 * Results merge into docs/testing/results/live-results.json, keyed by provider
 * and stamped with the machine and time, so the matrix can say where and when
 * each live row was observed.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { BrowserSessionManager } from "./browser/session-manager.js";
import { ChatWebProvider } from "./providers/chat-web-provider.js";
import { adapterFor } from "./providers/adapters.js";
import { AIResponse, StateReport } from "./providers/ai-web-provider.js";
import { Tracer } from "./trace.js";
import { storagePaths } from "../storage-paths.js";

export type RowStatus = "PASS" | "FAIL" | "PARTIAL" | "AUTH_REQUIRED" | "BLOCKED" | "NOT_APPLICABLE" | "NOT_TESTED";

export interface LiveRow { capability: string; status: RowStatus; detail: string }

export interface LiveRun {
  provider: string;
  at: string;
  machine: string;
  state: StateReport | null;
  rows: LiveRow[];
  durationMs: number;
}

interface Scenario {
  capability: string;
  prompt: string;
  judge: (r: AIResponse) => { status: RowStatus; detail: string };
}

const token = "CLOSENI-" + Math.random().toString(36).slice(2, 8).toUpperCase();

/** The fixture suite's scenarios, phrased for a real model with objective checks. */
export const LIVE_SCENARIOS: Scenario[] = [
  { capability: "Instruction following", prompt: "Reply with exactly this text and nothing else: " + token,
    judge: (r) => ({ status: r.content.text.includes(token) ? "PASS" : "FAIL", detail: JSON.stringify(r.content.text.slice(0, 80)) }) },
  { capability: "Reasoning", prompt: "What is 17 multiplied by 23? Answer with just the number.",
    judge: (r) => ({ status: /\b391\b/.test(r.content.text) ? "PASS" : "FAIL", detail: r.content.text.slice(0, 80) + (r.reasoning ? " (reasoning section extracted)" : " (no reasoning section seen)") }) },
  { capability: "Code extraction", prompt: "Write a Python function slugify(text) that lowercases text and replaces runs of non-alphanumeric characters with hyphens. Put it in one python code block.",
    judge: (r) => ({ status: r.content.code.some((c) => /def slugify/.test(c.text)) ? (r.content.code.some((c) => c.lang === "python") ? "PASS" : "PARTIAL") : "FAIL",
      detail: r.content.code.map((c) => c.lang || "?").join(",") + (r.extraction_metadata.copyButtonUsed ? " via Copy control" : "") }) },
  { capability: "JSON generation", prompt: "Return only a JSON object with a key \"name\" set to \"closeni\" and a key \"items\" set to [1, 2, 3], inside a json code block.",
    judge: (r) => {
      const src = (r.content.code[0] || { text: r.content.text }).text;
      try { const j = JSON.parse(src.slice(src.indexOf("{"), src.lastIndexOf("}") + 1)); return { status: j.name === "closeni" && Array.isArray(j.items) ? "PASS" : "PARTIAL", detail: "parsed" }; }
      catch { return { status: "FAIL", detail: "no parseable JSON" }; }
    } },
  { capability: "Markdown extraction", prompt: "Give a numbered list of three steps to boil an egg, then a bulleted list of two tips.",
    judge: (r) => ({ status: /^1\. /m.test(r.content.markdown) && /^- /m.test(r.content.markdown) ? "PASS" : "PARTIAL", detail: r.content.markdown.slice(0, 80) }) },
  { capability: "Tables", prompt: "Give a markdown table with columns Option and Latency for three options named A, B and C.",
    judge: (r) => ({ status: r.content.tables.length && r.content.tables[0].rows.length >= 3 ? "PASS" : "FAIL", detail: r.content.tables.length + " table(s)" }) },
  { capability: "Links/citations", prompt: "Give two links to pages of the official Playwright documentation, as markdown links.",
    judge: (r) => ({ status: r.content.links.length >= 2 ? "PASS" : r.content.links.length ? "PARTIAL" : "FAIL", detail: r.content.links.length + " link(s)" }) },
  { capability: "Long response", prompt: "Write the numbers from 1 to 600, separated by single spaces, and nothing else.",
    judge: (r) => ({ status: /\b600\b/.test(r.content.text) && /\b1 2 3\b/.test(r.content.text) ? "PASS" : "PARTIAL", detail: r.content.text.length + " chars, signal " + r.extraction_metadata.completionSignal }) },
  { capability: "Large context", prompt: Array.from({ length: 400 }, (_, i) => "Filler line " + i + " carries no information at all.").join("\n") + "\nThe secret word is ZEBRA-91. Reply with only the secret word.",
    judge: (r) => ({ status: /ZEBRA-91/.test(r.content.text) ? "PASS" : "FAIL", detail: "~15k-char prompt; " + r.content.text.slice(0, 40) }) },
  { capability: "Long-running conversation", prompt: "What exact text did I ask you to reply with at the start of this conversation?",
    judge: (r) => ({ status: r.content.text.includes(token) ? "PASS" : "FAIL", detail: "recall across turns" }) },
];

export interface LiveOptions { headed?: boolean; tracer?: Tracer; resultsFile?: string }

function classifyStop(st: StateReport): RowStatus | null {
  if (st.state === "AUTH_REQUIRED") return "AUTH_REQUIRED";
  if (st.state === "CAPTCHA" || st.state === "RATE_LIMITED") return "BLOCKED";
  if (st.navigation && !st.navigation.ok) return "BLOCKED";
  if (st.state !== "CHAT_READY") return "BLOCKED";
  return null;
}

export async function runLive(providerId: string, config: any, opts: LiveOptions = {}): Promise<LiveRun> {
  const t0 = Date.now();
  const spec = adapterFor(providerId);
  if (!spec) throw new Error("no browser adapter for " + providerId);
  const tracer = opts.tracer || new Tracer({ echo: true });
  const sessions = new BrowserSessionManager({ headless: !opts.headed, tracer, executablePath: process.env.CLOSENI_CHROMIUM || undefined });
  const profileDir = storagePaths(process.env.CLOSENI_STORAGE, config).profileDir;
  const provider = new ChatWebProvider(spec, { sessions, tracer, profileDir });
  const rows: LiveRow[] = [];
  let state: StateReport | null = null;
  const everything = ["Browser launch", "UI detection", "Prompt submission", "Response detection", "Streaming capture"].concat(LIVE_SCENARIOS.map((s) => s.capability));
  try {
    await provider.launch();
    rows.push({ capability: "Browser launch", status: "PASS", detail: "persistent profile " + path.basename(profileDir) });
    state = await provider.openChat();
    const stop = classifyStop(state);
    const why = state.state + ": " + state.evidence.join("; ") + (state.navigation && state.navigation.error ? " (" + state.navigation.errorKind + ")" : "");
    rows.push({ capability: "UI detection", status: state.state === "CHAT_READY" || state.state === "AUTH_REQUIRED" || state.state === "CAPTCHA" ? "PASS" : stop || "PASS", detail: why });
    if (stop) {
      for (const c of everything.slice(2)) rows.push({ capability: c, status: stop, detail: why });
    } else {
      let first = true;
      for (const sc of LIVE_SCENARIOS) {
        const partials: number[] = [];
        const r = await provider.ask(sc.prompt, { onPartial: (p) => partials.push(p.chars) });
        if (first) {
          rows.push({ capability: "Prompt submission", status: r.status === "failed" ? "FAIL" : "PASS", detail: r.extraction_metadata.warnings.join("; ") });
          rows.push({ capability: "Response detection", status: r.status === "complete" ? "PASS" : "PARTIAL", detail: "signal " + r.extraction_metadata.completionSignal + " in " + r.extraction_metadata.waitedMs + "ms" });
          rows.push({ capability: "Streaming capture", status: partials.length > 1 ? "PASS" : "PARTIAL", detail: partials.length + " partials" });
          first = false;
        }
        if (r.status === "failed" || r.status === "no-start") {
          const st2 = await provider.detectState();
          const s2 = classifyStop(st2);
          rows.push({ capability: sc.capability, status: s2 && s2 !== "BLOCKED" ? s2 : "FAIL", detail: st2.state + ": " + st2.evidence.join("; ") });
          if (s2 === "AUTH_REQUIRED" || st2.state === "RATE_LIMITED" || st2.state === "CAPTCHA") {
            for (const rest of LIVE_SCENARIOS.slice(LIVE_SCENARIOS.indexOf(sc) + 1)) rows.push({ capability: rest.capability, status: s2 || "BLOCKED", detail: "stopped: " + st2.state });
            break;
          }
          continue;
        }
        const j = sc.judge(r);
        rows.push({ capability: sc.capability, status: j.status, detail: j.detail });
      }
      const health = await provider.healthCheck();
      rows.push({ capability: "Selector health", status: health.ok ? (health.chains.some((c) => c.verdict === "fallback") ? "PARTIAL" : "PASS") : "FAIL", detail: health.summary });
    }
  } catch (err: any) {
    rows.push({ capability: "Run", status: "FAIL", detail: String(err && err.message || err).split("\n")[0] });
  } finally {
    await sessions.closeAll();
  }
  const run: LiveRun = { provider: spec.id, at: new Date().toISOString(), machine: os.hostname() + " (" + process.platform + ")", state, rows, durationMs: Date.now() - t0 };
  if (opts.resultsFile) mergeResults(opts.resultsFile, run);
  return run;
}

export function mergeResults(file: string, run: LiveRun): void {
  let all: Record<string, LiveRun> = {};
  try { all = JSON.parse(fs.readFileSync(file, "utf-8")); } catch { all = {}; }
  all[run.provider] = run;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(all, null, 2) + "\n");
}
