/**
 * Tool permission prompts.
 *
 * Before a "dangerous" tool runs, we ask the user: allow / deny / always.
 * "always" adds the tool name to a session-scoped allowlist so we don't
 * re-prompt for the same tool again in this REPL session.
 *
 * Reference: claude-code src/hooks/toolPermission/handlers/interactiveHandler.ts
 * + src/utils/permissions/*. Theirs has per-argument rule patterns, classifier-
 * based auto-approval, bridge/channel relay, persistent rules across sources
 * (user/project/local/CLI/policy). Ours has a set of tool names.
 */

import type { Interface as ReadlineInterface } from 'node:readline/promises'
import { makeLogger } from './debug.ts'
import type { AnyTool } from './tools.ts'
import { formatToolCall, bold, cyan, dim, green, red, yellow } from './ui.ts'

const log = makeLogger('perm')

export type PermissionDecision = 'allow' | 'deny' | 'always'

/**
 * Called by the agent before executing a tool. Return value determines
 * whether the tool runs.
 * - 'allow' / 'always' → the tool runs
 * - 'deny' → the tool does not run; agent sends is_error=true back to Claude
 *
 * (The agent treats 'allow' and 'always' the same — the allowlist-updating
 *  happens inside the canUseTool implementation.)
 */
export type CanUseTool = (
  tool: AnyTool,
  input: unknown,
) => Promise<PermissionDecision>

/**
 * Auto-allow policy: every call is allowed, never prompts. Useful for
 * non-interactive contexts or tests.
 */
export const allowAll: CanUseTool = async () => 'allow'

/**
 * Auto-deny policy: never allows anything marked dangerous. Safe default
 * for scripted use where you don't want surprises.
 */
export const denyDangerous: CanUseTool = async tool =>
  tool.isDangerous ? 'deny' : 'allow'

/**
 * Interactive policy: prompt the user via stdin for each dangerous tool,
 * remembering "always" decisions in a session-scoped allowlist.
 *
 * Takes the REPL's existing `readline.Interface` — creating a new one here
 * would leave two interfaces fighting over process.stdin, and closing the
 * temporary one causes the REPL's main loop to see EOF and exit.
 */
export function createInteractivePermissions(rl: ReadlineInterface): {
  canUseTool: CanUseTool
  getAllowlist: () => string[]
  clearAllowlist: () => void
} {
  const sessionAllowlist = new Set<string>()

  const canUseTool: CanUseTool = async (tool, input) => {
    // Safe tools always run without prompting
    if (!tool.isDangerous) {
      return 'allow'
    }
    // Already in the session allowlist?
    if (sessionAllowlist.has(tool.name)) {
      log.debug('auto-allowed from session allowlist', { tool: tool.name })
      return 'allow'
    }

    // Show the prompt — multi-line layout so the input cursor is on its
    // own line, separate from the option labels.
    //
    // Note: rl.question()'s prompt must be plain ASCII. ANSI escape codes
    // in the prompt confuse readline's cursor-position tracking and cause
    // doubled/echoed characters. So we write the styled prompt with
    // process.stdout.write first, then give rl.question an empty prompt.
    console.log() // blank line for breathing room
    console.log(formatToolCall(tool.name, input))
    console.log(`   ${yellow('⚠ requires permission')}`)
    console.log(
      `     ${green('y')} ${dim('= allow once')}` +
      `    ${red('n')} ${dim('= deny')}` +
      `    ${bold('a')} ${dim('= always allow this tool for the session')}`,
    )
    process.stdout.write(`   ${cyan('›')} `)
    const answer = (await rl.question('')).trim().toLowerCase()

    if (answer === 'a' || answer === 'always') {
      sessionAllowlist.add(tool.name)
      log.info('added to session allowlist', { tool: tool.name })
      console.log(dim(`   → always allowing '${tool.name}' for this session\n`))
      return 'always'
    }
    if (answer === 'y' || answer === 'yes') {
      log.info('allowed once', { tool: tool.name })
      console.log(dim('   → allowed once\n'))
      return 'allow'
    }
    log.info('denied', { tool: tool.name })
    console.log(dim('   → denied\n'))
    return 'deny'
  }

  return {
    canUseTool,
    getAllowlist: () => Array.from(sessionAllowlist).sort(),
    clearAllowlist: () => sessionAllowlist.clear(),
  }
}
