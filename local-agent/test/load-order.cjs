/*
 * Checks that the renderer's scripts can load in the order index.html gives.
 *
 * They are classic scripts sharing one global scope, so a function in a later
 * file does not exist while an earlier one runs. A call across that line works
 * in every test that loads the page whole, and fails only when an async start
 * resumes between two script loads - at launch, now and then. So this is a
 * test rather than a convention.
 *
 * Followed: top-level statements, IIFEs, and callbacks handed to IPC listeners
 * or promises, then every top-level function they name, transitively. Not
 * followed: click and change handlers (on* assignments, addEventListener),
 * since nothing is clicked while the page loads, and anything behind typeof.
 */
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

function isHandlerAssignment(node) {
  const p = node.parent;
  return ts.isBinaryExpression(p) && p.right === node && p.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    ts.isPropertyAccessExpression(p.left) && /^on[a-z]+$/.test(p.left.name.text);
}

function isHandler(fn) {
  if (isHandlerAssignment(fn)) return true;
  const p = fn.parent;
  return ts.isCallExpression(p) && ts.isPropertyAccessExpression(p.expression) &&
    p.expression.name.text === "addEventListener";
}

/**
 * Every name that code able to run during load reaches in a later script.
 *
 * @param {{name: string, source: string}[]} scripts in load order
 * @returns {string[]} "name (in later.js) via file.js:line > fn > ..."
 */
function forwardRefs(scripts) {
  const parsed = scripts.map((s) => ts.createSourceFile(s.name, s.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS));
  const declaredIn = new Map();
  const funcs = new Map();
  parsed.forEach((sf, i) => {
    sf.statements.forEach((st) => {
      if (ts.isFunctionDeclaration(st) && st.name) { declaredIn.set(st.name.text, i); funcs.set(st.name.text, st); }
      else if (ts.isVariableStatement(st)) {
        st.declarationList.declarations.forEach((d) => { if (ts.isIdentifier(d.name)) declaredIn.set(d.name.text, i); });
      } else if (ts.isClassDeclaration(st) && st.name) declaredIn.set(st.name.text, i);
    });
  });

  const found = [];
  parsed.forEach((sf, i) => {
    const followed = new Set();
    const seen = new Set();
    function visit(node, via) {
      // A top-level function runs only when something reaches it by name.
      if (ts.isFunctionDeclaration(node) && ts.isSourceFile(node.parent)) return;
      if ((ts.isFunctionExpression(node) || ts.isArrowFunction(node)) && isHandler(node)) return;
      if (ts.isTypeOfExpression(node)) return;
      if (ts.isPropertyAccessExpression(node)) { visit(node.expression, via); return; }
      if (ts.isPropertyAssignment(node)) { visit(node.initializer, via); return; }
      if (ts.isIdentifier(node)) {
        if (isHandlerAssignment(node)) return;
        const name = node.text;
        const at = declaredIn.get(name);
        if (at !== undefined && at > i) {
          const line = name + " (in " + scripts[at].name + ") via " + via;
          if (!seen.has(line)) { seen.add(line); found.push(line); }
        }
        if (funcs.has(name) && !followed.has(name)) {
          followed.add(name);
          const body = funcs.get(name).body;
          if (body) ts.forEachChild(body, (c) => visit(c, via + " > " + name));
        }
        return;
      }
      ts.forEachChild(node, (c) => visit(c, via));
    }
    sf.statements.forEach((st) => {
      visit(st, scripts[i].name + ":" + (sf.getLineAndCharacterOfPosition(st.getStart()).line + 1));
    });
  });
  return found;
}

/** The renderer's scripts, in the order index.html loads them. */
function rendererScripts(desktopDir) {
  const html = fs.readFileSync(path.join(desktopDir, "index.html"), "utf8");
  const names = [];
  const re = /<script src="(renderer\/[^"]+\.js)"><\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) names.push(m[1]);
  return names.map((n) => ({ name: n, source: fs.readFileSync(path.join(desktopDir, n), "utf8") }));
}

module.exports = { forwardRefs, rendererScripts };
