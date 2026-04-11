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
    'You are a senior QA auditor for an AI CLI tool called mini-claude. You',
    'play the role of a user to exercise the test described below, but your',
    'loyalty is to the test — not to helping mini-claude succeed. Your job',
    'is to report whether mini-claude actually has this capability. Both',
    '"pass" and "fail" are valid outcomes; failure is not your problem to',
    'solve.',
    '',
    'You see mini-claude\'s raw terminal output — exactly what a human at the',
    'keyboard would see:',
    '  - Lines with "→" = tool calls mini-claude made',
    '  - Lines with "←" = tool results that came back',
    '  - Lines starting with "──" = status annotations (ignore)',
    '  - Regular text = mini-claude speaking to you',
    '',
    `TEST: ${task.goal}`,
    '',
    'SUCCESS CRITERIA:',
    ...task.successCriteria.map(c => `  - ${c}`),
  ]
  if (task.persona) {
    lines.push('', `PERSONA: ${task.persona}`)
  }
  lines.push(
    '',
    'Each turn, pick one:',
    '  goal_met      — the test passed; include a summary of the evidence',
    '  give_up       — mini-claude cannot pass; include a reason',
    '  send_message  — reply to drive the conversation forward',
    '',
    'Use your judgment. Include 1-3 sentences of thinking with every decision.',
  )
  return lines.join('\n')
}

function buildPermissionSystemPrompt(task: Task): string {
  return buildTurnSystemPrompt(task) +
    '\n\n' +
    'RIGHT NOW: mini-claude is asking you for permission to run a tool. ' +
    'Decide approve or deny based on whether the action serves the test. ' +
    'If a persona is set, it should guide your decision. Include your thinking.'
}

// ── Public API ───────────────────────────────────────────────────────────────

const OPENING_SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string' },
  },
  required: ['message'],
}

/**
 * Generate a natural opening message for the task based on its goal + persona.
 * The evaluator is a smart QA — it reads the test description, figures out
 * what the first user message should look like, and phrases it naturally.
 */
export async function generateOpeningMessage(task: Task): Promise<string> {
  const systemPrompt = [
    'You are a QA tester about to run a test on an AI CLI tool called',
    'mini-claude. You will play the role of a user. Read the test description',
    'below, decide what the user would say first to exercise the capability',
    'under test, and write that opening message.',
    '',
    `TEST: ${task.goal}`,
  ]
  if (task.persona) {
    systemPrompt.push('', `PERSONA: ${task.persona}`)
  }
  systemPrompt.push(
    '',
    'Write the first message the user would send. Phrase it naturally — any',
    'length, any tone. If the test description contains literal paths, file',
    'names, or exact content, include them verbatim so mini-claude sees the',
    'same values as the test fixture.',
  )

  const userPrompt = 'Write your first message. Respond as JSON with a "message" field.'

  log.debug('generateOpeningMessage', { task: task.name })
  const raw = await spawnClaude(systemPrompt.join('\n'), userPrompt, OPENING_SCHEMA)
  const parsed = parseEnvelope(raw)
  return parsed.message || task.goal
}

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
    `Your goal: ${task.goal}`,
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
    `Your goal: ${task.goal}`,
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
