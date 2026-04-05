/**
 * Eval runner — executes each task through runAgent(), then asks an LLM
 * judge (spawned via `claude -p`) whether the agent met the user's goal.
 *
 * Run:
 *   bun run eval/runner.ts
 *   bun run eval/runner.ts --only=read_file_capability
 *   bun run eval/runner.ts --model=claude-haiku-4-5
 */

import { runAgent } from '../agent.ts'
import type { ApiMessage } from '../claude.ts'
import { allowAll } from '../permissions.ts'
import { readFileTool, listFilesTool, writeFileTool } from '../tools.ts'
import { bold, dim, gray, green, red, yellow } from '../ui.ts'
import { judgeTask, type JudgeVerdict } from './judge.ts'
import { TASKS } from './tasks.ts'
import type { RunMetrics, Task, TaskResult, ToolCallRecord } from './types.ts'

const SYSTEM_PROMPT =
  'You are a helpful assistant with file tools (read_file, list_files, write_file). ' +
  'Use absolute paths. Keep responses brief and direct.'

const TOOLS = [readFileTool, listFilesTool, writeFileTool]

async function runOneTask(task: Task, model: string): Promise<TaskResult> {
  if (task.setup) await task.setup()

  const history: ApiMessage[] = []
  const toolCalls: ToolCallRecord[] = []
  let finalText = ''
  const metrics: RunMetrics = {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    wallMs: 0,
    stoppedWith: 'unknown',
  }

  const start = Date.now()
  let runError: string | undefined

  try {
    for await (const ev of runAgent({
      userInput: task.prompt,
      history,
      tools: TOOLS,
      system: SYSTEM_PROMPT,
      model,
      canUseTool: allowAll,
      maxTurns: 10,
    })) {
      switch (ev.type) {
        case 'text':
          finalText += ev.text
          break
        case 'tool_call':
          toolCalls.push({ name: ev.name, input: ev.input })
          break
        case 'turn_end':
          metrics.stoppedWith = ev.stopReason
          break
        case 'done':
          metrics.turns = ev.turns
          metrics.inputTokens = ev.totalUsage.inputTokens
          metrics.outputTokens = ev.totalUsage.outputTokens
          break
        case 'error':
          runError = ev.message
          break
      }
    }
  } catch (err) {
    runError = err instanceof Error ? err.message : String(err)
  }

  metrics.wallMs = Date.now() - start

  if (task.cleanup) {
    try {
      await task.cleanup()
    } catch {}
  }

  return { task, metrics, finalText, toolCalls, error: runError }
}

function fmtMetrics(m: RunMetrics): string {
  return dim(
    `${m.turns} turn${m.turns === 1 ? '' : 's'} · ${m.inputTokens} in / ${m.outputTokens} out · ${(m.wallMs / 1000).toFixed(1)}s`,
  )
}

async function main() {
  const args = process.argv.slice(2)
  const modelArg = args.find(a => a.startsWith('--model='))
  const model = modelArg ? modelArg.slice('--model='.length) : 'claude-haiku-4-5'
  const onlyArg = args.find(a => a.startsWith('--only='))
  const onlyName = onlyArg ? onlyArg.slice('--only='.length) : null

  const tasks = onlyName ? TASKS.filter(t => t.name === onlyName) : TASKS
  if (tasks.length === 0) {
    console.error(red(`no tasks matched --only=${onlyName}`))
    process.exit(1)
  }

  // Set up a per-run log file so you can review the judge prompts/responses.
  const runId = new Date().toISOString().replace(/[:.]/g, '-')
  const logPath = `${import.meta.dir}/runs/${runId}.jsonl`
  const { mkdir } = await import('node:fs/promises')
  await mkdir(`${import.meta.dir}/runs`, { recursive: true })
  const logFile = Bun.file(logPath).writer()

  const writeLog = (record: Record<string, unknown>): void => {
    logFile.write(JSON.stringify(record) + '\n')
  }

  console.log(bold(`mini-claude eval`))
  console.log(dim(`model: ${model} · tasks: ${tasks.length} · judge: claude-sonnet-4-6`))
  console.log(dim(`log: ${logPath}\n`))

  writeLog({
    type: 'run_start',
    timestamp: new Date().toISOString(),
    model,
    judgeModel: 'claude-sonnet-4-6',
    tasks: tasks.map(t => t.name),
  })

  const judgments: Record<string, JudgeVerdict | Error> = {}

  for (const task of tasks) {
    process.stdout.write(bold(`▸ ${task.name}\n`))
    console.log(dim(`   prompt: "${task.prompt.slice(0, 90)}${task.prompt.length > 90 ? '…' : ''}"`))
    console.log(dim(`   goal:   ${task.goal}`))

    const result = await runOneTask(task, model)

    if (result.error) {
      console.log(red(`   ✗ agent error: ${result.error}`))
      console.log(`   ${fmtMetrics(result.metrics)}\n`)
      writeLog({
        type: 'task_error',
        task: task.name,
        error: result.error,
        metrics: result.metrics,
      })
      continue
    }

    console.log(dim(`   ${fmtMetrics(result.metrics)}`))

    // Judge
    process.stdout.write(dim('   judging... '))
    try {
      const call = await judgeTask(task, result.finalText, result.toolCalls)
      const v = call.verdict
      judgments[task.name] = v
      const mark = v.verdict === 'pass' ? green('✓') : red('✗')
      const verdictText = v.verdict === 'pass' ? green('pass') : red('fail')
      console.log(
        `\r   ${mark} ${verdictText} · ${v.expectations_met.length} met / ${v.expectations_missed.length} missed`,
      )
      for (const m of v.expectations_met) {
        console.log(`       ${green('✓')} ${dim(m)}`)
      }
      for (const m of v.expectations_missed) {
        console.log(`       ${red('✗')} ${m}`)
      }
      if (v.expectations_missed.length > 0) {
        console.log(dim(`       ${v.reasoning}`))
      }

      writeLog({
        type: 'task_result',
        task: task.name,
        prompt: task.prompt,
        goal: task.goal,
        expectations: task.expectations,
        metrics: result.metrics,
        trajectory: {
          toolCalls: result.toolCalls,
          finalText: result.finalText,
        },
        judge: {
          prompt: call.prompt,
          verdict: v,
          rawResponse: call.rawResponse,
        },
      })
    } catch (err) {
      const errObj = err instanceof Error ? err : new Error(String(err))
      judgments[task.name] = errObj
      console.log('\r   ' + red(`✗ judge failed: ${errObj.message}`))
      writeLog({
        type: 'judge_error',
        task: task.name,
        error: errObj.message,
        metrics: result.metrics,
        trajectory: {
          toolCalls: result.toolCalls,
          finalText: result.finalText,
        },
      })
    }
    console.log()
  }

  logFile.end()

  // Summary
  const verdicts = Object.values(judgments).filter(
    (v): v is JudgeVerdict => !(v instanceof Error),
  )
  const passed = verdicts.filter(v => v.verdict === 'pass').length
  const totalMet = verdicts.reduce((s, v) => s + v.expectations_met.length, 0)
  const totalMissed = verdicts.reduce((s, v) => s + v.expectations_missed.length, 0)

  console.log(gray('─'.repeat(60)))
  const summaryColor = passed === tasks.length ? green : yellow
  console.log(
    summaryColor(`${passed}/${tasks.length} passed`) +
      dim(` · ${totalMet} expectations met / ${totalMissed} missed`),
  )

  process.exit(passed === tasks.length ? 0 : 1)
}

main()
