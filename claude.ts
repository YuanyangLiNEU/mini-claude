/**
 * Direct Anthropic Messages API client using your Claude Max OAuth token.
 *
 * Replaces the previous Agent SDK wrapper. No subprocess, no hidden system prompt,
 * no account-injected tools — just the raw API.
 *
 * Reference: claude-code src/services/api/claude.ts (their much more elaborate version).
 */

import { getAccessToken, OAUTH_BETA_HEADER } from './auth.ts'
import { isDebugEnabled, makeLogger } from './debug.ts'

const log = makeLogger('api')

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_MODEL = 'claude-sonnet-4-6'

export type Role = 'user' | 'assistant'
export type Message = { role: Role; content: string }

export type Usage = {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
}

/** A client tool schema — Claude returns tool_use, we execute locally. */
export type ApiTool = {
  name: string
  description: string
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] }
}

/** A server tool schema — the API executes it server-side (e.g. web search). */
export type ServerTool = {
  type: string       // e.g. 'web_search_20250305'
  name: string       // e.g. 'web_search'
  max_uses?: number  // optional cap per response
}

export type CompleteOpts = {
  /** User message, or full conversation history (as Message[] with content blocks) */
  prompt: string | Message[] | ApiMessage[]
  /** System prompt (optional) */
  system?: string
  /** Model override (default: claude-sonnet-4-6) */
  model?: string
  /** Max output tokens (default: 4096) */
  maxTokens?: number
  /** Client tool schemas (we execute locally) */
  tools?: ApiTool[]
  /** Server tool schemas (API executes server-side, e.g. web search) */
  serverTools?: ServerTool[]
  /** Abort signal to cancel mid-request */
  signal?: AbortSignal
}

/** Anthropic API message with structured content blocks (for tool use/results). */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  // Server-side tool blocks — preserved in history so the API sees them on the next turn
  | { type: 'server_tool_use'; id: string; name: string; input: unknown; [key: string]: unknown }
  | { type: 'web_search_tool_result'; tool_use_id: string; content: unknown[]; [key: string]: unknown }

export type ApiMessage = { role: Role; content: ContentBlock[] }

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'server_tool_use'; id: string; name: string; input: unknown }
  | { type: 'server_tool_result'; id: string; content: unknown[] }
  | { type: 'done'; stopReason: string; usage: Usage }

export type CompleteResult = {
  text: string
  stopReason: string
  usage: Usage
}

/**
 * Convert our prompt input into the API's `messages` array.
 * - string        → single user message with text content
 * - Message[]     → simple text conversation (we pass content strings directly;
 *                   the API accepts strings as a shorthand for text-only turns)
 * - ApiMessage[]  → full structured content blocks (needed for tool_use / tool_result)
 */
function buildMessages(
  prompt: string | Message[] | ApiMessage[],
): { role: Role; content: string | ContentBlock[] }[] {
  if (typeof prompt === 'string') {
    return [{ role: 'user', content: prompt }]
  }
  return prompt
}

/**
 * Build common request body for both streaming and non-streaming modes.
 */
function buildRequestBody(opts: CompleteOpts, stream: boolean): object {
  const body: Record<string, unknown> = {
    model: opts.model ?? DEFAULT_MODEL,
    max_tokens: opts.maxTokens ?? 4096,
    messages: buildMessages(opts.prompt),
    stream,
  }
  if (opts.system) body.system = opts.system
  // Merge client tools and server tools into a single tools array
  const allTools: unknown[] = []
  if (opts.tools) allTools.push(...opts.tools)
  if (opts.serverTools) allTools.push(...opts.serverTools)
  if (allTools.length > 0) body.tools = allTools
  return body
}

async function buildHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken()
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': OAUTH_BETA_HEADER,
  }
}

/**
 * Build a clearer error message from a failed response, especially for 429s
 * which happen often when learning.
 */
function buildApiError(response: Response, body: string): Error {
  if (response.status === 429) {
    const get = (k: string) =>
      response.headers.get(`anthropic-ratelimit-unified-${k}`)
    const util5h = get('5h-utilization')
    const resetTs = get('5h-reset')
    const resetDate = resetTs
      ? new Date(Number(resetTs) * 1000).toLocaleTimeString()
      : 'unknown'
    return new Error(
      `rate limited (429). 5h window at ${util5h}, resets ${resetDate}. ` +
      `Try /model claude-haiku-4-5 (usually has more headroom).`
    )
  }
  return new Error(`API error ${response.status}: ${body}`)
}

/**
 * Non-streaming completion. Returns once the full response is collected.
 */
export async function complete(opts: CompleteOpts): Promise<CompleteResult> {
  const response = await fetch(MESSAGES_URL, {
    method: 'POST',
    headers: await buildHeaders(),
    body: JSON.stringify(buildRequestBody(opts, false)),
    signal: opts.signal,
  })

  if (!response.ok) {
    throw buildApiError(response, await response.text())
  }

  const data = await response.json() as {
    content: { type: string; text?: string }[]
    stop_reason: string
    usage: {
      input_tokens: number
      output_tokens: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }

  const text = data.content
    .filter(b => b.type === 'text')
    .map(b => b.text ?? '')
    .join('')

  return {
    text,
    stopReason: data.stop_reason,
    usage: {
      inputTokens: data.usage.input_tokens,
      outputTokens: data.usage.output_tokens,
      cacheCreationTokens: data.usage.cache_creation_input_tokens ?? 0,
      cacheReadTokens: data.usage.cache_read_input_tokens ?? 0,
    },
  }
}

/**
 * Streaming completion. Yields events as tokens arrive.
 */
export async function* stream(opts: CompleteOpts): AsyncGenerator<StreamEvent> {
  const body = buildRequestBody(opts, true) as Record<string, unknown>
  log.debug('POST /v1/messages (streaming)', {
    model: body.model,
    messages: Array.isArray(body.messages) ? body.messages.length : 0,
    tools: Array.isArray(body.tools) ? body.tools.length : 0,
    hasSystem: 'system' in body,
  })
  const startMs = Date.now()

  const response = await fetch(MESSAGES_URL, {
    method: 'POST',
    headers: await buildHeaders(),
    body: JSON.stringify(body),
    signal: opts.signal,
  })

  log.debug('response received', {
    status: response.status,
    elapsedMs: Date.now() - startMs,
    claim: response.headers.get('anthropic-ratelimit-unified-representative-claim'),
    util5h: response.headers.get('anthropic-ratelimit-unified-5h-utilization'),
  })

  if (!response.ok) {
    throw buildApiError(response, await response.text())
  }
  if (!response.body) {
    throw new Error('No response body')
  }

  // Track running totals — SSE emits partial usage in deltas
  let stopReason = 'end_turn'
  const usage: Usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  }

  // Partial tool_use state, indexed by content block index. Tool input JSON
  // arrives in fragments across multiple input_json_delta events, so we
  // accumulate then emit once the block closes.
  const partialTools: Record<number, { id: string; name: string; json: string; isServer: boolean }> = {}

  // Server tool results (e.g. web_search_tool_result) — captured at
  // content_block_start and emitted at content_block_stop.
  const serverResults: Record<number, { id: string; content: unknown[] }> = {}

  for await (const event of parseSSE(response.body)) {
    if (event.type === 'message_start' && event.message?.usage) {
      usage.inputTokens = event.message.usage.input_tokens ?? 0
      usage.cacheCreationTokens = event.message.usage.cache_creation_input_tokens ?? 0
      usage.cacheReadTokens = event.message.usage.cache_read_input_tokens ?? 0
    } else if (event.type === 'content_block_start') {
      const block = event.content_block
      if (block?.type === 'tool_use' && event.index !== undefined) {
        partialTools[event.index] = {
          id: block.id ?? '', name: block.name ?? '', json: '', isServer: false,
        }
      } else if (block?.type === 'server_tool_use' && event.index !== undefined) {
        partialTools[event.index] = {
          id: block.id ?? '', name: block.name ?? '', json: '', isServer: true,
        }
      } else if (block?.type === 'web_search_tool_result' && event.index !== undefined) {
        serverResults[event.index] = {
          id: block.tool_use_id ?? '',
          content: block.content ?? [],
        }
      }
    } else if (event.type === 'content_block_delta') {
      if (event.delta?.type === 'text_delta') {
        yield { type: 'text', text: event.delta.text ?? '' }
      } else if (event.delta?.type === 'input_json_delta' && event.index !== undefined) {
        const pt = partialTools[event.index]
        if (pt) pt.json += event.delta.partial_json ?? ''
      }
    } else if (event.type === 'content_block_stop' && event.index !== undefined) {
      const pt = partialTools[event.index]
      if (pt) {
        let input: unknown = {}
        try {
          input = pt.json ? JSON.parse(pt.json) : {}
        } catch {
          input = { __parse_error: pt.json }
        }
        if (pt.isServer) {
          yield { type: 'server_tool_use', id: pt.id, name: pt.name, input }
        } else {
          yield { type: 'tool_use', id: pt.id, name: pt.name, input }
        }
        delete partialTools[event.index]
      }
      const sr = serverResults[event.index]
      if (sr) {
        yield { type: 'server_tool_result', id: sr.id, content: sr.content }
        delete serverResults[event.index]
      }
    } else if (event.type === 'message_delta') {
      if (event.delta?.stop_reason) stopReason = event.delta.stop_reason
      if (event.usage?.output_tokens !== undefined) usage.outputTokens = event.usage.output_tokens
    }
  }

  // When debug is on, close any mid-line stdout text before this log
  // lands on stderr (otherwise it visually attaches to Claude's text).
  if (isDebugEnabled()) process.stdout.write('\n')
  log.debug('stream complete', {
    stopReason,
    totalMs: Date.now() - startMs,
    in: usage.inputTokens,
    out: usage.outputTokens,
  })

  yield { type: 'done', stopReason, usage }
}

/**
 * Parse an SSE (Server-Sent Events) stream from the Messages API.
 * Each event has the form:
 *   event: <type>\n
 *   data: <json>\n\n
 */
type SSEEvent = {
  type: string
  index?: number
  message?: {
    usage?: {
      input_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
  content_block?: {
    type?: string
    id?: string
    name?: string
    input?: unknown
    tool_use_id?: string
    content?: unknown[]
  }
  delta?: {
    type?: string
    text?: string
    partial_json?: string
    stop_reason?: string
  }
  usage?: { output_tokens?: number }
}

async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })

    // Events are separated by blank lines (\n\n)
    let sep: number
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, sep)
      buffer = buffer.slice(sep + 2)

      // Extract the data: line (ignore event: line; JSON has .type already)
      const dataLine = rawEvent.split('\n').find(l => l.startsWith('data: '))
      if (!dataLine) continue
      const json = dataLine.slice(6)
      try {
        yield JSON.parse(json) as SSEEvent
      } catch {
        // Ignore malformed events (shouldn't happen with Anthropic's API)
      }
    }
  }
}
