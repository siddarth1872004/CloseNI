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

import { readFileSync, existsSync, readdirSync, lstatSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderSite } from './make-site.mjs';
import { renderLanding } from './make-landing.mjs';

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
// The native app (native/): its QML (panels, singletons, shell and the pure
// modules under qml/js/) and its C++ services under src/.
const nativeFiles = (dir, exts) => readdirSync(join(ROOT, dir), { recursive: true })
  .filter((f) => exts.some((x) => String(f).endsWith(x))).sort().map((f) => dir + '/' + f);
const QML_FILES = nativeFiles('native/qml', ['.qml', '.mjs']);
const CPP_FILES = nativeFiles('native/src', ['.cpp', '.h']);
const readQml = () => QML_FILES.map(read).join('\n');
const readCpp = () => CPP_FILES.map(read).join('\n');
// The agent CLI: the dispatcher in index.ts, its I/O and workspace helpers, and
// one module per mode under src/modes/.
const AGENT_FILES = ['local-agent/src/index.ts', 'local-agent/src/cli-io.ts', 'local-agent/src/workspace-env.ts',
  ...readdirSync(join(ROOT, 'local-agent/src/modes')).filter((f) => f.endsWith('.ts')).sort()
    .map((f) => 'local-agent/src/modes/' + f)];
const readAgent = () => AGENT_FILES.map(read).join('\n');
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
const themeJs = read('native/qml/js/theme.mjs');
const themeCount = [...themeJs.matchAll(/\{ id: "/g)].length;
const readme = read('README.md');
const landing = read('docs/index.html');
const docsPage = read('docs/readme.html');
const site = landing + docsPage;
// The documentation page is the README, rendered, so every claim checked
// against the README below holds for it. The landing page carries only the
// version, regenerated from package.json.
check('the docs page is generated from the current README', docsPage === renderSite(readme), 'run npm run site');
check('the landing page is generated from the README and package.json',
  landing === renderLanding(readme, JSON.parse(read('package.json'))), 'run npm run site');
check('the landing page links the latest release for both systems',
  (landing.match(/releases\/latest/g) || []).length >= 3 && /Windows/.test(landing) && /Linux/.test(landing));

// The twelve the README's table documents. The planner knows more, and the
// README must say how many of those are unproven.
const documented = ['c', 'cpp', 'csharp', 'go', 'java', 'javascript', 'php', 'python', 'ruby', 'rust', 'shell', 'typescript'];
check('check-planner covers the 12 documented languages', documented.every((l) => langs.has(l)),
  documented.filter((l) => !langs.has(l)).join(' ') || `${langs.size}: ${[...langs].sort().join(' ')}`);
check('README counts the unproven languages', readme.includes(`${langs.size - documented.length} more languages`), String(langs.size - documented.length));
check('theme.mjs registers 11 themes', themeCount === 11, String(themeCount));
check('README says twelve languages', /twelve languages/i.test(readme));
check('README says eleven themes', /[Ee]leven (built-in )?themes/.test(readme));
check('README does not still claim nine languages', !/nine languages/i.test(readme));

// Every theme in theme.mjs must have a palette in Theme.qml, and vice versa.
const themeQml = read('native/qml/singletons/Theme.qml');
const paletteBlock = themeQml.slice(themeQml.indexOf('readonly property var palettes'));
const qmlThemes = new Set([...paletteBlock.matchAll(/^ {8}"([a-z-]+)": \{/gm)].map((m) => m[1]));
const jsThemes = [...themeJs.matchAll(/\{ id: "([a-z-]+)"/g)].map((m) => m[1]);
check('every registered theme has a palette',
  jsThemes.every((t) => qmlThemes.has(t)), jsThemes.filter((t) => !qmlThemes.has(t)).join(',') || 'all present');
check('every palette is registered',
  [...qmlThemes].every((t) => jsThemes.includes(t)), [...qmlThemes].filter((t) => !jsThemes.includes(t)).join(',') || 'all registered');

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
for (const p of gated) {
  check(`README marks ${p.id} as coming soon`, /coming soon/i.test(readme) &&
    readme.includes(p.name.split(' (')[0]), p.name);
}

// Steps run one at a time now, because chat, plan and build share a
// conversation. Every one of these claimed otherwise until it was hunted down
// by hand; a grep is cheaper than the next hunt.
const agentSrc = readAgent();
check('the build no longer spawns parallel workers',
  !/setThreadKind\("build"\)/.test(agentSrc) && !agentSrc.includes('attachTo('),
  'a worker path came back');
check('Settings offers no parallelism control',
  !/concurrency/i.test(read('native/qml/panels/SettingsPanel.qml') + read('native/qml/singletons/SettingsStore.qml')));
// The changelog claimed parallel steps for a whole session after the code
// stopped doing it, because the drift check only looked at README and the site.
check('the changelog does not promise parallel steps',
  !/execute in parallel|in its own chat tab/i.test(read('CHANGELOG.md')));
check('README does not promise parallel steps',
  !/steps? .{0,20}(run|execute).{0,20}in parallel|Concurrent Step Execution/i.test(readme));
check('the roadmap records the concurrency reversal',
  /BUILT, THEN DELIBERATELY REVERSED/.test(read('docs/ROADMAP.md')));

// Mojibake, not merely non-ASCII: an emoji-stripping pass once decoded emoji as
// Latin-1 instead of removing them, leaving "ðŸ”" in a source file. Em dashes,
// bullets, ellipses and middots are deliberate typography and must not trip
// this - the first version of this check flagged them and was wrong.
const MOJIBAKE = /Ã[-ÿ]|â€|â€™|ðŸ|Â[ -¿]|Å’|Å¸/;
const mojibakeTargets = [...AGENT_FILES, ...QML_FILES, ...CPP_FILES, 'README.md'];
const garbled = mojibakeTargets.filter((f) => MOJIBAKE.test(read(f)));
check('no mojibake in source', garbled.length === 0, garbled.join(', '));

// The retry budget the docs quote.
const agent = readAgent();
const budget = agent.match(/const maxFollowUps = (\d+)/);
check('repair budget is 2, as documented', budget && budget[1] === '2', budget ? budget[1] : 'not found');
check('README quotes the same budget', /[Tt]wo attempts/.test(readme));

// The scheduler can run independent steps and block only what truly depended
// on a failure. It spent its whole life unable to, because the renderer built
// its step list without carrying dependsOn across - so every plan looked
// undeclared and became a chain. The wiring has no unit test, so it is pinned
// here. BuildState.qml is the builder; builder-logic.mjs its pure half.
const builder = read('native/qml/singletons/BuildState.qml');
const builderLogic = read('native/qml/js/builder-logic.mjs');
check('the step list carries dependsOn from the plan',
  /function stepsFromPlan[\s\S]{0,800}?dependsOn:/.test(builderLogic) && /B\.stepsFromPlan\(plan\.steps\)/.test(builder));
check('the build graph comes from the scheduler, not an inline map',
  /Sched\.graphFor\(build\.steps\)/.test(builder));
check('a session pins concurrency to one composer',
  /sessionOn \? 1 : build\.concurrency\(\)/.test(builder));
check('a failed apply gets its own follow-up, not the test-failure one',
  /command === "apply patch"[\s\S]{0,120}buildApplyFollowUp/.test(agent));

// Resuming a build. Every one of these is wiring with a tested module on
// either side of it - the shape of bug that killed dependsOn.
const builds = read('native/src/BuildStore.h');
const agentService = read('native/src/AgentService.cpp');
check('the build state is saved on every status change',
  /function setStatusOf[\s\S]{0,300}saveBuildState\(\)/.test(builder));
check('and restored when a workspace is opened',
  /function onWorkspaceOpened[\s\S]{0,120}restoreBuild\(folder\)/.test(builder));
check('the restored plan replaces the one in memory',
  /AppState\.currentPlan = restored/.test(builder));
check('the build state is reachable from QML',
  /Q_INVOKABLE void readBuildState/.test(builds) && /Q_INVOKABLE void writeBuildState/.test(builds));
check('a resumed build keeps what the conversation has been shown',
  /var resuming = steps\.some/.test(builder) && /"AGENT_RESUMING"/.test(agentService));
check('a step is told whether the conversation still has the plan',
  /threadHasContext: resumed/.test(agent));
check('full context is sent when the thread is cold, not only on step 0',
  /needsFullContext = isFirstStep \|\| coldThread/.test(agent));

// Rolling a step back. The dangerous half is the write, so what is pinned here
// is that nothing writes without a confirmed plan and a workspace check.
check('a checkpoint is taken before every apply, not just the first',
  /mergeCheckpoint\(checkpoint, stepIndex[\s\S]{0,200}applyPatch\(workspace, plan\)/.test(agent));
// A step out of attempts undoes itself, so its files cannot fail later steps;
// a checkpoint is left only for what could not be put back.
check('a step that ran out of attempts undoes its own changes',
  /attempt > maxFollowUps[\s\S]{0,600}restoreFailedStep\(workspace, checkpoint, stepIndex\)[\s\S]{0,160}if \(restored\.unrestorable\.length\) writeCheckpoint\(workspace, checkpoint\)/.test(agent));
check('the rollback is planned and applied as two steps',
  /Q_INVOKABLE void planRollback/.test(builds) && /Q_INVOKABLE void applyRollback/.test(builds));
check('rollback refuses paths outside the workspace',
  /QString inside\([\s\S]{0,400}startsWith\(QLatin1String\("\.\."\)\)/.test(read('native/src/BuildRules.cpp')) &&
  /Workspace::inside\(workspace, rel\)/.test(read('native/src/BuildStore.cpp')));
check('the user confirms before anything is written',
  /confirm\(msg, function \(\) \{ build\._applyRollback/.test(builder));
check('drifted files are named in that confirmation',
  /plan\.drifted\.join/.test(builderLogic));

// Conversation rollover. The dangerous ordering is doing it mid-step, so what
// is pinned is that the decision happens before anything is sent.
check('the rollover is decided before the prompt goes out',
  agent.indexOf('shouldRollOver(') < agent.indexOf('await controller.sendPrompt(promptText'));
check('a rolled-over thread is seeded as a cold one',
  /startFreshConversation\(config\)[\s\S]{0,600}buildPrompt\(\{\s*task: effectivePrompt, tree: ctx\.tree,[\s\S]{0,200}isFirstStep: true/.test(agent));
check('repairs count towards the conversation too',
  /const followUp = buildFollowUp[\s\S]{0,500}addTurn\(controller\.getConversationSize\(\), followUp\.length/.test(agent));
// A skill name arrives from the UI and becomes a path, so the refusal is the
// security-relevant part. An MCP server is an arbitrary subprocess the user
// configured, which is a new category of thing this app runs.
check('a skill name is refused rather than sanitised',
  /SkillStore::isSafeName/.test(read('native/src/LibraryService.cpp')) &&
  /[Rr]efused rather than sanitised/.test(read('local-agent/src/skill-store.ts')));
check('MCP context is gathered once per build, not per step',
  /gatherMcpContext/.test(builder) && !/gatherMcpContext/.test(builderLogic));
check('the preamble travels as an environment variable, like provider controls',
  /env\.insert\(QStringLiteral\("AGENT_PREAMBLE"\)/.test(agentService));
check('a status probe sends no preamble',
  /agentEnv\(QStringLiteral\("0"\), QVariant\(\), QVariant\(\)\)/.test(agentService));

// Recent workspaces, and the bug adding them exposed: showing the plan hands
// it to the builder, which resets every status to pending - correct for a
// new plan, destructive for a restored one. Resume had been silently broken
// since it landed, and the wrong statuses were being written back to disk.
const planState = read('native/qml/singletons/PlanState.qml');
const appState = read('native/qml/singletons/AppState.qml');
check('restoring a build does not reset its statuses',
  /PlanState\.showPlan\(restored, true\)/.test(builder) &&
  /if \(!keepBuild\) BuildState\.setPlan\(plan\)/.test(planState));
check('Browse and the recent list share one switch path',
  /onAccepted: AppState\.openWorkspace\(/.test(read('native/qml/Main.qml')) &&
  /AppState\.openWorkspace\(modelData\)/.test(read('native/qml/shell/RecentList.qml')));
check('the recent list stores paths only, not session data',
  /closeni\.recent-workspaces/.test(appState) &&
  !/recent-workspaces/.test(read('local-agent/src/session-store.ts')));
check('a missing folder is named rather than dropped',
  /missing/.test(read('native/qml/js/recent-workspaces.mjs')));

// Skills, personas and MCP context all arrive as one preamble. The risk is the
// same one that kept the code-quality block to four lines: text in front of the
// JSON instruction is parse risk, and this project has lost builds to it.
check('the preamble is composed under a budget, not concatenated',
  /composePrompt\(/.test(agent) && /withPreamble\(/.test(agent));
check('base is never truncated',
  /base` is never truncated|base is never truncated/.test(read('local-agent/src/prompt-compose.ts')));
check('what was dropped is reported', /Preamble over budget/.test(agent));
check('a malformed preamble is not fatal', /AGENT_PREAMBLE[\s\S]{0,300}catch/.test(agent));

// The headless CLI. Its value is that it runs the build path without a
// window, so what is pinned is that it reuses the app's modules rather than
// reimplementing them - a copy would drift and keep passing.
const cli = read('bin/closeni.js');
check('the CLI reuses the app scheduler rather than its own',
  /require\(path\.join\(ROOT, "native", "qml", "js", "scheduler\.mjs"\)\)/.test(cli) &&
  !/function runnableSteps/.test(cli));
check('and the app timing module', /require\(path\.join\(ROOT, "native", "qml", "js", "step-timing\.mjs"\)\)/.test(cli));
check('it builds an existing plan and does not plan', !/"plan"/.test(cli) && /only builds an existing plan/.test(cli));
check('a headless run defaults to running no commands',
  /autonomy: "never"/.test(cli));
// Installable through npm's `bin` from a checkout. The native package does
// not ship it: it needs the native/qml/js modules from a checkout and a Node
// on PATH, which an installed app has neither of.
check('the CLI is installable',
  JSON.parse(read('package.json')).bin.closeni === 'bin/closeni.js' && existsSync(join(ROOT, 'bin/closeni.js')));

// Timing. The value is in separating "waiting on the model" from "running a
// slow test suite", so what is pinned is that phases are measured rather than
// step totals guessed at.
const timing = read('native/qml/js/step-timing.mjs');
check('timing comes from observed phases, not inference',
  /signal phaseNoted/.test(read('native/qml/singletons/Providers.qml')) && /Timing\.markPhase\(build\._stepTimer/.test(builder));
check('time nobody accounted for is named, not folded into a neighbour',
  /UNATTRIBUTED/.test(timing));
check('timing survives a restart', /timing\?: \{ totalMs/.test(read('local-agent/src/build-state.ts')));
check('stored timing is re-validated on read', /function readTiming/.test(read('local-agent/src/build-state.ts')));

// The plan editor. dependsOn is index-based, so the danger is an edit that
// silently produces an unschedulable graph - which falls back to the chain and
// undoes the scheduler work rather than failing loudly.
const planEdit = read('native/qml/js/plan-edit.mjs');
const qmlSrc = readQml();
check('plan edits go through the remapping module, never the array directly',
  /PlanEdit\.(moveStep|deleteStep|mergeStepUp)/.test(read('native/qml/js/renderer-logic.mjs')) &&
  /R\.applyPlanEdit\(AppState\.currentPlan/.test(planState) &&
  !/currentPlan\.steps\.splice/.test(qmlSrc));
check('deleting a step hands on its dependencies', /inherited/.test(planEdit));
check('an invalid move is refused rather than silently dropping a dependency',
  /cannot run before it/.test(planEdit));
check('an undeclared step is not turned into a declared one',
  /if \(!declared\) return Object\.assign\(\{\}, step\)/.test(planEdit));

// Exporting a build as git history. Two of these are bugs that only showed up
// by running it against a real repository.
const gitSrc = read('native/src/GitService.cpp');
check('every step stages every build path, not only what it touched',
  /const allPaths = Object\.keys\(touchedAt\)/.test(read('local-agent/src/export-branch.ts')));
check('the working tree is restored whatever happens',
  /The finally: the project goes back to how it was found/.test(gitSrc));
check('the export refuses a dirty tree',
  /You have uncommitted changes/.test(gitSrc));
// QProcess takes the arguments as a list, so there is no shell to split them.
check('git still runs without a shell',
  /setProgram\(QStringLiteral\("git"\)\);\s*proc->setArguments\(args\)/.test(read('native/src/GitRunner.cpp')));

// A gated tab and the prose describing it drifted apart for a whole session,
// because gating is a one-line edit and updating the docs is a separate act of
// will - the same failure the provider counter check exists for.
const researchGated = /mode: "research"[^}]*gated/.test(appState);
check('the docs agree with whether Research is gated',
  researchGated === /Research (panel )?is gated|Research — gated/.test(readme),
  researchGated ? 'gated in the app' : 'live in the app');
// Research must not scrape a search engine. That is the trap the whole project
// is written against, and it would be an easy thing to reach for later.
const research = readAgent();
const researchCode = research.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
check('research uses the provider search, not a scraped results page',
  /smart-search/.test(researchCode) && !/duckduckgo|google\.com\/search|bing\.com/i.test(researchCode));
check('GitHub search is authenticated',
  /searchRepos/.test(read('native/src/GitHubApi.cpp')) && /"Authorization", "Bearer "/.test(read('native/src/GitHubApi.cpp')));

// The long-prompt path. A React composer shadows `value` with an own property,
// so el.value = text is swallowed and nothing sends - which hung a real build
// the first time a conversation rolled over and produced a 6384-char prompt.
const ctl = read('local-agent/src/providers/playwright-controller.ts');
check('a long prompt is written through the native value setter',
  /getOwnPropertyDescriptor\(w\.HTMLTextAreaElement\.prototype, "value"\)/.test(ctl));
check('and the composer is checked before anything is sent',
  /The composer did not take the prompt/.test(ctl));
check('with fill\(\) as the fallback that goes through the browser itself',
  /retyping it[\s\S]{0,120}input\.fill\(prompt\)/.test(ctl));

// Python tests were only ever run through pytest, and only when a manifest or
// a tests/ directory existed. A real build wrote test_*.py beside the code with
// neither, so NO test check was planned - CloseNI asked for tests, got them,
// and never ran them, and a wrong assertion went unnoticed.
const bc = read('local-agent/src/verification/behaviour-checker.ts');
check('loose python test files are run with unittest',
  /unittest discover/.test(bc));
check('a declared pytest project still wins',
  bc.indexOf('pytest.ini') < bc.indexOf('unittest discover'));
check('a missing dependency does not fail the step',
  /looksLikeMissingDependency/.test(readAgent()));
check('but a missing LOCAL module still does',
  /local\.has/.test(bc));

// A build installs into its own venv, and then uses it. A real run suggested
// `pip3 install -r backend/requirements.txt` at every step, failed every time
// with "pip3: not found", and then failed nine steps on "No module named
// pytest" - one fact about the machine, reported as nine code bugs.
const pe = read('local-agent/src/verification/python-env.ts');
const idx = readAgent();
check('a build creates its own venv', /-m venv/.test(pe));
check('and installs with the venv python, never a bare pip',
  /-m pip install/.test(pe) && !/^\s*"pip3? install/m.test(pe));
check('manifests one level down are found', /findManifests/.test(pe));
check('the venv is what "python" resolves to', /workspaceResolver/.test(idx));
check('suggested pip3 commands are rewritten to it', /rewriteForVenv\(normalizeCommand/.test(idx));
// A 15-step build lost both repair attempts to the rewrite itself: `flask db
// init` ran against the system PATH and was not found, and `python -m pip
// install` came back as `<venv>/python -m <venv>/python -m pip install`.
check('so are the console scripts the venv installs', /venvScriptResolver/.test(idx));
check('and only a word in command position is rewritten', /\[;&\|\(\]/.test(pe));
check('checks accept that resolver', /resolve \|\| resolveTool/.test(read('local-agent/src/verification/check-planner.ts')));
// The export refuses to run on a dirty tree and tells the user to commit what
// is there. Without this it would be asking them to commit node_modules.
check('build artefacts are gitignored', /mergeGitignore/.test(idx) && /node_modules\//.test(pe));
check('a machine that cannot build a venv is told once, with the fix',
  /describePythonUnavailable/.test(idx) && /sudo apt install/.test(pe));

// A failed reply request must stop the wait rather than poll for five minutes
// and then blame the model. Only the HTTP status is read - no payload is
// inspected, because a rate limit is a 429 whatever the body says.
const ctlSrc = read('local-agent/src/providers/playwright-controller.ts');
// The tap itself lives in stream-tap.ts, shared with the browser-native layer;
// the controller must still be the one installing it.
const tapSrc = read('local-agent/src/providers/stream-tap.ts');
check('the tap reports the reply request status',
  /__closeniStream\("open", this\.status\)/.test(tapSrc) && /replyStreamTap/.test(ctlSrc));
check('and the wait stops on a failed one',
  /describeStreamFailure\(this\.lastStreamStatus\)/.test(ctlSrc));
check('a rate limit is judged by status, not by matching prose',
  /429/.test(read('local-agent/src/providers/stream-status.ts')) &&
  !/rate limit(ed)?"|hit your limit/i.test(read('local-agent/src/providers/stream-status.ts')));

// Replay: real provider markup, no network. The seam matters - the harness has
// to drive the REAL extractors, because a copy keeps passing after the original
// breaks. And the fixture must never become a credential file, which is why the
// HAR approach was dropped.
check('there is a replay harness', !!JSON.parse(read('package.json')).scripts.replay);
check('it drives the real controller, not a copy',
  /attachPageForReplay/.test(read('scripts/replay.mjs')) &&
  /attachPageForReplay/.test(read('local-agent/src/providers/playwright-controller.ts')));
const fixture = read('local-agent/test/fixtures/replay/deepseek-reply.html');
check('the replay fixture carries no credentials',
  !/set-cookie|authorization|bearer |smidV2|thumbcache/i.test(fixture));
check('and no URLs beyond the SVG namespace',
  (fixture.match(/https?:\/\/[^"' ]+/g) || []).every((u) => u.startsWith('http://www.w3.org/')));

// A real MCP server reports a tool failure as a SUCCESSFUL result carrying
// isError, not as a JSON-RPC error. Checking only the latter meant a failed
// tool's message was folded into every step's prompt as if it were context.
check('a tool error in the result is treated as a failure',
  /isError/.test(read('local-agent/src/mcp/mcp-client.ts')));
check('the fake reproduces the shape a real server uses',
  /isError/.test(read('local-agent/test/fixtures/fake-mcp-server.js')));
check('there is an opt-in interop check against a real server',
  !!JSON.parse(read('package.json')).scripts['mcp:interop']);

// A checkpoint's title becomes a git commit subject when a build is exported.
// Storing the step DETAIL there produced "step 1: Overall: Temperature converter
// Execute ONLY this step: Tempe" on a real exported build.
check('a checkpoint records the step title, not the whole prompt',
  /req\.title \|\| stepDetail/.test(agent));
check('and the title is sent by both the app and the CLI',
  /\{QStringLiteral\("title"\), orString\(payload\.value\(QStringLiteral\("title"\)\)/.test(agentService) &&
  /title: steps\[i\]\.title/.test(read('bin/closeni.js')));

// The stream tap wrapped fetch only, and DeepSeek's page never calls fetch -
// 0 fetch calls against 36 XHR, measured. So the tap never fired once, and
// completion silently ran on text stability for the whole life of the feature.
// A tap that watches one transport is a tap that works until it does not.
const controller = read('local-agent/src/providers/playwright-controller.ts');
check('the stream tap watches XHR as well as fetch',
  /XMLHttpRequest/.test(tapSrc) && /w\.fetch/.test(tapSrc) && /import \{ replyStreamTap \}/.test(controller));
check('an XHR stream closes on loadend, so a failed one cannot hang the counter',
  /loadend/.test(tapSrc));
check("DeepSeek's stream pattern is the measured endpoint, not a guess",
  JSON.parse(read('local-agent/config/providers/deepseek.json')).selectors.streamUrlPattern
    === '/api/v0/chat/(completion|resume_stream)');
check('a provider with no stop control does not pretend to have one',
  !JSON.parse(read('local-agent/config/providers/deepseek.json')).selectors.stopButton);

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

// Step review. Wiring with no unit test, and two of these are bugs that would
// only show up at runtime: there is no blocking prompt() to ask for a reason
// (the panel's dialog does), and a build waiting on a verdict nobody will give
// never ends.
check('review is opt-in, not opt-out',
  /Prefs\.get\("closeni\.review-steps", "off"\) === "on"/.test(builder));
check('a rejection asks for a reason and sends it on',
  /A previous attempt at this step was rejected/.test(builderLogic) && /B\.stepPrompt\(plan, s, rejection\)/.test(builder));
check('a rejected step is undone before it is redone',
  /_rollbackQuietly\(i\)\.then\(function \(\) \{[\s\S]{0,200}var reason = verdict\.reason[\s\S]{0,400}return attempt\(reason\)/.test(builder));
check('no blocking prompt() is called - a reason comes from the panel',
  !/(^|[^.\w])prompt\(/m.test(builder.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')));
check('Stop releases a step waiting on review',
  /stopRequested = true[\s\S]{0,600}settleReview\(\{ accept: true \}\)/.test(builder));
check('a step that changed nothing does not pause',
  /!build\.reviewSteps \|\| !filesArr\.length \|\| build\.stopRequested/.test(builder));

// Tests the model wrote. The plan declares which steps have behaviour worth
// asserting, and that flag has to survive the same renderer journey dependsOn
// did not - so every hop is pinned.
check('the plan is asked which steps are testable', /testable is true when/.test(agent));
check('a testable step is asked for tests',
  /This step has behaviour worth testing/.test(read('local-agent/src/step-prompt.ts')) && /testable: req\.testable/.test(agent));
check('the suite only runs once tests exist', /hasTestFiles\(workspaceNames\)/.test(agent));
check('a failing test gets its own follow-up',
  /command === "run tests"[\s\S]{0,200}buildTestFollowUp/.test(agent));
check('the follow-up does not decide which is wrong',
  /either could be at fault/.test(read('local-agent/src/follow-up.ts')));
check('testable survives the builder', /testable: s\.testable === true/.test(builderLogic) && /testable: s\.testable/.test(builder));
check('and the call to the session', /\{QStringLiteral\("testable"\), truthy\(payload\.value\(QStringLiteral\("testable"\)\)\)\}/.test(agentService));
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
  /void AgentService::providerHealth/.test(agentService) && /Providers\.checkSelectors\(\)/.test(read('native/qml/shell/Rail.qml')));
check('the on-demand check is queued against the profile lock',
  /refuseWhileBuilding\(QStringLiteral\("The selector check"\)\)/.test(agentService));

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
check('assets were generated', assets.length >= 4, assets.join(' '));

// An asset nothing points at is dead weight that still ships and still has to
// be regenerated. Either use it or delete it.
const unused = assets.filter((f) => !readme.includes(f) && !site.includes(f));
check('every generated asset is referenced', unused.length === 0, unused.join(', '));
for (const f of assets) {
  const svg = read('docs/assets/' + f);
  const okNoScript = !/<script/i.test(svg);
  const okNoExternal = !/(href|src)\s*=\s*"https?:/i.test(svg);
  const okCrisp = /shape-rendering="crispEdges"/.test(svg);
  const okDiscrete = !/calcMode="linear"/.test(svg);
  check(`${f}: no <script>, no external refs, crisp, discrete-only`,
    okNoScript && okNoExternal && okCrisp && okDiscrete,
    [!okNoScript && 'script', !okNoExternal && 'external', !okCrisp && 'not crisp', !okDiscrete && 'tweened'].filter(Boolean).join(' '));
}

// -------------------------------------------------------- 5. release config ----

group('Release configuration');
const pkg = JSON.parse(read('package.json'));
const appMeta = JSON.parse(read('native/package/app.json'));
check('version is set', /^\d+\.\d+(\.\d+)?$/.test(pkg.version), pkg.version);
// One home for the version: CMake reads package.json, so the app, its
// installers and the release tag cannot disagree.
check('CMake takes its version from package.json',
  /string\(JSON CLOSENI_PACKAGE_VERSION GET \$\{CLOSENI_PACKAGE_JSON\} version\)/.test(read('native/CMakeLists.txt')) &&
  /project\(CloseNI VERSION \$\{CLOSENI_PACKAGE_VERSION\}/.test(read('native/CMakeLists.txt')));
check('linux deb has a maintainer', /^[^<>]+ <[^@\s<>]+@[^\s<>]+>$/.test(appMeta.maintainer || ''),
  appMeta.maintainer || 'MISSING — a .deb without a Maintainer field is refused by dpkg');
// stage.mjs copies only local-agent/dist and config (the unit suite pins
// that), and what actually lands in the stage is audited below, which is the
// stronger check.
check('the bundled Node is a 22 LTS pinned by checksum for every target',
  /^22\.\d+\.\d+$/.test(appMeta.node?.version || '') &&
  ['linux-x64.tar.gz', 'win-x64.zip', 'darwin-arm64.tar.gz', 'darwin-x64.tar.gz']
    .every((k) => /^[0-9a-f]{64}$/.test(appMeta.node?.sha256?.[k] || '')), appMeta.node?.version);
check('packaging tools are downloaded over https and pinned by checksum',
  Object.values(appMeta.tools || {}).length > 0 &&
  Object.values(appMeta.tools).every((t) => /^https:\/\//.test(t.url) && /^[0-9a-f]{64}$/.test(t.sha256)));

const wf = read('.github/workflows/release.yml');
// The jobs, split on their two-space-indented keys under `jobs:`.
const jobs = Object.fromEntries((wf.split(/^jobs:\n/m)[1] || '').split(/^(?=  [a-z][\w-]*:\n)/m)
  .map((j) => [(j.match(/^  ([a-z][\w-]*):/) || [])[1], j]).filter(([k]) => k));
check('release workflow checks the tag against package.json', /does not match package.json version/.test(wf));
check('installers are built for windows, linux and both macs',
  ['linux-x64', 'win-x64', 'mac-arm64', 'mac-x64'].every((t) => new RegExp(`target: ${t}\\b`).test(jobs.package || '')));
// The build jobs only upload artifacts and one job publishes after them all,
// so no two jobs race to create the release.
check('one job publishes, after every installer is built',
  /needs: package\b/.test(jobs.publish || '') && (wf.match(/gh release create/g) || []).length === 1 &&
  !/gh release/.test(jobs.package || ''), Object.keys(jobs).join(', '));
check('publish is a draft', /gh release create [^\n]*--draft/.test(jobs.publish || ''));
check('only the publish job can write to the repository',
  /^permissions:\n\s+contents: read/m.test(wf) && /contents: write/.test(jobs.publish || '') &&
  (wf.match(/contents: write/g) || []).length === 1);
// Compare the executed `run:` lines, not any mention, so prose in a comment
// cannot make this pass or fail.
const runLines = (j) => [...(j || '').matchAll(/^\s*run:\s*(.+)$/gm)].map((m) => m[1]);
check('release workflow runs unit tests before packaging',
  runLines(jobs.test).some((l) => l.includes('run-tests.cjs')) && /needs: test\b/.test(jobs.package || '') &&
  runLines(jobs.package).some((l) => l.includes('native/package/stage.mjs --installers')));

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
  // The native app as native/package/stage.mjs staged it (npm run pack): the
  // AppDir, CloseNI.app or install directory the installers are made from.
  // The stage itself is walked, for what the native app needs and for what
  // must never ship.
  const manifestFile = 'dist/native/stage.json';
  if (!existsSync(join(ROOT, manifestFile))) {
    check('a packaged build exists to audit', false, 'run `npm run pack` first');
  } else {
    const m = JSON.parse(read(manifestFile));
    const stage = join(ROOT, m.stage);
    const res = join(ROOT, m.resources);
    const walk = (dir) => readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return lstatSync(p).isDirectory() ? walk(p) : [p];
    });
    const files = existsSync(stage) ? walk(stage).map((p) => p.slice(stage.length + 1).split('\\').join('/')) : [];
    const resRel = res.slice(stage.length + 1).split('\\').join('/');
    const inRes = (p) => (resRel ? resRel + '/' : '') + p;
    check('the stage exists', files.length > 0, m.stage);
    check('the stage is this version', m.version === pkg.version, `${m.version} vs ${pkg.version}`);

    const leaked = files.filter((f) => /(^|\/)(storage|browser-profiles|\.git)\/|sessions\.json|last-chat-url|(^|\/)\.env(\.|$)/.test(f));
    check('no session data, .env or .git in the artifact', leaked.length === 0, leaked.slice(0, 5).join(', '));
    check('no source maps or type declarations', !files.some((f) => /\.(map|d\.[cm]?ts)$/.test(f)),
      files.filter((f) => /\.(map|d\.[cm]?ts)$/.test(f)).slice(0, 3).join(', '));
    check('only the agent\'s dist, config and runtime packages are shipped',
      files.filter((f) => f.startsWith(inRes('local-agent/')))
        .every((f) => /^(dist|config|node_modules)\/|^package\.json$/.test(f.slice(inRes('local-agent/').length))));

    for (const need of ['local-agent/dist/index.js', 'local-agent/package.json', 'local-agent/node_modules/playwright/cli.js']) {
      check(`artifact contains ${need}`, files.includes(inRes(need)));
    }
    check('artifact contains the provider configs', files.some((f) => f.startsWith(inRes('local-agent/config/providers/')) && f.endsWith('.json')));
    check('artifact contains the app', existsSync(join(ROOT, m.executable)), m.executable);
    check('artifact contains Node', existsSync(join(ROOT, m.node.path)), m.node.path);
    check('the bundled Node is 22', /^22\./.test(m.node.version) && m.node.version === appMeta.node.version, m.node.version);
    const host = { linux: 'linux-x64', win32: 'win-x64', darwin: process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64' }[process.platform];
    if (m.target === host) {
      let said = '';
      try { said = sh(join(ROOT, m.node.path), ['--version']).trim(); } catch (e) { said = String(e.message).slice(0, 100); }
      check('and it runs', said === `v${m.node.version}`, said);
    }

    // Exactly the packages the agent needs at run time, resolved from its own
    // package.json the way Node resolves them, and nothing it requires missing.
    const agentPkg = JSON.parse(read('local-agent/package.json'));
    const closure = new Set();
    const queue = Object.keys(agentPkg.dependencies || {}).filter((d) => !d.startsWith('@agentic/'));
    while (queue.length) {
      const name = queue.shift();
      if (closure.has(name)) continue;
      const dir = ['local-agent/node_modules/' + name, 'node_modules/' + name].find((d) => existsSync(join(ROOT, d, 'package.json')));
      if (!dir) continue;
      closure.add(name);
      const meta = JSON.parse(read(dir + '/package.json'));
      queue.push(...Object.keys(meta.dependencies || {}));
      queue.push(...Object.keys(meta.optionalDependencies || {}).filter((o) => existsSync(join(ROOT, 'node_modules', o))));
    }
    const modulesDir = join(res, 'local-agent', 'node_modules');
    const shipped = existsSync(modulesDir) ? readdirSync(modulesDir).flatMap((n) => n.startsWith('@')
      ? readdirSync(join(modulesDir, n)).map((s) => n + '/' + s) : [n]).sort() : [];
    check('node_modules is exactly the agent\'s runtime closure', JSON.stringify(shipped) === JSON.stringify([...closure].sort()),
      `shipped ${shipped.join(' ')}; needed ${[...closure].sort().join(' ')}`);
    const required = new Set();
    for (const f of files.filter((p) => p.startsWith(inRes('local-agent/dist/')) && p.endsWith('.js'))) {
      for (const r of readFileSync(join(stage, f), 'utf8').matchAll(/require\("([^".][^"]*)"\)/g)) {
        const id = r[1].replace(/^node:/, '');
        required.add(id.startsWith('@') ? id.split('/').slice(0, 2).join('/') : id.split('/')[0]);
      }
    }
    const builtin = new Set(builtinModules);
    const unmet = [...required].filter((n) => !builtin.has(n) && !shipped.includes(n));
    check('everything the agent requires is shipped', unmet.length === 0, unmet.join(', '));

    // Lightweight by construction: Qt Quick's Basic style only, no web engine,
    // no translations, no software OpenGL fallback.
    check('Qt Quick Controls\' Basic style is shipped', files.some((f) => /\/qml\/QtQuick\/Controls\/Basic\/qmldir$/.test('/' + f)));
    const otherStyles = files.filter((f) => /\/QtQuick\/Controls\/(Material|Universal|Fusion|Imagine|FluentWinUI3|Windows|macOS|iOS)\//.test('/' + f));
    check('no other Qt Quick Controls style', otherStyles.length === 0, otherStyles.slice(0, 3).join(', '));
    const web = files.filter((f) => /webengine|webview|webchannel/i.test(f));
    check('no web engine or web view', web.length === 0, web.slice(0, 3).join(', '));
    check('no translations', !files.some((f) => /\.qm$/.test(f) || /(^|\/)translations\//.test(f)));
    check('no software OpenGL', !files.some((f) => /opengl32sw\.dll$/i.test(f)));
    check('a platform plugin is shipped', files.some((f) => /platforms\/(libqxcb\.so|qwindows\.dll|libqcocoa\.dylib)$/.test(f)));
    // The file and folder pickers (QtQuick.Dialogs) load these at run time;
    // without them a dialog fails only when someone opens it. The qml/assets
    // textures need no check: they are compiled into the executable.
    for (const p of ['qtquickdialogsplugin', 'qtquickdialogs2quickimplplugin']) {
      check(`QtQuick.Dialogs plugin ${p} is shipped`, files.some((f) => new RegExp(`(^|/)(lib)?${p}\\.(so|dll|dylib)$`).test(f)));
    }
    // Lightweight is a requirement: the unpacked app stays under 283 MB.
    check('the stage is under 283 MB', m.bytes < 283 * 1048576,
      `${(m.bytes / 1048576).toFixed(1)} MB`);
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

    · The Windows installer and the macOS disk images. No Windows or Mac
      here; the first .exe and .dmg the release workflow builds are
      unverified until someone installs them. The packaging audit above
      covers only the stage built on this machine.
    · Qwen and GLM are selectable as experimental, not verified. Qwen's 300s
      completion wait has not been re-run live with a build-sized prompt;
      GLM's live site declined the build prompts when last tried. Only
      DeepSeek has been driven end to end.
    · GitHub sign-in, push, clone and Actions against a real token. Tested
      with an injected transport, never over the network.
    · MCP against servers other than the reference one. Interop IS verified -
      'npm run mcp:interop' passes against @modelcontextprotocol/server-everything,
      which uses the official SDK - but that is one implementation, and the
      check is opt-in because it needs the network.
    · Whether generated projects behave in general. One three-step build was
      run against DeepSeek on 11 August and its output verified by hand - it
      ran and printed the right answer - but that is a single sample, and the
      automated checks still only prove code parses and compiles.
${'-'.repeat(W)}
`);

process.exit(fail === 0 ? 0 : 1);
