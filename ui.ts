/**
 * Terminal formatting helpers — ANSI escape codes for colors/weights, plus
 * CC-style renderers for tool calls and results.
 *
 * Reference: claude-code src/components/messages/AssistantToolUseMessage.tsx
 * and src/components/MessageResponse.tsx. Theirs use Ink (React for terminals).
 * Ours are plain printf-style — good enough for learning, no deps.
 */

// --- ANSI escape codes ---
// Reset + styles
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'

// Colors
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const CYAN = '\x1b[36m'
const GRAY = '\x1b[90m'

export const bold = (s: string) => `${BOLD}${s}${RESET}`
export const dim = (s: string) => `${DIM}${s}${RESET}`
export const red = (s: string) => `${RED}${s}${RESET}`
export const green = (s: string) => `${GREEN}${s}${RESET}`
export const yellow = (s: string) => `${YELLOW}${s}${RESET}`
export const cyan = (s: string) => `${CYAN}${s}${RESET}`
export const gray = (s: string) => `${GRAY}${s}${RESET}`

// --- CC-style symbols ---
const CIRCLE = '●'
const CURVE = '⎿'

/**
 * Format a tool invocation line. Matches CC's `●  ToolName(args)` style.
 *
 * Example: `●  read_file(path: "/tmp/hello.txt")`
 */
export function formatToolCall(name: string, input: unknown): string {
  const args = renderArgsInline(input)
  return `${bold(CIRCLE)}  ${bold(name)}(${args})`
}

/**
 * Format a tool result line. Matches CC's `  ⎿  <result>` style, dimmed.
 * Truncates long results.
 */
export function formatToolResult(
  result: string,
  isError: boolean,
  maxLen = 200,
): string {
  const truncated =
    result.length > maxLen
      ? result.slice(0, maxLen) + ` … (+${result.length - maxLen} chars)`
      : result
  // Collapse newlines for the one-line preview
  const oneLine = truncated.replace(/\n/g, ' ')
  const prefix = `  ${dim(CURVE)}  `
  return prefix + (isError ? red(oneLine) : dim(oneLine))
}

/**
 * Format the entire conversation history for debug display. One line per
 * message, content blocks summarized inline. Useful to see what's actually
 * being sent to the API each turn.
 */
export function formatHistory(
  history: { role: string; content: unknown }[],
  maxContent = 100,
): string {
  const lines: string[] = []
  history.forEach((msg, i) => {
    const roleLabel = msg.role === 'user' ? yellow(msg.role) : cyan(msg.role)
    const blocks = Array.isArray(msg.content) ? msg.content : []
    const summary = blocks.map(b => summarizeBlock(b, maxContent)).join(' · ')
    lines.push(gray(`    [${i}] `) + roleLabel + ' ' + gray(summary))
  })
  return lines.join('\n')
}

function summarizeBlock(block: unknown, maxContent: number): string {
  if (!block || typeof block !== 'object' || !('type' in block)) return '?'
  const b = block as { type: string; [k: string]: unknown }
  switch (b.type) {
    case 'text': {
      const text = String(b.text ?? '').replace(/\n/g, ' ')
      return `text: "${truncate(text, maxContent)}"`
    }
    case 'tool_use': {
      const input = JSON.stringify(b.input ?? {})
      return `tool_use: ${b.name}(${truncate(input, maxContent)})`
    }
    case 'tool_result': {
      const content = String(b.content ?? '').replace(/\n/g, ' ')
      const err = b.is_error ? ' [error]' : ''
      return `tool_result${err}: "${truncate(content, maxContent)}"`
    }
    default:
      return String(b.type)
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

/**
 * Render a tool's input as a compact `key: "value"` inline list.
 * `{path: "/tmp/hello.txt", lines: 50}` → `path: "/tmp/hello.txt", lines: 50`
 */
function renderArgsInline(input: unknown, maxLen = 80): string {
  if (input === null || input === undefined) return ''
  if (typeof input !== 'object') return JSON.stringify(input)
  const entries = Object.entries(input as Record<string, unknown>)
  if (entries.length === 0) return ''
  const parts = entries.map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
  const joined = parts.join(', ')
  return joined.length > maxLen ? joined.slice(0, maxLen) + '…' : joined
}
