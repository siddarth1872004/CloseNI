/*
 * A local stand-in for a web chat provider.
 *
 * It serves a page shaped like the real chat UIs the agent drives (a textarea, a
 * submit button, and a list of assistant messages) and replies with whatever the
 * test queued up. That lets the whole orchestrator — send, wait, extract, parse,
 * patch, verify, retry — run end to end without a real account or network.
 *
 * Queue replies by POSTing to /__queue. Each send pops the next one; the last
 * reply repeats if the agent asks more times than the test queued.
 */
const http = require("http");

function createMockProvider() {
  /** @type {string[]} */
  let queued = [];
  /** @type {string[]} */
  const prompts = [];
  let replyDelayMs = 0;
  let renderMode = "append";
  /** threadId -> { prompts: string[], replies: string[] } */
  const threads = new Map();
  let nextThreadId = 1;

  const page = `<!doctype html>
<html><head><meta charset="utf-8"><title>Mock Chat</title></head>
<body>
  <div id="thread"></div>
  <textarea id="input" placeholder="Message"></textarea>
  <button id="send" type="submit">Send</button>
<script>
async function send() {
  var input = document.getElementById('input');
  var text = input.value;
  if (!text) return;
  input.value = '';
  var thread = document.getElementById('thread');
  var res = await fetch('/__reply', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: text
  });
  var body = await res.json();
  // Real chat sites move you onto a per-thread URL after the first message.
  if (body.threadId && location.pathname.indexOf('/c/') !== 0) {
    history.replaceState({}, '', '/c/' + body.threadId);
  }
  // Render the reply the way a chat UI would: markdown-ish HTML with fenced code
  // becoming <pre><code>, so the agent's extraction logic sees a realistic DOM.
  var msg = document.createElement('div');
  msg.className = 'markdown-body assistant-msg';
  // "replace" reuses the last bubble instead of adding one, mimicking a UI that
  // re-renders in place — the message count then never grows.
  if (body.renderMode === 'replace' && thread.lastElementChild) {
    thread.removeChild(thread.lastElementChild);
  }
  var parts = String(body.reply).split(/\`\`\`(?:[a-zA-Z]*)\\n?/);
  for (var i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      var pre = document.createElement('pre');
      var code = document.createElement('code');
      code.textContent = parts[i].replace(/\\n$/, '');
      pre.appendChild(code);
      msg.appendChild(pre);
    } else if (parts[i].trim()) {
      var p = document.createElement('p');
      p.textContent = parts[i].trim();
      msg.appendChild(p);
    }
  }
  thread.appendChild(msg);
}
document.getElementById('send').addEventListener('click', send);
document.getElementById('input').addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
</script>
</body></html>`;

  const escapeHtml = (s) =>
    String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/__reply") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        // The page tells us which thread it is on via the Referer path.
        const ref = req.headers.referer || "";
        const m = ref.match(/\/c\/([^/?#]+)/);
        const threadId = m ? m[1] : String(nextThreadId++);
        if (!threads.has(threadId)) threads.set(threadId, { prompts: [], replies: [] });
        const thread = threads.get(threadId);

        prompts.push(body);
        thread.prompts.push(body);
        const reply = queued.length > 1 ? queued.shift() : (queued[0] ?? "(no reply queued)");
        thread.replies.push(reply);

        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ reply: reply, renderMode: renderMode, threadId: threadId }));
        }, replyDelayMs);
      });
      return;
    }

    // Replay a thread's assistant messages so a resumed thread is not blank.
    const m = req.url.match(/^\/c\/([^/?#]+)/);
    const prior = m && threads.has(m[1]) ? threads.get(m[1]).replies : [];
    const seeded = prior
      .map((r) => '<div class="markdown-body assistant-msg"><p>' + escapeHtml(r) + "</p></div>")
      .join("");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(page.replace('<div id="thread"></div>', '<div id="thread">' + seeded + "</div>"));
  });

  return {
    async listen() {
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      return "http://127.0.0.1:" + server.address().port + "/";
    },
    close() {
      return new Promise((r) => server.close(r));
    },
    /** Queue the replies the provider will hand back, in order. */
    setReplies(replies) {
      queued = replies.slice();
      prompts.length = 0;
    },
    setReplyDelay(ms) {
      replyDelayMs = ms;
    },
    /** "append" adds a bubble per reply; "replace" reuses the last one. */
    setRenderMode(mode) {
      renderMode = mode;
    },
    /** Every prompt the agent sent, in order — lets tests assert on prompt content. */
    prompts() {
      return prompts.slice();
    },
    /** How many distinct chat threads have been created. */
    threadCount() {
      return threads.size;
    },
    promptsForThread(id) {
      return threads.has(id) ? threads.get(id).prompts.slice() : [];
    },
    /** Reset thread state between sections so counts do not leak. */
    resetThreads() {
      threads.clear();
      nextThreadId = 1;
    },
  };
}

module.exports = { createMockProvider };
