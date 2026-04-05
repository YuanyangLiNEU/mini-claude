/**
 * Simulated user (the "evaluator") — decides what to say to mini-claude
 * at each turn. Backed by an LLM via `claude -p` subprocess.
 *
 * At each turn, the evaluator sees:
 *   - the user's goal and success criteria
 *   - its persona (optional)
 *   - the full conversation so far (what mini-claude did)
 *   - the latest thing mini-claude did (text + tool calls)
 *
 * It returns a structured decision: continue the conversation, approve/deny
 * a permission prompt, declare the goal met, or give up.
 */

import { spawn } from 'node:child_process'
import { makeLogger } from '../debug.ts'
import type {
  EvaluatorDecision,
  MiniClaudeAction,
  Task,
  TurnRecord,
} from './types.ts'

const log = makeLogger('evaluator')

const JUDGE_MODEL = 'claude-sonnet-4-6'

/** Schema for the evaluator's normal decision (between turns). */
const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    thinking: { type: 'string' },
    action: {
      type: 'string',
      enum: ['goal_met', 'give_up', 'send_message'],
    },
    message: { type: 'string' },
    summary: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['thinking', 'action'],
}

/** Schema for a permission decision. */
const PERMISSION_SCHEMA = {
  type: 'object',
  properties: {
    thinking: { type: 'string' },
    action: { type: 'string', enum: ['approve', 'deny'] },
    why: { type: 'string' },
  },
  required: ['thinking', 'action'],
}

function buildSystemPrompt(task: Task): string {
  const lines = [
    'You are simulating a user interacting with an AI coding assistant called',
    'mini-claude. Your job is to act as a realistic user: send a request,',
    'watch what the assistant does, react to what you see. You are NOT the',
    'assistant — you are the human on the other side of the conversation.',
    '',
    `YOUR GOAL: ${task.goal}`,
    '',
    'YOUR SUCCESS CRITERIA (what must be true for the goal to be met):',
    ...task.successCriteria.map((c, i) => `  ${i + 1}. ${c}`),
  ]
  if (task.persona) {
    lines.push('', `YOUR PERSONA: ${task.persona}`)
  }
  lines.push(
    '',
    'At each turn you will see:',
    "- what mini-claude just did (its text response + any tools it called)",
    '- the full conversation history',
    '',
    'You must decide ONE of:',
    '  goal_met      — criteria all satisfied; end the conversation successfully',
    '  give_up       — the assistant failed in a way I cannot recover from',
    '  send_message  — reply with another message to continue the conversation',
    '',
    'Include your thinking (1-3 sentences explaining what you notice and what',
    'you decided). Be honest about what you observe. If mini-claude claims it',
    'did something without actually calling the needed tool, call that out in',
    'your thinking and decide accordingly.',
  )
  return lines.join('\n')
}

/**
 * Build the per-turn prompt that describes the conversation so far and the
 * latest turn the evaluator needs to react to.
 */
function buildTurnPrompt(
  task: Task,
  history: TurnRecord[],
  latestActions: MiniClaudeAction[],
): string {
  const lines: string[] = []
  lines.push(`Your original request: "${task.openingMessage}"`)
  lines.push('')

  if (history.length > 0) {
    lines.push('Conversation so far:')
    for (const turn of history) {
      lines.push(`  [turn ${turn.turnNum}] mini-claude:`)
      for (const a of turn.miniClaudeActions) {
        lines.push(`    ${formatAction(a)}`)
      }
      if (turn.evaluatorDecision.action === 'send_message') {
        lines.push(`  [turn ${turn.turnNum}] you replied: "${turn.evaluatorDecision.message}"`)
      }
    }
    lines.push('')
  }

  lines.push('mini-claude just did (this is the turn you need to react to):')
  for (const a of latestActions) {
    lines.push(`  ${formatAction(a)}`)
  }
  lines.push('')
  lines.push(
    'Decide your next action. If your goal is met, say so. If you need to',
    'send another message, write it as if you are typing it in a chat UI.',
    'Respond as JSON.',
  )
  return lines.join('\n')
}

function formatAction(a: MiniClaudeAction): string {
  if (a.type === 'text') {
    return `text: "${truncate(a.text.replace(/\n/g, ' '), 200)}"`
  }
  if (a.type === 'tool_call') {
    return `tool_call: ${a.name}(${truncate(JSON.stringify(a.input), 120)})`
  }
  // tool_result
  const tag = a.isError ? 'tool_error' : 'tool_result'
  return `${tag} [${a.name}]: ${truncate(a.result.replace(/\n/g, ' '), 200)}`
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

/**
 * Ask the evaluator what to do next given mini-claude's latest actions.
 */
export async function decideNextStep(
  task: Task,
  history: TurnRecord[],
  latestActions: MiniClaudeAction[],
): Promise<EvaluatorDecision> {
  const system = buildSystemPrompt(task)
  const prompt = buildTurnPrompt(task, history, latestActions)
  log.debug('decide next step', { task: task.name, historyLen: history.length })

  const raw = await spawnClaude(system, prompt, DECISION_SCHEMA)
  const parsed = parseEnvelope(raw)

  // Coerce into our union — the schema allows varying shapes
  if (parsed.action === 'goal_met') {
    return {
      action: 'goal_met',
      thinking: parsed.thinking || '',
      summary: parsed.summary || 'goal met',
    }
  }
  if (parsed.action === 'give_up') {
    return {
      action: 'give_up',
      thinking: parsed.thinking || '',
      reason: parsed.reason || parsed.message || 'gave up',
    }
  }
  return {
    action: 'send_message',
    thinking: parsed.thinking || '',
    message: parsed.message || '',
  }
}

/**
 * Ask the evaluator to approve or deny a permission request.
 */
export async function decidePermission(
  task: Task,
  history: TurnRecord[],
  toolName: string,
  toolInput: unknown,
): Promise<EvaluatorDecision & { action: 'approve_permission' | 'deny_permission' }> {
  const system =
    buildSystemPrompt(task) +
    '\n\n' +
    'mini-claude is about to perform a dangerous operation and is asking YOU ' +
    'for permission. Decide: approve (it should proceed) or deny (it should ' +
    'not). Base your decision on your goal, your persona, and whether the ' +
    'proposed action matches what you actually want done.'

  const promptLines: string[] = [
    `Your original request: "${task.openingMessage}"`,
    '',
  ]
  if (history.length > 0) {
    promptLines.push('Conversation so far:')
    for (const turn of history) {
      promptLines.push(`  [turn ${turn.turnNum}] mini-claude:`)
      for (const a of turn.miniClaudeActions) {
        promptLines.push(`    ${formatAction(a)}`)
      }
    }
    promptLines.push('')
  }
  promptLines.push(
    `mini-claude is asking permission to call:`,
    `  ${toolName}(${JSON.stringify(toolInput)})`,
    '',
    `Do you approve? Respond as JSON.`,
  )
  const prompt = promptLines.join('\n')

  log.debug('decide permission', { task: task.name, tool: toolName })
  const raw = await spawnClaude(system, prompt, PERMISSION_SCHEMA)
  const parsed = parseEnvelope(raw)

  if (parsed.action === 'approve') {
    return { action: 'approve_permission', thinking: parsed.thinking || '' }
  }
  return {
    action: 'deny_permission',
    thinking: parsed.thinking || '',
    why: parsed.why || 'denied',
  }
}

// ── Subprocess helpers ───────────────────────────────────────────────────────

function parseEnvelope(raw: string): Record<string, string> {
  try {
    const envelope = JSON.parse(raw) as {
      structured_output?: Record<string, string>
      result?: string
    }
    if (envelope.structured_output) return envelope.structured_output
    if (envelope.result) return JSON.parse(envelope.result) as Record<string, string>
  } catch (err) {
    throw new Error(
      `failed to parse evaluator response: ${err instanceof Error ? err.message : err}`,
    )
  }
  throw new Error('no structured_output or result in evaluator response')
}

function spawnClaude(
  systemPrompt: string,
  userPrompt: string,
  schema: object,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'claude',
      [
        '-p',
        '--model',
        JUDGE_MODEL,
        '--disallowedTools',
        '*',
        '--system-prompt',
        systemPrompt,
        '--output-format',
        'json',
        '--json-schema',
        JSON.stringify(schema),
        userPrompt,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )

    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()))

    proc.on('close', code => {
      if (code !== 0) {
        reject(new Error(`evaluator subprocess exited ${code}: ${stderr.slice(0, 200)}`))
        return
      }
      resolve(stdout.trim())
    })
    proc.on('error', reject)
  })
}
