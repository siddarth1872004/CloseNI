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
