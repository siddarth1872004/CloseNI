#!/usr/bin/env node
/*
 * Builds the native app and stages everything a package ships, then (with
 * --installers) makes the installers.
 *
 *   node native/package/stage.mjs                 stage for this machine (npm run pack)
 *   node native/package/stage.mjs --installers    and make the installers
 *
 * Options:
 *   --target linux-x64 | win-x64 | mac-arm64 | mac-x64   (default: this machine)
 *   --exe PATH    package this built executable (or .app) instead of building
 *
 * Output, all under dist/native/ (gitignored):
 *   build-<target>/   the CMake build
 *   <target>/         the staged app: Linux AppDir/, Windows CloseNI/, macOS CloseNI.app
 *   downloads/        Node and the Linux packaging tools, each checked against
 *                     the SHA-256 pinned in app.json
 *   out/              CloseNI-<v>.AppImage, closeni_<v>_amd64.deb,
 *                     CloseNI-Setup-<v>.exe, CloseNI-<v>-<arch>.dmg
 *   stage.json        what was staged, for scripts/verify.mjs to audit
 *
 * What a package holds, and why so little:
 *   - The app, and only the Qt it uses: the Basic style (main.cpp sets it),
 *     the QML modules the app's imports reach, and a short list of plugins
 *     (PLUGINS below). No translations (the UI is English only), no software
 *     OpenGL, no QML tooling, no web engine.
 *   - The official Node 22 binary and its licence. Nothing else from Node: the
 *     agent never runs npm.
 *   - local-agent/dist and config, and the node_modules the agent requires at
 *     run time (playwright and playwright-core), without type declarations,
 *     source maps or READMEs.
 *   - Not Chromium. The app downloads it on first run into
 *     <storage>/browsers, which AgentService points PLAYWRIGHT_BROWSERS_PATH at.
 *
 * Paths.cpp looks for node/ and local-agent/ in the resources directory: next
 * to the executable on Windows and Linux, Contents/Resources on macOS.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, closeSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync,
  readSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { builtinModules } from 'node:module';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const APP = JSON.parse(readFileSync(join(HERE, 'app.json'), 'utf8'));
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const OUT = join(ROOT, 'dist', 'native');

// ------------------------------------------------------------- arguments ----

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const INSTALLERS = args.includes('--installers');
const HOST_TARGET = { linux: 'linux-x64', win32: 'win-x64', darwin: process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64' }[process.platform];
const TARGET = opt('--target') || HOST_TARGET;
const OS = TARGET.split('-')[0];
const ARCH = TARGET.split('-')[1];
if (!['linux-x64', 'win-x64', 'mac-arm64', 'mac-x64'].includes(TARGET)) die(`unknown target ${TARGET}`);
if (OS !== { linux: 'linux', win32: 'win', darwin: 'mac' }[process.platform]) die(`${TARGET} has to be packaged on its own system`);

// -------------------------------------------------------------- helpers ----

function die(msg) { console.error(`stage: ${msg}`); process.exit(1); }
function step(msg) { console.log(`\n== ${msg}`); }

function run(cmd, argv, opts = {}) {
  console.log(`$ ${cmd} ${argv.join(' ')}`);
  const r = spawnSync(cmd, argv, { stdio: 'inherit', ...opts });
  if (r.error) die(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) die(`${cmd} exited with ${r.status}`);
}
const out = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const have = (cmd) => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).error === undefined;

/** Every file (not directory) under dir, symlinks included, as absolute paths. */
function walk(dir, list = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isDirectory()) walk(p, list); else list.push(p);
  }
  return list;
}

function removeEmptyDirs(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (lstatSync(p).isDirectory()) removeEmptyDirs(p);
  }
  if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
}

function bytes(path) {
  const st = lstatSync(path);
  if (!st.isDirectory()) return st.size;
  return readdirSync(path).reduce((n, name) => n + bytes(join(path, name)), 0);
}
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

function magic(file) {
  try {
    const st = lstatSync(file);
    if (!st.isFile() || st.size < 4) return '';
    const head = Buffer.alloc(4);
    const fd0 = openSync(file, 'r');
    try { readSync(fd0, head, 0, 4, 0); } finally { closeSync(fd0); }
    const fd = head.toString('hex');
    if (fd === '7f454c46') return 'elf';
    if (fd.startsWith('4d5a')) return 'pe';
    if (['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca'].includes(fd)) return 'macho';
  } catch { /* unreadable: not a binary we handle */ }
  return '';
}

// ------------------------------------------------------------ downloads ----

async function download(url, file) {
  console.log(`download ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) die(`${url}: HTTP ${res.status}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

/**
 * A file from the internet, kept in dist/native/downloads/ and used only once
 * its SHA-256 matches the one pinned in app.json. A changed pin downloads
 * again; a mismatch deletes the file and stops.
 */
async function fetchPinned(url, pin, name = basename(new URL(url).pathname)) {
  if (!/^[0-9a-f]{64}$/.test(pin || '')) die(`no SHA-256 pinned for ${url}`);
  const dir = join(OUT, 'downloads');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  if (!existsSync(file) || sha256(file) !== pin) {
    await download(url, file);
    const got = sha256(file);
    if (got !== pin) { rmSync(file); die(`${name}: SHA-256 ${got} is not the pinned ${pin}`); }
  }
  return file;
}

/** Entries of a .tar.gz, read in memory: name -> { data, mode }. */
function untar(buf, wanted) {
  const tar = zlib.gunzipSync(buf);
  const found = {};
  let longName = null;
  for (let pos = 0; pos + 512 <= tar.length;) {
    const h = tar.subarray(pos, pos + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => h.toString('latin1', a, b).replace(/\0.*$/s, '');
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    const data = tar.subarray(pos + 512, pos + 512 + size);
    let name = longName || (str(345, 500) ? str(345, 500) + '/' : '') + str(0, 100);
    longName = null;
    if (type === 'L') longName = data.toString('latin1').replace(/\0.*$/s, '');
    else if (type === 'x') {
      const m = data.toString('utf8').match(/\d+ path=([^\n]*)\n/);
      if (m) longName = m[1];
    } else if ((type === '0' || type === '\0') && wanted(name)) {
      found[name] = { data: Buffer.from(data), mode: parseInt(str(100, 108).trim() || '644', 8) };
    }
    pos += 512 + Math.ceil(size / 512) * 512;
  }
  return found;
}

/** Entries of a .zip, read in memory: name -> { data }. */
function unzip(buf, wanted) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) die('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const found = {};
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) die('bad zip central directory');
    const method = buf.readUInt16LE(pos + 10);
    const csize = buf.readUInt32LE(pos + 20);
    const nlen = buf.readUInt16LE(pos + 28), elen = buf.readUInt16LE(pos + 30), clen = buf.readUInt16LE(pos + 32);
    const local = buf.readUInt32LE(pos + 42);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nlen);
    if (wanted(name)) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const raw = buf.subarray(start, start + csize);
      if (method !== 0 && method !== 8) die(`zip entry ${name} uses compression method ${method}`);
      found[name] = { data: method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw), mode: 0o755 };
    }
    pos += 46 + nlen + elen + clen;
  }
  return found;
}

/**
 * The official Node binary for the target, checked twice: against the hash
 * pinned in app.json, and against the release's SHASUMS256.txt.
 */
async function stageNode(res) {
  const v = APP.node.version;
  const plat = { 'linux-x64': 'linux-x64.tar.gz', 'win-x64': 'win-x64.zip', 'mac-arm64': 'darwin-arm64.tar.gz', 'mac-x64': 'darwin-x64.tar.gz' }[TARGET];
  const name = `node-v${v}-${plat}`;
  const file = await fetchPinned(`https://nodejs.org/dist/v${v}/${name}`, APP.node.sha256[plat]);
  const sums = join(OUT, 'downloads', `node-v${v}-SHASUMS256.txt`);
  if (!existsSync(sums)) await download(`https://nodejs.org/dist/v${v}/SHASUMS256.txt`, sums);
  const listed = readFileSync(sums, 'utf8').split('\n').find((l) => l.endsWith(`  ${name}`));
  if (!listed || listed.split(/\s+/)[0] !== APP.node.sha256[plat]) die(`${name} is not listed in SHASUMS256.txt with the pinned hash`);

  const top = name.replace(/\.(tar\.gz|zip)$/, '');
  const bin = OS === 'win' ? `${top}/node.exe` : `${top}/bin/node`;
  const want = (n) => n === bin || n === `${top}/LICENSE`;
  const entries = plat.endsWith('.zip') ? unzip(readFileSync(file), want) : untar(readFileSync(file), want);
  if (!entries[bin] || !entries[`${top}/LICENSE`]) die(`${name} lacks ${bin} or LICENSE`);
  const dest = join(res, 'node');
  const exe = OS === 'win' ? join(dest, 'node.exe') : join(dest, 'bin', 'node');
  mkdirSync(dirname(exe), { recursive: true });
  writeFileSync(exe, entries[bin].data);
  chmodSync(exe, 0o755);
  // The Linux build carries its symbol table (17 MB). Its dynamic symbols,
  // which native addons link against, stay. The macOS binary is left alone
  // because stripping would break Node's own signature.
  if (OS === 'linux') run('strip', ['--strip-unneeded', exe]);
  writeFileSync(join(dest, 'LICENSE'), entries[`${top}/LICENSE`].data);
  return exe;
}

// ---------------------------------------------------------------- build ----

function qtQuery() {
  const tools = [process.env.QT_ROOT_DIR && join(process.env.QT_ROOT_DIR, 'bin', 'qtpaths'), 'qtpaths6', 'qtpaths', 'qmake6', 'qmake'].filter(Boolean);
  for (const tool of tools) {
    try {
      const text = out(tool, ['-query']);
      const q = {};
      for (const line of text.split(/\r?\n/)) { const i = line.indexOf(':'); if (i > 0) q[line.slice(0, i)] = line.slice(i + 1); }
      if (q.QT_INSTALL_QML) return q;
    } catch { /* try the next tool */ }
  }
  die('Qt was not found: put its bin/ on PATH or set QT_ROOT_DIR');
}

function build() {
  const dir = join(OUT, `build-${TARGET}`);
  const cfg = ['-S', join(ROOT, 'native'), '-B', dir, '-DCMAKE_BUILD_TYPE=Release', '-DCLOSENI_TESTS=OFF'];
  if (OS !== 'win' && have('ninja')) cfg.push('-G', 'Ninja');
  if (OS === 'mac') cfg.push(`-DCMAKE_OSX_ARCHITECTURES=${ARCH === 'arm64' ? 'arm64' : 'x86_64'}`);
  run('cmake', cfg);
  run('cmake', ['--build', dir, '--config', 'Release', '--parallel']);
  const cache = readFileSync(join(dir, 'CMakeCache.txt'), 'utf8');
  const cmakeVersion = (cache.match(/^CMAKE_PROJECT_VERSION:STATIC=(.*)$/m) || [])[1];
  if (cmakeVersion !== VERSION) die(`CMake built ${cmakeVersion}, package.json says ${VERSION}`);
  const candidates = OS === 'win' ? [join(dir, 'bin', 'Release', 'CloseNI.exe'), join(dir, 'bin', 'CloseNI.exe')]
    : OS === 'mac' ? [join(dir, 'bin', 'CloseNI.app')] : [join(dir, 'bin', 'CloseNI')];
  const exe = candidates.find((p) => existsSync(p));
  if (!exe) die(`the build produced none of ${candidates.join(', ')}`);
  return exe;
}

// ---------------------------------------------------------------- Qt -------

/*
 * Plugins kept, by type. Everything else the deploy tools copy is removed:
 * other image formats (AVIF, TIFF, WebP and the codec libraries they pull in),
 * iconengines and styles (Widgets only), generic input (eglfs only),
 * networkinformation and qmltooling (unused).
 */
const PLUGINS = {
  linux: {
    // xcb works everywhere; Wayland is native where it runs; offscreen is for
    // headless checks (QT_QPA_PLATFORM=offscreen).
    platforms: ['libqxcb.so', 'libqwayland.so', 'libqwayland-egl.so', 'libqwayland-generic.so', 'libqoffscreen.so'],
    xcbglintegrations: '*',
    'wayland-shell-integration': ['libxdg-shell.so'],
    'wayland-decoration-client': '*',
    'wayland-graphics-integration-client': ['libqt-plugin-wayland-egl.so'],
    // Dead keys and the compose key, and IBus for input methods (CJK).
    platforminputcontexts: ['libcomposeplatforminputcontextplugin.so', 'libibusplatforminputcontextplugin.so'],
    // Native file and folder dialogs through the desktop portal.
    platformthemes: ['libqxdgdesktopportal.so'],
    imageformats: ['libqsvg.so', 'libqjpeg.so', 'libqgif.so'],
    // HTTPS for the GitHub API.
    tls: '*',
  },
  win: {
    platforms: ['qwindows.dll'],
    imageformats: ['qsvg.dll', 'qjpeg.dll', 'qgif.dll', 'qico.dll'],
    tls: '*',
  },
  mac: {
    platforms: ['libqcocoa.dylib'],
    imageformats: ['libqsvg.dylib', 'libqjpeg.dylib', 'libqgif.dylib', 'libqico.dylib'],
    tls: '*',
  },
}[OS];

/**
 * The QML modules the app can load: its own imports, then whatever those
 * modules depend on or import, read from their qmldir and QML files in the Qt
 * install. Optional imports (the other Controls styles) are not followed, and
 * neither are `+Style` file selector directories: main.cpp fixes the style
 * to Basic.
 */
function qmlModules(qmlRoot) {
  const importRe = /^\s*import\s+([A-Za-z_][\w.]*)/gm;
  const queue = ['QtQuick.Controls.Basic'];
  for (const f of walk(join(ROOT, 'native', 'qml')).filter((p) => /\.qml$/.test(p))) {
    for (const m of readFileSync(f, 'utf8').matchAll(importRe)) queue.push(m[1]);
  }
  const keep = new Set();
  while (queue.length) {
    const name = queue.shift();
    if (keep.has(name)) continue;
    const dir = join(qmlRoot, ...name.split('.'));
    if (!existsSync(join(dir, 'qmldir'))) continue; // CloseNI itself is compiled in
    keep.add(name);
    for (const line of readFileSync(join(dir, 'qmldir'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^(?:depends|import|default import)\s+(\S+)/);
      if (m) queue.push(m[1]);
    }
    const scan = (d) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (lstatSync(p).isDirectory()) { if (!f.startsWith('+') && !existsSync(join(p, 'qmldir'))) scan(p); }
        else if (/\.(qml|js|mjs)$/.test(f)) for (const m of readFileSync(p, 'utf8').matchAll(importRe)) queue.push(m[1]);
      }
    };
    scan(dir);
  }
  return [...keep].sort();
}

const isPlugin = (f) => /\.(so|dll|dylib)$/.test(f);

/*
 * The deployed copy of a QML module needs only its qmldir and plugin: every
 * module in the set says `prefer :/qt-project.org/...`, so its QML files load
 * from the plugin's resources. .qmltypes and designer/ are for tools.
 */
function copyQmlModules(qmlRoot, dest, modules) {
  for (const name of modules) {
    const from = join(qmlRoot, ...name.split('.'));
    const to = join(dest, ...name.split('.'));
    const qmldir = readFileSync(join(from, 'qmldir'), 'utf8');
    if (!/^prefer :\//m.test(qmldir)) die(`${name} does not load its QML from resources; staging needs its files too`);
    mkdirSync(to, { recursive: true });
    copyFileSync(join(from, 'qmldir'), join(to, 'qmldir'));
    for (const f of readdirSync(from)) {
      if (isPlugin(f) && !f.endsWith('.dSYM') && lstatSync(join(from, f)).isFile()) copyFileSync(join(from, f), join(to, f));
    }
  }
}

/** Removes QML modules outside the set from a tree a deploy tool filled, and their tooling files. */
function pruneQml(dest, modules) {
  if (!existsSync(dest)) return;
  const keep = new Set(modules.map((m) => join(dest, ...m.split('.'))));
  const visit = (dir) => {
    const isModule = existsSync(join(dir, 'qmldir'));
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (lstatSync(p).isDirectory()) visit(p);
      else if (!(isModule && keep.has(dir) && (f === 'qmldir' || isPlugin(f)))) rmSync(p);
    }
  };
  visit(dest);
  removeEmptyDirs(dest);
}

function selectPlugins(pluginRoot, dest) {
  for (const [type, names] of Object.entries(PLUGINS)) {
    const from = join(pluginRoot, type);
    if (!existsSync(from)) continue;
    const files = readdirSync(from).filter((f) => isPlugin(f) && (names === '*' || names.includes(f)));
    for (const f of files) {
      mkdirSync(join(dest, type), { recursive: true });
      copyFileSync(join(from, f), join(dest, type, f));
    }
  }
}

function prunePlugins(dest) {
  if (!existsSync(dest)) return;
  for (const type of readdirSync(dest)) {
    const names = PLUGINS[type];
    const dir = join(dest, type);
    for (const f of readdirSync(dir)) {
      if (!names || !(names === '*' || names.includes(f))) rmSync(join(dir, f), { recursive: true });
    }
  }
  removeEmptyDirs(dest);
}

// ---------------------------------------------------------------- agent ----

const JUNK_ANYWHERE = /\.(d\.ts|d\.mts|d\.cts|map)$/;
const JUNK_AT_PACKAGE_ROOT = /^(readme|changelog|history)(\.[a-z]+)?$/i;

/**
 * The agent and the packages it requires at run time. @agentic/shared is
 * types only, so it is not shipped, and the compiled agent is checked not to
 * require it or anything else outside the set.
 */
function stageAgent(res) {
  const src = join(ROOT, 'local-agent');
  if (!existsSync(join(src, 'dist', 'index.js'))) die('local-agent/dist is missing: run `npm run build` first');
  const dest = join(res, 'local-agent');
  cpSync(join(src, 'dist'), join(dest, 'dist'), { recursive: true, filter: (p) => !JUNK_ANYWHERE.test(p) });
  cpSync(join(src, 'config'), join(dest, 'config'), { recursive: true });

  const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
  const deps = Object.keys(pkg.dependencies || {}).filter((d) => !d.startsWith('@agentic/'));
  writeFileSync(join(dest, 'package.json'), JSON.stringify({
    name: pkg.name, version: VERSION, private: true, main: pkg.main,
    dependencies: Object.fromEntries(deps.map((d) => [d, pkg.dependencies[d]])),
  }, null, 2) + '\n');

  // The dependency closure, resolved the way Node would from local-agent/.
  const shipped = new Map();
  const resolvePkg = (name) => [join(src, 'node_modules', name), join(ROOT, 'node_modules', name)].find((d) => existsSync(join(d, 'package.json')));
  const queue = [...deps];
  while (queue.length) {
    const name = queue.shift();
    if (shipped.has(name)) continue;
    const dir = resolvePkg(name);
    if (!dir) die(`${name} is required by the agent but not installed: run npm ci`);
    shipped.set(name, dir);
    const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    queue.push(...Object.keys(meta.dependencies || {}));
    for (const o of Object.keys(meta.optionalDependencies || {})) if (resolvePkg(o)) queue.push(o);
  }

  const builtins = new Set(builtinModules);
  const required = new Set();
  for (const f of walk(join(dest, 'dist')).filter((p) => p.endsWith('.js'))) {
    for (const m of readFileSync(f, 'utf8').matchAll(/require\("([^".][^"]*)"\)/g)) {
      const id = m[1].replace(/^node:/, '');
      const name = id.startsWith('@') ? id.split('/').slice(0, 2).join('/') : id.split('/')[0];
      if (!builtins.has(name)) required.add(name);
    }
  }
  const missing = [...required].filter((n) => !shipped.has(n));
  if (missing.length) die(`the agent requires ${missing.join(', ')}, which is not shipped`);

  for (const [name, dir] of shipped) {
    cpSync(dir, join(dest, 'node_modules', name), {
      recursive: true,
      filter: (p) => !JUNK_ANYWHERE.test(p) && !(dirname(p) === dir && JUNK_AT_PACKAGE_ROOT.test(basename(p))),
    });
  }
  removeEmptyDirs(join(dest, 'node_modules'));
  return [...shipped.keys()].sort();
}

// ---------------------------------------------------------------- Linux ----

function linuxTools() {
  const env = { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1', NO_STRIP: '1', TMPDIR: mkTmp() };
  return env;
}
function mkTmp() { const d = join(OUT, 'tmp'); mkdirSync(d, { recursive: true }); return d; }

async function deployLinux(exe, stageRoot, qt) {
  const appDir = join(stageRoot, 'AppDir');
  const usr = join(appDir, 'usr');
  const modules = qmlModules(qt.QT_INSTALL_QML);
  selectPlugins(qt.QT_INSTALL_PLUGINS, join(usr, 'plugins'));
  copyQmlModules(qt.QT_INSTALL_QML, join(usr, 'qml'), modules);

  // linuxdeploy copies the executable and every library the executable, the
  // plugins and the QML plugins need (minus the system ones on its exclude
  // list) into usr/lib. Its own strip is too old for current toolchains, so it
  // is off and stripping happens below.
  const linuxdeploy = await fetchPinned(APP.tools.linuxdeploy.url, APP.tools.linuxdeploy.sha256);
  chmodSync(linuxdeploy, 0o755);
  const icon = join(mkTmp(), 'closeni.png');
  copyFileSync(join(ROOT, 'build', 'icon.png'), icon);
  const plugins = walk(join(usr, 'plugins')).concat(walk(join(usr, 'qml'))).filter((p) => magic(p) === 'elf');
  run(linuxdeploy, ['--appdir', appDir, '--executable', exe, '--desktop-file', join(HERE, 'closeni.desktop'), '--icon-file', icon,
    ...plugins.flatMap((p) => ['--deploy-deps-only', p])], { env: linuxTools() });
  // It points those files' RUNPATH at the AppDir's root rather than usr/lib,
  // so set it here.
  for (const p of plugins) run('patchelf', ['--set-rpath', `$ORIGIN/${relative(dirname(p), join(usr, 'lib'))}`, p]);

  // Relative to usr/bin, so the same tree works as the AppImage and as /opt/CloseNI.
  writeFileSync(join(usr, 'bin', 'qt.conf'), '[Paths]\nPrefix = ..\nLibraries = lib\nPlugins = plugins\nQmlImports = qml\n');
  for (const f of walk(appDir).filter((p) => magic(p) === 'elf')) run('strip', ['--strip-unneeded', f]);
  if (!existsSync(join(appDir, 'AppRun'))) symlinkSync('usr/bin/CloseNI', join(appDir, 'AppRun'));
  return { appDir, res: join(usr, 'bin'), exe: join(usr, 'bin', 'CloseNI'), modules };
}

/**
 * Every ELF file in the tree loads, and loads the bundled Qt: a library that
 * is not found, or a Qt library from the system, fails the stage. Returns
 * the system libraries in use, for the .deb's Depends.
 */
function checkLinuxLibs(appDir) {
  const system = new Set();
  const problems = [];
  const env = { ...process.env };
  delete env.LD_LIBRARY_PATH;
  for (const f of walk(appDir).filter((p) => magic(p) === 'elf')) {
    let text;
    try { text = out('ldd', [f], { env }); } catch (e) { text = String(e.stdout || ''); }
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*(\S+) => (.*?) \(0x/);
      if (/not found/.test(line)) problems.push(`${relative(appDir, f)}: ${line.trim()}`);
      else if (m && m[2] && !m[2].startsWith(appDir)) {
        if (/libQt6/.test(m[1])) problems.push(`${relative(appDir, f)} loads the system's ${m[2]}`);
        else system.add(m[2]);
      }
    }
  }
  if (problems.length) die(`library check failed:\n  ${[...new Set(problems)].join('\n  ')}`);
  return [...system].sort();
}

async function appImage(appDir) {
  const tool = await fetchPinned(APP.tools.appimagetool.url, APP.tools.appimagetool.sha256);
  const runtime = await fetchPinned(APP.tools['appimage-runtime'].url, APP.tools['appimage-runtime'].sha256);
  chmodSync(tool, 0o755);
  const file = join(OUT, 'out', `CloseNI-${VERSION}.AppImage`);
  rmSync(file, { force: true });
  run(tool, ['--no-appstream', '--runtime-file', runtime, '--comp', 'zstd', '--mksquashfs-opt', '-Xcompression-level', '--mksquashfs-opt', '19', appDir, file],
    { env: { ...linuxTools(), ARCH: 'x86_64' } });
  return file;
}

/** A Unix ar archive, the container format of a .deb. */
function ar(members) {
  const parts = [Buffer.from('!<arch>\n')];
  for (const [name, data] of members) {
    const h = `${name.padEnd(16)}${'0'.padEnd(12)}${'0'.padEnd(6)}${'0'.padEnd(6)}${'100644'.padEnd(8)}${String(data.length).padEnd(10)}\`\n`;
    parts.push(Buffer.from(h, 'latin1'), data);
    if (data.length % 2) parts.push(Buffer.from('\n'));
  }
  return Buffer.concat(parts);
}

/*
 * The .deb installs the AppDir's usr/ tree as /opt/CloseNI. /usr/bin/closeni
 * is a link that postinst makes and postrm removes.
 */
function deb(appDir, systemLibs) {
  const tmp = join(OUT, 'tmp', 'deb');
  rmSync(tmp, { recursive: true, force: true });
  const root = join(tmp, 'root');
  const opt = join(root, 'opt', 'CloseNI');
  for (const d of ['bin', 'lib', 'plugins', 'qml']) {
    if (existsSync(join(appDir, 'usr', d))) cpSync(join(appDir, 'usr', d), join(opt, d), { recursive: true, verbatimSymlinks: true });
  }
  const share = join(root, 'usr', 'share');
  mkdirSync(join(share, 'applications'), { recursive: true });
  writeFileSync(join(share, 'applications', 'closeni.desktop'),
    readFileSync(join(HERE, 'closeni.desktop'), 'utf8').replace(/^Exec=.*$/m, 'Exec=/opt/CloseNI/bin/CloseNI'));
  const icons = join(appDir, 'usr', 'share', 'icons');
  if (existsSync(icons)) cpSync(icons, join(share, 'icons'), { recursive: true });
  mkdirSync(join(share, 'doc', APP.debName), { recursive: true });
  writeFileSync(join(share, 'doc', APP.debName, 'copyright'),
    `CloseNI is released under the MIT licence. Bundled components keep their own licences:\n` +
    `Qt (LGPL-3.0, see https://www.qt.io/licensing), Node.js (/opt/CloseNI/bin/node/LICENSE),\n` +
    `Playwright (Apache-2.0, /opt/CloseNI/bin/local-agent/node_modules/playwright/LICENSE).\n`);

  // Depends: the packages that own the system libraries the app loads, when
  // dpkg can say (on the Ubuntu runner), and a known list otherwise. The
  // browser libraries are Chromium's, which the app downloads on first run.
  let qtDeps = [];
  if (have('dpkg')) {
    const pkgs = new Set();
    for (const lib of systemLibs) {
      for (const p of [lib, realpath(lib)]) {
        try { pkgs.add(out('dpkg', ['-S', p]).split(':')[0].trim()); break; } catch { /* try the resolved path */ }
      }
    }
    qtDeps = [...pkgs].sort();
  }
  if (!qtDeps.length) qtDeps = ['libc6', 'libstdc++6', 'libgcc-s1', 'libgl1', 'libegl1', 'libfontconfig1', 'libfreetype6', 'libx11-6', 'libx11-xcb1', 'libxcb1', 'libglib2.0-0'];
  const depends = [...qtDeps, 'libnss3', 'libgbm1', 'libasound2 | libasound2t64', 'libgtk-3-0 | libgtk-3-0t64', 'xdg-utils'];

  const control = join(tmp, 'control');
  mkdirSync(control, { recursive: true });
  writeFileSync(join(control, 'control'), [
    `Package: ${APP.debName}`,
    `Version: ${VERSION}`,
    'Section: devel',
    'Priority: optional',
    'Architecture: amd64',
    `Maintainer: ${APP.maintainer}`,
    `Installed-Size: ${Math.ceil(bytes(root) / 1024)}`,
    `Depends: ${depends.join(', ')}`,
    'Recommends: libsecret-1-0',
    `Homepage: ${APP.homepage}`,
    `Description: ${APP.synopsis}`,
    ` ${APP.description}`,
    '',
  ].join('\n'));
  writeFileSync(join(control, 'postinst'), '#!/bin/sh\nset -e\nif [ "$1" = configure ]; then\n  ln -sf /opt/CloseNI/bin/CloseNI /usr/bin/closeni\n' +
    '  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q /usr/share/applications || true\n' +
    '  command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t /usr/share/icons/hicolor || true\nfi\n');
  writeFileSync(join(control, 'postrm'), '#!/bin/sh\nset -e\nif [ "$1" = remove ] || [ "$1" = purge ]; then\n' +
    '  if [ "$(readlink /usr/bin/closeni 2>/dev/null)" = /opt/CloseNI/bin/CloseNI ]; then rm -f /usr/bin/closeni; fi\nfi\n');
  chmodSync(join(control, 'postinst'), 0o755);
  chmodSync(join(control, 'postrm'), 0o755);

  const epoch = String(Math.floor(Date.now() / 1000));
  const tarArgs = ['--owner=0', '--group=0', '--numeric-owner', '--sort=name', `--mtime=@${process.env.SOURCE_DATE_EPOCH || epoch}`, '--mode=u+rwX,go+rX,go-w'];
  run('tar', [...tarArgs, '-cJf', join(tmp, 'control.tar.xz'), '-C', control, '.']);
  run('tar', [...tarArgs, '-cJf', join(tmp, 'data.tar.xz'), '-C', root, '.']);
  const file = join(OUT, 'out', `${APP.debName}_${VERSION}_amd64.deb`);
  writeFileSync(file, ar([['debian-binary', Buffer.from('2.0\n')], ['control.tar.xz', readFileSync(join(tmp, 'control.tar.xz'))],
    ['data.tar.xz', readFileSync(join(tmp, 'data.tar.xz'))]]));
  rmSync(tmp, { recursive: true, force: true });
  return file;
}

function realpath(p) { try { return out('readlink', ['-f', p]).trim(); } catch { return p; } }

// -------------------------------------------------------------- Windows ----

/** The DLL names a PE file imports, plain and delay-loaded. */
function peImports(file) {
  const b = readFileSync(file);
  const pe = b.readUInt32LE(0x3c);
  if (b.readUInt32LE(pe) !== 0x4550) return [];
  const sections = b.readUInt16LE(pe + 6);
  const optSize = b.readUInt16LE(pe + 20);
  const opt = pe + 24;
  const dirs = opt + (b.readUInt16LE(opt) === 0x20b ? 112 : 96);
  const secTable = opt + optSize;
  const toOff = (rva) => {
    for (let i = 0; i < sections; i++) {
      const s = secTable + i * 40;
      const va = b.readUInt32LE(s + 12), size = Math.max(b.readUInt32LE(s + 8), b.readUInt32LE(s + 16)), raw = b.readUInt32LE(s + 20);
      if (rva >= va && rva < va + size) return rva - va + raw;
    }
    return -1;
  };
  const cstr = (off) => b.toString('latin1', off, b.indexOf(0, off));
  const names = [];
  for (const [index, entry, nameAt] of [[1, 20, 12], [13, 32, 4]]) {
    const rva = b.readUInt32LE(dirs + index * 8);
    if (!rva) continue;
    for (let off = toOff(rva); off > 0; off += entry) {
      const nameRva = b.readUInt32LE(off + nameAt);
      if (!nameRva) break;
      const n = toOff(nameRva);
      if (n > 0) names.push(cstr(n).toLowerCase());
    }
  }
  return names;
}

function vcRuntimeDir() {
  try {
    const vswhere = join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    const vs = out(vswhere, ['-latest', '-products', '*', '-property', 'installationPath']).trim();
    const redist = join(vs, 'VC', 'Redist', 'MSVC');
    for (const v of readdirSync(redist).sort().reverse()) {
      const x64 = join(redist, v, 'x64');
      if (!existsSync(x64)) continue;
      const crt = readdirSync(x64).find((d) => /^Microsoft\.VC\d+\.CRT$/.test(d));
      if (crt) return join(x64, crt);
    }
  } catch { /* fall back to System32 */ }
  return join(process.env.SystemRoot || 'C:\\Windows', 'System32');
}

async function deployWindows(exe, stageRoot, qt) {
  const dir = join(stageRoot, 'CloseNI');
  mkdirSync(dir, { recursive: true });
  const staged = join(dir, 'CloseNI.exe');
  copyFileSync(exe, staged);
  const windeployqt = join(qt.QT_INSTALL_BINS, 'windeployqt.exe');
  const help = spawnSync(windeployqt, ['--help'], { encoding: 'utf8' }).stdout || '';
  // Flags this windeployqt does not know are left out rather than failing it.
  const flags = ['--release', '--qmldir', join(ROOT, 'native', 'qml')]
    .concat(['--no-translations', '--no-system-d3d-compiler', '--no-opengl-sw', '--no-compiler-runtime'].filter((f) => help.includes(f)));
  if (help.includes('--skip-plugin-types')) flags.push('--skip-plugin-types', 'qmltooling,generic,iconengines,networkinformation,styles');
  run(windeployqt, [...flags, staged]);

  const modules = qmlModules(qt.QT_INSTALL_QML);
  pruneQml(join(dir, 'qml'), modules);
  for (const type of readdirSync(dir)) {
    const p = join(dir, type);
    if (lstatSync(p).isDirectory() && type !== 'qml') prunePlugins2(dir, type);
  }
  removeTranslations(dir);

  // Keep the DLLs something loads, starting from the executable, the plugins
  // and the QML plugins; drop the rest (other styles' libraries, Pdf, ...).
  // The Visual C++ runtime comes from the Visual Studio redist, and anything
  // else not bundled must be part of Windows.
  const bundled = new Map(readdirSync(dir).filter((f) => /\.dll$/i.test(f)).map((f) => [f.toLowerCase(), join(dir, f)]));
  const roots = walk(dir).filter((p) => /\.(exe|dll)$/i.test(p) && dirname(p) !== dir).concat([staged]);
  const needed = new Set();
  const crt = vcRuntimeDir();
  const system32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const queue = [...roots];
  while (queue.length) {
    for (const name of peImports(queue.shift())) {
      if (needed.has(name)) continue;
      needed.add(name);
      if (!bundled.has(name) && /^(msvcp140|vcruntime140|concrt140)/.test(name)) {
        const from = [join(crt, name), join(system32, name)].find((p) => existsSync(p));
        if (!from) die(`the Visual C++ runtime ${name} was not found`);
        copyFileSync(from, join(dir, name));
        bundled.set(name, join(dir, name));
      }
      if (bundled.has(name)) queue.push(bundled.get(name));
      else if (!/^(api-ms-win-|ext-ms-win-)/.test(name) && !existsSync(join(system32, name))) die(`${name} is needed but neither bundled nor part of Windows`);
    }
  }
  for (const [name, p] of bundled) if (!needed.has(name)) { console.log(`drop ${name}`); rmSync(p); }
  return { res: dir, exe: staged, modules };
}

/** Windows keeps plugin types beside the executable rather than under plugins/. */
function prunePlugins2(dir, type) {
  const names = PLUGINS[type];
  const p = join(dir, type);
  for (const f of readdirSync(p)) if (!names || !(names === '*' || names.includes(f))) rmSync(join(p, f), { recursive: true });
  if (readdirSync(p).length === 0) rmSync(p, { recursive: true });
}

function removeTranslations(dir) {
  for (const f of walk(dir).filter((p) => /\.qm$/.test(p))) rmSync(f);
}

/** Install and uninstall lists for installer.nsi, one line per file. */
function nsisLists(dir) {
  const files = walk(dir).map((p) => relative(dir, p)).sort();
  const dirs = [...new Set(files.map((f) => dirname(f)).filter((d) => d !== '.'))];
  const allDirs = new Set();
  for (const d of dirs) for (let x = d; x !== '.'; x = dirname(x)) allDirs.add(x);
  const win = (p) => p.split(sep).join('\\').split('/').join('\\');
  const install = [];
  let current = null;
  for (const f of files) {
    const d = dirname(f) === '.' ? '' : `\\${win(dirname(f))}`;
    if (d !== current) { install.push(`SetOutPath "$INSTDIR${d}"`); current = d; }
    install.push(`File "${win(join(dir, f))}"`);
  }
  const uninstall = files.map((f) => `Delete "$INSTDIR\\${win(f)}"`)
    .concat([...allDirs].sort((a, b) => b.length - a.length).map((d) => `RMDir "$INSTDIR\\${win(d)}"`));
  writeFileSync(join(OUT, 'tmp', 'install-files.nsh'), install.join('\r\n') + '\r\n');
  writeFileSync(join(OUT, 'tmp', 'uninstall-files.nsh'), uninstall.join('\r\n') + '\r\n');
}

function nsis(dir) {
  mkTmp();
  nsisLists(dir);
  const candidates = ['makensis', join(process.env['ProgramFiles(x86)'] || '', 'NSIS', 'makensis.exe'), join(process.env.ProgramFiles || '', 'NSIS', 'makensis.exe')];
  const makensis = candidates.find((c) => spawnSync(c, ['/VERSION'], { stdio: 'ignore' }).status === 0);
  if (!makensis) die('makensis was not found: install NSIS (choco install nsis)');
  const file = join(OUT, 'out', `CloseNI-Setup-${VERSION}.exe`);
  // The file version resource takes four numbers and no pre-release suffix.
  const version4 = VERSION.replace(/[-+].*$/, '').split('.').concat(['0', '0', '0']).slice(0, 4).join('.');
  run(makensis, ['/V2', '/INPUTCHARSET', 'UTF8', `/DVERSION=${VERSION}`, `/DVERSION4=${version4}`, `/DOUTFILE=${file}`,
    `/DICON=${join(HERE, 'closeni.ico')}`, `/DFILES=${join(OUT, 'tmp', 'install-files.nsh')}`,
    `/DUNFILES=${join(OUT, 'tmp', 'uninstall-files.nsh')}`, `/DSIZE_KB=${Math.ceil(bytes(dir) / 1024)}`, join(HERE, 'installer.nsi')]);
  return file;
}

// ---------------------------------------------------------------- macOS ----

async function deployMac(appPath, stageRoot, qt) {
  const app = join(stageRoot, 'CloseNI.app');
  run('ditto', [appPath, app]);
  const macdeployqt = join(qt.QT_INSTALL_BINS, 'macdeployqt');
  run(macdeployqt, [app, `-qmldir=${join(ROOT, 'native', 'qml')}`, '-always-overwrite']);
  const contents = join(app, 'Contents');
  const modules = qmlModules(qt.QT_INSTALL_QML);
  pruneQml(join(contents, 'Resources', 'qml'), modules);
  prunePlugins(join(contents, 'PlugIns'));
  removeTranslations(contents);

  // Frameworks nothing links to (the other styles', Pdf, ...) go.
  const fw = join(contents, 'Frameworks');
  const binaries = () => walk(contents).filter((p) => magic(p) === 'macho' && !p.includes(`${sep}Frameworks${sep}`));
  const keep = new Set();
  const queue = binaries();
  while (queue.length) {
    for (const line of out('otool', ['-L', queue.shift()]).split('\n').slice(1)) {
      const m = line.trim().match(/^(?:@rpath|@executable_path\/\.\.\/Frameworks|@loader_path\/\.\.\/\.\.\/\.\.\/Frameworks)\/([^/]+\.(framework|dylib))/);
      if (!m || keep.has(m[1])) continue;
      keep.add(m[1]);
      const bin = m[2] === 'framework' ? join(fw, m[1], m[1].replace(/\.framework$/, '')) : join(fw, m[1]);
      if (existsSync(bin)) queue.push(bin);
    }
  }
  if (existsSync(fw)) for (const f of readdirSync(fw)) if (!keep.has(f)) { console.log(`drop ${f}`); rmSync(join(fw, f), { recursive: true }); }

  // Qt's macOS binaries are universal; keep the target's half.
  const arch = ARCH === 'arm64' ? 'arm64' : 'x86_64';
  for (const f of walk(contents).filter((p) => magic(p) === 'macho' && !lstatSync(p).isSymbolicLink())) {
    const archs = out('lipo', ['-archs', f]).trim().split(/\s+/);
    if (archs.length > 1) run('lipo', ['-thin', arch, '-output', f, f]);
    else if (archs[0] !== arch) die(`${relative(app, f)} is ${archs[0]}, not ${arch}`);
  }
  return { res: join(contents, 'Resources'), exe: join(contents, 'MacOS', 'CloseNI'), app, modules };
}

/*
 * Ad-hoc signing: not notarised, so Gatekeeper still asks on first open, but
 * Apple silicon refuses to run unsigned code at all. Inside out: each
 * library and framework, then the bundle. Node keeps its official signature.
 */
function signMac(app, node) {
  const contents = join(app, 'Contents');
  for (const f of walk(contents).filter((p) => magic(p) === 'macho' && p !== node && !lstatSync(p).isSymbolicLink() && !p.includes('.framework'))) {
    run('codesign', ['--force', '--sign', '-', f]);
  }
  const fw = join(contents, 'Frameworks');
  if (existsSync(fw)) for (const f of readdirSync(fw).filter((n) => n.endsWith('.framework'))) run('codesign', ['--force', '--sign', '-', join(fw, f)]);
  run('codesign', ['--force', '--sign', '-', app]);
  run('codesign', ['--verify', '--deep', '--strict', app]);
}

function dmg(app) {
  const tmp = join(OUT, 'tmp', 'dmg');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  run('ditto', [app, join(tmp, 'CloseNI.app')]);
  symlinkSync('/Applications', join(tmp, 'Applications'));
  const file = join(OUT, 'out', `CloseNI-${VERSION}-${ARCH}.dmg`);
  rmSync(file, { force: true });
  // hdiutil fails now and then with "Resource busy" on CI machines.
  for (let attempt = 1; ; attempt++) {
    const r = spawnSync('hdiutil', ['create', '-volname', 'CloseNI', '-srcfolder', tmp, '-fs', 'HFS+', '-format', 'ULMO', '-ov', file], { stdio: 'inherit' });
    if (r.status === 0) break;
    if (attempt === 3) die('hdiutil create failed three times');
    spawnSync('sleep', ['5']);
  }
  rmSync(tmp, { recursive: true, force: true });
  return file;
}

// ----------------------------------------------------------------- main ----

async function main() {
  console.log(`CloseNI ${VERSION}, ${TARGET}`);
  const qt = qtQuery();
  step('build');
  const exe = opt('--exe') ? resolve(opt('--exe')) : build();

  const stageRoot = join(OUT, TARGET);
  rmSync(stageRoot, { recursive: true, force: true });
  mkdirSync(stageRoot, { recursive: true });
  mkdirSync(join(OUT, 'out'), { recursive: true });

  step('deploy Qt');
  const deployed = OS === 'linux' ? await deployLinux(exe, stageRoot, qt)
    : OS === 'win' ? await deployWindows(exe, stageRoot, qt) : await deployMac(exe, stageRoot, qt);

  step('agent and Node');
  const nodeModules = stageAgent(deployed.res);
  const node = await stageNode(deployed.res);

  let systemLibs = [];
  if (OS === 'linux') {
    step('check libraries');
    systemLibs = checkLinuxLibs(deployed.appDir);
  }
  if (OS === 'mac') { step('sign'); signMac(deployed.app, node); }

  // The executable reports the version CMake read from package.json.
  if (OS === 'linux' || (OS === 'mac' && HOST_TARGET === TARGET)) {
    const said = out(deployed.exe, ['--version'], { env: { ...process.env, QT_QPA_PLATFORM: 'offscreen' } }).trim();
    if (said !== `CloseNI ${VERSION}`) die(`the staged app says "${said}", expected "CloseNI ${VERSION}"`);
  }

  const installers = [];
  if (INSTALLERS) {
    step('installers');
    if (OS === 'linux') installers.push(await appImage(deployed.appDir), deb(deployed.appDir, systemLibs));
    if (OS === 'win') installers.push(nsis(deployed.res));
    if (OS === 'mac') installers.push(dmg(deployed.app));
  }

  const stageDir = deployed.appDir || deployed.app || deployed.res;
  const manifest = {
    version: VERSION,
    target: TARGET,
    stage: relative(ROOT, stageDir).split(sep).join('/'),
    resources: relative(ROOT, deployed.res).split(sep).join('/'),
    executable: relative(ROOT, deployed.exe).split(sep).join('/'),
    node: { version: APP.node.version, path: relative(ROOT, node).split(sep).join('/') },
    nodeModules,
    qmlModules: deployed.modules,
    bytes: bytes(stageDir),
    installers: installers.map((f) => ({ file: relative(ROOT, f).split(sep).join('/'), bytes: statSync(f).size })),
  };
  writeFileSync(join(OUT, 'stage.json'), JSON.stringify(manifest, null, 2) + '\n');

  step('sizes');
  const parts = [['staged app', stageDir], ['  node', dirname(OS === 'win' ? node : dirname(node))], ['  local-agent', join(deployed.res, 'local-agent')]];
  for (const [label, p] of parts) console.log(`${label.padEnd(28)} ${mb(bytes(p)).padStart(10)}`);
  for (const f of installers) console.log(`${basename(f).padEnd(28)} ${mb(statSync(f).size).padStart(10)}`);
  console.log(`\nwrote ${relative(ROOT, join(OUT, 'stage.json'))}`);
}

main().catch((e) => die(e.stack || String(e)));
