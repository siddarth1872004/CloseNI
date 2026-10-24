// The Pages landing page, docs/index.html. Called by make-site.mjs.
//
// It states no fact of its own that the repo already records: the version is
// package.json's, and every download button goes to the latest GitHub release
// rather than to a file name that may not exist yet. The prose is the README's
// own claims, shortened.
//
// The look is the app's: the Terminal theme's palette, type and controls from
// native/qml/singletons/Theme.qml and components/Btn.qml, and Paper's palette
// for a light system. make-site.mjs takes THEME_CSS and wordmark() from here so
// the two pages cannot drift apart.

const REPO = 'https://github.com/siddarth1872004/CloseNI';
const RELEASES = REPO + '/releases/latest';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The "][" mark from BracketMark.qml: viewBox 32, stroke 2.8, square caps.
const MARK = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><path d="M7 6H13V26H7M25 6H19V26H25" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="square"/></svg>`;

export const FAVICON = `<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' fill='%23141414'/><path d='M7 6H13V26H7M25 6H19V26H25' fill='none' stroke='%23ebe9e5' stroke-width='2.8' stroke-linecap='square'/></svg>">`;

export function wordmark(href) {
  return `<a class="wm" href="${href}">${MARK}<span>Close<b>NI</b></span></a>`;
}

// Terminal, then Paper. Token names follow Theme.qml.
export const THEME_CSS = `
:root{
  color-scheme:dark;
  --bg:#141414; --panel:#181818; --surface:#1b1b1b; --raised:#232323; --sunken:#101010;
  --line:#262626; --line2:#3a3a3a; --txt:#ebe9e5; --dim:#a8a49d; --mut:#8a867e; --inverse:#141414;
  --ok:#8ccf7e; --warn:#e5c07b; --err:#f07878; --accent:#e4e4e4; --focus:#d0d0d0;
  --mono:ui-monospace,"SF Mono",Menlo,"Cascadia Mono",Consolas,"Liberation Mono",monospace;
}
@media (prefers-color-scheme: light){
  :root{
    color-scheme:light;
    --bg:#f7f7f5; --panel:#ffffff; --surface:#ffffff; --raised:#eeeee9; --sunken:#f0f0ec;
    --line:#ddddd7; --line2:#c6c6bf; --txt:#1b1b1d; --dim:#55555a; --mut:#8a8a84; --inverse:#f7f7f5;
    --ok:#2f6b45; --warn:#7a6520; --err:#9c2f38; --accent:#b3541e; --focus:#3b4fd8;
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.7 var(--mono);-webkit-text-size-adjust:100%}
a{color:inherit;text-decoration:underline;text-decoration-color:var(--line2);text-underline-offset:3px}
a:hover{text-decoration-color:currentColor}
:focus-visible{outline:1px solid var(--focus);outline-offset:2px}
.wm{display:inline-flex;align-items:center;gap:8px;text-decoration:none;font-size:15px;letter-spacing:1.2px;color:var(--txt)}
.wm .mark{width:17px;height:17px;color:var(--accent)}
.wm b{font-weight:inherit;color:var(--accent)}
.micro{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--mut)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;padding:8px 14px;border:1px solid var(--line2);border-radius:2px;
  font:11px/1.4 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--dim);background:transparent;text-decoration:none}
.btn:hover{color:var(--txt);border-color:var(--txt)}
.btn.invert{background:var(--txt);border-color:var(--txt);color:var(--inverse);font-weight:600}
.btn.invert:hover{background:var(--accent);border-color:var(--accent)}
.btn.small{padding:4px 8px;font-size:10px}
/* A status readout, as the app's phase line draws it: filled for working, hollow for not yet. */
.st{font-size:10px;letter-spacing:.14em;text-transform:uppercase;white-space:nowrap}
.st::before{content:"";display:inline-block;width:7px;height:7px;margin-right:8px;vertical-align:0;border:1px solid currentColor}
.st.ok{color:var(--ok)} .st.ok::before{background:currentColor}
.st.dim{color:var(--dim)} .st.dim::before{background:currentColor}
.st.mut{color:var(--mut)}
`;

const SHOTS = [
  ['code.png', 'The Code panel', 'Ask in plain words. Reads, searches and edits show as they happen; a command waits for your yes.'],
  ['builder.png', 'The builder', 'A plan you can revise, then one step at a time, each checked before the next.'],
  ['test.png', 'Test', 'The checks it ran for your project, and what they said.'],
  ['ship.png', 'Ship', 'Commit and push from the app, with the diff in front of you.'],
];

const FEATURES = [
  ['No API key', 'It opens a real Chromium window with the session you are signed into, types the prompt, waits for the reply to finish streaming and reads it back. From the site\'s side it is a person typing.'],
  ['A coding agent', 'Reads and searches the project, edits files, runs commands and checks its work. File changes and commands ask first, as diffs you can read.'],
  ['Plan, build, repair', 'For a larger job it plans, you revise the plan, and each step is built, checked and repaired before the next one starts.'],
  ['Twelve languages', 'It picks the checks that fit the project: tests, type checks, a build, whichever the project actually has.'],
  ['Safe by default', 'Writes stay inside the workspace, secret files are never read without asking, and every command can be refused. Read the safety model before you give it autonomy.'],
  ['Eleven themes', 'Terminal, Paper, Cassette, Phosphor and seven more. This page wears Terminal, or Paper on a light system.'],
];

const STEPS = [
  ['Open', 'A Chromium window with your own session. You sign in once, in the real site.'],
  ['Ask', 'Your request goes into the chat box, with the project\'s context and the tool conventions the model needs.'],
  ['Read', 'It waits for the stream to end, parses the reply into tool calls, and runs the ones you allow.'],
  ['Check', 'Tests, type checks and the build run on the result. A failure goes back to the model as the next prompt.'],
];

// [status class, label] - the app's phase readout words.
const PROVIDERS = [
  ['DeepSeek', 'ok', 'Ready', 'Chat, plan, build and the coding agent, including long sessions.'],
  ['Qwen Studio, GLM', 'mut', 'Coming soon', 'Selectors checked against the live sites; gated until a signed-in reply is.'],
  ['Ollama, ChatGPT, Gemini, Claude, Grok', 'mut', 'Coming soon', 'Listed, not selectable.'],
];

// An illustrative Code turn, in the panel's own notation (see screenshots/code.png).
const TURN = [
  ['you', '&gt; fix the bug in calc.py'],
  ['say', '● Let me read it.'],
  ['tool', '● <b>Read</b>(calc.py)'],
  ['out', '  ⎿ Read 2 lines'],
  ['tool', '● <b>Update</b>(calc.py)'],
  ['del', '  ⎿ -    return a - b'],
  ['add', '     +    return a + b'],
  ['tool', '● <b>Bash</b>(python3 -m unittest)'],
  ['out', '  ⎿ Ran 3 tests · OK'],
  ['say', '● Fixed: add() subtracted. The tests pass.'],
];

const section = (n, id, label, title, lede) =>
  `<section id="${id}">\n  <div class="rule micro"><span>${n}</span><span>${label}</span><i></i></div>\n  <h2>${title}</h2>\n` +
  (lede ? `  <p class="lede">${lede}</p>\n` : '');

export function renderLanding(readme, pkg) {
  const v = esc(pkg.version);
  const shots = SHOTS.map(([f, t, d]) => `<figure><img src="screenshots/${f}" alt="${esc(t)}: ${esc(d)}" loading="lazy"><figcaption><span class="micro">${esc(t)}</span>${esc(d)}</figcaption></figure>`).join('\n');
  const features = FEATURES.map(([t, d]) => `<div><dt>${esc(t)}</dt><dd>${esc(d)}</dd></div>`).join('\n');
  const steps = STEPS.map(([t, d], i) => `<li><span class="micro">0${i + 1} · ${esc(t)}</span><p>${esc(d)}</p></li>`).join('\n');
  const providers = PROVIDERS.map(([n, c, s, d]) => `<tr><td>${esc(n)}</td><td><span class="st ${c}">${esc(s)}</span></td><td>${esc(d)}</td></tr>`).join('\n');
  const turn = TURN.map(([c, t], i) => `<span class="${c}" style="--i:${i}">${t}</span>`).join('');
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
<meta name="theme-color" content="#141414">
${FAVICON}
<style>${THEME_CSS}
html{scroll-behavior:smooth;scroll-padding-top:64px}
.wrap{max-width:1080px;margin:0 auto;padding:0 16px}
nav{position:sticky;top:0;z-index:5;background:var(--panel);border-bottom:1px solid var(--line)}
nav .wrap{display:flex;align-items:center;gap:20px;height:48px}
nav .links{display:flex;gap:18px}
nav .links a{text-decoration:none;color:var(--mut)}
nav .links a:hover{color:var(--txt)}
nav .links a span{color:var(--line2);margin-right:6px}
nav .sp{flex:1}

header.hero{padding:64px 0 0}
.hero .grid{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,1fr);gap:48px;align-items:start}
.hero .tag{margin:0 0 20px}
.hero .tag b{font-weight:inherit;color:var(--warn)}
h1{font-size:clamp(26px,4.2vw,40px);line-height:1.18;font-weight:600;letter-spacing:-.01em;margin:0 0 20px}
h1 span{color:var(--dim)}
.hero p.intro{color:var(--dim);margin:0 0 28px;max-width:520px}
.cta{display:flex;gap:8px;flex-wrap:wrap}
.hero .facts{margin:20px 0 0;display:flex;flex-wrap:wrap;gap:4px 14px}
.hero .facts span+span::before{content:"·";margin-right:14px;color:var(--line2)}

.panel{background:var(--panel);border:1px solid var(--line);border-radius:3px}
.panel .head{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-bottom:1px solid var(--line)}
.panel .head .live{color:var(--ok)}
.panel .head .live::before{content:"";display:inline-block;width:6px;height:6px;background:currentColor;margin-right:6px;vertical-align:1px}
.turn{margin:0;padding:14px 14px 16px;font-size:12.5px;line-height:1.75;white-space:pre;overflow-x:auto;color:var(--dim)}
.turn span{display:block;opacity:0;animation:line .01s linear forwards;animation-delay:calc(var(--i) * .55s + .3s)}
.turn .you{color:var(--txt);background:var(--raised);border-left:2px solid var(--line2);padding:2px 8px;margin:0 0 10px}
.turn .tool{color:var(--txt);margin-top:8px}
.turn .tool b{font-weight:600}
.turn .say{color:var(--txt);margin-top:8px}
.turn .out{color:var(--mut)}
.turn .del{color:var(--err)} .turn .add{color:var(--ok)}
.turn .say:last-child::after{content:"";display:inline-block;width:7px;height:14px;margin-left:4px;background:var(--txt);vertical-align:-2px;animation:blink 1s steps(1) infinite}
@keyframes line{to{opacity:1}}
@keyframes blink{50%{opacity:0}}
@media (prefers-reduced-motion: reduce){.turn span{animation:none;opacity:1}.turn .say:last-child::after{animation:none}}

.shot{margin:56px 0 0}
.shot img{display:block;width:100%;height:auto}

section{padding:88px 0 0}
.rule{display:flex;align-items:center;gap:10px;margin:0 0 18px}
.rule span:first-child{color:var(--line2)}
.rule i{flex:1;height:1px;background:var(--line)}
h2{font-size:clamp(20px,2.6vw,26px);line-height:1.3;font-weight:600;margin:0 0 10px}
.lede{color:var(--dim);max-width:640px;margin:0 0 32px}

.steps{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border-top:1px solid var(--line2)}
.steps li{padding:16px 20px 0 0}
.steps li+li{padding-left:20px;border-left:1px solid var(--line)}
.steps .micro{color:var(--txt)}
.steps p{margin:8px 0 0;color:var(--dim)}

dl.features{margin:0;border-top:1px solid var(--line)}
dl.features div{display:grid;grid-template-columns:220px minmax(0,1fr);gap:24px;padding:14px 0;border-bottom:1px solid var(--line)}
dl.features dt{color:var(--txt);font-weight:600}
dl.features dd{margin:0;color:var(--dim)}

.gallery{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}
figure{margin:0}
figure img{display:block;width:100%;height:auto;border:1px solid var(--line);border-radius:3px}
figcaption{padding:10px 0 0;color:var(--dim);font-size:13px}
figcaption .micro{display:block;color:var(--txt);margin-bottom:2px}

table{width:100%;border-collapse:collapse;border-top:1px solid var(--line2)}
th,td{padding:12px 16px 12px 0;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}
th{font-weight:400}
td:first-child{color:var(--txt);white-space:nowrap}
td:last-child{color:var(--dim)}
.terms{color:var(--mut);font-size:13px;margin:16px 0 0}

.dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border:1px solid var(--line);border-radius:3px;background:var(--panel)}
.dl > div{padding:20px;display:flex;flex-direction:column;gap:10px;align-items:flex-start}
.dl > div+div{border-left:1px solid var(--line)}
.dl h3{margin:0;font-size:14px;font-weight:600}
.dl h3 .micro{margin-left:10px;color:var(--ok);display:none}
.dl .rec h3 .micro{display:inline}
.dl p{margin:0;color:var(--dim);flex:1}
.dl .src{grid-column:1/-1;border-left:0;border-top:1px solid var(--line)}
pre{margin:0;width:100%;padding:12px 14px;background:var(--sunken);border:1px solid var(--line);border-radius:2px;overflow:auto;font:12.5px/1.7 var(--mono);color:var(--txt)}
pre .p{color:var(--mut);user-select:none}
.note{margin:16px 0 0;padding:12px 14px;border-left:2px solid var(--warn);background:var(--panel);color:var(--dim);font-size:13px}
.note b{color:var(--txt);font-weight:600}

footer{margin-top:96px;border-top:1px solid var(--line);background:var(--panel)}
footer .wrap{display:flex;flex-wrap:wrap;align-items:center;gap:8px 22px;padding:22px 16px 28px;color:var(--mut);font-size:12px}
footer a{color:var(--dim)}
footer .sp{flex:1}

@media (max-width:860px){
  .hero .grid{grid-template-columns:minmax(0,1fr);gap:36px}
  .steps{grid-template-columns:repeat(2,minmax(0,1fr))}
  .steps li:nth-child(3){padding-left:0;border-left:0}
  dl.features div{grid-template-columns:minmax(0,1fr);gap:4px}
  .gallery{grid-template-columns:minmax(0,1fr)}
}
@media (max-width:640px){
  nav .links{display:none}
  header.hero{padding-top:40px}
  section{padding-top:64px}
  .steps{grid-template-columns:minmax(0,1fr)}
  .steps li,.steps li+li{padding:14px 0;border-left:0;border-bottom:1px solid var(--line)}
  .dl{grid-template-columns:minmax(0,1fr)}
  .dl > div+div{border-left:0;border-top:1px solid var(--line)}
  th:last-child,td:last-child{display:none}
  td:first-child{white-space:normal}
}
</style>
</head>
<body>
<nav><div class="wrap">
  ${wordmark('./')}
  <div class="links micro">
    <a href="#how"><span>01</span>How it works</a>
    <a href="#features"><span>02</span>Features</a>
    <a href="#screens"><span>03</span>Screens</a>
    <a href="#providers"><span>04</span>Providers</a>
    <a href="#download"><span>05</span>Download</a>
    <a href="readme.html"><span>06</span>Docs</a>
  </div>
  <span class="sp"></span>
  <a class="btn small" href="${REPO}">GitHub</a>
</div></nav>

<header class="hero"><div class="wrap">
  <div class="grid">
    <div>
      <p class="tag micro">v${v} · <b>early release</b> · DeepSeek driven end to end</p>
      <h1>Free web AI chats, <span>turned into a coding agent.</span></h1>
      <p class="intro">Ask for a change and it reads your project, edits files, runs commands and checks its work, asking before anything it should. The model is a chat site driven in a real browser. No API key, no per-token bill.</p>
      <div class="cta">
        <a class="btn invert" id="dl-main" href="${RELEASES}">Download for your system</a>
        <a class="btn" href="readme.html">Read the docs</a>
      </div>
      <p class="facts micro" id="dl-sub"><span>Windows</span><span>Linux</span><span>Native Qt, no web view</span><span>Unsigned</span></p>
    </div>
    <div class="panel" role="img" aria-label="A Code turn: the agent reads calc.py, fixes a subtraction that should be an addition, and runs the tests, which pass.">
      <div class="head micro"><span>Code</span><span class="live">DeepSeek</span></div>
<pre class="turn">${turn}</pre>
    </div>
  </div>
  <div class="shot panel"><div class="head micro"><span>CloseNI · Terminal theme</span><span>v${v}</span></div><img src="screenshots/code.png" alt="The Code panel: a request, a read, and an edit shown as a diff waiting for permission"></div>
</div></header>

<main class="wrap">
${section('01', 'how', 'How it works', 'A person typing, from the site\'s side.', 'A chat site has no tool-calling API, so tools are a convention written into the conversation. CloseNI teaches the model that convention and runs what comes back.')}  <ol class="steps">
${steps}
  </ol>
</section>

${section('02', 'features', 'Features', 'What it does', 'Everything here is covered by the test suites linked from the docs. Where something is not, the docs say so.')}  <dl class="features">
${features}
  </dl>
</section>

${section('03', 'screens', 'The app', 'Screens', 'Four of the panels, in a few of the themes.')}  <div class="gallery">
${shots}
  </div>
</section>

${section('04', 'providers', 'Providers', 'Where it stands, plainly', '')}  <table>
    <tr><th class="micro">Provider</th><th class="micro">Status</th><th class="micro">Notes</th></tr>
${providers}
  </table>
  <p class="terms">You are using a site under its own terms. Check them before you sign in. <a href="readme.html#providers">Details</a>.</p>
  <p class="note"><b>Use a throwaway account.</b> Sign in with a dummy email, never your main account: the more prompts you send, the more likely the account is banned. CloseNI can break when a site changes its page, and it is not recommended for production.</p>
</section>

${section('05', 'download', 'Download', 'Get CloseNI', `Version ${v}. A native Qt app with Node and the agent bundled. Chromium is downloaded on first run.`)}  <div class="dl">
    <div id="card-win"><h3>Windows<span class="micro">Your system</span></h3><p>NSIS installer; you choose the folder. Windows 10 or later.</p>
      <a class="btn invert" href="${RELEASES}">Download the .exe</a></div>
    <div id="card-linux"><h3>Linux<span class="micro">Your system</span></h3><p>An AppImage that runs anywhere, or a .deb for Debian and Ubuntu.</p>
      <a class="btn invert" href="${RELEASES}">AppImage or .deb</a></div>
    <div class="src"><h3>From source</h3><p>Node 22.12+, Qt 6.8+, CMake 3.21+ and Ninja.</p>
<pre><span class="p">$ </span>git clone ${REPO}.git &amp;&amp; cd CloseNI
<span class="p">$ </span>npm install &amp;&amp; npm run build
<span class="p">$ </span>npx playwright install chromium
<span class="p">$ </span>cmake -S native -B build-native -G Ninja
<span class="p">$ </span>cmake --build build-native &amp;&amp; npm start</pre></div>
  </div>
  <p class="note"><b>The installers are unsigned.</b> Windows SmartScreen may warn on first launch. The first run asks you to install Chromium and sign in to a provider once, with a throwaway account.</p>
</section>
</main>

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
// Point the main button at the visitor's system. Both buttons already work
// without this; it only changes the label and marks the matching column.
(function () {
  var ua = navigator.userAgent || '';
  var os = /Windows/i.test(ua) ? 'win' : /Linux|X11/i.test(ua) && !/Android/i.test(ua) ? 'linux' : '';
  if (!os) return;
  var label = 'Download for ' + { win: 'Windows', linux: 'Linux' }[os];
  var btn = document.getElementById('dl-main');
  if (btn) btn.textContent = label;
  var card = document.getElementById('card-' + os);
  if (card) card.className += ' rec';
})();
</script>
</body>
</html>`;
}
