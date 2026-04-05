# mini-claude

A minimal Claude Code, built from scratch for learning.

Direct Anthropic Messages API client using Claude Code's OAuth credentials — no SDK,
no subprocess, no hidden system prompts. Built alongside
[claude-code-source](https://github.com/anthropics/claude-code) as a learning exercise.

## Files

- `auth.ts` — reads OAuth token from macOS Keychain, refreshes automatically
- `claude.ts` — direct `fetch` wrapper around `/v1/messages` with streaming support
- `test.ts` — smoke tests

## Run

```sh
bun run test.ts
```

## Prerequisites

- macOS (Keychain-based credential storage)
- `claude` CLI logged in (Max/Pro subscription)
- [Bun](https://bun.sh) runtime
