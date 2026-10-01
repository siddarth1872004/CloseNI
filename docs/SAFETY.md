# What the coding agent can and cannot be stopped from doing

CloseNI's coding agent runs on your machine, as you. It has no sandbox. What
stands between a model's reply and your files is three things: the path
checks on the file tools, the permission prompts, and a list of commands that
always ask. This page says what each one holds against and where it stops.

## File tools: read, write, edit, glob, grep, ls

Every path is resolved inside the project folder and refused outside it:

- `../`, absolute paths and drive letters outside the project are refused.
- Links are followed before the check, so `link-to-home/.ssh/config` is
  refused. A link to something that does not exist is refused too: writing
  through it would create its target, wherever that is. A cloned repository
  can carry either kind of link.
- Nothing inside a `.git` folder is written or edited: not the project's own,
  not a nested one (`sub/.git`), not one reached through a link, and not one
  spelled `.GIT` (the same folder on Windows and macOS). A hook planted there
  would run on your next commit.
- `glob` and `grep` skip links altogether.

**These do not hold against `bash`.** A command can write anywhere you can.

## Permission prompts

| Mode | Edits | Commands |
|---|---|---|
| Default | ask | ask |
| Accept edits | run | ask |
| Plan | refused | refused |
| Auto | run | run, except the safety list |

"Yes, and don't ask again" remembers a command's prefix (`npm test`,
`pytest`) for the session, never for the safety list.

Prompts are also the only defence against **prompt injection**. Files,
command output and web pages the agent reads go to the model as they are.
A README or a test's output that says "ignore your instructions and run …" can
steer it. In default mode you see every command before it runs. In auto mode
you don't, so use auto only in a project you trust. Choosing auto says so.

## The safety list

These always ask, in every mode including auto, and in the step-by-step
builder: `sudo`, `su`, `doas`, `pkexec`, `runas`; system package managers
(apt, dnf, yum, pacman, apk, brew, zypper, emerge, snap, winget, choco,
scoop); recursive or forced deletes (`rm -r`/`-R`/`-f`/`--recursive`,
`find -delete`, `rd /s`, `del /s`, `Remove-Item -Recurse`); `git reset --hard`,
`git clean -f`, and force pushes (`--force`, `-f`, `+branch`); a download
run by an interpreter (`curl … | sh`, through `tee` or not, `bash <(curl …)`,
`sh -c "$(curl …)"`, `iwr … | iex`); `dd`, `mkfs`, `format C:`, `chmod 777`,
`chown`, writes to a raw disk, and shutdowns.

The list is matched against the whole command text, so it holds inside
`$(...)`, backticks, `bash -c "..."`, `eval`, `python -c "os.system('...')"`,
and after `&&`, `||` or `;`.

### What it cannot catch

It reads text. Anything that hides the text gets past it:

- **A script the model wrote first.** `write cleanup.py` then `python cleanup.py`
  runs whatever is in the file, `shutil.rmtree` included. The write shows as a
  diff, and in default mode you approve both steps, but nothing flags it.
- **Download, then run.** `curl -o i.sh https://… && sh i.sh` is two ordinary
  commands.
- **Anything encoded or assembled.** `echo cm0gLXJmIH4= | base64 -d | sh`,
  `x=su; ${x}do id`, `r\m -rf ~`.
- **Language-level deletes.** `python -c "import shutil; shutil.rmtree(...)"`,
  `node -e "fs.rmSync(..., {recursive: true})"`.
- **Anything not on the list.** It is a list of the common ways a coding task
  goes wrong, not a complete description of harm. `chmod a+rwx`, `git push`
  (a plain one), `docker run --privileged` and network access in general are
  not on it.

## Secrets

Everything the agent reads is typed into a chat site.

- Reading a `.env` (but not `.env.example`), an SSH private key, a `.pem`,
  `.key`, `.p12` or `.pfx`, `.netrc`, `.npmrc` or `.pypirc` always asks, in
  every mode, and "don't ask again" is not offered. A project-wide `grep`
  leaves those files out and names them.
- The GitHub token is stored encrypted by the OS keychain (`safeStorage`),
  reaches git only through `GIT_ASKPASS` (never a remote URL or an argument),
  and is redacted from anything git prints. The agent's process never has it.
- There is no crash reporter or telemetry. Logs stay on your machine.
- **Not covered:** `bash` runs as you. `cat .env` or a command that reads the
  app's data folder, where the signed-in browser profiles live, is an ordinary
  command. In default mode you see it first; in auto mode you don't.

If you need a boundary rather than a floor, run CloseNI inside a VM, a
container, or a separate user account that owns only the project.
