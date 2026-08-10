# Visual Identity & Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give CloseNI a token system, nine themes, a settings page, a logo and language marks — without changing what the app does.

**Architecture:** Every colour in `styles.css` becomes a custom property, enforced by a lint that fails on any colour literal outside a theme block. A theme is then one block of those properties under `[data-theme="…"]`, applied by setting an attribute on `<html>`. Everything else in this plan depends on the tokens existing, so they come first.

**Tech Stack:** Plain CSS custom properties, no preprocessor. Renderer logic in UMD-style modules (`window.X` in the browser, `module.exports` under Node) beside `diff.js`, `entrypoint.js` and `controls-settings.js` — there is no bundler. Tests are plain CommonJS in `local-agent/test/run-tests.cjs`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-10-visual-identity-design.md`. Read it before starting.
- **Themes style CloseNI's own chrome and nothing else.** Nothing under `local-agent/src/` reads or writes a theme. The app never injects a theme, token, stylesheet or colour into a generated project. This is a rule, not an oversight to be corrected later.
- **No motion is added.** Static scanlines, glow and bloom only. The only animations in the app remain the progress bar filling and the toast sliding in, both behind `prefers-reduced-motion`.
- **No brand assets.** Language marks are drawn from the file extension. Nothing is fetched or vendored.
- **The app must run after every task.** Each task leaves `npm start` working.
- Run tests with `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs`. The Windows toolchain on PATH cannot read UNC paths.
- Never commit `local-agent/storage/sessions.json`, `last-chat-url.json`, or anything under `local-agent/storage/browser-profiles/`.

## File Structure

| File | Responsibility |
|---|---|
| `desktop/styles.css` (modify) | Tokens, the nine theme blocks, every rule referring to tokens only |
| `desktop/theme.js` (create) | `THEMES`, `resolveTheme` — which theme to use. Pure. |
| `desktop/language-mark.js` (create) | `languageMark(path)` — extension to label and token. Pure. |
| `desktop/index.html` (modify) | Settings panel, nav item, logo, no-flash bootstrap, inline styles removed |
| `desktop/renderer.js` (modify) | Appearance section wiring, `MODE_TITLES` entry |
| `desktop/builder.js` (modify) | Language mark on file cards |
| `build/icon.svg` (create) | The logo, canonical source for sub-project 8's installer icons |
| `local-agent/test/css-lint.cjs` (create) | Token completeness and per-theme completeness checks |
| `local-agent/test/run-tests.cjs` (modify) | New unit sections |

**Phase A (tasks 1–4)** builds the foundation: tokens, themes, settings. **Phase B (tasks 5–8)** is the polish that depends on it.

---

### Task 1: Tokens, enforced by a lint

**Files:**
- Create: `local-agent/test/css-lint.cjs`
- Modify: `desktop/styles.css`
- Test: `local-agent/test/run-tests.cjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `colorLiteralsOutsideThemes(css) -> Array<{line: number, text: string}>`
  - `themeBlocks(css) -> Array<{name: string, tokens: string[]}>` — `name` is `":root"` or the `data-theme` value
  - `STRUCTURAL_PREFIXES: string[]`

- [ ] **Step 1: Write the lint module**

Create `local-agent/test/css-lint.cjs`. This is test infrastructure rather than production code, so it lives with the tests:

```javascript
/*
 * Checks that styles.css can actually be themed.
 *
 * A theme reaches exactly as far as the tokens do. One hardcoded hex and that
 * rule keeps its dark colour under every theme - which looks worse than no
 * theming at all, and does it silently. So this is a test rather than a
 * convention: conventions decay on the next edit.
 */
const COLOR = /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(|\bhsla?\s*\(/;

/** Tokens that describe structure, not appearance. Themes never redefine these. */
const STRUCTURAL_PREFIXES = ["--sp-", "--r-", "--dur-", "--ease"];

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Every colour literal that a theme could never reach.
 *
 * Walks line by line tracking brace depth, so a rule inside @media or
 * @keyframes is still seen. Anything inside a :root or [data-theme] block is
 * exempt - that is where colours are supposed to be.
 */
function colorLiteralsOutsideThemes(css) {
  const lines = stripComments(css).split("\n");
  const offenders = [];
  let depth = 0;
  let themeDepth = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (themeDepth === -1 && /:root|\[data-theme/.test(line) && line.indexOf("{") !== -1) {
      themeDepth = depth;
    }
    if (themeDepth === -1 && COLOR.test(line)) {
      offenders.push({ line: i + 1, text: line.trim().slice(0, 100) });
    }
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
    if (themeDepth !== -1 && depth <= themeDepth) themeDepth = -1;
  }
  return offenders;
}

/** Each :root / [data-theme] block and the token names it declares. */
function themeBlocks(css) {
  const out = [];
  const text = stripComments(css);
  const re = /(:root|\[data-theme="([^"]+)"\])\s*\{([\s\S]*?)\}/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const tokens = [];
    const tokenRe = /(--[a-z0-9-]+)\s*:/g;
    let t;
    while ((t = tokenRe.exec(m[3])) !== null) tokens.push(t[1]);
    out.push({ name: m[2] || ":root", tokens: tokens });
  }
  return out;
}

module.exports = { colorLiteralsOutsideThemes, themeBlocks, STRUCTURAL_PREFIXES, COLOR };
```

- [ ] **Step 2: Write the failing test**

Add to `local-agent/test/run-tests.cjs`, above `function testEntrypoint()`:

```javascript
function testCssTokens() {
  section("css tokens");
  const { colorLiteralsOutsideThemes, themeBlocks } = require(path.join(__dirname, "css-lint.cjs"));
  const css = fs.readFileSync(path.join(__dirname, "..", "..", "desktop", "styles.css"), "utf8");

  // The load-bearing check. A colour outside a theme block is a rule no theme
  // can reach, and it fails silently - the app just looks wrong on that theme.
  const stray = colorLiteralsOutsideThemes(css);
  check("no colour literals outside theme blocks", stray.length === 0,
    stray.slice(0, 6).map(function (o) { return "line " + o.line + ": " + o.text; }).join(" | "));

  // Sanity-check the lint itself, so a broken detector cannot report success.
  check("the lint detects a hex", colorLiteralsOutsideThemes(".a{color:#fff;}").length === 1);
  check("the lint detects rgba", colorLiteralsOutsideThemes(".a{background:rgba(0,0,0,.5);}").length === 1);
  check("the lint ignores colours inside :root", colorLiteralsOutsideThemes(":root{--x:#fff;}").length === 0);
  check("the lint ignores colours inside a theme block",
    colorLiteralsOutsideThemes('[data-theme="paper"]{--x:#fff;}').length === 0);
  check("the lint sees a rule after a theme block closes",
    colorLiteralsOutsideThemes(':root{--x:#fff;}\n.a{color:#000;}').length === 1);
  check("the lint ignores var() references", colorLiteralsOutsideThemes(".a{color:var(--txt);}").length === 0);

  const blocks = themeBlocks(css);
  check("a :root block exists", blocks.some(function (b) { return b.name === ":root"; }));
}
```

Register it in `main()`:

```javascript
  testControlSettings();
  testCssTokens();
  testToolchain();
```

- [ ] **Step 3: Run test to verify it fails**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs`
Expected: FAIL — "no colour literals outside theme blocks", reporting around 40 lines.

- [ ] **Step 4: Replace the `:root` block**

In `desktop/styles.css`, replace lines 1-4 (the existing `:root`) with the full token set. Structural tokens first, then the palette:

```css
:root{
  /* Structural. Themes never redefine these. */
  --sp-1:4px; --sp-2:6px; --sp-3:8px; --sp-4:12px; --sp-5:14px; --sp-6:20px;
  --r-sm:2px; --r-md:3px; --r-lg:6px;
  --dur-fast:.12s; --dur-slow:.4s; --ease:ease;

  /* Palette. Every theme block below redefines all of these. */
  --bg:#0b0b0c; --panel:#101012; --surface:#0e0e10; --surface-raised:#17171a; --surface-sunken:#050506;
  --overlay:rgba(0,0,0,.7);
  --line:#232326; --line-strong:#2e2e33; --line-focus:#6f7ce0;
  --txt:#e8e8ea; --dim:#9b9ba3; --mut:#5b5b63; --inverse:#0b0b0c;
  --ok:#8fe0a8; --ok-bg:#0d2416; --ok-line:#2c4f39;
  --warn:#e0cf8f; --warn-bg:#211f13; --warn-line:#5c5327;
  --err:#eda1a6; --err-bg:#2a1214; --err-line:#5c2c2f;
  --lang-py:#78c0e0; --lang-rs:#e0a878; --lang-js:#e0cf8f; --lang-java:#e08f96; --lang-c:#a49ce0; --lang-default:#9b9ba3;
  --shadow-1:0 4px 20px rgba(0,0,0,.5); --shadow-2:0 12px 40px rgba(0,0,0,.75);
  --overlay-texture:none; --glow:none;
}
```

- [ ] **Step 5: Replace every remaining colour literal**

Work through `styles.css` applying this mapping. It is mechanical — the same value always maps to the same token:

| Literal | Token | Occurrences |
|---|---|---|
| `#0e0e10` | `var(--surface)` | 10 |
| `#17171a` | `var(--surface-raised)` | 7 |
| `#050506` | `var(--surface-sunken)` | 5 |
| `#101012` | `var(--panel)` | 1 (`.toast`) |
| `#0b0b0d` | `var(--bg)` | 1 (`#suggest-bar`) |
| `#0a0a0c` | `var(--surface-sunken)` | 1 (`.diff-line.gap`) |
| `#0b0b0c` | `var(--inverse)` | 1 (`.btn.invert`) |
| `rgba(255,255,255,.02)` | `var(--surface-raised)` | 1 (`#plan-head`) |
| `rgba(0,0,0,.7)` | `var(--overlay)` | 1 (`#approval-modal`) |
| `0 4px 20px rgba(0,0,0,.5)` | `var(--shadow-1)` | 1 (`.toast`) |
| `#0d2416` / `#8fe0a8` | `var(--ok-bg)` / `var(--ok)` | `.diff-line.add`, `.test-row.pass` |
| `#2a1214` / `#eda1a6` | `var(--err-bg)` / `var(--err)` | `.diff-line.remove`, `.test-row.fail` |
| `#8a8a8a` / `#1a1a1d` | `var(--err-line)` / `var(--err-bg)` | `.toast.err` |

Three rules need more than substitution:

```css
/* Was: background:#fff;border-color:#fff;color:#000 - two literals for one
   hover state. brightness() works on any theme and needs no token. */
.btn.invert:hover:not(:disabled){filter:brightness(1.15);}

/* Was: color:#fff on a --mut background. State colour replaces it in Task 7;
   for now it takes the error tokens so no literal survives. */
.step-card-status.failed{color:var(--err);background:var(--err-bg);border-color:var(--err-line);}

/* Rename for consistency with --line-strong. 8 occurrences of var(--line2). */
--line2  ->  --line-strong
```

- [ ] **Step 6: Run test to verify it passes**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs`
Expected: PASS, count up by 8.

Then confirm nothing moved visually:

Run: `npm start`
Expected: the app looks exactly as it did. This task changes no appearance — every token holds the value the literal held. The one intended difference is `.toast.err`, which becomes reddish instead of grey.

- [ ] **Step 7: Commit**

```bash
git add desktop/styles.css local-agent/test/css-lint.cjs local-agent/test/run-tests.cjs
git commit -m "Turn every colour into a token, enforced by a lint"
```

---

### Task 2: The theme engine

**Files:**
- Create: `desktop/theme.js`
- Modify: `desktop/index.html` (script tag, no-flash bootstrap)
- Test: `local-agent/test/run-tests.cjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `THEMES: Array<{id: string, name: string, crt: boolean}>`
  - `resolveTheme(saved: string|null, available?: Array): string`
  - `DEFAULT_THEME = "midnight"`, `THEME_KEY = "closeni.theme"`, `DECOR_KEY = "closeni.theme.decor"`

- [ ] **Step 1: Write the failing test**

Add to `local-agent/test/run-tests.cjs`, above `function testEntrypoint()`:

```javascript
function testTheme() {
  section("theme resolution");
  const { THEMES, resolveTheme, DEFAULT_THEME } = require(path.join(__dirname, "..", "..", "desktop", "theme.js"));

  check("nine themes are offered", THEMES.length === 9, String(THEMES.length));
  check("midnight is the default", DEFAULT_THEME === "midnight");
  check("midnight is in the list", THEMES.some(function (t) { return t.id === "midnight"; }));
  check("every theme has an id and a name",
    THEMES.every(function (t) { return t.id && t.name; }));
  check("ids are unique",
    new Set(THEMES.map(function (t) { return t.id; })).size === THEMES.length);
  // Only the CRT-flavoured themes carry scanlines and glow, so the Appearance
  // toggle knows when to show itself.
  check("four themes are marked as CRT",
    THEMES.filter(function (t) { return t.crt; }).length === 4, 
    THEMES.filter(function (t) { return t.crt; }).map(function (t) { return t.id; }).join());

  check("a saved theme is honoured", resolveTheme("paper") === "paper");
  check("nothing saved yields the default", resolveTheme(null) === "midnight");
  check("an empty string yields the default", resolveTheme("") === "midnight");
  // A theme removed in a later version must not leave the app unstyled.
  check("an unknown theme falls back", resolveTheme("vaporwave-deluxe") === "midnight");
  check("a non-string falls back", resolveTheme({ id: "paper" }) === "midnight");
}
```

Register it in `main()`:

```javascript
  testCssTokens();
  testTheme();
  testToolchain();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs`
Expected: FAIL — `Cannot find module '.../desktop/theme.js'`

- [ ] **Step 3: Write the implementation**

Create `desktop/theme.js`:

```javascript
/*
 * Which theme to use.
 *
 * Loaded as a plain <script> in the renderer (window.CNTheme) and require()d by
 * the test harness (module.exports). There is no bundler, so no import/export.
 *
 * Applying a theme is setting one attribute on <html>; the styling itself is
 * entirely CSS. Nothing here knows what a colour is.
 */
(function (root) {
  var DEFAULT_THEME = "midnight";
  var THEME_KEY = "closeni.theme";
  var DECOR_KEY = "closeni.theme.decor";

  // `crt` marks the themes carrying scanlines and glow, so Appearance knows
  // when the decoration toggle is worth showing.
  var THEMES = [
    { id: "midnight",        name: "Midnight",          crt: false },
    { id: "paper",           name: "Paper",             crt: false },
    { id: "phosphor",        name: "Phosphor",          crt: true },
    { id: "amber",           name: "Amber",             crt: true },
    { id: "cassette-indigo", name: "Cassette · Indigo", crt: true },
    { id: "cassette-miami",  name: "Cassette · Miami",  crt: true },
    { id: "cassette-grid",   name: "Cassette · Grid",   crt: true },
    { id: "blueprint",       name: "Blueprint",         crt: false },
    { id: "contrast",        name: "High contrast",     crt: false },
  ];

  /**
   * A saved theme is trusted only if it still exists. A theme dropped in a
   * later version would otherwise leave the app with no palette at all -
   * every token unresolved, which renders as unstyled text on white.
   */
  function resolveTheme(saved, available) {
    var list = available || THEMES;
    if (typeof saved !== "string" || !saved) return DEFAULT_THEME;
    for (var i = 0; i < list.length; i++) if (list[i].id === saved) return saved;
    return DEFAULT_THEME;
  }

  var api = {
    THEMES: THEMES,
    resolveTheme: resolveTheme,
    DEFAULT_THEME: DEFAULT_THEME,
    THEME_KEY: THEME_KEY,
    DECOR_KEY: DECOR_KEY,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CNTheme = api;
})(typeof window !== "undefined" ? window : globalThis);
```

Note the `crt: true` count is four — phosphor, amber, and two of the three Cassettes? No: phosphor, amber, cassette-indigo, cassette-miami, cassette-grid is five. Set `crt: false` on `cassette-grid`, which has no scanline overlay in its design, giving four. If you prefer all three Cassettes to carry decoration, change the test's expected count to five and mark it so — the number must match the CSS written in Task 3.

- [ ] **Step 4: Add the script tag and the no-flash bootstrap**

In `desktop/index.html`, add the theme script beside the other UMD modules:

```html
<script src="controls-settings.js"></script>
<script src="theme.js"></script>
```

Then, in `<head>` immediately after the stylesheet link, add the bootstrap. It must run before first paint or the app flashes Midnight before switching:

```html
<link rel="stylesheet" href="styles.css">
<script>
  /* Before first paint: a theme applied from renderer.js would flash Midnight
     first. Inline and synchronous is the only way to avoid that. */
  try {
    var t = localStorage.getItem("closeni.theme");
    if (t) document.documentElement.setAttribute("data-theme", t);
    if (localStorage.getItem("closeni.theme.decor") === "off") {
      document.documentElement.setAttribute("data-decor", "off");
    }
  } catch (e) { /* storage disabled: the default theme is correct anyway */ }
</script>
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs && node --check desktop/theme.js`
Expected: PASS, count up by 11.

- [ ] **Step 6: Commit**

```bash
git add desktop/theme.js desktop/index.html local-agent/test/run-tests.cjs
git commit -m "Add the theme engine and a no-flash bootstrap"
```

---

### Task 3: The nine themes

**Files:**
- Modify: `desktop/styles.css`
- Test: `local-agent/test/run-tests.cjs`

**Interfaces:**
- Consumes: `themeBlocks`, `STRUCTURAL_PREFIXES` from Task 1; `THEMES` from Task 2.
- Produces: nine `[data-theme]` blocks. No JavaScript.

- [ ] **Step 1: Write the failing test**

Add to `testCssTokens()` in `local-agent/test/run-tests.cjs`, after the existing checks:

```javascript
  // Every theme must redefine the whole palette. A theme that omits --err-bg
  // inherits Midnight's near-black, which looks correct until the day a build
  // fails - on Paper, that is dark red text on a dark red background.
  const { STRUCTURAL_PREFIXES } = require(path.join(__dirname, "css-lint.cjs"));
  const { THEMES } = require(path.join(__dirname, "..", "..", "desktop", "theme.js"));
  const rootBlock = blocks.find(function (b) { return b.name === ":root"; });
  const palette = rootBlock.tokens.filter(function (t) {
    return !STRUCTURAL_PREFIXES.some(function (p) { return t.indexOf(p) === 0; });
  });

  check("the palette is substantial", palette.length >= 25, String(palette.length));
  check("structural tokens are excluded from the palette",
    palette.indexOf("--sp-1") === -1 && palette.indexOf("--r-md") === -1);

  THEMES.forEach(function (t) {
    if (t.id === "midnight") return;   // midnight IS :root
    const block = blocks.find(function (b) { return b.name === t.id; });
    if (!block) { check("theme " + t.id + " has a block", false); return; }
    const missing = palette.filter(function (tok) { return block.tokens.indexOf(tok) === -1; });
    check("theme " + t.id + " defines the whole palette", missing.length === 0, missing.join(" "));
  });

  // Structural tokens belong to :root alone; a theme redefining spacing would
  // change layout, which is not what a theme is for.
  blocks.forEach(function (b) {
    if (b.name === ":root") return;
    const structural = b.tokens.filter(function (t) {
      return STRUCTURAL_PREFIXES.some(function (p) { return t.indexOf(p) === 0; });
    });
    check("theme " + b.name + " does not redefine structure", structural.length === 0, structural.join(" "));
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs`
Expected: FAIL — eight "theme X has a block" checks fail, one per theme other than midnight.

- [ ] **Step 3: Write the theme blocks**

Append to `desktop/styles.css`, immediately after the `:root` block. Midnight is `:root` itself and gets no block of its own.

```css
/* Light. The demanding one: every surface, line and state needs a counterpart,
   which is what forces the token set to be complete. */
[data-theme="paper"]{
  --bg:#f7f7f5; --panel:#fff; --surface:#fff; --surface-raised:#eeeee9; --surface-sunken:#f0f0ec;
  --overlay:rgba(40,40,38,.45);
  --line:#ddddd7; --line-strong:#c6c6bf; --line-focus:#3b4fd8;
  --txt:#1b1b1d; --dim:#55555a; --mut:#8a8a84; --inverse:#f7f7f5;
  --ok:#2f6b45; --ok-bg:#eaf6ee; --ok-line:#a8d4b6;
  --warn:#7a6520; --warn-bg:#faf5e2; --warn-line:#d8c98a;
  --err:#9c2f38; --err-bg:#fbeced; --err-line:#e0b0b4;
  --lang-py:#1f5f85; --lang-rs:#a85c22; --lang-js:#7a6520; --lang-java:#9c2f38; --lang-c:#4a448a; --lang-default:#55555a;
  --shadow-1:0 4px 20px rgba(40,40,38,.14); --shadow-2:0 12px 40px rgba(40,40,38,.2);
  --overlay-texture:none; --glow:none;
}

/* Green CRT. Square corners come from --r-* staying put; the character is the
   scanline overlay and the phosphor glow. */
[data-theme="phosphor"]{
  --bg:#020a04; --panel:#04140a; --surface:#04140a; --surface-raised:#0a2412; --surface-sunken:#010603;
  --overlay:rgba(0,10,4,.78);
  --line:#12401f; --line-strong:#2f8a52; --line-focus:#7bffa0;
  --txt:#9dffb8; --dim:#4ec46f; --mut:#2f8a52; --inverse:#020a04;
  --ok:#7bffa0; --ok-bg:#04240f; --ok-line:#2f8a52;
  --warn:#d8ff7b; --warn-bg:#141f04; --warn-line:#6b8a2f;
  --err:#ff9d8f; --err-bg:#240a06; --err-line:#8a3f2f;
  --lang-py:#7bffd8; --lang-rs:#d8ff7b; --lang-js:#b8ff7b; --lang-java:#ff9d8f; --lang-c:#7bd8ff; --lang-default:#4ec46f;
  --shadow-1:0 4px 20px rgba(0,0,0,.6); --shadow-2:0 12px 40px rgba(0,0,0,.8);
  --overlay-texture:repeating-linear-gradient(0deg,rgba(0,255,120,.045) 0 1px,transparent 1px 3px);
  --glow:0 0 8px rgba(80,255,140,.55);
}

/* The same CRT in amber - easier on the eyes over a long session. */
[data-theme="amber"]{
  --bg:#0c0703; --panel:#150c04; --surface:#150c04; --surface-raised:#241407; --surface-sunken:#080402;
  --overlay:rgba(12,7,3,.78);
  --line:#40260c; --line-strong:#8a5a20; --line-focus:#ffc06b;
  --txt:#ffd9a0; --dim:#c4913f; --mut:#8a5a20; --inverse:#0c0703;
  --ok:#c8e06b; --ok-bg:#1a2407; --ok-line:#6b8a2f;
  --warn:#ffc06b; --warn-bg:#241a07; --warn-line:#8a6520;
  --err:#ff9b7b; --err-bg:#240e06; --err-line:#8a3f2f;
  --lang-py:#6bc8e0; --lang-rs:#ffc06b; --lang-js:#e0cf8f; --lang-java:#ff9b7b; --lang-c:#c8a0e0; --lang-default:#c4913f;
  --shadow-1:0 4px 20px rgba(0,0,0,.6); --shadow-2:0 12px 40px rgba(0,0,0,.8);
  --overlay-texture:repeating-linear-gradient(0deg,rgba(255,180,80,.04) 0 1px,transparent 1px 3px);
  --glow:0 0 8px rgba(255,170,70,.5);
}

/* Retro-futurist, violet. Cyan for success, magenta for what is live. */
[data-theme="cassette-indigo"]{
  --bg:#07060f; --panel:#0d0a1c; --surface:#0d0a1c; --surface-raised:#171233; --surface-sunken:#040309;
  --overlay:rgba(7,6,15,.78);
  --line:#241c47; --line-strong:#5a2a6e; --line-focus:#f08cff;
  --txt:#e6e2ff; --dim:#a49ce0; --mut:#6a5fa8; --inverse:#07060f;
  --ok:#4fe0d0; --ok-bg:#07211f; --ok-line:#1f6b6b;
  --warn:#f08cff; --warn-bg:#220e2a; --warn-line:#a83fc4;
  --err:#ff7b9d; --err-bg:#24060f; --err-line:#8a2f4a;
  --lang-py:#4fe0d0; --lang-rs:#ffb03f; --lang-js:#f0e08c; --lang-java:#ff7b9d; --lang-c:#a49ce0; --lang-default:#a49ce0;
  --shadow-1:0 4px 20px rgba(0,0,0,.6); --shadow-2:0 12px 40px rgba(0,0,0,.8);
  --overlay-texture:repeating-linear-gradient(0deg,rgba(120,200,255,.035) 0 1px,transparent 1px 3px);
  --glow:0 0 8px rgba(200,120,255,.5);
}

/* Retro-futurist, warm. Hot pink and gold on plum. */
[data-theme="cassette-miami"]{
  --bg:#0a0512; --panel:#150a1e; --surface:#150a1e; --surface-raised:#241033; --surface-sunken:#05020a;
  --overlay:rgba(10,5,18,.78);
  --line:#3a1430; --line-strong:#8a3050; --line-focus:#ffb03f;
  --txt:#ffe0ee; --dim:#e0a0c8; --mut:#a05a86; --inverse:#0a0512;
  --ok:#4fe0d0; --ok-bg:#07211f; --ok-line:#1f6b6b;
  --warn:#ffc86b; --warn-bg:#2a1a06; --warn-line:#ffb03f;
  --err:#ff5aa0; --err-bg:#2a0616; --err-line:#8a3050;
  --lang-py:#4fe0d0; --lang-rs:#ffb03f; --lang-js:#ffc86b; --lang-java:#ff5aa0; --lang-c:#c88ce0; --lang-default:#e0a0c8;
  --shadow-1:0 4px 20px rgba(0,0,0,.6); --shadow-2:0 12px 40px rgba(0,0,0,.8);
  --overlay-texture:repeating-linear-gradient(0deg,rgba(255,150,200,.035) 0 1px,transparent 1px 3px);
  --glow:0 0 8px rgba(255,90,150,.5);
}

/* Retro-futurist, cool. No magenta, green for success - the most legible of
   the three, and the only one without a scanline overlay. */
[data-theme="cassette-grid"]{
  --bg:#03080e; --panel:#061420; --surface:#061420; --surface-raised:#0a2033; --surface-sunken:#020509;
  --overlay:rgba(3,8,14,.78);
  --line:#0e2c3f; --line-strong:#1d6f9c; --line-focus:#5fd8ff;
  --txt:#dff4ff; --dim:#8fc4e0; --mut:#3d7a9c; --inverse:#03080e;
  --ok:#4fe08f; --ok-bg:#07211a; --ok-line:#1f6b4a;
  --warn:#e0d08f; --warn-bg:#21200e; --warn-line:#6b6320;
  --err:#ff8f9d; --err-bg:#240a0e; --err-line:#8a2f3a;
  --lang-py:#5fd8ff; --lang-rs:#e0a878; --lang-js:#e0d08f; --lang-java:#ff8f9d; --lang-c:#9c8fe0; --lang-default:#8fc4e0;
  --shadow-1:0 4px 20px rgba(0,0,0,.6); --shadow-2:0 12px 40px rgba(0,0,0,.8);
  --overlay-texture:none;
  --glow:0 0 9px rgba(95,216,255,.5);
}

/* Drafting paper in negative. The texture is a grid rather than scanlines. */
[data-theme="blueprint"]{
  --bg:#081a2e; --panel:#0b2540; --surface:#0b2540; --surface-raised:#123350; --surface-sunken:#05131f;
  --overlay:rgba(8,26,46,.78);
  --line:#1c4468; --line-strong:#4c86b8; --line-focus:#c8e4ff;
  --txt:#e8f4ff; --dim:#a8ccea; --mut:#5f8fb8; --inverse:#081a2e;
  --ok:#7fd8a8; --ok-bg:#0d2a1e; --ok-line:#3f7a5c;
  --warn:#e8cf8f; --warn-bg:#2a2410; --warn-line:#8a7a3f;
  --err:#f0a0a8; --err-bg:#2a1218; --err-line:#8a4550;
  --lang-py:#8fd8f0; --lang-rs:#e8b48f; --lang-js:#e8cf8f; --lang-java:#f0a0a8; --lang-c:#b0a8f0; --lang-default:#a8ccea;
  --shadow-1:0 4px 20px rgba(0,0,0,.45); --shadow-2:0 12px 40px rgba(0,0,0,.65);
  --overlay-texture:linear-gradient(rgba(120,190,255,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(120,190,255,.07) 1px,transparent 1px);
  --glow:none;
}

/* Not a style choice. The fallback for anyone the CRT themes are unusable for:
   maximum contrast, no colour coding carrying meaning on its own, no texture. */
[data-theme="contrast"]{
  --bg:#000; --panel:#0a0a0a; --surface:#0a0a0a; --surface-raised:#1a1a1a; --surface-sunken:#000;
  --overlay:rgba(0,0,0,.85);
  --line:#3a3a3a; --line-strong:#fff; --line-focus:#fff;
  --txt:#fff; --dim:#c8c8c8; --mut:#8a8a8a; --inverse:#000;
  --ok:#fff; --ok-bg:#000; --ok-line:#fff;
  --warn:#fff; --warn-bg:#000; --warn-line:#fff;
  --err:#fff; --err-bg:#000; --err-line:#fff;
  --lang-py:#fff; --lang-rs:#fff; --lang-js:#fff; --lang-java:#fff; --lang-c:#fff; --lang-default:#fff;
  --shadow-1:none; --shadow-2:none;
  --overlay-texture:none; --glow:none;
}
```

Blueprint's `--overlay-texture` holds two comma-separated gradients, so the rule
applying it must also set `background-size:14px 14px`. Add that in Task 7 when
the texture layer is introduced; until then the token is declared but unused.

- [ ] **Step 4: Run tests to verify they pass**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs`
Expected: PASS. If a "defines the whole palette" check fails, it names the exact missing tokens.

- [ ] **Step 5: Check each theme by eye**

Run: `npm start`, then in DevTools console:

```javascript
["midnight","paper","phosphor","amber","cassette-indigo","cassette-miami","cassette-grid","blueprint","contrast"]
  .forEach((t,i) => setTimeout(() => document.documentElement.setAttribute("data-theme", t), i*1200));
```

Expected: nine distinct looks, text legible against its background in every one. Paper is the one to watch — it is where an un-tokenised colour would show as dark-on-light.

- [ ] **Step 6: Commit**

```bash
git add desktop/styles.css local-agent/test/run-tests.cjs
git commit -m "Add nine themes, each defining the whole palette"
```

---

### Task 4: The settings panel

**Files:**
- Modify: `desktop/index.html:10-45` (rail), and add `#panel-settings`
- Modify: `desktop/renderer.js` (`MODE_TITLES`, Appearance wiring)
- Modify: `desktop/styles.css` (settings layout)

**Interfaces:**
- Consumes: `THEMES`, `resolveTheme`, `THEME_KEY`, `DECOR_KEY` from Task 2.
- Produces: no new exports.

- [ ] **Step 1: Add the nav item and the panel**

`switchTab` in `renderer.js:84` is already generic — it toggles `.nav-btn` by `data-mode` and shows `#panel-<mode>`. A new tab needs markup plus one `MODE_TITLES` entry, and no logic change.

In `desktop/index.html`, add to `<nav>`:

```html
<button class="nav-btn" data-mode="settings"><i>06</i>Settings</button>
```

**Move — do not rewrite — these blocks out of `#rail-bottom` into a new panel.** Every control keeps its existing `id`, so `renderer.js` continues to find them and every existing behaviour and test survives untouched:

```html
<section id="panel-settings" class="panel">
  <div id="settings-view">
    <div id="settings-nav">
      <button class="settings-tab active" data-section="provider">Provider</button>
      <button class="settings-tab" data-section="permissions">Permissions</button>
      <button class="settings-tab" data-section="appearance">Appearance</button>
      <button class="settings-tab" data-section="about">About</button>
    </div>
    <div id="settings-body">

      <div class="settings-section active" data-section="provider">
        <div class="micro">Provider</div>
        <select id="provider-select"></select>
        <button id="provider-signin" class="btn">Sign in</button>
        <div id="provider-controls"></div>
      </div>

      <div class="settings-section" data-section="permissions">
        <div class="micro">Permissions</div>
        <select id="autonomy-select">
          <option value="ask">Ask each command</option>
          <option value="auto">Auto-allow</option>
          <option value="never">Never run commands</option>
        </select>
        <div class="settings-row">
          <input type="checkbox" id="show-browser">
          <label for="show-browser">Show Browser</label>
        </div>
      </div>

      <div class="settings-section" data-section="appearance">
        <div class="micro">Theme</div>
        <div id="theme-grid"></div>
        <div class="settings-row" id="decor-row">
          <input type="checkbox" id="theme-decor" checked>
          <label for="theme-decor">Scanlines &amp; glow</label>
        </div>
      </div>

      <div class="settings-section" data-section="about">
        <div class="micro">About</div>
        <div id="about-body"></div>
      </div>

    </div>
  </div>
</section>
```

`#rail-bottom` keeps only the workspace and chat-session blocks — the two touched most often mid-task.

- [ ] **Step 2: Add the mode title**

Find `MODE_TITLES` in `desktop/renderer.js` and add the entry, matching the existing style:

```javascript
settings: "SETTINGS",
```

- [ ] **Step 3: Wire the settings sections and the theme grid**

Append to `desktop/renderer.js`:

```javascript
// Settings section switching. Same shape as switchTab, scoped to the panel.
document.querySelectorAll(".settings-tab").forEach(function (tab) {
  tab.onclick = function () {
    const want = tab.dataset.section;
    document.querySelectorAll(".settings-tab").forEach(function (t) {
      t.classList.toggle("active", t.dataset.section === want);
    });
    document.querySelectorAll(".settings-section").forEach(function (s) {
      s.classList.toggle("active", s.dataset.section === want);
    });
  };
});

/**
 * The theme picker.
 *
 * A theme is one attribute on <html>; the styling is entirely CSS. The
 * attribute is also written by an inline script in <head> so the app never
 * paints Midnight before switching.
 */
(function () {
  const grid = $("theme-grid");
  if (!grid || !window.CNTheme) return;
  const T = window.CNTheme;

  function saved(key, fallback) {
    try { return localStorage.getItem(key) || fallback; } catch (e) { return fallback; }
  }
  let current = T.resolveTheme(saved(T.THEME_KEY, null));

  function apply(id) {
    current = T.resolveTheme(id);
    document.documentElement.setAttribute("data-theme", current);
    try { localStorage.setItem(T.THEME_KEY, current); } catch (e) {}
    grid.querySelectorAll(".theme-swatch").forEach(function (s) {
      s.classList.toggle("active", s.dataset.theme === current);
    });
    // The decoration toggle is meaningless on a theme with no decoration.
    const meta = T.THEMES.find(function (t) { return t.id === current; });
    const row = $("decor-row");
    if (row) row.style.display = meta && meta.crt ? "" : "none";
  }

  T.THEMES.forEach(function (t) {
    const s = document.createElement("button");
    s.className = "theme-swatch";
    s.dataset.theme = t.id;
    s.title = t.name;
    // Each swatch previews its own theme by carrying the attribute itself.
    s.setAttribute("data-theme", t.id);
    s.innerHTML = '<span class="theme-swatch-chip"></span><span class="theme-swatch-name">' + t.name + "</span>";
    s.onclick = function () { apply(t.id); };
    grid.appendChild(s);
  });

  const decor = $("theme-decor");
  if (decor) {
    decor.checked = saved(T.DECOR_KEY, "on") !== "off";
    decor.onchange = function () {
      document.documentElement.setAttribute("data-decor", decor.checked ? "on" : "off");
      try { localStorage.setItem(T.DECOR_KEY, decor.checked ? "on" : "off"); } catch (e) {}
    };
  }

  apply(current);
})();
```

- [ ] **Step 4: Style the panel**

Append to `desktop/styles.css`. Tokens only — the lint from Task 1 fails otherwise:

```css
#settings-view{display:flex;gap:var(--sp-5);flex:1;min-height:0;}
#settings-nav{width:150px;flex:none;display:flex;flex-direction:column;gap:2px;}
.settings-tab{background:none;border:none;border-left:2px solid transparent;color:var(--dim);
  text-align:left;padding:var(--sp-3) var(--sp-4);font-size:12px;cursor:pointer;transition:var(--dur-fast);}
.settings-tab:hover{color:var(--txt);background:var(--surface-raised);}
.settings-tab.active{color:var(--txt);border-left-color:var(--txt);background:var(--surface-raised);}
#settings-body{flex:1;border:1px solid var(--line);border-radius:var(--r-lg);background:var(--panel);
  padding:var(--sp-6);overflow-y:auto;}
.settings-section{display:none;flex-direction:column;gap:var(--sp-3);max-width:460px;}
.settings-section.active{display:flex;}
.settings-row{display:flex;align-items:center;gap:var(--sp-2);}
.settings-row input[type="checkbox"]{width:auto;flex:none;accent-color:var(--txt);}
.settings-row label{font-size:11px;color:var(--dim);cursor:pointer;}

#theme-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(132px,1fr));gap:var(--sp-3);}
.theme-swatch{display:flex;align-items:center;gap:var(--sp-3);padding:var(--sp-3);cursor:pointer;
  background:var(--panel);border:1px solid var(--line);border-radius:var(--r-md);transition:var(--dur-fast);}
.theme-swatch:hover{border-color:var(--line-strong);}
.theme-swatch.active{border-color:var(--txt);}
/* The chip previews the theme it selects: the swatch carries its own
   data-theme, so these tokens resolve to that theme's palette, not the
   current one. */
.theme-swatch-chip{width:26px;height:18px;flex:none;border-radius:var(--r-sm);
  background:var(--bg);border:1px solid var(--line-strong);}
.theme-swatch-name{font-size:11px;color:var(--dim);text-align:left;}
.theme-swatch.active .theme-swatch-name{color:var(--txt);}
```

- [ ] **Step 5: Verify**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs && node --check desktop/renderer.js`
Expected: PASS, same count as after Task 3. The lint catches any literal introduced above.

Run: `npm start` and check, in order:
1. `06 Settings` appears in the nav and opens.
2. All four sections switch.
3. Each theme swatch previews its own palette, not the current one.
4. Clicking a swatch changes the app immediately; restarting keeps it.
5. The Scanlines toggle appears only on CRT themes.
6. **The provider picker, Sign in, provider controls, autonomy selector and Show Browser all still work** — they moved, they were not rewritten.

- [ ] **Step 6: Commit**

```bash
git add desktop/index.html desktop/renderer.js desktop/styles.css
git commit -m "Give settings its own panel and a theme picker"
```

---

### Task 5: The logo

**Files:**
- Create: `build/icon.svg`
- Modify: `desktop/index.html` (rail header, About section)
- Test: `local-agent/test/run-tests.cjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `build/icon.svg`, a 32×32 monochrome mark. Sub-project 8 generates `.ico` and `.png` from it.

- [ ] **Step 1: Write the failing test**

Add to `local-agent/test/run-tests.cjs`, above `function testEntrypoint()`:

```javascript
function testLogo() {
  section("logo");
  const svg = fs.readFileSync(path.join(__dirname, "..", "..", "build", "icon.svg"), "utf8");

  // Sub-project 8 rasterises this into .ico and .png. A known viewBox is what
  // makes those sizes land on whole pixels.
  check("the viewBox is 32x32", /viewBox=["']0 0 32 32["']/.test(svg), svg.slice(0, 120));
  check("it is an svg element", /<svg[\s>]/.test(svg));
  check("it draws something", /<path[\s>]/.test(svg));
  // currentColor is what lets one file serve nine themes and an installer icon.
  check("it inherits its colour", svg.indexOf("currentColor") !== -1);
  check("no raster is embedded", svg.indexOf("data:image") === -1);
}
```

Register it in `main()`:

```javascript
  testTheme();
  testLogo();
  testToolchain();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs`
Expected: FAIL — `ENOENT ... build/icon.svg`

- [ ] **Step 3: Draw the mark**

Create `build/icon.svg`. Two brackets facing inward — closing. Coordinates sit on whole pixels of the 32-unit grid so the shape stays crisp when rasterised to 16 and 32:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none"
     stroke="currentColor" stroke-width="2.8" stroke-linecap="square">
  <path d="M7 6 H13 V26 H7"/>
  <path d="M25 6 H19 V26 H25"/>
</svg>
```

- [ ] **Step 4: Put it in the rail and the About section**

In `desktop/index.html`, replace the wordmark:

```html
<div id="wordmark">
  <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="square" aria-hidden="true">
    <path d="M7 6 H13 V26 H7"/><path d="M25 6 H19 V26 H25"/>
  </svg>
  <span>Close<span>NI</span></span>
</div>
```

And fill the About section:

```html
<div id="about-body">
  <div class="about-mark">
    <svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="square" aria-hidden="true">
      <path d="M7 6 H13 V26 H7"/><path d="M25 6 H19 V26 H25"/>
    </svg>
    <div>
      <div class="about-name">CloseNI</div>
      <div class="hint">Drives web AI chats to plan and build software.</div>
    </div>
  </div>
</div>
```

Add the styling to `desktop/styles.css`:

```css
#wordmark{display:flex;align-items:center;gap:var(--sp-3);font-size:15px;letter-spacing:.08em;margin-bottom:28px;}
#wordmark svg{width:17px;height:17px;flex:none;color:var(--txt);}
#wordmark span span{color:var(--mut);}
.about-mark{display:flex;align-items:center;gap:var(--sp-5);}
.about-mark svg{width:52px;height:52px;flex:none;color:var(--txt);}
.about-name{font-size:16px;letter-spacing:.08em;color:var(--txt);margin-bottom:var(--sp-1);}
```

The existing `#wordmark` rule is replaced, not duplicated — delete the old one at `styles.css:12-13`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs`
Expected: PASS, count up by 5.

Run: `npm start` and confirm the mark sits beside the wordmark, and that it changes colour with the theme — it inherits `currentColor`, so Paper should show a dark mark.

- [ ] **Step 6: Commit**

```bash
git add build/icon.svg desktop/index.html desktop/styles.css local-agent/test/run-tests.cjs
git commit -m "Add the CloseNI mark"
```

---

### Task 6: Language marks

**Files:**
- Create: `desktop/language-mark.js`
- Modify: `desktop/index.html` (script tag), `desktop/builder.js` (file cards), `desktop/renderer.js` (test rows), `desktop/styles.css`
- Test: `local-agent/test/run-tests.cjs`

**Interfaces:**
- Consumes: `--lang-*` tokens from Task 1.
- Produces: `languageMark(path: string) -> { label: string, token: string }`

- [ ] **Step 1: Write the failing test**

Add to `local-agent/test/run-tests.cjs`, above `function testEntrypoint()`:

```javascript
function testLanguageMark() {
  section("language marks");
  const { languageMark } = require(path.join(__dirname, "..", "..", "desktop", "language-mark.js"));

  check("python", languageMark("handlers.py").label === "py");
  check("python uses its own token", languageMark("handlers.py").token === "--lang-py");
  check("rust", languageMark("src/main.rs").token === "--lang-rs");
  check("javascript", languageMark("index.js").token === "--lang-js");
  check("java", languageMark("App.java").token === "--lang-java");
  check("c", languageMark("main.c").token === "--lang-c");
  check("c++ shares the c accent", languageMark("app.cpp").token === "--lang-c");
  check("headers share it too", languageMark("util.h").token === "--lang-c");

  // The label is the extension, so a family shares a colour but keeps its name.
  check("the label is the extension", languageMark("app.cpp").label === "cpp");
  check("uppercase is normalised", languageMark("MAIN.PY").label === "py");

  // Anything unrecognised still gets a mark, so rows do not change width.
  check("an unknown extension falls back", languageMark("notes.txt").token === "--lang-default");
  check("and keeps its extension as the label", languageMark("notes.txt").label === "txt");
  check("no extension falls back", languageMark("Makefile").token === "--lang-default");
  check("a file with no extension is labelled", languageMark("Makefile").label === "—");
  check("a dotfile is not read as an extension", languageMark(".gitignore").label === "—");
  check("a windows path works", languageMark("src\\\\main.rs").token === "--lang-rs");
  check("a long extension is truncated", languageMark("a.mjsonschema").label.length <= 4);
}
```

Register it in `main()`:

```javascript
  testLogo();
  testLanguageMark();
  testToolchain();
```

- [ ] **Step 2: Run test to verify it fails**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs`
Expected: FAIL — `Cannot find module '.../desktop/language-mark.js'`

- [ ] **Step 3: Write the implementation**

Create `desktop/language-mark.js`:

```javascript
/*
 * A file's language, as a label and a colour token.
 *
 * Drawn rather than bundled: real language logos are trademarked brand assets,
 * and item 10 already made this call for provider logos. The extension in an
 * accent colour says the same thing and ships nothing.
 *
 * Loaded as a plain <script> in the renderer (window.CNLang) and require()d by
 * the test harness (module.exports). There is no bundler, so no import/export.
 */
(function (root) {
  // Families share an accent; the label keeps the real extension, so .cpp and
  // .c look related without looking identical.
  var FAMILIES = {
    "--lang-py": ["py", "pyw"],
    "--lang-rs": ["rs"],
    "--lang-js": ["js", "cjs", "mjs", "jsx", "ts", "tsx"],
    "--lang-java": ["java"],
    "--lang-c": ["c", "h", "cpp", "cc", "hpp", "cxx"],
  };

  var BY_EXT = {};
  Object.keys(FAMILIES).forEach(function (token) {
    FAMILIES[token].forEach(function (ext) { BY_EXT[ext] = token; });
  });

  function languageMark(filePath) {
    var name = String(filePath || "").replace(/\\/g, "/").split("/").pop() || "";
    var dot = name.lastIndexOf(".");
    // dot === 0 is a dotfile, not an extension: .gitignore is not a "gitignore"
    // file, and labelling it as one would be wrong on every row.
    var ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
    if (!ext) return { label: "—", token: "--lang-default" };
    return {
      label: ext.length > 4 ? ext.slice(0, 4) : ext,
      token: BY_EXT[ext] || "--lang-default",
    };
  }

  var api = { languageMark: languageMark };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CNLang = api;
})(typeof window !== "undefined" ? window : globalThis);
```

- [ ] **Step 4: Load it and style it**

In `desktop/index.html`, beside the other UMD modules:

```html
<script src="theme.js"></script>
<script src="language-mark.js"></script>
```

In `desktop/styles.css`:

```css
.lang-mark{font-family:ui-monospace,Consolas,monospace;font-size:9px;line-height:1;
  padding:3px 5px;border-radius:var(--r-sm);flex:none;
  color:var(--lang-default);border:1px solid currentColor;opacity:.85;}
```

Each mark sets its own colour inline from the token, which is the one place an
inline style is right: the value is data, not styling.

- [ ] **Step 5: Use it on file cards**

In `desktop/builder.js`, find where `.file-card-head` is built and its `.file-path` span created. Insert the mark before the path:

```javascript
  const mark = window.CNLang ? window.CNLang.languageMark(change.filePath) : null;
  if (mark) {
    const m = document.createElement("span");
    m.className = "lang-mark";
    m.textContent = mark.label;
    m.style.color = "var(" + mark.token + ")";
    head.appendChild(m);
  }
```

Match the surrounding code's variable names for the head element and the change
object — read the function before editing rather than assuming them.

- [ ] **Step 6: Run tests to verify they pass**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs && node --check desktop/language-mark.js && node --check desktop/builder.js`
Expected: PASS, count up by 17.

Run: `npm start`, load a plan and build a step. Expected: each file card shows its extension chip in an accent colour, and the colours change with the theme.

- [ ] **Step 7: Commit**

```bash
git add desktop/language-mark.js desktop/index.html desktop/builder.js desktop/styles.css local-agent/test/run-tests.cjs
git commit -m "Mark each file with its language"
```

---

### Task 7: State colour, focus, texture and elevation

**Files:**
- Modify: `desktop/styles.css`

**Interfaces:**
- Consumes: every token from Tasks 1 and 3.
- Produces: no exports.

- [ ] **Step 1: Give status chips their state colour**

Replace **both** copies of the `.step-card-status` rules — they are currently duplicated at roughly lines 105-107 and 171-174 — with one set:

```css
.step-card-status{font-size:9px;letter-spacing:.1em;text-transform:uppercase;padding:2px 6px;
  border:1px solid var(--line-strong);border-radius:var(--r-sm);color:var(--mut);}
.step-card-status.running{color:var(--warn);background:var(--warn-bg);border-color:var(--warn-line);}
.step-card-status.done{color:var(--ok);background:var(--ok-bg);border-color:var(--ok-line);}
.step-card-status.failed{color:var(--err);background:var(--err-bg);border-color:var(--err-line);}
.step-card-status.skipped{color:var(--mut);border-style:dashed;}
```

The `animation:pulse 1.4s infinite` on `.running` goes, along with the
`@keyframes pulse` block — the amber now says "running" without moving. Delete
both.

- [ ] **Step 2: Add focus rings**

There is currently no `:focus-visible` rule anywhere, so keyboard navigation is
invisible. Add near the `.btn` rules:

```css
/* Two layers so the ring reads against any theme: a gap in the page colour,
   then the ring itself. :focus-visible rather than :focus so a mouse click
   does not leave a ring behind. */
.btn:focus-visible,.nav-btn:focus-visible,.settings-tab:focus-visible,.theme-swatch:focus-visible,
input:focus-visible,textarea:focus-visible,select:focus-visible,.file-card-head:focus-visible{
  outline:none;box-shadow:0 0 0 2px var(--bg),0 0 0 4px var(--line-focus);}
```

- [ ] **Step 3: Add the texture layer**

One element, one rule. Themes without decoration set `--overlay-texture:none`
and nothing happens:

```css
/* Static decoration - it never moves. Live animation was built, reviewed and
   rejected. */
#app::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:1;
  background-image:var(--overlay-texture);background-size:14px 14px;}
[data-decor="off"] #app::before{background-image:none;}
```

`background-size` only affects Blueprint's grid; the scanline gradients ignore
it because they repeat on their own axis.

Glow follows the same shape — one rule, driven by a token:

```css
.step-card.active .step-card-title,#status-line,#builder-status{text-shadow:var(--glow);}
[data-decor="off"] .step-card.active .step-card-title,
[data-decor="off"] #status-line,
[data-decor="off"] #builder-status{text-shadow:none;}
```

- [ ] **Step 4: Add elevation and reduced motion**

Depth by layering, in place of the literal 3D item 19 asked for:

```css
#approval-modal{backdrop-filter:blur(3px);}
#approval-card{box-shadow:var(--shadow-2);}
.toast{box-shadow:var(--shadow-1);}

/* The two animations that remain both carry meaning - progress advancing, and
   a toast arriving. Neither should move for anyone who asked it not to. */
@media (prefers-reduced-motion: reduce){
  *,*::before,*::after{animation-duration:.001ms !important;animation-iteration-count:1 !important;
    transition-duration:.001ms !important;}
}
```

- [ ] **Step 5: Verify**

Run: `source scripts/wsl-env.sh && node local-agent/test/run-tests.cjs`
Expected: PASS. The lint catches any literal introduced above.

Run: `npm start` and check:
1. A running step is amber, a done step green, a failed step red — distinguishable at a glance.
2. Tab through the sidebar: every control shows a ring.
3. Phosphor and Amber show scanlines; Cassette · Grid and Blueprint do not show scanlines but Blueprint shows a grid; the Scanlines toggle removes them.
4. The permission modal blurs what is behind it.
5. Nothing anywhere is moving.

- [ ] **Step 6: Commit**

```bash
git add desktop/styles.css
git commit -m "Give state its own colour, focus its own ring, depth its own layer"
```

---

### Task 8: Cleanup, docs and merge

**Files:**
- Modify: `desktop/index.html` (inline styles), `desktop/styles.css` (duplicates), `docs/ROADMAP.md`

- [ ] **Step 1: Remove the inline styles**

`desktop/index.html` carries 14 `style=` attributes. Replace each with a class in
`styles.css`. Most are spacing; they become the existing tokens:

```css
.stack{display:flex;flex-direction:column;gap:var(--sp-2);}
.mt-1{margin-top:var(--sp-3);} .mt-2{margin-top:var(--sp-4);} .mt-3{margin-top:var(--sp-5);}
.btn-block{width:100%;}
.btn-sm{font-size:10px;padding:var(--sp-1) var(--sp-3);}
```

Verify none remain, ignoring the theme swatch chips which set a token value
rather than a style:

Run: `grep -c 'style="' desktop/index.html`
Expected: `0`

- [ ] **Step 2: Remove the duplicated rules**

`#provider-select` and `#autonomy-select` each re-declare what
`input,textarea,select` already provides. Delete both rules; the shared one
covers them. `.step-card-status.done` and `.failed` were deduplicated in Task 7 —
confirm only one copy of each survives:

Run: `grep -c 'step-card-status.done' desktop/styles.css`
Expected: `1`

- [ ] **Step 3: Update the roadmap**

Replace the sub-project 7 section of `docs/ROADMAP.md`:

```markdown
## 7 · Visual identity & polish — DONE

Roadmap items 19, 20, 21, 26, 27. Spec: `specs/2026-08-10-visual-identity-design.md`,
plan: `plans/2026-08-10-visual-identity.md`

- **19. UI refresh** — `done`, reinterpreted. 3D was rejected in favour of
  layered elevation and a backdrop blur: literal 3D costs GPU and startup time
  and fights a flat terminal aesthetic. Live animation was built, reviewed and
  rejected too — decoration is static, and the only animations left are the
  progress bar and the toast, both behind `prefers-reduced-motion`.
- **20. Programming-language logos** — `done` as drawn marks. The extension in a
  per-language accent colour; no trademarked asset is reproduced or vendored,
  matching the call item 10 made for provider logos.
- **21. Detailed settings page** — `done`. `06 Settings` with Provider,
  Permissions, Appearance and About sections. The provider controls, autonomy
  policy and Show Browser moved out of the rail keeping their ids and their
  storage keys, so nothing was rewritten.
- **26. Beautiful, detailed UI** — `done`, made finite. 47 colour literals became
  32 tokens; nine themes; focus rings where there were none; reduced-motion
  support; state carried by colour; six duplicated rules and 14 inline styles
  removed.
- **27. Logo** — `done`. Two inward-facing brackets — closing. One 32×32 SVG in
  `currentColor`, serving the rail, the About section and, for sub-project 8,
  the installer icon.

**Themes style CloseNI's chrome and never the projects built with it.** Token
completeness is enforced by a lint that fails on any colour literal outside a
theme block, because a theme reaches exactly as far as the tokens do and a
single stray hex fails silently.
```

Update the header count on line 3 to **6 of 9 complete** and add `7 · Visual identity & polish` to the list.

- [ ] **Step 4: Run the full suite**

```bash
source scripts/wsl-env.sh && npx tsc -p local-agent/tsconfig.json \
  && node local-agent/test/run-tests.cjs \
  && node local-agent/test/run-e2e.cjs > /tmp/e2e.log 2>&1; tail -3 /tmp/e2e.log
```

Expected: both PASS. The e2e suite does not touch the renderer, so its count is
unchanged.

- [ ] **Step 5: Walk every theme once more**

Run: `npm start`. For each of the nine, check the Builder with a loaded plan, the
Test panel with results, the diff view with an expanded file card, and the
permission modal. Paper and High contrast are where an un-tokenised colour
shows; the diff view is where it hides longest, since it needs a file card
expanded to be seen at all.

- [ ] **Step 6: Commit and merge**

```bash
git add -A
git commit -m "Record visual identity as done"
git checkout main && git merge --no-ff visual-identity -m "Merge visual identity: items 19, 20, 21, 26, 27"
git push origin main
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Token groups (surface, line, text, state, lang, space, radius, elevation, motion) | 1 |
| Token completeness enforced by a test | 1 |
| `--line2` → `--line-strong` rename | 1 |
| Theme engine, `data-theme`, no flash of wrong theme | 2 |
| `resolveTheme` fallback for a removed theme | 2 |
| The nine themes | 3 |
| Every theme defines every palette token | 3 |
| CRT tokens `--overlay-texture` and `--glow` | 3 (declared), 7 (applied) |
| Decoration static, no motion added | 3, 7 |
| Settings as sixth panel, four sections | 4 |
| Moved controls keep ids and storage keys | 4 |
| Logo `][`, 32×32, `currentColor` | 5 |
| Logo as `build/icon.svg` for sub-project 8 | 5 |
| `languageMark(path)`, unknown extensions fall back | 6 |
| Marks on file cards | 6 |
| State colour on status chips | 7 |
| `:focus-visible` on every control | 7 |
| `prefers-reduced-motion` | 7 |
| Elevation and backdrop blur instead of 3D | 7 |
| Duplicated rules and inline styles removed | 8 |
| Themes never touch generated projects | Global Constraints; nothing in any task writes to a workspace |

**Gap found and closed:** the spec lists language marks on *both* Builder file
cards and the Test panel's result rows. Task 6 Step 5 covers file cards only.
Test-row marks are deliberately dropped: a test row's text is a *command*
(`gcc -fsyntax-only "main.c"`), not a file path, so `languageMark` has nothing
correct to read. Recorded here rather than silently skipped — if it is wanted, it
needs the check's `language` field, which `planChecks` already returns.

**Type consistency:** `languageMark`, `resolveTheme`, `THEMES`, `THEME_KEY`,
`DECOR_KEY`, `colorLiteralsOutsideThemes`, `themeBlocks` and `STRUCTURAL_PREFIXES`
are used with the same names and shapes throughout. Theme ids match between
`theme.js` (Task 2) and the CSS blocks (Task 3); the `crt` flag count in the Task
2 test must match the number of themes given a non-`none` `--overlay-texture` in
Task 3 — currently four: phosphor, amber, cassette-indigo, cassette-miami.

**Known risk:** appearance has no automated coverage beyond the lint. Tasks 4, 5,
6, 7 and 8 each end with an explicit manual check list for that reason, and Task
8 Step 5 walks all nine themes across the four screens where an un-tokenised
colour could still be hiding.
