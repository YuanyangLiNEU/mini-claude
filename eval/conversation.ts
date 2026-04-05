/**
 * Conversation orchestrator — drives a multi-turn exchange between the
 * simulated user (evaluator) and mini-claude. Feeds each side the other's
 * outputs, asks the evaluator for permission decisions when mini-claude
 * calls dangerous tools, and stops when the evaluator says the goal is
 * met, gives up, or we hit the turn cap.
 */

import { runAgent } from '../agent.ts'
import type { ApiMessage } from '../claude.ts'
import { makeLogger } from '../debug.ts'
import type { AnyTool } from '../tools.ts'
import { decideNextStep, decidePermission } from './evaluator.ts'
import type {
  ConversationResult,
  MiniClaudeAction,
  Task,
  TurnRecord,
} from './types.ts'

const log = makeLogger('conversation')

const SYSTEM_PROMPT =
  'You are a helpful assistant with file tools (read_file, list_files, write_file). ' +
  'Use absolute paths. Keep responses brief and direct. If you are asked to perform ' +
  'an action that requires a dangerous tool, call the tool — the user will be asked ' +
  'for permission and their decision will come back as the tool result.'

export type RunConversationOpts = {
  task: Task
  tools: AnyTool[]
  model: string
  /** Turn-level callback so the runner can print things as they happen */
  onEvent?: (event: ConversationEvent) => void
}

export type ConversationEvent =
  | { type: 'conversation_start' }
  | { type: 'user_message'; turnNum: number; text: string }
  | { type: 'mini_claude_turn_start'; turnNum: number }
  | {
      type: 'mini_claude_action'
      turnNum: number
      action: MiniClaudeAction
    }
  | { type: 'mini_claude_turn_end'; turnNum: number; metrics: TurnRecord['metrics'] }
  | {
      type: 'permission_decision'
      turnNum: number
      toolName: string
      toolInput: unknown
      decision: 'approve' | 'deny'
      thinking: string
      why?: string
    }
  | {
      type: 'evaluator_decision'
      turnNum: number
      decision: TurnRecord['evaluatorDecision']
    }
  | { type: 'conversation_end'; outcome: ConversationResult['outcome'] }

export async function runConversation(
  opts: RunConversationOpts,
): Promise<ConversationResult> {
  const { task, tools, model } = opts
  const emit = opts.onEvent ?? (() => {})
  const maxTurns = task.maxTurns ?? 6

  if (task.setup) await task.setup()

  emit({ type: 'conversation_start' })

  // mini-claude's conversation history (its view)
  const miniClaudeHistory: ApiMessage[] = []
  // our record of the full conversation
  const turns: TurnRecord[] = []

  let nextMessage: string = task.openingMessage
  let outcome: ConversationResult['outcome'] = 'max_turns'
  let finalSummary: string | undefined
  let giveUpReason: string | undefined
  let errorMessage: string | undefined
  const convoStart = Date.now()
  let totalIn = 0
  let totalOut = 0

  try {
    for (let turnNum = 1; turnNum <= maxTurns; turnNum++) {
      log.debug('turn start', { turnNum, message: nextMessage.slice(0, 50) })

      emit({ type: 'user_message', turnNum, text: nextMessage })
      emit({ type: 'mini_claude_turn_start', turnNum })

      const actions: MiniClaudeAction[] = []
      let currentPermissionEvent: TurnRecord['permissionEvent']
      const turnStart = Date.now()
      let turnIn = 0
      let turnOut = 0
      let miniTurns = 0

      // Permission callback: when mini-claude wants to use a dangerous tool,
      // ask the evaluator.
      const canUseTool = async (tool: AnyTool, input: unknown) => {
        if (!tool.isDangerous) return 'allow' as const

        const decision = await decidePermission(
          task,
          turns,
          tool.name,
          input,
        )
        const outcome_ = decision.action === 'approve_permission' ? 'approve' : 'deny'
        currentPermissionEvent = {
          toolName: tool.name,
          toolInput: input,
          decision: outcome_,
          evaluatorThinking: decision.thinking,
          evaluatorWhy: decision.action === 'deny_permission' ? decision.why : undefined,
        }
        emit({
          type: 'permission_decision',
          turnNum,
          toolName: tool.name,
          toolInput: input,
          decision: outcome_,
          thinking: decision.thinking,
          why: decision.action === 'deny_permission' ? decision.why : undefined,
        })
        return outcome_ === 'approve' ? ('allow' as const) : ('deny' as const)
      }

      for await (const ev of runAgent({
        userInput: nextMessage,
        history: miniClaudeHistory,
        tools,
        system: SYSTEM_PROMPT,
        model,
        canUseTool,
        maxTurns: 10,
      })) {
        if (ev.type === 'text') {
          const action: MiniClaudeAction = { type: 'text', text: ev.text }
          actions.push(action)
          emit({ type: 'mini_claude_action', turnNum, action })
        } else if (ev.type === 'tool_call') {
          const action: MiniClaudeAction = {
            type: 'tool_call',
            name: ev.name,
            input: ev.input,
          }
          actions.push(action)
          emit({ type: 'mini_claude_action', turnNum, action })
        } else if (ev.type === 'tool_result') {
          const action: MiniClaudeAction = {
            type: 'tool_result',
            name: ev.name,
            result: ev.result,
            isError: ev.isError,
          }
          actions.push(action)
          emit({ type: 'mini_claude_action', turnNum, action })
        } else if (ev.type === 'done') {
          miniTurns = ev.turns
          turnIn = ev.totalUsage.inputTokens
          turnOut = ev.totalUsage.outputTokens
        } else if (ev.type === 'error') {
          throw new Error(`mini-claude error: ${ev.message}`)
        }
      }

      const coalescedActions = coalesceActions(actions)

      const metrics = {
        turns: miniTurns,
        inputTokens: turnIn,
        outputTokens: turnOut,
        wallMs: Date.now() - turnStart,
      }
      totalIn += turnIn
      totalOut += turnOut
      emit({ type: 'mini_claude_turn_end', turnNum, metrics })

      // Ask the evaluator: given what mini-claude just did, what next?
      const decision = await decideNextStep(task, turns, coalescedActions)
      emit({ type: 'evaluator_decision', turnNum, decision })

      turns.push({
        turnNum,
        miniClaudeActions: coalescedActions,
        metrics,
        evaluatorDecision: decision,
        permissionEvent: currentPermissionEvent,
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
      // send_message → queue it up for the next iteration
      if (decision.action === 'send_message') {
        nextMessage = decision.message
      }
    }
  } catch (err) {
    outcome = 'error'
    errorMessage = err instanceof Error ? err.message : String(err)
  } finally {
    if (task.cleanup) {
      try {
        await task.cleanup()
      } catch {}
    }
  }

  emit({ type: 'conversation_end', outcome })

  return {
    task,
    turns,
    outcome,
    finalSummary,
    giveUpReason,
    errorMessage,
    totalWallMs: Date.now() - convoStart,
    totalMiniClaudeInputTokens: totalIn,
    totalMiniClaudeOutputTokens: totalOut,
  }
}

/** Merge consecutive text actions into one for readability. */
function coalesceActions(actions: MiniClaudeAction[]): MiniClaudeAction[] {
  const out: MiniClaudeAction[] = []
  for (const a of actions) {
    const prev = out[out.length - 1]
    if (a.type === 'text' && prev?.type === 'text') {
      prev.text += a.text
    } else {
      out.push({ ...a })
    }
  }
  return out
}
