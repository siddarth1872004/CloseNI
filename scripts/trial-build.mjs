#!/usr/bin/env node
/*
 * Drive a whole, deliberately awkward project through the real agent and report
 * what survives.
 *
 *   node scripts/trial-build.mjs
 *
 * Not a test — nothing here asserts. It is a rehearsal: a ten-step build where
 * the model behaves the way models actually behave, run through the production
 * CLI against the mock provider, so the failures are the app's rather than a
 * unit test's idea of the app.
 *
 * Every reply below is a shape seen in a real run: clean JSON, code blocks
 * instead of JSON, prose wrapped around the answer, a reply cut off by the
 * completion wait, a file abbreviated with "rest unchanged", an absolute path,
 * and a step that answers with no files at all.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AGENT = join(ROOT, 'local-agent', 'dist', 'index.js');
const { createMockProvider } = require(join(ROOT, 'local-agent/test/mock-provider.cjs'));
const F = '```';

const PROVIDER_DIR = mkdtempSync(join(tmpdir(), 'closeni-trial-providers-'));
const { writeFileSync, mkdirSync } = await import('node:fs');

function writeProviderConfig(baseUrl, profileDir) {
  mkdirSync(PROVIDER_DIR, { recursive: true });
  writeFileSync(join(PROVIDER_DIR, 'mock.json'), JSON.stringify({
    id: 'mock', name: 'Mock Provider', baseUrl, enabled: false,
    selectors: { chatInput: '#input', sendButton: '#send', stopButton: '#nonexistent-stop', assistantMessage: '.assistant-msg' },
    completionRules: { waitForStopButtonDisappear: false, maxWaitMs: 30000 },
    profileDir,
  }, null, 2));
}

function runAgent(args, timeoutMs = 120000) {
  return new Promise((res) => {
    const proc = spawn(process.execPath, [AGENT].concat(args), {
      cwd: ROOT, env: { ...process.env, AGENT_PROVIDER_DIR: PROVIDER_DIR },
    });
    let out = '';
    proc.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('APPROVAL_REQUEST:') && !proc.__a) {
        proc.__a = true;
        proc.stdin.write(JSON.stringify({ approved: true }) + '\n');
      }
    });
    proc.stderr.on('data', (d) => (out += d.toString()));
    const t = setTimeout(() => proc.kill(), timeoutMs);
    proc.on('close', () => {
      clearTimeout(t);
      let result = null;
      const s = out.indexOf('AGENT_OUTPUT_START');
      const e = out.indexOf('AGENT_OUTPUT_END');
      if (s !== -1 && e !== -1) {
        const lines = out.substring(s + 18, e).split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{'));
        if (lines.length) { try { result = JSON.parse(lines[lines.length - 1]); } catch { /* leave null */ } }
      }
      res({ result, out });
    });
  });
}

/** The ten steps, and how the model chooses to answer each one. */
const STEPS = [
  {
    title: 'Project setup',
    why: 'clean JSON — the happy path',
    reply: F + 'json\n{"files":[' +
      '{"path":"requirements.txt","mode":"create","content":"flask==3.0.0\\n"},' +
      '{"path":"src/config.py","mode":"create","content":"DEBUG = True\\nDB_PATH = \'habits.db\'\\n"}' +
      ']}\n' + F,
    expect: ['requirements.txt', 'src/config.py'],
  },
  {
    title: 'Database models',
    why: 'code blocks instead of JSON, path in a comment',
    reply: 'Here is the model layer.\n\n' + F + 'python\n# src/models.py\nclass Habit:\n    def __init__(self, name):\n        self.name = name\n' + F + '\n\nThat covers it.',
    expect: ['src/models.py'],
  },
  {
    title: 'Storage layer',
    why: 'code block with the path on the fence line',
    reply: F + 'python src/store.py\nHABITS = []\n\n\ndef add(h):\n    HABITS.append(h)\n' + F,
    expect: ['src/store.py'],
  },
  {
    title: 'API routes',
    why: 'path only in a bold heading above the block',
    reply: 'Now the routes:\n\n**src/routes.py**\n\n' + F + 'python\nfrom flask import Blueprint\n\nbp = Blueprint("api", __name__)\n' + F,
    expect: ['src/routes.py'],
  },
  {
    title: 'Server entrypoint',
    why: 'JSON wrapped in explanation, with a trailing comma',
    reply: 'Sure! Here is the server.\n\n' + F + 'json\n{"files":[{"path":"src/server.py","mode":"create","content":"from flask import Flask\\n\\napp = Flask(__name__)\\n",}]}\n' + F + '\n\nRun it with flask.',
    expect: ['src/server.py'],
  },
  {
    title: 'Frontend',
    why: 'two files in one reply, mixed prose',
    reply: 'Static assets:\n\n**static/index.html**\n' + F + 'html\n<!doctype html><title>Habits</title>\n' + F +
      '\n\nand the script:\n\n' + F + 'javascript\n// static/app.js\nconsole.log("ready");\n' + F,
    expect: ['static/index.html', 'static/app.js'],
  },
  {
    title: 'Cut off mid-write',
    why: 'the completion wait expired while the model was still writing',
    reply: F + 'json\n{"files":[{"path":"src/util.py","mode":"create","content":"def slug(s):\\n    return s.lower()\\n"},{"path":"src/broken.py","mode":"create","content":"import os\\nprint(',
    expect: ['src/util.py'],
    mustNotWrite: ['src/broken.py'],
  },
  {
    title: 'Abbreviated file',
    why: 'the model elides the middle of a file it was told to write in full',
    reply: F + 'json\n{"files":[{"path":"src/config.py","mode":"overwrite","content":"DEBUG = True\\n# ... rest of the file unchanged ...\\n"}]}\n' + F,
    expect: [],
    hazard: 'overwrites a real file with an abbreviated one',
  },
  {
    title: 'Escapes the workspace',
    why: 'an absolute path outside the project',
    reply: F + 'json\n{"files":[{"path":"/etc/closeni-trial.conf","mode":"create","content":"x=1\\n"}]}\n' + F,
    expect: [],
    hazard: 'writes outside the workspace',
  },
  {
    title: 'No files at all',
    why: 'the model answers with prose and never sends the code',
    reply: 'You should create a tests directory and add pytest cases for each module.',
    expect: [],
  },
];

// ------------------------------------------------------------------- run ----

const mock = createMockProvider();
const baseUrl = await mock.listen();
const profileRoot = mkdtempSync(join(tmpdir(), 'closeni-trial-profile-'));
writeProviderConfig(baseUrl, join(profileRoot, 'profiles', 'mock'));
const ws = mkdtempSync(join(tmpdir(), 'closeni-trial-ws-'));

const W = 78;
console.log('='.repeat(W));
console.log('  CloseNI trial build — habit tracker, 10 steps');
console.log('  workspace: ' + ws);
console.log('='.repeat(W) + '\n');

const findings = [];
let written = 0;

for (let i = 0; i < STEPS.length; i++) {
  const s = STEPS[i];
  mock.setReplies([s.reply]);
  const detail = 'Execute ONLY this step: ' + s.title;
  const { result, out } = await runAgent(['browser', detail, ws, 'mock', 'auto', String(i), detail, 'Habit tracker']);

  const ok = !!result && result.success === true;
  const files = (result && result.appliedFiles) || [];
  written += files.length;

  console.log('  ' + String(i + 1).padStart(2) + '. ' + s.title);
  console.log('      ' + s.why);
  console.log('      ' + (ok ? 'ok   ' : 'FAIL ') + (files.length ? files.join(', ') : (result && result.error) || 'no files'));

  for (const want of s.expect) {
    if (!existsSync(join(ws, want))) {
      findings.push('step ' + (i + 1) + ' (' + s.why + '): expected ' + want + ' on disk, it is not there');
      console.log('      MISSING  ' + want);
    }
  }
  for (const forbidden of s.mustNotWrite || []) {
    if (existsSync(join(ws, forbidden))) {
      findings.push('step ' + (i + 1) + ': wrote ' + forbidden + ', which was truncated mid-content');
      console.log('      WROTE A TRUNCATED FILE  ' + forbidden);
    }
  }
  if (s.hazard) {
    console.log('      hazard checked: ' + s.hazard + ' -> ' + (ok ? 'ACCEPTED' : 'refused'));
  }
  console.log('');
}

// -------------------------------------------------------------- outcomes ----

console.log('-'.repeat(W));

// Did anything land outside the workspace?
if (existsSync('/etc/closeni-trial.conf')) {
  findings.push('a file was written outside the workspace (/etc/closeni-trial.conf)');
}

// Did the abbreviation survive onto disk?
const cfg = existsSync(join(ws, 'src/config.py')) ? readFileSync(join(ws, 'src/config.py'), 'utf8') : '';
if (/rest of the file unchanged|\.\.\. rest/i.test(cfg)) {
  findings.push('src/config.py now contains an "... rest unchanged" placeholder instead of code');
}

function tree(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    if (e === '.agent-backups') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...tree(p, base));
    else out.push(relative(base, p));
  }
  return out;
}
console.log('  files on disk: ' + tree(ws).sort().join(', '));
console.log('  applied total: ' + written);

console.log('\n' + '-'.repeat(W));
if (findings.length === 0) {
  console.log('  No gaps found by this run.');
} else {
  console.log('  ' + findings.length + ' gap(s):');
  findings.forEach((f) => console.log('    · ' + f));
}
console.log('-'.repeat(W) + '\n');

await mock.close();
rmSync(profileRoot, { recursive: true, force: true });
rmSync(PROVIDER_DIR, { recursive: true, force: true });
console.log('  workspace left at ' + ws + ' for inspection\n');
