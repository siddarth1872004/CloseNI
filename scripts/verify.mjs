#!/usr/bin/env node
/*
 * Everything about this project that a machine can check, in one run.
 *
 *   node scripts/verify.mjs            all checks
 *   node scripts/verify.mjs --quick    skip the packaging audit (which builds)
 *
 * What it deliberately does NOT check is listed at the end of its own report,
 * so "everything passed" never gets read as "everything is verified".
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const QUICK = process.argv.includes('--quick');

let pass = 0, fail = 0;
const failures = [];
const groups = [];
let current = null;

function group(name) { current = { name, rows: [] }; groups.push(current); }
function check(label, ok, detail = '') {
  if (ok) pass++; else { fail++; failures.push(`${current.name} › ${label}${detail ? ' — ' + detail : ''}`); }
  current.rows.push({ label, ok, detail });
}
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

// ------------------------------------------------------------ 1. compile ----

group('Build');
try {
  sh('npm', ['run', 'build'], { timeout: 300000 });
  check('the TypeScript core compiles', true);
} catch (e) {
  check('the TypeScript core compiles', false, String(e.stdout || e.message).slice(0, 200));
}
check('compiled entrypoint exists', existsSync(join(ROOT, 'local-agent/dist/index.js')));

// -------------------------------------------------------------- 2. tests ----

group('Test suites');
try {
  const out = sh('node', ['local-agent/test/run-tests.cjs'], { timeout: 300000 });
  const m = out.match(/PASS — (\d+) passed, (\d+) failed/);
  check('unit suite passes', !!m && m[2] === '0', m ? `${m[1]} passed, ${m[2]} failed` : 'no result line');
  global.__unit = m ? Number(m[1]) : 0;
} catch (e) {
  check('unit suite passes', false, String(e.stdout || e.message).slice(-300));
}

// ------------------------------------------------------- 3. claims vs code ----

group('Documentation claims match the code');

const planner = read('local-agent/src/verification/check-planner.ts');
const langs = new Set([...planner.matchAll(/language: "([a-z+#]+)"/g)].map((m) => m[1]));
const themeJs = read('desktop/theme.js');
const themeCount = [...themeJs.matchAll(/\{ id: "/g)].length;
const readme = read('README.md');
const site = read('docs/index.html');

check('check-planner emits 12 language tags', langs.size === 12, `${langs.size}: ${[...langs].sort().join(' ')}`);
check('theme.js registers 9 themes', themeCount === 9, String(themeCount));
check('README says twelve languages', /twelve languages/i.test(readme));
check('README says nine themes', /[Nn]ine (built-in )?themes/.test(readme));
check('site counter says 12 languages',
  /data-count="12">[^<]*<\/span>\s*<span class="l">languages/.test(site));
check('README does not still claim nine languages', !/nine languages/i.test(readme));

// Every theme in theme.js must have a block in styles.css, and vice versa.
const css = read('desktop/styles.css');
const cssThemes = new Set([...css.matchAll(/\[data-theme="([a-z-]+)"\]/g)].map((m) => m[1]));
const jsThemes = [...themeJs.matchAll(/\{ id: "([a-z-]+)"/g)].map((m) => m[1]).filter((t) => t !== 'midnight');
check('every registered theme has a CSS block',
  jsThemes.every((t) => cssThemes.has(t)), jsThemes.filter((t) => !cssThemes.has(t)).join(',') || 'all present');
check('every CSS theme block is registered',
  [...cssThemes].every((t) => jsThemes.includes(t)), [...cssThemes].filter((t) => !jsThemes.includes(t)).join(',') || 'all registered');

// Providers: what ships as ready must match what the registry will actually
// drive. This is the claim most likely to drift, because gating a provider is
// a config edit and updating the prose is a separate act of will.
const provDir = join(ROOT, 'local-agent/config/providers');
const provs = readdirSync(provDir).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(provDir, f), 'utf8')));
// "Ready" means a provider that can do everything - chat, plan and build.
// A chat-only provider is real and usable and must not be counted as one, or
// the site would claim two providers can build a project when one of them
// refuses the moment you press Build.
const ready = provs.filter((p) => p.enabled && !p.comingSoon && !p.chatOnly);
const chatOnly = provs.filter((p) => p.enabled && !p.comingSoon && p.chatOnly);
const gated = provs.filter((p) => p.enabled && p.comingSoon);

check('at least one provider is ready', ready.length >= 1, ready.map((p) => p.id).join(', '));
check('every chat-only provider says so in its config',
  chatOnly.every((p) => typeof p._transportNote === 'string' && p._transportNote.length > 40),
  chatOnly.map((p) => p.id).join(', ') || 'none');
for (const p of chatOnly) {
  check(`README describes ${p.id} as chat-only`,
    /chat[- ]only/i.test(readme) && readme.includes(p.name.split(' (')[0]), p.name);
}
check('every gated provider records why it is gated',
  gated.every((p) => typeof p._comingSoonReason === 'string' && p._comingSoonReason.length > 40),
  gated.map((p) => p.id).join(', ') || 'none gated');
const counter = site.match(/data-count="(\d+)">[^<]*<\/span>\s*<span class="l">provider ready/);
check('site "provider ready" counter matches the registry',
  !!counter && Number(counter[1]) === ready.length,
  counter ? `site says ${counter[1]}, registry has ${ready.length}` : 'counter not found');
for (const p of gated) {
  check(`README marks ${p.id} as coming soon`, /coming soon/i.test(readme) &&
    readme.includes(p.name.split(' (')[0]), p.name);
}

// Steps run one at a time now, because chat, plan and build share a
// conversation. Every one of these claimed otherwise until it was hunted down
// by hand; a grep is cheaper than the next hunt.
const agentSrc = read('local-agent/src/index.ts');
const indexHtml = read('desktop/index.html');
check('the build no longer spawns parallel workers',
  !/setThreadKind\("build"\)/.test(agentSrc) && !agentSrc.includes('attachTo('),
  'a worker path came back');
check('Settings offers no parallelism control', !indexHtml.includes('concurrency-select'));
// The changelog claimed parallel steps for a whole session after the code
// stopped doing it, because the drift check only looked at README and the site.
check('the changelog does not promise parallel steps',
  !/execute in parallel|in its own chat tab/i.test(read('CHANGELOG.md')));
check('README does not promise parallel steps',
  !/steps? .{0,20}(run|execute).{0,20}in parallel|Concurrent Step Execution/i.test(readme));
check('the site does not promise parallel steps',
  !/run <strong>at the same time<\/strong>/.test(site));
check('the roadmap records the concurrency reversal',
  /BUILT, THEN DELIBERATELY REVERSED/.test(read('docs/ROADMAP.md')));

// Mojibake, not merely non-ASCII: an emoji-stripping pass once decoded emoji as
// Latin-1 instead of removing them, leaving "ðŸ”" in a source file. Em dashes,
// bullets, ellipses and middots are deliberate typography and must not trip
// this - the first version of this check flagged them and was wrong.
const MOJIBAKE = /Ã[-ÿ]|â€|â€™|ðŸ|Â[ -¿]|Å’|Å¸/;
const mojibakeTargets = ['local-agent/src/index.ts', 'desktop/renderer.js', 'desktop/main.js',
  'desktop/builder.js', 'vscode-extension/src/extension.ts', 'README.md'];
const garbled = mojibakeTargets.filter((f) => MOJIBAKE.test(read(f)));
check('no mojibake in source', garbled.length === 0, garbled.join(', '));

// The retry budget the docs quote.
const agent = read('local-agent/src/index.ts');
const budget = agent.match(/const maxFollowUps = (\d+)/);
check('repair budget is 2, as documented', budget && budget[1] === '2', budget ? budget[1] : 'not found');
check('README quotes the same budget', /[Tt]wo attempts/.test(readme));

// The scheduler can run independent steps and block only what truly depended
// on a failure. It spent its whole life unable to, because the renderer built
// its step list without carrying dependsOn across - so every plan looked
// undeclared and became a chain. That line has no DOM to test it against, so
// it is pinned here.
const builder = read('desktop/builder.js');
check('the step list carries dependsOn from the plan',
  /steps = plan\.steps\.map\([\s\S]{0,400}?dependsOn:/.test(builder));
check('the build graph comes from the scheduler, not an inline map',
  /CNSched\.graphFor\(steps\)/.test(builder));
check('a session pins concurrency to one composer',
  /sessionOn \? 1 : CN\.getConcurrency\(\)/.test(builder));
check('a failed apply gets its own follow-up, not the test-failure one',
  /command === "apply patch"[\s\S]{0,120}buildApplyFollowUp/.test(agent));

// Resuming a build. Every one of these is renderer wiring with a tested module
// on either side of it - the shape of bug that killed dependsOn.
const preload = read('desktop/preload.js');
check('the build state is saved on every status change',
  /function setStatusOf[\s\S]{0,300}saveBuildState\(\)/.test(builder));
check('and restored when a workspace is opened',
  /restoreBuild/.test(read('desktop/renderer.js')));
check('the restored plan replaces the one in memory',
  /restored\)\s*\{\s*currentPlan = restored/.test(read('desktop/renderer.js')));
check('the build state is reachable from the renderer',
  /readBuildState/.test(preload) && /writeBuildState/.test(preload));
check('a resumed build keeps what the conversation has been shown',
  /const resuming = steps\.some/.test(builder) && /AGENT_RESUMING/.test(read('desktop/main.js')));
check('a step is told whether the conversation still has the plan',
  /threadHasContext: resumed/.test(agent));
check('full context is sent when the thread is cold, not only on step 0',
  /needsFullContext = isFirstStep \|\| coldThread/.test(agent));

// Rolling a step back. The dangerous half is the write, so what is pinned here
// is that nothing writes without a confirmed plan and a workspace check.
check('a checkpoint is taken before every apply, not just the first',
  /mergeCheckpoint\(checkpoint, stepIndex[\s\S]{0,200}applyPatch\(workspace, plan\)/.test(agent));
check('a step that ran out of attempts still leaves one',
  /attempt > maxFollowUps[\s\S]{0,240}writeCheckpoint\(workspace, checkpoint\)/.test(agent));
check('the rollback is planned and applied as two steps',
  /plan-rollback/.test(read('desktop/main.js')) && /apply-rollback/.test(read('desktop/main.js')));
check('rollback refuses paths outside the workspace',
  /function inside\(rel\)[\s\S]{0,260}startsWith\('\.\.'\)|function inside\(rel\)[\s\S]{0,260}startsWith\("\.\."\)/.test(read('desktop/main.js')));
check('the user confirms before anything is written',
  /if \(!confirm\(msg\)\) return;[\s\S]{0,120}applyRollback/.test(builder));
check('drifted files are named in that confirmation',
  /plan\.drifted\.join/.test(builder));

// Conversation rollover. The dangerous ordering is doing it mid-step, so what
// is pinned is that the decision happens before anything is sent.
check('the rollover is decided before the prompt goes out',
  agent.indexOf('shouldRollOver(') < agent.indexOf('await controller.sendPrompt(promptText'));
check('a rolled-over thread is seeded as a cold one',
  /startFreshConversation\(config\)[\s\S]{0,400}buildPrompt\(effectivePrompt, ctx\.tree/.test(agent));
check('repairs count towards the conversation too',
  /const followUp = buildFollowUp[\s\S]{0,500}addTurn\(controller\.getConversationSize\(\), followUp\.length/.test(agent));
// Exporting a build as git history. Two of these are bugs that only showed up
// by running it against a real repository.
const mainJs = read('desktop/main.js');
check('every step stages every build path, not only what it touched',
  /const allPaths = Object\.keys\(touchedAt\)/.test(read('local-agent/src/export-branch.ts')));
check('the working tree is restored whatever happens',
  /\} finally \{[\s\S]{0,400}The project goes back to how it was found/.test(mainJs));
check('the export refuses a dirty tree',
  /You have uncommitted changes/.test(mainJs));
check('git still runs without a shell',
  /spawn\("git", safe, \{ cwd: cwd, shell: false/.test(mainJs));

// A gated tab and the prose describing it drifted apart for a whole session,
// because gating is a markup edit and updating the docs is a separate act of
// will - the same failure the provider counter check exists for.
const researchGated = /data-mode="research"[^>]*data-gated/.test(indexHtml);
check('the docs agree with whether Research is gated',
  researchGated === /Research (panel )?is gated|Research — gated/.test(readme),
  researchGated ? 'gated in markup' : 'live in markup');
check('the site agrees too',
  researchGated === /Research panel is unfinished/.test(site));
// Research must not scrape a search engine. That is the trap the whole project
// is written against, and it would be an easy thing to reach for later.
const research = read('local-agent/src/index.ts');
const researchCode = research.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
check('research uses the provider search, not a scraped results page',
  /smart-search/.test(researchCode) && !/duckduckgo|google\.com\/search|bing\.com/i.test(researchCode));
check('GitHub search is authenticated',
  /searchRepos/.test(read('desktop/github-api.js')));

// The live smoke test. Its value rests on watching the REAL wait loop and on
// asserting a budget rather than reporting a number, so both are pinned.
const smoke = read('local-agent/src/health/smoke-report.ts');
check('the smoke test observes the real wait, not a copy of it',
  /waitForResponse\(config, prevCount, prevContent, \(tick\)/.test(agent));
check('a slow completion fails rather than being reported',
  /COMPLETION_BUDGET_MS[\s\S]{0,200}health: "critical"/.test(smoke));
check('text that never changed is the frozen selector, and critical',
  /never changed while a reply was being generated[\s\S]{0,200}|health: "critical",\s*\n\s*detail: "the assistant text never changed/.test(smoke));
check('the reply is checked for content, not presence', /reply\.includes\(expect\)/.test(smoke));
check('it uses a thread of its own', /setThreadKind\("worker"\)[\s\S]{0,400}navigateFresh/.test(agent));
check('npm run smoke exists', !!JSON.parse(read('package.json')).scripts.smoke);

// Step review. All renderer code, and two of these are bugs that would only
// show up at runtime: Electron has no window.prompt, and a build waiting on a
// verdict nobody will give never ends.
check('review is opt-in, not opt-out',
  /localStorage\.getItem\("closeni\.review-steps"\) === "on"/.test(builder));
check('a rejection asks for a reason and sends it on',
  /A previous attempt at this step was rejected/.test(builder));
check('a rejected step is undone before it is redone',
  /rollbackQuietly\(i\)[\s\S]{0,200}rejection = verdict\.reason/.test(builder));
check('window.prompt is never called - Electron does not implement it',
  !/(^|[^.\w])prompt\(/m.test(builder.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')));
check('Stop releases a step waiting on review',
  /stopRequested = true;[\s\S]{0,600}settleReview\(\{ accept: true \}\)/.test(builder));
check('a step that changed nothing does not pause',
  /!reviewOn\(\) \|\| !filesArr\.length \|\| stopRequested/.test(builder));

// Tests the model wrote. The plan declares which steps have behaviour worth
// asserting, and that flag has to survive the same renderer journey dependsOn
// did not - so every hop is pinned.
check('the plan is asked which steps are testable', /testable is true when/.test(agent));
check('a testable step is asked for tests', /This step has behaviour worth testing/.test(agent));
check('the suite only runs once tests exist', /hasTestFiles\(workspaceNames\)/.test(agent));
check('a failing test gets its own follow-up',
  /command === "run tests"[\s\S]{0,200}buildTestFollowUp/.test(agent));
check('the follow-up does not decide which is wrong',
  /either could be at fault/.test(read('local-agent/src/follow-up.ts')));
check('testable survives the renderer', /testable: s\.testable === true/.test(builder));
check('and the IPC to the session', /testable: !!payload\.testable/.test(read('desktop/main.js')));
check('and a restart', /testable\?: boolean/.test(read('local-agent/src/build-state.ts')));

// Type checking. The flags are the feature: without --ignore-missing-imports a
// Flask project fails every single step on a missing stub for flask, which
// would make this actively worse than not running it at all.
const cp = read('local-agent/src/verification/check-planner.ts');
check('python gets a type check, not only a syntax check', /tool: "mypy"/.test(cp));
check('third-party stubs cannot fail a step', /--ignore-missing-imports/.test(cp));
check('errors in untouched files are not reported', /--follow-imports=silent/.test(cp));
check('the type cache stays out of the project', /--cache-dir/.test(cp));
check('mypy resolves inside a virtualenv too',
  /-m mypy/.test(read('local-agent/src/verification/toolchain.ts')));
check('a type failure reads differently from a syntax one',
  /c\.kind === "types"/.test(agent));

// The selector health check. Its whole value rests on one distinction - a
// selector matching nothing is only a fault when something should have matched
// - so that is what is pinned, along with it never blocking a build.
check('the health check runs inside the build session, before step 1',
  agent.indexOf('judgeSelectors(await controller.probeSelectors(config)') <
  agent.indexOf('Build session ready (one conversation).'));
check('a failed probe does not stop a build',
  /Selector check could not run/.test(agent));
check('the read path is judged against a resumed conversation',
  /conversationResumed: resumed/.test(agent));
check('there is an on-demand check too',
  /provider-health/.test(read('desktop/main.js')) && /acct-health/.test(read('desktop/index.html')));
check('the on-demand check is queued against the profile lock',
  /refuseWhileBuilding\("The selector check"\)/.test(read('desktop/main.js')));

check('the size is stored with the ledger, so both reset together',
  /entry\.buildLedger = \{\};[\s\S]{0,120}entry\.conversationSize/.test(read('local-agent/src/session-store.ts')));

// ------------------------------------------------------ 4. asset integrity ----

group('Assets and references');

const refs = [
  ...[...readme.matchAll(/src="([^"]+)"/g)].map((m) => ['README', m[1]]),
  ...[...readme.matchAll(/\]\((?!http)([^)#][^)]*)\)/g)].map((m) => ['README', m[1]]),
  ...[...site.matchAll(/(?:src|href)="((?:assets|screenshots)\/[^"]+)"/g)].map((m) => ['site', 'docs/' + m[1]]),
];
// A link may carry a fragment (docs/ROADMAP.md#some-heading). Only the path
// part names a file; leaving the fragment on reported a missing file that was
// right there.
const missing = refs.filter(([, p]) => !existsSync(join(ROOT, p.split('#')[0])));
check('every referenced file exists', missing.length === 0, missing.map(([w, p]) => `${w}:${p}`).join(', '));

// Anchors in the README table of contents must resolve to a heading.
const headings = new Set([...readme.matchAll(/^#{1,6} (.+)$/gm)]
  .map((m) => m[1].toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/ /g, '-')));
const anchors = [...readme.matchAll(/\]\(#([a-z0-9-]+)\)/g)].map((m) => m[1]);
const badAnchors = anchors.filter((a) => !headings.has(a));
check('every README anchor resolves', badAnchors.length === 0, badAnchors.join(', '));

// SVGs must carry no script and no external reference, or GitHub strips them
// and a Pages CSP blocks them.
group('Pixel-art SVGs');
const assets = readdirSync(join(ROOT, 'docs/assets')).filter((f) => f.endsWith('.svg'));
check('assets were generated', assets.length >= 6, assets.join(' '));

// An asset nothing points at is dead weight that still ships and still has to
// be regenerated. Either use it or delete it.
const unused = assets.filter((f) => !readme.includes(f) && !site.includes(f));
check('every generated asset is referenced', unused.length === 0, unused.join(', '));
for (const f of assets) {
  const svg = read('docs/assets/' + f);
  const okNoScript = !/<script/i.test(svg);
  const okNoExternal = !/(href|src)\s*=\s*"https?:/i.test(svg);
  const okCrisp = /shape-rendering="crispEdges"/.test(svg) || f === 'divider.svg';
  const okDiscrete = !/calcMode="linear"/.test(svg);
  check(`${f}: no <script>, no external refs, crisp, discrete-only`,
    okNoScript && okNoExternal && okCrisp && okDiscrete,
    [!okNoScript && 'script', !okNoExternal && 'external', !okCrisp && 'not crisp', !okDiscrete && 'tweened'].filter(Boolean).join(' '));
}

// -------------------------------------------------------- 5. release config ----

group('Release configuration');
const pkg = JSON.parse(read('package.json'));
check('version is set', /^\d+\.\d+\.\d+$/.test(pkg.version), pkg.version);
check('linux deb has a maintainer', !!(pkg.build?.linux?.maintainer), pkg.build?.linux?.maintainer || 'MISSING — the .deb target refuses to build without it');
check('files list is an allow-list, not a glob',
  Array.isArray(pkg.build?.files) && !pkg.build.files.includes('**/*'), (pkg.build?.files || []).join(' '));
check('storage is never in the files list',
  !(pkg.build?.files || []).some((f) => /storage/.test(f)));
check('publish is a draft', pkg.build?.publish?.releaseType === 'draft');

const wf = read('.github/workflows/release.yml');
check('release workflow checks the tag against package.json', /does not match package.json version/.test(wf));
check('release workflow serialises the two OS jobs', /max-parallel:\s*1/.test(wf));
// Compare the executed `run:` lines, not any mention - electron-builder is
// named in a comment near the top, which made this pass/fail on prose.
const runLines = [...wf.matchAll(/^\s*run:\s*(.+)$/gm)].map((m) => m[1]);
const iTests = runLines.findIndex((l) => l.includes('run-tests.cjs'));
const iPack = runLines.findIndex((l) => l.includes('electron-builder'));
check('release workflow runs unit tests before packaging',
  iTests !== -1 && iPack !== -1 && iTests < iPack, `tests step ${iTests}, package step ${iPack}`);

// gitignore must still exclude live session state.
const ignore = read('.gitignore');
for (const secret of ['local-agent/storage/sessions.json', 'local-agent/storage/last-chat-url.json', 'local-agent/storage/browser-profiles/']) {
  check(`gitignore excludes ${secret}`, ignore.includes(secret.replace(/\/$/, '')));
}
try {
  const tracked = sh('git', ['ls-files', 'local-agent/storage']).trim().split('\n').filter(Boolean);
  const bad = tracked.filter((f) => !/\.gitkeep$/.test(f));
  check('no session state is tracked by git', bad.length === 0, bad.join(', '));
} catch { check('no session state is tracked by git', false, 'git ls-files failed'); }

// ------------------------------------------------------- 6. packaging audit ----

if (!QUICK) {
  group('Packaged artifact');
  const asar = 'dist/linux-unpacked/resources/app.asar';
  if (!existsSync(join(ROOT, asar))) {
    check('a packaged build exists to audit', false, 'run `npx electron-builder --linux` first');
  } else {
    const list = sh('npx', ['asar', 'list', asar]).split('\n');
    const leaked = list.filter((f) => /storage\/|sessions\.json|last-chat-url|browser-profiles/.test(f));
    check('no session data in the artifact', leaked.length === 0, leaked.slice(0, 5).join(', '));
    for (const need of ['/local-agent/dist/index.js', '/desktop/main.js', '/desktop/theme.js', '/build/icon.png']) {
      check(`artifact contains ${need}`, list.includes(need));
    }
    check('artifact bundles playwright', list.some((f) => f.startsWith('/node_modules/playwright')));
  }
}

// ------------------------------------------------------------------ report ----

const W = 78;
console.log('\n' + '='.repeat(W));
console.log('  CloseNI verification');
console.log('='.repeat(W));
for (const g of groups) {
  console.log(`\n  ${g.name}`);
  for (const r of g.rows) {
    console.log(`    ${r.ok ? ' ok ' : 'FAIL'}  ${r.label}${r.detail ? '  (' + r.detail + ')' : ''}`);
  }
}
console.log('\n' + '-'.repeat(W));
console.log(`  ${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} checks passed, ${fail} failed`);
if (fail) { console.log('\n  Failures:'); failures.forEach((f) => console.log('    · ' + f)); }

console.log(`
${'-'.repeat(W)}
  NOT covered by this script, and still unverified:

    · The Windows installer. No Windows machine here; the first .exe the
      release workflow builds is unverified until someone installs it.
    · Qwen and GLM are gated as coming soon, not verified. Qwen's page control
      works against the live site but a build-sized prompt outruns its 120s
      completion wait; GLM's live site declines the build prompts. Only
      DeepSeek has been driven end to end.
    · GitHub sign-in, push, clone and Actions against a real token. Tested
      with an injected transport, never over the network.
    · Whether generated projects are correct. The checks prove code parses
      and compiles, not that it behaves.
${'-'.repeat(W)}
`);

process.exit(fail === 0 ? 0 : 1);
