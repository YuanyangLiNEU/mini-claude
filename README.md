# mini-claude

**A minimal Claude Code, built from scratch to learn how AI coding agents work.**

[Claude Code](https://github.com/anthropics/claude-code) is 500K+ lines of
production TypeScript. This project strips it down to the essential architecture
in the simplest code possible. No SDK. No hidden system prompts. Just `fetch`,
async generators, and a tool-calling loop.

**Built with eval-driven development.** Every new capability starts as a
failing eval task. An LLM evaluator (Claude Sonnet) drives mini-claude through
stdin/stdout — typing messages, approving permissions, judging answers —
exactly like a human sitting at the terminal. The eval is a complete black box:
no imports from mini-claude internals, no mocking, no shortcuts. Write the
test, implement the feature, watch it pass.

## Why this exists

Claude Code is 500K+ lines of production code. This project distills the core
architecture into something you can read in an afternoon:

- **Black-box eval harness** — LLM-as-user drives the real REPL via subprocess stdin/stdout
- **Direct API client** — raw `fetch` to `/v1/messages` with SSE streaming
- **Agent loop** — async generator that yields events as tools execute
- **Tool calling** — Claude decides which tools to use, you execute them locally
- **Server-side tools** — Anthropic's built-in web search, no parsing needed
- **Permission system** — dangerous tools require interactive approval

Every file has comments pointing to the equivalent Claude Code source for comparison.

## Quick start

**Option A: API key (recommended, works everywhere)**

```sh
export ANTHROPIC_API_KEY=sk-ant-...
bun install
bun run repl.ts
```

**Option B: OAuth (Claude Max/Pro on macOS)**

```sh
# requires: macOS, `claude` CLI logged in
bun install
bun run repl.ts
```

```sh
# with debug logs
DEBUG=1 bun run repl.ts
```

```
mini-claude REPL
model: claude-haiku-4-5
type /help for commands, /exit to quit

❯ read /etc/hosts and tell me the first non-comment line

I'll read the file for you.

→ read_file(path: "/etc/hosts")
← ##  # Host Database # localhost is used to configure the loopback…

The first non-comment line is: 127.0.0.1    localhost

���─ turn ended · stop=end_turn · in:783 out:57 ──
[done · 2 turns · total in:1403 out:125]
```

Web search works out of the box — Anthropic's API handles it server-side:

```
❯ Who won the mass recent NBA finals?

→ web_search(query: "NBA Finals 2025 winner")
  ← (server-side result)

The Oklahoma City Thunder won the 2025 NBA Finals...

── turn ended · stop=end_turn · in:8924 out:186 ──
```

Dangerous tools require permission:

```
❯ write "hello" to /tmp/demo.txt

→ write_file(path: "/tmp/demo.txt", content: "hello")
   ⚠ requires permission
     y = allow once    n = deny    a = always allow this tool for the session
   › y

← wrote 5 bytes to /tmp/demo.txt
```

## Architecture

```
repl.ts           terminal UI: input, rendering, slash commands
   ↓
agent.ts          agent loop: tool dispatch, history, permission gate
   ↓
claude.ts         API client: fetch + SSE streaming + server tool support
   ↓
auth.ts           OAuth: macOS Keychain token read + auto-refresh
tools.ts          tool definitions: read, list, write, delete files
permissions.ts    interactive y/n/a prompts + session allowlist
ui.ts             ANSI colors, tool-call/result formatters
debug.ts          opt-in stderr logging with subsystems and levels
```

### The agent loop

`runAgent()` is an async generator that yields events as things happen:

```
user message
   → stream API response (text + tool_use blocks)
      → execute tools locally (or server-side for web search)
         → append results to history
            → loop until no more tool calls
               → done
```

Each iteration: call `/v1/messages` with full history + tool schemas, stream
the response, execute any tool calls, feed results back, repeat. The API is
stateless — you send the entire conversation every time.

### Client tools vs server tools

| | Client tools | Server tools |
|---|---|---|
| **Examples** | `read_file`, `write_file`, `delete_file` | `web_search` |
| **Who executes** | mini-claude (locally) | Anthropic's API (server-side) |
| **Round-trip** | API returns `tool_use` → you execute → send `tool_result` → loop | API executes internally → returns result in same response |
| **Permission** | `isDangerous` tools require y/n/a approval | No permission needed |

### Files

| File | Lines | What it does |
|---|---|---|
| `claude.ts` | ~340 | SSE stream parser, `server_tool_use`/`web_search_tool_result` handling, OAuth bearer auth |
| `agent.ts` | ~230 | Async generator agent loop, tool dispatch, permission gate, usage tracking |
| `tools.ts` | ~250 | `Tool<I,O>` type system with `AnyTool` erasure, 4 built-in file tools |
| `permissions.ts` | ~115 | Interactive prompts, session allowlist, `allowAll`/`denyDangerous` policies |
| `auth.ts` | ~100 | macOS Keychain read, token refresh via `platform.claude.com` |
| `repl.ts` | ~175 | Terminal loop, slash commands, event rendering |
| `debug.ts` | ~135 | `makeLogger(subsystem)`, silent by default, `DEBUG=1` to enable |
| `ui.ts` | ~125 | ANSI helpers, `formatToolCall`, `formatToolResult` |

Zero runtime dependencies beyond Bun.

## Evaluation

mini-claude ships with a **black-box evaluation harness** that tests the agent
end-to-end, exactly the way a human would interact with it.

### How it works

The eval spawns mini-claude as a **subprocess** and communicates through
stdin/stdout — no imports from mini-claude internals. An LLM evaluator
(Claude Sonnet) plays the role of a user:

```
                    stdin/stdout
  eval runner  ←──────────────────→  mini-claude subprocess
       ↓                                    ↓
  LLM evaluator                     real agent loop
  (Claude Sonnet)                   real tools
       ↓                            real permissions
  reads terminal output
  decides: goal_met / give_up / send_message / approve / deny
```

The evaluator sees **exactly what a human would see** — streaming text, tool
call arrows (`���`/`←`), permission prompts, error messages. It makes structured
JSON decisions about whether success criteria are met.

### What it tests

**13 tasks** across two categories:

**File tools** (7 tasks)
- Read, list, write, delete files
- Multi-step chains (read → transform → write)
- Error recovery (missing files)
- Permission handling (approve and deny flows)

**Web search** (6 tasks)
- Basic factual queries requiring current information
- Synthesis and comparison from search results
- Search → file tool chains (research and save)
- Multi-turn follow-up conversations
- Answer formatting requirements
- General knowledge (search not needed)

### Run it

```sh
bun run eval/runner.ts                          # all 13 tasks
bun run eval/runner.ts '--only=web_search*'     # web search tasks only
bun run eval/runner.ts --only=write_file_approved  # single task
bun run eval/runner.ts --list                   # list all tasks
```

### TDD workflow

Write the eval task first, then implement the feature:

```sh
# 1. Add a task for a capability that doesn't exist yet
# 2. Run it — expect failure
bun run eval/runner.ts --only=my_new_task

# 3. Implement the feature
# 4. Run again — expect pass
bun run eval/runner.ts --only=my_new_task

# 5. Regression check
bun run eval/runner.ts
```

### Web portal

```sh
bun run eval/portal.ts    # http://localhost:3333
```

Browse run results in a web UI: score summaries, per-task cards with goals
and success criteria, full conversation timelines showing user messages,
mini-claude responses, permission decisions, and evaluator reasoning.

### Logs

Every run writes JSONL to `eval/runs/<timestamp>.jsonl` — full conversation
trajectories, evaluator thinking at each decision point, and outcomes.

## REPL commands

| Command | What it does |
|---|---|
| `/exit` | quit |
| `/clear` | reset conversation history |
| `/history` | show history length |
| `/model [name]` | get/set model (default: `claude-haiku-4-5`) |
| `/tools` | list available tools |
| `/allowed` | show session allowlist |
| `/revoke` | clear the session allowlist |
| `/help` | show commands |

## What's not here (yet)

- `bash` tool (shell command execution)
- `grep`/`glob` tools (code search)
- `edit_file` (diff-based editing)
- Concurrent tool execution
- Context compaction (conversation summarization)
- Session persistence

## Authentication

mini-claude supports two auth modes:

| Mode | How | Models | Platform |
|---|---|---|---|
| **API key** | `export ANTHROPIC_API_KEY=sk-ant-...` | All models | Any |
| **OAuth** | `claude` CLI logged in | Haiku only* | macOS |

\* Anthropic's server-side classifier restricts non-Claude-Code OAuth traffic.
Sonnet/Opus return 429 via OAuth. Use an API key for full model access.

## Prerequisites

- [Bun](https://bun.sh) >= 1.3
- One of: `ANTHROPIC_API_KEY` env var, or `claude` CLI logged in (macOS)

## License

MIT
