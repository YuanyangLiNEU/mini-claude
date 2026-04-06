/**
 * Eval runner — drives a real mini-claude REPL subprocess and a simulated
 * user (evaluator). The subprocess is a black box: we interact through
 * stdin/stdout only, exactly like a human would.
 *
 * NO IMPORTS from mini-claude internals (tools, agent, permissions, etc).
 *
 * Run:
 *   bun run eval/runner.ts
 *   bun run eval/runner.ts --only=read_file_capability
 *   bun run eval/runner.ts --list
 */

import { mkdir } from 'node:fs/promises'
import { bold, cyan, dim, gray, green, red, yellow } from '../ui.ts'
import { decideNextStep, decidePermission } from './evaluator.ts'
import { spawnMiniClaude } from './subprocess.ts'
import { TASKS } from './tasks.ts'
import type { ConversationResult, Task, TurnRecord } from './types.ts'

async function runOneTask(task: Task): Promise<ConversationResult> {
  if (task.setup) await task.setup()

  const maxTurns = task.maxTurns ?? 6
  const turns: TurnRecord[] = []
  let outcome: ConversationResult['outcome'] = 'max_turns'
  let finalSummary: string | undefined
  let giveUpReason: string | undefined
  let errorMessage: string | undefined
  const convoStart = Date.now()

  // Full conversation transcript (what we show the evaluator for context)
  let conversationLog = ''

  const mc = spawnMiniClaude()

  try {
    // Wait for the REPL to boot (greeting + first ❯ prompt)
    const greeting = await mc.waitForIdle()
    conversationLog += greeting.output

    let nextMessage = task.openingMessage

    for (let turnNum = 1; turnNum <= maxTurns; turnNum++) {
      // Send user message
      mc.sendMessage(nextMessage)
      conversationLog += `\n[USER]: ${nextMessage}\n`

      // Wait for mini-claude to respond
      const { output, reason } = await mc.waitForIdle()
      conversationLog += output

      if (reason === 'timeout') {
        outcome = 'error'
        errorMessage = 'mini-claude timed out (no prompt detected)'
        break
      }

      if (reason === 'permission') {
        // mini-claude is asking for permission — ask the evaluator
        const permDecision = await decidePermission(task, conversationLog, output)

        turns.push({
          turnNum,
          rawOutput: output,
          idleReason: reason,
          permissionDecision: {
            action: permDecision.action,
            thinking: permDecision.thinking,
            why: permDecision.action === 'deny' ? permDecision.why : undefined,
          },
        })

        // Type the answer
        const answer = permDecision.action === 'approve' ? 'y' : 'n'
        mc.answerPermission(answer)
        conversationLog += `\n[USER PERMISSION]: ${answer}\n`

        // Wait for mini-claude to finish processing after the permission answer
        const postPerm = await mc.waitForIdle()
        conversationLog += postPerm.output

        if (postPerm.reason === 'timeout') {
          outcome = 'error'
          errorMessage = 'mini-claude timed out after permission answer'
          break
        }

        // Now ask the evaluator: is the goal met?
        const decision = await decideNextStep(task, conversationLog, postPerm.output)

        turns.push({
          turnNum: turnNum + 0.5, // sub-turn after permission
          rawOutput: postPerm.output,
          idleReason: postPerm.reason,
          evaluatorDecision: {
            action: decision.action,
            thinking: decision.thinking,
            summary: decision.action === 'goal_met' ? decision.summary : undefined,
            reason: decision.action === 'give_up' ? decision.reason : undefined,
            message: decision.action === 'send_message' ? decision.message : undefined,
          },
        })

        if (decision.action === 'goal_met') {
          outcome = 'goal_met'
          finalSummary = decision.summary
          break
        }
        if (decision.action === 'give_up') {
          outcome = 'give_up'
          giveUpReason = decision.reason
          break
        }
        nextMessage = decision.message
        continue
      }

      // reason === 'prompt' — normal turn completion
      const decision = await decideNextStep(task, conversationLog, output)

      turns.push({
        turnNum,
        rawOutput: output,
        idleReason: reason,
        evaluatorDecision: {
          action: decision.action,
          thinking: decision.thinking,
          summary: decision.action === 'goal_met' ? decision.summary : undefined,
          reason: decision.action === 'give_up' ? decision.reason : undefined,
          message: decision.action === 'send_message' ? decision.message : undefined,
        },
      })

      if (decision.action === 'goal_met') {
        outcome = 'goal_met'
        finalSummary = decision.summary
        break
      }
      if (decision.action === 'give_up') {
        outcome = 'give_up'
        giveUpReason = decision.reason
        break
      }
      nextMessage = decision.message
    }
  } catch (err) {
    outcome = 'error'
    errorMessage = err instanceof Error ? err.message : String(err)
  } finally {
    mc.shutdown()
    if (task.cleanup) {
      try { await task.cleanup() } catch {}
    }
  }

  return {
    task,
    turns,
    conversationLog,
    outcome,
    finalSummary,
    giveUpReason,
    errorMessage,
    totalWallMs: Date.now() - convoStart,
  }
}

// ── Rendering ────────────────────────────────────────────────────────────────

function printTurn(turn: TurnRecord): void {
  // Permission decision
  if (turn.permissionDecision) {
    const pd = turn.permissionDecision
    const mark = pd.action === 'approve' ? green('✓ APPROVE') : red('✗ DENY')
    console.log(`   ${yellow('⚠ permission')} ${mark}`)
    console.log(dim(`     💭 ${pd.thinking}`))
    if (pd.why) console.log(dim(`     reason: ${pd.why}`))
  }

  // Evaluator decision
  if (turn.evaluatorDecision) {
    const d = turn.evaluatorDecision
    console.log(dim(`   💭 evaluator: ${d.thinking}`))
    if (d.action === 'goal_met') {
      console.log(`   ${green('✓ goal met')}: ${dim(d.summary || '')}`)
    } else if (d.action === 'give_up') {
      console.log(`   ${red('✗ giving up')}: ${dim(d.reason || '')}`)
    } else if (d.action === 'send_message') {
      console.log(`   ${cyan('➜')} will reply: ${dim('"' + (d.message || '').slice(0, 100) + '"')}`)
    }
  }
}

function outcomeColor(o: string): (s: string) => string {
  return o === 'goal_met' ? green : o === 'error' ? red : yellow
}

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
    console.log()
    console.log(gray('═'.repeat(60)))
    console.log(bold(`▸ ${task.name}`))
    console.log(dim(`  goal: ${task.goal}`))
    if (task.setupDescription) console.log(dim(`  setup: ${task.setupDescription}`))
    if (task.persona) console.log(dim(`  persona: ${task.persona}`))

    const result = await runOneTask(task)
    results.push(result)

    // Print raw mini-claude output (indented)
    if (result.conversationLog) {
      console.log()
      const lines = result.conversationLog.split('\n')
      for (const line of lines) {
        if (line.trim()) console.log(dim(`  │ ${line}`))
      }
    }

    // Print evaluator decisions
    for (const turn of result.turns) {
      printTurn(turn)
    }

    console.log()
    const oc = outcomeColor(result.outcome)
    const label = result.outcome.toUpperCase().replace(/_/g, ' ')
    console.log(`   ${oc(label)} · ${dim(`${result.turns.length} turns · ${(result.totalWallMs / 1000).toFixed(1)}s`)}`)
    if (result.finalSummary) console.log(dim(`   summary: ${result.finalSummary}`))
    if (result.giveUpReason) console.log(dim(`   reason: ${result.giveUpReason}`))
    if (result.errorMessage) console.log(red(`   error: ${result.errorMessage}`))

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
