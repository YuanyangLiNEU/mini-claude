/**
 * LLM-as-judge for capability verification.
 *
 * This is NOT a quality grader for Claude's writing. It's an evaluator for
 * the mini-claude HARNESS: given the user's goal and the actions the agent
 * took, did the agent do what a reasonable user would expect?
 *
 * It spawns the real `claude` CLI as a subprocess. The judge sees the task's
 * goal + expectations + full trajectory, and returns which expectations were
 * met or missed.
 *
 * Expected cost per run: ~3¢ for the first call (prompt-cache create),
 * then ~0.6¢ each after.
 */

import { spawn } from 'node:child_process'
import { makeLogger } from '../debug.ts'
import type { Task, ToolCallRecord } from './types.ts'

const log = makeLogger('judge')

export type JudgeVerdict = {
  verdict: 'pass' | 'fail'
  expectations_met: string[]
  expectations_missed: string[]
  reasoning: string
}

export type JudgeCall = {
  verdict: JudgeVerdict
  /** The full prompt sent to the judge (for logging/debugging) */
  prompt: string
  /** Raw JSON envelope returned by `claude -p` (for logging/debugging) */
  rawResponse: string
}

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    expectations_met: { type: 'array', items: { type: 'string' } },
    expectations_missed: { type: 'array', items: { type: 'string' } },
    reasoning: { type: 'string' },
  },
  required: ['verdict', 'expectations_met', 'expectations_missed', 'reasoning'],
}

const JUDGE_SYSTEM = `You are evaluating whether a lightweight AI coding agent
("mini-claude") completed a user's task correctly. You are NOT grading the
agent's writing style or the correctness of facts the LLM generated. You are
verifying whether the agent USED ITS TOOLS to accomplish what the user
actually wanted.

You will be told:
  - The user's goal (what they wanted to accomplish)
  - The exact prompt the user sent
  - The list of expectations: concrete behaviors the agent should have shown
  - The full trajectory: tool calls the agent made, and its final text response

For each expectation, decide: did the agent do it? Place it in
expectations_met or expectations_missed.

Set verdict=pass if ALL expectations were met, fail otherwise.

Keep reasoning to 1-2 sentences, focused on WHY the verdict — especially
what the agent did wrong if it failed. Don't judge writing quality.`

/**
 * Ask the judge: did the agent complete the task?
 * Returns the verdict plus the prompt/raw-response for logging.
 */
export async function judgeTask(
  task: Task,
  finalText: string,
  toolCalls: ToolCallRecord[],
): Promise<JudgeCall> {
  const trajectory = formatTrajectory(finalText, toolCalls)
  const expectationList = task.expectations
    .map((e, i) => `  ${i + 1}. ${e}`)
    .join('\n')

  const prompt = `User's goal: ${task.goal}
User's prompt (what they typed): "${task.prompt}"

Expectations:
${expectationList}

Agent's trajectory:
${trajectory}

Evaluate. Respond as JSON.`

  log.debug('calling judge', { task: task.name, promptLen: prompt.length })
  const rawResponse = await spawnClaude(prompt)
  log.debug('judge response', { task: task.name, len: rawResponse.length })

  try {
    const envelope = JSON.parse(rawResponse) as {
      structured_output?: JudgeVerdict
      result?: string
    }
    let verdict: JudgeVerdict
    if (envelope.structured_output) {
      verdict = envelope.structured_output
    } else if (envelope.result) {
      verdict = JSON.parse(envelope.result) as JudgeVerdict
    } else {
      throw new Error('no structured_output or result field')
    }
    return { verdict, prompt, rawResponse }
  } catch (err) {
    throw new Error(
      `failed to parse judge response: ${err instanceof Error ? err.message : err}`,
    )
  }
}

function formatTrajectory(
  finalText: string,
  toolCalls: ToolCallRecord[],
): string {
  const toolSummary =
    toolCalls.length === 0
      ? '  (none)'
      : toolCalls
          .map((tc, i) => `  ${i + 1}. ${tc.name}(${JSON.stringify(tc.input)})`)
          .join('\n')
  return `Tools called:
${toolSummary}

Final text response:
${finalText || '(empty)'}`
}

/**
 * Spawn `claude -p` with our judge prompt and return raw stdout.
 */
function spawnClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'claude',
      [
        '-p',
        '--model',
        'claude-sonnet-4-6',
        '--disallowedTools',
        '*',
        '--system-prompt',
        JUDGE_SYSTEM,
        '--output-format',
        'json',
        '--json-schema',
        JSON.stringify(JUDGE_SCHEMA),
        prompt,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()))

    proc.on('close', code => {
      if (code !== 0) {
        reject(new Error(`claude -p exited ${code}: ${stderr.slice(0, 200)}`))
        return
      }
      resolve(stdout.trim())
    })
    proc.on('error', reject)
  })
}
