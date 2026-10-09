#!/usr/bin/env bash
# Sets up the shell for running this project inside WSL.
#
#   source scripts/wsl-env.sh
#
# Only needed on WSL. On Windows or a normal Linux box with node and the usual
# chromium libraries installed, plain `npm` works and this script is unnecessary.
#
# It handles two WSL-specific problems:
#   1. A Windows node on /mnt/c cannot run from a \\wsl.localhost\... path
#      ("UNC paths are not supported"), so a Linux node must come first on PATH.
#   2. Playwright's chromium needs system libraries that are not installed
#      here; they were extracted to ~/.local/chromium-deps.

if [ -d "$HOME/.local/node/bin" ]; then
  export PATH="$HOME/.local/node/bin:$PATH"
else
  echo "warning: no Linux node at ~/.local/node — see README" >&2
fi

if [ -d "$HOME/.local/chromium-deps/usr/lib/x86_64-linux-gnu" ]; then
  export LD_LIBRARY_PATH="$HOME/.local/chromium-deps/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
fi

echo "node:     $(command -v node || echo MISSING) $(node --version 2>/dev/null)"
echo "chromium: $([ -n "${LD_LIBRARY_PATH:-}" ] && echo "libs on LD_LIBRARY_PATH" || echo "using system libs")"
