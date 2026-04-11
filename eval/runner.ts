/**
 * CLI eval runner — drives a real mini-claude REPL subprocess and a simulated
 * user (evaluator). The subprocess is a black box: we interact through
 * stdin/stdout only, exactly like a human would.
 *
 * NO IMPORTS from mini-claude internals (tools, agent, permissions, etc).
 *
 * The core loop lives in run-task.ts as an async generator. This file just
 * consumes the event stream for each task and writes to the terminal + JSONL.
 *
 * Run:
 *   bun run eval/runner.ts
 *   bun run eval/runner.ts --only=read_file_capability
 *   bun run eval/runner.ts --only='web_search*'
 *   bun run eval/runner.ts --list
 */

import { mkdir } from 'node:fs/promises'
import { bold, cyan, dim, gray, green, red, yellow } from '../ui.ts'
import { runTaskStream } from './run-task.ts'
import { TASKS } from './tasks.ts'
import type { ConversationResult, Task } from './types.ts'

// ── Rendering ────────────────────────────────────────────────────────────────

function outcomeColor(o: string): (s: string) => string {
  return o === 'goal_met' ? green : o === 'error' ? red : yellow
}

/**
 * Consume the async event stream from runTaskStream() and print to the
 * terminal as events arrive. Returns the final ConversationResult.
 */
async function runOneTask(task: Task): Promise<ConversationResult> {
  console.log()
  console.log(gray('═'.repeat(60)))
  console.log(bold(`▸ ${task.name}`))
  console.log(dim(`  goal: ${task.goal}`))
  if (task.persona) console.log(dim(`  persona: ${task.persona}`))

  let result: ConversationResult | null = null

  for await (const ev of runTaskStream(task)) {
    switch (ev.type) {
      case 'setup_start':
        console.log(dim('  ⚙ running setup...'))
        break
      case 'setup_error':
        console.log(red(`  ✗ setup failed: ${ev.error}`))
        break
      case 'repl_booting':
        console.log(dim('  ◐ spawning mini-claude subprocess...'))
        break
      case 'repl_ready':
        console.log(dim('  ● mini-claude ready'))
        break
      case 'evaluator_thinking':
        console.log(dim(`  💭 evaluator: ${ev.reason}`))
        break
      case 'user_message':
        console.log(`  ${cyan('👤 user')} (turn ${ev.turnNum}): ${dim(ev.message.slice(0, 120))}`)
        break
      case 'agent_output':
        if (ev.output.trim()) {
          const lines = ev.output.split('\n').filter(l => l.trim())
          for (const line of lines) console.log(dim(`    │ ${line}`))
        }
        break
      case 'permission_prompt':
        console.log(yellow('  ⚠ mini-claude asking for permission...'))
        break
      case 'permission_decision': {
        const mark = ev.action === 'approve' ? green('✓ APPROVE') : red('✗ DENY')
        console.log(`  ${yellow('⚠ permission')} ${mark}`)
        console.log(dim(`    💭 ${ev.thinking}`))
        if (ev.why) console.log(dim(`    reason: ${ev.why}`))
        break
      }
      case 'evaluator_decision': {
        console.log(dim(`  💭 evaluator: ${ev.thinking}`))
        if (ev.action === 'goal_met') {
          console.log(`  ${green('✓ goal met')}: ${dim(ev.summary || '')}`)
        } else if (ev.action === 'give_up') {
          console.log(`  ${red('✗ giving up')}: ${dim(ev.reason || '')}`)
        } else if (ev.action === 'send_message') {
          console.log(`  ${cyan('➜')} will reply: ${dim('"' + (ev.message || '').slice(0, 100) + '"')}`)
        }
        break
      }
      case 'task_timeout':
        console.log(red(`  ⏱ timeout: ${ev.message}`))
        break
      case 'task_error':
        console.log(red(`  ✗ error: ${ev.error}`))
        break
      case 'task_done':
        result = ev.result
        break
    }
  }

  if (!result) {
    throw new Error(`task ${task.name} produced no result`)
  }

  console.log()
  const oc = outcomeColor(result.outcome)
  const label = result.outcome.toUpperCase().replace(/_/g, ' ')
  console.log(`  ${oc(label)} · ${dim(`${result.turns.length} turns · ${(result.totalWallMs / 1000).toFixed(1)}s`)}`)
  if (result.finalSummary) console.log(dim(`  summary: ${result.finalSummary}`))
  if (result.giveUpReason) console.log(dim(`  reason: ${result.giveUpReason}`))
  if (result.errorMessage) console.log(red(`  error: ${result.errorMessage}`))

  return result
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const modelArg = args.find(a => a.startsWith('--model='))
  const model = modelArg ? modelArg.slice('--model='.length) : 'claude-haiku-4-5'
  const onlyArg = args.find(a => a.startsWith('--only='))
  const onlyName = onlyArg ? onlyArg.slice('--only='.length) : null

  if (args.includes('--list')) {
    console.log(bold('Available tasks:'))
    for (const t of TASKS) {
      console.log(`  ${t.name}${dim(` — ${t.goal.slice(0, 80)}${t.goal.length > 80 ? '…' : ''}`)}`)
    }
    process.exit(0)
  }

  // --only supports exact name, prefix with wildcard (web_search*), or comma-separated
  let tasks: Task[]
  if (onlyName) {
    if (onlyName.includes(',')) {
      const names = onlyName.split(',')
      tasks = TASKS.filter(t => names.includes(t.name))
    } else if (onlyName.endsWith('*')) {
      const prefix = onlyName.slice(0, -1)
      tasks = TASKS.filter(t => t.name.startsWith(prefix))
    } else {
      tasks = TASKS.filter(t => t.name === onlyName)
    }
  } else {
    tasks = TASKS
  }
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

  console.log(bold('mini-claude eval — subprocess mode'))
  console.log(dim(`mini-claude model: ${model} · evaluator: claude-sonnet-4-6`))
  console.log(dim(`tasks: ${tasks.length} · log: ${logPath}`))

  writeLog({
    type: 'run_start',
    timestamp: new Date().toISOString(),
    model,
    evaluatorModel: 'claude-sonnet-4-6',
    tasks: tasks.map(t => t.name),
  })

  const results: ConversationResult[] = []

  for (const task of tasks) {
    const result = await runOneTask(task)
    results.push(result)

    writeLog({
      type: 'task_result',
      task: task.name,
      goal: task.goal,
      successCriteria: task.successCriteria,
      persona: task.persona,
      outcome: result.outcome,
      finalSummary: result.finalSummary,
      giveUpReason: result.giveUpReason,
      errorMessage: result.errorMessage,
      conversationLog: result.conversationLog,
      turns: result.turns,
      wallMs: result.totalWallMs,
    })
  }

  logFile.end()

  // Summary
  const met = results.filter(r => r.outcome === 'goal_met').length
  console.log()
  console.log(gray('─'.repeat(60)))
  const color = met === tasks.length ? green : yellow
  console.log(color(`${met}/${tasks.length} goals met`) + dim(` · ${results.reduce((s, r) => s + r.turns.length, 0)} total turns`))

  process.exit(met === tasks.length ? 0 : 1)
}

main()
