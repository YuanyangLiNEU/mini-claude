/**
 * Interactive REPL — reads user input, runs the agent, renders events.
 *
 * Each user message is one invocation of runAgent(), which may make multiple
 * API calls (e.g., Claude asks for a tool, we execute it, Claude responds).
 *
 * Commands:
 *   /clear    reset conversation history
 *   /history  show current history length
 *   /model    get/set model
 *   /tools    list available tools
 *   /help     show commands
 *   /exit     quit
 */

import * as readline from 'node:readline/promises'
import { runAgent } from './agent.ts'
import { createInteractivePermissions } from './permissions.ts'
import { deleteFileTool, readFileTool, listFilesTool, writeFileTool, type AnyTool } from './tools.ts'
import { loadMcpTools, shutdownMcpServers } from './mcp/tools.ts'
import type { ApiMessage, ServerTool } from './claude.ts'
import { bold, cyan, dim, gray, red } from './ui.ts'
import { formatToolCall, formatToolResult } from './ui.ts'

const DEFAULT_SYSTEM = [
  // Intro
  'You are an interactive agent that helps users with software engineering tasks.',
  'Use the tools available to you to assist the user.',
  '',
  // Doing tasks
  'When given a task, try the simplest approach first.',
  'Do not add features, refactor code, or make improvements beyond what was asked.',
  'Read existing code before suggesting modifications.',
  'Use absolute paths for file operations.',
  '',
  // Executing with care
  'Carefully consider the reversibility of actions.',
  'For destructive or hard-to-reverse operations, confirm with the user first.',
  '',
  // Tone and style
  'Keep responses brief and direct. Lead with the answer, not the reasoning.',
  'Skip filler words, preamble, and unnecessary transitions.',
  'Do not restate what the user said — just do it.',
  'Only use emojis if the user explicitly requests it.',
].join('\n')

const TOOLS = [readFileTool, listFilesTool, writeFileTool, deleteFileTool]

const SERVER_TOOLS: ServerTool[] = [
  { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
]

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const history: ApiMessage[] = []
  const permissions = createInteractivePermissions(rl)
  let model = 'claude-haiku-4-5'

  // Load MCP tools from .mcp.json (if it exists)
  const mcpTools = await loadMcpTools()
  const allTools: AnyTool[] = [...TOOLS, ...mcpTools]

  console.log(bold('mini-claude REPL'))
  console.log(dim(`model: ${model}`))
  if (mcpTools.length > 0) {
    console.log(dim(`mcp tools: ${mcpTools.map(t => t.name).join(', ')}`))
  }
  console.log(dim('type /help for commands, /exit to quit'))
  console.log()

  while (true) {
    const input = (await rl.question(cyan('❯ '))).trim()
    if (!input) continue

    // --- Slash commands (no API call) ---
    if (input === '/exit' || input === '/quit') break
    if (input === '/clear') {
      history.length = 0
      console.log(dim('history cleared.\n'))
      continue
    }
    if (input === '/history') {
      console.log(dim(`history: ${history.length} messages\n`))
      continue
    }
    if (input.startsWith('/model')) {
      const parts = input.split(/\s+/)
      if (parts.length === 2) {
        model = parts[1]!
        console.log(dim(`model set to: ${model}\n`))
      } else {
        console.log(dim(`current model: ${model}\n`))
      }
      continue
    }
    if (input === '/tools') {
      for (const t of allTools) {
        const danger = t.isDangerous ? red(' [dangerous]') : ''
        console.log(`  ${bold(t.name)}${danger} — ${t.description.split('.')[0]}`)
      }
      console.log()
      continue
    }
    if (input === '/allowed') {
      const list = permissions.getAllowlist()
      if (list.length === 0) {
        console.log(dim('session allowlist: (empty)\n'))
      } else {
        console.log(dim('session allowlist:'))
        for (const name of list) console.log(`  ${name}`)
        console.log()
      }
      continue
    }
    if (input === '/revoke') {
      permissions.clearAllowlist()
      console.log(dim('session allowlist cleared.\n'))
      continue
    }
    if (input === '/help') {
      console.log('  /exit       quit')
      console.log('  /clear      reset conversation history')
      console.log('  /history    show history length')
      console.log('  /model [m]  get/set model (e.g. /model claude-haiku-4-5)')
      console.log('  /tools      list available tools')
      console.log('  /allowed    show session allowlist (always-approved tools)')
      console.log('  /revoke     clear the session allowlist')
      console.log('  /help       show this message\n')
      continue
    }

    // --- User turn: run the agent, render each event ---
    console.log() // blank line between prompt and response
    try {
      for await (const ev of runAgent({
        userInput: input,
        history,
        tools: allTools,
        serverTools: SERVER_TOOLS,
        system: DEFAULT_SYSTEM,
        model,
        canUseTool: permissions.canUseTool,
        maxTurns: 50,
      })) {
        switch (ev.type) {
          case 'turn_start':
            break
          case 'text':
            process.stdout.write(ev.text)
            break
          case 'tool_call':
            process.stdout.write('\n\n' + formatToolCall(ev.name, ev.input) + '\n')
            break
          case 'tool_result':
            process.stdout.write(formatToolResult(ev.result, ev.isError) + '\n\n')
            break
          case 'server_tool_call':
            process.stdout.write('\n\n' + formatToolCall(ev.name, ev.input) + '\n')
            break
          case 'server_tool_result':
            process.stdout.write(dim('  ← (server-side result)') + '\n\n')
            break
          case 'turn_end':
            console.log(
              gray(
                `\n── turn ended · stop=${ev.stopReason} · in:${ev.turnUsage.inputTokens} out:${ev.turnUsage.outputTokens}${ev.turnUsage.cacheReadTokens ? ` cached:${ev.turnUsage.cacheReadTokens}` : ''} ──`,
              ),
            )
            break
          case 'done':
            console.log(
              `\n${gray(`[done · ${ev.turns} turn${ev.turns === 1 ? '' : 's'} · total in:${ev.totalUsage.inputTokens} out:${ev.totalUsage.outputTokens}]`)}`,
            )
            console.log()
            break
          case 'error':
            console.log(red(`\n[error] ${ev.message}\n`))
            break
        }
      }
    } catch (err) {
      console.error(red(`\n[error] ${err instanceof Error ? err.message : String(err)}`))
      console.log()
    }
  }

  shutdownMcpServers()
  rl.close()
  console.log(dim('bye.'))
}

main()
