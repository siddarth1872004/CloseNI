# Changelog

All notable changes to CloseNI are recorded here.

## [0.1.1] — 2026-10-25

### Fixed

- **Signed out after long tasks on Windows.** The app killed each agent run
  150 ms after its result, while the agent could still be closing Chromium. On
  Windows Chromium dies with the agent, so it was cut off before saving the
  profile, and repeated runs lost the login. The app now lets the agent exit on
  its own and kills it only if it is still running 10 s later.

## [0.1] — 2026-10-23

The first release of CloseNI.

### The app

- **Native on Windows and Linux.** Every screen is Qt Quick, with no
  web view anywhere. The agent is a Node and Playwright process the app starts
  beside it. The unpacked Linux app is about 234 MB and holds about 95 MB of
  memory at idle; Chromium is downloaded on first use.
- **Installers** are built by CI from the tag: a Windows `.exe`, a Linux
  AppImage and a `.deb`, with a SHA-256 checksum file. They bundle Qt, Node 22
  and the agent. They are unsigned, so SmartScreen may warn on first launch.
- **Updates from inside the app.** CloseNI checks GitHub for the latest
  release at start, or from Settings > About, and shows an Update button in
  the top bar when one is out. The download is checked against the release's
  `SHA256SUMS.txt`, and a file that does not match is deleted. On Windows the
  installer upgrades in place. The AppImage replaces itself and restarts. The
  `.deb` opens in the system's software installer.
- **Running a project** opens a native console for its output, and **Open in
  browser** hands a web project's address to your system browser.
- **The GitHub token** is kept in the OS keyring: DPAPI on Windows, the
  Secret Service on Linux.

### The agent

- **The Code panel** reads and searches the project, edits files, runs
  commands and checks its work, asking first in default mode. Ask, Accept
  edits, Plan, Build, Test, Research, Ship and Auto are buttons under the
  prompt. Plan mode stays read-only until you approve its plan.
- **No step limit.** A Code turn keeps going until the agent is done, you
  press Esc, or the provider fails.
- **A high bar for the code.** Every mode asks for correct, idiomatic,
  production-ready code on a current, maintained stack, with nothing
  deprecated, no placeholders and nothing that reads as machine-written. The
  agent is told to prove a change by running the tests or the code.
- **Replies parsed reliably.** A tool block cut off mid-reply is not run; the
  model is asked to send it again. A reply written as a built-in function-call
  tag instead of a tool block gets the same request rather than ending the
  turn. Files that contain code fences, like a README, have a worked
  four-backtick example in the prompt.
- **Planned builds** plan a project as steps, build them one at a time in the
  same conversation, check each with the real compiler for twelve languages,
  and repair a failing step at most twice.
- **Research** asks the provider with its web search on, leads with the
  answer, lists the cited sources, and searches GitHub repositories.
- **Less sent to the chat.** A file read again in the same chat comes back as
  a diff, or a note that nothing changed. A long file starts with an outline
  of its declarations, so the agent can read just the part it needs.
- **`/resume` picks up a cut-off turn.** Each step is logged before the next
  starts. After a restart, a crash or a provider error, `/resume` continues the
  turn without running a finished tool call twice.
- **Copy and paste when the page fails.** `/route manual` shows each prompt to
  copy into any chat and takes the reply pasted back. There is no API key
  anywhere.
- **Auto-approve** in Settings > Permissions applies to the Code panel and
  planned builds alike; "Never run commands" turns commands off. The safety
  list still asks.

### Conversations

- The rail lists every chat in the project, newest first, named after its
  first message. Open one to get its messages and plan back, rename it, or
  remove it from the list (the provider keeps its copy). **New Chat** starts a
  fresh one, and each chat remembers its provider.
- Messages and plans are saved under `chats/` in the storage directory, so
  they come back after a restart.
- **No automatic new chats.** When a provider says the conversation is full,
  the turn ends with that message, and you choose between New Chat and
  `/compact`, which carries it over with a summary.

### Providers

- **DeepSeek** is driven end to end, including long sessions. Busy,
  network, rate-limit, unfinished and refused replies are recognised; busy
  replies and rate limits are retried on a capped back-off, and anything else
  ends with a message that says what happened.
- **Ollama, Qwen Studio, GLM, ChatGPT, Gemini, Claude and Grok** are listed as coming
  soon and cannot be selected.
- **A provider status you can act on.** The readout shows when a provider is
  rate limited, busy, signed out, showing a human check, full, or its page has
  changed. A human check or a sign-in page is never retried automatically:
  finish it in the browser window, then send again.
- **A startup page check** reports a moved composer as "page has changed"
  before the first prompt, and saves a scrubbed copy of the page in
  `diagnostics/`.
- **Pacing.** At least the provider's gap between prompts (3 seconds for
  DeepSeek) or a longer one of your own, and an optional daily prompt budget,
  both in Settings > Permissions. Only prompts the page took are counted.
- **Sends that are checked.** A prompt goes into the composer that was found,
  all of it, and is confirmed sent. A send the page ignores is pressed once
  more, then reported, instead of waiting out the reply timeout.
- **A browser readout** in Settings > Provider: the Chromium and Playwright
  versions, the profile folder, sign-in, the last selector check, and whether
  the window is shown.
- **A reply counts as finished** only after its text has held still for at
  least 1.5s, once the stop button has gone.
