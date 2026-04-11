/**
 * Subprocess driver for mini-claude.
 *
 * Spawns `bun run repl.ts` as a child process and communicates via
 * stdin/stdout — exactly the way a human would. No imports from
 * mini-claude internals.
 *
 * Detects two idle states:
 *   - "❯ "  → REPL is waiting for the next user message
 *   - "› "  → REPL is waiting for a permission answer (y/n/a)
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { makeLogger } from '../debug.ts'

const log = makeLogger('subprocess')

/** Milliseconds of silence after a prompt marker to confirm REPL is idle. */
const IDLE_CONFIRM_MS = 300
/** Max wait before we give up and call it a timeout. */
const MAX_WAIT_MS = 120_000

export type IdleReason = 'prompt' | 'permission' | 'timeout'

export type MiniClaudeSubprocess = {
  /** Send a user message (types it into the ❯ prompt). */
  sendMessage(text: string): void
  /** Answer a permission prompt (types y/n/a into the › prompt). */
  answerPermission(answer: 'y' | 'n' | 'a'): void
  /**
   * Wait until the REPL goes idle. Returns the raw stdout collected
   * since the last call, plus the reason it stopped.
   */
  waitForIdle(): Promise<{ output: string; reason: IdleReason }>
  /** Kill the subprocess. */
  shutdown(): void
  /** The underlying ChildProcess, for advanced use. */
  proc: ChildProcess
}

/**
 * Strip ANSI escape codes from a string so the evaluator sees clean text.
 */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
}

/**
 * Spawn mini-claude's REPL and return a handle for driving it.
 * The caller must await waitForIdle() after spawn to consume the
 * initial greeting before sending the first message.
 */
export function spawnMiniClaude(): MiniClaudeSubprocess {
  const replPath = new URL('../repl.ts', import.meta.url).pathname
  log.debug('spawning', { path: replPath })

  const proc = spawn('bun', ['run', replPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NO_COLOR: '1', DEBUG: '', DEBUG_SDK: '' }, // no debug, no ANSI
  })

  // Accumulate stdout between waitForIdle() calls
  let buffer = ''
  let onData: ((chunk: string) => void) | null = null

  proc.stdout.on('data', (chunk: Buffer) => {
    const text = stripAnsi(chunk.toString())
    buffer += text
    if (onData) onData(text)
  })

  // stderr — log but don't surface to evaluator
  proc.stderr.on('data', (chunk: Buffer) => {
    log.debug('stderr', stripAnsi(chunk.toString()).trim())
  })

  function sendMessage(text: string): void {
    // The REPL's readline reads one line per submission — any internal \n
    // would terminate the message early, causing truncation. Collapse all
    // whitespace (including newlines) into single spaces so multi-line
    // evaluator messages (e.g. requirements lists) survive as a single
    // readline input. The model handles the loss of line breaks fine.
    const flat = text.replace(/\s+/g, ' ').trim()
    log.debug('sending message', { len: flat.length, preview: flat.slice(0, 120) })
    proc.stdin.write(flat + '\n')
  }

  function answerPermission(answer: 'y' | 'n' | 'a'): void {
    log.debug('answering permission', { answer })
    proc.stdin.write(answer + '\n')
  }

  function waitForIdle(): Promise<{ output: string; reason: IdleReason }> {
    return new Promise((resolve, reject) => {
      const startBuffer = buffer
      let idleTimer: ReturnType<typeof setTimeout> | null = null
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null

      function cleanup() {
        onData = null
        if (idleTimer) clearTimeout(idleTimer)
        if (timeoutTimer) clearTimeout(timeoutTimer)
      }

      function checkIdle() {
        // Check what we've accumulated since caller last called waitForIdle
        const accumulated = buffer.slice(startBuffer.length)
        const trimmed = accumulated.trimEnd()

        if (trimmed.endsWith('❯')) {
          cleanup()
          resolve({ output: accumulated, reason: 'prompt' })
          // Reset buffer for next call
          buffer = ''
          return true
        }
        if (trimmed.endsWith('›')) {
          cleanup()
          resolve({ output: accumulated, reason: 'permission' })
          buffer = ''
          return true
        }
        return false
      }

      // On each chunk of data, reset the idle timer and check markers
      onData = () => {
        if (idleTimer) clearTimeout(idleTimer)
        // Wait a short period after the last data arrives, then check
        idleTimer = setTimeout(() => {
          if (!checkIdle()) {
            // Still no prompt marker — keep waiting
          }
        }, IDLE_CONFIRM_MS)
      }

      // Overall timeout
      timeoutTimer = setTimeout(() => {
        cleanup()
        const accumulated = buffer.slice(startBuffer.length)
        buffer = ''
        resolve({ output: accumulated, reason: 'timeout' })
      }, MAX_WAIT_MS)

      // Check immediately in case the prompt is already in the buffer
      // (e.g. REPL's greeting + first prompt arrived before we started waiting)
      setTimeout(() => {
        if (!checkIdle()) {
          // Not idle yet — the onData handler will keep checking
        }
      }, 50)
    })
  }

  function shutdown(): void {
    log.debug('shutting down subprocess')
    proc.stdin.write('/exit\n')
    setTimeout(() => {
      if (!proc.killed) proc.kill()
    }, 2000)
  }

  return { sendMessage, answerPermission, waitForIdle, shutdown, proc }
}
