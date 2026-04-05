/**
 * Direct Anthropic Messages API client using your Claude Max OAuth token.
 *
 * Replaces the previous Agent SDK wrapper. No subprocess, no hidden system prompt,
 * no account-injected tools — just the raw API.
 *
 * Reference: claude-code src/services/api/claude.ts (their much more elaborate version).
 */

import { getAccessToken, OAUTH_BETA_HEADER } from './auth.ts'

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

export type CompleteOpts = {
  /** User message, or full conversation history */
  prompt: string | Message[]
  /** System prompt (optional) */
  system?: string
  /** Model override (default: claude-sonnet-4-6) */
  model?: string
  /** Max output tokens (default: 4096) */
  maxTokens?: number
  /** Abort signal to cancel mid-request */
  signal?: AbortSignal
}

export type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'done'; stopReason: string; usage: Usage }

export type CompleteResult = {
  text: string
  stopReason: string
  usage: Usage
}

/**
 * Convert our simple (prompt, system) inputs into the API's messages array.
 */
function buildMessages(prompt: string | Message[]): { role: Role; content: string }[] {
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
    throw new Error(`API error ${response.status}: ${await response.text()}`)
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
  const response = await fetch(MESSAGES_URL, {
    method: 'POST',
    headers: await buildHeaders(),
    body: JSON.stringify(buildRequestBody(opts, true)),
    signal: opts.signal,
  })

  if (!response.ok) {
    throw new Error(`API error ${response.status}: ${await response.text()}`)
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

  for await (const event of parseSSE(response.body)) {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      yield { type: 'text', text: event.delta.text ?? '' }
    } else if (event.type === 'message_start' && event.message?.usage) {
      usage.inputTokens = event.message.usage.input_tokens ?? 0
      usage.cacheCreationTokens = event.message.usage.cache_creation_input_tokens ?? 0
      usage.cacheReadTokens = event.message.usage.cache_read_input_tokens ?? 0
    } else if (event.type === 'message_delta') {
      if (event.delta?.stop_reason) stopReason = event.delta.stop_reason
      if (event.usage?.output_tokens !== undefined) usage.outputTokens = event.usage.output_tokens
    }
  }

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
  message?: {
    usage?: {
      input_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
  delta?: {
    type?: string
    text?: string
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
