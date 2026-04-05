# mini-claude

A minimal Claude Code, built from scratch for learning.

Direct Anthropic Messages API client + agent loop + tool calling + permission
prompts + interactive REPL, written from scratch to understand how tools like
Claude Code actually work. No SDK, no subprocess, no hidden system prompts —
just `fetch`, async generators, and a tool-calling loop.

Built alongside [claude-code source](https://github.com/anthropics/claude-code)
as a reference — file-by-file comments point to the equivalent CC
implementation for each piece.

## What it does

Type a question into a terminal REPL. If Claude wants to use a tool
(`read_file`, `list_files`, `write_file`), mini-claude executes it locally,
feeds the result back, and loops until Claude is done. Dangerous tools
require permission via a y/n/always prompt. Displays everything that
happens — streaming text, tool calls, results, turn-by-turn progress,
and the full message history being sent to the API each turn.

## Quick start

```sh
# prerequisites: macOS, Bun, logged into `claude` CLI
bun install
bun run repl.ts

# with debug logs to stderr
DEBUG=1 bun run repl.ts
```

Example session:

```
❯ read /etc/hosts and tell me the first non-comment line

── turn 1 · sending 1 msg to API (trigger: user message) ──
    [0] user text: "read /etc/hosts and tell me..."

I'll read the file for you.

→ read_file(path: "/etc/hosts")
── turn ended · stop=tool_use · in:620 out:68 ──
← ##  # Host Database # localhost is used to configure the loopback…

── turn 2 · sending 3 msgs to API (trigger: tool results) ──
    [0] user text: "..."
    [1] assistant tool_use: read_file(...)
    [2] user tool_result: "##  # Host Database..."

The first non-comment line is: 127.0.0.1    localhost
── turn ended · stop=end_turn · in:783 out:57 ──

[done · 2 turns · total in:1403 out:125]
```

When Claude calls a dangerous tool:

```
❯ write "hello" to /tmp/demo.txt

→ write_file(path: "/tmp/demo.txt", content: "hello")
   ⚠ requires permission
     y = allow once    n = deny    a = always allow this tool for the session
   › a
   → always allowing 'write_file' for this session

← wrote 5 bytes to /tmp/demo.txt
```

## REPL commands

| Command | What it does |
|---|---|
| `/exit` `/quit` | quit |
| `/clear` | reset conversation history |
| `/history` | show history length |
| `/model [name]` | get/set model (default: `claude-haiku-4-5`) |
| `/tools` | list available tools (dangerous ones marked) |
| `/allowed` | show session allowlist of auto-approved tools |
| `/revoke` | clear the session allowlist |
| `/help` | show commands |

## Architecture

Six layers, each with one job:

```
repl.ts       — terminal UI: reads input, renders events, slash commands
   ↓
agent.ts      — agent loop: tool dispatch, history management, permission gate
   ↓
claude.ts     — API client: fetch + SSE streaming
   ↓
auth.ts       — OAuth: Keychain read, token refresh
   ↓
tools.ts      — tool definitions and registry
permissions.ts — permission prompts and session allowlist
ui.ts         — ANSI color helpers, tool-call/result formatters
debug.ts      — opt-in stderr logging with levels and subsystems
```

### Files

| File | Purpose | Lines |
|---|---|---|
| `auth.ts` | Reads OAuth token from macOS Keychain, auto-refreshes via `platform.claude.com/v1/oauth/token` before expiry. | ~100 |
| `claude.ts` | Direct `fetch` wrapper around `/v1/messages`. Parses SSE stream into typed events (`text`, `tool_use`, `done`). Handles OAuth bearer + `oauth-2025-04-20` beta header. | ~330 |
| `tools.ts` | `Tool`/`AnyTool` types, `defineTool()` helper for type-erasure. Ships with `read_file`, `list_files`, `write_file`. | ~220 |
| `agent.ts` | `runAgent()` — async generator. Loops until no `tool_use` blocks remain. Executes tools via user-supplied `canUseTool` gate. | ~220 |
| `permissions.ts` | Interactive y/n/always prompts with session allowlist. Exports `allowAll` / `denyDangerous` / `createInteractivePermissions`. | ~115 |
| `ui.ts` | ANSI color helpers, `→` tool-call and `←` tool-result formatters, history dump. | ~125 |
| `debug.ts` | `makeLogger(subsystem)` — silent by default, activated via `DEBUG=1` or `--debug`. Levels: debug/info/warn/error. | ~135 |
| `repl.ts` | Interactive terminal loop. Reads input, dispatches slash commands, calls `runAgent()`, renders its event stream. | ~165 |
| `test.ts` | Smoke test for the API client (no agent, no tools). | ~40 |

Total: ~1,450 lines, zero runtime dependencies.

### The agent loop

`runAgent()` is an `async function*` that yields events as things happen:

```
turn_start    (every agent-loop iteration)
text          (streaming from API)
tool_call     (Claude wants to use a tool)
tool_result   (we executed it, or user denied permission)
turn_end      (this API call finished)
done          (loop exited — final answer delivered)
error         (unrecoverable)
```

Each iteration:

1. Call `/v1/messages` with the full history + tool schemas
2. Stream back the response, collecting text and `tool_use` blocks
3. Append assistant's message to history
4. If there were tool_uses: ask `canUseTool` for permission, execute each
   allowed tool, append results as a `user` message, loop
5. Otherwise: emit `done` and exit

The text above `── stop=end_turn ──` is the final answer.
The text above `── stop=tool_use ──` is interim reasoning before a tool call.

See the file-by-file comments — they reference the equivalent Claude Code
source files for each subsystem.

### Permissions

Tools are marked `isDangerous: true` (e.g. `write_file`). Before a dangerous
tool runs, `canUseTool()` is called — the REPL's implementation prompts
interactively:

- `y` — allow this single call
- `n` — deny; agent sends `is_error: true` back to Claude
- `a` — add to the session allowlist; never prompt for this tool again

The allowlist lives in memory only, scoped to the REPL process. Use
`/allowed` to inspect, `/revoke` to clear.

Read-only tools (`read_file`, `list_files`) run without prompting.

### Debug logging

Silent by default. Enable with `DEBUG=1` or `--debug` — then every subsystem
writes to stderr:

```
10:38:54.086 [DEBUG] [agent] turn start {"turn":1,"historyLen":1}
10:38:54.097 [DEBUG] [api]   POST /v1/messages (streaming) {...}
10:38:54.116 [DEBUG] [auth]  using cached token {"expiresInSec":28546}
10:38:55.194 [DEBUG] [api]   response received {"status":200,"elapsedMs":1097}
10:38:55.202 [DEBUG] [agent] executing tools {"names":["read_file"]}
10:38:55.203 [DEBUG] [agent] tool ok {"name":"read_file","elapsedMs":1}
```

Pipe stderr separately: `DEBUG=1 bun run repl.ts 2> debug.log`

## What's not here yet

Left as future exercises:

- **More tools** — `run_bash`, `grep`/`glob`, `edit_file` (diff-based editing)
- **Concurrent tool execution** — run read-only tools in parallel
- **Session persistence** — save to disk, `/resume` command
- **Compaction** — summarize old turns when history gets long
- **Per-argument permission rules** — allow `write_file(/tmp/**)` but not `write_file(/etc/**)`
- **Image/binary handling** — `read_file` is text-only

## Why OAuth direct instead of the Agent SDK?

The official [`@anthropic-ai/claude-agent-sdk`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
spawns a Claude Code subprocess. Works fine but:

- Injects a system prompt (~10K tokens)
- Inherits account-level MCP tools
- Hides everything behind the SDK surface

Direct OAuth gives true raw API access for learning. Caveat (as of April 2026):
Anthropic classifies non-Claude-Code OAuth traffic and **only Haiku works**
via this path; Sonnet and Opus return 429 due to server-side fingerprinting.
Fine for learning the agent loop — for production, use an API key with
`x-api-key` auth instead of the Keychain OAuth token.

## Prerequisites

- macOS (Keychain credential storage)
- `claude` CLI logged in (Claude Max / Pro subscription)
- [Bun](https://bun.sh) ≥ 1.3
