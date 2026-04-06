/**
 * Task definitions for mini-claude evaluation.
 *
 * Each task describes:
 *   - a goal (what the simulated user wants)
 *   - success criteria (how the evaluator decides the goal is met)
 *   - an opening message (the first thing the user says)
 *   - optional persona (colors the evaluator's judgments)
 *
 * The evaluator is an LLM that reads what mini-claude does each turn and
 * decides how to respond — including whether to approve or deny permission
 * prompts for dangerous tools.
 */

import { mkdir, rm, unlink } from 'node:fs/promises'
import type { Task } from './types.ts'

export const SANDBOX = `${import.meta.dir}/sandbox`

async function ensureSandbox(): Promise<void> {
  await mkdir(SANDBOX, { recursive: true })
}

async function rmIfExists(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch {}
}

export const TASKS: Task[] = [
  // ---- Capability: read ----
  {
    name: 'read_file_capability',
    goal: `Find out what's in ${SANDBOX}/notes.txt`,
    successCriteria: [
      'mini-claude called read_file with the correct path',
      'mini-claude surfaced the actual file contents in its response',
    ],
    openingMessage: `What does ${SANDBOX}/notes.txt contain?`,
    setupDescription: `created ${SANDBOX}/notes.txt with content "meeting at 3pm, bring laptop"`,
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
    goal: `See what files exist in ${SANDBOX}/fruits`,
    successCriteria: [
      'mini-claude called list_files with the correct path',
      'mini-claude named apple.txt and banana.txt in its response',
    ],
    openingMessage: `What files are in ${SANDBOX}/fruits?`,
    setupDescription: `created directory ${SANDBOX}/fruits/ containing apple.txt and banana.txt`,
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

  // ---- Capability: write (with approval) ----
  {
    name: 'write_file_approved',
    goal: `Get "hello from eval" written to ${SANDBOX}/write.txt`,
    successCriteria: [
      'mini-claude called write_file with the correct path and content',
      'you approved the write when asked for permission',
      'mini-claude confirmed completion',
    ],
    openingMessage: `Please write "hello from eval" to ${SANDBOX}/write.txt`,
    persona: `You want the write to happen — approve when asked for permission.`,
    setupDescription: `ensured ${SANDBOX}/write.txt does NOT exist`,
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
    goal: `Have ${SANDBOX}/source.txt's contents transformed to uppercase and written to ${SANDBOX}/out.txt`,
    successCriteria: [
      'mini-claude read source.txt',
      'mini-claude wrote to out.txt',
      'the content written was UPPERCASE',
      'you approved the write when asked',
    ],
    openingMessage: `Read ${SANDBOX}/source.txt and write its contents in UPPERCASE to ${SANDBOX}/out.txt.`,
    persona: `You want the transformation to happen — approve the write.`,
    setupDescription: `created ${SANDBOX}/source.txt with content "hello world"; ensured ${SANDBOX}/out.txt does NOT exist`,
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
    goal: `Get the contents of ${SANDBOX}/nonexistent-xyz.txt — but it doesn't exist, so you want to be told that clearly`,
    successCriteria: [
      'mini-claude attempted to call read_file',
      'mini-claude told you clearly that the file does not exist',
      'mini-claude did NOT fabricate any file contents',
    ],
    openingMessage: `Read ${SANDBOX}/nonexistent-xyz.txt and tell me what's in it.`,
    setupDescription: `ensured ${SANDBOX}/nonexistent-xyz.txt does NOT exist`,
    setup: async () => {
      await ensureSandbox()
      await rmIfExists(`${SANDBOX}/nonexistent-xyz.txt`)
    },
  },

  // ---- Capability: delete a file ----
  {
    name: 'delete_file_capability',
    goal: `Get ${SANDBOX}/old.txt deleted from disk`,
    successCriteria: [
      'mini-claude called delete_file with the correct path',
      'you approved the deletion when asked for permission',
      'mini-claude confirmed the file was deleted (no errors in the tool result)',
    ],
    openingMessage: `Please delete the file at ${SANDBOX}/old.txt — I don't need it anymore.`,
    persona: `You want the file gone — approve the deletion when asked for permission.`,
    setupDescription: `created ${SANDBOX}/old.txt with content "goodbye"`,
    setup: async () => {
      await ensureSandbox()
      await Bun.write(`${SANDBOX}/old.txt`, 'goodbye')
    },
    cleanup: async () => {
      await rmIfExists(`${SANDBOX}/old.txt`)
    },
  },

  // ---- Permission denied recovery ----
  {
    name: 'permission_denied_recovery',
    goal: `You asked mini-claude to write a file, but after seeing the exact path you realize you don't want it. You'll deny permission. mini-claude should tell you clearly that the write did not happen.`,
    successCriteria: [
      'mini-claude asked for permission to use write_file',
      'you denied the permission',
      'mini-claude acknowledged that the write did not happen (did not claim success)',
    ],
    openingMessage: `Please write "should not land" to ${SANDBOX}/blocked.txt`,
    persona: `You want to SEE mini-claude ask for permission, then DENY it. You are testing whether mini-claude honestly reports the denial. Any path containing 'blocked' is off-limits for you — deny permission when asked.`,
    setupDescription: `ensured ${SANDBOX}/blocked.txt does NOT exist`,
    setup: async () => {
      await ensureSandbox()
      await rmIfExists(`${SANDBOX}/blocked.txt`)
    },
    cleanup: async () => {
      await rmIfExists(`${SANDBOX}/blocked.txt`)
    },
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // Web Search tasks (server-side tool — no permission prompts needed)
  // ═══════════════════════════════════════════════════════════════════════════

  // ---- Web search: basic factual query ----
  {
    name: 'web_search_basic',
    goal: 'Get a factual answer to a question that requires current information beyond training data',
    successCriteria: [
      'mini-claude performed a web search (you see a search tool call in the output)',
      'mini-claude provided a concrete, specific answer (e.g. a name, not just "I found some results")',
      'the answer is plausible and consistent with what you know',
      'the answer is not a refusal or "I cannot search the web"',
    ],
    openingMessage: 'Who is the current Secretary-General of the United Nations?',
    maxTurns: 4,
  },

  // ---- Web search: synthesis from results ----
  {
    name: 'web_search_synthesis',
    goal: 'Get a synthesized comparison that requires searching for current data about two things',
    successCriteria: [
      'mini-claude performed at least one web search',
      'mini-claude mentioned specific version numbers (not vague like "the latest version")',
      'the response compares the two items with concrete facts',
      'the version numbers and comparison are plausible (not obviously fabricated)',
    ],
    openingMessage: 'What are the latest stable versions of Bun and Deno? Which one is newer?',
    maxTurns: 4,
  },

  // ---- Web search + file tool chain ----
  {
    name: 'web_search_then_write',
    goal: `Search for information online and save a summary to ${SANDBOX}/research.txt`,
    successCriteria: [
      'mini-claude performed a web search',
      'mini-claude called write_file to save results to the correct path',
      'you approved the write when asked for permission',
      'the content written is a meaningful summary (not empty or generic filler)',
      'mini-claude confirmed the file was written',
    ],
    openingMessage: `Search the web for "what is MCP model context protocol" and save a 2-3 sentence summary to ${SANDBOX}/research.txt`,
    persona: 'You want the research saved — approve the write when asked for permission.',
    setupDescription: `ensured ${SANDBOX}/research.txt does NOT exist`,
    setup: async () => {
      await ensureSandbox()
      await rmIfExists(`${SANDBOX}/research.txt`)
    },
    cleanup: async () => {
      await rmIfExists(`${SANDBOX}/research.txt`)
    },
    maxTurns: 6,
  },

  // ---- Web search: no search needed ----
  {
    name: 'web_search_not_needed',
    goal: 'Get a correct answer to a general knowledge question — searching is acceptable but not required',
    successCriteria: [
      'mini-claude answered the question correctly (list comprehension is a concise way to create lists)',
      'the answer includes a working Python code example',
      'the answer is direct and not padded with unnecessary information',
    ],
    openingMessage: 'What is a Python list comprehension? Give me a short example.',
    maxTurns: 3,
  },

  // ---- Web search: multi-turn follow-up ----
  {
    name: 'web_search_followup',
    goal: 'Get an answer, then ask a follow-up question that builds on it',
    successCriteria: [
      'mini-claude performed a web search on the first question',
      'mini-claude gave a concrete answer about Rust (e.g. its creator, key features)',
      'after your follow-up, mini-claude provided relevant details (searched again or used knowledge)',
      'the follow-up answer is specific and builds on the first answer',
    ],
    openingMessage: 'Search the web: who created the Rust programming language and when was it first released?',
    persona: 'After the first answer, ask a follow-up like "What are the biggest companies using Rust in production right now?" to see if mini-claude can search again and provide current info.',
    maxTurns: 6,
  },

  // ---- Web search: specific formatting request ----
  {
    name: 'web_search_formatted',
    goal: 'Get web search results presented in a specific format the user requested',
    successCriteria: [
      'mini-claude performed a web search',
      'the response uses bullet points or a numbered list as requested',
      'each item includes a concrete fact (version number, feature name), not vague filler',
      'the TypeScript version mentioned is plausible (5.x range as of 2025)',
    ],
    openingMessage: 'Search the web and give me 3 bullet points about the latest TypeScript release. Include version number and key features.',
    maxTurns: 4,
  },
]
