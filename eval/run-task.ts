/**
 * Core task execution as an async generator.
 *
 * Both runner.ts (CLI) and portal.ts (live web UI) consume this stream.
 * Each yielded event describes something that just happened — setup started,
 * user sent a message, mini-claude replied, evaluator decided, etc.
 *
 * This keeps the CLI and web portal in sync: they see the same events.
 */

import { decideNextStep, decidePermission, generateOpeningMessage } from './evaluator.ts'
import { spawnMiniClaude } from './subprocess.ts'
import type { ConversationResult, Task, TurnRecord } from './types.ts'

// ── Event types ─────────────────────────────────────────────────────────────

export type TaskEvent =
  | { type: 'task_start'; task: Task }
  | { type: 'setup_start' }
  | { type: 'setup_done' }
  | { type: 'setup_error'; error: string }
  | { type: 'repl_booting' }
  | { type: 'repl_ready'; greeting: string }
  | { type: 'user_message'; turnNum: number; message: string }
  | { type: 'agent_output'; turnNum: number; output: string; idleReason: string }
  | { type: 'permission_prompt'; turnNum: number; output: string }
  | { type: 'evaluator_thinking'; reason: string }
  | {
      type: 'permission_decision'
      turnNum: number
      action: 'approve' | 'deny'
      thinking: string
      why?: string
    }
  | { type: 'permission_answer_sent'; turnNum: number; answer: 'y' | 'n' }
  | {
      type: 'evaluator_decision'
      turnNum: number
      action: 'goal_met' | 'give_up' | 'send_message'
      thinking: string
      summary?: string
      reason?: string
      message?: string
    }
  | { type: 'task_timeout'; message: string }
  | { type: 'task_error'; error: string }
  | { type: 'task_done'; result: ConversationResult }

// ── Runner ──────────────────────────────────────────────────────────────────

export async function* runTaskStream(
  task: Task,
): AsyncGenerator<TaskEvent> {
  yield { type: 'task_start', task }

  // Run setup
  if (task.setup) {
    yield { type: 'setup_start' }
    try {
      await task.setup()
      yield { type: 'setup_done' }
    } catch (err) {
      yield { type: 'setup_error', error: err instanceof Error ? err.message : String(err) }
      return
    }
  }

  const maxTurns = task.maxTurns ?? 6
  const turns: TurnRecord[] = []
  let outcome: ConversationResult['outcome'] = 'max_turns'
  let finalSummary: string | undefined
  let giveUpReason: string | undefined
  let errorMessage: string | undefined
  const convoStart = Date.now()
  let conversationLog = ''

  yield { type: 'repl_booting' }
  const mc = spawnMiniClaude()

  try {
    const greeting = await mc.waitForIdle()
    conversationLog += greeting.output
    yield { type: 'repl_ready', greeting: greeting.output }

    // Ask the evaluator to generate a natural opening message from the goal
    yield { type: 'evaluator_thinking', reason: 'phrasing the opening message as a real user would...' }
    let nextMessage: string
    try {
      nextMessage = await generateOpeningMessage(task)
    } catch (err) {
      // Fallback: if evaluator fails, use the goal directly
      nextMessage = task.goal
      yield { type: 'task_error', error: `failed to generate opening message (falling back to goal): ${err instanceof Error ? err.message : String(err)}` }
    }

    for (let turnNum = 1; turnNum <= maxTurns; turnNum++) {
      yield { type: 'user_message', turnNum, message: nextMessage }

      mc.sendMessage(nextMessage)
      conversationLog += `\n[USER]: ${nextMessage}\n`

      const { output, reason } = await mc.waitForIdle()
      conversationLog += output

      yield { type: 'agent_output', turnNum, output, idleReason: reason }

      if (reason === 'timeout') {
        outcome = 'error'
        errorMessage = 'mini-claude timed out (no prompt detected)'
        yield { type: 'task_timeout', message: errorMessage }
        break
      }

      if (reason === 'permission') {
        yield { type: 'permission_prompt', turnNum, output }
        yield { type: 'evaluator_thinking', reason: 'deciding whether to approve the permission prompt...' }

        const permDecision = await decidePermission(task, conversationLog, output)

        yield {
          type: 'permission_decision',
          turnNum,
          action: permDecision.action,
          thinking: permDecision.thinking,
          why: permDecision.action === 'deny' ? permDecision.why : undefined,
        }

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

        const answer: 'y' | 'n' = permDecision.action === 'approve' ? 'y' : 'n'
        yield { type: 'permission_answer_sent', turnNum, answer }

        mc.answerPermission(answer)
        conversationLog += `\n[USER PERMISSION]: ${answer}\n`

        const postPerm = await mc.waitForIdle()
        conversationLog += postPerm.output

        yield { type: 'agent_output', turnNum, output: postPerm.output, idleReason: postPerm.reason }

        if (postPerm.reason === 'timeout') {
          outcome = 'error'
          errorMessage = 'mini-claude timed out after permission answer'
          yield { type: 'task_timeout', message: errorMessage }
          break
        }

        yield { type: 'evaluator_thinking', reason: 'deciding if the goal is met or if I should continue...' }
        const decision = await decideNextStep(task, conversationLog, postPerm.output)

        yield {
          type: 'evaluator_decision',
          turnNum: turnNum + 0.5,
          action: decision.action,
          thinking: decision.thinking,
          summary: decision.action === 'goal_met' ? decision.summary : undefined,
          reason: decision.action === 'give_up' ? decision.reason : undefined,
          message: decision.action === 'send_message' ? decision.message : undefined,
        }

        turns.push({
          turnNum: turnNum + 0.5,
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
      yield { type: 'evaluator_thinking', reason: 'deciding if the goal is met or if I should continue...' }
      const decision = await decideNextStep(task, conversationLog, output)

      yield {
        type: 'evaluator_decision',
        turnNum,
        action: decision.action,
        thinking: decision.thinking,
        summary: decision.action === 'goal_met' ? decision.summary : undefined,
        reason: decision.action === 'give_up' ? decision.reason : undefined,
        message: decision.action === 'send_message' ? decision.message : undefined,
      }

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
    yield { type: 'task_error', error: errorMessage }
  } finally {
    mc.shutdown()
    if (task.cleanup) {
      try { await task.cleanup() } catch {}
    }
  }

  const result: ConversationResult = {
    task,
    turns,
    conversationLog,
    outcome,
    finalSummary,
    giveUpReason,
    errorMessage,
    totalWallMs: Date.now() - convoStart,
  }

  yield { type: 'task_done', result }
}
