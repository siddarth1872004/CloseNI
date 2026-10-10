#!/usr/bin/env node
/**
 * A long CloseNI Code session on DeepSeek, live: many small coding turns in one
 * agent session, as the app runs it, with the conversation rolling over.
 *
 *   node scripts/long-session.mjs --scratch <dir> [--turns 40] [--budget 20000]
 *                                 [--gap 4000] [--no-resume-check] [--until-rollover]
 *
 * Drives `agent-session` exactly as native/src/AgentService does: JSON lines on
 * stdin, AGENT_EVENT lines on stdout, every permission answered "allow". Works
 * on a COPY of the signed-in profile (scripts/lib/scratch-profile.mjs), deleted
 * when the run ends. --budget lowers contextBudgetChars in a config copy under
 * the scratch directory (never the committed config) so a short run rolls over
 * several times; --budget 0 keeps the real one. --until-rollover ends the run
 * after the first rollover.
 *
 * Per turn it records the latency, rollovers (compacting/compacted), the
 * agent's RSS, the browser's memory (PSS summed over the agent's child
 * processes) and any error, into <scratch>/long-session.json. It stops early
 * on a rate limit - that is a finding, not something to push through. At the
 * end it restarts the session and asks about the last turn, to check that the
 * saved thread is the one resumed.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { prepareProfile, argValue, repoRoot } from "./lib/scratch-profile.mjs";

const scratch = argValue("--scratch");
const turns = Number(argValue("--turns", "40"));
const budget = Number(argValue("--budget", "20000"));
const gap = Number(argValue("--gap", "4000"));
const resumeCheck = !process.argv.includes("--no-resume-check");
const untilRollover = process.argv.includes("--until-rollover");
const { storage, cleanup } = prepareProfile(scratch);

const providers = path.join(scratch, "providers");
fs.mkdirSync(providers, { recursive: true });
const config = JSON.parse(fs.readFileSync(path.join(repoRoot, "local-agent/config/providers/deepseek.json"), "utf8"));
if (budget > 0) config.contextBudgetChars = budget;
fs.writeFileSync(path.join(providers, "deepseek.json"), JSON.stringify(config, null, 2));

const ws = path.join(scratch, "ws-long");
fs.rmSync(ws, { recursive: true, force: true });
fs.mkdirSync(ws, { recursive: true });
fs.writeFileSync(path.join(ws, "README.md"), "# mathlib\n\nA tiny JavaScript library. `lib.js` exports functions; `test.js` checks them with node's assert.\n");
fs.writeFileSync(path.join(ws, "lib.js"), "module.exports = {};\n");
fs.writeFileSync(path.join(ws, "test.js"), "const assert = require(\"assert\");\nconst lib = require(\"./lib\");\nconsole.log(\"ok\");\n");

const NAMES = ["double", "square", "cube", "negate", "half", "inc", "dec", "isEven", "isOdd", "abs", "sign", "clamp01", "max2", "min2", "avg2",
  "sum3", "isZero", "recip", "pow4", "triple", "mod3", "isPositive", "floorHalf", "toCents", "fromCents", "hypot2", "lerp", "isInt", "pct", "cmp",
  "gcd", "lcm", "fact", "fib", "isPrime", "digits", "rev", "palin", "sumTo", "mean"];
function task(i) {
  const name = NAMES[i % NAMES.length] + (i >= NAMES.length ? String(Math.floor(i / NAMES.length) + 1) : "");
  if (i % 10 === 9) return { name: null, text: "Run `node test.js` and tell me in one line whether it passes." };
  if (i % 7 === 6) return { name: null, text: "Read lib.js and tell me in one line how many functions it exports. Do not change anything." };
  return { name: name, text: "In lib.js, add and export a function `" + name + "` (pick the obvious meaning of the name, one line of code). Add one assert for it in test.js before the final console.log. Keep both files otherwise unchanged. Be brief." };
}

function procTree(root) {
  const kids = new Map();
  for (const d of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = fs.readFileSync("/proc/" + d + "/stat", "utf8");
      const ppid = Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[1]);
      if (!kids.has(ppid)) kids.set(ppid, []);
      kids.get(ppid).push(Number(d));
    } catch { /* gone */ }
  }
  const out = [];
  const walk = (p) => { for (const k of kids.get(p) || []) { out.push(k); walk(k); } };
  walk(root);
  return out;
}
function kb(file, key) {
  try { const m = new RegExp("^" + key + ":\\s+(\\d+)", "m").exec(fs.readFileSync(file, "utf8")); return m ? Number(m[1]) : 0; } catch { return 0; }
}
function memory(pid) {
  const agent = kb("/proc/" + pid + "/status", "VmRSS");
  let browser = 0;
  for (const p of procTree(pid)) browser += kb("/proc/" + p + "/smaps_rollup", "Pss");
  return { agentMB: Math.round(agent / 1024), browserMB: Math.round(browser / 1024) };
}

function startSession() {
  const child = spawn(process.execPath, [path.join(repoRoot, "local-agent/dist/index.js"), "agent-session", ws, "deepseek", "acceptEdits"], {
    cwd: ws,
    env: { ...process.env, CLOSENI_STORAGE: storage, AGENT_PROVIDER_DIR: providers, AGENT_CONTROLS: JSON.stringify({ "deep-thinking": false, "smart-search": false }) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const log = fs.createWriteStream(path.join(scratch, "long-session.log"), { flags: "a" });
  const waiters = [];
  let buf = "";
  child.stdout.on("data", (d) => {
    log.write(d);
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.startsWith("AGENT_EVENT: ")) continue;
      let ev; try { ev = JSON.parse(line.slice(13)); } catch { continue; }
      if (ev.type === "permission") child.stdin.write(JSON.stringify({ type: "permission", id: ev.id, decision: "allow" }) + "\n");
      for (const w of waiters.slice()) w(ev);
    }
  });
  child.stderr.on("data", (d) => log.write(d));
  const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
  const until = (pred, ms) => new Promise((resolve, reject) => {
    const seen = [];
    const t = setTimeout(() => { waiters.splice(waiters.indexOf(on), 1); reject(new Error("timed out after " + ms / 1000 + "s")); }, ms);
    const on = (ev) => { seen.push(ev); if (pred(ev)) { clearTimeout(t); waiters.splice(waiters.indexOf(on), 1); resolve({ ev, seen }); } };
    waiters.push(on);
  });
  const exited = new Promise((r) => child.on("exit", r));
  const stop = async () => {
    send({ type: "close" });
    const t = setTimeout(() => child.kill("SIGTERM"), 30000);
    await exited; clearTimeout(t);
  };
  return { child, send, until, stop };
}

const rows = [];
const outFile = path.join(scratch, "long-session.json");
const save = (extra) => fs.writeFileSync(outFile, JSON.stringify({ budget: config.contextBudgetChars, rows, ...extra }, null, 2));
let stoppedFor = "";
let resume = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let s = startSession();
  await s.until((e) => e.type === "ready", 120000);
  console.log("[long] session ready; budget " + config.contextBudgetChars + " chars, " + turns + " turns");
  let lastName = null;
  for (let i = 0; i < turns; i++) {
    const t = task(i);
    const t0 = Date.now();
    s.send({ type: "user", text: t.text });
    let res;
    try { res = await s.until((e) => e.type === "done", 20 * 60000); }
    catch (e) { rows.push({ turn: i + 1, error: "no done event: " + e.message }); stoppedFor = "hung turn"; break; }
    const secs = (Date.now() - t0) / 1000;
    const seen = res.seen;
    const mem = memory(s.child.pid);
    const row = {
      turn: i + 1, secs: Math.round(secs * 10) / 10, reason: res.ev.reason, error: res.ev.error || "",
      compacting: seen.filter((e) => e.type === "compacting").map((e) => e.size),
      compacted: seen.filter((e) => e.type === "compacted").map((e) => ({ summary: e.summary, files: e.files })),
      tools: seen.filter((e) => e.type === "tool" && (e.status === "done" || e.status === "error")).length,
      ...mem,
    };
    if (t.name && row.reason === "complete") lastName = t.name;
    rows.push(row);
    save({});
    console.log("[long] turn " + row.turn + ": " + row.secs + "s " + row.reason + (row.compacted.length ? " ROLLOVER(" + row.compacting.join(";") + ")" : "") +
      " agent " + row.agentMB + "MB browser " + row.browserMB + "MB" + (row.error ? " ERROR " + row.error.slice(0, 160) : ""));
    if (/rate limit|too frequent/i.test(row.error)) { stoppedFor = "rate limited: " + row.error; break; }
    if (/Signed out/i.test(row.error)) { stoppedFor = "signed out: " + row.error; break; }
    if (untilRollover && row.compacted.length) break;
    await sleep(gap);
  }
  await s.stop();

  if (resumeCheck && !stoppedFor && lastName) {
    // A restart resumes the saved thread: the new session's first message
    // must know what the last turn did, and must not start a new chat.
    s = startSession();
    await s.until((e) => e.type === "ready", 120000);
    s.send({ type: "user", text: "Without reading any file: what was the name of the last function I asked you to add? Answer with just the name." });
    const res = await s.until((e) => e.type === "done", 10 * 60000);
    const said = res.seen.filter((e) => e.type === "assistant").map((e) => e.text).join(" ");
    resume = { expected: lastName, said: said.slice(0, 200), ok: new RegExp("\\b" + lastName + "\\b").test(said), rolledOver: res.seen.some((e) => e.type === "compacted"), tools: res.seen.filter((e) => e.type === "tool").length };
    console.log("[long] resume check: expected " + lastName + ", got " + JSON.stringify(resume.said) + (resume.ok ? " OK" : " MISMATCH"));
    await s.stop();
  }
} finally {
  const sessions = path.join(storage, "sessions.json");
  let saved = null;
  try { saved = JSON.parse(fs.readFileSync(sessions, "utf8"))[ws] || null; } catch { /* none */ }
  const ok = rows.filter((r) => r.secs !== undefined);
  const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : 0; };
  const summary = {
    turns: ok.length,
    completed: ok.filter((r) => r.reason === "complete").length,
    rollovers: ok.reduce((n, r) => n + r.compacted.length, 0),
    errors: ok.filter((r) => r.error).map((r) => "turn " + r.turn + ": " + r.error.slice(0, 160)),
    latencyMedianFirst10: med(ok.slice(0, 10).map((r) => r.secs)),
    latencyMedianLast10: med(ok.slice(-10).map((r) => r.secs)),
    agentMB: ok.length ? { first: ok[0].agentMB, last: ok[ok.length - 1].agentMB, max: Math.max(...ok.map((r) => r.agentMB)) } : null,
    browserMB: ok.length ? { first: ok[0].browserMB, last: ok[ok.length - 1].browserMB, max: Math.max(...ok.map((r) => r.browserMB)) } : null,
    stoppedFor, resume, savedThread: saved && { activeChat: saved.activeChat, size: saved.conversationSize },
  };
  save({ summary });
  console.log("[long] summary " + JSON.stringify(summary, null, 2));
  cleanup();
}
