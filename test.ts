/**
 * Smoke test: verifies direct API access via OAuth is working.
 *
 * Run:  bun run test.ts
 */

import { complete, stream } from './claude.ts'

// --- Test 1: single-shot call (Haiku for fast/cheap smoke test) ---
console.log('--- Test 1: simple completion (Haiku) ---')
const t1 = await complete({
  prompt: 'Say hello in exactly 3 words.',
  model: 'claude-haiku-4-5',
})
console.log('Answer:', t1.text)
console.log('Usage:', t1.usage)

// --- Test 2: with system prompt ---
console.log('\n--- Test 2: with system prompt (Haiku) ---')
const t2 = await complete({
  prompt: 'Write about autumn.',
  system: 'You are a haiku poet. Respond only with a single 5-7-5 haiku.',
  model: 'claude-haiku-4-5',
})
console.log(t2.text)
console.log('Usage:', t2.usage)

// --- Test 3: streaming ---
console.log('\n--- Test 3: streaming (Haiku) ---')
process.stdout.write('Answer: ')
for await (const ev of stream({
  prompt: 'Count from 1 to 5, one number per line.',
  model: 'claude-haiku-4-5',
})) {
  if (ev.type === 'text') process.stdout.write(ev.text)
  if (ev.type === 'done') console.log(`\n[stopped: ${ev.stopReason}, usage:`, ev.usage, ']')
}
