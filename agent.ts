/**
 * The agent loop.
 *
 * Runs one user turn: calls the API, collects tool_use requests, executes them,
 * feeds results back, and loops until Claude is done.
 *
 * Reference: claude-code src/QueryEngine.ts + src/services/tools/toolOrchestration.ts.
 * Theirs handles: concurrency partitioning, permissions, hooks, compaction,
 * streaming tool execution, retries, etc. Ours: sequential tool execution only.
 */

import { stream, type ApiMessage, type ContentBlock, type ServerTool } from './claude.ts'
import { makeLogger } from './debug.ts'
import { allowAll, type CanUseTool } from './permissions.ts'
import { findTool, stringifyToolResult, toolsToApiFormat, type AnyTool } from './tools.ts'

const log = makeLogger('agent')

/** Cumulative token usage across all API calls in this turn. */
export type AgentUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
}

export type AgentEvent =
  | {
      type: 'turn_start'
      /** Which agent-loop iteration this is (1-indexed) */
      turnNum: number
      /** Messages in history about to be sent to the API */
      historyMessages: number
      /** Why we're starting this turn */
      reason: 'initial' | 'tool_results' | 'continuation'
    }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; name: string; result: string; isError: boolean }
  | { type: 'server_tool_call'; id: string; name: string; input: unknown }
  | { type: 'server_tool_result'; id: string }
  | { type: 'turn_end'; stopReason: string; turnUsage: AgentUsage }
  | { type: 'done'; stopReason: string; turns: number; totalUsage: AgentUsage }
  | { type: 'error'; message: string }

export type RunAgentOpts = {
  userInput: string
  history: ApiMessage[] // mutated: user msg + assistant reply(ies) + tool results appended
  tools: AnyTool[]
  /** Server-side tools (e.g. web search) — API executes these, not us. */
  serverTools?: ServerTool[]
  system?: string
  model?: string
  /** Safety cap on agent iterations (each = one API call). Default: 10. */
  maxTurns?: number
  /**
   * Permission check run before each tool call. If it returns 'deny', the
   * tool does NOT run and a permission-denied tool_result is sent back to
   * Claude. Defaults to allow-all (unsafe — set this in any real REPL).
   */
  canUseTool?: CanUseTool
}

export async function* runAgent(opts: RunAgentOpts): AsyncGenerator<AgentEvent> {
  const { userInput, history, tools, serverTools, system, model } = opts
  const maxTurns = opts.maxTurns ?? 10
  const canUseTool = opts.canUseTool ?? allowAll

  // 1. Append the user's message to history
  history.push({
    role: 'user',
    content: [{ type: 'text', text: userInput }],
  })

  // 2. Build the API-facing tool schemas
  const apiTools = toolsToApiFormat(tools)

  // 3. Agent loop
  let turns = 0
  const totalUsage: AgentUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
  let reason: 'initial' | 'tool_results' | 'continuation' = 'initial'
  // Safety cap on consecutive max_tokens continuations — prevents a runaway
  // model from burning the whole turn budget on one response. Reset on any
  // non-truncated turn. Same cap value (3) as CC's MAX_OUTPUT_TOKENS_RECOVERY_LIMIT,
  // but the mechanism differs: CC injects a user recovery message, we use
  // assistant prefill merge (see the merge block below).
  const MAX_CONTINUATIONS = 3
  let continuationsUsed = 0

  while (turns < maxTurns) {
    turns++
    log.debug('turn start', { turn: turns, historyLen: history.length, reason })

    // Log turn start so the REPL can show loop progression
    yield {
      type: 'turn_start',
      turnNum: turns,
      historyMessages: history.length,
      reason,
    }

    // The assistant content blocks we're building this turn — text + tool_uses
    // arrive interleaved, and we need to preserve their order when we append
    // the assistant message to history.
    const assistantBlocks: ContentBlock[] = []
    const toolUses: { id: string; name: string; input: unknown }[] = []
    let currentTextBuffer = ''
    let stopReason = 'end_turn'
    const turnUsage: AgentUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }

    // Call the API
    for await (const ev of stream({
      prompt: history,
      system,
      model,
      tools: apiTools,
      serverTools,
    })) {
      if (ev.type === 'text') {
        currentTextBuffer += ev.text
        yield { type: 'text', text: ev.text }
      } else if (ev.type === 'tool_use') {
        // Flush any text that came before this tool_use
        if (currentTextBuffer) {
          assistantBlocks.push({ type: 'text', text: currentTextBuffer })
          currentTextBuffer = ''
        }
        assistantBlocks.push({
          type: 'tool_use',
          id: ev.id,
          name: ev.name,
          input: ev.input,
        })
        toolUses.push({ id: ev.id, name: ev.name, input: ev.input })
        yield { type: 'tool_call', id: ev.id, name: ev.name, input: ev.input }
      } else if (ev.type === 'server_tool_use') {
        // Server-side tool (e.g. web search) — API executes it, not us.
        // Flush text, add to history as server_tool_use (NOT tool_use — the API
        // needs to see the original type), and do NOT add to toolUses.
        if (currentTextBuffer) {
          assistantBlocks.push({ type: 'text', text: currentTextBuffer })
          currentTextBuffer = ''
        }
        assistantBlocks.push({
          type: 'server_tool_use',
          id: ev.id,
          name: ev.name,
          input: ev.input,
        })
        yield { type: 'server_tool_call', id: ev.id, name: ev.name, input: ev.input }
      } else if (ev.type === 'server_tool_result') {
        // Server tool result — add to assistant blocks so history is complete.
        // The API needs to see the matching result for the server_tool_use.
        assistantBlocks.push({
          type: 'web_search_tool_result',
          tool_use_id: ev.id,
          content: ev.content,
        })
        yield { type: 'server_tool_result', id: ev.id }
      } else if (ev.type === 'done') {
        // Flush any trailing text
        if (currentTextBuffer) {
          assistantBlocks.push({ type: 'text', text: currentTextBuffer })
          currentTextBuffer = ''
        }
        stopReason = ev.stopReason
        turnUsage.inputTokens = ev.usage.inputTokens
        turnUsage.outputTokens = ev.usage.outputTokens
        turnUsage.cacheReadTokens = ev.usage.cacheReadTokens
      }
    }

    // Accumulate usage across turns
    totalUsage.inputTokens += turnUsage.inputTokens
    totalUsage.outputTokens += turnUsage.outputTokens
    totalUsage.cacheReadTokens += turnUsage.cacheReadTokens

    // 4. Append the assistant's response to history. On a continuation turn,
    //    the trailing assistant message was used as prefill — merge the new
    //    blocks into it so we don't end up with two consecutive assistant
    //    messages (which the API rejects). Adjacent text blocks are collapsed.
    const tail = history[history.length - 1]
    if (reason === 'continuation' && tail && tail.role === 'assistant') {
      const existing = Array.isArray(tail.content) ? (tail.content as ContentBlock[]) : []
      const merged = [...existing]
      for (const block of assistantBlocks) {
        const last = merged[merged.length - 1]
        if (block.type === 'text' && last && last.type === 'text') {
          last.text += block.text
        } else {
          merged.push(block)
        }
      }
      tail.content = merged
    } else {
      history.push({ role: 'assistant', content: assistantBlocks })
    }

    // Emit turn end so REPL can show per-turn summary
    yield { type: 'turn_end', stopReason, turnUsage }

    // 5. No tool calls → either continue (if truncated) or we're done.
    //    max_tokens means the model was cut off mid-response. The API treats
    //    a trailing assistant message as a prefill, so re-issuing with the
    //    partial already in history resumes generation where it stopped.
    //    Cap recoveries so a runaway model can't burn the whole turn budget.
    if (toolUses.length === 0) {
      if (stopReason === 'max_tokens' && continuationsUsed < MAX_CONTINUATIONS) {
        continuationsUsed++
        log.debug('max_tokens hit — continuing', { turns, continuationsUsed })
        reason = 'continuation'
        continue
      }
      log.debug('no tool_use — exiting loop', { turns, stopReason })
      yield { type: 'done', stopReason, turns, totalUsage }
      return
    }

    // A turn with tool_use or an end_turn run resets the continuation budget —
    // the cap is meant to bound a single runaway response, not the whole loop.
    continuationsUsed = 0

    log.debug('executing tools', { count: toolUses.length, names: toolUses.map(t => t.name) })

    // 6. Execute each tool, build tool_result blocks
    const resultBlocks: ContentBlock[] = []
    for (const tu of toolUses) {
      const tool = findTool(tools, tu.name)
      if (!tool) {
        const msg = `tool not found: ${tu.name}`
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: msg,
          is_error: true,
        })
        yield { type: 'tool_result', id: tu.id, name: tu.name, result: msg, isError: true }
        continue
      }
      // Permission gate — ask the user (or a policy) before running.
      // Safe tools are auto-allowed inside the canUseTool implementation.
      const decision = await canUseTool(tool, tu.input)
      if (decision === 'deny') {
        const msg = `user denied permission for ${tu.name}`
        log.info('tool denied', { name: tu.name })
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: msg,
          is_error: true,
        })
        yield { type: 'tool_result', id: tu.id, name: tu.name, result: msg, isError: true }
        continue
      }

      const toolStart = Date.now()
      try {
        const output = await tool.execute(tu.input as never)
        const resultStr = stringifyToolResult(output)
        log.debug('tool ok', { name: tu.name, elapsedMs: Date.now() - toolStart, bytes: resultStr.length })
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: resultStr,
        })
        yield { type: 'tool_result', id: tu.id, name: tu.name, result: resultStr, isError: false }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log.warn('tool error', { name: tu.name, elapsedMs: Date.now() - toolStart, msg })
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: msg,
          is_error: true,
        })
        yield { type: 'tool_result', id: tu.id, name: tu.name, result: msg, isError: true }
      }
    }

    // 7. Append tool results to history as a "user" message; loop again
    history.push({ role: 'user', content: resultBlocks })
    reason = 'tool_results' // next turn starts because we just produced tool results
  }

  // Hit the max-turns cap
  yield {
    type: 'error',
    message: `agent hit max turns (${maxTurns}) without finishing — possible loop`,
  }
}
