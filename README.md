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
- **MCP (Model Context Protocol)** — connect to external tool servers (GitHub, etc.) via stdio or HTTP
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
repl.ts            terminal UI: input, rendering, slash commands
   ↓
agent.ts           agent loop: tool dispatch, history, permission gate
   ↓
claude.ts          API client: fetch + SSE streaming + server tool support
   ↓
auth.ts            auth: API key or OAuth (macOS Keychain)
tools.ts           built-in tool definitions: read, list, write, delete files
mcp/client.ts      MCP client: stdio + HTTP transports (JSON-RPC 2.0)
mcp/tools.ts       MCP tool loader: reads .mcp.json, discovers tools
permissions.ts     interactive y/n/a prompts + session allowlist
ui.ts              ANSI colors, tool-call/result formatters
debug.ts           opt-in stderr logging with subsystems and levels
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

### Three kinds of tools

| | Built-in tools | MCP tools | Server tools |
|---|---|---|---|
| **Examples** | `read_file`, `write_file` | `mcp__github__create_issue` | `web_search` |
| **Defined in** | `tools.ts` | External MCP server | Anthropic's API |
| **Who executes** | mini-claude | MCP server (local or remote) | Anthropic |
| **Permission** | `isDangerous` → y/n/a | No (currently) | No |

### MCP (Model Context Protocol)

MCP lets mini-claude use tools from external servers — without writing any
tool-specific code. Configure `.mcp.json`, and mini-claude discovers tools
automatically at startup via the MCP protocol.

```sh
cp .mcp.example.json .mcp.json
# edit .mcp.json — add your GitHub token, Slack server, etc.
bun run repl.ts
```

Two transports supported:

| Transport | Use case | Config |
|---|---|---|
| **stdio** | Local adapter (npm package) | `"command": "bun", "args": [...]` |
| **HTTP** | Remote hosted server (e.g. GitHub) | `"type": "http", "url": "https://..."` |

Example `.mcp.json`:

```json
{
  "mcpServers": {
    "test": {
      "command": "bun",
      "args": ["run", "eval/test-mcp-server.ts"]
    },
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer YOUR_GITHUB_TOKEN" }
    }
  }
}
```

MCP tools appear alongside built-in tools — Claude doesn't know the difference.
The naming convention is `mcp__<server>__<tool>` (e.g., `mcp__github__create_issue`).

### Core files

| File | What it does |
|---|---|
| `claude.ts` | SSE stream parser, server tool handling, API key + OAuth auth |
| `agent.ts` | Async generator agent loop, tool dispatch, permission gate |
| `tools.ts` | `Tool<I,O>` type system with `AnyTool` erasure, 4 built-in file tools |
| `mcp/client.ts` | MCP client: stdio + HTTP transports, JSON-RPC 2.0 protocol |
| `mcp/tools.ts` | Reads `.mcp.json`, connects to servers, converts MCP tools to `AnyTool` |
| `permissions.ts` | Interactive y/n/a prompts, session allowlist |
| `auth.ts` | API key or macOS Keychain OAuth with auto-refresh |
| `repl.ts` | Terminal loop, slash commands, event rendering, MCP tool loading |
| `debug.ts` | `makeLogger(subsystem)`, silent by default, `DEBUG=1` to enable |
| `ui.ts` | ANSI helpers, `formatToolCall`, `formatToolResult` |

### Eval files

| File | What it does |
|---|---|
| `eval/tasks.ts` | 38 task definitions grouped by difficulty and capability |
| `eval/types.ts` | `Task`, `TurnRecord`, `ConversationResult` types |
| `eval/subprocess.ts` | Spawns the mini-claude REPL, exposes stdin/stdout helpers |
| `eval/evaluator.ts` | LLM-as-user via `claude -p`: opening message gen, turn decisions, permission decisions |
| `eval/run-task.ts` | Core task loop as an async generator yielding `TaskEvent`s |
| `eval/runner.ts` | CLI runner — consumes `runTaskStream`, prints to terminal, writes JSONL |
| `eval/portal.ts` | Web portal — task list, live SSE runs, past-run browsing |
| `eval/test-mcp-server.ts` | Tiny JSON-RPC MCP server (echo + add tools) for eval fixtures |

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
  (Claude Sonnet)                   real tools + MCP + permissions
       ↓
  reads terminal output
  decides: goal_met / give_up / send_message / approve / deny
```

The evaluator sees **exactly what a human would see** — streaming text, tool
call arrows, permission prompts, error messages. It makes structured JSON
decisions at every turn.

**The evaluator even writes its own first message.** Each task is defined by
a `goal` describing what capability is being tested. Before turn 1, the
evaluator reads the goal and phrases a natural user message to start the
conversation. Same run of the same task looks slightly different every time.

### What it tests

**38 tasks** across five categories:

| Category | Count | What it covers |
|---|---|---|
| **Core** | 7 | Read, list, write, delete, multi-step chains, error recovery, permission handling |
| **Web search** | 6 | Factual queries, synthesis, search+write chains, follow-ups, formatting, knowledge-only |
| **MCP test server** | 5 | Tool discovery, echo, add, MCP+file chains, unknown tool recovery |
| **GitHub integration** | 5 | Repo info, issues, file reads, issue creation, commits+save chain |
| **Medium difficulty** | 5 | News digest, tech explainer, CLI tool, gift research, data dashboard |
| **Hard (north star)** | 10 | Indie game, equity research, trip planning, year-in-review, book writing, curriculum design, startup validation, complex purchase, literature review, SaaS prototype |

The hard tasks are **aspirational** — most will fail today. They exist to
drive the roadmap: if mini-claude can ship a playable game or produce an
institutional-grade equity report, we're doing well.

### Run from the CLI

```sh
bun run eval/runner.ts                              # all tasks
bun run eval/runner.ts '--only=web_search*'         # group wildcard
bun run eval/runner.ts '--only=mcp*,github*'        # comma-separated groups
bun run eval/runner.ts --only=write_file_approved   # single task
bun run eval/runner.ts --list                       # list all tasks
```

### Or run from the web portal (interactive)

```sh
bun run eval/portal.ts   # http://localhost:3333
```

The portal has two modes:

**Run tasks** (live) — Pick a task from the grouped sidebar, click ▶ Run,
and watch events stream in real time as the task runs on the server:
- Setup progress, subprocess spawn, greeting
- User messages (phrased dynamically by the evaluator)
- mini-claude's response bubbles
- Permission prompts with the evaluator's approve/deny thinking
- Evaluator decisions at each turn
- Final verdict

**Past runs** (replay) — Browse JSONL logs from previous runs. Each task
card shows goal, success criteria, evaluator verdict, and a full chat-bubble
conversation timeline. A ▶ Replay button animates through the turns one at
a time so you can watch old runs unfold.

### TDD workflow

Write the eval task first, then implement the feature:

```sh
# 1. Add a task for a capability that doesn't exist yet
# 2. Run it — expect failure
bun run eval/runner.ts --only=my_new_task

# 3. Implement the feature
# 4. Run again — expect pass
bun run eval/runner.ts --only=my_new_task
```

### Logs

Every run writes JSONL to `eval/runs/<timestamp>.jsonl` — full conversation
trajectories, evaluator thinking at each decision point, and outcomes. The
portal reads these for the past-runs view.

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
- Context compaction (conversation summarization)
- Concurrent tool execution
- Session persistence
- MCP tool permission controls

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
