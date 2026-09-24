#!/usr/bin/env node
/*
 * Every language check, run for real against a real toolchain.
 *
 *   node scripts/languages.mjs            # every language whose tools exist
 *   node scripts/languages.mjs rust go    # only these
 *
 * The unit suite proves planChecks picks the right command. It cannot prove the
 * command works: that `gofmt -e` exits non-zero on a syntax error, that
 * `javac -d` finds a sibling class, that `tsc` without a tsconfig can see node's
 * types. Six of the twelve languages had never been run at all when this was
 * written, because the machine they were built on had none of the compilers.
 *
 * Each case is a small workspace written to a temp directory, checked through
 * the same planChecksForWorkspace + runCommand pair a build uses. A case asks
 * two things:
 *
 *   good code   every check passes      (a false failure burns repair attempts
 *                                        on code that was never broken)
 *   bad code    at least one check fails (a false pass reports success on code
 *                                        nobody compiled)
 *
 * A missing tool prints SKIP, never ok: a skipped language has verified nothing.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const D = join(ROOT, 'local-agent', 'dist');

const { planChecksForWorkspace } = require(join(D, 'verification/check-planner.js'));
const { runCommand } = require(join(D, 'verification/command-runner.js'));
const { resolveTool } = require(join(D, 'verification/toolchain.js'));

const only = process.argv.slice(2);
let pass = 0, fail = 0, skip = 0;
const failures = [];

/** Directories a project-level build legitimately owns. Anything else a check
 *  leaves in the workspace is the check modifying what it inspects. */
const BUILD_DIRS = new Set(['target', 'build', '.gradle', 'node_modules', 'obj', 'bin']);
/** Files a toolchain writes that belong in the project: cargo records the
 *  versions it resolved, and a binary crate is meant to commit that. */
const PROJECT_FILES = new Set(['Cargo.lock']);

function listFiles(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (BUILD_DIRS.has(name) || PROJECT_FILES.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) listFiles(full, base, out);
    else out.push(relative(base, full).replace(/\\/g, '/'));
  }
  return out.sort();
}

function writeTree(files) {
  const ws = mkdtempSync(join(tmpdir(), 'closeni-lang-'));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(ws, p)), { recursive: true });
    writeFileSync(join(ws, p), body);
  }
  return ws;
}

/**
 * Run one workspace through the planner and every check it returns.
 * `changed` defaults to every file written, which is what step 1 of a build
 * looks like.
 */
async function check(files, changed) {
  const ws = writeTree(files);
  const before = listFiles(ws);
  const checks = planChecksForWorkspace(ws, changed || Object.keys(files));
  const results = [];
  for (const c of checks) {
    const r = await runCommand(c.command, ws, c.timeoutMs, { timeoutIsFailure: true });
    results.push({ command: c.command, scope: c.scope, kind: c.kind, success: r.success, output: r.output });
  }
  const after = listFiles(ws);
  const left = after.filter((f) => !before.includes(f));
  rmSync(ws, { recursive: true, force: true });
  return { checks, results, left };
}

function brief(r) {
  return r.results.map((x) => (x.success ? 'pass ' : 'FAIL ') + x.command.replace(/\s+"?\/tmp\/[^ "]*"?/g, ' <tmp>') +
    (x.success ? '' : '\n              ' + x.output.split('\n').slice(0, 3).join('\n              '))).join('\n            ');
}

function record(label, cond, detail) {
  if (cond) { pass++; console.log('     ok   ' + label); }
  else {
    fail++;
    failures.push(label);
    console.log('    FAIL  ' + label + (detail ? '\n            ' + detail : ''));
  }
}

/**
 * A language case: tools that must exist, a good tree, a bad tree, and what
 * the planner is expected to choose (`scope`), so a case cannot pass by
 * accidentally running nothing.
 */
async function language(name, { tools, good, bad, scope, changed, note }) {
  if (only.length && !only.some((o) => name.toLowerCase().includes(o.toLowerCase()))) return;
  console.log('\n  ' + name + (note ? '  (' + note + ')' : ''));
  const missing = tools.filter((t) => !resolveTool(t));
  if (missing.length) {
    skip++;
    console.log('     SKIP  no ' + missing.join(', ') + ' on this machine - nothing verified');
    return;
  }

  const g = await check(good, changed);
  record('good code: a check was planned', g.checks.length > 0, 'planner returned nothing');
  if (scope) record('good code: checked as ' + scope, g.checks.some((c) => c.scope === scope), g.checks.map((c) => c.scope).join(','));
  record('good code: every check passes', g.results.length > 0 && g.results.every((x) => x.success), brief(g));
  record('good code: nothing left in the workspace', g.left.length === 0, g.left.join(', '));

  if (bad) {
    const b = await check(bad, changed);
    record('bad code: a check fails', b.results.some((x) => !x.success), brief(b));
    record('bad code: nothing left in the workspace', b.left.length === 0, b.left.join(', '));
  }
}

// --------------------------------------------------------------- per file --

await language('Python', {
  tools: ['python'],
  good: {
    'app/util.py': 'def add(a: int, b: int) -> int:\n    return a + b\n',
    'app/main.py': 'from app.util import add\n\nprint(add(1, 2))\n',
    'app/__init__.py': '',
  },
  bad: { 'main.py': 'def broken(:\n    pass\n' },
  scope: 'file',
});

await language('Python types (mypy)', {
  tools: ['python', 'mypy'],
  good: {
    'util.py': 'def add(a: int, b: int) -> int:\n    return a + b\n',
    'main.py': 'import flask  # a missing stub must not fail the step\nfrom util import add\n\nx: int = add(1, 2)\n',
  },
  // Parses, compiles, and is wrong - the case py_compile alone cannot see.
  bad: { 'main.py': 'def add(a: int, b: int) -> int:\n    return a + b\n\nx: int = add("1", 2)\n' },
  scope: 'file',
});

await language('JavaScript', {
  tools: ['node'],
  good: {
    'lib.js': 'module.exports = { add: (a, b) => a + b };\n',
    'main.mjs': 'import { readFileSync } from "node:fs";\nconsole.log(typeof readFileSync);\n',
  },
  bad: { 'main.js': 'function (\n' },
  scope: 'file',
});

await language('C', {
  tools: ['gcc'],
  good: {
    'util.h': '#ifndef UTIL_H\n#define UTIL_H\nint add(int a, int b);\n#endif\n',
    'util.c': '#include "util.h"\nint add(int a, int b) { return a + b; }\n',
    'main.c': '#include <stdio.h>\n#include "util.h"\nint main(void) { printf("%d\\n", add(1, 2)); return 0; }\n',
  },
  bad: { 'main.c': 'int main(void) { return 0 }\n' },
  scope: 'file',
});

await language('C++', {
  tools: ['gxx'],
  good: {
    'shape.hpp': '#pragma once\nstruct Shape { virtual ~Shape() = default; virtual double area() const = 0; };\n',
    'main.cpp': '#include <iostream>\n#include "shape.hpp"\nstruct Sq : Shape { double s = 2; double area() const override { return s * s; } };\nint main() { Sq q; std::cout << q.area() << "\\n"; }\n',
  },
  bad: { 'main.cpp': '#include <vector>\nint main() { std::vector<int> v; v.push_back("x"); }\n' },
  scope: 'file',
});

await language('Rust, loose file', {
  tools: ['rustc'],
  good: { 'main.rs': 'fn main() {\n    let v: Vec<u32> = (1..4).collect();\n    println!("{}", v.iter().sum::<u32>());\n}\n' },
  bad: { 'main.rs': 'fn main() {\n    let x: u32 = "no";\n}\n' },
  scope: 'file',
});

await language('Java, loose files in the default package', {
  tools: ['javac'],
  good: {
    'Helper.java': 'public class Helper { static int twice(int n) { return n * 2; } }\n',
    'Main.java': 'public class Main { public static void main(String[] a) { System.out.println(Helper.twice(21)); } }\n',
  },
  bad: { 'Main.java': 'public class Main { public static void main(String[] a) { int x = "s"; } }\n' },
  scope: 'file',
});

await language('Java, loose files in packages', {
  tools: ['javac'],
  note: 'a sibling class in another package, no build file',
  good: {
    'src/com/example/util/Helper.java': 'package com.example.util;\npublic class Helper { public static int twice(int n) { return n * 2; } }\n',
    'src/com/example/Main.java': 'package com.example;\nimport com.example.util.Helper;\npublic class Main { public static void main(String[] a) { System.out.println(Helper.twice(21)); } }\n',
  },
  bad: {
    'src/com/example/Main.java': 'package com.example;\nimport com.example.util.Missing;\npublic class Main { public static void main(String[] a) { } }\n',
  },
  scope: 'file',
});

await language('Go, loose file', {
  tools: ['gofmt'],
  good: { 'main.go': 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println(1 + 2)\n}\n' },
  bad: { 'main.go': 'package main\n\nfunc main() {\n\tfmt.Println(\n}\n' },
  scope: 'file',
});

await language('TypeScript, loose files', {
  tools: ['tsc'],
  good: {
    'util.ts': 'export function add(a: number, b: number): number { return a + b; }\n',
    'main.ts': 'import { add } from "./util";\nconst n: number = add(1, 2);\nconsole.log(n);\n',
  },
  bad: { 'main.ts': 'const n: number = "three";\nexport {};\n' },
  scope: 'file',
});

await language('Ruby', {
  tools: ['ruby'],
  good: { 'app.rb': 'class Greeter\n  def hi(name) = "hi #{name}"\nend\nputs Greeter.new.hi("x")\n' },
  bad: { 'app.rb': 'def broken(\n  puts 1\n' },
  scope: 'file',
});

await language('PHP', {
  tools: ['php'],
  good: { 'index.php': '<?php\nfunction add(int $a, int $b): int { return $a + $b; }\necho add(1, 2), PHP_EOL;\n' },
  bad: { 'index.php': '<?php\nfunction add( { return 1; }\n' },
  scope: 'file',
});

await language('Shell', {
  tools: ['bash'],
  good: { 'run.d/start.sh': '#!/usr/bin/env bash\nset -euo pipefail\nfor f in *; do echo "$f"; done\n' },
  bad: { 'run.d/start.sh': '#!/usr/bin/env bash\nif [ -f x ]; then\n  echo x\n' },
  scope: 'file',
});

// ---------------------------------------------------------------- projects --

await language('Rust, Cargo project', {
  tools: ['cargo'],
  note: 'a module the crate root declares - fails as a loose file',
  good: {
    'Cargo.toml': '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n',
    'src/main.rs': 'mod utils;\n\nfn main() {\n    println!("{}", utils::twice(21));\n}\n',
    'src/utils.rs': 'pub fn twice(n: u32) -> u32 {\n    n * 2\n}\n',
  },
  bad: {
    'Cargo.toml': '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n',
    'src/main.rs': 'mod utils;\n\nfn main() {\n    let s: String = utils::twice(21);\n}\n',
    'src/utils.rs': 'pub fn twice(n: u32) -> u32 {\n    n * 2\n}\n',
  },
  scope: 'project',
});

const POM = `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId>
  <artifactId>demo</artifactId>
  <version>1.0</version>
  <properties>
    <maven.compiler.release>17</maven.compiler.release>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>
</project>
`;
const JAVA_PKG = {
  'src/main/java/com/example/util/Helper.java': 'package com.example.util;\npublic class Helper { public static int twice(int n) { return n * 2; } }\n',
  'src/main/java/com/example/Main.java': 'package com.example;\nimport com.example.util.Helper;\npublic class Main { public static void main(String[] a) { System.out.println(Helper.twice(21)); } }\n',
};
const JAVA_BAD = {
  'src/main/java/com/example/Main.java': 'package com.example;\npublic class Main { public static void main(String[] a) { int x = "s"; } }\n',
};

await language('Java, Maven project', {
  tools: ['mvn'],
  good: { 'pom.xml': POM, ...JAVA_PKG },
  bad: { 'pom.xml': POM, ...JAVA_BAD },
  scope: 'project',
});

await language('Java, Gradle project', {
  tools: ['gradle'],
  good: { 'build.gradle': "plugins { id 'java' }\n", 'settings.gradle': "rootProject.name = 'demo'\n", ...JAVA_PKG },
  bad: { 'build.gradle': "plugins { id 'java' }\n", 'settings.gradle': "rootProject.name = 'demo'\n", ...JAVA_BAD },
  scope: 'project',
});

await language('Go module', {
  tools: ['go'],
  note: 'a type error gofmt cannot see',
  good: {
    'go.mod': 'module example.com/demo\n\ngo 1.21\n',
    'main.go': 'package main\n\nimport (\n\t"fmt"\n\n\t"example.com/demo/util"\n)\n\nfunc main() {\n\tfmt.Println(util.Twice(21))\n}\n',
    'util/util.go': 'package util\n\nfunc Twice(n int) int { return n * 2 }\n',
  },
  bad: {
    'go.mod': 'module example.com/demo\n\ngo 1.21\n',
    'main.go': 'package main\n\nfunc main() {\n\tvar s string = 42\n\t_ = s\n}\n',
  },
  scope: 'project',
});

await language('TypeScript project', {
  tools: ['tsc'],
  good: {
    'tsconfig.json': '{ "compilerOptions": { "strict": true, "target": "ES2020", "module": "commonjs", "outDir": "dist" }, "include": ["src"] }\n',
    'src/util.ts': 'export function add(a: number, b: number): number { return a + b; }\n',
    'src/main.ts': 'import { add } from "./util";\nconst n: number = add(1, 2);\nconsole.log(n);\n',
  },
  bad: {
    'tsconfig.json': '{ "compilerOptions": { "strict": true, "target": "ES2020", "module": "commonjs" }, "include": ["src"] }\n',
    'src/main.ts': 'function f(x) { return x; }\nexport default f;\n',
  },
  scope: 'project',
});

await language('C, Makefile project', {
  tools: ['make'],
  good: {
    'Makefile': 'CC ?= gcc\n\napp: main.c\n\t$(CC) -o app main.c\n',
    'main.c': 'int main(void) { return 0; }\n',
  },
  // make -n proves the Makefile parses and its targets resolve; it compiles
  // nothing, so broken C under a Makefile is not caught. A missing rule is.
  bad: {
    'Makefile': 'app: main.o missing.o\n\t$(CC) -o app main.o missing.o\n',
    'main.c': 'int main(void) { return 0; }\n',
  },
  scope: 'project',
});

// ---------------------------------------------------------------------------
console.log('\n' + '-'.repeat(78));
console.log('  ' + (fail ? 'FAIL' : 'PASS') + ' - ' + pass + ' passed, ' + fail + ' failed, ' + skip + ' language(s) skipped');
if (failures.length) {
  console.log('\n  Failures:');
  for (const f of failures) console.log('    · ' + f);
}
console.log('-'.repeat(78));
process.exit(fail ? 1 : 0);
