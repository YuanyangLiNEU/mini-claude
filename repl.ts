/**
 * Interactive REPL — read user input, call Claude, stream response, loop.
 *
 * Commands:
 *   /clear   reset conversation history
 *   /history show current history length
 *   /model   switch model
 *   /exit    quit
 */

import * as readline from 'node:readline/promises'
import { stream } from './claude.ts'
import { History } from './history.ts'

const DEFAULT_SYSTEM =
  'You are a helpful, concise assistant. Respond in plain text without unnecessary preamble.'

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const history = new History()
  // Default to Haiku to stay comfortably under the 5h rate limit while learning.
  // Switch with `/model claude-sonnet-4-6` when you want better quality.
  let model = 'claude-haiku-4-5'

  console.log('mini-claude REPL')
  console.log(`model: ${model}`)
  console.log('type /exit to quit, /clear to reset, /help for commands\n')

  while (true) {
    const input = (await rl.question('❯ ')).trim()
    if (!input) continue

    // --- Commands ---
    if (input === '/exit' || input === '/quit') break
    if (input === '/clear') {
      history.clear()
      console.log('history cleared.\n')
      continue
    }
    if (input === '/history') {
      console.log(`history: ${history.length} messages\n`)
      continue
    }
    if (input.startsWith('/model')) {
      const parts = input.split(/\s+/)
      if (parts.length === 2) {
        model = parts[1]!
        console.log(`model set to: ${model}\n`)
      } else {
        console.log(`current model: ${model}\n`)
      }
      continue
    }
    if (input === '/help') {
      console.log('  /exit       quit')
      console.log('  /clear      reset conversation history')
      console.log('  /history    show history length')
      console.log('  /model [m]  get/set model (e.g. /model claude-haiku-4-5)\n')
      continue
    }

    // --- User turn ---
    history.addUser(input)

    // --- Assistant turn: stream response ---
    process.stdout.write('\n')
    let assistantText = ''
    try {
      for await (const ev of stream({
        prompt: history.all(),
        system: DEFAULT_SYSTEM,
        model,
      })) {
        if (ev.type === 'text') {
          process.stdout.write(ev.text)
          assistantText += ev.text
        } else if (ev.type === 'done') {
          // Show stop reason and usage subtly, on its own line
          process.stdout.write(
            `\n\n[${ev.stopReason}, in:${ev.usage.inputTokens} out:${ev.usage.outputTokens}]\n\n`,
          )
        }
      }
      history.addAssistant(assistantText)
    } catch (err) {
      // On error, don't poison history with a half-turn
      console.error('\n[error]', err instanceof Error ? err.message : err, '\n')
    }
  }

  rl.close()
  console.log('bye.')
}

main()
