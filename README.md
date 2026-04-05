# mini-claude

A minimal Claude Code, built from scratch for learning.

Direct Anthropic Messages API client + agent loop + interactive REPL, written
from scratch to understand how tools like Claude Code actually work. No SDK,
no subprocess, no hidden system prompts — just `fetch`, async generators, and
a tool-calling loop.

Built alongside [claude-code source](https://github.com/anthropics/claude-code)
as a reference — file-by-file comments point to the equivalent CC implementation
for each piece.

## What it does

Type a question into a terminal REPL. If Claude wants to use a tool (currently
just `read_file`), mini-claude executes it locally, feeds the result back, and
loops until Claude is done. Displays everything that happens, including the
message history being sent to the API each turn.

## Quick start

```sh
# prerequisites: macOS, Bun, logged into `claude` CLI
bun install
bun run repl.ts
```

Example session:

```
❯ read /etc/hosts and tell me if there are any custom entries

── turn 1 · sending 1 msg to API (trigger: user message) ──
    [0] user text: "read /etc/hosts and tell me..."

I'll read the file for you.

●  read_file(path: "/etc/hosts")
── turn ended · stop=tool_use · in:620 out:68 ──
  ⎿  ##  # Host Database # localhost is used to configure the loopback...

── turn 2 · sending 3 msgs to API (trigger: tool results) ──
    [0] user text: "read /etc/hosts and tell me..."
    [1] assistant tool_use: read_file({"path":"/etc/hosts"})
    [2] user tool_result: "##  # Host Database..."

The /etc/hosts file contains only the default entries...
── turn ended · stop=end_turn · in:783 out:157 ──

[done · 2 turns · total in:1403 out:225]
```

## REPL commands

| Command | What it does |
|---|---|
| `/exit` `/quit` | quit |
| `/clear` | reset conversation history |
| `/history` | show history length |
| `/model [name]` | get/set model (default: `claude-haiku-4-5`) |
| `/tools` | list available tools |
| `/help` | show commands |

## Architecture

Five layers, each with one job:

```
repl.ts     — terminal UI: reads input, renders events
   ↓
agent.ts    — agent loop: tool dispatch, history management
   ↓
claude.ts   — API client: fetch + SSE streaming
   ↓
auth.ts     — OAuth: Keychain read, token refresh
   ↓
tools.ts + ui.ts — tool definitions, ANSI formatting helpers
```

### Files

| File | Purpose | Lines |
|---|---|---|
| `auth.ts` | Reads OAuth token from macOS Keychain, auto-refreshes via `platform.claude.com/v1/oauth/token`. | ~100 |
| `claude.ts` | Direct `fetch` wrapper around `/v1/messages`. Parses SSE stream into typed events (`text`, `tool_use`, `done`). Handles OAuth bearer header + `oauth-2025-04-20` beta header. | ~300 |
| `tools.ts` | `Tool` type, registry helpers, `defineTool()` helper for type-erasure. Ships with `readFileTool`. | ~130 |
| `agent.ts` | `runAgent()` — async generator that loops until `stop_reason !== 'tool_use'`. Executes tools sequentially, appends results to history, yields events for the REPL to render. | ~190 |
| `ui.ts` | ANSI color helpers, `●` tool-call and `⎿` tool-result formatters, history dump. | ~120 |
| `repl.ts` | Interactive terminal loop. Reads input, dispatches slash commands, calls `runAgent()`, renders its event stream. | ~150 |
| `test.ts` | Smoke test for the API client (no agent, no tools). | ~40 |

Total: ~1,000 lines, zero runtime dependencies.

### The agent loop

`runAgent()` is an `async function*` that yields events as things happen:

```
turn_start    (every iteration)
text          (streaming from API)
tool_call     (Claude wants to use a tool)
tool_result   (we executed it)
turn_end      (this API call finished)
done          (loop exited — no more tool calls)
error         (unrecoverable)
```

Each iteration:
1. Call `/v1/messages` with the full history + tool schemas
2. Stream back the response, collecting text and `tool_use` blocks
3. Append assistant's message to history
4. If there were tool_uses: execute each, append results as a `user` message, loop
5. Otherwise: emit `done` and exit

See the file-by-file comments — they reference the equivalent Claude Code
source files for each subsystem.

## What's not here yet

Left as future exercises:

- **Permissions** — `isDangerous` is declared but not enforced. `run_bash` would need a `y/n` prompt.
- **More tools** — only `read_file` exists. `list_files`, `write_file`, `run_bash` are obvious next additions.
- **Session persistence** — history lives in memory only.
- **Compaction** — long conversations will eventually exceed the context window.
- **Image/binary handling** — `read_file` is text-only.

## Why OAuth direct instead of the Agent SDK?

The official [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
spawns a Claude Code subprocess. Works fine but:
- Injects a system prompt (~10K tokens)
- Inherits account-level MCP tools
- Hides everything behind the SDK surface

Direct OAuth gives true raw API access for learning. Caveat (as of April 2026):
Anthropic classifies non-Claude-Code OAuth traffic and **only Haiku works** via
this path; Sonnet and Opus return 429 due to server-side fingerprinting. Fine
for learning the agent loop — for production, use an API key.

## Prerequisites

- macOS (Keychain credential storage)
- `claude` CLI logged in (Claude Max / Pro subscription)
- [Bun](https://bun.sh) ≥ 1.3
