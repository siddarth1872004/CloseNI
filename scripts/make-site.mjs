#!/usr/bin/env node
// Generates the Pages site from README.md and package.json.
//
//   docs/index.html   the landing page: what it is, screenshots, downloads
//   docs/readme.html  the README, rendered the way GitHub renders it
//
// A hand-written site drifted from the README for months, so neither page
// carries a fact of its own. The landing page takes its numbers from the
// README's stats image and its version from package.json, the documentation
// page is the README itself, and scripts/verify.mjs fails when either is older
// than its source.
//
// Pages serves docs/ as the site root, so docs/assets/x.svg becomes
// assets/x.svg. Every other repo-relative link (CHANGELOG.md, LICENSE,
// docs/SAFETY.md, source files) goes to the file on GitHub.
//
//   node scripts/make-site.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { renderLanding } from './make-landing.mjs';
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
  const body = marked.parse(readme).replace(/\b(src|href)="([^"]+)"/g, (_, a, u) => `${a}="${sitePath(u)}"`);
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
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><path d='M7 6 H13 V26 H7' fill='none' stroke='%23e8e8ea' stroke-width='2.8'/><path d='M25 6 H19 V26 H25' fill='none' stroke='%23e8e8ea' stroke-width='2.8'/></svg>">
<style>
/* GitHub's README look. The art is drawn for a dark page, so dark is the default. */
:root{
  --bg:#0d1117; --box:#0d1117; --fg:#e6edf3; --dim:#9198a1; --line:#3d444d; --line-soft:#3d444db3;
  --link:#4493f8; --code-bg:#656c7633; --pre-bg:#151b23; --quote:#9198a1; --row:#151b23; --bar:#010409;
}
@media (prefers-color-scheme: light){
  :root{
    --bg:#f6f8fa; --box:#ffffff; --fg:#1f2328; --dim:#59636e; --line:#d1d9e0; --line-soft:#d1d9e0b3;
    --link:#0969da; --code-bg:#818b981f; --pre-bg:#f6f8fa; --quote:#59636e; --row:#f6f8fa; --bar:#f6f8fa;
  }
}
*{box-sizing:border-box}
html{scroll-padding-top:64px}
body{margin:0;background:var(--bg);color:var(--fg);
  font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;word-wrap:break-word}
.bar{position:sticky;top:0;z-index:1;background:var(--bar);border-bottom:1px solid var(--line);
  display:flex;align-items:center;gap:16px;padding:12px 16px;font-size:14px}
.bar b{font-size:16px}
.bar .home{margin:0;border:0;padding:0}
.bar .dim{color:var(--dim)}
.bar a:last-child{margin-left:auto}
.bar a{color:var(--fg);text-decoration:none;border:1px solid var(--line);border-radius:6px;padding:4px 12px}
.bar a:hover{border-color:var(--dim)}
main{max-width:1012px;margin:24px auto 48px;padding:0 16px}
article{background:var(--box);border:1px solid var(--line);border-radius:6px;padding:32px}
@media (max-width:600px){main{margin-top:16px;padding:0 8px}article{padding:16px}}
a{color:var(--link);text-decoration:none}
a:hover{text-decoration:underline}
h1,h2,h3,h4,h5,h6{margin:24px 0 16px;font-weight:600;line-height:1.25}
h1{font-size:2em;padding-bottom:.3em;border-bottom:1px solid var(--line-soft)}
h2{font-size:1.5em;padding-bottom:.3em;border-bottom:1px solid var(--line-soft)}
h3{font-size:1.25em} h4{font-size:1em}
p,blockquote,ul,ol,table,pre,details{margin:0 0 16px}
ul,ol{padding-left:2em}
li+li{margin-top:.25em}
hr{height:.25em;padding:0;margin:24px 0;background:var(--line);border:0}
img{max-width:100%;height:auto;border-style:none;box-sizing:content-box}
blockquote{padding:0 1em;color:var(--quote);border-left:.25em solid var(--line)}
blockquote>:last-child{margin-bottom:0}
code,pre{font-family:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;font-size:85%}
code{padding:.2em .4em;background:var(--code-bg);border-radius:6px;white-space:break-spaces}
pre{padding:16px;overflow:auto;line-height:1.45;background:var(--pre-bg);border-radius:6px}
pre code{padding:0;background:none;font-size:100%;white-space:pre;border-radius:0}
table{display:block;width:max-content;max-width:100%;overflow:auto;border-spacing:0;border-collapse:collapse}
th,td{padding:6px 13px;border:1px solid var(--line)}
th{font-weight:600}
tr:nth-child(2n){background:var(--row)}
td img{background:transparent}
</style>
</head>
<body>
<header class="bar"><b><a class="home" href="./">CloseNI</a></b><span class="dim">Documentation</span><a href="${REPO}">View on GitHub</a></header>
<main><article>
${body}</article></main>
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
