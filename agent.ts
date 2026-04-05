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

import { stream, type ApiMessage, type ContentBlock } from './claude.ts'
import { findTool, stringifyToolResult, toolsToApiFormat, type AnyTool } from './tools.ts'

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
      reason: 'initial' | 'tool_results'
    }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; name: string; result: string; isError: boolean }
  | { type: 'turn_end'; stopReason: string; turnUsage: AgentUsage }
  | { type: 'done'; stopReason: string; turns: number; totalUsage: AgentUsage }
  | { type: 'error'; message: string }

export type RunAgentOpts = {
  userInput: string
  history: ApiMessage[] // mutated: user msg + assistant reply(ies) + tool results appended
  tools: AnyTool[]
  system?: string
  model?: string
  /** Safety cap on agent iterations (each = one API call). Default: 10. */
  maxTurns?: number
}

export async function* runAgent(opts: RunAgentOpts): AsyncGenerator<AgentEvent> {
  const { userInput, history, tools, system, model } = opts
  const maxTurns = opts.maxTurns ?? 10

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
  let reason: 'initial' | 'tool_results' = 'initial'

  while (turns < maxTurns) {
    turns++

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

    // 4. Append the assistant's response to history
    history.push({ role: 'assistant', content: assistantBlocks })

    // Emit turn end so REPL can show per-turn summary
    yield { type: 'turn_end', stopReason, turnUsage }

    // 5. No tool calls → we're done
    if (toolUses.length === 0) {
      yield { type: 'done', stopReason, turns, totalUsage }
      return
    }

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
      try {
        const output = await tool.execute(tu.input as never)
        const resultStr = stringifyToolResult(output)
        resultBlocks.push({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: resultStr,
        })
        yield { type: 'tool_result', id: tu.id, name: tu.name, result: resultStr, isError: false }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
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
