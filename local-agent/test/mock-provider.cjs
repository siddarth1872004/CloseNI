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
  <button id="stop" style="display:none;">Stop</button>
<script>
async function send() {
  var input = document.getElementById('input');
  var text = input.value;
  if (!text) return;
  input.value = '';
  var thread = document.getElementById('thread');
  // Visible only while a reply is pending, the way a real chat UI behaves.
  var stop = document.getElementById('stop');
  stop.style.display = '';
  var res = await fetch('/__reply', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: text
  });
  var body = await res.json();
  stop.style.display = 'none';
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

  /*
   * A page carrying all three providers' control shapes at once, served at
   * /__controls. The point is that the shapes differ in kind, so each module is
   * driven against markup that behaves the way the real thing does:
   *
   *   DeepSeek — inline, state in aria-pressed / aria-checked, no menu
   *   Qwen     — combobox whose value is the trigger's text and whose options
   *              do not exist until it is opened, each option a card with a
   *              description underneath
   *   GLM      — menu whose options carry data-value and data-selected
   *
   * The scripting is deliberately real: clicking updates the same attributes
   * the modules read back to confirm, so a module that clicks without checking
   * fails here rather than in production.
   */
  const controlsPage = `<!doctype html>
<html><head><meta charset="utf-8"><title>Controls Lab</title></head>
<body>
  <!-- DeepSeek -->
  <div role="radiogroup">
    <div data-model-type="default" role="radio" aria-checked="true">Instant</div>
    <div data-model-type="expert" role="radio" aria-checked="false">Advanced</div>
  </div>
  <div class="ds-toggle-button" aria-pressed="true" tabindex="0"><span>Deep thinking</span></div>
  <div class="ds-toggle-button" aria-pressed="false" tabindex="0"><span>Smart Search</span></div>
  <!-- A toggle with no readable state: must be reported, never guessed at. -->
  <div class="ds-toggle-button" tabindex="0"><span>Mystery</span></div>

  <!-- Qwen -->
  <div aria-label="Select Model" aria-haspopup="listbox" data-menu="qwen-model">
    <div class="index-module__model-selector-text___XvWe0">Qwen3.8-Max</div>
  </div>
  <div id="qwen-model" class="menu" style="display:none">
    <div role="option"><div class="opt-title">Qwen3.8-Max</div><div class="desc">Latest</div></div>
    <div role="option"><div class="opt-title">Qwen3.7-Max</div><div class="desc">Built on Qwen3.7</div></div>
  </div>
  <div aria-label="Thinking" data-menu="qwen-thinking"><span>Fast</span></div>
  <div id="qwen-thinking" class="menu" style="display:none">
    <div role="option">Auto</div>
    <div role="option">Thinking</div>
    <div role="option">Fast</div>
  </div>

  <!-- GLM -->
  <button aria-label="Select a model" data-menu="glm-model">GLM-5.2</button>
  <div id="glm-model" class="menu" style="display:none">
    <div aria-label="model-item" data-value="glm-5.2" data-selected="true">GLM-5.2</div>
    <div aria-label="model-item" data-value="glm-4.7" data-selected="false">GLM-4.7</div>
  </div>
  <div data-dropdown-menu-trigger data-menu="glm-think">Deep Think</div>
  <div id="glm-think" class="menu" style="display:none">
    <div data-selected="false">High</div>
    <div data-selected="true">Max</div>
  </div>
<script>
function closeAll() {
  var menus = document.querySelectorAll('.menu');
  for (var i = 0; i < menus.length; i++) menus[i].style.display = 'none';
}
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeAll(); });

// DeepSeek: radios are exclusive, toggles flip. A control with no aria-pressed
// still moves on click, so a module that clicks blind would look successful.
document.querySelectorAll('[role="radio"]').forEach(function (r) {
  r.addEventListener('click', function () {
    document.querySelectorAll('[role="radio"]').forEach(function (o) { o.setAttribute('aria-checked', 'false'); });
    r.setAttribute('aria-checked', 'true');
  });
});
document.querySelectorAll('.ds-toggle-button').forEach(function (t) {
  t.addEventListener('click', function () {
    if (!t.hasAttribute('aria-pressed')) return;
    t.setAttribute('aria-pressed', t.getAttribute('aria-pressed') === 'true' ? 'false' : 'true');
  });
});

// Menus: opening one closes the others, the way a portal-rendered menu behaves.
document.querySelectorAll('[data-menu]').forEach(function (trigger) {
  trigger.addEventListener('click', function () {
    var menu = document.getElementById(trigger.getAttribute('data-menu'));
    var wasOpen = menu.style.display !== 'none';
    closeAll();
    menu.style.display = wasOpen ? 'none' : '';
  });
});

// Qwen: picking writes the label onto the trigger, which is where its state lives.
['qwen-model', 'qwen-thinking'].forEach(function (id) {
  var trigger = document.querySelector('[data-menu="' + id + '"]');
  document.querySelectorAll('#' + id + ' [role="option"]').forEach(function (opt) {
    opt.addEventListener('click', function () {
      var title = opt.querySelector('.opt-title');
      trigger.firstElementChild.textContent = (title || opt).textContent.trim();
      closeAll();
    });
  });
});

// GLM: picking moves data-selected and updates the trigger; the menu closes,
// taking the options out of view, so confirmation has to come from the trigger.
document.querySelectorAll('#glm-model [aria-label="model-item"]').forEach(function (opt) {
  opt.addEventListener('click', function () {
    document.querySelectorAll('#glm-model [aria-label="model-item"]').forEach(function (o) { o.setAttribute('data-selected', 'false'); });
    opt.setAttribute('data-selected', 'true');
    document.querySelector('[aria-label="Select a model"]').textContent = opt.getAttribute('data-value');
    closeAll();
  });
});
document.querySelectorAll('#glm-think [data-selected]').forEach(function (opt) {
  opt.addEventListener('click', function () {
    document.querySelectorAll('#glm-think [data-selected]').forEach(function (o) { o.setAttribute('data-selected', 'false'); });
    opt.setAttribute('data-selected', 'true');
    closeAll();
  });
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

    if (req.url.startsWith("/__controls")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(controlsPage);
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
