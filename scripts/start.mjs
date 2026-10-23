/*
 * npm start: run the native app from its development build, passing any
 * arguments through (npm start -- --workspace ~/proj). The build is
 * native/'s CMake project; if it has not been built, say how.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const dir = process.env.CLOSENI_BUILD_DIR || join(root, 'build-native');
const exe = process.platform === 'darwin'
  ? join(dir, 'bin', 'CloseNI.app', 'Contents', 'MacOS', 'CloseNI')
  : join(dir, 'bin', process.platform === 'win32' ? 'CloseNI.exe' : 'CloseNI');

if (!existsSync(exe)) {
  console.error(`No native build at ${exe}. Build it first (Qt 6.10 and Ninja):\n\n` +
    '  npm run build\n' +
    '  cmake -S native -B build-native -G Ninja\n' +
    '  cmake --build build-native\n\n' +
    'or set CLOSENI_BUILD_DIR to a build directory of your own.');
  process.exit(1);
}
const r = spawnSync(exe, process.argv.slice(2), { stdio: 'inherit' });
process.exit(r.status ?? 1);
