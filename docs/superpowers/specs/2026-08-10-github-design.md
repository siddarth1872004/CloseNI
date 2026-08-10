# GitHub integration — design

Date: 2026-08-10
Roadmap items: 11 (repo search + integration into builds), 12 (in-app sign-in,
repo access, push), 14 (GitHub Actions + external tooling)
Sub-project: 5a · GitHub — the credential-dependent half of sub-project 5
Status: agreed in brainstorming. Token acquisition (paste a PAT) and repo
integration (both reference and clone) were chosen by the project owner.

## Problem

The Ship panel shells out to `git` and hopes the machine's credentials work.
There is no sign-in, no way to see which repositories exist, no way to create
one, and no view of whether a push triggered anything.

Repo search exists and is tested, but a result is a link and nothing more — item
11's "integration into builds" was never built.

Sub-project 5 was recorded as blocked on "a credential story the app does not
have". That story turns out to be short: Electron ships `safeStorage`, which
encrypts with an OS-level key — Keychain on macOS, DPAPI on Windows, libsecret
on Linux. No new dependency.

### A live bug found while exploring

`desktop/main.js` runs:

```javascript
spawn("git", payload.args, { cwd: payload.cwd, shell: true });
```

**With `shell: true`, Node concatenates the arguments into a shell string rather
than passing them separately.** Node emits a deprecation warning saying exactly
this. Verified directly: `spawn("echo", ["hello; echo INJECTED"], {shell:true})`
prints both `hello` and `INJECTED`.

That reaches real input today. The Ship panel calls `g(["commit", "-m", msg])`
with a typed commit message, and `g(["remote", "add", "origin", remote])` with a
typed URL. A commit message containing `; rm -rf ~` runs it.

It is self-inflicted at present, which makes it low severity. **Item 11 changes
that**, by feeding repository URLs from search results — network-derived text —
into git operations. The fix belongs here rather than after.

## Decisions

1. **A pasted personal access token**, not OAuth device flow. Device flow needs
   a registered OAuth app before anything works at all.
2. **No plaintext token on disk, ever.** If `safeStorage` is unavailable the
   token lives in memory for the session and the UI says so.
3. **`GIT_ASKPASS`**, so the token never enters `.git/config` or a process
   argument list.
4. **Every log path is redacted.**
5. **`shell: false` for git**, and argument validation before spawn.
6. **Both reference and clone**, with the licence shown before cloning.

## Design

### The token

Sign in opens GitHub's token page with the scopes pre-selected
(`repo`, `workflow`) and the user pastes the result. They choose the scopes,
see exactly what was granted, and can revoke it in one click — none of which is
true of a token this app negotiated on their behalf.

Storage is `safeStorage.encryptString`, written to `<userData>/github.token`.

**When `safeStorage.isEncryptionAvailable()` is false, nothing is written.** The
token is held in memory for the session and the sign-in panel says it will need
re-entering next launch. Falling back to a plaintext file because encryption was
unavailable would take a decision the user did not make and hand them a
credential lying in a predictable path.

Signing out deletes the file and clears memory.

### Pushing without leaking it

Three ways to authenticate a `git push`, and two of them leak:

| Approach | Leak |
|---|---|
| Token in the remote URL | Written into `.git/config`, surviving in the project indefinitely |
| Token as a push argument | Visible in `ps` to every process on the machine |
| **`GIT_ASKPASS` helper** | Token exists only in that child process's environment |

A small helper script is written to `userData` — `askpass.sh` with a shebang, or
`askpass.bat` on Windows — that echoes the token from its own environment. Git
invocations set `GIT_ASKPASS` to it, put the token in the child's env, and set
`GIT_TERMINAL_PROMPT=0` so git fails loudly rather than blocking forever on a
password prompt nobody can see.

The helper never contains the token; it reads it from the environment. A script
on disk containing a credential is the same mistake in a different place.

### Redaction

`redactToken(text, token)` is applied on every path that writes git output to
the log or the UI.

The git IPC currently pipes stdout and stderr straight into the project log. Git
echoes URLs on failure, and a mistyped remote could carry the token into a line
the app then writes to a log file. **A credential in a log file has been
published** — to a screenshot, a pasted error report, a support request. Adding
this now costs a function; retrofitting it means auditing every call site later.

Redaction is unconditional, not conditional on the token looking secret.

### The injection fix

```javascript
spawn("git", safeGitArgs(payload.args), { cwd: payload.cwd, shell: false });
```

Git needs no shell. `safeGitArgs` rejects anything that is not a string and
throws rather than filtering — silently dropping an argument would produce a git
command that means something different from what was asked.

`run-command` keeps `shell: true`: running a shell command is its entire
purpose, it is user-initiated, and it already goes through the approval policy.

### Repositories

A signed-in user gets their repository list in the Ship panel, can pick one as
the remote, and can create a new one. Push uses the askpass path above.

Search results in the Research panel gain two actions:

**Use as reference** fetches the repository's README and file tree and adds them
to the planning context, so the model designs against how a real project of that
kind is laid out. Nothing is written to the workspace, so there is no licence
question and no surprise files.

**Clone** shows the repository's licence and requires confirmation. It clones
into the workspace when the workspace is empty, and into a subdirectory named
after the repository otherwise — and says which it did. Scattering someone
else's files into a project already under way, without saying so, would be its
own kind of bug.

`parseRepoUrl(url)` returns `{ owner, repo }` only for `github.com` URLs and
null for anything else. Both actions go through it, so a search result cannot
point a clone or a fetch at an arbitrary host.

### Actions

The Ship panel lists recent workflow runs for the selected repository with their
status and conclusion, and can trigger a `workflow_dispatch`. Triggering needs
the `workflow` scope; without it the panel says so rather than failing on the
request.

Rate limits are reported plainly. Authenticated search is 30 requests per
minute; the existing unauthenticated path is 10, which is one reason a token
improves item 11 even before anything else.

## Testing

The pure parts are the security-relevant ones, which is convenient:

- **`redactToken`** — a token appearing once, twice, in a URL; a partial match
  left alone; an empty or absent token not turning the text into mush; text
  containing regex metacharacters not breaking the replacement.
- **`safeGitArgs`** — a plain argument list passes; a non-string throws; a null
  throws; an argument containing shell metacharacters passes **unchanged**,
  because with `shell: false` it is data rather than syntax, and escaping it
  would corrupt legitimate commit messages.
- **`parseRepoUrl`** — HTTPS, with and without `.git`, with a trailing slash;
  SSH form; a non-GitHub host rejected; a lookalike host such as
  `github.com.evil.test` rejected; a path with too few segments rejected.
- **The persistence policy** — encryption available means persist; unavailable
  means memory only; the decision is a function, not a branch buried in an IPC
  handler.
- **A regression test that the git IPC never passes `shell: true`**, asserted
  against the source of `desktop/main.js`. The bug it prevents is invisible in
  normal use and only shows up when someone types the wrong thing.

**Not testable here, stated plainly:** anything requiring a real token. There is
no GitHub credential in this environment and one will not be requested. The API
call shapes are written from the documented endpoints and verified by their
construction, not by calling GitHub. Sign-in, push, repo listing and Actions all
need the owner to try them.

## Non-goals

- **OAuth device flow**, for the reason above.
- **Hosting a credential for any provider other than GitHub.** The AI provider
  logins remain browser profiles; this is a separate mechanism for a separate
  thing, and merging them would be worse.
- **Git operations beyond init, status, add, commit, push, clone and remote.**
  This is not a git client.
- **Editing workflow files.** Actions are triggered and watched, not authored.
- **Storing the token anywhere the agent process can read it.** The agent drives
  browsers; it has no reason to hold a GitHub credential, and not passing it is
  cheaper than deciding later whether it leaked.

## Consequences

- **A token in memory only, on some Linux setups.** Anyone without libsecret
  re-enters it each launch. Annoying, and the honest outcome.
- **Cloning drops third-party code and its licence into a workspace.** The
  confirmation makes it deliberate; it does not make the licence go away, and
  the AI will subsequently edit code it did not write.
- **`shell: false` changes git argument handling.** Anything that previously
  relied on shell expansion — a glob in a path, say — stops working. Nothing in
  the app does, but it is a behaviour change rather than a pure fix.
- **More GitHub API surface means more ways to be rate-limited**, and a
  rate-limited response looks like a failure unless it is reported as what it
  is. The panel distinguishes them.
- **The token is one more secret the app must never log**, and redaction is a
  discipline that only holds if every new log path remembers it.
