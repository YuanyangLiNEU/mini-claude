/**
 * Task definitions for mini-claude evaluation.
 *
 * Each task probes a specific capability of the harness — whether the current
 * tools + system prompt + agent loop can accomplish what a user would ask.
 *
 * Each task is evaluated by the LLM judge (see ./judge.ts) against its
 * `goal` and `expectations`.
 */

import { mkdir, rm, unlink } from 'node:fs/promises'
import type { Task } from './types.ts'

/**
 * Sandbox directory where eval fixtures live. Kept inside the repo so you
 * can see them, reset them, and gitignore them easily. Each task creates
 * its own files here at setup and deletes them at cleanup.
 */
export const SANDBOX = `${import.meta.dir}/sandbox`

/** Ensure the sandbox directory exists. Idempotent. */
async function ensureSandbox(): Promise<void> {
  await mkdir(SANDBOX, { recursive: true })
}

/** Best-effort delete; ignore missing files. */
async function rmIfExists(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch {}
}

export const TASKS: Task[] = [
  // ---- Capability: read ----
  {
    name: 'read_file_capability',
    prompt: `What does ${SANDBOX}/notes.txt contain?`,
    goal: `Get the contents of ${SANDBOX}/notes.txt so the user can see what's in it.`,
    expectations: [
      'Agent calls read_file with the correct path',
      "Agent's final response surfaces the actual file contents (not just 'I read it')",
    ],
    setup: async () => {
      await ensureSandbox()
      await Bun.write(`${SANDBOX}/notes.txt`, 'meeting at 3pm, bring laptop')
    },
    cleanup: async () => {
      await rmIfExists(`${SANDBOX}/notes.txt`)
    },
  },

  // ---- Capability: list directory ----
  {
    name: 'list_dir_capability',
    prompt: `What files are in ${SANDBOX}/fruits?`,
    goal: `See the contents of the ${SANDBOX}/fruits directory.`,
    expectations: [
      'Agent calls list_files with the correct path',
      "Agent's final response names the files that exist in the directory (apple.txt, banana.txt)",
    ],
    setup: async () => {
      await ensureSandbox()
      await mkdir(`${SANDBOX}/fruits`, { recursive: true })
      await Bun.write(`${SANDBOX}/fruits/apple.txt`, 'a')
      await Bun.write(`${SANDBOX}/fruits/banana.txt`, 'b')
    },
    cleanup: async () => {
      try {
        await rm(`${SANDBOX}/fruits`, { recursive: true, force: true })
      } catch {}
    },
  },

  // ---- Capability: write a file ----
  {
    name: 'write_file_capability',
    prompt: `Please write "hello from eval" to ${SANDBOX}/write.txt`,
    goal: `Create a file at ${SANDBOX}/write.txt containing the text "hello from eval".`,
    expectations: [
      'Agent calls write_file with the correct path',
      'Agent writes the exact requested content',
      'Agent confirms to the user that the file was written',
    ],
    setup: async () => {
      await ensureSandbox()
      await rmIfExists(`${SANDBOX}/write.txt`)
    },
    cleanup: async () => {
      await rmIfExists(`${SANDBOX}/write.txt`)
    },
  },

  // ---- Capability: chain tools together ----
  {
    name: 'chain_read_then_write',
    prompt: `Read ${SANDBOX}/source.txt and write its contents in UPPERCASE to ${SANDBOX}/out.txt.`,
    goal: `Read a file, transform its content to uppercase, write to a new file.`,
    expectations: [
      'Agent calls read_file on the source path',
      'Agent calls write_file on the destination path',
      'The content written to the destination is the UPPERCASE version of the source content',
    ],
    setup: async () => {
      await ensureSandbox()
      await Bun.write(`${SANDBOX}/source.txt`, 'hello world')
      await rmIfExists(`${SANDBOX}/out.txt`)
    },
    cleanup: async () => {
      await rmIfExists(`${SANDBOX}/source.txt`)
      await rmIfExists(`${SANDBOX}/out.txt`)
    },
  },

  // ---- Error recovery: missing file ----
  {
    name: 'missing_file_recovery',
    prompt: `Read ${SANDBOX}/nonexistent-xyz.txt and tell me what's in it.`,
    goal: `Tell the user clearly that the file cannot be read because it does not exist.`,
    expectations: [
      'Agent attempts to call read_file',
      "Agent's final response tells the user the file does not exist (or could not be found/read)",
      'Agent does not fabricate file contents',
    ],
    setup: async () => {
      await ensureSandbox()
      await rmIfExists(`${SANDBOX}/nonexistent-xyz.txt`)
    },
  },

  // ---- History continuity: follow-up uses prior context ----
  // (skipped for now — would need multi-prompt harness; single-prompt tasks only)
]
