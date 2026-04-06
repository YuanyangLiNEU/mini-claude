/**
 * Simulated user (the "evaluator") — decides what to do next based on
 * mini-claude's raw terminal output. Backed by an LLM via `claude -p`.
 *
 * The evaluator sees the same output a human would see in their terminal
 * (minus ANSI colors). It doesn't import anything from mini-claude's
 * internals — it reads stdout and makes decisions.
 */

import { spawn } from 'node:child_process'
import { makeLogger } from '../debug.ts'
import type { Task } from './types.ts'

const log = makeLogger('evaluator')

const EVAL_MODEL = 'claude-sonnet-4-6'

// ── Decision types ───────────────────────────────────────────────────────────

export type TurnDecision =
  | { action: 'goal_met'; thinking: string; summary: string }
  | { action: 'give_up'; thinking: string; reason: string }
  | { action: 'send_message'; thinking: string; message: string }

export type PermissionDecision =
  | { action: 'approve'; thinking: string }
  | { action: 'deny'; thinking: string; why: string }

// ── Schemas ──────────────────────────────────────────────────────────────────

const TURN_SCHEMA = {
  type: 'object',
  properties: {
    thinking: { type: 'string' },
    action: { type: 'string', enum: ['goal_met', 'give_up', 'send_message'] },
    message: { type: 'string' },
    summary: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['thinking', 'action'],
}

const PERMISSION_SCHEMA = {
  type: 'object',
  properties: {
    thinking: { type: 'string' },
    action: { type: 'string', enum: ['approve', 'deny'] },
    why: { type: 'string' },
  },
  required: ['thinking', 'action'],
}

// ── System prompts ───────────────────────────────────────────────────────────

function buildTurnSystemPrompt(task: Task): string {
  const lines = [
    'You are simulating a user interacting with an AI CLI tool called',
    'mini-claude. You see its raw terminal output — exactly what a human',
    'sitting at their keyboard would see.',
    '',
    'The output may contain:',
    '  - Lines with "→" = tool calls mini-claude is making',
    '  - Lines with "←" = tool results that came back',
    '  - Lines starting with "──" = status annotations (ignore these)',
    '  - Lines starting with "[" like "[done ·" = completion markers',
    '  - Regular text = mini-claude\'s response to you',
    '',
    `YOUR GOAL: ${task.goal}`,
    '',
    'SUCCESS CRITERIA:',
    ...task.successCriteria.map((c, i) => `  ${i + 1}. ${c}`),
  ]
  if (task.persona) {
    lines.push('', `YOUR PERSONA: ${task.persona}`)
  }
  lines.push(
    '',
    'Decide ONE of:',
    '  goal_met      — all criteria satisfied; include a summary',
    '  give_up       — mini-claude failed in a way you cannot recover from',
    '  send_message  — reply with another message to continue the conversation',
    '',
    'Include your thinking (1-3 sentences). Be honest about what you see.',
    '',
    'JUDGING CRITERIA:',
    '  - Every success criterion must be met. Do not mark goal_met if any is missing.',
    '  - Judge what you SEE, not what mini-claude claims. If it says "done" but',
    '    you see no tool call or an error in the output, that is NOT goal_met.',
    '  - Judge answer quality: a correct tool call that produces a wrong, vague,',
    '    or fabricated answer is NOT goal_met. Answers must be concrete, relevant,',
    '    and plausible.',
    '  - If mini-claude is clearly on the right track but hasn\'t finished yet,',
    '    use send_message to let it continue — don\'t give_up prematurely.',
  )
  return lines.join('\n')
}

function buildPermissionSystemPrompt(task: Task): string {
  return buildTurnSystemPrompt(task) +
    '\n\n' +
    'RIGHT NOW: mini-claude is asking YOU for permission to run a dangerous ' +
    'tool. You can see the permission prompt in the output. Decide: approve ' +
    'or deny. Base your decision on your goal and persona.'
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Given the raw terminal output from mini-claude, decide what to do next.
 */
export async function decideNextStep(
  task: Task,
  conversationSoFar: string,
  latestOutput: string,
): Promise<TurnDecision> {
  const prompt = [
    conversationSoFar
      ? `Conversation so far:\n\`\`\`\n${truncate(conversationSoFar, 3000)}\n\`\`\``
      : '(This is the first turn.)',
    '',
    `Your original request: "${task.openingMessage}"`,
    '',
    'mini-claude just printed:',
    '```',
    latestOutput.trim(),
    '```',
    '',
    'Decide your next action. Respond as JSON.',
  ].join('\n')

  log.debug('decideNextStep', { task: task.name, outputLen: latestOutput.length })
  const raw = await spawnClaude(buildTurnSystemPrompt(task), prompt, TURN_SCHEMA)
  const parsed = parseEnvelope(raw)

  if (parsed.action === 'goal_met') {
    return { action: 'goal_met', thinking: parsed.thinking || '', summary: parsed.summary || 'goal met' }
  }
  if (parsed.action === 'give_up') {
    return { action: 'give_up', thinking: parsed.thinking || '', reason: parsed.reason || 'gave up' }
  }
  return { action: 'send_message', thinking: parsed.thinking || '', message: parsed.message || '' }
}

/**
 * Given raw terminal output showing a permission prompt, decide approve/deny.
 */
export async function decidePermission(
  task: Task,
  conversationSoFar: string,
  permissionOutput: string,
): Promise<PermissionDecision> {
  const prompt = [
    conversationSoFar
      ? `Conversation so far:\n\`\`\`\n${truncate(conversationSoFar, 3000)}\n\`\`\``
      : '',
    '',
    `Your original request: "${task.openingMessage}"`,
    '',
    'mini-claude just printed this permission prompt:',
    '```',
    permissionOutput.trim(),
    '```',
    '',
    'Do you approve or deny? Respond as JSON.',
  ].join('\n')

  log.debug('decidePermission', { task: task.name })
  const raw = await spawnClaude(buildPermissionSystemPrompt(task), prompt, PERMISSION_SCHEMA)
  const parsed = parseEnvelope(raw)

  if (parsed.action === 'approve') {
    return { action: 'approve', thinking: parsed.thinking || '' }
  }
  return { action: 'deny', thinking: parsed.thinking || '', why: parsed.why || 'denied' }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '\n... (truncated)' : s
}

function parseEnvelope(raw: string): Record<string, string> {
  try {
    const envelope = JSON.parse(raw) as {
      structured_output?: Record<string, string>
      result?: string
    }
    if (envelope.structured_output) return envelope.structured_output
    if (envelope.result) return JSON.parse(envelope.result) as Record<string, string>
  } catch (err) {
    throw new Error(`failed to parse evaluator response: ${err instanceof Error ? err.message : err}`)
  }
  throw new Error('no structured_output or result in evaluator response')
}

function spawnClaude(systemPrompt: string, userPrompt: string, schema: object): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'claude',
      [
        '-p',
        '--model', EVAL_MODEL,
        '--disallowedTools', '*',
        '--system-prompt', systemPrompt,
        '--output-format', 'json',
        '--json-schema', JSON.stringify(schema),
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
