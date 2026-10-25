// The Pages landing page, docs/index.html. Called by make-site.mjs.
//
// It states no fact of its own that the repo already records: the version is
// package.json's, and every download button goes to the latest GitHub release
// rather than to a file name that may not exist yet. The prose is the README's
// own claims, shortened.
//
// The colours are the app's: its default Terminal palette, and Paper when the
// visitor's system is light (native/qml/singletons/Theme.qml). The type is
// editorial: Instrument Serif for display, Instrument Sans for text, monospace
// only where something is code.
// The fonts are self-hosted in docs/assets/fonts (OFL, licences beside them),
// so the page loads nothing from another origin. make-site.mjs takes THEME_CSS
// and wordmark() from here so the two pages cannot drift apart.

const REPO = 'https://github.com/siddarth1872004/CloseNI';
const RELEASES = REPO + '/releases/latest';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The "][" mark from BracketMark.qml: viewBox 32, stroke 2.8, square caps.
const MARK = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><path d="M7 6H13V26H7M25 6H19V26H25" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="square"/></svg>`;

export const FAVICON = `<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' fill='%23141414'/><path d='M7 6H13V26H7M25 6H19V26H25' fill='none' stroke='%23e8a06b' stroke-width='2.8' stroke-linecap='square'/></svg>">`;

export function wordmark(href) {
  return `<a class="wm" href="${href}">${MARK}<span>Close<b>NI</b></span></a>`;
}

// Terminal, then Paper, from Theme.qml. Terminal's own accent is near-white, so
// the accent here is its warm langRs orange; Paper's is its own. The token
// names are the ones make-site.mjs styles with.
export const THEME_CSS = `
@font-face{font-family:"Instrument Serif";font-style:normal;font-weight:400;font-display:swap;src:url(assets/fonts/instrument-serif.woff2) format("woff2")}
@font-face{font-family:"Instrument Serif";font-style:italic;font-weight:400;font-display:swap;src:url(assets/fonts/instrument-serif-italic.woff2) format("woff2")}
@font-face{font-family:"Instrument Sans";font-style:normal;font-weight:400 600;font-display:swap;src:url(assets/fonts/instrument-sans.woff2) format("woff2")}
:root{
  color-scheme:dark;
  --bg:#141414; --panel:#181818; --surface:#1b1b1b; --raised:#232323; --sunken:#101010;
  --line:#262626; --line2:#3a3a3a; --txt:#ebe9e5; --dim:#a8a49d; --mut:#8a867e; --inverse:#141414;
  --ok:#8ccf7e; --warn:#e5c07b; --warnBg:#262011; --warnLine:#6b5a2a; --err:#f07878;
  --accent:#e8a06b; --accentInk:#b3541e; --onAccent:#141414; --focus:#d0d0d0; --shadow:rgba(0,0,0,.8);
  --serif:"Instrument Serif",Georgia,"Times New Roman",serif;
  --sans:"Instrument Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,"Cascadia Mono",Consolas,"Liberation Mono",monospace;
}
@media (prefers-color-scheme: light){
  :root{
    color-scheme:light;
    --bg:#f7f7f5; --panel:#ffffff; --surface:#ffffff; --raised:#eeeee9; --sunken:#f0f0ec;
    --line:#ddddd7; --line2:#c6c6bf; --txt:#1b1b1d; --dim:#55555a; --mut:#8a8a84; --inverse:#f7f7f5;
    --ok:#2f6b45; --warn:#7a6520; --warnBg:#faf5e2; --warnLine:#d8c98a; --err:#9c2f38;
    --accent:#b3541e; --accentInk:#e8a06b; --onAccent:#ffffff; --focus:#3b4fd8; --shadow:rgba(40,40,38,.45);
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);font:16px/1.6 var(--sans);-webkit-text-size-adjust:100%;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:underline;text-decoration-color:var(--line2);text-underline-offset:3px;text-decoration-thickness:1px}
a:hover{text-decoration-color:currentColor}
:focus-visible{outline:1px solid var(--focus);outline-offset:2px}
.wm{display:inline-flex;align-items:center;gap:8px;text-decoration:none;font:600 17px/1 var(--sans);letter-spacing:-.01em;color:var(--txt)}
.wm .mark{width:18px;height:18px;color:var(--accent)}
.wm b{font-weight:inherit;color:var(--accent)}
.micro{font-size:13px;color:var(--mut)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;padding:12px 20px;border:1px solid var(--line2);border-radius:3px;
  font:500 15px/1.2 var(--sans);color:var(--txt);background:transparent;text-decoration:none;transition:background .15s,color .15s,border-color .15s}
.btn:hover{border-color:var(--txt)}
.btn.invert{background:var(--txt);border-color:var(--txt);color:var(--inverse)}
.btn.invert:hover{background:var(--accent);border-color:var(--accent);color:var(--onAccent)}
.btn.small{padding:6px 14px;font-size:14px}
/* A status readout, as the app's phase line draws it: filled for working, hollow for not yet. */
.st{display:inline-flex;align-items:center;gap:8px;font-size:14px;font-weight:500;white-space:nowrap}
.st::before{content:"";width:8px;height:8px;border:1px solid currentColor}
.st.ok{color:var(--ok)} .st.ok::before{background:currentColor}
.st.soon{color:var(--mut)}
`;

// Pins on screenshots/code.png (1280x800), as percentages of its size.
const PINS = [
  [21, 22, 'The chat site it drives. You sign in once, in a real browser window.'],
  [36, 29, 'Ask in plain words: fix a bug, add a feature, explain a file.'],
  [16.5, 39, 'Every read, search and edit shows as it happens.'],
  [93, 52.5, 'File changes and commands wait for your yes, shown as a diff.'],
];

const STEPS = [
  ['Open', 'A Chromium window with your own session. You sign in once, in the real site.'],
  ['Ask', 'Your request goes into the chat box, with the project\'s context and the tool conventions the model needs.'],
  ['Read', 'It waits for the stream to end, parses the reply into tool calls, and runs the ones you allow.'],
  ['Check', 'Tests, type checks and the build run on the result. A failure goes back to the model as the next prompt.'],
];

const FEATURES = [
  ['No API key', 'It opens a real Chromium window with the session you are signed into, types the prompt, waits for the reply to finish streaming and reads it back.'],
  ['A coding agent', 'Reads and searches the project, edits files, runs commands and checks its work. File changes and commands ask first, as diffs you can read.'],
  ['Plan, build, repair', 'For a larger job it plans, you revise the plan, and each step is built, checked and repaired before the next one starts.'],
  ['Twelve languages', 'It picks the checks that fit the project: tests, type checks, a build, whichever the project actually has.'],
  ['Safe by default', 'Writes stay inside the workspace, secret files are never read without asking, and every command can be refused.'],
  ['Eleven themes', 'Terminal, Paper, Cassette, Phosphor and seven more, in a native Qt app with no web view anywhere.'],
];

const SHOTS = [
  ['builder.png', 'The builder', 'A plan you can revise, then one step at a time, each checked before the next.'],
  ['test.png', 'Test', 'The checks it ran for your project, and what they said.'],
  ['ship.png', 'Ship', 'Commit and push from the app, with the diff in front of you.'],
  ['theme-paper.png', 'Paper', 'One of the eleven themes.'],
];

// [status class, label]
const PROVIDERS = [
  ['DeepSeek', 'ok', 'Ready', 'Chat, plan, build and the coding agent, including long sessions.'],
  ['Qwen Studio, GLM', 'soon', 'Coming soon', 'Selectors checked against the live sites; gated until a signed-in reply is.'],
  ['Ollama, ChatGPT, Gemini, Claude, Grok', 'soon', 'Coming soon', 'Listed, not selectable.'],
];

// The README's "Read this before you sign in", shortened.
const WARNINGS = [
  ['Use a throwaway account.', 'Sign in with a dummy email made for CloseNI, never your main account.'],
  ['Your account can be banned.', 'Automated use can break a provider\'s terms. The more prompts you send, the more likely the account is flagged or banned.'],
  ['It breaks when the site changes.', 'CloseNI drives the chat site\'s own page, so a redesign can stop it working until the selectors are updated.'],
  ['Not recommended for production.', 'It is an early release. Keep it away from production systems and code you cannot afford to lose.'],
];

export function renderLanding(readme, pkg) {
  const v = esc(pkg.version);
  const pins = PINS.map(([x, y], i) => `<span class="pin" style="left:${x}%;top:${y}%">${i + 1}</span>`).join('');
  const callouts = PINS.map(([, , t]) => `<li>${esc(t)}</li>`).join('\n');
  const steps = STEPS.map(([t, d]) => `<li><h3>${esc(t)}</h3><p>${esc(d)}</p></li>`).join('\n');
  const features = FEATURES.map(([t, d]) => `<div><dt>${esc(t)}</dt><dd>${esc(d)}</dd></div>`).join('\n');
  const shots = SHOTS.map(([f, t, d], i) => `<figure><img src="screenshots/${f}" alt="${esc(t)}: ${esc(d)}" loading="lazy" width="1280" height="800"><figcaption><b>Fig. ${i + 2}</b> ${esc(t)}. ${esc(d)}</figcaption></figure>`).join('\n');
  const providers = PROVIDERS.map(([n, c, s, d]) => `<li><span class="name">${esc(n)}</span><span class="st ${c}">${esc(s)}</span><span class="note">${esc(d)}</span></li>`).join('\n');
  const warnings = WARNINGS.map(([t, d]) => `<li><span><b>${esc(t)}</b> ${esc(d)}</span></li>`).join('\n');
  return `<!DOCTYPE html>
<!-- Generated by scripts/make-site.mjs from README.md and package.json. Edit scripts/make-landing.mjs, then run npm run site. -->
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CloseNI</title>
<meta name="description" content="Free web AI chats, turned into a coding agent. No API keys: it drives a chat site in a real browser. Native desktop app for Windows and Linux.">
<meta property="og:title" content="CloseNI">
<meta property="og:description" content="Free web AI chats, turned into a coding agent. No API keys.">
<meta property="og:image" content="screenshots/code.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#f7f7f5" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#141414" media="(prefers-color-scheme: dark)">
<link rel="preload" href="assets/fonts/instrument-serif.woff2" as="font" type="font/woff2" crossorigin>
${FAVICON}
<style>${THEME_CSS}
html{scroll-behavior:smooth}
.wrap{max-width:1200px;margin:0 auto;padding:0 24px}
h1,h2,h3{font-family:var(--serif);font-weight:400;margin:0}
h2{font-size:clamp(40px,6vw,72px);line-height:1;letter-spacing:-.02em}
h2 em,h1 em{font-style:italic;color:var(--accent)}
.lede{font-size:19px;color:var(--dim);max-width:560px;margin:20px 0 0}

nav .wrap{display:flex;align-items:center;gap:28px;height:76px}
nav .links{display:flex;gap:26px;font-size:15px}
nav .links a{text-decoration:none;color:var(--dim)}
nav .links a:hover{color:var(--txt)}
nav .sp{flex:1}

.hero{padding:56px 0 0}
.kicker{display:flex;align-items:center;gap:10px;margin:0 0 28px;font-size:14px;color:var(--dim)}
.kicker{font-family:var(--mono);font-size:13px}
.kicker i{width:8px;height:8px;background:var(--ok)}
h1{font-size:clamp(52px,9.2vw,128px);line-height:.92;letter-spacing:-.03em;max-width:11.5em}
.hero-foot{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:32px;align-items:end;margin:40px 0 0;padding:28px 0 0;border-top:1px solid var(--txt)}
.hero-foot p{margin:0;max-width:560px;font-size:19px;color:var(--dim)}
.cta{display:flex;align-items:center;gap:22px;flex-wrap:wrap}
.cta a.more{font-size:15px}

.plate{margin:64px auto 0}
.frame{position:relative;border:1px solid var(--line2);border-radius:6px;overflow:hidden;background:#141414;box-shadow:0 30px 60px -30px var(--shadow)}
.frame img{display:block;width:100%;height:auto}
.pin{position:absolute;width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:3px;background:var(--accent);color:var(--onAccent);
  font:600 13px/28px var(--mono);text-align:center;box-shadow:0 0 0 4px rgba(20,20,20,.55)}
.plate figcaption{display:grid;grid-template-columns:auto minmax(0,1fr);gap:24px;margin:20px 0 0;font-size:14px;color:var(--dim)}
.plate figcaption b{font-weight:600;color:var(--txt)}
.callouts{list-style:none;counter-reset:c;margin:0;padding:0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px}
.callouts li{counter-increment:c;position:relative;padding-left:30px}
.callouts li::before{content:counter(c);position:absolute;left:0;top:1px;width:20px;height:20px;border-radius:2px;background:var(--accent);color:var(--onAccent);font:600 11px/20px var(--mono);text-align:center}

section{padding:140px 0 0}
.quote{font-family:var(--serif);font-size:clamp(34px,5vw,64px);line-height:1.04;letter-spacing:-.02em;margin:0;max-width:16em}
.quote span{color:var(--mut)}
.flow{list-style:none;margin:64px 0 0;padding:0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0}
.flow li{position:relative;padding:22px 32px 0 0;border-top:1px solid var(--txt)}
.flow li+li{padding-left:0}
.flow li:not(:last-child)::after{content:"\\2192";position:absolute;right:14px;top:16px;font:24px/1 var(--serif);color:var(--accent)}
.flow h3{font-size:34px;line-height:1;margin:0 0 12px}
.flow p{margin:0;color:var(--dim);font-size:15px;max-width:240px}

.split{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr);gap:48px}
.split .side{position:sticky;top:32px;align-self:start}
dl.features{margin:0}
dl.features div{padding:22px 0;border-top:1px solid var(--line2)}
dl.features div:last-child{border-bottom:1px solid var(--line2)}
dl.features dt{font:400 30px/1.1 var(--serif);margin:0 0 8px}
dl.features dd{margin:0;color:var(--dim);max-width:560px}

.gallery{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:48px 32px;margin:56px 0 0}
.gallery figure{margin:0}
.gallery img{display:block;width:100%;height:auto;border-radius:8px;border:1px solid var(--line)}
.gallery figcaption{margin:14px 0 0;font-size:14px;color:var(--dim)}
.gallery figcaption b{font-weight:600;color:var(--txt);margin-right:6px}

.label{margin:0;background:var(--warnBg);color:var(--txt);border:1px solid var(--warnLine);border-radius:6px;overflow:hidden}
.label .stripe{height:12px;background:repeating-linear-gradient(-45deg,var(--warn) 0 10px,transparent 10px 20px);border-bottom:1px solid var(--warnLine)}
.label .body{display:grid;grid-template-columns:minmax(0,4fr) minmax(0,8fr);gap:40px;padding:36px 40px 40px}
.label h2{font-size:clamp(36px,4.6vw,56px)}
.label .sign{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;margin:0 0 20px;border:1px solid var(--warn);border-radius:3px;color:var(--warn);font:600 22px/1 var(--mono)}
.label ol{margin:0;padding:0;list-style:none;counter-reset:w}
.label li{counter-increment:w;display:grid;grid-template-columns:36px minmax(0,1fr);padding:14px 0;border-top:1px solid var(--warnLine);font-size:16px;color:var(--dim)}
.label li::before{content:counter(w,decimal-leading-zero);font:600 12px/2 var(--mono);color:var(--warn)}
.label li:last-child{border-bottom:1px solid var(--warnLine)}
.label li b{font-weight:600;color:var(--txt)}
.label .fine{margin:18px 0 0;font-size:14px;color:var(--dim)}

.providers{list-style:none;margin:48px 0 0;padding:0}
.providers li{display:grid;grid-template-columns:minmax(0,5fr) 150px minmax(0,6fr);gap:24px;align-items:baseline;padding:22px 0;border-top:1px solid var(--line2)}
.providers li:last-child{border-bottom:1px solid var(--line2)}
.providers .name{font:400 30px/1.1 var(--serif)}
.providers .note{color:var(--dim);font-size:15px}

/* Drawn in the other palette's ink, so it takes that palette's accent too. */
.get{--accent:var(--accentInk);margin:140px 0 0;padding:120px 0 96px;background:var(--txt);color:var(--inverse)}
.get h2{font-size:clamp(56px,10vw,140px);line-height:.9}
.get h2 em{color:var(--accent)}
.get .lede{color:var(--line2)}
.rows{margin:56px 0 0;border-top:1px solid var(--mut)}
.row{display:grid;grid-template-columns:minmax(0,4fr) minmax(0,7fr) auto;gap:24px;align-items:center;padding:26px 4px;border-bottom:1px solid var(--mut);
  text-decoration:none;color:inherit;transition:padding .2s,background .2s}
.row:hover{background:rgba(138,134,126,.12);padding-left:16px;padding-right:16px}
.row .os{font:400 44px/1 var(--serif)}
.row .what{color:var(--line2);font-size:15px}
.row .arrow{font:28px/1 var(--serif);color:var(--accent)}
.row .yours{display:none;margin-left:12px;padding:3px 10px;border:1px solid var(--accent);border-radius:2px;color:var(--accent);font:500 12px/1.4 var(--sans);vertical-align:middle}
.row.rec .yours{display:inline-block}
.source{display:grid;grid-template-columns:minmax(0,4fr) minmax(0,7fr);gap:24px;margin:56px 0 0}
.source h3{font-size:30px}
.source p{margin:6px 0 0;color:var(--line2);font-size:15px}
.get pre{margin:0;min-width:0;overflow:auto;padding:18px 20px;border:1px solid var(--mut);border-radius:6px;font:13px/1.8 var(--mono);color:var(--inverse)}
.get pre .p{color:var(--mut);user-select:none}
.unsigned{margin:40px 0 0;font-size:14px;color:var(--line2);max-width:720px}
.unsigned b{color:var(--inverse);font-weight:600}

footer .wrap{display:flex;flex-wrap:wrap;align-items:center;gap:10px 26px;padding:28px 24px 40px;font-size:14px;color:var(--mut)}
footer a{color:var(--dim);text-decoration:none}
footer a:hover{color:var(--txt)}
footer .sp{flex:1}

@media (max-width:960px){
  .hero-foot,.split,.label .body{grid-template-columns:minmax(0,1fr)}
  .split .side{position:static}
  .callouts,.flow{grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}
  .flow li{padding-right:24px}
  .flow li:not(:last-child)::after{display:none}
  .plate figcaption{grid-template-columns:minmax(0,1fr);gap:12px}
  .providers li{grid-template-columns:minmax(0,1fr) auto}
  .providers .note{grid-column:1/-1}
  .source{grid-template-columns:minmax(0,1fr);gap:16px}
}
@media (max-width:640px){
  .wrap{padding:0 16px}
  nav .links{display:none}
  .hero{padding-top:24px}
  section{padding-top:96px}
  .pin{width:20px;height:20px;margin:-10px 0 0 -10px;font-size:11px;line-height:20px;box-shadow:0 0 0 3px rgba(20,20,20,.55)}
  .callouts,.flow,.gallery{grid-template-columns:minmax(0,1fr)}
  .label .body{padding:24px 20px 28px;gap:16px}
  .row{grid-template-columns:minmax(0,1fr) auto;gap:6px 16px}
  .row .what{grid-column:1/2;grid-row:2}
  .row .arrow{grid-row:1/3;grid-column:2}
  .row .os{font-size:36px}
  .get{margin-top:96px;padding:80px 0 64px}
}
@media (prefers-reduced-motion: reduce){html{scroll-behavior:auto}.btn,.row{transition:none}}
</style>
</head>
<body>
<nav><div class="wrap">
  ${wordmark('./')}
  <span class="sp"></span>
  <div class="links">
    <a href="#how">How it works</a>
    <a href="#features">Features</a>
    <a href="#before">Before you start</a>
    <a href="readme.html">Docs</a>
  </div>
  <a class="btn small" href="${REPO}">GitHub</a>
</div></nav>

<header class="hero"><div class="wrap">
  <p class="kicker"><i></i>Version ${v} · an early release for Windows and Linux</p>
  <h1>Free web AI chats, <em>turned into a coding agent.</em></h1>
  <div class="hero-foot">
    <p>Ask for a change and it reads your project, edits files, runs commands and checks its work, asking before anything it should. The model is a chat site driven in a real browser: no API key, no per-token bill.</p>
    <div class="cta">
      <a class="btn invert" id="dl-main" href="${RELEASES}">Download CloseNI</a>
      <a class="more" href="readme.html">Read the docs</a>
    </div>
  </div>
</div></header>

<figure class="plate wrap">
  <div class="frame"><img src="screenshots/code.png" alt="The Code panel: a request, a read, and an edit shown as a diff waiting for permission" width="1280" height="800">${pins}</div>
  <figcaption><b>Fig. 1</b><ol class="callouts">
${callouts}
  </ol></figcaption>
</figure>

<main>
<section id="how"><div class="wrap">
  <p class="quote">From the site's side, it is a person typing. <span>From yours, it is a coding agent working in your project folder.</span></p>
  <ol class="flow">
${steps}
  </ol>
</div></section>

<section id="features"><div class="wrap split">
  <div class="side">
    <h2>What it <em>does</em></h2>
    <p class="lede">A chat site has no tool-calling API, so the tools are a convention written into the conversation. CloseNI teaches the model that convention and runs what comes back.</p>
  </div>
  <dl class="features">
${features}
  </dl>
</div></section>

<section id="screens"><div class="wrap">
  <h2>Around <em>the app</em></h2>
  <div class="gallery">
${shots}
  </div>
</div></section>

<section id="before"><div class="wrap">
  <div class="label">
    <div class="stripe"></div>
    <div class="body">
      <div><span class="sign" aria-hidden="true">!</span><h2>Read this before you sign in</h2></div>
      <div>
        <ol>
${warnings}
        </ol>
        <p class="fine">You are using a site under its own terms. Check them before you sign in. <a href="readme.html#providers">Details</a>.</p>
      </div>
    </div>
  </div>
</div></section>

<section id="providers"><div class="wrap">
  <h2>Where it <em>stands</em></h2>
  <ul class="providers">
${providers}
  </ul>
</div></section>
</main>

<section class="get" id="download"><div class="wrap">
  <h2>Get <em>CloseNI.</em></h2>
  <p class="lede">Version ${v}. A native Qt app with Node and the agent bundled. Chromium is downloaded on first run.</p>
  <div class="rows">
    <a class="row" id="card-win" href="${RELEASES}"><span class="os">Windows<span class="yours">Your system</span></span><span class="what">An installer (.exe); you choose the folder. Windows 10 or later.</span><span class="arrow" aria-hidden="true">&#8595;</span></a>
    <a class="row" id="card-linux" href="${RELEASES}"><span class="os">Linux<span class="yours">Your system</span></span><span class="what">An AppImage that runs anywhere, or a .deb for Debian and Ubuntu.</span><span class="arrow" aria-hidden="true">&#8595;</span></a>
  </div>
  <div class="source">
    <div><h3>From source</h3><p>Node 22.12+, Qt 6.8+, CMake 3.21+ and Ninja.</p></div>
<pre><span class="p">$ </span>git clone ${REPO}.git &amp;&amp; cd CloseNI
<span class="p">$ </span>npm install &amp;&amp; npm run build
<span class="p">$ </span>npx playwright install chromium
<span class="p">$ </span>cmake -S native -B build-native -G Ninja
<span class="p">$ </span>cmake --build build-native &amp;&amp; npm start</pre>
  </div>
  <p class="unsigned"><b>The installers are unsigned.</b> Windows SmartScreen may warn on first launch. The first run asks you to install Chromium and sign in to a provider once, with a throwaway account.</p>
</div></section>

<footer><div class="wrap">
  ${wordmark('./')}
  <span>v${v} · MIT licence</span>
  <span class="sp"></span>
  <a href="readme.html">Documentation</a>
  <a href="${REPO}/blob/main/CHANGELOG.md">Changelog</a>
  <a href="${REPO}/blob/main/docs/SAFETY.md">Safety</a>
  <a href="${REPO}">GitHub</a>
</div></footer>

<script>
// Point the main button at the visitor's system. Both rows already work
// without this; it only changes the label and marks the matching row.
(function () {
  var ua = navigator.userAgent || '';
  var os = /Windows/i.test(ua) ? 'win' : /Linux|X11/i.test(ua) && !/Android/i.test(ua) ? 'linux' : '';
  if (!os) return;
  var btn = document.getElementById('dl-main');
  if (btn) btn.textContent = 'Download for ' + { win: 'Windows', linux: 'Linux' }[os];
  var row = document.getElementById('card-' + os);
  if (row) row.className += ' rec';
})();
</script>
</body>
</html>`;
}
