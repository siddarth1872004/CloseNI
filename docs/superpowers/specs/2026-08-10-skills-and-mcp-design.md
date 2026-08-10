# Skills, personas and MCP — design

Date: 2026-08-10
Roadmap items: 13 (MCP tool support), 15 (skills, personas, GitHub skill-`md`)
Sub-project: 5b · The credential-free half of sub-project 5
Status: agreed in brainstorming. The shape of MCP support (a context provider
rather than an agentic loop) and where skills come from were chosen by the
project owner.

## Problem

Two roadmap items remain, and neither needs a credential. They share a purpose:
**changing what the model knows and how it works, without changing the code.**

Today the only way to influence how the agent writes code is to edit
`buildPrompt` in `local-agent/src/index.ts` and recompile. That is where the
four lines of code-quality guidance from sub-project 10 live — hardcoded,
identical for every project, and invisible to the person using the app.

## The constraint that shapes item 13

**The model cannot call a tool.** It drives a web chat window; it emits text into
a textarea and the agent reads text back out. There is no tool-use API, no
function calling, no structured tool result channel.

So "MCP tool support" can only mean one of two things:

**Tools called during a step.** The model asks for a tool in its reply, the agent
runs it and sends the result back as a follow-up message, and the model
continues. Genuinely agentic — the model decides what it needs. But every
exchange is a full browser round-trip: send, wait for generation, read the DOM.
That is 60–90 seconds. Five tool calls add seven minutes to one step.

**Tools called before a step.** Results are gathered up front and folded into the
prompt. No extra round-trips, but the model does not choose what it gets.

The second was chosen. The first is not a matter of better engineering — the
round-trip is structural, a consequence of driving a chat UI rather than an API.

## Decisions

1. **MCP is a context provider.** Tools run before the build, not during it.
2. **Once per build, not per step.** A schema or a page of documentation does not
   change while a build runs, and re-fetching it twenty times would cost twenty
   subprocess launches for identical text.
3. **A minimal MCP client, no new dependency.** Three methods over stdio.
4. **Skills and personas are `.md` files** in the user's data directory,
   importable from GitHub.
5. **Everything prepended shares one hard budget.**

## Design

### Skills and personas

```
<userData>/personas/*.md      who the model is
<userData>/skills/*.md        how it should work
```

A **persona** is a stance: *"a terse backend engineer who prefers the standard
library to dependencies and writes no comment that restates the code"*. One is
active at a time, or none.

A **skill** is a practice: *"always write pytest tests alongside the code they
test"*. Any number active at once.

Both are plain Markdown with no schema. The file name is the display name. There
is no frontmatter, no registry, and no versioning — a skill is a paragraph of
instructions, and inventing a format around it would be the larger commitment.

**Import from GitHub** takes `owner/repo/path/to/file.md`, fetches it through the
token from sub-project 5a, and writes it into `skills/`. After that it is a local
file the user can edit. Nothing syncs; nothing phones home.

### MCP as a context provider

Servers are declared in `<userData>/mcp.json`:

```json
{
  "servers": {
    "fetch": { "command": "uvx", "args": ["mcp-server-fetch"] }
  }
}
```

A **context call** attaches a specific tool with fixed arguments to the build:

```json
{
  "calls": [
    { "server": "fetch", "tool": "fetch", "args": { "url": "https://flask.palletsprojects.com/quickstart/" } }
  ]
}
```

Before the first step, the agent starts each needed server, calls each tool once,
and folds the text results into every step's prompt for that build.

**The minimal client.** MCP over stdio is JSON-RPC 2.0, and this needs exactly
three methods: `initialize`, `tools/list`, `tools/call`. That is roughly a
hundred lines against a well-specified protocol. Adding the official SDK for
three methods would be the larger commitment in a project whose only runtime
dependencies are Playwright and Electron.

**Failure is never fatal.** A server that will not start, a tool that errors, one
that never responds within its timeout — each is logged and skipped. A build must
not fail because an optional context source was unavailable; the model simply
gets less context, which is the situation today.

### Composition, and the budget

```typescript
composePrompt(parts: { persona?, skills?, mcpContext?, base }): { text: string; truncated: string[] }
```

Order is deliberate: **persona → skills → MCP context → task.** Who you are, how
to work, what is true, what to do. The task goes last because it is what the
model should still be reading when it starts generating.

**One hard budget across everything prepended: 6000 characters.**

This is the same risk that made sub-project 10's quality block four lines and no
more. That block was safe; a persona plus three skills plus a fetched page of
documentation could be thousands of characters standing between the model and a
JSON formatting instruction — and this project has lost whole builds to replies
the parser could not read.

So the budget truncates, lowest-priority first — MCP context, then skills, then
persona — and reports what it dropped, visibly, rather than silently shipping a
smaller prompt than the user configured. **The JSON instruction always survives**,
because it is part of `base` and `base` is never truncated.

### Where it plugs in

A **Skills** section in Settings lists the personas and skills found on disk with
checkboxes, an editor for each, an Import from GitHub field, and the MCP server
and call configuration. Selections persist in `localStorage`; the files
themselves are the source of truth.

The renderer passes the composed preamble to the agent the same way provider
controls travel — as an environment variable read once, rather than a new
positional argument threaded through every mode.

## Testing

`composePrompt` is the whole testable core, and the budget is where the risk is:

- Every part present, under budget, in the right order.
- Each part absent individually, with no stray separators left behind.
- Over budget: MCP context dropped first, then skills, then persona.
- **`base` is never truncated**, at any budget, including one smaller than `base`
  itself. This is the check that protects the JSON instruction.
- What was dropped is reported, not silently discarded.
- An empty parts object yields exactly `base`.

The MCP client, against a scripted fake process rather than a real server:

- A well-formed `initialize` handshake and `tools/list`.
- A tool call whose result is returned as text.
- A server that exits immediately on start.
- A server that returns a JSON-RPC error.
- A server that never responds, hitting the timeout.
- Malformed JSON on stdout not crashing the caller.

Skill discovery: names from filenames, non-`.md` files ignored, an unreadable
directory yielding an empty list rather than throwing.

**Not testable here:** interoperability with any real MCP server. The fake proves
the framing and the failure handling; it does not prove that `mcp-server-fetch`
and this client agree in practice. That needs the owner to configure one.

## Non-goals

- **An agentic tool loop.** Rejected above, on structural grounds.
- **Tool calls the model chooses.** Same reason.
- **Re-running context tools per step.** Once per build; the limitation is
  recorded in Consequences.
- **A skill registry, marketplace or sync.** Import copies a file in; after that
  it is yours.
- **Frontmatter, versioning or dependencies between skills.** A skill is a
  paragraph.
- **Shipping default skills.** The four quality lines stay hardcoded in
  `buildPrompt` as the floor; skills are additions on top, not a replacement the
  user must configure before getting sensible behaviour.

## Consequences

- **A tool whose answer changes mid-build is read once.** Fetching a schema
  before step 1 and creating tables in step 4 means the model works from the old
  schema for the rest of the build. Recorded rather than solved: solving it means
  per-step calls, which is a cost this design exists to avoid.
- **Prompt budget is now shared.** A long persona leaves less room for MCP
  context. The truncation report makes that visible, but it is a trade the user
  now has to think about.
- **Skills can make output worse.** A badly written skill is a badly written
  instruction sent on every step of every build. There is no validation possible
  — it is prose.
- **MCP servers are arbitrary subprocesses.** The user configures a command and
  the app runs it. That is what MCP is, but it is a new category of thing this
  app executes, and it is worth naming: a malicious `mcp.json` is a malicious
  program.
- **More text before the JSON instruction is more parse risk.** The budget and
  the e2e suite are the mitigations, and the fallback is a smaller budget.
