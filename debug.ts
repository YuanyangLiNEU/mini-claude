/**
 * Debug logging — silent by default, opt-in via env var or flag.
 *
 * Reference: claude-code src/utils/debug.ts. Theirs has levels, filter
 * patterns, file rotation, buffered writers, session IDs, symlinks. Ours
 * has levels and writes to stderr. That's it.
 *
 * Enable:
 *   DEBUG=1 bun run repl.ts
 *   bun run repl.ts --debug
 *
 * Control minimum level (default: 'debug'):
 *   DEBUG=1 DEBUG_LEVEL=info bun run repl.ts
 */

export type Level = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<Level, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

// Decided once at startup — debug mode is a process-wide flag
const DEBUG_ENABLED =
  process.env.DEBUG === '1' ||
  process.env.DEBUG === 'true' ||
  process.argv.includes('--debug')

const MIN_LEVEL: Level = (() => {
  const raw = process.env.DEBUG_LEVEL?.toLowerCase()
  if (raw && raw in LEVEL_ORDER) return raw as Level
  return 'debug'
})()

// --- ANSI codes for stderr coloring (subsystem prefix only) ---
const DIM = '\x1b[2m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const RESET = '\x1b[0m'
const GRAY = '\x1b[90m'

function levelColor(level: Level): string {
  switch (level) {
    case 'debug':
      return GRAY
    case 'info':
      return ''
    case 'warn':
      return YELLOW
    case 'error':
      return RED
  }
}

/** Short time prefix: HH:MM:SS.mmm */
function timestamp(): string {
  const d = new Date()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return `${hh}:${mm}:${ss}.${ms}`
}

function write(subsystem: string, level: Level, msg: string, data?: unknown): void {
  if (!DEBUG_ENABLED) return
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return

  const ts = timestamp()
  const lvl = level.toUpperCase().padEnd(5)
  const color = levelColor(level)

  // Render the data (JSON-stringified if not already a string) ahead of time
  // so we can style the whole message consistently.
  let dataStr = ''
  if (data !== undefined) {
    dataStr = ' ' + (
      typeof data === 'string'
        ? data
        : (() => {
            try {
              return JSON.stringify(data)
            } catch {
              return String(data)
            }
          })()
    )
  }

  // For debug level: dim the whole line so it recedes from the user's gaze.
  // For info/warn/error: color the bracket, keep the message itself bright so
  // it stands out (these signal that something important is being reported).
  let line: string
  if (level === 'debug') {
    // Everything dim/gray — recedes from view but still readable if needed
    line = `${GRAY}${ts} [${lvl}] [${subsystem}] ${msg}${dataStr}${RESET}`
  } else {
    const styledLvl = color ? `${color}[${lvl}]${RESET}` : `[${lvl}]`
    line =
      `${DIM}${ts}${RESET} ` +
      `${styledLvl} ` +
      `${DIM}[${subsystem}]${RESET} ` +
      `${msg}${DIM}${dataStr}${RESET}`
  }

  process.stderr.write(line + '\n')
}

/**
 * Create a logger bound to a subsystem name. Log calls pass through to stderr
 * only when debug mode is enabled.
 *
 * Example:
 *   const log = makeLogger('api')
 *   log.debug('sending request', { model: 'claude-haiku-4-5' })
 */
export function makeLogger(subsystem: string): {
  debug: (msg: string, data?: unknown) => void
  info: (msg: string, data?: unknown) => void
  warn: (msg: string, data?: unknown) => void
  error: (msg: string, data?: unknown) => void
} {
  return {
    debug: (msg, data) => write(subsystem, 'debug', msg, data),
    info: (msg, data) => write(subsystem, 'info', msg, data),
    warn: (msg, data) => write(subsystem, 'warn', msg, data),
    error: (msg, data) => write(subsystem, 'error', msg, data),
  }
}

/** Whether debug mode is currently enabled. Useful for guarding expensive work. */
export function isDebugEnabled(): boolean {
  return DEBUG_ENABLED
}
