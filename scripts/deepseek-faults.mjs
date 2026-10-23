#!/usr/bin/env node
/**
 * Break DeepSeek's reply on purpose, live, and check what the agent does.
 *
 *   node scripts/deepseek-faults.mjs --scratch <dir> [--only a,b] [--dump]
 *
 * Works on a COPY of the signed-in profile (scripts/lib/scratch-profile.mjs),
 * deleted when the run ends. Each scenario routes the first request to
 * /api/v0/chat/completion and replaces it with a fault: an error event in
 * DeepSeek's own SSE format, an HTTP error, a dropped connection, a stall.
 * Every later request goes through untouched, so a retry gets a real answer.
 *
 * Without --dump each scenario asks through BrowserChatSession.ask - the call
 * the agent loop makes - and checks the outcome: the real reply after a
 * retry, or the error a person should see. --dump prints the page's markup
 * around the fault instead, which is how the selectors in deepseek.json were
 * measured.
 *
 * The SSE shapes are DeepSeek's (captured 9 October 2026): `event: ready`,
 * `data: {"v":{"response":{...}}}`, `{"p":"response/status","o":"SET","v":
 * "INCOMPLETE"}`, `event: hint` {type, content, clear_response, finish_reason},
 * `event: toast` {type, content, finish_reason}, `event: close`.
 */
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { prepareProfile, argValue, repoRoot } from "./lib/scratch-profile.mjs";

const scratch = argValue("--scratch");
const only = (argValue("--only", "") || "").split(",").filter(Boolean);
const dump = process.argv.includes("--dump");
const { cleanup } = prepareProfile(scratch);

const require = createRequire(path.join(repoRoot, "local-agent", "package.json"));
const { PlaywrightController } = require(path.join(repoRoot, "local-agent/dist/providers/playwright-controller.js"));
const { BrowserChatSession } = require(path.join(repoRoot, "local-agent/dist/providers/chat-session.js"));
const config = JSON.parse(fs.readFileSync(path.join(repoRoot, "local-agent/config/providers/deepseek.json"), "utf8"));
// Thinking and search off, as the agent runs it.
process.env.AGENT_CONTROLS = process.env.AGENT_CONTROLS || JSON.stringify({ "deep-thinking": false, "smart-search": false });

const sse = (...events) => events.join("\n\n") + "\n\n";
const ev = (name, data) => "event: " + name + "\ndata: " + JSON.stringify(data);
const data = (d) => "data: " + JSON.stringify(d);
// The head of the REAL reply when there is one: the faulted message must carry
// ids the server knows, or the page's next message names a parent that does
// not exist and the retry is refused - a failure of the harness, not the agent.
let realHead = null;
const head = () => realHead || [
  ev("ready", { request_message_id: 1, response_message_id: 2, model_type: "default" }),
  data({ v: { response: { message_id: 2, parent_id: 1, model: "", role: "ASSISTANT", thinking_enabled: false, ban_edit: false, ban_regenerate: false,
    status: "WIP", incomplete_message: null, accumulated_token_usage: 0, feedback: null, inserted_at: Date.now() / 1000, search_enabled: false,
    fragments: [], conversation_mode: "DEFAULT", has_pending_fragment: false, auto_continue: false, search_triggered: false, extra_search_providers: [] } } }),
];
const text = (s) => data({ p: "response/fragments", o: "APPEND", v: [{ id: 3, type: "RESPONSE", content: s, references: [], stage_id: 1 }] });
const status = (s) => data({ p: "response/status", o: "SET", v: s });
const close = (behavior = "none") => ev("close", { click_behavior: behavior, auto_resume: false });
const SSE = { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } };

const BUSY = "Server busy, please try again later.";
// The toast DeepSeek sent in a live long session, 10 October 2026.
const RATE = "Messages too frequent. Try again later.";

/**
 * name -> { fault(route), expect }. `expect` is "reply" (a retry gets the real
 * answer) or a regex the thrown error's message must match.
 */
const SCENARIOS = {
  "busy-hint": { fault: (r) => r.fulfill({ ...SSE, body: sse(...head(), ev("hint", { type: "error", content: BUSY, clear_response: true, finish_reason: "server_busy" }), close("retry")) }), expect: "reply" },
  "busy-incomplete": { fault: (r) => r.fulfill({ ...SSE, body: sse(...head(), text("Let me start by reading"), data({ p: "response", o: "BATCH", v: [{ p: "incomplete_message", v: BUSY }, { p: "quasi_status", v: "INCOMPLETE" }] }), status("INCOMPLETE"), close("retry")) }), expect: "reply" },
  "rate-toast": { fault: (r) => r.fulfill({ ...SSE, body: sse(ev("toast", { type: "error", content: RATE, finish_reason: "rate_limit_reached" }), close()) }), expect: "reply" },
  "http-429": { fault: (r) => r.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ code: 429, msg: "Too Many Requests" }) }), expect: "reply" },
  "http-500": { fault: (r) => r.fulfill({ status: 500, contentType: "application/json", body: "{}" }), expect: "reply" },
  "length-exceeded": { fault: (r) => r.fulfill({ ...SSE, body: sse(...head(), text("Partial answer"), status("CONTEXT_LENGTH_EXCEEDED"), close()) }), expect: /conversation is full|length limit/i },
  "content-filter": { fault: (r) => r.fulfill({ ...SSE, body: sse(...head(), text("Sorry"), status("CONTENT_FILTER"), close()) }), expect: "reply" },
  "token-usage": { fault: (r) => r.fulfill({ ...SSE, body: sse(...head(), text("Done"), data({ p: "response", o: "BATCH", v: [{ p: "accumulated_token_usage", v: 999999 }, { p: "quasi_status", v: "FINISHED" }] }), status("FINISHED"), close()) }), expect: "reply" },
  "empty": { fault: (r) => r.fulfill({ ...SSE, body: "" }), expect: "reply" },
  "abort": { fault: (r) => r.abort("connectionreset"), expect: "reply" },
  // Last: the page answers an invalid token by signing the profile copy out.
  "signed-out": { fault: (r) => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ code: 40003, msg: "Authorization Failed (invalid token)", data: null }) }), expect: /sign in/i },
};

async function domAround(page) {
  return page.evaluate((needles) => {
    const out = [];
    const all = Array.from(document.querySelectorAll("body *"));
    for (const n of needles) {
      for (const el of all) {
        const t = el.textContent || "";
        if (!t.includes(n) || Array.from(el.children).some((c) => (c.textContent || "").includes(n))) continue;
        const chain = [];
        for (let p = el; p && p !== document.body && chain.length < 7; p = p.parentElement) {
          chain.push(p.tagName.toLowerCase() + (p.getAttribute("role") ? "[role=" + p.getAttribute("role") + "]" : "") + (p.className && typeof p.className === "string" ? "." + p.className.trim().split(/\s+/).join(".") : ""));
        }
        out.push(JSON.stringify(n) + " in " + chain.join(" < "));
      }
    }
    const msgs = document.querySelectorAll(".ds-message");
    const last = msgs[msgs.length - 1];
    const tail = last && last.parentElement ? last.parentElement.outerHTML.replace(/<svg[\s\S]*?<\/svg>/g, "<svg/>").replace(/<path[^>]*>/g, "") : "";
    const ta = document.querySelector("textarea");
    let box = ta; for (let i = 0; i < 5 && box && box.parentElement; i++) box = box.parentElement;
    out.push("url " + location.href + " | composer: " + JSON.stringify(box ? box.innerText.slice(0, 300) : null) + " | textarea disabled=" + (ta && ta.disabled));
    return out.join("\n") + "\n--- last message's parent (tail) ---\n" + tail.slice(-2500);
  }, ["Server busy", "too frequent", "rate limit", "Continue", "Try again", "temporarily unavailable", "Send failed", "Length limit", "New chat", "Network error", "Partial answer", "Let me start"]);
}

const ctl = new PlaywrightController(config);
ctl.setWorkspace(path.join(scratch, "faults-ws"));
const session = new BrowserChatSession(ctl, config, { workspace: path.join(scratch, "faults-ws"), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) });
const results = [];
try {
  await session.start();
  let n = 0;
  for (const [name, sc] of Object.entries(SCENARIOS)) {
    if (only.length && !only.includes(name)) continue;
    n++;
    await ctl.startFreshConversation(config);
    await ctl.waitForLogin(30000);
    let hit = 0;
    realHead = null;
    await ctl.page.route("**/api/v0/chat/completion*", async (route) => {
      if (hit++ !== 0) return route.continue();
      if (/head\(\)/.test(String(sc.fault))) {
        // Ask the server for real, keep its first two events (ready, the
        // response header with its ids), and replace the rest with the fault.
        const real = await route.fetch();
        realHead = (await real.text()).split(/\r?\n\r?\n/).filter((b) => b.trim()).slice(0, 2);
      }
      await sc.fault(route);
    });
    const token = "PONG" + n;
    const t0 = Date.now();
    if (dump) {
      const c = await ctl.countMessages(config), last = await ctl.getLastMessageText(config);
      await ctl.sendPrompt("Reply with exactly " + token + " and nothing else.", config);
      await new Promise((r) => setTimeout(r, 8000));
      console.log("\n===== " + name + " =====\n" + await domAround(ctl.page) + "\n(count " + c + " -> " + await ctl.countMessages(config) + ", last " + JSON.stringify(last) + ")");
    } else {
      let outcome, ok;
      try {
        const reply = await session.ask("Reply with exactly " + token + " and nothing else.");
        outcome = "reply " + JSON.stringify(reply.slice(0, 80));
        ok = sc.expect === "reply" ? reply.includes(token) : false;
      } catch (e) {
        outcome = "error " + JSON.stringify(String(e && e.message || e).slice(0, 200));
        ok = sc.expect instanceof RegExp && sc.expect.test(String(e && e.message));
      }
      const secs = Math.round((Date.now() - t0) / 1000);
      results.push({ name, ok, secs, outcome, hits: hit });
      console.log("[harness] " + (ok ? "PASS" : "FAIL") + " " + name + " (" + secs + "s, " + hit + " request(s)): " + outcome);
    }
    await ctl.page.unroute("**/api/v0/chat/completion*");
  }
} finally {
  await session.close().catch(() => {});
  cleanup();
}
if (!dump) {
  console.log("\n[harness] " + results.filter((r) => r.ok).length + "/" + results.length + " passed");
  process.exitCode = results.every((r) => r.ok) ? 0 : 1;
}
