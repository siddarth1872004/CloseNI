/*
 * A local web the browser-native layer is tested against.
 *
 * Nothing here pretends to BE DeepSeek, Qwen or GLM. Each "flavor" reproduces
 * the documented, measured SHAPE of one site - the parts the adapters rely on -
 * so the same code paths run: a DeepSeek-like page streams its reply over XHR to
 * /api/v0/chat/completion and has no distinct stop control (both MEASURED facts
 * from deepseek.json); a Qwen-like page shows a stop button while writing; a
 * GLM-like page uses a contenteditable composer and class names that force the
 * selector chains onto their fallbacks. Where a real site's markup is UNKNOWN
 * (reasoning sections, login walls), the fixture uses generic markup and the
 * report says the behaviour is proven on fixtures only.
 *
 *   /ai/<flavor>/<scenario>/          a chat page
 *   /ai/<flavor>/<scenario>/c/<id>    the same page after the first message
 *   /web/...                          a small documentation web for research
 *   /search?q=...                     a results page for the browser search backend
 *
 * The "model" is deterministic: the reply is chosen by keywords in the prompt,
 * so every provider flavor can be put through the identical scenario and asked
 * the identical questions.
 */
const http = require("http");
const { URL } = require("url");

const F = "```";

// ------------------------------------------------------------ the model --

/** Replies keyed by a keyword in the prompt. Deterministic on purpose. */
function scriptedReply(prompt, turn) {
  const p = String(prompt || "");
  const token = (/TOKEN-(\w+)/.exec(p) || [])[1];
  if (/Answer the research question using ONLY the evidence below/.test(p)) {
    // A stand-in for a model answering from the context it was given: it
    // quotes the first evidence lines with their citations, so the synthesis
    // path - prompt, reply, citation check - runs end to end.
    const lines = p.split("\n").filter((l) => /^- .*\[\d+\]/.test(l)).slice(0, 4).map((l) => l.replace(/^- /, "").replace(/\s*\([^)]*\)\s*$/, ""));
    const conflict = /Conflicts between sources/.test(p) ? "\n\nThe sources disagree on some figures; both values are cited above." : "";
    return { answer: "Based on the evidence:\n\n" + lines.map((l) => "- " + l).join("\n") + conflict };
  }
  if (/\bJSON\b/.test(p)) {
    return { answer: "Here is the JSON:\n\n" + F + "json\n" + JSON.stringify({ name: "closeni", ok: true, items: [1, 2, 3], nested: { depth: 2 } }, null, 2) + "\n" + F + "\n" };
  }
  if (/\bTABLE\b/.test(p)) {
    return { answer: "Comparison of the three options:\n\n| Option | Latency (ms) | Notes |\n| --- | --- | --- |\n| Alpha | 120 | stable |\n| Beta | 85 | uses [the Beta docs](http://docs.example.test/beta) |\n| Gamma | 240 | deprecated |\n\nAlpha is the default." };
  }
  if (/\bCODE\b/.test(p)) {
    return { answer: "A Python function and a shell command:\n\n" + F + "python\ndef slugify(text: str) -> str:\n    import re\n    text = text.lower().strip()\n    return re.sub(r'[^a-z0-9]+', '-', text).strip('-')\n" + F + "\n\nRun it with:\n\n" + F + "bash\npython -c \"from s import slugify; print(slugify('Hello World'))\"\n" + F + "\n\nThat prints `hello-world`." };
  }
  if (/\bREASON\b/.test(p)) {
    return { reasoning: "The user asks for 17 * 23. 17 * 20 = 340 and 17 * 3 = 51, so 340 + 51 = 391.", answer: "**17 × 23 = 391**" };
  }
  if (/\bLINKS\b/.test(p)) {
    return { answer: "Sources that discuss this:\n\n- [Playwright docs](https://playwright.dev/docs/intro) - the official guide\n- [MDN on MutationObserver](https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver)\n\nSee also the [download](http://files.example.test/report.pdf).\n\n## Summary\n\nBoth are primary sources." };
  }
  if (/\bLIST\b/.test(p)) {
    return { answer: "Steps:\n\n1. Launch the browser\n2. Open the chat\n3. Send the prompt\n\n- a bullet\n- another bullet" };
  }
  if (/\bLONG\b/.test(p)) {
    const para = "This paragraph is part of a deliberately long reply that exercises streaming capture and extraction of large responses. ";
    const parts = [];
    for (let i = 0; i < 60; i++) parts.push("## Section " + (i + 1) + "\n\n" + para.repeat(3));
    return { answer: parts.join("\n\n") + "\n\nEND-OF-LONG-REPLY" };
  }
  if (/\bEMPTY\b/.test(p)) return { answer: "" };
  if (/\bSAME\b/.test(p)) return { answer: "An identical answer every time." };
  if (/\bCONTEXT\b/.test(p)) {
    return { answer: "I received " + p.length + " characters. Last marker: " + ((/MARK-(\d+)/g.exec(p.slice(-200)) || [])[0] || "none") + "." };
  }
  return { answer: "ACK " + (token || "turn-" + turn) + ". Echo length " + p.length + "." };
}

// ------------------------------------------------------------- chat page --

const FLAVORS = {
  deepseek: {
    title: "DeepSeek-like fixture",
    composer: '<textarea id="chat-input" placeholder="Message the fixture" rows="3"></textarea>',
    // Measured: DeepSeek's send control is a div role=button, which the
    // configured button[type=submit] selector misses. Enter sends.
    send: '<div role="button" class="ds-icon-button send-ctl" aria-disabled="false" tabindex="0">&#x2191;</div>',
    stop: "",
    assistantClass: "ds-markdown ds-assistant-message",
    reasoningClass: "ds-thinking",
    transport: "xhr",
    endpoint: "api/v0/chat/completion",
    codeStyle: "banner",
  },
  qwen: {
    title: "Qwen-like fixture",
    composer: '<textarea id="chat-input" placeholder="How can I help?" rows="2"></textarea>',
    send: '<button type="submit" id="send-btn" class="send-button">Send</button>',
    stop: '<button id="stop-btn" class="stop-button" style="display:none">Stop</button>',
    assistantClass: "chat-assistant markdown-body",
    reasoningClass: "thinking-block",
    transport: "fetch",
    endpoint: "api/stream",
    codeStyle: "plain",
  },
  glm: {
    title: "GLM-like fixture",
    composer: '<div id="chat-input" contenteditable="true" role="textbox" aria-label="Message"></div>',
    send: '<button id="send-btn" aria-label="Send"><svg width="10" height="10"></svg></button>',
    stop: '<button id="stop-btn" aria-label="Stop" style="display:none"><svg width="10" height="10"></svg></button>',
    // Chosen so [class*="assistant"] and .markdown-body both miss: the chain
    // must fall through to its third strategy and the diagnosis must say so.
    assistantClass: "message bot-reply",
    reasoningClass: "reasoning-panel",
    transport: "fetch",
    endpoint: "api/stream",
    codeStyle: "plain",
  },
};

function chatPage(flavorName, scenario, prefix) {
  const fl = FLAVORS[flavorName];
  if (scenario === "login") {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${fl.title} - sign in</title></head><body>
<main><h1>Welcome back</h1><form action="#" onsubmit="return false">
<label>Email <input type="email" name="email"></label>
<label>Password <input type="password" name="password"></label>
<button type="submit">Log in</button></form>
<p><a href="#">Sign up</a></p></main></body></html>`;
  }
  if (scenario === "captcha") {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Just a moment...</title></head><body>
<div id="challenge-form"><p>Checking your browser before accessing the site.</p>
<iframe title="reCAPTCHA" src="${prefix}recaptcha/api2/anchor" width="300" height="80"></iframe></div></body></html>`;
  }
  if (scenario === "nocomposer") {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${fl.title} - maintenance</title></head><body>
<main><h1>Scheduled maintenance</h1><p>The chat is unavailable while we upgrade our systems. Please come back in an hour.</p></main></body></html>`;
  }
  const cfg = JSON.stringify({ flavor: flavorName, scenario, prefix, fl });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${fl.title}</title>
<style>
body{font-family:sans-serif;margin:0;display:flex;flex-direction:column;height:100vh}
#thread{flex:1;overflow:auto;padding:12px}
#composer-row{display:flex;gap:8px;padding:12px;border-top:1px solid #ccc}
#chat-input{flex:1;min-height:40px}
.user-msg{background:#eef;margin:6px 0;padding:6px}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center}
.overlay>div{background:#fff;padding:20px}
</style></head><body>
<div id="loading" aria-busy="true" role="progressbar">Loading...</div>
<div id="app" style="display:none">
  <nav><a href="${prefix}">New chat</a></nav>
  <div id="thread"></div>
  <div id="composer-row">${fl.composer}${fl.send}${fl.stop}</div>
</div>
<script>
const CFG = ${cfg};
const FL = CFG.fl;
let turn = 0;
let busy = false;
let controller = null;
const $ = (id) => document.getElementById(id);

function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function inline(s){
  return esc(s)
    .replace(/\`([^\`]+)\`/g,'<code>$1</code>')
    .replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>')
    .replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
}
function codeBlock(lang, code){
  if (FL.codeStyle === 'banner') {
    return '<div class="md-code-block"><div class="md-code-block-banner"><span class="lang-tag">' + esc(lang) + '</span>' +
      '<div role="button" class="copy-ctl" tabindex="0"><span class="code-info-button-text">Copy</span></div>' +
      '<div role="button" class="dl-ctl" tabindex="0"><span class="code-info-button-text">Download</span></div></div>' +
      '<pre><code>' + highlight(code) + '</code></pre></div>';
  }
  return '<pre><code class="language-' + esc(lang) + '">' + esc(code) + '</code></pre>';
}
// Shred code into token spans the way a highlighter does.
function highlight(code){
  return code.split(/(\\s+)/).map(function(t){ return /\\s/.test(t) ? esc(t) : '<span class="token">' + esc(t) + '</span>'; }).join('');
}
function md(src){
  const lines = String(src).split('\\n');
  let html = '', i = 0;
  while (i < lines.length) {
    const l = lines[i];
    const fence = /^\`\`\`(\\w*)/.exec(l);
    if (fence) {
      const buf = []; i++;
      while (i < lines.length && !/^\`\`\`/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++; html += codeBlock(fence[1] || 'text', buf.join('\\n')); continue;
    }
    const h = /^(#{1,6})\\s+(.*)/.exec(l);
    if (h) { html += '<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'; i++; continue; }
    if (/^\\|/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\\|/.test(lines[i])) { rows.push(lines[i]); i++; }
      const cells = (r) => r.replace(/^\\||\\|$/g,'').split('|').map(c => c.trim());
      let t = '<table><thead><tr>' + cells(rows[0]).map(c => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>';
      for (const r of rows.slice(2)) t += '<tr>' + cells(r).map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>';
      html += t + '</tbody></table>'; continue;
    }
    if (/^(\\d+\\.|-)\\s/.test(l)) {
      const ordered = /^\\d/.test(l);
      let t = ordered ? '<ol>' : '<ul>';
      while (i < lines.length && /^(\\d+\\.|-)\\s/.test(lines[i]) && (/^\\d/.test(lines[i]) === ordered)) {
        t += '<li>' + inline(lines[i].replace(/^(\\d+\\.|-)\\s/, '')) + '</li>'; i++;
      }
      html += t + (ordered ? '</ol>' : '</ul>'); continue;
    }
    if (!l.trim()) { i++; continue; }
    // Always consume the current line: a streamed "#" with no heading text yet
    // matches no rule above, and a loop that does not advance hangs the page.
    const para = [l]; i++;
    while (i < lines.length && lines[i].trim() && !/^(\`\`\`|#|\\||\\d+\\.\\s|-\\s)/.test(lines[i])) { para.push(lines[i]); i++; }
    html += '<p>' + inline(para.join(' ')) + '</p>';
  }
  return html;
}

// A rich-text editor turns its paragraphs into lines; innerText is the closest
// a plain contenteditable gets to that (textContent drops <br> and <div> breaks).
function composerText(){ const c = $('chat-input'); return c.tagName === 'TEXTAREA' ? c.value : c.innerText; }
function clearComposer(){ const c = $('chat-input'); if (c.tagName === 'TEXTAREA') c.value = ''; else c.textContent = ''; }
function setBusy(b){
  busy = b;
  const s = $('stop-btn'); if (s) s.style.display = b ? '' : 'none';
  const c = $('chat-input'); if (c.tagName === 'TEXTAREA') c.disabled = false;
}

function showLoginModal(){
  const o = document.createElement('div');
  o.className = 'overlay';
  o.innerHTML = '<div role="dialog" aria-modal="true"><h2>Log in to continue</h2><input type="password" aria-label="Password"><button>Log in</button></div>';
  document.body.appendChild(o);
}

function send(){
  if (busy) return;
  const text = composerText();
  if (!text.trim()) return;
  if (CFG.scenario === 'login-on-send') { showLoginModal(); return; }
  // The site's own script locks up: the renderer's main thread never returns.
  if (CFG.scenario === 'hang-renderer') { setTimeout(function () { for (;;) {} }, 200); }
  clearComposer();
  turn++;
  const u = document.createElement('div'); u.className = 'user-msg'; u.textContent = text; $('thread').appendChild(u);
  if (turn === 1 && location.pathname.indexOf('/c/') === -1) {
    history.replaceState({}, '', CFG.prefix + 'c/' + 'conv' + Math.random().toString(36).slice(2).padEnd(18, 'x'));
  }
  if (CFG.scenario === 'layoutchange' && turn === 2) {
    // A redesign between two replies: the class every selector keyed on is gone.
    for (const el of document.querySelectorAll('.' + FL.assistantClass.split(' ')[0])) el.className = 'rewritten-bubble';
    FL.assistantClass = 'rewritten-bubble';
  }
  const msg = document.createElement('div');
  msg.className = FL.assistantClass;
  msg.setAttribute('data-message-id', 'msg-' + turn + '-' + Date.now());
  let answer = '', reasoning = '';
  let started = false;
  const render = () => {
    if (!started) { started = true; $('thread').appendChild(msg); }
    let html = '';
    if (reasoning) html += '<div class="' + FL.reasoningClass + '" aria-label="Thinking">' + md(reasoning) + '</div>';
    html += md(answer);
    msg.innerHTML = html;
    $('thread').scrollTop = 1e9;
  };
  const onChunk = (obj) => {
    if (obj.t === 'r') reasoning += obj.v; else answer += obj.v;
    if (CFG.scenario === 'rewrite' && obj.last) answer = answer.toUpperCase();
    render();
  };
  const onEnd = (status) => {
    setBusy(false);
    if (status === 429 && FL.transport !== 'xhr') {
      const a = document.createElement('div'); a.setAttribute('role','alert'); a.textContent = 'Too many requests. Please try again later.'; document.body.appendChild(a);
    }
    if (status >= 500) {
      const a = document.createElement('div'); a.setAttribute('role','alert'); a.textContent = 'Something went wrong. Please retry.'; document.body.appendChild(a);
    }
    if (CFG.scenario === 'empty-bubble' && !started) render();
  };
  setBusy(true);
  const body = JSON.stringify({ prompt: text, turn: turn, scenario: CFG.scenario });
  const url = CFG.prefix + FL.endpoint;
  if (FL.transport === 'xhr') {
    const x = new XMLHttpRequest();
    let seen = 0;
    x.open('POST', url);
    x.setRequestHeader('Content-Type','application/json');
    x.onprogress = () => {
      const data = x.responseText.slice(seen); seen = x.responseText.length;
      for (const line of data.split('\\n')) { if (line.startsWith('data: ')) { try { onChunk(JSON.parse(line.slice(6))); } catch (e) {} } }
    };
    x.onloadend = () => onEnd(x.status);
    x.send(body);
  } else {
    controller = new AbortController();
    fetch(url, { method: 'POST', body: body, headers: {'Content-Type':'application/json'}, signal: controller.signal }).then(async (res) => {
      if (!res.ok || !res.body) { onEnd(res.status); return; }
      const rd = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const r = await rd.read(); if (r.done) break;
        buf += dec.decode(r.value, { stream: true });
        let k; while ((k = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, k); buf = buf.slice(k + 1); if (line.startsWith('data: ')) { try { onChunk(JSON.parse(line.slice(6))); } catch (e) {} } }
      }
      onEnd(res.status);
    }).catch(() => onEnd(0));
  }
}

function boot(){
  $('loading').remove();
  $('app').style.display = '';
  const c = $('chat-input');
  c.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
  const s = document.querySelector('#send-btn, .send-ctl');
  if (s) s.addEventListener('click', send);
  const st = $('stop-btn');
  if (st) st.addEventListener('click', () => { if (controller) controller.abort(); setBusy(false); });
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.copy-ctl');
    if (!b) return;
    const pre = b.closest('.md-code-block').querySelector('pre');
    navigator.clipboard.writeText(pre.textContent).catch(() => {});
  });
  if (CFG.scenario === 'modal') {
    const o = document.createElement('div');
    o.className = 'overlay';
    o.innerHTML = '<div role="dialog" aria-modal="true"><p>We use cookies to improve the site.</p><button id="accept-cookies">Accept</button></div>';
    document.body.appendChild(o);
    o.querySelector('button').addEventListener('click', () => o.remove());
  }
  if (CFG.scenario === 'popup') window.open(CFG.prefix + 'promo', '_blank');
  if (CFG.scenario === 'dialog') setTimeout(() => alert('Welcome to the fixture!'), 50);
}
setTimeout(boot, CFG.scenario === 'slow' ? 2500 : 60);
</script></body></html>`;
}

// ------------------------------------------------------------- research web --

const WEB = {
  "/web/": { title: "Fixture Web - Home", body: `<header><nav><a href="/web/docs/intro">Docs</a> <a href="/web/blog/">Blog</a> <a href="/web/about">About</a></nav></header>
<main><h1>Fixture Web</h1><p>A small web for testing research. Start with the <a href="/web/docs/intro">introduction</a>.</p></main>
<footer><a href="/web/privacy">Privacy</a> &copy; 2026</footer>` },
  "/web/docs/intro": { title: "Widget Engine - Introduction", meta: { description: "Official documentation for the Widget Engine." }, canonical: "/web/docs/intro", body: `
<header class="site-header"><nav class="topnav"><a href="/web/">Home</a> <a href="/web/docs/intro">Docs</a> <a href="/web/docs/auth">Authentication</a> <a href="/web/docs/limits">Limits</a> <a href="/web/blog/">Blog</a></nav></header>
<aside class="sidebar"><ul><li><a href="/web/docs/intro">Intro</a></li><li><a href="/web/docs/auth">Auth</a></li><li><a href="/web/docs/limits">Limits</a></li><li><a href="/web/docs/install">Install</a></li></ul></aside>
<main><article>
<h1>Widget Engine</h1>
<p>The Widget Engine is an open-source rendering library first released in 2019. It renders widgets in the browser and on the server.</p>
<h2>Architecture</h2>
<p>The engine is built around a scheduler, a renderer and a plugin system. The scheduler batches updates every 16 milliseconds.</p>
<h3>Plugins</h3>
<p>Plugins register hooks. See <a href="/web/docs/plugins?utm_source=nav&amp;utm_medium=docs">the plugin guide</a> for details.</p>
<h2>Performance</h2>
<p>The Widget Engine handles 10,000 widgets per second on a modern laptop.</p>
<table><thead><tr><th>Version</th><th>Released</th><th>Widgets/sec</th></tr></thead>
<tbody><tr><td>1.0</td><td>2019</td><td>4,000</td></tr><tr><td>2.0</td><td>2022</td><td>10,000</td></tr></tbody></table>
<h2>Next steps</h2>
<p>Read about <a href="/web/docs/auth">authentication</a> and <a href="/web/docs/limits">rate limits</a>.</p>
</article></main>
<footer class="site-footer"><a href="/web/privacy">Privacy</a> <a href="/web/terms">Terms</a> <a href="https://twitter.example.test/widget">Twitter</a></footer>` },
  "/web/docs/auth": { title: "Widget Engine - Authentication", body: `
<nav class="topnav"><a href="/web/">Home</a> <a href="/web/docs/intro">Docs</a></nav>
<main><article><h1>Authentication</h1>
<p>The Widget Engine supports token authentication and OAuth 2.0.</p>
<h2>Tokens</h2>
<p>Tokens expire after 30 days. Rotate them with the CLI.</p>
<pre><code class="language-bash">widget auth rotate --expires 30d</code></pre>
<h2>OAuth</h2>
<p>OAuth support was added in version 2.0.</p>
</article></main>` },
  "/web/docs/limits": { title: "Widget Engine - Rate limits", body: `
<main><article><h1>Rate limits</h1>
<p>The hosted Widget API allows 100 requests per minute per token.</p>
<p>Exceeding the limit returns HTTP 429.</p>
</article></main>` },
  "/web/docs/plugins": { title: "Widget Engine - Plugins", body: `<main><article><h1>Plugins</h1><p>A plugin exports a register function. Plugins run in registration order.</p></article></main>` },
  "/web/docs/install": { title: "Widget Engine - Install", body: `<main><article><h1>Install</h1><p>Install the Widget Engine from npm with the command below. It needs Node 20 or later.</p><pre><code class="language-bash">npm install widget-engine</code></pre></article></main>` },
  "/web/blog/": { title: "Widget Blog", body: `<main><h1>Blog</h1><ul>
<li><a href="/web/blog/perf-2026">Widget Engine performance in 2026</a></li>
<li><a href="/web/blog/limits-change">Rate limits are changing</a></li></ul></main>` },
  "/web/blog/perf-2026": { title: "Widget Engine performance in 2026", meta: { "article:published_time": "2026-03-01" }, body: `
<main><article><h1>Widget Engine performance in 2026</h1>
<p>In our benchmarks the Widget Engine handles 12,000 widgets per second on a modern laptop.</p>
<p>The scheduler was rewritten in version 3.0.</p>
</article></main>` },
  "/web/blog/limits-change": { title: "Rate limits are changing", meta: { "article:published_time": "2026-05-10" }, body: `
<main><article><h1>Rate limits are changing</h1>
<p>From June 2026 the hosted Widget API allows 60 requests per minute per token.</p>
</article></main>` },
  // A syndicated copy of the perf post on another path, with tracking noise.
  "/mirror/perf-2026": { title: "Widget Engine performance in 2026 (mirror)", canonical: "/web/blog/perf-2026", body: `
<main><article><h1>Widget Engine performance in 2026</h1>
<p>In our benchmarks the Widget Engine handles 12,000 widgets per second on a modern laptop.</p>
<p>The scheduler was rewritten in version 3.0.</p>
</article></main>` },
  "/web/about": { title: "About", body: "<main><h1>About</h1><p>Fixture pages for CloseNI tests.</p></main>" },
  "/web/privacy": { title: "Privacy", body: "<main><h1>Privacy</h1><p>No data is collected.</p></main>" },
  "/web/terms": { title: "Terms", body: "<main><h1>Terms</h1><p>None.</p></main>" },
  // A page that only has content after JavaScript runs.
  "/web/spa": { title: "SPA", script: `document.getElementById('root').innerHTML = '<article><h1>Rendered by script</h1><p>The Widget Engine CLI is called widget.</p></article>';`, body: `<div id="root"></div><noscript>Enable JavaScript</noscript>` },
  // Infinite scroll: more items appear as the page scrolls.
  "/web/feed": { title: "Feed", script: `let n=0; function more(){ for(let i=0;i<10;i++){ const p=document.createElement('p'); p.textContent='Feed item '+(++n)+': Widget update number '+n+'.'; document.getElementById('feed').appendChild(p);} } more(); window.addEventListener('scroll', ()=>{ if (n<50 && window.innerHeight+window.scrollY>=document.body.offsetHeight-50) more(); });`, body: `<style>#feed p{min-height:120px}</style><main><h1>Feed</h1><div id="feed"></div></main>` },
};

function webPage(pathname, base) {
  const p = WEB[pathname];
  if (!p) return null;
  const metas = Object.entries(p.meta || {}).map(([k, v]) => (k.includes(":") ? `<meta property="${k}" content="${v}">` : `<meta name="${k}" content="${v}">`)).join("");
  const canon = p.canonical ? `<link rel="canonical" href="${base}${p.canonical}">` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${p.title}</title>${metas}${canon}</head><body>${p.body}${p.script ? "<script>" + p.script + "</script>" : ""}</body></html>`;
}

/** A results page for the browser search backend. Results depend on the query words. */
function searchPage(q, base) {
  const words = String(q || "").toLowerCase();
  const all = [
    { url: "/web/docs/intro?utm_source=search&utm_campaign=x", title: "Widget Engine - Introduction", snip: "Official documentation for the Widget Engine: architecture, performance, plugins.", keys: ["widget", "engine", "architecture", "performance", "docs"] },
    { url: "/web/docs/auth", title: "Widget Engine - Authentication", snip: "Token authentication and OAuth 2.0 for the Widget Engine.", keys: ["auth", "authentication", "token", "oauth", "widget"] },
    { url: "/web/docs/limits", title: "Widget Engine - Rate limits", snip: "The hosted Widget API allows 100 requests per minute.", keys: ["limit", "limits", "rate", "requests", "widget"] },
    { url: "/web/blog/limits-change", title: "Rate limits are changing", snip: "From June 2026 the hosted API allows 60 requests per minute.", keys: ["limit", "limits", "rate", "widget", "2026"] },
    { url: "/web/blog/perf-2026", title: "Widget Engine performance in 2026", snip: "12,000 widgets per second in our benchmarks.", keys: ["performance", "widget", "benchmark", "2026", "speed"] },
    { url: "/mirror/perf-2026?ref=feed", title: "Widget Engine performance in 2026 (mirror)", snip: "12,000 widgets per second in our benchmarks.", keys: ["performance", "widget", "benchmark"] },
    { url: "/web/docs/plugins#top", title: "Widget Engine - Plugins", snip: "Plugins register hooks and run in registration order.", keys: ["plugin", "plugins", "hooks", "widget"] },
  ];
  const hits = all.filter((r) => r.keys.some((k) => words.includes(k)));
  const items = hits.map((r) => `<li class="result"><h3><a class="result-link" href="${base}${r.url}">${r.title}</a></h3><p class="snippet">${r.snip}</p></li>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${q} - Fixture Search</title></head><body>
<form><input name="q" value="${String(q).replace(/"/g, "&quot;")}"></form>
<div class="ad"><a href="${base}/web/about">Sponsored: buy widgets</a></div>
<ol id="results">${items || '<li class="no-results">No results</li>'}</ol></body></html>`;
}

// -------------------------------------------------------------- server --

function createWebFixtures(opts = {}) {
  const chunkDelay = opts.chunkDelayMs ?? 12;
  const log = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://localhost");
    const base = "http://" + req.headers.host;
    log.push(req.method + " " + u.pathname);

    const m = /^\/ai\/(deepseek|qwen|glm)\/([\w-]+)\/(.*)$/.exec(u.pathname);
    if (m) {
      const [, flavor, scenario, rest] = m;
      const prefix = "/ai/" + flavor + "/" + scenario + "/";
      if (req.method === "POST" && (rest === FLAVORS[flavor].endpoint)) return streamReply(req, res, flavor, scenario, chunkDelay);
      if (rest === "promo") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<h1>Promo popup</h1>"); }
      if (rest.startsWith("recaptcha/")) { res.writeHead(200, { "Content-Type": "text/html" }); return res.end("<p>challenge</p>"); }
      if (scenario === "error500") { res.writeHead(500, { "Content-Type": "text/html" }); return res.end("<h1>500 Internal Server Error</h1><p>Something went wrong.</p>"); }
      if (rest === "" || rest.startsWith("c/")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(chatPage(flavor, scenario, prefix));
      }
    }
    if (u.pathname === "/search") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(searchPage(u.searchParams.get("q") || "", base));
    }
    if (u.pathname === "/web/slow") {
      return setTimeout(() => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<main><h1>Slow page</h1><p>Arrived late.</p></main>"); }, 3000);
    }
    if (u.pathname === "/web/hang") return; // never answers: navigation timeout
    if (u.pathname === "/web/redirect") { res.writeHead(302, { Location: "/web/docs/intro" }); return res.end(); }
    const page = webPage(u.pathname, base);
    if (page) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page);
    }
    res.writeHead(404, { "Content-Type": "text/html" });
    res.end("<h1>Not found</h1>");
  });
  return {
    server,
    log,
    listen() { return new Promise((r) => server.listen(0, "127.0.0.1", () => r("http://127.0.0.1:" + server.address().port))); },
    close() { return new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); }); },
  };
}

function streamReply(req, res, flavor, scenario, delay) {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch { /* empty */ }
    if (scenario === "ratelimit") { res.writeHead(429, { "Content-Type": "application/json" }); return res.end('{"error":"rate limited"}'); }
    if (scenario === "error-reply") { res.writeHead(500, { "Content-Type": "application/json" }); return res.end('{"error":"boom"}'); }
    const reply = scriptedReply(parsed.prompt, parsed.turn);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const chunks = [];
    // Small chunks for ordinary replies (many partials to observe); larger ones
    // for long replies, whose page re-renders the whole message per chunk.
    const size = (reply.answer || "").length > 4000 ? 96 : 7;
    const cut = (t, kind) => { for (let i = 0; i < t.length; i += size) chunks.push({ t: kind, v: t.slice(i, i + size) }); };
    if (reply.reasoning) cut(reply.reasoning, "r");
    cut(reply.answer, "a");
    if (chunks.length) chunks[chunks.length - 1].last = true;
    let i = 0;
    const slow = scenario === "slow-stream";
    const stallAt = scenario === "stall" ? Math.floor(chunks.length / 2) : -1;
    const cutAt = scenario === "cut" ? Math.floor(chunks.length / 2) : -1;
    const tick = () => {
      if (res.destroyed) return;
      if (i === stallAt) return; // never finishes; the client aborts or the test ends
      if (i === cutAt) { res.socket && res.socket.destroy(); return; } // the connection drops mid-reply
      if (i >= chunks.length) { res.end(); return; }
      res.write("data: " + JSON.stringify(chunks[i++]) + "\n\n");
      // A pause mid-answer, longer than a naive stability window.
      const pause = scenario === "pause" && i === Math.floor(chunks.length / 2) ? 2500 : 0;
      setTimeout(tick, (slow ? 60 : delay) + pause);
    };
    setTimeout(tick, scenario === "late-start" ? 1500 : 30);
  });
}

module.exports = { createWebFixtures, scriptedReply, FLAVORS };

if (require.main === module) {
  const f = createWebFixtures();
  f.listen().then((url) => console.log("fixtures at " + url));
}
