/**
 * Eval runner — drives a conversation between a simulated user (evaluator)
 * and mini-claude for each task. Prints each turn as it happens: user
 * messages, mini-claude's actions, evaluator thinking, permission
 * decisions, and the final outcome.
 *
 * Run:
 *   bun run eval/runner.ts
 *   bun run eval/runner.ts --only=permission_denied_recovery
 *   bun run eval/runner.ts --model=claude-haiku-4-5
 */

import { mkdir } from 'node:fs/promises'
import { readFileTool, listFilesTool, writeFileTool } from '../tools.ts'
import { bold, cyan, dim, gray, green, red, yellow } from '../ui.ts'
import { runConversation, type ConversationEvent } from './conversation.ts'
import { TASKS } from './tasks.ts'
import type { ConversationResult, MiniClaudeAction } from './types.ts'

const TOOLS = [readFileTool, listFilesTool, writeFileTool]

function outcomeColor(outcome: ConversationResult['outcome']): (s: string) => string {
  switch (outcome) {
    case 'goal_met':
      return green
    case 'give_up':
    case 'max_turns':
      return yellow
    case 'error':
      return red
  }
}

function indent(text: string, prefix = '   '): string {
  return text
    .split('\n')
    .map(line => prefix + line)
    .join('\n')
}

function fmtActionInline(a: MiniClaudeAction): string {
  if (a.type === 'text') {
    const t = a.text.replace(/\n/g, ' ').trim()
    return t.length > 120 ? t.slice(0, 120) + '…' : t
  }
  if (a.type === 'tool_call') {
    const input = JSON.stringify(a.input)
    return `${cyan('→')} ${bold(a.name)}(${input.length > 80 ? input.slice(0, 80) + '…' : input})`
  }
  const tag = a.isError ? red('✗') : dim('←')
  const result = a.result.replace(/\n/g, ' ').trim()
  return `${tag} ${dim(result.length > 120 ? result.slice(0, 120) + '…' : result)}`
}

function printEvent(event: ConversationEvent): void {
  switch (event.type) {
    case 'conversation_start':
      break
    case 'user_message':
      console.log()
      console.log(
        gray(`━━━━━━━━━━━━━━━ turn ${event.turnNum} ━━━━━━━━━━━━━━━`),
      )
      console.log(`${bold(cyan('👤 user'))}: ${event.text}`)
      break
    case 'mini_claude_turn_start':
      break
    case 'mini_claude_action':
      console.log(indent(fmtActionInline(event.action)))
      break
    case 'mini_claude_turn_end':
      console.log(
        dim(
          `   ${event.metrics.turns} tool-loop turn${event.metrics.turns === 1 ? '' : 's'} · ${event.metrics.inputTokens} in / ${event.metrics.outputTokens} out · ${(event.metrics.wallMs / 1000).toFixed(1)}s`,
        ),
      )
      break
    case 'permission_decision': {
      const mark =
        event.decision === 'approve'
          ? green('✓ APPROVED')
          : red('✗ DENIED')
      console.log()
      console.log(
        `   ${yellow('⚠ permission prompt')}: ${bold(event.toolName)}(${JSON.stringify(event.toolInput)})`,
      )
      console.log(dim(`     💭 ${event.thinking}`))
      console.log(`     ${mark}${event.why ? dim(' — ' + event.why) : ''}`)
      break
    }
    case 'evaluator_decision': {
      console.log()
      const d = event.decision
      console.log(dim(`   💭 evaluator: ${d.thinking}`))
      if (d.action === 'goal_met') {
        console.log(`   ${green('✓ goal met')}: ${dim(d.summary)}`)
      } else if (d.action === 'give_up') {
        console.log(`   ${red('✗ giving up')}: ${dim(d.reason)}`)
      } else if (d.action === 'send_message') {
        console.log(
          `   ${cyan('➜')} will reply: ${dim('"' + d.message.slice(0, 100) + (d.message.length > 100 ? '…' : '') + '"')}`,
        )
      }
      break
    }
    case 'conversation_end':
      break
  }
}

async function main() {
  const args = process.argv.slice(2)
  const modelArg = args.find(a => a.startsWith('--model='))
  const model = modelArg ? modelArg.slice('--model='.length) : 'claude-haiku-4-5'
  const onlyArg = args.find(a => a.startsWith('--only='))
  const onlyName = onlyArg ? onlyArg.slice('--only='.length) : null

  // Support --list to just print available tasks
  if (args.includes('--list')) {
    console.log(bold('Available tasks:'))
    for (const t of TASKS) {
      console.log(`  ${t.name}${dim(` — ${t.goal.slice(0, 80)}${t.goal.length > 80 ? '…' : ''}`)}`)
    }
    process.exit(0)
  }

  const tasks = onlyName ? TASKS.filter(t => t.name === onlyName) : TASKS
  if (tasks.length === 0) {
    console.error(red(`no tasks matched --only=${onlyName}`))
    console.error(dim('Available tasks:'))
    for (const t of TASKS) console.error(dim(`  ${t.name}`))
    process.exit(1)
  }

  // Logging
  const runId = new Date().toISOString().replace(/[:.]/g, '-')
  const logPath = `${import.meta.dir}/runs/${runId}.jsonl`
  await mkdir(`${import.meta.dir}/runs`, { recursive: true })
  const logFile = Bun.file(logPath).writer()
  const writeLog = (record: Record<string, unknown>): void => {
    logFile.write(JSON.stringify(record) + '\n')
  }

  console.log(bold(`mini-claude eval — conversational`))
  console.log(dim(`model: ${model} · tasks: ${tasks.length} · evaluator: claude-sonnet-4-6`))
  console.log(dim(`log: ${logPath}`))

  writeLog({
    type: 'run_start',
    timestamp: new Date().toISOString(),
    model,
    evaluatorModel: 'claude-sonnet-4-6',
    tasks: tasks.map(t => t.name),
  })

  const results: ConversationResult[] = []

  for (const task of tasks) {
    console.log()
    console.log(gray('═'.repeat(60)))
    console.log(`${bold('▸ ' + task.name)}`)
    console.log(dim(`  goal: ${task.goal}`))
    console.log(
      dim(
        `  criteria: ${task.successCriteria.length} item${task.successCriteria.length === 1 ? '' : 's'}`,
      ),
    )
    if (task.setupDescription) {
      console.log(dim(`  setup: ${task.setupDescription}`))
    }
    if (task.persona) {
      console.log(dim(`  persona: ${task.persona}`))
    }

    const result = await runConversation({
      task,
      tools: TOOLS,
      model,
      onEvent: printEvent,
    })
    results.push(result)

    console.log()
    const oc = outcomeColor(result.outcome)
    const label = result.outcome.toUpperCase().replace(/_/g, ' ')
    const permissionCount = result.turns.filter(t => t.permissionEvent).length
    const permissionSuffix = permissionCount > 0 ? ` · ${permissionCount} permission prompt${permissionCount === 1 ? '' : 's'}` : ''
    console.log(
      `   ${oc(label)} · ${dim(`${result.turns.length} conversation turn${result.turns.length === 1 ? '' : 's'}${permissionSuffix} · ${result.totalMiniClaudeInputTokens} in / ${result.totalMiniClaudeOutputTokens} out · ${(result.totalWallMs / 1000).toFixed(1)}s`)}`,
    )
    if (result.outcome === 'goal_met' && result.finalSummary) {
      console.log(dim(`   summary: ${result.finalSummary}`))
    }
    if (result.outcome === 'give_up' && result.giveUpReason) {
      console.log(dim(`   reason: ${result.giveUpReason}`))
    }
    if (result.outcome === 'error' && result.errorMessage) {
      console.log(red(`   error: ${result.errorMessage}`))
    }

    writeLog({
      type: 'task_result',
      task: task.name,
      goal: task.goal,
      successCriteria: task.successCriteria,
      openingMessage: task.openingMessage,
      persona: task.persona,
      setupDescription: task.setupDescription,
      outcome: result.outcome,
      finalSummary: result.finalSummary,
      giveUpReason: result.giveUpReason,
      errorMessage: result.errorMessage,
      metrics: {
        conversationTurns: result.turns.length,
        wallMs: result.totalWallMs,
        miniClaudeInputTokens: result.totalMiniClaudeInputTokens,
        miniClaudeOutputTokens: result.totalMiniClaudeOutputTokens,
      },
      turns: result.turns,
    })
  }

  logFile.end()

  // Summary
  const met = results.filter(r => r.outcome === 'goal_met').length
  const total = results.length
  console.log()
  console.log(gray('─'.repeat(60)))
  const color = met === total ? green : yellow
  console.log(
    color(`${met}/${total} goals met`) +
      dim(
        ` · ${results.reduce((s, r) => s + r.turns.length, 0)} total conversation turns`,
      ),
  )

  process.exit(met === total ? 0 : 1)
}

main()
