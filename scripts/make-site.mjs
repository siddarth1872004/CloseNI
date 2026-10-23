#!/usr/bin/env node
// Generates the Pages site from README.md and package.json.
//
//   docs/index.html   the landing page: what it is, screenshots, downloads
//   docs/readme.html  the README, in the same theme as the landing page
//
// A hand-written site drifted from the README for months, so neither page
// carries a fact of its own. The landing page takes its version from
// package.json, the documentation
// page is the README itself, and scripts/verify.mjs fails when either is older
// than its source.
//
// Pages serves docs/ as the site root, so docs/assets/x.svg becomes
// assets/x.svg. Every other repo-relative link (CHANGELOG.md, LICENSE,
// docs/SAFETY.md, source files) goes to the file on GitHub.
//
//   node scripts/make-site.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { renderLanding, THEME_CSS, FAVICON, wordmark } from './make-landing.mjs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked } from 'marked';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = 'https://github.com/siddarth1872004/CloseNI';

// GitHub's heading anchors: lowercase, punctuation dropped, spaces to
// hyphens, and a -1, -2 suffix on repeats.
function slugger() {
  const seen = new Map();
  return (text) => {
    const base = text.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().replace(/ /g, '-');
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    return n ? base + '-' + n : base;
  };
}

/** A README link or image source, as the site needs it. */
function sitePath(url) {
  if (/^([a-z]+:|#|\/\/)/i.test(url)) return url;
  if (/^docs\/(assets|screenshots)\//.test(url)) return url.slice('docs/'.length);
  return REPO + (url.endsWith('/') ? '/tree/main/' : '/blob/main/') + url;
}

// shields.io badges are GitHub's idiom, not the app's. On the site each one
// becomes the app's status readout: "ready" and the like get a lamp, the
// header's label-value badges plain micro text.
const LAMP = { 'ready': 'ok', 'chat-only': 'dim', 'coming soon': 'mut' };
function badge(spec) {
  // "--" is a literal dash in a shields path, "-" the separator.
  const [label, msg] = spec.split('?')[0].replace(/--/g, '\0').split('-').map((p) => decodeURIComponent(p.replace(/\0/g, '-')));
  const lamp = LAMP[msg];
  return lamp ? `<span class="st ${lamp}">${esc(msg)}</span>` : `<span class="micro badge">${esc(label)} ${esc(msg)}</span>`;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderSite(readme) {
  const slug = slugger();
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth, text }) {
        return `<h${depth} id="${slug(text)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
    },
  });
  // Raw HTML blocks (the centred art, the screenshot tables) carry their own
  // src attributes, so the rewrite runs over the finished HTML, not the tokens.
  const body = marked.parse(readme).replace(/\b(src|href)="([^"]+)"/g, (_, a, u) => `${a}="${sitePath(u)}"`)
    .replace(/<img src="https:\/\/img\.shields\.io\/badge\/([^"]+)"[^>]*>/g, (_, b) => badge(b));
  const tagline = (readme.match(/^\*\*(.+?)\*\*/m) || [, 'CloseNI'])[1];
  return `<!DOCTYPE html>
<!-- Generated from README.md by scripts/make-site.mjs. Edit the README, then run npm run site. -->
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CloseNI</title>
<meta name="description" content="${esc(tagline)}">
<meta property="og:title" content="CloseNI">
<meta property="og:description" content="${esc(tagline)}">
<meta property="og:image" content="screenshots/code.png">
<meta name="twitter:card" content="summary_large_image">
${FAVICON}
<style>${THEME_CSS}
/* The README, in the app's own type: the same tokens as the landing page. */
html{scroll-padding-top:64px}
body{word-wrap:break-word}
.bar{position:sticky;top:0;z-index:1;background:var(--panel);border-bottom:1px solid var(--line)}
.bar div{max-width:960px;margin:0 auto;padding:0 16px;height:48px;display:flex;align-items:center;gap:16px}
.bar .micro span{color:var(--line2);margin-right:6px}
.bar .sp{flex:1}
main{max-width:960px;margin:0 auto;padding:40px 16px 96px}
h1,h2,h3,h4,h5,h6{margin:40px 0 14px;font-weight:600;line-height:1.3}
h1{font-size:26px}
h2{font-size:19px;padding-top:28px;border-top:1px solid var(--line)}
h3{font-size:15px} h4{font-size:14px;color:var(--dim)}
main>:first-child{margin-top:0}
p,blockquote,ul,ol,table,pre,details{margin:0 0 16px}
p,li,td{color:var(--dim)}
strong,b,th{color:var(--txt);font-weight:600}
ul,ol{padding-left:2ch}
li+li{margin-top:.3em}
li::marker{color:var(--mut)}
hr{height:1px;margin:40px 0;background:var(--line);border:0}
hr+h2{margin-top:0;padding-top:0;border-top:0}
img{max-width:100%;height:auto;border-style:none}
p>img{vertical-align:middle}
blockquote{margin-left:0;padding:10px 14px;border-left:2px solid var(--warn);background:var(--panel)}
blockquote>:last-child{margin-bottom:0}
code{font:inherit;font-size:92%;padding:1px 5px;color:var(--txt);background:var(--raised);border-radius:2px;white-space:break-spaces}
pre{padding:12px 14px;overflow:auto;font-size:12.5px;line-height:1.7;background:var(--sunken);border:1px solid var(--line);border-radius:2px}
pre code{padding:0;background:none;font-size:100%;white-space:pre}
table{display:block;width:max-content;max-width:100%;overflow:auto;border-collapse:collapse;border-top:1px solid var(--line2);font-size:13px}
th,td{padding:8px 16px 8px 0;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}
th{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--mut);font-weight:400}
td img{border:1px solid var(--line);border-radius:3px}
.badge{display:inline-block;margin-right:14px;color:var(--dim)}
a:has(>.badge){text-decoration:none}
@media (max-width:640px){.bar .micro{display:none}main{padding-top:24px}}
</style>
</head>
<body>
<header class="bar"><div>${wordmark('./')}<span class="micro"><span>06</span>Documentation</span><span class="sp"></span><a class="btn small" href="./">Home</a><a class="btn small" href="${REPO}">GitHub</a></div></header>
<main>
${body}</main>
</body>
</html>
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf8');
  const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  writeFileSync(resolve(ROOT, 'docs/readme.html'), renderSite(readme));
  writeFileSync(resolve(ROOT, 'docs/index.html'), renderLanding(readme, pkg));
  console.log('docs/index.html and docs/readme.html written');
}
