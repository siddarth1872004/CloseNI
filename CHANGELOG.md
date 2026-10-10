# Changelog

All notable changes to CloseNI are recorded here.

## [0.1] — 2026-10-10

The first release of CloseNI as a native app.

### The app

- **Native on Windows, macOS and Linux.** Every screen is Qt Quick, with no
  web view anywhere. The agent is a Node and Playwright process the app starts
  beside it. The unpacked Linux app is about 234 MB and holds about 95 MB of
  memory at idle; Chromium is downloaded on first use.
- **Installers** are built by CI from the tag: a Windows `.exe`, macOS disk
  images for Apple silicon and Intel, and a Linux AppImage and `.deb`. They
  bundle Qt, Node 22 and the agent. They are unsigned, so SmartScreen and
  Gatekeeper warn on first launch.
- **Running a project** opens a native console for its output, and **Open in
  browser** hands a web project's address to your system browser.
- **The GitHub token** is kept in the OS keyring: DPAPI on Windows, the
  keychain on macOS and the Secret Service on Linux.

### The agent

- **The Code panel** reads and searches the project, edits files, runs
  commands and checks its work, asking first in default mode. Plan mode stays
  read-only until you approve its plan.
- **Planned builds** plan a project as steps, build them one at a time in the
  same conversation, check each with the real compiler for twelve languages,
  and repair a failing step at most twice.
- **Research** asks the provider with its web search on, lists the cited
  sources, and searches GitHub repositories.

### Conversations

- The rail lists every chat in the project, newest first, named after its
  first message. Open one to get its messages and plan back, rename it, or
  remove it from the list (the provider keeps its copy). **New Chat** starts a
  fresh one, and each chat remembers its provider.
- Messages and plans are saved under `chats/` in the storage directory, so
  they come back after a restart.
- New Chat, switching and removing the open chat wait while a reply, a build
  or a Code turn is using the thread, and say why.

### Long DeepSeek sessions

- DeepSeek's busy, network, rate-limit, unfinished and refused replies are
  recognised. Busy replies are retried after 5, 20 and 60 seconds and a rate
  limit after a minute; anything else ends with a message that says what
  happened.
- Signing out mid-session stops the agent with a message to sign in again.
- A full conversation continues in a new chat with a summary, and the summary
  is sent again if the new chat's first reply fails.
- A reply that never started or never finished ends with a message instead of
  returning the previous answer.
- Memory stays bounded: the last 20 undo checkpoints and the last 500 entries
  of prompt history are kept.

### Providers

- **DeepSeek** is driven end to end.
- **Qwen Studio** and **GLM** can be selected as experimental.
- **Ollama** is local and chat-only.
